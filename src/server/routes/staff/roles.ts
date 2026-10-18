import { Router } from "express";
import { z } from "zod";
import { ALL_PERMISSIONS, isPermission, PERMISSION_GROUPS, SUPER_ADMIN_SLUG, type Permission } from "@shared/permissions";
import type { AppDeps } from "../../app";
import { auditContext, writeAudit } from "../../lib/audit";
import { exec, one, rows, transaction, type Conn } from "../../lib/db";
import { badRequest, conflict, forbidden, handler, parse } from "../../lib/http";
import { assertHoldsAll, getRole, type RoleRow } from "../../staff/guards";
import { loadPermissions, requirePermission, requireStepUp, staffActor, staffOf } from "../../staff/session";

const id = z.coerce.number().int().positive();
const permissionList = z
  .array(z.string())
  .max(ALL_PERMISSIONS.length)
  .transform((list, ctx) => {
    const unknown = list.filter((p) => !isPermission(p));
    if (unknown.length) ctx.addIssue({ code: "custom", message: `Unknown permissions: ${unknown.join(", ")}` });
    return [...new Set(list)].filter(isPermission).sort();
  });

const slugify = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "role";

async function presentRole(conn: Conn, role: RoleRow) {
  const permissions = [...(await loadPermissions(conn, role.id, role.slug))].sort();
  const count = await one<{ n: number }>(conn, "SELECT COUNT(*) AS n FROM staff_users WHERE role_id = ?", [role.id]);
  return {
    id: role.id,
    slug: role.slug,
    name: role.name,
    description: role.description,
    isSystem: role.is_system === 1,
    editable: role.slug !== SUPER_ADMIN_SLUG,
    permissions,
    staffCount: Number(count?.n ?? 0),
  };
}

async function setPermissions(conn: Conn, roleId: number, permissions: Permission[]) {
  await exec(conn, "DELETE FROM role_permissions WHERE role_id = ?", [roleId]);
  for (const permission of permissions) {
    await exec(conn, "INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)", [roleId, permission]);
  }
}

export function staffRolesRouter(deps: AppDeps): Router {
  const { db, config } = deps;
  const router = Router();
  const stepUp = requireStepUp(config);

  router.get(
    "/permissions",
    requirePermission("role.view"),
    handler(async (_req, res) => {
      res.json({
        groups: Object.entries(PERMISSION_GROUPS).map(([key, group]) => ({
          key,
          label: group.label,
          permissions: Object.entries(group.permissions).map(([permission, label]) => ({ permission, label })),
        })),
      });
    }),
  );

  router.get(
    "/",
    requirePermission("role.view"),
    handler(async (_req, res) => {
      const list = await rows<RoleRow>(db, "SELECT id, slug, name, description, is_system FROM roles ORDER BY is_system DESC, name");
      res.json({ items: await Promise.all(list.map((r) => presentRole(db, r))) });
    }),
  );

  router.post(
    "/",
    requirePermission("role.manage"),
    stepUp,
    handler(async (req, res) => {
      const actor = staffOf(req);
      const body = parse(
        z.object({ name: z.string().trim().min(2).max(80), description: z.string().trim().max(255).default(""), permissions: permissionList }),
        req.body,
      );
      assertHoldsAll(actor, body.permissions);
      const role = await transaction(db, async (conn) => {
        let slug = slugify(body.name);
        if (await one(conn, "SELECT id FROM roles WHERE slug = ?", [slug])) slug = `${slug}_${Date.now().toString(36)}`;
        if (await one(conn, "SELECT id FROM roles WHERE name = ?", [body.name])) throw conflict("A role with this name already exists.");
        const result = await exec(conn, "INSERT INTO roles (slug, name, description, is_system) VALUES (?, ?, ?, 0)", [slug, body.name, body.description]);
        await setPermissions(conn, result.insertId, body.permissions);
        const created = await getRole(conn, result.insertId);
        await writeAudit(conn, auditContext(req, staffActor(actor)), {
          action: "role.created", entityType: "role", entityId: created.id,
          after: { name: created.name, permissions: body.permissions },
        });
        return presentRole(conn, created);
      });
      res.status(201).json(role);
    }),
  );

  router.patch(
    "/:id",
    requirePermission("role.manage"),
    stepUp,
    handler(async (req, res) => {
      const actor = staffOf(req);
      const roleId = parse(id, req.params.id);
      const body = parse(
        z
          .object({
            name: z.string().trim().min(2).max(80).optional(),
            description: z.string().trim().max(255).optional(),
            permissions: permissionList.optional(),
          })
          .strict(),
        req.body,
      );
      const role = await transaction(db, async (conn) => {
        const before = await getRole(conn, roleId);
        if (before.slug === SUPER_ADMIN_SLUG) throw forbidden("The Super Admin role always has every permission and cannot be edited.");
        if (before.id === actor.roleId) throw forbidden("You cannot edit your own role.");
        const beforePermissions = [...(await loadPermissions(conn, before.id, before.slug))].sort();
        if (body.permissions) {
          // Holding a permission is needed both to add it and to take it away.
          const changed = [
            ...body.permissions.filter((p) => !beforePermissions.includes(p)),
            ...beforePermissions.filter((p) => !body.permissions!.includes(p)),
          ];
          assertHoldsAll(actor, changed);
          await setPermissions(conn, roleId, body.permissions);
        }
        if (body.name && body.name !== before.name && (await one(conn, "SELECT id FROM roles WHERE name = ? AND id <> ?", [body.name, roleId]))) {
          throw conflict("A role with this name already exists.");
        }
        await exec(conn, "UPDATE roles SET name = COALESCE(?, name), description = COALESCE(?, description) WHERE id = ?", [
          body.name ?? null,
          body.description ?? null,
          roleId,
        ]);
        const after = await getRole(conn, roleId);
        const afterPermissions = body.permissions ?? beforePermissions;
        await writeAudit(conn, auditContext(req, staffActor(actor)), {
          action: "role.updated", entityType: "role", entityId: roleId,
          before: { name: before.name, description: before.description, permissions: beforePermissions },
          after: { name: after.name, description: after.description, permissions: afterPermissions },
        });
        return presentRole(conn, after);
      });
      res.json(role);
    }),
  );

  router.delete(
    "/:id",
    requirePermission("role.manage"),
    stepUp,
    handler(async (req, res) => {
      const actor = staffOf(req);
      const roleId = parse(id, req.params.id);
      await transaction(db, async (conn) => {
        const role = await getRole(conn, roleId);
        if (role.is_system === 1) throw forbidden("Built-in roles cannot be deleted.");
        const inUse = await one<{ n: number }>(conn, "SELECT COUNT(*) AS n FROM staff_users WHERE role_id = ?", [roleId]);
        if (Number(inUse?.n ?? 0) > 0) throw badRequest("Move the staff in this role to another role first.");
        const permissions = [...(await loadPermissions(conn, role.id, role.slug))].sort();
        await exec(conn, "DELETE FROM roles WHERE id = ?", [roleId]);
        await writeAudit(conn, auditContext(req, staffActor(actor)), {
          action: "role.deleted", entityType: "role", entityId: roleId, before: { name: role.name, permissions },
        });
      });
      res.status(204).end();
    }),
  );

  return router;
}
