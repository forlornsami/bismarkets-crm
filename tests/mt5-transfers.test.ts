import type { Logger } from "pino";
import pino from "pino";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import { lockClient } from "../src/server/clients/kyc";
import { createClientSession } from "../src/server/clients/session";
import { exec, one, rows, transaction } from "../src/server/lib/db";
import { depositMethodAccount, holdAccount, lockWallet, mt5FundingAccount, postLedger, verifyLedger, walletAccount } from "../src/server/money/ledger";
import { newReference } from "../src/server/money/references";
import { insertBalanceOp, settleBalanceOp } from "../src/server/mt5/operations";
import { checkBalanceOp, resolveMt5Once } from "../src/server/mt5/resolver";
import { startTransfer } from "../src/server/mt5/transfers";
import { FakeGateway } from "./fakes/gateway";
import { createStaff, hasDb, post, setup, signIn, stepUp, type SignedIn, type TestEnv } from "./helpers";

const MASTER = "Trade-Me-42!";
const INVESTOR = "Look-Only-7?";
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UNAVAILABLE = "Trading accounts are temporarily unavailable. Please try again in a few minutes.";
const VIEW_ONLY = "This is a view-only staff session. Changes are not allowed.";
const FROZEN = "Your account is frozen. Deposits, withdrawals and transfers are paused.";
const TO_MT5_FAILED = "The transfer did not go through. The money is back in your wallet.";
const TO_WALLET_FAILED = "The transfer did not go through.";
const NO_MARGIN = "There is not enough free margin in this account for this transfer.";
const NOT_ENOUGH = "Your wallet balance is not enough for this transfer.";
const BUSY = "Another transfer for this account is still being processed. Please wait a minute.";

interface Client {
  id: number;
  token: string;
}

/** A logger that keeps what it was told. */
function capture() {
  const lines: { level: string; obj: Record<string, unknown>; msg: string }[] = [];
  const at = (level: string) => (obj: Record<string, unknown>, msg = "") => void lines.push({ level, obj, msg });
  return { log: { info: at("info"), warn: at("warn"), error: at("error") } as unknown as Pick<Logger, "info" | "warn" | "error">, lines };
}

