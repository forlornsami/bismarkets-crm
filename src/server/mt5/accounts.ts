import type { Mt5Account } from "../../gateway/protocol";
import { exec, one, rows, type Conn, type Db } from "../lib/db";
import { toMajor } from "../money/amounts";
import { GatewayError, type Mt5Gateway } from "./gateway";
import type { Mt5Passwords } from "./passwords";
import { enabledServers } from "./settings";

// A client's MT5 accounts as the CRM keeps them: the row, the lookups the
// client and staff routes share, the shape both front ends parse, and the
// cached money figures (the "snapshot") with their live refresh.

/** Both clients show this server name whatever the API says, so it is the only one the CRM ever sends. */
export const MT5_SERVER_NAME = "BISMarkets-Trade";
/** Figures newer than this are shown as they are; older ones are read from MT5 again. */
export const SNAPSHOT_FRESH_MS = 15_000;
/** How long a client's account list waits for live figures before showing the cached ones. */
export const LIVE_BUDGET_MS = 3_000;
/** The most logins one accounts.get may name (the gateway's limit). */
const LOGINS_PER_CALL = 100;

export type AccountStatus = "creating" | "active" | "unknown" | "failed";

export interface AccountRow {
  id: number;
  client_id: number;
  server_code: string;
  login: number | null;
  is_demo: number;
  package_id: number | null;
  package_name: string;
  mt5_group: string;
  currency: string;
  leverage: number;
  status: AccountStatus;
  create_ref: string;
  failure: string | null;
  checks: number;
  next_check_at: Date | null;
  archived_at: Date | null;
  suspended_at: Date | null;
  suspended_by: number | null;
  suspended_reason: string | null;
  balance_cents: number | null;
  credit_cents: number | null;
  equity_cents: number | null;
  margin_cents: number | null;
  margin_free_cents: number | null;
  snapshot_at: Date | null;
  mt5_registered_at: Date | null;
  created_ip: string;
  created_at: Date;
  updated_at: Date;
}

export const SELECT_ACCOUNT = `SELECT a.id, a.client_id, a.server_code, a.login, a.is_demo, a.package_id, a.package_name, a.mt5_group, a.currency, a.leverage,
  a.status, a.create_ref, a.failure, a.checks, a.next_check_at, a.archived_at, a.suspended_at, a.suspended_by, a.suspended_reason,
  a.balance_cents, a.credit_cents, a.equity_cents, a.margin_cents, a.margin_free_cents, a.snapshot_at, a.mt5_registered_at, a.created_ip,
  a.created_at, a.updated_at
  FROM mt5_accounts a`;

const cents = (v: number | string | null) => (v === null ? null : Number(v));

/** BIGINT columns as numbers (MySQL may hand back strings for some of them). */
export const accountFromDb = <T extends AccountRow>(a: T): T => ({
  ...a,
  id: Number(a.id),
  client_id: Number(a.client_id),
  login: a.login === null ? null : Number(a.login),
  package_id: a.package_id === null ? null : Number(a.package_id),
  leverage: Number(a.leverage),
  checks: Number(a.checks),
  balance_cents: cents(a.balance_cents),
  credit_cents: cents(a.credit_cents),
  equity_cents: cents(a.equity_cents),
  margin_cents: cents(a.margin_cents),
  margin_free_cents: cents(a.margin_free_cents),
});

export async function loadAccount(conn: Conn, id: number, lock = false): Promise<AccountRow | undefined> {
  const a = await one<AccountRow>(conn, `${SELECT_ACCOUNT} WHERE a.id = ?${lock ? " FOR UPDATE" : ""}`, [id]);
  return a && accountFromDb(a);
}

/** An MT5 login as the portal and app send it (digits as text, or a number), or null. */
export function parseLogin(value: unknown): number | null {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^\d{1,15}$/.test(text)) return null;
  const login = Number(text);
  return login > 0 ? login : null;
}

/**
 * The caller's own open account with this login: client, login and status
 * 'active' must all match. `demo` picks the live or demo one when it matters
 * (separate MT5 servers could reuse a login); `lock` takes the row for update.
 */
export async function clientAccountByLogin(conn: Conn, clientId: number, login: unknown, opts: { demo?: boolean; lock?: boolean } = {}): Promise<AccountRow | undefined> {
  const number = parseLogin(login);
  if (number === null) return undefined;
  const demo = opts.demo === undefined ? "" : ` AND a.is_demo = ${opts.demo ? 1 : 0}`;
  const a = await one<AccountRow>(
    conn,
    `${SELECT_ACCOUNT} WHERE a.client_id = ? AND a.login = ? AND a.status = 'active'${demo} ORDER BY a.id DESC LIMIT 1${opts.lock ? " FOR UPDATE" : ""}`,
    [clientId, number],
  );
  return a && accountFromDb(a);
}

/** The client's open accounts, newest first. */
export async function clientAccounts(conn: Conn, clientId: number): Promise<AccountRow[]> {
  const list = await rows<AccountRow>(conn, `${SELECT_ACCOUNT} WHERE a.client_id = ? AND a.status = 'active' ORDER BY a.created_at DESC, a.id DESC`, [clientId]);
  return list.map(accountFromDb);
}

