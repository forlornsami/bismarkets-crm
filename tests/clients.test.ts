import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decryptField } from "../src/server/lib/crypto";
import { exec, one } from "../src/server/lib/db";
import { outboxContext } from "../src/server/lib/email";
import { createStaff, hasDb, patch, post, setup, signIn, stepUp, type SignedIn, type TestEnv } from "./helpers";

const PORTAL = "https://bismarkets.global";
const GOOD = "Sunny-Day-42!";

describe.skipIf(!hasDb)("client portal API", () => {
  let env: TestEnv;
  let boss: SignedIn;
  let sales: SignedIn;
  let salesId: number;
  const api = () => request(env.app);

  /** Reads the newest email to this address, with its secrets, from the outbox. */
  async function lastEmail(to: string) {
    const row = await one<{ body_enc: Buffer; body_text: string; template: string }>(env.db, "SELECT body_enc, body_text, template FROM email_outbox WHERE to_email = ? ORDER BY id DESC LIMIT 1", [to]);
    if (!row) throw new Error(`no email to ${to}`);
    return { ...row, full: decryptField(env.config.dataKey, row.body_enc, outboxContext(to, row.template)) };
  }
  const codeIn = (text: string) => /code is (\d{6})/.exec(text)![1]!;
  const probe = (email: string, extra: Record<string, unknown> = {}) =>
    api().post("/api/register").send({ first_name: "check", last_name: "check", email, password: "Placeholder123!", password_confirmation: "Placeholder123!", verification_code: "", ...extra });

  async function register(email: string, extra: Record<string, unknown> = {}) {
    expect((await api().post("/api/send-otp").send({ email })).status).toBe(200);
    const code = codeIn((await lastEmail(email)).full);
    const res = await api().post("/api/register").send({ first_name: "Jane", last_name: "Doe", email, password: GOOD, password_confirmation: GOOD, verification_code: code, ...extra });
    expect(res.status).toBe(201);
    return res.body as { token: string; user: { id: number; referral_code: string } };
  }

  beforeAll(async () => {
    env = await setup();
    await createStaff(env.db, "boss@bis.test", "super_admin");
    salesId = await createStaff(env.db, "sales@bis.test", "sales_agent");
    boss = await signIn(env, "boss@bis.test");
    sales = await signIn(env, "sales@bis.test");
  });
  afterAll(async () => {
    await env?.db.end();
  });

  it("answers the portal's CORS preflight only for the portal's origin", async () => {
    const ok = await api().options("/api/login").set("Origin", PORTAL).set("Access-Control-Request-Method", "POST");
    expect(ok.status).toBe(204);
    expect(ok.headers["access-control-allow-origin"]).toBe(PORTAL);
    expect(ok.headers["access-control-allow-headers"]).toContain("Authorization");
    const other = await api().options("/api/login").set("Origin", "https://evil.example").set("Access-Control-Request-Method", "POST");
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("signs a client up with the portal's probe, email code and register calls", async () => {
    const free = await probe("jane@client.test");
    expect(free.status).toBe(422);
    expect(Object.keys(free.body.errors)).toEqual(["verification_code"]);

    const sent = await api().post("/api/send-otp").send({ email: "jane@client.test" });
    expect(sent.body).toMatchObject({ success: true });
    const email = await lastEmail("jane@client.test");
    const code = codeIn(email.full);
    expect(email.body_text).not.toContain(code);
    expect((await api().post("/api/send-otp").send({ email: "jane@client.test" })).status).toBe(429);

    expect((await api().post("/api/verify-otp").send({ email: "jane@client.test", verification_code: "000000" === code ? "111111" : "000000" })).status).toBe(422);
    expect((await api().post("/api/verify-otp").send({ email: "jane@client.test", verification_code: code })).body).toMatchObject({ success: true });

    const weak = await api().post("/api/register").send({ first_name: "Jane", last_name: "Doe", email: "jane@client.test", password: "short", password_confirmation: "short", verification_code: code });
    expect(weak.status).toBe(422);
    expect(weak.body.errors.password).toBeDefined();

    const done = await api().post("/api/register").set("Origin", PORTAL).send({ first_name: "Jane", last_name: "Doe", email: "Jane@Client.test", password: GOOD, password_confirmation: GOOD, verification_code: code });
    expect(done.status).toBe(201);
    expect(done.body.token).toBeTruthy();
    expect(done.body.user).toMatchObject({ email: "jane@client.test", first_name: "Jane", name: "Jane Doe" });
    expect(done.body.user.id).toBeGreaterThan(100000);

    const taken = await probe("jane@client.test");
    expect(taken.body.errors.email[0]).toMatch(/already been taken/);
    // The code was used up by the successful sign-up.
    const again = await api().post("/api/register").send({ first_name: "J", last_name: "D", email: "jane2@client.test", password: GOOD, password_confirmation: GOOD, verification_code: code });
    expect(again.body.errors.verification_code).toBeDefined();
  });

  it("logs in, returns the profile support expects and logs out", async () => {
    const bad = await api().post("/api/login").send({ email: "jane@client.test", password: "Wrong-Pass-1!" });
    expect(bad.status).toBe(422);
    expect(bad.body.message).toMatch(/Invalid credentials/);

    const login = await api().post("/api/login").send({ email: "jane@client.test", password: GOOD });
    expect(login.status).toBe(200);
    const token = login.body.token as string;
    const me = await api().get("/api/user").set("Authorization", `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ email: "jane@client.test", first_name: "Jane" });
    for (const staffFlag of ["role", "type", "is_admin", "is_staff", "isStaff"]) expect(me.body[staffFlag]).toBeUndefined();

    expect((await api().post("/api/logout").set("Authorization", `Bearer ${token}`)).status).toBe(200);
    const after = await api().get("/api/user").set("Authorization", `Bearer ${token}`);
    expect(after.status).toBe(401);
    expect(after.body).toEqual({ message: "Unauthenticated." });
  });

  it("updates the profile and picture through the portal's calls", async () => {
    const { token } = await register("ali@client.test");
    const auth = { Authorization: `Bearer ${token}` };
    const bad = await api().patch("/api/user").set(auth).send({ dob: "2020-01-01" });
    expect(bad.status).toBe(422);
    const ok = await api().patch("/api/user").set(auth).send({ first_name: "Ali", phone: "5551234", countryCode: "+44", country: "United Kingdom", city: "London", gender: "Male", dob: "1990-04-02", date_of_birth: "1990-04-02" });
    expect(ok.status).toBe(200);
    const me = await api().get("/api/user").set(auth);
    expect(me.body).toMatchObject({ first_name: "Ali", phone: "5551234", countryCode: "44", country: "United Kingdom", dob: "1990-04-02", gender: "Male" });

    const { readFileSync } = await import("node:fs");
    const png = readFileSync(new URL("../src/admin/public/brand/apple-touch-icon.png", import.meta.url));
    const up = await api().post("/api/user/profile-picture").set(auth).attach("image", png, { filename: "me.png", contentType: "image/png" }).attach("image_name", png, { filename: "me.png", contentType: "image/png" });
    expect(up.status).toBe(200);
    expect(up.body.image_url).toMatch(/^https:\/\/crmbismarkets\.com\/api\/pictures\/client\/\d+\?v=[0-9a-f]{16}$/);
    const path = new URL(up.body.image_url).pathname + new URL(up.body.image_url).search;
    const pic = await api().get(path);
    expect(pic.status).toBe(200);
    expect(pic.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect((await api().get(path.replace(/v=.*/, "v=0000000000000000"))).status).toBe(404);
    // Staff see the same picture in the CRM.
    const listed = (await boss.agent.get("/api/staff/clients?q=ali@client.test")).body.items[0];
    expect(listed.pictureUrl).toBe(path);
    const forStaff = await boss.agent.get(listed.pictureUrl);
    expect(forStaff.status).toBe(200);
    expect(forStaff.headers["content-type"]).toBe("image/png");
    expect((await boss.agent.get(`/api/staff/clients/${listed.id}`)).body.pictureUrl).toBe(path);
    const svg = await api().post("/api/user/profile-picture").set(auth).attach("image", Buffer.from("<svg/>"), { filename: "x.svg", contentType: "image/svg+xml" });
    expect(svg.status).toBe(422);
  });

  it("resets a forgotten password once and signs the client out everywhere", async () => {
    const { token } = await register("reset@client.test");
    const same = await api().post("/api/forgot-password").send({ email: "nobody@client.test" });
    const res = await api().post("/api/forgot-password").send({ email: "reset@client.test" });
    expect(res.body.message).toBe(same.body.message);
    const link = /(https:\/\/\S+reset-password\S+)/.exec((await lastEmail("reset@client.test")).full)![1]!;
    expect((await lastEmail("reset@client.test")).body_text).not.toContain("token=");
    const resetToken = new URL(link).searchParams.get("token")!;
    const NEW = "Rainy-Night-77?";
    const ok = await api().post("/api/reset-password").send({ token: resetToken, email: "reset@client.test", password: NEW, password_confirmation: NEW });
    expect(ok.status).toBe(200);
    expect((await api().get("/api/user").set("Authorization", `Bearer ${token}`)).status).toBe(401);
    expect((await api().post("/api/reset-password").send({ token: resetToken, password: NEW, password_confirmation: NEW })).status).toBe(422);
    expect((await api().post("/api/login").send({ email: "reset@client.test", password: NEW })).status).toBe(200);
  });

  it("locks an account after repeated wrong passwords", async () => {
    await register("lock@client.test");
    for (let i = 0; i < env.config.loginMaxFailures; i++) await api().post("/api/login").send({ email: "lock@client.test", password: "Wrong-Pass-1!" });
    const locked = await api().post("/api/login").send({ email: "lock@client.test", password: GOOD });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("lists clients for staff with personal data masked, and reveals it only with permission and an audit entry", async () => {
    const list = await boss.agent.get("/api/staff/clients?q=ali");
    expect(list.status).toBe(200);
    const ali = list.body.items[0];
    expect(ali).toMatchObject({ name: "Ali Doe", email: "ali@client.test", country: "United Kingdom" });
    expect(ali.phone).toBe("•••• 234");
    expect(ali.dob).toBe("1990-••-••");

    const reveal = await post(boss, `/api/staff/clients/${ali.id}/reveal`, {});
    expect(reveal.body).toMatchObject({ phone: "5551234", dob: "1990-04-02" });
    const audit = await one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'client.pii_revealed' AND entity_id = ?", [String(ali.id)]);
    expect(Number(audit?.n)).toBe(1);

    // A sales agent sees only clients assigned to them and cannot reveal data.
    expect((await sales.agent.get("/api/staff/clients")).body.total).toBe(0);
    expect((await sales.agent.get(`/api/staff/clients/${ali.id}`)).status).toBe(404);
    expect((await post(boss, `/api/staff/clients/${ali.id}/assign`, { staffId: salesId })).status).toBe(200);
    expect((await sales.agent.get("/api/staff/clients")).body.total).toBe(1);
    expect((await post(sales, `/api/staff/clients/${ali.id}/reveal`, {})).status).toBe(403);
  });

  it("creates a client from the CRM with an invite to set a password", async () => {
    const res = await post(boss, "/api/staff/clients", { firstName: "Sara", lastName: "Khan", email: "sara@client.test", country: "Pakistan", assignedStaffId: salesId });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ source: "staff", hasPassword: false, assigned: { id: salesId } });
    expect((await post(boss, "/api/staff/clients", { firstName: "Sara", lastName: "Khan", email: "sara@client.test" })).status).toBe(409);
    expect((await lastEmail("sara@client.test")).template).toBe("password_reset");
    expect((await api().post("/api/login").send({ email: "sara@client.test", password: GOOD })).status).toBe(422);
  });

  it("freezes and closes accounts with 2FA, a reason and session revocation", async () => {
    const { token, user } = await register("close@client.test");
    const noStepUp = await post(boss, `/api/staff/clients/${user.id}/status`, { status: "closed", reason: "Client asked" });
    expect(noStepUp.body.error.code).toBe("STEP_UP_REQUIRED");
    await stepUp(env, boss);
    expect((await post(boss, `/api/staff/clients/${user.id}/status`, { status: "closed" })).status).toBe(400);
    const closed = await post(boss, `/api/staff/clients/${user.id}/status`, { status: "closed", reason: "Client asked" });
    expect(closed.body.status).toBe("closed");
    expect((await api().get("/api/user").set("Authorization", `Bearer ${token}`)).status).toBe(401);
    expect((await api().post("/api/login").send({ email: "close@client.test", password: GOOD })).status).toBe(403);
  });

  it("logs staff in as a client with 2FA and a reason, view-only and audited", async () => {
    const { user } = await register("view@client.test");
    await exec(env.db, "UPDATE staff_sessions SET stepup_at = NULL");
    const noStepUp = await post(boss, `/api/staff/clients/${user.id}/impersonate`, { reason: "Checking the dashboard" });
    expect(noStepUp.body.error.code).toBe("STEP_UP_REQUIRED");
    await stepUp(env, boss);
    expect((await post(boss, `/api/staff/clients/${user.id}/impersonate`, {})).status).toBe(400);
    const res = await post(boss, `/api/staff/clients/${user.id}/impersonate`, { reason: "Checking the dashboard" });
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/^https:\/\/bismarkets\.global\/impersonate\?token=/);
    const token = new URL(res.body.url).searchParams.get("token")!;
    const auth = { Authorization: `Bearer ${token}` };

    const me = await api().get("/api/user").set(auth);
    expect(me.body.email).toBe("view@client.test");
    // Marked as staff so the support service refuses it: staff must not chat as the client.
    expect(me.body).toMatchObject({ is_staff: true, read_only: true, impersonation: true });
    expect((await api().patch("/api/user").set(auth).send({ city: "Paris" })).status).toBe(403);
    expect((await api().post("/api/send-otp").set(auth).send({ email: "new@client.test" })).status).toBe(403);

    const minutes = (new Date(res.body.expiresAt).getTime() - Date.now()) / 60_000;
    expect(minutes).toBeLessThanOrEqual(env.config.impersonationMs / 60_000);
    const sessions = await boss.agent.get(`/api/staff/clients/${user.id}/sessions`);
    expect(sessions.body.items.find((s: { kind: string }) => s.kind === "impersonation")).toMatchObject({ staffName: "boss", reason: "Checking the dashboard" });
    const audit = await one<{ meta_json: { reason: string } }>(env.db, "SELECT meta_json FROM audit_log WHERE action = 'client.impersonation_started' AND entity_id = ?", [String(user.id)]);
    expect(audit?.meta_json.reason).toBe("Checking the dashboard");

    // Roles without client.impersonate cannot do it.
    expect((await post(sales, `/api/staff/clients/${user.id}/impersonate`, { reason: "Checking the dashboard" })).status).toBe(403);
  });

  it("records notes, edits and the activity timeline", async () => {
    const { user } = await register("notes@client.test");
    expect((await post(boss, `/api/staff/clients/${user.id}/notes`, { body: "Called about KYC" })).status).toBe(201);
    const notes = await boss.agent.get(`/api/staff/clients/${user.id}/notes`);
    expect(notes.body.items[0]).toMatchObject({ body: "Called about KYC", author: { name: "boss" } });
    const edit = await patch(boss, `/api/staff/clients/${user.id}`, { city: "Dubai", phone: "501234567" });
    expect(edit.status).toBe(200);
    const activity = await boss.agent.get(`/api/staff/clients/${user.id}/activity`);
    const actions = activity.body.items.map((a: { action: string }) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["client.registered", "client.note_added", "client.updated"]));
    const logged = await one<{ after_json: Record<string, unknown> }>(env.db, "SELECT after_json FROM audit_log WHERE action = 'client.updated' AND entity_id = ?", [String(user.id)]);
    expect(logged?.after_json).toEqual({ city: "Dubai" });
  });

  it("keeps the outbox readable for testing without leaking codes in the stored text", async () => {
    const list = await boss.agent.get("/api/staff/emails?q=jane");
    expect(list.status).toBe(200);
    expect(list.body.testMode).toBe(true);
    const one_ = await boss.agent.get(`/api/staff/emails/${list.body.items[0].id}`);
    expect(one_.body.body).toBeTruthy();
    expect((await sales.agent.get("/api/staff/emails")).status).toBe(403);
  });
});
