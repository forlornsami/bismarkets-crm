import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import pino from "pino";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Express } from "express";
import { loadGatewayConfig } from "../src/gateway/config";
import { createGatewayLogger } from "../src/gateway/log";
import { createGatewayServer, type GatewayServer } from "../src/gateway/server";
import { createApp } from "../src/server/app";
import { lockClient } from "../src/server/clients/kyc";
import { createClientSession } from "../src/server/clients/session";
import { verifyAuditChain } from "../src/server/lib/audit";
import { exec, one, rows, transaction } from "../src/server/lib/db";
import { depositMethodAccount, lockWallet, postLedger, verifyLedger, walletAccount } from "../src/server/money/ledger";
import { newReference } from "../src/server/money/references";
import { httpGateway, type Mt5Gateway } from "../src/server/mt5/gateway";
import { settleBalanceOp } from "../src/server/mt5/operations";
import { resolveMt5Once } from "../src/server/mt5/resolver";
import { startFakeMt5, type FakeMt5 } from "./fakes/mt5-webapi";
import { createStaff, hasDb, post, setup, signIn, stepUp, type TestEnv } from "./helpers";

// The whole MT5 path as it runs in production: the CRM app with the real
// httpGateway, the real gateway server (started here on a free port), and
// two fake MT5 servers (live and demo) over TLS with the certificate pin
// and the real manager sign-in. Nothing in between is faked, so these tests
// catch what the per-side tests cannot: the two sides disagreeing about a
// shape, a code or a rule.

const SECRET = `crm-gw-${randomBytes(16).toString("hex")}`;
const WRONG_SECRET = `not-the-gateway-secret-${randomBytes(8).toString("hex")}`;
const LIVE_MANAGER = "Live-Manager-1!";
const DEMO_MANAGER = "Demo-Manager-2!";
// Client passwords, some with characters that mean something in a URL: the gateway sends them to MT5 in the query string.
const MASTER = "Trade-Me-42!";
const INVESTOR = "Look+Only&7?";
const NEW_MASTER = "Fresh-Main-8#";
const NEW_INVESTOR = "Fresh=View+9$";
const OTHER_INVESTOR = "Other-View-3%";
const STANDARD = "real\\standard";
const DEMO_GROUP = "demo\\usd";

const UNAVAILABLE = "Trading accounts are temporarily unavailable. Please try again in a few minutes.";
const CHANGE_UNCONFIRMED = "We could not confirm that this change was made. Please check your account in a minute before trying again.";
const CREATE_UNCONFIRMED = "We could not confirm that your account was opened. Please check your accounts in a minute before trying again.";
const STILL_SETTING_UP = "Your previous account is still being set up. Please check your accounts in a minute.";
const TO_MT5_FAILED = "The transfer did not go through. The money is back in your wallet.";
const GATEWAY_REFUSED = "Refused a request that is not properly signed";
const CRM_UNTRUSTED = "MT5 gateway answer has no valid signature: check CRM_MT5_GATEWAY_SECRET and that the gateway is the one listening";

interface Client {
  id: number;
  email: string;
  last: string;
  token: string;
}

