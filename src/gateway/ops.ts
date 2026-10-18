import { z } from "zod";
import type { GatewayConfig, Mt5ServerConfig } from "./config";
import { OpError, policy, refused, unavailable, unknownOutcome } from "./errors";
import type { GatewayLogger } from "./log";
import { KeyedMutex, LockTimeout } from "./mutex";
import { MT5_GROUP, MT5_REFERENCE, SERVER_CODE, WRITE_OPS, type Mt5Account, type Mt5Deal, type OpName, type Ops } from "./protocol";
import { Mt5Pool } from "./mt5/pool";
import * as api from "./mt5/webapi";

// What the gateway does for each operation, and the rules it keeps whatever
// the CRM asks. The CRM is trusted to know its clients, not to be right:
// if it is compromised, these rules are what stands between it and MT5.
// - Only configured servers, and only accounts in the server's allowed live
//   or demo groups, are touched. No operation deletes an account or changes
//   its group.
// - Leverage comes from GATEWAY_LEVERAGES.
// - A balance deal carries a BIS- reference, stays under the per-operation
//   cap, and live credits stay under a rolling 24-hour cap per server.
// - One write at a time per login, and a balance is never sent twice for the
//   same reference.

const DAY_MS = 86_400_000;
const GROUP_TTL_MS = 10 * 60_000;
const GROUP_CACHE_MAX = 10_000;
/** user.find looks at this many of the group's newest logins. */
const FIND_LOGINS = 200;
/**
 * With `from`, user.find stops after this many accounts registered before it.
 * MT5 numbers new accounts upwards, so the logins below those are older
 * still; a few opened by hand with a high login of their own are allowed for.
 */
const FIND_OLDER = 10;
const DEAL_PAGE = 1000;
/** A deal search reads at most this many deals; past that it cannot prove a deal is absent. */
const MAX_SCAN_DEALS = 20_000;
/** A write is sent only with this much of the CRM's patience left, so its answer can still arrive. */
const WRITE_MIN_MS = 3_000;

export interface OpContext {
  /** When the CRM stops waiting (ms): every MT5 request must finish before then. */
  deadline: number;
  /** Aborted when the CRM hangs up; a write not yet sent then stays unsent. */
  signal: AbortSignal;
  /** Set for the write operations: their MT5 requests, reads included, go ahead of plain reads for a connection. */
  write?: boolean;
}

// ---- Request bodies (strict: an unexpected key is refused) ----

const server = z.string().regex(SERVER_CODE);
const login = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const reference = z.string().regex(MT5_REFERENCE);
const group = z.string().regex(MT5_GROUP);
const leverage = z.number().int().min(1).max(100_000);
const isoTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/)
  .refine((v) => Number.isFinite(Date.parse(v)));
// The CRM's password policy is stricter; this keeps anything odd out of MT5's query strings.
const mt5Password = z.string().regex(/^[\x21-\x7e]{8,16}$/);
const plain = (min: number, max: number) => z.string().min(min).max(max).regex(/^[^\u0000-\u001f\u007f]*$/);

export const OP_SCHEMAS: { [K in OpName]: z.ZodType<Ops[K]["req"], z.ZodTypeDef, unknown> } = {
  ping: z.object({ server }).strict(),
  "user.get": z.object({ server, login }).strict(),
  "accounts.get": z.object({ server, logins: z.array(login).min(1).max(100) }).strict(),
  "user.create": z
    .object({
      server,
      group,
      leverage,
      name: plain(1, 64),
      email: z.string().max(254).regex(/^[^\s@\u0000-\u001f\u007f]+@[^\s@\u0000-\u001f\u007f]+$/),
      country: plain(0, 64),
      comment: reference,
      password: mt5Password,
      investorPassword: mt5Password,
    })
    .strict(),
  "user.find": z.object({ server, group, comment: reference, from: isoTime.optional() }).strict(),
  "user.update": z
    .object({ server, login, leverage: leverage.optional(), enabled: z.boolean().optional(), tradeDisabled: z.boolean().optional() })
    .strict()
    .refine((r) => r.leverage !== undefined || r.enabled !== undefined || r.tradeDisabled !== undefined, "nothing to change"),
  "user.password": z.object({ server, login, type: z.enum(["main", "investor"]), password: mt5Password }).strict(),
  "positions.total": z.object({ server, login }).strict(),
  balance: z
    .object({
      server,
      login,
      amountCents: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).refine((v) => v !== 0),
      comment: reference,
      checkMargin: z.boolean(),
      notBefore: isoTime,
    })
    .strict(),
  "deal.find": z.object({ server, login, comment: reference, from: isoTime }).strict(),
  "deals.page": z
    .object({ server, login, from: isoTime, to: isoTime, offset: z.number().int().min(0).max(10_000_000), limit: z.number().int().min(1).max(1000) })
    .strict(),
};

