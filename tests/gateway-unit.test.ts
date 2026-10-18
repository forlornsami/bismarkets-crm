import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { NonceCache, verifyRequest } from "../src/gateway/auth";
import { loadGatewayConfig, normalizePin } from "../src/gateway/config";
import { createGatewayLogger } from "../src/gateway/log";
import { centsFromDecimal, decimalFromCents } from "../src/gateway/money";
import { KeyedMutex, LockTimeout } from "../src/gateway/mutex";
import { DailyCredits, GroupCache, OP_SCHEMAS } from "../src/gateway/ops";
import { requestSignature } from "../src/gateway/protocol";
import { mapRetcode, parseRetcode, retcodeError } from "../src/gateway/mt5/retcodes";
import { changeRights, parseReply, parseRights, readAccount, readDeal, readUser, userUpdate } from "../src/gateway/mt5/webapi";

const SECRET = "unit-test-secret-0123456789abcdef-0123";
const PIN = "ab".repeat(32);

const baseEnv = (overrides: Record<string, string | undefined> = {}) => ({
  GATEWAY_SECRET: SECRET,
  GATEWAY_SERVERS: "live",
  GATEWAY_SERVER_LIVE_HOST: "mt5.broker.example",
  GATEWAY_SERVER_LIVE_LOGIN: "9000",
  GATEWAY_SERVER_LIVE_PASSWORD: "Manager-Secret-77",
  GATEWAY_SERVER_LIVE_GROUPS: "real\\standard",
  ...overrides,
});

