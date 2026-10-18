import { describe, expect, it } from "vitest";
import { MT5_REFERENCE } from "../src/gateway/protocol";
import { parseLogin, presentClientAccount, withAccountLock, type AccountRow } from "../src/server/mt5/accounts";
import { callMt5, callMt5Again, staffMt5Error } from "../src/server/mt5/errors";
import { GatewayError } from "../src/server/mt5/gateway";
import { generateMt5Password, mt5PasswordOk } from "../src/server/mt5/passwords";
import { mt5Reference } from "../src/server/mt5/references";
import { defaultLeverage, parseLeverage, parseLeverages } from "../src/server/mt5/settings";
import { FakeGateway } from "./fakes/gateway";
import { testConfig } from "./helpers";

const SECRET = "s".repeat(40);
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe("MT5 gateway configuration", () => {
  it("is off without a URL and needs a long secret with one", () => {
    expect(testConfig().mt5Gateway).toBeNull();
    expect(testConfig({ CRM_MT5_GATEWAY_URL: "" }).mt5Gateway).toBeNull();
    expect(testConfig({ CRM_MT5_GATEWAY_URL: "http://127.0.0.1:8787/", CRM_MT5_GATEWAY_SECRET: SECRET }).mt5Gateway).toEqual({ url: "http://127.0.0.1:8787", secret: SECRET });
    expect(() => testConfig({ CRM_MT5_GATEWAY_URL: "http://127.0.0.1:8787" })).toThrow(/CRM_MT5_GATEWAY_SECRET must be at least 32/);
    expect(() => testConfig({ CRM_MT5_GATEWAY_URL: "http://127.0.0.1:8787", CRM_MT5_GATEWAY_SECRET: "short" })).toThrow(/CRM_MT5_GATEWAY_SECRET/);
  });

  it("refuses URLs that carry credentials, queries or other schemes, and never echoes the secret", () => {
    for (const url of ["ftp://gw.local", "https://user:pw@gw.local", "https://gw.local/?key=1", "https://gw.local/#x", "not a url"]) {
      let message = "";
      try {
        testConfig({ CRM_MT5_GATEWAY_URL: url, CRM_MT5_GATEWAY_SECRET: SECRET });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/CRM_MT5_GATEWAY_URL/);
      expect(message).not.toContain(SECRET);
    }
  });

  it("in production allows plain http only to this machine, on an explicit port", () => {
    const prod = { NODE_ENV: "production", CRM_COOKIE_SECURE: "true", CRM_STAFF_ORIGIN: "https://staff.example", CRM_STAFF_ALLOWED_IPS: "1.2.3.4", CRM_MT5_GATEWAY_SECRET: SECRET };
    expect(testConfig({ ...prod, CRM_MT5_GATEWAY_URL: "http://127.0.0.1:8787" }).mt5Gateway?.url).toBe("http://127.0.0.1:8787");
    expect(testConfig({ ...prod, CRM_MT5_GATEWAY_URL: "http://[::1]:8787" }).mt5Gateway?.url).toBe("http://[::1]:8787");
    expect(testConfig({ ...prod, CRM_MT5_GATEWAY_URL: "https://gw.example" }).mt5Gateway?.url).toBe("https://gw.example");
    expect(() => testConfig({ ...prod, CRM_MT5_GATEWAY_URL: "http://gw.example:8787" })).toThrow(/must be https/);
    expect(() => testConfig({ ...prod, CRM_MT5_GATEWAY_URL: "http://127.0.0.1" })).toThrow(/must be https/);
  });
});

describe("MT5 passwords", () => {
  it("accepts only 8 to 16 printable characters with every kind", () => {
    expect(mt5PasswordOk("Abcdef1!")).toBe(true);
    expect(mt5PasswordOk("Abcdefgh12345!@#")).toBe(true);
    for (const bad of ["Abcde1!", "Abcdefgh12345!@#x", "abcdef1!", "ABCDEF1!", "Abcdefg!", "Abcdefg1", "Abc def1!", "Abcdéf1!", "", null, 12345678, undefined]) {
      expect(mt5PasswordOk(bad)).toBe(false);
    }
  });

  it("generates passwords MT5 accepts, all different", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const p = generateMt5Password();
      expect(p).toHaveLength(12);
      expect(mt5PasswordOk(p)).toBe(true);
      // Nothing that reads ambiguously when staff read it out.
      expect(p).not.toMatch(/[0O1lI]/);
      seen.add(p);
    }
    expect(seen.size).toBe(500);
    expect(mt5PasswordOk(generateMt5Password(16))).toBe(true);
  });
});

