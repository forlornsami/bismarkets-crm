import pino from "pino";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Ops } from "../src/gateway/protocol";
import { createApp } from "../src/server/app";
import { createClientSession } from "../src/server/clients/session";
import { createDb, exec, one, rows, transaction } from "../src/server/lib/db";
import { OVERLAP_MS, startMt5DealSync, syncAccountDeals, syncDealsOnce, syncStaleDeals } from "../src/server/mt5/deals";
import type { Mt5Gateway } from "../src/server/mt5/gateway";
import { mt5Reference } from "../src/server/mt5/references";
import { rebuildTrades } from "../src/server/mt5/trades";
import { FakeGateway } from "./fakes/gateway";
import { createStaff, hasDb, post, setup, signIn, TEST_DB_URL, type SignedIn, type TestEnv } from "./helpers";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
/** The demo server's clock runs three hours ahead of UTC: deals carry that as `time`, and the gateway's UTC as `timeUtc`. */
const SERVER_OFFSET_S: Record<string, number> = { live: 0, demo: 3 * 3600, off: 0 };

interface Client {
  id: number;
  token: string;
}
interface Acct {
  id: number;
  login: number;
  server: string;
}

describe.skipIf(!hasDb)("MT5 trade history", () => {
  let env: TestEnv;
  const fake = new FakeGateway({
    servers: {
      live: { groups: ["real\\standard"], demoGroups: [] },
      demo: { groups: [], demoGroups: ["demo\\usd"] },
      off: { groups: ["real\\standard"], demoGroups: [] },
    },
  });
  let support: SignedIn; // support_agent: mt5.view, every client
  let sales: SignedIn; // sales_agent: mt5.view, only clients assigned to them
  let desk: SignedIn; // a role without mt5.view
  let seq = 0;
  let ticket = 70_000_000;
  let position = 4_000_000;
  /** Whole minutes, ten days back: inside every account's first sync window. */
  const t0 = Math.floor((Date.now() - 10 * DAY) / MINUTE) * MINUTE;
  const iso = (ms: number) => new Date(ms).toISOString();

  async function makeClient(assignedTo: number | null = null): Promise<Client> {
    seq++;
    const r = await exec(
      env.db,
      "INSERT INTO clients (email, first_name, last_name, referral_code, source, kyc_status, status, assigned_staff_id) VALUES (?, 'Tia', 'Lane', ?, 'portal', 'approved', 'active', ?)",
      [`history.${seq}@client.test`, `TH${String(seq).padStart(8, "0")}`, assignedTo],
    );
    const { token } = await transaction(env.db, (conn) => createClientSession(conn, env.config, r.insertId, "127.0.0.1", "vitest"));
    return { id: r.insertId, token };
  }

  /** An open account straight in the CRM and in MT5, opened `ageDays` ago. */
  async function openAccount(clientId: number, opts: { server?: string; login?: number; ageDays?: number; status?: string } = {}): Promise<Acct> {
    const server = opts.server ?? "live";
    const demo = server === "demo";
    const user = fake.addUser(server, { group: demo ? "demo\\usd" : "real\\standard", login: opts.login });
    const r = await exec(
      env.db,
      `INSERT INTO mt5_accounts (client_id, server_code, login, is_demo, package_name, mt5_group, leverage, status, create_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 2000, ?, ?, ?)`,
      [clientId, server, user.login, demo ? 1 : 0, demo ? "Demo" : "Classic", user.group, opts.status ?? "active", mt5Reference("A"), new Date(Date.now() - (opts.ageDays ?? 30) * DAY)],
    );
    return { id: r.insertId, login: user.login, server };
  }

  /** A deal in MT5 at a UTC time, as the gateway reports it (server clock in `time`, whole-second UTC in `timeUtc`). */
  function addDeal(
    a: Acct,
    d: { at: number; action: number; entry?: number; position?: number; volume?: number; price?: string; profit?: number; commission?: number; swap?: number; symbol?: string; comment?: string },
  ) {
    const time = Math.floor(d.at / 1000) + SERVER_OFFSET_S[a.server]!;
    ticket++;
    return fake.addDeal(a.server, {
      login: a.login, ticket, action: d.action, entry: d.entry ?? 0, positionId: d.position ?? 0, order: ticket, symbol: d.symbol ?? (d.action < 2 ? "EURUSD" : ""),
      volume: d.volume ?? 0, price: d.price ?? "0", profitCents: d.profit ?? 0, commissionCents: d.commission ?? 0, swapCents: d.swap ?? 0, feeCents: 0,
      comment: d.comment ?? "", time, timeMsc: time * 1000 + (d.at % 1000), timeUtc: iso(Math.floor(d.at / 1000) * 1000),
    });
  }

  /** A position opened and closed in full: an IN deal and an OUT deal. Returns its position id. */
  function trade(
    a: Acct,
    t: { openAt: number; closeAt: number; side?: 0 | 1; lots?: number; open?: string; close?: string; profit?: number; commission?: number; swap?: number; symbol?: string; position?: number },
  ) {
    const id = t.position ?? ++position;
    const side = t.side ?? 0;
    const volume = Math.round((t.lots ?? 1) * 10_000);
    addDeal(a, { at: t.openAt, action: side, entry: 0, position: id, volume, price: t.open ?? "1.10000", commission: t.commission, symbol: t.symbol });
    addDeal(a, { at: t.closeAt, action: 1 - side, entry: 1, position: id, volume, price: t.close ?? "1.10100", profit: t.profit, commission: t.commission, swap: t.swap, symbol: t.symbol });
    return id;
  }

  /** MT5 pages deals oldest first; the fake keeps them as added, so tests that add out of order sort them. */
  const chronological = () => fake.deals.sort((x, y) => x.timeMsc - SERVER_OFFSET_S[x.server]! * 1000 - (y.timeMsc - SERVER_OFFSET_S[y.server]! * 1000) || x.ticket - y.ticket);

  const history = (c: Client, query = "") => request(env.app).get(`/api/trade-history${query}`).set({ Authorization: `Bearer ${c.token}` });
  /** As if the account's last sync was long enough ago for the next first page to sync again. */
  const stale = (a: Acct, ago = "2 MINUTE") => exec(env.db, `UPDATE mt5_accounts SET deals_synced_at = CURRENT_TIMESTAMP(3) - INTERVAL ${ago} WHERE id = ?`, [a.id]);
  const syncState = (a: Acct) =>
    one<{ deals_synced_until: Date | null; deals_synced_at: Date | null; deals_sync_error: string | null; deals_sync_partial: number }>(
      env.db, "SELECT deals_synced_until, deals_synced_at, deals_sync_error, deals_sync_partial FROM mt5_accounts WHERE id = ?", [a.id],
    );
  const pageCalls = () => fake.callsTo("deals.page");
  const get = (s: SignedIn, url: string) => s.agent.get(url);
  async function waitFor(check: () => Promise<boolean>, ms = 5_000) {
    const end = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > end) throw new Error("timed out waiting");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  beforeAll(async () => {
    env = await setup({}, { mt5: fake });
    await exec(env.db, "INSERT INTO mt5_servers (code, label, is_enabled) VALUES ('live', 'Live', 1), ('demo', 'Demo', 1), ('off', 'Old server', 0)");
    await exec(env.db, "INSERT INTO roles (slug, name) VALUES ('kyc_desk', 'KYC desk')");
    await exec(
      env.db,
      "INSERT INTO role_permissions (role_id, permission) SELECT r.id, p.name FROM roles r JOIN (SELECT 'client.view' AS name UNION SELECT 'client.view_all' UNION SELECT 'kyc.view') p WHERE r.slug = 'kyc_desk'",
    );
    await createStaff(env.db, "support@crm.test", "support_agent");
    await createStaff(env.db, "sales@crm.test", "sales_agent");
    await createStaff(env.db, "desk@crm.test", "kyc_desk");
    support = await signIn(env, "support@crm.test");
    sales = await signIn(env, "sales@crm.test");
    desk = await signIn(env, "desk@crm.test");
  }, 120_000);
  afterAll(async () => env?.db.end());
  beforeEach(() => {
    fake.clearFaults();
    fake.down = false;
  });

  // ---------- The client's history ----------

  it("shows the closed trades of all the client's accounts, live and demo, in the exact envelope both clients parse", async () => {
    const c = await makeClient();
    const live = await openAccount(c.id);
    const demo = await openAccount(c.id, { server: "demo" });
    const p1 = trade(live, { openAt: t0, closeAt: t0 + 30 * MINUTE, lots: 1, open: "1.10000", close: "1.10100", profit: 12_345, commission: -350, swap: -120 });
    const p2 = trade(live, { openAt: t0 + HOUR, closeAt: t0 + 2 * HOUR, side: 1, lots: 0.5, symbol: "XAUUSD", open: "2350.15", close: "2360.15", profit: -5_000 });
    const p3 = trade(demo, { openAt: t0 + 3 * HOUR, closeAt: t0 + 4 * HOUR, lots: 2, profit: 1_000 });
    // Still open, and money in and out: never trades.
    addDeal(live, { at: t0 + 5 * HOUR, action: 0, entry: 0, position: ++position, volume: 10_000, price: "1.2" });
    addDeal(live, { at: t0 - HOUR, action: 2, profit: 100_000, comment: "BIS-T00000001" });
    addDeal(live, { at: t0 + 6 * HOUR, action: 3, profit: 5_000, comment: "Bonus" });

    const res = await history(c);
    expect(res.status).toBe(200);
    const login = String(live.login);
    expect(res.body).toEqual({
      success: true,
      filters: { from_date: null, to_date: null, account_id: null },
      summary: { total_trades: 3, total_profit: 83.45, total_volume: 3.5, total_commission: -7 },
      pagination: { current_page: 1, per_page: 100, total: 3, last_page: 1 },
      trades: [
        expect.objectContaining({ id: `${demo.login}-${p3}`, ticket: p3, account: String(demo.login), login: String(demo.login), volume: 2, pnl: 10, side: 0 }),
        expect.objectContaining({ id: `${login}-${p2}`, ticket: p2, symbol: "XAUUSD", side: 1, type: "sell", volume: 0.5, open_price: 2350.15, close_price: 2360.15, pnl: -50 }),
        {
          id: `${login}-${p1}`, ticket: p1, symbol: "EURUSD", side: 0, type: "buy", volume: 1, open_price: 1.1, close_price: 1.101, pnl: 123.45, profit: 123.45,
          commission: -7, swap: -1.2, currency: "USD", account: login, login, status: "closed", opened_at: iso(t0), closed_at: iso(t0 + 30 * MINUTE),
        },
      ],
    });
    // Nothing internal: no references, groups or server codes.
    expect(JSON.stringify(res.body)).not.toMatch(/BIS-|\\\\|server|group|live/);

    // Every deal is in the cache once, balance and credit too; only the three closed positions are trades.
    expect(Number((await one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM mt5_deals WHERE mt5_account_id IN (?, ?)", [live.id, demo.id]))!.n)).toBe(9);
    expect((await rows<{ position_id: number }>(env.db, "SELECT position_id FROM mt5_trades WHERE client_id = ? ORDER BY position_id", [c.id])).map((r) => Number(r.position_id))).toEqual([p1, p2, p3]);
    const state = (await syncState(live))!;
    expect(state).toMatchObject({ deals_sync_error: null, deals_sync_partial: 0 });
    expect(Math.abs(state.deals_synced_until!.getTime() - Date.now())).toBeLessThan(30_000);
  });

  it("pages exactly: current_page as asked, rows per page, last_page, and the summary over the whole filtered set", async () => {
    const c = await makeClient();
    const a = await openAccount(c.id);
    const ids: number[] = [];
    for (let i = 0; i < 7; i++) ids.push(trade(a, { openAt: t0 + i * HOUR, closeAt: t0 + i * HOUR + 10 * MINUTE, profit: 100 * (i + 1), commission: -10 }));
    const summary = { total_trades: 7, total_profit: 28, total_volume: 7, total_commission: -1.4 };
    const seen: string[] = [];
    const closes: string[] = [];
    for (const [page, count] of [[1, 3], [2, 3], [3, 1], [4, 0]] as const) {
      const res = await history(c, `?per_page=3&page=${page}`);
      expect(res.body.pagination).toEqual({ current_page: page, per_page: 3, total: 7, last_page: 3 });
      expect(res.body.summary).toEqual(summary);
      expect(res.body.trades).toHaveLength(count);
      seen.push(...res.body.trades.map((t: { id: string }) => t.id));
      closes.push(...res.body.trades.map((t: { closed_at: string }) => t.closed_at));
    }
    expect(seen).toEqual([...ids].reverse().map((p) => `${a.login}-${p}`));
    expect([...closes].sort().reverse()).toEqual(closes);

    // The portal's per_page=500 is honoured, never cut down; more is clamped to 500.
    expect((await history(c, "?per_page=500")).body.pagination).toEqual({ current_page: 1, per_page: 500, total: 7, last_page: 1 });
    const clamped = await history(c, "?per_page=1000");
    expect(clamped.body.pagination.per_page).toBe(500);
    expect(clamped.body.trades).toHaveLength(7);
    // Dates filter the summary too.
    const day = iso(t0).slice(0, 10);
    const filtered = await history(c, `?from_date=${day}&to_date=${day}&per_page=2`);
    const sameDay = ids.filter((_, i) => iso(t0 + i * HOUR + 10 * MINUTE).slice(0, 10) === day).length;
    expect(filtered.body.summary.total_trades).toBe(sameDay);
    expect(filtered.body.pagination).toEqual({ current_page: 1, per_page: 2, total: sameDay, last_page: Math.max(1, Math.ceil(sameDay / 2)) });
    expect(filtered.body.filters).toEqual({ from_date: day, to_date: day, account_id: null });
  });

  it("syncs on the first page only, at most once a minute, so the total cannot move while a client pages", async () => {
    const c = await makeClient();
    const a = await openAccount(c.id);
    for (let i = 0; i < 3; i++) trade(a, { openAt: t0 + i * HOUR, closeAt: t0 + i * HOUR + MINUTE });
    const first = await history(c, "?per_page=2");
    expect(first.body.pagination.total).toBe(3);
    const calls = pageCalls().length;

    // A trade closes in MT5 while the client is on page 1.
    trade(a, { openAt: Date.now() - 2 * HOUR, closeAt: Date.now() - HOUR });
    await stale(a);
    const second = await history(c, "?per_page=2&page=2");
    expect(second.body.pagination).toEqual({ current_page: 2, per_page: 2, total: 3, last_page: 2 });
    expect(second.body.trades).toHaveLength(1);
    expect(pageCalls()).toHaveLength(calls);

    // The first page again: synced two minutes ago, so it reads MT5 and sees the new one.
    expect((await history(c, "?per_page=2")).body.pagination.total).toBe(4);
    expect(pageCalls()).toHaveLength(calls + 1);
    // Straight after, it does not read MT5 again.
    expect((await history(c)).body.pagination.total).toBe(4);
    expect(pageCalls()).toHaveLength(calls + 1);
    // A malformed page is page 1.
    await stale(a);
    await history(c, "?page=x");
    expect(pageCalls()).toHaveLength(calls + 2);
  });

  it("answers only the caller's own accounts: another client's login is the empty result and is never read", async () => {
    const c = await makeClient();
    const mine = await openAccount(c.id);
    const second = await openAccount(c.id);
    const other = await makeClient();
    const theirs = await openAccount(other.id);
    const p = trade(mine, { openAt: t0, closeAt: t0 + MINUTE });
    trade(second, { openAt: t0, closeAt: t0 + 2 * MINUTE });
    trade(theirs, { openAt: t0, closeAt: t0 + MINUTE, profit: 99_999 });
    await history(other);
    const calls = pageCalls().length;

    const res = await history(c, `?account_id=${theirs.login}`);
    expect(res.body).toEqual({
      success: true,
      filters: { from_date: null, to_date: null, account_id: String(theirs.login) },
      summary: { total_trades: 0, total_profit: 0, total_volume: 0, total_commission: 0 },
      pagination: { current_page: 1, per_page: 100, total: 0, last_page: 1 },
      trades: [],
    });
    expect(pageCalls()).toHaveLength(calls);
    // Its own login: only that account (and only that account is synced).
    const own = await history(c, `?account_id=${mine.login}`);
    expect(own.body.trades.map((t: { id: string }) => t.id)).toEqual([`${mine.login}-${p}`]);
    expect(pageCalls().slice(calls).map((x) => x.req.login)).toEqual([mine.login]);
    // A malformed account (the generated client sends "null") is no filter.
    expect((await history(c, "?account_id=null")).body.pagination.total).toBe(2);

    // A staff view-only session may read; without a session, nothing.
    const { token } = await transaction(env.db, (conn) => createClientSession(conn, env.config, c.id, "127.0.0.1", "vitest", { staffId: support.staffId, reason: "Checking trades" }));
    expect((await history({ id: c.id, token })).body.pagination.total).toBe(2);
    expect((await request(env.app).get("/api/trade-history")).status).toBe(401);
  });

  it("gives every trade an id unique across the client's accounts, even when live and demo share a login and a position id", async () => {
    const c = await makeClient();
    const live = await openAccount(c.id);
    const demo = await openAccount(c.id, { server: "demo", login: live.login });
    const p = ++position;
    trade(live, { position: p, openAt: t0, closeAt: t0 + HOUR });
    trade(demo, { position: p, openAt: t0, closeAt: t0 + HOUR });
    const res = await history(c);
    const ids = res.body.trades.map((t: { id: string }) => t.id);
    expect(ids.sort()).toEqual([`${live.login}-${p}`, `${live.login}-${p}-2`]);
    expect(res.body.trades.map((t: { ticket: number }) => t.ticket)).toEqual([p, p]);
    // The same ids whatever the filter, so an app that has page 1 from one view never meets a changed id.
    expect((await history(c, `?account_id=${live.login}`)).body.trades.map((t: { id: string }) => t.id).sort()).toEqual(ids);
  });

  it("shows a partly closed position once it is closed in full, and a netting reversal as the part it closed, then the part it opened", async () => {
    const c = await makeClient();
    const a = await openAccount(c.id);
    // Recent, so the deals added after a sync are inside the two days it reads again.
    const t = Math.floor((Date.now() - DAY) / MINUTE) * MINUTE;
    const hedged = ++position;
    addDeal(a, { at: t, action: 1, entry: 0, position: hedged, volume: 10_000, price: "150.120", symbol: "USDJPY" });
    addDeal(a, { at: t + 5 * MINUTE, action: 0, entry: 1, position: hedged, volume: 3_000, price: "150.000", profit: 240, symbol: "USDJPY" });
    expect((await history(c)).body.pagination.total).toBe(0);

    addDeal(a, { at: t + 10 * MINUTE, action: 0, entry: 1, position: hedged, volume: 7_000, price: "149.900", profit: 1_027, symbol: "USDJPY" });
    const netted = ++position;
    addDeal(a, { at: t + HOUR, action: 0, entry: 0, position: netted, volume: 10_000, price: "1.10000" });
    addDeal(a, { at: t + HOUR + MINUTE, action: 0, entry: 0, position: netted, volume: 5_000, price: "1.10030" });
    const reversal = addDeal(a, { at: t + 2 * HOUR, action: 1, entry: 2, position: netted, volume: 20_000, price: "1.10200", profit: 2_850 });
    await stale(a);
    const res = await history(c);
    expect(res.body.trades).toEqual([
      expect.objectContaining({ id: `${a.login}-${netted}`, side: 0, volume: 1.5, open_price: 1.1001, close_price: 1.102, pnl: 28.5, closed_at: iso(t + 2 * HOUR) }),
      expect.objectContaining({ id: `${a.login}-${hedged}`, side: 1, type: "sell", volume: 1, open_price: 150.12, close_price: 149.9, pnl: 12.67, closed_at: iso(t + 10 * MINUTE) }),
    ]);

    // The reversed half-lot closes later under the same position id: a trade of its own, sold at the reversal's price and time,
    // and the part the reversal closed stays as it was.
    addDeal(a, { at: t + 3 * HOUR, action: 0, entry: 1, position: netted, volume: 5_000, price: "1.10100", profit: 500 });
    await stale(a);
    const after = await history(c);
    expect(after.body.summary).toEqual({ total_trades: 3, total_profit: 46.17, total_volume: 3, total_commission: 0 });
    expect(after.body.trades).toEqual([
      expect.objectContaining({
        id: `${a.login}-${netted}-r${reversal.ticket}`, ticket: netted, side: 1, type: "sell", volume: 0.5, open_price: 1.102, close_price: 1.101, pnl: 5,
        opened_at: iso(t + 2 * HOUR), closed_at: iso(t + 3 * HOUR),
      }),
      res.body.trades[0],
      res.body.trades[1],
    ]);
  });

  it("builds a reversed position's parts again over the overlap without doubling or leaving a row, and pages them exactly", async () => {
    const c = await makeClient();
    const a = await openAccount(c.id);
    const t = Math.floor((Date.now() - DAY) / MINUTE) * MINUTE;
    const p = ++position;
    // Bought a lot, sold three (reversed), bought five (reversed again), then sold the three lots bought in two goes.
    addDeal(a, { at: t, action: 0, entry: 0, position: p, volume: 10_000, price: "1.10000", commission: -350 });
    const first = addDeal(a, { at: t + 10 * MINUTE, action: 1, entry: 2, position: p, volume: 30_000, price: "1.09000", profit: -10_000, commission: -1_050 });
    const second = addDeal(a, { at: t + 20 * MINUTE, action: 0, entry: 2, position: p, volume: 50_000, price: "1.08000", profit: 20_000, commission: -1_750 });
    addDeal(a, { at: t + 30 * MINUTE, action: 1, entry: 1, position: p, volume: 10_000, price: "1.08500", profit: 5_000 });
    const last = addDeal(a, { at: t + 40 * MINUTE, action: 1, entry: 1, position: p, volume: 20_000, price: "1.08600", profit: 12_000, swap: -80 });
    const L = `${a.login}-${p}`;
    const order = [`${L}-r${second.ticket}`, `${L}-r${first.ticket}`, L];
    const summary = { total_trades: 3, total_profit: 270, total_volume: 6, total_commission: -31.5 };

    const pages = [await history(c, "?per_page=1"), await history(c, "?per_page=1&page=2"), await history(c, "?per_page=1&page=3"), await history(c, "?per_page=1&page=4")];
    expect(pages.map((r) => r.body.pagination)).toEqual([1, 2, 3, 4].map((n) => ({ current_page: n, per_page: 1, total: 3, last_page: 3 })));
    expect(pages.flatMap((r) => r.body.trades.map((x: { id: string }) => x.id))).toEqual(order);
    for (const r of pages) expect(r.body.summary).toEqual(summary);
    expect(pages.map((r) => r.body.trades[0])).toEqual([
      expect.objectContaining({ ticket: p, side: 0, volume: 3, open_price: 1.08, close_price: 1.086, pnl: 170, swap: -0.8, commission: 0, opened_at: iso(t + 20 * MINUTE), closed_at: iso(t + 40 * MINUTE) }),
      expect.objectContaining({ ticket: p, side: 1, volume: 2, open_price: 1.09, close_price: 1.08, pnl: 200, commission: -17.5, opened_at: iso(t + 10 * MINUTE), closed_at: iso(t + 20 * MINUTE) }),
      expect.objectContaining({ ticket: p, side: 0, volume: 1, open_price: 1.1, close_price: 1.09, pnl: -100, commission: -14, opened_at: iso(t), closed_at: iso(t + 10 * MINUTE) }),
      undefined,
    ]);
    // Staff see the same parts, each with an id of its own and the reversal that opened it.
    const staff = await get(support, `/api/staff/mt5/accounts/${a.id}/trades`);
    expect(staff.body.items.map((x: { id: string; positionId: number; reversalTicket: number | null }) => [x.id, x.positionId, x.reversalTicket])).toEqual([
      [`${p}-r${second.ticket}`, p, second.ticket], [`${p}-r${first.ticket}`, p, first.ticket], [String(p), p, null],
    ]);
    expect(staff.body.totals).toMatchObject({ trades: 3, lots: 6, profitCents: 27_000, commissionCents: -3_150, swapCents: -80 });

    const stored = () => rows<Record<string, unknown>>(env.db, "SELECT * FROM mt5_trades WHERE mt5_account_id = ? ORDER BY position_id, segment", [a.id]);
    const before = await stored();
    expect(before.map((r) => Number(r.segment))).toEqual([0, first.ticket, second.ticket]);
    // A sync reads the last two days again: the same deals, built into the same rows, not one of them rewritten.
    expect(await syncAccountDeals(env.db, fake, a.id, silent)).toMatchObject({ outcome: "complete", deals: 5, newDeals: 0, trades: 3 });
    expect(await stored()).toEqual(before);

    // A dealer corrects the second reversal: the two parts it touches are rewritten under the same keys.
    second.price = "1.08010";
    second.profitCents = 19_980;
    await syncAccountDeals(env.db, fake, a.id, silent);
    const corrected = await stored();
    expect(corrected.map((r) => [Number(r.segment), r.open_price, r.close_price, Number(r.profit_cents)])).toEqual([
      [0, "1.10000", "1.09000", -10_000], [first.ticket, "1.09000", "1.08010", 19_980], [second.ticket, "1.08010", "1.08600", 17_000],
    ]);
    // The last close is cancelled: the part it closed is open again and leaves the history; the others stay.
    last.action = 14;
    await syncAccountDeals(env.db, fake, a.id, silent);
    expect((await stored()).map((r) => Number(r.segment))).toEqual([0, first.ticket]);
    expect((await history(c)).body.summary).toEqual({ total_trades: 2, total_profit: 99.8, total_volume: 3, total_commission: -31.5 });
    // The first reversal is cancelled too: what is left no longer adds up, so the position shows nothing rather than a guess.
    first.action = 14;
    expect(await syncAccountDeals(env.db, fake, a.id, silent)).toMatchObject({ outcome: "complete", trades: 0 });
    expect(await stored()).toEqual([]);
  });

  it("filters by UTC days whatever the trade server's clock, and sends times in UTC", async () => {
    const c = await makeClient();
    const demo = await openAccount(c.id, { server: "demo" });
    const midnight = Math.floor((Date.now() - 5 * DAY) / DAY) * DAY;
    // 22:30 UTC is 01:30 the next day on the demo server's clock.
    const p = trade(demo, { openAt: midnight + 20 * HOUR, closeAt: midnight + 22 * HOUR + 30 * MINUTE + 250 });
    const day = iso(midnight).slice(0, 10);
    const next = iso(midnight + DAY).slice(0, 10);
    const res = await history(c, `?from_date=${day}&to_date=${day}`);
    expect(res.body.trades).toEqual([expect.objectContaining({ id: `${demo.login}-${p}`, opened_at: iso(midnight + 20 * HOUR), closed_at: iso(midnight + 22 * HOUR + 30 * MINUTE + 250) })]);
    expect((await history(c, `?from_date=${next}`)).body.pagination.total).toBe(0);
    expect((await history(c, `?to_date=${iso(midnight - DAY).slice(0, 10)}`)).body.pagination.total).toBe(0);
    // The cache keeps MT5's own seconds next to the UTC time.
    const stored = await one<{ time_server: number; time_utc: Date }>(env.db, "SELECT time_server, time_utc FROM mt5_deals WHERE mt5_account_id = ? AND entry = 1", [demo.id]);
    expect(Number(stored!.time_server)).toBe((midnight + 22 * HOUR + 30 * MINUTE) / 1000 + 3 * 3600);
    expect(stored!.time_utc.toISOString()).toBe(iso(midnight + 22 * HOUR + 30 * MINUTE + 250));
  });

  it("answers from the cache when MT5 is off, its server is switched off, or the sync fails, and never shows MT5's words", async () => {
    const c = await makeClient();
    const a = await openAccount(c.id);
    trade(a, { openAt: t0, closeAt: t0 + MINUTE, profit: 500 });
    expect((await history(c)).body.pagination.total).toBe(1);
    // Closed since: inside the two days every sync reads again.
    trade(a, { openAt: Date.now() - 3 * HOUR, closeAt: Date.now() - 2 * HOUR });
    await stale(a);
    const calls = pageCalls().length;

    const off = createApp({ db: env.db, config: env.config, log: pino({ level: "silent" }), fetch: (async () => new Response("", { status: 503 })) as typeof fetch, mt5: null });
    const offRes = await request(off).get("/api/trade-history").set({ Authorization: `Bearer ${c.token}` });
    expect(offRes.body.pagination.total).toBe(1);
    expect(pageCalls()).toHaveLength(calls);

    fake.failNext("deals.page", { kind: "refused", code: "group_not_allowed", message: "Group real\\standard is not in the gateway's list (retcode 3)" });
    const refused = await history(c);
    expect(refused.status).toBe(200);
    expect(refused.body.pagination.total).toBe(1);
    expect(JSON.stringify(refused.body)).not.toMatch(/group|retcode|gateway/i);
    expect((await syncState(a))!.deals_sync_error).toBe("refused/group_not_allowed: Group real\\standard is not in the gateway's list (retcode 3)");

    await stale(a);
    fake.down = true;
    expect((await history(c)).body.pagination.total).toBe(1);
    expect((await syncState(a))!.deals_sync_error).toMatch(/^unavailable\/connection/);
    fake.down = false;

    // A server switched off in the CRM is not read.
    const other = await openAccount(c.id, { server: "off" });
    trade(other, { openAt: t0, closeAt: t0 + MINUTE });
    await stale(a, "2 DAY");
    const mark = pageCalls().length;
    const res = await history(c);
    expect(pageCalls().slice(mark).map((x) => x.req.server)).toEqual(["live"]);
    expect(res.body.pagination.total).toBe(2);
    expect((await syncState(a))!.deals_sync_error).toBeNull();
  });

  // ---------- The sync ----------

  it("reads two days back from where the cache is complete, stores each deal once and never changes it", async () => {
    const c = await makeClient();
    const a = await openAccount(c.id, { ageDays: 20 });
    const created = (await one<{ created_at: Date }>(env.db, "SELECT created_at FROM mt5_accounts WHERE id = ?", [a.id]))!.created_at;
    trade(a, { openAt: Date.now() - 5 * DAY, closeAt: Date.now() - 5 * DAY + HOUR, profit: 700 });
    const first = await syncAccountDeals(env.db, fake, a.id, silent);
    expect(first).toEqual({ outcome: "complete", pages: 1, deals: 2, newDeals: 2, trades: 1, error: null });
    // The first sync starts a day before the account was opened, and reads to an hour past now.
    const call = pageCalls().at(-1)!.req;
    expect(call).toMatchObject({ server: "live", login: a.login, from: iso(created.getTime() - DAY), offset: 0, limit: 1000 });
    expect(Date.parse(String(call.to)) - Date.now()).toBeGreaterThan(55 * MINUTE);
    const until = (await syncState(a))!.deals_synced_until!;

    // MT5 files a deal late, a day before where the cache was complete: the overlap finds it.
    const late = trade(a, { openAt: until.getTime() - DAY, closeAt: until.getTime() - DAY + MINUTE, profit: 300 });
    // One three days back is outside the overlap.
    trade(a, { openAt: until.getTime() - 3 * DAY, closeAt: until.getTime() - 3 * DAY + MINUTE });
    // A deal MT5 changes once it is older than the two days read again is never read again: its stored copy stays as it was.
    const stored = fake.dealsOf("live", a.login)[1]!;
    stored.profitCents = 1;
    const second = await syncAccountDeals(env.db, fake, a.id, silent);
    expect(pageCalls().at(-1)!.req.from).toBe(iso(until.getTime() - OVERLAP_MS));
    expect(second).toMatchObject({ outcome: "complete", deals: 2, newDeals: 2, trades: 1 });
    const kept = await rows<{ ticket: number; profit_cents: number }>(env.db, "SELECT ticket, profit_cents FROM mt5_deals WHERE mt5_account_id = ? ORDER BY ticket", [a.id]);
    expect(kept).toHaveLength(4);
    expect(Number(kept.find((d) => Number(d.ticket) === stored.ticket)!.profit_cents)).toBe(700);
    expect(Number((await one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM mt5_trades WHERE mt5_account_id = ?", [a.id]))!.n)).toBe(2);
    expect(await one(env.db, "SELECT position_id FROM mt5_trades WHERE mt5_account_id = ? AND position_id = ?", [a.id, late])).toBeDefined();
    // And again: nothing new, nothing doubled.
    expect(await syncAccountDeals(env.db, fake, a.id, silent)).toMatchObject({ outcome: "complete", newDeals: 0 });
    expect(Number((await one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM mt5_deals WHERE mt5_account_id = ?", [a.id]))!.n)).toBe(4);
  });

  it("gets a big account's first sync through in several goes, each carrying on where the last stopped", async () => {
    const c = await makeClient();
    const a = await openAccount(c.id, { ageDays: 25 });
    const start = Date.now() - 20 * DAY;
    for (let i = 0; i < 1250; i++) trade(a, { openAt: start + i * 20 * MINUTE, closeAt: start + i * 20 * MINUTE + 5 * MINUTE + 300, profit: i % 2 ? 100 : -50, commission: -7 });
    chronological();
    const froms: string[] = [];
    let last = await syncAccountDeals(env.db, fake, a.id, silent, { budgetMs: 0 });
    froms.push(String(pageCalls().at(-1)!.req.from));
    expect(last).toMatchObject({ outcome: "partial", pages: 1, deals: 1000, newDeals: 1000 });
    let state = (await syncState(a))!;
    expect(state.deals_sync_partial).toBe(1);
    // Complete to the time of the last deal stored.
    const thousandth = fake.dealsOf("live", a.login)[999]!;
    expect(state.deals_synced_until!.toISOString()).toBe(iso(Date.parse(thousandth.timeUtc) + (thousandth.timeMsc % 1000)));
    let runs = 1;
    while (last.outcome === "partial") {
      const before = (await syncState(a))!.deals_synced_until!;
      last = await syncAccountDeals(env.db, fake, a.id, silent, { budgetMs: 0 });
      // Straight on from there (its whole second), not two days back.
      expect(pageCalls().at(-1)!.req.from).toBe(iso(Math.floor(before.getTime() / 1000) * 1000));
      runs++;
    }
    expect(last.outcome).toBe("complete");
    expect(runs).toBe(3);
    state = (await syncState(a))!;
    expect(state.deals_sync_partial).toBe(0);
    expect(Number((await one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM mt5_deals WHERE mt5_account_id = ?", [a.id]))!.n)).toBe(2500);

    // The whole history pages in 500s, the summary over all 1250.
    const p1 = await history(c, "?per_page=500");
    expect(p1.body.pagination).toEqual({ current_page: 1, per_page: 500, total: 1250, last_page: 3 });
    expect(p1.body.summary).toEqual({ total_trades: 1250, total_profit: 625 * 1 - 625 * 0.5, total_volume: 1250, total_commission: -175 });
    const p3 = await history(c, "?per_page=500&page=3");
    expect(p3.body.trades).toHaveLength(250);
    const all = new Set([...p1.body.trades, ...(await history(c, "?per_page=500&page=2")).body.trades, ...p3.body.trades].map((t: { id: string }) => t.id));
    expect(all.size).toBe(1250);

    // A client opening the history of a big account for the first time gets it within the page's budget.
    const c2 = await makeClient();
    const b = await openAccount(c2.id, { ageDays: 25 });
    for (let i = 0; i < 1100; i++) trade(b, { openAt: start + i * 20 * MINUTE, closeAt: start + i * 20 * MINUTE + 5 * MINUTE });
    chronological();
    const opened = Date.now();
    const res = await history(c2, "?per_page=500");
    expect(Date.now() - opened).toBeLessThan(5_000);
    expect(res.body.pagination.total).toBe(1100);
  });

  it("waits for a slow MT5 only as long as the page's budget, then stores nothing more, and joins a sync already running", async () => {
    const c = await makeClient();
    const a = await openAccount(c.id);
    trade(a, { openAt: t0, closeAt: t0 + MINUTE });
    const dealsOfA = async () => Number((await one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM mt5_deals WHERE mt5_account_id = ?", [a.id]))!.n);
    let pause = fake.pause("deals.page");
    const started = Date.now();
    await syncStaleDeals(env.db, fake, [a.id], silent, { budgetMs: 300 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(Date.now() - started).toBeLessThan(2_000);
    await pause.reached;
    const joined = syncAccountDeals(env.db, fake, a.id, silent);
    expect(syncAccountDeals(env.db, fake, a.id, silent)).toBe(joined);
    pause.release();
    // MT5 answered after the page had: nothing is stored, so a client paging on sees the same history.
    expect(await joined).toMatchObject({ outcome: "partial", pages: 0, newDeals: 0 });
    expect(await dealsOfA()).toBe(0);
    expect(fake.callsTo("deals.page").filter((x) => x.req.login === a.login)).toHaveLength(1);
    // Nothing was stored, so the account is left as it was: still due for the next sync.
    expect((await syncState(a))!.deals_synced_at).toBeNull();

    // A background sync is running when a trade history page asks: the page's deadline applies to it too.
    pause = fake.pause("deals.page");
    const background = syncAccountDeals(env.db, fake, a.id, silent);
    await pause.reached;
    await stale(a);
    await syncStaleDeals(env.db, fake, [a.id], silent, { budgetMs: 100 });
    pause.release();
    expect(await background).toMatchObject({ outcome: "partial", newDeals: 0 });
    expect(await dealsOfA()).toBe(0);
    // The next sync reads it all again.
    expect(await syncAccountDeals(env.db, fake, a.id, silent)).toMatchObject({ outcome: "complete", newDeals: 2 });
    expect(await dealsOfA()).toBe(2);
  });

  it("does not take a deals page that ends before MT5's total for the end: the next sync carries on from the last deal stored", async () => {
    const c = await makeClient();
    const a = await openAccount(c.id, { ageDays: 25 });
    const start = Date.now() - 20 * DAY;
    for (let i = 0; i < 750; i++) trade(a, { openAt: start + i * 30 * MINUTE, closeAt: start + i * 30 * MINUTE + 5 * MINUTE + 300 });
    chronological();
    // MT5 answers the second page empty once, although its total says there is more.
    let gaps = 1;
    const flaky: Mt5Gateway = {
      call: async (op, req) => {
        const res = await fake.call(op, req);
        if (op !== "deals.page" || (req as Ops["deals.page"]["req"]).offset !== 1000 || gaps-- <= 0) return res;
        return { ...(res as Ops["deals.page"]["res"]), deals: [] } as typeof res;
      },
    };
    const first = await syncAccountDeals(env.db, flaky, a.id, silent);
    expect(first).toMatchObject({ outcome: "partial", pages: 2, deals: 1000, newDeals: 1000, error: { kind: "unavailable", code: "mt5_error" } });
    const state = (await syncState(a))!;
    const thousandth = fake.dealsOf("live", a.login)[999]!;
    expect(state).toMatchObject({ deals_sync_partial: 1, deals_sync_error: expect.stringMatching(/^unavailable\/mt5_error: MT5's deal pages ended before its total/) });
    expect(state.deals_synced_until!.toISOString()).toBe(iso(Date.parse(thousandth.timeUtc) + (thousandth.timeMsc % 1000)));

    // MT5 answering as it should: straight on from the last deal stored, and the history is whole.
    expect(await syncAccountDeals(env.db, fake, a.id, silent)).toMatchObject({ outcome: "complete", newDeals: 500, error: null });
    expect(pageCalls().at(-1)!.req.from).toBe(iso(Math.floor(state.deals_synced_until!.getTime() / 1000) * 1000));
    expect((await syncState(a))!).toMatchObject({ deals_sync_partial: 0, deals_sync_error: null });
    expect((await history(c, "?per_page=1")).body.pagination.total).toBe(750);
  });

  it("leaves an account as it was when its sync stopped before storing anything, so the next page or background pass syncs it", async () => {
    const c = await makeClient();
    const a = await openAccount(c.id);
    trade(a, { openAt: t0, closeAt: t0 + MINUTE });
    expect(await syncAccountDeals(env.db, fake, a.id, silent)).toMatchObject({ outcome: "complete" });
    trade(a, { openAt: Date.now() - 2 * HOUR, closeAt: Date.now() - HOUR, profit: 900 });
    await exec(env.db, "UPDATE mt5_accounts SET deals_synced_at = CURRENT_TIMESTAMP(3)");
    await stale(a, "30 MINUTE");
    const before = (await syncState(a))!;

    // MT5 answers after the trade history page has.
    const pause = fake.pause("deals.page");
    await syncStaleDeals(env.db, fake, [a.id], silent, { budgetMs: 100 });
    await pause.reached;
    const stopped = syncAccountDeals(env.db, fake, a.id, silent);
    pause.release();
    expect(await stopped).toMatchObject({ outcome: "partial", pages: 0, newDeals: 0, error: null });
    expect(await syncState(a)).toEqual(before);

    // Still due: the background pass syncs it, and the trade is there.
    const mark = pageCalls().length;
    expect(await syncDealsOnce(env.db, fake, silent)).toMatchObject({ accounts: 1, complete: 1 });
    expect(pageCalls().slice(mark).map((x) => x.req.login)).toEqual([a.login]);
    expect((await history(c)).body.summary).toMatchObject({ total_trades: 2, total_profit: 9 });
  });

  it("updates a stored deal MT5 has changed since, and builds its position again: a cancelled trade leaves the history", async () => {
    const c = await makeClient();
    const a = await openAccount(c.id);
    // Inside the two days every sync reads again.
    const t = Math.floor((Date.now() - DAY) / MINUTE) * MINUTE;
    const cancelled = trade(a, { openAt: t, closeAt: t + 10 * MINUTE, profit: 200 });
    const corrected = trade(a, { openAt: t + HOUR, closeAt: t + 2 * HOUR, profit: 50 });
    const other = trade(a, { openAt: t + 3 * HOUR, closeAt: t + 4 * HOUR, profit: 10 });
    expect((await history(c)).body.summary).toMatchObject({ total_trades: 3, total_profit: 2.6 });
    /** The deals a sync rewrote because MT5 changed them, and when. */
    const changed = () =>
      rows<{ ticket: number; changed_at: Date }>(env.db, "SELECT ticket, changed_at FROM mt5_deals WHERE mt5_account_id = ? AND changed_at IS NOT NULL ORDER BY ticket", [a.id]);
    expect(await changed()).toEqual([]);

    const lines: unknown[] = [];
    const log = { ...silent, warn: (obj: unknown) => void lines.push(obj) };
    // The broker cancels a trade: MT5 turns its deals into BUY_CANCELED and SELL_CANCELED (13, 14) and takes their profit away.
    const [open, close] = fake.dealsOf("live", a.login).filter((d) => d.positionId === cancelled);
    open!.action = 13;
    close!.action = 14;
    close!.profitCents = 0;
    // A dealer corrects another trade's close.
    const fix = fake.dealsOf("live", a.login).find((d) => d.positionId === corrected && d.entry === 1)!;
    fix.price = "1.10150";
    fix.profitCents = 75;
    expect(await syncAccountDeals(env.db, fake, a.id, log)).toMatchObject({ outcome: "complete", deals: 6, newDeals: 0 });
    expect(lines).toEqual([
      { accountId: a.id, ticket: open!.ticket, changed: ["action"] },
      { accountId: a.id, ticket: close!.ticket, changed: ["action", "profit_cents"] },
      { accountId: a.id, ticket: fix.ticket, changed: ["price", "profit_cents"] },
    ]);
    const cached = await rows<{ ticket: number; action: number; price: string; profit_cents: number }>(
      env.db, "SELECT ticket, action, price, profit_cents FROM mt5_deals WHERE mt5_account_id = ? AND entry = 1 ORDER BY ticket", [a.id],
    );
    expect(cached.map((d) => [Number(d.action), d.price, Number(d.profit_cents)])).toEqual([[14, "1.10100", 0], [1, "1.10150", 75], [1, "1.10100", 10]]);
    // Only the rewritten deals carry when they changed (reconciliation reads them again from then).
    const stamped = await changed();
    expect(stamped.map((d) => Number(d.ticket))).toEqual([open!.ticket, close!.ticket, fix.ticket]);
    expect(stamped.every((d) => d.changed_at instanceof Date)).toBe(true);

    await stale(a);
    const res = await history(c);
    expect(res.body.summary).toMatchObject({ total_trades: 2, total_profit: 0.85 });
    expect(res.body.trades.map((r: { id: string }) => r.id)).toEqual([`${a.login}-${other}`, `${a.login}-${corrected}`]);
    expect(res.body.trades[1]).toMatchObject({ close_price: 1.1015, pnl: 0.75 });
    // Read again unchanged, nothing is written: not even when they last changed.
    lines.length = 0;
    expect(await syncAccountDeals(env.db, fake, a.id, log)).toMatchObject({ outcome: "complete", newDeals: 0, trades: 2 });
    expect(lines).toEqual([]);
    expect(await changed()).toEqual(stamped);
  });

  it("takes the client row before the account row while storing a page, as a settle does, so the two never deadlock", async () => {
    const c = await makeClient();
    const a = await openAccount(c.id);
    trade(a, { openAt: t0, closeAt: t0 + MINUTE });
    const own = createDb(TEST_DB_URL);
    const settle = await own.getConnection();
    try {
      await settle.query("SET SESSION innodb_lock_wait_timeout = 5");
      await settle.beginTransaction();
      // A settle's first lock (lockClient); a sync starts storing a page; then the settle's next lock, the account row.
      await settle.query("SELECT id FROM clients WHERE id = ? FOR UPDATE", [c.id]);
      const mark = pageCalls().length;
      const syncing = syncAccountDeals(env.db, fake, a.id, silent);
      await waitFor(async () => pageCalls().length > mark);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const settled = await settle.query("SELECT id FROM mt5_accounts WHERE id = ? FOR UPDATE", [a.id]).then(() => "locked", (e: { code?: string }) => e.code);
      await settle.commit();
      expect(settled).toBe("locked");
      expect(await syncing).toMatchObject({ outcome: "complete", newDeals: 2, trades: 1, error: null });
    } finally {
      settle.release();
      await own.end();
    }
  });

  it("builds the trades of two neighbouring accounts at once without deadlocking on the gaps between their rows", async () => {
    const c = await makeClient();
    const a = await openAccount(c.id);
    const b = await openAccount(c.id);
    const accountOf = (x: Acct) => ({ id: x.id, client_id: c.id, server_code: x.server, login: x.login });
    /** A closed position's two deals straight in the cache, its trade not built yet. */
    async function cached(x: Acct, positionId: number) {
      for (const entry of [0, 1]) {
        await exec(
          env.db,
          `INSERT INTO mt5_deals (server_code, ticket, mt5_account_id, client_id, login, action, entry, position_id, volume, price, profit_cents, time_server, time_utc)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 10000, '1.10000', 100, ?, ?)`,
          [x.server, ++ticket, x.id, c.id, x.login, entry, entry, positionId, Math.floor((t0 + entry * MINUTE) / 1000), new Date(t0 + entry * MINUTE)],
        );
      }
    }
    // b's first trade row ends the gap after a's rows.
    await cached(b, 9_000_500);
    await transaction(env.db, (conn) => rebuildTrades(conn, accountOf(b), [9_000_500]));
    await cached(a, 9_000_800);
    await cached(b, 9_000_200);

    const own = createDb(TEST_DB_URL);
    const [ta, tb] = [await own.getConnection(), await own.getConnection()];
    try {
      for (const conn of [ta, tb]) {
        await conn.query("SET SESSION innodb_lock_wait_timeout = 5");
        await conn.beginTransaction();
      }
      // Each sync's first batch has a still-open position without a row; its next batch a closed one in the same gap.
      await rebuildTrades(ta, accountOf(a), [9_000_900]);
      await rebuildTrades(tb, accountOf(b), [9_000_100]);
      const built = (conn: typeof ta, x: Acct, id: number) => rebuildTrades(conn, accountOf(x), [id]).then(() => "built", (e: { code?: string }) => e.code);
      const first = built(ta, a, 9_000_800);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const second = await built(tb, b, 9_000_200);
      expect([await first, second]).toEqual(["built", "built"]);
      await ta.commit();
      await tb.commit();
    } finally {
      for (const conn of [ta, tb]) {
        await conn.rollback().catch(() => undefined);
        conn.release();
      }
      await own.end();
    }
    const built = await rows<{ mt5_account_id: number; position_id: number }>(
      env.db, "SELECT mt5_account_id, position_id FROM mt5_trades WHERE mt5_account_id IN (?, ?) ORDER BY mt5_account_id, position_id", [a.id, b.id],
    );
    expect(built.map((r) => [Number(r.mt5_account_id), Number(r.position_id)])).toEqual([[a.id, 9_000_800], [b.id, 9_000_200], [b.id, 9_000_500]]);
  });

  it("syncs in the background: a day's wait first, then active clients', never switched-off servers, and skips a server it cannot reach", async () => {
    await exec(env.db, "UPDATE mt5_accounts SET deals_synced_at = CURRENT_TIMESTAMP(3)");
    const quiet = await makeClient();
    await exec(env.db, "UPDATE client_sessions SET last_seen_at = CURRENT_TIMESTAMP(3) - INTERVAL 2 DAY WHERE client_id = ?", [quiet.id]);
    const busy = await makeClient();
    const quietOverdue = await openAccount(quiet.id);
    const quietRecent = await openAccount(quiet.id);
    const busyNever = await openAccount(busy.id, { server: "demo" });
    const busyDue = await openAccount(busy.id);
    const busyFresh = await openAccount(busy.id);
    await openAccount(busy.id, { server: "off" });
    await openAccount(busy.id, { status: "failed" });
    await stale(quietOverdue, "2 DAY");
    await stale(quietRecent, "1 HOUR");
    await stale(busyDue, "10 MINUTE");
    await stale(busyFresh, "1 MINUTE");

    let mark = pageCalls().length;
    expect(await syncDealsOnce(env.db, fake, silent)).toEqual({ accounts: 3, complete: 3, partial: 0, failed: 0, skipped: 0 });
    expect(pageCalls().slice(mark).map((x) => x.req.login)).toEqual([busyNever.login, quietOverdue.login, busyDue.login]);
    expect(await syncDealsOnce(env.db, fake, silent)).toMatchObject({ accounts: 0 });

    await stale(quietOverdue, "4 DAY");
    await stale(quietRecent, "2 DAY");
    await stale(busyNever, "3 DAY");
    mark = pageCalls().length;
    expect(await syncDealsOnce(env.db, fake, silent, { limit: 1 })).toMatchObject({ accounts: 1 });
    expect(pageCalls().slice(mark).map((x) => x.req.login)).toEqual([busyNever.login]);

    // The live server is out of reach: its first account fails, its others wait; demo is still synced.
    await stale(busyNever, "3 DAY");
    fake.failNext("deals.page", { kind: "unavailable" }, 1, (r) => r.server === "live");
    mark = pageCalls().length;
    expect(await syncDealsOnce(env.db, fake, silent)).toMatchObject({ accounts: 2, complete: 1, failed: 1 });
    expect(pageCalls().slice(mark).map((x) => x.req.login)).toEqual([busyNever.login, quietOverdue.login]);
    expect((await syncState(quietOverdue))!.deals_sync_error).toMatch(/^unavailable\//);
    expect(Date.now() - (await syncState(quietRecent))!.deals_synced_at!.getTime()).toBeGreaterThan(DAY);

    // The loop in the server process: off without MT5; with it, a pass on its schedule.
    expect(startMt5DealSync(env.db, null, pino({ level: "silent" }))()).toBeUndefined();
    const stop = startMt5DealSync(env.db, fake, pino({ level: "silent" }), 25);
    try {
      await waitFor(async () => Date.now() - (await syncState(quietRecent))!.deals_synced_at!.getTime() < MINUTE);
    } finally {
      stop();
    }
  });

  // ---------- Staff ----------

  it("shows staff an account's trades and sync status, scoped to their clients, with mt5.view", async () => {
    const c = await makeClient(sales.staffId);
    const a = await openAccount(c.id);
    const unassigned = await makeClient();
    const b = await openAccount(unassigned.id);
    const p1 = trade(a, { openAt: t0, closeAt: t0 + HOUR, profit: 1_000, commission: -100, swap: -20 });
    const p2 = trade(a, { openAt: t0 + 2 * HOUR, closeAt: t0 + 3 * HOUR, side: 1, lots: 0.25, profit: -400 });
    await syncAccountDeals(env.db, fake, a.id, silent);

    const res = await get(support, `/api/staff/mt5/accounts/${a.id}/trades?pageSize=1`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      items: [
        {
          id: String(p2), positionId: p2, reversalTicket: null, symbol: "EURUSD", side: "sell", volume: 2_500, lots: 0.25, openPrice: "1.10000", closePrice: "1.10100", openedAt: iso(t0 + 2 * HOUR), closedAt: iso(t0 + 3 * HOUR),
          profitCents: -400, commissionCents: 0, swapCents: 0, feeCents: 0, netCents: -400,
        },
      ],
      page: 1, pageSize: 1, total: 2, pages: 2,
      totals: { trades: 2, lots: 1.25, profitCents: 600, commissionCents: -200, swapCents: -20, feeCents: 0, netCents: 380 },
      sync: { syncedUntil: expect.stringMatching(ISO), syncedAt: expect.stringMatching(ISO), error: null, partial: false, running: false },
    });
    expect((await get(support, `/api/staff/mt5/accounts/${a.id}/trades?page=2&pageSize=1`)).body.items.map((t: { positionId: number }) => t.positionId)).toEqual([p1]);

    expect((await get(sales, `/api/staff/mt5/accounts/${a.id}/trades`)).status).toBe(200);
    const hidden = await get(sales, `/api/staff/mt5/accounts/${b.id}/trades`);
    expect(hidden.status).toBe(404);
    expect(hidden.body.error.message).toBe("That MT5 account does not exist or its client is not assigned to you.");
    expect((await get(desk, `/api/staff/mt5/accounts/${a.id}/trades`)).status).toBe(403);
    expect((await get(support, "/api/staff/mt5/accounts/abc/trades")).status).toBe(400);
    expect((await request(env.app).get(`/api/staff/mt5/accounts/${a.id}/trades`)).status).toBe(401);
    // The account page itself is still the MT5 router's.
    expect((await get(support, `/api/staff/mt5/accounts/${a.id}`)).body.account).toMatchObject({ id: a.id, login: a.login });
  });

  it("lets staff sync an account now, audited, with MT5's problem in the answer", async () => {
    const c = await makeClient(sales.staffId);
    const a = await openAccount(c.id);
    trade(a, { openAt: t0, closeAt: t0 + HOUR });
    const res = await post(sales, `/api/staff/mt5/accounts/${a.id}/sync-deals`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      result: { outcome: "complete", pages: 1, deals: 2, newDeals: 2, trades: 1, error: null },
      sync: { syncedUntil: expect.stringMatching(ISO), syncedAt: expect.stringMatching(ISO), error: null, partial: false, running: false },
    });
    const audit = await one<{ actor_type: string; actor_id: number; entity_id: string; meta_json: Record<string, unknown> }>(
      env.db, "SELECT actor_type, actor_id, entity_id, meta_json FROM audit_log WHERE action = 'mt5.account.deals_synced' ORDER BY id DESC LIMIT 1",
    );
    expect(audit).toMatchObject({ actor_type: "staff", actor_id: sales.staffId, entity_id: String(c.id), meta_json: { accountId: a.id, login: a.login, outcome: "complete", pages: 1, newDeals: 2 } });

    fake.failNext("deals.page", { kind: "unavailable" });
    const failed = await post(support, `/api/staff/mt5/accounts/${a.id}/sync-deals`);
    expect(failed.status).toBe(200);
    expect(failed.body.result).toMatchObject({ outcome: "failed", error: { kind: "unavailable", code: "connection" } });
    expect(failed.body.sync.error).toMatch(/^unavailable\/connection/);

    expect((await post(desk, `/api/staff/mt5/accounts/${a.id}/sync-deals`)).status).toBe(403);
    const elsewhere = await openAccount((await makeClient()).id);
    expect((await post(sales, `/api/staff/mt5/accounts/${elsewhere.id}/sync-deals`)).status).toBe(404);
    const notOpen = await openAccount(c.id, { status: "failed" });
    expect((await post(support, `/api/staff/mt5/accounts/${notOpen.id}/sync-deals`)).status).toBe(409);
    const switchedOff = await openAccount(c.id, { server: "off" });
    expect((await post(support, `/api/staff/mt5/accounts/${switchedOff.id}/sync-deals`)).body.error.code).toBe("MT5_SERVER_OFF");
    // Same origin and the CSRF token, as every staff change.
    expect((await support.agent.post(`/api/staff/mt5/accounts/${a.id}/sync-deals`).send({})).status).toBe(403);
  });
});