// ---- Bounded memory ----

/** Login → group, for 10 minutes, at most 10,000 logins (the oldest entry goes first). */
export class GroupCache {
  private entries = new Map<string, { group: string; expires: number }>();

  get(serverCode: string, login: number, now = Date.now()): string | null {
    const key = `${serverCode}:${login}`;
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expires > now) return entry.group;
    this.entries.delete(key);
    return null;
  }

  set(serverCode: string, login: number, group: string, now = Date.now()) {
    const key = `${serverCode}:${login}`;
    this.entries.delete(key);
    this.entries.set(key, { group, expires: now + GROUP_TTL_MS });
    if (this.entries.size > GROUP_CACHE_MAX) this.entries.delete(this.entries.keys().next().value!);
  }

  get size() {
    return this.entries.size;
  }
}

/**
 * Credits to live accounts in the last 24 hours on one server, kept in
 * one-minute buckets: at most 1,441 numbers whatever the traffic. A minute
 * counts until all of it is a day old, so the sum can only be too high,
 * never too low. It lives in memory: a restart starts a new day.
 */
export class DailyCredits {
  private buckets = new Map<number, number>();
  private total = 0;

  /** Adds `cents` if the sum stays within `limit`; returns a function that takes it back, or null. */
  reserve(cents: number, limit: number, now = Date.now()): (() => void) | null {
    this.prune(now);
    if (this.total + cents > limit) return null;
    const minute = Math.floor(now / 60_000);
    this.buckets.set(minute, (this.buckets.get(minute) ?? 0) + cents);
    this.total += cents;
    let undone = false;
    return () => {
      const left = this.buckets.get(minute);
      if (undone || left === undefined) return;
      undone = true;
      if (left > cents) this.buckets.set(minute, left - cents);
      else this.buckets.delete(minute);
      this.total -= Math.min(left, cents);
    };
  }

  sum(now = Date.now()) {
    this.prune(now);
    return this.total;
  }

  get size() {
    return this.buckets.size;
  }

  private prune(now: number) {
    for (const [minute, cents] of this.buckets) {
      if ((minute + 1) * 60_000 > now - DAY_MS) continue;
      this.buckets.delete(minute);
      this.total -= cents;
    }
  }
}

/** Runs `fn` over the items, `limit` at a time, stopping at the first failure. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i]!);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/** Reads part of an MT5 answer; one of the wrong shape means MT5 could not be read. */
function readOr<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof api.Mt5FormatError) throw unavailable("mt5_error", error.message);
    throw error;
  }
}

const isNotFound = (error: unknown) => error instanceof OpError && error.kind === "refused" && error.code === "not_found";
const isGroupRefused = (error: unknown) => error instanceof OpError && error.kind === "refused" && error.code === "group_not_allowed";

interface ServerRuntime {
  config: Mt5ServerConfig;
  pool: Mt5Pool;
  credits: DailyCredits;
}

type WriteFields = Record<string, string | number | boolean | undefined>;

export class Gateway {
  private servers = new Map<string, ServerRuntime>();
  private groups = new GroupCache();
  private locks = new KeyedMutex();

  constructor(
    private config: GatewayConfig,
    private log: GatewayLogger,
    opts: { pingIntervalMs?: number } = {},
  ) {
    for (const s of config.servers) {
      this.servers.set(s.code, { config: s, pool: new Mt5Pool(s, log, opts.pingIntervalMs), credits: new DailyCredits() });
    }
  }

