import type { Request } from "express";
import type { Config } from "../config";
import { auditContext, writeAudit } from "../lib/audit";
import { randomToken, sha256 } from "../lib/crypto";
import { exec, transaction, type Db } from "../lib/db";
import { queueEmail } from "../lib/email";
import { clientActor } from "./session";

const RESET_TTL_MS = 60 * 60_000;

/**
 * Emails a one-time link to the portal's reset page. Any earlier link stops
 * working. Staff-requested links are audited by the staff route instead.
 */
export async function createResetLink(db: Db, config: Config, req: Request, client: { id: number; email: string; first_name: string }, staffId: number | null, ttlMs = RESET_TTL_MS) {
  const token = randomToken();
  const link = `${config.portalUrl}/reset-password?token=${encodeURIComponent(token)}&email=${encodeURIComponent(client.email)}`;
  const hours = Math.round(ttlMs / 3_600_000);
  await transaction(db, async (conn) => {
    await exec(conn, "UPDATE client_password_resets SET used_at = CURRENT_TIMESTAMP(3) WHERE client_id = ? AND used_at IS NULL", [client.id]);
    await exec(conn, "INSERT INTO client_password_resets (token_hash, client_id, requested_by_staff_id, expires_at) VALUES (?, ?, ?, ?)", [
      sha256(token), client.id, staffId, new Date(Date.now() + ttlMs),
    ]);
    await queueEmail(conn, config, {
      to: client.email,
      template: "password_reset",
      subject: "Set your BIS Markets password",
      text: `Hello ${client.first_name},\n\nUse this link to set a new password. It works once and expires in ${hours <= 1 ? "60 minutes" : `${hours} hours`}:\n${link}\n\nIf you did not ask for this, ignore this email; your password stays the same.`,
      secrets: [link, token],
      clientId: client.id,
    });
    if (!staffId) await writeAudit(conn, auditContext(req, clientActor(client)), { action: "client.password_reset_requested", entityType: "client", entityId: client.id });
  });
}
