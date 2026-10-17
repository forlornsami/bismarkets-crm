import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { z } from "zod";
import type { AppDeps } from "../../app";
import { auditContext, writeAudit } from "../../lib/audit";
import { encryptField } from "../../lib/crypto";
import { exec, one, rows, transaction, type Conn } from "../../lib/db";
import { mailEnabled, outboxContext } from "../../lib/email";
import { badRequest, conflict, forbidden, handler, notFound, parse } from "../../lib/http";
import { likeTerm, listQuery, toPage } from "../../lib/pagination";
import { requirePermission, requireStepUp, staffActor, staffOf } from "../../staff/session";

// Emails staff write: to one client, a group of clients, or colleagues.
// Everything goes through the outbox, so it is delivered with retries once a
// mail provider is switched on, and every send is in the audit log.

export const MAX_RECIPIENTS = 20_000;
export const MESSAGE_TEMPLATE = "staff_message";

export const PLACEHOLDERS = {
  first_name: "First name",
  last_name: "Last name",
  full_name: "Full name",
  email: "Email address",
  client_id: "Client number (clients only)",
  portal_url: "Client portal address",
} as const;
type Placeholder = keyof typeof PLACEHOLDERS;

const PLACEHOLDER_RE = /\{\{\s*([a-z_]+)\s*\}\}/g;

function checkPlaceholders(...texts: string[]) {
  for (const text of texts) {
    for (const m of text.matchAll(PLACEHOLDER_RE)) {
      if (!((m[1] ?? "") in PLACEHOLDERS)) throw badRequest(`{{${m[1]}}} is not a known placeholder. Use one of: ${Object.keys(PLACEHOLDERS).map((p) => `{{${p}}}`).join(", ")}.`);
    }
  }
}

interface Recipient {
  id: number;
  email: string;
  first_name: string;
  last_name: string;
}

export function fillPlaceholders(text: string, r: Recipient, kind: "clients" | "staff", portalUrl: string) {
  const values: Record<Placeholder, string> = {
    first_name: r.first_name,
    last_name: r.last_name,
    full_name: `${r.first_name} ${r.last_name}`.trim(),
    email: r.email,
    client_id: kind === "clients" ? String(r.id) : "",
    portal_url: portalUrl,
  };
  return text.replace(PLACEHOLDER_RE, (_all, key: string) => values[key as Placeholder] ?? "");
}

const subjectField = z
  .string()
  .trim()
  .min(1, "Enter a subject.")
  .max(200, "The subject can be at most 200 characters.")
  .refine((v) => !/[\r\n]/.test(v), "The subject must be one line.");
const bodyField = z.string().trim().min(1, "Write the message.").max(20_000, "The message can be at most 20,000 characters.");

const idList = (max: number) => z.array(z.coerce.number().int().positive()).max(max).optional();

const clientFilter = z.object({
  clientIds: idList(500),
  status: z.array(z.enum(["active", "frozen", "closed"])).max(3).optional(),
  kyc: z.array(z.enum(["none", "pending", "approved", "rejected"])).max(4).optional(),
  countries: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
  assigned: z.union([z.literal("me"), z.literal("none"), z.coerce.number().int().positive()]).optional(),
  registeredFrom: z.string().date().optional(),
  registeredTo: z.string().date().optional(),
});
const staffFilter = z.object({
  staffIds: idList(500),
  roleIds: idList(50),
});

const audienceBody = z.discriminatedUnion("audience", [
  z.object({ audience: z.literal("clients"), filter: clientFilter, category: z.enum(["service", "marketing"]).default("service") }),
  z.object({ audience: z.literal("staff"), filter: staffFilter, category: z.literal("service").default("service") }),
]);
type Audience = z.infer<typeof audienceBody>;

const messageBody = z.intersection(audienceBody, z.object({ subject: subjectField, body: bodyField, templateId: z.coerce.number().int().positive().optional() }));

const isSingleClient = (a: Audience) => a.audience === "clients" && a.filter.clientIds?.length === 1 && Object.keys(a.filter).length === 1;

type Staff = ReturnType<typeof staffOf>;

/** comms.send covers one client; anything wider needs comms.bulk. */
function assertMaySend(staff: Staff, a: Audience) {
  if (!staff.permissions.has("comms.send")) throw forbidden();
  if (a.audience === "clients" && !staff.permissions.has("client.view")) throw forbidden();
  if (!isSingleClient(a) && !staff.permissions.has("comms.bulk")) throw forbidden("You can email one client at a time. Emailing groups of clients or staff needs the bulk email permission.");
}

