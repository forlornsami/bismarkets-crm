import sharp from "sharp";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codeHash, newEmailCode } from "../src/server/clients/model";
import { createClientSession } from "../src/server/clients/session";
import { decryptBytes, decryptField, sha256 } from "../src/server/lib/crypto";
import { exec, one, rows, transaction } from "../src/server/lib/db";
import { outboxContext } from "../src/server/lib/email";
import { depositMethodAccount, holdAccount, lockWallet, payoutAccount, postLedger, verifyLedger, walletAccount } from "../src/server/money/ledger";
import { depositProofContext } from "../src/server/money/proofs";
import { destinationFingerprint, newReference } from "../src/server/money/references";
import { createStaff, hasDb, setup, type TestEnv } from "./helpers";

const GOOD = "Sunny-Day-42!";
const KYC = "You must complete your KYC first.";
const FROZEN = "Your account is frozen. Deposits, withdrawals and transfers are paused.";
const VIEW_ONLY = "This is a view-only staff session. Changes are not allowed.";
const PROOF_RULES = "Upload a screenshot or photo of your payment: JPG, PNG, WebP, HEIC or GIF, up to 10 MB.";
const WRONG_CODE = "The code is wrong or has expired. Request a new code.";
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** A plain picture; each colour gives a different file (and a different hash). */
const png = (background: string, width = 400, height = 300) => sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();
const PNG_INFO = { filename: "receipt.png", contentType: "image/png" };

interface Client {
  id: number;
  token: string;
  email: string;
  key: string;
}

