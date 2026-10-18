import type { GatewayErrorCode } from "../protocol";
import { OpError, refused, unavailable, unknownOutcome } from "../errors";

// MT5 answers every request with `retcode`, "<number> <text>" ("0 Done",
// "13 Not found"). Only 0 is success; a missing or unreadable retcode is an
// error, never success (MetaQuotes' own PHP library reads an empty one as 0,
// which the gateway does not copy). Numbers from MetaQuotes' MTRetCode list,
// see mt5-webapi.md §3.

export interface Retcode {
  code: number;
  text: string;
}

export function parseRetcode(value: unknown): Retcode | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,6})(?:\s+(.*))?$/s.exec(value.trim());
  if (!match) return null;
  return { code: Number(match[1]), text: (match[2] ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120) };
}

const CODES = new Map<number, GatewayErrorCode>([
  [10019, "no_money"],
  [13, "not_found"],
  [3006, "invalid_password"],
  [10017, "trade_disabled"],
  [3004, "login_exists"],
  [3007, "limit_reached"],
  [4001, "limit_reached"],
  [4005, "limit_reached"],
  [10024, "limit_reached"],
  [12, "too_frequent"],
  [1001, "auth"],
  [1002, "auth"],
  [1008, "auth"],
  [1011, "auth"],
  [1012, "auth"],
  [2005, "auth"],
]);

/** Retcodes that say the manager's session is not (or no longer) valid. */
export const SESSION_RETCODES: ReadonlySet<number> = new Set([1001, 1002, 1008, 1011, 1012, 2005]);

/**
 * The answers to a write that say for certain MT5 turned it down before
 * changing anything: invalid parameters (3), no permission (8), too frequent
 * (12), not found (13), the manager's session, the user refusals (3002-3008,
 * 3010), the trade limits (4001, 4004, 4005) and the request refusals
 * (10006, 10007, 10013-10019, 10024, 10026-10030, 10032). Any other answer to
 * a write may come after MT5 applied it: 7 network error, 9 timeout and 10 no
 * connection (the access server lost the trade server), but also the
 * request-pipeline codes 10001-10003, 10008-10010, 10012 "Request timeout",
 * 10031 and 11000-11002, and codes nobody listed. Those are unknown outcomes
 * that a search settles, never a refusal: a refusal gives the money back.
 */
const DEFINITE_WRITE_RETCODES: ReadonlySet<number> = new Set([
  3, 8, 12, 13, ...SESSION_RETCODES, 3002, 3003, 3004, 3006, 3007, 3008, 3010, 4001, 4004, 4005,
  10006, 10007, 10013, 10014, 10015, 10016, 10017, 10018, 10019, 10024, 10026, 10027, 10028, 10029, 10030, 10032,
]);

/**
 * MT5 busy or not reaching its own servers just now: 7 network error, 9
 * timeout, 10 no connection, 11 no service, 12 too frequent, 15 shutting down,
 * 1018 server busy. A read that meets one of these did not get an answer, so
 * it is `unavailable` (try again soon), not a refusal.
 */
const TRANSIENT_RETCODES: ReadonlySet<number> = new Set([7, 9, 10, 11, 12, 15, 1018]);

export const mapRetcode = (code: number): GatewayErrorCode => CODES.get(code) ?? "mt5_error";

/** The protocol code for a retcode that is not a refusal. */
const notAnswered = (code: number): GatewayErrorCode => (code === 9 || code === 10012 ? "timeout" : code === 12 ? "too_frequent" : code === 7 || code === 10 ? "connection" : "mt5_error");

/** The error for a non-zero retcode. During sign-in nothing can have happened, so every failure there is `unavailable`. */
export function retcodeError(rc: Retcode, ctx: { write: boolean; signingIn?: boolean }): OpError {
  const message = `MT5 answered ${rc.code}${rc.text ? ` "${rc.text}"` : ""}.`;
  if (ctx.signingIn) return unavailable("auth", `MT5 refused the manager sign-in: ${message}`, rc.code);
  if (ctx.write && !DEFINITE_WRITE_RETCODES.has(rc.code)) return unknownOutcome(notAnswered(rc.code), message, rc.code);
  if (!ctx.write && TRANSIENT_RETCODES.has(rc.code)) return unavailable(notAnswered(rc.code), message, rc.code);
  return refused(mapRetcode(rc.code), message, rc.code);
}
