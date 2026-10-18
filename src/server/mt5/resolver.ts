import type { Logger } from "pino";
import type { Mt5Deal } from "../../gateway/protocol";
import { lockClient } from "../clients/kyc";
import { writeAudit, type AuditContext } from "../lib/audit";
import { exec, rows, transaction, type Conn, type Db } from "../lib/db";
import { activateAccount, loadAccount, withAccountLock } from "./accounts";
import { callMt5 } from "./errors";
import { GatewayError, type Mt5Gateway } from "./gateway";
import { loadOp, PURPOSES, settleBalanceOp, signedCents, type BalanceOpRow } from "./operations";

// Settles what a lost answer left open: balance operations that are unknown
// (or stuck 'sending' because the process stopped mid-call) and accounts that
// are unknown (or stuck 'creating'). It only ever searches MT5: a deal by its
// reference, an account by its create reference. It never sends a balance
// operation or a create again. Found means done; not found three times, and
// at least ten minutes after the request, means it did not happen.

type Log = Pick<Logger, "info" | "warn" | "error">;

/** While a row is being checked, no other pass takes it. */
const LEASE_MS = 2 * 60_000;
/** A 'sending' or 'creating' row untouched this long was interrupted. */
const STUCK_MINUTES = 2;
export const STUCK_MS = STUCK_MINUTES * 60_000;
const RETRY_UNREACHABLE_MS = 60_000;
/** A deal that does not match, or a search MT5 refuses: staff must look; checked again hourly meanwhile. */
const RECHECK_ODD_MS = 3_600_000;
const GIVE_UP_CHECKS = 3;
/** How old a request must be before it may be settled as never made (by the resolver or by staff). */
export const GIVE_UP_AGE_MS = 10 * 60_000;
/** 2, 4, 8, then every 10 minutes. */
const backoffMs = (checks: number) => Math.min(2 ** checks, 10) * 60_000;
/** How far back from the request a deal or an account is searched for (MT5 times are the trade server's clock). */
const SEARCH_BACK_MS = 24 * 3_600_000;

const SYSTEM: AuditContext = { actor: { type: "system", id: null, label: "MT5 resolver" }, ip: "", userAgent: "" };

const DUE = `(status = 'unknown' AND (next_check_at IS NULL OR next_check_at <= CURRENT_TIMESTAMP(3)))
  OR (status = ? AND updated_at < CURRENT_TIMESTAMP(3) - INTERVAL ${STUCK_MINUTES} MINUTE AND (next_check_at IS NULL OR next_check_at <= CURRENT_TIMESTAMP(3)))`;

/** Claims due rows of one table with a lease, in its own short transaction, so no lock is held while MT5 answers. */
async function claim(db: Db, table: "mt5_balance_ops" | "mt5_accounts", stuck: "sending" | "creating", batch: number): Promise<number[]> {
  return transaction(db, async (conn) => {
    const due = await rows<{ id: number }>(conn, `SELECT id FROM ${table} WHERE ${DUE} ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED`, [stuck, batch]);
    const ids = due.map((r) => Number(r.id));
    if (ids.length) await exec(conn, `UPDATE ${table} SET next_check_at = ? WHERE id IN (${ids.map(() => "?").join(", ")})`, [new Date(Date.now() + LEASE_MS), ...ids]);
    return ids;
  });
}

/** Keeps an operation open (as unknown) and says when to look again. */
const rescheduleOp = (db: Db, id: number, failure: string | null, checks: number, inMs: number) =>
  exec(db, "UPDATE mt5_balance_ops SET status = 'unknown', failure = COALESCE(?, failure), checks = ?, next_check_at = ? WHERE id = ? AND status IN ('sending', 'unknown')", [
    failure, checks, new Date(Date.now() + inMs), id,
  ]);

const rescheduleAccount = (db: Db, id: number, failure: string | null, checks: number, inMs: number) =>
  exec(db, "UPDATE mt5_accounts SET status = 'unknown', failure = COALESCE(?, failure), checks = ?, next_check_at = ? WHERE id = ? AND status IN ('creating', 'unknown')", [
    failure, checks, new Date(Date.now() + inMs), id,
  ]);

