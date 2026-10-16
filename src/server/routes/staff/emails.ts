import { Router } from "express";
import { z } from "zod";
import type { AppDeps } from "../../app";
import { decryptField } from "../../lib/crypto";
import { one, rows } from "../../lib/db";
import { outboxContext } from "../../lib/email";
import { handler, notFound, parse } from "../../lib/http";
import { likeTerm, listQuery, toPage } from "../../lib/pagination";
import { requirePermission } from "../../staff/session";

interface OutboxRow {
  id: number;
  to_email: string;
  template: string;
  subject: string;
  body_text: string;
  body_enc: Buffer;
  client_id: number | null;
  status: string;
  created_at: Date;
  sent_at: Date | null;
}

const present = (r: OutboxRow) => ({
  id: r.id,
  to: r.to_email,
  template: r.template,
  subject: r.subject,
  clientId: r.client_id,
  status: r.status,
  createdAt: r.created_at.toISOString(),
  sentAt: r.sent_at?.toISOString() ?? null,
});

/** The email outbox: what the CRM has sent or is holding until a mail provider is connected. */
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
      const query = parse(listQuery(["created_at"], "created_at").extend({ clientId: z.coerce.number().int().positive().optional() }), req.query);
      const where: string[] = ["1 = 1"];
      const params: unknown[] = [];
      if (query.q) (where.push("(to_email LIKE ? OR subject LIKE ? OR template LIKE ?)"), params.push(likeTerm(query.q), likeTerm(query.q), likeTerm(query.q)));
      if (query.clientId) (where.push("client_id = ?"), params.push(query.clientId));
      const clause = ` WHERE ${where.join(" AND ")}`;
      const total = await one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM email_outbox${clause}`, params);
      const items = await rows<OutboxRow>(
        db,
        `SELECT id, to_email, template, subject, body_text, body_enc, client_id, status, created_at, sent_at FROM email_outbox${clause}
         ORDER BY id ${query.dir === "asc" ? "ASC" : "DESC"} LIMIT ? OFFSET ?`,
        [...params, query.pageSize, (query.page - 1) * query.pageSize],
      );
      res.json({ ...toPage(items.map(present), Number(total?.n ?? 0), query.page, query.pageSize), testMode });
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

  return router;
}
