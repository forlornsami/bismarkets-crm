import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadGatewayConfig } from "../src/gateway/config";
import { createGatewayLogger } from "../src/gateway/log";
import { Mt5Connection, TransportError } from "../src/gateway/mt5/connection";
import { testAccess, userGet } from "../src/gateway/mt5/webapi";
import { HEADERS, requestSignature, responseSignature, sameHex } from "../src/gateway/protocol";
import { createGatewayServer, type GatewayServer } from "../src/gateway/server";
import { GatewayError, httpGateway, type Mt5Gateway } from "../src/server/mt5/gateway";
import { startFakeMt5, type FakeMt5 } from "./fakes/mt5-webapi";

// The gateway as it runs: the CRM's own client (httpGateway) → the gateway's
// HTTP server → real TLS with a pinned certificate → a fake MT5 that does the
// real sign-in and ties sessions to sockets. No MySQL needed.

const SECRET = `gw-test-${randomBytes(16).toString("hex")}`;
const MANAGER_PASSWORD = "Manager-Pass-1";
const STANDARD = "real\\standard";
const PRO = "real\\pro";
const VIP = "real\\vip"; // exists in MT5, but the gateway does not allow it
const DEMO = "demo\\standard";
const MAIN = "Main-Pass-7a!";
const INVESTOR = "Invest-Pass-7b!";
const NEW_MAIN = "New-Main-9c!";
const NEW_INVESTOR = "New-Inv-9d!";

const logLines: string[] = [];
const sink = { write: (line: string) => void logLines.push(line) };
const fakes: FakeMt5[] = [];

let refSeq = 0;
const ref = (letter: "A" | "T" | "D") => `BIS-${letter}${String(++refSeq).padStart(8, "0")}`;
const nowIso = () => new Date().toISOString();

function gatewayEnv(fake: FakeMt5, overrides: Record<string, string> = {}) {
  return {
    GATEWAY_SECRET: SECRET,
    GATEWAY_LOG_LEVEL: "debug",
    GATEWAY_SERVERS: "live",
    GATEWAY_SERVER_LIVE_HOST: fake.host,
    GATEWAY_SERVER_LIVE_PORT: String(fake.port),
    GATEWAY_SERVER_LIVE_LOGIN: "9000",
    GATEWAY_SERVER_LIVE_PASSWORD: MANAGER_PASSWORD,
    GATEWAY_SERVER_LIVE_CERT_SHA256: fake.certSha256,
    GATEWAY_SERVER_LIVE_GROUPS: `${STANDARD},${PRO}`,
    GATEWAY_SERVER_LIVE_DEMO_GROUPS: DEMO,
    GATEWAY_SERVER_LIVE_TZ_OFFSET_MINUTES: "180",
    GATEWAY_LEVERAGES: "100,500,2000",
    ...overrides,
  };
}

interface Running {
  server: GatewayServer;
  url: string;
  gw: Mt5Gateway;
  close(): Promise<void>;
}

async function newFake(opts: Parameters<typeof startFakeMt5>[0] = {}) {
  const fake = await startFakeMt5({ tzOffsetMinutes: 180, ...opts });
  fakes.push(fake);
  return fake;
}

async function startGateway(fake: FakeMt5, overrides: Record<string, string> = {}, pingIntervalMs = 0): Promise<Running> {
  const config = loadGatewayConfig(gatewayEnv(fake, overrides));
  const server = createGatewayServer(config, { log: createGatewayLogger("debug", sink), pingIntervalMs });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, url, gw: httpGateway({ url, secret: SECRET, fetch }), close: () => new Promise((resolve) => server.close(() => resolve())) };
}

/** The GatewayError a call ends with. */
async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GatewayError) return { kind: error.kind, code: error.code, retcode: error.retcode, message: error.message };
    throw error;
  }
  throw new Error("expected the gateway to refuse");
}

/** A request made by hand, to test what httpGateway would never send. */
async function rawPost(url: string, path: string, body: string, opts: { secret?: string; timestamp?: number; nonce?: string; signature?: string } = {}) {
  const timestamp = String(opts.timestamp ?? Date.now());
  const nonce = opts.nonce ?? randomBytes(16).toString("hex");
  const signature = opts.signature ?? requestSignature(opts.secret ?? SECRET, timestamp, nonce, path, body);
  const res = await fetch(url + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", [HEADERS.timestamp]: timestamp, [HEADERS.nonce]: nonce, [HEADERS.signature]: signature },
    body,
  });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text), signed: sameHex(res.headers.get(HEADERS.signature), responseSignature(SECRET, nonce, res.status, text)) };
}

const pathsSince = (fake: FakeMt5, since: number) => fake.state.requests.slice(since).map((r) => r.path);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const dealsWith = (fake: FakeMt5, comment: string) => fake.state.deals.filter((d) => d.comment === comment);

