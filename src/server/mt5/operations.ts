import type { Logger } from "pino";
import { lockClient } from "../clients/kyc";
import { notifyClient } from "../clients/notifications";
import { exec, one, transaction, type Conn, type Db } from "../lib/db";
import { formatMinor } from "../money/amounts";
import { holdAccount, lockWallet, mt5FundingAccount, postLedger, walletAccount } from "../money/ledger";
import { adjustSnapshot } from "./accounts";
import { callMt5 } from "./errors";
import { GatewayError, type Mt5Gateway } from "./gateway";
import { withMt5Reference, type Mt5ReferenceKind } from "./references";

// Balance operations: every balance deal the CRM asks MT5 for (wallet
// transfers, demo funding and top-ups). The row is written and committed
// ('sending') before the gateway is called, the call is made once, and the
// answer settles the row: completed, failed (MT5 definitely did not make the
// deal) or unknown (the answer was lost). An unknown operation is settled
// later by the resolver, which searches MT5 for the deal by its reference and
// never sends it again.
//
// Lock order, as for all client money: the client row, the wallet, the
// mt5_accounts row, then the operation.

export type BalancePurpose = "wallet_to_mt5" | "mt5_to_wallet" | "demo_funding" | "demo_topup";
export type OpStatus = "sending" | "unknown" | "completed" | "failed";

