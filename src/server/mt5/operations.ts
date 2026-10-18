import type { Logger } from "pino";
import { lockClient } from "../clients/kyc";
import { notifyClient } from "../clients/notifications";
import { writeAudit, type AuditContext } from "../lib/audit";
import { exec, one, transaction, type Conn, type Db } from "../lib/db";
import { formatMinor } from "../money/amounts";
import { holdAccount, lockWallet, MT5_ADJUSTMENTS_ACCOUNT, mt5FundingAccount, postLedger, walletAccount } from "../money/ledger";
import { adjustSnapshot } from "./accounts";
import { callMt5 } from "./errors";
import { GatewayError, type Mt5Gateway } from "./gateway";
import { withMt5Reference, type Mt5ReferenceKind } from "./references";

// Balance operations: every balance or credit deal the CRM asks MT5 for
// (wallet transfers, demo funding and top-ups, and staff changes to an
// account's balance or credit). The row is written and committed ('sending')
// before the gateway is called, the call is made once, and the answer
// settles the row: completed, failed (MT5 definitely did not make the deal)
// or unknown (the answer was lost). An unknown operation is settled later by
// the resolver, which searches MT5 for the deal by its reference and never
// sends it again.
//
// A staff change is written 'awaiting_approval' unless it is small enough to
// run at once. Only a second staff member's approval moves it to 'sending';
// a rejected one ends 'cancelled'. Neither of those two states is ever sent.
//
// Lock order, as for all client money: the client row, the wallet, the
// mt5_accounts row, then the operation.

export type StaffPurpose = "staff_balance_in" | "staff_balance_out" | "staff_credit_in" | "staff_credit_out";
export type BalancePurpose = "wallet_to_mt5" | "mt5_to_wallet" | "demo_funding" | "demo_topup" | StaffPurpose;
export const STAFF_PURPOSES: readonly StaffPurpose[] = ["staff_balance_in", "staff_balance_out", "staff_credit_in", "staff_credit_out"];
export const isStaffPurpose = (purpose: string): purpose is StaffPurpose => (STAFF_PURPOSES as readonly string[]).includes(purpose);

/** awaiting_approval and cancelled belong to staff changes only: waiting for a second person, and refused before anything was sent. */
export type OpStatus = "awaiting_approval" | "sending" | "unknown" | "completed" | "failed" | "cancelled";

/** Why staff changed a balance or credit. */
export const REASON_CODES = ["compensation", "correction", "bonus", "chargeback", "fee_refund", "other"] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

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
  /** Staff changes: who asked, why, their note, who approved it and when, and the approver's or rejecter's note. */
  requested_by: number | null;
  reason_code: ReasonCode | null;
  staff_note: string | null;
  approved_by: number | null;
  approved_at: Date | null;
  decided_note: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export const SELECT_OP = `SELECT o.id, o.reference, o.purpose, o.client_id, o.mt5_account_id, o.server_code, o.login, o.amount_cents, o.status, o.mt5_ticket,
  o.failure, o.client_message, o.checks, o.next_check_at, o.resolved_by, o.resolved_note, o.requested_ip,
  o.requested_by, o.reason_code, o.staff_note, o.approved_by, o.approved_at, o.decided_note, o.created_at, o.updated_at, o.completed_at
  FROM mt5_balance_ops o`;

const idOrNull = (v: number | null) => (v === null ? null : Number(v));

export const opFromDb = (o: BalanceOpRow): BalanceOpRow => ({
  ...o,
  id: Number(o.id),
  client_id: Number(o.client_id),
  mt5_account_id: Number(o.mt5_account_id),
  login: Number(o.login),
  amount_cents: Number(o.amount_cents),
  mt5_ticket: idOrNull(o.mt5_ticket),
  checks: Number(o.checks),
  resolved_by: idOrNull(o.resolved_by),
  requested_by: idOrNull(o.requested_by),
  approved_by: idOrNull(o.approved_by),
});

export async function loadOp(conn: Conn, id: number, lock = false): Promise<BalanceOpRow | undefined> {
  const o = await one<BalanceOpRow>(conn, `${SELECT_OP} WHERE o.id = ?${lock ? " FOR UPDATE" : ""}`, [id]);
  return o && opFromDb(o);
}

/** The amount MT5 is asked to add to the account: negative takes money (or credit) out. */
export const signedCents = (op: Pick<BalanceOpRow, "purpose" | "amount_cents">) => (PURPOSES[op.purpose].out ? -op.amount_cents : op.amount_cents);

