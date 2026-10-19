import type { Logger } from "pino";
import { rows, type Conn } from "../lib/db";

// An IB's network is every client below them in the clients.referred_by chain,
// down to MAX_DEPTH levels. Nothing in this round changes referred_by: it is
// set once, at sign-up, from the code of a client whose account is not closed.
//
// Invariant for later rounds (history import, ib.edit): any code that sets or
// changes referred_by locks both client rows (lockClient, lower id first) and
// refuses a sponsor that is the client or is inside the client's own network
// (networkOf(conn, clientId) contains the sponsor). The queries below still
// stop on a loop, so a bad row cannot hang a request, but the tree shown to
// the client and the counts would be wrong.

export const MAX_DEPTH = 10;
/** Above this, a network is cut off (and logged): no real IB has one this size, and every read would be slow. */
export const MAX_NETWORK = 20_000;

export interface Member {
  id: number;
  /** 1 for the IB's direct referrals. */
  level: number;
  sponsorId: number;
  createdAt: Date;
}

/**
 * Everyone in the IB's network, each once at their lowest level, ordered by
 * level, then sign-up time, then id. Never contains the IB. The path column
 * stops a loop in referred_by from repeating, so each id appears at most once
 * per path; the outer query keeps the lowest level.
 */
export async function networkOf(conn: Conn, ibId: number, log?: Pick<Logger, "warn">): Promise<Member[]> {
  const found = await rows<{ id: number; level: number; sponsor_id: number; created_at: Date }>(
    conn,
    `WITH RECURSIVE net (id, level, sponsor_id, created_at, path) AS (
       SELECT c.id, 1, c.referred_by, c.created_at, CAST(CONCAT(',', ?, ',', c.id, ',') AS CHAR(600))
       FROM clients c WHERE c.referred_by = ? AND c.id <> ?
       UNION ALL
       SELECT c.id, n.level + 1, c.referred_by, c.created_at, CONCAT(n.path, c.id, ',')
       FROM net n JOIN clients c ON c.referred_by = n.id
       WHERE n.level < ? AND LOCATE(CONCAT(',', c.id, ','), n.path) = 0
       LIMIT ${MAX_NETWORK + 1}
     )
     SELECT id, level, sponsor_id, created_at FROM net`,
    [ibId, ibId, ibId, MAX_DEPTH],
  );
  const lowest = new Map<number, Member>();
  for (const r of found) {
    const id = Number(r.id);
    const level = Number(r.level);
    const had = lowest.get(id);
    if (!had || level < had.level) lowest.set(id, { id, level, sponsorId: Number(r.sponsor_id), createdAt: r.created_at });
  }
  const members = [...lowest.values()].sort((a, b) => a.level - b.level || a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id);
  if (found.length > MAX_NETWORK) {
    log?.warn({ ibId, found: found.length }, "IB network over the size limit; cut off");
    return members.slice(0, MAX_NETWORK);
  }
  return members;
}

/** A small time-limited cache, one per router, so a client opening the IB pages does not rebuild their network on every call. */
export class TtlCache<T> {
  private entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private ttlMs: number,
    private max = 2_000,
  ) {}

  async get(key: string, load: () => Promise<T>, now = Date.now()): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > now) return hit.value;
    const value = await load();
    if (this.entries.size >= this.max) {
      for (const [k, e] of this.entries) if (e.expiresAt <= now) this.entries.delete(k);
      // Still full of live entries: drop the oldest.
      if (this.entries.size >= this.max) this.entries.delete(this.entries.keys().next().value!);
    }
    this.entries.set(key, { value, expiresAt: now + this.ttlMs });
    return value;
  }
}

// ---------- Figures per client, for the ids of one page or of a whole network ----------

const CHUNK = 1_000;

/** Runs `query` for the ids in chunks of CHUNK and merges the rows (each query groups by client). */
async function chunked<R>(ids: readonly number[], query: (marks: string, part: number[]) => Promise<R[]>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    out.push(...(await query(part.map(() => "?").join(","), part)));
  }
  return out;
}

export interface Window {
  from: Date;
  to: Date;
}