describe("gateway money", () => {
  it("turns MT5 decimal text into exact cents", () => {
    expect(centsFromDecimal("0")).toBe(0);
    expect(centsFromDecimal("1250.5")).toBe(125050);
    expect(centsFromDecimal("1250.50")).toBe(125050);
    expect(centsFromDecimal("-0.01")).toBe(-1);
    expect(centsFromDecimal("-0.00")).toBe(0);
    expect(Object.is(centsFromDecimal("-0.001"), -0)).toBe(false);
    expect(centsFromDecimal("12345678901234.56")).toBe(1234567890123456);
    // A float would make these 0.30000000000000004 and 1.0049999999999999.
    expect(centsFromDecimal("0.30000000000000004")).toBe(30);
    expect(centsFromDecimal("1.0049999999999999")).toBe(100);
  });

  it("rounds a third decimal half away from zero", () => {
    expect(centsFromDecimal("1.005")).toBe(101);
    expect(centsFromDecimal("-1.005")).toBe(-101);
    expect(centsFromDecimal("1.004999")).toBe(100);
    expect(centsFromDecimal("-1.004999")).toBe(-100);
    expect(centsFromDecimal("0.995")).toBe(100);
  });

  it("reads exponents exactly", () => {
    expect(centsFromDecimal("1e-05")).toBe(0);
    expect(centsFromDecimal("1.5E+3")).toBe(150000);
    expect(centsFromDecimal("5e-3")).toBe(1);
    expect(centsFromDecimal("-5e-3")).toBe(-1);
  });

  it("refuses anything that is not a plain decimal or does not fit", () => {
    for (const bad of ["", " 1", "1 ", "1,000.00", "abc", "1.2.3", "Infinity", "NaN", "--1", "0x10", ".5", "1e999", "99999999999999999"]) {
      expect(() => centsFromDecimal(bad), bad).toThrow();
    }
  });

  it("writes cents back as two-decimal text", () => {
    expect(decimalFromCents(12345)).toBe("123.45");
    expect(decimalFromCents(-5)).toBe("-0.05");
    expect(decimalFromCents(0)).toBe("0.00");
    expect(decimalFromCents(100)).toBe("1.00");
    expect(decimalFromCents(-1234567890123456)).toBe("-12345678901234.56");
    expect(() => decimalFromCents(1.5)).toThrow();
    expect(() => decimalFromCents(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });
});

describe("gateway MT5 answers", () => {
  it("keeps every JSON number as its exact text", () => {
    const reply = parseReply('{"retcode":"0 Done","answer":{"Balance":0.1,"Rights":18446744073709551615,"List":[1.10]}}');
    expect(reply.answer).toEqual({ Balance: "0.1", Rights: "18446744073709551615", List: ["1.10"] });
    expect(() => parseReply("[1]")).toThrow();
    expect(() => parseReply("not json")).toThrow();
  });

  it("reads 64-bit rights with BigInt and changes only the two bits it may", () => {
    expect(parseRights("18446744073709551615")).toBe(2n ** 64n - 1n);
    expect(() => parseRights("18446744073709551616")).toThrow();
    expect(() => parseRights("-1")).toThrow();
    const rights = 0x8000_0000_0000_0163n;
    expect(changeRights(rights, { enabled: false })).toBe(0x8000_0000_0000_0162n);
    expect(changeRights(rights, { tradeDisabled: true })).toBe(0x8000_0000_0000_0167n);
    expect(changeRights(0x8000_0000_0000_0166n, { enabled: true, tradeDisabled: false })).toBe(0x8000_0000_0000_0163n);
    expect(changeRights(rights, {})).toBe(rights);
  });

  it("reads users, accounts and deals whether MT5 sends strings or numbers", () => {
    const reply = parseReply(
      '{"retcode":"0 Done","answer":{"Login":100001,"Group":"real\\\\standard","Rights":"9223372036854776163","Leverage":2000,"Name":"Ali Khan","Comment":"BIS-A0000000A","Registration":"1700010800"}}',
    );
    const { user, raw } = readUser(reply.answer, 180);
    expect(user).toMatchObject({ login: 100001, group: "real\\standard", leverage: 2000, rights: "9223372036854776163", enabled: true, tradeDisabled: false });
    // Registration is server time, three hours ahead of UTC here.
    expect(user.registeredAt).toBe("2023-11-14T22:13:20.000Z");
    const update = userUpdate(raw, { leverage: 500, rights: changeRights(BigInt(user.rights), { tradeDisabled: true }) });
    expect(update.body).toMatchObject({ Login: "100001", Group: "real\\standard", Leverage: "500", Rights: "9223372036854776167" });

    const account = readAccount(parseReply('{"retcode":"0 Done","answer":{"Login":"5","Balance":1234.565,"Equity":"0.30000000000000004","MarginFree":"-12.5","Credit":0}}'));
    expect(account).toEqual({ login: 5, balanceCents: 123457, creditCents: 0, equityCents: 30, marginCents: 0, marginFreeCents: -1250, profitCents: 0 });

    const deal = readDeal(parseReply('{"answer":{"Deal":"77","Login":"5","Action":"2","Profit":"-100.00","Comment":"BIS-T00000001","Time":"1700010800"}}').answer, 180);
    expect(deal).toMatchObject({ ticket: 77, action: 2, profitCents: -10000, comment: "BIS-T00000001", time: 1700010800, timeUtc: "2023-11-14T22:13:20.000Z" });
    expect(() => readDeal({ Deal: "1", Login: "5", Action: "2", Time: "1" }, 0)).toThrow(/Profit/);
  });
});

describe("gateway retcodes", () => {
  it("parses the leading number and nothing else", () => {
    expect(parseRetcode("0 Done")).toEqual({ code: 0, text: "Done" });
    expect(parseRetcode("13")).toEqual({ code: 13, text: "" });
    expect(parseRetcode("10019 Not enough money")).toEqual({ code: 10019, text: "Not enough money" });
    for (const bad of [undefined, null, "", "Done", "x13", 13, {}]) expect(parseRetcode(bad), String(bad)).toBeNull();
  });

  it("maps MT5 codes to the protocol's codes", () => {
    const table: Array<[number, string]> = [
      [10019, "no_money"], [13, "not_found"], [3006, "invalid_password"], [10017, "trade_disabled"], [3004, "login_exists"],
      [3007, "limit_reached"], [4001, "limit_reached"], [4005, "limit_reached"], [10024, "limit_reached"], [12, "too_frequent"],
      [1001, "auth"], [1002, "auth"], [1008, "auth"], [1011, "auth"], [1012, "auth"], [2005, "auth"], [2, "mt5_error"], [3, "mt5_error"], [10006, "mt5_error"],
    ];
    for (const [code, expected] of table) expect(mapRetcode(code), String(code)).toBe(expected);
  });

  it("says unavailable during sign-in and unknown when MT5 itself timed out on a write", () => {
    expect(retcodeError({ code: 3006, text: "Invalid password" }, { write: false, signingIn: true })).toMatchObject({ kind: "unavailable", code: "auth", retcode: 3006 });
    expect(retcodeError({ code: 1012, text: "" }, { write: true })).toMatchObject({ kind: "refused", code: "auth" });
    expect(retcodeError({ code: 9, text: "Timeout" }, { write: true })).toMatchObject({ kind: "unknown", code: "timeout" });
    expect(retcodeError({ code: 7, text: "Network" }, { write: true })).toMatchObject({ kind: "unknown", code: "connection" });
    expect(retcodeError({ code: 9, text: "Timeout" }, { write: false })).toMatchObject({ kind: "refused", code: "mt5_error" });
    expect(retcodeError({ code: 10019, text: "No money" }, { write: true })).toMatchObject({ kind: "refused", code: "no_money", retcode: 10019 });
  });
});

describe("gateway request signatures", () => {
  const sign = (timestamp: string, nonce: string, path = "/v1/ping", body = '{"server":"live"}') => ({
    secret: SECRET, timestamp, nonce, signature: requestSignature(SECRET, timestamp, nonce, path, body), path, body,
  });
  const nonce = (n: number) => n.toString(16).padStart(32, "0");

  it("accepts a good request once and refuses its replay", () => {
    const nonces = new NonceCache();
    const now = Date.now();
    const req = sign(String(now), nonce(1));
    expect(verifyRequest({ ...req, nonces, now })).toEqual({ ok: true });
    expect(verifyRequest({ ...req, nonces, now: now + 1000 })).toMatchObject({ ok: false, status: 401 });
  });

  it("refuses a wrong signature, a changed body or path, and a time over 30 s off", () => {
    const nonces = new NonceCache();
    const now = Date.now();
    expect(verifyRequest({ ...sign(String(now), nonce(2)), signature: "0".repeat(64), nonces, now })).toMatchObject({ ok: false, status: 401 });
    expect(verifyRequest({ ...sign(String(now), nonce(3)), body: '{"server":"demo"}', nonces, now })).toMatchObject({ ok: false });
    expect(verifyRequest({ ...sign(String(now), nonce(4)), path: "/v1/balance", nonces, now })).toMatchObject({ ok: false });
    expect(verifyRequest({ ...sign(String(now - 30_001), nonce(5)), nonces, now })).toMatchObject({ ok: false, message: expect.stringMatching(/time/) });
    expect(verifyRequest({ ...sign(String(now + 30_001), nonce(6)), nonces, now })).toMatchObject({ ok: false, message: expect.stringMatching(/time/) });
    expect(verifyRequest({ ...sign(String(now - 29_000), nonce(7)), nonces, now })).toEqual({ ok: true });
    // Unsigned or malformed headers.
    expect(verifyRequest({ ...sign(String(now), nonce(8)), signature: undefined, nonces, now })).toMatchObject({ ok: false });
    expect(verifyRequest({ ...sign(String(now), "XYZ"), nonces, now })).toMatchObject({ ok: false });
    expect(verifyRequest({ ...sign("12.5", nonce(9)), nonces, now })).toMatchObject({ ok: false });
    // Only the request that passed everything left its nonce behind.
    expect(nonces.size).toBe(1);
  });

  it("remembers nonces for 60 s and, when full, refuses instead of forgetting early", () => {
    const nonces = new NonceCache(3, 60_000);
    expect(nonces.add("a", 0)).toBe("ok");
    expect(nonces.add("b", 10_000)).toBe("ok");
    expect(nonces.add("c", 20_000)).toBe("ok");
    expect(nonces.add("d", 30_000)).toBe("full");
    expect(nonces.add("a", 59_999)).toBe("replay");
    expect(nonces.add("d", 60_000)).toBe("ok"); // "a" expired, making room
    expect(nonces.add("a", 60_001)).toBe("full");
    expect(nonces.size).toBe(3);
    expect(nonces.add("a", 200_000)).toBe("ok");
    expect(nonces.size).toBe(1);
  });
});

describe("gateway locks and limits", () => {
  it("runs one holder of a key at a time, in order, and forgets idle keys", async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    const step = (name: string, ms: number) => mutex.run("live|login:1", 1000, async () => {
      order.push(`${name} in`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${name} out`);
    });
    const other = mutex.run("live|login:2", 1000, async () => void order.push("other"));
    await Promise.all([step("a", 30), step("b", 1), step("c", 1), other]);
    expect(order.filter((o) => o !== "other")).toEqual(["a in", "a out", "b in", "b out", "c in", "c out"]);
    expect(order.indexOf("other")).toBeLessThan(order.indexOf("a out"));
    expect(mutex.size).toBe(0);
  });

  it("gives up waiting without running, and the lock still works after", async () => {
    const mutex = new KeyedMutex();
    let release!: () => void;
    const holder = mutex.run("k", 1000, () => new Promise<void>((r) => (release = r)));
    let ran = false;
    await expect(mutex.run("k", 20, async () => void (ran = true))).rejects.toBeInstanceOf(LockTimeout);
    expect(ran).toBe(false);
    release();
    await holder;
    await mutex.run("k", 20, async () => void (ran = true));
    expect(ran).toBe(true);
    expect(mutex.size).toBe(0);
  });

  it("sums live credits over a rolling day in bounded memory", () => {
    const credits = new DailyCredits();
    const t0 = Date.UTC(2026, 9, 18, 12, 0, 0);
    expect(credits.reserve(400, 1000, t0)).not.toBeNull();
    const undo = credits.reserve(500, 1000, t0 + 60_000);
    expect(undo).not.toBeNull();
    expect(credits.reserve(200, 1000, t0 + 120_000)).toBeNull();
    undo!();
    undo!(); // only once
    expect(credits.sum(t0 + 120_000)).toBe(400);
    expect(credits.reserve(600, 1000, t0 + 120_000)).not.toBeNull();
    // The first minute counts until all of it is a day old.
    expect(credits.sum(t0 + 86_400_000 + 59_000)).toBe(1000);
    expect(credits.sum(t0 + 86_400_000 + 60_000)).toBe(600);
    // A year of one credit a second still keeps at most a day of minutes.
    const big = new DailyCredits();
    for (let t = 0; t < 3 * 86_400_000; t += 7_000) big.reserve(1, Number.MAX_SAFE_INTEGER, t0 + t);
    expect(big.size).toBeLessThanOrEqual(1441);
  });

  it("caches groups for 10 minutes and keeps at most 10,000 logins", () => {
    const cache = new GroupCache();
    cache.set("live", 1, "real\\standard", 0);
    expect(cache.get("live", 1, 599_999)).toBe("real\\standard");
    expect(cache.get("demo", 1, 0)).toBeNull();
    expect(cache.get("live", 1, 600_000)).toBeNull();
    for (let login = 1; login <= 10_050; login++) cache.set("live", login, "g", 0);
    expect(cache.size).toBe(10_000);
    expect(cache.get("live", 1, 0)).toBeNull();
    expect(cache.get("live", 10_050, 0)).toBe("g");
  });
});

describe("gateway request bodies", () => {
  it("refuses extra keys and bad values", () => {
    const ok = { server: "live", login: 5, amountCents: 100, comment: "BIS-T00000001", checkMargin: false, notBefore: new Date().toISOString() };
    expect(OP_SCHEMAS.balance.safeParse(ok).success).toBe(true);
    expect(OP_SCHEMAS.balance.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(OP_SCHEMAS.balance.safeParse({ ...ok, amountCents: 0 }).success).toBe(false);
    expect(OP_SCHEMAS.balance.safeParse({ ...ok, amountCents: 1.5 }).success).toBe(false);
    expect(OP_SCHEMAS.balance.safeParse({ ...ok, amountCents: "100" }).success).toBe(false);
    expect(OP_SCHEMAS.balance.safeParse({ ...ok, comment: "BIS-T0000000" }).success).toBe(false);
    expect(OP_SCHEMAS.balance.safeParse({ ...ok, notBefore: "yesterday" }).success).toBe(false);
    expect(OP_SCHEMAS.balance.safeParse({ ...ok, login: 2 ** 53 }).success).toBe(false);
    expect(OP_SCHEMAS["user.update"].safeParse({ server: "live", login: 5 }).success).toBe(false);
    expect(OP_SCHEMAS["user.update"].safeParse({ server: "live", login: 5, group: "real\\vip", leverage: 100 }).success).toBe(false);
    expect(OP_SCHEMAS["user.password"].safeParse({ server: "live", login: 5, type: "main", password: "with space1A!" }).success).toBe(false);
    expect(OP_SCHEMAS["user.find"].safeParse({ server: "live", group: "real\\*", comment: "BIS-A00000001" }).success).toBe(false);
    expect(OP_SCHEMAS["accounts.get"].safeParse({ server: "live", logins: Array.from({ length: 101 }, (_, i) => i + 1) }).success).toBe(false);
    expect(OP_SCHEMAS.ping.safeParse(JSON.parse('{"server":"live","__proto__":{"x":1}}')).success).toBe(false);
  });
});

describe("gateway configuration", () => {
  it("reads servers with their defaults", () => {
    const config = loadGatewayConfig(baseEnv({ GATEWAY_SERVER_LIVE_DEMO_GROUPS: "demo\\standard, demo\\pro", GATEWAY_SERVER_LIVE_CERT_SHA256: PIN.toUpperCase() }));
    expect(config).toMatchObject({ host: "127.0.0.1", port: 3100, leverages: [2000], maxOpCents: 10_000_000, dailyCreditCents: 50_000_000, demoMaxOpCents: 10_000_000 });
    expect(config.servers[0]).toMatchObject({
      code: "live", host: "mt5.broker.example", port: 443, login: 9000, certSha256: PIN, groups: ["real\\standard"], demoGroups: ["demo\\standard", "demo\\pro"],
      connections: 2, version: 3211, agent: "BISCRM", tzOffsetMinutes: 0,
    });
  });

  it("never prints the secret or a password", () => {
    const config = loadGatewayConfig(baseEnv());
    const shown = JSON.stringify(config) + inspect(config, { depth: 10 });
    expect(shown).not.toContain(SECRET);
    expect(shown).not.toContain("Manager-Secret-77");
    expect(shown).toContain("[hidden]");
    expect(config.secret.reveal()).toBe(SECRET);
    // Problems name the setting, not its value.
    const error = (() => {
      try {
        loadGatewayConfig(baseEnv({ GATEWAY_SECRET: "short-secret-value", GATEWAY_SERVER_LIVE_PORT: "Manager-Secret-77" }));
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(error).toMatch(/GATEWAY_SECRET/);
    expect(error).toMatch(/GATEWAY_SERVER_LIVE_PORT/);
    expect(error).not.toContain("short-secret-value");
    expect(error).not.toContain("Manager-Secret-77");
  });

  it("listens on loopback only unless told otherwise", () => {
    expect(() => loadGatewayConfig(baseEnv({ GATEWAY_HOST: "0.0.0.0" }))).toThrow(/GATEWAY_HOST/);
    expect(() => loadGatewayConfig(baseEnv({ GATEWAY_HOST: "10.0.0.5" }))).toThrow(/loopback/);
    expect(loadGatewayConfig(baseEnv({ GATEWAY_HOST: "::1" })).host).toBe("::1");
    expect(loadGatewayConfig(baseEnv({ GATEWAY_HOST: "10.0.0.5", GATEWAY_ALLOW_REMOTE: "true" })).host).toBe("10.0.0.5");
  });

  it("refuses unsafe or mistyped settings", () => {
    expect(() => loadGatewayConfig(baseEnv({ GATEWAY_SECRET: "x".repeat(31) }))).toThrow(/GATEWAY_SECRET/);
    expect(() => loadGatewayConfig(baseEnv({ GATEWAY_SERVER_LIVE_CERT_SHA256: "abcd" }))).toThrow(/CERT_SHA256/);
    expect(() => loadGatewayConfig(baseEnv({ GATEWAY_SERVER_LIVE_CERT_SHA: PIN }))).toThrow(/GATEWAY_SERVER_LIVE_CERT_SHA: is not a gateway setting/);
    expect(() => loadGatewayConfig(baseEnv({ GATEWAY_SERVER_LIVE_PASSWORD: undefined }))).toThrow(/PASSWORD/);
    expect(() => loadGatewayConfig(baseEnv({ GATEWAY_SERVER_LIVE_GROUPS: "" }))).toThrow(/at least one live or demo group/);
    expect(() => loadGatewayConfig(baseEnv({ GATEWAY_SERVER_LIVE_DEMO_GROUPS: "real\\standard" }))).toThrow(/both live and demo/);
    expect(() => loadGatewayConfig(baseEnv({ GATEWAY_SERVER_LIVE_GROUPS: "real\\*" }))).toThrow(/GROUPS/);
    expect(() => loadGatewayConfig(baseEnv({ GATEWAY_SERVERS: "live,LIVE" }))).toThrow(/not a server code/);
    expect(() => loadGatewayConfig(baseEnv({ GATEWAY_SERVERS: "a-b,a_b", GATEWAY_SERVER_A_B_HOST: "h", GATEWAY_SERVER_A_B_LOGIN: "1", GATEWAY_SERVER_A_B_PASSWORD: "p", GATEWAY_SERVER_A_B_GROUPS: "g" }))).toThrow(/share the variable names/);
    expect(() => loadGatewayConfig(baseEnv({ GATEWAY_LEVERAGES: "2000,1:500" }))).toThrow(/GATEWAY_LEVERAGES/);
    expect(() => loadGatewayConfig(baseEnv({ GATEWAY_SERVER_LIVE_CONNECTIONS: "0" }))).toThrow(/CONNECTIONS/);
    expect(() => loadGatewayConfig(baseEnv({ GATEWAY_LOG_LEVEL: "verbose" }))).toThrow(/GATEWAY_LOG_LEVEL/);
  });

  it("normalizes certificate pins", () => {
    const colon = PIN.match(/../g)!.join(":").toUpperCase();
    expect(normalizePin(colon)).toBe(PIN);
    expect(normalizePin(PIN)).toBe(PIN);
    expect(normalizePin(PIN.slice(2))).toBeNull();
    expect(normalizePin(`${PIN}:`)).toBeNull();
  });

  it("hides password fields in logs as a second guard", () => {
    const lines: string[] = [];
    const log = createGatewayLogger("info", { write: (line: string) => void lines.push(line) });
    log.info({ login: 5, password: "Main-Pass-1!", investorPassword: "Inv-Pass-1!", secret: SECRET }, "test");
    expect(lines.join("")).not.toMatch(/Main-Pass|Inv-Pass|unit-test-secret/);
    expect(JSON.parse(lines[0]!)).toMatchObject({ login: 5, password: "[hidden]", service: "mt5-gateway" });
  });
});
