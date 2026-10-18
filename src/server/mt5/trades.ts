import type { ResultSetHeader } from "mysql2/promise";
import { one, rows, transaction, type Conn, type Db } from "../lib/db";
import { toMajor } from "../money/amounts";
import { parseLogin } from "./accounts";

// Closed trades: one per fully closed MT5 position, or per closed part of a
// position a netting reversal turned, built from the position's deals in the
// cache (mt5_deals, see deals.ts), and what the portal and app read as trade
// history. MT5 has no closed-position record of its own, so a trade is
// assembled here: side, open time and open price from the deals that opened
// it, close time and close price from the last deal that closed it, money
// summed over its deals.
//
// Both clients check the history hard: an id seen twice, a status or side
// they do not know, a page with the wrong number of rows or a total that
// differs from the summary makes them refuse the whole list. So the summary
// and the page are read from one snapshot, ids carry the login (and the
// reversal that opened a part), and only closed buys and sells are ever rows.

/** MT5 deal entry: how a deal changes its position. */
export const ENTRY = { in: 0, out: 1, inOut: 2, outBy: 3 } as const;
/** MT5 deal actions that are trades; balance, credit and the rest (2 and up) never become one. */
export const BUY = 0;
export const SELL = 1;
/** MT5 volumes are in 1/10000 of a lot. */
export const VOLUME_PER_LOT = 10_000;
/** Positions rebuilt per query. */
const REBUILD_BATCH = 500;
/** Trade history page sizes: the portal asks for 500 at once, so the shared pageQuery (15 above 200) will not do. */
export const HISTORY_PER_PAGE = { default: 100, max: 500 } as const;

/** A deal as a trade is built from it. */
export interface TradeDeal {
  ticket: number;
  action: number;
  entry: number;
  symbol: string;
  volume: number;
  price: string;
  profitCents: number;
  commissionCents: number;
  swapCents: number;
  feeCents: number;
  timeUtc: Date;
}

export interface ClosedTrade {
  /** Which part of its position this is: 0 for the part it opened with, else the ticket of the INOUT deal that opened it. */
  segment: number;
  symbol: string;
  side: 0 | 1;
  volume: number;
  openPrice: string;
  closePrice: string;
  openTimeUtc: Date;
  closeTimeUtc: Date;
  profitCents: number;
  commissionCents: number;
  swapCents: number;
  feeCents: number;
}

const byTime = (a: TradeDeal, b: TradeDeal) => a.timeUtc.getTime() - b.timeUtc.getTime() || a.ticket - b.ticket;
const sum = (list: TradeDeal[], pick: (d: TradeDeal) => number) => list.reduce((total, d) => total + pick(d), 0);

const DECIMAL = /^(-?)(\d{1,20})(?:\.(\d{1,20}))?$/;

/**
 * The volume-weighted average of decimal price strings, to as many decimals
 * as the most precise of them, rounded half away from zero. Exact (BigInt),
 * so a price never passes through a float. One fill is its own price.
 */
export function averagePrice(fills: { price: string; volume: number }[]): string {
  const first = fills[0]?.price ?? "0";
  if (fills.length <= 1) return first;
  const parsed = fills.map((f) => DECIMAL.exec(f.price));
  if (parsed.some((m) => !m)) return first;
  const scale = Math.max(...parsed.map((m) => m![3]?.length ?? 0));
  let weighted = 0n;
  let volume = 0n;
  fills.forEach((f, i) => {
    const m = parsed[i]!;
    const units = BigInt(m[2]! + (m[3] ?? "").padEnd(scale, "0"));
    weighted += (m[1] ? -units : units) * BigInt(f.volume);
    volume += BigInt(f.volume);
  });
  if (volume <= 0n) return first;
  const negative = weighted < 0n;
  const q = (2n * (negative ? -weighted : weighted) + volume) / (2n * volume);
  const digits = q.toString().padStart(scale + 1, "0");
  const text = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
  return negative && q !== 0n ? `-${text}` : text;
}