async function resolveRecipients(conn: Conn, staff: Staff, a: Audience, limit = MAX_RECIPIENTS + 1): Promise<Recipient[]> {
  if (a.audience === "staff") {
    const where = ["u.status = 'active'"];
    const params: unknown[] = [];
    const f = a.filter;
    if (f.staffIds?.length) (where.push(`u.id IN (${f.staffIds.map(() => "?").join(",")})`), params.push(...f.staffIds));
    if (f.roleIds?.length) (where.push(`u.role_id IN (${f.roleIds.map(() => "?").join(",")})`), params.push(...f.roleIds));
    return rows<Recipient>(
      conn,
      `SELECT u.id, u.email, SUBSTRING_INDEX(u.name, ' ', 1) AS first_name,
              TRIM(SUBSTRING(u.name, LENGTH(SUBSTRING_INDEX(u.name, ' ', 1)) + 1)) AS last_name
       FROM staff_users u WHERE ${where.join(" AND ")} ORDER BY u.id LIMIT ?`,
      [...params, limit],
    );
  }
  const f = a.filter;
  const where: string[] = [];
  const params: unknown[] = [];
  // Staff without client.view_all can only reach their own clients.
  if (!staff.permissions.has("client.view_all")) (where.push("c.assigned_staff_id = ?"), params.push(staff.id));
  if (f.clientIds?.length) (where.push(`c.id IN (${f.clientIds.map(() => "?").join(",")})`), params.push(...f.clientIds));
  // Closed accounts are left out of groups unless asked for, and never get marketing.
  const statuses = (f.status?.length ? f.status : f.clientIds?.length ? ["active", "frozen", "closed"] : ["active", "frozen"]).filter((s) => a.category !== "marketing" || s !== "closed");
  if (!statuses.length) return [];
  where.push(`c.status IN (${statuses.map(() => "?").join(",")})`);
  params.push(...statuses);
  if (f.kyc?.length) (where.push(`c.kyc_status IN (${f.kyc.map(() => "?").join(",")})`), params.push(...f.kyc));
  if (f.countries?.length) (where.push(`c.country IN (${f.countries.map(() => "?").join(",")})`), params.push(...f.countries));
  if (f.assigned === "me") (where.push("c.assigned_staff_id = ?"), params.push(staff.id));
  else if (f.assigned === "none") where.push("c.assigned_staff_id IS NULL");
  else if (typeof f.assigned === "number") (where.push("c.assigned_staff_id = ?"), params.push(f.assigned));
  if (f.registeredFrom) (where.push("c.created_at >= ?"), params.push(`${f.registeredFrom} 00:00:00`));
  if (f.registeredTo) (where.push("c.created_at < ? + INTERVAL 1 DAY"), params.push(`${f.registeredTo} 00:00:00`));
  if (a.category === "marketing") where.push("c.marketing_opt_out_at IS NULL AND c.email_verified_at IS NOT NULL");
  return rows<Recipient>(conn, `SELECT c.id, c.email, c.first_name, c.last_name FROM clients c WHERE ${where.join(" AND ")} ORDER BY c.id LIMIT ?`, [...params, limit]);
}

async function describeAudience(conn: Conn, a: Audience, recipients: Recipient[]) {
  if (a.audience === "staff") {
    if (a.filter.staffIds?.length && !a.filter.roleIds?.length && recipients[0] && recipients.length === 1) return `Staff: ${recipients[0].email}`;
    if (a.filter.roleIds?.length) {
      const roles = await rows<{ name: string }>(conn, `SELECT name FROM roles WHERE id IN (${a.filter.roleIds.map(() => "?").join(",")})`, a.filter.roleIds);
      return `Staff in ${roles.map((r) => r.name).join(", ")}`;
    }
    return a.filter.staffIds?.length ? `${recipients.length} selected staff` : "All active staff";
  }
  if (isSingleClient(a) && recipients[0] && recipients.length === 1) return `Client ${recipients[0].id} (${recipients[0].email})`;
  const parts: string[] = [];
  if (a.filter.clientIds?.length) parts.push(`${a.filter.clientIds.length} selected`);
  if (a.filter.status?.length) parts.push(`status ${a.filter.status.join("/")}`);
  if (a.filter.kyc?.length) parts.push(`KYC ${a.filter.kyc.join("/")}`);
  if (a.filter.countries?.length) parts.push(a.filter.countries.join(", ").slice(0, 80));
  if (a.filter.assigned) parts.push(a.filter.assigned === "me" ? "assigned to me" : a.filter.assigned === "none" ? "unassigned" : `assigned to staff ${a.filter.assigned}`);
  if (a.filter.registeredFrom || a.filter.registeredTo) parts.push(`registered ${a.filter.registeredFrom ?? "…"} to ${a.filter.registeredTo ?? "…"}`);
  return (`Clients${parts.length ? `: ${parts.join(", ")}` : ": all"}`).slice(0, 255);
}

