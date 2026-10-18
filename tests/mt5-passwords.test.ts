import type { Express } from "express";
import pino from "pino";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import { createClientSession } from "../src/server/clients/session";
import { decryptField } from "../src/server/lib/crypto";
import { exec, one, rows, transaction } from "../src/server/lib/db";
import { keepMt5Password, mt5PasswordContext, samePassword } from "../src/server/mt5/passwords";
import { checkAccount } from "../src/server/mt5/resolver";
import { FakeGateway } from "./fakes/gateway";
import { createStaff, hasDb, post, setup, signIn, stepUp, type SignedIn, type TestEnv } from "./helpers";

// Kept MT5 passwords (design §16): sealed and bound to their row, shown only
// in the client's own account list, never to staff (not even viewing as the
// client), forgotten when the account was never opened, and never left
// showing a password the account may no longer have.

const MASTER = "Trade-Me-42!";
const INVESTOR = "Look-Only-7?";
const SAME = "The investor password must be different from the master password.";
const NEW_PASSWORD = "Enter a new password.";
const OUT_OF_DATE = "Your account's passwords have changed since this page was opened. Reload the page and try again.";
const UNCONFIRMED = "We could not confirm that this change was made. Please check your account in a minute before trying again.";
const VIEW_ONLY = "This is a view-only staff session. Changes are not allowed.";

/** What the portal shows (portal-api.ts:2267-2268, OpenAccounts.tsx:593-596): the value, or "not available" for null, "" or none. */
const portalShows = (v: unknown) => (v ? String(v) : "not available");
/** What the app shows (normalize.ts text(), CoreScreens.tsx:240): text or a number as it is (so "" is blank), anything else its fallback. */
const appShows = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : "Not supplied by server");

interface Client {
  id: number;
  token: string;
}

