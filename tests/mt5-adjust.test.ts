import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createClientSession } from "../src/server/clients/session";
import { exec, one, rows, transaction } from "../src/server/lib/db";
import { migrationsDir, splitStatements } from "../src/server/migrate";
import { MT5_ADJUSTMENTS_ACCOUNT, mt5FundingAccount, verifyLedger } from "../src/server/money/ledger";
import { settleBalanceOp } from "../src/server/mt5/operations";
import { resolveMt5Once } from "../src/server/mt5/resolver";
import { FakeGateway } from "./fakes/gateway";
import { codeFor, createStaff, forgetLastStep, hasDb, ORIGIN, patch, post, setup, signIn, stepUp, type SignedIn, type TestEnv } from "./helpers";

// Staff balance and credit changes to a client's live MT5 account: asked for
// by one person, approved by another (or run at once under the second-approval
// amount), sent to MT5 once, posted to the ledger once for balance and never
// for credit, and audited from request to outcome.

const MASTER = "Trade-Me-42!";
const INVESTOR = "Look-Only-7?";
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const REF = /^BIS-S[0-9A-Z]{8}$/;
const NOTE = "Compensation for the platform outage on 3 May";
const SAME_PERSON = "You asked for this change, so another person must approve it.";
const NOT_AWAITING = "This change is no longer waiting for approval.";

interface Client {
  id: number;
  token: string;
}

function quiet() {
  const at = () => () => undefined;
  return { info: at(), warn: at(), error: at() } as unknown as Pick<Logger, "info" | "warn" | "error">;
}

