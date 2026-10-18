import { createHash } from "node:crypto";
import type { Mt5Account, Mt5Deal, Mt5User } from "../protocol";
import { centsFromDecimal, decimalFromCents } from "../money";

// Every MT5 Web API path, parameter and answer format the gateway uses lives
// in this file, so checking the gateway against MetaQuotes' documentation
// (https://support.metaquotes.net/en/docs/mt5/api/webapi) or a broker's test
// server means reading this file only. Sources are in mt5-webapi.md.
//
// Paths seen in working REST clients are marked confirmed. Every other path
// or format was inferred from MetaQuotes' socket protocol (its command and
// parameter names, lowercased) and is marked UNCONFIRMED with what to check.
// docs/DEPLOY.md lists them for the broker test before going live.
//
// MT5 answers `{"retcode":"0 Done","answer":...}` with field names in
// PascalCase and values as strings. Answers are parsed keeping every JSON
// number as its exact text, so money and 64-bit values never pass through a
// float even if MT5 sends them as numbers.

export interface Mt5Request {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string>;
  /** Sent as JSON. */
  body?: unknown;
  /** True when the request changes something in MT5. */
  write: boolean;
}

/** An MT5 answer, with every number kept as the text MT5 sent. */
export type Reply = Record<string, unknown>;

/** An answer that does not have the shape the gateway expects. */
export class Mt5FormatError extends Error {}

type Reviver = (this: unknown, key: string, value: unknown, context?: { source?: string }) => unknown;
const numbersAsText: Reviver = (_key, value, context) => {
  if (typeof value !== "number") return value;
  // Node 22 passes each number's source text; without it the number would be a float.
  if (typeof context?.source !== "string") throw new Error("JSON.parse source text access is missing (Node 22 is required)");
  return context.source;
};

export function parseReply(text: string): Reply {
  const value: unknown = JSON.parse(text, numbersAsText as (key: string, value: unknown) => unknown);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Mt5FormatError("MT5's answer is not a JSON object");
  return value as Reply;
}

// ---- Values ----

function text(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Mt5FormatError(`MT5's answer has no ${name}`);
  return value;
}

function int(value: unknown, name: string, min = 0): number {
  const t = text(value, name).trim();
  const n = /^-?\d{1,16}$/.test(t) ? Number(t) : NaN;
  if (!Number.isSafeInteger(n) || n < min) throw new Mt5FormatError(`MT5's ${name} is not a whole number`);
  return n;
}

function cents(value: unknown, name: string): number {
  try {
    return centsFromDecimal(text(value, name).trim());
  } catch (error) {
    if (error instanceof Mt5FormatError) throw error;
    throw new Mt5FormatError(`MT5's ${name} is not an amount`);
  }
}

const optional = <T>(value: unknown, read: (v: unknown) => T, fallback: T): T => (value === undefined || value === null || value === "" ? fallback : read(value));

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Mt5FormatError(`MT5's answer has no ${name}`);
  return value as Record<string, unknown>;
}

/** The `answer` member as an object. */
export const answerObject = (reply: Reply) => object(reply.answer, "answer");

// ---- Time ----
// MT5 keeps times in the trade server's own clock. The offset from UTC is a
// per-server setting (GATEWAY_SERVER_X_TZ_OFFSET_MINUTES).
// UNCONFIRMED: whether the server's offset changes with daylight saving; if it
// does, deals from the other side of a change are an hour off.

export const toServerSeconds = (utcMs: number, offsetMinutes: number) => Math.floor(utcMs / 1000) + offsetMinutes * 60;
export const isoFromServerSeconds = (seconds: number, offsetMinutes: number) => new Date((seconds - offsetMinutes * 60) * 1000).toISOString();

// ---- Sign-in (confirmed: mt5-webapi.md §1, in clients A, B and G) ----

const md5 = (...parts: Buffer[]) => {
  const hash = createHash("md5");
  for (const part of parts) hash.update(part);
  return hash.digest();
};

/** MT5's password hash for the Web API sign-in: MD5(MD5(UTF-16LE(password)) ‖ "WebAPI"). */
export const passwordHash = (password: string) => md5(md5(Buffer.from(password, "utf16le")), Buffer.from("WebAPI", "ascii"));

/** MD5(hash ‖ rand) as lowercase hex: the answer to the other side's random challenge. */
export const randAnswer = (hash: Buffer, rand: Buffer) => md5(hash, rand).toString("hex");

export const authStart = (s: { version: number; agent: string; login: number }): Mt5Request => ({
  write: false,
  method: "GET",
  path: "/api/auth/start",
  query: { version: String(s.version), agent: s.agent, login: String(s.login), type: "manager" },
});

