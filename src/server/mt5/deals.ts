import type { ResultSetHeader } from "mysql2/promise";
import type { Logger } from "pino";
import type { Mt5Deal } from "../../gateway/protocol";
import { exec, one, rows, transaction, type Conn, type Db } from "../lib/db";
import { callMt5 } from "./errors";
import { GatewayError, type Mt5Gateway } from "./gateway";
import { serverEnabled } from "./settings";
import { BUY, rebuildTrades, SELL, type TradeAccount } from "./trades";

// The CRM's copy of each MT5 account's deals (mt5_deals), and the closed
// trades built from them (mt5_trades, see trades.ts). A sync reads one
// account's deals from MT5 page by page, oldest first, from a little before
// where the cache is complete to, stores the deals it has not seen and builds
// again every position they belong to. It only ever reads MT5.
//
// Syncs run on demand (the first page of a client's trade history, a staff
// "Sync now", reconciliation) and in a background loop. One account is
// synced once at a time in this process: a second ask joins the one running.

type Log = Pick<Logger, "info" | "warn" | "error">;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Deals per deals.page call (the gateway's most). */
export const DEALS_PER_PAGE = 1000;
/** Each sync reads again this far back from where the last one ended: MT5 can file a deal late, or a server clock can move. */
export const OVERLAP_MS = 2 * DAY;
/** A first sync starts this long before the account was opened (deal times are on the trade server's clock). */
const FIRST_SYNC_BACK_MS = DAY;
/** And every sync reads to this far past now, for a trade server whose clock runs ahead. */
const AHEAD_MS = HOUR;
/** How long a sync runs before it stops after the page it is on, unless its caller says otherwise. */
export const SYNC_BUDGET_MS = 20_000;

/** The first page of a client's trade history syncs the accounts not synced in the last minute, and waits for them at most 4 seconds. */
export const ON_DEMAND_FRESH_MS = 60_000;
export const ON_DEMAND_BUDGET_MS = 4_000;
/** Accounts synced at once for one client (the gateway has two MT5 connections per server). */
const ON_DEMAND_AT_ONCE = 3;

/** The background loop: every 5 minutes, up to 50 accounts, each for at most 20 seconds, and no new one after 4 minutes. */
export const LOOP_EVERY_MS = 5 * MINUTE;
const LOOP_ACCOUNTS = 50;
const LOOP_BUDGET_MS = 4 * MINUTE;
/** Accounts whose client used the portal or app in the last day are synced again after this long; every other one daily. */
const ACTIVE_RESYNC_MINUTES = 5;

export type SyncOutcome = "complete" | "partial" | "failed" | "skipped";

export interface SyncError {
  kind: GatewayError["kind"] | "internal";
  code: string;
  message: string;
}

export interface SyncResult {
  /**
   * complete: the cache holds every deal up to when this sync started.
   * partial: its time ran out first (or a trade history page that was
   *   waiting had answered, or MT5's pages ended before its total, which
   *   `error` says); the next sync carries on from there.
   * failed: MT5 could not be read (pages read before that are kept).
   * skipped: not an open account, or its server is switched off.
   */
  outcome: SyncOutcome;
  pages: number;
  /** Deals read, and how many of them the cache did not have. */
  deals: number;
  newDeals: number;
  /** Closed trades built again (a position a netting reversal turned is one per closed part). */
  trades: number;
  /** What went wrong, for staff and logs (it may carry MT5's words: never for clients). */
  error: SyncError | null;
}

interface SyncAccount extends TradeAccount {
  status: string;
  created_at: Date;
  mt5_registered_at: Date | null;
  deals_synced_until: Date | null;
  deals_sync_partial: number;
}

/** An account's sync state as staff see it. */
export interface SyncState {
  deals_synced_until: Date | null;
  deals_synced_at: Date | null;
  deals_sync_error: string | null;
  deals_sync_partial: number;
}

/**
 * The sync running for each account. `stopAt` (epoch ms): no page is stored
 * from then on, the time a trade history page waiting for it answers, so
 * the cache does not change under a client paging through it. `storing`: the
 * page being written now, if any.
 */
interface Running {
  result: Promise<SyncResult>;
  stopAt: number;
  storing: Promise<unknown> | null;
}
const inFlight = new Map<number, Running>();

export const syncStatus = (accountId: number, s: SyncState) => ({
  /** The cache holds every deal up to here. */
  syncedUntil: s.deals_synced_until?.toISOString() ?? null,
  /** When the last sync ended, whether or not it worked. */
  syncedAt: s.deals_synced_at?.toISOString() ?? null,
  error: s.deals_sync_error,
  /** The last sync stopped before reaching the present; the next one carries on. */
  partial: Number(s.deals_sync_partial) === 1,
  running: inFlight.has(accountId),
});

const marks = (list: unknown[]) => list.map(() => "?").join(", ");

/**
 * A deal's time in UTC to the millisecond: the gateway's UTC second, plus
 * the milliseconds MT5 gives in TimeMsc (same clock as Time), so deals of
 * one second keep their order. Null when the time cannot be read.
 */
export function dealTimeUtc(d: Pick<Mt5Deal, "time" | "timeMsc" | "timeUtc">): Date | null {
  const parsed = Date.parse(d.timeUtc);
  if (Number.isNaN(parsed)) return null;
  const ms = d.timeMsc - d.time * 1000;
  return new Date(Math.floor(parsed / 1000) * 1000 + (ms >= 0 && ms < 1000 ? ms : 0));
}

/**
 * Where a sync of this account starts reading. After a partial sync, from
 * the start of the second its last deal was in: MT5 searches whole seconds,
 * and the other deals of that second may not be stored yet.
 */
function syncFrom(a: SyncAccount): Date {
  if (a.deals_synced_until && a.deals_sync_partial) return new Date(Math.floor(a.deals_synced_until.getTime() / 1000) * 1000);
  if (a.deals_synced_until) return new Date(a.deals_synced_until.getTime() - OVERLAP_MS);
  const opened = Math.min(a.created_at.getTime(), a.mt5_registered_at?.getTime() ?? Infinity);
  return new Date(opened - FIRST_SYNC_BACK_MS);
}

/** What MT5 says of a deal, after its identity (server, ticket, account, client, login). */
const DEAL_FIELDS = [
  "action", "entry", "position_id", "order_id", "symbol", "volume", "price", "profit_cents", "commission_cents", "swap_cents", "fee_cents", "comment", "time_server", "time_utc",
] as const;
const COLUMNS = ["server_code", "ticket", "mt5_account_id", "client_id", "login", ...DEAL_FIELDS];

/** A deal's DEAL_FIELDS values, in that order, as they are stored. */
const fieldsOf = (d: Mt5Deal, time: Date): unknown[] => [
  d.action, d.entry, d.positionId, d.order, d.symbol.slice(0, 64), d.volume, d.price, d.profitCents, d.commissionCents, d.swapCents, d.feeCents, d.comment.slice(0, 64), d.time, time,
];

type StoredDeal = Record<(typeof DEAL_FIELDS)[number], unknown> & { ticket: number; mt5_account_id: number };

/** The fields MT5 now reports differently from the stored copy. */
function changedFields(stored: StoredDeal, now: unknown[]) {
  return DEAL_FIELDS.filter((field, i) => {
    const was = stored[field];
    const is = now[i];
    return is instanceof Date ? !(was instanceof Date) || was.getTime() !== is.getTime() : String(was) !== String(is);
  });
}

/**
 * Stores one page of deals and builds again the positions they belong to, in
 * one transaction, so the cache never has a deal without its trade. A deal
 * already stored is rewritten, with changed_at stamped, when MT5 now reports
 * it differently (a broker cancelling it turns a buy or sell into
 * BUY_CANCELED or SELL_CANCELED; a dealer can correct a price, an amount or a
 * comment). Returns the time of the page's last
 * stored deal (pages are oldest first, so the cache is complete to there).
 */
async function storePage(db: Db, a: SyncAccount, deals: Mt5Deal[], log: Log): Promise<{ inserted: number; trades: number; last: Date | null }> {
  const own: { d: Mt5Deal; time: Date }[] = [];
  for (const d of deals) {
    const time = dealTimeUtc(d);
    if (d.login !== a.login || time === null) {
      log.error({ accountId: a.id, ticket: d.ticket, login: d.login }, "The MT5 gateway returned a deal of another login or without a readable time; it was not stored");
      continue;
    }
    own.push({ d, time });
  }
  if (!own.length) return { inserted: 0, trades: 0, last: null };
  return transaction(db, async (conn) => {
    // The client row first, as everything that moves money locks it (money/ledger.ts): the inserts below check their
    // foreign keys on the account row before the client row, so without this a settle holding the client and
    // waiting for the account deadlocks with this page.
    await one(conn, "SELECT id FROM clients WHERE id = ? FOR SHARE", [a.client_id]);
    const tickets = own.map(({ d }) => d.ticket);
    const stored = new Map(
      (await rows<StoredDeal>(conn, `SELECT ticket, mt5_account_id, ${DEAL_FIELDS.join(", ")} FROM mt5_deals WHERE server_code = ? AND ticket IN (${marks(tickets)})`, [a.server_code, ...tickets])).map(
        (r) => [Number(r.ticket), r],
      ),
    );
    const fresh = own.filter(({ d }) => !stored.has(d.ticket));
    if (fresh.length) {
      const values = fresh.map(({ d, time }) => [a.server_code, d.ticket, a.id, a.client_id, a.login, ...fieldsOf(d, time)]);
      // The no-op update only covers a deal another sync stored a moment ago.
      // (Not INSERT IGNORE: that would also turn a bad value into a silent warning.)
      await conn.query<ResultSetHeader>(
        `INSERT INTO mt5_deals (${COLUMNS.join(", ")}) VALUES ${values.map((v) => `(${marks(v)})`).join(", ")} ON DUPLICATE KEY UPDATE ticket = ticket`,
        values.flat(),
      );
    }
    // Every position the page touched, new deal or not, so a trade is always rebuilt from all its deals.
    const positions = own.filter(({ d }) => (d.action === BUY || d.action === SELL) && d.positionId > 0).map(({ d }) => d.positionId);
    for (const { d, time } of own) {
      const was = stored.get(d.ticket);
      if (!was || Number(was.mt5_account_id) !== a.id) continue;
      const now = fieldsOf(d, time);
      const changed = changedFields(was, now);
      if (!changed.length) continue;
      // changed_at only here, never for a deal read again as it was: reconciliation reads a changed deal again from then.
      await exec(
        conn,
        `UPDATE mt5_deals SET ${DEAL_FIELDS.map((f) => `${f} = ?`).join(", ")}, changed_at = CURRENT_TIMESTAMP(3) WHERE server_code = ? AND ticket = ?`,
        [...now, a.server_code, d.ticket],
      );
      log.warn({ accountId: a.id, ticket: d.ticket, changed }, "MT5 changed a deal the CRM had stored; the stored copy was updated");
      // Its position is built again whatever the deal is now (a cancelled one is no longer a buy or sell), and so is the one it was in.
      positions.push(d.positionId, Number(was.position_id));
    }
    const trades = await rebuildTrades(conn, a, positions);
    return { inserted: fresh.length, trades, last: own.at(-1)!.time };
  });
}

/** Records how a sync ended. updated_at is kept: it tracks changes to the account, not reads. */
async function record(conn: Conn, accountId: number, end: { until?: Date; partial?: boolean; error: string | null }) {
  if (end.until) {
    await exec(
      conn,
      `UPDATE mt5_accounts SET deals_synced_until = ?, deals_sync_partial = ?, deals_synced_at = CURRENT_TIMESTAMP(3), deals_sync_error = ?, updated_at = updated_at WHERE id = ?`,
      [end.until, end.partial ? 1 : 0, end.error, accountId],
    );
  } else {
    await exec(conn, "UPDATE mt5_accounts SET deals_synced_at = CURRENT_TIMESTAMP(3), deals_sync_error = ?, updated_at = updated_at WHERE id = ?", [end.error, accountId]);
  }
}

const errorText = (e: SyncError) => `${e.kind}/${e.code}: ${e.message}`.slice(0, 200);

async function runSync(db: Db, gateway: Mt5Gateway, accountId: number, log: Log, budgetMs: number, run: Running): Promise<SyncResult> {
  const result: SyncResult = { outcome: "skipped", pages: 0, deals: 0, newDeals: 0, trades: 0, error: null };
  let last: Date | null = null;
  let a: SyncAccount | undefined;
  /**
   * Stops before the present: the cache is complete to the last deal stored, and the next sync carries on from it.
   * With nothing stored and nothing wrong the account is left as it was, so it is still due for the next sync
   * (stamped as synced, the same accounts would stop again on every trade history page and miss the background loop).
   */
  const stop = async (error: SyncError | null = null) => {
    result.outcome = "partial";
    result.error = error;
    const text = error && errorText(error);
    if (last) await record(db, a!.id, { until: last, partial: true, error: text });
    else if (text) await record(db, a!.id, { error: text });
    return result;
  };
  try {
    const row = await one<SyncAccount>(
      db,
      `SELECT id, client_id, server_code, login, status, created_at, mt5_registered_at, deals_synced_until, deals_sync_partial FROM mt5_accounts WHERE id = ?`,
      [accountId],
    );
    if (!row || row.status !== "active" || row.login === null || !(await serverEnabled(db, row.server_code))) return result;
    a = { ...row, id: Number(row.id), client_id: Number(row.client_id), login: Number(row.login), deals_sync_partial: Number(row.deals_sync_partial) };
    const started = Date.now();
    const deadline = started + budgetMs;
    const from = syncFrom(a).toISOString();
    // A fixed end: deals arriving meanwhile come after the ones read, so offsets stay put.
    const to = new Date(started + AHEAD_MS).toISOString();
    let offset = 0;
    for (;;) {
      const page = await callMt5(gateway, "deals.page", { server: a.server_code, login: a.login, from, to, offset, limit: DEALS_PER_PAGE }, log);
      // A trade history page that waited for this sync has answered: what came too late is read again next time.
      if (Date.now() >= run.stopAt) return await stop();
      result.pages++;
      result.deals += page.deals.length;
      const storing = storePage(db, a, page.deals, log);
      run.storing = storing;
      const stored = await storing.finally(() => (run.storing = null));
      result.newDeals += stored.inserted;
      result.trades += stored.trades;
      last = stored.last ?? last;
      offset += page.deals.length;
      if (offset >= page.total) {
        await record(db, a.id, { until: new Date(started), partial: false, error: null });
        result.outcome = "complete";
        return result;
      }
      // MT5 counts and pages in two reads (a deal can go in between): the deals past this offset were not read, so the
      // cache is not complete to now. The gateway's own deal search refuses the same answer.
      if (!page.deals.length) {
        log.warn({ accountId, offset, total: page.total }, "MT5's deal pages ended before its total; the next sync carries on from the last deal stored");
        return await stop({ kind: "unavailable", code: "mt5_error", message: "MT5's deal pages ended before its total; the next sync carries on from the last deal stored." });
      }
      // Always at least one page (unless told to stop), so a sync stopped on its budget still moves on.
      if (Date.now() >= deadline || Date.now() >= run.stopAt) return await stop();
    }
  } catch (error) {
    result.outcome = "failed";
    if (error instanceof GatewayError) {
      result.error = { kind: error.kind, code: error.code, message: error.message };
      // MT5 out of reach is expected now and then; a refusal (a group the gateway no longer allows) needs a look.
      if (error.kind !== "unavailable") log.warn({ accountId, kind: error.kind, code: error.code }, "MT5 deals could not be read");
    } else {
      result.error = { kind: "internal", code: "internal", message: "The sync failed inside the CRM; the server log has the details." };
      log.error({ err: error, accountId }, "Syncing MT5 deals failed");
    }
    if (a) {
      try {
        // Pages stored before the failure count: the next sync carries on after them.
        await record(db, a.id, last ? { until: last, partial: true, error: errorText(result.error) } : { error: errorText(result.error) });
      } catch (e) {
        log.error({ err: e, accountId }, "Could not record how an MT5 deals sync ended");
      }
    }
    return result;
  }
}

/**
 * Syncs one account's deals now and builds its trades: from deals_synced_until
 * less two days (straight on from it after a partial sync; the first time,
 * from a day before the account was opened) to an hour past now, 1000 deals
 * a page, until done or `budgetMs` has passed (checked after each page).
 * With `stopAt`, no page is stored from that time on (see Running).
 * Single-flight per account: while one runs, this returns the same result,
 * and a `stopAt` given now applies to it too. Never throws; problems are in
 * the result and on the account row.
 */
export function syncAccountDeals(db: Db, gateway: Mt5Gateway, accountId: number, log: Log, opts: { budgetMs?: number; stopAt?: number } = {}): Promise<SyncResult> {
  const running = inFlight.get(accountId);
  if (running) {
    if (opts.stopAt !== undefined) running.stopAt = Math.min(running.stopAt, opts.stopAt);
    return running.result;
  }
  const run = { stopAt: opts.stopAt ?? Infinity, storing: null } as Running;
  run.result = runSync(db, gateway, accountId, log, opts.budgetMs ?? SYNC_BUDGET_MS, run).finally(() => inFlight.delete(accountId));
  inFlight.set(accountId, run);
  return run.result;
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
 * The trade history's first page: syncs those of these accounts not synced
 * in the last minute (joining a sync already running), waiting at most
 * `budgetMs` in all. At the deadline the syncs stop storing pages, and a
 * page being stored just then is waited for, so this answer and the pages
 * after it read the same cache. Failures are ignored: the page shows what the
 * cache has.
 */
export async function syncStaleDeals(db: Db, gateway: Mt5Gateway, accountIds: number[], log: Log, opts: { budgetMs?: number; freshMs?: number } = {}) {
  if (!accountIds.length) return;
  const deadline = Date.now() + (opts.budgetMs ?? ON_DEMAND_BUDGET_MS);
  let timer: NodeJS.Timeout | undefined;
  let ids: number[] = [];
  try {
    const stale = await rows<{ id: number }>(
      db,
      `SELECT a.id FROM mt5_accounts a JOIN mt5_servers s ON s.code = a.server_code AND s.is_enabled = 1
       WHERE a.id IN (${marks(accountIds)}) AND a.status = 'active' AND a.login IS NOT NULL
         AND (a.deals_synced_at IS NULL OR a.deals_synced_at < CURRENT_TIMESTAMP(3) - INTERVAL ? SECOND)
       ORDER BY a.deals_synced_at IS NOT NULL, a.deals_synced_at, a.id`,
      [...accountIds, Math.floor((opts.freshMs ?? ON_DEMAND_FRESH_MS) / 1000)],
    );
    ids = stale.map((r) => Number(r.id));
    const work = eachAtMost(ids, ON_DEMAND_AT_ONCE, async (id) => {
      const left = deadline - Date.now();
      if (left > 0) await syncAccountDeals(db, gateway, id, log, { budgetMs: left, stopAt: deadline });
    }).catch((error) => log.error({ err: error }, "Syncing MT5 deals for a trade history failed"));
    await Promise.race([work, new Promise<void>((resolve) => (timer = setTimeout(resolve, Math.max(0, deadline - Date.now()))))]);
  } catch (error) {
    log.error({ err: error }, "Syncing MT5 deals for a trade history failed");
  } finally {
    clearTimeout(timer);
  }
  // Syncs that did not start in time, or are still waiting for MT5, now store nothing more.
  for (const id of ids) {
    const run = inFlight.get(id);
    if (run) run.stopAt = Math.min(run.stopAt, deadline);
  }
  await Promise.all(ids.map((id) => inFlight.get(id)?.storing?.catch(() => undefined)));
}

/**
 * One background pass: up to `limit` open accounts on switched-on servers,
 * one after another. First those not synced for a day (every account at
 * least daily), then those whose client used the portal or app in the last
 * day and were not synced in the last 5 minutes; within each, clients active
 * in the last day first, then the longest since a sync. Once a server cannot
 * be reached, its other accounts wait for the next pass.
 */
export async function syncDealsOnce(
  db: Db,
  gateway: Mt5Gateway,
  log: Log,
  opts: { limit?: number; budgetMs?: number; accountBudgetMs?: number } = {},
) {
  const deadline = Date.now() + (opts.budgetMs ?? LOOP_BUDGET_MS);
  const due = await rows<{ id: number; server_code: string }>(
    db,
    `SELECT id, server_code FROM (
       SELECT a.id, a.server_code, a.deals_synced_at,
         (a.deals_synced_at IS NULL OR a.deals_synced_at < CURRENT_TIMESTAMP(3) - INTERVAL 1 DAY) AS overdue,
         EXISTS (SELECT 1 FROM client_sessions cs WHERE cs.client_id = a.client_id AND cs.kind = 'login' AND cs.last_seen_at > CURRENT_TIMESTAMP(3) - INTERVAL 1 DAY) AS active_client
       FROM mt5_accounts a JOIN mt5_servers s ON s.code = a.server_code AND s.is_enabled = 1
       WHERE a.status = 'active' AND a.login IS NOT NULL
     ) due
     WHERE overdue = 1 OR (active_client = 1 AND deals_synced_at < CURRENT_TIMESTAMP(3) - INTERVAL ${ACTIVE_RESYNC_MINUTES} MINUTE)
     ORDER BY overdue DESC, active_client DESC, deals_synced_at IS NOT NULL, deals_synced_at, id
     LIMIT ?`,
    [opts.limit ?? LOOP_ACCOUNTS],
  );
  const counts = { accounts: 0, complete: 0, partial: 0, failed: 0, skipped: 0 };
  const unreachable = new Set<string>();
  for (const { id, server_code: server } of due) {
    if (Date.now() >= deadline) break;
    if (unreachable.has(server)) continue;
    const r = await syncAccountDeals(db, gateway, Number(id), log, { budgetMs: opts.accountBudgetMs ?? SYNC_BUDGET_MS });
    counts.accounts++;
    counts[r.outcome]++;
    if (r.error?.kind === "unavailable") unreachable.add(server);
  }
  return counts;
}

/** Runs the background deal sync every 5 minutes in the server process. */
export function startMt5DealSync(db: Db, gateway: Mt5Gateway | null, log: Logger, everyMs = LOOP_EVERY_MS) {
  if (!gateway) {
    log.info("MT5 is off: CRM_MT5_GATEWAY_URL is not set, so MT5 deals are not synced");
    return () => undefined;
  }
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    syncDealsOnce(db, gateway, log)
      .catch((e) => log.error({ err: e }, "MT5 deal sync failed"))
      .finally(() => (running = false));
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

/** An account's sync state, for staff. */
export async function loadSyncState(conn: Conn, accountId: number): Promise<SyncState | undefined> {
  return one<SyncState>(conn, "SELECT deals_synced_until, deals_synced_at, deals_sync_error, deals_sync_partial FROM mt5_accounts WHERE id = ?", [accountId]);
}