describe.skipIf(!hasDb)("MT5 end to end: CRM, gateway and MT5 over TLS", () => {
  let env: TestEnv;
  let live: FakeMt5;
  let demo: FakeMt5;
  let gateway: GatewayServer | null = null;
  let port = 0;
  let mt5: Mt5Gateway;
  let classic = 0;
  let depositMethod = 0;
  let seq = 0;
  /** Passwords staff resets made, checked with the others at the end. */
  const generated: string[] = [];

  // Both processes' logs, kept to check that no secret or password ever reaches them.
  const gatewayLines: string[] = [];
  const crmLines: string[] = [];
  const crmLog = pino({ level: "debug" }, { write: (line: string) => void crmLines.push(line) });
  const noFetch = (async () => new Response("", { status: 503 })) as typeof fetch;

  function gatewayEnv(): Record<string, string> {
    return {
      GATEWAY_SECRET: SECRET,
      GATEWAY_LOG_LEVEL: "debug",
      GATEWAY_SERVERS: "live,demo",
      GATEWAY_SERVER_LIVE_HOST: live.host,
      GATEWAY_SERVER_LIVE_PORT: String(live.port),
      GATEWAY_SERVER_LIVE_LOGIN: "9000",
      GATEWAY_SERVER_LIVE_PASSWORD: LIVE_MANAGER,
      GATEWAY_SERVER_LIVE_CERT_SHA256: live.certSha256,
      GATEWAY_SERVER_LIVE_GROUPS: STANDARD,
      GATEWAY_SERVER_LIVE_TZ_OFFSET_MINUTES: "180",
      GATEWAY_SERVER_DEMO_HOST: demo.host,
      GATEWAY_SERVER_DEMO_PORT: String(demo.port),
      GATEWAY_SERVER_DEMO_LOGIN: "9100",
      GATEWAY_SERVER_DEMO_PASSWORD: DEMO_MANAGER,
      GATEWAY_SERVER_DEMO_CERT_SHA256: demo.certSha256,
      GATEWAY_SERVER_DEMO_DEMO_GROUPS: DEMO_GROUP,
      GATEWAY_SERVER_DEMO_TZ_OFFSET_MINUTES: "-300",
      GATEWAY_LEVERAGES: "100,500,2000",
    };
  }

  /** The gateway as index.ts runs it, on `listenOn` (0 picks a free port). */
  async function startGateway(listenOn = 0) {
    const server = createGatewayServer(loadGatewayConfig(gatewayEnv()), { log: createGatewayLogger("debug", { write: (line: string) => void gatewayLines.push(line) }), pingIntervalMs: 0 });
    await new Promise<void>((resolve) => server.listen(listenOn, "127.0.0.1", resolve));
    gateway = server;
    return (server.address() as AddressInfo).port;
  }

  async function stopGateway() {
    const server = gateway;
    gateway = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** The CRM app as index.ts builds it, with this gateway client. */
  const crmApp = (gw: Mt5Gateway | null): Express => createApp({ db: env.db, config: env.config, log: crmLog, fetch: noFetch, mt5: gw });

  async function makeClient(): Promise<Client> {
    seq++;
    const email = `e2e.${seq}@client.test`;
    const last = `Client${seq}`;
    const r = await exec(
      env.db,
      "INSERT INTO clients (email, first_name, last_name, referral_code, source, kyc_status, status, country) VALUES (?, 'Tara', ?, ?, 'portal', 'approved', 'active', 'Pakistan')",
      [email, last, `IN${String(seq).padStart(8, "0")}`],
    );
    const { token } = await transaction(env.db, (conn) => createClientSession(conn, env.config, r.insertId, "127.0.0.1", "vitest"));
    return { id: r.insertId, email, last, token };
  }

  /** Money in the wallet the way an approved deposit puts it there, so the ledger checks stay clean. */
  async function fund(clientId: number, cents: number) {
    await transaction(env.db, async (conn) => {
      await lockClient(conn, clientId);
      const wallet = await lockWallet(conn, clientId);
      const d = await exec(
        conn,
        `INSERT INTO deposits (reference, client_id, wallet_id, payment_method_id, method_name, status, currency, amount_minor, usd_rate, amount_cents, received_minor, credited_cents)
         VALUES (?, ?, ?, ?, 'Bank', 'approved', 'USD', ?, 1, ?, ?, ?)`,
        [newReference("D"), clientId, wallet.id, depositMethod, cents, cents, cents, cents],
      );
      await postLedger(conn, { kind: "deposit", sourceType: "deposit", sourceId: d.insertId, clientId, staffId: null, memo: "test deposit" }, [
        { account: walletAccount(clientId), amount: cents },
        { account: depositMethodAccount(depositMethod), amount: -cents },
      ]);
    });
  }

  const api = (app?: Express) => request(app ?? env.app);
  const bearer = (c: Client) => ({ Authorization: `Bearer ${c.token}` });
  const liveBody = { is_demo: false, account_package_id: 0, leverage: "2000", currency: "usd", password: MASTER, investor_password: INVESTOR };
  const createLive = (c: Client, app?: Express) => api(app).post("/api/mt5-accounts").set(bearer(c)).send({ ...liveBody, account_package_id: classic });
  const createDemo = (c: Client, amount: number, leverage = "2000") =>
    api().post("/api/mt5-accounts").set(bearer(c)).send({ is_demo: true, demo_amount: amount, leverage, password: MASTER, investor_password: INVESTOR });
  const list = (c: Client, app?: Express) => api(app).get("/api/mt5-accounts").set(bearer(c));
  const change = (c: Client, login: number, what: string, body: object = {}, app?: Express) => api(app).patch(`/api/mt5-accounts/${login}/${what}`).set(bearer(c)).send(body);
  const toMt5 = (c: Client, login: number, amount: unknown, app?: Express) => api(app).post("/api/transfer/wallet-to-mt5").set(bearer(c)).send({ mt5_account_id: String(login), amount });
  const toWallet = (c: Client, login: number, amount: unknown, app?: Express) => api(app).post("/api/transfer/mt5-to-wallet").set(bearer(c)).send({ mt5_account_id: String(login), amount });
  const topUp = (c: Client, login: number, amount: number) => api().post("/api/mt5-accounts/demo/top-up").set(bearer(c)).send({ login, amount });
  const history = (c: Client) => api().get("/api/transfers").set(bearer(c));

  async function openLive(c: Client) {
    const res = await createLive(c);
    expect(res.status).toBe(200);
    const login = Number(res.body.account.login);
    return { login, id: Number((await accountRow("live", login))!.id) };
  }

  async function openDemo(c: Client, amount = 1000, leverage = "2000") {
    const res = await createDemo(c, amount, leverage);
    expect(res.status).toBe(200);
    const login = Number(res.body.account.login);
    return { login, id: Number((await accountRow("demo", login))!.id) };
  }

  /** A client with `cents` in the wallet and one open live account. */
  async function clientWithLive(cents = 50_000) {
    const c = await makeClient();
    await fund(c.id, cents);
    return { c, ...(await openLive(c)) };
  }

  const accountRow = (server: string, login: number) => one<Record<string, any>>(env.db, "SELECT * FROM mt5_accounts WHERE server_code = ? AND login = ?", [server, login]);
  const wallet = async (clientId: number) => {
    const w = await one<{ available_cents: number; held_cents: number }>(env.db, "SELECT available_cents, held_cents FROM wallets WHERE client_id = ?", [clientId]);
    return { available: Number(w?.available_cents ?? 0), held: Number(w?.held_cents ?? 0) };
  };
  const opByRef = async (reference: string) => {
    const o = await one<Record<string, any>>(env.db, "SELECT * FROM mt5_balance_ops WHERE reference = ?", [reference]);
    const op: Record<string, any> & { id: number; mt5_ticket: number | null } = { ...o!, id: Number(o!.id), mt5_ticket: o!.mt5_ticket === null ? null : Number(o!.mt5_ticket) };
    return op;
  };
  const kinds = async (opId: number) =>
    (await rows<{ kind: string }>(env.db, "SELECT kind FROM ledger_transactions WHERE source_type = 'mt5_op' AND source_id = ? ORDER BY id", [opId])).map((r) => r.kind);
  const opsOf = async (clientId: number) => Number((await one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM mt5_balance_ops WHERE client_id = ?", [clientId]))!.n);
  const audits = (action: string, clientId: number) => rows<Record<string, any>>(env.db, "SELECT * FROM audit_log WHERE action = ? AND entity_id = ? ORDER BY id", [action, String(clientId)]);
  const due = (opId: number) => exec(env.db, "UPDATE mt5_balance_ops SET next_check_at = NULL WHERE id = ?", [opId]);
  const resolve = (gw: Mt5Gateway = mt5) => resolveMt5Once(env.db, gw, crmLog);
  const clean = async () => expect(await verifyLedger(env.db)).toEqual([]);
  /** Ages every snapshot so the next list asks MT5 again. */
  const staleFigures = () => exec(env.db, "UPDATE mt5_accounts SET snapshot_at = snapshot_at - INTERVAL 1 HOUR WHERE snapshot_at IS NOT NULL");

  const sent = (fake: FakeMt5, path: string) => fake.state.requests.filter((r) => r.path === path).length;
  const dealsWith = (fake: FakeMt5, comment: string) => fake.state.deals.filter((d) => d.comment === comment);
  const reached = () => live.state.requests.length + demo.state.requests.length;
  const logged = (lines: string[], msg: string) => lines.filter((l) => (JSON.parse(l) as { msg?: string }).msg === msg).length;
  const soon = (d: unknown, ms: number) => {
    const at = (d as Date).getTime() - Date.now();
    expect(at).toBeGreaterThan(ms - 5_000);
    expect(at).toBeLessThanOrEqual(ms + 1_000);
  };

  beforeAll(async () => {
    live = await startFakeMt5({ managers: { 9000: LIVE_MANAGER }, tzOffsetMinutes: 180 });
    // A broker gives each server its own login range.
    demo = await startFakeMt5({ managers: { 9100: DEMO_MANAGER }, tzOffsetMinutes: -300, firstLogin: 7_000_001 });
    port = await startGateway();
    // The CRM's own settings check the URL and the secret, and the client is built from them as index.ts does.
    const base = await setup({ CRM_MT5_GATEWAY_URL: `http://127.0.0.1:${port}`, CRM_MT5_GATEWAY_SECRET: SECRET });
    const { url, secret } = base.config.mt5Gateway!;
    mt5 = httpGateway({ url, secret, fetch, log: crmLog });
    env = base;
    env.app = crmApp(mt5);

    await exec(env.db, "INSERT INTO mt5_servers (code, label, is_enabled) VALUES ('live', 'Live', 1), ('demo', 'Demo', 1)");
    await exec(env.db, "UPDATE mt5_settings SET demo_server_code = 'demo', demo_group = ?, leverages = '2000,500,100' WHERE id = 1", [DEMO_GROUP]);
    classic = (
      await exec(env.db, "INSERT INTO account_packages (name, spread_label, min_deposit_cents, server_code, mt5_group) VALUES ('Classic', '1.2', 10000, 'live', ?)", [STANDARD])
    ).insertId;
    depositMethod = (
      await exec(env.db, "INSERT INTO payment_methods (direction, kind, name, currency, network, bank_name, account_title, account_number, wallet_address, ask_qr) VALUES ('deposit', 'bank', 'Bank', 'USD', '', 'Bank', 'BIS Markets', '0101', '', 0)")
    ).insertId;
  }, 120_000);

  afterAll(async () => {
    await stopGateway();
    await live?.close();
    await demo?.close();
    await env?.db.end();
  });

  beforeEach(async () => {
    // Whatever an earlier test left open is settled the proper way (money back), so each test starts clean.
    for (const o of await rows<{ id: number }>(env.db, "SELECT id FROM mt5_balance_ops WHERE status IN ('sending', 'unknown')")) {
      await settleBalanceOp(env.db, Number(o.id), { status: "failed", failure: "test", clientMessage: "test" });
    }
    await exec(env.db, "UPDATE mt5_accounts SET status = 'failed', failure = 'test' WHERE status IN ('creating', 'unknown')");
    if (!gateway) await startGateway(port);
  });
  afterEach(() => {
    live.faults.clear();
    demo.faults.clear();
  });

  // ---------- Accounts ----------

  it("opens a live and a demo account on their own MT5 servers, with the client's details, and lists both", async () => {
    const c = await makeClient();
    await fund(c.id, 50_000);

    const res = await createLive(c);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      message: "Your account is ready.",
      account: { is_demo: false, type: "real", status: "active", archived: false, leverage: "2000", package_name: "Classic", server: "BISMarkets-Trade" },
    });
    const login = Number(res.body.account.login);
    expect(res.body.account).toMatchObject({ id: String(login), account_id: String(login), login: String(login) });
    const row = (await accountRow("live", login))!;
    expect(row).toMatchObject({ status: "active", mt5_group: STANDARD, leverage: 2000 });
    expect(Number(row.client_id)).toBe(c.id);
    // MT5 has it as the CRM asked: its group, the client's details, the passwords the client chose, and the CRM's reference.
    expect(live.state.users.get(login)).toMatchObject({
      group: STANDARD, leverage: 2000, name: `Tara ${c.last}`, email: c.email, country: "Pakistan", comment: row.create_ref,
      mainPassword: MASTER, investorPassword: INVESTOR, rights: 0x163n,
    });
    expect(demo.state.users.has(login)).toBe(false);

    const d = await createDemo(c, 2500, "1:500");
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ success: true, account: { is_demo: true, type: "demo", leverage: "500", package_name: "Demo" } });
    const demoLogin = Number(d.body.account.login);
    expect(demo.state.users.get(demoLogin)).toMatchObject({ group: DEMO_GROUP, leverage: 500, balanceCents: 250_000, mainPassword: MASTER, investorPassword: INVESTOR });
    expect(live.state.users.has(demoLogin)).toBe(false);
    // The starting balance is a balance deal carrying the funding operation's reference.
    const funding = (await one<Record<string, any>>(env.db, "SELECT * FROM mt5_balance_ops WHERE login = ? AND purpose = 'demo_funding'", [demoLogin]))!;
    expect(funding).toMatchObject({ status: "completed", amount_cents: 250_000, server_code: "demo" });
    expect(dealsWith(demo, funding.reference)).toEqual([expect.objectContaining({ ticket: Number(funding.mt5_ticket), login: demoLogin, action: 2, profitCents: 250_000 })]);

    const shown = await list(c);
    expect(shown.status).toBe(200);
    expect(shown.body.real_accounts.map((a: { login: string }) => a.login)).toEqual([String(login)]);
    expect(shown.body.demo_accounts.map((a: { login: string }) => a.login)).toEqual([String(demoLogin)]);
    // The demo account shows its starting balance, read back from the demo server.
    expect(shown.body.demo_accounts[0]).toMatchObject({ balance: 2500, equity: 2500, mt5: { balance: 2500, leverage: "500", currency: "USD" } });
    expect(await audits("mt5.account.created", c.id)).toHaveLength(2);
  });

  it("shows each account's live figures from MT5, saves them, and does not ask again within 15 seconds", async () => {
    const { c, login, id } = await clientWithLive();
    Object.assign(live.state.users.get(login)!, { balanceCents: 123_456, creditCents: 500, marginCents: 1_000, profitCents: -2_001 });
    // Just opened: the empty figures are fresh.
    expect((await list(c)).body.real_accounts[0]).toMatchObject({ balance: 0, equity: 0 });

    await staleFigures();
    const reads = sent(live, "/api/user/account/get");
    const shown = (await list(c)).body.real_accounts[0];
    expect(shown).toMatchObject({
      login: String(login), balance: 1234.56, equity: 1219.55, credit: 5,
      mt5: { login: String(login), balance: 1234.56, equity: 1219.55, credit: 5, margin: 10, free_margin: 1209.55, leverage: "2000", currency: "USD" },
    });
    expect(sent(live, "/api/user/account/get")).toBe(reads + 1);
    expect(await one(env.db, "SELECT balance_cents, credit_cents, equity_cents, margin_cents, margin_free_cents FROM mt5_accounts WHERE id = ?", [id])).toEqual({
      balance_cents: 123_456, credit_cents: 500, equity_cents: 121_955, margin_cents: 1_000, margin_free_cents: 120_955,
    });

    expect((await list(c)).body.real_accounts[0].balance).toBe(1234.56);
    expect(sent(live, "/api/user/account/get")).toBe(reads + 1);
  });

  it("archives and restores an account by switching trading off and on in MT5", async () => {
    const { c, login } = await clientWithLive();
    const updates = live.state.updates.length;

    live.state.positions.set(login, 2);
    const busy = await change(c, login, "inactive");
    expect(busy.status).toBe(422);
    expect(busy.body.errors).toEqual({ account: ["Close your open trades before archiving this account."] });
    expect(live.state.updates).toHaveLength(updates);

    live.state.positions.set(login, 0);
    const archived = await change(c, login, "inactive");
    expect(archived.status).toBe(200);
    expect(archived.body).toEqual({ success: true, message: "Account archived." });
    // TRADE_DISABLED (4) on, everything else as MT5 had it: the client can still sign in.
    expect(live.state.users.get(login)!.rights).toBe(0x163n | 0x4n);
    expect(live.state.updates).toHaveLength(updates + 1);
    expect((await list(c)).body.real_accounts[0]).toMatchObject({ status: "active", archived: true });
    const lever = await change(c, login, "leverage", { leverage: "500" });
    expect(lever.status).toBe(422);
    expect(lever.body.errors).toEqual({ leverage: ["Restore this account before changing its leverage."] });

    const restored = await change(c, login, "active");
    expect(restored.status).toBe(200);
    expect(restored.body).toEqual({ success: true, message: "Account restored." });
    expect(live.state.users.get(login)!.rights).toBe(0x163n);
    expect((await list(c)).body.real_accounts[0]).toMatchObject({ status: "active", archived: false });
    expect(await audits("mt5.account.archived", c.id)).toHaveLength(1);
    expect(await audits("mt5.account.restored", c.id)).toHaveLength(1);
  });

  it("changes leverage in MT5 and the next list shows it; a leverage the gateway does not allow changes nothing", async () => {
    const { c, login, id } = await clientWithLive();
    const res = await change(c, login, "leverage", { leverage: "1:500" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: "Leverage changed.", leverage: "500" });
    expect(live.state.users.get(login)!.leverage).toBe(500);
    expect((await list(c)).body.real_accounts[0]).toMatchObject({ leverage: "500" });

    // Staff offer 1:1000 in the CRM, but the gateway's own list does not have it: its rule wins.
    await exec(env.db, "UPDATE mt5_settings SET leverages = '2000,500,100,1000' WHERE id = 1");
    try {
      const refused = await change(c, login, "leverage", { leverage: 1000 });
      expect(refused.status).toBe(422);
      expect(refused.body.errors).toEqual({ mt5: [UNAVAILABLE] });
    } finally {
      await exec(env.db, "UPDATE mt5_settings SET leverages = '2000,500,100' WHERE id = 1");
    }
    expect(live.state.users.get(login)!.leverage).toBe(500);
    expect((await accountRow("live", login))!.leverage).toBe(500);
    expect(await audits("mt5.account.leverage_changed", c.id)).toEqual([expect.objectContaining({ entity_id: String(c.id) })]);
    expect(Number((await audits("mt5.account.leverage_changed", c.id))[0]!.meta_json.accountId)).toBe(id);
  });

  it("asks once more when the answer to an archive or a leverage change is lost, and MT5 changes it once", async () => {
    const { c, login } = await clientWithLive();
    const updates = live.state.updates.length;
    live.faults.next("/api/user/update", { drop: "after" });
    const archived = await change(c, login, "inactive");
    expect(archived.status).toBe(200);
    expect(archived.body).toEqual({ success: true, message: "Account archived." });
    // MT5 applied the first one; the second found nothing left to change and sent nothing.
    expect(live.state.updates).toHaveLength(updates + 1);
    expect(live.state.users.get(login)!.rights).toBe(0x163n | 0x4n);
    expect((await list(c)).body.real_accounts[0]).toMatchObject({ archived: true });
    expect((await change(c, login, "active")).status).toBe(200);

    live.faults.next("/api/user/update", { drop: "after" });
    const lever = await change(c, login, "leverage", { leverage: "100" });
    expect(lever.status).toBe(200);
    expect(live.state.users.get(login)!.leverage).toBe(100);
    expect(live.state.updates).toHaveLength(updates + 3);
    expect((await list(c)).body.real_accounts[0]).toMatchObject({ leverage: "100", archived: false });

    // Both sends lost on the way (MT5 never applied either): the honest "not confirmed", never a failure.
    live.faults.next("/api/user/update", { drop: "before" });
    live.faults.next("/api/user/update", { drop: "before" });
    const unsure = await change(c, login, "leverage", { leverage: "500" });
    expect(unsure.status).toBe(409);
    expect(unsure.body).toEqual({ message: CHANGE_UNCONFIRMED });
    expect(live.state.users.get(login)!.leverage).toBe(100);
    expect((await accountRow("live", login))!.leverage).toBe(100);
  });

  it("changes the master and investor passwords in MT5, and the list shows the ones MT5 has", async () => {
    const { c, login } = await clientWithLive();
    expect((await list(c)).body.real_accounts[0]).toMatchObject({ password: MASTER, investor_password: INVESTOR });

    // The portal's body for a new master password: the investor one sent back as the list shows it. Only the master one goes to MT5.
    const before = sent(live, "/api/user/change_password");
    const master = await change(c, login, "password", { password: NEW_MASTER, password_confirmation: NEW_MASTER, investor_password: INVESTOR, investor_password_confirmation: INVESTOR });
    expect(master.status).toBe(200);
    expect(master.body).toEqual({ success: true, message: "Password changed." });
    expect(sent(live, "/api/user/change_password")).toBe(before + 1);
    expect(live.state.users.get(login)).toMatchObject({ mainPassword: NEW_MASTER, investorPassword: INVESTOR });
    expect((await list(c)).body.real_accounts[0]).toMatchObject({ password: NEW_MASTER, investor_password: INVESTOR });
    // And for a new investor password, from the list read again.
    expect((await change(c, login, "password", { password: NEW_MASTER, password_confirmation: NEW_MASTER, investor_password: NEW_INVESTOR, investor_password_confirmation: NEW_INVESTOR })).status).toBe(200);
    expect(sent(live, "/api/user/change_password")).toBe(before + 2);
    expect(live.state.users.get(login)).toMatchObject({ mainPassword: NEW_MASTER, investorPassword: NEW_INVESTOR });

    // From a page that still has the first list: neither matches what is kept, so nothing goes to MT5 and the old master is not put back.
    const stale = await change(c, login, "password", { password: MASTER, password_confirmation: MASTER, investor_password: OTHER_INVESTOR, investor_password_confirmation: OTHER_INVESTOR });
    expect(stale.status).toBe(422);
    expect(sent(live, "/api/user/change_password")).toBe(before + 2);
    expect(live.state.users.get(login)).toMatchObject({ mainPassword: NEW_MASTER, investorPassword: NEW_INVESTOR });

    // An empty pair is unchanged: only the investor password goes to MT5.
    const sends = sent(live, "/api/user/change_password");
    const investorOnly = await change(c, login, "password", { password: "", password_confirmation: "", investor_password: OTHER_INVESTOR, investor_password_confirmation: OTHER_INVESTOR });
    expect(investorOnly.status).toBe(200);
    expect(sent(live, "/api/user/change_password")).toBe(sends + 1);
    expect(live.state.users.get(login)).toMatchObject({ mainPassword: NEW_MASTER, investorPassword: OTHER_INVESTOR });

    expect((await list(c)).body.real_accounts[0]).toMatchObject({ password: NEW_MASTER, investor_password: OTHER_INVESTOR });

    const recorded = await audits("mt5.account.password_changed", c.id);
    expect(recorded.map((a) => a.meta_json)).toEqual([
      expect.objectContaining({ login, main: true, investor: false }),
      expect.objectContaining({ login, main: false, investor: true }),
      expect.objectContaining({ login, main: false, investor: true }),
    ]);
  });

  it("tops up a demo account with a balance deal on the demo server", async () => {
    const c = await makeClient();
    const { login, id } = await openDemo(c, 1000);
    const res = await topUp(c, login, 250.5);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: "Your demo account was topped up." });
    expect(demo.state.users.get(login)!.balanceCents).toBe(125_050);
    const op = (await one<Record<string, any>>(env.db, "SELECT * FROM mt5_balance_ops WHERE mt5_account_id = ? AND purpose = 'demo_topup'", [id]))!;
    expect(op).toMatchObject({ status: "completed", amount_cents: 25_050, server_code: "demo" });
    expect(dealsWith(demo, op.reference)).toEqual([expect.objectContaining({ ticket: Number(op.mt5_ticket), action: 2, profitCents: 25_050 })]);
    expect((await list(c)).body.demo_accounts[0]).toMatchObject({ balance: 1250.5 });
    // Demo money is not client money: nothing in the ledger.
    expect(await kinds(Number(op.id))).toEqual([]);
  });

  it("opens a live account for a client whose country is longer or odder than MT5 accepts", async () => {
    const c = await makeClient();
    await fund(c.id, 50_000);
    // The profile allows 80 characters of any text; the gateway takes 64 with no control characters.
    const country = `Saint\tIsles ${"Long".repeat(16)}`;
    expect(country.length).toBeLessThanOrEqual(80);
    await exec(env.db, "UPDATE clients SET country = ? WHERE id = ?", [country, c.id]);
    const { login } = await openLive(c);
    expect(live.state.users.get(login)!.country).toBe(`Saint Isles ${"Long".repeat(13)}`);
  });

  it("lets staff ping a server, read an account, suspend it, reset a password and reactivate it, all in MT5", async () => {
    const { c, login, id } = await clientWithLive();
    const opened = Date.now();
    await createStaff(env.db, "dealer.e2e@crm.test", "super_admin");
    const staff = await signIn(env, "dealer.e2e@crm.test");
    await stepUp(env, staff);

    // MT5's own clock, three hours ahead of UTC on this server.
    const ping = await post(staff, "/api/staff/mt5/servers/live/ping");
    expect(ping.body).toMatchObject({ ok: true, serverTime: expect.any(Number) });
    expect(Math.abs(ping.body.serverTime - live.serverNow())).toBeLessThanOrEqual(5);

    Object.assign(live.state.users.get(login)!, { balanceCents: 5_000 });
    const read = await post(staff, `/api/staff/mt5/accounts/${id}/refresh`);
    expect(read.status).toBe(200);
    expect(read.body.live).toMatchObject({ user: { login, group: STANDARD, enabled: true, tradeDisabled: false }, figures: { login, balanceCents: 5_000 }, error: null });
    // MT5 registered it in server time; the CRM keeps it in UTC, and the client sees that as the opening time.
    const registered = Date.parse(read.body.account.registeredAt);
    expect(Math.abs(registered - opened)).toBeLessThan(5_000);
    expect(Date.parse((await list(c)).body.real_accounts[0].created_at)).toBe(registered);

    const suspended = await post(staff, `/api/staff/mt5/accounts/${id}/suspend`, { reason: "Checking a complaint" });
    expect(suspended.status).toBe(200);
    expect(live.state.users.get(login)!.rights).toBe(0x163n & ~0x1n);
    expect((await list(c)).body.real_accounts[0]).toMatchObject({ status: "suspended", archived: false });
    expect((await change(c, login, "inactive")).body.errors).toEqual({ account: ["Account already inactive"] });

    const reset = await post(staff, `/api/staff/mt5/accounts/${id}/password`, { type: "investor" });
    expect(reset.status).toBe(200);
    expect(reset.body).toEqual({ login: String(login), type: "investor", password: expect.stringMatching(/^[\x21-\x7e]{12}$/) });
    generated.push(reset.body.password);
    expect(live.state.users.get(login)).toMatchObject({ investorPassword: reset.body.password, mainPassword: MASTER });
    // The client sees the new one in their own list; it is the one MT5 has.
    expect((await list(c)).body.real_accounts[0]).toMatchObject({ password: MASTER, investor_password: reset.body.password });

    const back = await post(staff, `/api/staff/mt5/accounts/${id}/reactivate`, { reason: "Complaint resolved" });
    expect(back.status).toBe(200);
    expect(live.state.users.get(login)!.rights).toBe(0x163n);
    expect((await list(c)).body.real_accounts[0]).toMatchObject({ status: "active", archived: false });
  }, 30_000);

  // ---------- Transfers ----------

  it("moves money from the wallet to MT5 and back, each a single deal, with the ledger balanced", async () => {
    const { c, login } = await clientWithLive(50_000);
    const sends = sent(live, "/api/trade/balance");

    const inRes = await toMt5(c, login, "200.25");
    expect(inRes.status).toBe(200);
    expect(inRes.body).toMatchObject({ success: true, message: "Transfer completed.", data: { type: 1, status: "completed", amount: 200.25, mt5_account_id: String(login) } });
    const opIn = await opByRef(inRes.body.data.id);
    expect(opIn).toMatchObject({ purpose: "wallet_to_mt5", status: "completed", amount_cents: 20_025 });
    expect(dealsWith(live, opIn.reference)).toEqual([expect.objectContaining({ ticket: opIn.mt5_ticket, login, action: 2, profitCents: 20_025 })]);
    expect(live.state.users.get(login)!.balanceCents).toBe(20_025);
    expect(await wallet(c.id)).toEqual({ available: 29_975, held: 0 });
    expect(await kinds(opIn.id)).toEqual(["transfer_hold", "transfer_out"]);
    await clean();

    const outRes = await toWallet(c, login, 75);
    expect(outRes.status).toBe(200);
    expect(outRes.body).toMatchObject({ success: true, message: "Transfer completed.", data: { type: 2, status: "completed", amount: 75 } });
    const opOut = await opByRef(outRes.body.data.id);
    expect(opOut).toMatchObject({ purpose: "mt5_to_wallet", status: "completed", amount_cents: 7_500 });
    expect(dealsWith(live, opOut.reference)).toEqual([expect.objectContaining({ ticket: opOut.mt5_ticket, action: 2, profitCents: -7_500 })]);
    expect(live.state.users.get(login)!.balanceCents).toBe(12_525);
    expect(await wallet(c.id)).toEqual({ available: 37_475, held: 0 });
    expect(await kinds(opOut.id)).toEqual(["transfer_in"]);
    await clean();

    // More than MT5 says the account can give: refused before anything is written or sent.
    const ops = await opsOf(c.id);
    const tooMuch = await toWallet(c, login, 200);
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.errors).toEqual({ amount: ["You can transfer up to $125.25 from this account."] });
    expect(await opsOf(c.id)).toBe(ops);

    expect(sent(live, "/api/trade/balance")).toBe(sends + 2);
    expect((await history(c)).body.data.map((t: { id: string }) => t.id)).toEqual([opOut.reference, opIn.reference]);
    await clean();
  });

  it("never lets transfers at the same moment spend the same wallet money, and MT5 gets each deal once", async () => {
    const c = await makeClient();
    await fund(c.id, 50_000);
    const accounts = [await openLive(c), await openLive(c), await openLive(c)];
    const sends = sent(live, "/api/trade/balance");
    const answers = await Promise.all(accounts.map((a) => toMt5(c, a.login, 200)));
    expect(answers.map((r) => r.status).sort()).toEqual([200, 200, 422]);
    expect(answers.find((r) => r.status === 422)!.body.errors).toEqual({ amount: ["Your wallet balance is not enough for this transfer."] });
    expect(sent(live, "/api/trade/balance")).toBe(sends + 2);
    expect(accounts.map((a) => live.state.users.get(a.login)!.balanceCents).sort()).toEqual([0, 20_000, 20_000]);
    expect(await wallet(c.id)).toEqual({ available: 10_000, held: 0 });
    await clean();
  });

  it("when MT5 makes a deal but its answer is lost, answers 202 and one resolver pass completes it exactly once", async () => {
    const { c, login } = await clientWithLive(50_000);
    live.faults.next("/api/trade/balance", { drop: "after" });
    const res = await toMt5(c, login, 120);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ success: true, message: "Your transfer is being processed.", data: { status: "pending", amount: 120 } });
    const op = await opByRef(res.body.data.id);
    expect(op).toMatchObject({ status: "unknown", failure: "connection", checks: 0, mt5_ticket: null });
    soon(op.next_check_at, 60_000);
    // MT5 did make it; the CRM holds the money until it knows.
    expect(dealsWith(live, op.reference)).toHaveLength(1);
    expect(live.state.users.get(login)!.balanceCents).toBe(12_000);
    expect(await wallet(c.id)).toEqual({ available: 38_000, held: 12_000 });
    expect(await kinds(op.id)).toEqual(["transfer_hold"]);
    await clean();

    const sends = sent(live, "/api/trade/balance");
    await due(op.id);
    expect(await resolve()).toEqual({ ops: 1, accounts: 0 });
    expect(await opByRef(op.reference)).toMatchObject({ status: "completed", mt5_ticket: dealsWith(live, op.reference)[0]!.ticket, next_check_at: null });
    expect(await kinds(op.id)).toEqual(["transfer_hold", "transfer_out"]);
    expect(await wallet(c.id)).toEqual({ available: 38_000, held: 0 });
    await clean();

    // A second pass has nothing to do and changes nothing.
    expect(await resolve()).toEqual({ ops: 0, accounts: 0 });
    expect(await kinds(op.id)).toEqual(["transfer_hold", "transfer_out"]);
    // The resolver only searched: nothing was sent again, and MT5 has the deal once.
    expect(sent(live, "/api/trade/balance")).toBe(sends);
    expect(dealsWith(live, op.reference)).toHaveLength(1);
    expect(live.state.users.get(login)!.balanceCents).toBe(12_000);
    expect((await history(c)).body.data[0]).toMatchObject({ id: op.reference, status: "completed" });
    await clean();
  });

  it("credits the wallet for a lost MT5-to-wallet answer only when the resolver finds the deal, and only once", async () => {
    const { c, login } = await clientWithLive(50_000);
    expect((await toMt5(c, login, 300)).status).toBe(200);
    live.faults.next("/api/trade/balance", { drop: "after" });
    const res = await toWallet(c, login, 100);
    expect(res.status).toBe(202);
    const op = await opByRef(res.body.data.id);
    expect(op).toMatchObject({ purpose: "mt5_to_wallet", status: "unknown" });
    expect(live.state.users.get(login)!.balanceCents).toBe(20_000);
    expect(await wallet(c.id)).toEqual({ available: 20_000, held: 0 });
    expect(await kinds(op.id)).toEqual([]);
    await clean();

    await due(op.id);
    expect(await resolve()).toEqual({ ops: 1, accounts: 0 });
    expect(await opByRef(op.reference)).toMatchObject({ status: "completed", mt5_ticket: dealsWith(live, op.reference)[0]!.ticket });
    expect(await kinds(op.id)).toEqual(["transfer_in"]);
    expect(await wallet(c.id)).toEqual({ available: 30_000, held: 0 });

    expect(await resolve()).toEqual({ ops: 0, accounts: 0 });
    expect(await kinds(op.id)).toEqual(["transfer_in"]);
    expect(await wallet(c.id)).toEqual({ available: 30_000, held: 0 });
    expect(dealsWith(live, op.reference)).toHaveLength(1);
    await clean();
  });

  it("answers 202 well inside the app's 30 seconds when MT5 is too slow, and settles once MT5 has made the deal", async () => {
    const { c, login } = await clientWithLive(50_000);
    live.faults.next("/api/trade/balance", { delayMs: 11_000 });
    const started = Date.now();
    const res = await toMt5(c, login, 80);
    // The gateway stops waiting for MT5 after 10 seconds, before the CRM (20) and the app (30) do.
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(res.status).toBe(202);
    const op = await opByRef(res.body.data.id);
    expect(op).toMatchObject({ status: "unknown", failure: "timeout" });
    expect(await wallet(c.id)).toEqual({ available: 42_000, held: 8_000 });

    // MT5 makes the deal a moment later; the resolver's search finds it.
    await vi.waitFor(() => expect(dealsWith(live, op.reference)).toHaveLength(1), { timeout: 5_000, interval: 100 });
    await due(op.id);
    expect(await resolve()).toEqual({ ops: 1, accounts: 0 });
    expect(await opByRef(op.reference)).toMatchObject({ status: "completed", mt5_ticket: dealsWith(live, op.reference)[0]!.ticket });
    expect(await wallet(c.id)).toEqual({ available: 42_000, held: 0 });
    expect(live.state.users.get(login)!.balanceCents).toBe(8_000);
    await clean();
  }, 30_000);

  it("when MT5 opens an account but the answer is lost, answers 409, and the resolver finds it by its reference", async () => {
    const c = await makeClient();
    await fund(c.id, 50_000);
    live.faults.next("/api/user/add", { drop: "after" });
    const res = await createLive(c);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ message: CREATE_UNCONFIRMED });
    const row = (await one<Record<string, any>>(env.db, "SELECT * FROM mt5_accounts WHERE client_id = ?", [c.id]))!;
    expect(row).toMatchObject({ status: "unknown", login: null });
    const made = [...live.state.users.values()].find((u) => u.comment === row.create_ref)!;
    expect(made).toMatchObject({ group: STANDARD, email: c.email });

    // No second account while the first is unsettled.
    const again = await createLive(c);
    expect(again.status).toBe(422);
    expect(again.body.errors).toEqual({ is_demo: [STILL_SETTING_UP] });

    const adds = sent(live, "/api/user/add");
    await exec(env.db, "UPDATE mt5_accounts SET next_check_at = NULL WHERE id = ?", [row.id]);
    expect(await resolve()).toEqual({ ops: 0, accounts: 1 });
    expect(await accountRow("live", made.login)).toMatchObject({ id: row.id, status: "active" });
    expect((await list(c)).body.real_accounts.map((a: { login: string }) => a.login)).toEqual([String(made.login)]);
    expect(await resolve()).toEqual({ ops: 0, accounts: 0 });
    expect(sent(live, "/api/user/add")).toBe(adds);
  });

  // ---------- When the gateway cannot be trusted or reached ----------

  it("with the gateway stopped, every write is a definite 422 and nothing moves; once restarted it works again", async () => {
    const { c, login } = await clientWithLive(50_000);
    const second = await openLive(c);
    const { login: demoLogin } = await openDemo(c, 1000);
    expect((await toMt5(c, login, 100)).status).toBe(200);
    // A transfer on the second account whose answer was lost, still open.
    live.faults.next("/api/trade/balance", { drop: "after" });
    const lost = await opByRef((await toMt5(c, second.login, 50)).body.data.id);
    expect(lost.status).toBe("unknown");
    const before = { wallet: await wallet(c.id), reached: reached(), live: await accountRow("live", login) };

    await stopGateway();

    // Lists still answer, from the saved figures.
    await staleFigures();
    const shown = await list(c);
    expect(shown.status).toBe(200);
    expect(shown.body.real_accounts.find((a: { login: string }) => a.login === String(login))).toMatchObject({ balance: 100 });

    const wrote = {
      toMt5: await toMt5(c, login, 40),
      toWallet: await toWallet(c, login, 40),
      leverage: await change(c, login, "leverage", { leverage: "500" }),
      archive: await change(c, login, "inactive"),
      password: await change(c, login, "password", { password: NEW_MASTER, password_confirmation: NEW_MASTER }),
      create: await createLive(c),
    };
    for (const [what, res] of Object.entries(wrote)) {
      expect(res.status, what).toBe(422);
      expect(res.body, what).toEqual({ message: UNAVAILABLE, errors: { mt5: [UNAVAILABLE] } });
    }
    // The password change never reached MT5, so the kept one is still shown.
    expect((await list(c)).body.real_accounts.find((a: { login: string }) => a.login === String(login))).toMatchObject({ password: MASTER, investor_password: INVESTOR });
    const topped = await topUp(c, demoLogin, 10);
    expect(topped.status).toBe(422);
    expect(topped.body).toEqual({ message: UNAVAILABLE, errors: { mt5: [UNAVAILABLE] } });

    // Nothing reached MT5, nothing changed in the CRM, and the held money went back.
    expect(reached()).toBe(before.reached);
    expect(await wallet(c.id)).toEqual(before.wallet);
    expect(await accountRow("live", login)).toMatchObject({ leverage: before.live!.leverage, archived_at: null });
    const newest = await one<{ reference: string }>(env.db, "SELECT reference FROM mt5_balance_ops WHERE client_id = ? AND purpose = 'wallet_to_mt5' ORDER BY id DESC LIMIT 1", [c.id]);
    const failedOp = await opByRef(newest!.reference);
    expect(failedOp.amount_cents).toBe(4_000);
    expect(failedOp).toMatchObject({ status: "failed", failure: "unavailable" });
    expect(await kinds(failedOp.id)).toEqual(["transfer_hold", "transfer_release"]);
    expect(await one(env.db, "SELECT status, failure FROM mt5_accounts WHERE client_id = ? ORDER BY id DESC LIMIT 1", [c.id])).toEqual({ status: "failed", failure: "unavailable" });
    await clean();

    // The resolver cannot search either: the lost transfer stays open, and that does not count as a search.
    await due(lost.id);
    expect(await resolve()).toEqual({ ops: 1, accounts: 0 });
    const waiting = await opByRef(lost.reference);
    expect(waiting).toMatchObject({ status: "unknown", checks: 0 });
    soon(waiting.next_check_at, 60_000);

    // Back on the same port, the same CRM client works again.
    await startGateway(port);
    const lever = await change(c, login, "leverage", { leverage: "500" });
    expect(lever.status).toBe(200);
    expect(live.state.users.get(login)!.leverage).toBe(500);
    await due(lost.id);
    expect(await resolve()).toEqual({ ops: 1, accounts: 0 });
    expect(await opByRef(lost.reference)).toMatchObject({ status: "completed", mt5_ticket: dealsWith(live, lost.reference)[0]!.ticket });
    await clean();
  });

  it("trusts no answer when the CRM has the wrong secret: reads are unavailable, writes unconfirmed, and nothing reaches MT5", async () => {
    const { c, login } = await clientWithLive(50_000);
    expect((await toMt5(c, login, 100)).status).toBe(200);
    const wrong = httpGateway({ url: env.config.mt5Gateway!.url, secret: WRONG_SECRET, fetch, log: crmLog });
    const app = crmApp(wrong);
    const before = { reached: reached(), refused: logged(gatewayLines, GATEWAY_REFUSED), untrusted: logged(crmLines, CRM_UNTRUSTED) };

    // The list answers from the saved figures.
    await staleFigures();
    const shown = await list(c, app);
    expect(shown.status).toBe(200);
    expect(shown.body.real_accounts[0]).toMatchObject({ balance: 100 });
    // A read the transfer depends on cannot be trusted: a definite "not now".
    const out = await toWallet(c, login, 20, app);
    expect(out.status).toBe(422);
    expect(out.body.errors).toEqual({ mt5: [UNAVAILABLE] });
    // A write whose answer cannot be verified may have happened, as far as the CRM can tell.
    const lever = await change(c, login, "leverage", { leverage: "500" }, app);
    expect(lever.status).toBe(409);
    expect(lever.body).toEqual({ message: CHANGE_UNCONFIRMED });
    const pending = await toMt5(c, login, 60, app);
    expect(pending.status).toBe(202);
    const op = await opByRef(pending.body.data.id);
    expect(op).toMatchObject({ status: "unknown", failure: "bad_signature" });
    expect(await wallet(c.id)).toEqual({ available: 34_000, held: 6_000 });
    await clean();

    // The gateway refused every one of them before MT5 heard of it, and both sides said so in their logs.
    expect(reached()).toBe(before.reached);
    expect(live.state.users.get(login)).toMatchObject({ leverage: 2000, balanceCents: 10_000 });
    expect(logged(gatewayLines, GATEWAY_REFUSED)).toBeGreaterThan(before.refused + 3);
    expect(logged(crmLines, CRM_UNTRUSTED)).toBeGreaterThan(before.untrusted + 3);

    // Its resolver cannot search either: the transfer stays open and the search is not counted.
    await due(op.id);
    expect(await resolve(wrong)).toEqual({ ops: 1, accounts: 0 });
    expect(await opByRef(op.reference)).toMatchObject({ status: "unknown", checks: 0 });
    expect(reached()).toBe(before.reached);

    // With the right secret, MT5 has no such deal: after three searches, ten minutes on, the money comes back.
    await exec(env.db, "UPDATE mt5_balance_ops SET created_at = created_at - INTERVAL 11 MINUTE WHERE id = ?", [op.id]);
    for (let i = 0; i < 3; i++) {
      await due(op.id);
      expect(await resolve()).toEqual({ ops: 1, accounts: 0 });
    }
    expect(await opByRef(op.reference)).toMatchObject({ status: "failed", failure: "not_found", client_message: TO_MT5_FAILED });
    expect(await kinds(op.id)).toEqual(["transfer_hold", "transfer_release"]);
    expect(await wallet(c.id)).toEqual({ available: 40_000, held: 0 });
    expect(dealsWith(live, op.reference)).toHaveLength(0);
    // Aged ten minutes back, it is no longer the newest row.
    expect((await history(c)).body.data.find((t: { id: string }) => t.id === op.reference)).toMatchObject({ status: "rejected", message: TO_MT5_FAILED });
    await clean();
  });

  // ---------- What the whole run must never do ----------

  it("left no password or secret in either log, the audit log or the MT5 tables, and every session was signed in", async () => {
    for (const fake of [live, demo]) {
      expect(fake.state.unauthenticated).toBe(0);
      expect(fake.state.groupChanges).toBe(0);
      // One write at a time per login (per group for opening accounts), whatever the CRM sent at once.
      expect(fake.state.maxWritesInFlight).toBe(1);
    }
    expect(generated).toHaveLength(1);
    const secrets = [SECRET, WRONG_SECRET, LIVE_MANAGER, DEMO_MANAGER, MASTER, INVESTOR, NEW_MASTER, NEW_INVESTOR, OTHER_INVESTOR, ...generated];
    const logs = gatewayLines.join("") + crmLines.join("");
    expect(gatewayLines.length).toBeGreaterThan(0);
    expect(crmLines.length).toBeGreaterThan(0);
    const stored = JSON.stringify([
      await rows(env.db, "SELECT * FROM audit_log"),
      await rows(env.db, "SELECT * FROM mt5_accounts"),
      await rows(env.db, "SELECT * FROM mt5_balance_ops"),
      await rows(env.db, "SELECT * FROM client_notifications"),
      // Kept passwords are sealed: none of them reads as itself.
      (await rows<{ sealed: Buffer }>(env.db, "SELECT * FROM mt5_account_passwords")).map((r) => r.sealed.toString("latin1")),
    ]);
    for (const secret of secrets) {
      expect(logs).not.toContain(secret);
      expect(stored).not.toContain(secret);
    }
    expect((await verifyAuditChain(env.db)).ok).toBe(true);
    await clean();
  });
});