/** The MT5 deal action an operation makes: 2 balance, 3 credit. */
export const dealAction = (op: Pick<BalanceOpRow, "purpose">) => (PURPOSES[op.purpose].deal === "credit" ? 3 : 2);

/**
 * When the operation was let go to MT5: a staff change's approval, else its
 * request. MT5 cannot have its deal from before then, and the "ten minutes
 * before it may be called never made" count from then.
 */
export const sentAt = (op: Pick<BalanceOpRow, "created_at" | "approved_at">) => op.approved_at ?? op.created_at;

export const DEMO_FAILED = "We could not add the money to your demo account. Please try again later.";

/**
 * What each purpose does when its operation settles. The hooks run inside the
 * settling transaction, with the client row, the wallet (when `wallet`), the
 * account and the operation locked, before the operation's status changes;
 * if a hook throws, nothing is settled. Each purpose's hooks run at most once
 * per operation: only an operation still 'sending' or 'unknown' settles.
 */
export interface PurposeRules {
  /** The reference letter (T transfer, D demo, S staff change). */
  kind: Mt5ReferenceKind;
  /** The hooks move wallet money, so the wallet is locked too. */
  wallet: boolean;
  /** MT5's check_margin: taking money or credit out of MT5 must leave its margin covered. */
  checkMargin: boolean;
  /** Which MT5 deal it is: a balance deal, or a credit deal (the broker's money lent). */
  deal: "balance" | "credit";
  /** It takes money (or credit) out of the account. */
  out: boolean;
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
  deal: "balance",
  out: false,
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
  deal: "balance",
  out: false,
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
  deal: "balance",
  out: true,
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

/** A staff change that did not go through. Clients never see staff changes that failed, so this is for the record only. */
export const STAFF_CHANGE_FAILED = "The change was not made.";

/** An outcome MT5 decided (its answer, or the resolver's search), as the audit log records it. */
const MT5_OUTCOME: AuditContext = { actor: { type: "system", id: null, label: "MT5 balance operations" }, ip: "", userAgent: "" };

/** What the client reads in the bell once a staff change has gone through: the login and the amount, never the reason or the reference. */
const STAFF_BELL: Record<StaffPurpose, (amount: string, login: number) => { title: string; body: string }> = {
  staff_balance_in: (x, login) => ({ title: "Your MT5 account was credited", body: `Your MT5 account ${login} was credited ${x}.` }),
  staff_balance_out: (x, login) => ({ title: "Your MT5 account was debited", body: `Your MT5 account ${login} was debited ${x}.` }),
  staff_credit_in: (x, login) => ({ title: "Credit added to your MT5 account", body: `${x} of credit was added to your MT5 account ${login}.` }),
  staff_credit_out: (x, login) => ({ title: "Credit removed from your MT5 account", body: `${x} of credit was removed from your MT5 account ${login}.` }),
};

/** What every audit row of a staff change names. */
export const staffChangeMeta = (op: BalanceOpRow) => ({
  opId: op.id, reference: op.reference, purpose: op.purpose, accountId: op.mt5_account_id, login: op.login, amountCents: op.amount_cents,
  reasonCode: op.reason_code, requestedBy: op.requested_by, approvedBy: op.approved_by,
});

/**
 * Moves the cached credit, and the equity and free margin it is part of, by
 * a credit change that just went through, dated back so the next list reads
 * MT5 again (as adjustSnapshot does for the balance).
 */
async function adjustCreditSnapshot(conn: Conn, accountId: number, deltaCents: number) {
  await exec(
    conn,
    `UPDATE mt5_accounts SET credit_cents = credit_cents + ?, equity_cents = equity_cents + ?, margin_free_cents = margin_free_cents + ?,
       snapshot_at = LEAST(snapshot_at, CURRENT_TIMESTAMP(3) - INTERVAL 1 HOUR), updated_at = updated_at
     WHERE id = ? AND snapshot_at IS NOT NULL`,
    [deltaCents, deltaCents, deltaCents, accountId],
  );
}

/**
 * A staff change to a live account's balance or credit. A balance change is
 * client money: once MT5 has made the deal, the ledger moves it between the
 * broker's adjustments account and the account's funding line, once (the
 * operation is its source). A credit change is the broker's money lent and
 * posts nothing. Either way the client hears of it once it is done, and the
 * outcome is audited.
 */
function staffRules(purpose: StaffPurpose): PurposeRules {
  const credit = purpose === "staff_credit_in" || purpose === "staff_credit_out";
  const out = purpose === "staff_balance_out" || purpose === "staff_credit_out";
  return {
    kind: "S",
    wallet: false,
    checkMargin: out,
    deal: credit ? "credit" : "balance",
    out,
    completed: async (conn, op, ticket) => {
      const x = op.amount_cents;
      const delta = out ? -x : x;
      if (credit) {
        await adjustCreditSnapshot(conn, op.mt5_account_id, delta);
      } else {
        await postLedger(
          conn,
          {
            kind: out ? "mt5_adjust_out" : "mt5_adjust_in", sourceType: "mt5_op", sourceId: op.id, clientId: op.client_id,
            staffId: op.approved_by ?? op.requested_by, memo: `Staff change ${op.reference}, MT5 ${op.login}`,
          },
          [{ account: MT5_ADJUSTMENTS_ACCOUNT, amount: -delta }, { account: mt5FundingAccount(op.mt5_account_id), amount: delta }],
        );
        await adjustSnapshot(conn, op.mt5_account_id, delta);
      }
      await notifyClient(conn, op.client_id, { type: "account", ...STAFF_BELL[purpose](dollars(x), op.login) });
      await writeAudit(conn, MT5_OUTCOME, { action: "mt5.adjustment.completed", entityType: "client", entityId: op.client_id, meta: { ...staffChangeMeta(op), ticket } });
    },
    failed: (conn, op, failure) =>
      writeAudit(conn, MT5_OUTCOME, { action: "mt5.adjustment.failed", entityType: "client", entityId: op.client_id, meta: { ...staffChangeMeta(op), failure } }),
    failedMessage: () => STAFF_CHANGE_FAILED,
    notFoundMessage: STAFF_CHANGE_FAILED,
  };
}

/** The settle hooks of each purpose. */
export const PURPOSES: Record<BalancePurpose, PurposeRules> = {
  demo_funding: demoRules,
  demo_topup: demoRules,
  wallet_to_mt5: toMt5Rules,
  mt5_to_wallet: toWalletRules,
  staff_balance_in: staffRules("staff_balance_in"),
  staff_balance_out: staffRules("staff_balance_out"),
  staff_credit_in: staffRules("staff_credit_in"),
  staff_credit_out: staffRules("staff_credit_out"),
};

/** Who asked for a staff change and why, and whether it waits for a second person. */
export interface StaffRequest {
  requestedBy: number;
  reasonCode: ReasonCode;
  note: string;
  awaitingApproval: boolean;
}

/**
 * Writes a new operation with a fresh reference: 'sending', or for a staff
 * change that needs a second person 'awaiting_approval'. Call it in the
 * transaction that holds the client row, the wallet (for transfers) and the
 * account, and commit before runBalanceOp.
 */
export async function insertBalanceOp(
  conn: Conn,
  input: { purpose: BalancePurpose; clientId: number; accountId: number; serverCode: string; login: number; amountCents: number; ip: string; staff?: StaffRequest },
): Promise<{ id: number; reference: string }> {
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new Error(`Bad MT5 balance amount ${input.amountCents}`);
  const staff = input.staff ?? null;
  if (isStaffPurpose(input.purpose) !== (staff !== null)) throw new Error(`MT5 operation ${input.purpose} ${staff ? "cannot" : "must"} name a staff requester`);
  return withMt5Reference(PURPOSES[input.purpose].kind, async (reference) => {
    const r = await exec(
      conn,
      `INSERT INTO mt5_balance_ops (reference, purpose, client_id, mt5_account_id, server_code, login, amount_cents, requested_ip,
         status, requested_by, reason_code, staff_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        reference, input.purpose, input.clientId, input.accountId, input.serverCode, input.login, input.amountCents, input.ip.slice(0, 45),
        staff?.awaitingApproval ? "awaiting_approval" : "sending", staff?.requestedBy ?? null, staff?.reasonCode ?? null, staff?.note.slice(0, 500) ?? null,
      ],
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

export type StaffDecision =
  | { done: true; op: BalanceOpRow }
  /**
   * settled: no longer awaiting approval; same_person: the approver asked for
   * it; busy: another operation on the account is still open; closed: the
   * client's account is closed.
   */
  | { done: false; reason: "settled" | "same_person" | "busy" | "closed"; op: BalanceOpRow };

/** Takes a staff change's locks for a decision, in lock order: the client row, the account, the operation. */
async function lockForDecision(conn: Conn, ref: BalanceOpRow) {
  await lockClient(conn, ref.client_id);
  await one(conn, "SELECT id FROM mt5_accounts WHERE id = ? FOR UPDATE", [ref.mt5_account_id]);
  return (await loadOp(conn, ref.id, true))!;
}

/**
 * A second person's yes. Moves a staff change still awaiting approval to
 * 'sending', for runBalanceOp to send once: only this moves it there, under
 * the operation's lock, so two approvals at once let it go once. Refused for
 * the person who asked for it (whichever of their sessions asks; the table
 * refuses it too), while another operation on the account is still open, and
 * for a closed client. The caller checks the limits on live figures first.
 * `also` runs in the same transaction (the audit row).
 */
export async function approveStaffOp(
  db: Db,
  opId: number,
  by: { staffId: number; note: string | null },
  also: (conn: Conn, op: BalanceOpRow) => Promise<void>,
): Promise<StaffDecision> {
  const ref = await loadOp(db, opId);
  if (!ref) throw new Error(`MT5 balance operation ${opId} does not exist`);
  return transaction(db, async (conn): Promise<StaffDecision> => {
    const op = await lockForDecision(conn, ref);
    if (op.status !== "awaiting_approval" || !isStaffPurpose(op.purpose)) return { done: false, reason: "settled", op };
    if (op.requested_by === by.staffId) return { done: false, reason: "same_person", op };
    const client = await one<{ status: string }>(conn, "SELECT status FROM clients WHERE id = ?", [op.client_id]);
    if (client?.status === "closed") return { done: false, reason: "closed", op };
    // Every operation on the account is written or let go under its row lock, so this sees any still open.
    if (await one(conn, "SELECT id FROM mt5_balance_ops WHERE mt5_account_id = ? AND status IN ('sending', 'unknown') LIMIT 1", [op.mt5_account_id])) {
      return { done: false, reason: "busy", op };
    }
    await exec(conn, "UPDATE mt5_balance_ops SET status = 'sending', approved_by = ?, approved_at = CURRENT_TIMESTAMP(3), decided_note = ? WHERE id = ?", [
      by.staffId, by.note?.slice(0, 500) ?? null, op.id,
    ]);
    const approved = (await loadOp(conn, op.id))!;
    await also(conn, approved);
    return { done: true, op: approved };
  });
}

/**
 * A no, from anyone who may decide, the requester included (who cancels
 * their own). A staff change still awaiting approval ends 'cancelled' and is
 * never sent. `also` runs in the same transaction (the audit row).
 */
export async function cancelStaffOp(
  db: Db,
  opId: number,
  by: { staffId: number; note: string },
  also: (conn: Conn, op: BalanceOpRow) => Promise<void>,
): Promise<StaffDecision> {
  const ref = await loadOp(db, opId);
  if (!ref) throw new Error(`MT5 balance operation ${opId} does not exist`);
  return transaction(db, async (conn): Promise<StaffDecision> => {
    const op = await lockForDecision(conn, ref);
    if (op.status !== "awaiting_approval" || !isStaffPurpose(op.purpose)) return { done: false, reason: "settled", op };
    await exec(
      conn,
      "UPDATE mt5_balance_ops SET status = 'cancelled', resolved_by = ?, decided_note = ?, next_check_at = NULL, completed_at = CURRENT_TIMESTAMP(3) WHERE id = ?",
      [by.staffId, by.note.slice(0, 500), op.id],
    );
    const cancelled = (await loadOp(conn, op.id))!;
    await also(conn, cancelled);
    return { done: true, op: cancelled };
  });
}

/** How soon the resolver first looks for a deal whose answer was lost. */
export const FIRST_CHECK_MS = 60_000;

/**
 * Sends a 'sending' operation to MT5 once and settles it from the answer.
 * A lost answer leaves it unknown for the resolver. Returns the settled row.
 * An operation in any other state (waiting for approval, cancelled, settled)
 * is returned as it is and never sent.
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
        {
          server: op.server_code, login: op.login, amountCents: signedCents(op), comment: op.reference, checkMargin: rules.checkMargin, notBefore: sentAt(op).toISOString(),
          // Only credit names its type, so a balance deal reads the same as it always has.
          ...(rules.deal === "credit" ? { type: "credit" as const } : {}),
        },
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