/** The server's random challenge (`srv_rand`, hex). */
export function readServerRand(reply: Reply): Buffer {
  const rand = text(reply.srv_rand, "srv_rand");
  if (!/^(?:[0-9a-fA-F]{2}){8,64}$/.test(rand)) throw new Mt5FormatError("MT5's srv_rand is not hex");
  return Buffer.from(rand, "hex");
}

export const authAnswer = (srvRandAnswer: string, cliRand: string): Mt5Request => ({
  write: false,
  method: "GET",
  path: "/api/auth/answer",
  query: { srv_rand_answer: srvRandAnswer, cli_rand: cliRand },
});

/** The server's answer to our challenge, which proves it knows the password too. */
export const readClientRandAnswer = (reply: Reply) => text(reply.cli_rand_answer, "cli_rand_answer").toLowerCase();

// ---- Pings and time (confirmed: /api/test/access in B; /api/time/server in A) ----

export const testAccess = (): Mt5Request => ({ write: false, method: "GET", path: "/api/test/access" });

export const timeServer = (): Mt5Request => ({ write: false, method: "GET", path: "/api/time/server" });

/** `answer.time` starts with the server's clock in seconds; null if it does not. */
export function readServerTime(reply: Reply): number | null {
  const answer = reply.answer;
  const time = answer && typeof answer === "object" ? (answer as Record<string, unknown>).time : undefined;
  const first = typeof time === "string" ? /^\s*(\d{1,12})\b/.exec(time)?.[1] : undefined;
  return first === undefined ? null : Number(first);
}

// ---- Users ----

/** MT5 user rights bits (MetaQuotes' MTEnUsersRights; the field is 64-bit, so always BigInt). */
export const RIGHTS = { ENABLED: 0x1n, PASSWORD: 0x2n, TRADE_DISABLED: 0x4n, TRAILING: 0x20n, EXPERT: 0x40n, REPORTS: 0x100n } as const;
/** What a new account gets: ENABLED | PASSWORD | TRAILING | EXPERT | REPORTS (MetaQuotes' default, 0x163). */
export const NEW_USER_RIGHTS = RIGHTS.ENABLED | RIGHTS.PASSWORD | RIGHTS.TRAILING | RIGHTS.EXPERT | RIGHTS.REPORTS;
const MAX_RIGHTS = (1n << 64n) - 1n;

export function parseRights(value: unknown): bigint {
  const t = text(value, "Rights").trim();
  if (!/^\d{1,20}$/.test(t) || BigInt(t) > MAX_RIGHTS) throw new Mt5FormatError("MT5's Rights is not a 64-bit number");
  return BigInt(t);
}

/** Sets or clears only ENABLED and TRADE_DISABLED; every other bit stays as MT5 has it. */
export function changeRights(rights: bigint, change: { enabled?: boolean; tradeDisabled?: boolean }): bigint {
  let next = rights;
  if (change.enabled !== undefined) next = change.enabled ? next | RIGHTS.ENABLED : next & ~RIGHTS.ENABLED;
  if (change.tradeDisabled !== undefined) next = change.tradeDisabled ? next | RIGHTS.TRADE_DISABLED : next & ~RIGHTS.TRADE_DISABLED;
  return next & MAX_RIGHTS;
}

// UNCONFIRMED: REST path /api/user/get?login= (socket command USER_GET).
export const userGet = (login: number): Mt5Request => ({ write: false, method: "GET", path: "/api/user/get", query: { login: String(login) } });

/** An MT5 user record: the protocol's view of it, and the record itself for a read-modify-write. */
export function readUser(answer: unknown, offsetMinutes: number): { user: Mt5User; raw: Record<string, unknown> } {
  const raw = object(answer, "user");
  const rights = parseRights(raw.Rights);
  const name = typeof raw.Name === "string" && raw.Name.trim() !== ""
    ? raw.Name
    : [raw.FirstName, raw.LastName].filter((v) => typeof v === "string" && v !== "").join(" ");
  const registered = optional(raw.Registration, (v) => int(v, "Registration"), 0);
  return {
    raw,
    user: {
      login: int(raw.Login, "Login", 1),
      group: text(raw.Group, "Group"),
      name,
      email: optional(raw.Email, (v) => text(v, "Email"), ""),
      leverage: int(raw.Leverage, "Leverage", 1),
      rights: rights.toString(),
      enabled: (rights & RIGHTS.ENABLED) !== 0n,
      tradeDisabled: (rights & RIGHTS.TRADE_DISABLED) !== 0n,
      comment: optional(raw.Comment, (v) => text(v, "Comment"), ""),
      registeredAt: registered > 0 ? isoFromServerSeconds(registered, offsetMinutes) : null,
    },
  };
}

