import { Router } from "express";
import { z } from "zod";
import type { AppDeps } from "../../app";
import { auditContext, writeAudit } from "../../lib/audit";
import { decryptField } from "../../lib/crypto";
import { exec, one, rows, transaction } from "../../lib/db";
import { mailEnabled, outboxContext } from "../../lib/email";
import { badRequest, handler, notFound, parse } from "../../lib/http";
import { likeTerm, listQuery, toPage } from "../../lib/pagination";
import { requirePermission, staffActor, staffOf } from "../../staff/session";

interface OutboxRow {
  id: number;
  to_email: string;
  template: string;
  subject: string;
  body_text: string;
  body_enc: Buffer;
  category: string;
  client_id: number | null;
  staff_user_id: number | null;
  campaign_id: number | null;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  sent_at: Date | null;
}

const present = (r: OutboxRow) => ({
  id: r.id,
  to: r.to_email,
  template: r.template,
  subject: r.subject,
  category: r.category,
  clientId: r.client_id,
  staffUserId: r.staff_user_id,
  campaignId: r.campaign_id,
  status: r.status,
  attempts: r.attempts,
  lastError: r.last_error,
  createdAt: r.created_at.toISOString(),
  sentAt: r.sent_at?.toISOString() ?? null,
});

const COLUMNS = "id, to_email, template, subject, body_text, body_enc, category, client_id, staff_user_id, campaign_id, status, attempts, last_error, created_at, sent_at";

/** The email outbox: every email the CRM has sent, is sending, or is holding until sending is switched on. */
export function staffEmailsRouter(deps: AppDeps): Router {
  const { db, config } = deps;
  const router = Router();
  // Outside production the full message (with codes and links) can be read, so
  // sign-up can be tested before email sending is switched on.
  const testMode = config.env !== "production";

  router.get(
    "/",
    requirePermission("comms.view"),
    handler(async (req, res) => {
      const query = parse(listQuery(["created_at"], "created_at").extend({
          clientId: z.coerce.number().int().positive().optional(),
          staffUserId: z.coerce.number().int().positive().optional(),
          campaignId: z.coerce.number().int().positive().optional(),
          status: z.enum(["queued", "sending", "sent", "failed", "held", "cancelled"]).optional(),
        }), req.query);
      const where: string[] = ["1 = 1"];
      const params: unknown[] = [];
      if (query.q) (where.push("(to_email LIKE ? OR subject LIKE ? OR template LIKE ?)"), params.push(likeTerm(query.q), likeTerm(query.q), likeTerm(query.q)));
      if (query.clientId) (where.push("client_id = ?"), params.push(query.clientId));
      if (query.staffUserId) (where.push("staff_user_id = ?"), params.push(query.staffUserId));
      if (query.campaignId) (where.push("campaign_id = ?"), params.push(query.campaignId));
      if (query.status) (where.push("status = ?"), params.push(query.status));
      const clause = ` WHERE ${where.join(" AND ")}`;
      const total = await one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM email_outbox${clause}`, params);
      const items = await rows<OutboxRow>(
        db,
        `SELECT ${COLUMNS} FROM email_outbox${clause}
         ORDER BY id ${query.dir === "asc" ? "ASC" : "DESC"} LIMIT ? OFFSET ?`,
        [...params, query.pageSize, (query.page - 1) * query.pageSize],
      );
      res.json({ ...toPage(items.map(present), Number(total?.n ?? 0), query.page, query.pageSize), testMode, deliveryOn: await mailEnabled(db) });
    }),
  );

  router.get(
    "/:id",
    requirePermission("comms.view"),
    handler(async (req, res) => {
      const row = await one<OutboxRow>(db, "SELECT * FROM email_outbox WHERE id = ?", [parse(z.coerce.number().int().positive(), req.params.id)]);
      if (!row) throw notFound();
      res.json({
        ...present(row),
        body: testMode ? decryptField(config.dataKey, row.body_enc, outboxContext(row.to_email, row.template)) : row.body_text,
        testMode,
      });
    }),
  );

  // Puts a held or failed email back in the queue, e.g. after fixing the mail settings.
  router.post(
    "/:id/retry",
    requirePermission("comms.send"),
    handler(async (req, res) => {
      const id = parse(z.coerce.number().int().positive(), req.params.id);
      const staff = staffOf(req);
      await transaction(db, async (conn) => {
        const row = await one<{ status: string; to_email: string; template: string }>(conn, "SELECT status, to_email, template FROM email_outbox WHERE id = ? FOR UPDATE", [id]);
        if (!row) throw notFound();
        if (row.status !== "held" && row.status !== "failed") throw badRequest("Only held or failed emails can be sent again.");
        if (!(await mailEnabled(conn))) throw badRequest("Switch sending on in Settings > Email first.");
        await exec(conn, "UPDATE email_outbox SET status = 'queued', attempts = 0, last_error = NULL, next_attempt_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [id]);
        await writeAudit(conn, auditContext(req, staffActor(staff)), { action: "email.retried", entityType: "email", entityId: id, before: { status: row.status }, meta: { to: row.to_email, template: row.template } });
      });
      res.json({ ok: true });
    }),
  );

  router.post(
    "/:id/cancel",
    requirePermission("comms.send"),
    handler(async (req, res) => {
      const id = parse(z.coerce.number().int().positive(), req.params.id);
      const staff = staffOf(req);
      await transaction(db, async (conn) => {
        const row = await one<{ status: string; to_email: string; template: string }>(conn, "SELECT status, to_email, template FROM email_outbox WHERE id = ? FOR UPDATE", [id]);
        if (!row) throw notFound();
        if (row.status !== "held" && row.status !== "queued") throw badRequest("Only emails that have not been sent yet can be cancelled.");
        await exec(conn, "UPDATE email_outbox SET status = 'cancelled' WHERE id = ?", [id]);
        await writeAudit(conn, auditContext(req, staffActor(staff)), { action: "email.cancelled", entityType: "email", entityId: id, before: { status: row.status }, meta: { to: row.to_email, template: row.template } });
      });
      res.json({ ok: true });
    }),
  );

  return router;
}