/**
 * One row of GET /api/mt5-accounts, as both front ends parse it. The login is
 * the id everywhere, as text. A staff switch-off is "suspended"; the client's
 * own archive stays "active" with archived true ("archived" as a status
 * makes the portal refuse the whole list). `passwords` only for the client's
 * own session: otherwise both are null, which the portal shows as "not
 * available" and the app as "Not supplied by server" ("" would show blank in
 * the app).
 */
export function presentClientAccount(a: AccountRow, passwords: Mt5Passwords | null = null) {
  const login = String(a.login);
  const suspended = a.suspended_at !== null;
  const leverage = String(a.leverage);
  const major = (v: number | null) => toMajor(v ?? 0);
  const balance = major(a.balance_cents);
  const equity = major(a.equity_cents);
  const credit = major(a.credit_cents);
  return {
    id: login,
    account_id: login,
    login,
    is_demo: a.is_demo === 1,
    type: a.is_demo === 1 ? "demo" : "real",
    status: suspended ? "suspended" : "active",
    archived: !suspended && a.archived_at !== null,
    package_name: a.package_name,
    package_id: a.package_id,
    // The real code, and its lower-case twin: a mismatch would make the portal's totals 100 times too large for cent accounts.
    currency: a.currency,
    currency_type: a.currency.toLowerCase(),
    leverage,
    balance,
    equity,
    credit,
    mt5:
      a.snapshot_at === null
        ? null
        : { login, balance, equity, credit, margin: major(a.margin_cents), free_margin: major(a.margin_free_cents), leverage, currency: a.currency },
    server: MT5_SERVER_NAME,
    created_at: (a.mt5_registered_at ?? a.created_at).toISOString(),
    password: passwords?.main ?? null,
    investor_password: passwords?.investor ?? null,
  };
}

// ---------- Activation ----------

/**
 * Marks a created account open with its login and empty figures. Only from
 * 'creating' or 'unknown', so the request that created it and the resolver
 * cannot both do it. Returns false when it was already settled.
 */
export async function activateAccount(conn: Conn, accountId: number, login: number): Promise<boolean> {
  const r = await exec(
    conn,
    `UPDATE mt5_accounts SET status = 'active', login = ?, failure = NULL, next_check_at = NULL,
       balance_cents = 0, credit_cents = 0, equity_cents = 0, margin_cents = 0, margin_free_cents = 0, snapshot_at = CURRENT_TIMESTAMP(3)
     WHERE id = ? AND status IN ('creating', 'unknown')`,
    [login, accountId],
  );
  return r.affectedRows === 1;
}

// ---------- Figures ----------

/** Saves figures read from MT5. updated_at is kept: it tracks changes to the account, not reads. */
export async function writeSnapshot(conn: Conn, accountId: number, f: Mt5Account) {
  await exec(
    conn,
    `UPDATE mt5_accounts SET balance_cents = ?, credit_cents = ?, equity_cents = ?, margin_cents = ?, margin_free_cents = ?,
       snapshot_at = CURRENT_TIMESTAMP(3), updated_at = updated_at WHERE id = ?`,
    [f.balanceCents, f.creditCents, f.equityCents, f.marginCents, f.marginFreeCents, accountId],
  );
}

/**
 * Moves the cached figures by a balance change that just went through, and
 * dates them back so the next list reads MT5 again. Until then the client
 * already sees the new balance, even if MT5 cannot be reached.
 */
export async function adjustSnapshot(conn: Conn, accountId: number, deltaCents: number) {
  await exec(
    conn,
    `UPDATE mt5_accounts SET balance_cents = balance_cents + ?, equity_cents = equity_cents + ?, margin_free_cents = margin_free_cents + ?,
       snapshot_at = LEAST(snapshot_at, CURRENT_TIMESTAMP(3) - INTERVAL 1 HOUR), updated_at = updated_at
     WHERE id = ? AND snapshot_at IS NOT NULL`,
    [deltaCents, deltaCents, deltaCents, accountId],
  );
}

const applyFigures = (a: AccountRow, f: Mt5Account): AccountRow => ({
  ...a,
  balance_cents: f.balanceCents,
  credit_cents: f.creditCents,
  equity_cents: f.equityCents,
  margin_cents: f.marginCents,
  margin_free_cents: f.marginFreeCents,
  snapshot_at: new Date(),
});

/**
 * Live reads of figures by account, from when each starts until
 * SNAPSHOT_FRESH_MS later. A request that comes meanwhile waits for the read
 * on its way, or keeps the snapshot once that read has ended, answered or not.
 * So however many requests come at once or one after another (a client
 * reloading its accounts page), MT5 is asked about an account at most once in
 * that time and never twice at once; only an ask for the figures now
 * (`maxAgeMs` 0, behind its own rate limit) reads again once a read is over.
 */