interface CampaignRow {
  id: number;
  audience: "clients" | "staff";
  audience_label: string;
  category: "service" | "marketing";
  subject: string;
  body: string;
  recipients: number;
  created_by: number;
  created_by_name: string;
  created_at: Date;
  sent: number | null;
  failed: number | null;
  waiting: number | null;
  cancelled: number | null;
}

const presentCampaign = (r: CampaignRow) => ({
  id: r.id,
  audience: r.audience,
  audienceLabel: r.audience_label,
  category: r.category,
  subject: r.subject,
  recipients: r.recipients,
  createdBy: { id: r.created_by, name: r.created_by_name },
  createdAt: r.created_at.toISOString(),
  delivery: { sent: Number(r.sent ?? 0), failed: Number(r.failed ?? 0), waiting: Number(r.waiting ?? 0), cancelled: Number(r.cancelled ?? 0) },
});

const CAMPAIGN_SELECT = `SELECT m.*, s.name AS created_by_name,
    (SELECT SUM(o.status = 'sent') FROM email_outbox o WHERE o.campaign_id = m.id) AS sent,
    (SELECT SUM(o.status = 'failed') FROM email_outbox o WHERE o.campaign_id = m.id) AS failed,
    (SELECT SUM(o.status IN ('queued', 'sending', 'held')) FROM email_outbox o WHERE o.campaign_id = m.id) AS waiting,
    (SELECT SUM(o.status = 'cancelled') FROM email_outbox o WHERE o.campaign_id = m.id) AS cancelled
  FROM email_campaigns m JOIN staff_users s ON s.id = m.created_by`;

const templateBody = z.object({
  name: z.string().trim().min(1, "Give the template a name.").max(80),
  subject: subjectField,
  body: bodyField,
  category: z.enum(["service", "marketing"]).default("service"),
});