/** UTC calendar month "YYYY-MM" as a [from, to) window. */
export function monthWindow(month: string): Window {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return { from: new Date(Date.UTC(y, m - 1, 1)), to: new Date(Date.UTC(y, m, 1)) };
}

/** Approved deposits per client: how many and the USD cents credited, optionally only those approved within `window`. */
export async function approvedDeposits(conn: Conn, ids: readonly number[], window?: Window) {
  const found = await chunked(ids, (marks, part) =>
    rows<{ client_id: number; n: number; cents: string | number | null; first_at: Date | null }>(
      conn,
      `SELECT client_id, COUNT(*) AS n, SUM(credited_cents) AS cents, MIN(decided_at) AS first_at FROM deposits
       WHERE status = 'approved' AND client_id IN (${marks})${window ? " AND decided_at >= ? AND decided_at < ?" : ""} GROUP BY client_id`,
      window ? [...part, window.from, window.to] : part,
    ),
  );
  return new Map(found.map((r) => [Number(r.client_id), { count: Number(r.n), cents: Number(r.cents ?? 0), firstAt: r.first_at }]));
}

/** Paid withdrawals per client: how many and the USD cents. */
export async function paidWithdrawals(conn: Conn, ids: readonly number[]) {
  const found = await chunked(ids, (marks, part) =>
    rows<{ client_id: number; n: number; cents: string | number | null }>(
      conn,
      `SELECT client_id, COUNT(*) AS n, SUM(amount_cents) AS cents FROM withdrawals WHERE status = 'paid' AND client_id IN (${marks}) GROUP BY client_id`,
      part,
    ),
  );
  return new Map(found.map((r) => [Number(r.client_id), { count: Number(r.n), cents: Number(r.cents ?? 0) }]));
}

/** Lots traded per client on closed trades of live (not demo) MT5 accounts. mt5_trades.volume is in 1/10000 of a lot. */
export async function lotsTraded(conn: Conn, ids: readonly number[]) {
  const found = await chunked(ids, (marks, part) =>
    rows<{ client_id: number; volume: string | number | null }>(
      conn,
      `SELECT t.client_id, SUM(t.volume) AS volume FROM mt5_trades t JOIN mt5_accounts a ON a.id = t.mt5_account_id
       WHERE a.is_demo = 0 AND t.client_id IN (${marks}) GROUP BY t.client_id`,
      part,
    ),
  );
  return new Map(found.map((r) => [Number(r.client_id), Number(r.volume ?? 0) / 10_000]));
}

/** How many clients each of these clients referred directly. */
export async function directReferralCounts(conn: Conn, ids: readonly number[]) {
  const found = await chunked(ids, (marks, part) =>
    rows<{ id: number; n: number }>(conn, `SELECT referred_by AS id, COUNT(*) AS n FROM clients WHERE referred_by IN (${marks}) GROUP BY referred_by`, part),
  );
  return new Map(found.map((r) => [Number(r.id), Number(r.n)]));
}

/** Which of these clients are IBs now: an active partnership on an account that is not closed. */
export async function activePartnersAmong(conn: Conn, ids: readonly number[]) {
  const found = await chunked(ids, (marks, part) =>
    rows<{ client_id: number }>(
      conn,
      `SELECT p.client_id FROM ib_partners p JOIN clients c ON c.id = p.client_id WHERE p.status = 'active' AND c.status <> 'closed' AND p.client_id IN (${marks})`,
      part,
    ),
  );
  return new Set(found.map((r) => Number(r.client_id)));
}

/** Members whose chain up to the IB passes through one of the sub-IBs (the sub-IBs' own networks). */
export function inSubIbNetworks(members: readonly Member[], subIbs: ReadonlySet<number>) {
  const sponsor = new Map(members.map((m) => [m.id, m.sponsorId]));
  let count = 0;
  for (const m of members) {
    let up = sponsor.get(m.id);
    for (let step = 0; up !== undefined && step < MAX_DEPTH; step++) {
      if (subIbs.has(up)) {
        count++;
        break;
      }
      up = sponsor.get(up);
    }
  }
  return count;
}

/** USD cents as a number with 2 decimals, the way both front ends read money. */
export const usd = (cents: number) => Math.round(cents) / 100;
/** Lots with 2 decimals. */
export const lots = (value: number) => Math.round(value * 100) / 100;
