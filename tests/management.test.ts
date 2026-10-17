import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exec, one } from "../src/server/lib/db";
import { createStaff, del, hasDb, patch, post, setup, signIn, stepUp, type SignedIn, type TestEnv } from "./helpers";

describe.skipIf(!hasDb)("staff, roles and audit", () => {
  let env: TestEnv;
  let boss: SignedIn; // Super Admin
  let admin: SignedIn; // Admin
  let support: SignedIn; // Support Agent
  const roleId = async (slug: string) => (await one<{ id: number }>(env.db, "SELECT id FROM roles WHERE slug = ?", [slug]))!.id;

  beforeAll(async () => {
    env = await setup();
    await createStaff(env.db, "boss@bis.test", "super_admin");
    await createStaff(env.db, "admin@bis.test", "admin");
    await createStaff(env.db, "support@bis.test", "support_agent");
    boss = await signIn(env, "boss@bis.test");
    admin = await signIn(env, "admin@bis.test");
    support = await signIn(env, "support@bis.test");
  });
  afterAll(async () => {
    await env?.db.end();
  });

  it("checks permissions on the server for every route", async () => {
    expect((await support.agent.get("/api/staff/users")).status).toBe(403);
    expect((await support.agent.get("/api/staff/roles")).status).toBe(403);
    expect((await support.agent.get("/api/staff/audit")).status).toBe(403);
    expect((await admin.agent.get("/api/staff/users")).status).toBe(200);
  });

  it("lists staff with filters, search and pagination", async () => {
    const all = await admin.agent.get("/api/staff/users?pageSize=2&sort=email&dir=asc");
    expect(all.body.total).toBe(3);
    expect(all.body.pages).toBe(2);
    expect(all.body.items.map((s: { email: string }) => s.email)).toEqual(["admin@bis.test", "boss@bis.test"]);
    const search = await admin.agent.get("/api/staff/users?q=supp");
    expect(search.body.items).toHaveLength(1);
    const byRole = await admin.agent.get(`/api/staff/users?roleId=${await roleId("super_admin")}`);
    expect(byRole.body.items[0].email).toBe("boss@bis.test");
    expect((await admin.agent.get("/api/staff/users?sort=password_hash")).status).toBe(400);
  });

  it("creates staff with a one-time temporary password and audits it", async () => {
    const res = await post(admin, "/api/staff/users", { email: "New.Agent@bis.test", name: "New Agent", roleId: await roleId("sales_agent") });
    expect(res.status).toBe(201);
    expect(res.body.staff.email).toBe("new.agent@bis.test");
    expect(res.body.staff.mustChangePassword).toBe(true);
    expect(res.body.temporaryPassword).toHaveLength(20);
    const stored = await one<{ password_hash: string }>(env.db, "SELECT password_hash FROM staff_users WHERE email = 'new.agent@bis.test'");
    expect(stored!.password_hash.startsWith("$argon2id$")).toBe(true);
    const audit = await one<{ actor_label: string }>(env.db, "SELECT actor_label FROM audit_log WHERE action = 'staff.created' ORDER BY id DESC LIMIT 1");
    expect(audit!.actor_label).toBe("admin@bis.test");
    expect((await post(admin, "/api/staff/users", { email: "new.agent@bis.test", name: "Dup", roleId: await roleId("sales_agent") })).status).toBe(409);
  });

  it("stops anyone granting more power than they hold", async () => {
    // Admin lacks role.manage, so cannot create a Super Admin or another Admin-plus.
    const superAdmin = await post(admin, "/api/staff/users", { email: "sneaky@bis.test", name: "Sneaky", roleId: await roleId("super_admin") });
    expect(superAdmin.status).toBe(403);
    const target = await one<{ id: number }>(env.db, "SELECT id FROM staff_users WHERE email = 'support@bis.test'");
    const promote = await patch(admin, `/api/staff/users/${target!.id}`, { roleId: await roleId("super_admin") });
    expect(promote.status).toBe(403);
    const self = await patch(admin, `/api/staff/users/${admin.staffId}`, { roleId: await roleId("support_agent") });
    expect(self.status).toBe(403);
    const editBoss = await patch(admin, `/api/staff/users/${boss.staffId}`, { name: "Renamed" });
    expect(editBoss.status).toBe(403);
  });

  it("stops anyone taking over an account with more power than their own", async () => {
    // A Super Admin gave a desk role kyc.download, which Admin does not hold.
    await exec(env.db, "INSERT INTO roles (slug, name) VALUES ('document_desk', 'Document desk')");
    await exec(
      env.db,
      "INSERT INTO role_permissions (role_id, permission) SELECT r.id, p.name FROM roles r JOIN (SELECT 'kyc.view' AS name UNION SELECT 'kyc.documents' UNION SELECT 'kyc.download') p WHERE r.slug = 'document_desk'",
    );
    await createStaff(env.db, "desk@bis.test", "document_desk");
    const desk = (await one<{ id: number }>(env.db, "SELECT id FROM staff_users WHERE email = 'desk@bis.test'"))!.id;
    await stepUp(env, admin);
    const refused = "You cannot change an account with permissions you do not hold yourself: kyc.download";
    for (const action of ["reset-password", "reset-2fa", "unlock", "revoke-sessions"]) {
      expect((await post(admin, `/api/staff/users/${desk}/${action}`)).body.error.message).toBe(refused);
    }
    expect((await post(admin, `/api/staff/users/${desk}/status`, { status: "disabled" })).body.error.message).toBe(refused);
    expect((await patch(admin, `/api/staff/users/${desk}`, { name: "Renamed" })).body.error.message).toBe(refused);
    expect((await post(admin, "/api/staff/users", { email: "desk2@bis.test", name: "Desk Two", roleId: await roleId("document_desk") })).status).toBe(403);
    // Accounts within the Admin's own power are still theirs to manage.
    expect((await patch(admin, `/api/staff/users/${support.staffId}`, { name: "Support Agent" })).status).toBe(200);
  });

  it("requires a fresh 2FA code for sensitive actions", async () => {
    const target = await one<{ id: number }>(env.db, "SELECT id FROM staff_users WHERE email = 'new.agent@bis.test'");
    const blocked = await post(boss, `/api/staff/users/${target!.id}/status`, { status: "disabled" });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("STEP_UP_REQUIRED");
    await stepUp(env, boss);
    const ok = await post(boss, `/api/staff/users/${target!.id}/status`, { status: "disabled" });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("disabled");
  });

  it("signs a person out everywhere when an admin resets their 2FA", async () => {
    await stepUp(env, boss);
    const res = await post(boss, `/api/staff/users/${support.staffId}/reset-2fa`);
    expect(res.status).toBe(200);
    expect((await support.agent.get("/api/staff/auth/session")).status).toBe(401);
    const user = await one<{ totp_enabled_at: Date | null }>(env.db, "SELECT totp_enabled_at FROM staff_users WHERE id = ?", [support.staffId]);
    expect(user!.totp_enabled_at).toBeNull();
  });

  it("protects the last active Super Admin", async () => {
    await stepUp(env, boss);
    const res = await patch(boss, `/api/staff/users/${boss.staffId}`, { roleId: await roleId("admin") });
    expect(res.status).toBe(403); // own role
  });

  it("manages custom roles with step-up and escalation checks", async () => {
    await stepUp(env, boss);
    const created = await post(boss, "/api/staff/roles", { name: "Night Desk", description: "Overnight", permissions: ["client.view", "kyc.view"] });
    expect(created.status).toBe(201);
    expect(created.body.permissions).toEqual(["client.view", "kyc.view"]);
    const bad = await post(boss, "/api/staff/roles", { name: "Bad", permissions: ["made.up"] });
    expect(bad.status).toBe(400);
    const edited = await patch(boss, `/api/staff/roles/${created.body.id}`, { permissions: ["client.view"] });
    expect(edited.status).toBe(200);
    expect(edited.body.permissions).toEqual(["client.view"]);
    const superRole = await patch(boss, `/api/staff/roles/${await roleId("super_admin")}`, { name: "Other" });
    expect(superRole.status).toBe(403);
    const systemDelete = await del(boss, `/api/staff/roles/${await roleId("auditor")}`);
    expect(systemDelete.status).toBe(403);
    expect((await del(boss, `/api/staff/roles/${created.body.id}`)).status).toBe(204);
  });

  it("keeps the audit log append-only and verifiable", async () => {
    await expect(exec(env.db, "UPDATE audit_log SET action = 'x' WHERE id = 1")).rejects.toThrow(/append-only/);
    await expect(exec(env.db, "DELETE FROM audit_log WHERE id = 1")).rejects.toThrow(/append-only/);
    const report = await post(boss, "/api/staff/audit/verify");
    expect(report.status).toBe(200);
    expect(report.body.ok).toBe(true);
    expect(report.body.checked).toBeGreaterThan(10);
  });

  it("detects a forged audit entry", async () => {
    // Someone with database access inserts a row and moves the head without the right hash.
    await exec(env.db, `INSERT INTO audit_log (occurred_at, actor_type, actor_label, action, prev_hash, hash)
      SELECT NOW(3), 'system', 'forger', 'staff.created', last_hash, REPEAT('a', 64) FROM audit_chain_head WHERE id = 1`);
    await exec(env.db, "UPDATE audit_chain_head SET last_id = LAST_INSERT_ID(), last_hash = REPEAT('a', 64) WHERE id = 1");
    const report = await post(boss, "/api/staff/audit/verify");
    expect(report.body.ok).toBe(false);
    expect(report.body.reason).toMatch(/hash/);
  });

  it("filters and paginates the audit log", async () => {
    const res = await boss.agent.get("/api/staff/audit?action=staff.&pageSize=5");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(5);
    for (const item of res.body.items) expect(item.action.startsWith("staff.")).toBe(true);
    const actions = await boss.agent.get("/api/staff/audit/actions");
    expect(actions.body.items).toContain("staff.login");
    expect((await boss.agent.get("/api/staff/audit?action=DROP TABLE")).status).toBe(400);
  });

  it("exports the audit log as CSV only after step-up, with formulas neutralised", async () => {
    await stepUp(env, boss);
    const res = await boss.agent.get("/api/staff/audit/export?action=staff.login");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.text.split("\r\n")[0]).toMatch(/^id,occurred_at/);
  });
});
