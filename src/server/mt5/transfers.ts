import type { Logger } from "pino";
import type { Mt5Account } from "../../gateway/protocol";
import { fieldError } from "../clients/errors";
import { lockClient } from "../clients/kyc";
import { assertClientMayMoveMoney } from "../clients/money";
import { writeAudit, type AuditContext } from "../lib/audit";
import { one, transaction, type Conn, type Db } from "../lib/db";
import { AMOUNT_MESSAGES, formatMinor, parseAmount, toMajor } from "../money/amounts";
import { holdAccount, InsufficientFunds, lockWallet, postLedger, walletAccount } from "../money/ledger";
import { loadMoneySettings } from "../money/settings";
import { clientAccountByLogin, loadAccount, writeSnapshot, type AccountRow } from "./accounts";
import { accountNotFound, callMt5, mt5Unavailable } from "./errors";
import { GatewayError, type Mt5Gateway } from "./gateway";
import { insertBalanceOp, loadOp, type BalanceOpRow, type OpStatus } from "./operations";
import { loadMt5Settings, serverEnabled } from "./settings";

// Transfers between a client's wallet and their live MT5 accounts. A
// transfer is a balance operation (operations.ts): checked and written here
// ('sending') before MT5 is asked, sent once, and settled by its answer, or
// later by the resolver when the answer was lost.
//
// Wallet to MT5 takes the money out of the wallet into `hold` in the same
// transaction that writes the operation, so two transfers can never spend the
// same money; MT5's deal pays it out, a definite no gives it back. MT5 to
// wallet writes nothing to the ledger until MT5 has taken the money out of
// the account.
//
// Lock order: the client row, the wallet (wallet to MT5), the account, then
// the operation. Every refusal is a 422 (or 403/404): the app reads 409 and
// 5xx as "it may have happened" and blocks a retry.

export type TransferPurpose = "wallet_to_mt5" | "mt5_to_wallet";
export const TRANSFER_PURPOSES: readonly TransferPurpose[] = ["wallet_to_mt5", "mt5_to_wallet"];

/** The same request again this soon (a double click, a retry after a lost answer) gets the first one's answer. */
const REPEAT_SECONDS = 30;
/** How long a repeat waits for the first request's answer from MT5. */
const REPEAT_WAIT_MS = 10_000;
/** How long an MT5-to-wallet transfer waits for the account's figures before refusing. */
const FIGURES_BUDGET_MS = 5_000;

const LIVE_ONLY = "Transfers are only available for live accounts.";
const NOT_AVAILABLE = "This account is not available for transfers.";
const RESTORE_FIRST = "Restore this account before adding money to it.";
const BUSY = "Another transfer for this account is still being processed. Please wait a minute.";
const NOT_ENOUGH = "Your wallet balance is not enough for this transfer.";

/** Both clients know these numbers and labels (3 is an IB transfer). */
const TYPES: Record<TransferPurpose, { type: 1 | 2; label: string }> = {
  wallet_to_mt5: { type: 1, label: "Wallet To MT5" },
  mt5_to_wallet: { type: 2, label: "MT5 To Wallet" },
};

const dollars = (cents: number) => `$${formatMinor(cents)}`;

/** Pending until MT5 has answered for certain; a client never sees "unknown". */
export const transferStatus = (status: OpStatus) => (status === "completed" ? "completed" : status === "failed" ? "rejected" : "pending");

/**
 * One row of GET /api/transfers, and the `data` of a transfer's answer.
 * Both front ends show `message` as the rejection reason, so it is there only
 * once rejected, and is never MT5's own words.
 */
export function presentTransfer(op: BalanceOpRow) {
  const t = TYPES[op.purpose as TransferPurpose];
  const status = transferStatus(op.status);
  return {
    id: op.reference,
    type: t.type,
    type_label: t.label,
    mt5_account_id: String(op.login),
    amount: toMajor(op.amount_cents),
    currency: "USD",
    status,
    created_at: op.created_at.toISOString(),
    updated_at: op.updated_at.toISOString(),
    ...(status === "rejected" && op.client_message ? { message: op.client_message } : {}),
  };
}