describe.skipIf(!hasDb)("kept MT5 passwords", () => {
  let env: TestEnv;
  let app: Express;
  const fake = new FakeGateway();
  /** Everything the app logged, down to trace, to check no password ever reaches a log. */
  const logLines: string[] = [];
  /** Every password the tests used, checked against the logs and tables at the end. */
  const used = new Set<string>([MASTER, INVESTOR]);
  let boss: SignedIn;
  let staffId = 0;
  let classic = 0;
  let seq = 0;

  async function makeClient(): Promise<Client> {
    seq++;
    const r = await exec(
      env.db,
      "INSERT INTO clients (email, first_name, last_name, referral_code, source, kyc_status, status) VALUES (?, 'Pat', 'Kay', ?, 'portal', 'approved', 'active')",
      [`kept.${seq}@client.test`, `KP${String(seq).padStart(8, "0")}`],
    );
    const { token } = await transaction(env.db, (conn) => createClientSession(conn, env.config, r.insertId, "127.0.0.1", "vitest"));
    return { id: r.insertId, token };
  }
  /** Staff looking through the client's eyes. */
  async function viewAs(c: Client): Promise<Client> {
    const { token } = await transaction(env.db, (conn) => createClientSession(conn, env.config, c.id, "127.0.0.1", "vitest", { staffId, reason: "Checking accounts" }));
    return { ...c, token };
  }
  const api = () => request(app);
  const bearer = (c: Client) => ({ Authorization: `Bearer ${c.token}` });
  const list = (c: Client) => api().get("/api/mt5-accounts").set(bearer(c));
  const create = (c: Client, body: Record<string, unknown>) => api().post("/api/mt5-accounts").set(bearer(c)).send(body);
  const change = (c: Client, login: string, body: Record<string, unknown>) => api().patch(`/api/mt5-accounts/${login}/password`).set(bearer(c)).send(body);
  const pairs = (main: string, investor: string) => {
    for (const p of [main, investor]) if (p) used.add(p);
    return { password: main, password_confirmation: main, investor_password: investor, investor_password_confirmation: investor };
  };
  /** The portal's body (OpenAccounts.tsx:518, 535): the new password, and the other one sent back from the list the page loaded, or "". */
  const portalBody = (page: { password?: unknown; investor_password?: unknown }, kind: "master" | "investor", value: string) => {
    const other = (v: unknown) => (v ? String(v) : "");
    return kind === "master" ? pairs(value, other(page.investor_password)) : pairs(other(page.password), value);
  };
  const realBody = (extra: Record<string, unknown> = {}) => ({
    is_demo: false, account_package_id: classic, leverage: "2000", currency: "usd", password: MASTER, investor_password: INVESTOR, ...extra,
  });
  const demoBody = (extra: Record<string, unknown> = {}) => ({ is_demo: true, demo_amount: 1000, leverage: "2000", password: MASTER, investor_password: INVESTOR, ...extra });
  const accountId = async (clientId: number) => Number((await one<{ id: number }>(env.db, "SELECT id FROM mt5_accounts WHERE client_id = ? ORDER BY id DESC LIMIT 1", [clientId]))!.id);
  const kept = (id: number) => rows<{ type: string; set_by: string }>(env.db, "SELECT type, set_by FROM mt5_account_passwords WHERE account_id = ? ORDER BY type", [id]);
  const sealedOf = async (id: number, type: string) => (await one<{ sealed: Buffer }>(env.db, "SELECT sealed FROM mt5_account_passwords WHERE account_id = ? AND type = ?", [id, type]))?.sealed;
  /** The account as the client's list shows it. */
  async function shown(c: Client, login: string) {
    const res = await list(c);
    expect(res.status).toBe(200);
    return [...res.body.real_accounts, ...res.body.demo_accounts].find((a: { login: string }) => a.login === login);
  }
  const mt5User = (login: string, server = "live") => fake.user(server, Number(login))!;

  /** A client with one open account (live unless `body` says demo). */
  async function withAccount(body: Record<string, unknown> = realBody()) {
    const c = await makeClient();
    const res = await create(c, body);
    expect(res.status).toBe(200);
    const login = res.body.account.login as string;
    return { c, login, id: await accountId(c.id) };
  }

  beforeAll(async () => {
    env = await setup({}, { mt5: fake });
    const log = pino({ level: "trace" }, { write: (line: string) => void logLines.push(line) });
    app = createApp({ db: env.db, config: env.config, log, fetch: (async () => new Response("", { status: 503 })) as typeof fetch, mt5: fake });
    await exec(env.db, "INSERT INTO mt5_servers (code, label, is_enabled) VALUES ('live', 'Live', 1), ('demo', 'Demo', 1)");
    await exec(env.db, "UPDATE mt5_settings SET demo_server_code = 'demo', demo_group = 'demo\\\\usd', leverages = '2000,500' WHERE id = 1");
    classic = (
      await exec(env.db, "INSERT INTO account_packages (name, spread_label, min_deposit_cents, server_code, mt5_group) VALUES ('Classic', '1.2', 0, 'live', 'real\\\\standard')")
    ).insertId;
    staffId = await createStaff(env.db, "boss.kept@crm.test", "super_admin");
    boss = await signIn({ ...env, app }, "boss.kept@crm.test");
  }, 120_000);
  afterAll(async () => env?.db.end());
  beforeEach(() => {
    fake.clearFaults();
    fake.down = false;
  });

  // ---------- Sealed and bound ----------

  it("keeps both passwords sealed, each opening only for its own account, client and type", async () => {
    const { c, login, id } = await withAccount();
    expect(await kept(id)).toEqual([{ type: "main", set_by: "client" }, { type: "investor", set_by: "client" }]);
    const main = (await sealedOf(id, "main"))!;
    expect(main.toString("latin1")).not.toContain(MASTER);
    expect(decryptField(env.config.dataKey, main, `mt5_password|${id}|${c.id}|main`)).toBe(MASTER);
    expect(mt5PasswordContext(id, c.id, "main")).toBe(`mt5_password|${id}|${c.id}|main`);
    for (const wrong of [mt5PasswordContext(id, c.id, "investor"), mt5PasswordContext(id + 1, c.id, "main"), mt5PasswordContext(id, c.id + 1, "main")]) {
      expect(() => decryptField(env.config.dataKey, main, wrong)).toThrow();
    }

    const res = await list(c);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.real_accounts[0]).toMatchObject({ login, password: MASTER, investor_password: INVESTOR });

    // Another client's account, its master password replaced by this account's sealed one: it does not open there.
    const other = await withAccount(realBody({ password: "Other-Main-1!", investor_password: "Other-View-1?" }));
    used.add("Other-Main-1!").add("Other-View-1?");
    await exec(env.db, "UPDATE mt5_account_passwords SET sealed = ? WHERE account_id = ? AND type = 'main'", [main, other.id]);
    const warnedBefore = logLines.length;
    expect(await shown(other.c, other.login)).toMatchObject({ password: null, investor_password: "Other-View-1?" });
    const warned = logLines.slice(warnedBefore).map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.msg === "A kept MT5 password does not open; it is shown as not available");
    expect(warned).toEqual([expect.objectContaining({ level: 40, accountId: other.id, type: "main" })]);
    expect(JSON.stringify(warned)).not.toContain(MASTER);

    // Swapped between the two types of one account: neither opens.
    const investor = (await sealedOf(id, "investor"))!;
    await exec(env.db, "UPDATE mt5_account_passwords SET sealed = ? WHERE account_id = ? AND type = 'main'", [investor, id]);
    await exec(env.db, "UPDATE mt5_account_passwords SET sealed = ? WHERE account_id = ? AND type = 'investor'", [main, id]);
    expect(await shown(c, login)).toMatchObject({ password: null, investor_password: null });
    await exec(env.db, "UPDATE mt5_account_passwords SET sealed = ? WHERE account_id = ? AND type = 'main'", [main, id]);
    await exec(env.db, "UPDATE mt5_account_passwords SET sealed = ? WHERE account_id = ? AND type = 'investor'", [investor, id]);
    expect(await shown(c, login)).toMatchObject({ password: MASTER, investor_password: INVESTOR });

    // An account row moved to another client: its passwords do not open for that client.
    await exec(env.db, "UPDATE mt5_accounts SET client_id = ? WHERE id = ?", [other.c.id, id]);
    try {
      expect(await shown(other.c, login)).toMatchObject({ password: null, investor_password: null });
    } finally {
      await exec(env.db, "UPDATE mt5_accounts SET client_id = ? WHERE id = ?", [c.id, id]);
    }
  });

  it("compares a re-sent password in constant time, whatever the lengths", () => {
    expect(samePassword(MASTER, MASTER)).toBe(true);
    expect(samePassword(MASTER, INVESTOR)).toBe(false);
    // Different lengths compare as hashes: no early way out, and no throw from timingSafeEqual.
    expect(samePassword("a", "a much longer password")).toBe(false);
    expect(samePassword("", "x")).toBe(false);
    expect(samePassword(MASTER, null)).toBe(false);
  });

  // ---------- Who sees them ----------

  it("shows them to the client's own session only; staff viewing as the client get what both clients show as not available", async () => {
    const { c, login } = await withAccount();
    const mine = await shown(c, login);
    expect([portalShows(mine.password), appShows(mine.password), portalShows(mine.investor_password), appShows(mine.investor_password)]).toEqual([MASTER, MASTER, INVESTOR, INVESTOR]);

    const staff = await viewAs(c);
    const res = await list(staff);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const theirs = res.body.real_accounts[0];
    expect(theirs).toMatchObject({ login, password: null, investor_password: null });
    expect([portalShows(theirs.password), appShows(theirs.password)]).toEqual(["not available", "Not supplied by server"]);
    expect(JSON.stringify(res.body)).not.toContain(MASTER);
    expect(JSON.stringify(res.body)).not.toContain(INVESTOR);

    // Nor through a change or an opening, which a view-only session cannot make, or their refusals.
    const writes = [
      await create(staff, realBody()),
      await change(staff, login, pairs("Staff-Try-11!", "")),
      await api().patch(`/api/mt5-accounts/${login}/inactive`).set(bearer(staff)),
    ];
    for (const w of writes) {
      expect(w).toMatchObject({ status: 403, body: { message: VIEW_ONLY } });
      expect(JSON.stringify(w.body)).not.toMatch(/Trade-Me|Look-Only|Staff-Try/);
    }
    // And no other read of the client's: there is no single-account read, and these carry no password.
    for (const path of [`/api/mt5-accounts/${login}`, "/api/trade-history", "/api/transfers", "/api/user", "/api/user/stats", "/api/notifications"]) {
      for (const who of [staff, c]) {
        const r = await api().get(path).set(bearer(who));
        expect(JSON.stringify(r.body), path).not.toContain(MASTER);
        expect(JSON.stringify(r.body), path).not.toContain(INVESTOR);
      }
    }
  });

  it("shows an account with nothing kept as not available in both clients, never as a blank", async () => {
    const { c, login, id } = await withAccount();
    await exec(env.db, "DELETE FROM mt5_account_passwords WHERE account_id = ?", [id]);
    const a = await shown(c, login);
    // Both keys are there, as null: "" would show blank in the app.
    expect(a).toHaveProperty("password", null);
    expect(a).toHaveProperty("investor_password", null);
    expect([portalShows(a.password), appShows(a.password), portalShows(a.investor_password), appShows(a.investor_password)]).toEqual([
      "not available", "Not supplied by server", "not available", "Not supplied by server",
    ]);
    // The portal then sends "" for the one it is not changing, which is unchanged.
    expect((await change(c, login, pairs("Fresh-Main-11!", ""))).status).toBe(200);
    expect(await shown(c, login)).toMatchObject({ password: "Fresh-Main-11!", investor_password: null });
  });

  it("keeps a demo account's passwords too, and shows them with the demo accounts", async () => {
    const { c, login, id } = await withAccount(demoBody());
    expect(await kept(id)).toHaveLength(2);
    const res = await list(c);
    expect(res.body.real_accounts).toEqual([]);
    expect(res.body.demo_accounts[0]).toMatchObject({ login, is_demo: true, balance: 1000, password: MASTER, investor_password: INVESTOR });
    // A top-up leaves them as they are.
    expect((await api().post("/api/mt5-accounts/demo/top-up").set(bearer(c)).send({ login: Number(login), amount: 100 })).status).toBe(200);
    expect(await shown(c, login)).toMatchObject({ balance: 1100, password: MASTER, investor_password: INVESTOR });
    // A demo opening MT5 turns down keeps nothing.
    const d = await makeClient();
    fake.failNext("user.create", { kind: "refused", code: "mt5_error" });
    expect((await create(d, demoBody())).status).toBe(422);
    expect(await kept(await accountId(d.id))).toEqual([]);
  });

  it("never sends them in an opening answer or an error, and never to the staff API, audit, events, emails or notifications", async () => {
    const c = await makeClient();
    const opened = await create(c, realBody());
    expect(opened.body.account).toMatchObject({ password: null, investor_password: null });
    expect(JSON.stringify(opened.body)).not.toMatch(/Trade-Me|Look-Only/);
    const login = opened.body.account.login as string;
    const id = await accountId(c.id);

    // Refusals do not repeat what was sent.
    const refusals = [
      await create(c, realBody({ investor_password: MASTER })),
      await change(c, login, { password: "Mis-Match-11!", password_confirmation: "Mis-Match-12!" }),
      await change(c, login, pairs("Both-Same-11!", "Both-Same-11!")),
      await change(c, login, pairs("", MASTER)),
    ];
    for (const r of refusals) {
      expect(r.status).toBe(422);
      expect(JSON.stringify(r.body)).not.toMatch(/Trade-Me|Look-Only|Mis-Match|Both-Same/);
    }
    // A change and a staff reset, so their records are in the tables below.
    expect((await change(c, login, pairs("Changed-Main-1!", ""))).status).toBe(200);
    await stepUp({ ...env, app }, boss);
    const reset = await post(boss, `/api/staff/mt5/accounts/${id}/password`, { type: "investor" });
    expect(reset.status).toBe(200);
    used.add(reset.body.password);
    expect(await shown(c, login)).toMatchObject({ password: "Changed-Main-1!", investor_password: reset.body.password });
    const secrets = ["Changed-Main-1!", reset.body.password as string, MASTER, INVESTOR];

    // The staff API: lists, the account page and its refresh, the client's page and activity, the audit log and its export.
    const staffReads: [string, () => Promise<request.Response>][] = [
      ["accounts", () => boss.agent.get("/api/staff/mt5/accounts?pageSize=100")],
      ["account page", () => boss.agent.get(`/api/staff/mt5/accounts/${id}`)],
      ["refresh", () => post(boss, `/api/staff/mt5/accounts/${id}/refresh`)],
      ["search", () => boss.agent.get(`/api/staff/mt5/accounts?q=${login}`)],
      ["client", () => boss.agent.get(`/api/staff/clients/${c.id}`)],
      ["activity", () => boss.agent.get(`/api/staff/clients/${c.id}/activity`)],
      ["audit", () => boss.agent.get("/api/staff/audit?pageSize=100")],
      ["audit export", () => boss.agent.get("/api/staff/audit/export")],
      ["operations", () => boss.agent.get(`/api/staff/mt5/operations?clientId=${c.id}`)],
    ];
    for (const [what, read] of staffReads) {
      const r = await read();
      expect(r.status, what).toBe(200);
      const text = r.text + JSON.stringify(r.body);
      for (const s of secrets) expect(text, what).not.toContain(s);
      expect(text, what).not.toMatch(/investor_password|"password":/);
    }

    const tables = JSON.stringify([
      await rows(env.db, "SELECT * FROM audit_log"),
      await rows(env.db, "SELECT * FROM webhook_outbox"),
      await rows(env.db, "SELECT to_email, subject, body_text FROM email_outbox"),
      await rows(env.db, "SELECT * FROM client_notifications"),
      await rows(env.db, "SELECT * FROM mt5_accounts"),
      await rows(env.db, "SELECT * FROM mt5_balance_ops"),
    ]);
    for (const s of secrets) expect(tables).not.toContain(s);
    // The audit says which one changed, never what to.
    const audits = await rows<{ action: string; meta_json: Record<string, unknown> }>(
      env.db, "SELECT action, meta_json FROM audit_log WHERE action IN ('mt5.account.password_changed', 'mt5.account.password_reset') AND entity_id = ? ORDER BY id", [String(c.id)],
    );
    expect(audits).toEqual([
      { action: "mt5.account.password_changed", meta_json: { accountId: id, login: Number(login), main: true, investor: false } },
      { action: "mt5.account.password_reset", meta_json: { accountId: id, login: Number(login), type: "investor" } },
    ]);
  });

  // ---------- Openings that fail ----------

  it("forgets them when an opening definitely fails, and keeps them while MT5 may have opened it", async () => {
    const c = await makeClient();
    for (const fault of [
      { kind: "refused", code: "invalid_password" },
      { kind: "refused", code: "mt5_error" },
      { kind: "unavailable" },
      { kind: "bad_request" },
    ] as const) {
      fake.failNext("user.create", fault);
      expect((await create(c, realBody())).status, fault.kind).toBe(422);
      const id = await accountId(c.id);
      expect(await one(env.db, "SELECT status FROM mt5_accounts WHERE id = ?", [id])).toEqual({ status: "failed" });
      expect(await kept(id), fault.kind).toEqual([]);
    }

    // A lost answer: kept, and the resolver finding the account shows them.
    fake.failNext("user.create", { kind: "unknown-after" });
    expect((await create(c, realBody())).status).toBe(409);
    const found = await accountId(c.id);
    expect(await kept(found)).toHaveLength(2);
    expect(await checkAccount(env.db, fake, found, pino({ level: "silent" }))).toBe("completed");
    const login = String((await one<{ login: number }>(env.db, "SELECT login FROM mt5_accounts WHERE id = ?", [found]))!.login);
    expect(await shown(c, login)).toMatchObject({ password: MASTER, investor_password: INVESTOR });
    expect(mt5User(login).passwords).toEqual({ main: MASTER, investor: INVESTOR });

    // A lost answer MT5 never acted on: once the resolver gives up, they go.
    const d = await makeClient();
    fake.failNext("user.create", { kind: "unknown-before" });
    expect((await create(d, realBody())).status).toBe(409);
    const never = await accountId(d.id);
    await exec(env.db, "UPDATE mt5_accounts SET checks = 2, created_at = created_at - INTERVAL 11 MINUTE, next_check_at = NULL WHERE id = ?", [never]);
    expect(await checkAccount(env.db, fake, never, pino({ level: "silent" }))).toBe("failed");
    expect(await kept(never)).toEqual([]);
  });

  // ---------- Changes ----------

  it("replaces one when MT5 confirms it, keeps the old one on a definite no, and keeps none after a lost answer", async () => {
    const { c, login } = await withAccount();
    const lost = { kind: "unknown-after" } as const;

    // Lost, and lost again on the one retry: MT5 has the new master password, the list says not available.
    fake.failNext("user.password", lost, 2);
    expect(await change(c, login, pairs("Lost-Main-11!", ""))).toMatchObject({ status: 409, body: { message: UNCONFIRMED } });
    expect(mt5User(login).passwords.main).toBe("Lost-Main-11!");
    expect(await shown(c, login)).toMatchObject({ password: null, investor_password: INVESTOR });
    // Set again, it shows.
    expect((await change(c, login, pairs("Again-Main-12!", ""))).status).toBe(200);
    expect(await shown(c, login)).toMatchObject({ password: "Again-Main-12!", investor_password: INVESTOR });

    // Lost once, then confirmed on the retry: kept.
    fake.failNext("user.password", { kind: "unknown-before" });
    expect((await change(c, login, pairs("Retry-Main-13!", ""))).status).toBe(200);
    expect(await shown(c, login)).toMatchObject({ password: "Retry-Main-13!" });

    // MT5 says no, or is not reached: the old one stays.
    fake.failNext("user.password", { kind: "refused", code: "mt5_error" });
    expect((await change(c, login, pairs("Nope-Main-14!", ""))).status).toBe(422);
    fake.failNext("user.password", { kind: "unavailable" });
    expect((await change(c, login, pairs("Nope-Main-15!", ""))).status).toBe(422);
    expect(await shown(c, login)).toMatchObject({ password: "Retry-Main-13!", investor_password: INVESTOR });
    expect(mt5User(login).passwords.main).toBe("Retry-Main-13!");

    // The same for the investor one: lost, it is not available and the master one stays; turned down, the one before stays.
    fake.failNext("user.password", lost, 2);
    expect((await change(c, login, pairs("", "Lost-View-16?"))).status).toBe(409);
    expect(mt5User(login).passwords).toEqual({ main: "Retry-Main-13!", investor: "Lost-View-16?" });
    expect(await shown(c, login)).toMatchObject({ password: "Retry-Main-13!", investor_password: null });
    expect((await change(c, login, pairs("", "Mid-View-17?"))).status).toBe(200);
    fake.failNext("user.password", { kind: "refused", code: "invalid_password" });
    expect((await change(c, login, pairs("", "Nope-View-18?"))).body.errors).toEqual({ investor_password: ["MT5 did not accept this password. Choose a different one."] });
    expect(await shown(c, login)).toMatchObject({ password: "Retry-Main-13!", investor_password: "Mid-View-17?" });
    expect(mt5User(login).passwords).toEqual({ main: "Retry-Main-13!", investor: "Mid-View-17?" });
  });

  it("does the same for a staff reset", async () => {
    const { c, login, id } = await withAccount();
    await stepUp({ ...env, app }, boss);
    fake.failNext("user.password", { kind: "refused", code: "mt5_error" });
    expect((await post(boss, `/api/staff/mt5/accounts/${id}/password`, { type: "main" })).status).toBe(422);
    expect(await shown(c, login)).toMatchObject({ password: MASTER, investor_password: INVESTOR });

    fake.failNext("user.password", { kind: "unknown-after" }, 2);
    const lost = await post(boss, `/api/staff/mt5/accounts/${id}/password`, { type: "main" });
    expect(lost.status).toBe(409);
    used.add(mt5User(login).passwords.main);
    expect(JSON.stringify(lost.body)).not.toContain(mt5User(login).passwords.main);
    expect(await shown(c, login)).toMatchObject({ password: null, investor_password: INVESTOR });

    const ok = await post(boss, `/api/staff/mt5/accounts/${id}/password`, { type: "main" });
    expect(ok.status).toBe(200);
    expect(ok.headers["cache-control"]).toBe("no-store");
    used.add(ok.body.password);
    expect(await shown(c, login)).toMatchObject({ password: ok.body.password, investor_password: INVESTOR });
    expect(await kept(id)).toEqual([{ type: "main", set_by: "staff" }, { type: "investor", set_by: "client" }]);
  });

  it("ends two changes to one account at once with the password MT5 has", async () => {
    const { c, login, id } = await withAccount();
    // The first is held in MT5; meanwhile its old value is set aside (not available), never left standing for a password that may be gone.
    const hold = fake.pause("user.password");
    const first = change(c, login, pairs("Race-One-11!", "")).then((r) => r);
    await hold.reached;
    expect(await shown(c, login)).toMatchObject({ password: null, investor_password: INVESTOR });
    const second = change(c, login, pairs("Race-Two-12!", "")).then((r) => r);
    hold.release();
    expect([(await first).status, (await second).status]).toEqual([200, 200]);
    expect(mt5User(login).passwords.main).toBe("Race-Two-12!");
    expect(await shown(c, login)).toMatchObject({ password: "Race-Two-12!" });

    // A client change and a staff reset of the same password at once.
    await stepUp({ ...env, app }, boss);
    const held = fake.pause("user.password");
    const mine = change(c, login, pairs("Race-Three-13!", "")).then((r) => r);
    await held.reached;
    const staffs = post(boss, `/api/staff/mt5/accounts/${id}/password`, { type: "main" }).then((r) => r);
    held.release();
    const [m, s] = [await mine, await staffs];
    expect([m.status, s.status]).toEqual([200, 200]);
    used.add(s.body.password);
    expect(mt5User(login).passwords.main).toBe(s.body.password);
    expect(await shown(c, login)).toMatchObject({ password: s.body.password });

    // Held, then turned down: the one set aside comes back.
    fake.failNext("user.password", { kind: "refused", code: "mt5_error" });
    const refusedHold = fake.pause("user.password");
    const refused = change(c, login, pairs("", "Race-View-14?")).then((r) => r);
    await refusedHold.reached;
    expect(await shown(c, login)).toMatchObject({ investor_password: null });
    refusedHold.release();
    expect((await refused).status).toBe(422);
    expect(await shown(c, login)).toMatchObject({ password: s.body.password, investor_password: INVESTOR });
  });

  it("counts a pair equal to the kept password as unchanged, as the portal sends it", async () => {
    const { c, login } = await withAccount();
    const sentSince = (n: number) => fake.callsTo("user.password").slice(n).map((x) => x.req.type);

    // The portal's body for a new master password: the investor one sent back from the list.
    let n = fake.callsTo("user.password").length;
    expect((await change(c, login, pairs("Portal-Main-11!", INVESTOR))).status).toBe(200);
    expect(sentSince(n)).toEqual(["main"]);
    // And for a new investor password: the master one sent back.
    n = fake.callsTo("user.password").length;
    expect((await change(c, login, pairs("Portal-Main-11!", "Portal-View-12?"))).status).toBe(200);
    expect(sentSince(n)).toEqual(["investor"]);
    expect(mt5User(login).passwords).toEqual({ main: "Portal-Main-11!", investor: "Portal-View-12?" });
    expect(await shown(c, login)).toMatchObject({ password: "Portal-Main-11!", investor_password: "Portal-View-12?" });

    // Both as kept: there is no telling which one was typed, so nothing is sent.
    n = fake.callsTo("user.password").length;
    expect((await change(c, login, pairs("Portal-Main-11!", "Portal-View-12?"))).body.errors).toEqual({ password: [NEW_PASSWORD] });
    expect(sentSince(n)).toEqual([]);

    // The two must still differ, the one left as it is included.
    expect((await change(c, login, pairs("Portal-View-12?", ""))).body.errors).toEqual({ password: [SAME] });
    expect((await change(c, login, pairs("", "Portal-Main-11!"))).body.errors).toEqual({ investor_password: [SAME] });
    expect((await change(c, login, pairs("Portal-View-12?", "Portal-View-12?"))).body.errors).toEqual({ password: [SAME] });
    expect(sentSince(n)).toEqual([]);

    // A kept password older than the policy, sent back as it is, is unchanged and not checked again.
    const id = await accountId(c.id);
    await keepMt5Password(env.db, env.config, { id, client_id: c.id }, "investor", "oldweak1", "client");
    used.add("oldweak1");
    n = fake.callsTo("user.password").length;
    expect((await change(c, login, pairs("Policy-Main-13!", "oldweak1"))).status).toBe(200);
    expect(sentSince(n)).toEqual(["main"]);
    // Sent as a new one, it is.
    await exec(env.db, "DELETE FROM mt5_account_passwords WHERE account_id = ? AND type = 'investor'", [id]);
    expect((await change(c, login, pairs("", "oldweak1"))).body.errors).toEqual({ investor_password: ["The password must be 8 to 16 characters with upper and lower case letters, a number and a symbol."] });
  });

  it("turns away a change from a page whose list is out of date, so it cannot put back a password the client replaced", async () => {
    const { c, login, id } = await withAccount();
    const sentSince = (n: number) => fake.callsTo("user.password").slice(n).map((x) => x.req.type);
    const outOfDate = { status: 422, body: { errors: { password: [OUT_OF_DATE] } } };
    const changes = async () => (await rows(env.db, "SELECT id FROM audit_log WHERE action = 'mt5.account.password_changed' AND entity_id = ?", [String(c.id)])).length;

    // One page visit, as the portal does it: the master changed from the list the page loaded, then the
    // investor from the same list, which still has the old master.
    const page = await shown(c, login);
    let n = fake.callsTo("user.password").length;
    expect((await change(c, login, portalBody(page, "master", "Page-Main-11!"))).status).toBe(200);
    expect(await change(c, login, portalBody(page, "investor", "Page-View-11?"))).toMatchObject(outOfDate);
    expect(sentSince(n)).toEqual(["main"]);
    expect(mt5User(login).passwords).toEqual({ main: "Page-Main-11!", investor: INVESTOR });
    // Reloaded, it goes through. And the other way round.
    const reloaded = await shown(c, login);
    expect((await change(c, login, portalBody(reloaded, "investor", "Page-View-12?"))).status).toBe(200);
    expect(await change(c, login, portalBody(reloaded, "master", "Page-Main-12!"))).toMatchObject(outOfDate);
    expect(mt5User(login).passwords).toEqual({ main: "Page-Main-11!", investor: "Page-View-12?" });

    // A page opened before a staff reset: the master staff set stays.
    const beforeReset = await shown(c, login);
    await stepUp({ ...env, app }, boss);
    const reset = await post(boss, `/api/staff/mt5/accounts/${id}/password`, { type: "main" });
    expect(reset.status).toBe(200);
    used.add(reset.body.password);
    expect(await change(c, login, portalBody(beforeReset, "investor", "Page-View-13?"))).toMatchObject(outOfDate);
    expect(mt5User(login).passwords).toEqual({ main: reset.body.password, investor: "Page-View-12?" });

    // A page opened before a change whose answer was lost: the list no longer has that one, the page still does.
    const beforeLost = await shown(c, login);
    fake.failNext("user.password", { kind: "unknown-after" }, 2);
    expect((await change(c, login, portalBody(beforeLost, "master", "Page-Main-14!"))).status).toBe(409);
    n = fake.callsTo("user.password").length;
    expect(await change(c, login, portalBody(beforeLost, "investor", "Page-View-14?"))).toMatchObject(outOfDate);
    expect(sentSince(n)).toEqual([]);
    expect(mt5User(login).passwords.main).toBe("Page-Main-14!");
    // Reloaded, the master is not available, so the portal sends "" for it and the investor one changes.
    const afterLost = await shown(c, login);
    expect(afterLost).toMatchObject({ password: null, investor_password: "Page-View-12?" });
    expect((await change(c, login, portalBody(afterLost, "investor", "Page-View-15?"))).status).toBe(200);
    expect(mt5User(login).passwords).toEqual({ main: "Page-Main-14!", investor: "Page-View-15?" });

    // Both new in one request, which neither front end sends: nothing goes to MT5 and nothing is recorded.
    const recorded = await changes();
    n = fake.callsTo("user.password").length;
    expect(await change(c, login, pairs("Both-Main-16!", "Both-View-16?"))).toMatchObject(outOfDate);
    expect(sentSince(n)).toEqual([]);
    expect(await changes()).toBe(recorded);
    expect(await shown(c, login)).toMatchObject({ password: null, investor_password: "Page-View-15?" });
  });

  it("sends a password equal to the kept one when it is the only one sent, so MT5 can match what the panel shows", async () => {
    const { c, login } = await withAccount();
    const sentSince = (n: number) => fake.callsTo("user.password").slice(n).map((x) => x.req.type);
    // Changed in MT5 itself (the MT5 terminal, or a dealer in MT5 Manager): the panel still shows the kept one.
    mt5User(login).passwords.main = "Elsewhere-Main-1!";
    used.add("Elsewhere-Main-1!");
    // The app's body, and the portal's when it has no other one to send back.
    const n = fake.callsTo("user.password").length;
    expect((await change(c, login, pairs(MASTER, ""))).status).toBe(200);
    expect(sentSince(n)).toEqual(["main"]);
    expect(mt5User(login).passwords).toEqual({ main: MASTER, investor: INVESTOR });
    expect(await shown(c, login)).toMatchObject({ password: MASTER, investor_password: INVESTOR });
    // Still checked against the other one.
    expect((await change(c, login, pairs("", MASTER))).body.errors).toEqual({ investor_password: [SAME] });
    expect(sentSince(n)).toEqual(["main"]);
  });

  // ---------- What the whole run must never do ----------

  it("left no password in any log line or table", async () => {
    expect(logLines.length).toBeGreaterThan(0);
    const logs = logLines.join("");
    const tables = JSON.stringify([
      await rows(env.db, "SELECT * FROM audit_log"),
      await rows(env.db, "SELECT * FROM mt5_accounts"),
      await rows(env.db, "SELECT * FROM mt5_balance_ops"),
      await rows(env.db, "SELECT * FROM client_notifications"),
      await rows(env.db, "SELECT * FROM webhook_outbox"),
      await rows(env.db, "SELECT to_email, subject, body_text FROM email_outbox"),
      (await rows<{ sealed: Buffer }>(env.db, "SELECT sealed FROM mt5_account_passwords")).map((r) => r.sealed.toString("latin1")),
    ]);
    for (const p of used) {
      expect(logs).not.toContain(p);
      expect(tables).not.toContain(p);
    }
    expect(JSON.stringify(fake.calls)).not.toMatch(/Trade-Me|Look-Only/);
  });
});
