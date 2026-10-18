import { randomBytes } from "node:crypto";
import type { PoolConnection } from "mysql2/promise";
import type { Logger } from "pino";
import { canonical } from "../lib/audit";
import { sha256 } from "../lib/crypto";
import { exec, one, rows, transaction, type Conn, type Db } from "../lib/db";
import { verifyLedgerProblems } from "../money/ledger";
import { syncAccountDeals } from "./deals";
import { callMt5 } from "./errors";
import { GatewayError, type Mt5Gateway } from "./gateway";
import { dealAction, opFromDb, SELECT_OP, sentAt, signedCents, type BalanceOpRow } from "./operations";
import { loadMt5Settings, serverEnabled } from "./settings";

// Nightly (and on-demand) reconciliation of MT5 with the CRM. A run first
// syncs every open account's deals into the cache (deals.ts), then compares:
// - each balance operation with the cached deals that carry its reference or
//   its ticket: a completed one has exactly its own deal; a failed, cancelled
//   or waiting one has none;
// - each balance-type deal (actions 2 to 7) newly cached, or changed by MT5
//   since it was cached, with the operations and accounts: a BIS- reference
//   that nobody has, or a deal made outside the CRM;
// - the ledger (verifyLedgerProblems, and each account's mt5_funding line
//   against its completed transfers and balance changes);
// - MT5's accounts: an open CRM account MT5 does not return, and an account
//   in a package or demo group that no CRM row has (users.list).
// What does not match becomes an issue (mt5_recon_issues) under a key that
// stays the same from run to run.
//
// A run only ever reads MT5 (deals.page and users.list). One runs at a time
// across every process (the table's unique running_flag), and the nightly
// one is run by whichever process inserts the day's row first. A run whose
// process ended mid-run is taken over by another process or marked failed;
// running it again is safe, as every write is keyed.
//
// A list that cries wolf stops being read, so a check says something is
// wrong only when the data proves it:
// - "completed without a deal" only once the account's cache is complete to
//   an hour past the operation (a deal newer than the last sync, or a trade
//   server clock a little off, is not a missing deal yet);
// - each page of checks reads one consistent snapshot, so an operation that
//   settles, or a deal stored, while the run reads is seen either before or
//   after, never half;
// - demo accounts are not client money and are never critical;
// - a staff change waiting for approval was never sent: only a deal for it
//   is wrong.
// Work is bounded per run: each account's sync, all the syncs together, the
// newly cached or changed deals and the operations looked at each have a
// limit, deals are read once (from where the last run read to) and again
// only when MT5 changes them, and an operation settled with nothing wrong is
// not looked at again unless a new or changed deal names it (its check is
// dropped as that deal is read, so a run that stops before looking at it
// leaves it to the next).

type Log = Pick<Logger, "info" | "warn" | "error">;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export type RunKind = "nightly" | "manual";
export type RunStatus = "running" | "done" | "failed";
export type Severity = "critical" | "warning" | "info";
export const ISSUE_KINDS = [
  "op_without_deal", "deal_mismatch", "failed_op_has_deal", "unknown_bis_deal", "ledger_problem", "funding_mismatch",
  "external_balance_deal", "unsettled_op", "account_missing", "unlinked_mt5_account",
] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];
export const SEVERITIES: readonly Severity[] = ["critical", "warning", "info"];

/**
 * States the CRM or MT5 should get out of: a resolved one that a run finds
 * again always reopens. The other kinds are about one deal, one settled
 * operation or one MT5 account, whose facts do not change by themselves (an
 * account MT5 archived, or one the CRM has no row for, may be meant to be
 * so): resolved by staff, they reopen only when what is found differs from
 * what was resolved.
 */
const STATE_KINDS: ReadonlySet<IssueKind> = new Set<IssueKind>(["ledger_problem", "funding_mismatch", "unsettled_op"]);

/** An operation is compared with its deal once the account's cache is complete to this long after it settled. */
export const SETTLE_SLACK_MS = HOUR;
/** An operation still open this long after it was let go to MT5, or waiting this long for approval, is reported. */
export const UNSETTLED_MS = HOUR;
/** A run whose heartbeat is this old has stopped (its process ended). */
export const STALE_MS = 15 * MINUTE;
/** A nightly run is tried this many times in all before it is marked failed. */
export const MAX_ATTEMPTS = 3;
/** How often each process checks whether today's nightly run is due. */
export const TICK_MS = MINUTE;

export interface RunLimits {
  /** Each account's deal sync. */
  accountSyncMs: number;
  /** All the syncs of one run; accounts not reached wait for the next run. */
  syncPhaseMs: number;
  /** Newly cached or changed balance-type deals one run looks at; the rest wait for the next run. */
  maxDeals: number;
  /** Operations one run checks (operations touched by a new deal come on top). */
  maxOps: number;
}
export const DEFAULT_LIMITS: RunLimits = { accountSyncMs: 15_000, syncPhaseMs: 90 * MINUTE, maxDeals: 20_000, maxOps: 50_000 };

/** Accounts synced at once (the gateway has two MT5 connections per server). */
const SYNC_AT_ONCE = 2;
const OPS_PAGE = 500;
const LOOKUP_PAGE = 1000;
const LOGINS_PAGE = 1000;
const WRITE_BATCH = 200;
/**
 * The next run reads again the deals stored or changed in the last ten
 * minutes before this one read: a page being stored then may not have
 * committed yet, and reading a deal twice only finds the same issue again.
 */
const DEALS_OVERLAP_MS = 10 * MINUTE;
const BEAT_EVERY_MS = 5_000;
/** MT5 deal actions that move money or credit: balance, credit, charge, correction, bonus, commission. */
const MONEY_ACTIONS = "2, 3, 4, 5, 6, 7";
/** A comment that claims to be one of the CRM's references (MT5_REFERENCE is upper case; any case counts as a claim). */
const BIS = /^bis-/i;

export interface Finding {
  key: string;
  kind: IssueKind;
  severity: Severity;
  accountId: number | null;
  clientId: number | null;
  opId: number | null;
  dealTicket: number | null;
  /** The facts, for staff: amounts in cents, logins, references, tickets. Never anything secret. */
  details: Record<string, unknown>;
}

export interface RunRow {
  id: number;
  kind: RunKind;
  run_date: Date | null;
  status: RunStatus;
  heartbeat_at: Date;
  attempts: number;
  started_at: Date;
  finished_at: Date | null;
  accounts_total: number;
  accounts_checked: number;
  issues_found: number;
  issues_new: number;
  critical_found: number;
  next_deals_from: Date | null;
  error: string | null;
  notes: string | null;
  started_by: number | null;
  started_by_name: string | null;
}

