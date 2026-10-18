import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// The wire protocol between the CRM and the MT5 gateway, imported by both.
//
// The gateway is the only process that holds MT5 manager credentials. The
// CRM asks it for a fixed set of operations: POST /v1/<op> with a JSON body,
// signed with a shared secret over the time, a one-time nonce, the path and
// the body. Every answer is signed too, over the request's nonce, so a
// process that takes over the gateway's port cannot fake a result (a forged
// "done" for an MT5-to-wallet transfer would be money out of nowhere).
//
// Money is always integer cents, signed where it can be negative. MT5's own
// error text never crosses this line as something to show a client: the CRM
// maps `code` to its own words.

export const PROTOCOL_PREFIX = "/v1/";
export const HEADERS = { timestamp: "x-gw-timestamp", nonce: "x-gw-nonce", signature: "x-gw-signature" } as const;
/** How far the two clocks may differ, and how long a nonce is remembered (twice this). */
export const MAX_SKEW_MS = 30_000;
export const MAX_BODY_BYTES = 16 * 1024;
export const MIN_SECRET_LENGTH = 32;

/** A server code, the same on both sides: "live", "demo". */
export const SERVER_CODE = /^[a-z0-9_-]{1,16}$/;
/**
 * The comment on every balance deal and on every MT5 user the CRM creates:
 * "BIS-", a letter for what it is (A account, T transfer, D demo funding,
 * S staff change), then 8 characters. Unique, at most 31 characters (MT5's
 * comment limit).
 */
export const MT5_REFERENCE = /^BIS-[A-Z][0-9A-Z]{8}$/;
/** An MT5 group name as the broker configures it, such as "real\\standard". */
export const MT5_GROUP = /^[A-Za-z0-9_\\\-. ]{1,64}$/;

/** What MT5 says about a user (the account holder record). */
export interface Mt5User {
  login: number;
  group: string;
  name: string;
  email: string;
  leverage: number;
  /** MT5's 64-bit rights bit mask, as a decimal string. */
  rights: string;
  /** True when the ENABLED right is set (the account can sign in). */
  enabled: boolean;
  /** True when the TRADE_DISABLED right is set. */
  tradeDisabled: boolean;
  comment: string;
  /** When MT5 registered the account, as an ISO time, or null if MT5 did not say. */
  registeredAt: string | null;
}

/** An account's money as MT5 reports it now, in cents of the account currency. */
export interface Mt5Account {
  login: number;
  balanceCents: number;
  creditCents: number;
  equityCents: number;
  marginCents: number;
  marginFreeCents: number;
  profitCents: number;
}

/** One MT5 deal. `time` is seconds as MT5 reports it (the trade server's clock, not UTC). */
export interface Mt5Deal {
  ticket: number;
  login: number;
  /** 0 buy, 1 sell, 2 balance, 3 credit, ... (MT5 deal action). */
  action: number;
  /** 0 in, 1 out, 2 in/out, 3 out by (MT5 deal entry). */
  entry: number;
  positionId: number;
  order: number;
  symbol: string;
  /** In 1/10000 of a lot, as MT5 stores it. */
  volume: number;
  price: string;
  profitCents: number;
  commissionCents: number;
  swapCents: number;
  feeCents: number;
  comment: string;
  time: number;
  timeMsc: number;
  /** `time` turned into UTC with the server's configured offset from UTC, as an ISO time. */
  timeUtc: string;
}

