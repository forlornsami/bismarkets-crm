import { Router } from "express";
import { z } from "zod";
import type { AppDeps } from "../../app";
import { NOTIFICATION_TYPES } from "../../clients/notifications";
import { clientActor, clientAuth, clientOf, noImpersonation, revokeClientSession, revokeClientSessions } from "../../clients/session";
import { auditContext, writeAudit } from "../../lib/audit";
import { exec, one, rows, transaction } from "../../lib/db";
import { sessionRef } from "../../lib/events";
import { handler, HttpError } from "../../lib/http";

/** "Chrome on Windows" style labels from a user agent, for the devices list. */
export function describeAgent(ua: string) {
  const browser =
    /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /okhttp|Expo|ReactNative|Darwin|CFNetwork/i.test(ua) ? "BIS Markets app" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad|iOS/.test(ua) ? "iOS" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "Unknown system";
  const mobile = /Mobile|Android|iPhone|iPad|okhttp|Expo/i.test(ua);
  return { browser, os, device: mobile ? ("mobile" as const) : ("desktop" as const) };
}

/** The bell (notifications) and signed-in devices, as the portal and app call them. */
export function clientAccountRouter(deps: AppDeps): Router {
  const { db, config } = deps;
  const router = Router();
  const auth = clientAuth(db, config);

  // ---------- Notifications ----------

  router.get(
    "/notifications",
    auth,
    handler(async (req, res) => {
      const q = z.object({ per_page: z.coerce.number().int().min(1).max(100).default(50), page: z.coerce.number().int().min(1).default(1) }).catch({ per_page: 50, page: 1 }).parse(req.query);
      const client = clientOf(req);
      const items = await rows<{ id: number; type: string; title: string; body: string; link: string | null; link_label: string | null; read_at: Date | null; created_at: Date }>(
        db,
        "SELECT id, type, title, body, link, link_label, read_at, created_at FROM client_notifications WHERE client_id = ? ORDER BY id DESC LIMIT ? OFFSET ?",
        [client.id, q.per_page, (q.page - 1) * q.per_page],
      );
      const counts = await one<{ total: number; unread: number }>(db, "SELECT COUNT(*) AS total, SUM(read_at IS NULL) AS unread FROM client_notifications WHERE client_id = ?", [client.id]);
      res.json({
        success: true,
        data: items.map((n) => ({
          id: String(n.id),
          type: n.type,
          title: n.title,
          body: n.body,
          message: n.body,
          link: n.link,
          link_label: n.link_label,
          read_at: n.read_at?.toISOString() ?? null,
          is_read: n.read_at !== null,
          created_at: n.created_at.toISOString(),
        })),
        unread_count: Number(counts?.unread ?? 0),
        total: Number(counts?.total ?? 0),
        current_page: q.page,
        per_page: q.per_page,
      });
    }),
  );

  router.get(
    "/notification-types",
    auth,
    handler(async (_req, res) => {
      res.json({ success: true, data: NOTIFICATION_TYPES });
    }),
  );

  // Blocked in a staff view-only session: marking read would hide unread items from the client.
  router.post(
    "/notifications/mark-all-read",
    auth,
    noImpersonation,
    handler(async (req, res) => {
      const r = await exec(db, "UPDATE client_notifications SET read_at = CURRENT_TIMESTAMP(3) WHERE client_id = ? AND read_at IS NULL", [clientOf(req).id]);
      res.json({ success: true, updated: r.affectedRows });
    }),
  );

  router.post(
    "/notifications/:id/read",
    auth,
    noImpersonation,
    handler(async (req, res) => {
      const nid = z.coerce.number().int().positive().safeParse(req.params.id);
      if (!nid.success) throw new HttpError(404, "NOT_FOUND", "Notification not found.");
      const r = await exec(db, "UPDATE client_notifications SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP(3)) WHERE id = ? AND client_id = ?", [nid.data, clientOf(req).id]);
      if (!r.affectedRows) throw new HttpError(404, "NOT_FOUND", "Notification not found.");
      res.json({ success: true });
    }),
  );

  // ---------- Signed-in devices ----------

  router.get(
    "/sessions",
    auth,
    handler(async (req, res) => {
      const client = clientOf(req);
      const list = await rows<{ id: string; ip: string; user_agent: string; created_at: Date; last_seen_at: Date }>(
        db,
        `SELECT id, ip, user_agent, created_at, last_seen_at FROM client_sessions
         WHERE client_id = ? AND kind = 'login' AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP(3)
           AND last_seen_at > CURRENT_TIMESTAMP(3) - INTERVAL ? SECOND
         ORDER BY last_seen_at DESC LIMIT 50`,
        [client.id, Math.floor(config.clientIdleMs / 1000)],
      );
      res.json({
        success: true,
        data: list.map((s) => ({
          id: sessionRef(s.id),
          ...describeAgent(s.user_agent),
          ip: s.ip,
          location: s.ip,
          signed_in_at: s.created_at.toISOString(),
          last_active: s.last_seen_at.toISOString(),
          current: s.id === client.sessionId,
        })),
      });
    }),
  );

  router.delete(
    "/sessions/:id",
    auth,
    noImpersonation,
    handler(async (req, res) => {
      const client = clientOf(req);
      const ref = String(req.params.id);
      if (!/^[a-f0-9]{32}$/.test(ref)) throw new HttpError(404, "NOT_FOUND", "That device is not signed in.");
      const done = await transaction(db, async (conn) => {
        const s = await one<{ id: string }>(conn, "SELECT id FROM client_sessions WHERE client_id = ? AND kind = 'login' AND revoked_at IS NULL AND LEFT(id, 32) = ? FOR UPDATE", [client.id, ref]);
        if (!s) return false;
        await revokeClientSession(conn, config, client.id, s.id, "client_removed_device");
        await writeAudit(conn, auditContext(req, clientActor(client)), { action: "client.device_signed_out", entityType: "client", entityId: client.id, meta: { current: s.id === client.sessionId } });
        return true;
      });
      if (!done) throw new HttpError(404, "NOT_FOUND", "That device is not signed in.");
      res.json({ success: true, message: "That device has been signed out." });
    }),
  );

  router.delete(
    "/sessions",
    auth,
    noImpersonation,
    handler(async (req, res) => {
      const client = clientOf(req);
      const n = await transaction(db, async (conn) => {
        const count = await revokeClientSessions(conn, config, client.id, "client_signed_out_others", client.sessionId, true);
        await writeAudit(conn, auditContext(req, clientActor(client)), { action: "client.other_devices_signed_out", entityType: "client", entityId: client.id, meta: { sessions: count } });
        return count;
      });
      res.json({ success: true, message: n ? `Signed out ${n} other device${n === 1 ? "" : "s"}.` : "No other devices were signed in.", revoked: n });
    }),
  );

  return router;
}
