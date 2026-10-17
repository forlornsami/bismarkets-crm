import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exec, one, transaction } from "../src/server/lib/db";
import { formatMinor, fromUsdCents, parseAmount, toMajor, toUsdCents } from "../src/server/money/amounts";
import { depositMethodAccount, holdAccount, InsufficientFunds, lockWallet, postLedger, verifyLedger, walletAccount, walletOf } from "../src/server/money/ledger";
import { compareNames } from "../src/server/money/names";
import { editorIn, prepareProof, ProofProblem, proofType } from "../src/server/money/proofs";
import { bankReferenceKey, newReference } from "../src/server/money/references";
import { loadMoneySettings } from "../src/server/money/settings";
import { hasDb, setup, type TestEnv } from "./helpers";

describe("amounts", () => {
  it("parses decimal text into cents without floats", () => {
    expect(parseAmount("1250")).toEqual({ minor: 125000 });
    expect(parseAmount("1250.5")).toEqual({ minor: 125050 });
    expect(parseAmount(" 0.07 ")).toEqual({ minor: 7 });
    expect(parseAmount(19.99)).toEqual({ minor: 1999 });
    expect(parseAmount("12.500")).toEqual({ minor: 1250 });
    expect(parseAmount("10000000")).toEqual({ minor: 1_000_000_000 });
  });

  it("refuses what is not a plain amount", () => {
    expect(parseAmount("")).toEqual({ problem: "missing" });
    expect(parseAmount(undefined)).toEqual({ problem: "missing" });
    for (const bad of ["-5", "1,000", "1e3", "12.", ".5", "abc", "0x10", "1 000", "Infinity"]) expect(parseAmount(bad)).toEqual({ problem: "invalid" });
    expect(parseAmount(1e21)).toEqual({ problem: "invalid" });
    expect(parseAmount("1.005")).toEqual({ problem: "decimals" });
    expect(parseAmount(0.001)).toEqual({ problem: "decimals" });
    expect(parseAmount("0.00")).toEqual({ problem: "zero" });
    expect(parseAmount("10000000.01")).toEqual({ problem: "too_large" });
    expect(parseAmount({})).toEqual({ problem: "invalid" });
    expect(parseAmount("12.5000000000000000000")).toEqual({ minor: 1250 });
    expect(parseAmount("12.50000000000000000000")).toEqual({ problem: "invalid" });
  });

  it("answers at once however long the amount text is", () => {
    const started = performance.now();
    expect(parseAmount(`1.${"0".repeat(200_000)}1`)).toEqual({ problem: "invalid" });
    expect(parseAmount(`${"1".repeat(200_000)}`)).toEqual({ problem: "invalid" });
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("converts rupees to US cents rounding down, and back rounding up", () => {
    expect(toUsdCents(2_800_000, "PKR", "280.000000")).toBe(10_000);
    // 100 rupees at 278.5 = 35.906... cents → 35 cents, never more than was sent.
    expect(toUsdCents(10_000, "PKR", "278.500000")).toBe(35);
    expect(toUsdCents(4321, "USD", "280")).toBe(4321);
    expect(fromUsdCents(5000, "PKR", "280.000000")).toBe(1_400_000);
    expect(fromUsdCents(1, "PKR", "278.5")).toBe(279);
    expect(toMajor(125050)).toBe(1250.5);
    expect(formatMinor(125050)).toBe("1,250.50");
  });
});

describe("names", () => {
  it("compares the payer's name with the verified name", () => {
    expect(compareNames("Ali Khan", "KHAN ALI")).toBe("same");
    expect(compareNames("Mr. Muhammad Ali", "Mohammad Ali")).toBe("same");
    expect(compareNames("José Pérez", "Jose Perez")).toBe("same");
    expect(compareNames("Ali Raza Khan", "Ali Khan")).toBe("similar");
    expect(compareNames("Ali Khan", "Sara Ahmed")).toBe("different");
    expect(compareNames("Ali Khan", "Ali Hassan")).toBe("different");
    expect(compareNames("", "Ali Khan")).toBe("different");
  });
});

describe("references", () => {
  it("are never numeric and avoid look-alike letters", () => {
    for (let i = 0; i < 200; i++) expect(newReference("D")).toMatch(/^D-[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(newReference("W")).toMatch(/^W-/);
    expect(bankReferenceKey(3, " ft-2401 9988 ")).toBe("3:FT24019988");
  });
});

describe("payment proofs", () => {
  const png = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: "#225588" } }).png().toBuffer();

  it("accepts screenshots, including small ones and GIFs, and drops their metadata", async () => {
    const shot = await prepareProof(await png(400, 180));
    expect(shot.mime).toBe("image/png");
    expect(shot.editor).toBeNull();
    const gif = await sharp({ create: { width: 300, height: 300, channels: 3, background: "#aa3322" } }).gif().toBuffer();
    expect(proofType(gif)).toBe("image/gif");
    expect((await prepareProof(gif)).mime).toBe("image/png");
    const jpeg = await sharp({ create: { width: 500, height: 300, channels: 3, background: "#123456" } }).jpeg().withExifMerge({ IFD0: { Software: "Adobe Photoshop 25.0" } }).toBuffer();
    const prepared = await prepareProof(jpeg);
    expect(prepared.editor).toBe("Adobe Photoshop");
    expect(editorIn(prepared.bytes)).toBeNull();
    expect((await sharp(prepared.bytes).metadata()).exif).toBeUndefined();
  });

  it("refuses files that are not images, tiny images and PDFs", async () => {
    const problem = (b: Buffer) => prepareProof(b).then(() => null, (e: unknown) => (e instanceof ProofProblem ? e.message : `unexpected ${String(e)}`));
    expect(await problem(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"))).toMatch(/^Upload a screenshot/);
    expect(await problem(Buffer.from("%PDF-1.4\n%%EOF\n"))).toMatch(/^Upload a screenshot/);
    expect(await problem(await png(100, 600))).toMatch(/too small/);
    expect(await problem(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]))).toMatch(/could not be opened/);
  });
});

describe.skipIf(!hasDb)("ledger", () => {
  let env: TestEnv;
  let clientId: number;
  let methodId: number;

  beforeAll(async () => {
    env = await setup();
    const c = await exec(env.db, "INSERT INTO clients (email, first_name, last_name, referral_code, source) VALUES ('ledger@client.test', 'Lee', 'Ledger', 'LEDGER01', 'portal')");
    clientId = c.insertId;
    const m = await exec(env.db, "INSERT INTO payment_methods (direction, kind, name, currency, bank_name) VALUES ('deposit', 'bank', 'Bank transfer', 'USD', 'Test Bank')");
    methodId = m.insertId;
  });
  afterAll(async () => env?.db.end());

  const credit = (sourceId: number, cents: number) =>
    transaction(env.db, async (conn) => {
      await lockWallet(conn, clientId);
      return postLedger(conn, { kind: "deposit", sourceType: "deposit", sourceId, clientId, staffId: null, memo: "test" }, [
        { account: walletAccount(clientId), amount: cents },
        { account: depositMethodAccount(methodId), amount: -cents },
      ]);
    });

  it("creates one wallet per client with a public key", async () => {
    const [a, b] = await Promise.all([walletOf(env.db, clientId), walletOf(env.db, clientId)]);
    expect(a.id).toBe(b.id);
    expect(a.wallet_key).toMatch(/^w[0-9a-f]{20}$/);
    expect(a.available_cents).toBe(0);
  });

  it("posts balanced transactions, updates the wallet and refuses a second credit of the same source", async () => {
    await credit(1, 10_000);
    expect((await walletOf(env.db, clientId)).available_cents).toBe(10_000);
    await expect(credit(1, 10_000)).rejects.toMatchObject({ status: 409 });
    expect((await walletOf(env.db, clientId)).available_cents).toBe(10_000);
    await expect(
      transaction(env.db, (conn) =>
        postLedger(conn, { kind: "deposit", sourceType: "deposit", sourceId: 2, clientId, staffId: null, memo: "" }, [
          { account: walletAccount(clientId), amount: 100 },
          { account: depositMethodAccount(methodId), amount: -99 },
        ]),
      ),
    ).rejects.toThrow(/sum to zero/);
  });

  it("never lets a wallet go below zero", async () => {
    const hold = (sourceId: number, cents: number) =>
      transaction(env.db, async (conn) => {
        await lockWallet(conn, clientId);
        return postLedger(conn, { kind: "withdrawal_hold", sourceType: "withdrawal", sourceId, clientId, staffId: null, memo: "" }, [
          { account: walletAccount(clientId), amount: -cents },
          { account: holdAccount(clientId), amount: cents },
        ]);
      });
    await expect(hold(1, 10_001)).rejects.toBeInstanceOf(InsufficientFunds);
    await hold(2, 4_000);
    const w = await walletOf(env.db, clientId);
    expect([w.available_cents, w.held_cents]).toEqual([6_000, 4_000]);
  });

  it("keeps entries append-only and checks the cache against them", async () => {
    await expect(exec(env.db, "UPDATE ledger_entries SET amount_cents = 1 WHERE id = 1")).rejects.toThrow(/append-only/);
    await expect(exec(env.db, "DELETE FROM ledger_entries WHERE id = 1")).rejects.toThrow(/append-only/);
    await expect(exec(env.db, "DELETE FROM ledger_transactions WHERE id = 1")).rejects.toThrow(/append-only/);
    // No deposit or withdrawal rows exist for these test sources, so only the wallet checks apply.
    expect(await verifyLedger(env.db)).toEqual([]);
    await exec(env.db, "UPDATE wallets SET available_cents = available_cents + 1 WHERE client_id = ?", [clientId]);
    expect(await verifyLedger(env.db)).toEqual([expect.stringMatching(/wallet shows 6001 cents but the ledger adds up to 6000/)]);
    await exec(env.db, "UPDATE wallets SET available_cents = available_cents - 1 WHERE client_id = ?", [clientId]);
  });

  it("has default limits until Sami sets them", async () => {
    const s = await loadMoneySettings(env.db);
    expect(s).toMatchObject({ min_deposit_cents: 5000, min_withdrawal_cents: 5000, usd_to_pkr: "280.000000", deposit_second_approval_cents: 500_000, withdrawal_second_approval_cents: 100_000, first_withdrawal_second_approval: true });
    expect(await one(env.db, "SELECT permission FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.slug = 'finance_agent' AND permission = 'deposit.proof'")).toBeDefined();
  });
});
