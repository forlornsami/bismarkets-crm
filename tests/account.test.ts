import { createHmac } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeAgent } from "../src/server/routes/client/account";
import { decryptField } from "../src/server/lib/crypto";
import { exec, one, transaction } from "../src/server/lib/db";
import { outboxContext } from "../src/server/lib/email";
import { deliverSupportEvents, queueSupportEvent, signSupportEvent, SUPPORT_EVENTS_PATH } from "../src/server/lib/events";
import { createStaff, hasDb, post, setup, signIn, stepUp, type SignedIn, type TestEnv } from "./helpers";

const GOOD = "Sunny-Day-42!";
const SECRET = "s".repeat(40);
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

describe("device labels", () => {
  it("names common browsers and the app", () => {
    expect(describeAgent(CHROME)).toEqual({ browser: "Chrome", os: "Windows", device: "desktop" });
    expect(describeAgent("okhttp/4.12.0")).toMatchObject({ browser: "BIS Markets app", device: "mobile" });
  });
});

describe("support event signature", () => {
  it("matches the support service's v1 scheme", () => {
    const body = '{"a":1}';
    const { signature, timestamp } = signSupportEvent(SECRET, "evt-1", body, 1_800_000_000);
    expect(timestamp).toBe("1800000000");
    const expected = createHmac("sha256", SECRET).update(`1800000000\nPOST\n${SUPPORT_EVENTS_PATH}\nevt-1\n${body}`).digest("hex");
    expect(signature).toBe(`v1=${expected}`);
  });
});

