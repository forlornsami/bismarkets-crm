import type { NextFunction, Request, Response } from "express";
import type { Config } from "../config";
import { randomToken, sha256 } from "../lib/crypto";
import { exec, one, rows, type Conn, type Db } from "../lib/db";
import { queueSupportEvent } from "../lib/events";
import { forbidden, unauthorized } from "../lib/http";

export interface ClientContext {
  id: number;
  email: string;
  status: "active" | "frozen" | "closed";
  sessionId: string;
  kind: "login" | "impersonation";
  /** The staff member behind an impersonation session. */
  staffId: number | null;
}

export async function createClientSession(
  conn: Conn,
  config: Config,
  clientId: number,
  ip: string,
  userAgent: string,
  impersonation?: { staffId: number; reason: string },
) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + (impersonation ? config.impersonationMs : config.clientSessionMs));
  await exec(
    conn,
    "INSERT INTO client_sessions (id, client_id, kind, staff_id, reason, ip, user_agent, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [sha256(token), clientId, impersonation ? "impersonation" : "login", impersonation?.staffId ?? null, impersonation?.reason ?? null, ip.slice(0, 45), userAgent.slice(0, 255), expiresAt],
  );
  return { token, expiresAt };
}

/** Ends sessions and tells the support service, so the app stops pushing to signed-out devices. */
export async function revokeClientSessions(conn: Conn, config: Config, clientId: number, reason: string, exceptSessionId?: string) {
  const live = await rows<{ id: string; kind: string }>(
    conn,
    `SELECT id, kind FROM client_sessions WHERE client_id = ? AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP(3) ${exceptSessionId ? "AND id <> ?" : ""} FOR UPDATE`,
    exceptSessionId ? [clientId, exceptSessionId] : [clientId],
  );
  await exec(
    conn,
    `UPDATE client_sessions SET revoked_at = CURRENT_TIMESTAMP(3), revoked_reason = ?
     WHERE client_id = ? AND revoked_at IS NULL ${exceptSessionId ? "AND id <> ?" : ""}`,
    exceptSessionId ? [reason, clientId, exceptSessionId] : [reason, clientId],
  );
  for (const s of live) if (s.kind === "login") await queueSupportEvent(conn, config, { event: "session.revoked", clientId, sessionId: s.id });
  return live.length;
}

/** Ends one session (sign-out, or the client removing a device). */
export async function revokeClientSession(conn: Conn, config: Config, clientId: number, sessionId: string, reason: string) {
  const r = await exec(conn, "UPDATE client_sessions SET revoked_at = CURRENT_TIMESTAMP(3), revoked_reason = ? WHERE id = ? AND client_id = ? AND revoked_at IS NULL", [reason, sessionId, clientId]);
  const s = await one<{ kind: string }>(conn, "SELECT kind FROM client_sessions WHERE id = ?", [sessionId]);
  if (r.affectedRows && s?.kind === "login") await queueSupportEvent(conn, config, { event: "session.revoked", clientId, sessionId });
  return r.affectedRows > 0;
}

export function bearerToken(req: Request): string | null {
  const header = req.get("authorization") ?? "";
  const match = /^Bearer\s+([A-Za-z0-9_\-|.]{20,200})$/.exec(header.trim());
  return match ? match[1]! : null;
}

interface SessionRow {
  session_id: string;
  kind: "login" | "impersonation";
  staff_id: number | null;
  expires_at: Date;
  last_seen_at: Date;
  client_id: number;
  email: string;
  status: "active" | "frozen" | "closed";
}

/** Authenticates a client API request from its Bearer token. */
export function clientAuth(db: Db, config: Config) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const token = bearerToken(req);
      if (!token) throw unauthorized();
      const row = await one<SessionRow>(
        db,
        `SELECT s.id AS session_id, s.kind, s.staff_id, s.expires_at, s.last_seen_at, c.id AS client_id, c.email, c.status
         FROM client_sessions s JOIN clients c ON c.id = s.client_id
         WHERE s.id = ? AND s.revoked_at IS NULL`,
        [sha256(token)],
      );
      const now = Date.now();
      if (!row || row.status === "closed") throw unauthorized();
      const idle = row.kind === "login" && row.last_seen_at.getTime() + config.clientIdleMs <= now;
      if (row.expires_at.getTime() <= now || idle) {
        await exec(db, "UPDATE client_sessions SET revoked_at = CURRENT_TIMESTAMP(3), revoked_reason = 'expired' WHERE id = ?", [row.session_id]);
        throw unauthorized();
      }
      if (now - row.last_seen_at.getTime() > 60_000) {
        await exec(db, "UPDATE client_sessions SET last_seen_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [row.session_id]);
      }
      req.client = { id: row.client_id, email: row.email, status: row.status, sessionId: row.session_id, kind: row.kind, staffId: row.staff_id };
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function clientOf(req: Request): ClientContext {
  if (!req.client) throw unauthorized();
  return req.client;
}

/** Staff viewing the portal as a client can look but not change anything. */
export function noImpersonation(req: Request, _res: Response, next: NextFunction) {
  if (req.client?.kind === "impersonation") return next(forbidden("This is a view-only staff session. Changes are not allowed."));
  next();
}

export const clientActor = (client: { id: number; email: string }) => ({ type: "client" as const, id: client.id, label: client.email });