/**
 * Opens an account. Login 0 lets MT5 pick the next login of the group's range.
 * UNCONFIRMED: REST path /api/user/add, POST with the user record as a JSON
 * body and the passwords as `pass_main` and `pass_investor` query parameters
 * (socket command USER_ADD takes LOGIN, PASS_MAIN, PASS_INVESTOR and the
 * record as BODY_TEXT). Check whether the passwords may go in the body
 * instead (better: query strings end up in more logs), whether values must
 * be strings as MT5 sends them, and that the answer is the created record with
 * its `Login` (answer.Login).
 */
export const userAdd = (u: { group: string; leverage: number; name: string; email: string; country: string; comment: string; password: string; investorPassword: string }): Mt5Request => ({
  write: true,
  method: "POST",
  path: "/api/user/add",
  query: { pass_main: u.password, pass_investor: u.investorPassword },
  body: {
    Login: "0",
    Group: u.group,
    Name: u.name,
    Email: u.email,
    Country: u.country,
    Comment: u.comment,
    Leverage: String(u.leverage),
    Rights: NEW_USER_RIGHTS.toString(),
  },
});

/** The login MT5 gave a new account, or null if the answer does not say. */
export function readCreatedLogin(reply: Reply): number | null {
  const answer = reply.answer;
  if (!answer || typeof answer !== "object") return null;
  const login = (answer as Record<string, unknown>).Login;
  try {
    return int(login, "Login", 1);
  } catch {
    return null;
  }
}

/**
 * Writes a user record back with a new leverage and rights. The record is
 * the one just read, so nothing else changes.
 * UNCONFIRMED: REST path /api/user/update?login=, POST with the whole record
 * as a JSON body (socket command USER_UPDATE). Check that MT5 ignores Balance
 * and Credit in an update (they must only change through trade/balance) and
 * whether a partial record would do; the answer is taken to be the updated
 * record, and when it is not, the record as sent.
 */
export const userUpdate = (raw: Record<string, unknown>, change: { leverage: number; rights: bigint }): Mt5Request => ({
  write: true,
  method: "POST",
  path: "/api/user/update",
  query: { login: text(raw.Login, "Login") },
  body: { ...raw, Leverage: String(change.leverage), Rights: change.rights.toString() },
});

/**
 * Sets the main or investor password.
 * UNCONFIRMED: REST path /api/user/change_password (the socket command is
 * USER_PASS_CHANGE, so it may be /api/user/pass_change), GET with `login`,
 * `type` (main | investor) and `password` as query parameters. Check the path,
 * the type spelling (the socket protocol uses MAIN / INVESTOR) and whether the
 * password may go in a POST body instead.
 */
export const userChangePassword = (login: number, type: "main" | "investor", password: string): Mt5Request => ({
  write: true,
  method: "GET",
  path: "/api/user/change_password",
  query: { login: String(login), type, password },
});

/**
 * Logins in one group (exact name: the gateway's group names cannot hold
 * the * or , of an MT5 group mask), for user.find and users.list.
 * UNCONFIRMED: REST path /api/user/logins?group= (socket command USER_LOGINS),
 * that the answer is an array of every login in the group in one answer (no
 * paging on MT5's side; the gateway pages it for the CRM), and how large an
 * answer MT5 sends for a big group.
 */
export const userLogins = (group: string): Mt5Request => ({ write: false, method: "GET", path: "/api/user/logins", query: { group } });

export function readLogins(reply: Reply): number[] {
  if (!Array.isArray(reply.answer)) throw new Mt5FormatError("MT5's answer has no list of logins");
  return reply.answer.map((v) => int(v, "login", 1));
}

// ---- Money ----

/**
 * An account's money now.
 * UNCONFIRMED: REST path /api/user/account/get?login= (socket command
 * USER_ACCOUNT_GET; only /api/user/account/get_batch?group= was seen).
 */
export const userAccountGet = (login: number): Mt5Request => ({ write: false, method: "GET", path: "/api/user/account/get", query: { login: String(login) } });

export function readAccount(reply: Reply): Mt5Account {
  const a = answerObject(reply);
  return {
    login: int(a.Login, "Login", 1),
    balanceCents: cents(a.Balance, "Balance"),
    creditCents: optional(a.Credit, (v) => cents(v, "Credit"), 0),
    equityCents: cents(a.Equity, "Equity"),
    marginCents: optional(a.Margin, (v) => cents(v, "Margin"), 0),
    marginFreeCents: cents(a.MarginFree, "MarginFree"),
    profitCents: optional(a.Profit, (v) => cents(v, "Profit"), 0),
  };
}

// Confirmed: /api/position/get_total (B), answer.total.
export const positionTotal = (login: number): Mt5Request => ({ write: false, method: "GET", path: "/api/position/get_total", query: { login: String(login) } });