  run<K extends OpName>(op: K, req: Ops[K]["req"], ctx: OpContext): Promise<Ops[K]["res"]> {
    const handler = this.handlers[op] as (req: Ops[K]["req"], ctx: OpContext) => Promise<Ops[K]["res"]>;
    return handler(req, { ...ctx, write: WRITE_OPS.has(op) });
  }

  close() {
    for (const s of this.servers.values()) s.pool.close();
  }

  private handlers: { [K in OpName]: (req: Ops[K]["req"], ctx: OpContext) => Promise<Ops[K]["res"]> } = {
    ping: async (req, ctx) => {
      const s = this.server(req.server);
      return { serverTime: api.readServerTime(await this.read(s, api.timeServer(), ctx)) };
    },

    "user.get": async (req, ctx) => {
      const s = this.server(req.server);
      const { user } = await this.getUser(s, req.login, ctx);
      this.kindOf(s, user.group);
      return user;
    },

    "accounts.get": async (req, ctx) => {
      const s = this.server(req.server);
      const logins = [...new Set(req.logins)];
      const results = await mapLimit(logins, s.pool.size, async (login): Promise<Mt5Account | number> => {
        try {
          await this.groupOf(s, login, ctx);
          const reply = await this.read(s, api.userAccountGet(login), ctx);
          const account = readOr(() => api.readAccount(reply));
          if (account.login !== login) throw unavailable("mt5_error", "MT5 answered with another account.");
          return account;
        } catch (error) {
          // One login MT5 does not know, or in a group the gateway no longer allows, is listed as
          // missing: it must not cost the other accounts their figures.
          if (isNotFound(error) || isGroupRefused(error)) return login;
          throw error;
        }
      });
      return {
        accounts: results.filter((r): r is Mt5Account => typeof r !== "number"),
        missing: results.filter((r): r is number => typeof r === "number"),
      };
    },

    "user.create": async (req, ctx) => {
      const s = this.server(req.server);
      // Creates in one group run one at a time: the login is not known yet.
      return this.write(s, `group:${req.group}`, ctx, { op: "user.create", group: req.group, leverage: req.leverage, comment: req.comment }, async (log) => {
        this.kindOf(s, req.group);
        this.checkLeverage(req.leverage);
        if (req.password === req.investorPassword) throw policy("The investor password must differ from the main password.");
        const reply = await this.send(s, api.userAdd(req), ctx);
        const login = api.readCreatedLogin(reply);
        if (login === null) throw unknownOutcome("mt5_error", "MT5 said the account was opened but not which login it has.");
        log.login = login;
        const made = reply.answer as Record<string, unknown>;
        if (typeof made.Group === "string" && made.Group !== req.group) {
          this.log.error({ server: s.config.code, login, group: req.group }, "MT5 opened the account in another group than asked: check the user/add format in webapi.ts");
        }
        this.groups.set(s.config.code, login, typeof made.Group === "string" ? made.Group : req.group);
        return { login };
      });
    },

    "user.find": async (req, ctx) => {
      const s = this.server(req.server);
      this.kindOf(s, req.group);
      const from = req.from === undefined ? null : Date.parse(req.from);
      const now = Date.now();
      if (from !== null && (from > now + DAY_MS || from < now - 400 * DAY_MS)) throw policy("from must be within the last 400 days.");
      // Waits for any create in the group, so "not found" is never said while
      // a create with this comment is still on its way.
      return this.withLock(s, `group:${req.group}`, ctx, async () => {
        const reply = await this.read(s, api.userLogins(req.group), ctx);
        const logins = readOr(() => api.readLogins(reply)).sort((a, b) => b - a).slice(0, FIND_LOGINS);
        const matches: number[] = [];
        // Newest first, and only as far back as `from`: "not found" then costs a few reads, not one per
        // account in the group, and fits the read deadline however large the group is.
        let older = 0;
        await mapLimit(logins, 2, async (login) => {
          if (matches.length || older >= FIND_OLDER) return;
          try {
            const { user } = await this.getUser(s, login, ctx);
            if (user.comment === req.comment && user.group === req.group) matches.push(login);
            else if (from !== null && user.registeredAt !== null && Date.parse(user.registeredAt) < from) older++;
          } catch (error) {
            // Deleted between the list and the read: not the one.
            if (!isNotFound(error)) throw error;
          }
        });
        return { login: matches.length ? Math.max(...matches) : null };
      });
    },

    "user.update": async (req, ctx) => {
      const s = this.server(req.server);
      const fields = { op: "user.update", login: req.login, leverage: req.leverage, enabled: req.enabled, tradeDisabled: req.tradeDisabled };
      return this.write(s, `login:${req.login}`, ctx, fields, async (log) => {
        if (req.leverage !== undefined) this.checkLeverage(req.leverage);
        // Read the record fresh: the update sends all of it back.
        const { user, raw } = await this.getUser(s, req.login, ctx);
        this.kindOf(s, user.group);
        const rights = BigInt(user.rights);
        const next = api.changeRights(rights, req);
        const lever = req.leverage ?? user.leverage;
        if (next === rights && lever === user.leverage) {
          log.unchanged = true;
          return user;
        }
        const reply = await this.send(s, api.userUpdate(raw, { leverage: lever, rights: next }), ctx);
        try {
          const back = api.readUser(reply.answer, s.config.tzOffsetMinutes).user;
          if (back.login === req.login) return back;
        } catch {
          // The update was done; the answer just does not repeat the record.
        }
        return { ...user, leverage: lever, rights: next.toString(), enabled: (next & api.RIGHTS.ENABLED) !== 0n, tradeDisabled: (next & api.RIGHTS.TRADE_DISABLED) !== 0n };
      });
    },

    "user.password": async (req, ctx) => {
      const s = this.server(req.server);
      return this.write(s, `login:${req.login}`, ctx, { op: "user.password", login: req.login, type: req.type }, async () => {
        await this.groupOf(s, req.login, ctx);
        await this.send(s, api.userChangePassword(req.login, req.type, req.password), ctx);
        return {};
      });
    },

    "positions.total": async (req, ctx) => {
      const s = this.server(req.server);
      await this.groupOf(s, req.login, ctx);
      const reply = await this.read(s, api.positionTotal(req.login), ctx);
      return { total: readOr(() => api.readTotal(reply)) };
    },

    balance: async (req, ctx) => {
      const s = this.server(req.server);
      const fields = { op: "balance", login: req.login, amountCents: req.amountCents, comment: req.comment, checkMargin: req.checkMargin };
      return this.write(s, `login:${req.login}`, ctx, fields, async (log) => {
        const notBefore = Date.parse(req.notBefore);
        const now = Date.now();
        if (notBefore > now + DAY_MS || notBefore < now - 30 * DAY_MS) throw policy("notBefore must be within the last 30 days.");
        // Money only leaves an account if MT5 checks the margin it leaves behind.
        if (req.amountCents < 0 && !req.checkMargin) throw policy("Taking money out of an account must check its margin.");
        const { kind } = await this.groupOf(s, req.login, ctx);
        // Look for this reference first, under the same lock as the send: if
        // MT5 already has the deal, it happened, and nothing is sent again.
        // This comes before the caps, so a repeat is answered as done even
        // after a cap has been reached.
        const existing = await this.findDeal(s, req.login, req.comment, notBefore - DAY_MS, now + DAY_MS, ctx);
        if (existing) {
          log.ticket = existing.ticket;
          if (existing.action === api.BALANCE_ACTION && existing.profitCents === req.amountCents) {
            log.duplicate = true;
            return { ticket: existing.ticket, duplicate: true };
          }
          // Something with this reference is there but it is not this
          // operation. Neither "done" nor "failed" is safe to say.
          throw unknownOutcome("mt5_error", `MT5 already has deal ${existing.ticket} with this comment, but not as this balance operation; staff must check it.`);
        }
        const cap = kind === "demo" ? this.config.demoMaxOpCents : this.config.maxOpCents;
        if (Math.abs(req.amountCents) > cap) throw refused("over_limit", `The amount is over the gateway's ${kind} limit for one operation.`);
        const release = kind === "live" && req.amountCents > 0 ? s.credits.reserve(req.amountCents, this.config.dailyCreditCents) : () => undefined;
        if (!release) throw refused("over_limit", `Credits to live accounts on server ${s.config.code} would pass the gateway's 24-hour limit.`);
        let reply: api.Reply;
        try {
          reply = await this.send(s, api.tradeBalance(req), ctx);
        } catch (error) {
          // Only money that may have reached MT5 counts toward the day.
          if (error instanceof OpError && error.kind !== "unknown") release();
          throw error;
        }
        let ticket = api.readTicket(reply);
        if (ticket === null) {
          // Done, but the answer has no ticket: find the deal it made.
          const made = await this.findDeal(s, req.login, req.comment, notBefore - DAY_MS, Date.now() + DAY_MS, ctx).catch(() => null);
          if (made && made.action === api.BALANCE_ACTION && made.profitCents === req.amountCents) ticket = made.ticket;
        }
        if (ticket === null) throw unknownOutcome("mt5_error", "MT5 accepted the balance operation but its deal could not be found.");
        log.ticket = ticket;
        return { ticket, duplicate: false };
      });
    },

    "deal.find": async (req, ctx) => {
      const s = this.server(req.server);
      const from = Date.parse(req.from);
      const now = Date.now();
      if (from > now + DAY_MS || from < now - 400 * DAY_MS) throw policy("from must be within the last 400 days.");
      await this.groupOf(s, req.login, ctx);
      // Waits for any write on the login, so "not found" is never said while
      // a send with this comment is still on its way.
      return this.withLock(s, `login:${req.login}`, ctx, async () => ({
        deal: await this.findDeal(s, req.login, req.comment, from, Date.now() + DAY_MS, ctx),
      }));
    },

    "deals.page": async (req, ctx) => {
      const s = this.server(req.server);
      const from = Date.parse(req.from);
      const to = Date.parse(req.to);
      if (to < from) throw policy("to must not be before from.");
      await this.groupOf(s, req.login, ctx);
      const tz = s.config.tzOffsetMinutes;
      const a = api.toServerSeconds(from, tz);
      const b = api.toServerSeconds(to, tz);
      const totalReply = await this.read(s, api.dealTotal(req.login, a, b), ctx);
      const total = readOr(() => api.readTotal(totalReply));
      if (req.offset >= total) return { total, deals: [] };
      const page = await this.read(s, api.dealPage(req.login, a, b, req.offset, req.limit), ctx);
      return { total, deals: readOr(() => api.readDeals(page, tz)).slice(0, req.limit) };
    },
  };