/** One part of a position while its deals are read. */
interface Part {
  segment: number;
  side: 0 | 1;
  symbol: string;
  openTimeUtc: Date;
  /** What opened it, at what price: its IN deals that way and, after a reversal, the volume the INOUT deal opened. */
  fills: { price: string; volume: number }[];
  /** Its OUT and OUT_BY volume so far. */
  closedVolume: number;
  /** The deal that closed it last, so far. */
  closedBy: TradeDeal | null;
  /** The deals whose money is this part's. */
  deals: TradeDeal[];
}

const openedVolume = (p: Part) => p.fills.reduce((total, f) => total + f.volume, 0);

const tradeOf = (p: Part, closedBy: TradeDeal): ClosedTrade => ({
  segment: p.segment,
  symbol: p.symbol,
  side: p.side,
  volume: openedVolume(p),
  openPrice: averagePrice(p.fills),
  closePrice: closedBy.price,
  openTimeUtc: p.openTimeUtc,
  closeTimeUtc: closedBy.timeUtc,
  profitCents: sum(p.deals, (d) => d.profitCents),
  commissionCents: sum(p.deals, (d) => d.commissionCents),
  swapCents: sum(p.deals, (d) => d.swapCents),
  feeCents: sum(p.deals, (d) => d.feeCents),
});

/**
 * The closed trades one position's deals make, oldest first. None while it
 * is still open, or when its opening deal is not in the cache, so it cannot
 * be shown; and none from a reversal on that the deals do not explain.
 *
 * The side is the first opening deal's. The volume is what was opened in
 * that direction (a netting account can add to a position with more IN
 * deals), and the open price their average. The position is closed when its
 * OUT and OUT_BY volume reaches that, or when an INOUT deal reverses it: on
 * a netting account the reversal closes what was open and opens the rest the
 * other way under the same position id. So a reversed position comes in
 * parts, each a trade of its own. The part the reversal closed ends at that
 * deal. The remainder starts there: the other side, the deal's price and
 * time, and the volume the deal opened (its volume less what was still
 * open). It is closed like any position, by OUT and OUT_BY deals or by the
 * next reversal, and until then it is not a row.
 *
 * All of the INOUT deal's money goes to the part it closed. Its profit is
 * what closing that part made. MT5 gives a deal one commission and one fee,
 * and nothing that says how much of them was for the closing side, so they
 * are not split either: each is shown once, in the row of the deal it was
 * charged on, as soon as it was charged.
 *
 * Each part is keyed by `segment`: 0 for the part the position opened with,
 * then the ticket of the INOUT deal that opened it. A key does not move as
 * later deals come in, so a rebuild writes the same rows again.
 */
export function closedTrades(deals: TradeDeal[]): ClosedTrade[] {
  const trades: ClosedTrade[] = [];
  let part: Part | null = null;
  for (const d of deals.filter((x) => x.action === BUY || x.action === SELL).sort(byTime)) {
    if (!part) {
      // Without the deal that opened the position nothing is shown: what a reversal opened depends on what it closed.
      if (d.entry !== ENTRY.in) return trades;
      part = { segment: 0, side: d.action as 0 | 1, symbol: d.symbol, openTimeUtc: d.timeUtc, fills: [d], closedVolume: 0, closedBy: null, deals: [d] };
      continue;
    }
    part.deals.push(d);
    if (d.entry === ENTRY.in && d.action === part.side) part.fills.push(d);
    if (d.entry === ENTRY.out || d.entry === ENTRY.outBy) {
      part.closedVolume += d.volume;
      part.closedBy = d;
    }
    if (d.entry !== ENTRY.inOut) continue;
    const opened: number = d.volume - (openedVolume(part) - part.closedVolume);
    // MT5 makes no reversal the same way as the position, or one that opens nothing: the cache is missing a deal (or MT5
    // cancelled one), so neither this part nor what follows is guessed at.
    if (d.action === part.side || opened <= 0) return trades;
    trades.push(tradeOf(part, d));
    part = { segment: d.ticket, side: d.action as 0 | 1, symbol: d.symbol, openTimeUtc: d.timeUtc, fills: [{ price: d.price, volume: opened }], closedVolume: 0, closedBy: null, deals: [] };
  }
  if (part?.closedBy && part.closedVolume >= openedVolume(part)) trades.push(tradeOf(part, part.closedBy));
  return trades;
}

