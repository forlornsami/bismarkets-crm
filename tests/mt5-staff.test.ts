import pino from "pino";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import { createClientSession } from "../src/server/clients/session";
import { exec, one, rows, transaction } from "../src/server/lib/db";
import { mt5PasswordOk } from "../src/server/mt5/passwords";
import { FakeGateway } from "./fakes/gateway";
import { createStaff, hasDb, patch, post, setup, signIn, stepUp, type SignedIn, type TestEnv } from "./helpers";

const MASTER = "Trade-Me-42!";
const INVESTOR = "Look-Only-7?";
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

interface Client {
  id: number;
  token: string;
}

describe.skipIf(!hasDb)("staff MT5 API", () => {
  let env: TestEnv;
  const fake = new FakeGateway();
  let boss: SignedIn; // super_admin: everything, including MT5 servers
  let dealer: SignedIn; // dealing: accounts and packages, not servers
  let support: SignedIn; // support_agent: view only
  let sales: SignedIn; // sales_agent: view, only clients assigned to them
  let finance: SignedIn; // finance_agent: mt5.view, no packages
  let classic = 0;
  let seq = 0;
  /** Accounts made in beforeAll: a real one for an unassigned client, a demo one for the sales agent's client. */
  const acct = { real: 0, realLogin: 0, demo: 0, demoLogin: 0, realClient: 0, demoClient: 0 };
  let realClient: Client;

  async function makeClient(assignedTo: number | null = null): Promise<Client> {
    seq++;
    const r = await exec(
      env.db,
      "INSERT INTO clients (email, first_name, last_name, referral_code, source, kyc_status, status, assigned_staff_id) VALUES (?, 'Sam', ?, ?, 'portal', 'approved', 'active', ?)",
      [`staff.mt5.${seq}@client.test`, `Client${seq}`, `SM${String(seq).padStart(8, "0")}`, assignedTo],
    );
    const { token } = await transaction(env.db, (conn) => createClientSession(conn, env.config, r.insertId, "127.0.0.1", "vitest"));
    return { id: r.insertId, token };
  }
  const bearer = (c: Client) => ({ Authorization: `Bearer ${c.token}` });
  const clientCreate = (c: Client, body: Record<string, unknown>) => request(env.app).post("/api/mt5-accounts").set(bearer(c)).send(body);
  const clientList = (c: Client) => request(env.app).get("/api/mt5-accounts").set(bearer(c));
  const get = (s: SignedIn, url: string) => s.agent.get(url);
  /** A newly signed-in staff member, with no 2FA confirmation yet. */
  const fresh = async (role: string) => {
    const email = `${role}.${++seq}@crm.test`;
    await createStaff(env.db, email, role);
    return signIn(env, email);
  };
  const audits = (action: string) => rows<Record<string, any>>(env.db, "SELECT * FROM audit_log WHERE action = ? ORDER BY id", [action]);

  beforeAll(async () => {
    env = await setup({}, { mt5: fake });
    await exec(env.db, "INSERT INTO mt5_servers (code, label, is_enabled) VALUES ('live', 'Live', 1), ('demo', 'Demo', 1)");
    await exec(env.db, "UPDATE mt5_settings SET demo_server_code = 'demo', demo_group = 'demo\\\\usd', leverages = '2000,500' WHERE id = 1");
    classic = (
      await exec(env.db, "INSERT INTO account_packages (name, spread_label, min_deposit_cents, server_code, mt5_group) VALUES ('Classic', '1.2', 0, 'live', 'real\\\\standard')")
    ).insertId;
    await createStaff(env.db, "boss@crm.test", "super_admin");
    await createStaff(env.db, "dealer@crm.test", "dealing");
    await createStaff(env.db, "support@crm.test", "support_agent");
    await createStaff(env.db, "sales@crm.test", "sales_agent");
    await createStaff(env.db, "finance@crm.test", "finance_agent");
    boss = await signIn(env, "boss@crm.test");
    dealer = await signIn(env, "dealer@crm.test");
    support = await signIn(env, "support@crm.test");
    sales = await signIn(env, "sales@crm.test");
    finance = await signIn(env, "finance@crm.test");

    realClient = await makeClient();
    const real = await clientCreate(realClient, { is_demo: false, account_package_id: classic, leverage: "2000", password: MASTER, investor_password: INVESTOR });
    expect(real.status).toBe(200);
    const demoClient = await makeClient(sales.staffId);
    const demo = await clientCreate(demoClient, { is_demo: true, demo_amount: 5000, leverage: "500", password: MASTER, investor_password: INVESTOR });
    expect(demo.status).toBe(200);
    acct.realLogin = Number(real.body.account.login);
    acct.demoLogin = Number(demo.body.account.login);
    acct.real = Number((await one<{ id: number }>(env.db, "SELECT id FROM mt5_accounts WHERE login = ? AND server_code = 'live'", [acct.realLogin]))!.id);
    acct.demo = Number((await one<{ id: number }>(env.db, "SELECT id FROM mt5_accounts WHERE login = ? AND server_code = 'demo'", [acct.demoLogin]))!.id);
    acct.realClient = realClient.id;
    acct.demoClient = demoClient.id;
  }, 120_000);
  afterAll(async () => env?.db.end());
  beforeEach(() => {
    fake.clearFaults();
    fake.down = false;
  });

  // ---------- Servers ----------

  it("lists servers for anyone with mt5.view, with what uses them", async () => {
    const res = await get(support, "/api/staff/mt5/servers");
    expect(res.status).toBe(200);
    expect(res.body.gatewayConfigured).toBe(true);
    expect(res.body.items).toEqual([
      { code: "demo", label: "Demo", isEnabled: true, isDemoServer: true, usage: { packages: 0, accounts: 1 }, createdAt: expect.stringMatching(ISO), updatedAt: expect.stringMatching(ISO), updatedBy: null },
      { code: "live", label: "Live", isEnabled: true, isDemoServer: false, usage: { packages: 1, accounts: 1 }, createdAt: expect.stringMatching(ISO), updatedAt: expect.stringMatching(ISO), updatedBy: null },
    ]);
    expect((await request(env.app).get("/api/staff/mt5/servers")).status).toBe(401);
  });

  it("adds and changes servers with mt5.servers and a fresh 2FA code only, audited", async () => {
    expect((await post(dealer, "/api/staff/mt5/servers", { code: "live2", label: "Live 2" })).body.error.code).toBe("FORBIDDEN");
    const noStep = await post(boss, "/api/staff/mt5/servers", { code: "live2", label: "Live 2" });
    expect(noStep.status).toBe(403);
    expect(noStep.body.error.code).toBe("STEP_UP_REQUIRED");

    await stepUp(env, boss);
    const created = await post(boss, "/api/staff/mt5/servers", { code: "live2", label: "Live 2", isEnabled: false });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ code: "live2", label: "Live 2", isEnabled: false, isDemoServer: false, usage: { packages: 0, accounts: 0 }, updatedBy: { id: boss.staffId, name: "boss" } });
    expect((await post(boss, "/api/staff/mt5/servers", { code: "live2", label: "Again" })).status).toBe(409);
    for (const bad of [{ code: "Live 2", label: "Live" }, { code: "x".repeat(17), label: "Live" }, { code: "ok", label: "<b>" }, { code: "ok", label: "L" }, { code: "ok", label: "Live", host: "1.2.3.4" }]) {
      const res = await post(boss, "/api/staff/mt5/servers", bad);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("BAD_REQUEST");
    }

    const on = await patch(boss, "/api/staff/mt5/servers/live2", { isEnabled: true, label: "Live two" });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ code: "live2", label: "Live two", isEnabled: true });
    expect((await patch(boss, "/api/staff/mt5/servers/nope", { isEnabled: true })).status).toBe(404);
    expect((await patch(dealer, "/api/staff/mt5/servers/live2", { isEnabled: false })).status).toBe(403);

    expect((await audits("mt5.server.created")).at(-1)).toMatchObject({ actor_type: "staff", actor_id: boss.staffId, entity_type: "mt5_server", entity_id: "live2", after_json: { label: "Live 2", isEnabled: false } });
    expect((await audits("mt5.server.updated")).at(-1)).toMatchObject({ entity_id: "live2", before_json: { isEnabled: false, label: "Live 2" }, after_json: { isEnabled: true, label: "Live two" } });
    // Nothing changed: no audit row.
    const n = (await audits("mt5.server.updated")).length;
    expect((await patch(boss, "/api/staff/mt5/servers/live2", { label: "Live two" })).status).toBe(200);
    expect(await audits("mt5.server.updated")).toHaveLength(n);
  });

  it("pings a server through the gateway, even one switched off, and shows why it failed", async () => {
    const ok = await post(boss, "/api/staff/mt5/servers/live/ping");
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true, latencyMs: expect.any(Number), serverTime: expect.any(Number) });
    // live2 is known to the CRM but not to the gateway.
    await exec(env.db, "UPDATE mt5_servers SET is_enabled = 0 WHERE code = 'live2'");
    const unknown = await post(boss, "/api/staff/mt5/servers/live2/ping");
    expect(unknown.body).toMatchObject({ ok: false, error: { kind: "bad_request" } });
    fake.down = true;
    expect((await post(boss, "/api/staff/mt5/servers/live/ping")).body).toMatchObject({ ok: false, error: { kind: "unavailable", code: "connection" } });
    fake.down = false;
    expect((await post(boss, "/api/staff/mt5/servers/nope/ping")).status).toBe(404);
    expect((await post(dealer, "/api/staff/mt5/servers/live/ping")).status).toBe(403);
  });

  // ---------- Settings ----------

  it("shows and changes the MT5 rules, checked and audited", async () => {
    const shown = await get(support, "/api/staff/mt5/settings");
    expect(shown.status).toBe(200);
    expect(shown.body).toEqual({
      demoServerCode: "demo", demoGroup: "demo\\usd", leverages: [2000, 500], maxLiveAccounts: expect.any(Number), maxDemoAccounts: expect.any(Number),
      demoMaxOpeningCents: 10_000_000, demoMaxTopupCents: 1_000_000, demoMaxBalanceCents: 100_000_000, maxTransferCents: expect.any(Number), adjustSecondApprovalCents: 0,
      gatewayConfigured: true, updatedAt: expect.stringMatching(ISO), updatedBy: null,
    });
    expect((await patch(dealer, "/api/staff/mt5/settings", { leverages: [100] })).status).toBe(403);
    expect((await patch(await fresh("super_admin"), "/api/staff/mt5/settings", { leverages: [100] })).body.error.code).toBe("STEP_UP_REQUIRED");
    await stepUp(env, boss);

    const bad = async (body: unknown) => {
      const res = await patch(boss, "/api/staff/mt5/settings", body);
      expect(res.status).toBe(400);
      return res.body.error.details as { field: string; message: string }[];
    };
    expect(await bad({ demoServerCode: "nope" })).toEqual([{ field: "demoServerCode", message: "Choose a server the CRM knows." }]);
    expect(await bad({ demoGroup: "" })).toEqual([{ field: "demoGroup", message: "Set both the demo server and the demo group, or neither." }]);
    expect(await bad({ demoMaxBalanceCents: 1000 })).toEqual([{ field: "demoMaxBalanceCents", message: "The most a demo account may hold must be at least its largest starting balance." }]);
    expect((await bad({ leverages: [] }))[0]!.field).toBe("leverages");
    expect((await bad({ leverages: [2000.5] }))[0]!.field).toBe("leverages.0");
    expect((await bad({ maxLiveAccounts: 0 }))[0]!.field).toBe("maxLiveAccounts");
    expect((await bad({ gatewaySecret: "x" }))[0]!.message).toMatch(/Unrecognized key/);

    const changed = await patch(boss, "/api/staff/mt5/settings", { leverages: [500, 1000, 500, 2000], maxLiveAccounts: 3 });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ leverages: [500, 1000, 2000], maxLiveAccounts: 3, updatedBy: { id: boss.staffId, name: "boss" } });
    expect((await audits("mt5.settings_updated")).at(-1)).toMatchObject({
      entity_type: "mt5_settings", entity_id: "1", before_json: { leverages: [2000, 500], maxLiveAccounts: expect.any(Number) }, after_json: { leverages: [500, 1000, 2000], maxLiveAccounts: 3 },
    });
    // Clients see the new list at once.
    expect((await request(env.app).get("/api/leverages").set(bearer(realClient))).body.data).toEqual(["500", "1000", "2000"]);

    // Both demo fields cleared together turn demo accounts off.
    expect((await patch(boss, "/api/staff/mt5/settings", { demoServerCode: "", demoGroup: null })).body).toMatchObject({ demoServerCode: null, demoGroup: null });
    const off = await clientCreate(realClient, { is_demo: true, demo_amount: 100, leverage: "500", password: MASTER, investor_password: INVESTOR });
    expect(off.status).toBe(422);
    expect((await patch(boss, "/api/staff/mt5/settings", { demoServerCode: "demo", demoGroup: "demo\\usd", leverages: [2000, 500], maxLiveAccounts: 10 })).status).toBe(200);
  });

  // ---------- Packages ----------

  it("manages packages with package.manage and step-up, and clients see the change", async () => {
    expect((await get(support, "/api/staff/packages")).status).toBe(403);
    const list = await get(dealer, "/api/staff/packages");
    expect(list.status).toBe(200);
    expect(list.body.items).toEqual([
      expect.objectContaining({ id: classic, name: "Classic", serverCode: "live", serverLabel: "Live", mt5Group: "real\\standard", accounts: 1, isVisible: true, highlights: [], commissionLabel: null }),
    ]);

    const body = {
      name: "Raw", description: "Raw spreads", highlights: ["From 0.0 pips", "Commission $7"], spreadLabel: "0.0", commissionLabel: "", minDepositCents: 100_000,
      serverCode: "live", mt5Group: "real\\raw", isRecommended: true, sortOrder: 5,
    };
    expect((await post(await fresh("dealing"), "/api/staff/packages", body)).body.error.code).toBe("STEP_UP_REQUIRED");
    await stepUp(env, dealer);
    const created = await post(dealer, "/api/staff/packages", body);
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      id: expect.any(Number), name: "Raw", description: "Raw spreads", highlights: ["From 0.0 pips", "Commission $7"], spreadLabel: "0.0", commissionLabel: null, minDepositCents: 100_000,
      serverCode: "live", mt5Group: "real\\raw", isRecommended: true, isVisible: true, sortOrder: 5, serverLabel: "Live", accounts: 0,
      createdAt: expect.stringMatching(ISO), updatedAt: expect.stringMatching(ISO), updatedBy: { id: dealer.staffId, name: "dealer" },
    });
    const id = created.body.id as number;
    expect((await audits("package.created")).at(-1)).toMatchObject({ entity_type: "account_package", entity_id: String(id), after_json: expect.objectContaining({ name: "Raw", mt5Group: "real\\raw" }) });
    const seen = await request(env.app).get("/api/account-packages").set(bearer(realClient));
    expect(seen.body.data.find((p: { id: number }) => p.id === id)).toEqual(expect.objectContaining({ name: "Raw", min_deposit: 1000, recommended: true, commission: null }));

    const bad = async (b: unknown, field: string) => {
      const res = await post(dealer, "/api/staff/packages", b);
      expect(res.status).toBe(400);
      expect(res.body.error.details.map((d: { field: string }) => d.field)).toContain(field);
    };
    await bad({ ...body, name: undefined }, "name");
    await bad({ ...body, mt5Group: "real/<raw>" }, "mt5Group");
    await bad({ ...body, serverCode: "nope" }, "serverCode");
    await bad({ ...body, minDepositCents: 10.5 }, "minDepositCents");
    await bad({ ...body, highlights: ["ok", ""] }, "highlights.1");
    await bad({ ...body, description: "See https://evil.example" }, "description");
    await bad({ ...body, isDemo: true }, "");

    const hidden = await patch(dealer, `/api/staff/packages/${id}`, { isVisible: false, mt5Group: "real\\raw2" });
    expect(hidden.status).toBe(200);
    expect(hidden.body).toMatchObject({ isVisible: false, mt5Group: "real\\raw2" });
    expect((await audits("package.updated")).at(-1)).toMatchObject({
      entity_id: String(id), before_json: { isVisible: true, mt5Group: "real\\raw" }, after_json: { isVisible: false, mt5Group: "real\\raw2" }, meta_json: { openAccounts: 0 },
    });
    expect((await request(env.app).get("/api/account-packages").set(bearer(realClient))).body.data.map((p: { id: number }) => p.id)).not.toContain(id);
    const n = (await audits("package.updated")).length;
    expect((await patch(dealer, `/api/staff/packages/${id}`, { isVisible: false })).status).toBe(200);
    expect(await audits("package.updated")).toHaveLength(n);
    expect((await patch(dealer, "/api/staff/packages/999999", { isVisible: true })).status).toBe(404);
    expect((await patch(finance, `/api/staff/packages/${id}`, { isVisible: true })).status).toBe(403);
  });

  // ---------- Accounts ----------

  it("lists accounts with filters, and a sales agent sees only their own clients'", async () => {
    const all = await get(support, "/api/staff/mt5/accounts?pageSize=100");
    expect(all.status).toBe(200);
    const ids = all.body.items.map((a: { id: number }) => a.id);
    expect(ids).toEqual(expect.arrayContaining([acct.real, acct.demo]));
    expect(all.body).toMatchObject({ page: 1, pageSize: 100, total: ids.length });
    const real = all.body.items.find((a: { id: number }) => a.id === acct.real);
    expect(real).toEqual({
      id: acct.real, clientId: acct.realClient, clientName: expect.stringContaining("Sam"), clientEmail: expect.stringContaining("@client.test"), clientStatus: "active",
      login: acct.realLogin, serverCode: "live", serverLabel: "Live", isDemo: false, type: "real", packageId: classic, packageName: "Classic", group: "real\\standard",
      currency: "USD", leverage: 2000, status: "active", state: "active", createRef: expect.stringMatching(/^BIS-A/), failure: null, checks: 0, nextCheckAt: null,
      archivedAt: null, suspendedAt: null, suspendedBy: null, suspendedReason: null, balanceCents: 0, creditCents: 0, equityCents: 0, marginCents: 0, marginFreeCents: 0,
      snapshotAt: expect.stringMatching(ISO), registeredAt: null, createdAt: expect.stringMatching(ISO), updatedAt: expect.stringMatching(ISO),
    });
    expect(JSON.stringify(all.body)).not.toMatch(/password/i);

    const demos = await get(support, "/api/staff/mt5/accounts?type=demo&pageSize=100");
    expect(demos.body.items.every((a: { isDemo: boolean }) => a.isDemo)).toBe(true);
    expect((await get(support, `/api/staff/mt5/accounts?q=${acct.realLogin}`)).body.items.map((a: { id: number }) => a.id)).toEqual([acct.real]);
    expect((await get(support, `/api/staff/mt5/accounts?clientId=${acct.demoClient}`)).body.items.map((a: { id: number }) => a.id)).toEqual([acct.demo]);
    expect((await get(support, "/api/staff/mt5/accounts?status=archived")).body.items.map((a: { id: number }) => a.id)).not.toContain(acct.real);
    expect((await get(support, "/api/staff/mt5/accounts?status=gone")).status).toBe(400);
    expect((await get(support, "/api/staff/mt5/accounts?sort=password")).status).toBe(400);

    // Scoped: only the client assigned to the sales agent.
    const mine = await get(sales, "/api/staff/mt5/accounts?pageSize=100");
    expect(mine.body.items.map((a: { id: number }) => a.id)).toEqual([acct.demo]);
    expect((await get(sales, `/api/staff/mt5/accounts?q=${acct.realLogin}`)).body.items).toEqual([]);
    expect((await get(sales, `/api/staff/mt5/accounts/${acct.real}`)).status).toBe(404);
    expect((await post(sales, `/api/staff/mt5/accounts/${acct.real}/refresh`)).status).toBe(404);
    expect((await get(sales, `/api/staff/mt5/accounts/${acct.demo}`)).status).toBe(200);
    expect((await get(support, "/api/staff/mt5/accounts/999999")).status).toBe(404);
    expect((await get(support, "/api/staff/mt5/accounts/abc")).status).toBe(400);
  });

  it("shows an account with live MT5 figures, saves them, and falls back to the snapshot when MT5 is down", async () => {
    fake.setAccount("live", acct.realLogin, { balanceCents: 250_000, creditCents: 5_000, marginCents: 10_000, profitCents: 1_500 });
    const page = await get(support, `/api/staff/mt5/accounts/${acct.real}`);
    expect(page.status).toBe(200);
    expect(page.body.live).toMatchObject({ error: null, user: { login: acct.realLogin, group: "real\\standard" }, figures: { login: acct.realLogin, balanceCents: 250_000 } });
    expect(page.body.account).toMatchObject({ balanceCents: 250_000, creditCents: 5_000, equityCents: 256_500, marginCents: 10_000 });
    expect(page.body.operations).toEqual([]);
    // MT5's registration time is kept once seen.
    expect(page.body.account.registeredAt).toBe(fake.user("live", acct.realLogin)!.registeredAt);
    expect(JSON.stringify(page.body)).not.toMatch(/Trade-Me|Look-Only/);

    fake.down = true;
    const cached = await get(support, `/api/staff/mt5/accounts/${acct.real}`);
    expect(cached.status).toBe(200);
    expect(cached.body.live).toMatchObject({ user: null, figures: null, error: expect.stringContaining("unavailable") });
    expect(cached.body.account.balanceCents).toBe(250_000);
    const refresh = await post(support, `/api/staff/mt5/accounts/${acct.real}/refresh`);
    expect(refresh.status).toBe(422);
    expect(refresh.body.error).toMatchObject({ code: "MT5_UNAVAILABLE", details: { kind: "unavailable" } });
    fake.down = false;
    expect((await post(support, `/api/staff/mt5/accounts/${acct.real}/refresh`)).status).toBe(200);

    // A demo account lists its balance operations.
    const demo = await get(sales, `/api/staff/mt5/accounts/${acct.demo}`);
    expect(demo.body.operations).toEqual([
      {
        id: expect.any(Number), reference: expect.stringMatching(/^BIS-D/), purpose: "demo_funding", amountCents: 500_000, status: "completed", ticket: expect.any(Number),
        failure: null, clientMessage: null, checks: 0, nextCheckAt: null, createdAt: expect.stringMatching(ISO), completedAt: expect.stringMatching(ISO),
      },
    ]);
  });

  it("changes leverage with mt5.edit and step-up, audited as the staff member", async () => {
    expect((await post(support, `/api/staff/mt5/accounts/${acct.real}/leverage`, { leverage: 500 })).status).toBe(403);
    expect((await post(await fresh("dealing"), `/api/staff/mt5/accounts/${acct.real}/leverage`, { leverage: 500 })).body.error.code).toBe("STEP_UP_REQUIRED");
    await stepUp(env, dealer);

    const res = await post(dealer, `/api/staff/mt5/accounts/${acct.real}/leverage`, { leverage: 1000 });
    expect(res.status).toBe(200);
    expect(res.body.account).toMatchObject({ id: acct.real, leverage: 1000 });
    expect(fake.user("live", acct.realLogin)!.leverage).toBe(1000);
    expect((await audits("mt5.account.leverage_changed")).at(-1)).toMatchObject({
      actor_type: "staff", actor_id: dealer.staffId, entity_type: "client", entity_id: String(acct.realClient), before_json: { leverage: 2000 }, after_json: { leverage: 1000 },
      meta_json: { accountId: acct.real, login: acct.realLogin },
    });
    // The client sees it on the next read.
    expect((await request(env.app).get("/api/mt5-accounts").set(bearer(realClient))).body.real_accounts[0].leverage).toBe("1000");

    const refused = await post(dealer, `/api/staff/mt5/accounts/${acct.real}/leverage`, { leverage: 300 });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({ code: "MT5_REFUSED", details: { kind: "refused", code: "policy" } });
    fake.failNext("user.update", { kind: "unknown-before" }, 2);
    const lost = await post(dealer, `/api/staff/mt5/accounts/${acct.real}/leverage`, { leverage: 2000 });
    expect(lost.status).toBe(409);
    expect(lost.body.error).toMatchObject({ code: "MT5_UNCONFIRMED", message: "MT5 did not confirm the change. Refresh to see the account's current state." });
    expect((await post(dealer, `/api/staff/mt5/accounts/${acct.real}/leverage`, { leverage: "2000" })).status).toBe(400);
    expect((await post(dealer, `/api/staff/mt5/accounts/${acct.real}/leverage`, { leverage: 2000 })).status).toBe(200);
  });

  it("answers 409, never a refusal, when the retry after a lost answer fails, and asks MT5 for the leverage the row already shows", async () => {
    const c = await makeClient();
    const made = await clientCreate(c, { is_demo: false, account_package_id: classic, leverage: "2000", password: MASTER, investor_password: INVESTOR });
    const login = Number(made.body.account.login);
    const id = Number((await one<{ id: number }>(env.db, "SELECT id FROM mt5_accounts WHERE login = ? AND server_code = 'live'", [login]))!.id);
    const user = () => fake.user("live", login)!;
    /** MT5 makes the change but its answer is lost; the retry straight after then fails as `then` says. */
    const lostThen = (op: "user.update" | "user.password", then: Parameters<FakeGateway["failNext"]>[1]) => {
      fake.failNext(op, { kind: "unknown-after" });
      fake.failNext(op, then);
    };
    const unconfirmed = (res: request.Response) => {
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({ code: "MT5_UNCONFIRMED", details: { kind: "unknown" } });
    };
    await stepUp(env, dealer);

    lostThen("user.update", { kind: "unavailable" });
    unconfirmed(await post(dealer, `/api/staff/mt5/accounts/${id}/leverage`, { leverage: 500 }));
    expect(user().leverage).toBe(500);
    // The row still shows 1:2000, and asking for it puts MT5 back; nothing changed in the CRM, so nothing is recorded.
    const recorded = (await audits("mt5.account.leverage_changed")).length;
    const back = await post(dealer, `/api/staff/mt5/accounts/${id}/leverage`, { leverage: 2000 });
    expect(back.status).toBe(200);
    expect(back.body.account).toMatchObject({ id, leverage: 2000 });
    expect(user().leverage).toBe(2000);
    expect(await audits("mt5.account.leverage_changed")).toHaveLength(recorded);

    lostThen("user.update", { kind: "refused", code: "mt5_error" });
    unconfirmed(await post(dealer, `/api/staff/mt5/accounts/${id}/suspend`, { reason: "Chargeback under review" }));
    expect(user().enabled).toBe(false);
    expect((await one<{ suspended_at: Date | null }>(env.db, "SELECT suspended_at FROM mt5_accounts WHERE id = ?", [id]))!.suspended_at).toBeNull();

    lostThen("user.password", { kind: "refused", code: "invalid_password" });
    unconfirmed(await post(dealer, `/api/staff/mt5/accounts/${id}/password`, { type: "main" }));
    expect(user().passwords.main).not.toBe(MASTER);
    // MT5 may have either password now: the client's list says not available rather than show the old one.
    expect((await clientList(c)).body.real_accounts[0]).toMatchObject({ login: String(login), password: null, investor_password: INVESTOR });
  });

  it("suspends and reactivates an account with a reason; the client sees 'suspended' and cannot undo it", async () => {
    await stepUp(env, dealer);
    expect((await post(dealer, `/api/staff/mt5/accounts/${acct.real}/suspend`, { reason: "abc" })).status).toBe(400);
    const res = await post(dealer, `/api/staff/mt5/accounts/${acct.real}/suspend`, { reason: "Chargeback under review" });
    expect(res.status).toBe(200);
    expect(res.body.account).toMatchObject({ state: "suspended", suspendedAt: expect.stringMatching(ISO), suspendedBy: { id: dealer.staffId, name: "dealer" }, suspendedReason: "Chargeback under review" });
    expect(fake.user("live", acct.realLogin)!.enabled).toBe(false);
    expect((await post(dealer, `/api/staff/mt5/accounts/${acct.real}/suspend`, { reason: "Chargeback again" })).status).toBe(409);

    const client = await request(env.app).get("/api/mt5-accounts").set(bearer(realClient));
    expect(client.body.real_accounts[0]).toMatchObject({ status: "suspended", archived: false });
    expect((await request(env.app).patch(`/api/mt5-accounts/${acct.realLogin}/active`).set(bearer(realClient))).status).toBe(422);
    expect((await get(support, "/api/staff/mt5/accounts?status=suspended")).body.items.map((a: { id: number }) => a.id)).toEqual([acct.real]);

    const back = await post(dealer, `/api/staff/mt5/accounts/${acct.real}/reactivate`, { reason: "Chargeback withdrawn" });
    expect(back.status).toBe(200);
    expect(back.body.account).toMatchObject({ state: "active", suspendedAt: null, suspendedBy: null, suspendedReason: null });
    expect(fake.user("live", acct.realLogin)!.enabled).toBe(true);
    expect((await post(dealer, `/api/staff/mt5/accounts/${acct.real}/reactivate`, { reason: "Chargeback withdrawn" })).status).toBe(409);
    expect((await audits("mt5.account.suspended")).at(-1)).toMatchObject({ actor_id: dealer.staffId, entity_id: String(acct.realClient), meta_json: { reason: "Chargeback under review", login: acct.realLogin } });
    expect((await audits("mt5.account.reactivated")).at(-1)).toMatchObject({ meta_json: { reason: "Chargeback withdrawn", suspendedReason: "Chargeback under review" } });
    // Staff changes leave the client's own archive switch alone.
    expect(fake.user("live", acct.realLogin)!.tradeDisabled).toBe(false);
  });

  it("refuses changes on accounts that are not open in MT5", async () => {
    const c = await makeClient();
    fake.failNext("user.create", { kind: "unknown-before" });
    expect((await clientCreate(c, { is_demo: false, account_package_id: classic, leverage: "2000", password: MASTER, investor_password: INVESTOR })).status).toBe(409);
    const id = Number((await one<{ id: number }>(env.db, "SELECT id FROM mt5_accounts WHERE client_id = ?", [c.id]))!.id);
    await stepUp(env, dealer);
    const res = await post(dealer, `/api/staff/mt5/accounts/${id}/suspend`, { reason: "Checking this" });
    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({ code: "CONFLICT", message: "This account is not open in MT5." });
    const page = await get(support, `/api/staff/mt5/accounts/${id}`);
    expect(page.body).toMatchObject({ account: { status: "unknown", state: "unknown", login: null }, live: null });
    expect((await get(support, "/api/staff/mt5/accounts?status=unknown")).body.items.map((a: { id: number }) => a.id)).toContain(id);
  });

  it("resets a password, shows it to staff once and keeps it only for the client", async () => {
    expect((await post(support, `/api/staff/mt5/accounts/${acct.real}/password`, { type: "main" })).status).toBe(403);
    await stepUp(env, dealer);
    expect((await post(dealer, `/api/staff/mt5/accounts/${acct.real}/password`, { type: "both" })).status).toBe(400);
    const res = await post(dealer, `/api/staff/mt5/accounts/${acct.real}/password`, { type: "investor" });
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const { password } = res.body as { password: string };
    expect(res.body).toEqual({ login: String(acct.realLogin), type: "investor", password });
    expect(mt5PasswordOk(password)).toBe(true);
    expect(fake.user("live", acct.realLogin)!.passwords.investor).toBe(password);

    const audit = (await audits("mt5.account.password_reset")).at(-1)!;
    expect(audit).toMatchObject({ actor_id: dealer.staffId, entity_id: String(acct.realClient), meta_json: { accountId: acct.real, login: acct.realLogin, type: "investor" } });
    const note = await one<{ type: string; body: string }>(env.db, "SELECT type, body FROM client_notifications WHERE client_id = ? ORDER BY id DESC LIMIT 1", [acct.realClient]);
    expect(note).toMatchObject({ type: "security", body: expect.stringContaining(String(acct.realLogin)) });
    const everywhere = JSON.stringify(await rows(env.db, "SELECT * FROM audit_log")) + JSON.stringify(await rows(env.db, "SELECT * FROM client_notifications")) + JSON.stringify(fake.calls);
    expect(everywhere).not.toContain(password);

    // Kept sealed for the client, who sees it in their own list from now on; the staff pages never show it.
    const kept = await one<{ set_by: string; sealed: Buffer }>(env.db, "SELECT set_by, sealed FROM mt5_account_passwords WHERE account_id = ? AND type = 'investor'", [acct.real]);
    expect(kept!.set_by).toBe("staff");
    expect(kept!.sealed.toString("latin1")).not.toContain(password);
    const mine = await request(env.app).get("/api/mt5-accounts").set(bearer(realClient));
    expect(mine.body.real_accounts[0]).toMatchObject({ login: String(acct.realLogin), password: MASTER, investor_password: password });
    const staffViews = [await get(dealer, `/api/staff/mt5/accounts/${acct.real}`), await get(dealer, "/api/staff/mt5/accounts?pageSize=100")];
    for (const view of staffViews) {
      expect(view.status).toBe(200);
      expect(JSON.stringify(view.body)).not.toContain(password);
      expect(JSON.stringify(view.body)).not.toContain(MASTER);
    }

    fake.failNext("user.password", { kind: "refused", code: "invalid_password", message: "3006 Invalid account password" });
    const refused = await post(dealer, `/api/staff/mt5/accounts/${acct.real}/password`, { type: "main" });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({ code: "MT5_REFUSED", message: expect.stringContaining("3006"), details: { kind: "refused", code: "invalid_password" } });
    expect(JSON.stringify(refused.body)).not.toMatch(/"password"/);
    // MT5 said no, so the client's master password is still the one kept.
    expect((await request(env.app).get("/api/mt5-accounts").set(bearer(realClient))).body.real_accounts[0]).toMatchObject({ password: MASTER, investor_password: password });
  });

  it("answers 422 when MT5 is off or the account's server is switched off", async () => {
    await stepUp(env, boss);
    expect((await patch(boss, "/api/staff/mt5/servers/live", { isEnabled: false })).status).toBe(200);
    try {
      await stepUp(env, dealer);
      const off = await post(dealer, `/api/staff/mt5/accounts/${acct.real}/leverage`, { leverage: 500 });
      expect(off.status).toBe(422);
      expect(off.body.error.code).toBe("MT5_SERVER_OFF");
      expect((await get(support, `/api/staff/mt5/accounts/${acct.real}`)).body.live).toMatchObject({ error: expect.stringContaining("switched off") });
      // Clients cannot open accounts on it either.
      const res = await clientCreate(realClient, { is_demo: false, account_package_id: classic, leverage: "2000", password: MASTER, investor_password: INVESTOR });
      expect(res.body.errors).toEqual({ mt5: ["Trading accounts are temporarily unavailable. Please try again in a few minutes."] });
    } finally {
      await exec(env.db, "UPDATE mt5_servers SET is_enabled = 1 WHERE code = 'live'");
    }

    const offApp = createApp({ db: env.db, config: env.config, log: pino({ level: "silent" }), fetch: (async () => new Response("", { status: 503 })) as typeof fetch, mt5: null });
    await createStaff(env.db, "offline@crm.test", "super_admin");
    const offline = await signIn({ ...env, app: offApp }, "offline@crm.test");
    expect((await get(offline, "/api/staff/mt5/servers")).body.gatewayConfigured).toBe(false);
    expect((await get(offline, "/api/staff/mt5/settings")).body.gatewayConfigured).toBe(false);
    expect((await post(offline, "/api/staff/mt5/servers/live/ping")).body).toMatchObject({ ok: false, error: { kind: "unavailable" } });
    await stepUp({ ...env, app: offApp }, offline);
    const res = await post(offline, `/api/staff/mt5/accounts/${acct.real}/leverage`, { leverage: 500 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("MT5_OFF");
    const page = await get(offline, `/api/staff/mt5/accounts/${acct.real}`);
    expect(page.status).toBe(200);
    expect(page.body.live.error).toMatch(/not connected/);
  });
});
