import { WRITE_OPS, type OpName, type Ops } from "../../gateway/protocol";
import { fieldError } from "../clients/errors";
import { HttpError } from "../lib/http";
import { GatewayError, type Mt5Gateway } from "./gateway";

// What clients and staff are told when MT5 work does not go through, and the
// gateway call wrappers every route uses. A client never reads MT5's own text
// (a retcode message can look like a sign-in error); staff may.

export const MT5_UNAVAILABLE = "Trading accounts are temporarily unavailable. Please try again in a few minutes.";
export const ACCOUNT_NOT_FOUND = "Account not found.";
export const CREATE_UNCONFIRMED = "We could not confirm that your account was opened. Please check your accounts in a minute before trying again.";
export const CHANGE_UNCONFIRMED = "We could not confirm that this change was made. Please check your account in a minute before trying again.";
export const CHANGE_FAILED = "We could not make this change. Please try again later.";
export const SUSPENDED = "This account has been suspended. Please contact support.";
export const STAFF_UNCONFIRMED = "MT5 did not confirm the change. Refresh to see the account's current state.";

/** MT5 off, the server switched off, or the gateway could not reach MT5: 422, never 5xx (the app would block a retry). */
export const mt5Unavailable = () => fieldError("mt5", MT5_UNAVAILABLE);
export const accountNotFound = () => new HttpError(404, "NOT_FOUND", ACCOUNT_NOT_FOUND);
/** The honest "it may or may not have happened": the app reads 409 as an uncertain outcome and blocks a blind retry. */
export const unconfirmed = (message = CHANGE_UNCONFIRMED) => new HttpError(409, "UNCONFIRMED", message);

export const isUnknown = (error: unknown): error is GatewayError => error instanceof GatewayError && error.kind === "unknown";

/**
 * Calls the gateway. Anything thrown that is not a GatewayError (a bug on
 * this side) counts as a lost answer for a write and as "not reached" for a
 * read, so a write is never taken to have failed when it may have happened.
 * Requests are never logged: some carry passwords.
 */
export async function callMt5<K extends OpName>(gateway: Mt5Gateway, op: K, req: Ops[K]["req"], log?: { error: (obj: unknown, msg: string) => void }): Promise<Ops[K]["res"]> {
  try {
    return await gateway.call(op, req);
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    log?.error({ op, err: error }, "MT5 gateway call failed unexpectedly");
    throw new GatewayError(WRITE_OPS.has(op) ? "unknown" : "unavailable", "connection", "The MT5 gateway call failed unexpectedly.");
  }
}

/**
 * For changes that are safe to repeat (rights, leverage, a password): a lost
 * answer is asked once more straight away before anyone is told "unconfirmed".
 * If that second try fails too, in any way, the first answer is still the
 * lost one: the change may have happened, so it stays unknown, never a
 * definite no. Never for a create or a balance operation.
 */
export async function callMt5Again<K extends "user.update" | "user.password">(
  gateway: Mt5Gateway,
  op: K,
  req: Ops[K]["req"],
  log?: { error: (obj: unknown, msg: string) => void },
): Promise<Ops[K]["res"]> {
  try {
    return await callMt5(gateway, op, req, log);
  } catch (error) {
    if (!isUnknown(error)) throw error;
    try {
      return await callMt5(gateway, op, req, log);
    } catch {
      throw error;
    }
  }
}

/** A failed gateway call as staff read it: MT5's own words may be shown to staff. */
export function staffMt5Error(error: GatewayError): HttpError {
  const details = { kind: error.kind, code: error.code, ...(error.retcode === undefined ? {} : { retcode: error.retcode }) };
  if (error.kind === "unknown") return new HttpError(409, "MT5_UNCONFIRMED", STAFF_UNCONFIRMED, details);
  if (error.kind === "unavailable") return new HttpError(422, "MT5_UNAVAILABLE", `MT5 could not be reached: ${error.message}`, details);
  if (error.kind === "bad_request") return new HttpError(400, "MT5_BAD_REQUEST", `The MT5 gateway would not accept this: ${error.message}`, details);
  return new HttpError(422, "MT5_REFUSED", `MT5 refused this: ${error.message}`, details);
}