describe("MT5 references and parsing", () => {
  it("makes references the gateway accepts as comments", () => {
    const seen = new Set<string>();
    for (const kind of ["A", "T", "D"] as const) {
      for (let i = 0; i < 200; i++) {
        const r = mt5Reference(kind);
        expect(r).toMatch(new RegExp(`^BIS-${kind}[0-9A-Z]{8}$`));
        expect(MT5_REFERENCE.test(r)).toBe(true);
        seen.add(r);
      }
    }
    expect(seen.size).toBe(600);
  });

  it("reads leverages and logins the ways the apps send them", () => {
    expect(parseLeverage("2000")).toBe(2000);
    expect(parseLeverage(500)).toBe(500);
    expect(parseLeverage("1:1000")).toBe(1000);
    for (const bad of ["", "0", "-5", "1:", "2000.5", "abc", null, undefined, {}, 1.5, "1:2:3"]) expect(parseLeverage(bad)).toBeNull();
    expect(parseLeverages("2000, 500,abc,0,500")).toEqual([2000, 500]);
    expect(defaultLeverage({ leverages: [100, 2000, 500] })).toBe(2000);
    expect(defaultLeverage({ leverages: [100, 500] })).toBe(500);

    expect(parseLogin("500001")).toBe(500001);
    expect(parseLogin(500001)).toBe(500001);
    for (const bad of ["", "0x10", "1e5", "-1", "12345678901234567", 1.5, null, "50 01"]) expect(parseLogin(bad)).toBeNull();
  });
});

describe("client account shape", () => {
  const base: AccountRow = {
    id: 7, client_id: 1, server_code: "live", login: 500123, is_demo: 0, package_id: 3, package_name: "Classic", mt5_group: "real\\standard", currency: "USD",
    leverage: 2000, status: "active", create_ref: "BIS-A00000000", failure: null, checks: 0, next_check_at: null, archived_at: null, suspended_at: null,
    suspended_by: null, suspended_reason: null, balance_cents: 123_456, credit_cents: 0, equity_cents: 120_000, margin_cents: 5_000, margin_free_cents: 115_000,
    snapshot_at: new Date(), mt5_registered_at: null, created_ip: "", created_at: new Date("2026-10-01T10:00:00Z"), updated_at: new Date(),
  } as AccountRow;

  it("uses strings for logins and leverage, numbers in dollars, and never 'archived' as a status", () => {
    const shown = presentClientAccount(base);
    expect(shown).toMatchObject({ id: "500123", login: "500123", account_id: "500123", leverage: "2000", balance: 1234.56, equity: 1200, status: "active", archived: false, is_demo: false });
    expect(presentClientAccount({ ...base, archived_at: new Date() })).toMatchObject({ status: "active", archived: true });
    expect(presentClientAccount({ ...base, archived_at: new Date(), suspended_at: new Date() })).toMatchObject({ status: "suspended", archived: false });
    expect(presentClientAccount({ ...base, snapshot_at: null, balance_cents: null, equity_cents: null, credit_cents: null })).toMatchObject({ balance: 0, equity: 0, credit: 0, mt5: null });
  });
});