export const SELECT_RUN = `SELECT r.id, r.kind, r.run_date, r.status, r.heartbeat_at, r.attempts, r.started_at, r.finished_at, r.accounts_total,
  r.accounts_checked, r.issues_found, r.issues_new, r.critical_found, r.next_deals_from, r.error, r.notes, r.started_by, s.name AS started_by_name
  FROM mt5_recon_runs r LEFT JOIN staff_users s ON s.id = r.started_by`;

export const runFromDb = (r: RunRow): RunRow => ({
  ...r,
  id: Number(r.id),
  attempts: Number(r.attempts),
  accounts_total: Number(r.accounts_total),
  accounts_checked: Number(r.accounts_checked),
  issues_found: Number(r.issues_found),
  issues_new: Number(r.issues_new),
  critical_found: Number(r.critical_found),
  started_by: r.started_by === null ? null : Number(r.started_by),
});

export async function loadRun(conn: Conn, id: number): Promise<RunRow | undefined> {
  const r = await one<RunRow>(conn, `${SELECT_RUN} WHERE r.id = ?`, [id]);
  return r && runFromDb(r);
}

const marks = (list: unknown[]) => list.map(() => "?").join(", ");

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Runs `work` on each item, at most `n` at a time. */
async function eachAtMost<T>(items: T[], n: number, work: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) await work(items[next++]!);
    }),
  );
}

/**
 * Reads in one consistent snapshot: every query sees the database as it was
 * at the first one, so nothing that commits meanwhile is seen half done.
 */
async function snapshot<T>(db: Db, read: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await db.getConnection();
  try {
    await conn.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await conn.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
    try {
      return await read(conn);
    } finally {
      await conn.query("ROLLBACK").catch(() => undefined);
    }
  } finally {
    conn.release();
  }
}

// ---- Operations against their deals ----

/** A cached deal, as the operation checks read it. */
export interface CachedDeal {
  server: string;
  ticket: number;
  login: number;
  action: number;
  amountCents: number;
  comment: string;
  timeUtc: Date;
}

/** The account an operation is on: whether it is demo, and how far its deals are cached. */
export interface OpAccount {
  is_demo: number;
  deals_synced_until: Date | null;
}

export interface OpVerdict {
  findings: Finding[];
  /** Keys of issues this check proves are no longer true. */
  cleared: string[];
  /**
   * Done with the operation for good: settled, nothing wrong, and its own deal
   * cached (or, failed or cancelled, none). Null to look again next run, as
   * for every operation with an issue, so the issue stays found while true.
   */
  check: { outcome: "matched" | "no_deal"; tickets: number[] } | null;
}

const dealFacts = (d: CachedDeal) => ({ server: d.server, login: d.login, ticket: d.ticket, action: d.action, amountCents: d.amountCents, comment: d.comment, time: d.timeUtc.toISOString() });

/**
 * Compares one operation with the cached deals that carry its reference or
 * the ticket MT5 gave it. Its own deal is the one on its login and server,
 * of its action (2 balance, 3 credit) and signed amount, with its reference;
 * any other deal is a mismatch (a second deal for the same reference is
 * money moved twice). Pure: the caller reads the operation, its account and
 * the deals in one snapshot.
 */
export function evaluateOp(op: BalanceOpRow, account: OpAccount | undefined, cached: CachedDeal[], now = Date.now()): OpVerdict {
  const serious: Severity = account?.is_demo === 1 ? "warning" : "critical";
  const byTicket = (d: CachedDeal) => op.mt5_ticket !== null && d.server === op.server_code && d.ticket === op.mt5_ticket;
  const seen = new Set<string>();
  const deals = cached
    .filter((d) => d.comment === op.reference || byTicket(d))
    .filter((d) => !seen.has(`${d.server}:${d.ticket}`) && seen.add(`${d.server}:${d.ticket}`))
    .sort((a, b) => a.ticket - b.ticket);
  const action = dealAction(op);
  const amount = signedCents(op);
  const isOwn = (d: CachedDeal) => d.comment === op.reference && d.server === op.server_code && d.login === op.login && d.action === action && d.amountCents === amount;
  const own = deals.find((d) => isOwn(d) && byTicket(d)) ?? deals.find(isOwn) ?? null;
  const strays = deals.filter((d) => d !== own);
  const tickets = deals.map((d) => d.ticket);

  const facts = {
    reference: op.reference, purpose: op.purpose, status: op.status, amountCents: op.amount_cents, ticket: op.mt5_ticket,
    expected: { server: op.server_code, login: op.login, action, amountCents: amount },
  };
  const base = { accountId: op.mt5_account_id, clientId: op.client_id, opId: op.id };
  const keys = { withoutDeal: `op_without_deal:${op.id}`, hasDeal: `failed_op_has_deal:${op.id}`, unsettled: `unsettled_op:${op.id}` };
  const reason = (d: CachedDeal) => {
    if (d.comment !== op.reference) return "comment";
    if (d.server !== op.server_code || d.login !== op.login) return "account";
    if (d.action !== action) return "action";
    if (d.amountCents !== amount) return Math.sign(d.amountCents) !== Math.sign(amount) ? "sign" : "amount";
    return "duplicate";
  };
  const mismatch = (d: CachedDeal, why = reason(d)): Finding => ({
    key: `deal_mismatch:${d.server}:${d.ticket}`, kind: "deal_mismatch", severity: serious, ...base, dealTicket: d.ticket, details: { ...facts, deal: dealFacts(d), reason: why },
  });
  const unsettled = (since: Date): Finding => ({
    key: keys.unsettled, kind: "unsettled_op", severity: "warning", ...base, dealTicket: own?.ticket ?? null,
    details: { ...facts, failure: op.failure, since: since.toISOString(), mt5HasDeal: own !== null },
  });
  const hasDeal = (): Finding => ({
    key: keys.hasDeal, kind: "failed_op_has_deal", severity: serious, ...base, dealTicket: deals[0]!.ticket,
    details: { ...facts, failure: op.failure, deals: deals.map(dealFacts) },
  });

  const findings: Finding[] = [];
  const cleared: string[] = [];
  if (op.status === "completed") {
    findings.push(...strays.map((d) => mismatch(d)));
    // Its deal is there, but MT5 answered another ticket for it that is not cached under this server.
    if (own && op.mt5_ticket !== null && own.ticket !== op.mt5_ticket && !deals.some(byTicket)) findings.push(mismatch(own, "ticket"));
    const covered = account?.deals_synced_until && op.completed_at && account.deals_synced_until.getTime() >= op.completed_at.getTime() + SETTLE_SLACK_MS;
    if (!own && !strays.length && covered) {
      findings.push({ key: keys.withoutDeal, kind: "op_without_deal", severity: serious, ...base, dealTicket: null, details: { ...facts, completedAt: op.completed_at!.toISOString() } });
    }
    cleared.push(keys.unsettled, keys.hasDeal);
    if (own) cleared.push(keys.withoutDeal);
    // Done once its own deal is cached: any later deal with its reference is newly cached and brings it back.
    return { findings, cleared, check: own && !findings.length ? { outcome: "matched", tickets } : null };
  }
  if (op.status === "failed" || op.status === "cancelled") {
    // Given back (or never sent), so MT5 must have nothing for it.
    if (deals.length) findings.push(hasDeal());
    else cleared.push(keys.hasDeal);
    cleared.push(keys.unsettled, keys.withoutDeal);
    return { findings, cleared, check: deals.length ? null : { outcome: "no_deal", tickets } };
  }
  if (op.status === "awaiting_approval") {
    // Never let go to MT5: any deal with its reference is wrong.
    if (deals.length) findings.push(hasDeal());
    else cleared.push(keys.hasDeal);
    if (now - op.created_at.getTime() > UNSETTLED_MS) findings.push(unsettled(op.created_at));
    else cleared.push(keys.unsettled);
    cleared.push(keys.withoutDeal);
    return { findings, cleared, check: null };
  }
  // Sending or unknown: the resolver settles it; a deal that does not match it is wrong already.
  findings.push(...strays.map((d) => mismatch(d)));
  if (now - sentAt(op).getTime() > UNSETTLED_MS) findings.push(unsettled(sentAt(op)));
  else cleared.push(keys.unsettled);
  cleared.push(keys.withoutDeal, keys.hasDeal);
  return { findings, cleared, check: null };
}