describe.skipIf(!hasDb)("client money API", () => {
  let env: TestEnv;
  const api = () => request(env.app);
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  let ann: Client; // KYC approved: deposits, payout accounts and withdrawals
  let ben: Client; // KYC approved: someone else's data, the caps
  let cal: Client; // KYC approved: validation errors
  let dee: Client; // KYC approved: the open-deposit cap and history pages
  let fay: Client; // KYC approved, then frozen
  let newbie: Client; // KYC not done
  let gus: Client; // rate limits
  const m = { bankUsd: 0, bankPkr: 0, trc: 0, off: 0, empty: 0, wBank: 0, wTrc: 0, wBep: 0, wOff: 0 };
  let qrToken: string;
  let offQrToken: string;
  let qrPng: Buffer;

  async function register(email: string, first = "Ann", last = "Lee", approved = true): Promise<Client> {
    await api().post("/api/send-otp").send({ email });
    const sent = await one<{ body_enc: Buffer; template: string }>(env.db, "SELECT body_enc, template FROM email_outbox WHERE to_email = ? ORDER BY id DESC LIMIT 1", [email]);
    const code = /code is (\d{6})/.exec(decryptField(env.config.dataKey, sent!.body_enc, outboxContext(email, sent!.template)))![1];
    const res = await api().post("/api/register").send({ first_name: first, last_name: last, email, password: GOOD, password_confirmation: GOOD, verification_code: code });
    const id = res.body.user.id as number;
    if (approved) await exec(env.db, "UPDATE clients SET kyc_status = 'approved', kyc_approved_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [id]);
    const stats = await api().get("/api/user/stats").set(bearer(res.body.token));
    return { id, token: res.body.token, email, key: stats.body.wallet.wallet_key };
  }

  const method = async (cols: Record<string, unknown>) => {
    const keys = Object.keys(cols);
    return (await exec(env.db, `INSERT INTO payment_methods (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`, Object.values(cols))).insertId;
  };

  /** Puts money in a client's wallet the way an approved deposit does, so the ledger checks stay clean. */
  async function fund(clientId: number, cents: number) {
    await transaction(env.db, async (conn) => {
      await conn.query("SELECT id FROM clients WHERE id = ? FOR UPDATE", [clientId]);
      const wallet = await lockWallet(conn, clientId);
      const r = await exec(
        conn,
        `INSERT INTO deposits (reference, client_id, wallet_id, payment_method_id, method_name, status, currency, amount_minor, usd_rate, amount_cents, credited_cents)
         VALUES (?, ?, ?, ?, 'Bank transfer (USD)', 'approved', 'USD', ?, 1, ?, ?)`,
        [newReference("D"), clientId, wallet.id, m.bankUsd, cents, cents, cents],
      );
      await postLedger(conn, { kind: "deposit", sourceType: "deposit", sourceId: r.insertId, clientId, staffId: null, memo: "test funding" }, [
        { account: walletAccount(clientId), amount: cents },
        { account: depositMethodAccount(m.bankUsd), amount: -cents },
      ]);
    });
  }

  /** What staff do when a deposit is credited (Section B builds the real thing). */
  async function approveDeposit(reference: string) {
    await transaction(env.db, async (conn) => {
      const d = (await one<{ id: number; client_id: number; amount_cents: number; payment_method_id: number }>(conn, "SELECT id, client_id, amount_cents, payment_method_id FROM deposits WHERE reference = ?", [reference]))!;
      await conn.query("SELECT id FROM clients WHERE id = ? FOR UPDATE", [d.client_id]);
      await lockWallet(conn, d.client_id);
      await postLedger(conn, { kind: "deposit", sourceType: "deposit", sourceId: d.id, clientId: d.client_id, staffId: null, memo: "test" }, [
        { account: walletAccount(d.client_id), amount: Number(d.amount_cents) },
        { account: depositMethodAccount(d.payment_method_id), amount: -Number(d.amount_cents) },
      ]);
      await exec(conn, "UPDATE deposits SET status = 'approved', credited_cents = amount_cents WHERE id = ?", [d.id]);
    });
  }

  /** Pays or rejects a withdrawal with its ledger movement (Section C builds the real thing). */
  async function settle(reference: string, outcome: "paid" | "rejected", reason = "We could not send money to this account. Please check the account details and request again.") {
    await transaction(env.db, async (conn) => {
      const w = (await one<{ id: number; client_id: number; amount_cents: number; payment_method_id: number }>(conn, "SELECT id, client_id, amount_cents, payment_method_id FROM withdrawals WHERE reference = ?", [reference]))!;
      const cents = Number(w.amount_cents);
      await conn.query("SELECT id FROM clients WHERE id = ? FOR UPDATE", [w.client_id]);
      await lockWallet(conn, w.client_id);
      await postLedger(conn, { kind: outcome === "paid" ? "withdrawal_paid" : "withdrawal_release", sourceType: "withdrawal", sourceId: w.id, clientId: w.client_id, staffId: null, memo: "test" }, [
        { account: holdAccount(w.client_id), amount: -cents },
        { account: outcome === "paid" ? payoutAccount(w.payment_method_id) : walletAccount(w.client_id), amount: cents },
      ]);
      await exec(conn, "UPDATE withdrawals SET status = ?, reject_reason = ? WHERE id = ?", [outcome, outcome === "rejected" ? reason : null, w.id]);
    });
  }

  /** A fresh withdrawal code, as /api/send-otp issues it (that route allows one a minute per email). */
  async function issueCode(email: string, purpose: "withdrawal" | "register" = "withdrawal") {
    const code = newEmailCode();
    await exec(env.db, "UPDATE email_codes SET consumed_at = CURRENT_TIMESTAMP(3) WHERE email = ? AND purpose = ? AND consumed_at IS NULL", [email, purpose]);
    // A withdrawal code belongs to the signed-in client who asked for it.
    const owner = purpose === "withdrawal" ? (await one<{ id: number }>(env.db, "SELECT id FROM clients WHERE email = ?", [email]))!.id : null;
    await exec(env.db, "INSERT INTO email_codes (email, purpose, client_id, code_hash, expires_at) VALUES (?, ?, ?, ?, ?)", [email, purpose, owner, codeHash(env.config, email, purpose, code), new Date(Date.now() + 600_000)]);
    return code;
  }
  const codeRow = (email: string, purpose = "withdrawal") =>
    one<{ attempts: number; consumed_at: Date | null }>(env.db, "SELECT attempts, consumed_at FROM email_codes WHERE email = ? AND purpose = ? ORDER BY id DESC LIMIT 1", [email, purpose]);

  const deposit = (c: Client, fields: Record<string, string>, file?: Buffer, info: { filename: string; contentType: string } = PNG_INFO) => {
    let r = api().post("/api/deposits").set(bearer(c.token));
    for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
    if (file) r = r.attach("file_name", file, info);
    return r;
  };
  const savePayout = (c: Client, fields: Record<string, string>, file?: Buffer, id?: number) => {
    let r = api().post(id ? `/api/user-payment-methods/${id}` : "/api/user-payment-methods").set(bearer(c.token));
    for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
    if (file) r = r.attach("file_name", file, { filename: "qr.png", contentType: "image/png" });
    return r;
  };
  const withdraw = (c: Client, fields: Record<string, string>) => {
    let r = api().post("/api/withdrawals").set(bearer(c.token));
    for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
    return r;
  };
  const audits = async (action: string, clientId: number) =>
    (await rows<{ meta_json: Record<string, unknown> }>(env.db, "SELECT meta_json FROM audit_log WHERE action = ? AND entity_id = ? ORDER BY id", [action, String(clientId)])).map((r) => r.meta_json);
  const lastBell = (clientId: number) =>
    one<{ type: string; title: string; body: string; link: string | null; link_label: string | null }>(env.db, "SELECT type, title, body, link, link_label FROM client_notifications WHERE client_id = ? ORDER BY id DESC LIMIT 1", [clientId]);
  const bells = async (clientId: number) => Number((await one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM client_notifications WHERE client_id = ?", [clientId]))!.n);
  const mail = async (email: string, template: string) =>
    (await rows<{ body_enc: Buffer; body_text: string }>(env.db, "SELECT body_enc, body_text FROM email_outbox WHERE to_email = ? AND template = ? ORDER BY id", [email, template])).map((r) => ({
      text: decryptField(env.config.dataKey, r.body_enc, outboxContext(email, template)),
      stored: r.body_text,
    }));
  const wallet = async (clientId: number) => {
    const w = (await one<{ available_cents: number; held_cents: number }>(env.db, "SELECT available_cents, held_cents FROM wallets WHERE client_id = ?", [clientId]))!;
    return [Number(w.available_cents), Number(w.held_cents)];
  };
  const errorOf = (res: request.Response, field: string) => {
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.errors)[0]).toBe(field);
    expect(res.body.message).toBe(res.body.errors[field][0]);
    return res.body.errors[field][0] as string;
  };

  beforeAll(async () => {
    env = await setup();
    qrPng = await png("#000000", 240, 240);
    qrToken = "a".repeat(32);
    offQrToken = "b".repeat(32);
    m.bankUsd = await method({
      direction: "deposit", kind: "bank", name: "Bank transfer (USD)", currency: "USD", bank_name: "Meezan Bank", account_title: "BIS Markets Ltd", account_number: "0101 2233 4455",
      iban: "PK36MEZN0001010122334455", amount_note: "Send from an account in your own name.", processing_label: "1 to 3 business days", sort_order: 1,
    });
    m.bankPkr = await method({ direction: "deposit", kind: "bank", name: "Local bank (PKR)", currency: "PKR", bank_name: "HBL", account_title: "BIS Markets Ltd", account_number: "1234567", fee_label: "No fee", sort_order: 2 });
    m.trc = await method({
      direction: "deposit", kind: "crypto", name: "USDT TRC20", currency: "USD", network: "trc20", wallet_address: "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE", qr_mime: "image/png", qr_bytes: qrPng,
      qr_token: qrToken, min_minor: 2500, sort_order: 3,
    });
    m.off = await method({ direction: "deposit", kind: "crypto", name: "USDT BEP20", network: "bep20", wallet_address: "0x1111111111111111111111111111111111111111", qr_mime: "image/png", qr_bytes: qrPng, qr_token: offQrToken, is_enabled: 0 });
    // Missing its account details, so it cannot be offered.
    m.empty = await method({ direction: "deposit", kind: "bank", name: "Wire (not set up)", currency: "USD", bank_name: "Somebank", sort_order: 4 });
    m.wBank = await method({ direction: "withdrawal", kind: "bank", name: "Bank transfer", sort_order: 1 });
    m.wTrc = await method({ direction: "withdrawal", kind: "crypto", name: "USDT TRC20", network: "trc20", ask_qr: 1, sort_order: 2 });
    m.wBep = await method({ direction: "withdrawal", kind: "crypto", name: "USDT BEP20", network: "bep20", sort_order: 3 });
    m.wOff = await method({ direction: "withdrawal", kind: "crypto", name: "Binance Pay", network: "binance_pay", is_enabled: 0, sort_order: 4 });

    ann = await register("ann@client.test", "Ann", "Lee");
    ben = await register("ben@client.test", "Ben", "Hart");
    cal = await register("cal@client.test", "Cal", "Moss");
    dee = await register("dee@client.test", "Dee", "Park");
    fay = await register("fay@client.test", "Fay", "Frost");
    newbie = await register("new@client.test", "Nia", "New", false);
    gus = await register("gus@client.test", "Gus", "Gale", false);
  });
  afterAll(async () => {
    await env?.db.end();
  });

  // ---------- Reads ----------

  it("gives every signed-in client the wallet summary both apps read, with numbers", async () => {
    const res = await api().get("/api/user/stats").set(bearer(newbie.token));
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toEqual({
      success: true,
      wallet: { wallet_key: newbie.key, wallet_name: "Main Wallet", wallet_id: expect.any(Number), amount: 0, currency: "USD", type: "main", is_default: true },
      currency: "USD",
      deposits: { total_approved: 0, pending_count: 0 },
      withdrawals: { total_approved: 0, pending_count: 0 },
      minimum_amounts: { min_transfer: 10, min_internal_transfer: 10 },
      recent_deposits: [],
      recent_withdrawals: [],
    });
    expect(newbie.key).toMatch(/^w[0-9a-f]{20}$/);
    expect(newbie.key).not.toBe(ann.key);
    const anonymous = await api().get("/api/user/stats");
    expect(anonymous.status).toBe(401);
    expect(anonymous.body).toEqual({ message: "Unauthenticated." });
  });

  it("lists enabled deposit methods with every field the portal needs, a minimum in each currency and the client's reference", async () => {
    const res = await api().get("/api/deposit-methods").set(bearer(ann.token));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.settings).toEqual({ min_deposit_amount: 50, usd_to_pkr: 280 });
    expect(res.body.wallets).toEqual([{ wallet_key: ann.key, is_default: true, currency: "USD" }]);
    // Disabled methods and one without account details are left out.
    expect(res.body.payment_methods.map((p: { id: string }) => p.id)).toEqual([String(m.bankUsd), String(m.bankPkr), String(m.trc)]);
    const [usd, pkr, trc] = res.body.payment_methods;
    expect(usd).toEqual({
      id: String(m.bankUsd), name: "Bank transfer (USD)", method_name: "Bank transfer (USD)", currency: "USD", min_amount: 50, is_enabled: true, requires_slip: true, type: "manual",
      fee: "0", processing: "1 to 3 business days",
      details: {
        bank_details: "Meezan Bank\nAccount Title: BIS Markets Ltd\nAccount No: 0101 2233 4455\nIBAN: PK36MEZN0001010122334455",
        bank_name: "Meezan Bank", account_title: "BIS Markets Ltd", account_number: "0101 2233 4455", iban: "PK36MEZN0001010122334455",
        amount_note: `Send from an account in your own name.\nWrite BIS-${ann.id} as the payment reference.`,
      },
    });
    // The global minimum of USD 50 at 280 rupees per dollar; without a processing label the client reads what happens next.
    expect(pkr).toMatchObject({ currency: "PKR", min_amount: 14000, fee: "No fee", requires_slip: true, type: "manual", processing: "Added after our team checks it" });
    expect(pkr.details.bank_details).toBe("HBL\nAccount Title: BIS Markets Ltd\nAccount No: 1234567");
    expect(trc).toMatchObject({ currency: "USD", min_amount: 25, type: "manual", requires_slip: true });
    // A wallet transfer has no reference field, so it gets no reference line.
    expect(trc.details).toEqual({
      wallet_address: "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE", network: "TRC20", qr_code_url: `${env.config.publicUrl}/api/payment-qr/${qrToken}`,
    });
    for (const row of res.body.payment_methods) {
      expect(typeof row.min_amount).toBe("number");
      expect(row).not.toHaveProperty("provider");
      expect(row).not.toHaveProperty("networks");
    }
    // Reads work before KYC: both apps gate the screens on GET /api/kyc themselves.
    expect((await api().get("/api/deposit-methods").set(bearer(newbie.token))).status).toBe(200);
  });

  it("serves a deposit method's QR code publicly by its token, as an image that cannot run", async () => {
    const res = await api().get(`/api/payment-qr/${qrToken}`);
    expect(res.status).toBe(200);
    expect(res.headers).toMatchObject({
      "content-type": "image/png", "content-disposition": "inline", "content-security-policy": "default-src 'none'; sandbox", "cross-origin-resource-policy": "cross-origin",
      "x-content-type-options": "nosniff", "cache-control": "public, max-age=300",
    });
    expect(Buffer.compare(res.body as Buffer, qrPng)).toBe(0);
    expect((await api().get(`/api/payment-qr/${"c".repeat(32)}`)).status).toBe(404);
    expect((await api().get(`/api/payment-qr/${offQrToken}`)).status).toBe(404);
    const bad = await api().get("/api/payment-qr/x' OR 1=1");
    expect(bad.status).toBe(404);
    expect(bad.body).toEqual({ message: "Not found." });
    expect((await api().get(`/api/payment-qr/${qrToken.toUpperCase()}`)).status).toBe(404);
  });

  it("lists enabled payout types without a minimum, manual when a QR picture is needed", async () => {
    const res = await api().get("/api/payment-methods").set(bearer(ann.token));
    expect(res.status).toBe(200);
    const expected = [
      { id: String(m.wBank), name: "Bank transfer", method_name: "Bank transfer", type: "manual", network: "", currency: "USD", is_enabled: true },
      { id: String(m.wTrc), name: "USDT TRC20", method_name: "USDT TRC20", type: "manual", network: "TRC20", currency: "USD", is_enabled: true },
      { id: String(m.wBep), name: "USDT BEP20", method_name: "USDT BEP20", type: "hosted", network: "BEP20", currency: "USD", is_enabled: true },
    ];
    expect(res.body).toEqual({ success: true, data: expected, payment_methods: expected });
    for (const row of res.body.data) expect(row).not.toHaveProperty("min_amount");
  });

  it("gives the withdrawal limits and wallet key, with a maximum only when one is set", async () => {
    const res = await api().get("/api/withdrawal-options").set(bearer(ann.token));
    expect(res.body).toEqual({
      success: true, wallet_key: ann.key, wallets: [{ wallet_key: ann.key, is_default: true, currency: "USD", amount: 0 }], currency: "USD", min_amount: 50,
      settings: { min_withdrawal_amount: 50 },
    });
    await exec(env.db, "UPDATE money_settings SET max_withdrawal_cents = 250050 WHERE id = 1");
    const capped = await api().get("/api/withdrawal-options").set(bearer(ann.token));
    expect(capped.body).toMatchObject({ max_amount: 2500.5, settings: { min_withdrawal_amount: 50, max_withdrawal_amount: 2500.5 } });
    await exec(env.db, "UPDATE money_settings SET max_withdrawal_cents = NULL WHERE id = 1");
  });

  it("answers the transfer, IB and instant-deposit reads that are not built yet without breaking the pages", async () => {
    const transfers = await api().get("/api/transfers?page=1&per_page=200").set(bearer(ann.token));
    expect(transfers.body).toEqual({ success: true, data: [], pagination: { current_page: 1, last_page: 1, per_page: 200, total: 0 }, current_page: 1, last_page: 1, per_page: 200, total: 0 });
    const ib = await api().get("/api/ib-transfer-history?from_date=2026-01-01&to_date=2026-10-17&page=1&per_page=50").set(bearer(newbie.token));
    expect(ib.status).toBe(200);
    expect(ib.body).toEqual({ success: true, data: { history: [], pagination: { current_page: 1, last_page: 1, per_page: 50, total: 0 } } });
    const active = await api().get("/api/deposits/automated/active").set(bearer(ann.token));
    expect(active.status).toBe(404);
    expect(active.body).toEqual({ message: "No active payment." });
  });

  // ---------- Gates ----------

  it("refuses every money write before KYC, while frozen and in a staff view-only session, but keeps reads open", async () => {
    const writes = (c: Client | { token: string }) => [
      api().post("/api/deposits").set(bearer(c.token)).field("method", String(m.bankUsd)),
      api().post("/api/withdrawals").set(bearer(c.token)).send({}),
      api().post("/api/user-payment-methods").set(bearer(c.token)).send({}),
      api().post("/api/user-payment-methods/1").set(bearer(c.token)).send({}),
      api().delete("/api/user-payment-methods/1").set(bearer(c.token)),
    ];
    for (const res of await Promise.all(writes(newbie))) {
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ message: KYC });
    }
    await exec(env.db, "UPDATE clients SET status = 'frozen' WHERE id = ?", [fay.id]);
    for (const res of await Promise.all(writes(fay))) {
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ message: FROZEN });
    }
    expect((await api().get("/api/user/stats").set(bearer(fay.token))).status).toBe(200);
    expect((await api().get("/api/deposits").set(bearer(fay.token))).status).toBe(200);
    await exec(env.db, "UPDATE clients SET status = 'active' WHERE id = ?", [fay.id]);

    const staffId = await createStaff(env.db, "boss@bis.test", "super_admin");
    const view = await createClientSession(env.db, env.config, ann.id, "127.0.0.1", "test", { staffId, reason: "Checking the wallet page" });
    for (const res of await Promise.all(writes(view))) {
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ message: VIEW_ONLY });
    }
    expect((await api().get("/api/user-payment-methods").set(bearer(view.token))).status).toBe(200);
    expect(Number((await one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM deposits"))!.n)).toBe(0);
  });

  // ---------- Deposits ----------

  it("checks a deposit request field by field, in plain words, and stores nothing when it is refused", async () => {
    const proof = await png("#224466");
    const ok = { method: String(m.bankUsd), amount: "100", wallet_key: cal.key };
    const json = await api().post("/api/deposits").set(bearer(cal.token)).send({ method: String(m.trc), amount: "125.50", network: "trc20" });
    expect(json.body).toEqual({ message: "Instant deposits are not available yet. Please choose another method.", errors: { method: ["Instant deposits are not available yet. Please choose another method."] } });
    expect(errorOf(await deposit(cal, { ...ok, method: "999999" }, proof), "method")).toBe("Choose a deposit method.");
    expect(errorOf(await deposit(cal, { ...ok, method: String(m.off) }, proof), "method")).toBe("Choose a deposit method.");
    expect(errorOf(await deposit(cal, { ...ok, method: String(m.empty) }, proof), "method")).toBe("Choose a deposit method.");
    expect(errorOf(await deposit(cal, { ...ok, method: String(m.wBank) }, proof), "method")).toBe("Choose a deposit method.");
    expect(errorOf(await deposit(cal, { ...ok, wallet_key: ben.key }, proof), "wallet_key")).toBe("Refresh the page and try again.");
    expect(errorOf(await deposit(cal, { method: ok.method, amount: "100" }, proof), "wallet_key")).toBe("Refresh the page and try again.");
    expect(errorOf(await deposit(cal, { ...ok, amount: "100.001" }, proof), "amount")).toBe("Use at most two decimal places.");
    expect(errorOf(await deposit(cal, { ...ok, amount: "1,000" }, proof), "amount")).toBe("Enter the amount as a number, such as 100 or 100.50.");
    expect(errorOf(await deposit(cal, { ...ok, amount: "" }, proof), "amount")).toBe("The amount field is required.");
    expect(errorOf(await deposit(cal, { ...ok, amount: "49.99" }, proof), "amount")).toBe("The minimum deposit for this method is USD 50.00.");
    expect(errorOf(await deposit(cal, { ...ok, method: String(m.bankPkr), amount: "13999.99" }, proof), "amount")).toBe("The minimum deposit for this method is PKR 14,000.00.");
    expect(errorOf(await deposit(cal, { ...ok, method: String(m.trc), amount: "24.99" }, proof), "amount")).toBe("The minimum deposit for this method is USD 25.00.");
    expect(errorOf(await deposit(cal, ok), "file_name")).toBe("Attach a screenshot of your payment.");
    expect(errorOf(await deposit(cal, ok, Buffer.from("<html><script>alert(1)</script></html>"), { filename: "x.png", contentType: "image/png" }), "file_name")).toBe(PROOF_RULES);
    expect(errorOf(await deposit(cal, ok, Buffer.from("%PDF-1.4\n%%EOF\n"), { filename: "receipt.pdf", contentType: "application/pdf" }), "file_name")).toBe(PROOF_RULES);
    expect(errorOf(await deposit(cal, ok, await png("#224466", 100, 100)), "file_name")).toBe("This image is too small to read. Upload the full screenshot of the payment.");
    // Over 10 MB: refused as a field error the portal shows, both under and over the body limit.
    const big = Buffer.concat([proof, Buffer.alloc(10 * 1024 * 1024)]);
    expect(errorOf(await deposit(cal, ok, big), "file_name")).toBe(PROOF_RULES);
    expect(errorOf(await deposit(cal, ok, Buffer.concat([big, Buffer.alloc(1024 * 1024)])), "file_name")).toBe(PROOF_RULES);
    expect(Number((await one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM deposits WHERE client_id = ?", [cal.id]))!.n)).toBe(0);
  });

  let annUsd: string;
  let annProof: Buffer;

  it("stores a deposit request with its encrypted proof, audits it and tells the client, without touching the wallet", async () => {
    annProof = await png("#118833");
    const before = await bells(ann.id);
    // An Android file with no extension and a generic type: judged by its bytes.
    const res = await deposit(ann, { method: String(m.bankUsd), amount: "150.5", wallet_key: ann.key, network: "" }, annProof, { filename: "IMG_2041", contentType: "application/octet-stream" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      success: true,
      message: "Your deposit request was sent. We will add the money to your wallet once we confirm the payment.",
      deposit: {
        id: expect.any(Number), reference: expect.stringMatching(/^D-[0-9A-HJKMNP-TV-Z]{8}$/), method: "Bank transfer (USD)", method_name: "Bank transfer (USD)", amount: 150.5,
        currency: "USD", status_label: "pending", status: "pending", created_at: expect.stringMatching(ISO), updated_at: expect.stringMatching(ISO),
      },
    });
    annUsd = res.body.deposit.reference;
    const row = (await one<Record<string, unknown>>(env.db, "SELECT d.*, w.client_id AS wallet_owner FROM deposits d JOIN wallets w ON w.id = d.wallet_id WHERE d.reference = ?", [annUsd]))!;
    expect(row).toMatchObject({ client_id: ann.id, wallet_owner: ann.id, payment_method_id: m.bankUsd, status: "pending", currency: "USD", amount_minor: 15050, usd_rate: "1.000000", amount_cents: 15050, credited_cents: null });
    expect(row.submitted_ip).not.toBe("");
    const proof = (await one<{ mime: string; sha256: string; file_name: string; editor: string | null; size_bytes: number; bytes_enc: Buffer }>(env.db, "SELECT * FROM deposit_proofs WHERE deposit_id = ?", [row.id]))!;
    expect(proof).toMatchObject({ mime: "image/png", sha256: sha256(annProof), file_name: "IMG_2041", editor: null });
    const stored = decryptBytes(env.config.dataKey, proof.bytes_enc, depositProofContext(annUsd));
    expect(stored.length).toBe(proof.size_bytes);
    expect(await sharp(stored).metadata()).toMatchObject({ format: "png", width: 400, height: 300 });
    expect(() => decryptBytes(env.config.dataKey, proof.bytes_enc, depositProofContext("D-OTHER"))).toThrow();

    expect(await audits("deposit.requested", ann.id)).toEqual([
      {
        depositId: row.id, reference: annUsd, method: "Bank transfer (USD)", amountMinor: 15050, currency: "USD", amountCents: 15050,
        proof: { type: "image/png", bytes: annProof.length, sha256: sha256(annProof), editor: null, stored: { type: "image/png", bytes: stored.length, sha256: sha256(stored) } },
      },
    ]);
    expect(await bells(ann.id)).toBe(before + 1);
    expect(await lastBell(ann.id)).toEqual({ type: "deposit", title: "We received your deposit request", body: "We will check your payment of USD 150.50 and add it to your wallet.", link: "/transactions", link_label: "View history" });
    expect(await rows(env.db, "SELECT id FROM email_outbox WHERE client_id = ? AND template LIKE 'deposit%'", [ann.id])).toEqual([]);
    expect(await rows(env.db, "SELECT id FROM webhook_outbox WHERE event LIKE 'deposit.%'")).toEqual([]);

    const stats = (await api().get("/api/user/stats").set(bearer(ann.token))).body;
    expect(stats.wallet.amount).toBe(0);
    expect(stats.deposits).toEqual({ total_approved: 0, pending_count: 1 });
    expect(stats.recent_deposits).toEqual([res.body.deposit]);
  });

  it("converts a rupee deposit to US dollars at the rate shown", async () => {
    const res = await deposit(ann, { method: String(m.bankPkr), amount: "28000", wallet_key: ann.key }, await png("#118834"));
    expect(res.status).toBe(201);
    expect(res.body.deposit).toMatchObject({ amount: 100, currency: "USD", method_name: "Local bank (PKR)" });
    expect(await one(env.db, "SELECT currency, amount_minor, usd_rate, amount_cents FROM deposits WHERE reference = ?", [res.body.deposit.reference])).toEqual({
      currency: "PKR", amount_minor: 2_800_000, usd_rate: "280.000000", amount_cents: 10_000,
    });
    expect((await lastBell(ann.id))!.body).toBe("We will check your payment of PKR 28,000.00 (about USD 100.00) and add it to your wallet.");
  });

  it("answers a retry with the first request, refuses a screenshot sent before, and lets one from a rejected request come again", async () => {
    const count = async () => Number((await one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM deposits WHERE client_id = ?", [ann.id]))!.n);
    const n = await count();
    const again = await deposit(ann, { method: String(m.bankUsd), amount: "150.50", wallet_key: ann.key }, annProof);
    expect(again.status).toBe(201);
    expect(again.body.deposit.reference).toBe(annUsd);
    expect(await count()).toBe(n);
    expect((await audits("deposit.requested", ann.id)).length).toBe(n);

    const reused = await deposit(ann, { method: String(m.bankUsd), amount: "200", wallet_key: ann.key }, annProof);
    expect(errorOf(reused, "file_name")).toBe(`This screenshot was already sent with request ${annUsd}. Send a screenshot of the new payment.`);
    const otherMethod = await deposit(ann, { method: String(m.trc), amount: "150.50", wallet_key: ann.key }, annProof);
    expect(errorOf(otherMethod, "file_name")).toMatch(/^This screenshot was already sent with request D-/);

    // Two identical requests at once (a double tap): one deposit.
    const fresh = await png("#118835");
    const [a, b] = await Promise.all([0, 1].map(() => deposit(ann, { method: String(m.bankUsd), amount: "75", wallet_key: ann.key }, fresh)));
    expect([a!.status, b!.status]).toEqual([201, 201]);
    expect(a!.body.deposit.reference).toBe(b!.body.deposit.reference);
    expect(await count()).toBe(n + 1);

    // Staff asked for the request again with the right method: the same screenshot is fine then.
    await exec(env.db, "UPDATE deposits SET status = 'rejected', reject_reason = 'This payment arrived through a different method. Please send a new request with the method you used.' WHERE reference = ?", [a!.body.deposit.reference]);
    const resent = await deposit(ann, { method: String(m.trc), amount: "75", wallet_key: ann.key }, fresh);
    expect(resent.status).toBe(201);
    expect(resent.body.deposit.reference).not.toBe(a!.body.deposit.reference);
  });

  it("keeps at most five deposits waiting, but still answers a retry of one of them", async () => {
    const proofs = await Promise.all(["#330001", "#330002", "#330003", "#330004", "#330005", "#330006"].map((c) => png(c)));
    const refs: string[] = [];
    for (const [i, p] of proofs.slice(0, 5).entries()) {
      const res = await deposit(dee, { method: String(m.bankUsd), amount: String(100 + i), wallet_key: dee.key }, p);
      expect(res.status).toBe(201);
      refs.push(res.body.deposit.reference);
    }
    const sixth = await deposit(dee, { method: String(m.bankUsd), amount: "200", wallet_key: dee.key }, proofs[5]);
    expect(errorOf(sixth, "amount")).toBe("You already have 5 deposits waiting for review. Please wait for them to be checked.");
    const retry = await deposit(dee, { method: String(m.bankUsd), amount: "104", wallet_key: dee.key }, proofs[4]);
    expect(retry.status).toBe(201);
    expect(retry.body.deposit.reference).toBe(refs[4]);
  });

  it("pages the deposit history newest first, echoing the page, with the client's status words and the reason only when rejected", async () => {
    const [first, second, third] = (await rows<{ reference: string }>(env.db, "SELECT reference FROM deposits WHERE client_id = ? ORDER BY id", [dee.id])).map((r) => r.reference);
    const reason = "We could not find this payment. If you have already paid, please contact support with your payment receipt.";
    await exec(env.db, "UPDATE deposits SET status = 'rejected', reject_reason = ? WHERE reference = ?", [reason, first]);
    await exec(env.db, "UPDATE deposits SET status = 'second_approval' WHERE reference = ?", [second]);
    await approveDeposit(third!);
    // Same creation time: the id breaks the tie, so pages never overlap.
    await exec(env.db, "UPDATE deposits SET created_at = '2026-10-01 10:00:00.000' WHERE client_id = ?", [dee.id]);

    const seen: { id: number }[] = [];
    for (const page of [1, 2, 3]) {
      const res = await api().get(`/api/deposits?page=${page}&per_page=2`).set(bearer(dee.token));
      expect(res.status).toBe(200);
      const meta = { current_page: page, last_page: 3, per_page: 2, total: 5 };
      expect(res.body).toMatchObject({ success: true, pagination: meta, ...meta });
      seen.push(...res.body.data);
    }
    expect(seen.map((r) => r.id)).toEqual([...seen.map((r) => r.id)].sort((a, b) => b - a));
    const allowed = ["id", "reference", "method", "method_name", "amount", "currency", "status_label", "status", "created_at", "updated_at", "message", "rejection_reason"];
    for (const row of seen) {
      expect(Object.keys(row).every((k) => allowed.includes(k))).toBe(true);
      expect(row).toMatchObject({ created_at: "2026-10-01T10:00:00.000Z", currency: "USD" });
    }
    const byRef = new Map(seen.map((r) => [(r as unknown as { reference: string }).reference, r as unknown as Record<string, unknown>]));
    expect(byRef.get(first!)).toMatchObject({ status_label: "rejected", status: "rejected", message: reason, rejection_reason: reason, amount: 100 });
    expect(byRef.get(second!)).toMatchObject({ status_label: "pending", status: "pending" });
    expect(byRef.get(second!)).not.toHaveProperty("message");
    expect(byRef.get(third!)).toMatchObject({ status_label: "approved", amount: 102 });

    // Odd paging values fall back to the defaults instead of failing the page.
    const odd = await api().get("/api/deposits?page=abc&per_page=500").set(bearer(dee.token));
    expect(odd.status).toBe(200);
    expect(odd.body).toMatchObject({ current_page: 1, per_page: 15, last_page: 1, total: 5 });
    expect(odd.body.data).toHaveLength(5);
    const beyond = await api().get("/api/deposits?page=4&per_page=200").set(bearer(dee.token));
    expect(beyond.body).toMatchObject({ data: [], current_page: 4, last_page: 1, per_page: 200, total: 5 });
    const zero = await api().get("/api/deposits?page=0&per_page=0").set(bearer(dee.token));
    expect(zero.body).toMatchObject({ current_page: 1, per_page: 15 });

    const stats = (await api().get("/api/user/stats").set(bearer(dee.token))).body;
    expect(stats.wallet.amount).toBe(102);
    expect(stats.deposits).toEqual({ total_approved: 102, pending_count: 3 });
    expect(stats.recent_deposits).toHaveLength(5);
    // Nobody else's deposits.
    expect((await api().get("/api/deposits").set(bearer(ben.token))).body).toMatchObject({ data: [], total: 0, last_page: 1 });
  });

  // ---------- Saved payout accounts ----------

  let annBank: number;
  let annTrc: number;
  let annBep: number;
  let firstTrcQr: string;

  it("checks a new payout account's fields for its type", async () => {
    const bank = { payment_method_id: String(m.wBank), method_name: "Meezan Bank", account_name: "Cal Moss", account_number: "0123 4567 8901", is_default: "1" };
    expect(errorOf(await savePayout(cal, { ...bank, payment_method_id: "" }), "payment_method_id")).toBe("Choose an account type.");
    expect(errorOf(await savePayout(cal, { ...bank, payment_method_id: String(m.wOff) }), "payment_method_id")).toBe("Choose an account type.");
    expect(errorOf(await savePayout(cal, { ...bank, payment_method_id: String(m.bankUsd) }), "payment_method_id")).toBe("Choose an account type.");
    expect(errorOf(await savePayout(cal, { ...bank, account_name: "" }), "account_name")).toBe("Enter the account holder's name.");
    expect(errorOf(await savePayout(cal, { ...bank, account_number: "12" }), "account_number")).toBe("Enter the full account number.");
    expect(errorOf(await savePayout(cal, { ...bank, account_number: "<script>1234</script>" }), "account_number")).toBe("Use only letters, numbers, spaces and - . / :");
    expect(errorOf(await savePayout(cal, { ...bank, method_name: "" }), "method_name")).toBe("Enter a name for this account.");
    // Worded without the symbols, so the portal shows it as written.
    expect(errorOf(await savePayout(cal, { ...bank, method_name: "<b>Bank</b>" }), "method_name")).toBe("Use plain text only, without angle brackets, curly brackets, backslashes or web links.");
    expect(errorOf(await savePayout(cal, { ...bank, iban: "x".repeat(65) }), "iban")).toBe("The IBAN can be at most 64 characters.");
    const trc = { payment_method_id: String(m.wTrc), method_name: "USDT TRC20", account_number: "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE" };
    expect(errorOf(await savePayout(cal, trc), "file_name")).toBe("Upload a picture of your wallet's QR code.");
    expect(errorOf(await savePayout(cal, trc, Buffer.from("<svg onload=alert(1)>")), "file_name")).toBe("Upload a picture of the QR code: JPG, PNG, WebP, HEIC or GIF, up to 10 MB.");
    expect(errorOf(await savePayout(cal, trc, Buffer.from("GIF89a not really")), "file_name")).toBe("This picture could not be opened. Upload a picture of the QR code: JPG, PNG, WebP, HEIC or GIF, up to 10 MB.");
    // An address saved under another network's type would be paid on the wrong chain.
    expect(errorOf(await savePayout(cal, { ...trc, payment_method_id: String(m.wBep) }), "account_number")).toBe(
      "This is not a BEP20 address. A BEP20 address starts with 0x followed by 40 letters and digits.",
    );
    expect(errorOf(await savePayout(cal, { ...trc, account_number: "0x52908400098527886E0F7030069857D2E4169EE7" }), "account_number")).toBe(
      "This is not a TRC20 address. A TRC20 address starts with T and has 34 characters.",
    );
    // A bank account takes no picture: one sent anyway is ignored, not stored.
    const ignored = await savePayout(cal, { payment_method_id: String(m.wBank), method_name: "Spare", account_name: "Cal Moss", account_number: "11112222" }, await png("#444444", 300, 300));
    expect(ignored.status).toBe(201);
    expect(ignored.body.data.qr_code_url).toBeNull();
    expect((await one<{ qr_bytes_enc: Buffer | null }>(env.db, "SELECT qr_bytes_enc FROM client_payout_methods WHERE id = ?", [ignored.body.id]))!.qr_bytes_enc).toBeNull();
    expect((await api().delete(`/api/user-payment-methods/${ignored.body.id}`).set(bearer(cal.token))).status).toBe(200);
    expect((await api().get("/api/user-payment-methods").set(bearer(cal.token))).body).toEqual({ success: true, data: [], user_payment_methods: [] });
  });

  it("does not let a client's form choose another client's row, the owner or the stored numbers", async () => {
    const res = await api()
      .post("/api/user-payment-methods")
      .set(bearer(dee.token))
      .send({ payment_method_id: m.wBep, method_name: "Dee wallet", account_number: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd", client_id: ann.id, user_id: ann.id, id: 1, fingerprint: "f".repeat(64), is_default: true });
    expect(res.status).toBe(201);
    const row = (await one<{ client_id: number; fingerprint: string }>(env.db, "SELECT client_id, fingerprint FROM client_payout_methods WHERE id = ?", [res.body.id]))!;
    expect(row.client_id).toBe(dee.id);
    expect(row.fingerprint).not.toBe("f".repeat(64));
    expect((await api().delete(`/api/user-payment-methods/${res.body.id}`).set(bearer(dee.token))).status).toBe(200);
  });

  it("saves a bank account encrypted, echoes it exactly, makes the first one the default and warns the client", async () => {
    const res = await savePayout(ann, {
      payment_method_id: String(m.wBank), method_name: "Meezan Bank", account_name: "Ann Lee", account_number: "0123 4567 8901", iban: "PK36MEZN0000000123456789", swift: "MEZNPKKA", is_default: "0",
    });
    expect(res.status).toBe(201);
    const row = {
      id: expect.any(Number), user_payment_method_id: expect.any(Number), payment_method_id: String(m.wBank), payment_method_name: "Bank transfer", method_name: "Meezan Bank",
      account_name: "Ann Lee", account_number: "0123 4567 8901", iban: "PK36MEZN0000000123456789", swift: "MEZNPKKA", network: "", currency: "USD", is_default: true, qr_code_url: null,
      created_at: expect.stringMatching(ISO),
    };
    expect(res.body).toEqual({ success: true, message: "Payout account saved.", data: row, user_payment_method: row, id: res.body.data.id, method_name: "Meezan Bank", created_at: res.body.data.created_at });
    annBank = res.body.id;
    expect(res.body.data.user_payment_method_id).toBe(annBank);

    const stored = (await one<{ account_number_enc: Buffer; iban_enc: Buffer; fingerprint: string }>(env.db, "SELECT * FROM client_payout_methods WHERE id = ?", [annBank]))!;
    expect(stored.account_number_enc.includes("4567")).toBe(false);
    expect(decryptField(env.config.dataKey, stored.account_number_enc, `payout_method:${ann.id}:account_number`)).toBe("0123 4567 8901");
    expect(decryptField(env.config.dataKey, stored.iban_enc, `payout_method:${ann.id}:iban`)).toBe("PK36MEZN0000000123456789");
    expect(stored.fingerprint).toBe(destinationFingerprint(env.config.dataKey, m.wBank, "PK36MEZN0000000123456789"));

    const [added] = await audits("payout_method.added", ann.id);
    expect(added).toEqual({ id: annBank, type: "Bank transfer", kind: "bank", ending: "8901", qr: false, default: true });
    const everything = JSON.stringify(await rows(env.db, "SELECT meta_json, before_json, after_json FROM audit_log"));
    expect(everything).not.toContain("4567");
    expect(everything).not.toContain("PK36MEZN");
    expect(await lastBell(ann.id)).toMatchObject({ type: "security", title: "A payout account was added", body: "Meezan Bank ending 8901 can now receive withdrawals. If this was not you, contact support straight away." });
    const [email] = await mail(ann.email, "payout_method_added");
    expect(email!.text).toContain("Meezan Bank ending 8901");
    expect(email!.text).toContain("If this was not you, contact support straight away and change your password.");
    expect(email!.text).not.toContain("4567");
  });

  it("saves crypto wallets, with a QR picture where the type asks for one, served only by its secret link", async () => {
    const qr = await png("#101010", 300, 300);
    const trc = await savePayout(ann, { payment_method_id: String(m.wTrc), method_name: "USDT TRC20", account_name: "Ann Lee", account_number: "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE", is_default: "1" }, qr);
    expect(trc.status).toBe(201);
    annTrc = trc.body.id;
    expect(trc.body.data).toMatchObject({ payment_method_name: "USDT TRC20", network: "TRC20", is_default: true, iban: "", swift: "", qr_code_url: expect.stringMatching(new RegExp(`^${env.config.publicUrl}/api/payout-qr/[a-f0-9]{32}$`)) });
    firstTrcQr = trc.body.data.qr_code_url.split("/").pop();
    const served = await api().get(`/api/payout-qr/${firstTrcQr}`);
    expect(served.status).toBe(200);
    expect(served.headers).toMatchObject({ "content-type": "image/png", "content-disposition": "inline", "content-security-policy": "default-src 'none'; sandbox", "cache-control": "private, no-store", "x-content-type-options": "nosniff" });
    expect(await sharp(served.body as Buffer).metadata()).toMatchObject({ width: 300, height: 300 });
    expect((await one<{ qr_bytes_enc: Buffer }>(env.db, "SELECT qr_bytes_enc FROM client_payout_methods WHERE id = ?", [annTrc]))!.qr_bytes_enc.equals(served.body as Buffer)).toBe(false);
    expect((await api().get(`/api/payout-qr/${"d".repeat(32)}`)).status).toBe(404);
    expect((await api().get("/api/payout-qr/nope")).status).toBe(404);

    // A hosted type needs no picture; is_default 0 leaves the default where it is.
    const bep = await savePayout(ann, { payment_method_id: String(m.wBep), method_name: "USDT BEP20", account_name: "Ann Lee", account_number: "0x52908400098527886E0F7030069857D2E4169EE7", is_default: "0" });
    expect(bep.status).toBe(201);
    annBep = bep.body.id;
    expect(bep.body.data).toMatchObject({ is_default: false, qr_code_url: null, network: "BEP20" });

    const list = (await api().get("/api/user-payment-methods").set(bearer(ann.token))).body;
    expect(list.data).toEqual(list.user_payment_methods);
    expect(list.data.map((r: { id: number; is_default: boolean }) => [r.id, r.is_default])).toEqual([[annBep, false], [annTrc, true], [annBank, false]]);
    // Nobody else sees them.
    expect((await api().get("/api/user-payment-methods").set(bearer(ben.token))).body.data).toEqual([]);
  });

  it("updates an account the way the app does (empty IBAN and SWIFT), and tells the client when the details change", async () => {
    const bellsBefore = await bells(ann.id);
    const changedAt = (await one<{ details_changed_at: Date }>(env.db, "SELECT details_changed_at FROM client_payout_methods WHERE id = ?", [annBank]))!.details_changed_at;
    const res = await savePayout(ann, { payment_method_id: String(m.wBank), method_name: "Meezan Bank", account_name: "Ann Lee", account_number: "0123 4567 8901", iban: "", swift: "", is_default: "0" }, undefined, annBank);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, message: "Payout account saved.", id: annBank, data: { iban: "", swift: "", account_number: "0123 4567 8901", is_default: false, method_name: "Meezan Bank" } });
    const stored = (await one<{ iban_enc: Buffer | null; fingerprint: string; details_changed_at: Date }>(env.db, "SELECT iban_enc, fingerprint, details_changed_at FROM client_payout_methods WHERE id = ?", [annBank]))!;
    expect(stored.iban_enc).toBeNull();
    expect(stored.fingerprint).toBe(destinationFingerprint(env.config.dataKey, m.wBank, "0123 4567 8901"));
    expect(stored.details_changed_at.getTime()).toBeGreaterThanOrEqual(changedAt.getTime());
    expect((await audits("payout_method.updated", ann.id)).at(-1)).toEqual({ id: annBank, type: "Bank transfer", ending: "8901", fields: ["iban", "swift"] });
    expect(await bells(ann.id)).toBe(bellsBefore + 1);
    expect(await lastBell(ann.id)).toMatchObject({ type: "security", title: "A payout account was changed" });
    expect((await mail(ann.email, "payout_method_updated")).length).toBe(1);

    // The portal leaves empty fields out: nothing that is not sent changes.
    const portal = await savePayout(ann, { payment_method_id: String(m.wBank), method_name: "Meezan Bank Ltd", account_name: "Ann Lee", is_default: "0" }, undefined, annBank);
    expect(portal.body.data).toMatchObject({ method_name: "Meezan Bank Ltd", account_number: "0123 4567 8901", iban: "" });
    expect((await audits("payout_method.updated", ann.id)).at(-1)).toEqual({ id: annBank, type: "Bank transfer", ending: "8901", fields: ["method_name"] });
    expect(await bells(ann.id)).toBe(bellsBefore + 1);
  });

  it("moves the default with is_default alone, without alerting the client", async () => {
    const bellsBefore = await bells(ann.id);
    const res = await savePayout(ann, { payment_method_id: String(m.wBank), method_name: "Meezan Bank Ltd", account_name: "Ann Lee", account_number: "0123 4567 8901", iban: "", swift: "", is_default: "1" }, undefined, annBank);
    expect(res.status).toBe(200);
    expect(res.body.data.is_default).toBe(true);
    const list = (await api().get("/api/user-payment-methods").set(bearer(ann.token))).body.data as { id: number; is_default: boolean }[];
    expect(list.filter((r) => r.is_default).map((r) => r.id)).toEqual([annBank]);
    expect((await audits("payout_method.updated", ann.id)).at(-1)).toEqual({ id: annBank, type: "Bank transfer", ending: "8901", fields: [], default: true });
    expect(await bells(ann.id)).toBe(bellsBefore);
    // Sending the same row again changes nothing and records nothing.
    const audited = (await audits("payout_method.updated", ann.id)).length;
    expect((await savePayout(ann, { payment_method_id: String(m.wBank), method_name: "Meezan Bank Ltd", account_name: "Ann Lee", account_number: "0123 4567 8901", is_default: "1" }, undefined, annBank)).status).toBe(200);
    expect((await audits("payout_method.updated", ann.id)).length).toBe(audited);
  });

  it("replaces a wallet's QR picture with a new secret link, and drops it when the address changes without one", async () => {
    const res = await savePayout(ann, { method_name: "USDT TRC20" }, await png("#202020", 300, 300), annTrc);
    expect(res.status).toBe(200);
    const token = res.body.data.qr_code_url.split("/").pop();
    expect(token).not.toBe(firstTrcQr);
    expect((await api().get(`/api/payout-qr/${firstTrcQr}`)).status).toBe(404);
    expect((await api().get(`/api/payout-qr/${token}`)).status).toBe(200);
    expect((await audits("payout_method.updated", ann.id)).at(-1)).toMatchObject({ id: annTrc, fields: ["qr"] });
    expect(await lastBell(ann.id)).toMatchObject({ title: "A payout account was changed" });

    // The type asks for a QR code, so a new address without one is refused (the app's edit form sends none) and nothing changes.
    expect(errorOf(await savePayout(ann, { account_number: "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj" }, undefined, annTrc), "account_number")).toBe(
      "This account type needs your wallet's QR code. To change the details, remove this account and add it again with its QR code.",
    );
    expect((await api().get(`/api/payout-qr/${token}`)).status).toBe(200);
    const moved = await savePayout(ann, { account_number: "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj" }, await png("#303030", 300, 300), annTrc);
    expect(moved.body.data).toMatchObject({ account_number: "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj", qr_code_url: expect.any(String) });
    expect((await audits("payout_method.updated", ann.id)).at(-1)).toMatchObject({ fields: ["account_number", "qr"] });
    expect((await api().get(`/api/payout-qr/${token}`)).status).toBe(404);

    // Under a type that does not ask for one, the old picture goes with the old address.
    const spare = await savePayout(ann, { payment_method_id: String(m.wBep), method_name: "Spare", account_number: "0x1111111111111111111111111111111111111111", is_default: "0" }, await png("#404040", 300, 300));
    const spareQr = spare.body.data.qr_code_url.split("/").pop();
    const spareMoved = await savePayout(ann, { account_number: "0x2222222222222222222222222222222222222222" }, undefined, spare.body.id);
    expect(spareMoved.body.data).toMatchObject({ account_number: "0x2222222222222222222222222222222222222222", qr_code_url: null });
    expect((await audits("payout_method.updated", ann.id)).at(-1)).toMatchObject({ fields: ["account_number", "qr"] });
    expect((await api().get(`/api/payout-qr/${spareQr}`)).status).toBe(404);
    expect((await api().delete(`/api/user-payment-methods/${spare.body.id}`).set(bearer(ann.token))).status).toBe(200);
  });

  it("answers another client's payout account as not found", async () => {
    for (const res of [
      await savePayout(ben, { method_name: "Mine now" }, undefined, annBank),
      await api().delete(`/api/user-payment-methods/${annBank}`).set(bearer(ben.token)),
      await api().delete("/api/user-payment-methods/abc").set(bearer(ben.token)),
      await savePayout(ben, { method_name: "x" }, undefined, 99999999),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ message: "Payout account not found." });
    }
    expect((await api().get("/api/user-payment-methods").set(bearer(ann.token))).body.data.find((r: { id: number }) => r.id === annBank).method_name).toBe("Meezan Bank Ltd");
  });

  it("keeps at most ten accounts and passes the default to the newest one left when the default is removed", async () => {
    const save = (i: number) =>
      savePayout(ben, { payment_method_id: String(m.wBep), method_name: `Wallet ${i}`, account_number: `0x${String(i).padStart(40, "0")}`, is_default: i === 3 ? "1" : "0" });
    const ids: number[] = [];
    for (let i = 1; i <= 10; i++) {
      const res = await save(i);
      expect(res.status).toBe(201);
      ids.push(res.body.id);
    }
    expect(errorOf(await save(11), "payment_method_id")).toBe("You can save up to 10 payout accounts. Remove one to add another.");
    const removed = await api().delete(`/api/user-payment-methods/${ids[2]}`).set(bearer(ben.token));
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ success: true, message: "Payout account removed." });
    const list = (await api().get("/api/user-payment-methods").set(bearer(ben.token))).body.data as { id: number; is_default: boolean }[];
    expect(list).toHaveLength(9);
    expect(list.filter((r) => r.is_default).map((r) => r.id)).toEqual([ids[9]]);
    expect((await audits("payout_method.removed", ben.id)).at(-1)).toEqual({ id: ids[2], type: "USDT BEP20", ending: "0003" });
    expect((await savePayout(ben, { method_name: "again" }, undefined, ids[2])).status).toBe(404);
    expect((await save(11)).status).toBe(201);
  });

  // ---------- Withdrawals ----------

  let w1: string;

  it("checks a withdrawal request field by field, counts a wrong code and never answers 401", async () => {
    await fund(cal.id, 20_000);
    const saved = await savePayout(cal, { payment_method_id: String(m.wBank), method_name: "HBL", account_name: "Cal Moss", account_number: "5566778899", is_default: "1" });
    expect(saved.status).toBe(201);
    const code = await issueCode(cal.email);
    const ok = { method: String(saved.body.id), amount: "100", verification_code: code, wallet_key: cal.key };
    expect(errorOf(await withdraw(cal, { ...ok, method: "" }), "method")).toBe("Choose where to send the money.");
    expect(errorOf(await withdraw(cal, { ...ok, method: String(annBank) }), "method")).toBe("Choose where to send the money.");
    expect(errorOf(await withdraw(cal, { ...ok, wallet_key: ann.key }), "wallet_key")).toBe("Refresh the page and try again.");
    expect(errorOf(await withdraw(cal, { ...ok, amount: "49.99" }), "amount")).toBe("The minimum withdrawal is USD 50.00.");
    expect(errorOf(await withdraw(cal, { ...ok, amount: "60.123" }), "amount")).toBe("Use at most two decimal places.");
    expect(errorOf(await withdraw(cal, { ...ok, verification_code: "" }), "verification_code")).toBe("Enter the code we emailed you.");
    expect((await codeRow(cal.email))!.attempts).toBe(0);
    const wrong = await withdraw(cal, { ...ok, verification_code: code === "000000" ? "111111" : "000000" });
    expect(errorOf(wrong, "verification_code")).toBe(WRONG_CODE);
    // Counted even though the request failed.
    expect((await codeRow(cal.email))!.attempts).toBe(1);
    const tooMuch = await withdraw(cal, { ...ok, amount: "200.01" });
    expect(errorOf(tooMuch, "amount")).toBe("This is more than your available balance of USD 200.00.");
    // Nothing happened, so the code is still good.
    expect((await codeRow(cal.email))!.consumed_at).toBeNull();
    await exec(env.db, "UPDATE money_settings SET max_withdrawal_cents = 15000 WHERE id = 1");
    expect(errorOf(await withdraw(cal, { ...ok, amount: "150.01" }), "amount")).toBe("The maximum withdrawal is USD 150.00.");
    await exec(env.db, "UPDATE money_settings SET max_withdrawal_cents = NULL WHERE id = 1");
    expect(await wallet(cal.id)).toEqual([20_000, 0]);
    expect(Number((await one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM withdrawals WHERE client_id = ?", [cal.id]))!.n)).toBe(0);
  });

  it("checks a withdrawal code on verify-otp with the client's session, without using it up", async () => {
    const sent = await api().post("/api/send-otp").set(bearer(ann.token)).send({ email: ann.email });
    expect(sent.status).toBe(200);
    const out = (await mail(ann.email, "otp_withdrawal")).at(-1)!;
    const code = /code is (\d{6})/.exec(out.text)![1]!;
    expect(out.stored).not.toContain(code);
    const other = code === "000000" ? "111111" : "000000";
    // Without the session, nothing reaches a withdrawal code: guesses are checked against sign-up codes only.
    for (let i = 0; i < 6; i++) expect((await api().post("/api/verify-otp").send({ email: ann.email, verification_code: other, purpose: "withdrawal" })).status).toBe(422);
    expect((await api().post("/api/verify-otp").send({ email: ann.email, verification_code: code })).status).toBe(422);
    expect((await codeRow(ann.email))!.attempts).toBe(0);
    const verify = (verification_code: string) => api().post("/api/verify-otp").set(bearer(ann.token)).send({ email: ann.email, verification_code, purpose: "withdrawal" });
    const wrong = await verify(other);
    expect(wrong.status).toBe(422);
    expect((await codeRow(ann.email))!.attempts).toBe(1);
    const right = await verify(code);
    expect(right.status).toBe(200);
    expect(right.body).toMatchObject({ success: true });
    expect((await codeRow(ann.email))!.consumed_at).toBeNull();

    await fund(ann.id, 50_000);
    const bellsBefore = await bells(ann.id);
    const res = await withdraw(ann, { method: String(annBank), amount: "100", verification_code: code, wallet_key: ann.key });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      success: true,
      message: "Your withdrawal request was sent.",
      withdrawal: {
        id: expect.any(Number), reference: expect.stringMatching(/^W-[0-9A-HJKMNP-TV-Z]{8}$/), method: "Meezan Bank Ltd", method_name: "Meezan Bank Ltd", amount: 100, currency: "USD",
        status_label: "pending", status: "pending", created_at: expect.stringMatching(ISO), updated_at: expect.stringMatching(ISO),
      },
    });
    w1 = res.body.withdrawal.reference;
    // Used up with the request: the same code cannot send another.
    expect((await codeRow(ann.email))!.consumed_at).not.toBeNull();
    expect(errorOf(await withdraw(ann, { method: String(annBank), amount: "50", verification_code: code, wallet_key: ann.key }), "verification_code")).toBe(WRONG_CODE);
    expect((await verify(code)).status).toBe(422);

    // The money is held at once.
    expect(await wallet(ann.id)).toEqual([40_000, 10_000]);
    const stats = (await api().get("/api/user/stats").set(bearer(ann.token))).body;
    expect(stats.wallet.amount).toBe(400);
    expect(stats.withdrawals).toEqual({ total_approved: 0, pending_count: 1 });
    expect((await api().get("/api/withdrawal-options").set(bearer(ann.token))).body.wallets[0].amount).toBe(400);

    const row = (await one<{ id: number; needs_second_approval: number; destination_enc: Buffer; destination_fingerprint: string; payment_method_id: number; payout_method_id: number; status: string }>(
      env.db, "SELECT * FROM withdrawals WHERE reference = ?", [w1],
    ))!;
    // A first withdrawal always needs a second person (the default setting).
    expect(row).toMatchObject({ needs_second_approval: 1, payment_method_id: m.wBank, payout_method_id: annBank, status: "pending" });
    expect(JSON.parse(decryptField(env.config.dataKey, row.destination_enc, `withdrawal:${w1}`))).toEqual({
      methodName: "Meezan Bank Ltd", typeName: "Bank transfer", kind: "bank", network: "", accountName: "Ann Lee", accountNumber: "0123 4567 8901", iban: "", swift: "", payoutMethodId: annBank, qrToken: null,
    });
    expect(row.destination_fingerprint).toBe((await one<{ fingerprint: string }>(env.db, "SELECT fingerprint FROM client_payout_methods WHERE id = ?", [annBank]))!.fingerprint);
    const hold = await rows<{ account: string; amount_cents: number }>(
      env.db, "SELECT e.account, e.amount_cents FROM ledger_transactions t JOIN ledger_entries e ON e.transaction_id = t.id WHERE t.source_type = 'withdrawal' AND t.source_id = ? AND t.kind = 'withdrawal_hold' ORDER BY e.id", [row.id],
    );
    expect(hold.map((e) => [e.account, Number(e.amount_cents)])).toEqual([[`client:${ann.id}:wallet`, -10_000], [`client:${ann.id}:hold`, 10_000]]);

    expect(await audits("withdrawal.requested", ann.id)).toEqual([
      { withdrawalId: row.id, reference: w1, amountCents: 10_000, method: "Meezan Bank Ltd", type: "Bank transfer", accountEnding: "8901", needsSecondApproval: true },
    ]);
    expect(await bells(ann.id)).toBe(bellsBefore + 1);
    expect(await lastBell(ann.id)).toEqual({
      type: "withdrawal", title: "We received your withdrawal request", body: "USD 100.00 to your Meezan Bank Ltd account ending 8901. We will let you know when it is sent.", link: "/transactions", link_label: "View history",
    });
    const [email] = await mail(ann.email, "withdrawal_requested");
    expect(email!.text).toContain("USD 100.00 to your Meezan Bank Ltd account ending 8901");
    expect(email!.text).toContain("If you did not ask for this, contact support straight away and change your password.");
    expect(email!.text).not.toContain("4567");
    expect(await rows(env.db, "SELECT id FROM webhook_outbox WHERE event LIKE 'withdrawal.%'")).toEqual([]);
  });

  it("keeps a client's withdrawal codes out of other clients' reach", async () => {
    const code = await issueCode(dee.email);
    // Ben asks for a withdrawal code "for" Dee: it goes to Ben's own address, and Dee's code still works.
    const asked = await api().post("/api/send-otp").set(bearer(ben.token)).send({ email: dee.email, purpose: "withdrawal" });
    expect(asked.status).toBe(200);
    expect(await mail(dee.email, "otp_withdrawal")).toEqual([]);
    expect(await one(env.db, "SELECT client_id, email FROM email_codes WHERE purpose = 'withdrawal' ORDER BY id DESC LIMIT 1")).toEqual({ client_id: ben.id, email: ben.email });
    expect((await codeRow(dee.email))!.consumed_at).toBeNull();
    // Ben's guesses at Dee's address only ever reach Ben's own code.
    for (let i = 0; i < 5; i++) await api().post("/api/verify-otp").set(bearer(ben.token)).send({ email: dee.email, verification_code: code === "000000" ? "111111" : "000000", purpose: "withdrawal" });
    expect((await codeRow(dee.email))!).toMatchObject({ attempts: 0, consumed_at: null });
    expect((await api().post("/api/verify-otp").set(bearer(dee.token)).send({ email: dee.email, verification_code: code, purpose: "withdrawal" })).status).toBe(200);
    // Nor do Ben's requests count against Dee's limits.
    expect((await api().post("/api/send-otp").set(bearer(dee.token)).send({ email: dee.email })).status).toBe(200);
    // A code for Ann's address that another client asked for never sends Ann's money.
    const stray = newEmailCode();
    await exec(env.db, "UPDATE email_codes SET consumed_at = CURRENT_TIMESTAMP(3) WHERE email = ? AND consumed_at IS NULL", [ann.email]);
    await exec(env.db, "INSERT INTO email_codes (email, purpose, client_id, code_hash, expires_at) VALUES (?, 'withdrawal', ?, ?, ?)", [ann.email, ben.id, codeHash(env.config, ann.email, "withdrawal", stray), new Date(Date.now() + 600_000)]);
    expect(errorOf(await withdraw(ann, { method: String(annBank), amount: "50", verification_code: stray, wallet_key: ann.key }), "verification_code")).toBe(WRONG_CODE);
    await exec(env.db, "UPDATE email_codes SET consumed_at = CURRENT_TIMESTAMP(3) WHERE consumed_at IS NULL");
  });

  it("lets only one of two requests with the same code through", async () => {
    const code = await issueCode(ann.email);
    const results = await Promise.all([0, 1].map(() => withdraw(ann, { method: String(annBep), amount: "50", verification_code: code, wallet_key: ann.key })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
    expect(results.find((r) => r.status === 422)!.body.errors.verification_code).toEqual([WRONG_CODE]);
    expect(await wallet(ann.id)).toEqual([35_000, 15_000]);
  });

  it("decides at request time whether a second approval is needed, and accepts JSON", async () => {
    await settle(w1, "paid");
    await exec(env.db, "UPDATE money_settings SET withdrawal_second_approval_cents = 6000 WHERE id = 1");
    const big = await api().post("/api/withdrawals").set(bearer(ann.token)).send({ method: annBank, amount: 70, verification_code: await issueCode(ann.email), wallet_key: ann.key });
    expect(big.status).toBe(201);
    expect((await one<{ n: number }>(env.db, "SELECT needs_second_approval AS n FROM withdrawals WHERE reference = ?", [big.body.withdrawal.reference]))!.n).toBe(1);
    await settle(big.body.withdrawal.reference, "rejected");
    const small = await withdraw(ann, { method: String(annBank), amount: "50", verification_code: await issueCode(ann.email), wallet_key: ann.key });
    expect(small.status).toBe(201);
    expect((await one<{ n: number }>(env.db, "SELECT needs_second_approval AS n FROM withdrawals WHERE reference = ?", [small.body.withdrawal.reference]))!.n).toBe(0);
    await exec(env.db, "UPDATE money_settings SET withdrawal_second_approval_cents = 100000 WHERE id = 1");
    // Paid: out of the wallet for good. Rejected: back in the wallet.
    expect(await wallet(ann.id)).toEqual([30_000, 10_000]);

    // The client sees pending until the money is sent, approved once paid.
    await exec(env.db, "UPDATE withdrawals SET status = 'approved' WHERE reference = ?", [small.body.withdrawal.reference]);
    const history = (await api().get("/api/withdrawals?page=1&per_page=200").set(bearer(ann.token))).body;
    expect(history).toMatchObject({ success: true, current_page: 1, last_page: 1, per_page: 200, total: 4, pagination: { current_page: 1, last_page: 1, per_page: 200, total: 4 } });
    const byRef = new Map((history.data as { reference: string }[]).map((r) => [r.reference, r as Record<string, unknown>]));
    expect(byRef.get(w1)).toMatchObject({ status_label: "approved", status: "approved", amount: 100 });
    expect(byRef.get(w1)).not.toHaveProperty("message");
    expect(byRef.get(big.body.withdrawal.reference)).toMatchObject({
      status_label: "rejected", amount: 70,
      message: "We could not send money to this account. Please check the account details and request again.",
      rejection_reason: "We could not send money to this account. Please check the account details and request again.",
    });
    expect(byRef.get(small.body.withdrawal.reference)).toMatchObject({ status_label: "pending", method_name: "Meezan Bank Ltd" });
    const stats = (await api().get("/api/user/stats").set(bearer(ann.token))).body;
    expect(stats.withdrawals).toEqual({ total_approved: 100, pending_count: 2 });
    expect(stats.recent_withdrawals.map((r: { reference: string }) => r.reference)).toEqual((history.data as { reference: string }[]).map((r) => r.reference));
  });

  it("refuses to change or remove an account a withdrawal in progress uses, but allows the label and default", async () => {
    expect(errorOf(await api().delete(`/api/user-payment-methods/${annBank}`).set(bearer(ann.token)), "method")).toBe(
      "This account is used by a withdrawal in progress. You can remove it once that withdrawal is finished.",
    );
    expect(errorOf(await savePayout(ann, { account_number: "9999 8888 7777" }, undefined, annBank), "method")).toBe(
      "This account is used by a withdrawal in progress. You can change it once that withdrawal is finished.",
    );
    expect((await savePayout(ann, { method_name: "Meezan", is_default: "1" }, undefined, annBank)).body.data).toMatchObject({ method_name: "Meezan", is_default: true });
    // An account nothing is using can go.
    expect((await api().delete(`/api/user-payment-methods/${annTrc}`).set(bearer(ann.token))).status).toBe(200);
    expect(errorOf(await withdraw(ann, { method: String(annTrc), amount: "50", verification_code: await issueCode(ann.email), wallet_key: ann.key }), "method")).toBe("Choose where to send the money.");
  });

  it("refuses a withdrawal to a type that was switched off", async () => {
    await exec(env.db, "UPDATE payment_methods SET is_enabled = 0 WHERE id = ?", [m.wBep]);
    expect(errorOf(await withdraw(ann, { method: String(annBep), amount: "50", verification_code: await issueCode(ann.email), wallet_key: ann.key }), "method")).toBe("Choose where to send the money.");
    expect((await api().get("/api/payment-methods").set(bearer(ann.token))).body.data.map((r: { id: string }) => r.id)).not.toContain(String(m.wBep));
    // The account itself stays listed, and its default flag can still move.
    expect((await api().get("/api/user-payment-methods").set(bearer(ann.token))).body.data.map((r: { id: number }) => r.id)).toContain(annBep);
    expect((await savePayout(ann, { payment_method_id: String(m.wBep), method_name: "USDT BEP20", is_default: "1" }, undefined, annBep)).status).toBe(200);
    await exec(env.db, "UPDATE payment_methods SET is_enabled = 1 WHERE id = ?", [m.wBep]);
  });

  it("keeps at most three withdrawals in progress", async () => {
    await fund(ben.id, 100_000);
    const method = (await api().get("/api/user-payment-methods").set(bearer(ben.token))).body.data[0].id;
    for (let i = 0; i < 3; i++) expect((await withdraw(ben, { method: String(method), amount: "60", verification_code: await issueCode(ben.email), wallet_key: ben.key })).status).toBe(201);
    const fourth = await withdraw(ben, { method: String(method), amount: "60", verification_code: await issueCode(ben.email), wallet_key: ben.key });
    expect(errorOf(fourth, "amount")).toBe("You already have 3 withdrawals in progress. Please wait for them to finish.");
    expect((await codeRow(ben.email))!.consumed_at).toBeNull();
    expect(await wallet(ben.id)).toEqual([82_000, 18_000]);
  });

  it("limits attempts per client with Retry-After", async () => {
    for (let i = 0; i < 10; i++) expect((await api().post("/api/withdrawals").set(bearer(gus.token)).send({})).status).toBe(403);
    const limited = await api().post("/api/withdrawals").set(bearer(gus.token)).send({});
    expect(limited.status).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect(limited.body).toEqual({ message: "Too many attempts. Please wait before trying again." });
    // Another client is not affected.
    expect((await api().post("/api/withdrawals").set(bearer(newbie.token)).send({})).status).toBe(403);
  });

  it("leaves the ledger consistent after every flow", async () => {
    expect(await verifyLedger(env.db)).toEqual([]);
  });
});
