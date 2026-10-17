import express, { Router, type Request } from "express";
import { z } from "zod";
import type { AppDeps } from "../../app";
import { auditContext, writeAudit } from "../../lib/audit";
import { exec, one, rows, transaction } from "../../lib/db";
import { badRequest, conflict, forbidden, handler, notFound, parse } from "../../lib/http";
import { likeTerm, listQuery, toPage } from "../../lib/pagination";
import { hashPassword } from "../../lib/passwords";
import { deletePicture, PICTURE_MAX_BYTES, PICTURE_TYPES, savePicture, sendPicture, staffAvatarUrl, uploadedImage } from "../../lib/pictures";
import { activeSuperAdminCount, assertCanGrantRole, assertCanManageTarget, getRole, temporaryPassword } from "../../staff/guards";
import { requirePermission, requireStepUp, revokeStaffSessions, staffActor, staffOf } from "../../staff/session";

interface StaffRow {
  id: number;
  email: string;
  name: string;
  status: "active" | "disabled";
  role_id: number;
  role_slug: string;
  role_name: string;
  totp_enabled_at: Date | null;
  must_change_password: number;
  locked_until: Date | null;
  scope_countries: string[] | null;
  scope_desks: string[] | null;
  last_login_at: Date | null;
  last_login_ip: string | null;
  created_at: Date;
  avatar_sha: string | null;
}

const SELECT_STAFF = `SELECT u.id, u.email, u.name, u.status, u.role_id, r.slug AS role_slug, r.name AS role_name,
  u.totp_enabled_at, u.must_change_password, u.locked_until, u.scope_countries, u.scope_desks,
  u.last_login_at, u.last_login_ip, u.created_at, p.sha256 AS avatar_sha
  FROM staff_users u JOIN roles r ON r.id = u.role_id
  LEFT JOIN profile_pictures p ON p.owner_type = 'staff' AND p.owner_id = u.id`;

export function presentStaff(r: StaffRow) {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    status: r.status,
    role: { id: r.role_id, slug: r.role_slug, name: r.role_name },
    twoFactorEnabled: r.totp_enabled_at !== null,
    mustChangePassword: r.must_change_password === 1,
    lockedUntil: r.locked_until && r.locked_until.getTime() > Date.now() ? r.locked_until.toISOString() : null,
    scope: { countries: r.scope_countries ?? [], desks: r.scope_desks ?? [] },
    lastLoginAt: r.last_login_at?.toISOString() ?? null,
    lastLoginIp: r.last_login_ip,
    createdAt: r.created_at.toISOString(),
    avatarUrl: staffAvatarUrl(r.id, r.avatar_sha),
  };
}

const auditView = (r: StaffRow) => ({
  email: r.email,
  name: r.name,
  status: r.status,
  role: r.role_slug,
  scope_countries: r.scope_countries ?? [],
  scope_desks: r.scope_desks ?? [],
});

const country = z.string().regex(/^[A-Z]{2}$/, "Use two-letter country codes such as GB");
const desk = z.string().trim().min(1).max(40);
const id = z.coerce.number().int().positive();

const SORT_COLUMNS = { name: "u.name", email: "u.email", created_at: "u.created_at", last_login_at: "u.last_login_at" } as const;