/** What may leave an MT5 account now: never its credit, and never money its open trades need as margin. */
export const withdrawableCents = (f: Pick<Mt5Account, "balanceCents" | "equityCents" | "creditCents" | "marginCents">) =>
  Math.max(0, Math.min(f.balanceCents, f.equityCents - f.creditCents - f.marginCents));

/** The caller's open account with this login; the live one first, as a demo server could reuse a login. */
async function transferAccount(conn: Conn, clientId: number, login: unknown): Promise<AccountRow> {
  const a = (await clientAccountByLogin(conn, clientId, login, { demo: false })) ?? (await clientAccountByLogin(conn, clientId, login));
  if (!a) throw accountNotFound();
  return a;
}

/** Live, not suspended by staff, and for money going in, not archived. Money may always come back out of an archived account. */
function assertUsable(a: AccountRow, toMt5: boolean) {
  if (a.is_demo === 1) throw fieldError("mt5_account_id", LIVE_ONLY);
  if (a.suspended_at) throw fieldError("mt5_account_id", NOT_AVAILABLE);
  if (toMt5 && a.archived_at) throw fieldError("mt5_account_id", RESTORE_FIRST);
}

/** The same transfer (client, direction, account and amount) asked for in the last 30 seconds, if any. */
async function repeatOf(conn: Conn, clientId: number, purpose: TransferPurpose, accountId: number, cents: number): Promise<number | null> {
  const r = await one<{ id: number }>(
    conn,
    `SELECT id FROM mt5_balance_ops WHERE client_id = ? AND purpose = ? AND mt5_account_id = ? AND amount_cents = ?
       AND created_at > CURRENT_TIMESTAMP(3) - INTERVAL ${REPEAT_SECONDS} SECOND
     ORDER BY id DESC LIMIT 1`,
    [clientId, purpose, accountId, cents],
  );
  return r ? Number(r.id) : null;
}

/**
 * The account's figures from MT5 now (saved as its snapshot), or the
 * "temporarily unavailable" refusal when MT5 does not answer in time.
 */
async function liveFigures(db: Db, mt5: Mt5Gateway, a: AccountRow, log: Pick<Logger, "warn" | "error">): Promise<Mt5Account> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), FIGURES_BUDGET_MS)));
  let res: { accounts: Mt5Account[]; missing: number[] } | null;
  try {
    res = await Promise.race([callMt5(mt5, "accounts.get", { server: a.server_code, logins: [a.login!] }, log), late]);
  } catch (error) {
    if (!(error instanceof GatewayError)) throw error;
    log.warn({ accountId: a.id, kind: error.kind, code: error.code }, "MT5 figures could not be read for a transfer");
    throw mt5Unavailable();
  } finally {
    clearTimeout(timer);
  }
  const figures = res?.accounts.find((f) => f.login === a.login);
  if (!figures) {
    log.warn({ accountId: a.id, timedOut: res === null }, "MT5 figures were not available for a transfer");
    throw mt5Unavailable();
  }
  await writeSnapshot(db, a.id, figures);
  return figures;
}

export interface TransferRequest {
  clientId: number;
  purpose: TransferPurpose;
  /** mt5_account_id as sent: the login, as text or a number. */
  account: unknown;
  /** amount as sent: a number or numeric text, in dollars. */
  amount: unknown;
  ip: string;
  audit: AuditContext;
}

/**
 * Checks a transfer and writes it ('sending'; for wallet to MT5 with the
 * money held), ready for runBalanceOp. Throws the client's refusal when it
 * may not go ahead. The same request again within 30 seconds writes nothing:
 * the first one comes back with `repeat`.
 */
