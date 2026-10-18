import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WRITE_OPS } from "../src/gateway/protocol";
import { exec, one, rows, transaction, type Db } from "../src/server/lib/db";
import { holdAccount, MT5_ADJUSTMENTS_ACCOUNT, mt5FundingAccount, postLedger, walletAccount, walletOf } from "../src/server/money/ledger";
import { syncAccountDeals } from "../src/server/mt5/deals";
import { insertBalanceOp, runBalanceOp, type BalancePurpose, type OpStatus } from "../src/server/mt5/operations";
import {
  activeRun, claimRun, MAX_ATTEMPTS, reconciliationTick, runClaimed, runReconciliation, RunBusy, startMt5Reconciliation, type RunLimits, type RunRow,
} from "../src/server/mt5/reconcile";
import { mt5Reference } from "../src/server/mt5/references";
import { FakeGateway } from "./fakes/gateway";
import { createStaff, hasDb, post, setup, signIn, stepUp, type SignedIn, type TestEnv } from "./helpers";

// Reconciliation end to end against MySQL and the fake gateway: what each
// check reports and when it holds back, the keys that keep one row per
// issue, reopening and resolving, one run at a time and one nightly run a
// day across processes, a run that stops midway, the limits, and the staff
// API with its permissions, scoping, 2FA and audit.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const STANDARD = "real\\standard";
const DEMO_GROUP = "demo\\usd";

interface Line {
  level: "info" | "warn" | "error";
  obj: Record<string, unknown>;
  msg: string;
}
const lines: Line[] = [];
const at = (level: Line["level"]) => (obj: unknown, msg?: string) => void lines.push({ level, obj: obj as Record<string, unknown>, msg: msg ?? "" });
const log = { info: at("info"), warn: at("warn"), error: at("error") };

/** The pool, except that queries matching one of `fail` reject, as a lost connection (or the process ending) there would. */
function failing(db: Db, fail: RegExp[]): Db {
  return new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      if (prop !== "query" && prop !== "execute") return value.bind(target);
      return (sql: string | { sql: string }, params?: unknown) =>
        fail.some((f) => f.test(typeof sql === "string" ? sql : sql.sql)) ? Promise.reject(new Error("Connection lost")) : value.call(target, sql, params);
    },
  });
}

interface Acct {
  id: number;
  clientId: number;
  login: number;
  server: string;
  demo: boolean;
}
interface Issue {
  id: number;
  issue_key: string;
  kind: string;
  severity: string;
  status: string;
  op_id: number | null;
  deal_ticket: number | null;
  mt5_account_id: number | null;
  client_id: number | null;
  details: Record<string, unknown>;
  first_run_id: number;
  last_run_id: number;
  reopened: number;
  resolved_by: number | null;
  resolved_note: string | null;
}