describe.skipIf(!hasDb)("transfers between the wallet and MT5", () => {
  let env: TestEnv;
  const fake = new FakeGateway();
  const { log } = capture();
  const api = () => request(env.app);
  const bearer = (c: Client) => ({ Authorization: `Bearer ${c.token}` });
  let classic = 0;
  let depositMethod = 0;
  let viewerId = 0;
  let seq = 0;

  let boss: SignedIn; // super_admin
  let manager: SignedIn; // finance_manager: wallet.view and wallet.reconcile
  let agent: SignedIn; // finance_agent: wallet.view only
  let dealer: SignedIn; // dealing: no wallet.view
  let desk: SignedIn; // a custom role with wallet.view and wallet.reconcile, for assigned clients only

  async function makeClient(opts: { kyc?: string; status?: string; assignedTo?: number | null } = {}): Promise<Client> {
    seq++;
    const r = await exec(
      env.db,
      "INSERT INTO clients (email, first_name, last_name, referral_code, source, kyc_status, status, assigned_staff_id) VALUES (?, 'Tara', ?, ?, 'portal', ?, ?, ?)",
      [`transfer.${seq}@client.test`, `Client${seq}`, `TR${String(seq).padStart(8, "0")}`, opts.kyc ?? "approved", opts.status ?? "active", opts.assignedTo ?? null],
    );
    const { token } = await transaction(env.db, (conn) => createClientSession(conn, env.config, r.insertId, "127.0.0.1", "vitest"));
    return { id: r.insertId, token };
  }

  /** Staff looking through the client's eyes. */
  async function viewAs(c: Client): Promise<Client> {
    const { token } = await transaction(env.db, (conn) => createClientSession(conn, env.config, c.id, "127.0.0.1", "vitest", { staffId: viewerId, reason: "Checking transfers" }));
    return { ...c, token };
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

  /** A live account opened through the API: its login and row id. */
  async function liveAccount(c: Client) {
    const res = await api().post("/api/mt5-accounts").set(bearer(c)).send({ is_demo: false, account_package_id: classic, leverage: "2000", password: MASTER, investor_password: INVESTOR });
    expect(res.status).toBe(200);
    const login = Number(res.body.account.login);
    const id = Number((await one<{ id: number }>(env.db, "SELECT id FROM mt5_accounts WHERE login = ? AND server_code = 'live'", [login]))!.id);
    return { login, id };
  }

  async function demoAccount(c: Client) {
    const res = await api().post("/api/mt5-accounts").set(bearer(c)).send({ is_demo: true, demo_amount: 1000, leverage: "2000", password: MASTER, investor_password: INVESTOR });
    expect(res.status).toBe(200);
    return { login: Number(res.body.account.login) };
  }

  /** A funded client with one live account. */
  async function funded(cents: number, opts: { assignedTo?: number | null } = {}) {
    const c = await makeClient(opts);
    await fund(c.id, cents);
    return { c, ...(await liveAccount(c)) };
  }

  const toMt5 = (c: Client, login: number | string, amount: unknown) => api().post("/api/transfer/wallet-to-mt5").set(bearer(c)).send({ mt5_account_id: String(login), amount });
  const toWallet = (c: Client, login: number | string, amount: unknown) => api().post("/api/transfer/mt5-to-wallet").set(bearer(c)).send({ mt5_account_id: String(login), amount });
  const history = (c: Client, query = "") => api().get(`/api/transfers${query}`).set(bearer(c));

  const wallet = async (clientId: number) => {
    const w = await one<{ available_cents: number; held_cents: number }>(env.db, "SELECT available_cents, held_cents FROM wallets WHERE client_id = ?", [clientId]);
    return { available: Number(w?.available_cents ?? 0), held: Number(w?.held_cents ?? 0) };
  };
  const opByRef = async (reference: string) => {
    const o = await one<Record<string, any>>(env.db, "SELECT * FROM mt5_balance_ops WHERE reference = ?", [reference]);
    const op: Record<string, any> & { id: number } = { ...o!, id: Number(o!.id) };
    return op;
  };
  const opsOf = async (clientId: number) => Number((await one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM mt5_balance_ops WHERE client_id = ? AND purpose IN ('wallet_to_mt5', 'mt5_to_wallet')", [clientId]))!.n);
  const kinds = async (opId: number) =>
    (await rows<{ kind: string }>(env.db, "SELECT kind FROM ledger_transactions WHERE source_type = 'mt5_op' AND source_id = ? ORDER BY id", [opId])).map((r) => r.kind);
  const entriesOf = (opId: number) =>
    rows<{ kind: string; account: string; amount_cents: number }>(
      env.db,
      "SELECT t.kind, e.account, e.amount_cents FROM ledger_transactions t JOIN ledger_entries e ON e.transaction_id = t.id WHERE t.source_type = 'mt5_op' AND t.source_id = ? ORDER BY e.id",
      [opId],
    );
  const lastBell = (clientId: number) => one<{ type: string; title: string; body: string }>(env.db, "SELECT type, title, body FROM client_notifications WHERE client_id = ? ORDER BY id DESC LIMIT 1", [clientId]);
  const audits = (action: string, clientId: number) => rows<Record<string, any>>(env.db, "SELECT * FROM audit_log WHERE action = ? AND entity_id = ? ORDER BY id", [action, String(clientId)]);
  const balanceCalls = (reference: string) => fake.callsTo("balance").filter((x) => x.req.comment === reference);
  const resolve = () => resolveMt5Once(env.db, fake, log);
  const due = (opId: number) => exec(env.db, "UPDATE mt5_balance_ops SET next_check_at = NULL WHERE id = ?", [opId]);
  /** Ages an operation past the ten minutes after which it may be settled as never made. */
  const age = (opId: number, minutes = 11) => exec(env.db, `UPDATE mt5_balance_ops SET created_at = created_at - INTERVAL ${minutes} MINUTE, next_check_at = NULL WHERE id = ?`, [opId]);
  const soon = (d: unknown, ms: number) => {
    const at = (d as Date).getTime() - Date.now();
    expect(at).toBeGreaterThan(ms - 5_000);
    expect(at).toBeLessThanOrEqual(ms + 1_000);
  };
  const clean = async () => expect(await verifyLedger(env.db)).toEqual([]);

  beforeAll(async () => {
    env = await setup({}, { mt5: fake });
    await exec(env.db, "INSERT INTO mt5_servers (code, label, is_enabled) VALUES ('live', 'Live', 1), ('demo', 'Demo', 1)");
    await exec(env.db, "UPDATE mt5_settings SET demo_server_code = 'demo', demo_group = 'demo\\\\usd', leverages = '2000,500' WHERE id = 1");
    classic = (
      await exec(env.db, "INSERT INTO account_packages (name, spread_label, min_deposit_cents, server_code, mt5_group) VALUES ('Classic', '1.2', 0, 'live', 'real\\\\standard')")
    ).insertId;
    depositMethod = (
      await exec(env.db, "INSERT INTO payment_methods (direction, kind, name, currency, network, bank_name, account_title, account_number, wallet_address, ask_qr) VALUES ('deposit', 'bank', 'Bank', 'USD', '', 'Bank', 'BIS Markets', '0101', '', 0)")
    ).insertId;
    viewerId = await createStaff(env.db, "viewer@crm.test", "support_agent");
    const role = (await exec(env.db, "INSERT INTO roles (slug, name) VALUES ('transfer_desk', 'Transfer desk')")).insertId;
    await exec(env.db, "INSERT INTO role_permissions (role_id, permission) VALUES (?, 'wallet.view'), (?, 'wallet.reconcile')", [role, role]);
    for (const [email, slug] of [["boss@crm.test", "super_admin"], ["manager@crm.test", "finance_manager"], ["agent@crm.test", "finance_agent"], ["dealer@crm.test", "dealing"], ["desk@crm.test", "transfer_desk"]]) {
      await createStaff(env.db, email!, slug!);
    }
    boss = await signIn(env, "boss@crm.test");
    manager = await signIn(env, "manager@crm.test");
    agent = await signIn(env, "agent@crm.test");
    dealer = await signIn(env, "dealer@crm.test");
    desk = await signIn(env, "desk@crm.test");
  }, 120_000);
  afterAll(async () => env?.db.end());
  beforeEach(async () => {
    fake.clearFaults();
    fake.down = false;
    // Whatever an earlier test left open is settled the proper way (money back), so the ledger stays sound.
    for (const o of await rows<{ id: number }>(env.db, "SELECT id FROM mt5_balance_ops WHERE status IN ('sending', 'unknown')")) {
      await settleBalanceOp(env.db, Number(o.id), { status: "failed", failure: "test", clientMessage: "test" });
    }
  });

  // ---------- Wallet to MT5 ----------

  it("moves money from the wallet into MT5, holding it until MT5 confirms, and shows it everywhere", async () => {
    const { c, login, id: accountId } = await funded(50_000);
    const res = await toMt5(c, login, "125.50");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      message: "Transfer completed.",
      data: {
        id: expect.stringMatching(/^BIS-T[0-9A-Z]{8}$/), type: 1, type_label: "Wallet To MT5", mt5_account_id: String(login), amount: 125.5, currency: "USD",
        status: "completed", created_at: expect.stringMatching(ISO), updated_at: expect.stringMatching(ISO),
      },
    });
    const ref = res.body.data.id as string;
    const op = await opByRef(ref);
    expect(op).toMatchObject({ purpose: "wallet_to_mt5", status: "completed", amount_cents: 12_550, mt5_ticket: fake.dealsOf("live", login)[0]!.ticket, failure: null, client_message: null });
    expect(balanceCalls(ref)).toEqual([
      { op: "balance", req: { server: "live", login, amountCents: 12_550, comment: ref, checkMargin: false, notBefore: (op.created_at as Date).toISOString() } },
    ]);
    expect(fake.user("live", login)!.balanceCents).toBe(12_550);
    expect(await wallet(c.id)).toEqual({ available: 37_450, held: 0 });
    // Held when asked, then paid out to the account's funding line.
    expect(await entriesOf(op.id)).toEqual([
      { kind: "transfer_hold", account: walletAccount(c.id), amount_cents: -12_550 },
      { kind: "transfer_hold", account: holdAccount(c.id), amount_cents: 12_550 },
      { kind: "transfer_out", account: holdAccount(c.id), amount_cents: -12_550 },
      { kind: "transfer_out", account: mt5FundingAccount(accountId), amount_cents: 12_550 },
    ]);

    // The account shows the new balance at once, even while MT5 cannot be read.
    fake.down = true;
    const accounts = await api().get("/api/mt5-accounts").set(bearer(c));
    expect(accounts.body.real_accounts[0]).toMatchObject({ login: String(login), balance: 125.5, mt5: { balance: 125.5, currency: "USD" } });
    fake.down = false;

    const list = await history(c);
    expect(list.body.data).toEqual([res.body.data]);
    expect(await lastBell(c.id)).toEqual({ type: "account", title: "Your transfer to MT5 is complete", body: `$125.50 from your wallet is now in MT5 account ${login}.` });
    expect((await audits("mt5.transfer.requested", c.id))[0]).toMatchObject({
      actor_type: "client", actor_id: c.id, meta_json: { opId: op.id, reference: ref, purpose: "wallet_to_mt5", accountId, login, amountCents: 12_550 },
    });

    // The login as a number and the amount as a number work too.
    const again = await api().post("/api/transfer/wallet-to-mt5").set(bearer(c)).send({ mt5_account_id: login, amount: 10 });
    expect(again.status).toBe(200);
    expect(await wallet(c.id)).toEqual({ available: 36_450, held: 0 });
    await clean();
  });

  it("refuses what it cannot do with field errors (never a 409) and writes nothing", async () => {
    const { c, login } = await funded(10_000);
    const demo = await demoAccount(c);
    const other = await funded(10_000);
    const sent = fake.callsTo("balance").length;
    const refused = async (res: request.Response, field: string, message: string) => {
      expect(res.status).toBe(422);
      expect(res.body).toEqual({ message, errors: { [field]: [message] } });
    };
    await refused(await toMt5(c, login, undefined), "amount", "The amount field is required.");
    await refused(await toMt5(c, login, "1.005"), "amount", "Use at most two decimal places.");
    await refused(await toMt5(c, login, "-5"), "amount", "Enter the amount as a number, such as 100 or 100.50.");
    await refused(await toMt5(c, login, "9.99"), "amount", "The minimum transfer is $10.00.");
    await exec(env.db, "UPDATE mt5_settings SET max_transfer_cents = 5000 WHERE id = 1");
    await refused(await toMt5(c, login, 60), "amount", "The maximum transfer is $50.00.");
    await exec(env.db, "UPDATE mt5_settings SET max_transfer_cents = 10000000 WHERE id = 1");
    await refused(await toMt5(c, login, "100.01"), "amount", NOT_ENOUGH);

    for (const someone of [other.login, "abc", 999_999_999]) {
      const res = await toMt5(c, someone, 20);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ message: "Account not found." });
    }
    await refused(await toMt5(c, demo.login, 20), "mt5_account_id", "Transfers are only available for live accounts.");
    await exec(env.db, "UPDATE mt5_accounts SET suspended_at = CURRENT_TIMESTAMP(3) WHERE login = ? AND server_code = 'live'", [login]);
    await refused(await toMt5(c, login, 20), "mt5_account_id", "This account is not available for transfers.");
    await exec(env.db, "UPDATE mt5_accounts SET suspended_at = NULL, archived_at = CURRENT_TIMESTAMP(3) WHERE login = ? AND server_code = 'live'", [login]);
    await refused(await toMt5(c, login, 20), "mt5_account_id", "Restore this account before adding money to it.");
    await exec(env.db, "UPDATE mt5_accounts SET archived_at = NULL WHERE login = ? AND server_code = 'live'", [login]);
    await exec(env.db, "UPDATE mt5_servers SET is_enabled = 0 WHERE code = 'live'");
    await refused(await toMt5(c, login, 20), "mt5", UNAVAILABLE);
    await exec(env.db, "UPDATE mt5_servers SET is_enabled = 1 WHERE code = 'live'");

    expect(await opsOf(c.id)).toBe(0);
    expect(await wallet(c.id)).toEqual({ available: 10_000, held: 0 });
    expect(fake.callsTo("balance")).toHaveLength(sent);
    await clean();
  });

  it("refuses frozen, unverified and view-only clients, and answers 'unavailable' when MT5 is off", async () => {
    const { c, login } = await funded(10_000);
    const look = await viewAs(c);
    for (const res of [await toMt5(look, login, 20), await toWallet(look, login, 20)]) expect(res).toMatchObject({ status: 403, body: { message: VIEW_ONLY } });
    // They may still look.
    expect((await history(look)).status).toBe(200);

    const pending = await makeClient({ kyc: "pending" });
    expect(await toMt5(pending, login, 20)).toMatchObject({ status: 403, body: { message: "You must complete your KYC first." } });
    await exec(env.db, "UPDATE clients SET status = 'frozen' WHERE id = ?", [c.id]);
    for (const res of [await toMt5(c, login, 20), await toWallet(c, login, 20)]) expect(res).toMatchObject({ status: 403, body: { message: FROZEN } });
    await exec(env.db, "UPDATE clients SET status = 'active' WHERE id = ?", [c.id]);

    const off = createApp({ db: env.db, config: env.config, log: pino({ level: "silent" }), fetch: (async () => new Response("", { status: 503 })) as typeof fetch, mt5: null });
    for (const path of ["/api/transfer/wallet-to-mt5", "/api/transfer/mt5-to-wallet"]) {
      const res = await request(off).post(path).set(bearer(c)).send({ mt5_account_id: String(login), amount: 20 });
      expect(res.status).toBe(422);
      expect(res.body.errors).toEqual({ mt5: [UNAVAILABLE] });
    }
    expect(await opsOf(c.id)).toBe(0);
    await clean();
  });

  it("gives the money back at once when MT5 definitely says no, or is never reached", async () => {
    const { c, login } = await funded(20_000);
    fake.failNext("balance", { kind: "refused", code: "trade_disabled" });
    const no = await toMt5(c, login, 50);
    expect(no.status).toBe(422);
    expect(no.body).toEqual({ message: TO_MT5_FAILED, errors: { amount: [TO_MT5_FAILED] } });
    const [row] = (await history(c)).body.data;
    expect(row).toMatchObject({ type: 1, amount: 50, status: "rejected", message: TO_MT5_FAILED });
    const op = await opByRef(row.id);
    expect(op).toMatchObject({ status: "failed", failure: "trade_disabled", client_message: TO_MT5_FAILED, mt5_ticket: null });
    expect(await kinds(op.id)).toEqual(["transfer_hold", "transfer_release"]);
    expect(await wallet(c.id)).toEqual({ available: 20_000, held: 0 });
    expect(await lastBell(c.id)).toEqual({ type: "account", title: "Your transfer to MT5 did not go through", body: `$50.00 for MT5 account ${login} is back in your wallet.` });

    for (const [fault, amount] of [[{ kind: "unavailable" }, 60], [{ kind: "bad_request" }, 70]] as const) {
      fake.failNext("balance", fault);
      const res = await toMt5(c, login, amount);
      expect(res.status).toBe(422);
      expect(res.body).toEqual({ message: UNAVAILABLE, errors: { mt5: [UNAVAILABLE] } });
      const failed = await opByRef((await history(c)).body.data[0].id);
      expect(failed).toMatchObject({ status: "failed", failure: fault.kind });
      expect(await kinds(failed.id)).toEqual(["transfer_hold", "transfer_release"]);
    }
    expect(await wallet(c.id)).toEqual({ available: 20_000, held: 0 });
    expect(fake.user("live", login)!.balanceCents).toBe(0);
    await clean();
  });

  it("keeps the money held when MT5's answer is lost, and completes it exactly once when the deal is found", async () => {
    const { c, login } = await funded(20_000);
    fake.failNext("balance", { kind: "unknown-after" });
    const res = await toMt5(c, login, 70);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ success: true, message: "Your transfer is being processed.", data: { status: "pending", amount: 70 } });
    const op = await opByRef(res.body.data.id);
    expect(op).toMatchObject({ status: "unknown", failure: "timeout", checks: 0 });
    soon(op.next_check_at, 60_000);
    expect(await wallet(c.id)).toEqual({ available: 13_000, held: 7_000 });
    expect(await kinds(op.id)).toEqual(["transfer_hold"]);
    await clean();
    expect((await history(c)).body.data[0]).toMatchObject({ id: op.reference, status: "pending" });
    expect((await history(c)).body.data[0]).not.toHaveProperty("message");

    await due(op.id);
    expect(await resolve()).toEqual({ ops: 1, accounts: 0 });
    expect(await opByRef(op.reference)).toMatchObject({ status: "completed", mt5_ticket: fake.dealsOf("live", login)[0]!.ticket, next_check_at: null });
    expect(await kinds(op.id)).toEqual(["transfer_hold", "transfer_out"]);
    expect(await wallet(c.id)).toEqual({ available: 13_000, held: 0 });
    expect(balanceCalls(op.reference)).toHaveLength(1);
    expect(fake.user("live", login)!.balanceCents).toBe(7_000);

    // Nothing settles it twice: another pass, another check, or a late answer to the original send.
    expect(await resolve()).toEqual({ ops: 0, accounts: 0 });
    expect(await checkBalanceOp(env.db, fake, op.id, log)).toBe("skipped");
    expect(await settleBalanceOp(env.db, op.id, { status: "completed", ticket: 1 }, ["sending"])).toMatchObject({ settled: false });
    expect(await kinds(op.id)).toEqual(["transfer_hold", "transfer_out"]);
    expect((await history(c)).body.data[0]).toMatchObject({ status: "completed" });
    await clean();
  });

  it("settles a transfer left 'sending' when the process stopped mid-call, from what MT5 has", async () => {
    const { c, login } = await funded(20_000);
    const other = await liveAccount(c);
    // Written and held, then the process stopped before MT5's answer was recorded.
    const written = (on: number, amount: number) =>
      startTransfer(
        { db: env.db, mt5: fake, log },
        { clientId: c.id, purpose: "wallet_to_mt5", account: String(on), amount, ip: "127.0.0.1", audit: { actor: { type: "client", id: c.id, label: "test" }, ip: "", userAgent: "" } },
      );
    const made = await written(login, 30);
    const lost = await written(other.login, 40);
    expect(await wallet(c.id)).toEqual({ available: 13_000, held: 7_000 });
    const madeRef = (await one<{ reference: string }>(env.db, "SELECT reference FROM mt5_balance_ops WHERE id = ?", [made.opId]))!.reference;
    fake.addDeal("live", { login, comment: madeRef, profitCents: 3_000 });
    // Not yet: a 'sending' row is only taken once untouched for two minutes.
    expect(await resolve()).toEqual({ ops: 0, accounts: 0 });
    await exec(env.db, "UPDATE mt5_balance_ops SET updated_at = updated_at - INTERVAL 3 MINUTE WHERE id IN (?, ?)", [made.opId, lost.opId]);
    expect(await resolve()).toEqual({ ops: 2, accounts: 0 });
    expect(await kinds(made.opId)).toEqual(["transfer_hold", "transfer_out"]);
    expect(await kinds(lost.opId)).toEqual(["transfer_hold"]);
    expect(fake.callsTo("balance").filter((x) => x.req.comment === madeRef)).toEqual([]);
    for (let i = 0; i < 2; i++) {
      await due(lost.opId);
      await resolve();
    }
    await age(lost.opId);
    await resolve();
    expect(await kinds(lost.opId)).toEqual(["transfer_hold", "transfer_release"]);
    expect(await wallet(c.id)).toEqual({ available: 17_000, held: 0 });
    await clean();
  });

  it("gives the money back when MT5 never made the deal, after three searches and ten minutes", async () => {
    const { c, login } = await funded(20_000);
    fake.failNext("balance", { kind: "unknown-before" });
    const res = await toMt5(c, login, 80);
    expect(res.status).toBe(202);
    const op = await opByRef(res.body.data.id);
    for (const checks of [1, 2, 3]) {
      await due(op.id);
      await resolve();
      expect(await opByRef(op.reference)).toMatchObject({ status: "unknown", failure: "not_found", checks });
      expect(await wallet(c.id)).toEqual({ available: 12_000, held: 8_000 });
    }
    await age(op.id);
    await resolve();
    expect(await opByRef(op.reference)).toMatchObject({ status: "failed", failure: "not_found", client_message: TO_MT5_FAILED, resolved_by: null });
    expect(await kinds(op.id)).toEqual(["transfer_hold", "transfer_release"]);
    expect(await wallet(c.id)).toEqual({ available: 20_000, held: 0 });
    expect(balanceCalls(op.reference)).toHaveLength(1);
    expect(fake.user("live", login)!.balanceCents).toBe(0);
    expect((await history(c)).body.data[0]).toMatchObject({ status: "rejected", message: TO_MT5_FAILED });
    expect(await lastBell(c.id)).toMatchObject({ title: "Your transfer to MT5 did not go through" });
    await clean();
  });

  // ---------- MT5 to wallet ----------

  it("credits the wallet only once MT5 has taken the money out, also from an archived account", async () => {
    const { c, login, id: accountId } = await funded(100_000);
    expect((await toMt5(c, login, 400)).status).toBe(200);
    const res = await toWallet(c, login, "150");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      message: "Transfer completed.",
      data: {
        id: expect.stringMatching(/^BIS-T/), type: 2, type_label: "MT5 To Wallet", mt5_account_id: String(login), amount: 150, currency: "USD", status: "completed",
        created_at: expect.stringMatching(ISO), updated_at: expect.stringMatching(ISO),
      },
    });
    const op = await opByRef(res.body.data.id);
    // MT5 was read first, then asked to take the money out with its margin check on.
    const calls = fake.calls.slice(-2).map((x) => x.op);
    expect(calls).toEqual(["accounts.get", "balance"]);
    expect(balanceCalls(op.reference)[0]!.req).toMatchObject({ server: "live", login, amountCents: -15_000, checkMargin: true });
    expect(await entriesOf(op.id)).toEqual([
      { kind: "transfer_in", account: mt5FundingAccount(accountId), amount_cents: -15_000 },
      { kind: "transfer_in", account: walletAccount(c.id), amount_cents: 15_000 },
    ]);
    expect(await wallet(c.id)).toEqual({ available: 75_000, held: 0 });
    expect(fake.user("live", login)!.balanceCents).toBe(25_000);
    expect(await lastBell(c.id)).toEqual({ type: "account", title: "Your transfer to your wallet is complete", body: `$150.00 from MT5 account ${login} is now in your wallet.` });
    expect((await audits("mt5.transfer.requested", c.id)).at(-1)!.meta_json).toMatchObject({ purpose: "mt5_to_wallet", amountCents: 15_000 });

    // Money may come back out of an archived account, but not go in.
    await exec(env.db, "UPDATE mt5_accounts SET archived_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [accountId]);
    expect((await toWallet(c, login, 50)).status).toBe(200);
    expect((await toMt5(c, login, 50)).body.errors).toEqual({ mt5_account_id: ["Restore this account before adding money to it."] });
    expect(await wallet(c.id)).toEqual({ available: 80_000, held: 0 });
    await clean();
  });

  it("lets a client take out only what the account can give, read from MT5 first", async () => {
    const { c, login, id: accountId } = await funded(50_000);
    expect((await toMt5(c, login, 200)).status).toBe(200);
    // $200 balance, $100 credit, $30 of margin in use and $20 of open losses: $150 may leave.
    fake.setAccount("live", login, { creditCents: 10_000, marginCents: 3_000, profitCents: -2_000 });
    const over = await toWallet(c, login, "150.01");
    expect(over.status).toBe(422);
    expect(over.body.errors).toEqual({ amount: ["You can transfer up to $150.00 from this account."] });
    // What MT5 said is kept as the account's figures.
    expect(await one(env.db, "SELECT balance_cents, credit_cents, equity_cents, margin_cents FROM mt5_accounts WHERE id = ?", [accountId])).toEqual({
      balance_cents: 20_000, credit_cents: 10_000, equity_cents: 28_000, margin_cents: 3_000,
    });
    expect((await toWallet(c, login, 150)).status).toBe(200);

    // MT5 cannot be read, or does not know the login: nothing is written.
    const before = await opsOf(c.id);
    fake.down = true;
    expect((await toWallet(c, login, 10)).body.errors).toEqual({ mt5: [UNAVAILABLE] });
    fake.down = false;
    const user = fake.users.get(`live:${login}`)!;
    fake.users.delete(`live:${login}`);
    expect((await toWallet(c, login, 10)).body.errors).toEqual({ mt5: [UNAVAILABLE] });
    fake.users.set(`live:${login}`, user);
    await exec(env.db, "UPDATE mt5_accounts SET suspended_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [accountId]);
    expect((await toWallet(c, login, 10)).body.errors).toEqual({ mt5_account_id: ["This account is not available for transfers."] });
    await exec(env.db, "UPDATE mt5_accounts SET suspended_at = NULL WHERE id = ?", [accountId]);
    const demo = await demoAccount(c);
    expect((await toWallet(c, demo.login, 10)).body.errors).toEqual({ mt5_account_id: ["Transfers are only available for live accounts."] });
    expect(await opsOf(c.id)).toBe(before);
    expect(await wallet(c.id)).toEqual({ available: 45_000, held: 0 });
    await clean();
  });

  it("refuses with the margin message when MT5 will not leave the margin uncovered, and moves nothing", async () => {
    const { c, login } = await funded(20_000);
    expect((await toMt5(c, login, 100)).status).toBe(200);
    // The margin changed between the read and the deal: MT5's own check says no.
    fake.failNext("balance", { kind: "refused", code: "no_money" });
    const res = await toWallet(c, login, 50);
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ message: NO_MARGIN, errors: { amount: [NO_MARGIN] } });
    const [row] = (await history(c)).body.data;
    expect(row).toMatchObject({ type: 2, status: "rejected", message: NO_MARGIN });
    const op = await opByRef(row.id);
    expect(op).toMatchObject({ status: "failed", failure: "no_money", client_message: NO_MARGIN });
    expect(await kinds(op.id)).toEqual([]);
    expect(await wallet(c.id)).toEqual({ available: 10_000, held: 0 });
    expect(await lastBell(c.id)).toEqual({ type: "account", title: "Your transfer from MT5 did not go through", body: `$50.00 stayed in MT5 account ${login}.` });
    await clean();
  });

  it("never credits the wallet for a lost answer until the deal is found, and never for one that was not made", async () => {
    const { c, login } = await funded(20_000);
    expect((await toMt5(c, login, 100)).status).toBe(200);
    fake.failNext("balance", { kind: "unknown-after" });
    const lost = await toWallet(c, login, 40);
    expect(lost.status).toBe(202);
    const op = await opByRef(lost.body.data.id);
    // MT5 took it out, but nothing says so yet: the wallet waits.
    expect(fake.user("live", login)!.balanceCents).toBe(6_000);
    expect(await wallet(c.id)).toEqual({ available: 10_000, held: 0 });
    expect(await kinds(op.id)).toEqual([]);
    await clean();
    await due(op.id);
    await resolve();
    expect(await opByRef(op.reference)).toMatchObject({ status: "completed" });
    expect(await kinds(op.id)).toEqual(["transfer_in"]);
    expect(await wallet(c.id)).toEqual({ available: 14_000, held: 0 });
    expect(await resolve()).toEqual({ ops: 0, accounts: 0 });

    fake.failNext("balance", { kind: "unknown-before" });
    const never = await opByRef((await toWallet(c, login, 30)).body.data.id);
    for (let i = 0; i < 3; i++) {
      await due(never.id);
      await resolve();
    }
    await age(never.id);
    await resolve();
    expect(await opByRef(never.reference)).toMatchObject({ status: "failed", failure: "not_found", client_message: TO_WALLET_FAILED });
    expect(await kinds(never.id)).toEqual([]);
    expect(await wallet(c.id)).toEqual({ available: 14_000, held: 0 });
    expect(fake.user("live", login)!.balanceCents).toBe(6_000);
    await clean();
  });

  // ---------- Concurrency and repeats ----------

  it("never lets transfers at the same moment spend the same money", async () => {
    const { c, login } = await funded(10_000);
    const second = await liveAccount(c);
    const third = await liveAccount(c);
    const results = await Promise.all([toMt5(c, login, 60), toMt5(c, second.login, 60), toMt5(c, third.login, 60)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 422, 422]);
    for (const r of results.filter((x) => x.status === 422)) expect(r.body.errors).toEqual({ amount: [NOT_ENOUGH] });
    expect(await wallet(c.id)).toEqual({ available: 4_000, held: 0 });
    expect(await opsOf(c.id)).toBe(1);
    await clean();
  });

  it("allows one transfer at a time per account", async () => {
    const { c, login } = await funded(10_000);
    const hold = fake.pause("balance");
    const first = toMt5(c, login, 20).then((r) => r);
    await hold.reached;
    const second = await toMt5(c, login, 30);
    expect(second.status).toBe(422);
    expect(second.body.errors).toEqual({ mt5_account_id: [BUSY] });
    hold.release();
    expect((await first).status).toBe(200);
    expect(await wallet(c.id)).toEqual({ available: 8_000, held: 0 });
    expect((await toMt5(c, login, 30)).status).toBe(200);
    await clean();
  });

  it("answers a double click with the first transfer instead of making a second", async () => {
    const { c, login } = await funded(10_000);
    const hold = fake.pause("balance");
    const first = toMt5(c, login, "25").then((r) => r);
    await hold.reached;
    const repeat = api().post("/api/transfer/wallet-to-mt5").set(bearer(c)).send({ mt5_account_id: login, amount: 25 }).then((r) => r);
    await new Promise((resolve) => setTimeout(resolve, 300));
    hold.release();
    const [a, b] = await Promise.all([first, repeat]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(b.body.data).toEqual(a.body.data);
    expect(await opsOf(c.id)).toBe(1);
    expect(balanceCalls(a.body.data.id)).toHaveLength(1);
    expect(await wallet(c.id)).toEqual({ available: 7_500, held: 0 });

    // Once it is done, the same request within 30 seconds still answers the first one.
    const later = await toMt5(c, login, 25);
    expect(later.body.data.id).toBe(a.body.data.id);
    expect(await opsOf(c.id)).toBe(1);
    // After that it is a new transfer.
    await exec(env.db, "UPDATE mt5_balance_ops SET created_at = created_at - INTERVAL 31 SECOND WHERE reference = ?", [a.body.data.id]);
    const fresh = await toMt5(c, login, 25);
    expect(fresh.status).toBe(200);
    expect(fresh.body.data.id).not.toBe(a.body.data.id);
    expect(await wallet(c.id)).toEqual({ available: 5_000, held: 0 });
    // A different amount is never a repeat.
    expect((await toMt5(c, login, 26)).body.data.id).not.toBe(fresh.body.data.id);
    await clean();
  });

  it("limits a client to 30 transfers an hour, counting only those written", async () => {
    const { c, login } = await funded(50_000);
    for (let i = 0; i < 3; i++) expect((await toMt5(c, login, 5)).status).toBe(422);
    for (let i = 1; i <= 30; i++) expect((await toMt5(c, login, (10 + i / 100).toFixed(2))).status).toBe(200);
    const res = await toWallet(c, login, 10);
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ message: "Too many transfers. Please wait before trying again." });
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    await clean();
  }, 60_000);

  it("limits refused attempts too, since each one from MT5 reads the account in MT5", async () => {
    const { c, login } = await funded(1_000);
    const reads = fake.callsTo("accounts.get").length;
    for (let i = 0; i < 120; i++) {
      const res = await toWallet(c, login, 999);
      expect(res.status).toBe(422);
      expect(res.body.errors).toEqual({ amount: ["You can transfer up to $0.00 from this account."] });
    }
    expect(fake.callsTo("accounts.get").length - reads).toBe(120);
    const res = await toMt5(c, login, 10);
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ message: "Too many transfers. Please wait before trying again." });
    expect(fake.callsTo("accounts.get").length - reads).toBe(120);
    expect(await opsOf(c.id)).toBe(0);
    await clean();
  }, 60_000);

  it("lists only the client's own transfers, newest first, with the reason only when rejected", async () => {
    const { c, login } = await funded(20_000);
    await demoAccount(c); // its starting balance is not a transfer
    const someoneElse = await funded(10_000);
    expect((await toMt5(someoneElse.c, someoneElse.login, 20)).status).toBe(200);

    expect((await toMt5(c, login, 50)).status).toBe(200);
    fake.failNext("balance", { kind: "refused", code: "over_limit" });
    expect((await toMt5(c, login, 20)).status).toBe(422);
    expect((await toWallet(c, login, 10)).status).toBe(200);
    fake.failNext("balance", { kind: "unknown-before" });
    expect((await toMt5(c, login, 30)).status).toBe(202);

    const res = await history(c, "?page=1&per_page=200");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, pagination: { current_page: 1, last_page: 1, per_page: 200, total: 4 }, current_page: 1, total: 4 });
    expect(res.body.data.map((r: Record<string, unknown>) => [r.type, r.amount, r.status])).toEqual([
      [1, 30, "pending"], [2, 10, "completed"], [1, 20, "rejected"], [1, 50, "completed"],
    ]);
    for (const r of res.body.data) {
      expect(Object.keys(r).sort()).toEqual(
        ["amount", "created_at", "currency", "id", "mt5_account_id", "status", "type", "type_label", "updated_at", ...(r.status === "rejected" ? ["message"] : [])].sort(),
      );
      expect(r.mt5_account_id).toBe(String(login));
    }
    expect(res.body.data[2].message).toBe(TO_MT5_FAILED);

    const page2 = await history(c, "?page=2&per_page=3");
    expect(page2.body).toMatchObject({ pagination: { current_page: 2, last_page: 2, per_page: 3, total: 4 } });
    expect(page2.body.data).toEqual([res.body.data[3]]);
    // The app may ask with no parameters; staff looking through the client's eyes see the same list.
    expect((await history(c)).body.data).toHaveLength(4);
    expect((await history(await viewAs(c))).body.data).toEqual((await history(c)).body.data);
    await clean();
  });

  it("settles a lost transfer exactly once when resolver passes and a staff check race", async () => {
    const { c, login } = await funded(20_000);
    fake.failNext("balance", { kind: "unknown-after" });
    const op = await opByRef((await toMt5(c, login, 70)).body.data.id);
    await due(op.id);
    const [, , direct, staff] = await Promise.all([resolve(), resolve(), checkBalanceOp(env.db, fake, op.id, log), post(manager, `/api/staff/mt5/operations/${op.id}/check`)]);
    expect(["completed", "skipped"]).toContain(direct);
    expect([200, 409]).toContain(staff.status);
    expect(await opByRef(op.reference)).toMatchObject({ status: "completed" });
    expect(await kinds(op.id)).toEqual(["transfer_hold", "transfer_out"]);
    expect(await wallet(c.id)).toEqual({ available: 13_000, held: 0 });
    const bells = await one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM client_notifications WHERE client_id = ? AND title = 'Your transfer to MT5 is complete'", [c.id]);
    expect(Number(bells!.n)).toBe(1);
    await clean();
  });

  // ---------- Staff ----------

  it("lists operations for staff with wallet.view, scoped to the clients they may see", async () => {
    const mine = await funded(10_000, { assignedTo: desk.staffId });
    const theirs = await funded(10_000);
    const a = await opByRef((await toMt5(mine.c, mine.login, 20)).body.data.id);
    fake.failNext("balance", { kind: "unknown-after" });
    const b = await opByRef((await toMt5(theirs.c, theirs.login, 30)).body.data.id);

    for (const s of [dealer]) expect((await s.agent.get("/api/staff/mt5/operations")).status).toBe(403);
    const all = await agent.agent.get(`/api/staff/mt5/operations?clientId=${theirs.c.id}`);
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ page: 1, pageSize: 25, total: 1, pages: 1 });
    expect(all.body.items[0]).toEqual({
      id: b.id, reference: b.reference, purpose: "wallet_to_mt5", clientId: theirs.c.id, clientName: expect.stringMatching(/^Tara Client\d+$/), clientEmail: expect.stringMatching(/@client\.test$/),
      accountId: theirs.id, login: theirs.login, serverCode: "live", isDemo: false, accountState: "active", amountCents: 3_000, signedCents: 3_000, status: "unknown",
      ticket: null, failure: "timeout", clientMessage: null, checks: 0, nextCheckAt: expect.stringMatching(ISO), resolvedBy: null, resolvedNote: null,
      createdAt: expect.stringMatching(ISO), updatedAt: expect.stringMatching(ISO), completedAt: null, canCheck: true, canFail: false,
    });
    const open = await agent.agent.get("/api/staff/mt5/operations?status=open&purpose=wallet_to_mt5");
    expect(open.body.items.map((o: { id: number }) => o.id)).toContain(b.id);
    expect(open.body.items.map((o: { id: number }) => o.id)).not.toContain(a.id);
    for (const q of [b.reference, String(theirs.login)]) {
      expect((await agent.agent.get(`/api/staff/mt5/operations?q=${q}`)).body.items.map((o: { id: number }) => o.id)).toEqual([b.id]);
    }
    expect((await agent.agent.get(`/api/staff/mt5/operations?accountId=${mine.id}`)).body.items.map((o: { id: number }) => o.id)).toEqual([a.id]);
    expect((await agent.agent.get("/api/staff/mt5/operations?status=nope")).status).toBe(400);

    // A staff member without client.view_all sees only their own clients' operations.
    const scoped = await desk.agent.get("/api/staff/mt5/operations");
    expect(scoped.body.items.map((o: { id: number }) => o.id)).toEqual([a.id]);
    expect((await desk.agent.get(`/api/staff/mt5/operations/${b.id}`)).status).toBe(404);
    expect((await post(desk, `/api/staff/mt5/operations/${b.id}/check`)).status).toBe(404);

    const detail = await agent.agent.get(`/api/staff/mt5/operations/${a.id}`);
    expect(detail.body.operation).toMatchObject({ id: a.id, status: "completed", ticket: a.mt5_ticket, canCheck: false, canFail: false });
    expect(detail.body.ledger).toEqual([
      { id: expect.any(Number), kind: "transfer_hold", createdAt: expect.stringMatching(ISO), entries: [{ account: walletAccount(mine.c.id), amountCents: -2_000 }, { account: holdAccount(mine.c.id), amountCents: 2_000 }] },
      { id: expect.any(Number), kind: "transfer_out", createdAt: expect.stringMatching(ISO), entries: [{ account: holdAccount(mine.c.id), amountCents: -2_000 }, { account: mt5FundingAccount(mine.id), amountCents: 2_000 }] },
    ]);
    expect((await agent.agent.get("/api/staff/mt5/operations/999999")).status).toBe(404);
    await clean();
  });

  it("lets staff with wallet.reconcile run the resolver's search now, audited", async () => {
    const { c, login } = await funded(20_000);
    fake.failNext("balance", { kind: "unknown-after" });
    const op = await opByRef((await toMt5(c, login, 40)).body.data.id);
    const url = `/api/staff/mt5/operations/${op.id}/check`;
    expect((await post(agent, url)).status).toBe(403);

    fake.down = true;
    const down = await post(manager, url);
    expect(down.status).toBe(200);
    expect(down.body).toMatchObject({ result: "unknown", searchError: { kind: "unavailable", code: "connection" }, operation: { status: "unknown", checks: 0 } });
    fake.down = false;

    const found = await post(manager, url);
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({ result: "completed", searchError: null, operation: { status: "completed", canCheck: false } });
    expect(found.body.ledger.map((t: { kind: string }) => t.kind)).toEqual(["transfer_hold", "transfer_out"]);
    expect((await post(manager, url)).body.error).toMatchObject({ code: "CONFLICT", message: "This operation is already settled." });
    expect((await audits("mt5.operation.checked", c.id)).map((a) => [a.actor_id, a.meta_json.result])).toEqual([[manager.staffId, "unknown"], [manager.staffId, "completed"]]);

    // An operation still in its own request's hands is not searched yet.
    const fresh = await transaction(env.db, async (conn) => {
      await lockClient(conn, c.id);
      return insertBalanceOp(conn, { purpose: "mt5_to_wallet", clientId: c.id, accountId: op.mt5_account_id, serverCode: "live", login, amountCents: 1_000, ip: "" });
    });
    const busy = await post(manager, `/api/staff/mt5/operations/${fresh.id}/check`);
    expect(busy.status).toBe(409);
    expect(busy.body.error.message).toMatch(/still being sent/);
    await settleBalanceOp(env.db, fresh.id, { status: "failed", failure: "test", clientMessage: "test" });
    await clean();
  });

  it("lets staff mark a transfer failed only after ten minutes, with a note and 2FA, when MT5 has no deal", async () => {
    const { c, login } = await funded(20_000);
    fake.failNext("balance", { kind: "unknown-before" });
    const op = await opByRef((await toMt5(c, login, 90)).body.data.id);
    const url = `/api/staff/mt5/operations/${op.id}/fail`;
    const note = { note: "Checked the MT5 manager: no deal for this reference." };

    expect((await post(agent, url, note)).status).toBe(403);
    const noStep = await post(manager, url, note);
    expect(noStep.status).toBe(403);
    expect(noStep.body.error.code).toBe("STEP_UP_REQUIRED");
    await stepUp(env, manager);
    for (const bad of [{}, { note: "too short" }, { note: "<b>no deal found here</b>" }, { ...note, status: "completed" }]) {
      expect((await post(manager, url, bad)).status).toBe(400);
    }
    const young = await post(manager, url, note);
    expect(young.status).toBe(409);
    expect(young.body.error.message).toMatch(/ten minutes/);

    await age(op.id);
    fake.down = true;
    const unreachable = await post(manager, url, note);
    expect(unreachable.status).toBe(422);
    expect(unreachable.body.error.code).toBe("MT5_UNAVAILABLE");
    fake.down = false;
    expect(await opByRef(op.reference)).toMatchObject({ status: "unknown" });

    // There is no way to mark one completed by hand.
    for (const path of ["complete", "settle", "completed"]) expect((await post(manager, `/api/staff/mt5/operations/${op.id}/${path}`, note)).status).toBe(404);

    const done = await post(manager, url, note);
    expect(done.status).toBe(200);
    expect(done.body.operation).toMatchObject({
      status: "failed", failure: "not_found", clientMessage: TO_MT5_FAILED, resolvedBy: { id: manager.staffId, name: "manager" }, resolvedNote: note.note, canFail: false,
    });
    expect(done.body.ledger.map((t: { kind: string }) => t.kind)).toEqual(["transfer_hold", "transfer_release"]);
    expect(await wallet(c.id)).toEqual({ available: 20_000, held: 0 });
    expect(balanceCalls(op.reference)).toHaveLength(1);
    expect((await audits("mt5.operation.failed", c.id))[0]).toMatchObject({
      actor_type: "staff", actor_id: manager.staffId, before_json: { status: "unknown" }, after_json: { status: "failed" },
      meta_json: { opId: op.id, reference: op.reference, purpose: "wallet_to_mt5", amountCents: 9_000, internalNote: note.note },
    });
    expect((await history(c)).body.data[0]).toMatchObject({ status: "rejected", message: TO_MT5_FAILED });
    expect((await post(manager, url, note)).status).toBe(409);
    await clean();
  });

  it("refuses to mark failed a transfer whose deal MT5 has, and settles a race between two staff once", async () => {
    const { c, login } = await funded(30_000);
    fake.failNext("balance", { kind: "unknown-after" });
    const made = await opByRef((await toMt5(c, login, 40)).body.data.id);
    await age(made.id);
    await stepUp(env, boss);
    const refused = await post(boss, `/api/staff/mt5/operations/${made.id}/fail`, { note: "The client says it never arrived." });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: "MT5_DEAL_FOUND", details: { ticket: fake.dealsOf("live", login)[0]!.ticket, amountCents: 4_000, expectedCents: 4_000 } });
    expect(await opByRef(made.reference)).toMatchObject({ status: "unknown" });
    expect(await kinds(made.id)).toEqual(["transfer_hold"]);
    // Check now settles it the only way it can be completed: from the deal.
    expect((await post(boss, `/api/staff/mt5/operations/${made.id}/check`)).body.result).toBe("completed");

    fake.failNext("balance", { kind: "unknown-before" });
    const never = await opByRef((await toMt5(c, login, 50)).body.data.id);
    await age(never.id);
    await stepUp(env, manager);
    const [x, y] = await Promise.all([
      post(boss, `/api/staff/mt5/operations/${never.id}/fail`, { note: "No deal in MT5 for this one." }),
      post(manager, `/api/staff/mt5/operations/${never.id}/fail`, { note: "No deal in MT5, giving it back." }),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect(await kinds(never.id)).toEqual(["transfer_hold", "transfer_release"]);
    expect(await wallet(c.id)).toEqual({ available: 26_000, held: 0 });
    await clean();
  });

  // Last: the ledger is append-only, so what this test posts stays wrong for the rest of the file.
  it("reports every transfer whose ledger or row contradicts its status", async () => {
    await clean();
    const { c, login, id: accountId } = await funded(20_000);
    const other = await funded(1_000);
    const insert = (purpose: "wallet_to_mt5" | "mt5_to_wallet" | "demo_topup", cents: number, owner = c.id) =>
      transaction(env.db, async (conn) => {
        await lockClient(conn, owner);
        return insertBalanceOp(conn, { purpose, clientId: owner, accountId, serverCode: "live", login, amountCents: cents, ip: "" });
      });
    const post_ = (kind: "transfer_hold" | "transfer_in" | "transfer_out", opId: number, entries: { account: string; amount: number }[], clientId = c.id) =>
      transaction(env.db, (conn) => postLedger(conn, { kind, sourceType: "mt5_op", sourceId: opId, clientId, staffId: null, memo: "test" }, entries));

    // Marked completed without the money moving, and without a ticket.
    fake.failNext("balance", { kind: "unknown-before" });
    const skipped = await opByRef((await toMt5(c, login, 10)).body.data.id);
    await exec(env.db, "UPDATE mt5_balance_ops SET status = 'completed' WHERE id = ?", [skipped.id]);
    // Held for the wrong amount.
    const wrong = await insert("wallet_to_mt5", 2_000);
    await post_("transfer_hold", wrong.id, [{ account: walletAccount(c.id), amount: -1_500 }, { account: holdAccount(c.id), amount: 1_500 }]);
    // A transfer to MT5 credited as if it came from MT5.
    const crossed = await insert("wallet_to_mt5", 500);
    await post_("transfer_hold", crossed.id, [{ account: walletAccount(c.id), amount: -500 }, { account: holdAccount(c.id), amount: 500 }]);
    await post_("transfer_in", crossed.id, [{ account: mt5FundingAccount(accountId), amount: -500 }, { account: walletAccount(c.id), amount: 500 }]);
    // Demo money in the ledger.
    const demo = await insert("demo_topup", 700);
    await post_("transfer_in", demo.id, [{ account: mt5FundingAccount(accountId), amount: -700 }, { account: walletAccount(c.id), amount: 700 }]);
    // An open transfer from MT5 that already credited the wallet, and an operation naming someone else's account.
    const early = await insert("mt5_to_wallet", 300);
    await post_("transfer_in", early.id, [{ account: mt5FundingAccount(accountId), amount: -300 }, { account: walletAccount(c.id), amount: 300 }]);
    const stranger = await insert("mt5_to_wallet", 400, other.c.id);

    const problems = await verifyLedger(env.db);
    const ref = async (id: number) => (await one<{ reference: string }>(env.db, "SELECT reference FROM mt5_balance_ops WHERE id = ?", [id]))!.reference;
    expect(problems).toEqual([
      `MT5 operation ${skipped.reference} (wallet_to_mt5) is completed, but the ledger has 1 hold, 0 return to the wallet, 0 payment to MT5, 0 credit from MT5, not 1 hold, 0 return to the wallet, 1 payment to MT5, 0 credit from MT5.`,
      `MT5 operation ${skipped.reference} is completed but has no MT5 ticket.`,
      `MT5 operation ${await ref(crossed.id)} (wallet_to_mt5) is sending, but the ledger has 1 hold, 0 return to the wallet, 0 payment to MT5, 1 credit from MT5, not 1 hold, 0 return to the wallet, 0 payment to MT5, 0 credit from MT5.`,
      `MT5 operation ${await ref(demo.id)} (demo_topup) is sending, but the ledger has 0 hold, 0 return to the wallet, 0 payment to MT5, 1 credit from MT5, not 0 hold, 0 return to the wallet, 0 payment to MT5, 0 credit from MT5.`,
      `MT5 operation ${await ref(early.id)} (mt5_to_wallet) is sending, but the ledger has 0 hold, 0 return to the wallet, 0 payment to MT5, 1 credit from MT5, not 0 hold, 0 return to the wallet, 0 payment to MT5, 0 credit from MT5.`,
      `MT5 operation ${await ref(stranger.id)} is for client ${other.c.id}, login live:${login}, but its account is client ${c.id}'s live:${login}.`,
      expect.stringMatching(new RegExp(`^Ledger transaction \\d+ \\(transfer_hold\\) for ${await ref(wrong.id)} moves client:${c.id}:hold 1500, client:${c.id}:wallet -1500, not client:${c.id}:hold 2000, client:${c.id}:wallet -2000\\.$`)),
      expect.stringMatching(new RegExp(`^Ledger transaction \\d+ \\(transfer_in\\) is not a kind of transaction an MT5 wallet_to_mt5 operation makes\\.$`)),
      expect.stringMatching(new RegExp(`^Ledger transaction \\d+ \\(transfer_in\\) is not a kind of transaction an MT5 demo_topup operation makes\\.$`)),
    ]);
  });
});
