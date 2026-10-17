import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { decryptField } from "../src/server/lib/crypto";
import { exec, one, rows } from "../src/server/lib/db";
import { outboxContext } from "../src/server/lib/email";
import { deliverEmails, MAIL_PASSWORD_CONTEXT, textToHtml, unsubscribeToken, type MailMessage, type SmtpOptions, type TransportFactory } from "../src/server/lib/mailer";
import { createStaff, hasDb, ORIGIN, patch, post, setup, signIn, stepUp, type SignedIn, type TestEnv } from "./helpers";

describe("email rendering", () => {
  it("escapes text and links only https addresses", () => {
    const html = textToHtml("Hi <b>Sam</b>\n\nOpen https://bismarkets.global/login. Or javascript:alert(1)");
    expect(html).toContain("Hi &lt;b&gt;Sam&lt;/b&gt;");
    expect(html).toContain('<a href="https://bismarkets.global/login"');
    expect(html).not.toContain('href="javascript');
  });
});

describe.skipIf(!hasDb)("email", () => {
  let env: TestEnv;
  let boss: SignedIn;
  let admin: SignedIn;
  let sales: SignedIn;
  let support: SignedIn;
  const outbox: { options: SmtpOptions; message: MailMessage }[] = [];
  let failNext: { code?: string; responseCode?: number; message: string } | null = null;
  const fake: TransportFactory = (options) => ({
    async send(message) {
      if (failNext) {
        const e = Object.assign(new Error(failNext.message), failNext);
        failNext = null;
        throw e;
      }
      outbox.push({ options, message });
      return { messageId: `<${outbox.length}@test>` };
    },
    async verify() {},
    close() {},
  });
  const clients: number[] = [];

  const SETTINGS = { provider: "hostinger", host: "smtp.hostinger.com", port: 465, security: "tls", username: "crm@bismarkets.com", password: "Mailbox-Pass-1", fromName: "BIS Markets", fromEmail: "crm@bismarkets.com", replyTo: "support@bismarkets.com" };

  beforeAll(async () => {
    env = await setup({}, { mailTransport: fake });
    await createStaff(env.db, "boss@bis.test", "super_admin");
    await createStaff(env.db, "admin@bis.test", "admin");
    await createStaff(env.db, "sales@bis.test", "sales_manager");
    await createStaff(env.db, "support@bis.test", "support_agent");
    boss = await signIn(env, "boss@bis.test");
    admin = await signIn(env, "admin@bis.test");
    sales = await signIn(env, "sales@bis.test");
    support = await signIn(env, "support@bis.test");
    for (const [i, status] of (["active", "active", "frozen", "closed"] as const).entries()) {
      const r = await exec(
        env.db,
        "INSERT INTO clients (email, first_name, last_name, status, referral_code, email_verified_at, country) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3), ?)",
        [`c${i}@client.test`, `Ann${i}`, "Lee", status, `REF${i}`, i === 1 ? "Germany" : "United Kingdom"],
      );
      clients.push(r.insertId);
    }
  });
  afterAll(async () => {
    await env?.db.end();
  });
  beforeEach(() => {
    outbox.length = 0;
  });

  it("holds emails while no provider is set up", async () => {
    await request(env.app).post("/api/send-otp").send({ email: "held@client.test" });
    const row = await one<{ status: string }>(env.db, "SELECT status FROM email_outbox WHERE to_email = 'held@client.test'");
    expect(row?.status).toBe("held");
    expect(await deliverEmails(env.db, env.config, fake)).toBe(0);
    const stored = await one<{ body_text: string; body_enc: Buffer; template: string }>(env.db, "SELECT body_text, body_enc, template FROM email_outbox WHERE to_email = 'held@client.test'");
    expect(stored!.body_text).not.toMatch(/\d{6}/);
    expect(decryptField(env.config.dataKey, stored!.body_enc, outboxContext("held@client.test", stored!.template))).toMatch(/\d{6}/);
  });

  it("lets only settings managers change the provider, with 2FA, and never returns the password", async () => {
    expect((await admin.agent.get("/api/staff/mail-settings")).status).toBe(200);
    expect((await admin.agent.put("/api/staff/mail-settings").set("Origin", ORIGIN).set("X-CSRF-Token", admin.csrf).send(SETTINGS)).status).toBe(403);
    expect((await support.agent.get("/api/staff/mail-settings")).status).toBe(403);
    const put = () => boss.agent.put("/api/staff/mail-settings").set("Origin", ORIGIN).set("X-CSRF-Token", boss.csrf);
    expect((await put().send(SETTINGS)).body.error.code).toBe("STEP_UP_REQUIRED");
    await stepUp(env, boss);
    const saved = await put().send(SETTINGS);
    expect(saved.status).toBe(200);
    expect(saved.body.settings).toMatchObject({ host: "smtp.hostinger.com", port: 465, security: "tls", hasPassword: true, enabled: false });
    expect(JSON.stringify(saved.body)).not.toContain("Mailbox-Pass-1");
    const row = await one<{ password_enc: Buffer }>(env.db, "SELECT password_enc FROM mail_settings WHERE id = 1");
    expect(row!.password_enc.includes(Buffer.from("Mailbox-Pass-1"))).toBe(false);
    expect(decryptField(env.config.dataKey, row!.password_enc, MAIL_PASSWORD_CONTEXT)).toBe("Mailbox-Pass-1");
    const audit = await one<{ after_json: string }>(env.db, "SELECT after_json FROM audit_log WHERE action = 'mail.settings_updated' ORDER BY id DESC LIMIT 1");
    expect(JSON.stringify(audit)).not.toContain("Mailbox-Pass-1");
    // Saving again without a password keeps the stored one.
    const again = await put().send({ ...SETTINGS, password: "" });
    expect(again.body.settings.hasPassword).toBe(true);
    expect((await put().send({ ...SETTINGS, host: "not a host" })).status).toBe(400);
  });

  it("needs a passing test before sending can be switched on", async () => {
    expect((await post(boss, "/api/staff/mail-settings/enabled", { enabled: true })).status).toBe(400);
    failNext = { code: "EAUTH", responseCode: 535, message: "Invalid login" };
    const bad = await post(boss, "/api/staff/mail-settings/test", { to: "boss@bis.test" });
    expect(bad.body).toMatchObject({ ok: false, error: "The mail server rejected the username or password." });
    const good = await post(boss, "/api/staff/mail-settings/test", { to: "boss@bis.test" });
    expect(good.body.ok).toBe(true);
    expect(outbox[0]?.options).toMatchObject({ host: "smtp.hostinger.com", port: 465, security: "tls", username: "crm@bismarkets.com", password: "Mailbox-Pass-1" });
    expect(outbox[0]?.message).toMatchObject({ to: "boss@bis.test", from: { name: "BIS Markets", address: "crm@bismarkets.com" }, replyTo: "support@bismarkets.com" });
    const on = await post(boss, "/api/staff/mail-settings/enabled", { enabled: true });
    expect(on.body.settings.enabled).toBe(true);
  });

  it("sends queued account emails through the provider and retries failures", async () => {
    await request(env.app).post("/api/send-otp").send({ email: "new@client.test" });
    const row = await one<{ id: number; status: string }>(env.db, "SELECT id, status FROM email_outbox WHERE to_email = 'new@client.test'");
    expect(row?.status).toBe("queued");
    failNext = { code: "ECONNECTION", message: "connect ECONNREFUSED" };
    expect(await deliverEmails(env.db, env.config, fake)).toBe(0);
    const retry = await one<{ status: string; attempts: number; last_error: string }>(env.db, "SELECT status, attempts, last_error FROM email_outbox WHERE id = ?", [row!.id]);
    expect(retry).toMatchObject({ status: "queued", attempts: 1 });
    expect(retry!.last_error).toContain("Could not connect");
    await exec(env.db, "UPDATE email_outbox SET next_attempt_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [row!.id]);
    expect(await deliverEmails(env.db, env.config, fake)).toBe(1);
    expect(outbox[0]?.message.text).toMatch(/code is \d{6}/);
    expect(outbox[0]?.message.html).toContain("BIS Markets");
    expect((await one<{ status: string }>(env.db, "SELECT status FROM email_outbox WHERE id = ?", [row!.id]))?.status).toBe("sent");
  });

  it("changing the server pauses sending until it is tested again", async () => {
    await stepUp(env, boss);
    const res = await boss.agent.put("/api/staff/mail-settings").set("Origin", ORIGIN).set("X-CSRF-Token", boss.csrf).send({ ...SETTINGS, host: "smtp.example.com", password: "" });
    expect(res.body.settings).toMatchObject({ enabled: false, lastTestOk: null });
    await post(boss, "/api/staff/mail-settings/test", { to: "boss@bis.test" });
    expect((await post(boss, "/api/staff/mail-settings/enabled", { enabled: true })).body.settings.enabled).toBe(true);
  });

  it("lets a sales manager email one client but not a group", async () => {
    const one1 = { audience: "clients", filter: { clientIds: [clients[0]] }, subject: "Hello {{first_name}}", body: "Dear {{full_name}},\n\nYour account {{client_id}} is ready." };
    const preview = await post(sales, "/api/staff/messages/preview", one1);
    expect(preview.body).toMatchObject({ count: 1, rendered: { subject: "Hello Ann0", body: `Dear Ann0 Lee,\n\nYour account ${clients[0]} is ready.` } });
    const sent = await post(sales, "/api/staff/messages/send", { ...one1, expectedCount: 1 });
    expect(sent.status).toBe(201);
    const group = { audience: "clients", filter: { status: ["active"] }, subject: "News", body: "Hi" };
    expect((await post(sales, "/api/staff/messages/preview", group)).status).toBe(403);
    expect((await post(support, "/api/staff/messages/preview", one1)).status).toBe(403);
    const audit = await one<{ action: string }>(env.db, "SELECT action FROM audit_log WHERE action = 'email.sent_to_client'");
    expect(audit).toBeTruthy();
  });

  it("rejects unknown placeholders and multi-line subjects", async () => {
    const res = await post(admin, "/api/staff/messages/preview", { audience: "clients", filter: { clientIds: [clients[0]] }, subject: "Hi", body: "{{password}}" });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("{{password}}");
    await stepUp(env, admin);
    const nl = await post(admin, "/api/staff/messages/send", { audience: "clients", filter: { clientIds: [clients[0]] }, subject: "Hi\r\nBcc: x@y.z", body: "x", expectedCount: 1 });
    expect(nl.status).toBe(400);
  });

  it("sends a group email with 2FA, skipping closed accounts and checking the confirmed count", async () => {
    const group = { audience: "clients", filter: { status: [] as string[] }, category: "service", subject: "Maintenance", body: "Hi {{first_name}}, the portal is down tonight." };
    const preview = await post(admin, "/api/staff/messages/preview", group);
    expect(preview.body.count).toBe(3);
    await exec(env.db, "UPDATE staff_sessions SET stepup_at = NULL WHERE staff_id = ?", [admin.staffId]);
    expect((await post(admin, "/api/staff/messages/send", { ...group, expectedCount: 3 })).body.error.code).toBe("STEP_UP_REQUIRED");
    await stepUp(env, admin);
    expect((await post(admin, "/api/staff/messages/send", { ...group, expectedCount: 4 })).status).toBe(409);
    const sent = await post(admin, "/api/staff/messages/send", { ...group, expectedCount: 3 });
    expect(sent.status).toBe(201);
    const list = await rows<{ to_email: string; subject: string; body_text: string }>(env.db, "SELECT to_email, subject, body_text FROM email_outbox WHERE campaign_id = ? ORDER BY id", [sent.body.id]);
    expect(list.map((r) => r.to_email)).toEqual(["c0@client.test", "c1@client.test", "c2@client.test"]);
    expect(list[1]?.body_text).toBe("Hi Ann1, the portal is down tonight.");
    const history = await admin.agent.get("/api/staff/messages");
    expect(history.body.items[0]).toMatchObject({ id: sent.body.id, recipients: 3, subject: "Maintenance", delivery: { waiting: 3 } });
    await deliverEmails(env.db, env.config, fake);
    const detail = await admin.agent.get(`/api/staff/messages/${sent.body.id}`);
    expect(detail.body.delivery).toMatchObject({ sent: 3, waiting: 0 });
  });

  it("adds an unsubscribe link to marketing emails and honours it", async () => {
    await stepUp(env, admin);
    const promo = { audience: "clients", filter: { countries: ["Germany", "United Kingdom"] }, category: "marketing", subject: "Offer", body: "New bonus for you." };
    const preview = await post(admin, "/api/staff/messages/preview", promo);
    expect(preview.body.count).toBe(3);
    await post(admin, "/api/staff/messages/send", { ...promo, expectedCount: 3 });
    // Client 1 unsubscribes before delivery.
    const token = unsubscribeToken(env.config, clients[1]!);
    const page = await request(env.app).get(`/email/unsubscribe?c=${clients[1]}&t=${token}`);
    expect(page.text).toContain("<form");
    expect((await request(env.app).get(`/email/unsubscribe?c=${clients[1]}&t=${"x".repeat(32)}`)).status).toBe(404);
    const unsub = await request(env.app).post(`/email/unsubscribe?c=${clients[1]}&t=${token}`).type("form").send("List-Unsubscribe=One-Click");
    expect(unsub.status, unsub.text).toBe(200);
    await deliverEmails(env.db, env.config, fake);
    expect(outbox.map((m) => m.message.to).sort()).toEqual(["c0@client.test", "c2@client.test"]);
    expect(outbox[0]?.message.headers?.["List-Unsubscribe"]).toContain("/email/unsubscribe?c=");
    expect(outbox[0]?.message.text).toContain("To stop news and offers");
    expect((await post(admin, "/api/staff/messages/preview", promo)).body.count).toBe(2);
  });

  it("emails staff by role, and only for staff with the bulk permission", async () => {
    const roles = await rows<{ id: number; slug: string }>(env.db, "SELECT id, slug FROM roles WHERE slug IN ('admin', 'support_agent')");
    const msg = { audience: "staff", filter: { roleIds: roles.map((r) => r.id) }, subject: "Team meeting", body: "Hi {{first_name}}, meeting at 10." };
    expect((await post(sales, "/api/staff/messages/preview", msg)).status).toBe(403);
    await stepUp(env, admin);
    const preview = await post(admin, "/api/staff/messages/preview", msg);
    expect(preview.body.count).toBe(2);
    const sent = await post(admin, "/api/staff/messages/send", { ...msg, expectedCount: 2 });
    expect(sent.status).toBe(201);
    const staffRows = await rows<{ staff_user_id: number | null; client_id: number | null }>(env.db, "SELECT staff_user_id, client_id FROM email_outbox WHERE campaign_id = ?", [sent.body.id]);
    expect(staffRows.every((r) => r.staff_user_id && !r.client_id)).toBe(true);
  });

  it("saves templates for staff with the templates permission", async () => {
    const t = { name: "Welcome call", subject: "Hi {{first_name}}", body: "Thanks for joining.", category: "service" };
    expect((await post(support, "/api/staff/messages/templates", t)).status).toBe(403);
    const made = await post(admin, "/api/staff/messages/templates", t);
    expect(made.status).toBe(201);
    expect((await post(admin, "/api/staff/messages/templates", t)).status).toBe(409);
    expect((await patch(admin, `/api/staff/messages/templates/${made.body.id}`, { ...t, body: "Updated" })).status).toBe(200);
    const list = await sales.agent.get("/api/staff/messages/templates");
    expect(list.body.items[0]).toMatchObject({ name: "Welcome call", body: "Updated" });
  });

  it("can retry a failed email and cancel a waiting one", async () => {
    await deliverEmails(env.db, env.config, fake);
    await request(env.app).post("/api/send-otp").send({ email: "bounce@client.test" });
    failNext = { responseCode: 550, message: "550 No such user" };
    await deliverEmails(env.db, env.config, fake);
    const row = await one<{ id: number; status: string; last_error: string }>(env.db, "SELECT id, status, last_error FROM email_outbox WHERE to_email = 'bounce@client.test'");
    expect(row).toMatchObject({ status: "failed" });
    expect(row!.last_error).toContain("550");
    expect((await post(admin, `/api/staff/emails/${row!.id}/retry`)).status).toBe(200);
    expect((await post(admin, `/api/staff/emails/${row!.id}/cancel`)).status).toBe(200);
    const list = await admin.agent.get("/api/staff/emails?status=cancelled");
    expect(list.body.items.some((e: { id: number }) => e.id === row!.id)).toBe(true);
  });
});