  // ---- Rules ----

  private server(code: string): ServerRuntime {
    const s = this.servers.get(code);
    if (!s) throw policy(`The gateway has no MT5 server "${code}".`);
    return s;
  }

  /** Whether a group is one of the server's live or demo groups; any other is refused. */
  private kindOf(s: ServerRuntime, group: string): "live" | "demo" {
    if (s.config.groups.includes(group)) return "live";
    if (s.config.demoGroups.includes(group)) return "demo";
    throw refused("group_not_allowed", `Group "${group}" is not one the gateway allows on server ${s.config.code}.`);
  }

  private checkLeverage(value: number) {
    if (!this.config.leverages.includes(value)) throw policy(`Leverage ${value} is not in GATEWAY_LEVERAGES.`);
  }

  // ---- MT5 requests ----

  private read(s: ServerRuntime, request: api.Mt5Request, ctx: OpContext) {
    return s.pool.request(request, { deadline: ctx.deadline, forWrite: ctx.write });
  }

  /**
   * Sends a write. Right before it goes out (after any sign-in), it is
   * stopped if the CRM has hung up or too little time is left for the answer
   * to reach the CRM; either way nothing is sent.
   */
  private send(s: ServerRuntime, request: api.Mt5Request, ctx: OpContext) {
    return s.pool.request(request, {
      deadline: ctx.deadline,
      forWrite: true,
      beforeSend: () => {
        if (ctx.signal.aborted) throw unavailable("connection", "The CRM stopped waiting; nothing was sent.");
        if (ctx.deadline - Date.now() < WRITE_MIN_MS) throw unavailable("timeout", "Too little time was left to send the write; nothing was sent.");
      },
    });
  }