const liveReads = new Map<number, { done: boolean; figures: Promise<Mt5Account | null> }>();

/**
 * One accounts.get for some of a server's accounts. What arrives within
 * `budgetMs` is saved as their snapshot; a later answer is dropped. Resolves
 * with the figures by login and never rejects.
 */
async function readFigures(db: Db, gateway: Mt5Gateway, server: string, batch: AccountRow[], budgetMs: number, log?: { warn: (obj: unknown, msg: string) => void }) {
  const found = new Map<number, Mt5Account>();
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), budgetMs)));
  try {
    const res = await Promise.race([gateway.call("accounts.get", { server, logins: batch.map((a) => a.login!) }), late]);
    if (!res) return found;
    if (res.missing.length) log?.warn({ server, missing: res.missing }, "MT5 does not know some of the CRM's accounts");
    for (const a of batch) {
      const f = res.accounts.find((x) => x.login === a.login);
      if (!f) continue;
      await writeSnapshot(db, a.id, f);
      found.set(a.login!, f);
    }
  } catch (error) {
    // MT5 out of reach is expected now and then; a refusal (a group the gateway no longer allows) or a bug needs a look.
    if (!(error instanceof GatewayError) || error.kind !== "unavailable") log?.warn({ server, err: error }, "MT5 figures could not be read");
  } finally {
    clearTimeout(timer);
  }
  return found;
}

/**
 * Reads live figures for the accounts whose snapshot is older than `maxAgeMs`
 * (all of them with 0), at most 100 logins per call and one call per server
 * at a time, all within `budgetMs`, and at most one read per account at a
 * time (see liveReads). What arrives in time is saved as the snapshot and
 * returned in place; anything else keeps its cached figures. Switched-off
 * servers are not asked. Never throws for a gateway problem.
 */
export async function refreshFigures(
  db: Db,
  gateway: Mt5Gateway | null,
  accounts: AccountRow[],
  opts: { maxAgeMs?: number; budgetMs?: number; log?: { warn: (obj: unknown, msg: string) => void } } = {},
): Promise<AccountRow[]> {
  const maxAgeMs = opts.maxAgeMs ?? SNAPSHOT_FRESH_MS;
  const budgetMs = opts.budgetMs ?? LIVE_BUDGET_MS;
  const now = Date.now();
  const stale = accounts.filter((a) => a.status === "active" && a.login !== null && (a.snapshot_at === null || now - a.snapshot_at.getTime() >= maxAgeMs));
  if (!gateway || !stale.length) return accounts;
  const enabled = await enabledServers(db);
  const reading = new Map<number, Promise<Mt5Account | null>>();
  const ask = new Map<string, AccountRow[]>();
  for (const a of stale) {
    if (!enabled.has(a.server_code)) continue;
    const earlier = liveReads.get(a.id);
    if (earlier && !earlier.done) reading.set(a.id, earlier.figures);
    else if (!earlier || maxAgeMs === 0) ask.set(a.server_code, [...(ask.get(a.server_code) ?? []), a]);
  }
  for (const [server, list] of ask) {
    for (let i = 0; i < list.length; i += LOGINS_PER_CALL) {
      const batch = list.slice(i, i + LOGINS_PER_CALL);
      const read = readFigures(db, gateway, server, batch, budgetMs, opts.log);
      const started = batch.map((a) => {
        const entry = { done: false, figures: read.then((found) => found.get(a.login!) ?? null) };
        void entry.figures.then(() => (entry.done = true));
        liveReads.set(a.id, entry);
        reading.set(a.id, entry.figures);
        return [a.id, entry] as const;
      });
      setTimeout(() => {
        for (const [id, entry] of started) if (liveReads.get(id) === entry) liveReads.delete(id);
      }, SNAPSHOT_FRESH_MS).unref();
    }
  }
  const found = new Map<number, Mt5Account>();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => (timer = setTimeout(resolve, budgetMs)));
  let late = false;
  const work = Promise.all(
    [...reading].map(async ([id, figures]) => {
      const f = await figures;
      // Answers after the deadline are dropped: this request has already answered.
      if (f && !late) found.set(id, f);
    }),
  );
  await Promise.race([work, deadline]);
  late = true;
  clearTimeout(timer);
  return accounts.map((a) => {
    const f = found.get(a.id);
    return f ? applyFigures(a, f) : a;
  });
}

// ---------- One change at a time per account ----------

const queues = new Map<number, Promise<void>>();

/**
 * Runs MT5 changes to one account one after another in this process, so two
 * of them (an archive and a restore, a client and a staff member) cannot
 * interleave between MT5 and the database. The CRM runs as one process; the
 * gateway's own per-login lock covers the rest.
 */
export async function withAccountLock<T>(accountId: number, work: () => Promise<T>): Promise<T> {
  const before = queues.get(accountId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => (release = resolve));
  const tail = before.then(() => mine);
  queues.set(accountId, tail);
  await before;
  try {
    return await work();
  } finally {
    release();
    if (queues.get(accountId) === tail) queues.delete(accountId);
  }
}
