import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import pino from "pino";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadGatewayConfig } from "../src/gateway/config";
import { createGatewayLogger } from "../src/gateway/log";
import { createGatewayServer, type GatewayServer } from "../src/gateway/server";
import { createApp } from "../src/server/app";
import { createClientSession } from "../src/server/clients/session";
import { exec, one, rows, transaction } from "../src/server/lib/db";
import { syncAccountDeals } from "../src/server/mt5/deals";
import { httpGateway, type Mt5Gateway } from "../src/server/mt5/gateway";
import { mt5Reference } from "../src/server/mt5/references";
import { startFakeMt5, type FakeDeal, type FakeMt5 } from "./fakes/mt5-webapi";
import { createStaff, hasDb, post, setup, signIn, type SignedIn, type TestEnv } from "./helpers";

// Trade history the way it runs in production: the CRM's httpGateway, the
// real gateway server and fake MT5 servers over TLS whose clocks are not
// UTC (live three hours ahead, demo five behind), with MT5 answering fewer
// deals per page than asked for. What the CRM stores and shows must be UTC.

const SECRET = `crm-gw-${randomBytes(16).toString("hex")}`;
const STANDARD = "real\\standard";
const DEMO_GROUP = "demo\\usd";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe.skipIf(!hasDb)("MT5 trade history end to end: CRM, gateway and MT5 over TLS", () => {
  let env: TestEnv;
  let live: FakeMt5;
  let demo: FakeMt5;
  let gateway: GatewayServer;
  let mt5: Mt5Gateway;
  let staff: SignedIn;
  let seq = 0;
  let position = 8_800_000;
  const lines: string[] = [];
  const log = pino({ level: "debug" }, { write: (line: string) => void lines.push(line) });
  const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const iso = (ms: number) => new Date(ms).toISOString();

  async function makeClient() {
    seq++;
    const r = await exec(
      env.db,
      "INSERT INTO clients (email, first_name, last_name, referral_code, source, kyc_status, status) VALUES (?, 'Ola', 'Ng', ?, 'portal', 'approved', 'active')",
      [`e2e.history.${seq}@client.test`, `EH${String(seq).padStart(8, "0")}`],
    );
    const { token } = await transaction(env.db, (conn) => createClientSession(conn, env.config, r.insertId, "127.0.0.1", "vitest"));
    return { id: r.insertId, token };
  }

  /** An open account in the CRM for a user made straight in the fake MT5. */
  async function openAccount(clientId: number, server: "live" | "demo") {
    const fake = server === "live" ? live : demo;
    const user = fake.addUser({ group: server === "live" ? STANDARD : DEMO_GROUP });
    const r = await exec(
      env.db,
      `INSERT INTO mt5_accounts (client_id, server_code, login, is_demo, package_name, mt5_group, leverage, status, create_ref, created_at)
       VALUES (?, ?, ?, ?, 'Classic', ?, 2000, 'active', ?, ?)`,
      [clientId, server, user.login, server === "demo" ? 1 : 0, user.group, mt5Reference("A"), new Date(Date.now() - 30 * DAY)],
    );
    return { id: r.insertId, login: user.login, fake, tz: server === "live" ? 180 : -300 };
  }

  /** A closed position, its two deals dated on the MT5 server's own clock. */
  function trade(a: Awaited<ReturnType<typeof openAccount>>, openAt: number, closeAt: number, profitCents: number) {
    const id = ++position;
    const serverTime = (utc: number) => utc / 1000 + a.tz * 60;
    a.fake.addDeal({ login: a.login, action: 0, entry: 0, positionId: id, symbol: "EURUSD", volume: 10_000, price: "1.08500", commissionCents: -300, time: serverTime(openAt) });
    a.fake.addDeal({ login: a.login, action: 1, entry: 1, positionId: id, symbol: "EURUSD", volume: 10_000, price: "1.08750", profitCents, commissionCents: -300, time: serverTime(closeAt) });
    return id;
  }

  beforeAll(async () => {
    live = await startFakeMt5({ managers: { 9000: "Live-Manager-1!" }, tzOffsetMinutes: 180, pageLimit: 40 });
    demo = await startFakeMt5({ managers: { 9100: "Demo-Manager-2!" }, tzOffsetMinutes: -300, firstLogin: 7_000_001 });
    gateway = createGatewayServer(
      loadGatewayConfig({
        GATEWAY_SECRET: SECRET,
        GATEWAY_SERVERS: "live,demo",
        GATEWAY_SERVER_LIVE_HOST: live.host,
        GATEWAY_SERVER_LIVE_PORT: String(live.port),
        GATEWAY_SERVER_LIVE_LOGIN: "9000",
        GATEWAY_SERVER_LIVE_PASSWORD: "Live-Manager-1!",
        GATEWAY_SERVER_LIVE_CERT_SHA256: live.certSha256,
        GATEWAY_SERVER_LIVE_GROUPS: STANDARD,
        GATEWAY_SERVER_LIVE_TZ_OFFSET_MINUTES: "180",
        GATEWAY_SERVER_DEMO_HOST: demo.host,
        GATEWAY_SERVER_DEMO_PORT: String(demo.port),
        GATEWAY_SERVER_DEMO_LOGIN: "9100",
        GATEWAY_SERVER_DEMO_PASSWORD: "Demo-Manager-2!",
        GATEWAY_SERVER_DEMO_CERT_SHA256: demo.certSha256,
        GATEWAY_SERVER_DEMO_DEMO_GROUPS: DEMO_GROUP,
        GATEWAY_SERVER_DEMO_TZ_OFFSET_MINUTES: "-300",
      }),
      { log: createGatewayLogger("silent", { write: () => undefined }), pingIntervalMs: 0 },
    );
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    const port = (gateway.address() as AddressInfo).port;
    env = await setup({ CRM_MT5_GATEWAY_URL: `http://127.0.0.1:${port}`, CRM_MT5_GATEWAY_SECRET: SECRET });
    mt5 = httpGateway({ url: env.config.mt5Gateway!.url, secret: env.config.mt5Gateway!.secret, fetch, log });
    env.app = createApp({ db: env.db, config: env.config, log, fetch: (async () => new Response("", { status: 503 })) as typeof fetch, mt5 });
    await exec(env.db, "INSERT INTO mt5_servers (code, label, is_enabled) VALUES ('live', 'Live', 1), ('demo', 'Demo', 1)");
    await createStaff(env.db, "dealer@crm.test", "dealing");
    staff = await signIn(env, "dealer@crm.test");
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => gateway?.close(() => resolve()));
    await live?.close();
    await demo?.close();
    await env?.db.end();
  });

  it("stores and shows UTC times whatever the trade servers' clocks, and filters by UTC days", async () => {
    const c = await makeClient();
    const a = await openAccount(c.id, "live");
    const d = await openAccount(c.id, "demo");
    const midnight = Math.floor((Date.now() - 3 * DAY) / DAY) * DAY;
    // 23:10 UTC: already the next day on the live server's clock (02:10), still the same day on demo's (18:10).
    const p1 = trade(a, midnight + 22 * HOUR, midnight + 23 * HOUR + 10 * MINUTE, 2_500);
    // 01:00 UTC the next day: still the day before on demo's clock (20:00).
    const p2 = trade(d, midnight + DAY + 30 * MINUTE, midnight + DAY + HOUR, -1_200);

    const res = await request(env.app).get("/api/trade-history").set({ Authorization: `Bearer ${c.token}` });
    expect(res.status).toBe(200);
    expect(res.body.trades).toEqual([
      expect.objectContaining({ id: `${d.login}-${p2}`, opened_at: iso(midnight + DAY + 30 * MINUTE), closed_at: iso(midnight + DAY + HOUR), pnl: -12, commission: -6 }),
      expect.objectContaining({ id: `${a.login}-${p1}`, opened_at: iso(midnight + 22 * HOUR), closed_at: iso(midnight + 23 * HOUR + 10 * MINUTE), pnl: 25, open_price: 1.085, close_price: 1.0875 }),
    ]);
    const day = (ms: number) => iso(ms).slice(0, 10);
    const on = async (date: string) =>
      (await request(env.app).get(`/api/trade-history?from_date=${date}&to_date=${date}`).set({ Authorization: `Bearer ${c.token}` })).body.trades.map((t: { id: string }) => t.id);
    expect(await on(day(midnight))).toEqual([`${a.login}-${p1}`]);
    expect(await on(day(midnight + DAY))).toEqual([`${d.login}-${p2}`]);

    const stored = await one<{ time_server: number; time_utc: Date }>(env.db, "SELECT time_server, time_utc FROM mt5_deals WHERE mt5_account_id = ? AND entry = 1", [a.id]);
    expect(Number(stored!.time_server)).toBe((midnight + 23 * HOUR + 10 * MINUTE) / 1000 + 180 * 60);
    expect(stored!.time_utc.toISOString()).toBe(iso(midnight + 23 * HOUR + 10 * MINUTE));
  });

  it("reads every page when MT5 answers fewer deals than asked for, and staff sync through the real gateway", async () => {
    const c = await makeClient();
    const a = await openAccount(c.id, "live");
    const start = Math.floor((Date.now() - 5 * DAY) / MINUTE) * MINUTE;
    for (let i = 0; i < 55; i++) trade(a, start + i * HOUR, start + i * HOUR + 20 * MINUTE, 100);
    // 110 deals at 40 a page.
    const first = await syncAccountDeals(env.db, mt5, a.id, silent);
    expect(first).toEqual({ outcome: "complete", pages: 3, deals: 110, newDeals: 110, trades: 55, error: null });

    const recent = Math.floor(Date.now() / MINUTE) * MINUTE;
    trade(a, recent - 2 * HOUR, recent - HOUR, 900);
    const res = await post(staff, `/api/staff/mt5/accounts/${a.id}/sync-deals`);
    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ outcome: "complete", newDeals: 2, trades: 1, error: null });
    const shown = await staff.agent.get(`/api/staff/mt5/accounts/${a.id}/trades?pageSize=100`);
    expect(shown.body).toMatchObject({ total: 56, totals: { trades: 56, profitCents: 55 * 100 + 900, commissionCents: -600 * 56 } });
    expect(shown.body.items[0]).toMatchObject({ profitCents: 900, closedAt: expect.any(String) });

    // MT5 refusing the group (the gateway's list no longer has it) is the sync's error, in MT5's and the gateway's words, for staff.
    const odd = live.addUser({ group: "real\\vip" });
    const r = await exec(
      env.db,
      `INSERT INTO mt5_accounts (client_id, server_code, login, is_demo, package_name, mt5_group, leverage, status, create_ref) VALUES (?, 'live', ?, 0, 'VIP', 'real\\\\vip', 2000, 'active', ?)`,
      [c.id, odd.login, mt5Reference("A")],
    );
    const refused = await syncAccountDeals(env.db, mt5, r.insertId, silent);
    expect(refused).toMatchObject({ outcome: "failed", error: { kind: "refused", code: "group_not_allowed" } });
    // Nothing about any of this reaches the client.
    const client = await request(env.app).get("/api/trade-history").set({ Authorization: `Bearer ${c.token}` });
    expect(client.body.pagination.total).toBe(56);
    expect(JSON.stringify(client.body)).not.toMatch(/group|vip|gateway|refused/i);
    // And no secret in the CRM's logs.
    expect(lines.join("\n")).not.toContain(SECRET);
  });

  it("builds a netting reversal's two parts from deals MT5 pages apart, and the same rows again when the next sync reads them over", async () => {
    const c = await makeClient();
    const a = await openAccount(c.id, "live");
    const t = Math.floor((Date.now() - 10 * HOUR) / MINUTE) * MINUTE;
    const p = ++position;
    const deal = (at: number, d: Partial<FakeDeal>) => a.fake.addDeal({ positionId: p, symbol: "GBPUSD", ...d, login: a.login, time: at / 1000 + a.tz * 60 });
    // Sold two lots; bought three (closing the two and opening one bought); sold that lot. Twenty other trades in
    // between each, so MT5's 40-deal pages put the opening, the reversal and the close on three pages.
    deal(t, { action: 1, entry: 0, volume: 20_000, price: "1.27000", commissionCents: -700 });
    for (let i = 1; i <= 20; i++) trade(a, t + i * MINUTE, t + i * MINUTE + 30_000, 10);
    const reversal = deal(t + HOUR, { action: 0, entry: 2, volume: 30_000, price: "1.26500", profitCents: 10_000, commissionCents: -1_050 });
    for (let i = 1; i <= 20; i++) trade(a, t + HOUR + i * MINUTE, t + HOUR + i * MINUTE + 30_000, 10);
    deal(t + 3 * HOUR, { action: 1, entry: 1, volume: 10_000, price: "1.26800", profitCents: 3_000, commissionCents: -350, swapCents: -25 });

    expect(await syncAccountDeals(env.db, mt5, a.id, silent)).toMatchObject({ outcome: "complete", pages: 3, deals: 83, newDeals: 83 });
    const res = await request(env.app).get("/api/trade-history?per_page=500").set({ Authorization: `Bearer ${c.token}` });
    const L = `${a.login}-${p}`;
    expect(res.body.trades.filter((x: { ticket: number }) => x.ticket === p)).toEqual([
      expect.objectContaining({
        id: `${L}-r${reversal.ticket}`, symbol: "GBPUSD", side: 0, type: "buy", volume: 1, open_price: 1.265, close_price: 1.268, pnl: 30, commission: -3.5, swap: -0.25,
        opened_at: iso(t + HOUR), closed_at: iso(t + 3 * HOUR),
      }),
      expect.objectContaining({ id: L, side: 1, type: "sell", volume: 2, open_price: 1.27, close_price: 1.265, pnl: 100, commission: -17.5, swap: 0, opened_at: iso(t), closed_at: iso(t + HOUR) }),
    ]);
    // 40 other trades (10 cents and 6 dollars of commission each) and the two parts.
    expect(res.body.summary).toEqual({ total_trades: 42, total_profit: 134, total_volume: 43, total_commission: -261 });

    // The next sync reads the last two days again through the gateway, all of this with them: the same rows, none rewritten.
    const stored = () => rows<Record<string, unknown>>(env.db, "SELECT * FROM mt5_trades WHERE mt5_account_id = ? ORDER BY position_id, segment", [a.id]);
    const before = await stored();
    expect(before.filter((r) => Number(r.position_id) === p).map((r) => Number(r.segment))).toEqual([0, reversal.ticket]);
    expect(await syncAccountDeals(env.db, mt5, a.id, silent)).toMatchObject({ outcome: "complete", deals: 83, newDeals: 0 });
    expect(await stored()).toEqual(before);
  });
});