describe.skipIf(!hasDb)("MT5 reconciliation", () => {
  let env: TestEnv;
  const fake = new FakeGateway();
  let finance: SignedIn; // finance_manager: wallet.view and wallet.reconcile, every client
  let auditor: SignedIn; // auditor: wallet.view only
  let support: SignedIn; // support_agent: neither
  let scoped: SignedIn; // wallet.view, only the clients assigned to them
  let seq = 0;
  let ticket = 80_000_000;

  async function makeClient(assignedTo: number | null = null) {
    seq++;
    const r = await exec(
      env.db,
      "INSERT INTO clients (email, first_name, last_name, referral_code, source, kyc_status, status, assigned_staff_id) VALUES (?, 'Ria', 'Moss', ?, 'portal', 'approved', 'active', ?)",
      [`recon.${seq}@client.test`, `TR${String(seq).padStart(8, "0")}`, assignedTo],
    );
    return r.insertId;
  }

  /** An open account, in the CRM and in MT5. */
  async function openAccount(clientId: number, opts: { server?: "live" | "demo"; status?: string; group?: string } = {}): Promise<Acct> {
    const server = opts.server ?? "live";
    const demo = server === "demo";
    const user = fake.addUser(server, { group: opts.group ?? (demo ? DEMO_GROUP : STANDARD) });
    const r = await exec(
      env.db,
      `INSERT INTO mt5_accounts (client_id, server_code, login, is_demo, package_name, mt5_group, leverage, status, create_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 2000, ?, ?, ?)`,
      [clientId, server, user.login, demo ? 1 : 0, demo ? "Demo" : "Classic", user.group, opts.status ?? "active", mt5Reference("A"), new Date(Date.now() - 30 * DAY)],
    );
    return { id: r.insertId, clientId, login: user.login, server, demo };
  }

  /** A deal in MT5 at a UTC time (the fake's servers keep UTC). */
  function addDeal(a: Acct, d: { at: number; amount: number; comment?: string; action?: number; ticket?: number }) {
    const time = Math.floor(d.at / 1000);
    return fake.addDeal(a.server, {
      login: a.login, ticket: d.ticket ?? ++ticket, action: d.action ?? 2, profitCents: d.amount, comment: d.comment ?? "", time, timeMsc: time * 1000,
      timeUtc: new Date(time * 1000).toISOString(),
    });
  }

  const STAFF = new Set(["staff_balance_in", "staff_balance_out", "staff_credit_in", "staff_credit_out"]);
  /** An operation written straight into the table, as if it had run. */
  async function insertOp(
    a: Acct,
    o: { purpose?: BalancePurpose; status?: OpStatus; amount?: number; ticket?: number | null; createdAt?: number; completedAt?: number; reference?: string } = {},
  ) {
    const purpose = o.purpose ?? (a.demo ? "demo_topup" : "staff_credit_in");
    const status = o.status ?? "completed";
    const reference = o.reference ?? mt5Reference("T");
    const staff = STAFF.has(purpose);
    const createdAt = new Date(o.createdAt ?? Date.now() - 3 * HOUR);
    const r = await exec(
      env.db,
      `INSERT INTO mt5_balance_ops (reference, purpose, client_id, mt5_account_id, server_code, login, amount_cents, status, mt5_ticket, failure,
         requested_by, reason_code, staff_note, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        reference, purpose, a.clientId, a.id, a.server, a.login, o.amount ?? 10_000, status, o.ticket ?? null, status === "failed" ? "no_money" : status === "unknown" ? "timeout" : null,
        staff ? finance.staffId : null, staff ? "bonus" : null, staff ? "Promised bonus" : null, createdAt,
        status === "completed" ? new Date(o.completedAt ?? createdAt.getTime()) : null,
      ],
    );
    return { id: r.insertId, reference };
  }

  /** A completed operation and its own deal in MT5. */
  async function completedWithDeal(a: Acct, o: { purpose?: BalancePurpose; amount?: number; at?: number } = {}) {
    const purpose = o.purpose ?? (a.demo ? "demo_topup" : "staff_credit_in");
    const amount = o.amount ?? 10_000;
    const out = purpose === "staff_credit_out" || purpose === "staff_balance_out" || purpose === "mt5_to_wallet";
    const when = o.at ?? Date.now() - 3 * HOUR;
    const reference = mt5Reference("T");
    const deal = addDeal(a, { at: when, amount: out ? -amount : amount, comment: reference, action: purpose.startsWith("staff_credit") ? 3 : 2 });
    const op = await insertOp(a, { purpose, amount, ticket: deal.ticket, reference, createdAt: when, completedAt: when });
    return { ...op, deal };
  }

  const run = (limits: Partial<RunLimits> = {}) => runReconciliation(env.db, fake, log, { kind: "manual", staffId: finance.staffId }, limits);
  const issues = async (): Promise<Issue[]> =>
    (await rows<Issue>(env.db, "SELECT * FROM mt5_recon_issues ORDER BY id")).map((i) => ({
      ...i, id: Number(i.id), op_id: i.op_id === null ? null : Number(i.op_id), deal_ticket: i.deal_ticket === null ? null : Number(i.deal_ticket),
      mt5_account_id: i.mt5_account_id === null ? null : Number(i.mt5_account_id), client_id: i.client_id === null ? null : Number(i.client_id),
      first_run_id: Number(i.first_run_id), last_run_id: Number(i.last_run_id), reopened: Number(i.reopened), resolved_by: i.resolved_by === null ? null : Number(i.resolved_by),
    }));
  /** "key severity" of the issues in a status. */
  const listed = async (status = "open") => (await issues()).filter((i) => i.status === status).map((i) => `${i.issue_key} ${i.severity}`);
  const issue = async (key: string) => (await issues()).find((i) => i.issue_key === key);
  const checks = async () =>
    new Map((await rows<{ op_id: number; outcome: string; deal_tickets: number[] }>(env.db, "SELECT op_id, outcome, deal_tickets FROM mt5_recon_op_checks")).map((c) => [Number(c.op_id), c]));
  const criticalLogged = () => lines.filter((l) => l.level === "error" && l.msg === "MT5 reconciliation found a critical issue").map((l) => l.obj.issueKey);

  beforeAll(async () => {
    env = await setup({}, { mt5: fake });
    await exec(env.db, "INSERT INTO mt5_servers (code, label, is_enabled) VALUES ('live', 'Live', 1), ('demo', 'Demo', 1)");
    await exec(env.db, "UPDATE mt5_settings SET demo_server_code = 'demo', demo_group = ? WHERE id = 1", [DEMO_GROUP]);
    await exec(env.db, "INSERT INTO account_packages (name, spread_label, server_code, mt5_group) VALUES ('Classic', '1.0', 'live', ?)", [STANDARD]);
    await exec(env.db, "INSERT INTO roles (slug, name) VALUES ('recon_desk', 'Reconciliation desk')");
    await exec(env.db, "INSERT INTO role_permissions (role_id, permission) SELECT id, 'wallet.view' FROM roles WHERE slug = 'recon_desk'");
    await createStaff(env.db, "finance@crm.test", "finance_manager");
    await createStaff(env.db, "auditor@crm.test", "auditor");
    await createStaff(env.db, "support@crm.test", "support_agent");
    await createStaff(env.db, "desk@crm.test", "recon_desk");
    finance = await signIn(env, "finance@crm.test");
    auditor = await signIn(env, "auditor@crm.test");
    support = await signIn(env, "support@crm.test");
    scoped = await signIn(env, "desk@crm.test");
  }, 120_000);
  afterAll(async () => env?.db.end());
  beforeEach(async () => {
    // Every test starts with no MT5 accounts, operations, deals or runs, in the CRM or in MT5.
    for (const table of ["mt5_recon_issues", "mt5_recon_op_checks", "mt5_recon_runs", "mt5_trades", "mt5_deals", "mt5_balance_ops", "mt5_accounts"]) {
      await exec(env.db, `DELETE FROM ${table}`);
    }
    fake.users.clear();
    fake.deals.length = 0;
    fake.calls.length = 0;
    fake.clearFaults();
    fake.down = false;
    lines.length = 0;
  });

  describe("what a run checks", () => {
    it("a clean run syncs every open account, matches each operation with its deal, finds nothing and only reads MT5", async () => {
      const c = await makeClient();
      const live = await openAccount(c);
      const demo = await openAccount(c, { server: "demo" });
      const credit = await completedWithDeal(live, { purpose: "staff_credit_in", amount: 12_500 });
      const taken = await completedWithDeal(live, { purpose: "staff_credit_out", amount: 2_500 });
      const failed = await insertOp(live, { status: "failed" });
      const funded = await completedWithDeal(demo, { purpose: "demo_funding", amount: 1_000_000 });
      // Trades are not balance deals, whatever their comment.
      addDeal(live, { at: Date.now() - 2 * HOUR, amount: 1_500, action: 0 });
      addDeal(live, { at: Date.now() - 2 * HOUR, amount: -700, action: 1, comment: "sl" });
      // An account not open in MT5 is not synced.
      await openAccount(c, { status: "failed" });

      const r = await run();
      expect(r).toMatchObject({ kind: "manual", status: "done", accounts_total: 2, accounts_checked: 2, issues_found: 0, issues_new: 0, critical_found: 0, error: null, notes: null });
      expect(r.started_by).toBe(finance.staffId);
      expect(r.finished_at).toBeInstanceOf(Date);
      expect(await issues()).toEqual([]);
      const done = await checks();
      expect(done.get(credit.id)).toMatchObject({ outcome: "matched", deal_tickets: [credit.deal.ticket] });
      expect(done.get(taken.id)).toMatchObject({ outcome: "matched", deal_tickets: [taken.deal.ticket] });
      expect(done.get(failed.id)).toMatchObject({ outcome: "no_deal", deal_tickets: [] });
      expect(done.get(funded.id)).toMatchObject({ outcome: "matched" });
      // Reads only: every account's deals, and the package's and demo group's logins.
      expect(fake.calls.some((c) => WRITE_OPS.has(c.op))).toBe(false);
      expect(new Set(fake.calls.map((c) => c.op))).toEqual(new Set(["deals.page", "users.list"]));
      expect(fake.callsTo("users.list").map((c) => `${c.req.server} ${c.req.group}`).sort()).toEqual([`demo ${DEMO_GROUP}`, `live ${STANDARD}`]);
      expect(lines.filter((l) => l.level === "error")).toEqual([]);
      expect(lines.at(-1)).toMatchObject({ level: "info", msg: "MT5 reconciliation run ended" });

      // A day later (as if), a run looks only at what is not done with: the four settled operations are not read again.
      await exec(env.db, "UPDATE mt5_recon_runs SET next_deals_from = CURRENT_TIMESTAMP(3)");
      const again = await run();
      expect(again).toMatchObject({ status: "done", issues_found: 0 });
      expect(Number((await one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM mt5_recon_op_checks WHERE run_id = ?", [again.id]))!.n)).toBe(0);
    });

    it("a completed operation without its deal is critical only once the account's cache covers it, and its deal arriving resolves it", async () => {
      const a = await openAccount(await makeClient());
      const op = await insertOp(a, { createdAt: Date.now() - 10 * MINUTE, ticket: 9_100_001 });
      // Completed ten minutes ago: MT5 may file its deal late, so nothing yet, and it is looked at again next run.
      const first = await run();
      expect(first.issues_found).toBe(0);
      expect((await checks()).has(op.id)).toBe(false);

      // Two hours later (as if): the cache, synced now, is complete to well past it.
      await exec(env.db, "UPDATE mt5_balance_ops SET created_at = ?, completed_at = ? WHERE id = ?", [new Date(Date.now() - 2 * HOUR), new Date(Date.now() - 2 * HOUR), op.id]);
      const second = await run();
      expect(second).toMatchObject({ issues_found: 1, issues_new: 1, critical_found: 1 });
      expect(await listed()).toEqual([`op_without_deal:${op.id} critical`]);
      const found = (await issue(`op_without_deal:${op.id}`))!;
      expect(found).toMatchObject({ kind: "op_without_deal", op_id: op.id, mt5_account_id: a.id, client_id: a.clientId, first_run_id: second.id, last_run_id: second.id });
      expect(found.details).toMatchObject({ reference: op.reference, status: "completed", amountCents: 10_000, ticket: 9_100_001, expected: { server: "live", login: a.login, action: 3, amountCents: 10_000 } });
      // Looked at again each run while it is wrong.
      expect((await checks()).has(op.id)).toBe(false);
      expect(criticalLogged()).toEqual([`op_without_deal:${op.id}`]);
      expect(lines.at(-1)).toMatchObject({ level: "error", msg: "MT5 reconciliation found critical issues" });

      // Found again: the same row, not a new one, and not logged as new.
      lines.length = 0;
      const third = await run();
      expect(third).toMatchObject({ issues_found: 1, issues_new: 0, critical_found: 1 });
      expect(await issues()).toHaveLength(1);
      expect(await issue(`op_without_deal:${op.id}`)).toMatchObject({ status: "open", first_run_id: second.id, last_run_id: third.id });
      expect(criticalLogged()).toEqual([]);

      // MT5 had it after all (filed late): the new deal brings the operation back, and the issue is resolved by the run.
      addDeal(a, { at: Date.now() - 2 * HOUR, amount: 10_000, comment: op.reference, action: 3, ticket: 9_100_001 });
      const fourth = await run();
      expect(fourth.issues_found).toBe(0);
      expect(await issue(`op_without_deal:${op.id}`)).toMatchObject({ status: "resolved", resolved_by: null, resolved_note: `No longer found by reconciliation run ${fourth.id}.` });
      expect((await checks()).get(op.id)).toMatchObject({ outcome: "matched", deal_tickets: [9_100_001] });
    });

    it("an operation that settles, and a deal MT5 makes, while the run reads are not reported", async () => {
      const a = await openAccount(await makeClient());
      const op = await insertOp(a, { status: "sending", createdAt: Date.now() - 2 * MINUTE });
      // The run has synced every account and is listing MT5's groups when the answer comes back.
      const listing = fake.pause("users.list");
      const running = run();
      await listing.reached;
      const deal = addDeal(a, { at: Date.now(), amount: 10_000, comment: op.reference, action: 3 });
      await exec(env.db, "UPDATE mt5_balance_ops SET status = 'completed', mt5_ticket = ?, completed_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [deal.ticket, op.id]);
      listing.release();
      const r = await running;
      expect(r).toMatchObject({ status: "done", issues_found: 0 });
      expect(await issues()).toEqual([]);
      // Not done with: the next run reads its deal and matches it.
      expect((await checks()).has(op.id)).toBe(false);
      expect((await run()).issues_found).toBe(0);
      expect((await checks()).get(op.id)).toMatchObject({ outcome: "matched", deal_tickets: [deal.ticket] });
    });

    it("a deal that does not match its operation, and a second deal for one reference, are critical mismatches", async () => {
      const a = await openAccount(await makeClient());
      const reference = mt5Reference("T");
      const wrong = addDeal(a, { at: Date.now() - 3 * HOUR, amount: 9_999, comment: reference, action: 3 });
      const short = await insertOp(a, { reference, amount: 10_000, ticket: wrong.ticket });
      const twice = await completedWithDeal(a, { amount: 5_000 });
      const again = addDeal(a, { at: Date.now() - 2 * HOUR, amount: 5_000, comment: twice.reference, action: 3 });
      await run();
      expect((await listed()).sort()).toEqual([`deal_mismatch:live:${again.ticket} critical`, `deal_mismatch:live:${wrong.ticket} critical`].sort());
      expect((await issue(`deal_mismatch:live:${wrong.ticket}`))!).toMatchObject({ op_id: short.id, deal_ticket: wrong.ticket, details: { reason: "amount", deal: { amountCents: 9_999 } } });
      expect((await issue(`deal_mismatch:live:${again.ticket}`))!.details).toMatchObject({ reason: "duplicate", reference: twice.reference });
      // A wrong deal is not also a missing one.
      expect(await issue(`op_without_deal:${short.id}`)).toBeUndefined();
    });

    it("a transfer done with comes back when MT5 changes its deal: a new amount or comment is a critical mismatch", async () => {
      const a = await openAccount(await makeClient());
      // Written straight into the table, these transfers have no ledger entries (which the ledger checks report): only their deals matter here.
      const amount = await completedWithDeal(a, { purpose: "wallet_to_mt5" });
      const comment = await completedWithDeal(a, { purpose: "wallet_to_mt5" });
      const kept = await completedWithDeal(a, { purpose: "wallet_to_mt5" });
      const first = await run();
      for (const t of [amount, comment, kept]) expect((await checks()).get(t.id)).toMatchObject({ outcome: "matched", deal_tickets: [t.deal.ticket] });
      const checkedBy = async (opId: number) => Number((await one<{ run_id: number }>(env.db, "SELECT run_id FROM mt5_recon_op_checks WHERE op_id = ?", [opId]))?.run_id);

      // A day later (as if): the run's sync reads the deals again just as they were, which marks none of them changed, so none is looked at again.
      await exec(env.db, "UPDATE mt5_recon_runs SET next_deals_from = CURRENT_TIMESTAMP(3)");
      await run();
      expect(await rows(env.db, "SELECT ticket FROM mt5_deals WHERE changed_at IS NOT NULL")).toEqual([]);
      for (const t of [amount, comment, kept]) expect(await checkedBy(t.id)).toBe(first.id);

      // A dealer changes one deal's amount and another's comment in MT5, and the background sync reads them again.
      amount.deal.profitCents = 100_000;
      comment.deal.comment = "Corrected by dealing";
      expect(await syncAccountDeals(env.db, fake, a.id, log)).toMatchObject({ outcome: "complete", newDeals: 0 });
      const next = await run();
      expect(await issue(`deal_mismatch:live:${amount.deal.ticket}`)).toMatchObject({
        status: "open", severity: "critical", op_id: amount.id, first_run_id: next.id,
        details: { reference: amount.reference, reason: "amount", expected: { amountCents: 10_000 }, deal: { amountCents: 100_000 } },
      });
      expect(await issue(`deal_mismatch:live:${comment.deal.ticket}`)).toMatchObject({
        status: "open", severity: "critical", op_id: comment.id, details: { reference: comment.reference, reason: "comment", deal: { comment: "Corrected by dealing" } },
      });
      // The CRM's own deal under another comment is not one made outside the CRM.
      expect(await issue(`external_balance_deal:live:${comment.deal.ticket}`)).toBeUndefined();
      expect(criticalLogged()).toEqual(expect.arrayContaining([`deal_mismatch:live:${amount.deal.ticket}`, `deal_mismatch:live:${comment.deal.ticket}`]));
      // Wrong now, so looked at each run; the transfer whose deal MT5 left alone stays done with.
      const done = await checks();
      expect([done.has(amount.id), done.has(comment.id)]).toEqual([false, false]);
      expect(await checkedBy(kept.id)).toBe(first.id);
    });

    it("a deal made outside the CRM that MT5 changes is looked at again under its one issue, which reopens with what MT5 says now", async () => {
      const a = await openAccount(await makeClient());
      const manual = addDeal(a, { at: Date.now() - HOUR, amount: 20_000, comment: "Deposit by bank" });
      const first = await run();
      const key = `external_balance_deal:live:${manual.ticket}`;
      expect(await listed()).toEqual([`${key} warning`]);
      await exec(env.db, "UPDATE mt5_recon_issues SET status = 'resolved', resolved_by = ?, resolved_at = CURRENT_TIMESTAMP(3), resolved_note = 'Checked with dealing' WHERE issue_key = ?", [
        finance.staffId, key,
      ]);

      // A day later (as if): read again just as it was, the deal is not looked at again.
      await exec(env.db, "UPDATE mt5_recon_runs SET next_deals_from = CURRENT_TIMESTAMP(3)");
      await run();
      expect(await issue(key)).toMatchObject({ status: "resolved", last_run_id: first.id });

      // A dealer changes its amount: the run's own sync reads it again, and it is the same issue with the new facts.
      manual.profitCents = 2_000_000;
      const changed = await run();
      expect(changed).toMatchObject({ status: "done", issues_found: 1, issues_new: 1 });
      expect(await issues()).toHaveLength(1);
      expect(await issue(key)).toMatchObject({
        status: "open", severity: "warning", reopened: 1, resolved_by: null, first_run_id: first.id, last_run_id: changed.id,
        details: { ticket: manual.ticket, amountCents: 2_000_000, comment: "Deposit by bank" },
      });
    });

    it("a failed, cancelled or waiting operation with a deal is critical; one waiting or open over an hour is a warning", async () => {
      const a = await openAccount(await makeClient());
      const failed = await insertOp(a, { status: "failed" });
      const failedDeal = addDeal(a, { at: Date.now() - 3 * HOUR, amount: 10_000, comment: failed.reference, action: 3 });
      const cancelled = await insertOp(a, { status: "cancelled" });
      addDeal(a, { at: Date.now() - 3 * HOUR, amount: 10_000, comment: cancelled.reference, action: 3 });
      const waitingPaid = await insertOp(a, { status: "awaiting_approval", createdAt: Date.now() - 5 * MINUTE });
      addDeal(a, { at: Date.now() - MINUTE, amount: 10_000, comment: waitingPaid.reference, action: 3 });
      const waitingLong = await insertOp(a, { status: "awaiting_approval", createdAt: Date.now() - 2 * HOUR });
      const waitingNew = await insertOp(a, { status: "awaiting_approval", createdAt: Date.now() - 5 * MINUTE });
      const stuck = await insertOp(a, { status: "unknown", createdAt: Date.now() - 2 * HOUR });
      const sending = await insertOp(a, { status: "sending", createdAt: Date.now() - 5 * MINUTE });

      await run();
      expect((await listed()).sort()).toEqual(
        [
          `failed_op_has_deal:${failed.id} critical`, `failed_op_has_deal:${cancelled.id} critical`, `failed_op_has_deal:${waitingPaid.id} critical`,
          `unsettled_op:${waitingLong.id} warning`, `unsettled_op:${stuck.id} warning`,
        ].sort(),
      );
      expect((await issue(`failed_op_has_deal:${failed.id}`))!).toMatchObject({ deal_ticket: failedDeal.ticket, details: { failure: "no_money", status: "failed" } });
      expect((await issue(`unsettled_op:${stuck.id}`))!.details).toMatchObject({ status: "unknown", failure: "timeout", mt5HasDeal: false });
      for (const op of [waitingNew, sending]) expect((await issues()).some((i) => i.op_id === op.id)).toBe(false);

      // Settled since, with nothing in MT5: the warnings go, resolved by the run.
      await exec(env.db, "UPDATE mt5_balance_ops SET status = 'failed', failure = 'not_found' WHERE id = ?", [stuck.id]);
      await exec(env.db, "UPDATE mt5_balance_ops SET status = 'cancelled' WHERE id = ?", [waitingLong.id]);
      const later = await run();
      expect(await issue(`unsettled_op:${stuck.id}`)).toMatchObject({ status: "resolved", resolved_by: null });
      expect(await issue(`unsettled_op:${waitingLong.id}`)).toMatchObject({ status: "resolved", resolved_by: null });
      expect((await checks()).get(stuck.id)).toMatchObject({ outcome: "no_deal", deal_tickets: [] });
      // The deals still there are still found (their operations are done with, so they come from the issues already open).
      expect(await issue(`failed_op_has_deal:${failed.id}`)).toMatchObject({ status: "open" });
      expect(later.status).toBe("done");
    });

    it("a BIS- deal no operation or account has is critical on live and a warning on demo; a deal made outside the CRM is a warning on live only", async () => {
      const c = await makeClient();
      const live = await openAccount(c);
      const demo = await openAccount(c, { server: "demo" });
      const unknown = addDeal(live, { at: Date.now() - HOUR, amount: 50_000, comment: "BIS-TZZZZ9999" });
      const unknownDemo = addDeal(demo, { at: Date.now() - HOUR, amount: 50_000, comment: "BIS-DZZZZ9999" });
      const manual = addDeal(live, { at: Date.now() - HOUR, amount: 20_000, comment: "Deposit by bank" });
      const bonus = addDeal(live, { at: Date.now() - HOUR, amount: 1_000, comment: "", action: 6 });
      // A charge is not a deal the CRM makes, whatever its comment says.
      const charge = addDeal(live, { at: Date.now() - HOUR, amount: -300, comment: "BIS-TQQQQ9999", action: 4 });
      addDeal(demo, { at: Date.now() - HOUR, amount: 20_000, comment: "Top up by dealer" });
      // A deal carrying an account's opening reference belongs to the CRM.
      const ref = (await one<{ create_ref: string }>(env.db, "SELECT create_ref FROM mt5_accounts WHERE id = ?", [live.id]))!.create_ref;
      addDeal(live, { at: Date.now() - HOUR, amount: 1, comment: ref });
      const r = await run();
      expect((await listed()).sort()).toEqual(
        [
          `unknown_bis_deal:live:${unknown.ticket} critical`, `unknown_bis_deal:demo:${unknownDemo.ticket} warning`,
          `external_balance_deal:live:${manual.ticket} warning`, `external_balance_deal:live:${bonus.ticket} warning`,
          `external_balance_deal:live:${charge.ticket} warning`,
        ].sort(),
      );
      expect(r).toMatchObject({ issues_found: 5, critical_found: 1 });
      expect((await issue(`external_balance_deal:live:${manual.ticket}`))!).toMatchObject({
        mt5_account_id: live.id, client_id: c, deal_ticket: manual.ticket, details: { server: "live", login: live.login, action: 2, amountCents: 20_000, comment: "Deposit by bank" },
      });
      expect(criticalLogged()).toEqual([`unknown_bis_deal:live:${unknown.ticket}`]);
    });

    it("an open account MT5 does not return, and an MT5 account no CRM row has, are warnings (info on demo)", async () => {
      const c = await makeClient();
      const gone = await openAccount(c);
      fake.users.delete(`live:${gone.login}`);
      const moved = await openAccount(c, { server: "demo" });
      fake.user("demo", moved.login)!.group = "demo\\other";
      const kept = await openAccount(c);
      const stranger = fake.addUser("live", { group: STANDARD });
      const demoStranger = fake.addUser("demo", { group: DEMO_GROUP });
      // A group no package uses is not the CRM's to list.
      fake.addUser("live", { group: "real\\raw" });

      const r = await run();
      expect((await listed()).sort()).toEqual(
        [
          `account_missing:${gone.id} warning`, `account_missing:${moved.id} info`,
          `unlinked_mt5_account:live:${stranger.login} warning`, `unlinked_mt5_account:demo:${demoStranger.login} info`,
        ].sort(),
      );
      expect(r).toMatchObject({ accounts_total: 3, accounts_checked: 3, critical_found: 0 });
      expect((await issue(`account_missing:${gone.id}`))!.details).toEqual({ server: "live", login: gone.login, demo: false, reason: "not_found" });
      expect((await issue(`account_missing:${moved.id}`))!.details).toMatchObject({ reason: "group_not_allowed" });
      expect((await issue(`unlinked_mt5_account:live:${stranger.login}`))!).toMatchObject({ mt5_account_id: null, client_id: null, details: { group: STANDARD, login: stranger.login } });
      expect(await issue(`account_missing:${kept.id}`)).toBeUndefined();

      // The stranger gets a CRM row, the missing account is closed in the CRM: both resolve.
      await exec(
        env.db,
        "INSERT INTO mt5_accounts (client_id, server_code, login, is_demo, package_name, mt5_group, leverage, status, create_ref) VALUES (?, 'live', ?, 0, 'Classic', ?, 2000, 'active', ?)",
        [c, stranger.login, STANDARD, mt5Reference("A")],
      );
      await exec(env.db, "UPDATE mt5_accounts SET status = 'failed', login = NULL WHERE id = ?", [gone.id]);
      await run();
      expect(await listed()).toEqual(expect.arrayContaining([`account_missing:${moved.id} info`, `unlinked_mt5_account:demo:${demoStranger.login} info`]));
      expect(await issue(`unlinked_mt5_account:live:${stranger.login}`)).toMatchObject({ status: "resolved" });
      expect(await issue(`account_missing:${gone.id}`)).toMatchObject({ status: "resolved" });
    });

    it("waits to list a group while an account in it is being opened, and skips a server MT5 cannot reach", async () => {
      const c = await makeClient();
      const stranger = fake.addUser("live", { group: STANDARD });
      await exec(
        env.db,
        "INSERT INTO mt5_accounts (client_id, server_code, login, is_demo, package_name, mt5_group, leverage, status, create_ref) VALUES (?, 'live', NULL, 0, 'Classic', ?, 2000, 'creating', ?)",
        [c, STANDARD, mt5Reference("A")],
      );
      const r = await run();
      expect(await issue(`unlinked_mt5_account:live:${stranger.login}`)).toBeUndefined();
      expect(r.notes).toContain("an account there is still being opened");

      await exec(env.db, "DELETE FROM mt5_accounts WHERE status = 'creating'");
      const a = await openAccount(c);
      fake.failNext("deals.page", { kind: "unavailable" }, 1, (req) => req.server === "live");
      const off = await run();
      expect(off).toMatchObject({ status: "done", accounts_total: 1, accounts_checked: 0 });
      expect(off.notes).toContain("could not be synced");
      expect(off.notes).toContain("Accounts in live group real\\standard were not listed");
      // Nothing about the account or the stranger: MT5 was not read.
      expect((await issues()).filter((i) => i.mt5_account_id === a.id || i.issue_key.includes(String(stranger.login)))).toEqual([]);
    });
  });

  describe("keys, reopening and resolving", () => {
    it("keeps one row per issue across runs; a person's resolution stands unless the facts change; a state still true reopens", async () => {
      const a = await openAccount(await makeClient());
      const manual = addDeal(a, { at: Date.now() - HOUR, amount: 20_000, comment: "Deposit by bank" });
      const stuck = await insertOp(a, { status: "unknown", createdAt: Date.now() - 2 * HOUR });
      const first = await run();
      const deal = (await issue(`external_balance_deal:live:${manual.ticket}`))!;
      const open = (await issue(`unsettled_op:${stuck.id}`))!;
      expect([deal.status, open.status]).toEqual(["open", "open"]);

      for (const i of [deal, open]) {
        await exec(env.db, "UPDATE mt5_recon_issues SET status = 'resolved', resolved_by = ?, resolved_at = CURRENT_TIMESTAMP(3), resolved_note = 'Checked with dealing' WHERE id = ?", [
          finance.staffId, i.id,
        ]);
      }
      // The deal is read again (it was cached in the last ten minutes) and found just as it was; the operation is still stuck.
      const second = await run();
      expect(await issues()).toHaveLength(2);
      expect(await issue(deal.issue_key)).toMatchObject({ status: "resolved", resolved_by: finance.staffId, first_run_id: first.id, last_run_id: second.id, reopened: 0 });
      expect(await issue(open.issue_key)).toMatchObject({ status: "open", resolved_by: null, resolved_note: null, reopened: 1, last_run_id: second.id });
      expect(second.issues_new).toBe(1);

      // The same deal key with other facts (MT5 changed the deal's comment) reopens it.
      await exec(env.db, "UPDATE mt5_recon_issues SET fingerprint = REPEAT('0', 64) WHERE id = ?", [deal.id]);
      await run();
      expect(await issue(deal.issue_key)).toMatchObject({ status: "open", reopened: 1 });
    });

    it("an issue a run resolved comes back if a later run finds it again", async () => {
      const a = await openAccount(await makeClient());
      const stuck = await insertOp(a, { status: "unknown", createdAt: Date.now() - 2 * HOUR });
      await run();
      await exec(env.db, "UPDATE mt5_balance_ops SET created_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [stuck.id]);
      await run();
      expect(await issue(`unsettled_op:${stuck.id}`)).toMatchObject({ status: "resolved", resolved_by: null });
      await exec(env.db, "UPDATE mt5_balance_ops SET created_at = ? WHERE id = ?", [new Date(Date.now() - 2 * HOUR), stuck.id]);
      await run();
      expect(await issue(`unsettled_op:${stuck.id}`)).toMatchObject({ status: "open", reopened: 1 });
    });

    it("an MT5 account no CRM row has, or one MT5 does not return, stays resolved while it is just as the person found it", async () => {
      const c = await makeClient();
      const moved = await openAccount(c);
      fake.user("live", moved.login)!.group = "real\\other";
      const stranger = fake.addUser("live", { group: STANDARD });
      await run();
      const keys = [`account_missing:${moved.id}`, `unlinked_mt5_account:live:${stranger.login}`];
      expect((await listed()).sort()).toEqual([`${keys[0]} warning`, `${keys[1]} warning`]);
      const note = "Old CRM client, import pending";
      await exec(env.db, `UPDATE mt5_recon_issues SET status = 'resolved', resolved_by = ?, resolved_at = CURRENT_TIMESTAMP(3), resolved_note = ? WHERE status = 'open'`, [finance.staffId, note]);

      // Found again just as they were: the person's resolution stands, and they are neither counted nor new.
      const second = await run();
      expect(second).toMatchObject({ status: "done", issues_found: 0, issues_new: 0 });
      for (const key of keys) expect(await issue(key)).toMatchObject({ status: "resolved", resolved_by: finance.staffId, resolved_note: note, reopened: 0, last_run_id: second.id });

      // What is found changes (MT5 no longer has the account at all): it opens again.
      fake.users.delete(`live:${moved.login}`);
      const third = await run();
      expect(third.issues_new).toBe(1);
      expect(await issue(keys[0]!)).toMatchObject({ status: "open", reopened: 1, resolved_by: null, details: { reason: "not_found" } });
      expect(await issue(keys[1]!)).toMatchObject({ status: "resolved", resolved_by: finance.staffId });
    });

    it("a critical issue a person resolved, found again just as it was, is not counted or logged as critical", async () => {
      const a = await openAccount(await makeClient());
      const op = await insertOp(a, { ticket: 9_200_001 });
      expect(await run()).toMatchObject({ issues_found: 1, critical_found: 1 });
      await exec(env.db, "UPDATE mt5_recon_issues SET status = 'resolved', resolved_by = ?, resolved_at = CURRENT_TIMESTAMP(3), resolved_note = 'Explained by dealing, ticket 42' WHERE status = 'open'", [
        finance.staffId,
      ]);
      lines.length = 0;
      const second = await run();
      expect(second).toMatchObject({ status: "done", issues_found: 0, issues_new: 0, critical_found: 0 });
      expect(await issue(`op_without_deal:${op.id}`)).toMatchObject({ status: "resolved", resolved_by: finance.staffId, last_run_id: second.id });
      expect(lines.filter((l) => l.level === "error")).toEqual([]);
      expect(lines.at(-1)).toMatchObject({ level: "info", msg: "MT5 reconciliation run ended" });
    });
  });

  describe("runs", () => {
    it("runs one at a time across processes", async () => {
      const claimed = (await claimRun(env.db, { kind: "manual", staffId: finance.staffId }))!;
      await expect(run()).rejects.toBeInstanceOf(RunBusy);
      expect(await claimRun(env.db, { kind: "nightly", runDate: "2031-01-01" })).toBeNull();
      await exec(env.db, "UPDATE mt5_recon_runs SET status = 'done', finished_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [claimed.id]);
      expect((await run()).status).toBe("done");
    });

    it("starts the nightly run from the configured UTC hour, once a day however many processes tick", async () => {
      const night = (iso: string) => reconciliationTick(env.db, fake, log, { hourUtc: 2, now: new Date(iso) });
      expect(await night("2031-03-04T01:59:00Z")).toBeNull();
      expect(await rows(env.db, "SELECT id FROM mt5_recon_runs")).toEqual([]);
      // Three processes tick in the same minute: one runs it.
      const results = await Promise.all([night("2031-03-04T02:00:00Z"), night("2031-03-04T02:00:01Z"), night("2031-03-04T02:00:02Z")]);
      const ran = results.filter((r): r is RunRow => r !== null);
      expect(ran).toHaveLength(1);
      expect(ran[0]).toMatchObject({ kind: "nightly", status: "done", started_by: null });
      expect(ran[0]!.run_date!.toISOString()).toBe("2031-03-04T00:00:00.000Z");
      expect(await night("2031-03-04T23:59:00Z")).toBeNull();
      expect((await night("2031-03-05T02:30:00Z"))?.run_date?.toISOString()).toBe("2031-03-05T00:00:00.000Z");
      expect((await rows(env.db, "SELECT id FROM mt5_recon_runs WHERE kind = 'nightly'")).length).toBe(2);
    });

    it("takes over a nightly run whose process stopped, up to three attempts, and marks a stopped manual run failed", async () => {
      const stale = (kind: "nightly" | "manual", attempts: number, runDate: string | null) =>
        exec(
          env.db,
          `INSERT INTO mt5_recon_runs (kind, run_date, owner, attempts, started_by, heartbeat_at, started_at) VALUES (?, ?, REPEAT('a', 32), ?, ?, ?, ?)`,
          [kind, runDate, attempts, kind === "manual" ? finance.staffId : null, new Date(Date.now() - 20 * MINUTE), new Date(Date.now() - HOUR)],
        );
      const before = { hourUtc: 2, now: new Date("2031-04-01T00:30:00Z") };
      const taken = (await stale("nightly", 1, "2031-03-31")).insertId;
      // Any process takes it over, at any hour.
      const again = await reconciliationTick(env.db, fake, log, before);
      expect(again).toMatchObject({ id: taken, status: "done", attempts: 2 });
      expect(lines.some((l) => l.level === "warn" && l.obj.runId === taken)).toBe(true);

      const tired = (await stale("nightly", MAX_ATTEMPTS, "2031-03-30")).insertId;
      expect(await reconciliationTick(env.db, fake, log, before)).toBeNull();
      expect(await one(env.db, "SELECT status, error FROM mt5_recon_runs WHERE id = ?", [tired])).toMatchObject({
        status: "failed", error: expect.stringContaining("3 times"),
      });
      const manual = (await stale("manual", 1, null)).insertId;
      expect(await reconciliationTick(env.db, fake, log, before)).toBeNull();
      expect(await one(env.db, "SELECT status, error FROM mt5_recon_runs WHERE id = ?", [manual])).toMatchObject({ status: "failed", error: expect.stringContaining("Start a new run") });
      expect(lines.filter((l) => l.level === "error" && /marked failed/.test(l.msg)).map((l) => l.obj.runId)).toEqual([tired, manual]);
    });

    it("a run another process took over stops at its next heartbeat without recording an ending", async () => {
      await openAccount(await makeClient());
      const listing = fake.pause("users.list");
      const running = run();
      await listing.reached;
      await exec(env.db, "UPDATE mt5_recon_runs SET owner = REPEAT('b', 32) WHERE status = 'running'");
      listing.release();
      const r = await running;
      expect(r).toMatchObject({ status: "running", finished_at: null });
      expect(lines.some((l) => l.level === "warn" && /took this MT5 reconciliation run over/.test(l.msg))).toBe(true);
    });

    it("a run that fails inside the CRM is marked failed and the next run starts afresh", async () => {
      await openAccount(await makeClient());
      const call = fake.call.bind(fake);
      fake.call = (async (op: string, req: never) => (op === "users.list" ? { total: 1, logins: null } : call(op as never, req))) as typeof fake.call;
      let r: RunRow;
      try {
        r = await run();
      } finally {
        fake.call = call;
      }
      expect(r).toMatchObject({ status: "failed", error: "The run failed inside the CRM; the server log has the details." });
      expect(r.finished_at).toBeInstanceOf(Date);
      expect(lines.some((l) => l.level === "error" && l.msg === "MT5 reconciliation run failed")).toBe(true);
      expect((await run()).status).toBe("done");
    });

    it("keeps each run's work within its limits, and the next run carries on", async () => {
      const a = await openAccount(await makeClient());
      // Three outside deals, all stored by one sync page in one millisecond.
      const deals = [1, 2, 3].map((n) => addDeal(a, { at: Date.now() - HOUR + n * 1000, amount: n * 100, comment: `manual ${n}` }));
      const ops = [];
      for (let i = 0; i < 3; i++) ops.push(await insertOp(a, { status: "failed" }));
      const first = await run({ maxDeals: 2, maxOps: 2 });
      expect(first.notes).toContain("More than 2 newly cached or changed balance-type deals");
      expect(first.notes).toContain("More than 2 operations to check");
      expect(await issues()).toHaveLength(2);
      expect((await checks()).size).toBe(2);
      const second = await run({ maxDeals: 2, maxOps: 2 });
      expect((await listed()).sort()).toEqual(deals.map((d) => `external_balance_deal:live:${d.ticket} warning`).sort());
      expect((await checks()).size).toBe(3);
      expect(second.notes ?? "").not.toContain("operations to check");
    });

    describe("a run that stops after reading new deals", () => {
      /**
       * An operation the last run was done with (failed, MT5 had nothing), whose deal MT5 then files after all: the money moved
       * although the CRM gave it back. As in production, the last run was a day ago and the background sync cached the deal an
       * hour before this run, so only the run that reads it from the cache brings the operation back.
       */
      async function doneWithThenPaid() {
        const a = await openAccount(await makeClient());
        const op = await insertOp(a, { status: "failed" });
        await run();
        expect((await checks()).get(op.id)).toMatchObject({ outcome: "no_deal" });
        addDeal(a, { at: Date.now() - 2 * HOUR, amount: 10_000, comment: op.reference, action: 3 });
        expect((await syncAccountDeals(env.db, fake, a.id, log)).newDeals).toBe(1);
        await exec(env.db, "UPDATE mt5_deals SET created_at = ? WHERE comment = ?", [new Date(Date.now() - HOUR), op.reference]);
        await exec(env.db, "UPDATE mt5_recon_runs SET next_deals_from = ?", [new Date(Date.now() - DAY)]);
        return op;
      }
      const opChecks = /LEFT JOIN mt5_recon_op_checks k ON k\.op_id = o\.id/;

      it("leaves the operations those deals name to the next run when it fails", async () => {
        const op = await doneWithThenPaid();
        // Read the deal, then lost the database while checking operations.
        expect(await runReconciliation(failing(env.db, [opChecks]), fake, log, { kind: "manual", staffId: finance.staffId })).toMatchObject({ status: "failed" });
        expect(await run()).toMatchObject({ status: "done", critical_found: 1 });
        expect(await listed()).toEqual([`failed_op_has_deal:${op.id} critical`]);
        expect((await checks()).has(op.id)).toBe(false);
      });

      it("leaves them to the process that takes the run over when its own process ends", async () => {
        const op = await doneWithThenPaid();
        // The process ends while checking operations: nothing records how the run ended.
        const claimed = (await claimRun(env.db, { kind: "nightly", runDate: "2031-06-01" }))!;
        expect(await runClaimed(failing(env.db, [opChecks, /UPDATE mt5_recon_runs SET status = \?/]), fake, log, claimed)).toMatchObject({ status: "running" });
        await exec(env.db, "UPDATE mt5_recon_runs SET heartbeat_at = ? WHERE id = ?", [new Date(Date.now() - 20 * MINUTE), claimed.id]);
        const again = await reconciliationTick(env.db, fake, log, { hourUtc: 2, now: new Date("2031-06-01T00:30:00Z") });
        expect(again).toMatchObject({ id: claimed.id, status: "done", attempts: 2, critical_found: 1 });
        expect(await listed()).toEqual([`failed_op_has_deal:${op.id} critical`]);
      });
    });

    it("the scheduler does nothing when MT5 is off", () => {
      const stop = startMt5Reconciliation(env.db, null, { ...log, child: () => log } as never, 2);
      expect(lines.some((l) => /MT5 is not reconciled/.test(String(l.obj)))).toBe(true);
      stop();
    });
  });

  describe("staff API", () => {
    const base = "/api/staff/mt5/reconciliation";

    it("starts a run (wallet.reconcile, audited), refuses a second while it runs, and lists runs to wallet.view", async () => {
      await openAccount(await makeClient());
      expect((await post(auditor, `${base}/runs`)).status).toBe(403);
      expect((await post(support, `${base}/runs`)).status).toBe(403);
      const listing = fake.pause("users.list");
      const started = await post(finance, `${base}/runs`);
      expect(started.status).toBe(202);
      expect(started.body.run).toMatchObject({ kind: "manual", status: "running", runDate: null, startedBy: { id: finance.staffId, name: "finance" } });
      await listing.reached;
      const busy = await post(finance, `${base}/runs`);
      expect(busy.status).toBe(409);
      expect(busy.body.error).toMatchObject({ code: "RUN_RUNNING", message: "A reconciliation run is already running. Wait for it to finish." });
      const summary = await auditor.agent.get(`${base}/summary`);
      expect(summary.body.running).toMatchObject({ id: started.body.run.id, status: "running" });
      listing.release();
      await activeRun();
      const audit = await one<{ actor_id: number; entity_type: string; entity_id: string }>(env.db, "SELECT actor_id, entity_type, entity_id FROM audit_log WHERE action = 'mt5.reconciliation.run_started'");
      expect(audit).toMatchObject({ actor_id: finance.staffId, entity_type: "mt5_recon_run", entity_id: String(started.body.run.id) });

      const list = await auditor.agent.get(`${base}/runs`);
      expect(list.status).toBe(200);
      expect(list.body).toMatchObject({ total: 1, page: 1, items: [{ id: started.body.run.id, status: "done", accountsTotal: 1, accountsChecked: 1, issuesFound: 0 }] });
      expect((await auditor.agent.get(`${base}/runs/${started.body.run.id}`)).body.run).toMatchObject({ id: started.body.run.id, status: "done" });
      expect((await auditor.agent.get(`${base}/runs/999999`)).status).toBe(404);
      expect((await support.agent.get(`${base}/runs`)).status).toBe(403);
      expect((await post(finance, `${base}/runs`, { force: true })).status).toBe(400);
    });

    it("lists issues by severity, filtered and scoped to the clients a staff member may see", async () => {
      const mine = await makeClient(scoped.staffId);
      const other = await makeClient();
      const a = await openAccount(mine);
      const b = await openAccount(other);
      const unknown = addDeal(a, { at: Date.now() - HOUR, amount: 50_000, comment: "BIS-TYYYY9999" });
      const manual = addDeal(b, { at: Date.now() - HOUR, amount: 20_000, comment: "Deposit" });
      const stranger = fake.addUser("live", { group: STANDARD });
      const r = await run();

      const all = await finance.agent.get(`${base}/issues`);
      expect(all.status).toBe(200);
      // Critical first, then the newest: the stranger was found (listing MT5's groups) before the deals were read.
      expect(all.body.items.map((i: { key: string }) => i.key)).toEqual([
        `unknown_bis_deal:live:${unknown.ticket}`, `external_balance_deal:live:${manual.ticket}`, `unlinked_mt5_account:live:${stranger.login}`,
      ]);
      expect(all.body.items[0]).toMatchObject({
        kind: "unknown_bis_deal", severity: "critical", status: "open", accountId: a.id, login: a.login, serverCode: "live", isDemo: false, clientId: mine,
        clientName: "Ria Moss", dealTicket: unknown.ticket, firstRunId: r.id, lastRunId: r.id, canResolve: true, resolvedAutomatically: false,
        details: { comment: "BIS-TYYYY9999", amountCents: 50_000 },
      });
      const keysOf = async (s: SignedIn, query: string) => (await s.agent.get(`${base}/issues${query}`)).body.items.map((i: { key: string }) => i.key);
      expect(await keysOf(finance, "?severity=warning&kind=external_balance_deal")).toEqual([`external_balance_deal:live:${manual.ticket}`]);
      expect(await keysOf(finance, `?clientId=${other}`)).toEqual([`external_balance_deal:live:${manual.ticket}`]);
      expect(await keysOf(finance, `?q=${stranger.login}`)).toEqual([`unlinked_mt5_account:live:${stranger.login}`]);
      expect(await keysOf(finance, `?runId=${r.id}&status=all`)).toHaveLength(3);
      expect(await keysOf(finance, "?status=resolved")).toEqual([]);
      expect((await finance.agent.get(`${base}/issues?severity=loud`)).status).toBe(400);
      // Only their own client's; an issue about no client, or another's, is not theirs.
      expect(await keysOf(scoped, "")).toEqual([`unknown_bis_deal:live:${unknown.ticket}`]);
      expect((await auditor.agent.get(`${base}/issues`)).body.items.every((i: { canResolve: boolean }) => !i.canResolve)).toBe(true);
      const theirs = (await issue(`external_balance_deal:live:${manual.ticket}`))!;
      expect((await scoped.agent.get(`${base}/issues/${theirs.id}`)).status).toBe(404);
      expect((await support.agent.get(`${base}/issues`)).status).toBe(403);

      const summary = await finance.agent.get(`${base}/summary`);
      expect(summary.body).toMatchObject({ open: { critical: 1, warning: 2, info: 0 }, lastRun: { id: r.id, status: "done" }, running: null });
      expect((await scoped.agent.get(`${base}/summary`)).body.open).toEqual({ critical: 1, warning: 0, info: 0 });
    });

    it("shows what a run counted across the broker only to staff who see every client", async () => {
      const mine = await makeClient(scoped.staffId);
      const a = await openAccount(mine);
      const b = await openAccount(await makeClient());
      addDeal(a, { at: Date.now() - HOUR, amount: 50_000, comment: "BIS-TVVVV9999" });
      addDeal(b, { at: Date.now() - HOUR, amount: 20_000, comment: "Deposit" });
      for (let i = 0; i < 2; i++) await insertOp(b, { status: "failed" });
      const r = await run({ maxOps: 1 });
      const counted = { accountsTotal: 2, accountsChecked: 2, issuesFound: 2, issuesNew: 2, criticalFound: 1, notes: expect.stringContaining("More than 1 operations") };
      expect((await finance.agent.get(`${base}/runs/${r.id}`)).body.run).toMatchObject(counted);
      expect((await finance.agent.get(`${base}/summary`)).body.lastRun).toMatchObject(counted);

      // Staff who see only their own clients get the run, without the broker's counts.
      const hidden = { accountsTotal: null, accountsChecked: null, issuesFound: null, issuesNew: null, criticalFound: null, notes: null };
      expect((await scoped.agent.get(`${base}/runs`)).body.items).toEqual([expect.objectContaining({ id: r.id, status: "done", ...hidden })]);
      expect((await scoped.agent.get(`${base}/runs/${r.id}`)).body.run).toMatchObject({ id: r.id, ...hidden });
      expect((await scoped.agent.get(`${base}/summary`)).body).toMatchObject({ open: { critical: 1, warning: 0, info: 0 }, lastRun: { id: r.id, ...hidden }, running: null });
      const listing = fake.pause("users.list");
      const running = run();
      await listing.reached;
      expect((await finance.agent.get(`${base}/summary`)).body.running).toMatchObject({ status: "running", accountsTotal: 2 });
      expect((await scoped.agent.get(`${base}/summary`)).body.running).toMatchObject({ status: "running", ...hidden });
      listing.release();
      await running;
    });

    it("resolves an issue with a note, after a fresh 2FA code, in the audit log; never twice", async () => {
      const c = await makeClient();
      const a = await openAccount(c);
      const unknown = addDeal(a, { at: Date.now() - HOUR, amount: 50_000, comment: "BIS-TXXXX9999" });
      await run();
      const id = (await issue(`unknown_bis_deal:live:${unknown.ticket}`))!.id;
      const url = `${base}/issues/${id}/resolve`;
      const note = "Dealing reversed it by hand, see ticket 4471";
      expect((await post(auditor, url, { note })).status).toBe(403);
      const noCode = await post(finance, url, { note });
      expect(noCode.status).toBe(403);
      expect(noCode.body.error.code).toBe("STEP_UP_REQUIRED");
      await stepUp(env, finance);
      expect((await post(finance, url, { note: "short" })).status).toBe(400);
      expect((await post(finance, url, { note: "See <a href=x>this</a> page" })).status).toBe(400);
      const done = await post(finance, url, { note });
      expect(done.status).toBe(200);
      expect(done.body.issue).toMatchObject({ id, status: "resolved", resolvedBy: { id: finance.staffId }, resolvedNote: note, resolvedAutomatically: false, canResolve: false });
      const again = await post(finance, url, { note });
      expect(again.status).toBe(409);
      const audit = await one<{ entity_type: string; entity_id: string; meta_json: Record<string, unknown> }>(
        env.db, "SELECT entity_type, entity_id, meta_json FROM audit_log WHERE action = 'mt5.reconciliation.issue_resolved'",
      );
      expect(audit).toMatchObject({ entity_type: "client", entity_id: String(c), meta_json: { issueId: id, kind: "unknown_bis_deal", severity: "critical", dealTicket: unknown.ticket, internalNote: note } });

      // Found again just as it was: it stays resolved.
      await run();
      expect(await issue(`unknown_bis_deal:live:${unknown.ticket}`)).toMatchObject({ status: "resolved", resolved_by: finance.staffId });
    });

    it("answers MT5_OFF when MT5 is not connected", async () => {
      const off = await setupOff();
      try {
        expect((await post(off.finance, `${base}/runs`)).body.error).toMatchObject({ code: "MT5_OFF" });
      } finally {
        await off.close();
      }
    });
  });

  /** The same database, served by an app without a gateway. */
  async function setupOff() {
    const { createApp } = await import("../src/server/app");
    const pino = (await import("pino")).default;
    const app = createApp({ db: env.db, config: env.config, log: pino({ level: "silent" }), fetch: (async () => new Response("", { status: 503 })) as typeof fetch });
    const offEnv = { ...env, app };
    const email = `finance.off.${Date.now()}@crm.test`;
    await createStaff(env.db, email, "finance_manager");
    return { finance: await signIn(offEnv, email), close: async () => undefined };
  }
});

describe.skipIf(!hasDb)("MT5 reconciliation of the ledger", () => {
  let env: TestEnv;
  const fake = new FakeGateway();
  let staffId: number;

  beforeAll(async () => {
    env = await setup({}, { mt5: fake });
    await exec(env.db, "INSERT INTO mt5_servers (code, label, is_enabled) VALUES ('live', 'Live', 1), ('demo', 'Demo', 1)");
    await exec(env.db, "INSERT INTO account_packages (name, spread_label, server_code, mt5_group) VALUES ('Classic', '1.0', 'live', ?)", [STANDARD]);
    staffId = await createStaff(env.db, "finance@crm.test", "finance_manager");
  }, 120_000);
  afterAll(async () => env?.db.end());

  it("a staff balance change made through MT5 reconciles with the ledger; a funding line that does not add up is critical", async () => {
    const client = (
      await exec(env.db, "INSERT INTO clients (email, first_name, last_name, referral_code, source, kyc_status, status) VALUES ('ledger@client.test', 'Lea', 'Dorn', 'TL00000001', 'portal', 'approved', 'active')")
    ).insertId;
    const user = fake.addUser("live", { group: STANDARD });
    const account = (
      await exec(
        env.db,
        `INSERT INTO mt5_accounts (client_id, server_code, login, is_demo, package_name, mt5_group, leverage, status, create_ref, created_at)
         VALUES (?, 'live', ?, 0, 'Classic', ?, 2000, 'active', ?, ?)`,
        [client, user.login, STANDARD, mt5Reference("A"), new Date(Date.now() - 30 * DAY)],
      )
    ).insertId;
    const op = await transaction(env.db, (conn) =>
      insertBalanceOp(conn, {
        purpose: "staff_balance_in", clientId: client, accountId: account, serverCode: "live", login: user.login, amountCents: 30_000, ip: "127.0.0.1",
        staff: { requestedBy: staffId, reasonCode: "compensation", note: "Compensation for the outage", awaitingApproval: false },
      }),
    );
    expect((await runBalanceOp({ db: env.db, mt5: fake, log }, op.id)).status).toBe("completed");

    const clean = await runReconciliation(env.db, fake, log, { kind: "manual", staffId });
    expect(clean).toMatchObject({ status: "done", issues_found: 0 });

    // A debit from the account's funding line that no operation made.
    await transaction(env.db, (conn) =>
      postLedger(conn, { kind: "mt5_adjust_out", sourceType: "mt5_op", sourceId: op.id, clientId: client, staffId, memo: "Test: a stray debit" }, [
        { account: MT5_ADJUSTMENTS_ACCOUNT, amount: 500 }, { account: mt5FundingAccount(account), amount: -500 },
      ]),
    );
    const found = await runReconciliation(env.db, fake, log, { kind: "manual", staffId });
    const open = await rows<{ issue_key: string; kind: string; severity: string; details: Record<string, unknown> }>(
      env.db, "SELECT issue_key, kind, severity, details FROM mt5_recon_issues WHERE status = 'open'",
    );
    expect(new Set(open.map((i) => `${i.kind} ${i.severity}`))).toEqual(new Set(["funding_mismatch critical", "ledger_problem critical"]));
    expect(open.filter((i) => i.kind === "funding_mismatch")).toEqual([
      expect.objectContaining({
        issue_key: `funding_mismatch:${account}`, details: { fundingAccount: mt5FundingAccount(account), ledgerCents: 29_500, operationsCents: 30_000, server: "live", login: user.login },
      }),
    ]);
    expect(open.some((i) => i.kind === "ledger_problem" && String(i.details.problem).includes(op.reference))).toBe(true);
    expect(found.critical_found).toBe(open.length);
    // Found again: the same rows, none added.
    await runReconciliation(env.db, fake, log, { kind: "manual", staffId });
    expect(await rows(env.db, "SELECT id FROM mt5_recon_issues")).toHaveLength(open.length);
  });

  it("a ledger problem stays one open issue while the money around it moves, and shows the latest amounts", async () => {
    const client = (
      await exec(env.db, "INSERT INTO clients (email, first_name, last_name, referral_code, source, kyc_status, status) VALUES ('ledger.gap@client.test', 'Lea', 'Dorn', 'TL00000002', 'portal', 'approved', 'active')")
    ).insertId;
    const user = fake.addUser("live", { group: STANDARD });
    const account = (
      await exec(
        env.db,
        `INSERT INTO mt5_accounts (client_id, server_code, login, is_demo, package_name, mt5_group, leverage, status, create_ref, created_at)
         VALUES (?, 'live', ?, 0, 'Classic', ?, 2000, 'active', ?, ?)`,
        [client, user.login, STANDARD, mt5Reference("A"), new Date(Date.now() - 30 * DAY)],
      )
    ).insertId;
    // The wallet cache is 500 cents over its entries (it has none).
    await walletOf(env.db, client);
    await exec(env.db, "UPDATE wallets SET available_cents = 500 WHERE client_id = ?", [client]);
    // This client's ledger problems, whatever their status (the test above leaves its own open).
    const theirs = async () =>
      (await rows<{ issue_key: string; status: string; severity: string; first_run_id: number; last_run_id: number; details: { problem: string } }>(
        env.db, "SELECT issue_key, status, severity, first_run_id, last_run_id, details FROM mt5_recon_issues WHERE kind = 'ledger_problem' ORDER BY id",
      ))
        .filter((i) => i.details.problem.startsWith(`Client ${client}:`))
        .map((i) => ({ ...i, first_run_id: Number(i.first_run_id), last_run_id: Number(i.last_run_id) }));

    const first = await runReconciliation(env.db, fake, log, { kind: "manual", staffId });
    const before = await theirs();
    expect(before).toEqual([expect.objectContaining({ status: "open", severity: "critical", details: { problem: `Client ${client}: wallet shows 500 cents but the ledger adds up to 0.` } })]);

    // The client moves 200 to MT5: the operation and its hold are written as the request writes them. The cache is still 500 over.
    await transaction(env.db, async (conn) => {
      const op = await insertBalanceOp(conn, { purpose: "wallet_to_mt5", clientId: client, accountId: account, serverCode: "live", login: user.login, amountCents: 200, ip: "127.0.0.1" });
      await postLedger(conn, { kind: "transfer_hold", sourceType: "mt5_op", sourceId: op.id, clientId: client, staffId: null, memo: `Transfer ${op.reference}, MT5 ${user.login}` }, [
        { account: walletAccount(client), amount: -200 }, { account: holdAccount(client), amount: 200 },
      ]);
    });
    const second = await runReconciliation(env.db, fake, log, { kind: "manual", staffId });
    // The same issue, not resolved as "no longer found" with a new one opened beside it.
    expect(await theirs()).toEqual([
      {
        issue_key: before[0]!.issue_key, status: "open", severity: "critical", first_run_id: first.id, last_run_id: second.id,
        details: { problem: `Client ${client}: wallet shows 300 cents but the ledger adds up to -200.` },
      },
    ]);
  });
});
