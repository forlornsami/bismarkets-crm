import { ALL_PERMISSIONS, DEFAULT_ROLES } from "@shared/permissions";
import { auditStandalone } from "./lib/audit";
import { exec, one, type Db, transaction } from "./lib/db";

const system = { actor: { type: "system" as const, id: null, label: "cli" }, ip: "", userAgent: "cli" };

/**
 * Creates the built-in roles. A role that already exists keeps the permissions
 * an admin gave it, unless `reset` is set; Super Admin is always all-powerful.
 */
export async function seedRoles(db: Db, reset = false): Promise<{ created: string[]; reset: string[] }> {
  const created: string[] = [];
  const resetRoles: string[] = [];
  await transaction(db, async (conn) => {
    for (const role of DEFAULT_ROLES) {
      const existing = await one<{ id: number }>(conn, "SELECT id FROM roles WHERE slug = ?", [role.slug]);
      let roleId = existing?.id;
      if (!roleId) {
        const result = await exec(conn, "INSERT INTO roles (slug, name, description, is_system) VALUES (?, ?, ?, 1)", [role.slug, role.name, role.description]);
        roleId = result.insertId;
        created.push(role.slug);
      } else if (!reset) {
        continue;
      } else {
        resetRoles.push(role.slug);
      }
      const permissions = role.permissions === "all" ? ALL_PERMISSIONS : role.permissions;
      await exec(conn, "DELETE FROM role_permissions WHERE role_id = ?", [roleId]);
      for (const permission of permissions) await exec(conn, "INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)", [roleId, permission]);
    }
  });
  if (created.length || resetRoles.length) {
    await auditStandalone(db, system, { action: "role.seeded", meta: { created, reset: resetRoles } });
  }
  return { created, reset: resetRoles };
}