export type CheckResult = "completed" | "failed" | "unknown" | "skipped";

const isOpen = (op: BalanceOpRow) => op.status === "sending" || op.status === "unknown";
/** The deal MT5 made for this operation: a balance deal on its login for exactly its signed amount. */
const isItsDeal = (deal: Mt5Deal, op: BalanceOpRow) => deal.action === 2 && deal.login === op.login && deal.profitCents === signedCents(op);
const searchFrom = (row: { created_at: Date }) => new Date(row.created_at.getTime() - SEARCH_BACK_MS).toISOString();

/**
 * Looks for one balance operation's deal in MT5 and settles it when the
 * answer is clear. Returns what happened, and the gateway's error when MT5
 * could not be searched (staff "Check now" shows it).
 *
 * `mayGiveUp: false` is a staff "Check now": a deal it finds completes the
 * operation, but a search that finds nothing neither counts as one of the
 * resolver's searches nor settles it as failed. Only the resolver's own
 * schedule, or a staff "mark failed" (2FA, a note, a name), does that.
 *
 * Checks and staff decisions on one account run one at a time in this
 * process, so a search and a staff "failed" can never cross; the settle
 * itself only moves an operation that is still open, so a second check of a
 * settled one changes nothing.
 */
export async function checkBalanceOpDetailed(
  db: Db,
  gateway: Mt5Gateway | null,
  opId: number,
  log: Log,
  opts: { mayGiveUp?: boolean } = {},
): Promise<{ result: CheckResult; error: GatewayError | null }> {
  const first = await loadOp(db, opId);
  if (!first || !isOpen(first)) return { result: "skipped", error: null };
  return withAccountLock(first.mt5_account_id, async () => {
    const op = (await loadOp(db, opId))!;
    if (!isOpen(op)) return { result: "skipped" as const, error: null };
    if (!gateway) {
      await rescheduleOp(db, op.id, null, op.checks, RETRY_UNREACHABLE_MS);
      return { result: "unknown" as const, error: null };
    }
    let deal: Mt5Deal | null;
    try {
      ({ deal } = await callMt5(gateway, "deal.find", { server: op.server_code, login: op.login, comment: op.reference, from: searchFrom(op) }, log));
    } catch (error) {
      const e = error as GatewayError;
      if (e.kind === "refused" || e.kind === "bad_request") {
        // MT5 or the gateway will not search (the login or its group is no longer allowed): a person must decide.
        log.error({ opId: op.id, reference: op.reference, kind: e.kind, code: e.code }, "MT5 refused to search for a balance operation's deal; staff must check it");
        await rescheduleOp(db, op.id, e.code, op.checks, RECHECK_ODD_MS);
      } else {
        // Not reached: try again soon, and it does not count as a search.
        await rescheduleOp(db, op.id, null, op.checks, RETRY_UNREACHABLE_MS);
      }
      return { result: "unknown" as const, error: e };
    }
    if (deal) {
      if (isItsDeal(deal, op)) {
        const { op: settled, settled: now } = await settleBalanceOp(db, op.id, { status: "completed", ticket: deal.ticket });
        log.info({ opId: op.id, reference: op.reference, ticket: deal.ticket, status: settled.status }, "MT5 balance operation found and settled");
        return { result: now ? ("completed" as const) : ("skipped" as const), error: null };
      }
      log.error(
        { opId: op.id, reference: op.reference, ticket: deal.ticket, action: deal.action, amountCents: deal.profitCents, expected: signedCents(op) },
        "An MT5 deal carries this operation's reference but does not match it; staff must check it",
      );
      await rescheduleOp(db, op.id, "mismatch", op.checks, RECHECK_ODD_MS);
      return { result: "unknown" as const, error: null };
    }
    if (opts.mayGiveUp === false) {
      // Not found yet: still open, and the resolver's next search stays when it was due.
      await exec(db, "UPDATE mt5_balance_ops SET status = 'unknown', failure = 'not_found' WHERE id = ? AND status IN ('sending', 'unknown')", [op.id]);
      return { result: "unknown" as const, error: null };
    }
    const checks = op.checks + 1;
    if (checks >= GIVE_UP_CHECKS && Date.now() - op.created_at.getTime() >= GIVE_UP_AGE_MS) {
      const { settled: now } = await settleBalanceOp(db, op.id, { status: "failed", failure: "not_found", clientMessage: PURPOSES[op.purpose].notFoundMessage });
      log.warn({ opId: op.id, reference: op.reference, checks }, "MT5 balance operation was never made; settled as failed");
      return { result: now ? ("failed" as const) : ("skipped" as const), error: null };
    }
    await rescheduleOp(db, op.id, "not_found", checks, backoffMs(checks));
    return { result: "unknown" as const, error: null };
  });
}