export interface Ops {
  ping: { req: { server: string }; res: { serverTime: number | null } };
  "user.get": { req: { server: string; login: number }; res: Mt5User };
  /** Up to 100 logins; logins MT5 does not know, or in a group the gateway does not allow, are listed in `missing`. */
  "accounts.get": { req: { server: string; logins: number[] }; res: { accounts: Mt5Account[]; missing: number[] } };
  /** Opens an account in an allowed group. `comment` is the CRM's create reference. */
  "user.create": {
    req: { server: string; group: string; leverage: number; name: string; email: string; country: string; comment: string; password: string; investorPassword: string };
    res: { login: number };
  };
  /**
   * Finds the account a create with this comment made, among the group's
   * newest accounts. With `from` (ISO), accounts MT5 registered before then
   * cannot be it, so the search ends once it has reached them.
   */
  "user.find": { req: { server: string; group: string; comment: string; from?: string }; res: { login: number | null } };
  /** Changes only what is given. `enabled` false stops sign-in; `tradeDisabled` true stops trading. */
  "user.update": { req: { server: string; login: number; leverage?: number; enabled?: boolean; tradeDisabled?: boolean }; res: Mt5User };
  "user.password": { req: { server: string; login: number; type: "main" | "investor"; password: string }; res: Record<string, never> };
  "positions.total": { req: { server: string; login: number }; res: { total: number } };
  /**
   * A balance deal of `amountCents` (negative takes money out), commented with
   * the CRM's reference. Idempotent per (login, comment): when a deal with this
   * comment already exists since `notBefore`, its ticket comes back with
   * `duplicate: true` and nothing new is sent. `type` "credit" makes it a
   * credit deal instead (the broker's money lent to a live account, MT5 deal
   * action 3), under the same rules and caps; left out, it is a balance deal.
   */
  balance: {
    req: { server: string; login: number; amountCents: number; comment: string; checkMargin: boolean; notBefore: string; type?: "balance" | "credit" };
    res: { ticket: number; duplicate: boolean };
  };
  /** The balance or credit deal with this comment since `from` (ISO), if MT5 has one. */
  "deal.find": { req: { server: string; login: number; comment: string; from: string }; res: { deal: Mt5Deal | null } };
  /** A page of an account's deals between two ISO times, oldest first; `limit` at most 1000. */
  "deals.page": { req: { server: string; login: number; from: string; to: string; offset: number; limit: number }; res: { total: number; deals: Mt5Deal[] } };
  /**
   * The logins in one of the server's allowed live or demo groups, lowest
   * first: up to `limit` (at most 1000) above `after`, and how many the group
   * has in all. For reconciliation, to find MT5 accounts the CRM has no row
   * for. A group with more than the gateway lists (100,000) is refused.
   */
  "users.list": { req: { server: string; group: string; after?: number; limit: number }; res: { total: number; logins: number[] } };
}
export type OpName = keyof Ops;
export const OP_NAMES: readonly OpName[] = [
  "ping", "user.get", "accounts.get", "user.create", "user.find", "user.update", "user.password", "positions.total", "balance", "deal.find", "deals.page",
  "users.list",
];
/** Operations that change something in MT5. A lost answer to one of these is an unknown outcome, not a failure. */
export const WRITE_OPS: ReadonlySet<OpName> = new Set<OpName>(["user.create", "user.update", "user.password", "balance"]);

/**
 * - refused: MT5 (or the gateway's rules) said no; nothing changed.
 * - unavailable: the request never reached MT5 (no connection, sign-in failed); nothing changed.
 * - unknown: the request may have reached MT5 and the answer was lost; it may or may not have happened.
 * - bad_request: the request broke the protocol or the gateway's rules (a CRM bug or an attack); nothing changed.
 */
export type GatewayErrorKind = "refused" | "unavailable" | "unknown" | "bad_request";

/**
 * Machine codes for `refused` and the others. The CRM decides what a client
 * reads from these, never from `message`.
 */
export type GatewayErrorCode =
  | "no_money" // MT5 10019: not enough money or free margin
  | "not_found" // MT5 13: no such account or deal
  | "invalid_password" // MT5 3006: the password does not meet MT5's rules
  | "trade_disabled" // MT5 10017
  | "login_exists" // MT5 3004
  | "limit_reached" // MT5 3007, 4001, 4005, 10024
  | "too_frequent" // MT5 12
  | "group_not_allowed" // the gateway's group list does not include this account's group
  | "over_limit" // the gateway's per-operation or daily cap
  | "policy" // any other gateway rule
  | "mt5_error" // any other MT5 retcode
  | "auth" // the gateway could not sign in to MT5
  | "connection" // no connection to MT5
  | "timeout" // MT5 did not answer in time
  | "bad_signature" // the request's signature, time or nonce was wrong
  | "bad_request"; // the body or operation was invalid

export interface GatewayFailure {
  ok: false;
  error: { kind: GatewayErrorKind; code: GatewayErrorCode; message: string; retcode?: number };
}
export type GatewayAnswer<T> = { ok: true; result: T } | GatewayFailure;

export const sha256Hex = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** HMAC-SHA256 over the version, time, nonce, method, path and a hash of the body. */
export function requestSignature(secret: string, timestamp: string, nonce: string, path: string, body: string): string {
  return createHmac("sha256", secret).update(`gw1\n${timestamp}\n${nonce}\nPOST\n${path}\n${sha256Hex(body)}`).digest("hex");
}

/** HMAC-SHA256 over the request's nonce, the HTTP status and a hash of the answer's body. */
export function responseSignature(secret: string, nonce: string, status: number, body: string): string {
  return createHmac("sha256", secret).update(`gw1-answer\n${nonce}\n${status}\n${sha256Hex(body)}`).digest("hex");
}

/** Constant-time comparison of two hex strings of the expected length. */
export function sameHex(a: string | undefined | null, b: string): boolean {
  if (typeof a !== "string" || a.length !== b.length || !/^[0-9a-f]+$/.test(a)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/** 16 random bytes as hex: what X-Gw-Nonce carries. */
export const NONCE = /^[0-9a-f]{32}$/;
