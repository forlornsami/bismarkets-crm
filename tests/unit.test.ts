import { describe, expect, it } from "vitest";
import { canonical, entryHash, GENESIS_HASH } from "../src/server/lib/audit";
import { decryptField, encryptField } from "../src/server/lib/crypto";
import { buildAllowList, isAllowed, normalizeIp } from "../src/server/lib/ip";
import { isBreachedPassword, passwordProblem } from "../src/server/lib/passwords";
import { loggablePath } from "../src/server/lib/logger";
import { base32Decode, base32Encode, hotp, verifyTotp } from "../src/server/lib/totp";
import { splitStatements } from "../src/server/migrate";
import { temporaryPassword } from "../src/server/staff/guards";
import { ALL_PERMISSIONS, DEFAULT_ROLES } from "../src/shared/permissions";
import { testConfig } from "./helpers";

describe("TOTP", () => {
  const secret = base32Encode(Buffer.from("12345678901234567890"));

  it("matches the RFC 6238 SHA-1 test vector", () => {
    // T = 59s → counter 1 → 94287082 (8 digits), so 287082 for 6 digits.
    expect(hotp(base32Decode(secret), 1, 8)).toBe("94287082");
    expect(verifyTotp(secret, "287082", 59_000)).toBe(1);
  });

  it("accepts one step of clock drift and nothing more", () => {
    const at = 1_000_000 * 30_000;
    const code = hotp(base32Decode(secret), 1_000_000);
    expect(verifyTotp(secret, code, at + 30_000)).toBe(1_000_000);
    expect(verifyTotp(secret, code, at + 61_000)).toBeNull();
    expect(verifyTotp(secret, "12345", at)).toBeNull();
    expect(verifyTotp(secret, "abcdef", at)).toBeNull();
  });

  it("round-trips base32", () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 255, 7]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
  });
});

describe("field encryption", () => {
  const key = Buffer.alloc(32, 9);

  it("round-trips and binds the context", () => {
    const sealed = encryptField(key, "JBSWY3DPEHPK3PXP", "staff:1:totp");
    expect(decryptField(key, sealed, "staff:1:totp")).toBe("JBSWY3DPEHPK3PXP");
    expect(() => decryptField(key, sealed, "staff:2:totp")).toThrow();
  });

  it("rejects tampered ciphertext", () => {
    const sealed = encryptField(key, "secret", "ctx");
    sealed[sealed.length - 1] = sealed.at(-1)! ^ 1;
    expect(() => decryptField(key, sealed, "ctx")).toThrow();
  });
});

describe("audit hashing", () => {
  it("is independent of key order", () => {
    expect(canonical({ b: 1, a: { d: [1, 2], c: null } })).toBe(canonical({ a: { c: null, d: [1, 2] }, b: 1 }));
  });

  it("changes when any field changes", () => {
    const base = {
      occurredAt: new Date("2026-10-15T10:00:00.000Z"), actorType: "staff", actorId: 1, actorLabel: "a@b.c", action: "staff.login",
      entityType: "staff", entityId: "1", ip: "1.2.3.4", userAgent: "ua", before: null, after: { x: 1 }, meta: null,
    };
    const h = entryHash(GENESIS_HASH, base);
    expect(entryHash(GENESIS_HASH, { ...base, after: { x: 2 } })).not.toBe(h);
    expect(entryHash("1".repeat(64), base)).not.toBe(h);
  });
});

describe("staff network allowlist", () => {
  it("matches addresses and subnets for IPv4 and IPv6", () => {
    const list = buildAllowList(["203.0.113.7", "10.0.0.0/8", "2001:db8::/32"]);
    expect(isAllowed(list, "203.0.113.7")).toBe(true);
    expect(isAllowed(list, "10.20.30.40")).toBe(true);
    expect(isAllowed(list, "2001:db8::1")).toBe(true);
    expect(isAllowed(list, "203.0.113.8")).toBe(false);
    expect(isAllowed(list, "")).toBe(false);
    expect(isAllowed(null, "8.8.8.8")).toBe(true);
    expect(normalizeIp("::ffff:10.1.2.3")).toBe("10.1.2.3");
  });

  it("refuses bad entries", () => {
    expect(() => buildAllowList(["not-an-ip"])).toThrow();
  });
});

describe("configuration", () => {
  it("requires the staff allowlist, HTTPS and secure cookies in production", () => {
    expect(() => testConfig({ NODE_ENV: "production", CRM_COOKIE_SECURE: "true", CRM_STAFF_ORIGIN: "https://staff.x" })).toThrow(/ALLOWED_IPS/);
    expect(() => testConfig({ NODE_ENV: "production", CRM_STAFF_ALLOWED_IPS: "1.2.3.4" })).toThrow(/COOKIE_SECURE/);
    expect(() => testConfig({ CRM_DATA_KEY: "short" })).toThrow(/CRM_DATA_KEY/);
  });
});