  /** user/get, which also refreshes the group cache. */
  private async getUser(s: ServerRuntime, login: number, ctx: OpContext) {
    const reply = await this.read(s, api.userGet(login), ctx);
    const found = readOr(() => api.readUser(reply.answer, s.config.tzOffsetMinutes));
    if (found.user.login !== login) throw unavailable("mt5_error", "MT5 answered with another account.");
    this.groups.set(s.config.code, login, found.user.group);
    return found;
  }

  /** The login's group (read at most every 10 minutes), refused unless the server allows it. */
  private async groupOf(s: ServerRuntime, login: number, ctx: OpContext) {
    const group = this.groups.get(s.config.code, login) ?? (await this.getUser(s, login, ctx)).user.group;
    return { group, kind: this.kindOf(s, group) };
  }

  /**
   * The deal on this login with exactly this comment between two UTC times,
   * preferring a balance deal, or null. Every deal in the window is read; a
   * window too large to read in full is `unavailable`, never "not found".
   */
  private async findDeal(s: ServerRuntime, login: number, comment: string, fromMs: number, toMs: number, ctx: OpContext): Promise<Mt5Deal | null> {
    const tz = s.config.tzOffsetMinutes;
    const from = api.toServerSeconds(fromMs, tz);
    const to = api.toServerSeconds(toMs, tz);
    const totalReply = await this.read(s, api.dealTotal(login, from, to), ctx);
    const total = readOr(() => api.readTotal(totalReply));
    if (total > MAX_SCAN_DEALS) throw unavailable("mt5_error", `Account ${login} has too many deals in the window to search them all.`);
    let found: Mt5Deal | null = null;
    for (let offset = 0; offset < total; ) {
      const page = await this.read(s, api.dealPage(login, from, to, offset, DEAL_PAGE), ctx);
      const deals = readOr(() => api.readDeals(page, tz));
      if (deals.length === 0) throw unavailable("mt5_error", "MT5's deal pages ended before its total; the search is not complete.");
      for (const deal of deals) {
        if (deal.comment !== comment || deal.login !== login) continue;
        if (deal.action === api.BALANCE_ACTION) return deal;
        found ??= deal;
      }
      offset += deals.length;
    }
    return found;
  }

