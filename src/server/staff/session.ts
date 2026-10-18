import { createHmac } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { ALL_PERMISSIONS, SUPER_ADMIN_SLUG, type Permission } from "@shared/permissions";
import type { Config } from "../config";
import { readCookie } from "../lib/cookies";
import { randomToken, safeEqual, sha256 } from "../lib/crypto";
import { exec, one, rows, type Conn, type Db } from "../lib/db";
import { forbidden, HttpError, unauthorized } from "../lib/http";

export interface StaffContext {
  id: number;
  email: string;
  name: string;
  roleId: number;
  roleSlug: string;
  roleName: string;
  isSuperAdmin: boolean;
  permissions: Set<Permission>;
  mustChangePassword: boolean;
  sessionId: string;
  sessionExpiresAt: Date;
  stepUpAt: Date | null;
}

export const cookieName = (config: Config) => (config.cookieSecure ? "__Host-crm_staff" : "crm_staff");

export function csrfFor(config: Config, sessionToken: string): string {
  return createHmac("sha256", config.dataKey).update(`csrf:${sessionToken}`).digest("base64url");
}

export async function createSession(conn: Conn, config: Config, staffId: number, ip: string, userAgent: string) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + config.sessionMaxMs);
  await exec(
    conn,
    "INSERT INTO staff_sessions (id, staff_id, ip, user_agent, expires_at) VALUES (?, ?, ?, ?, ?)",
    [sha256(token), staffId, ip.slice(0, 45), userAgent.slice(0, 255), expiresAt],
  );
  return { token, expiresAt, csrfToken: csrfFor(config, token) };
}

export function setSessionCookie(res: Response, config: Config, token: string, expiresAt: Date) {
  res.cookie(cookieName(config), token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "strict",
    path: "/",
    expires: expiresAt,
  });
}

export function clearSessionCookie(res: Response, config: Config) {
  res.clearCookie(cookieName(config), { httpOnly: true, secure: config.cookieSecure, sameSite: "strict", path: "/" });
}

export async function revokeStaffSessions(conn: Conn, staffId: number, reason: string, exceptSessionId?: string) {
  await exec(
    conn,
    `UPDATE staff_sessions SET revoked_at = CURRENT_TIMESTAMP(3), revoked_reason = ?
     WHERE staff_id = ? AND revoked_at IS NULL ${exceptSessionId ? "AND id <> ?" : ""}`,
    exceptSessionId ? [reason, staffId, exceptSessionId] : [reason, staffId],
  );
}

export async function loadPermissions(conn: Conn, roleId: number, roleSlug: string): Promise<Set<Permission>> {
  if (roleSlug === SUPER_ADMIN_SLUG) return new Set(ALL_PERMISSIONS);
  const granted = await rows<{ permission: string }>(conn, "SELECT permission FROM role_permissions WHERE role_id = ?", [roleId]);
  const known = new Set<string>(ALL_PERMISSIONS);
  return new Set(granted.map((g) => g.permission).filter((p): p is Permission => known.has(p)));
}

interface SessionRow {
  session_id: string;
  expires_at: Date;
  last_seen_at: Date;
  stepup_at: Date | null;
  staff_id: number;
  email: string;
  name: string;
  status: string;
  must_change_password: number;
  role_id: number;
  role_slug: string;
  role_name: string;
}

// Routes a staff member with a temporary password may still use.
const PASSWORD_CHANGE_ALLOWED = new Set(["/api/staff/auth/session", "/api/staff/auth/password", "/api/staff/auth/logout"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Authenticates a staff request from its session cookie. Enforces revocation,
 * the absolute and idle timeouts, account status, and the CSRF token on every
 * state-changing request.
 */
export function staffSession(db: Db, config: Config) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const token = readCookie(req.headers.cookie, cookieName(config));
      if (!token || token.length > 128) throw unauthorized();
      const row = await one<SessionRow>(
        db,
        `SELECT s.id AS session_id, s.expires_at, s.last_seen_at, s.stepup_at,
                u.id AS staff_id, u.email, u.name, u.status, u.must_change_password,
                r.id AS role_id, r.slug AS role_slug, r.name AS role_name
         FROM staff_sessions s
         JOIN staff_users u ON u.id = s.staff_id
         JOIN roles r ON r.id = u.role_id
         WHERE s.id = ? AND s.revoked_at IS NULL`,
        [sha256(token)],
      );
      const now = Date.now();
      if (!row || row.status !== "active") throw unauthorized("Your session has ended. Please sign in again.");
      if (row.expires_at.getTime() <= now || row.last_seen_at.getTime() + config.sessionIdleMs <= now) {
        await exec(db, "UPDATE staff_sessions SET revoked_at = CURRENT_TIMESTAMP(3), revoked_reason = 'expired' WHERE id = ?", [row.session_id]);
        throw unauthorized("Your session has expired. Please sign in again.");
      }
      if (!SAFE_METHODS.has(req.method)) {
        const sent = String(req.get("x-csrf-token") ?? "");
        if (!safeEqual(sent, csrfFor(config, token))) throw new HttpError(403, "CSRF", "Refresh the page and try again.");
      }
      // Touch at most every 30 seconds to keep writes low.
      if (now - row.last_seen_at.getTime() > 30_000) {
        await exec(db, "UPDATE staff_sessions SET last_seen_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [row.session_id]);
      }
      const mustChangePassword = row.must_change_password === 1;
      if (mustChangePassword && !PASSWORD_CHANGE_ALLOWED.has(`${req.baseUrl}${req.path}`)) {
        throw new HttpError(403, "PASSWORD_CHANGE_REQUIRED", "Set a new password before continuing.");
      }
      req.staff = {
        id: row.staff_id,
        email: row.email,
        name: row.name,
        roleId: row.role_id,
        roleSlug: row.role_slug,
        roleName: row.role_name,
        isSuperAdmin: row.role_slug === SUPER_ADMIN_SLUG,
        permissions: await loadPermissions(db, row.role_id, row.role_slug),
        mustChangePassword,
        sessionId: row.session_id,
        sessionExpiresAt: row.expires_at,
        stepUpAt: row.stepup_at,
      };
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function staffOf(req: Request): StaffContext {
  if (!req.staff) throw unauthorized();
  return req.staff;
}

export function requirePermission(...needed: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const staff = req.staff;
    if (!staff) return next(unauthorized());
    if (!needed.every((p) => staff.permissions.has(p))) return next(forbidden());
    next();
  };
}

/** Sensitive actions need a fresh 2FA code within the step-up window. */
export function requireStepUp(config: Config) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const at = req.staff?.stepUpAt;
    if (!at || at.getTime() + config.stepUpMs <= Date.now()) {
      return next(new HttpError(403, "STEP_UP_REQUIRED", "Enter your 2FA code to confirm this action."));
    }
    next();
  };
}

export const staffActor = (staff: { id: number; email: string }) => ({ type: "staff" as const, id: staff.id, label: staff.email });
