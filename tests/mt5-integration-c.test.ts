import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import pino from "pino";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { activeRun } from "../src/server/mt5/reconcile";
import { resolveMt5Once } from "../src/server/mt5/resolver";
import { startFakeMt5, type FakeDeal, type FakeMt5 } from "./fakes/mt5-webapi";
import { createStaff, hasDb, post, setup, signIn, stepUp, type SignedIn, type TestEnv } from "./helpers";

// Round C along the whole path as it runs in production: the CRM app with
// the real httpGateway, the real gateway server, and two fake MT5 servers
// (live three hours ahead of UTC and answering five deals a page, demo five
// hours behind) over TLS with the certificate pin and the real sign-in.
// Trade history built from MT5's deals and paged by the client, staff
// balance and credit changes made by two people, and a reconciliation run,
// each checked where the two sides could disagree about a shape, a time, an
// action or a comment.

const SECRET = `crm-gw-c-${randomBytes(16).toString("hex")}`;
const LIVE_MANAGER = "Live-Manager-1!";
const DEMO_MANAGER = "Demo-Manager-2!";
const MASTER = "Trade-Me-42!";
const INVESTOR = "Look+Only&7?";
const STANDARD = "real\\standard";
const DEMO_GROUP = "demo\\usd";
const NOTE = "Agreed with the dealing desk after a review";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const WRITE_PATHS = new Set(["/api/user/add", "/api/user/update", "/api/user/change_password", "/api/trade/balance"]);

interface Client {
  id: number;
  token: string;
}
/** An open account as the CRM made it, and the MT5 server it is on. */
interface Acct {
  id: number;
  login: number;
  fake: FakeMt5;
  /** That server's clock minus UTC, in minutes. */
  tz: number;
}