export async function startTransfer(
  deps: { db: Db; mt5: Mt5Gateway | null; log: Pick<Logger, "warn" | "error"> },
  r: TransferRequest,
): Promise<{ opId: number; repeat: boolean }> {
  const { db, mt5, log } = deps;
  const toMt5 = r.purpose === "wallet_to_mt5";
  // Frozen, closed and unverified clients cannot move money (checked again with the client row locked).
  await assertClientMayMoveMoney(db, r.clientId);
  const amount = parseAmount(r.amount);
  if ("problem" in amount) throw fieldError("amount", AMOUNT_MESSAGES[amount.problem]);
  const cents = amount.minor;
  const [money, rules] = await Promise.all([loadMoneySettings(db), loadMt5Settings(db)]);
  if (cents < money.min_transfer_cents) throw fieldError("amount", `The minimum transfer is ${dollars(money.min_transfer_cents)}.`);
  if (cents > rules.maxTransferCents) throw fieldError("amount", `The maximum transfer is ${dollars(rules.maxTransferCents)}.`);
  const found = await transferAccount(db, r.clientId, r.account);
  assertUsable(found, toMt5);
  if (!mt5 || !(await serverEnabled(db, found.server_code))) throw mt5Unavailable();

  // Before MT5 is read: a repeat of a transfer that already took money out would otherwise be refused for want of it.
  const earlier = await repeatOf(db, r.clientId, r.purpose, found.id, cents);
  if (earlier) return { opId: earlier, repeat: true };

  if (!toMt5) {
    // Read before anything is written. MT5's own margin check guards the moment the deal is made.
    const most = withdrawableCents(await liveFigures(db, mt5, found, log));
    if (cents > most) throw fieldError("amount", `You can transfer up to ${dollars(most)} from this account.`);
  }

  return transaction(db, async (conn) => {
    await lockClient(conn, r.clientId);
    await assertClientMayMoveMoney(conn, r.clientId);
    const wallet = toMt5 ? await lockWallet(conn, r.clientId) : null;
    const a = await loadAccount(conn, found.id, true);
    if (!a || a.status !== "active" || a.client_id !== r.clientId || a.login === null) throw accountNotFound();
    assertUsable(a, toMt5);
    // Checked again under the locks: two clicks at once both get here, one after the other.
    const again = await repeatOf(conn, r.clientId, r.purpose, a.id, cents);
    if (again) return { opId: again, repeat: true };
    // Every operation on this account is written under its row lock, so this sees any still open.
    if (await one(conn, "SELECT id FROM mt5_balance_ops WHERE mt5_account_id = ? AND status IN ('sending', 'unknown') LIMIT 1", [a.id])) {
      throw fieldError("mt5_account_id", BUSY);
    }
    // Under the wallet lock, so two transfers at once cannot spend the same money. A 422 here: the
    // ledger's own refusal is a 409, which the app would read as "it may have happened".
    if (wallet && wallet.available_cents < cents) throw fieldError("amount", NOT_ENOUGH);
    const op = await insertBalanceOp(conn, { purpose: r.purpose, clientId: r.clientId, accountId: a.id, serverCode: a.server_code, login: a.login, amountCents: cents, ip: r.ip });
    if (toMt5) {
      try {
        await postLedger(conn, { kind: "transfer_hold", sourceType: "mt5_op", sourceId: op.id, clientId: r.clientId, staffId: null, memo: `Transfer ${op.reference}, MT5 ${a.login}` }, [
          { account: walletAccount(r.clientId), amount: -cents },
          { account: holdAccount(r.clientId), amount: cents },
        ]);
      } catch (error) {
        if (error instanceof InsufficientFunds) throw fieldError("amount", NOT_ENOUGH);
        throw error;
      }
    }
    await writeAudit(conn, r.audit, {
      action: "mt5.transfer.requested", entityType: "client", entityId: r.clientId,
      meta: { opId: op.id, reference: op.reference, purpose: r.purpose, accountId: a.id, login: a.login, amountCents: cents },
    });
    return { opId: op.id, repeat: false };
  });
}

/**
 * The operation an earlier identical request wrote, once its own request has
 * had MT5's answer (or after 10 seconds, still sending).
 */
export async function settledOp(db: Db, opId: number, waitMs = REPEAT_WAIT_MS): Promise<BalanceOpRow> {
  const until = Date.now() + waitMs;
  for (;;) {
    const op = (await loadOp(db, opId))!;
    if (op.status !== "sending" || Date.now() >= until) return op;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
