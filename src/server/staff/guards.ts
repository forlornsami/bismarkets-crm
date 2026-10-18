import { randomBytes } from "node:crypto";
import { SUPER_ADMIN_SLUG, type Permission } from "@shared/permissions";
import { one, type Conn } from "../lib/db";
import { forbidden, notFound } from "../lib/http";
import { loadPermissions, type StaffContext } from "./session";

export interface RoleRow {
  id: number;
  slug: string;
  name: string;
  description: string;
  is_system: number;
}

export async function getRole(conn: Conn, roleId: number): Promise<RoleRow> {
  const role = await one<RoleRow>(conn, "SELECT id, slug, name, description, is_system FROM roles WHERE id = ?", [roleId]);
  if (!role) throw notFound("That role does not exist.");
  return role;
}

/**
 * Nobody can hand out more power than they hold: granting a role (to a person
 * or by editing it) requires the actor to hold every permission in it. Only a
 * Super Admin can make another Super Admin.
 */
export async function assertCanGrantRole(conn: Conn, actor: StaffContext, role: RoleRow) {
  if (role.slug === SUPER_ADMIN_SLUG && !actor.isSuperAdmin) throw forbidden("Only a Super Admin can assign the Super Admin role.");
  const granted = await loadPermissions(conn, role.id, role.slug);
  assertHoldsAll(actor, [...granted]);
}

export function assertHoldsAll(actor: StaffContext, permissions: Permission[]) {
  const missing = permissions.filter((p) => !actor.permissions.has(p));
  if (missing.length > 0) {
    throw forbidden(`You cannot grant permissions you do not hold yourself: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}`);
  }
}

/**
 * Nobody can take over an account with more power than their own: changing
 * another person's account (details, status, password, 2FA, sessions, picture)
 * requires the actor to hold every permission of that person's role. Only a
 * Super Admin may change another Super Admin's account.
 */
export async function assertCanManageTarget(conn: Conn, actor: StaffContext, target: { role_id: number; role_slug: string }) {
  if (target.role_slug === SUPER_ADMIN_SLUG && !actor.isSuperAdmin) throw forbidden("Only a Super Admin can change a Super Admin account.");
  const held = await loadPermissions(conn, target.role_id, target.role_slug);
  const missing = [...held].filter((p) => !actor.permissions.has(p));
  if (missing.length > 0) {
    throw forbidden(`You cannot change an account with permissions you do not hold yourself: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}`);
  }
}

export async function activeSuperAdminCount(conn: Conn): Promise<number> {
  const row = await one<{ n: number }>(
    conn,
    `SELECT COUNT(*) AS n FROM staff_users u JOIN roles r ON r.id = u.role_id WHERE r.slug = ? AND u.status = 'active'`,
    [SUPER_ADMIN_SLUG],
  );
  return Number(row?.n ?? 0);
}

/** A 20-character temporary password, shown once and changed at first sign-in. */
export function temporaryPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  // Rejection sampling: bytes at or above the largest multiple of the alphabet
  // length are skipped, so every character is equally likely.
  const limit = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < 20) {
    for (const byte of randomBytes(32)) {
      if (byte < limit && out.length < 20) out += alphabet[byte % alphabet.length];
    }
  }
  return out;
}