describe.skipIf(!hasDb)("MT5 round C end to end: trade history, staff changes and reconciliation over the gateway and MT5", () => {
  let env: TestEnv;
  let live: FakeMt5;
  let demo: FakeMt5;
  let gateway: GatewayServer;
  let mt5: Mt5Gateway;
  let ann: SignedIn;
  let ben: SignedIn;
  let classic = 0;
  let depositMethod = 0;
  let seq = 0;
  let position = 4_400_000;
  /** Issue keys the tests planted in MT5 on purpose: a reconciliation run must find exactly these. */
  const planted = new Map<string, string>();

  const gatewayLines: string[] = [];
  const crmLines: string[] = [];
  const crmLog = pino({ level: "debug" }, { write: (line: string) => void crmLines.push(line) });
  const iso = (ms: number) => new Date(ms).toISOString();

  async function makeClient(): Promise<Client> {
    seq++;
    const r = await exec(
      env.db,
      "INSERT INTO clients (email, first_name, last_name, referral_code, source, kyc_status, status, country) VALUES (?, 'Noor', ?, ?, 'portal', 'approved', 'active', 'Pakistan')",
      [`e2e.c.${seq}@client.test`, `Client${seq}`, `IC${String(seq).padStart(8, "0")}`],
    );
    const { token } = await transaction(env.db, (conn) => createClientSession(conn, env.config, r.insertId, "127.0.0.1", "vitest"));
    return { id: r.insertId, token };
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

  const api = () => request(env.app);
  const bearer = (c: Client) => ({ Authorization: `Bearer ${c.token}` });
  const accountId = async (server: string, login: number) =>
    Number((await one<{ id: number }>(env.db, "SELECT id FROM mt5_accounts WHERE server_code = ? AND login = ?", [server, login]))!.id);

  /** A live account opened through the client API, as the portal does. */
  async function openLive(c: Client): Promise<Acct> {
    const res = await api().post("/api/mt5-accounts").set(bearer(c))
      .send({ is_demo: false, account_package_id: classic, leverage: "2000", currency: "usd", password: MASTER, investor_password: INVESTOR });
    expect(res.status).toBe(200);
    const login = Number(res.body.account.login);
    return { id: await accountId("live", login), login, fake: live, tz: 180 };
  }

  async function openDemo(c: Client, amount = 1000): Promise<Acct> {
    const res = await api().post("/api/mt5-accounts").set(bearer(c)).send({ is_demo: true, demo_amount: amount, leverage: "2000", password: MASTER, investor_password: INVESTOR });
    expect(res.status).toBe(200);
    const login = Number(res.body.account.login);
    return { id: await accountId("demo", login), login, fake: demo, tz: -300 };
  }

  /** A deal in MT5 at a UTC time, dated on that trade server's own clock as MT5 does. */
  const addDeal = (a: Acct, at: number, d: Partial<FakeDeal>) => a.fake.addDeal({ ...d, login: a.login, time: Math.floor(at / 1000) + a.tz * 60 });

  /** A position opened and closed in full by one deal each. */
  function trade(a: Acct, t: { position?: number; openAt: number; closeAt: number; profitCents: number }) {
    const id = t.position ?? ++position;
    addDeal(a, t.openAt, { action: 0, entry: 0, positionId: id, symbol: "EURUSD", volume: 10_000, price: "1.08500" });
    addDeal(a, t.closeAt, { action: 1, entry: 1, positionId: id, symbol: "EURUSD", volume: 10_000, price: "1.08750", profitCents: t.profitCents });
    return id;
  }

  const history = (c: Client, query = "") => api().get(`/api/trade-history${query}`).set(bearer(c));
  const ids = (res: request.Response) => res.body.trades.map((t: { id: string }) => t.id);
  /** Dates the last sync back, so the next first page of history syncs again. */
  const stale = (...accounts: Acct[]) =>
    exec(env.db, `UPDATE mt5_accounts SET deals_synced_at = deals_synced_at - INTERVAL 2 MINUTE WHERE id IN (${accounts.map(() => "?").join(", ")})`, accounts.map((a) => a.id));
  const dealReads = () => [live, demo].reduce((n, f) => n + f.state.requests.filter((r) => r.path === "/api/deal/get_total" || r.path === "/api/deal/get_page").length, 0);
  const writes = () => [live, demo].reduce((n, f) => n + f.state.requests.filter((r) => WRITE_PATHS.has(r.path)).length, 0);
  const balanceSends = () => live.state.requests.filter((r) => r.path === "/api/trade/balance").length;
  const dealsWith = (comment: string) => live.state.deals.filter((d) => d.comment === comment).map((d) => ({ ticket: d.ticket, action: d.action, profitCents: d.profitCents }));

  /** The gateway's own record of the balance or credit write it sent for this reference. */
  const gatewayWrite = (comment: string) =>
    gatewayLines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.msg === "MT5 write" && l.op === "balance" && l.comment === comment);
  const ask = (s: SignedIn, a: Acct, kind: string, amountCents: number) => post(s, `/api/staff/mt5/accounts/${a.id}/adjustments`, { kind, amountCents, reasonCode: "compensation", note: NOTE });
  const approve = (s: SignedIn, opId: number) => post(s, `/api/staff/mt5/operations/${opId}/approve`);
  const op = (id: number) => one<Record<string, any>>(env.db, "SELECT * FROM mt5_balance_ops WHERE id = ?", [id]);
  const kinds = async (opId: number) =>
    (await rows<{ kind: string }>(env.db, "SELECT kind FROM ledger_transactions WHERE source_type = 'mt5_op' AND source_id = ? ORDER BY id", [opId])).map((r) => r.kind);
  const audits = (action: string, opId: number) =>
    rows<Record<string, any>>(env.db, "SELECT * FROM audit_log WHERE action = ? AND JSON_EXTRACT(meta_json, '$.opId') = ? ORDER BY id", [action, opId]);
  const clean = async () => expect(await verifyLedger(env.db)).toEqual([]);

  beforeAll(async () => {
    live = await startFakeMt5({ managers: { 9000: LIVE_MANAGER }, tzOffsetMinutes: 180, pageLimit: 5 });
    demo = await startFakeMt5({ managers: { 9100: DEMO_MANAGER }, tzOffsetMinutes: -300, firstLogin: 7_000_001 });
    gateway = createGatewayServer(
      loadGatewayConfig({
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
      }),
      { log: createGatewayLogger("debug", { write: (line: string) => void gatewayLines.push(line) }), pingIntervalMs: 0 },
    );
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    const port = (gateway.address() as AddressInfo).port;
    env = await setup({ CRM_MT5_GATEWAY_URL: `http://127.0.0.1:${port}`, CRM_MT5_GATEWAY_SECRET: SECRET });
    const { url, secret } = env.config.mt5Gateway!;
    mt5 = httpGateway({ url, secret, fetch, log: crmLog });
    env.app = createApp({ db: env.db, config: env.config, log: crmLog, fetch: (async () => new Response("", { status: 503 })) as typeof fetch, mt5 });

    await exec(env.db, "INSERT INTO mt5_servers (code, label, is_enabled) VALUES ('live', 'Live', 1), ('demo', 'Demo', 1)");
    await exec(env.db, "UPDATE mt5_settings SET demo_server_code = 'demo', demo_group = ?, leverages = '2000,500,100' WHERE id = 1", [DEMO_GROUP]);
    classic = (await exec(env.db, "INSERT INTO account_packages (name, spread_label, min_deposit_cents, server_code, mt5_group) VALUES ('Classic', '1.2', 0, 'live', ?)", [STANDARD])).insertId;
    depositMethod = (
      await exec(env.db, "INSERT INTO payment_methods (direction, kind, name, currency, network, bank_name, account_title, account_number, wallet_address, ask_qr) VALUES ('deposit', 'bank', 'Bank', 'USD', '', 'Bank', 'BIS Markets', '0101', '', 0)")
    ).insertId;
    // Finance Managers ask for and approve balance and credit changes (Admins do not), and run reconciliation.
    await createStaff(env.db, "ann.c@crm.test", "finance_manager");
    await createStaff(env.db, "ben.c@crm.test", "finance_manager");
    ann = await signIn(env, "ann.c@crm.test");
    ben = await signIn(env, "ben.c@crm.test");
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => gateway?.close(() => resolve()));
    await live?.close();
    await demo?.close();
    await env?.db.end();
  });

  beforeEach(async () => {
    // Whatever an earlier test left open is settled the proper way, so each test starts clean.
    for (const o of await rows<{ id: number }>(env.db, "SELECT id FROM mt5_balance_ops WHERE status IN ('sending', 'unknown')")) {
      await settleBalanceOp(env.db, Number(o.id), { status: "failed", failure: "test", clientMessage: "test" });
    }
    await exec(env.db, "UPDATE mt5_accounts SET status = 'failed', failure = 'test' WHERE status IN ('creating', 'unknown')");
    await stepUp(env, ann);
    await stepUp(env, ben);
  });
  afterEach(() => {
    live.faults.clear();
    demo.faults.clear();
  });

  // ---------- Trade history ----------

  it("builds closed trades from MT5's deals: a full close, a partial close once the rest closes, a netting reversal and the part it opened, never a balance or credit deal", async () => {
    const c = await makeClient();
    const a = await openLive(c);
    const t = Math.floor((Date.now() - 7 * HOUR) / MINUTE) * MINUTE;

    // Bought and sold a lot.
    const full = ++position;
    addDeal(a, t, { action: 0, entry: 0, positionId: full, symbol: "EURUSD", volume: 10_000, price: "1.08500", commissionCents: -300 });
    addDeal(a, t + 20 * MINUTE, { action: 1, entry: 1, positionId: full, symbol: "EURUSD", volume: 10_000, price: "1.08750", profitCents: 2_500, commissionCents: -300, swapCents: -45 });
    // Sold two lots, bought half a lot back: not closed yet.
    const partial = ++position;
    addDeal(a, t + HOUR, { action: 1, entry: 0, positionId: partial, symbol: "USDJPY", volume: 20_000, price: "150.120" });
    addDeal(a, t + HOUR + 10 * MINUTE, { action: 0, entry: 1, positionId: partial, symbol: "USDJPY", volume: 5_000, price: "150.000", profitCents: 4_000 });
    // Netting: bought 1.5 lots in two deals, then sold two lots, which closed the 1.5 and opened half a lot sold.
    const netted = ++position;
    addDeal(a, t + 2 * HOUR, { action: 0, entry: 0, positionId: netted, symbol: "GBPUSD", volume: 10_000, price: "1.10000" });
    addDeal(a, t + 2 * HOUR + MINUTE, { action: 0, entry: 0, positionId: netted, symbol: "GBPUSD", volume: 5_000, price: "1.10030" });
    const reversal = addDeal(a, t + 3 * HOUR, { action: 1, entry: 2, positionId: netted, symbol: "GBPUSD", volume: 20_000, price: "1.10200", profitCents: 2_850 });
    // Money in and credit, made at the broker's desk: never trades (and, made outside the CRM, reconciliation reports them).
    const deposit = addDeal(a, t + 4 * HOUR, { action: 2, profitCents: 50_000, comment: "Deposit at desk" });
    const credit = addDeal(a, t + 4 * HOUR + MINUTE, { action: 3, profitCents: 10_000, comment: "Bonus credit" });
    planted.set(`external_balance_deal:live:${deposit.ticket}`, "warning");
    planted.set(`external_balance_deal:live:${credit.ticket}`, "warning");

    const res = await history(c);
    expect(res.status).toBe(200);
    const L = String(a.login);
    expect(res.body.trades).toEqual([
      expect.objectContaining({ id: `${L}-${netted}`, ticket: netted, symbol: "GBPUSD", side: 0, type: "buy", volume: 1.5, open_price: 1.1001, close_price: 1.102, pnl: 28.5, closed_at: iso(t + 3 * HOUR) }),
      {
        id: `${L}-${full}`, ticket: full, symbol: "EURUSD", side: 0, type: "buy", volume: 1, open_price: 1.085, close_price: 1.0875, pnl: 25, profit: 25, commission: -6,
        swap: -0.45, currency: "USD", account: L, login: L, status: "closed", opened_at: iso(t), closed_at: iso(t + 20 * MINUTE),
      },
    ]);
    expect(res.body.summary).toEqual({ total_trades: 2, total_profit: 53.5, total_volume: 2.5, total_commission: -6 });
    expect(res.body.pagination).toEqual({ current_page: 1, per_page: 100, total: 2, last_page: 1 });
    // The cache has every deal, the desk's included, with MT5's action and comment.
    const cached = await rows<{ ticket: number; action: number; comment: string; profit_cents: number }>(
      env.db, "SELECT ticket, action, comment, profit_cents FROM mt5_deals WHERE mt5_account_id = ? AND action >= 2 ORDER BY ticket", [a.id],
    );
    expect(cached.map((d) => ({ ...d, ticket: Number(d.ticket), profit_cents: Number(d.profit_cents) }))).toEqual([
      { ticket: deposit.ticket, action: 2, comment: "Deposit at desk", profit_cents: 50_000 },
      { ticket: credit.ticket, action: 3, comment: "Bonus credit", profit_cents: 10_000 },
    ]);
    expect(Number((await one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM mt5_deals WHERE mt5_account_id = ?", [a.id]))!.n)).toBe(9);

    // The rest of the partial close, and the reversed half-lot closing under the same position id.
    addDeal(a, t + 5 * HOUR, { action: 0, entry: 1, positionId: partial, symbol: "USDJPY", volume: 15_000, price: "149.900", profitCents: 22_015 });
    addDeal(a, t + 5 * HOUR + 30 * MINUTE, { action: 0, entry: 1, positionId: netted, symbol: "GBPUSD", volume: 5_000, price: "1.10100", profitCents: 500 });
    await stale(a);
    const after = await history(c);
    expect(ids(after)).toEqual([`${L}-${netted}-r${reversal.ticket}`, `${L}-${partial}`, `${L}-${netted}`, `${L}-${full}`]);
    expect(after.body.trades[1]).toMatchObject({
      symbol: "USDJPY", side: 1, type: "sell", volume: 2, open_price: 150.12, close_price: 149.9, pnl: 260.15, opened_at: iso(t + HOUR), closed_at: iso(t + 5 * HOUR),
    });
    // The reversed half-lot is a trade of its own under the same position: sold at the reversal's price and time, closed by the later buy.
    expect(after.body.trades[0]).toMatchObject({
      ticket: netted, symbol: "GBPUSD", side: 1, type: "sell", volume: 0.5, open_price: 1.102, close_price: 1.101, pnl: 5, opened_at: iso(t + 3 * HOUR), closed_at: iso(t + 5 * HOUR + 30 * MINUTE),
    });
    // The part the reversal closed is as it was.
    expect(after.body.trades[2]).toEqual(res.body.trades[0]);
    expect(after.body.summary).toEqual({ total_trades: 4, total_profit: 318.65, total_volume: 5, total_commission: -6 });
    // Nothing of MT5's own text, groups, servers or the desk's comments reaches the client.
    expect(JSON.stringify(after.body)).not.toMatch(/desk|bonus|BIS-|standard|group|server/i);
  });

  it("pages GET /api/trade-history exactly over two trade servers, and only the first page syncs", async () => {
    const c = await makeClient();
    const a = await openLive(c);
    const d = await openDemo(c);
    const base = Math.floor((Date.now() - 20 * HOUR) / MINUTE) * MINUTE;
    // Four on live and three on demo; the demo ones close at the same UTC moment as a live one, with the same
    // position id, though the two servers' clocks are eight hours apart.
    const p = position + 1;
    position += 10;
    for (let i = 0; i < 4; i++) trade(a, { position: p + i, openAt: base + i * 2 * HOUR, closeAt: base + i * 2 * HOUR + 30 * MINUTE, profitCents: 100 * (i + 1) });
    for (let i = 0; i < 3; i++) trade(d, { position: p + i, openAt: base + i * 2 * HOUR + 5 * MINUTE, closeAt: base + i * 2 * HOUR + 30 * MINUTE, profitCents: -50 });
    const L = (i: number) => `${a.login}-${p + i}`;
    const D = (i: number) => `${d.login}-${p + i}`;
    // Newest close first; a tie on time and position goes to the newer account.
    const order = [L(3), D(2), L(2), D(1), L(1), D(0), L(0)];

    const summary = { total_trades: 7, total_profit: 8.5, total_volume: 7, total_commission: 0 };
    const pages = [await history(c, "?per_page=3"), await history(c, "?page=2&per_page=3"), await history(c, "?page=3&per_page=3"), await history(c, "?page=4&per_page=3")];
    expect(pages.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(pages.map((r) => r.body.pagination)).toEqual([1, 2, 3, 4].map((n) => ({ current_page: n, per_page: 3, total: 7, last_page: 3 })));
    expect(pages.map(ids)).toEqual([order.slice(0, 3), order.slice(3, 6), order.slice(6), []]);
    for (const r of pages) {
      expect(r.body.summary).toEqual(summary);
      expect(r.body.filters).toEqual({ from_date: null, to_date: null, account_id: null });
    }
    // The tied pair: the same UTC close time from servers whose clocks disagree.
    expect(pages[0]!.body.trades[1].closed_at).toBe(pages[0]!.body.trades[2].closed_at);

    // The portal's one big page is not cut to 15, and odd sizes are clamped, never reset.
    expect((await history(c, "?per_page=500")).body).toMatchObject({ pagination: { current_page: 1, per_page: 500, total: 7, last_page: 1 } });
    expect(ids(await history(c, "?per_page=500"))).toEqual(order);
    expect((await history(c, "?per_page=9000")).body.pagination).toEqual({ current_page: 1, per_page: 500, total: 7, last_page: 1 });
    expect((await history(c, "?per_page=0")).body.pagination).toEqual({ current_page: 1, per_page: 1, total: 7, last_page: 7 });
    expect((await history(c, "?per_page=lots&page=x")).body.pagination).toEqual({ current_page: 1, per_page: 100, total: 7, last_page: 1 });
    const demoOnly = await history(c, `?account_id=${d.login}&per_page=2`);
    expect(demoOnly.body).toMatchObject({ filters: { account_id: String(d.login) }, pagination: { total: 3, last_page: 2 } });
    expect(ids(demoOnly)).toEqual([D(2), D(1)]);
    expect((await history(c, `?account_id=${a.login + 99}`)).body).toMatchObject({ trades: [], summary: { total_trades: 0 }, pagination: { total: 0, last_page: 1 } });

    // A trade closes in MT5 while the client pages: page 2 reads the cache as it was, and asks MT5 nothing.
    trade(a, { position: p + 4, openAt: base + 8 * HOUR, closeAt: base + 8 * HOUR + 30 * MINUTE, profitCents: 500 });
    await stale(a, d);
    const reads = dealReads();
    const second = await history(c, "?page=2&per_page=3");
    expect(second.body.pagination).toEqual({ current_page: 2, per_page: 3, total: 7, last_page: 3 });
    expect(ids(second)).toEqual(order.slice(3, 6));
    expect(dealReads()).toBe(reads);
    // The next first page syncs both accounts through the gateway and shows it.
    const first = await history(c, "?per_page=3");
    expect(dealReads()).toBeGreaterThan(reads);
    expect(first.body.pagination).toEqual({ current_page: 1, per_page: 3, total: 8, last_page: 3 });
    expect(ids(first)).toEqual([L(4), L(3), D(2)]);
    expect(first.body.summary).toMatchObject({ total_trades: 8, total_profit: 13.5 });
  });

  it("answers the first page within its 4 seconds when MT5 is slow, from the cache as it was, and the next page agrees with it", async () => {
    const c = await makeClient();
    const a = await openLive(c);
    const t = Math.floor((Date.now() - 5 * HOUR) / MINUTE) * MINUTE;
    trade(a, { openAt: t, closeAt: t + 10 * MINUTE, profitCents: 300 });
    trade(a, { openAt: t + HOUR, closeAt: t + HOUR + 10 * MINUTE, profitCents: 300 });
    expect((await history(c, "?per_page=1")).body.pagination.total).toBe(2);

    trade(a, { openAt: t + 2 * HOUR, closeAt: t + 2 * HOUR + 10 * MINUTE, profitCents: 300 });
    await stale(a);
    // MT5 takes 6 seconds over the count, inside the gateway's 7 for a read, so the sync gets its page late.
    live.faults.next("/api/deal/get_total", { delayMs: 6_000 });
    const started = Date.now();
    const first = await history(c, "?per_page=1");
    expect(Date.now() - started).toBeLessThan(5_500);
    expect(first.body.pagination).toEqual({ current_page: 1, per_page: 1, total: 2, last_page: 2 });
    // The late page is not stored once the client has its first page, so the second page has the same total.
    const syncState = async () => (await ann.agent.get(`/api/staff/mt5/accounts/${a.id}/trades`)).body.sync;
    await vi.waitFor(async () => expect((await syncState()).running).toBe(false), { timeout: 10_000, interval: 250 });
    expect((await history(c, "?page=2&per_page=1")).body.pagination).toEqual({ current_page: 2, per_page: 1, total: 2, last_page: 2 });
    expect(Number((await one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM mt5_deals WHERE mt5_account_id = ?", [a.id]))!.n)).toBe(4);
    // The next first page reads it.
    await stale(a);
    expect((await history(c, "?per_page=1")).body.pagination).toEqual({ current_page: 1, per_page: 1, total: 3, last_page: 3 });
    expect(await syncState()).toMatchObject({ error: null, partial: false, running: false });
  }, 30_000);

  // ---------- Staff balance and credit changes ----------

  it("makes a credit and a balance change in MT5 only once a second person approves, as one deal of the right action and comment", async () => {
    const c = await makeClient();
    const a = await openLive(c);
    const sends = balanceSends();

    const asked = await ask(ann, a, "credit_in", 5_000);
    expect(asked.status).toBe(201);
    expect(asked.body.operation).toMatchObject({ status: "awaiting_approval", purpose: "staff_credit_in", amountCents: 5_000 });
    const creditRef = asked.body.operation.reference as string;
    expect(creditRef).toMatch(/^BIS-S[0-9A-Z]{8}$/);
    // Asked for, not sent; and the person who asked cannot approve it.
    expect(balanceSends()).toBe(sends);
    expect((await approve(ann, asked.body.operation.id)).body.error).toMatchObject({ code: "SAME_PERSON" });
    expect(balanceSends()).toBe(sends);

    const credited = await approve(ben, asked.body.operation.id);
    expect(credited.status).toBe(200);
    expect(credited.body.operation).toMatchObject({ status: "completed" });
    expect(dealsWith(creditRef)).toEqual([{ ticket: credited.body.operation.ticket, action: 3, profitCents: 5_000 }]);
    expect(live.state.users.get(a.login)).toMatchObject({ creditCents: 5_000, balanceCents: 0 });
    expect(balanceSends()).toBe(sends + 1);
    expect(await kinds(asked.body.operation.id)).toEqual([]);

    const balanceIn = await ask(ann, a, "balance_in", 9_000);
    const inRef = balanceIn.body.operation.reference as string;
    const done = await approve(ben, balanceIn.body.operation.id);
    expect(done.status).toBe(200);
    expect(dealsWith(inRef)).toEqual([{ ticket: done.body.operation.ticket, action: 2, profitCents: 9_000 }]);
    expect(await kinds(balanceIn.body.operation.id)).toEqual(["mt5_adjust_in"]);
    expect(live.state.users.get(a.login)).toMatchObject({ creditCents: 5_000, balanceCents: 9_000 });

    // Money out: MT5 is asked with its margin check, after the limits were checked again on MT5's figures.
    const out = await ask(ann, a, "balance_out", 2_500);
    const outRef = out.body.operation.reference as string;
    const taken = await approve(ben, out.body.operation.id);
    expect(taken.status).toBe(200);
    expect(dealsWith(outRef)).toEqual([{ ticket: taken.body.operation.ticket, action: 2, profitCents: -2_500 }]);
    expect(await kinds(out.body.operation.id)).toEqual(["mt5_adjust_out"]);
    expect(live.state.users.get(a.login)).toMatchObject({ creditCents: 5_000, balanceCents: 6_500 });
    expect(balanceSends()).toBe(sends + 3);
    // As the gateway sent them: credit as a credit deal, and only money out with MT5's margin check.
    expect(gatewayWrite(creditRef)).toEqual([expect.objectContaining({ type: "credit", login: a.login, amountCents: 5_000, checkMargin: false, outcome: "ok", ticket: credited.body.operation.ticket })]);
    expect(gatewayWrite(inRef)).toEqual([expect.objectContaining({ type: "balance", amountCents: 9_000, checkMargin: false, outcome: "ok" })]);
    expect(gatewayWrite(outRef)).toEqual([expect.objectContaining({ type: "balance", amountCents: -2_500, checkMargin: true, outcome: "ok" })]);
    await clean();

    // The client hears of each change with the login and amount only, never the reference or the reason.
    const bell = await rows<{ title: string; body: string }>(env.db, "SELECT title, body FROM client_notifications WHERE client_id = ? ORDER BY id", [c.id]);
    expect(bell.map((n) => n.body)).toEqual([
      `$50.00 of credit was added to your MT5 account ${a.login}.`,
      `Your MT5 account ${a.login} was credited $90.00.`,
      `Your MT5 account ${a.login} was debited $25.00.`,
    ]);
    expect(JSON.stringify(bell)).not.toMatch(/BIS-|compensation|dealing desk/i);

    // Staff's sync brings the three deals into the cache with MT5's action and comment; none is a trade.
    const synced = await post(ann, `/api/staff/mt5/accounts/${a.id}/sync-deals`);
    expect(synced.status).toBe(200);
    expect(synced.body.result).toMatchObject({ outcome: "complete", newDeals: 3, trades: 0, error: null });
    const cached = await rows<{ action: number; comment: string; profit_cents: number }>(env.db, "SELECT action, comment, profit_cents FROM mt5_deals WHERE mt5_account_id = ? ORDER BY ticket", [a.id]);
    expect(cached.map((r) => ({ ...r, profit_cents: Number(r.profit_cents) }))).toEqual([
      { action: 3, comment: creditRef, profit_cents: 5_000 },
      { action: 2, comment: inRef, profit_cents: 9_000 },
      { action: 2, comment: outRef, profit_cents: -2_500 },
    ]);
    expect((await ann.agent.get(`/api/staff/mt5/accounts/${a.id}/trades`)).body).toMatchObject({ total: 0, items: [] });
    expect((await history(c)).body.pagination.total).toBe(0);
  });

  it("when the answer to an approved balance change is lost, answers 202 and one resolver pass completes it exactly once", async () => {
    const c = await makeClient();
    const a = await openLive(c);
    const asked = await ask(ann, a, "balance_in", 7_000);
    expect(asked.status).toBe(201);
    const opId = asked.body.operation.id as number;
    const reference = asked.body.operation.reference as string;

    live.faults.next("/api/trade/balance", { drop: "after" });
    const lost = await approve(ben, opId);
    expect(lost.status).toBe(202);
    expect(lost.body.operation).toMatchObject({ status: "unknown", failure: "connection" });
    // MT5 made it; the CRM has not counted it yet.
    expect(dealsWith(reference)).toEqual([{ ticket: expect.any(Number), action: 2, profitCents: 7_000 }]);
    expect(live.state.users.get(a.login)!.balanceCents).toBe(7_000);
    expect(await kinds(opId)).toEqual([]);
    expect(await audits("mt5.adjustment.completed", opId)).toHaveLength(0);
    await clean();

    const sends = balanceSends();
    await exec(env.db, "UPDATE mt5_balance_ops SET next_check_at = NULL WHERE id = ?", [opId]);
    expect(await resolveMt5Once(env.db, mt5, crmLog)).toEqual({ ops: 1, accounts: 0 });
    expect(await op(opId)).toMatchObject({ status: "completed", failure: null, next_check_at: null });
    expect(Number((await op(opId))!.mt5_ticket)).toBe(dealsWith(reference)[0]!.ticket);
    expect(await kinds(opId)).toEqual(["mt5_adjust_in"]);
    expect(await audits("mt5.adjustment.completed", opId)).toEqual([expect.objectContaining({ actor_type: "system" })]);
    await clean();

    // A second pass has nothing to do; the resolver only searched, and MT5 has the deal once.
    expect(await resolveMt5Once(env.db, mt5, crmLog)).toEqual({ ops: 0, accounts: 0 });
    expect(await kinds(opId)).toEqual(["mt5_adjust_in"]);
    expect(await audits("mt5.adjustment.completed", opId)).toHaveLength(1);
    expect(balanceSends()).toBe(sends);
    expect(dealsWith(reference)).toHaveLength(1);
    expect(live.state.users.get(a.login)!.balanceCents).toBe(7_000);
    expect(Number((await one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM client_notifications WHERE client_id = ?", [c.id]))!.n)).toBe(1);
    await clean();
  });

  // ---------- Reconciliation ----------

  it("reconciles: finds a balance deal made outside the CRM and MT5 accounts no CRM row has, and nothing false", async () => {
    // A clean client: transfers both ways, a trade, a demo account and its starting balance.
    const c = await makeClient();
    await fund(c.id, 50_000);
    const a = await openLive(c);
    const d = await openDemo(c, 2_500);
    const toMt5 = await api().post("/api/transfer/wallet-to-mt5").set(bearer(c)).send({ mt5_account_id: String(a.login), amount: 300 });
    expect(toMt5.status).toBe(200);
    const toWallet = await api().post("/api/transfer/mt5-to-wallet").set(bearer(c)).send({ mt5_account_id: String(a.login), amount: 100 });
    expect(toWallet.status).toBe(200);
    trade(a, { openAt: Date.now() - 3 * HOUR, closeAt: Date.now() - 2 * HOUR, profitCents: 1_200 });

    // Another client's account, topped up at the broker's desk.
    const other = await openLive(await makeClient());
    const desk = addDeal(other, Date.now() - HOUR, { action: 2, profitCents: 25_000, comment: "Deposit at desk" });
    planted.set(`external_balance_deal:live:${desk.ticket}`, "warning");
    // Accounts opened in MT5 by hand in the package's group and the demo group; one in a group the CRM does not use is not its business.
    const lone = live.addUser({ group: STANDARD });
    const loneDemo = demo.addUser({ group: DEMO_GROUP });
    live.addUser({ group: "real\\vip" });
    planted.set(`unlinked_mt5_account:live:${lone.login}`, "warning");
    planted.set(`unlinked_mt5_account:demo:${loneDemo.login}`, "info");

    const before = writes();
    const started = await post(ann, "/api/staff/mt5/reconciliation/runs");
    expect(started.status).toBe(202);
    expect(started.body.run).toMatchObject({ kind: "manual", status: "running", startedBy: { id: ann.staffId } });
    const run = (await activeRun())!;
    expect(run).toMatchObject({ id: started.body.run.id, status: "done", error: null, notes: null, critical_found: 0 });
    // Every open account was read from MT5, and the run wrote nothing to it.
    const accounts = Number((await one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM mt5_accounts WHERE status = 'active'"))!.n);
    expect(run).toMatchObject({ accounts_total: accounts, accounts_checked: accounts, issues_found: planted.size, issues_new: planted.size });
    expect(writes()).toBe(before);

    // Exactly what was planted, at its severity: nothing on the clean client, the staff changes or the trades.
    const open = await rows<{ issue_key: string; severity: string }>(env.db, "SELECT issue_key, severity FROM mt5_recon_issues WHERE status = 'open' ORDER BY issue_key");
    expect(open.map((i) => [i.issue_key, i.severity])).toEqual([...planted].sort(([x], [y]) => (x < y ? -1 : 1)));
    // Nothing found because each was looked at, not skipped: every completed operation in this file matched its own deal in the cache.
    const unchecked = await rows<{ id: number; reference: string; outcome: string | null }>(
      env.db,
      "SELECT o.id, o.reference, k.outcome FROM mt5_balance_ops o LEFT JOIN mt5_recon_op_checks k ON k.op_id = o.id WHERE o.status = 'completed' AND (k.outcome IS NULL OR k.outcome <> 'matched')",
    );
    expect(unchecked).toEqual([]);
    const mine = await rows<{ mt5_account_id: number; purpose: string; outcome: string; deal_tickets: number[]; mt5_ticket: number }>(
      env.db,
      "SELECT o.mt5_account_id, o.purpose, k.outcome, k.deal_tickets, o.mt5_ticket FROM mt5_balance_ops o JOIN mt5_recon_op_checks k ON k.op_id = o.id WHERE o.client_id = ? ORDER BY o.id",
      [c.id],
    );
    expect(mine.map((m) => [Number(m.mt5_account_id), m.purpose, m.outcome, m.deal_tickets])).toEqual([
      [d.id, "demo_funding", "matched", [Number(mine[0]!.mt5_ticket)]],
      [a.id, "wallet_to_mt5", "matched", [Number(mine[1]!.mt5_ticket)]],
      [a.id, "mt5_to_wallet", "matched", [Number(mine[2]!.mt5_ticket)]],
    ]);

    // As staff read it: MT5's facts about the deal, for the account it is on.
    const issues = await ben.agent.get(`/api/staff/mt5/reconciliation/issues?runId=${run.id}&kind=external_balance_deal&accountId=${other.id}`);
    expect(issues.status).toBe(200);
    expect(issues.body.items).toEqual([
      expect.objectContaining({
        key: `external_balance_deal:live:${desk.ticket}`, kind: "external_balance_deal", severity: "warning", status: "open", accountId: other.id, login: other.login,
        serverCode: "live", isDemo: false, dealTicket: desk.ticket,
        details: { server: "live", login: other.login, ticket: desk.ticket, action: 2, amountCents: 25_000, comment: "Deposit at desk", time: expect.any(String) },
      }),
    ]);
    expect((await ben.agent.get(`/api/staff/mt5/reconciliation/summary`)).body.open).toEqual({ critical: 0, warning: planted.size - 1, info: 1 });

    // A second run finds the same and nothing new, and still writes nothing to MT5.
    expect((await post(ben, "/api/staff/mt5/reconciliation/runs")).status).toBe(202);
    const again = (await activeRun())!;
    expect(again).toMatchObject({ status: "done", issues_found: planted.size, issues_new: 0, critical_found: 0, notes: null });
    expect(writes()).toBe(before);
    expect(Number((await one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM mt5_recon_issues WHERE status = 'open'"))!.n)).toBe(planted.size);
    await clean();
  }, 60_000);

  // ---------- What the whole run must never do ----------

  it("left no password or secret in either log, the audit log or the MT5 tables, and every MT5 session was signed in", async () => {
    for (const fake of [live, demo]) {
      expect(fake.state.unauthenticated).toBe(0);
      expect(fake.state.groupChanges).toBe(0);
      expect(fake.state.maxWritesInFlight).toBe(1);
    }
    const logs = gatewayLines.join("") + crmLines.join("");
    expect(gatewayLines.length).toBeGreaterThan(0);
    expect(crmLines.length).toBeGreaterThan(0);
    const stored = JSON.stringify([
      await rows(env.db, "SELECT * FROM audit_log"),
      await rows(env.db, "SELECT * FROM mt5_accounts"),
      await rows(env.db, "SELECT * FROM mt5_balance_ops"),
      await rows(env.db, "SELECT * FROM mt5_deals"),
      await rows(env.db, "SELECT * FROM mt5_recon_issues"),
      await rows(env.db, "SELECT * FROM mt5_recon_runs"),
    ]);
    for (const secret of [SECRET, LIVE_MANAGER, DEMO_MANAGER, MASTER, INVESTOR]) {
      expect(logs).not.toContain(secret);
      expect(stored).not.toContain(secret);
    }
    expect((await verifyAuditChain(env.db)).ok).toBe(true);
    await clean();
  });
});