/** Writing and sending emails, sent history, and saved templates. */
export function staffMessagesRouter(deps: AppDeps): Router {
  const { db, config } = deps;
  const router = Router();
  const stepUp = requireStepUp(config);
  // A fresh 2FA code is needed for anything wider than one client.
  const stepUpForGroups = (req: Request, res: Response, next: NextFunction) => {
    const parsed = audienceBody.safeParse(req.body);
    if (parsed.success && isSingleClient(parsed.data)) return next();
    stepUp(req, res, next);
  };

  router.get(
    "/placeholders",
    requirePermission("comms.view"),
    handler(async (_req, res) => {
      res.json({ placeholders: Object.entries(PLACEHOLDERS).map(([key, label]) => ({ key, label })), maxRecipients: MAX_RECIPIENTS });
    }),
  );

  // Who staff emails can go to: active colleagues and roles.
  router.get(
    "/directory",
    requirePermission("comms.bulk"),
    handler(async (_req, res) => {
      const staff = await rows<{ id: number; name: string; email: string; role_id: number; role_name: string }>(
        db,
        "SELECT u.id, u.name, u.email, u.role_id, r.name AS role_name FROM staff_users u JOIN roles r ON r.id = u.role_id WHERE u.status = 'active' ORDER BY u.name",
      );
      const roles = await rows<{ id: number; name: string; members: number }>(
        db,
        "SELECT r.id, r.name, COUNT(u.id) AS members FROM roles r LEFT JOIN staff_users u ON u.role_id = r.id AND u.status = 'active' GROUP BY r.id, r.name ORDER BY r.name",
      );
      res.json({
        staff: staff.map((s) => ({ id: s.id, name: s.name, email: s.email, roleId: s.role_id, role: s.role_name })),
        roles: roles.map((r) => ({ id: r.id, name: r.name, members: Number(r.members) })),
      });
    }),
  );

  // How many people an email would reach, and how it reads for the first of them.
  router.post(
    "/preview",
    requirePermission("comms.send"),
    handler(async (req, res) => {
      const body = parse(z.intersection(audienceBody, z.object({ subject: z.string().max(200).default(""), body: z.string().max(20_000).default("") })), req.body);
      const staff = staffOf(req);
      assertMaySend(staff, body);
      checkPlaceholders(body.subject, body.body);
      const list = await resolveRecipients(db, staff, body);
      const first = list[0];
      res.json({
        count: Math.min(list.length, MAX_RECIPIENTS),
        tooMany: list.length > MAX_RECIPIENTS,
        sample: list.slice(0, 5).map((r) => ({ id: r.id, email: r.email, name: `${r.first_name} ${r.last_name}`.trim() })),
        rendered: first
          ? { to: first.email, subject: fillPlaceholders(body.subject, first, body.audience, config.portalUrl), body: fillPlaceholders(body.body, first, body.audience, config.portalUrl) }
          : null,
        deliveryOn: await mailEnabled(db),
      });
    }),
  );

  router.post(
    "/send",
    requirePermission("comms.send"),
    stepUpForGroups,
    handler(async (req, res) => {
      const input = parse(z.intersection(messageBody, z.object({ expectedCount: z.coerce.number().int().min(1) })), req.body);
      const staff = staffOf(req);
      assertMaySend(staff, input);
      checkPlaceholders(input.subject, input.body);
      const result = await transaction(db, async (conn) => {
        const list = await resolveRecipients(conn, staff, input);
        if (!list.length) throw badRequest("Nobody matches these recipients.");
        if (list.length > MAX_RECIPIENTS) throw badRequest(`One email can go to at most ${MAX_RECIPIENTS.toLocaleString("en")} people. Narrow the recipients.`);
        // The count staff confirmed must still be true, so a changed list is never sent blind.
        if (list.length !== input.expectedCount) throw conflict(`The recipients changed: this would now go to ${list.length}. Check the preview and send again.`);
        const label = await describeAudience(conn, input, list);
        const { insertId: campaignId } = await exec(
          conn,
          `INSERT INTO email_campaigns (audience, audience_label, filter, category, subject, body, template_id, recipients, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [input.audience, label, JSON.stringify(input.filter), input.category, input.subject, input.body, input.templateId ?? null, list.length, staff.id],
        );
        const status = (await mailEnabled(conn)) ? "queued" : "held";
        for (let i = 0; i < list.length; i += 500) {
          const chunk = list.slice(i, i + 500);
          const values: unknown[] = [];
          for (const r of chunk) {
            const subject = fillPlaceholders(input.subject, r, input.audience, config.portalUrl).slice(0, 200);
            const text = fillPlaceholders(input.body, r, input.audience, config.portalUrl);
            values.push(
              r.email, MESSAGE_TEMPLATE, input.category, subject, text,
              encryptField(config.dataKey, text, outboxContext(r.email, MESSAGE_TEMPLATE)),
              input.audience === "clients" ? r.id : null,
              input.audience === "staff" ? r.id : null,
              campaignId, status,
            );
          }
          await exec(
            conn,
            `INSERT INTO email_outbox (to_email, template, category, subject, body_text, body_enc, client_id, staff_user_id, campaign_id, status)
             VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(",")}`,
            values,
          );
        }
        await writeAudit(conn, auditContext(req, staffActor(staff)), {
          action: input.audience === "staff" ? "email.sent_to_staff" : list.length === 1 ? "email.sent_to_client" : "email.sent_to_clients",
          entityType: list.length === 1 && input.audience === "clients" ? "client" : "email_campaign",
          entityId: list.length === 1 && input.audience === "clients" ? list[0]?.id : campaignId,
          after: { campaignId, audience: label, category: input.category, recipients: list.length, subject: input.subject },
        });
        return { campaignId, recipients: list.length, status };
      });
      res.status(201).json({ id: result.campaignId, recipients: result.recipients, held: result.status === "held" });
    }),
  );

  // ---------- Templates ----------

  router.get(
    "/templates",
    requirePermission("comms.view"),
    handler(async (_req, res) => {
      const list = await rows<{ id: number; name: string; subject: string; body: string; category: string; updated_at: Date; updated_by_name: string | null }>(
        db,
        "SELECT t.id, t.name, t.subject, t.body, t.category, t.updated_at, s.name AS updated_by_name FROM email_templates t LEFT JOIN staff_users s ON s.id = COALESCE(t.updated_by, t.created_by) ORDER BY t.name",
      );
      res.json({
        items: list.map((t) => ({ id: t.id, name: t.name, subject: t.subject, body: t.body, category: t.category, updatedAt: t.updated_at.toISOString(), updatedBy: t.updated_by_name })),
      });
    }),
  );

  router.post(
    "/templates",
    requirePermission("comms.templates"),
    handler(async (req, res) => {
      const body = parse(templateBody, req.body);
      checkPlaceholders(body.subject, body.body);
      const staff = staffOf(req);
      const id = await transaction(db, async (conn) => {
        if (await one(conn, "SELECT id FROM email_templates WHERE name = ?", [body.name])) throw conflict("A template with this name already exists.");
        const r = await exec(conn, "INSERT INTO email_templates (name, subject, body, category, created_by) VALUES (?, ?, ?, ?, ?)", [body.name, body.subject, body.body, body.category, staff.id]);
        await writeAudit(conn, auditContext(req, staffActor(staff)), { action: "email.template_created", entityType: "email_template", entityId: r.insertId, after: body });
        return r.insertId;
      });
      res.status(201).json({ id });
    }),
  );

  router.patch(
    "/templates/:id",
    requirePermission("comms.templates"),
    handler(async (req, res) => {
      const id = parse(z.coerce.number().int().positive(), req.params.id);
      const body = parse(templateBody, req.body);
      checkPlaceholders(body.subject, body.body);
      const staff = staffOf(req);
      await transaction(db, async (conn) => {
        const before = await one<{ name: string; subject: string; body: string; category: string }>(conn, "SELECT name, subject, body, category FROM email_templates WHERE id = ? FOR UPDATE", [id]);
        if (!before) throw notFound();
        if (await one(conn, "SELECT id FROM email_templates WHERE name = ? AND id <> ?", [body.name, id])) throw conflict("A template with this name already exists.");
        await exec(conn, "UPDATE email_templates SET name = ?, subject = ?, body = ?, category = ?, updated_by = ? WHERE id = ?", [body.name, body.subject, body.body, body.category, staff.id, id]);
        await writeAudit(conn, auditContext(req, staffActor(staff)), { action: "email.template_updated", entityType: "email_template", entityId: id, before, after: body });
      });
      res.json({ id });
    }),
  );

  router.delete(
    "/templates/:id",
    requirePermission("comms.templates"),
    handler(async (req, res) => {
      const id = parse(z.coerce.number().int().positive(), req.params.id);
      const staff = staffOf(req);
      await transaction(db, async (conn) => {
        const before = await one<{ name: string; subject: string }>(conn, "SELECT name, subject FROM email_templates WHERE id = ? FOR UPDATE", [id]);
        if (!before) throw notFound();
        await exec(conn, "DELETE FROM email_templates WHERE id = ?", [id]);
        await writeAudit(conn, auditContext(req, staffActor(staff)), { action: "email.template_deleted", entityType: "email_template", entityId: id, before });
      });
      res.status(204).end();
    }),
  );

  // ---------- Sent history ----------

  router.get(
    "/",
    requirePermission("comms.view"),
    handler(async (req, res) => {
      const query = parse(listQuery(["created_at"], "created_at"), req.query);
      const where: string[] = ["1 = 1"];
      const params: unknown[] = [];
      if (query.q) (where.push("(m.subject LIKE ? OR m.audience_label LIKE ?)"), params.push(likeTerm(query.q), likeTerm(query.q)));
      const clause = ` WHERE ${where.join(" AND ")}`;
      const total = await one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM email_campaigns m${clause}`, params);
      const items = await rows<CampaignRow>(db, `${CAMPAIGN_SELECT}${clause} ORDER BY m.id ${query.dir === "asc" ? "ASC" : "DESC"} LIMIT ? OFFSET ?`, [
        ...params,
        query.pageSize,
        (query.page - 1) * query.pageSize,
      ]);
      res.json(toPage(items.map(presentCampaign), Number(total?.n ?? 0), query.page, query.pageSize));
    }),
  );

  router.get(
    "/:id",
    requirePermission("comms.view"),
    handler(async (req, res) => {
      const row = await one<CampaignRow>(db, `${CAMPAIGN_SELECT} WHERE m.id = ?`, [parse(z.coerce.number().int().positive(), req.params.id)]);
      if (!row) throw notFound();
      res.json({ ...presentCampaign(row), body: row.body });
    }),
  );

  return router;
}