export function staffUsersRouter(deps: AppDeps): Router {
  const { db, config } = deps;
  const router = Router();
  const stepUp = requireStepUp(config);

  async function loadTarget(conn: Parameters<typeof one>[0], staffId: number, lock = false) {
    const row = await one<StaffRow>(conn, `${SELECT_STAFF} WHERE u.id = ?${lock ? " FOR UPDATE" : ""}`, [staffId]);
    if (!row) throw notFound("That staff account does not exist.");
    return row;
  }

  router.get(
    "/",
    requirePermission("staff.view"),
    handler(async (req, res) => {
      const query = parse(
        listQuery(["name", "email", "created_at", "last_login_at"], "created_at").extend({
          status: z.enum(["active", "disabled"]).optional(),
          roleId: id.optional(),
          twoFactor: z.enum(["enabled", "pending"]).optional(),
        }),
        req.query,
      );
      const where: string[] = [];
      const params: unknown[] = [];
      if (query.status) (where.push("u.status = ?"), params.push(query.status));
      if (query.roleId) (where.push("u.role_id = ?"), params.push(query.roleId));
      if (query.twoFactor) where.push(query.twoFactor === "enabled" ? "u.totp_enabled_at IS NOT NULL" : "u.totp_enabled_at IS NULL");
      if (query.q) (where.push("(u.name LIKE ? OR u.email LIKE ?)"), params.push(likeTerm(query.q), likeTerm(query.q)));
      const clause = where.length ? ` WHERE ${where.join(" AND ")}` : "";
      const total = await one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM staff_users u${clause}`, params);
      const items = await rows<StaffRow>(
        db,
        `${SELECT_STAFF}${clause} ORDER BY ${SORT_COLUMNS[query.sort]} ${query.dir === "asc" ? "ASC" : "DESC"}, u.id DESC LIMIT ? OFFSET ?`,
        [...params, query.pageSize, (query.page - 1) * query.pageSize],
      );
      res.json(toPage(items.map(presentStaff), Number(total?.n ?? 0), query.page, query.pageSize));
    }),
  );

  // Profile pictures. Anyone signed in can change their own; changing someone
  // else's needs staff.edit and the right to manage that person.
  const rawImage = express.raw({ type: PICTURE_TYPES, limit: PICTURE_MAX_BYTES });

  async function changeAvatar(req: Request, staffId: number, upload: boolean) {
    const actor = staffOf(req);
    return transaction(db, async (conn) => {
      const target = await loadTarget(conn, staffId, true);
      if (staffId !== actor.id) await assertCanManageTarget(conn, actor, target);
      if (upload) {
        const saved = await savePicture(conn, "staff", staffId, uploadedImage(req));
        await writeAudit(conn, auditContext(req, staffActor(actor)), {
          action: "staff.avatar_updated", entityType: "staff", entityId: staffId,
          after: { sha256: saved.sha256, type: saved.type, width: saved.width, height: saved.height, bytes: saved.bytes },
        });
        return staffAvatarUrl(staffId, saved.sha256);
      }
      if (await deletePicture(conn, "staff", staffId)) {
        await writeAudit(conn, auditContext(req, staffActor(actor)), { action: "staff.avatar_removed", entityType: "staff", entityId: staffId });
      }
      return null;
    });
  }

  router.put("/me/avatar", rawImage, handler(async (req, res) => res.json({ avatarUrl: await changeAvatar(req, staffOf(req).id, true) })));
  router.delete("/me/avatar", handler(async (req, res) => res.json({ avatarUrl: await changeAvatar(req, staffOf(req).id, false) })));
  router.put("/:id/avatar", requirePermission("staff.edit"), rawImage, handler(async (req, res) => res.json({ avatarUrl: await changeAvatar(req, parse(id, req.params.id), true) })));
  router.delete("/:id/avatar", requirePermission("staff.edit"), handler(async (req, res) => res.json({ avatarUrl: await changeAvatar(req, parse(id, req.params.id), false) })));

  // Every signed-in staff member can see colleagues' pictures (they appear in the audit log, menus and lists).
  router.get("/:id/avatar", handler(async (req, res) => sendPicture(db, "staff", parse(id, req.params.id), req, res)));

  router.get(
    "/:id",
    requirePermission("staff.view"),
    handler(async (req, res) => {
      const staffId = parse(id, req.params.id);
      const target = await loadTarget(db, staffId);
      const sessions = await one<{ n: number }>(
        db,
        "SELECT COUNT(*) AS n FROM staff_sessions WHERE staff_id = ? AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP(3)",
        [staffId],
      );
      res.json({ ...presentStaff(target), activeSessions: Number(sessions?.n ?? 0) });
    }),
  );

  router.post(
    "/",
    requirePermission("staff.create"),
    handler(async (req, res) => {
      const actor = staffOf(req);
      const body = parse(
        z.object({
          email: z.string().trim().toLowerCase().email().max(254),
          name: z.string().trim().min(2).max(120),
          roleId: id,
          scopeCountries: z.array(country).max(250).default([]),
          scopeDesks: z.array(desk).max(50).default([]),
        }),
        req.body,
      );
      const password = temporaryPassword();
      const hashed = await hashPassword(password);
      const created = await transaction(db, async (conn) => {
        const role = await getRole(conn, body.roleId);
        await assertCanGrantRole(conn, actor, role);
        if (await one(conn, "SELECT id FROM staff_users WHERE email = ?", [body.email])) throw conflict("A staff account with this email already exists.");
        const result = await exec(
          conn,
          `INSERT INTO staff_users (email, name, password_hash, role_id, must_change_password, scope_countries, scope_desks, created_by)
           VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
          [body.email, body.name, hashed, role.id, JSON.stringify(body.scopeCountries), JSON.stringify(body.scopeDesks), actor.id],
        );
        const row = await loadTarget(conn, result.insertId);
        await writeAudit(conn, auditContext(req, staffActor(actor)), {
          action: "staff.created", entityType: "staff", entityId: row.id, after: auditView(row),
        });
        return row;
      });
      // The temporary password is returned exactly once and never stored in plain text.
      res.status(201).json({ staff: presentStaff(created), temporaryPassword: password });
    }),
  );

  router.patch(
    "/:id",
    requirePermission("staff.edit"),
    handler(async (req, res) => {
      const actor = staffOf(req);
      const staffId = parse(id, req.params.id);
      const body = parse(
        z
          .object({
            name: z.string().trim().min(2).max(120).optional(),
            roleId: id.optional(),
            scopeCountries: z.array(country).max(250).optional(),
            scopeDesks: z.array(desk).max(50).optional(),
          })
          .strict()
          .refine((v) => Object.keys(v).length > 0, "Change at least one field"),
        req.body,
      );
      const updated = await transaction(db, async (conn) => {
        const before = await loadTarget(conn, staffId, true);
        if (staffId !== actor.id) await assertCanManageTarget(conn, actor, before);
        if (body.roleId !== undefined && body.roleId !== before.role_id) {
          if (staffId === actor.id) throw forbidden("You cannot change your own role.");
          const role = await getRole(conn, body.roleId);
          await assertCanGrantRole(conn, actor, role);
          if (before.role_slug === "super_admin" && before.status === "active" && (await activeSuperAdminCount(conn)) <= 1) {
            throw badRequest("This is the last active Super Admin. Make someone else Super Admin first.");
          }
        }
        await exec(
          conn,
          `UPDATE staff_users SET name = COALESCE(?, name), role_id = COALESCE(?, role_id),
             scope_countries = COALESCE(?, scope_countries), scope_desks = COALESCE(?, scope_desks) WHERE id = ?`,
          [
            body.name ?? null,
            body.roleId ?? null,
            body.scopeCountries ? JSON.stringify(body.scopeCountries) : null,
            body.scopeDesks ? JSON.stringify(body.scopeDesks) : null,
            staffId,
          ],
        );
        const after = await loadTarget(conn, staffId);
        await writeAudit(conn, auditContext(req, staffActor(actor)), {
          action: before.role_id !== after.role_id ? "staff.role_changed" : "staff.updated",
          entityType: "staff", entityId: staffId, before: auditView(before), after: auditView(after),
        });
        return after;
      });
      res.json(presentStaff(updated));
    }),
  );

  router.post(
    "/:id/status",
    requirePermission("staff.disable"),
    stepUp,
    handler(async (req, res) => {
      const actor = staffOf(req);
      const staffId = parse(id, req.params.id);
      const { status } = parse(z.object({ status: z.enum(["active", "disabled"]) }), req.body);
      if (staffId === actor.id) throw forbidden("You cannot change the status of your own account.");
      const updated = await transaction(db, async (conn) => {
        const before = await loadTarget(conn, staffId, true);
        await assertCanManageTarget(conn, actor, before);
        if (before.status === status) return before;
        if (status === "disabled" && before.role_slug === "super_admin" && (await activeSuperAdminCount(conn)) <= 1) {
          throw badRequest("This is the last active Super Admin and cannot be disabled.");
        }
        await exec(conn, "UPDATE staff_users SET status = ? WHERE id = ?", [status, staffId]);
        if (status === "disabled") await revokeStaffSessions(conn, staffId, "account_disabled");
        const after = await loadTarget(conn, staffId);
        await writeAudit(conn, auditContext(req, staffActor(actor)), {
          action: status === "disabled" ? "staff.disabled" : "staff.enabled",
          entityType: "staff", entityId: staffId, before: { status: before.status }, after: { status },
        });
        return after;
      });
      res.json(presentStaff(updated));
    }),
  );

  // Security actions on another person's account. Each one signs them out everywhere.
  const securityAction = (path: string, action: string, work: (staffId: number, conn: Parameters<typeof exec>[0]) => Promise<Record<string, unknown> | void>) =>
    router.post(
      path,
      requirePermission("staff.security"),
      stepUp,
      handler(async (req, res) => {
        const actor = staffOf(req);
        const staffId = parse(id, req.params.id);
        if (staffId === actor.id && action !== "staff.sessions_revoked") throw forbidden("Use your own account settings for this.");
        const extra = await transaction(db, async (conn) => {
          const target = await loadTarget(conn, staffId, true);
          if (staffId !== actor.id) await assertCanManageTarget(conn, actor, target);
          const result = await work(staffId, conn);
          await revokeStaffSessions(conn, staffId, action.replace("staff.", ""), staffId === actor.id ? actor.sessionId : undefined);
          await writeAudit(conn, auditContext(req, staffActor(actor)), { action, entityType: "staff", entityId: staffId });
          return result ?? {};
        });
        res.json({ ok: true, ...extra });
      }),
    );

  securityAction("/:id/reset-2fa", "staff.2fa_reset", async (staffId, conn) => {
    await exec(conn, "UPDATE staff_users SET totp_secret_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL WHERE id = ?", [staffId]);
  });

  securityAction("/:id/reset-password", "staff.password_reset", async (staffId, conn) => {
    const password = temporaryPassword();
    await exec(conn, "UPDATE staff_users SET password_hash = ?, must_change_password = 1, password_changed_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [
      await hashPassword(password),
      staffId,
    ]);
    return { temporaryPassword: password };
  });

  securityAction("/:id/unlock", "staff.unlocked", async (staffId, conn) => {
    await exec(conn, "UPDATE staff_users SET failed_login_count = 0, locked_until = NULL WHERE id = ?", [staffId]);
  });

  securityAction("/:id/revoke-sessions", "staff.sessions_revoked", async () => undefined);

  router.get(
    "/:id/sessions",
    requirePermission("staff.security"),
    handler(async (req, res) => {
      const staffId = parse(id, req.params.id);
      await loadTarget(db, staffId);
      const list = await rows<{ created_at: Date; last_seen_at: Date; expires_at: Date; ip: string; user_agent: string }>(
        db,
        `SELECT created_at, last_seen_at, expires_at, ip, user_agent FROM staff_sessions
         WHERE staff_id = ? AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP(3) ORDER BY last_seen_at DESC LIMIT 50`,
        [staffId],
      );
      res.json({
        items: list.map((s) => ({
          createdAt: s.created_at.toISOString(),
          lastSeenAt: s.last_seen_at.toISOString(),
          expiresAt: s.expires_at.toISOString(),
          ip: s.ip,
          userAgent: s.user_agent,
        })),
      });
    }),
  );

  return router;
}