describe.skipIf(!hasDb)("client notifications, devices and support events", () => {
  let env: TestEnv;
  let boss: SignedIn;
  const api = () => request(env.app);

  async function register(email: string) {
    await api().post("/api/send-otp").send({ email });
    const row = await one<{ body_enc: Buffer; template: string }>(env.db, "SELECT body_enc, template FROM email_outbox WHERE to_email = ? ORDER BY id DESC LIMIT 1", [email]);
    const code = /code is (\d{6})/.exec(decryptField(env.config.dataKey, row!.body_enc, outboxContext(email, row!.template)))![1];
    const res = await api().post("/api/register").set("User-Agent", CHROME).send({ first_name: "Ann", last_name: "Lee", email, password: GOOD, password_confirmation: GOOD, verification_code: code });
    return res.body as { token: string; user: { id: number } };
  }
  const login = async (email: string, ua = CHROME) => (await api().post("/api/login").set("User-Agent", ua).send({ email, password: GOOD })).body.token as string;

  beforeAll(async () => {
    env = await setup({ CRM_SUPPORT_EVENTS_URL: "https://support.test.local/", CRM_SUPPORT_EVENTS_SECRET: SECRET, CRM_SUPPORT_EVENTS_ENVIRONMENT: "staging" });
    await createStaff(env.db, "boss@bis.test", "super_admin");
    boss = await signIn(env, "boss@bis.test");
  });
  afterAll(async () => {
    await env?.db.end();
  });

  it("refuses a short support secret", async () => {
    await expect(setup({ CRM_SUPPORT_EVENTS_URL: "https://support.test.local", CRM_SUPPORT_EVENTS_SECRET: "short" })).rejects.toThrow(/at least 32/);
  });

  it("lists and marks the bell's notifications, only for the signed-in client", async () => {
    const a = await register("bell@client.test");
    const b = await register("other@client.test");
    await exec(env.db, "INSERT INTO client_notifications (client_id, type, title, body) VALUES (?, 'account', 'One', 'First'), (?, 'account', 'Two', 'Second'), (?, 'account', 'Theirs', 'Not yours')", [a.user.id, a.user.id, b.user.id]);
    const auth = { Authorization: `Bearer ${a.token}` };
    expect((await api().get("/api/notifications")).status).toBe(401);
    const list = (await api().get("/api/notifications?per_page=50").set(auth)).body;
    expect(list.data.map((n: { title: string }) => n.title)).toEqual(["Two", "One"]);
    expect(list.data[0]).toMatchObject({ type: "account", body: "Second", message: "Second", read_at: null });
    expect(list.unread_count).toBe(2);
    const theirs = await one<{ id: number }>(env.db, "SELECT id FROM client_notifications WHERE client_id = ?", [b.user.id]);
    expect((await api().post(`/api/notifications/${theirs!.id}/read`).set(auth)).status).toBe(404);
    expect((await api().post(`/api/notifications/${list.data[0].id}/read`).set(auth)).status).toBe(200);
    expect((await api().get("/api/notifications").set(auth)).body.unread_count).toBe(1);
    expect((await api().post("/api/notifications/mark-all-read").set(auth)).body.updated).toBe(1);
    expect((await api().get("/api/notifications").set(auth)).body.unread_count).toBe(0);
    expect(await one(env.db, "SELECT id FROM client_notifications WHERE client_id = ? AND read_at IS NOT NULL", [b.user.id])).toBeUndefined();
    const types = (await api().get("/api/notification-types").set(auth)).body.data;
    expect(types.map((t: { value: string }) => t.value)).toEqual(["kyc", "security", "account", "deposit", "withdrawal"]);
  });

  it("lists signed-in devices and signs one or all others out", async () => {
    await register("devices@client.test");
    const here = await login("devices@client.test");
    const phone = await login("devices@client.test", "okhttp/4.12.0");
    const laptop = await login("devices@client.test");
    const auth = { Authorization: `Bearer ${here}` };
    const list = (await api().get("/api/sessions").set(auth)).body.data;
    expect(list.length).toBe(4);
    expect(list.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    expect(list.find((s: { browser: string }) => s.browser === "BIS Markets app")).toBeTruthy();
    for (const s of list) expect(s.id).toMatch(/^[a-f0-9]{32}$/);

    const me = (await api().get("/api/user").set({ Authorization: `Bearer ${phone}` })).body;
    expect((await api().delete(`/api/sessions/${me.session_id}`).set(auth)).status).toBe(200);
    expect((await api().get("/api/user").set({ Authorization: `Bearer ${phone}` })).status).toBe(401);
    expect((await api().delete(`/api/sessions/${me.session_id}`).set(auth)).status).toBe(404);
    expect((await api().delete("/api/sessions/not-a-session").set(auth)).status).toBe(404);

    const others = await api().delete("/api/sessions").set(auth);
    expect(others.body.revoked).toBe(2);
    expect((await api().get("/api/user").set({ Authorization: `Bearer ${laptop}` })).status).toBe(401);
    expect((await api().get("/api/user").set(auth)).status).toBe(200);
    const revoked = (await env.db.query("SELECT payload FROM webhook_outbox WHERE event = 'session.revoked'"))[0] as { payload: { session_id: string } }[];
    expect(revoked.map((r) => r.payload.session_id)).toContain(me.session_id);
    expect(await one(env.db, "SELECT id FROM audit_log WHERE action = 'client.other_devices_signed_out'")).toBeTruthy();
  });

  it("marks a staff view-only session on /api/user and blocks changes", async () => {
    const { user } = await register("viewonly@client.test");
    await stepUp(env, boss);
    const res = await post(boss, `/api/staff/clients/${user.id}/impersonate`, { reason: "Checking the bell" });
    const token = new URL(res.body.url).searchParams.get("token")!;
    const auth = { Authorization: `Bearer ${token}` };
    const me = (await api().get("/api/user").set(auth)).body;
    expect(me).toMatchObject({ impersonation: true, read_only: true, is_staff: true, impersonated_by: "boss" });
    expect((await api().get("/api/notifications").set(auth)).status).toBe(200);
    expect((await api().post("/api/notifications/mark-all-read").set(auth)).status).toBe(403);
    expect((await api().delete("/api/sessions").set(auth)).status).toBe(403);
    // A staff view does not appear in the client's own device list.
    const own = await login("viewonly@client.test");
    const ownAuth = { Authorization: `Bearer ${own}` };
    expect((await api().get("/api/sessions").set(ownAuth)).body.data).toHaveLength(2);

    // Signing out other devices ends only the listed ones and counts only those: the staff
    // view keeps running and a timed-out session is ended without being counted.
    const idle = await login("viewonly@client.test");
    await exec(env.db, "UPDATE client_sessions SET last_seen_at = CURRENT_TIMESTAMP(3) - INTERVAL 8 DAY WHERE id = SHA2(?, 256)", [idle]);
    expect((await api().get("/api/sessions").set(ownAuth)).body.data).toHaveLength(2);
    const out = await api().delete("/api/sessions").set(ownAuth);
    expect(out.body).toMatchObject({ revoked: 1, message: "Signed out 1 other device." });
    expect((await api().get("/api/user").set(auth)).status).toBe(200);
    expect((await api().get("/api/sessions").set(ownAuth)).body.data).toHaveLength(1);
    expect(await one(env.db, "SELECT id FROM client_sessions WHERE id = SHA2(?, 256) AND revoked_reason = 'client_signed_out_others'", [idle])).toBeTruthy();

    // Staff ending the client's sessions still ends the view too.
    await post(boss, `/api/staff/clients/${user.id}/revoke-sessions`, {});
    expect((await api().get("/api/user").set(auth)).status).toBe(401);
  });

  it("tells support when an account is closed and reopened", async () => {
    const { user } = await register("closed@client.test");
    await stepUp(env, boss);
    await post(boss, `/api/staff/clients/${user.id}/status`, { status: "closed", reason: "Client asked" });
    await post(boss, `/api/staff/clients/${user.id}/status`, { status: "active", reason: "Client came back" });
    const events = ((await env.db.query("SELECT event FROM webhook_outbox WHERE client_id = ? ORDER BY id", [user.id]))[0] as { event: string }[]).map((e) => e.event);
    expect(events).toEqual(expect.arrayContaining(["account.disabled", "account.enabled", "session.revoked"]));
  });

  it("delivers queued events signed, retries server errors and gives up on refusals", async () => {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    let answer = 500;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
      return new Response("{}", { status: answer });
    }) as unknown as typeof fetch;

    const queued = Number((await one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM webhook_outbox WHERE status = 'queued'"))!.n);
    expect(queued).toBeGreaterThan(0);
    expect(await deliverSupportEvents(env.db, env.config, fakeFetch, undefined, 500)).toBe(0);
    expect(calls[0]!.url).toBe(`https://support.test.local${SUPPORT_EVENTS_PATH}`);
    const first = calls[0]!;
    const body = JSON.parse(first.body);
    expect(body).toMatchObject({ schema_version: 1, environment: "staging", source: "crm", event_id: first.headers["X-Event-ID"] });
    expect(typeof body.user_id).toBe("string");
    const expected = createHmac("sha256", SECRET).update(`${first.headers["X-Event-Timestamp"]}\nPOST\n${SUPPORT_EVENTS_PATH}\n${body.event_id}\n${first.body}`).digest("hex");
    expect(first.headers["X-Event-Signature"]).toBe(`v1=${expected}`);
    expect(await one(env.db, "SELECT id FROM webhook_outbox WHERE status = 'queued' AND attempts = 1 AND last_status = 500")).toBeTruthy();

    // Not due yet: nothing is sent again until the backoff passes.
    calls.length = 0;
    expect(await deliverSupportEvents(env.db, env.config, fakeFetch, undefined, 500)).toBe(0);
    expect(calls).toHaveLength(0);

    await exec(env.db, "UPDATE webhook_outbox SET next_attempt_at = CURRENT_TIMESTAMP(3)");
    answer = 202;
    expect(await deliverSupportEvents(env.db, env.config, fakeFetch, undefined, 500)).toBe(queued);
    expect(await one(env.db, "SELECT id FROM webhook_outbox WHERE status <> 'delivered'")).toBeUndefined();

    await exec(env.db, "UPDATE webhook_outbox SET status = 'queued', next_attempt_at = CURRENT_TIMESTAMP(3) WHERE id = (SELECT id FROM (SELECT MIN(id) AS id FROM webhook_outbox) t)");
    answer = 401;
    await deliverSupportEvents(env.db, env.config, fakeFetch);
    expect(await one(env.db, "SELECT id FROM webhook_outbox WHERE status = 'failed' AND last_status = 401")).toBeTruthy();
  });

  it("holds a lease while sending and drops KYC pushes older than a day", async () => {
    const { user } = await register("stale@client.test");
    await exec(env.db, "UPDATE webhook_outbox SET status = 'delivered' WHERE status = 'queued'");
    await transaction(env.db, async (conn) => {
      await queueSupportEvent(conn, env.config, { event: "kyc.approved", clientId: user.id });
      await queueSupportEvent(conn, env.config, { event: "account.disabled", clientId: user.id });
      await queueSupportEvent(conn, env.config, { event: "kyc.identity.rejected", clientId: user.id });
    });
    await exec(env.db, "UPDATE webhook_outbox SET created_at = CURRENT_TIMESTAMP(3) - INTERVAL 25 HOUR WHERE client_id = ? AND event IN ('kyc.approved', 'account.disabled')", [user.id]);

    const sent: string[] = [];
    let during = -1;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)).event);
      // A second sender running meanwhile finds nothing: the rows are leased, not locked.
      if (during < 0) during = await deliverSupportEvents(env.db, env.config, fakeFetch, undefined, 500);
      return new Response("{}", { status: 202 });
    }) as unknown as typeof fetch;
    expect(await deliverSupportEvents(env.db, env.config, fakeFetch, undefined, 500)).toBe(2);
    expect(during).toBe(0);
    expect(sent.sort()).toEqual(["account.disabled", "kyc.identity.rejected"]);
    const rows = (await env.db.query("SELECT event, status, last_error FROM webhook_outbox WHERE client_id = ? AND event LIKE 'kyc.%' ORDER BY id", [user.id]))[0] as { event: string; status: string; last_error: string | null }[];
    expect(rows).toEqual([
      { event: "kyc.approved", status: "failed", last_error: "expired" },
      { event: "kyc.identity.rejected", status: "delivered", last_error: null },
    ]);
  });
});