describe.skipIf(!hasDb)("staff MT5 balance and credit changes", () => {
  let env: TestEnv;
  const fake = new FakeGateway();
  const log = quiet();
  const api = () => request(env.app);
  const bearer = (c: Client) => ({ Authorization: `Bearer ${c.token}` });
  let classic = 0;
  let seq = 0;
  let maxTransfer = 0;

  let boss: SignedIn; // super_admin: everything, the MT5 settings included
  let ann: SignedIn; // a custom role with mt5.balance.adjust and wallet.view, for every client: asks for most changes here
  let ben: SignedIn; // the same role: the second person
  let cal: SignedIn; // the same role, never confirms with 2FA
  let fin: SignedIn; // a custom role with wallet.view and wallet.reconcile, no mt5.balance.adjust: may mark one failed
  let desk: SignedIn; // a custom role with mt5.balance.adjust and wallet.view, for assigned clients only
  let adm: SignedIn; // admin: manages staff accounts, so no mt5.balance.adjust
  let changesRole = 0;

  async function makeClient(opts: { assignedTo?: number | null } = {}): Promise<Client> {
    seq++;
    const r = await exec(
      env.db,
      "INSERT INTO clients (email, first_name, last_name, referral_code, source, kyc_status, status, assigned_staff_id) VALUES (?, 'Ada', ?, ?, 'portal', 'approved', 'active', ?)",
      [`adjust.${seq}@client.test`, `Client${seq}`, `AJ${String(seq).padStart(8, "0")}`, opts.assignedTo ?? null],
    );
    const { token } = await transaction(env.db, (conn) => createClientSession(conn, env.config, r.insertId, "127.0.0.1", "vitest"));
    return { id: r.insertId, token };
  }

  /** A live account opened through the API for this client: its login and row id. */
  async function liveFor(c: Client) {
    const res = await api().post("/api/mt5-accounts").set(bearer(c)).send({ is_demo: false, account_package_id: classic, leverage: "2000", password: MASTER, investor_password: INVESTOR });
    expect(res.status).toBe(200);
    const login = Number(res.body.account.login);
    const id = Number((await one<{ id: number }>(env.db, "SELECT id FROM mt5_accounts WHERE login = ? AND server_code = 'live'", [login]))!.id);
    return { login, id };
  }

  /** A client with one live account opened through the API: its login and row id. */
  async function live(opts: { assignedTo?: number | null } = {}) {
    const c = await makeClient(opts);
    return { c, ...(await liveFor(c)) };
  }

  const ask = (s: SignedIn, accountId: number, kind: string, amountCents: unknown, extra: Record<string, unknown> = {}) =>
    post(s, `/api/staff/mt5/accounts/${accountId}/adjustments`, { kind, amountCents, reasonCode: "compensation", note: NOTE, ...extra });
  const approve = (s: SignedIn, opId: number, body: Record<string, unknown> = {}) => post(s, `/api/staff/mt5/operations/${opId}/approve`, body);
  const reject = (s: SignedIn, opId: number, note = "Not agreed with the dealing desk") => post(s, `/api/staff/mt5/operations/${opId}/reject`, { note });
  /** The client's own transfer from the account to their wallet, in dollars. */
  const toWallet = (c: Client, login: number, amount: number) => api().post("/api/transfer/mt5-to-wallet").set(bearer(c)).send({ mt5_account_id: String(login), amount });
  const permissionsOf = async (slug: string) =>
    (await rows<{ permission: string }>(env.db, "SELECT rp.permission FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.slug = ?", [slug])).map((p) => p.permission);
  const aMoment = () => new Promise((resolve) => setTimeout(resolve, 300));
  /** Waits until a transaction holds the lock on this row. */
  async function lockedElsewhere(table: "clients", id: number) {
    for (const until = Date.now() + 5_000; Date.now() < until; await new Promise((resolve) => setTimeout(resolve, 20))) {
      try {
        await env.db.query(`SELECT id FROM ${table} WHERE id = ? FOR UPDATE NOWAIT`, [id]);
      } catch (error) {
        if ((error as { errno?: number }).errno === 3572) return; // ER_LOCK_NOWAIT
        throw error;
      }
    }
    throw new Error(`Nothing locked ${table} ${id}`);
  }

  const opRow = async (id: number): Promise<Record<string, any>> => {
    const o = await one<Record<string, any>>(env.db, "SELECT * FROM mt5_balance_ops WHERE id = ?", [id]);
    return { ...o!, id: Number(o!.id), requested_by: o!.requested_by === null ? null : Number(o!.requested_by), approved_by: o!.approved_by === null ? null : Number(o!.approved_by) };
  };
  const opsOn = async (accountId: number) => Number((await one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM mt5_balance_ops WHERE mt5_account_id = ? AND purpose LIKE 'staff%'", [accountId]))!.n);
  const entriesOf = (opId: number) =>
    rows<{ kind: string; account: string; amount_cents: number }>(
      env.db,
      "SELECT t.kind, e.account, e.amount_cents FROM ledger_transactions t JOIN ledger_entries e ON e.transaction_id = t.id WHERE t.source_type = 'mt5_op' AND t.source_id = ? ORDER BY e.id",
      [opId],
    ).then((list) => list.map((e) => ({ ...e, amount_cents: Number(e.amount_cents) })));
  const bells = (clientId: number) => rows<{ type: string; title: string; body: string }>(env.db, "SELECT type, title, body FROM client_notifications WHERE client_id = ? ORDER BY id", [clientId]);
  const audits = (action: string, clientId: number) => rows<Record<string, any>>(env.db, "SELECT * FROM audit_log WHERE action = ? AND entity_id = ? ORDER BY id", [action, String(clientId)]);
  const actions = async (clientId: number) =>
    (await rows<{ action: string }>(env.db, "SELECT action FROM audit_log WHERE entity_type = 'client' AND entity_id = ? AND action LIKE 'mt5.adjustment.%' ORDER BY id", [String(clientId)])).map((a) => a.action);
  const balanceCalls = (reference: string) => fake.callsTo("balance").filter((x) => x.req.comment === reference);
  const resolve = () => resolveMt5Once(env.db, fake, log);
  const due = (opId: number) => exec(env.db, "UPDATE mt5_balance_ops SET next_check_at = NULL WHERE id = ?", [opId]);
  const clean = async () => expect(await verifyLedger(env.db)).toEqual([]);

  /** A second sign-in of the same staff member, in another browser. */
  async function secondSession(s: SignedIn, email: string): Promise<SignedIn> {
    const agent = request.agent(env.app);
    const login = await agent.post("/api/staff/auth/login").set("Origin", ORIGIN).send({ email, password: "Correct-Horse-Battery-9" });
    expect(login.body.step).toBe("totp");
    await forgetLastStep(env.db, s.staffId);
    const verify = await agent.post("/api/staff/auth/verify").set("Origin", ORIGIN).send({ challenge: login.body.challenge, code: codeFor(s.secret) });
    expect(verify.status).toBe(200);
    const again = { agent, csrf: verify.body.csrfToken as string, secret: s.secret, staffId: s.staffId };
    await stepUp(env, again);
    return again;
  }

  beforeAll(async () => {
    env = await setup({}, { mt5: fake });
    await exec(env.db, "INSERT INTO mt5_servers (code, label, is_enabled) VALUES ('live', 'Live', 1), ('demo', 'Demo', 1)");
    await exec(env.db, "UPDATE mt5_settings SET demo_server_code = 'demo', demo_group = 'demo\\\\usd', leverages = '2000,500' WHERE id = 1");
    maxTransfer = Number((await one<{ m: number }>(env.db, "SELECT max_transfer_cents AS m FROM mt5_settings WHERE id = 1"))!.m);
    classic = (
      await exec(env.db, "INSERT INTO account_packages (name, spread_label, min_deposit_cents, server_code, mt5_group) VALUES ('Classic', '1.2', 0, 'live', 'real\\\\standard')")
    ).insertId;
    const role = (await exec(env.db, "INSERT INTO roles (slug, name) VALUES ('adjust_desk', 'Adjustments desk')")).insertId;
    await exec(env.db, "INSERT INTO role_permissions (role_id, permission) VALUES (?, 'wallet.view'), (?, 'mt5.balance.adjust')", [role, role]);
    changesRole = (await exec(env.db, "INSERT INTO roles (slug, name) VALUES ('mt5_changes', 'MT5 balance changes')")).insertId;
    await exec(
      env.db,
      "INSERT INTO role_permissions (role_id, permission) VALUES (?, 'client.view'), (?, 'client.view_all'), (?, 'mt5.view'), (?, 'wallet.view'), (?, 'mt5.balance.adjust')",
      Array(5).fill(changesRole),
    );
    // Finance Managers hold mt5.balance.adjust, so someone who may only check and mark failed has a role of their own.
    const reconcile = (await exec(env.db, "INSERT INTO roles (slug, name) VALUES ('mt5_reconcile', 'MT5 reconciliation')")).insertId;
    await exec(
      env.db,
      "INSERT INTO role_permissions (role_id, permission) VALUES (?, 'client.view'), (?, 'client.view_all'), (?, 'mt5.view'), (?, 'wallet.view'), (?, 'wallet.reconcile')",
      Array(5).fill(reconcile),
    );
    for (const [email, slug] of [
      ["boss@crm.test", "super_admin"], ["ann@crm.test", "mt5_changes"], ["ben@crm.test", "mt5_changes"], ["cal@crm.test", "mt5_changes"], ["fin@crm.test", "mt5_reconcile"],
      ["desk@crm.test", "adjust_desk"], ["adm@crm.test", "admin"],
    ]) {
      await createStaff(env.db, email!, slug!);
    }
    boss = await signIn(env, "boss@crm.test");
    ann = await signIn(env, "ann@crm.test");
    ben = await signIn(env, "ben@crm.test");
    cal = await signIn(env, "cal@crm.test");
    fin = await signIn(env, "fin@crm.test");
    desk = await signIn(env, "desk@crm.test");
    adm = await signIn(env, "adm@crm.test");
  }, 120_000);
  afterAll(async () => env?.db.end());
  beforeEach(async () => {
    fake.clearFaults();
    fake.down = false;
    await exec(env.db, "UPDATE mt5_settings SET adjust_second_approval_cents = 0, max_transfer_cents = ? WHERE id = 1", [maxTransfer]);
    // Whatever an earlier test left open is settled as not made, so each test starts with quiet accounts.
    for (const o of await rows<{ id: number }>(env.db, "SELECT id FROM mt5_balance_ops WHERE status IN ('sending', 'unknown')")) {
      await settleBalanceOp(env.db, Number(o.id), { status: "failed", failure: "test", clientMessage: "test" });
    }
    for (const s of [boss, ann, ben, fin, desk, adm]) await stepUp(env, s);
  });

  it("waits for a second person, then sends the balance change to MT5 once, posts it to the ledger once and tells the client", async () => {
    const { c, login, id: accountId } = await live();
    const asked = await ask(ann, accountId, "balance_in", 12_345);
    expect(asked.status).toBe(201);
    const opId = asked.body.operation.id as number;
    expect(asked.body).toEqual({
      operation: {
        id: opId, reference: expect.stringMatching(REF), purpose: "staff_balance_in", clientId: c.id, clientName: expect.stringMatching(/^Ada Client\d+$/), clientEmail: expect.stringMatching(/@client\.test$/),
        accountId, login, serverCode: "live", isDemo: false, accountState: "active", amountCents: 12_345, signedCents: 12_345, status: "awaiting_approval",
        ticket: null, failure: null, clientMessage: null, checks: 0, nextCheckAt: null, resolvedBy: null, resolvedNote: null,
        createdAt: expect.stringMatching(ISO), updatedAt: expect.stringMatching(ISO), completedAt: null, canCheck: false, canFail: false,
        change: {
          deal: "balance", dealAction: 2, reasonCode: "compensation", note: NOTE, requestedBy: { id: ann.staffId, name: "ann" }, approvedBy: null, approvedAt: null,
          decidedNote: null, ranAtOnce: false, canApprove: false, canReject: true,
        },
      },
      ledger: [],
    });
    const reference = asked.body.operation.reference as string;
    // Nothing reaches MT5, the ledger or the client while it waits.
    expect(balanceCalls(reference)).toEqual([]);
    expect(fake.user("live", login)!.balanceCents).toBe(0);
    expect(await bells(c.id)).toEqual([]);
    expect((await ben.agent.get(`/api/staff/mt5/operations/${opId}`)).body.operation.change).toMatchObject({ canApprove: true, canReject: true });

    // Never by the person who asked, from any of their sessions.
    const own = await approve(ann, opId);
    expect(own.status).toBe(403);
    expect(own.body.error).toMatchObject({ code: "SAME_PERSON", message: SAME_PERSON });
    const annAgain = await secondSession(ann, "ann@crm.test");
    expect((await approve(annAgain, opId)).body.error).toMatchObject({ code: "SAME_PERSON" });
    // And the table itself refuses it.
    await expect(exec(env.db, "UPDATE mt5_balance_ops SET approved_by = requested_by WHERE id = ?", [opId])).rejects.toThrow(/ck_mt5_op/);
    expect((await opRow(opId)).status).toBe("awaiting_approval");

    const done = await approve(ben, opId, { note: "Checked the outage log" });
    expect(done.status).toBe(200);
    const op = await opRow(opId);
    expect(op).toMatchObject({ status: "completed", requested_by: ann.staffId, approved_by: ben.staffId, decided_note: "Checked the outage log", mt5_ticket: fake.dealsOf("live", login)[0]!.ticket });
    expect(done.body.operation).toMatchObject({
      status: "completed", ticket: op.mt5_ticket, completedAt: expect.stringMatching(ISO),
      change: { requestedBy: { id: ann.staffId, name: "ann" }, approvedBy: { id: ben.staffId, name: "ben" }, approvedAt: expect.stringMatching(ISO), decidedNote: "Checked the outage log", canApprove: false, canReject: false },
    });
    // Sent once, as a plain balance deal (no type), not before it was approved.
    expect(balanceCalls(reference)).toEqual([
      { op: "balance", req: { server: "live", login, amountCents: 12_345, comment: reference, checkMargin: false, notBefore: (op.approved_at as Date).toISOString() } },
    ]);
    expect(fake.dealsOf("live", login)).toMatchObject([{ action: 2, profitCents: 12_345, comment: reference }]);
    expect(fake.user("live", login)!.balanceCents).toBe(12_345);
    expect(await entriesOf(opId)).toEqual([
      { kind: "mt5_adjust_in", account: MT5_ADJUSTMENTS_ACCOUNT, amount_cents: -12_345 },
      { kind: "mt5_adjust_in", account: mt5FundingAccount(accountId), amount_cents: 12_345 },
    ]);
    expect(done.body.ledger).toEqual([
      { id: expect.any(Number), kind: "mt5_adjust_in", createdAt: expect.stringMatching(ISO), entries: [{ account: MT5_ADJUSTMENTS_ACCOUNT, amountCents: -12_345 }, { account: mt5FundingAccount(accountId), amountCents: 12_345 }] },
    ]);
    expect(await bells(c.id)).toEqual([{ type: "account", title: "Your MT5 account was credited", body: `Your MT5 account ${login} was credited $123.45.` }]);

    // Every step audited: who asked and why, who approved, and what MT5 did.
    expect(await actions(c.id)).toEqual(["mt5.adjustment.requested", "mt5.adjustment.approved", "mt5.adjustment.completed"]);
    const meta = { opId, reference, purpose: "staff_balance_in", accountId, login, amountCents: 12_345, reasonCode: "compensation", requestedBy: ann.staffId };
    expect((await audits("mt5.adjustment.requested", c.id))[0]).toMatchObject({
      actor_type: "staff", actor_id: ann.staffId, after_json: { status: "awaiting_approval" }, meta_json: { ...meta, approvedBy: null, internalNote: NOTE, secondApproval: true },
    });
    expect((await audits("mt5.adjustment.approved", c.id))[0]).toMatchObject({
      actor_type: "staff", actor_id: ben.staffId, before_json: { status: "awaiting_approval" }, after_json: { status: "sending" }, meta_json: { ...meta, approvedBy: ben.staffId, internalNote: "Checked the outage log" },
    });
    expect((await audits("mt5.adjustment.completed", c.id))[0]).toMatchObject({ actor_type: "system", actor_id: null, meta_json: { ...meta, approvedBy: ben.staffId, ticket: op.mt5_ticket } });

    // Settled: nobody approves or rejects it again, and the account page reads the new balance.
    expect((await approve(boss, opId)).body.error).toMatchObject({ code: "CONFLICT", message: NOT_AWAITING });
    expect((await reject(boss, opId)).body.error).toMatchObject({ code: "CONFLICT", message: NOT_AWAITING });
    expect(balanceCalls(reference)).toHaveLength(1);

    // The client sees the money and the bell, never the change among their transfers.
    const transfers = await api().get("/api/transfers").set(bearer(c));
    expect(transfers.status).toBe(200);
    expect(transfers.body.data).toEqual([]);
    await clean();
  });

  it("takes credit in and out as MT5 credit deals, with no ledger entries, within the credit the account has now", async () => {
    const { c, login, id: accountId } = await live();
    const given = await ask(ann, accountId, "credit_in", 5_000, { reasonCode: "bonus", note: "Welcome bonus, campaign October" });
    expect(given.body.operation).toMatchObject({ purpose: "staff_credit_in", signedCents: 5_000, change: { deal: "credit", dealAction: 3, reasonCode: "bonus" } });
    const inId = given.body.operation.id as number;
    expect((await approve(ben, inId)).status).toBe(200);
    expect(fake.user("live", login)).toMatchObject({ balanceCents: 0, creditCents: 5_000 });
    const inRef = given.body.operation.reference as string;
    expect(balanceCalls(inRef)).toEqual([
      { op: "balance", req: { server: "live", login, amountCents: 5_000, comment: inRef, checkMargin: false, notBefore: expect.stringMatching(ISO), type: "credit" } },
    ]);
    expect(fake.dealsOf("live", login)).toMatchObject([{ action: 3, profitCents: 5_000 }]);
    expect(await entriesOf(inId)).toEqual([]);

    // More credit out than the account has is refused at once, on MT5's figures, and nothing is written.
    const before = await opsOn(accountId);
    const tooMuch = await ask(ann, accountId, "credit_out", 5_001);
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.error).toMatchObject({ code: "OVER_CREDIT", message: "This account has USD 50.00 of credit now.", details: { creditCents: 5_000 } });
    expect(await opsOn(accountId)).toBe(before);

    // Checked again when approved: the credit fell meanwhile.
    const out = await ask(ann, accountId, "credit_out", 3_000);
    expect(out.status).toBe(201);
    const outId = out.body.operation.id as number;
    expect(out.body.operation).toMatchObject({ signedCents: -3_000, change: { deal: "credit", dealAction: 3 } });
    fake.setAccount("live", login, { creditCents: 1_000 });
    const stale = await approve(ben, outId);
    expect(stale.status).toBe(422);
    expect(stale.body.error).toMatchObject({ code: "OVER_CREDIT", details: { creditCents: 1_000 } });
    expect((await opRow(outId)).status).toBe("awaiting_approval");
    expect(balanceCalls(out.body.operation.reference)).toEqual([]);
    fake.setAccount("live", login, { creditCents: 5_000 });
    const taken = await approve(ben, outId);
    expect(taken.status).toBe(200);
    expect(balanceCalls(out.body.operation.reference)).toEqual([
      { op: "balance", req: { server: "live", login, amountCents: -3_000, comment: out.body.operation.reference, checkMargin: true, notBefore: expect.stringMatching(ISO), type: "credit" } },
    ]);
    expect(fake.user("live", login)).toMatchObject({ balanceCents: 0, creditCents: 2_000 });
    expect(await entriesOf(outId)).toEqual([]);
    expect(await bells(c.id)).toEqual([
      { type: "account", title: "Credit added to your MT5 account", body: `$50.00 of credit was added to your MT5 account ${login}.` },
      { type: "account", title: "Credit removed from your MT5 account", body: `$30.00 of credit was removed from your MT5 account ${login}.` },
    ]);
    expect(await actions(c.id)).toEqual([
      "mt5.adjustment.requested", "mt5.adjustment.approved", "mt5.adjustment.completed",
      "mt5.adjustment.requested", "mt5.adjustment.approved", "mt5.adjustment.completed",
    ]);
    await clean();
  });

  it("takes out of the balance at most what the account could withdraw now, and within the MT5 transfer limit", async () => {
    const { c, login, id: accountId } = await live();
    // Balance 100, credit 20, margin 30: equity 120, so 120 − 20 − 30 = 70 can come out.
    fake.setAccount("live", login, { balanceCents: 10_000, creditCents: 2_000, marginCents: 3_000 });
    const over = await ask(ann, accountId, "balance_out", 7_001, { reasonCode: "chargeback", note: "Card chargeback from the acquirer" });
    expect(over.status).toBe(422);
    expect(over.body.error).toMatchObject({ code: "OVER_WITHDRAWABLE", details: { withdrawableCents: 7_000 } });
    expect(over.body.error.message).toMatch(/^At most USD 70\.00 can be taken from this account now/);

    await exec(env.db, "UPDATE mt5_settings SET max_transfer_cents = 50000 WHERE id = 1");
    const big = await ask(ann, accountId, "balance_in", 50_001);
    expect(big.status).toBe(422);
    expect(big.body.error).toMatchObject({ code: "OVER_LIMIT" });
    expect(await opsOn(accountId)).toBe(0);

    const out = await ask(ann, accountId, "balance_out", 7_000, { reasonCode: "chargeback", note: "Card chargeback from the acquirer" });
    expect(out.status).toBe(201);
    const opId = out.body.operation.id as number;
    // A trade opened meanwhile uses more margin: checked again on MT5's figures when approved.
    fake.setAccount("live", login, { marginCents: 5_000 });
    const stale = await approve(ben, opId);
    expect(stale.status).toBe(422);
    expect(stale.body.error).toMatchObject({ code: "OVER_WITHDRAWABLE", details: { withdrawableCents: 5_000 } });
    // The transfer limit is checked again too.
    fake.setAccount("live", login, { marginCents: 3_000 });
    await exec(env.db, "UPDATE mt5_settings SET max_transfer_cents = 6999 WHERE id = 1");
    expect((await approve(ben, opId)).body.error).toMatchObject({ code: "OVER_LIMIT" });
    await exec(env.db, "UPDATE mt5_settings SET max_transfer_cents = 50000 WHERE id = 1");
    expect(balanceCalls(out.body.operation.reference)).toEqual([]);

    const done = await approve(ben, opId);
    expect(done.status).toBe(200);
    expect(done.body.operation).toMatchObject({ status: "completed", signedCents: -7_000 });
    expect(fake.user("live", login)!.balanceCents).toBe(3_000);
    expect(balanceCalls(out.body.operation.reference)[0]!.req).toMatchObject({ amountCents: -7_000, checkMargin: true });
    expect(await entriesOf(opId)).toEqual([
      { kind: "mt5_adjust_out", account: MT5_ADJUSTMENTS_ACCOUNT, amount_cents: 7_000 },
      { kind: "mt5_adjust_out", account: mt5FundingAccount(accountId), amount_cents: -7_000 },
    ]);
    expect(await bells(c.id)).toEqual([{ type: "account", title: "Your MT5 account was debited", body: `Your MT5 account ${login} was debited $70.00.` }]);
    await clean();
  });

  it("records MT5's refusal at approval as a failed change, with no ledger entry and no word to the client", async () => {
    const { c, login, id: accountId } = await live();
    fake.setAccount("live", login, { balanceCents: 5_000 });
    const out = await ask(ann, accountId, "balance_out", 4_000, { reasonCode: "correction", note: "Duplicate deposit credited twice" });
    const opId = out.body.operation.id as number;
    fake.failNext("balance", { kind: "refused", code: "no_money" });
    const refused = await approve(ben, opId);
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({ code: "MT5_REFUSED", details: { operationId: opId, failure: "no_money" } });
    expect(refused.body.error.message).toMatch(/does not have the money, credit or free margin/);
    expect(await opRow(opId)).toMatchObject({ status: "failed", failure: "no_money", approved_by: ben.staffId, mt5_ticket: null });
    expect(await entriesOf(opId)).toEqual([]);
    expect(await bells(c.id)).toEqual([]);
    expect(fake.user("live", login)!.balanceCents).toBe(5_000);
    expect((await audits("mt5.adjustment.failed", c.id))[0]).toMatchObject({ actor_type: "system", meta_json: { opId, failure: "no_money", approvedBy: ben.staffId } });
    // A failed change is never approved again: it is asked for anew.
    expect((await approve(boss, opId)).body.error).toMatchObject({ message: NOT_AWAITING });
    await clean();
  });

  it("rejects or cancels a waiting change without ever reaching MT5", async () => {
    const { c, id: accountId } = await live();
    const first = await ask(ann, accountId, "balance_in", 1_000);
    const firstId = first.body.operation.id as number;
    expect((await reject(fin, firstId)).status).toBe(403);
    const short = await reject(ben, firstId, "no");
    expect(short.status).toBe(400);
    expect(short.body.error.details).toEqual([{ field: "note", message: "Write a note saying what you checked (at least 10 characters)" }]);
    expect((await reject(ben, firstId, "See <script> here please")).status).toBe(400);
    // Saying no needs a fresh 2FA code, as saying yes does.
    const noStep = await reject(cal, firstId, "The outage did not affect this client");
    expect(noStep.status).toBe(403);
    expect(noStep.body.error.code).toBe("STEP_UP_REQUIRED");
    expect((await opRow(firstId)).status).toBe("awaiting_approval");
    const rejected = await reject(ben, firstId, "The outage did not affect this client");
    expect(rejected.status).toBe(200);
    expect(rejected.body.operation).toMatchObject({
      status: "cancelled", resolvedBy: { id: ben.staffId, name: "ben" }, completedAt: expect.stringMatching(ISO),
      change: { decidedNote: "The outage did not affect this client", approvedBy: null, canApprove: false, canReject: false },
    });
    expect((await audits("mt5.adjustment.rejected", c.id))[0]).toMatchObject({
      actor_type: "staff", actor_id: ben.staffId, after_json: { status: "cancelled" }, meta_json: { opId: firstId, internalNote: "The outage did not affect this client" },
    });

    // The requester may take back their own.
    const second = await ask(ann, accountId, "credit_in", 2_000);
    const secondId = second.body.operation.id as number;
    expect((await reject(ann, secondId, "Asked for the wrong account")).status).toBe(200);
    expect((await audits("mt5.adjustment.cancelled", c.id))[0]).toMatchObject({ actor_type: "staff", actor_id: ann.staffId, meta_json: { opId: secondId } });

    for (const id of [firstId, secondId]) {
      expect((await approve(ben, id)).body.error).toMatchObject({ code: "CONFLICT", message: NOT_AWAITING });
      expect((await reject(ben, id)).body.error).toMatchObject({ code: "CONFLICT", message: NOT_AWAITING });
    }
    expect(balanceCalls(first.body.operation.reference)).toEqual([]);
    expect(balanceCalls(second.body.operation.reference)).toEqual([]);
    expect(await bells(c.id)).toEqual([]);
    expect(await actions(c.id)).toEqual(["mt5.adjustment.requested", "mt5.adjustment.rejected", "mt5.adjustment.requested", "mt5.adjustment.cancelled"]);
    await clean();
  });

  it("needs mt5.balance.adjust and 2FA, keeps to the staff member's clients, and checks what is asked for", async () => {
    const { c, id: accountId } = await live();
    expect((await ask(fin, accountId, "balance_in", 1_000)).status).toBe(403);
    const noStep = await ask(cal, accountId, "balance_in", 1_000);
    expect(noStep.status).toBe(403);
    expect(noStep.body.error.code).toBe("STEP_UP_REQUIRED");
    const waiting = await ask(ann, accountId, "balance_in", 1_000);
    expect((await approve(fin, waiting.body.operation.id)).status).toBe(403);
    expect((await approve(cal, waiting.body.operation.id)).body.error.code).toBe("STEP_UP_REQUIRED");

    // A desk without client.view_all sees only its own clients' accounts and changes.
    expect((await ask(desk, accountId, "balance_in", 1_000)).status).toBe(404);
    expect((await approve(desk, waiting.body.operation.id)).status).toBe(404);
    expect((await reject(desk, waiting.body.operation.id)).status).toBe(404);
    const theirs = await live({ assignedTo: desk.staffId });
    const own = await ask(desk, theirs.id, "credit_in", 1_000);
    expect(own.status).toBe(201);
    expect((await approve(ben, own.body.operation.id)).status).toBe(200);
    expect((await ask(ann, 999_999, "balance_in", 1_000)).status).toBe(404);

    // The body, field by field.
    const fields = async (body: Record<string, unknown>) => {
      const res = await post(ann, `/api/staff/mt5/accounts/${accountId}/adjustments`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      return (res.body.error.details as { field: string }[]).map((d) => d.field);
    };
    const good = { kind: "balance_in", amountCents: 1_000, reasonCode: "other", note: NOTE };
    expect(await fields({ ...good, kind: "bonus" })).toEqual(["kind"]);
    for (const amountCents of [0, -5, 1.5, "1000", null]) expect(await fields({ ...good, amountCents })).toEqual(["amountCents"]);
    expect(await fields({ ...good, reasonCode: "gift" })).toEqual(["reasonCode"]);
    for (const note of ["too short", "x".repeat(501), "See https://example.com <b>now</b>", undefined]) expect(await fields({ ...good, note })).toEqual(["note"]);
    expect((await post(ann, `/api/staff/mt5/accounts/${accountId}/adjustments`, { ...good, staffId: ben.staffId })).status).toBe(400);
    expect(await opsOn(accountId)).toBe(1);

    // Live accounts of clients who are not closed, on a server that is switched on, with MT5 there to read.
    const demo = await api().post("/api/mt5-accounts").set(bearer(c)).send({ is_demo: true, demo_amount: 1000, leverage: "2000", password: MASTER, investor_password: INVESTOR });
    const demoId = Number((await one<{ id: number }>(env.db, "SELECT id FROM mt5_accounts WHERE login = ? AND server_code = 'demo'", [Number(demo.body.account.login)]))!.id);
    expect((await ask(ann, demoId, "balance_in", 1_000)).body.error).toMatchObject({ code: "CONFLICT", message: "Balance and credit changes are for live accounts only." });
    await exec(env.db, "UPDATE mt5_servers SET is_enabled = 0 WHERE code = 'live'");
    expect((await ask(ann, accountId, "balance_in", 1_000)).body.error.code).toBe("MT5_SERVER_OFF");
    expect((await approve(ben, waiting.body.operation.id)).body.error.code).toBe("MT5_SERVER_OFF");
    await exec(env.db, "UPDATE mt5_servers SET is_enabled = 1 WHERE code = 'live'");
    fake.down = true;
    expect((await ask(ann, accountId, "balance_out", 1_000)).body.error.code).toBe("MT5_UNAVAILABLE");
    fake.down = false;
    await exec(env.db, "UPDATE clients SET status = 'closed' WHERE id = ?", [c.id]);
    const closed = "This client's account is closed, so their MT5 balance and credit cannot change.";
    expect((await ask(ann, accountId, "balance_in", 1_000)).body.error).toMatchObject({ code: "CONFLICT", message: closed });
    expect((await approve(ben, waiting.body.operation.id)).body.error).toMatchObject({ code: "CONFLICT", message: closed });
    await exec(env.db, "UPDATE clients SET status = 'active' WHERE id = ?", [c.id]);
    expect(await opsOn(accountId)).toBe(1);
    expect(balanceCalls(waiting.body.operation.reference)).toEqual([]);
    await clean();
  });

  it("counts the changes waiting for this person's approval, for the Transfers badge", async () => {
    const summary = async (s: SignedIn) => {
      const res = await s.agent.get("/api/staff/mt5/operations/summary");
      expect(res.status).toBe(200);
      expect(Object.keys(res.body)).toEqual(["awaitingForMe"]);
      return res.body.awaitingForMe as number;
    };
    const before = { ann: await summary(ann), ben: await summary(ben), desk: await summary(desk) };
    const { id: accountId } = await live();
    const theirs = await live({ assignedTo: desk.staffId });
    const a = await ask(ann, accountId, "balance_in", 1_000);
    const b = await ask(ben, theirs.id, "credit_in", 1_000);
    expect([a.status, b.status]).toEqual([201, 201]);
    // Never the person's own request (another must approve it), and only the clients they may see.
    expect(await summary(ann)).toBe(before.ann + 1);
    expect(await summary(ben)).toBe(before.ben + 1);
    expect(await summary(desk)).toBe(before.desk + 1);
    // Without mt5.balance.adjust nothing waits for them.
    expect(await summary(fin)).toBe(0);
    expect(await summary(adm)).toBe(0);
    // Once decided it no longer waits.
    expect((await reject(ann, b.body.operation.id, "Asked for by mistake")).status).toBe(200);
    expect(await summary(ann)).toBe(before.ann);
    expect(await summary(desk)).toBe(before.desk);
    expect(await summary(ben)).toBe(before.ben + 1);
    expect((await approve(ben, a.body.operation.id)).status).toBe(200);
    expect(await summary(ben)).toBe(before.ben);

    // wallet.view is needed to ask at all, and a signed-out caller gets nothing.
    const role = (await exec(env.db, "INSERT INTO roles (slug, name) VALUES ('no_wallet', 'No wallet')")).insertId;
    await exec(env.db, "INSERT INTO role_permissions (role_id, permission) VALUES (?, 'client.view'), (?, 'mt5.balance.adjust')", [role, role]);
    await createStaff(env.db, "nowallet@crm.test", "no_wallet");
    const nowallet = await signIn(env, "nowallet@crm.test");
    expect((await nowallet.agent.get("/api/staff/mt5/operations/summary")).status).toBe(403);
    expect((await api().get("/api/staff/mt5/operations/summary")).status).toBe(401);
    await clean();
  });

  it("answers a double click with the first change instead of asking twice", async () => {
    const { id: accountId } = await live();
    const [a, b] = await Promise.all([ask(ann, accountId, "balance_in", 2_500), ask(ann, accountId, "balance_in", 2_500)]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.operation.id).toBe(b.body.operation.id);
    expect(await opsOn(accountId)).toBe(1);
    // Another amount, or a cancelled one, is a new change.
    expect((await ask(ann, accountId, "balance_in", 2_501)).status).toBe(201);
    await reject(ann, a.body.operation.id, "Asked for by mistake");
    expect((await ask(ann, accountId, "balance_in", 2_500)).status).toBe(201);
    expect(await opsOn(accountId)).toBe(3);
  });

  it("runs a change at or under the second-approval amount at once, within what the person ran alone in the last 24 hours", async () => {
    // The amount is an MT5 setting: mt5.servers and 2FA to change, audited, and 0 means every change needs a second person.
    expect((await patch(ann, "/api/staff/mt5/settings", { adjustSecondApprovalCents: 10_000 })).status).toBe(403);
    expect((await patch(boss, "/api/staff/mt5/settings", { adjustSecondApprovalCents: -1 })).status).toBe(400);
    const set = await patch(boss, "/api/staff/mt5/settings", { adjustSecondApprovalCents: 10_000 });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ adjustSecondApprovalCents: 10_000 });
    expect((await boss.agent.get("/api/staff/mt5/settings")).body).toMatchObject({ adjustSecondApprovalCents: 10_000 });
    expect((await rows<Record<string, any>>(env.db, "SELECT before_json, after_json FROM audit_log WHERE action = 'mt5.settings_updated' ORDER BY id DESC LIMIT 1"))[0]).toEqual({
      before_json: { adjustSecondApprovalCents: 0 }, after_json: { adjustSecondApprovalCents: 10_000 },
    });

    const { c, login, id: accountId } = await live();
    const first = await ask(ann, accountId, "balance_in", 6_000);
    expect(first.status).toBe(201);
    expect(first.body.operation).toMatchObject({ status: "completed", change: { approvedBy: null, ranAtOnce: true, canApprove: false } });
    expect(balanceCalls(first.body.operation.reference)[0]!.req.notBefore).toBe((await opRow(first.body.operation.id)).created_at.toISOString());
    expect((await audits("mt5.adjustment.requested", c.id))[0]).toMatchObject({ after_json: { status: "sending" }, meta_json: { secondApproval: false, ranAloneTodayCents: 0 } });
    // Credit counts with balance: 60 + 40 is the whole 100 for today.
    const second = await ask(ann, accountId, "credit_in", 4_000);
    expect(second.body.operation).toMatchObject({ status: "completed", change: { ranAtOnce: true } });
    expect(fake.user("live", login)).toMatchObject({ balanceCents: 6_000, creditCents: 4_000 });
    // So the next one waits, however small: small changes cannot add up to a large one.
    const third = await ask(ann, accountId, "balance_in", 1);
    expect(third.body.operation).toMatchObject({ status: "awaiting_approval", change: { ranAtOnce: false } });
    expect((await audits("mt5.adjustment.requested", c.id))[2]).toMatchObject({ meta_json: { secondApproval: true, ranAloneTodayCents: 10_000 } });
    // Someone else has their own day; over the amount always waits.
    expect((await ask(ben, accountId, "balance_out", 6_000)).body.operation).toMatchObject({ status: "completed" });
    expect((await ask(ben, accountId, "credit_out", 4_000)).body.operation).toMatchObject({ status: "completed" });
    expect((await ask(ben, accountId, "balance_in", 10_001)).body.operation).toMatchObject({ status: "awaiting_approval" });
    // An approved change does not use up the approver's day or the requester's.
    expect((await approve(ben, third.body.operation.id)).status).toBe(200);

    // A change MT5 refused does not count either, and asking again at once is a new try, not a repeat of the refused one.
    const other = await live();
    fake.failNext("balance", { kind: "refused", code: "trade_disabled" });
    const refused = await ask(boss, other.id, "balance_in", 9_000);
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({ code: "MT5_REFUSED", details: { failure: "trade_disabled" } });
    expect((await ask(boss, other.id, "balance_in", 9_000)).body.operation).toMatchObject({ status: "completed" });
    expect(await entriesOf(first.body.operation.id)).toHaveLength(2);
    expect(await entriesOf(second.body.operation.id)).toEqual([]);
    await clean();
  });

  it("leaves a lost answer to the resolver, which settles it once from the credit deal it finds", async () => {
    const { c, login, id: accountId } = await live();
    const asked = await ask(ann, accountId, "credit_in", 2_200);
    const opId = asked.body.operation.id as number;
    fake.failNext("balance", { kind: "unknown-after" });
    const lost = await approve(ben, opId);
    expect(lost.status).toBe(202);
    expect(lost.body.operation).toMatchObject({ status: "unknown", failure: "timeout", canCheck: true, canFail: false });
    expect(fake.user("live", login)!.creditCents).toBe(2_200);
    expect(await bells(c.id)).toEqual([]);
    // Another change on the account waits until this one is settled.
    const next = await ask(ann, accountId, "credit_in", 100);
    expect((await approve(ben, next.body.operation.id)).body.error).toMatchObject({
      code: "CONFLICT", message: "Another operation on this account is still being processed. Try again once it has settled.",
    });

    await due(opId);
    await resolve();
    await resolve();
    const op = await opRow(opId);
    expect(op).toMatchObject({ status: "completed", mt5_ticket: fake.dealsOf("live", login)[0]!.ticket });
    expect(balanceCalls(asked.body.operation.reference)).toHaveLength(1);
    expect(fake.callsTo("deal.find").filter((x) => x.req.comment === asked.body.operation.reference)[0]!.req.from).toBe(new Date((op.approved_at as Date).getTime() - 86_400_000).toISOString());
    expect(await bells(c.id)).toHaveLength(1);
    expect(await audits("mt5.adjustment.completed", c.id)).toHaveLength(1);
    expect(await entriesOf(opId)).toEqual([]);
    expect((await approve(ben, next.body.operation.id)).status).toBe(200);
    await clean();
  });

  it("never takes a balance deal with the reference for a credit change, and lets staff give up on one only when MT5 has none", async () => {
    const { c, login, id: accountId } = await live();
    const asked = await ask(ann, accountId, "credit_in", 3_300);
    const opId = asked.body.operation.id as number;
    const reference = asked.body.operation.reference as string;
    fake.failNext("balance", { kind: "unknown-before" });
    expect((await approve(ben, opId)).status).toBe(202);
    // A balance deal carrying the reference and the amount is not this credit deal.
    const planted = fake.addDeal("live", { login, comment: reference, profitCents: 3_300 });
    await due(opId);
    await resolve();
    expect(await opRow(opId)).toMatchObject({ status: "unknown", failure: "mismatch" });
    // Ten minutes after it was approved (not asked for), staff may look, but not mark it failed while MT5 has that deal.
    await exec(env.db, "UPDATE mt5_balance_ops SET created_at = created_at - INTERVAL 1 DAY WHERE id = ?", [opId]);
    expect((await post(fin, `/api/staff/mt5/operations/${opId}/fail`, { note: "Checked the MT5 manager for this deal" })).body.error.message).toMatch(/ten minutes/);
    await exec(env.db, "UPDATE mt5_balance_ops SET approved_at = approved_at - INTERVAL 11 MINUTE WHERE id = ?", [opId]);
    const found = await post(fin, `/api/staff/mt5/operations/${opId}/fail`, { note: "Checked the MT5 manager for this deal" });
    expect(found.status).toBe(409);
    expect(found.body.error).toMatchObject({ code: "MT5_DEAL_FOUND", details: { ticket: planted.ticket, action: 2, amountCents: 3_300, expectedCents: 3_300, expectedAction: 3 } });
    // Once that deal is gone (a person dealt with it in MT5), the change can be marked failed.
    fake.deals.splice(fake.deals.indexOf(planted), 1);
    const failed = await post(fin, `/api/staff/mt5/operations/${opId}/fail`, { note: "Checked the MT5 manager for this deal" });
    expect(failed.status).toBe(200);
    expect(failed.body.operation).toMatchObject({ status: "failed", resolvedBy: { id: fin.staffId } });
    expect(fake.user("live", login)!.creditCents).toBe(0);
    expect(await actions(c.id)).toEqual(["mt5.adjustment.requested", "mt5.adjustment.approved", "mt5.adjustment.failed"]);
    expect(await bells(c.id)).toEqual([]);
    await clean();
  });

  it("lets two approvals at once send the change once", async () => {
    const { login, id: accountId } = await live();
    const asked = await ask(ann, accountId, "balance_in", 4_400);
    const opId = asked.body.operation.id as number;
    const results = await Promise.all([approve(ben, opId), approve(boss, opId), approve(ben, opId)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(balanceCalls(asked.body.operation.reference)).toHaveLength(1);
    expect(fake.user("live", login)!.balanceCents).toBe(4_400);
    expect(await entriesOf(opId)).toHaveLength(2);
    await clean();
  });

  it("runs a client's transfer and a staff change on one account one after the other, each checked on MT5's figures after the other", async () => {
    const { c, login, id: accountId } = await live();
    fake.setAccount("live", login, { balanceCents: 100_000 });
    const chargeback = { reasonCode: "chargeback", note: "Card chargeback from the acquirer" };
    const balanceSent = () => fake.callsTo("balance").filter((x) => x.req.login === login).map((x) => x.req.amountCents);

    // MT5 has answered the approval's read of the figures ($1,000 can come out) when the client asks for $500 to their wallet.
    const first = await ask(ann, accountId, "balance_out", 80_000, chargeback);
    let read = fake.pause("accounts.get", { answered: true });
    const approval = approve(ben, first.body.operation.id).then((r) => r);
    await read.reached;
    const transfer = toWallet(c, login, 500).then((r) => r);
    // The transfer waits for the approval to finish (were it not to, it would be done by now).
    await Promise.race([transfer, aMoment()]);
    read.release();
    const [approved, refused] = await Promise.all([approval, transfer]);
    expect(approved.status).toBe(200);
    expect(approved.body.operation).toMatchObject({ status: "completed" });
    // Then it reads MT5 itself: $200 is all that can come out now.
    expect(refused.status).toBe(422);
    expect(refused.body.errors).toEqual({ amount: ["You can transfer up to $200.00 from this account."] });
    expect(balanceSent()).toEqual([-80_000]);

    // The other way round: MT5 has answered the transfer's read ($200 can come out) when a second person approves $150 out.
    const second = await ask(ann, accountId, "balance_out", 15_000, chargeback);
    read = fake.pause("accounts.get", { answered: true });
    const moved = toWallet(c, login, 100).then((r) => r);
    await read.reached;
    const late = approve(ben, second.body.operation.id).then((r) => r);
    await Promise.race([late, aMoment()]);
    read.release();
    const [made, stale] = await Promise.all([moved, late]);
    expect(made.status).toBe(200);
    // The approval reads MT5 after the transfer: $100 is left, less than the change.
    expect(stale.status).toBe(422);
    expect(stale.body.error).toMatchObject({ code: "OVER_WITHDRAWABLE", details: { withdrawableCents: 10_000 } });
    expect((await opRow(second.body.operation.id)).status).toBe("awaiting_approval");
    // MT5 was never asked for more than the account could give.
    expect(balanceSent()).toEqual([-80_000, -10_000]);
    expect(fake.user("live", login)!.balanceCents).toBe(10_000);
    await clean();
  });

  it("lets a person ask for a change on one account while their approval on another account of the same client goes through", async () => {
    const { c, id: first } = await live();
    const { id: second } = await liveFor(c);
    const waiting = await ask(ann, first, "balance_in", 1_000);
    // Another connection holds the first account's row for a moment, so Ben's approval waits there, holding the client's row.
    const blocker = await env.db.getConnection();
    await blocker.beginTransaction();
    let approving: Promise<request.Response>;
    let asking: Promise<request.Response>;
    try {
      await blocker.query("SELECT id FROM mt5_accounts WHERE id = ? FOR UPDATE", [first]);
      approving = approve(ben, waiting.body.operation.id).then((r) => r);
      await lockedElsewhere("clients", c.id);
      // Meanwhile Ben asks for a change on the second account, which waits for the client's row too.
      asking = ask(ben, second, "balance_in", 2_000).then((r) => r);
      await aMoment();
    } finally {
      await blocker.commit();
      blocker.release();
    }
    const [approved, asked] = await Promise.all([approving!, asking!]);
    // Neither is a deadlock's victim: both are taken in the order every other change takes them.
    expect(approved.status).toBe(200);
    expect(approved.body.operation).toMatchObject({ status: "completed" });
    expect(asked.status).toBe(201);
    expect(asked.body.operation).toMatchObject({ status: "awaiting_approval", change: { requestedBy: { id: ben.staffId } } });
    await clean();
  });

  it("keeps Admins out of balance and credit changes, so one cannot make a second account to approve their own", async () => {
    // Admins manage staff accounts, and may grant only what they hold themselves.
    expect(await permissionsOf("admin")).toContain("staff.create");
    expect(await permissionsOf("admin")).not.toContain("mt5.balance.adjust");
    const { id: accountId } = await live();
    expect((await ask(adm, accountId, "balance_in", 5_000_000)).status).toBe(403);
    const waiting = await ask(ann, accountId, "balance_in", 1_000);
    expect((await approve(adm, waiting.body.operation.id)).status).toBe(403);
    expect((await reject(adm, waiting.body.operation.id)).status).toBe(403);
    // So an Admin can neither make an account that may approve a change, nor take one over.
    const sock = await post(adm, "/api/staff/users", { email: "sock@crm.test", name: "Sock", roleId: changesRole });
    expect(sock.status).toBe(403);
    expect(sock.body.error.message).toMatch(/^You cannot grant permissions you do not hold yourself: .*mt5\.balance\.adjust/);
    expect(sock.body).not.toHaveProperty("temporaryPassword");
    const reset = await post(adm, `/api/staff/users/${ben.staffId}/reset-password`, {});
    expect(reset.status).toBe(403);
    expect(reset.body).not.toHaveProperty("temporaryPassword");
    expect((await opRow(waiting.body.operation.id)).status).toBe("awaiting_approval");

    // Where the roles were seeded before this permission did anything, 0019 takes it from the Admin role.
    await exec(env.db, "INSERT IGNORE INTO role_permissions (role_id, permission) SELECT id, 'mt5.balance.adjust' FROM roles WHERE slug = 'admin'");
    const migration = await readFile(path.join(migrationsDir(), "0019_mt5_adjustments.sql"), "utf8");
    for (const statement of splitStatements(migration).filter((s) => s.startsWith("DELETE"))) await env.db.query(statement);
    expect(await permissionsOf("admin")).not.toContain("mt5.balance.adjust");
    expect(await permissionsOf("mt5_changes")).toContain("mt5.balance.adjust");
  });

  it("lets one Finance Manager ask for a change and another approve it", async () => {
    expect(await permissionsOf("finance_manager")).toContain("mt5.balance.adjust");
    await createStaff(env.db, "fm.one@crm.test", "finance_manager");
    await createStaff(env.db, "fm.two@crm.test", "finance_manager");
    const asker = await signIn(env, "fm.one@crm.test");
    const approver = await signIn(env, "fm.two@crm.test");
    await stepUp(env, asker);
    await stepUp(env, approver);
    const { id: accountId } = await live();
    const asked = await ask(asker, accountId, "balance_in", 2_500);
    expect(asked.status).toBe(201);
    const opId = asked.body.operation.id as number;
    expect((await approve(asker, opId)).body.error).toMatchObject({ message: SAME_PERSON });
    const approved = await approve(approver, opId);
    expect(approved.status).toBe(200);
    expect(approved.body.operation).toMatchObject({ status: "completed", change: { requestedBy: { id: asker.staffId }, approvedBy: { id: approver.staffId } } });

    // Where the roles were seeded before this permission did anything, 0019 gives it to the Finance Manager role.
    await exec(env.db, "DELETE rp FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.slug = 'finance_manager' AND rp.permission = 'mt5.balance.adjust'");
    const migration = await readFile(path.join(migrationsDir(), "0019_mt5_adjustments.sql"), "utf8");
    for (const statement of splitStatements(migration).filter((s) => s.startsWith("INSERT"))) await env.db.query(statement);
    expect(await permissionsOf("finance_manager")).toContain("mt5.balance.adjust");
    await clean();
  });

  it("lists staff changes with the other MT5 operations, by purpose and state, and keeps them out of the client's transfers", async () => {
    const { c, id: accountId } = await live();
    const waiting = await ask(ann, accountId, "balance_in", 1_100);
    const done = await ask(ann, accountId, "credit_in", 2_200);
    await approve(ben, done.body.operation.id);
    const gone = await ask(ann, accountId, "credit_in", 3_300);
    await reject(ben, gone.body.operation.id);
    const ids = (res: request.Response) => res.body.items.map((o: { id: number }) => o.id);

    const all = await fin.agent.get(`/api/staff/mt5/operations?clientId=${c.id}`);
    expect(all.status).toBe(200);
    expect(ids(all)).toEqual([gone.body.operation.id, done.body.operation.id, waiting.body.operation.id]);
    // Someone without mt5.balance.adjust sees them, and may decide nothing.
    expect(all.body.items[2].change).toMatchObject({ canApprove: false, canReject: false });
    expect(ids(await ben.agent.get(`/api/staff/mt5/operations?clientId=${c.id}&status=awaiting_approval`))).toEqual([waiting.body.operation.id]);
    expect(ids(await ben.agent.get(`/api/staff/mt5/operations?clientId=${c.id}&status=cancelled`))).toEqual([gone.body.operation.id]);
    expect(ids(await ben.agent.get(`/api/staff/mt5/operations?clientId=${c.id}&purpose=staff_credit_in`))).toEqual([gone.body.operation.id, done.body.operation.id]);
    expect(ids(await ben.agent.get(`/api/staff/mt5/operations?clientId=${c.id}&purpose=staff`))).toHaveLength(3);
    expect(ids(await ben.agent.get(`/api/staff/mt5/operations?clientId=${c.id}&purpose=wallet_to_mt5`))).toEqual([]);
    expect(ids(await ben.agent.get(`/api/staff/mt5/operations?q=${waiting.body.operation.reference}`))).toEqual([waiting.body.operation.id]);
    expect((await ben.agent.get(`/api/staff/mt5/operations?status=awaiting`)).status).toBe(400);

    const transfers = await api().get("/api/transfers").set(bearer(c));
    expect(transfers.body.data).toEqual([]);
    await clean();
  });

  it("reports a staff change whose ledger contradicts its status", async () => {
    await clean();
    const { id: accountId } = await live();
    const credit = await ask(ann, accountId, "credit_in", 500);
    await approve(ben, credit.body.operation.id);
    const balance = await ask(ann, accountId, "balance_in", 700);
    await approve(ben, balance.body.operation.id);
    // Credit posted as if it were client money, and a balance change marked completed again in the ledger's eyes by a second posting.
    await transaction(env.db, async (conn) => {
      const { postLedger } = await import("../src/server/money/ledger");
      await postLedger(conn, { kind: "mt5_adjust_in", sourceType: "mt5_op", sourceId: credit.body.operation.id, clientId: credit.body.operation.clientId, staffId: null, memo: "test" }, [
        { account: MT5_ADJUSTMENTS_ACCOUNT, amount: -500 }, { account: mt5FundingAccount(accountId), amount: 500 },
      ]);
    });
    const waiting = await ask(ann, accountId, "balance_in", 900);
    await exec(env.db, "UPDATE mt5_balance_ops SET status = 'completed', mt5_ticket = 1 WHERE id = ?", [waiting.body.operation.id]);
    const problems = await verifyLedger(env.db);
    expect(problems).toEqual([
      `MT5 operation ${credit.body.operation.reference} (staff_credit_in) is completed, but the ledger has 1 staff payment to MT5, not 0 staff payment to MT5.`,
      `MT5 operation ${waiting.body.operation.reference} (staff_balance_in) is completed, but the ledger has 0 staff payment to MT5, not 1 staff payment to MT5.`,
      expect.stringMatching(/^Ledger transaction \d+ \(mt5_adjust_in\) is not a kind of transaction an MT5 staff_credit_in operation makes\.$/),
    ]);
  });
});
