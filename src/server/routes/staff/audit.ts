import { Router } from "express";
import { z } from "zod";
import type { AppDeps } from "../../app";
import { auditContext, auditStandalone, verifyAuditChain } from "../../lib/audit";
import { one, rows } from "../../lib/db";
import { handler, parse } from "../../lib/http";
import { toPage } from "../../lib/pagination";
import { requirePermission, requireStepUp, staffActor, staffOf } from "../../staff/session";

const EXPORT_LIMIT = 50_000;

const filters = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  action: z.string().trim().max(64).regex(/^[a-z0-9_.]*$/).optional(),
  actorType: z.enum(["staff", "client", "system"]).optional(),
  actorId: z.coerce.number().int().positive().optional(),
  entityType: z.string().trim().max(48).regex(/^[a-z0-9_]*$/).optional(),
  entityId: z.string().trim().max(64).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

type Filters = z.infer<typeof filters>;

function whereClause(f: Filters) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.action) {
    // "staff." matches every staff action; a full name matches exactly.
    if (f.action.endsWith(".")) (where.push("action LIKE ?"), params.push(`${f.action}%`));
    else (where.push("action = ?"), params.push(f.action));
  }
  if (f.actorType) (where.push("actor_type = ?"), params.push(f.actorType));
  if (f.actorId) (where.push("actor_id = ?"), params.push(f.actorId));
  if (f.entityType) (where.push("entity_type = ?"), params.push(f.entityType));
  if (f.entityId) (where.push("entity_id = ?"), params.push(f.entityId));
  if (f.from) (where.push("occurred_at >= ?"), params.push(f.from));
  if (f.to) (where.push("occurred_at < ?"), params.push(f.to));
  return { sql: where.length ? ` WHERE ${where.join(" AND ")}` : "", params };
}

interface AuditListRow {
  id: number;
  occurred_at: Date;
  actor_type: string;
  actor_id: number | null;
  actor_label: string;
  action: string;
  entity_type: string;
  entity_id: string;
  ip: string;
  user_agent: string;
  before_json: unknown;
  after_json: unknown;
  meta_json: unknown;
  hash: string;
}

const present = (r: AuditListRow) => ({
  id: r.id,
  occurredAt: r.occurred_at.toISOString(),
  actor: { type: r.actor_type, id: r.actor_id, label: r.actor_label },
  action: r.action,
  entity: { type: r.entity_type, id: r.entity_id },
  ip: r.ip,
  userAgent: r.user_agent,
  before: r.before_json,
  after: r.after_json,
  meta: r.meta_json,
  hash: r.hash,
});

const csvCell = (value: unknown) => {
  const text = value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
  // Neutralise spreadsheet formulas, then quote.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
};

export function staffAuditRouter(deps: AppDeps): Router {
  const { db, config } = deps;
  const router = Router();

  router.get(
    "/",
    requirePermission("audit.view"),
    handler(async (req, res) => {
      const f = parse(filters, req.query);
      const { sql, params } = whereClause(f);
      const total = await one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM audit_log${sql}`, params);
      const items = await rows<AuditListRow>(db, `SELECT * FROM audit_log${sql} ORDER BY id DESC LIMIT ? OFFSET ?`, [
        ...params,
        f.pageSize,
        (f.page - 1) * f.pageSize,
      ]);
      res.json(toPage(items.map(present), Number(total?.n ?? 0), f.page, f.pageSize));
    }),
  );

  router.get(
    "/actions",
    requirePermission("audit.view"),
    handler(async (_req, res) => {
      const list = await rows<{ action: string }>(db, "SELECT DISTINCT action FROM audit_log ORDER BY action LIMIT 500");
      res.json({ items: list.map((r) => r.action) });
    }),
  );

  router.post(
    "/verify",
    requirePermission("audit.verify"),
    handler(async (req, res) => {
      const report = await verifyAuditChain(db);
      await auditStandalone(db, auditContext(req, staffActor(staffOf(req))), {
        action: "audit.verified", meta: { ok: report.ok, checked: report.checked, brokenAtId: report.brokenAtId },
      });
      res.json(report);
    }),
  );

  router.get(
    "/export",
    requirePermission("audit.export"),
    requireStepUp(config),
    handler(async (req, res) => {
      const f = parse(filters, req.query);
      const { sql, params } = whereClause(f);
      const list = await rows<AuditListRow>(db, `SELECT * FROM audit_log${sql} ORDER BY id DESC LIMIT ?`, [...params, EXPORT_LIMIT]);
      await auditStandalone(db, auditContext(req, staffActor(staffOf(req))), {
        action: "audit.exported", meta: { rows: list.length, filters: { ...f, page: undefined, pageSize: undefined } },
      });
      const header = ["id", "occurred_at", "actor_type", "actor_id", "actor", "action", "entity_type", "entity_id", "ip", "before", "after", "meta", "hash"];
      const lines = list.map((r) =>
        [r.id, r.occurred_at.toISOString(), r.actor_type, r.actor_id, r.actor_label, r.action, r.entity_type, r.entity_id, r.ip, r.before_json, r.after_json, r.meta_json, r.hash]
          .map(csvCell)
          .join(","),
      );
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.send([header.join(","), ...lines].join("\r\n"));
    }),
  );

  return router;
}