// ---------- Building ----------

/** The account a sync is storing for. */
export interface TradeAccount {
  id: number;
  client_id: number;
  server_code: string;
  login: number;
}

interface DealDbRow {
  position_id: number;
  ticket: number;
  action: number;
  entry: number;
  symbol: string;
  volume: number;
  price: string;
  profit_cents: number;
  commission_cents: number;
  swap_cents: number;
  fee_cents: number;
  time_utc: Date;
}

const marks = (list: unknown[]) => list.map(() => "?").join(", ");

const TRADE_COLUMNS = [
  "client_id", "server_code", "login", "symbol", "side", "volume", "open_price", "close_price", "open_time_utc", "close_time_utc",
  "profit_cents", "commission_cents", "swap_cents", "fee_cents",
] as const;

/**
 * Builds the trades of these positions again from the account's cached
 * deals: closed ones (a part of a reversed position each) are written or
 * rewritten, and the position's rows this build no longer makes are taken
 * out: a position open again, or a part whose reversal MT5 cancelled or
 * changed. Returns how many trades are closed. Statements of any length go
 * through query, not execute: a prepared statement per row count would pile
 * up on the server.
 *
 * Only rows that are there are deleted, by their whole key: under REPEATABLE
 * READ a DELETE of a key that is not there locks the gap up to the next row,
 * which can be the next account's first trade, and two syncs of neighbouring
 * accounts then deadlock on each other's next insert into that gap.
 */
export async function rebuildTrades(conn: Conn, account: TradeAccount, positionIds: Iterable<number>): Promise<number> {
  const ids = [...new Set(positionIds)].filter((id) => Number.isSafeInteger(id) && id > 0);
  let closed = 0;
  for (let i = 0; i < ids.length; i += REBUILD_BATCH) {
    const batch = ids.slice(i, i + REBUILD_BATCH);
    const found = await rows<DealDbRow>(
      conn,
      `SELECT position_id, ticket, action, entry, symbol, volume, price, profit_cents, commission_cents, swap_cents, fee_cents, time_utc
       FROM mt5_deals WHERE mt5_account_id = ? AND action IN (${BUY}, ${SELL}) AND position_id IN (${marks(batch)})`,
      [account.id, ...batch],
    );
    const byPosition = new Map<number, TradeDeal[]>();
    for (const d of found) {
      const list = byPosition.get(Number(d.position_id)) ?? [];
      list.push({
        ticket: Number(d.ticket), action: Number(d.action), entry: Number(d.entry), symbol: d.symbol, volume: Number(d.volume), price: d.price,
        profitCents: Number(d.profit_cents), commissionCents: Number(d.commission_cents), swapCents: Number(d.swap_cents), feeCents: Number(d.fee_cents), timeUtc: d.time_utc,
      });
      byPosition.set(Number(d.position_id), list);
    }
    const built = batch.flatMap((id) => closedTrades(byPosition.get(id) ?? []).map((t) => [id, t] as const));
    if (built.length) {
      const values = built.map(([id, t]) => [
        account.id, id, t.segment, account.client_id, account.server_code, account.login, t.symbol, t.side, t.volume, t.openPrice, t.closePrice, t.openTimeUtc, t.closeTimeUtc,
        t.profitCents, t.commissionCents, t.swapCents, t.feeCents,
      ]);
      await conn.query<ResultSetHeader>(
        `INSERT INTO mt5_trades (mt5_account_id, position_id, segment, ${TRADE_COLUMNS.join(", ")})
         VALUES ${values.map((v) => `(${marks(v)})`).join(", ")}
         ON DUPLICATE KEY UPDATE ${TRADE_COLUMNS.map((c) => `${c} = VALUES(${c})`).join(", ")}`,
        values.flat(),
      );
    }
    const kept = new Set(built.map(([id, t]) => `${id}:${t.segment}`));
    const there = await rows<{ position_id: number; segment: number }>(
      conn,
      `SELECT position_id, segment FROM mt5_trades WHERE mt5_account_id = ? AND position_id IN (${marks(batch)})`,
      [account.id, ...batch],
    );
    const gone = there.map((t) => [Number(t.position_id), Number(t.segment)]).filter(([id, segment]) => !kept.has(`${id}:${segment}`));
    if (gone.length) {
      await conn.query<ResultSetHeader>(
        `DELETE FROM mt5_trades WHERE (mt5_account_id, position_id, segment) IN (${gone.map(() => "(?, ?, ?)").join(", ")})`,
        gone.flatMap(([id, segment]) => [account.id, id, segment]),
      );
    }
    closed += built.length;
  }
  return closed;
}

