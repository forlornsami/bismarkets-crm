import { Router, type Request } from "express";
import { z } from "zod";
import type { AppDeps } from "../../app";
import {
  clientName,
  clientPictureUrl,
  emailField,
  loadClient,
  nameField,
  newReferralCode,
  profileColumns,
  profileFields,
  SELECT_CLIENT,
  updateClientColumns,
  type ClientRow,
} from "../../clients/model";
import { createResetLink } from "../../clients/reset";
import { createClientSession, revokeClientSessions } from "../../clients/session";
import { notifyClient } from "../../clients/notifications";
import { queueSupportEvent } from "../../lib/events";
import { auditContext, writeAudit } from "../../lib/audit";
import { exec, one, rows, transaction, type Conn } from "../../lib/db";
import { badRequest, conflict, forbidden, handler, HttpError, notFound, parse } from "../../lib/http";
import { likeTerm, listQuery, toPage } from "../../lib/pagination";
import { queueEmail } from "../../lib/email";
import { deletePicture } from "../../lib/pictures";
import { requirePermission, requireStepUp, staffActor, staffOf, type StaffContext } from "../../staff/session";

const id = z.coerce.number().int().positive();
const SORT_COLUMNS = { created_at: "c.created_at", name: "c.last_name", email: "c.email", last_login_at: "c.last_login_at", id: "c.id" } as const;

// Personal data is masked in every list and profile; showing it in full is a
// separate, audited request that needs client.pii.reveal.
const mask = {
  phone: (v: string | null) => (v ? `•••• ${v.replace(/\D/g, "").slice(-3)}` : null),
  text: (v: string | null) => (v ? "••••••" : null),
  zip: (v: string | null) => (v ? `${v.slice(0, 2)}•••` : null),
  dob: (v: string | null) => (v ? `${v.slice(0, 4)}-••-••` : null),
};

type Row = ClientRow & { assigned_name: string | null; referrer_name: string | null };

const SELECT_STAFF_VIEW = SELECT_CLIENT.replace(
  "FROM clients c",
  `, a.name AS assigned_name, CONCAT(rc.first_name, ' ', rc.last_name) AS referrer_name
   FROM clients c LEFT JOIN staff_users a ON a.id = c.assigned_staff_id LEFT JOIN clients rc ON rc.id = c.referred_by`,
);