export interface BalanceOpRow {
  id: number;
  reference: string;
  purpose: BalancePurpose;
  client_id: number;
  mt5_account_id: number;
  server_code: string;
  login: number;
  /** Always positive; the purpose gives the direction. */
  amount_cents: number;
  status: OpStatus;
  mt5_ticket: number | null;
  failure: string | null;
  client_message: string | null;
  checks: number;
  next_check_at: Date | null;
  resolved_by: number | null;
  resolved_note: string | null;
  requested_ip: string;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export const SELECT_OP = `SELECT o.id, o.reference, o.purpose, o.client_id, o.mt5_account_id, o.server_code, o.login, o.amount_cents, o.status, o.mt5_ticket,
  o.failure, o.client_message, o.checks, o.next_check_at, o.resolved_by, o.resolved_note, o.requested_ip, o.created_at, o.updated_at, o.completed_at
  FROM mt5_balance_ops o`;

export const opFromDb = (o: BalanceOpRow): BalanceOpRow => ({
  ...o,
  id: Number(o.id),
  client_id: Number(o.client_id),
  mt5_account_id: Number(o.mt5_account_id),
  login: Number(o.login),
  amount_cents: Number(o.amount_cents),
  mt5_ticket: o.mt5_ticket === null ? null : Number(o.mt5_ticket),
  checks: Number(o.checks),
});

export async function loadOp(conn: Conn, id: number, lock = false): Promise<BalanceOpRow | undefined> {
  const o = await one<BalanceOpRow>(conn, `${SELECT_OP} WHERE o.id = ?${lock ? " FOR UPDATE" : ""}`, [id]);
  return o && opFromDb(o);
}

/** The amount MT5 is asked to add to the account: negative takes money out. */
export const signedCents = (op: Pick<BalanceOpRow, "purpose" | "amount_cents">) => (op.purpose === "mt5_to_wallet" ? -op.amount_cents : op.amount_cents);

export const DEMO_FAILED = "We could not add the money to your demo account. Please try again later.";

/**
 * What each purpose does when its operation settles. The hooks run inside the
 * settling transaction, with the client row, the wallet (when `wallet`), the
 * account and the operation locked, before the operation's status changes;
 * if a hook throws, nothing is settled. Each purpose's hooks run at most once
 * per operation: only an operation still 'sending' or 'unknown' settles.
 */
export interface PurposeRules {
  /** The reference letter (T transfer, D demo). */
  kind: Mt5ReferenceKind;
  /** The hooks move wallet money, so the wallet is locked too. */
  wallet: boolean;
  /** MT5's check_margin: a withdrawal from MT5 must leave its margin covered. */
  checkMargin: boolean;
  /** MT5 made the deal (`ticket`). */
  completed(conn: Conn, op: BalanceOpRow, ticket: number): Promise<void>;
  /** MT5 definitely did not make it (`failure` is the code staff see). */
  failed(conn: Conn, op: BalanceOpRow, failure: string): Promise<void>;
  /** What the client reads when it failed at once. Never MT5's own words. */
  failedMessage(failure: string): string;
  /** What the client reads when the resolver gave up finding it. */
  notFoundMessage: string;
}

const demoRules: PurposeRules = {
  kind: "D",
  wallet: false,
  checkMargin: false,
  // Demo money is not client money: no ledger, just the figures the client sees.
  completed: (conn, op) => adjustSnapshot(conn, op.mt5_account_id, op.amount_cents),
  failed: async () => undefined,
  failedMessage: () => DEMO_FAILED,
  notFoundMessage: DEMO_FAILED,
};

export const TO_MT5_FAILED = "The transfer did not go through. The money is back in your wallet.";
export const TO_WALLET_FAILED = "The transfer did not go through.";
export const NO_FREE_MARGIN = "There is not enough free margin in this account for this transfer.";

/** "$1,250.00", as the client reads amounts. */
const dollars = (cents: number) => `$${formatMinor(cents)}`;

/** The client hears how a transfer ended in the bell, whether the request, the resolver or staff settled it. */
const tellClient = (conn: Conn, op: BalanceOpRow, title: string, body: string) =>
  notifyClient(conn, op.client_id, { type: "account", title, body, link: "/transactions", linkLabel: "View history" });

/** Posts one of a transfer's ledger transactions, sourced to the operation so it can happen once only. */
const postTransfer = (conn: Conn, op: BalanceOpRow, kind: "transfer_out" | "transfer_release" | "transfer_in", entries: { account: string; amount: number }[]) =>
  postLedger(conn, { kind, sourceType: "mt5_op", sourceId: op.id, clientId: op.client_id, staffId: null, memo: `Transfer ${op.reference}, MT5 ${op.login}` }, entries);

/**
 * Wallet to MT5. The request took the money out of the wallet into `hold`
 * (transfer_hold) before MT5 was asked; MT5's deal pays it out to the
 * account's funding line, and a definite no gives it back.
 */
const toMt5Rules: PurposeRules = {
  kind: "T",
  wallet: true,
  checkMargin: false,
  completed: async (conn, op) => {
    const x = op.amount_cents;
    await postTransfer(conn, op, "transfer_out", [{ account: holdAccount(op.client_id), amount: -x }, { account: mt5FundingAccount(op.mt5_account_id), amount: x }]);
    await adjustSnapshot(conn, op.mt5_account_id, x);
    await tellClient(conn, op, "Your transfer to MT5 is complete", `${dollars(x)} from your wallet is now in MT5 account ${op.login}.`);
  },
  failed: async (conn, op) => {
    const x = op.amount_cents;
    await postTransfer(conn, op, "transfer_release", [{ account: holdAccount(op.client_id), amount: -x }, { account: walletAccount(op.client_id), amount: x }]);
    await tellClient(conn, op, "Your transfer to MT5 did not go through", `${dollars(x)} for MT5 account ${op.login} is back in your wallet.`);
  },
  failedMessage: () => TO_MT5_FAILED,
  notFoundMessage: TO_MT5_FAILED,
};

/**
 * MT5 to wallet. Nothing is written to the ledger until MT5 has taken the
 * money out of the account: only then is the wallet credited.
 */
const toWalletRules: PurposeRules = {
  kind: "T",
  wallet: true,
  // MT5 refuses a withdrawal that would leave the account's margin uncovered.
  checkMargin: true,
  completed: async (conn, op) => {
    const x = op.amount_cents;
    await postTransfer(conn, op, "transfer_in", [{ account: mt5FundingAccount(op.mt5_account_id), amount: -x }, { account: walletAccount(op.client_id), amount: x }]);
    await adjustSnapshot(conn, op.mt5_account_id, -x);
    await tellClient(conn, op, "Your transfer to your wallet is complete", `${dollars(x)} from MT5 account ${op.login} is now in your wallet.`);
  },
  failed: async (conn, op) => {
    await tellClient(conn, op, "Your transfer from MT5 did not go through", `${dollars(op.amount_cents)} stayed in MT5 account ${op.login}.`);
  },
  failedMessage: (failure) => (failure === "no_money" ? NO_FREE_MARGIN : TO_WALLET_FAILED),
  notFoundMessage: TO_WALLET_FAILED,
};

/** The settle hooks of each purpose. */
export const PURPOSES: Record<BalancePurpose, PurposeRules> = {
  demo_funding: demoRules,
  demo_topup: demoRules,
  wallet_to_mt5: toMt5Rules,
  mt5_to_wallet: toWalletRules,
};

/**
 * Writes a new operation ('sending') with a fresh reference. Call it in the
 * transaction that holds the client row, the wallet (for transfers) and the
 * account, and commit before runBalanceOp.
 */
export async function insertBalanceOp(
  conn: Conn,
  input: { purpose: BalancePurpose; clientId: number; accountId: number; serverCode: string; login: number; amountCents: number; ip: string },
): Promise<{ id: number; reference: string }> {
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new Error(`Bad MT5 balance amount ${input.amountCents}`);
  return withMt5Reference(PURPOSES[input.purpose].kind, async (reference) => {
    const r = await exec(
      conn,
      `INSERT INTO mt5_balance_ops (reference, purpose, client_id, mt5_account_id, server_code, login, amount_cents, requested_ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [reference, input.purpose, input.clientId, input.accountId, input.serverCode, input.login, input.amountCents, input.ip.slice(0, 45)],
    );
    return { id: r.insertId, reference };
  });
}

export type Settlement =
  | { status: "completed"; ticket: number }
  | { status: "failed"; failure: string; clientMessage: string; staffId?: number | null; note?: string | null }
  | { status: "unknown"; failure: string; nextCheckAt: Date; checks?: number };

/**
 * Settles an operation that is still in one of `from`, running its purpose's
 * hook. Returns the operation as it now is, and whether this call settled it
 * (false when something else already had). `also` runs in the same
 * transaction once this call has settled it (a staff action's audit row).
 */
export async function settleBalanceOp(
  db: Db,
  opId: number,
  outcome: Settlement,
  from: OpStatus[] = ["sending", "unknown"],
  also?: (conn: Conn, op: BalanceOpRow) => Promise<void>,
): Promise<{ op: BalanceOpRow; settled: boolean }> {
  // Read before the transaction (these never change), so the locks are taken in order.
  const ref = await loadOp(db, opId);
  if (!ref) throw new Error(`MT5 balance operation ${opId} does not exist`);
  const rules = PURPOSES[ref.purpose];
  return transaction(db, async (conn) => {
    await lockClient(conn, ref.client_id);
    if (rules.wallet) await lockWallet(conn, ref.client_id);
    await one(conn, "SELECT id FROM mt5_accounts WHERE id = ? FOR UPDATE", [ref.mt5_account_id]);
    const op = (await loadOp(conn, opId, true))!;
    if (!from.includes(op.status)) return { op, settled: false };
    if (outcome.status === "completed") {
      await rules.completed(conn, op, outcome.ticket);
      await exec(
        conn,
        `UPDATE mt5_balance_ops SET status = 'completed', mt5_ticket = ?, failure = NULL, client_message = NULL, next_check_at = NULL,
           completed_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
        [outcome.ticket, opId],
      );
    } else if (outcome.status === "failed") {
      await rules.failed(conn, op, outcome.failure);
      await exec(
        conn,
        `UPDATE mt5_balance_ops SET status = 'failed', failure = ?, client_message = ?, next_check_at = NULL, resolved_by = ?, resolved_note = ?,
           completed_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
        [outcome.failure.slice(0, 40), outcome.clientMessage.slice(0, 200), outcome.staffId ?? null, outcome.note?.slice(0, 500) ?? null, opId],
      );
    } else {
      await exec(conn, "UPDATE mt5_balance_ops SET status = 'unknown', failure = ?, next_check_at = ?, checks = ? WHERE id = ?", [
        outcome.failure.slice(0, 40), outcome.nextCheckAt, outcome.checks ?? op.checks, opId,
      ]);
    }
    const settled = (await loadOp(conn, opId))!;
    if (also) await also(conn, settled);
    return { op: settled, settled: true };
  });
}

/** How soon the resolver first looks for a deal whose answer was lost. */
export const FIRST_CHECK_MS = 60_000;

/**
 * Sends a 'sending' operation to MT5 once and settles it from the answer.
 * A lost answer leaves it unknown for the resolver. Returns the settled row.
 */
export async function runBalanceOp(deps: { db: Db; mt5: Mt5Gateway | null; log: Pick<Logger, "info" | "warn" | "error"> }, opId: number): Promise<BalanceOpRow> {
  const { db, mt5, log } = deps;
  const op = await loadOp(db, opId);
  if (!op) throw new Error(`MT5 balance operation ${opId} does not exist`);
  if (op.status !== "sending") return op;
  const rules = PURPOSES[op.purpose];
  const fail = (failure: string) => settleBalanceOp(db, opId, { status: "failed", failure, clientMessage: rules.failedMessage(failure) }, ["sending"]);
  let result: { op: BalanceOpRow };
  if (!mt5) {
    result = await fail("unavailable");
  } else {
    let ticket: number | null = null;
    let refusal: GatewayError | null = null;
    try {
      ({ ticket } = await callMt5(
        mt5,
        "balance",
        { server: op.server_code, login: op.login, amountCents: signedCents(op), comment: op.reference, checkMargin: rules.checkMargin, notBefore: op.created_at.toISOString() },
        log,
      ));
    } catch (error) {
      if (!(error instanceof GatewayError)) throw error;
      refusal = error;
    }
    // Settled outside the try: a problem recording a deal MT5 made must never read as MT5 saying no.
    if (refusal === null) result = await settleBalanceOp(db, opId, { status: "completed", ticket: ticket! }, ["sending"]);
    else if (refusal.kind === "unknown") {
      result = await settleBalanceOp(db, opId, { status: "unknown", failure: refusal.code, nextCheckAt: new Date(Date.now() + FIRST_CHECK_MS) }, ["sending"]);
    } else result = await fail(refusal.kind === "refused" ? refusal.code : refusal.kind);
  }
  const settled = result.op;
  const entry = { opId, reference: settled.reference, purpose: settled.purpose, server: settled.server_code, login: settled.login, amountCents: settled.amount_cents, status: settled.status, failure: settled.failure };
  if (settled.status === "unknown") log.warn(entry, "MT5 balance operation outcome unknown; the resolver will look for it");
  else log.info(entry, "MT5 balance operation settled");
  return settled;
}