// ---- Runs ----

export interface ClaimedRun {
  id: number;
  /** This process's token on the row: a run taken over by another process stops at its next heartbeat. */
  owner: string;
  kind: RunKind;
}

/** The run's row now belongs to another process. */
export class RunTakenOver extends Error {}
/** Another run is running, or today's nightly run exists already. */
export class RunBusy extends Error {}

/**
 * Inserts a run as running. Null when another run is running (one at a time
 * across all processes), or for a nightly run when that day's exists: the
 * process whose insert succeeds is the one that runs it.
 */
export async function claimRun(db: Db, run: { kind: "nightly"; runDate: string } | { kind: "manual"; staffId: number }): Promise<ClaimedRun | null> {
  const owner = randomBytes(16).toString("hex");
  try {
    const r = await exec(db, "INSERT INTO mt5_recon_runs (kind, run_date, owner, started_by) VALUES (?, ?, ?, ?)", [
      run.kind, run.kind === "nightly" ? run.runDate : null, owner, run.kind === "manual" ? run.staffId : null,
    ]);
    return { id: r.insertId, owner, kind: run.kind };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    if (e.code === "ER_DUP_ENTRY" && /uq_mt5_recon_running|uq_mt5_recon_nightly/.test(e.message ?? "")) return null;
    throw error;
  }
}

const STALE = `status = 'running' AND heartbeat_at < CURRENT_TIMESTAMP(3) - INTERVAL ${STALE_MS / 1000} SECOND`;

/**
 * A run whose heartbeat stopped did not finish (its process ended). A
 * nightly one is taken over by this process, up to MAX_ATTEMPTS in all, and
 * returned to be run again; any other is marked failed, as is a nightly one
 * out of attempts. Times are the database's, the same for every process.
 */
export async function recoverStaleRun(db: Db, log: Log): Promise<ClaimedRun | null> {
  const stale = await one<{ id: number; kind: RunKind; attempts: number }>(db, `SELECT id, kind, attempts FROM mt5_recon_runs WHERE ${STALE} LIMIT 1`);
  if (!stale) return null;
  const id = Number(stale.id);
  const attempts = Number(stale.attempts);
  if (stale.kind === "nightly" && attempts < MAX_ATTEMPTS) {
    const owner = randomBytes(16).toString("hex");
    const taken = await exec(db, `UPDATE mt5_recon_runs SET owner = ?, attempts = attempts + 1, heartbeat_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND ${STALE}`, [owner, id]);
    if (taken.affectedRows !== 1) return null;
    log.warn({ runId: id, attempt: attempts + 1 }, "An MT5 reconciliation run stopped before it finished; running it again");
    return { id, owner, kind: "nightly" };
  }
  const error =
    stale.kind === "nightly"
      ? `The run stopped before it finished, ${attempts} times (the CRM restarted or lost its database), so it was not tried again.`
      : "The run stopped before it finished (the CRM restarted or lost its database). Start a new run.";
  const failed = await exec(db, `UPDATE mt5_recon_runs SET status = 'failed', finished_at = CURRENT_TIMESTAMP(3), error = ? WHERE id = ? AND ${STALE}`, [error, id]);
  if (failed.affectedRows === 1) log.error({ runId: id, kind: stale.kind, attempts }, "An MT5 reconciliation run stopped before it finished; marked failed");
  return null;
}

let active: Promise<RunRow> | null = null;
/** The run this process is running, if any (tests wait for a run a staff request started). */
export const activeRun = () => active;

/** Runs a claimed run to its end. Never throws for a problem inside the run: the run row says how it ended. */
export function runClaimed(db: Db, gateway: Mt5Gateway, log: Log, claimed: ClaimedRun, limits: Partial<RunLimits> = {}): Promise<RunRow> {
  const run = new Run(db, gateway, log, claimed, { ...DEFAULT_LIMITS, ...limits });
  const done = run.execute().finally(() => {
    if (active === done) active = null;
  });
  active = done;
  return done;
}

/**
 * Claims a run and runs it to its end. Throws RunBusy when another run is
 * running (or, for a nightly run, that day's exists). A staff "Run now"
 * claims first and answers before the run ends, with runClaimed.
 */
export async function runReconciliation(
  db: Db,
  gateway: Mt5Gateway,
  log: Log,
  run: { kind: "manual"; staffId: number } | { kind: "nightly"; runDate: string },
  limits: Partial<RunLimits> = {},
): Promise<RunRow> {
  const claimed = await claimRun(db, run);
  if (!claimed) throw new RunBusy("Another MT5 reconciliation run is running, or that day's nightly run exists.");
  return runClaimed(db, gateway, log, claimed, limits);
}