// ---------- Reading ----------

export interface TradeRow {
  mt5_account_id: number;
  position_id: number;
  /** 0, or the ticket of the reversal that opened this part of the position (see closedTrades). */
  segment: number;
  client_id: number;
  login: number;
  symbol: string;
  side: 0 | 1;
  volume: number;
  open_price: string;
  close_price: string;
  open_time_utc: Date;
  close_time_utc: Date;
  profit_cents: number;
  commission_cents: number;
  swap_cents: number;
  fee_cents: number;
}

const SELECT_TRADE = `SELECT t.mt5_account_id, t.position_id, t.segment, t.client_id, t.login, t.symbol, t.side, t.volume, t.open_price, t.close_price,
  t.open_time_utc, t.close_time_utc, t.profit_cents, t.commission_cents, t.swap_cents, t.fee_cents
  FROM mt5_trades t`;
/**
 * Newest close first; then the account, so two accounts' trades closed at once still page in one fixed order, and
 * the part last, so two parts of a position closed at once do too (the whole key, so the order never ties).
 */
const TRADE_ORDER = "ORDER BY t.close_time_utc DESC, t.position_id DESC, t.mt5_account_id DESC, t.segment DESC";

const tradeFromDb = (t: TradeRow): TradeRow => ({
  ...t,
  mt5_account_id: Number(t.mt5_account_id),
  position_id: Number(t.position_id),
  segment: Number(t.segment),
  client_id: Number(t.client_id),
  login: Number(t.login),
  side: Number(t.side) === SELL ? SELL : BUY,
  volume: Number(t.volume),
  profit_cents: Number(t.profit_cents),
  commission_cents: Number(t.commission_cents),
  swap_cents: Number(t.swap_cents),
  fee_cents: Number(t.fee_cents),
});

interface Sums {
  n: number | string;
  profit: number | string;
  volume: number | string;
  commission: number | string;
  swap: number | string;
  fee: number | string;
}
const SUMS = `SELECT COUNT(*) AS n, COALESCE(SUM(t.profit_cents), 0) AS profit, COALESCE(SUM(t.volume), 0) AS volume,
  COALESCE(SUM(t.commission_cents), 0) AS commission, COALESCE(SUM(t.swap_cents), 0) AS swap, COALESCE(SUM(t.fee_cents), 0) AS fee
  FROM mt5_trades t`;

export interface TradeTotals {
  trades: number;
  profitCents: number;
  volume: number;
  commissionCents: number;
  swapCents: number;
  feeCents: number;
}
export const NO_TRADES: TradeTotals = { trades: 0, profitCents: 0, volume: 0, commissionCents: 0, swapCents: 0, feeCents: 0 };