  // ---- Locks and the write log ----

  private async withLock<T>(s: ServerRuntime, key: string, ctx: OpContext, fn: () => Promise<T>): Promise<T> {
    try {
      return await this.locks.run(`${s.config.code}|${key}`, ctx.deadline - Date.now() - WRITE_MIN_MS, fn);
    } catch (error) {
      if (error instanceof LockTimeout) throw unavailable("timeout", "Another write on this account was still running.");
      throw error;
    }
  }

  /**
   * Runs a write under its lock and logs it with its outcome: what staff need
   * to match it in MT5, never a password.
   */
  private async write<T>(s: ServerRuntime, key: string, ctx: OpContext, fields: WriteFields, fn: (log: WriteFields) => Promise<T>): Promise<T> {
    const log: WriteFields = { ...fields, server: s.config.code };
    try {
      const result = await this.withLock(s, key, ctx, () => fn(log));
      this.log.info({ ...log, outcome: "ok" }, "MT5 write");
      return result;
    } catch (error) {
      const e = error instanceof OpError ? error : null;
      const line = { ...log, outcome: e?.kind ?? "error", code: e?.code, retcode: e?.retcode, reason: e?.message ?? (error as Error).message };
      // An unknown outcome needs a person or the resolver; a broken rule may be an attack.
      if (!e || e.kind === "unknown") this.log.error(line, "MT5 write");
      else this.log.warn(line, "MT5 write");
      throw error;
    }
  }
}