/** Looks for one balance operation's deal in MT5 and settles it when the answer is clear (one resolver step). */
export const checkBalanceOp = async (db: Db, gateway: Mt5Gateway | null, opId: number, log: Log): Promise<CheckResult> =>
  (await checkBalanceOpDetailed(db, gateway, opId, log)).result;

export type StaffFailOutcome =
  | { done: true; op: BalanceOpRow }
  /** settled: something else settled it first; too_new: under ten minutes old; found: MT5 has a deal with its reference. */
  | { done: false; reason: "settled" | "too_new" | "found"; op: BalanceOpRow; deal: Mt5Deal | null };

/**
 * Staff "mark failed": the same settle as the resolver giving up, but now and
 * on a person's word, for an operation still open at least ten minutes after
 * the request whose deal a search made now does not find. Nobody can mark one
 * completed: only a deal found in MT5 does that. A search MT5 cannot answer
 * throws its GatewayError and changes nothing. `audit` runs in the settling
 * transaction.
 */
export async function failBalanceOpByStaff(
  db: Db,
  gateway: Mt5Gateway,
  opId: number,
  by: { staffId: number; note: string },
  audit: (conn: Conn, op: BalanceOpRow) => Promise<void>,
  log: Log,
): Promise<StaffFailOutcome> {
  const first = await loadOp(db, opId);
  if (!first) throw new Error(`MT5 balance operation ${opId} does not exist`);
  return withAccountLock(first.mt5_account_id, async (): Promise<StaffFailOutcome> => {
    const op = (await loadOp(db, opId))!;
    if (!isOpen(op)) return { done: false, reason: "settled", op, deal: null };
    if (Date.now() - op.created_at.getTime() < GIVE_UP_AGE_MS) return { done: false, reason: "too_new", op, deal: null };
    const { deal } = await callMt5(gateway, "deal.find", { server: op.server_code, login: op.login, comment: op.reference, from: searchFrom(op) }, log);
    if (deal) return { done: false, reason: "found", op, deal };
    const { op: settled, settled: now } = await settleBalanceOp(
      db, op.id, { status: "failed", failure: "not_found", clientMessage: PURPOSES[op.purpose].notFoundMessage, staffId: by.staffId, note: by.note }, ["sending", "unknown"], audit,
    );
    if (!now) return { done: false, reason: "settled", op: settled, deal: null };
    log.warn({ opId: op.id, reference: op.reference, staffId: by.staffId }, "MT5 balance operation marked failed by staff after a search found nothing");
    return { done: true, op: settled };
  });
}