export function staffClientsRouter(deps: AppDeps): Router {
  const { db, config } = deps;
  const router = Router();
  const stepUp = requireStepUp(config);
  const ctx = (req: Request) => auditContext(req, staffActor(staffOf(req)));

  const present = (r: Row) => ({
    id: r.id,
    name: clientName(r),
    firstName: r.first_name,
    lastName: r.last_name,
    email: r.email,
    emailVerified: r.email_verified_at !== null,
    status: r.status,
    statusReason: r.status_reason,
    kycStatus: r.kyc_status,
    kycApprovedAt: r.kyc_approved_at?.toISOString() ?? null,
    importantNotice: r.important_notice,
    country: r.country,
    city: r.city,
    gender: r.gender,
    businessName: r.business_name,
    phone: mask.phone(r.phone),
    phoneCode: r.phone_code,
    address: mask.text(r.address),
    zipcode: mask.zip(r.zipcode),
    dob: mask.dob(r.dob),
    hasPassword: r.password_hash !== null,
    referralCode: r.referral_code,
    referredBy: r.referred_by ? { id: r.referred_by, name: r.referrer_name } : null,
    source: r.source,
    assigned: r.assigned_staff_id ? { id: r.assigned_staff_id, name: r.assigned_name } : null,
    lockedUntil: r.locked_until && r.locked_until.getTime() > Date.now() ? r.locked_until.toISOString() : null,
    lastLoginAt: r.last_login_at?.toISOString() ?? null,
    lastLoginIp: r.last_login_ip,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    // Relative, so the admin panel loads it from its own origin.
    pictureUrl: clientPictureUrl("", r.id, r.picture_sha),
  });

  /** Staff without client.view_all see only the clients assigned to them. */
  const scope = (staff: StaffContext) =>
    staff.permissions.has("client.view_all") ? { sql: "", params: [] as unknown[] } : { sql: " AND c.assigned_staff_id = ?", params: [staff.id] as unknown[] };

  async function loadVisible(conn: Conn, req: Request, clientId: number, lock = false) {
    const s = scope(staffOf(req));
    const row = await one<Row>(conn, `${SELECT_STAFF_VIEW} WHERE c.id = ?${s.sql}${lock ? " FOR UPDATE OF c" : ""}`, [clientId, ...s.params]);
    if (!row) throw notFound("That client does not exist or is not assigned to you.");
    return row;
  }

  // ---------- List and create ----------

  router.get(
    "/",
    requirePermission("client.view"),
    handler(async (req, res) => {
      const staff = staffOf(req);
      const query = parse(
        listQuery(["created_at", "name", "email", "last_login_at", "id"], "created_at").extend({
          status: z.enum(["active", "frozen", "closed"]).optional().or(z.literal("").transform(() => undefined)),
          assigned: z.string().regex(/^(me|none|\d+)$/).optional().or(z.literal("").transform(() => undefined)),
          source: z.enum(["portal", "app", "staff", "import"]).optional().or(z.literal("").transform(() => undefined)),
          verified: z.enum(["yes", "no"]).optional().or(z.literal("").transform(() => undefined)),
          kyc: z.enum(["none", "pending", "approved", "rejected"]).optional().or(z.literal("").transform(() => undefined)),
          country: z.string().trim().max(80).optional(),
        }),
        req.query,
      );
      const where: string[] = ["1 = 1"];
      const params: unknown[] = [];
      const s = scope(staff);
      if (s.sql) {
        where.push("c.assigned_staff_id = ?");
        params.push(...s.params);
      }
      if (query.q) {
        const asId = /^\d{1,12}$/.test(query.q) ? Number(query.q) : 0;
        where.push("(c.id = ? OR c.email LIKE ? OR CONCAT(c.first_name, ' ', c.last_name) LIKE ? OR c.referral_code = ?)");
        params.push(asId, likeTerm(query.q), likeTerm(query.q), query.q.toUpperCase());
      }
      if (query.status) (where.push("c.status = ?"), params.push(query.status));
      if (query.source) (where.push("c.source = ?"), params.push(query.source));
      if (query.kyc) (where.push("c.kyc_status = ?"), params.push(query.kyc));
      if (query.country) (where.push("c.country = ?"), params.push(query.country));
      if (query.verified) where.push(query.verified === "yes" ? "c.email_verified_at IS NOT NULL" : "c.email_verified_at IS NULL");
      if (query.assigned === "me") (where.push("c.assigned_staff_id = ?"), params.push(staff.id));
      else if (query.assigned === "none") where.push("c.assigned_staff_id IS NULL");
      else if (query.assigned) (where.push("c.assigned_staff_id = ?"), params.push(Number(query.assigned)));
      const clause = ` WHERE ${where.join(" AND ")}`;
      const total = await one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM clients c${clause}`, params);
      const items = await rows<Row>(
        db,
        `${SELECT_STAFF_VIEW}${clause} ORDER BY ${SORT_COLUMNS[query.sort]} ${query.dir === "asc" ? "ASC" : "DESC"}, c.id DESC LIMIT ? OFFSET ?`,
        [...params, query.pageSize, (query.page - 1) * query.pageSize],
      );
      res.json(toPage(items.map(present), Number(total?.n ?? 0), query.page, query.pageSize));
    }),
  );

  router.get(
    "/summary",
    requirePermission("client.view"),
    handler(async (req, res) => {
      const s = scope(staffOf(req));
      const r = await one<{ total: number; active: number; frozen: number; closed: number; today: number; week: number; unassigned: number }>(
        db,
        `SELECT COUNT(*) AS total, SUM(status = 'active') AS active, SUM(status = 'frozen') AS frozen, SUM(status = 'closed') AS closed,
           SUM(created_at >= CURRENT_DATE) AS today, SUM(created_at >= CURRENT_TIMESTAMP(3) - INTERVAL 7 DAY) AS week,
           SUM(assigned_staff_id IS NULL) AS unassigned
         FROM clients c WHERE 1 = 1${s.sql}`,
        s.params,
      );
      const countries = await rows<{ country: string }>(db, `SELECT DISTINCT country FROM clients c WHERE country IS NOT NULL${s.sql} ORDER BY country LIMIT 300`, s.params);
      const n = (v: unknown) => Number(v ?? 0);
      res.json({
        total: n(r?.total), active: n(r?.active), frozen: n(r?.frozen), closed: n(r?.closed),
        newToday: n(r?.today), newThisWeek: n(r?.week), unassigned: n(r?.unassigned),
        countries: countries.map((c) => c.country),
      });
    }),
  );

  router.get(
    "/assignees",
    requirePermission("client.view"),
    handler(async (_req, res) => {
      const list = await rows<{ id: number; name: string; email: string }>(db, "SELECT id, name, email FROM staff_users WHERE status = 'active' ORDER BY name LIMIT 500");
      res.json({ items: list });
    }),
  );

  const createSchema = z
    .object({
      firstName: nameField("first name"),
      lastName: nameField("last name"),
      email: emailField,
      phone: profileFields.phone,
      countryCode: profileFields.countryCode,
      country: profileFields.country,
      city: profileFields.city,
      assignedStaffId: id.nullable().optional(),
      sendInvite: z.boolean().default(true),
    })
    .strict();

  router.post(
    "/",
    requirePermission("client.create"),
    handler(async (req, res) => {
      const staff = staffOf(req);
      const body = parse(createSchema, req.body);
      // Someone who sees only their own clients keeps the clients they add.
      if (!staff.permissions.has("client.view_all")) body.assignedStaffId = body.assignedStaffId ?? staff.id;
      if (body.assignedStaffId) await assertAssignable(db, body.assignedStaffId);
      const clientId = await transaction(db, async (conn) => {
        let newId = 0;
        for (let attempt = 0; attempt < 5 && !newId; attempt++) {
          try {
            const result = await exec(
              conn,
              `INSERT INTO clients (email, first_name, last_name, phone, phone_code, country, city, referral_code, source, assigned_staff_id, created_by_staff_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'staff', ?, ?)`,
              [body.email, body.firstName, body.lastName, body.phone ?? null, body.countryCode ?? null, body.country ?? null, body.city ?? null, newReferralCode(), body.assignedStaffId ?? null, staff.id],
            );
            newId = result.insertId;
          } catch (err) {
            if ((err as { code?: string }).code !== "ER_DUP_ENTRY") throw err;
            if (((err as { message?: string }).message ?? "").includes("uq_clients_email")) throw conflict("A client with this email already exists.");
          }
        }
        if (!newId) throw new Error("Could not allocate a referral code");
        await writeAudit(conn, ctx(req), {
          action: "client.created", entityType: "client", entityId: newId,
          after: { email: body.email, first_name: body.firstName, last_name: body.lastName, country: body.country ?? null, assigned_staff_id: body.assignedStaffId ?? null },
          meta: { invite: body.sendInvite },
        });
        return newId;
      });
      if (body.sendInvite) await createResetLink(db, config, req, { id: clientId, email: body.email, first_name: body.firstName }, staff.id, 72 * 3_600_000);
      res.status(201).json(present(await loadVisibleOrAny(clientId)));
    }),
  );

  async function loadVisibleOrAny(clientId: number) {
    return (await one<Row>(db, `${SELECT_STAFF_VIEW} WHERE c.id = ?`, [clientId]))!;
  }

  // ---------- One client ----------

  router.get(
    "/:id",
    requirePermission("client.view"),
    handler(async (req, res) => {
      const row = await loadVisible(db, req, parse(id, req.params.id));
      const counts = await one<{ sessions: number; notes: number; referrals: number }>(
        db,
        `SELECT (SELECT COUNT(*) FROM client_sessions WHERE client_id = ? AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP(3)) AS sessions,
                (SELECT COUNT(*) FROM client_notes WHERE client_id = ?) AS notes,
                (SELECT COUNT(*) FROM clients WHERE referred_by = ?) AS referrals`,
        [row.id, row.id, row.id],
      );
      res.json({ ...present(row), activeSessions: Number(counts?.sessions ?? 0), notesCount: Number(counts?.notes ?? 0), referrals: Number(counts?.referrals ?? 0) });
    }),
  );

  router.post(
    "/:id/reveal",
    requirePermission("client.view", "client.pii.reveal"),
    handler(async (req, res) => {
      const reason = parse(z.object({ reason: z.string().trim().max(255).optional() }), req.body ?? {}).reason ?? null;
      const row = await transaction(db, async (conn) => {
        const r = await loadVisible(conn, req, parse(id, req.params.id));
        await writeAudit(conn, ctx(req), { action: "client.pii_revealed", entityType: "client", entityId: r.id, meta: { fields: ["phone", "address", "zipcode", "dob"], reason } });
        return r;
      });
      res.json({ phone: row.phone, phoneCode: row.phone_code, address: row.address, zipcode: row.zipcode, dob: row.dob });
    }),
  );

  const editSchema = z
    .object({
      firstName: nameField("first name").optional(),
      lastName: nameField("last name").optional(),
      email: emailField.optional(),
      importantNotice: z.string().trim().max(500).nullable().optional(),
      ...profileFields,
    })
    .strict()
    .refine((v) => Object.keys(v).length > 0, "Change at least one field");

  // Fields whose old and new values may go in the audit log; the rest are
  // personal data, so the log records only that they changed.
  const PLAIN_FIELDS = new Set(["first_name", "last_name", "email", "country", "city", "gender", "business_name", "phone_code", "important_notice"]);

  router.patch(
    "/:id",
    requirePermission("client.edit"),
    handler(async (req, res) => {
      const clientId = parse(id, req.params.id);
      const body = parse(editSchema, req.body);
      const updated = await transaction(db, async (conn) => {
        const before = await loadVisible(conn, req, clientId, true);
        const columns = profileColumns({ ...body, first_name: body.firstName, last_name: body.lastName });
        if (body.importantNotice !== undefined) columns.push(["important_notice", body.importantNotice || null]);
        if (body.email && body.email !== before.email) {
          // Changing where a client signs in is sensitive: fresh 2FA, and the old address is told.
          const at = staffOf(req).stepUpAt;
          if (!at || at.getTime() + config.stepUpMs <= Date.now()) throw new HttpError(403, "STEP_UP_REQUIRED", "Enter your 2FA code to confirm this action.");
          if (await one(conn, "SELECT id FROM clients WHERE email = ? AND id <> ?", [body.email, clientId])) throw conflict("A client with this email already exists.");
          columns.push(["email", body.email]);
        }
        const old = before as unknown as Record<string, unknown>;
        const changed = columns.filter(([k, v]) => String(old[k] ?? "") !== String(v ?? ""));
        if (changed.length === 0) return before;
        await updateClientColumns(conn, clientId, changed);
        const plain = changed.filter(([k]) => PLAIN_FIELDS.has(k));
        await writeAudit(conn, ctx(req), {
          action: "client.updated", entityType: "client", entityId: clientId,
          before: Object.fromEntries(plain.map(([k]) => [k, old[k] ?? null])),
          after: Object.fromEntries(plain),
          meta: { fields: changed.map(([k]) => k) },
        });
        if (body.email && body.email !== before.email) {
          await queueEmail(conn, config, {
            to: before.email, template: "email_changed", subject: "Your BIS Markets email was changed",
            text: `Hello ${clientName(before)},\n\nBIS Markets staff changed the sign-in email for your account to ${body.email}.\n\nIf you did not ask for this, contact support immediately.`,
            clientId,
          });
        }
        return (await loadVisible(conn, req, clientId))!;
      });
      res.json(present(updated));
    }),
  );

  router.post(
    "/:id/status",
    requirePermission("client.status"),
    stepUp,
    handler(async (req, res) => {
      const clientId = parse(id, req.params.id);
      const body = parse(z.object({ status: z.enum(["active", "frozen", "closed"]), reason: z.string().trim().min(3, "Give a reason").max(255) }).strict(), req.body);
      const updated = await transaction(db, async (conn) => {
        const before = await loadVisible(conn, req, clientId, true);
        if (before.status === body.status) throw badRequest(`This client is already ${body.status}.`);
        await exec(conn, "UPDATE clients SET status = ?, status_reason = ? WHERE id = ?", [body.status, body.status === "active" ? null : body.reason, clientId]);
        const revoked = body.status === "closed" ? await revokeClientSessions(conn, config, clientId, "account_closed") : 0;
        // The support service signs closed accounts out of the app and lets them back in on reopening.
        if (body.status === "closed") await queueSupportEvent(conn, config, { event: "account.disabled", clientId });
        if (before.status === "closed") await queueSupportEvent(conn, config, { event: "account.enabled", clientId });
        if (body.status === "frozen") {
          await notifyClient(conn, clientId, { type: "account", title: "Your account is restricted", body: "Deposits, withdrawals and transfers are paused on your account. Please contact support for details." });
        } else if (body.status === "active") {
          await notifyClient(conn, clientId, { type: "account", title: "Your account is active again", body: "All features of your account are available again." });
        }
        await writeAudit(conn, ctx(req), {
          action: `client.${body.status === "active" ? "reactivated" : body.status}`, entityType: "client", entityId: clientId,
          before: { status: before.status }, after: { status: body.status }, meta: { reason: body.reason, sessionsRevoked: revoked },
        });
        return (await loadVisible(conn, req, clientId))!;
      });
      res.json(present(updated));
    }),
  );

  router.post(
    "/:id/assign",
    requirePermission("client.assign"),
    handler(async (req, res) => {
      const clientId = parse(id, req.params.id);
      const body = parse(z.object({ staffId: id.nullable() }).strict(), req.body);
      if (body.staffId) await assertAssignable(db, body.staffId);
      const updated = await transaction(db, async (conn) => {
        const before = await loadVisible(conn, req, clientId, true);
        await exec(conn, "UPDATE clients SET assigned_staff_id = ? WHERE id = ?", [body.staffId, clientId]);
        await writeAudit(conn, ctx(req), { action: "client.assigned", entityType: "client", entityId: clientId, before: { assigned_staff_id: before.assigned_staff_id }, after: { assigned_staff_id: body.staffId } });
        return (await one<Row>(conn, `${SELECT_STAFF_VIEW} WHERE c.id = ?`, [clientId]))!;
      });
      res.json(present(updated));
    }),
  );

  router.post(
    "/:id/password-reset",
    requirePermission("client.portal_password"),
    handler(async (req, res) => {
      const row = await loadVisible(db, req, parse(id, req.params.id));
      if (row.status === "closed") throw badRequest("This account is closed.");
      await createResetLink(db, config, req, row, staffOf(req).id, 24 * 3_600_000);
      await transaction(db, (conn) => writeAudit(conn, ctx(req), { action: "client.password_reset_sent", entityType: "client", entityId: row.id }));
      res.json({ ok: true, email: row.email });
    }),
  );

  router.post(
    "/:id/unlock",
    requirePermission("client.edit"),
    handler(async (req, res) => {
      const clientId = parse(id, req.params.id);
      await transaction(db, async (conn) => {
        await loadVisible(conn, req, clientId, true);
        await exec(conn, "UPDATE clients SET failed_login_count = 0, locked_until = NULL WHERE id = ?", [clientId]);
        await writeAudit(conn, ctx(req), { action: "client.unlocked", entityType: "client", entityId: clientId });
      });
      res.json(present(await loadVisible(db, req, clientId)));
    }),
  );

  router.delete(
    "/:id/picture",
    requirePermission("client.edit"),
    handler(async (req, res) => {
      const clientId = parse(id, req.params.id);
      await transaction(db, async (conn) => {
        await loadVisible(conn, req, clientId, true);
        if (await deletePicture(conn, "client", clientId)) await writeAudit(conn, ctx(req), { action: "client.picture_removed", entityType: "client", entityId: clientId });
      });
      res.json(present(await loadVisible(db, req, clientId)));
    }),
  );

  // ---------- Sessions and log in as client ----------

  router.get(
    "/:id/sessions",
    requirePermission("client.view"),
    handler(async (req, res) => {
      const row = await loadVisible(db, req, parse(id, req.params.id));
      const list = await rows<{ id: string; kind: string; staff_name: string | null; reason: string | null; ip: string; user_agent: string; created_at: Date; last_seen_at: Date; expires_at: Date }>(
        db,
        `SELECT s.id, s.kind, u.name AS staff_name, s.reason, s.ip, s.user_agent, s.created_at, s.last_seen_at, s.expires_at
         FROM client_sessions s LEFT JOIN staff_users u ON u.id = s.staff_id
         WHERE s.client_id = ? AND s.revoked_at IS NULL AND s.expires_at > CURRENT_TIMESTAMP(3) ORDER BY s.last_seen_at DESC LIMIT 50`,
        [row.id],
      );
      res.json({
        items: list.map((s) => ({
          ref: s.id.slice(0, 12), kind: s.kind, staffName: s.staff_name, reason: s.reason, ip: s.ip, userAgent: s.user_agent,
          createdAt: s.created_at.toISOString(), lastSeenAt: s.last_seen_at.toISOString(), expiresAt: s.expires_at.toISOString(),
        })),
      });
    }),
  );

  router.post(
    "/:id/revoke-sessions",
    requirePermission("client.status"),
    handler(async (req, res) => {
      const clientId = parse(id, req.params.id);
      const revoked = await transaction(db, async (conn) => {
        await loadVisible(conn, req, clientId, true);
        const n = await revokeClientSessions(conn, config, clientId, "staff_revoked");
        await writeAudit(conn, ctx(req), { action: "client.sessions_revoked", entityType: "client", entityId: clientId, meta: { count: n } });
        return n;
      });
      res.json({ revoked });
    }),
  );

  router.post(
    "/:id/impersonate",
    requirePermission("client.view", "client.impersonate"),
    stepUp,
    handler(async (req, res) => {
      const staff = staffOf(req);
      const clientId = parse(id, req.params.id);
      const body = parse(z.object({ reason: z.string().trim().min(5, "Say why you need to see the client's portal").max(255) }).strict(), req.body);
      const session = await transaction(db, async (conn) => {
        const row = await loadVisible(conn, req, clientId, true);
        if (row.status === "closed") throw forbidden("This account is closed.");
        const created = await createClientSession(conn, config, clientId, req.clientIp, req.get("user-agent") ?? "", { staffId: staff.id, reason: body.reason });
        await writeAudit(conn, ctx(req), {
          action: "client.impersonation_started", entityType: "client", entityId: clientId,
          meta: { reason: body.reason, expiresAt: created.expiresAt.toISOString(), viewOnly: true },
        });
        return created;
      });
      res.json({ url: `${config.portalUrl}/impersonate?token=${encodeURIComponent(session.token)}`, expiresAt: session.expiresAt.toISOString() });
    }),
  );

  // ---------- Notes and activity ----------

  router.get(
    "/:id/notes",
    requirePermission("client.view"),
    handler(async (req, res) => {
      const row = await loadVisible(db, req, parse(id, req.params.id));
      const list = await rows<{ id: number; body: string; pinned: number; created_at: Date; staff_id: number | null; staff_name: string | null }>(
        db,
        `SELECT n.id, n.body, n.pinned, n.created_at, n.staff_id, u.name AS staff_name FROM client_notes n LEFT JOIN staff_users u ON u.id = n.staff_id
         WHERE n.client_id = ? ORDER BY n.pinned DESC, n.created_at DESC LIMIT 200`,
        [row.id],
      );
      res.json({ items: list.map((n) => ({ id: n.id, body: n.body, pinned: n.pinned === 1, createdAt: n.created_at.toISOString(), author: n.staff_id ? { id: n.staff_id, name: n.staff_name } : null })) });
    }),
  );

  router.post(
    "/:id/notes",
    requirePermission("client.notes"),
    handler(async (req, res) => {
      const clientId = parse(id, req.params.id);
      const body = parse(z.object({ body: z.string().trim().min(1, "Write a note").max(4000), pinned: z.boolean().default(false) }).strict(), req.body);
      const noteId = await transaction(db, async (conn) => {
        await loadVisible(conn, req, clientId);
        const result = await exec(conn, "INSERT INTO client_notes (client_id, staff_id, body, pinned) VALUES (?, ?, ?, ?)", [clientId, staffOf(req).id, body.body, body.pinned ? 1 : 0]);
        await writeAudit(conn, ctx(req), { action: "client.note_added", entityType: "client", entityId: clientId, meta: { noteId: result.insertId } });
        return result.insertId;
      });
      res.status(201).json({ id: noteId });
    }),
  );

  router.get(
    "/:id/activity",
    requirePermission("client.view"),
    handler(async (req, res) => {
      const row = await loadVisible(db, req, parse(id, req.params.id));
      const list = await rows<{ id: number; occurred_at: Date; actor_type: string; actor_label: string; action: string; ip: string; meta_json: unknown }>(
        db,
        `SELECT id, occurred_at, actor_type, actor_label, action, ip, meta_json FROM audit_log
         WHERE entity_type = 'client' AND entity_id = ? ORDER BY id DESC LIMIT 100`,
        [String(row.id)],
      );
      res.json({
        items: list.map((a) => ({ id: a.id, at: a.occurred_at.toISOString(), actorType: a.actor_type, actor: a.actor_label, action: a.action, ip: a.ip, meta: a.meta_json ?? null })),
      });
    }),
  );

  return router;
}

async function assertAssignable(db: Conn, staffId: number) {
  const staff = await one<{ id: number }>(db, "SELECT id FROM staff_users WHERE id = ? AND status = 'active'", [staffId]);
  if (!staff) throw badRequest("Choose an active staff member.");
}