const totalsOf = (s: Sums | undefined): TradeTotals => ({
  trades: Number(s?.n ?? 0),
  profitCents: Number(s?.profit ?? 0),
  volume: Number(s?.volume ?? 0),
  commissionCents: Number(s?.commission ?? 0),
  swapCents: Number(s?.swap ?? 0),
  feeCents: Number(s?.fee ?? 0),
});

/**
 * One page of trades and the totals of everything the filter matches, read
 * in one transaction so both come from the same snapshot: a sync writing
 * trades in between cannot make the page disagree with its own total.
 */
async function pageOf(db: Db, where: string, params: unknown[], page: number, perPage: number): Promise<{ totals: TradeTotals; items: TradeRow[] }> {
  return transaction(db, async (conn) => {
    const totals = totalsOf(await one<Sums>(conn, `${SUMS} ${where}`, params));
    const offset = (page - 1) * perPage;
    const items = offset < totals.trades ? await rows<TradeRow>(conn, `${SELECT_TRADE} ${where} ${TRADE_ORDER} LIMIT ? OFFSET ?`, [...params, perPage, offset]) : [];
    return { totals, items: items.map(tradeFromDb) };
  });
}

/** A client's trades on some of their accounts, closed between two UTC times (either may be open). */
export function clientTradePage(
  db: Db,
  filter: { clientId: number; accountIds: number[]; from: Date | null; to: Date | null },
  page: number,
  perPage: number,
) {
  let where = `WHERE t.client_id = ? AND t.mt5_account_id IN (${marks(filter.accountIds)})`;
  const params: unknown[] = [filter.clientId, ...filter.accountIds];
  if (filter.from) (where += " AND t.close_time_utc >= ?"), params.push(filter.from);
  if (filter.to) (where += " AND t.close_time_utc <= ?"), params.push(filter.to);
  return pageOf(db, where, params, page, perPage);
}

/** One account's trades, newest close first (staff). */
export const accountTradePage = (db: Db, accountId: number, page: number, perPage: number) =>
  pageOf(db, "WHERE t.mt5_account_id = ?", [accountId], page, perPage);

// ---------- The client's view ----------

const signed = /^-?\d{1,9}$/;
const whole = (v: unknown) => (typeof v === "string" && signed.test(v.trim()) ? Number(v.trim()) : null);

/** A YYYY-MM-DD that is a real day, or null. */
function utcDay(v: unknown): string | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v) ? v : null;
}

/**
 * GET /api/trade-history's parameters. Anything malformed is ignored, as if
 * it had not been sent: page from 1, per_page clamped to 1..500 (100 when
 * absent), days as UTC (a whole day: from its first to its last millisecond),
 * account_id a login.
 */
export function historyQuery(q: Record<string, unknown>) {
  const page = Math.max(1, whole(q.page) ?? 1);
  const perPage = Math.min(HISTORY_PER_PAGE.max, Math.max(1, whole(q.per_page) ?? HISTORY_PER_PAGE.default));
  const fromDate = utcDay(q.from_date);
  const toDate = utcDay(q.to_date);
  const login = parseLogin(q.account_id);
  return {
    page,
    perPage,
    login,
    from: fromDate ? new Date(`${fromDate}T00:00:00.000Z`) : null,
    to: toDate ? new Date(`${toDate}T23:59:59.999Z`) : null,
    filters: { from_date: fromDate, to_date: toDate, account_id: login === null ? null : String(login) },
  };
}

/**
 * A trade's key within its account: the position id, and for a part of the
 * position a reversal opened, "-r" and that INOUT deal's ticket. A position
 * that was never reversed keeps its plain id.
 */
const tradeKey = (t: Pick<TradeRow, "position_id" | "segment">) => (t.segment ? `${t.position_id}-r${t.segment}` : String(t.position_id));