describe("passwords", () => {
  it("enforces the policy", () => {
    expect(passwordProblem("short", "a@b.c")).toMatch(/12/);
    expect(passwordProblem("samantha-is-great-2026", "samantha@x.com")).toMatch(/email/);
    expect(passwordProblem("aaaaaaaaaaaaaa", "x@y.z")).toMatch(/varied/);
    expect(passwordProblem("Correct-Horse-Battery-9", "x@y.z")).toBeNull();
  });

  it("checks breaches by hash prefix only and fails open", async () => {
    let calledWith = "";
    const hit = (async (url: string) => {
      calledWith = url;
      // SHA-1("password") = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
      return new Response("1E4C9B93F3F0682250B6CF8331B7EE68FD8:9545824\r\n0000000000000000000000000000000000:0");
    }) as unknown as typeof fetch;
    expect(await isBreachedPassword("password", hit)).toBe(true);
    expect(calledWith.endsWith("/range/5BAA6")).toBe(true);
    const down = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await isBreachedPassword("password", down)).toBe(false);
  });

  it("generates strong temporary passwords", () => {
    const seen = new Set(Array.from({ length: 50 }, temporaryPassword));
    expect(seen.size).toBe(50);
    for (const p of seen) expect(passwordProblem(p, "someone@x.com")).toBeNull();
  });
});

describe("permission catalog", () => {
  it("keeps staff account management and money approvals in different default roles", () => {
    const manageStaff = ["staff.create", "staff.edit", "staff.security"];
    const moveMoney = ["deposit.process", "deposit.approve_large", "withdrawal.process", "withdrawal.approve", "withdrawal.pay", "wallet.adjust", "ib.payout"];
    for (const role of DEFAULT_ROLES) {
      if (role.permissions === "all") continue;
      const held = role.permissions as string[];
      if (held.some((p) => manageStaff.includes(p))) expect([role.slug, held.filter((p) => moveMoney.includes(p))]).toEqual([role.slug, []]);
    }
  });

  it("only seeds known permissions", () => {
    for (const role of DEFAULT_ROLES) {
      if (role.permissions === "all") continue;
      for (const p of role.permissions) expect(ALL_PERMISSIONS).toContain(p);
    }
  });

  it("keeps the auditor read-only", () => {
    const auditor = DEFAULT_ROLES.find((r) => r.slug === "auditor")!;
    expect(auditor.permissions).not.toBe("all");
    for (const p of auditor.permissions as string[]) expect(p.endsWith(".view") || p === "audit.verify" || p === "client.view_all" || p === "kyc.documents" || p === "deposit.proof").toBe(true);
    // Opening KYC documents is its own permission: compliance and the auditor have it, sales and support do not.
    expect(auditor.permissions).toContain("kyc.documents");
    for (const slug of ["sales_agent", "sales_manager", "support_agent", "finance_agent"]) expect(DEFAULT_ROLES.find((r) => r.slug === slug)!.permissions).not.toContain("kyc.documents");
    // So is opening deposit proofs: finance reviews them, sales and support only see a deposit's status.
    for (const slug of ["finance_agent", "finance_manager", "compliance", "auditor"]) expect(DEFAULT_ROLES.find((r) => r.slug === slug)!.permissions).toContain("deposit.proof");
    for (const slug of ["sales_agent", "sales_manager", "support_agent", "dealing"]) expect(DEFAULT_ROLES.find((r) => r.slug === slug)!.permissions).not.toContain("deposit.proof");
  });
});

describe("migration splitter", () => {
  it("splits statements and drops comment lines", () => {
    expect(splitStatements("-- c\nCREATE TABLE a (x INT);\n\nCREATE TRIGGER t BEFORE UPDATE ON a FOR EACH ROW\n  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'no';\n")).toEqual([
      "CREATE TABLE a (x INT)",
      "CREATE TRIGGER t BEFORE UPDATE ON a FOR EACH ROW\n  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'no'",
    ]);
  });
});

describe.skipIf(!process.env.CRM_TEST_DATABASE_URL)("database connections", () => {
  it("run every session in UTC whatever the server's zone", async () => {
    const { createDb, one } = await import("../src/server/lib/db");
    const db = createDb(process.env.CRM_TEST_DATABASE_URL!);
    const row = await one<{ tz: string }>(db, "SELECT @@session.time_zone AS tz");
    expect(row?.tz).toBe("+00:00");
    await db.end();
  });
});

describe("request log paths", () => {
  it("drops query strings and QR link tokens", () => {
    expect(loggablePath("/api/payout-qr/ca02d5c2c06c97a8e7a6efb2614873b3")).toBe("/api/payout-qr/:token");
    expect(loggablePath("/api/payment-qr/ca02d5c2c06c97a8e7a6efb2614873b3?v=1")).toBe("/api/payment-qr/:token");
    expect(loggablePath("/api/user?token=secret")).toBe("/api/user");
    expect(loggablePath("/api/staff/withdrawals/7/qr")).toBe("/api/staff/withdrawals/7/qr");
    // Routing ignores case and repeated slashes; the token goes whatever the spelling.
    const t = "ca02d5c2c06c97a8e7a6efb2614873b3";
    for (const path of [`/API/Payout-QR/${t}`, `//api/payout-qr/${t}`, `/api//payout-qr/${t}`, `/api/payout-qr//${t}/`, `/api/payout%2Dqr/${t}`, `/api/%70ayout-qr/${t}`]) {
      expect([path, loggablePath(path).includes(t.slice(0, 8))]).toEqual([path, false]);
    }
  });
});