describe("MT5 call helpers", () => {
  it("asks once more after a lost answer to a repeatable change, and never for a create", async () => {
    const fake = new FakeGateway();
    const u = fake.addUser("live", { group: "real\\standard" });
    fake.failNext("user.update", { kind: "unknown-before" });
    await expect(callMt5Again(fake, "user.update", { server: "live", login: u.login, leverage: 500 }, silent)).resolves.toMatchObject({ leverage: 500 });
    expect(fake.callsTo("user.update")).toHaveLength(2);
    fake.failNext("user.update", { kind: "unknown-after" }, 2);
    await expect(callMt5Again(fake, "user.update", { server: "live", login: u.login, leverage: 100 }, silent)).rejects.toMatchObject({ kind: "unknown" });
    expect(fake.callsTo("user.update")).toHaveLength(4);
    fake.failNext("user.create", { kind: "unknown-before" });
    await expect(callMt5(fake, "user.create", { server: "live", group: "real\\standard", leverage: 100, name: "A", email: "a@b.c", country: "", comment: "BIS-A00000000", password: "Abcdef1!", investorPassword: "Bcdefg2@" }, silent)).rejects.toMatchObject({ kind: "unknown" });
    expect(fake.callsTo("user.create")).toHaveLength(1);
  });

  it("turns a thrown non-gateway error into unknown for writes and unavailable for reads", async () => {
    const broken = { call: async () => { throw new TypeError("socket hang up"); } };
    await expect(callMt5(broken, "balance", { server: "live", login: 1, amountCents: 1, comment: "BIS-D00000000", checkMargin: false, notBefore: new Date().toISOString() }, silent)).rejects.toMatchObject({ kind: "unknown" });
    await expect(callMt5(broken, "user.get", { server: "live", login: 1 }, silent)).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("maps gateway errors for staff, 409 for a lost answer", () => {
    expect(staffMt5Error(new GatewayError("unknown", "timeout", "late"))).toMatchObject({ status: 409, code: "MT5_UNCONFIRMED" });
    expect(staffMt5Error(new GatewayError("unavailable", "connection", "down"))).toMatchObject({ status: 422, code: "MT5_UNAVAILABLE" });
    expect(staffMt5Error(new GatewayError("bad_request", "bad_request", "no"))).toMatchObject({ status: 400, code: "MT5_BAD_REQUEST" });
    expect(staffMt5Error(new GatewayError("refused", "no_money", "10019 Not enough money"))).toMatchObject({ status: 422, code: "MT5_REFUSED", details: { kind: "refused", code: "no_money" } });
  });

  it("runs one change per account at a time", async () => {
    const order: string[] = [];
    let release!: () => void;
    const first = withAccountLock(1, async () => {
      order.push("first start");
      await new Promise<void>((r) => (release = r));
      order.push("first end");
    });
    const second = withAccountLock(1, async () => void order.push("second"));
    const other = withAccountLock(2, async () => void order.push("other account"));
    await other;
    await new Promise((r) => setTimeout(r, 10));
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first start", "other account", "first end", "second"]);
    // A failed change does not block the next one.
    await expect(withAccountLock(1, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(withAccountLock(1, async () => "ok")).resolves.toBe("ok");
  });
});

describe("fake gateway rules", () => {
  it("behaves like the gateway where the CRM depends on it", async () => {
    const fake = new FakeGateway();
    const create = (extra: Record<string, unknown> = {}) =>
      fake.call("user.create", { server: "live", group: "real\\standard", leverage: 2000, name: "A", email: "a@b.c", country: "", comment: "BIS-A00000001", password: "Abcdef1!", investorPassword: "Bcdefg2@", ...extra } as never);
    await expect(create({ server: "nope" })).rejects.toMatchObject({ kind: "bad_request" });
    await expect(create({ group: "real\\vip" })).rejects.toMatchObject({ kind: "refused", code: "group_not_allowed" });
    await expect(create({ leverage: 300 })).rejects.toMatchObject({ kind: "refused" });
    await expect(create({ comment: "free text" })).rejects.toMatchObject({ kind: "bad_request" });
    const { login } = await create();
    expect(await fake.call("user.find", { server: "live", group: "real\\standard", comment: "BIS-A00000001" })).toEqual({ login });

    const pay = (amountCents: number, comment: string, checkMargin = false) => fake.call("balance", { server: "live", login, amountCents, comment, checkMargin, notBefore: new Date(Date.now() - 60_000).toISOString() });
    const first = await pay(10_000, "BIS-T00000001");
    // The same reference twice: the first deal, not a second one.
    expect(await pay(10_000, "BIS-T00000001")).toEqual({ ticket: first.ticket, duplicate: true });
    expect(fake.user("live", login)!.balanceCents).toBe(10_000);
    await expect(pay(-20_000, "BIS-T00000002", true)).rejects.toMatchObject({ kind: "refused", code: "no_money" });
    await expect(pay(100_000_000, "BIS-T00000003")).rejects.toMatchObject({ kind: "refused", code: "over_limit" });
    expect(await fake.call("deal.find", { server: "live", login, comment: "BIS-T00000001", from: new Date(Date.now() - 60_000).toISOString() })).toMatchObject({ deal: { ticket: first.ticket, profitCents: 10_000 } });
    expect(await fake.call("deal.find", { server: "live", login, comment: "BIS-T00000009", from: new Date(0).toISOString() })).toEqual({ deal: null });
    expect(await fake.call("accounts.get", { server: "live", logins: [login, 999] })).toMatchObject({ accounts: [{ login, balanceCents: 10_000 }], missing: [999] });
    // Recorded calls never hold a password.
    expect(JSON.stringify(fake.calls)).not.toMatch(/Abcdef1!|Bcdefg2@/);
  });
});