/**
 * What makes each account's trade ids unique among all of the client's
 * accounts. Ids are "<login>-<position>" (with "-r<ticket>" for a part a
 * reversal opened, see tradeKey); two of a client's accounts can only share
 * a login on different MT5 servers (live and demo), where position ids can
 * repeat too, so every account after the first with that login (oldest
 * first) adds "-2", "-3" at the end. The app drops a history with an id seen
 * twice. Taken over all the client's accounts, so an id does not change with
 * the filter.
 */
export function tradeIdSuffixes(accounts: { id: number; login: number | null }[]): Map<number, string> {
  const seen = new Map<number, number>();
  const suffixes = new Map<number, string>();
  for (const a of [...accounts].sort((x, y) => x.id - y.id)) {
    if (a.login === null) continue;
    const n = (seen.get(a.login) ?? 0) + 1;
    seen.set(a.login, n);
    suffixes.set(a.id, n === 1 ? "" : `-${n}`);
  }
  return suffixes;
}

/** A row of GET /api/trade-history, as both clients parse it. Money in dollars, lots for volume, times as ISO UTC. */
export function presentClientTrade(t: TradeRow, account: { currency: string }, idSuffix: string) {
  const login = String(t.login);
  return {
    id: `${login}-${tradeKey(t)}${idSuffix}`,
    // The MT5 position, as the terminal shows it: every part of a reversed position has the same one.
    ticket: t.position_id,
    symbol: t.symbol,
    side: t.side,
    type: t.side === SELL ? "sell" : "buy",
    volume: t.volume / VOLUME_PER_LOT,
    open_price: Number(t.open_price),
    close_price: Number(t.close_price),
    // Gross: commission and swap are their own fields, and the portal adds commission up on its own.
    pnl: toMajor(t.profit_cents),
    profit: toMajor(t.profit_cents),
    commission: toMajor(t.commission_cents),
    swap: toMajor(t.swap_cents),
    currency: account.currency,
    account: login,
    login,
    status: "closed",
    opened_at: t.open_time_utc.toISOString(),
    closed_at: t.close_time_utc.toISOString(),
  };
}

/** The summary of GET /api/trade-history: over everything the filter matches, never just the page. */
export const presentClientSummary = (s: TradeTotals) => ({
  total_trades: s.trades,
  total_profit: toMajor(s.profitCents),
  total_volume: s.volume / VOLUME_PER_LOT,
  total_commission: toMajor(s.commissionCents),
});

// ---------- The staff view ----------

export const presentStaffTrade = (t: TradeRow) => ({
  /** Unique among the account's trades: the parts of a reversed position share their positionId. */
  id: tradeKey(t),
  positionId: t.position_id,
  /** The reversal (INOUT) deal that opened this part of the position; null for the part the position opened with. */
  reversalTicket: t.segment || null,
  symbol: t.symbol,
  side: t.side === SELL ? "sell" : "buy",
  /** In 1/10000 of a lot, as MT5 has it; `lots` is the same as a number of lots. */
  volume: t.volume,
  lots: t.volume / VOLUME_PER_LOT,
  openPrice: t.open_price,
  closePrice: t.close_price,
  openedAt: t.open_time_utc.toISOString(),
  closedAt: t.close_time_utc.toISOString(),
  profitCents: t.profit_cents,
  commissionCents: t.commission_cents,
  swapCents: t.swap_cents,
  feeCents: t.fee_cents,
  netCents: t.profit_cents + t.commission_cents + t.swap_cents + t.fee_cents,
});

export const presentStaffTotals = (s: TradeTotals) => ({
  trades: s.trades,
  lots: s.volume / VOLUME_PER_LOT,
  profitCents: s.profitCents,
  commissionCents: s.commissionCents,
  swapCents: s.swapCents,
  feeCents: s.feeCents,
  netCents: s.profitCents + s.commissionCents + s.swapCents + s.feeCents,
});
