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
 * MT5 itself lost track: 7 network error, 9 timeout. On a write MT5 may still
 * have applied it (the access server timed out waiting for the trade server),
 * so that is an unknown outcome, not a refusal.
 */
const UNSURE_RETCODES: ReadonlySet<number> = new Set([7, 9]);

export const mapRetcode = (code: number): GatewayErrorCode => CODES.get(code) ?? "mt5_error";

/** The error for a non-zero retcode. During sign-in nothing can have happened, so every failure there is `unavailable`. */
export function retcodeError(rc: Retcode, ctx: { write: boolean; signingIn?: boolean }): OpError {
  const message = `MT5 answered ${rc.code}${rc.text ? ` "${rc.text}"` : ""}.`;
  if (ctx.signingIn) return unavailable("auth", `MT5 refused the manager sign-in: ${message}`, rc.code);
  if (ctx.write && UNSURE_RETCODES.has(rc.code)) return unknownOutcome(rc.code === 9 ? "timeout" : "connection", message, rc.code);
  return refused(mapRetcode(rc.code), message, rc.code);
}