/** Looks for the MT5 account a create with a lost answer may have made, and settles the row. */
export async function checkAccount(db: Db, gateway: Mt5Gateway | null, accountId: number, log: Log): Promise<CheckResult> {
  const a = await loadAccount(db, accountId);
  if (!a || (a.status !== "creating" && a.status !== "unknown")) return "skipped";
  if (!gateway) {
    await rescheduleAccount(db, a.id, null, a.checks, RETRY_UNREACHABLE_MS);
    return "unknown";
  }
  let login: number | null;
  try {
    ({ login } = await callMt5(gateway, "user.find", { server: a.server_code, group: a.mt5_group, comment: a.create_ref, from: searchFrom(a) }, log));
  } catch (error) {
    const e = error as GatewayError;
    if (e.kind === "refused" || e.kind === "bad_request") {
      log.error({ accountId: a.id, createRef: a.create_ref, kind: e.kind, code: e.code }, "MT5 refused to search for a created account; staff must check it");
      await rescheduleAccount(db, a.id, e.code, a.checks, RECHECK_ODD_MS);
    } else {
      await rescheduleAccount(db, a.id, null, a.checks, RETRY_UNREACHABLE_MS);
    }
    return "unknown";
  }
  const meta = { accountId: a.id, server: a.server_code, group: a.mt5_group, isDemo: a.is_demo === 1, createRef: a.create_ref, foundBy: "resolver" };
  if (login) {
    let done: boolean;
    try {
      done = await transaction(db, async (conn) => {
        await lockClient(conn, a.client_id);
        // A demo account found this way has no starting balance: the client can top it up.
        if (!(await activateAccount(conn, a.id, login))) return false;
        await writeAudit(conn, SYSTEM, { action: "mt5.account.created", entityType: "client", entityId: a.client_id, meta: { ...meta, login } });
        return true;
      });
    } catch (error) {
      if ((error as { code?: string }).code !== "ER_DUP_ENTRY") throw error;
      // Another row already holds this login on this server: a person must decide which is right.
      log.error({ accountId: a.id, createRef: a.create_ref, login }, "The MT5 account found for this create is already linked to another CRM account; staff must check it");
      await rescheduleAccount(db, a.id, "login_taken", a.checks, RECHECK_ODD_MS);
      return "unknown";
    }
    if (done) log.info({ accountId: a.id, login }, "MT5 account found and opened");
    return done ? "completed" : "skipped";
  }
  const checks = a.checks + 1;
  if (checks >= GIVE_UP_CHECKS && Date.now() - a.created_at.getTime() >= GIVE_UP_AGE_MS) {
    const done = await transaction(db, async (conn) => {
      await lockClient(conn, a.client_id);
      const r = await exec(conn, "UPDATE mt5_accounts SET status = 'failed', failure = 'not_found', checks = ?, next_check_at = NULL WHERE id = ? AND status IN ('creating', 'unknown')", [
        checks, a.id,
      ]);
      if (r.affectedRows !== 1) return false;
      await writeAudit(conn, SYSTEM, { action: "mt5.account.create_failed", entityType: "client", entityId: a.client_id, meta: { ...meta, reason: "not_found" } });
      return true;
    });
    if (done) log.warn({ accountId: a.id, createRef: a.create_ref }, "MT5 account was never created; settled as failed");
    return done ? "failed" : "skipped";
  }
  await rescheduleAccount(db, a.id, "not_found", checks, backoffMs(checks));
  return "unknown";
}

/**
 * One pass: claims due operations and accounts and checks each. A problem
 * with one row is logged and does not stop the others; its lease runs out and
 * a later pass tries again.
 */
export async function resolveMt5Once(db: Db, gateway: Mt5Gateway | null, log: Log, batch = 20) {
  const counts = { ops: 0, accounts: 0 };
  for (const id of await claim(db, "mt5_balance_ops", "sending", batch)) {
    try {
      await checkBalanceOp(db, gateway, id, log);
      counts.ops++;
    } catch (error) {
      log.error({ err: error, opId: id }, "Checking an MT5 balance operation failed");
    }
  }
  for (const id of await claim(db, "mt5_accounts", "creating", batch)) {
    try {
      await checkAccount(db, gateway, id, log);
      counts.accounts++;
    } catch (error) {
      log.error({ err: error, accountId: id }, "Checking an MT5 account failed");
    }
  }
  return counts;
}

/** Runs the resolver every 20 seconds in the server process. */
export function startMt5Resolver(db: Db, gateway: Mt5Gateway | null, log: Logger, everyMs = 20_000) {
  if (!gateway) {
    log.info("MT5 is off: CRM_MT5_GATEWAY_URL is not set, so unconfirmed MT5 work is not checked");
    return () => undefined;
  }
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    resolveMt5Once(db, gateway, log)
      .catch((e) => log.error({ err: e }, "MT5 resolver failed"))
      .finally(() => (running = false));
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