export const readTotal = (reply: Reply) => int(answerObject(reply).total, "total");

/**
 * A balance deal (deal action 2) or credit deal (action 3) of `amountCents`;
 * negative takes money (or credit) out.
 * UNCONFIRMED: REST path /api/trade/balance, GET with `login`, `type` (the
 * deal action, 2 or 3), `balance` (signed decimal), `comment` and
 * `check_margin` (1 or 0) as query parameters (socket command TRADE_BALANCE).
 * Check that a negative amount is a withdrawal, that check_margin=1 refuses
 * one the free margin does not cover (and with which retcode: the gateway
 * expects 10019), the comment length limit (references are 13 characters),
 * and the answer's ticket field (answer.ticket is assumed).
 * UNCONFIRMED for credit (type 3): that it is the same command, that a
 * negative amount removes credit and that MT5 refuses to take more credit
 * than the account has, that check_margin=1 also guards a credit removal,
 * and that the credit deal's amount is in Profit like a balance deal's.
 */
export const tradeBalance = (b: { login: number; action: typeof BALANCE_ACTION | typeof CREDIT_ACTION; amountCents: number; comment: string; checkMargin: boolean }): Mt5Request => ({
  write: true,
  method: "GET",
  path: "/api/trade/balance",
  query: { login: String(b.login), type: String(b.action), balance: decimalFromCents(b.amountCents), comment: b.comment, check_margin: b.checkMargin ? "1" : "0" },
});

/** The deal ticket of a balance operation, or null if the answer does not say. */
export function readTicket(reply: Reply): number | null {
  const answer = reply.answer;
  if (!answer || typeof answer !== "object") return null;
  const a = answer as Record<string, unknown>;
  try {
    return int(a.ticket ?? a.Ticket ?? a.deal ?? a.Deal, "ticket", 1);
  } catch {
    return null;
  }
}

// ---- Deals (confirmed: /api/deal/get_total and /api/deal/get_page in A) ----
// `from` and `to` are seconds in server time. A sends no `total` to get_page
// and pages until it has them all; D's socket command takes `total`.
// UNCONFIRMED: the most deals one page returns (the gateway asks for at most
// 1000 and carries on from what it got).

/** MT5 deal actions (MetaQuotes' MTEnDealAction): what trade/balance's `type` makes. */
export const BALANCE_ACTION = 2;
export const CREDIT_ACTION = 3;

export const dealTotal = (login: number, from: number, to: number): Mt5Request => ({
  write: false,
  method: "GET",
  path: "/api/deal/get_total",
  query: { login: String(login), from: String(from), to: String(to) },
});

export const dealPage = (login: number, from: number, to: number, offset: number, total: number): Mt5Request => ({
  write: false,
  method: "GET",
  path: "/api/deal/get_page",
  query: { login: String(login), from: String(from), to: String(to), offset: String(offset), total: String(total) },
});

/** A deal record. UNCONFIRMED: that a balance deal's amount is in Profit (widely observed). */
export function readDeal(value: unknown, offsetMinutes: number): Mt5Deal {
  const d = object(value, "deal");
  const time = int(d.Time, "Time");
  const price = optional(d.Price, (v) => text(v, "Price").trim(), "0");
  if (!/^-?\d{1,20}(\.\d{1,20})?$/.test(price)) throw new Mt5FormatError("MT5's deal Price is not a number");
  return {
    ticket: int(d.Deal, "Deal", 1),
    login: int(d.Login, "Login", 1),
    action: int(d.Action, "Action"),
    entry: optional(d.Entry, (v) => int(v, "Entry"), 0),
    positionId: optional(d.PositionID, (v) => int(v, "PositionID"), 0),
    order: optional(d.Order, (v) => int(v, "Order"), 0),
    symbol: optional(d.Symbol, (v) => text(v, "Symbol"), ""),
    volume: optional(d.Volume, (v) => int(v, "Volume"), 0),
    price,
    profitCents: cents(d.Profit, "Profit"),
    commissionCents: optional(d.Commission, (v) => cents(v, "Commission"), 0),
    swapCents: optional(d.Storage, (v) => cents(v, "Storage"), 0),
    feeCents: optional(d.Fee, (v) => cents(v, "Fee"), 0),
    comment: optional(d.Comment, (v) => text(v, "Comment"), ""),
    time,
    timeMsc: optional(d.TimeMsc, (v) => int(v, "TimeMsc"), time * 1000),
    timeUtc: isoFromServerSeconds(time, offsetMinutes),
  };
}

export function readDeals(reply: Reply, offsetMinutes: number): Mt5Deal[] {
  if (!Array.isArray(reply.answer)) throw new Mt5FormatError("MT5's answer has no list of deals");
  return reply.answer.map((d) => readDeal(d, offsetMinutes));
}