afterAll(async () => {
  for (const fake of fakes) {
    // Invariants of the whole suite: nothing was ever sent on a socket that
    // had not signed in, and no update tried to move an account to another group.
    expect(fake.state.unauthenticated).toBe(0);
    expect(fake.state.groupChanges).toBe(0);
    await fake.close();
  }
  // Nothing secret ever reached the log.
  const all = logLines.join("");
  for (const secret of [SECRET, MANAGER_PASSWORD, MAIN, INVESTOR, NEW_MAIN, NEW_INVESTOR, "Weakpass1", "Secret-Value-1!"]) expect(all).not.toContain(secret);
});

describe("MT5 gateway", () => {
  let fake: FakeMt5;
  let g: Running;
  let gw: Mt5Gateway;

  beforeAll(async () => {
    fake = await newFake();
    g = await startGateway(fake);
    gw = g.gw;
  });
  afterAll(() => g.close());
  afterEach(() => fake.faults.clear());

  describe("who may call it", () => {
    it("answers /healthz with ok only", async () => {
      const res = await fetch(`${g.url}/healthz`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });

    it("signs its answers to a signed request", async () => {
      const res = await rawPost(g.url, "/v1/ping", '{"server":"live"}');
      expect(res.status).toBe(200);
      expect(res.signed).toBe(true);
      expect(res.json.ok).toBe(true);
    });

    it("refuses a wrong signature, an old or future time and a replay, unsigned and before MT5 hears of it", async () => {
      const before = fake.state.requests.length;
      const body = '{"server":"live"}';
      const wrong = await rawPost(g.url, "/v1/ping", body, { secret: "another-secret-another-secret-123" });
      expect(wrong).toMatchObject({ status: 401, signed: false, json: { ok: false, error: { code: "bad_signature" } } });
      expect((await rawPost(g.url, "/v1/ping", body, { timestamp: Date.now() - 31_000 })).status).toBe(401);
      expect((await rawPost(g.url, "/v1/ping", body, { timestamp: Date.now() + 31_000 })).status).toBe(401);
      expect((await rawPost(g.url, "/v1/ping", body, { signature: "zz" })).status).toBe(401);
      const nonce = randomBytes(16).toString("hex");
      const timestamp = Date.now();
      expect((await rawPost(g.url, "/v1/ping", body, { nonce, timestamp })).status).toBe(200);
      const replay = await rawPost(g.url, "/v1/ping", body, { nonce, timestamp });
      expect(replay).toMatchObject({ status: 401, signed: false });
      expect(replay.json.error.message).toMatch(/replayed/);
      // Only the one good ping reached MT5.
      expect(pathsSince(fake, before).filter((p) => !p.startsWith("/api/auth/"))).toEqual(["/api/time/server"]);
    });

    it("refuses a large body, an unknown operation, extra keys and other methods", async () => {
      const big = await rawPost(g.url, "/v1/ping", JSON.stringify({ server: "live", pad: "x".repeat(17 * 1024) }));
      expect(big.status).toBe(413);
      expect((await rawPost(g.url, "/v1/user.delete", '{"server":"live","login":1}')).status).toBe(400);
      expect((await rawPost(g.url, "/v1/ping?x=1", '{"server":"live"}')).status).toBe(400);
      const extra = await rawPost(g.url, "/v1/user.get", '{"server":"live","login":5,"password":"Secret-Value-1!"}');
      expect(extra).toMatchObject({ status: 400, signed: false });
      expect(extra.text).not.toContain("Secret-Value-1!");
      expect((await rawPost(g.url, "/v1/user.get", '{"server":"live","login":"5"}')).status).toBe(400);
      expect((await rawPost(g.url, "/v1/ping", "not json")).status).toBe(400);
      expect((await fetch(`${g.url}/v1/ping`)).status).toBe(404);
    });

    it("is unverifiable to a CRM with the wrong secret: unavailable for a read, unknown for a write", async () => {
      const before = fake.state.requests.length;
      const wrong = httpGateway({ url: g.url, secret: "the-wrong-secret-the-wrong-secret!", fetch });
      expect(await failure(wrong.call("ping", { server: "live" }))).toMatchObject({ kind: "unavailable", code: "bad_signature" });
      const write = wrong.call("balance", { server: "live", login: 1, amountCents: 100, comment: ref("T"), checkMargin: false, notBefore: nowIso() });
      expect(await failure(write)).toMatchObject({ kind: "unknown", code: "bad_signature" });
      expect(fake.state.requests.length).toBe(before);
    });

    it("refuses a server it does not have", async () => {
      expect(await failure(gw.call("ping", { server: "demo" }))).toMatchObject({ kind: "bad_request", code: "policy" });
    });
  });

  describe("operations", () => {
    it("ping answers MT5's clock", async () => {
      const { serverTime } = await gw.call("ping", { server: "live" });
      expect(Math.abs(serverTime! - fake.serverNow())).toBeLessThanOrEqual(5);
    });

    it("user.get reads the account, with registration time in UTC", async () => {
      const u = fake.addUser({ group: STANDARD, name: "Ali Khan", comment: "BIS-A00000000", leverage: 500, registration: 1_700_010_800 });
      expect(await gw.call("user.get", { server: "live", login: u.login })).toEqual({
        login: u.login, group: STANDARD, name: "Ali Khan", email: u.email, leverage: 500, rights: "355", enabled: true, tradeDisabled: false,
        comment: "BIS-A00000000", registeredAt: "2023-11-14T22:13:20.000Z",
      });
      expect(await failure(gw.call("user.get", { server: "live", login: 999_999 }))).toMatchObject({ kind: "refused", code: "not_found", retcode: 13 });
    });

    it("accounts.get reads exact cents and lists logins MT5 does not know", async () => {
      const a = fake.addUser({ group: STANDARD, balanceCents: 123_456, creditCents: 500, marginCents: 1_000, profitCents: -2_001 });
      const b = fake.addUser({ group: DEMO, balanceCents: 1 });
      const result = await gw.call("accounts.get", { server: "live", logins: [a.login, 888_888, b.login, a.login] });
      expect(result.missing).toEqual([888_888]);
      expect(result.accounts).toEqual([
        { login: a.login, balanceCents: 123_456, creditCents: 500, equityCents: 121_955, marginCents: 1_000, marginFreeCents: 120_955, profitCents: -2_001 },
        { login: b.login, balanceCents: 1, creditCents: 0, equityCents: 1, marginCents: 0, marginFreeCents: 1, profitCents: 0 },
      ]);
    });

    it("user.create opens an account that user.find then finds by its reference", async () => {
      const comment = ref("A");
      const { login } = await gw.call("user.create", {
        server: "live", group: PRO, leverage: 2000, name: "Sara Ahmed", email: "sara@client.test", country: "Pakistan", comment, password: MAIN, investorPassword: INVESTOR,
      });
      const made = fake.state.users.get(login)!;
      expect(made).toMatchObject({ group: PRO, leverage: 2000, name: "Sara Ahmed", comment, mainPassword: MAIN, investorPassword: INVESTOR, rights: 0x163n });
      expect(await gw.call("user.find", { server: "live", group: PRO, comment })).toEqual({ login });
      expect(await gw.call("user.find", { server: "live", group: PRO, comment: ref("A") })).toEqual({ login: null });
    });

    it("user.create refuses what MT5 or the gateway's rules refuse", async () => {
      const base = { server: "live", group: STANDARD, leverage: 2000, name: "N", email: "n@client.test", country: "", comment: ref("A"), password: MAIN, investorPassword: INVESTOR };
      expect(await failure(gw.call("user.create", { ...base, password: "Weakpass1" }))).toMatchObject({ kind: "refused", code: "invalid_password", retcode: 3006 });
      const before = fake.state.requests.length;
      expect(await failure(gw.call("user.create", { ...base, leverage: 1000 }))).toMatchObject({ kind: "bad_request", code: "policy" });
      expect(await failure(gw.call("user.create", { ...base, investorPassword: MAIN }))).toMatchObject({ kind: "bad_request", code: "policy" });
      expect(await failure(gw.call("user.create", { ...base, group: VIP }))).toMatchObject({ kind: "refused", code: "group_not_allowed" });
      expect(fake.state.requests.length).toBe(before);
    });

    it("user.update changes only leverage and the two rights bits, sending the rest back as it was", async () => {
      const u = fake.addUser({ group: STANDARD, rights: 0x8000_0000_0000_0163n, extra: { Phone: "+92300", LeadSource: "web", Color: "4278190080" } });
      const archived = await gw.call("user.update", { server: "live", login: u.login, tradeDisabled: true });
      expect(archived).toMatchObject({ tradeDisabled: true, enabled: true, rights: (0x8000_0000_0000_0167n).toString() });
      expect(fake.state.users.get(u.login)!.rights).toBe(0x8000_0000_0000_0167n);
      const suspended = await gw.call("user.update", { server: "live", login: u.login, enabled: false, tradeDisabled: false, leverage: 500 });
      expect(suspended).toMatchObject({ enabled: false, tradeDisabled: false, leverage: 500 });
      const after = fake.state.users.get(u.login)!;
      expect(after).toMatchObject({ rights: 0x8000_0000_0000_0162n, leverage: 500, group: STANDARD, extra: { Phone: "+92300", LeadSource: "web", Color: "4278190080" } });
      // Already so: nothing is sent.
      const updates = fake.state.updates.length;
      await gw.call("user.update", { server: "live", login: u.login, enabled: false, leverage: 500 });
      expect(fake.state.updates.length).toBe(updates);
      expect(await failure(gw.call("user.update", { server: "live", login: u.login, leverage: 3000 }))).toMatchObject({ kind: "bad_request", code: "policy" });
    });

    it("user.password sets the main and investor passwords", async () => {
      const u = fake.addUser({ group: STANDARD });
      await gw.call("user.password", { server: "live", login: u.login, type: "main", password: NEW_MAIN });
      await gw.call("user.password", { server: "live", login: u.login, type: "investor", password: NEW_INVESTOR });
      expect(fake.state.users.get(u.login)).toMatchObject({ mainPassword: NEW_MAIN, investorPassword: NEW_INVESTOR });
      expect(await failure(gw.call("user.password", { server: "live", login: u.login, type: "main", password: "Weakpass1" }))).toMatchObject({ kind: "refused", code: "invalid_password" });
    });

    it("positions.total counts open positions", async () => {
      const u = fake.addUser({ group: STANDARD });
      fake.state.positions.set(u.login, 3);
      expect(await gw.call("positions.total", { server: "live", login: u.login })).toEqual({ total: 3 });
    });

    it("balance credits and debits, and MT5's margin check refuses a debit it cannot cover", async () => {
      const u = fake.addUser({ group: STANDARD });
      const credit = await gw.call("balance", { server: "live", login: u.login, amountCents: 10_050, comment: ref("T"), checkMargin: false, notBefore: nowIso() });
      expect(credit.duplicate).toBe(false);
      const debit = await gw.call("balance", { server: "live", login: u.login, amountCents: -5_000, comment: ref("T"), checkMargin: true, notBefore: nowIso() });
      expect(debit.ticket).toBeGreaterThan(credit.ticket);
      expect(fake.state.users.get(u.login)!.balanceCents).toBe(5_050);
      expect(await failure(gw.call("balance", { server: "live", login: u.login, amountCents: -5_051, comment: ref("T"), checkMargin: true, notBefore: nowIso() })))
        .toMatchObject({ kind: "refused", code: "no_money", retcode: 10019 });
      // Taking money out without the margin check is never sent.
      expect(await failure(gw.call("balance", { server: "live", login: u.login, amountCents: -1, comment: ref("T"), checkMargin: false, notBefore: nowIso() })))
        .toMatchObject({ kind: "bad_request", code: "policy" });
      expect(await failure(gw.call("balance", { server: "live", login: u.login, amountCents: 1, comment: ref("T"), checkMargin: false, notBefore: "2020-01-01T00:00:00Z" })))
        .toMatchObject({ kind: "bad_request", code: "policy" });
      expect(fake.state.users.get(u.login)!.balanceCents).toBe(5_050);
    });

    it("deal.find finds a balance deal by its reference", async () => {
      const u = fake.addUser({ group: DEMO });
      const comment = ref("D");
      const { ticket } = await gw.call("balance", { server: "live", login: u.login, amountCents: 100_000, comment, checkMargin: false, notBefore: nowIso() });
      const from = new Date(Date.now() - 86_400_000).toISOString();
      const { deal } = await gw.call("deal.find", { server: "live", login: u.login, comment, from });
      expect(deal).toMatchObject({ ticket, login: u.login, action: 2, profitCents: 100_000, comment });
      expect(Date.parse(deal!.timeUtc)).toBeGreaterThan(Date.now() - 10_000);
      expect(await gw.call("deal.find", { server: "live", login: u.login, comment: ref("D"), from })).toEqual({ deal: null });
    });

    it("deals.page pages deals between two UTC times, converting from server time", async () => {
      const u = fake.addUser({ group: STANDARD });
      const base = fake.serverNow() - 3_600;
      for (const [i, profit] of [[0, 1_250], [60, -300], [120, 99]] as const) {
        fake.addDeal({ login: u.login, action: 0, entry: 1, symbol: "EURUSD", volume: 10_000, price: "1.08345", profitCents: profit, positionId: 7, time: base + i });
      }
      const utc = (serverSeconds: number) => new Date((serverSeconds - 180 * 60) * 1000).toISOString();
      const range = { server: "live", login: u.login, from: utc(base - 1), to: utc(base + 121) };
      const first = await gw.call("deals.page", { ...range, offset: 0, limit: 2 });
      expect(first.total).toBe(3);
      expect(first.deals.map((d) => d.profitCents)).toEqual([1_250, -300]);
      expect(first.deals[0]).toMatchObject({ symbol: "EURUSD", volume: 10_000, price: "1.08345", time: base, timeUtc: utc(base) });
      expect((await gw.call("deals.page", { ...range, offset: 2, limit: 2 })).deals.map((d) => d.profitCents)).toEqual([99]);
      expect(await gw.call("deals.page", { ...range, offset: 3, limit: 2 })).toEqual({ total: 3, deals: [] });
      // Times outside the window are outside.
      expect((await gw.call("deals.page", { ...range, from: utc(base + 1) , offset: 0, limit: 10 })).total).toBe(2);
    });
  });

  describe("group allow-list", () => {
    it("refuses every operation on an account in a group the gateway does not allow, and sends no write", async () => {
      const u = fake.addUser({ group: VIP });
      const before = fake.state.requests.length;
      const login = u.login;
      const calls = [
        () => gw.call("user.get", { server: "live", login }),
        () => gw.call("accounts.get", { server: "live", logins: [login] }),
        () => gw.call("positions.total", { server: "live", login }),
        () => gw.call("user.update", { server: "live", login, tradeDisabled: true }),
        () => gw.call("user.password", { server: "live", login, type: "main", password: NEW_MAIN }),
        () => gw.call("balance", { server: "live", login, amountCents: 100, comment: ref("T"), checkMargin: false, notBefore: nowIso() }),
        () => gw.call("deal.find", { server: "live", login, comment: ref("T"), from: nowIso() }),
        () => gw.call("deals.page", { server: "live", login, from: nowIso(), to: nowIso(), offset: 0, limit: 10 }),
        () => gw.call("user.find", { server: "live", group: VIP, comment: ref("A") }),
      ];
      for (const call of calls) expect(await failure(call())).toMatchObject({ kind: "refused", code: "group_not_allowed" });
      const sent = pathsSince(fake, before);
      expect(sent.every((p) => p === "/api/user/get" || p.startsWith("/api/auth/"))).toBe(true);
      expect(fake.state.users.get(login)).toMatchObject({ rights: 0x163n, mainPassword: "Main-Pass-1", balanceCents: 0 });
    });
  });

  describe("balance: idempotent by reference, and honest about lost answers", () => {
    it("sends a reference once: a repeat returns the first deal's ticket", async () => {
      const u = fake.addUser({ group: STANDARD });
      const comment = ref("T");
      const req = { server: "live", login: u.login, amountCents: 2_500, comment, checkMargin: false, notBefore: nowIso() };
      const first = await gw.call("balance", req);
      expect(await gw.call("balance", req)).toEqual({ ticket: first.ticket, duplicate: true });
      expect(dealsWith(fake, comment)).toHaveLength(1);
      expect(fake.state.users.get(u.login)!.balanceCents).toBe(2_500);
    });

    it("a lost answer after MT5 applied it is unknown, and the repeat finds the deal instead of paying twice", async () => {
      const u = fake.addUser({ group: STANDARD });
      const comment = ref("T");
      const req = { server: "live", login: u.login, amountCents: 7_000, comment, checkMargin: false, notBefore: nowIso() };
      fake.faults.next("/api/trade/balance", { drop: "after" });
      expect(await failure(gw.call("balance", req))).toMatchObject({ kind: "unknown", code: "connection" });
      expect(dealsWith(fake, comment)).toHaveLength(1);
      const repeat = await gw.call("balance", req);
      expect(repeat).toEqual({ ticket: dealsWith(fake, comment)[0]!.ticket, duplicate: true });
      expect(fake.state.users.get(u.login)!.balanceCents).toBe(7_000);
      // And the resolver's search finds it too.
      expect((await gw.call("deal.find", { server: "live", login: u.login, comment, from: nowIso() })).deal?.profitCents).toBe(7_000);
    });

    it("a connection lost before MT5 applied it is still unknown to the gateway; the repeat then sends it once", async () => {
      const u = fake.addUser({ group: STANDARD });
      const comment = ref("T");
      const req = { server: "live", login: u.login, amountCents: 300, comment, checkMargin: false, notBefore: nowIso() };
      fake.faults.next("/api/trade/balance", { drop: "before" });
      expect(await failure(gw.call("balance", req))).toMatchObject({ kind: "unknown" });
      expect(dealsWith(fake, comment)).toHaveLength(0);
      expect((await gw.call("balance", req)).duplicate).toBe(false);
      expect(dealsWith(fake, comment)).toHaveLength(1);
    });

    it("an answer without a ticket is settled by finding the deal", async () => {
      const u = fake.addUser({ group: STANDARD });
      const comment = ref("T");
      fake.faults.next("/api/trade/balance", { raw: '{"retcode":"0 Done"}', apply: true });
      const { ticket, duplicate } = await gw.call("balance", { server: "live", login: u.login, amountCents: 400, comment, checkMargin: false, notBefore: nowIso() });
      expect(duplicate).toBe(false);
      expect(ticket).toBe(dealsWith(fake, comment)[0]!.ticket);
    });

    it("MT5's own timeout, an HTTP error or an answer without a retcode after sending are unknown, not failed", async () => {
      const u = fake.addUser({ group: STANDARD });
      const send = () => gw.call("balance", { server: "live", login: u.login, amountCents: 100, comment: ref("T"), checkMargin: false, notBefore: nowIso() });
      fake.faults.next("/api/trade/balance", { retcode: "9 Timeout" });
      expect(await failure(send())).toMatchObject({ kind: "unknown", code: "timeout", retcode: 9 });
      fake.faults.next("/api/trade/balance", { status: 500 });
      expect(await failure(send())).toMatchObject({ kind: "unknown", code: "mt5_error" });
      fake.faults.next("/api/trade/balance", { raw: '{"answer":{"ticket":"1"}}' });
      expect(await failure(send())).toMatchObject({ kind: "unknown", code: "mt5_error" });
      fake.faults.next("/api/trade/balance", { raw: '{"retcode":"0 Done"}' });
      expect(await failure(send())).toMatchObject({ kind: "unknown", code: "mt5_error" });
    });

    it("a deal with this reference but another amount is unknown, and nothing is sent", async () => {
      const u = fake.addUser({ group: STANDARD });
      const comment = ref("T");
      fake.addDeal({ login: u.login, action: 2, profitCents: 999, comment });
      const before = fake.state.requests.length;
      expect(await failure(gw.call("balance", { server: "live", login: u.login, amountCents: 1_000, comment, checkMargin: false, notBefore: nowIso() })))
        .toMatchObject({ kind: "unknown", code: "mt5_error" });
      expect(pathsSince(fake, before)).not.toContain("/api/trade/balance");
      expect(dealsWith(fake, comment)).toHaveLength(1);
    });

    it("maps MT5's refusals to the protocol's codes", async () => {
      const u = fake.addUser({ group: STANDARD });
      const send = () => gw.call("balance", { server: "live", login: u.login, amountCents: 100, comment: ref("T"), checkMargin: false, notBefore: nowIso() });
      for (const [retcode, code] of [["10017 Trade disabled", "trade_disabled"], ["4005 Max money", "limit_reached"], ["12 Too frequent", "too_frequent"], ["10006 Rejected", "mt5_error"]]) {
        fake.faults.next("/api/trade/balance", { retcode: retcode! });
        expect(await failure(send())).toMatchObject({ kind: "refused", code, retcode: Number(retcode!.split(" ")[0]) });
      }
      fake.faults.next("/api/user/add", { retcode: "3004 Login exists" });
      const create = { server: "live", group: STANDARD, leverage: 2000, name: "N", email: "n@client.test", country: "", comment: ref("A"), password: MAIN, investorPassword: INVESTOR };
      expect(await failure(gw.call("user.create", create))).toMatchObject({ kind: "refused", code: "login_exists" });
      expect(fake.state.users.get(u.login)!.balanceCents).toBe(0);
    });
  });

  describe("one write at a time per login", () => {
    it("holds the second write on a login, deal search included, until the first is answered", async () => {
      const u = fake.addUser({ group: STANDARD });
      const since = fake.state.events.length;
      fake.faults.next("/api/trade/balance", { delayMs: 250 });
      const a = gw.call("balance", { server: "live", login: u.login, amountCents: 100, comment: ref("T"), checkMargin: false, notBefore: nowIso() });
      await sleep(20);
      const b = gw.call("balance", { server: "live", login: u.login, amountCents: 200, comment: ref("T"), checkMargin: false, notBefore: nowIso() });
      await Promise.all([a, b]);
      expect(fake.state.maxWritesInFlight).toBe(1);
      const events = fake.state.events.slice(since).filter((e) => e.login === u.login);
      const firstSendEnd = events.findIndex((e) => e.type === "end" && e.path === "/api/trade/balance");
      const searches = events.map((e, i) => (e.type === "start" && e.path === "/api/deal/get_total" ? i : -1)).filter((i) => i >= 0);
      expect(searches).toHaveLength(2);
      expect(searches[1]!).toBeGreaterThan(firstSendEnd);
      expect(fake.state.users.get(u.login)!.balanceCents).toBe(300);
    });

    it("lets writes on different logins run side by side", async () => {
      const x = fake.addUser({ group: STANDARD });
      const y = fake.addUser({ group: STANDARD });
      const since = fake.state.events.length;
      fake.faults.next("/api/trade/balance", { delayMs: 200 });
      fake.faults.next("/api/trade/balance", { delayMs: 200 });
      await Promise.all([x, y].map((u) => gw.call("balance", { server: "live", login: u.login, amountCents: 100, comment: ref("T"), checkMargin: false, notBefore: nowIso() })));
      const sends = fake.state.events.slice(since).filter((e) => e.path === "/api/trade/balance");
      expect(sends.map((e) => e.type)).toEqual(["start", "start", "end", "end"]);
    });
  });

  describe("sessions", () => {
    it("signs in again after MT5 closes an idle session, on the new socket", async () => {
      const u = fake.addUser({ group: STANDARD });
      await gw.call("user.get", { server: "live", login: u.login });
      const signIns = fake.state.signIns;
      expect(await fake.faults.closeIdleSockets()).toBeGreaterThan(0);
      await sleep(50);
      const before = fake.state.requests.length;
      await gw.call("balance", { server: "live", login: u.login, amountCents: 100, comment: ref("T"), checkMargin: false, notBefore: nowIso() });
      expect(fake.state.signIns).toBe(signIns + 1);
      const sent = fake.state.requests.slice(before);
      expect(sent.map((r) => r.path).slice(0, 2)).toEqual(["/api/auth/start", "/api/auth/answer"]);
      expect(new Set(sent.map((r) => r.socket)).size).toBe(1);
      expect(sent.slice(2).every((r) => r.signedIn)).toBe(true);
    });

    it("tries a read once more on a new sign-in when its connection drops or MT5 says the session is gone", async () => {
      const u = fake.addUser({ group: STANDARD });
      const signIns = fake.state.signIns;
      fake.faults.next("/api/user/get", { drop: "before" });
      expect((await gw.call("user.get", { server: "live", login: u.login })).login).toBe(u.login);
      fake.faults.next("/api/position/get_total", { retcode: "1012 IP address unallowed" });
      expect(await gw.call("positions.total", { server: "live", login: u.login })).toEqual({ total: 0 });
      expect(fake.state.signIns).toBe(signIns + 2);
      // But only once.
      fake.faults.next("/api/position/get_total", { status: 502 });
      fake.faults.next("/api/position/get_total", { status: 502 });
      expect(await failure(gw.call("positions.total", { server: "live", login: u.login }))).toMatchObject({ kind: "unavailable", code: "mt5_error" });
      fake.faults.next("/api/position/get_total", { raw: "{}" });
      expect(await failure(gw.call("positions.total", { server: "live", login: u.login }))).toMatchObject({ kind: "unavailable", code: "mt5_error" });
    });

    it("never writes a byte on a socket other than the signed-in one", async () => {
      const config = loadGatewayConfig(gatewayEnv(fake));
      const connection = new Mt5Connection(config.servers[0]!);
      const deadline = () => Date.now() + 5_000;
      await connection.request(testAccess(), { deadline: deadline() });
      const exchange = (connection as unknown as { exchange: (r: unknown, d: number, accept: (s: unknown) => boolean) => Promise<unknown> }).exchange.bind(connection);
      const requests = fake.state.requests.length;
      // The agent offers the signed-in socket, but the check refuses it:
      // nothing goes out, and the refused socket is dropped.
      const refused = (await exchange(userGet(1), deadline(), () => false).catch((e: unknown) => e)) as TransportError;
      expect(refused).toBeInstanceOf(TransportError);
      expect(refused.sent).toBe(false);
      expect(fake.state.requests.length).toBe(requests);
      expect(connection.signedIn).toBe(false);
      // So the next request signs in again on a new socket first.
      await connection.request(testAccess(), { deadline: deadline() });
      expect(pathsSince(fake, requests)).toEqual(["/api/auth/start", "/api/auth/answer", "/api/test/access"]);
      // With the session socket gone, the agent will not open another one outside a sign-in.
      const session = (connection as unknown as { session: { destroy(): void } }).session;
      session.destroy();
      await sleep(20);
      const connections = fake.state.tcpConnections;
      const noSocket = (await exchange(userGet(1), deadline(), () => true).catch((e: unknown) => e)) as TransportError;
      expect(noSocket).toBeInstanceOf(TransportError);
      expect(noSocket.sent).toBe(false);
      expect(fake.state.tcpConnections).toBe(connections);
      expect(fake.state.requests.length).toBe(requests + 3);
      connection.close();
    });
  });
});

describe("MT5 gateway caps", () => {
  let fake: FakeMt5;
  let g: Running;

  beforeAll(async () => {
    fake = await newFake();
    g = await startGateway(fake, { GATEWAY_MAX_OP_CENTS: "20000", GATEWAY_DEMO_MAX_OP_CENTS: "15000", GATEWAY_DAILY_CREDIT_CENTS: "30000" });
  });
  afterAll(() => g.close());

  const balance = (login: number, amountCents: number, comment = ref("T")) =>
    g.gw.call("balance", { server: "live", login, amountCents, comment, checkMargin: amountCents < 0, notBefore: nowIso() });

  it("refuses an operation over the per-operation cap, live or demo, without sending it", async () => {
    const live = fake.addUser({ group: STANDARD, balanceCents: 100_000 });
    const demo = fake.addUser({ group: DEMO });
    const before = fake.state.requests.length;
    expect(await failure(balance(live.login, 20_001))).toMatchObject({ kind: "refused", code: "over_limit" });
    expect(await failure(balance(live.login, -20_001))).toMatchObject({ kind: "refused", code: "over_limit" });
    expect(await failure(balance(demo.login, 15_001))).toMatchObject({ kind: "refused", code: "over_limit" });
    expect(pathsSince(fake, before)).not.toContain("/api/trade/balance");
  });

  it("keeps live credits within the rolling daily cap; debits, demo money and refusals do not count", async () => {
    const live = fake.addUser({ group: STANDARD });
    const other = fake.addUser({ group: PRO });
    const demo = fake.addUser({ group: DEMO });
    const first = ref("T");
    await balance(live.login, 15_000, first);
    fake.faults.next("/api/trade/balance", { retcode: "10017 Trade disabled" });
    expect(await failure(balance(other.login, 10_000))).toMatchObject({ code: "trade_disabled" });
    await balance(other.login, 10_000);
    await balance(demo.login, 15_000);
    await balance(live.login, -5_000);
    expect(await failure(balance(live.login, 5_001))).toMatchObject({ kind: "refused", code: "over_limit" });
    // An unknown outcome counts, as the money may be in MT5.
    fake.faults.next("/api/trade/balance", { drop: "before" });
    expect(await failure(balance(live.login, 5_000))).toMatchObject({ kind: "unknown" });
    expect(await failure(balance(other.login, 1))).toMatchObject({ code: "over_limit" });
    // A repeat of an operation already in MT5 is still answered as done.
    expect((await balance(live.login, 15_000, first)).duplicate).toBe(true);
    expect(fake.state.users.get(live.login)!.balanceCents).toBe(10_000);
  });
});

describe("MT5 gateway deal search across pages", () => {
  let fake: FakeMt5;
  let g: Running;

  beforeAll(async () => {
    fake = await newFake({ pageLimit: 2 });
    g = await startGateway(fake);
  });
  afterAll(() => g.close());

  it("reads every page before saying a reference is new, and finds one on the last page", async () => {
    const u = fake.addUser({ group: STANDARD });
    for (let i = 0; i < 5; i++) fake.addDeal({ login: u.login, action: i % 2, comment: `trade ${i}`, profitCents: i, time: fake.serverNow() - 600 + i });
    const comment = ref("T");
    const existing = fake.addDeal({ login: u.login, action: 2, profitCents: 4_200, comment, time: fake.serverNow() - 10 });
    const before = fake.state.requests.length;
    expect(await g.gw.call("balance", { server: "live", login: u.login, amountCents: 4_200, comment, checkMargin: false, notBefore: nowIso() }))
      .toEqual({ ticket: existing.ticket, duplicate: true });
    expect(pathsSince(fake, before).filter((p) => p === "/api/deal/get_page")).toHaveLength(3);
  });

  it("does not send when a page comes back short of MT5's own total", async () => {
    const u = fake.addUser({ group: STANDARD });
    for (let i = 0; i < 3; i++) fake.addDeal({ login: u.login, action: 0, comment: `trade ${i}`, time: fake.serverNow() - 60 });
    fake.faults.next("/api/deal/get_page", { raw: '{"retcode":"0 Done","answer":[]}' });
    expect(await failure(g.gw.call("balance", { server: "live", login: u.login, amountCents: 100, comment: ref("T"), checkMargin: false, notBefore: nowIso() })))
      .toMatchObject({ kind: "unavailable", code: "mt5_error" });
    expect(fake.state.users.get(u.login)!.balanceCents).toBe(0);
  });
});

describe("MT5 gateway TLS and sign-in", () => {
  it("refuses a server whose certificate does not match the pin, before sending anything", async () => {
    const fake = await newFake();
    const g = await startGateway(fake, { GATEWAY_SERVER_LIVE_CERT_SHA256: "00".repeat(32) });
    expect(await failure(g.gw.call("ping", { server: "live" }))).toMatchObject({ kind: "unavailable", code: "connection", message: expect.stringMatching(/pin/) });
    expect(fake.state.tcpConnections).toBeGreaterThan(0);
    expect(fake.state.requests).toHaveLength(0);
    await g.close();
  });

  it("without a pin, refuses a certificate no trusted CA signed", async () => {
    const fake = await newFake();
    const env = gatewayEnv(fake);
    delete (env as Record<string, string | undefined>).GATEWAY_SERVER_LIVE_CERT_SHA256;
    const config = loadGatewayConfig(env);
    const server = createGatewayServer(config, { log: createGatewayLogger("debug", sink), pingIntervalMs: 0 });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const gw = httpGateway({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, secret: SECRET, fetch });
    expect(await failure(gw.call("ping", { server: "live" }))).toMatchObject({ kind: "unavailable", code: "connection" });
    expect(fake.state.requests).toHaveLength(0);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("is unavailable when MT5 refuses the manager's password", async () => {
    const fake = await newFake({ managers: { 9000: "Another-Password-2" } });
    const g = await startGateway(fake);
    const u = fake.addUser({ group: STANDARD });
    expect(await failure(g.gw.call("balance", { server: "live", login: u.login, amountCents: 100, comment: ref("T"), checkMargin: false, notBefore: nowIso() })))
      .toMatchObject({ kind: "unavailable", code: "auth" });
    expect(fake.state.requests.every((r) => r.path.startsWith("/api/auth/"))).toBe(true);
    await g.close();
  });

  it("does not trust a server that cannot prove it knows the manager's password", async () => {
    const fake = await newFake();
    const g = await startGateway(fake);
    fake.faults.wrongServerProof = true;
    expect(await failure(g.gw.call("ping", { server: "live" }))).toMatchObject({ kind: "unavailable", code: "auth" });
    expect(fake.state.requests.map((r) => r.path)).toEqual(["/api/auth/start", "/api/auth/answer"]);
    // The next sign-in is a fresh one and works.
    expect((await g.gw.call("ping", { server: "live" })).serverTime).not.toBeNull();
    await g.close();
  });
});

describe("MT5 gateway keep-alive", () => {
  it("pings idle sessions and signs in again on its own when MT5 drops one", async () => {
    const fake = await newFake();
    const g = await startGateway(fake, {}, 40);
    await g.gw.call("ping", { server: "live" });
    await sleep(150);
    expect(fake.state.requests.some((r) => r.path === "/api/test/access")).toBe(true);
    const signIns = fake.state.signIns;
    await fake.faults.closeIdleSockets();
    const end = Date.now() + 2_000;
    while (fake.state.signIns === signIns && Date.now() < end) await sleep(10);
    expect(fake.state.signIns).toBe(signIns + 1);
    await g.close();
  });
});

describe("MT5 gateway log", () => {
  it("logs every write with what staff need to find it in MT5", () => {
    const writes = logLines.map((l) => JSON.parse(l)).filter((l) => l.msg === "MT5 write");
    const credit = writes.find((l) => l.op === "balance" && l.outcome === "ok");
    expect(credit).toMatchObject({ server: "live", login: expect.any(Number), amountCents: expect.any(Number), comment: expect.stringMatching(/^BIS-T/), ticket: expect.any(Number) });
    expect(writes.find((l) => l.op === "balance" && l.outcome === "unknown")).toMatchObject({ level: 50, code: expect.any(String) });
    expect(writes.find((l) => l.op === "user.create" && l.outcome === "refused")).toMatchObject({ retcode: 3006 });
    expect(writes.find((l) => l.op === "user.password")).toMatchObject({ type: expect.any(String) });
  });
});