/**
 * One scheduler step, as each process runs it every minute: takes over a
 * nightly run that stopped, or from `hourUtc` on starts today's (UTC) nightly
 * run if no process has. Returns the run it ran, or null.
 */
export async function reconciliationTick(db: Db, gateway: Mt5Gateway, log: Log, opts: { hourUtc: number; now?: Date; limits?: Partial<RunLimits> }): Promise<RunRow | null> {
  const takeOver = await recoverStaleRun(db, log);
  if (takeOver) return runClaimed(db, gateway, log, takeOver, opts.limits);
  const now = opts.now ?? new Date();
  if (now.getUTCHours() < opts.hourUtc) return null;
  const runDate = now.toISOString().slice(0, 10);
  // Read first, so a day's run that exists costs a select each minute, not a failed insert.
  if (await one(db, "SELECT id FROM mt5_recon_runs WHERE run_date = ?", [runDate])) return null;
  const claimed = await claimRun(db, { kind: "nightly", runDate });
  return claimed ? runClaimed(db, gateway, log, claimed, opts.limits) : null;
}

/** Runs the scheduler every minute in the server process. */
export function startMt5Reconciliation(db: Db, gateway: Mt5Gateway | null, log: Logger, hourUtc: number, everyMs = TICK_MS) {
  if (!gateway) {
    log.info("MT5 is off: CRM_MT5_GATEWAY_URL is not set, so MT5 is not reconciled");
    return () => undefined;
  }
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    reconciliationTick(db, gateway, log, { hourUtc })
      .catch((e) => log.error({ err: e }, "MT5 reconciliation scheduler failed"))
      .finally(() => (running = false));
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

interface ExistingIssue {
  id: number;
  issue_key: string;
  status: "open" | "resolved";
  resolved_by: number | null;
  fingerprint: string;
}

interface MoneyDealRow {
  server_code: string;
  ticket: number;
  mt5_account_id: number;
  client_id: number;
  login: number;
  action: number;
  profit_cents: number;
  comment: string;
  time_utc: Date;
  /** Where the scan read the deal: when the cache stored it (created_at) or, for a deal MT5 changed, rewrote it (changed_at). */
  written_at: Date;
  is_demo: number;
}

/** The last deal a run that reached its limit read, in the scan's order after written_at. */
interface DealCursor {
  action: number;
  server: string;
  ticket: number;
}

const DEAL_COLUMNS = "server_code, ticket, login, action, profit_cents, comment, time_utc";
type DealRow = Pick<MoneyDealRow, "server_code" | "ticket" | "login" | "action" | "profit_cents" | "comment" | "time_utc">;
const dealFromDb = (d: DealRow): CachedDeal => ({
  server: d.server_code, ticket: Number(d.ticket), login: Number(d.login), action: Number(d.action), amountCents: Number(d.profit_cents), comment: d.comment, timeUtc: d.time_utc,
});

/** One run: its counts, what it found, and the phases in order. */
class Run {
  /** Keys found by this run and left open (not one a person resolved, found just as it was), and the critical ones among them. */
  private found = new Set<string>();
  private critical = new Set<string>();
  /** Found and new, or found again after being resolved. */
  private opened = 0;
  private notes: string[] = [];
  private accountsTotal = 0;
  private accountsChecked = 0;
  /** Servers that answered "unavailable" this run: their other accounts and groups wait for the next run. */
  private unreachable = new Set<string>();
  /** Operations a newly cached or changed deal names (by reference or ticket): no longer done with, and looked at on top of the run's limit. */
  private touched = new Set<number>();
  private lastBeat = 0;

  constructor(
    private db: Db,
    private gateway: Mt5Gateway,
    private log: Log,
    private claimed: ClaimedRun,
    private limits: RunLimits,
  ) {}

  async execute(): Promise<RunRow> {
    const { id } = this.claimed;
    try {
      await this.syncAccounts();
      await this.checkUnlinked();
      await this.checkNewDeals();
      await this.checkOps();
      await this.checkLedger();
      await this.finish("done", null);
    } catch (error) {
      if (error instanceof RunTakenOver) {
        this.log.warn({ runId: id }, "Another process took this MT5 reconciliation run over; this one stops here");
      } else {
        this.log.error({ err: error, runId: id }, "MT5 reconciliation run failed");
        await this.finish("failed", "The run failed inside the CRM; the server log has the details.").catch((e) => {
          if (!(e instanceof RunTakenOver)) this.log.error({ err: e, runId: id }, "Could not record how an MT5 reconciliation run ended");
        });
      }
    }
    return (await loadRun(this.db, id))!;
  }

  private note(text: string) {
    this.notes.push(text);
  }

  /** Says the run is still alive (at most every few seconds unless `now`); stops it if another process has taken it over. */
  private async beat(now = false) {
    if (!now && Date.now() - this.lastBeat < BEAT_EVERY_MS) return;
    this.lastBeat = Date.now();
    const r = await exec(
      this.db,
      "UPDATE mt5_recon_runs SET heartbeat_at = CURRENT_TIMESTAMP(3), accounts_total = ?, accounts_checked = ? WHERE id = ? AND owner = ? AND status = 'running'",
      [this.accountsTotal, this.accountsChecked, this.claimed.id, this.claimed.owner],
    );
    if (r.affectedRows !== 1) throw new RunTakenOver();
  }

  private async finish(status: "done" | "failed", error: string | null) {
    const notes = this.notes.join(" ").slice(0, 1000) || null;
    const r = await exec(
      this.db,
      `UPDATE mt5_recon_runs SET status = ?, finished_at = CURRENT_TIMESTAMP(3), accounts_total = ?, accounts_checked = ?, issues_found = ?, issues_new = ?,
         critical_found = ?, error = ?, notes = ?
       WHERE id = ? AND owner = ? AND status = 'running'`,
      [status, this.accountsTotal, this.accountsChecked, this.found.size, this.opened, this.critical.size, error, notes, this.claimed.id, this.claimed.owner],
    );
    if (r.affectedRows !== 1) throw new RunTakenOver();
    const summary = { runId: this.claimed.id, kind: this.claimed.kind, status, accounts: this.accountsTotal, checked: this.accountsChecked, found: this.found.size, opened: this.opened };
    if (this.critical.size) this.log.error({ ...summary, critical: this.critical.size }, "MT5 reconciliation found critical issues");
    else this.log.info(summary, "MT5 reconciliation run ended");
  }

  /**
   * Writes what was found. A new key is a new open issue; an open one gets
   * the facts as found now; a resolved one reopens when it is a state kind,
   * was resolved by a run (it is true again), or its facts changed since a
   * person resolved it. Only the issues left open count as found. New and
   * reopened critical issues are logged as errors.
   */
  private async record(findings: Finding[]) {
    const unique = [...new Map(findings.map((f) => [f.key, f])).values()];
    const runId = this.claimed.id;
    for (const batch of chunks(unique, WRITE_BATCH)) {
      const { opened, open } = await transaction(this.db, async (conn) => {
        const keys = batch.map((f) => f.key);
        const existing = new Map(
          (await rows<ExistingIssue>(conn, `SELECT id, issue_key, status, resolved_by, fingerprint FROM mt5_recon_issues WHERE issue_key IN (${marks(keys)}) FOR UPDATE`, keys))
            .map((e) => [e.issue_key, e]),
        );
        const now: Finding[] = [];
        const stillOpen: Finding[] = [];
        for (const f of batch) {
          const details = JSON.stringify(f.details);
          const fingerprint = sha256(canonical(f.details));
          const facts = [f.severity, f.accountId, f.clientId, f.opId, f.dealTicket, details, fingerprint, runId];
          const e = existing.get(f.key);
          if (!e) {
            await exec(
              conn,
              `INSERT INTO mt5_recon_issues (severity, mt5_account_id, client_id, op_id, deal_ticket, details, fingerprint, last_run_id, issue_key, kind, first_run_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [...facts, f.key, f.kind, runId],
            );
            now.push(f);
          } else if (e.status === "open") {
            await exec(
              conn,
              "UPDATE mt5_recon_issues SET severity = ?, mt5_account_id = ?, client_id = ?, op_id = ?, deal_ticket = ?, details = ?, fingerprint = ?, last_run_id = ? WHERE id = ?",
              [...facts, e.id],
            );
            stillOpen.push(f);
          } else if (STATE_KINDS.has(f.kind) || e.resolved_by === null || e.fingerprint !== fingerprint) {
            await exec(
              conn,
              `UPDATE mt5_recon_issues SET severity = ?, mt5_account_id = ?, client_id = ?, op_id = ?, deal_ticket = ?, details = ?, fingerprint = ?, last_run_id = ?,
                 status = 'open', resolved_by = NULL, resolved_at = NULL, resolved_note = NULL, reopened = reopened + 1
               WHERE id = ?`,
              [...facts, e.id],
            );
            now.push(f);
          } else {
            // A person resolved it, and it is found again just as it was then: it stays resolved, and is not counted.
            await exec(conn, "UPDATE mt5_recon_issues SET last_run_id = ? WHERE id = ?", [runId, e.id]);
          }
        }
        return { opened: now, open: [...now, ...stillOpen] };
      });
      for (const f of open) {
        this.found.add(f.key);
        if (f.severity === "critical") this.critical.add(f.key);
      }
      this.opened += opened.length;
      for (const f of opened) {
        if (f.severity !== "critical") continue;
        this.log.error({ runId, issueKey: f.key, kind: f.kind, accountId: f.accountId, opId: f.opId, dealTicket: f.dealTicket }, "MT5 reconciliation found a critical issue");
      }
    }
  }

  /** Resolves open issues this run proved are no longer true (never one it found). */
  private async clear(keys: string[]) {
    const wanted = [...new Set(keys)].filter((k) => !this.found.has(k));
    for (const batch of chunks(wanted, 500)) {
      await exec(
        this.db,
        `UPDATE mt5_recon_issues SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP(3), resolved_note = ? WHERE status = 'open' AND issue_key IN (${marks(batch)})`,
        [`No longer found by reconciliation run ${this.claimed.id}.`, ...batch],
      );
    }
  }

  /** Resolves the open issues of a kind this run checked in full and did not find. */
  private async clearKind(kind: IssueKind) {
    await exec(
      this.db,
      "UPDATE mt5_recon_issues SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP(3), resolved_note = ? WHERE kind = ? AND status = 'open' AND last_run_id <> ?",
      [`No longer found by reconciliation run ${this.claimed.id}.`, kind, this.claimed.id],
    );
  }

  /**
   * Syncs every open account on a switched-on server, those synced longest
   * ago first, each within its own limit and all within the phase's. MT5
   * refusing an account as unknown, or in a group the gateway does not allow,
   * is an account MT5 does not return.
   */
  private async syncAccounts() {
    const accounts = (
      await rows<{ id: number; client_id: number; server_code: string; login: number; is_demo: number }>(
        this.db,
        `SELECT a.id, a.client_id, a.server_code, a.login, a.is_demo FROM mt5_accounts a JOIN mt5_servers s ON s.code = a.server_code AND s.is_enabled = 1
         WHERE a.status = 'active' AND a.login IS NOT NULL
         ORDER BY a.deals_synced_at IS NOT NULL, a.deals_synced_at, a.id`,
      )
    ).map((a) => ({ ...a, id: Number(a.id), client_id: Number(a.client_id), login: Number(a.login) }));
    this.accountsTotal = accounts.length;
    await this.beat(true);
    const deadline = Date.now() + this.limits.syncPhaseMs;
    const findings: Finding[] = [];
    const cleared: string[] = [];
    let late = 0;
    let unreached = 0;
    let unanswered = 0;
    await eachAtMost(accounts, SYNC_AT_ONCE, async (a) => {
      if (this.unreachable.has(a.server_code)) return void unreached++;
      const left = deadline - Date.now();
      if (left <= 0) return void late++;
      const r = await syncAccountDeals(this.db, this.gateway, a.id, this.log, { budgetMs: Math.min(this.limits.accountSyncMs, left) });
      const key = `account_missing:${a.id}`;
      if (r.outcome === "complete" || r.outcome === "partial") {
        this.accountsChecked++;
        cleared.push(key);
      } else if (r.outcome === "failed" && r.error?.kind === "refused" && (r.error.code === "not_found" || r.error.code === "group_not_allowed")) {
        this.accountsChecked++;
        findings.push({
          key, kind: "account_missing", severity: a.is_demo === 1 ? "info" : "warning", accountId: a.id, clientId: a.client_id, opId: null, dealTicket: null,
          details: { server: a.server_code, login: a.login, demo: a.is_demo === 1, reason: r.error.code },
        });
      } else if (r.outcome === "failed") {
        unanswered++;
        if (r.error?.kind === "unavailable") this.unreachable.add(a.server_code);
      }
      if (findings.length >= WRITE_BATCH) await this.record(findings.splice(0));
      await this.beat();
    });
    await this.record(findings);
    // An account closed or never opened since is not missing.
    const closed = await rows<{ issue_key: string }>(
      this.db,
      `SELECT i.issue_key FROM mt5_recon_issues i JOIN mt5_accounts a ON a.id = i.mt5_account_id
       WHERE i.kind = 'account_missing' AND i.status = 'open' AND (a.status <> 'active' OR a.login IS NULL)`,
    );
    await this.clear([...cleared, ...closed.map((i) => i.issue_key)]);
    if (unreached) this.note(`${unreached} accounts were not synced: their MT5 server (${[...this.unreachable].join(", ")}) could not be reached.`);
    if (unanswered) this.note(`${unanswered === 1 ? "1 account" : `${unanswered} accounts`} could not be synced (see each account's sync error).`);
    if (late) this.note(`${late} accounts were not synced in this run's time; the next run starts with them.`);
  }

  /** Lists each package group and the demo group in MT5 and reports the accounts no CRM row has. */
  private async checkUnlinked() {
    await this.beat(true);
    const groups = new Map<string, { server: string; group: string; demo: boolean }>();
    const packages = await rows<{ server_code: string; mt5_group: string }>(
      this.db,
      "SELECT DISTINCT p.server_code, p.mt5_group FROM account_packages p JOIN mt5_servers s ON s.code = p.server_code AND s.is_enabled = 1",
    );
    for (const p of packages) groups.set(`${p.server_code}|${p.mt5_group}`, { server: p.server_code, group: p.mt5_group, demo: false });
    const settings = await loadMt5Settings(this.db);
    if (settings.demoServerCode && settings.demoGroup && (await serverEnabled(this.db, settings.demoServerCode))) {
      const key = `${settings.demoServerCode}|${settings.demoGroup}`;
      if (!groups.has(key)) groups.set(key, { server: settings.demoServerCode, group: settings.demoGroup, demo: true });
    }
    for (const g of groups.values()) await this.listGroup(g);
    // A group no package or demo account uses any more is not the CRM's to list (a switched-off server's groups wait).
    const open = await rows<{ issue_key: string; details: { server?: string; group?: string } }>(
      this.db,
      "SELECT issue_key, details FROM mt5_recon_issues WHERE kind = 'unlinked_mt5_account' AND status = 'open'",
    );
    const enabled = new Set((await rows<{ code: string }>(this.db, "SELECT code FROM mt5_servers WHERE is_enabled = 1")).map((r) => r.code));
    await this.clear(open.filter((i) => enabled.has(String(i.details?.server)) && !groups.has(`${i.details?.server}|${i.details?.group}`)).map((i) => i.issue_key));
  }

  private async listGroup(g: { server: string; group: string; demo: boolean }) {
    const where = `${g.server} group ${g.group}`;
    if (this.unreachable.has(g.server)) return this.note(`Accounts in ${where} were not listed: the server could not be reached.`);
    const candidates: number[] = [];
    let after: number | undefined;
    try {
      for (;;) {
        const page = await callMt5(this.gateway, "users.list", { server: g.server, group: g.group, ...(after === undefined ? {} : { after }), limit: LOGINS_PAGE }, this.log);
        if (page.logins.length) {
          const known = await rows<{ login: number }>(this.db, `SELECT login FROM mt5_accounts WHERE server_code = ? AND login IN (${marks(page.logins)})`, [g.server, ...page.logins]);
          const linked = new Set(known.map((r) => Number(r.login)));
          candidates.push(...page.logins.filter((l) => !linked.has(l)));
        }
        await this.beat();
        if (page.logins.length < LOGINS_PAGE) break;
        after = page.logins.at(-1);
      }
    } catch (error) {
      if (!(error instanceof GatewayError)) throw error;
      if (error.kind === "unavailable") this.unreachable.add(g.server);
      return this.note(`Accounts in ${where} could not be listed (${error.kind}/${error.code}).`);
    }
    // An account being opened is in MT5 before its CRM row has the login. Checked after the
    // listing: any account the listing saw is then either still being opened (so this group
    // waits for the next run) or linked, which the check below sees.
    if (await one(this.db, "SELECT id FROM mt5_accounts WHERE server_code = ? AND mt5_group = ? AND status IN ('creating', 'unknown') LIMIT 1", [g.server, g.group])) {
      return this.note(`Unlinked accounts in ${where} were not checked: an account there is still being opened.`);
    }
    const linked = new Set<number>();
    for (const batch of chunks(candidates, LOOKUP_PAGE)) {
      const known = await rows<{ login: number }>(this.db, `SELECT login FROM mt5_accounts WHERE server_code = ? AND login IN (${marks(batch)})`, [g.server, ...batch]);
      for (const r of known) linked.add(Number(r.login));
    }
    await this.record(
      candidates
        .filter((login) => !linked.has(login))
        .map((login) => ({
          key: `unlinked_mt5_account:${g.server}:${login}`, kind: "unlinked_mt5_account" as const, severity: g.demo ? ("info" as const) : ("warning" as const),
          accountId: null, clientId: null, opId: null, dealTicket: null, details: { server: g.server, group: g.group, login, demo: g.demo },
        })),
    );
    // Listed in full: one for this group not found again is linked now, or no longer in the group.
    const open = await rows<{ issue_key: string; details: { server?: string; group?: string } }>(
      this.db,
      "SELECT issue_key, details FROM mt5_recon_issues WHERE kind = 'unlinked_mt5_account' AND status = 'open'",
    );
    await this.clear(open.filter((i) => i.details?.server === g.server && i.details?.group === g.group).map((i) => i.issue_key));
  }

  /**
   * Balance-type deals (actions 2 to 7) stored in the cache, or rewritten
   * because MT5 changed them, since the last run looked: one with an
   * operation's reference, or the ticket MT5 answered for one, brings that
   * operation back for a check (so a changed amount, action or comment is a
   * mismatch); otherwise one without a BIS- reference was made outside the
   * CRM, and one with a reference that no operation or account has is
   * unknown. A changed deal is found again under the same key.
   */
  private async checkNewDeals() {
    await this.beat(true);
    const last = await one<{ next_deals_from: Date; next_deals_after: DealCursor | null }>(
      this.db,
      "SELECT next_deals_from, next_deals_after FROM mt5_recon_runs WHERE next_deals_from IS NOT NULL ORDER BY next_deals_from DESC, id DESC LIMIT 1",
    );
    const from = last?.next_deals_from ?? new Date(0);
    const after = last?.next_deals_after ?? null;
    const upTo = (await one<{ now: Date }>(this.db, "SELECT CURRENT_TIMESTAMP(3) AS now"))!.now;
    // A deal is read where the cache stored it and, once MT5 has changed it, again where a sync rewrote it: one
    // cursor over both. Each half reads in the order of its index, on (created_at, action) or (changed_at, action)
    // (the primary key, server and ticket, ends each of their entries), so the limit stops both reads. After a run
    // cut short, the deals of its last millisecond that it read are skipped.
    const since = (at: "created_at" | "changed_at") =>
      `(SELECT server_code, ticket, mt5_account_id, client_id, login, action, profit_cents, comment, time_utc, ${at} AS written_at FROM mt5_deals
        WHERE ${at} >= ? AND ${at} <= ? AND action IN (${MONEY_ACTIONS})${after ? ` AND (${at} > ? OR (action, server_code, ticket) > (?, ?, ?))` : ""}
        ORDER BY ${at}, action, server_code, ticket LIMIT ?)`;
    const half = [from, upTo, ...(after ? [from, after.action, after.server, after.ticket] : []), this.limits.maxDeals + 1];
    const deals = await rows<MoneyDealRow>(
      this.db,
      `SELECT d.*, a.is_demo FROM (${since("created_at")} UNION ALL ${since("changed_at")}) d JOIN mt5_accounts a ON a.id = d.mt5_account_id
       ORDER BY d.written_at, d.action, d.server_code, d.ticket LIMIT ?`,
      [...half, ...half, this.limits.maxDeals + 1],
    );
    const capped = deals.length > this.limits.maxDeals;
    if (capped) deals.length = this.limits.maxDeals;
    for (const page of chunks(deals, LOOKUP_PAGE)) {
      const refs = [...new Set(page.filter((d) => BIS.test(d.comment)).map((d) => d.comment))];
      const ops = refs.length ? await rows<{ id: number; reference: string }>(this.db, `SELECT id, reference FROM mt5_balance_ops WHERE reference IN (${marks(refs)})`, refs) : [];
      const creates = refs.length ? await rows<{ create_ref: string }>(this.db, `SELECT create_ref FROM mt5_accounts WHERE create_ref IN (${marks(refs)})`, refs) : [];
      // The deal MT5 answered for an operation is that operation's whatever its comment says now (a dealer can change it).
      const ticketed = await rows<{ id: number; server_code: string; mt5_ticket: number }>(
        this.db,
        `SELECT id, server_code, mt5_ticket FROM mt5_balance_ops WHERE (server_code, mt5_ticket) IN (${page.map(() => "(?, ?)").join(", ")})`,
        page.flatMap((d) => [d.server_code, d.ticket]),
      );
      // The column compares without case; a reference is the exact text.
      const opOf = new Map(ops.map((o) => [o.reference, Number(o.id)]));
      const opOfTicket = new Map(ticketed.map((o) => [`${o.server_code}:${Number(o.mt5_ticket)}`, Number(o.id)]));
      const accountRefs = new Set(creates.map((a) => a.create_ref));
      const findings: Finding[] = [];
      const named = new Set<number>();
      for (const row of page) {
        const d = dealFromDb(row);
        const demo = Number(row.is_demo) === 1;
        const base = { accountId: Number(row.mt5_account_id), clientId: Number(row.client_id), opId: null, dealTicket: d.ticket, details: dealFacts(d) };
        const claimed = BIS.test(d.comment);
        const opIds = [claimed ? opOf.get(d.comment) : undefined, opOfTicket.get(`${d.server}:${d.ticket}`)].filter((id) => id !== undefined);
        if (opIds.length) {
          // Its operations are compared with it (and with their other deals) below.
          for (const opId of opIds) {
            this.touched.add(opId);
            named.add(opId);
          }
        } else if (claimed && accountRefs.has(d.comment)) {
          // An account's opening reference: not money the CRM sent.
        } else if (claimed && (d.action === 2 || d.action === 3)) {
          findings.push({ ...base, key: `unknown_bis_deal:${d.server}:${d.ticket}`, kind: "unknown_bis_deal", severity: demo ? "warning" : "critical" });
        } else if (!demo) {
          // The CRM only makes balance and credit deals, so anything else was made outside it. Demo money is play money, whoever adds it.
          findings.push({ ...base, key: `external_balance_deal:${d.server}:${d.ticket}`, kind: "external_balance_deal", severity: "warning" });
        }
      }
      // Before the cursor moves past these deals: an operation done with that one of them names is no longer done
      // with, so it is checked again by this run or, if this one stops first, by the next (or the one taking it over).
      if (named.size) await exec(this.db, `DELETE FROM mt5_recon_op_checks WHERE op_id IN (${marks([...named])})`, [...named]);
      await this.record(findings);
      await this.beat();
    }
    // Cut short, the next run carries on straight after the last deal read; otherwise it starts a little before
    // where this run read to. Never back: deals before `from` were read by an earlier run.
    const end = deals.at(-1);
    const next = capped && end
      ? { from: end.written_at, after: { action: Number(end.action), server: end.server_code, ticket: Number(end.ticket) } satisfies DealCursor }
      : { from: new Date(Math.max(upTo.getTime() - DEALS_OVERLAP_MS, from.getTime())), after: null };
    if (capped) this.note(`More than ${this.limits.maxDeals} newly cached or changed balance-type deals: the rest are checked by the next run.`);
    const r = await exec(this.db, "UPDATE mt5_recon_runs SET next_deals_from = ?, next_deals_after = ? WHERE id = ? AND owner = ? AND status = 'running'", [
      next.from, next.after && JSON.stringify(next.after), this.claimed.id, this.claimed.owner,
    ]);
    if (r.affectedRows !== 1) throw new RunTakenOver();
  }

  /** Every operation not done with yet, oldest first, then those a new or changed deal touched. */
  private async checkOps() {
    await this.beat(true);
    const checked = new Set<number>();
    let after = 0;
    let more = false;
    for (;;) {
      const ids = (
        await rows<{ id: number }>(
          this.db,
          `SELECT o.id FROM mt5_balance_ops o LEFT JOIN mt5_recon_op_checks k ON k.op_id = o.id WHERE k.op_id IS NULL AND o.id > ? ORDER BY o.id LIMIT ?`,
          [after, Math.min(OPS_PAGE, this.limits.maxOps - checked.size + 1)],
        )
      ).map((r) => Number(r.id));
      if (!ids.length) break;
      // One past the limit says there are more, and is left for the next run.
      if (checked.size + ids.length > this.limits.maxOps) {
        more = true;
        ids.length = this.limits.maxOps - checked.size;
        if (!ids.length) break;
      }
      after = ids.at(-1)!;
      await this.checkOpPage(ids);
      for (const id of ids) checked.add(id);
      await this.beat();
    }
    if (more) this.note(`More than ${this.limits.maxOps} operations to check: the rest are checked by the next run.`);
    for (const ids of chunks([...this.touched].filter((id) => !checked.has(id)), OPS_PAGE)) {
      await this.checkOpPage(ids);
      await this.beat();
    }
  }

  private async checkOpPage(ids: number[]) {
    const { ops, accounts, deals } = await snapshot(this.db, async (conn) => {
      const ops = (await rows<BalanceOpRow>(conn, `${SELECT_OP} WHERE o.id IN (${marks(ids)})`, ids)).map(opFromDb);
      const accountIds = [...new Set(ops.map((o) => o.mt5_account_id))];
      const accounts = accountIds.length
        ? await rows<OpAccount & { id: number }>(conn, `SELECT id, is_demo, deals_synced_until FROM mt5_accounts WHERE id IN (${marks(accountIds)})`, accountIds)
        : [];
      const refs = ops.map((o) => o.reference);
      const byComment = refs.length ? await rows<DealRow>(conn, `SELECT ${DEAL_COLUMNS} FROM mt5_deals WHERE comment IN (${marks(refs)})`, refs) : [];
      const ticketed = ops.filter((o) => o.mt5_ticket !== null);
      const byTicket = ticketed.length
        ? await rows<DealRow>(conn, `SELECT ${DEAL_COLUMNS} FROM mt5_deals WHERE (server_code, ticket) IN (${ticketed.map(() => "(?, ?)").join(", ")})`, ticketed.flatMap((o) => [o.server_code, o.mt5_ticket]))
        : [];
      return { ops, accounts, deals: [...byComment, ...byTicket].map(dealFromDb) };
    });
    const accountOf = new Map(accounts.map((a) => [Number(a.id), { is_demo: Number(a.is_demo), deals_synced_until: a.deals_synced_until }]));
    const findings: Finding[] = [];
    const cleared: string[] = [];
    const checks: [number, string, string, number][] = [];
    const now = Date.now();
    for (const op of ops) {
      const own = deals.filter((d) => d.comment === op.reference || (op.mt5_ticket !== null && d.server === op.server_code && d.ticket === op.mt5_ticket));
      const verdict = evaluateOp(op, accountOf.get(op.mt5_account_id), own, now);
      findings.push(...verdict.findings);
      cleared.push(...verdict.cleared);
      if (verdict.check) checks.push([op.id, verdict.check.outcome, JSON.stringify(verdict.check.tickets), this.claimed.id]);
    }
    await this.record(findings);
    await this.clear(cleared);
    if (checks.length) {
      await this.db.query(
        `INSERT INTO mt5_recon_op_checks (op_id, outcome, deal_tickets, run_id) VALUES ${checks.map(() => "(?, ?, ?, ?)").join(", ")}
         ON DUPLICATE KEY UPDATE outcome = VALUES(outcome), deal_tickets = VALUES(deal_tickets), run_id = VALUES(run_id), checked_at = CURRENT_TIMESTAMP(3)`,
        checks.flat(),
      );
    }
  }

  /**
   * The ledger's own checks, and each MT5 account's funding line (what the
   * ledger says went to MT5 less what came back) against its completed
   * transfers and balance changes, in one snapshot. A ledger problem is keyed
   * by its subject, not its text: the text carries amounts, which any posting
   * changes while the problem stays, so it stays one issue (with its history
   * and notes) that shows the latest text.
   */
  private async checkLedger() {
    await this.beat(true);
    const { problems, funding, operations } = await snapshot(this.db, async (conn) => ({
      problems: await verifyLedgerProblems(conn),
      funding: await rows<{ account: string; total: string }>(conn, "SELECT account, SUM(amount_cents) AS total FROM ledger_entries WHERE account LIKE 'mt5\\_funding:%' GROUP BY account"),
      operations: await rows<{ mt5_account_id: number; total: string }>(
        conn,
        `SELECT mt5_account_id, SUM(CASE WHEN purpose IN ('wallet_to_mt5', 'staff_balance_in') THEN amount_cents ELSE -amount_cents END) AS total
         FROM mt5_balance_ops WHERE status = 'completed' AND purpose IN ('wallet_to_mt5', 'mt5_to_wallet', 'staff_balance_in', 'staff_balance_out')
         GROUP BY mt5_account_id`,
      ),
    }));
    await this.record(
      problems.map((p) => ({
        key: `ledger_problem:${sha256(p.subject).slice(0, 40)}`, kind: "ledger_problem" as const, severity: "critical" as const,
        accountId: null, clientId: null, opId: null, dealTicket: null, details: { problem: p.text },
      })),
    );
    await this.clearKind("ledger_problem");

    const ledger = new Map<string, number>(funding.map((f) => [f.account, Number(f.total)]));
    const expected = new Map<string, number>(operations.map((o) => [`mt5_funding:${Number(o.mt5_account_id)}`, Number(o.total)]));
    const gaps = [...new Set([...ledger.keys(), ...expected.keys()])].filter((k) => (ledger.get(k) ?? 0) !== (expected.get(k) ?? 0));
    const ids = gaps.map((k) => /^mt5_funding:(\d+)$/.exec(k)?.[1]).filter((v): v is string => v !== undefined).map(Number);
    const accounts = ids.length
      ? await rows<{ id: number; client_id: number; server_code: string; login: number | null }>(this.db, `SELECT id, client_id, server_code, login FROM mt5_accounts WHERE id IN (${marks(ids)})`, ids)
      : [];
    const accountOf = new Map(accounts.map((a) => [Number(a.id), a]));
    await this.record(
      gaps.map((fundingAccount) => {
        const id = Number(/^mt5_funding:(\d+)$/.exec(fundingAccount)?.[1] ?? NaN);
        const a = accountOf.get(id);
        return {
          key: `funding_mismatch:${a ? a.id : fundingAccount.slice(0, 60)}`, kind: "funding_mismatch" as const, severity: "critical" as const,
          accountId: a ? Number(a.id) : null, clientId: a ? Number(a.client_id) : null, opId: null, dealTicket: null,
          details: {
            fundingAccount, ledgerCents: ledger.get(fundingAccount) ?? 0, operationsCents: expected.get(fundingAccount) ?? 0,
            server: a?.server_code ?? null, login: a?.login === undefined || a.login === null ? null : Number(a.login),
          },
        };
      }),
    );
    await this.clearKind("funding_mismatch");
  }
}
