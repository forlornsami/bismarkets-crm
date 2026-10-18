import { randomBytes } from "node:crypto";
import { exec, one, rows, type Conn } from "../lib/db";
import { conflict, HttpError } from "../lib/http";

// Double-entry ledger. Every movement of client money is one transaction whose
// entries sum to zero. Client accounts are liabilities (what the broker owes
// the client): `wallet` is what the client can use, `hold` is money set aside
// for a withdrawal that has not been paid yet. The broker's side is the method
// the money came in or went out through. Entries are never changed; a mistake
// is corrected by a new transaction. The `wallets` row caches the two client
// balances and is updated in the same transaction (`cli verify-ledger` checks
// the cache against the entries).
//
// Lock order for anything that moves money: the client row (lockClient), then
// the wallet (lockWallet), then the deposit or withdrawal row.

export type LedgerKind = "deposit" | "withdrawal_hold" | "withdrawal_release" | "withdrawal_paid";
export type LedgerSource = "deposit" | "withdrawal";

export const walletAccount = (clientId: number) => `client:${clientId}:wallet`;
export const holdAccount = (clientId: number) => `client:${clientId}:hold`;
/** The broker's account a deposit method pays into. */
export const depositMethodAccount = (paymentMethodId: number) => `deposit_method:${paymentMethodId}`;
/** Where paid withdrawals of one payout type went out. */
export const payoutAccount = (paymentMethodId: number) => `payout:${paymentMethodId}`;

const CLIENT_ACCOUNT = /^client:(\d+):(wallet|hold)$/;

export interface WalletRow {
  id: number;
  client_id: number;
  wallet_key: string;
  currency: "USD";
  available_cents: number;
  held_cents: number;
  created_at: Date;
}

const SELECT_WALLET = "SELECT id, client_id, wallet_key, currency, available_cents, held_cents, created_at FROM wallets";
const fromDb = (w: WalletRow): WalletRow => ({ ...w, available_cents: Number(w.available_cents), held_cents: Number(w.held_cents) });

export class InsufficientFunds extends HttpError {
  constructor() {
    super(409, "INSUFFICIENT_FUNDS", "The wallet does not have enough money for this.");
  }
}

/** The client's USD wallet, created on first use. Not locked: for reads. */
export async function walletOf(conn: Conn, clientId: number): Promise<WalletRow> {
  const found = await one<WalletRow>(conn, `${SELECT_WALLET} WHERE client_id = ? AND currency = 'USD'`, [clientId]);
  if (found) return fromDb(found);
  // INSERT IGNORE: two first requests at once both end up with the one wallet.
  await exec(conn, "INSERT IGNORE INTO wallets (client_id, wallet_key) VALUES (?, ?)", [clientId, newWalletKey()]);
  return fromDb((await one<WalletRow>(conn, `${SELECT_WALLET} WHERE client_id = ? AND currency = 'USD'`, [clientId]))!);
}

/** The client's wallet, locked for this transaction. Lock the client row first. */
export async function lockWallet(conn: Conn, clientId: number): Promise<WalletRow> {
  await exec(conn, "INSERT IGNORE INTO wallets (client_id, wallet_key) VALUES (?, ?)", [clientId, newWalletKey()]);
  return fromDb((await one<WalletRow>(conn, `${SELECT_WALLET} WHERE client_id = ? AND currency = 'USD' FOR UPDATE`, [clientId]))!);
}

/** A wallet's public key: what the portal and app send back as wallet_key. */
const newWalletKey = () => `w${randomBytes(10).toString("hex")}`;

export interface LedgerEntryInput {
  account: string;
  /** US cents; positive adds to the account, negative takes from it. */
  amount: number;
}

/**
 * Records one balanced transaction and updates the wallet cache. The same
 * (source, kind) can be recorded once only: a second attempt is a 409, so a
 * deposit is never credited twice. A wallet or hold that would go below zero
 * is refused (InsufficientFunds) and the caller's transaction rolls back.
 */
export async function postLedger(
  conn: Conn,
  tx: { kind: LedgerKind; sourceType: LedgerSource; sourceId: number; clientId: number; staffId: number | null; memo: string },
  entries: LedgerEntryInput[],
): Promise<number> {
  if (entries.length < 2) throw new Error("A ledger transaction needs at least two entries");
  for (const e of entries) {
    if (!Number.isSafeInteger(e.amount) || e.amount === 0) throw new Error(`Bad ledger amount ${e.amount} for ${e.account}`);
  }
  if (entries.reduce((sum, e) => sum + e.amount, 0) !== 0) throw new Error("Ledger entries must sum to zero");

  let transactionId: number;
  try {
    const r = await exec(conn, "INSERT INTO ledger_transactions (kind, source_type, source_id, client_id, staff_id, memo) VALUES (?, ?, ?, ?, ?, ?)", [
      tx.kind, tx.sourceType, tx.sourceId, tx.clientId, tx.staffId, tx.memo.slice(0, 160),
    ]);
    transactionId = r.insertId;
  } catch (error) {
    if ((error as { code?: string }).code === "ER_DUP_ENTRY") throw conflict("This has already been recorded.");
    throw error;
  }
  for (const e of entries) {
    const owner = CLIENT_ACCOUNT.exec(e.account);
    const clientId = owner ? Number(owner[1]) : null;
    await exec(conn, "INSERT INTO ledger_entries (transaction_id, account, client_id, currency, amount_cents) VALUES (?, ?, ?, 'USD', ?)", [transactionId, e.account, clientId, e.amount]);
    if (!owner) continue;
    const column = owner[2] === "wallet" ? "available_cents" : "held_cents";
    const updated = await exec(conn, `UPDATE wallets SET ${column} = ${column} + ? WHERE client_id = ? AND currency = 'USD' AND ${column} + ? >= 0`, [e.amount, clientId, e.amount]);
    if (updated.affectedRows !== 1) throw new InsufficientFunds();
  }
  return transactionId;
}

/** The ledger's consistency checks, for `cli verify-ledger` and tests. Returns a list of problems (empty when all is well). */
export async function verifyLedger(conn: Conn): Promise<string[]> {
  const problems: string[] = [];
  const unbalanced = await rows<{ id: number; total: string }>(
    conn,
    "SELECT t.id, SUM(e.amount_cents) AS total FROM ledger_transactions t LEFT JOIN ledger_entries e ON e.transaction_id = t.id GROUP BY t.id HAVING COUNT(e.id) < 2 OR SUM(e.amount_cents) <> 0",
  );
  for (const u of unbalanced) problems.push(`Ledger transaction ${u.id} does not balance (sum ${u.total ?? "no entries"}).`);

  const wallets = await rows<{ client_id: number; available_cents: number; held_cents: number; wallet_sum: string | null; hold_sum: string | null }>(
    conn,
    `SELECT w.client_id, w.available_cents, w.held_cents,
       (SELECT SUM(amount_cents) FROM ledger_entries WHERE account = CONCAT('client:', w.client_id, ':wallet')) AS wallet_sum,
       (SELECT SUM(amount_cents) FROM ledger_entries WHERE account = CONCAT('client:', w.client_id, ':hold')) AS hold_sum
     FROM wallets w`,
  );
  for (const w of wallets) {
    if (Number(w.available_cents) !== Number(w.wallet_sum ?? 0)) problems.push(`Client ${w.client_id}: wallet shows ${w.available_cents} cents but the ledger adds up to ${w.wallet_sum ?? 0}.`);
    if (Number(w.held_cents) !== Number(w.hold_sum ?? 0)) problems.push(`Client ${w.client_id}: held shows ${w.held_cents} cents but the ledger adds up to ${w.hold_sum ?? 0}.`);
  }

  // Each approved deposit is credited exactly once, for the amount on the deposit.
  const deposits = await rows<{ id: number; reference: string; status: string; credited_cents: number | null; credits: number; credited: string | null }>(
    conn,
    `SELECT d.id, d.reference, d.status, d.credited_cents,
       (SELECT COUNT(*) FROM ledger_transactions t WHERE t.source_type = 'deposit' AND t.source_id = d.id AND t.kind = 'deposit') AS credits,
       (SELECT SUM(e.amount_cents) FROM ledger_transactions t JOIN ledger_entries e ON e.transaction_id = t.id
          WHERE t.source_type = 'deposit' AND t.source_id = d.id AND e.account = CONCAT('client:', d.client_id, ':wallet')) AS credited
     FROM deposits d`,
  );
  for (const d of deposits) {
    const credits = Number(d.credits);
    if (d.status === "approved" && (credits !== 1 || Number(d.credited ?? 0) !== Number(d.credited_cents))) {
      problems.push(`Deposit ${d.reference} is approved but its wallet credit is ${d.credited ?? 0} cents in ${credits} transaction(s), not ${d.credited_cents}.`);
    }
    if (d.status !== "approved" && credits !== 0) problems.push(`Deposit ${d.reference} is ${d.status} but was credited to the wallet.`);
  }

  // A withdrawal's money is held from request until it is paid out (paid) or given back (rejected).
  const withdrawals = await rows<{ id: number; reference: string; status: string; amount_cents: number; held: string | null; holds: number; paid: number; released: number }>(
    conn,
    `SELECT w.id, w.reference, w.status, w.amount_cents,
       (SELECT SUM(e.amount_cents) FROM ledger_transactions t JOIN ledger_entries e ON e.transaction_id = t.id
          WHERE t.source_type = 'withdrawal' AND t.source_id = w.id AND e.account = CONCAT('client:', w.client_id, ':hold')) AS held,
       (SELECT COUNT(*) FROM ledger_transactions t WHERE t.source_type = 'withdrawal' AND t.source_id = w.id AND t.kind = 'withdrawal_hold') AS holds,
       (SELECT COUNT(*) FROM ledger_transactions t WHERE t.source_type = 'withdrawal' AND t.source_id = w.id AND t.kind = 'withdrawal_paid') AS paid,
       (SELECT COUNT(*) FROM ledger_transactions t WHERE t.source_type = 'withdrawal' AND t.source_id = w.id AND t.kind = 'withdrawal_release') AS released
     FROM withdrawals w`,
  );
  for (const w of withdrawals) {
    const open = ["pending", "second_approval", "approved"].includes(w.status);
    const expected = open ? Number(w.amount_cents) : 0;
    if (Number(w.held ?? 0) !== expected) problems.push(`Withdrawal ${w.reference} is ${w.status}, so ${expected} cents should be held, but ${w.held ?? 0} are.`);
    const outcome = { paid: Number(w.paid), released: Number(w.released) };
    const wanted = w.status === "paid" ? { paid: 1, released: 0 } : w.status === "rejected" ? { paid: 0, released: 1 } : { paid: 0, released: 0 };
    if (Number(w.holds) !== 1) problems.push(`Withdrawal ${w.reference} has ${w.holds} hold transaction(s), not 1.`);
    if (outcome.paid !== wanted.paid || outcome.released !== wanted.released) {
      problems.push(`Withdrawal ${w.reference} is ${w.status}, but the ledger has ${outcome.paid} payout(s) and ${outcome.released} return(s) to the wallet.`);
    }
  }

  problems.push(...(await verifyTransactions(conn)));
  return problems;
}

/**
 * Every transaction moves exactly what its deposit or withdrawal says, between the accounts its
 * kind names, for that deposit's or withdrawal's own client. Read in pages, oldest first.
 */
async function verifyTransactions(conn: Conn): Promise<string[]> {
  const problems: string[] = [];
  const inList = (ids: number[]) => ids.map(() => "?").join(", ");
  let after = 0;
  for (;;) {
    const batch = await rows<{ id: number; kind: string; source_type: string; source_id: number; client_id: number | null }>(
      conn,
      "SELECT id, kind, source_type, source_id, client_id FROM ledger_transactions WHERE id > ? ORDER BY id LIMIT 2000",
      [after],
    );
    if (!batch.length) return problems;
    after = Number(batch.at(-1)!.id);
    const ids = batch.map((t) => Number(t.id));
    const entries = await rows<{ id: number; transaction_id: number; account: string; client_id: number | null; currency: string; amount_cents: number }>(
      conn,
      `SELECT id, transaction_id, account, client_id, currency, amount_cents FROM ledger_entries WHERE transaction_id IN (${inList(ids)})`,
      ids,
    );
    // The client's wallet page lists entries by their client_id, so it must name the account's owner.
    for (const e of entries) {
      const owner = CLIENT_ACCOUNT.exec(e.account);
      const ownerId = owner ? Number(owner[1]) : null;
      if ((e.client_id === null ? null : Number(e.client_id)) !== ownerId) {
        problems.push(`Ledger entry ${e.id} on ${e.account} is marked for client ${e.client_id ?? "none"}, not ${ownerId ?? "none"}.`);
      }
      if (e.currency !== "USD") problems.push(`Ledger entry ${e.id} on ${e.account} is in ${e.currency}; the ledger is in USD.`);
    }
    const sourcesOf = async <T extends { id: number }>(type: LedgerSource, sql: string) => {
      const wanted = [...new Set(batch.filter((t) => t.source_type === type).map((t) => Number(t.source_id)))];
      const found = wanted.length ? await rows<T>(conn, `${sql} WHERE id IN (${inList(wanted)})`, wanted) : [];
      return new Map(found.map((r) => [Number(r.id), r]));
    };
    const deposits = await sourcesOf<{ id: number; reference: string; client_id: number; payment_method_id: number; credited_cents: number | null }>(
      "deposit",
      "SELECT id, reference, client_id, payment_method_id, credited_cents FROM deposits",
    );
    const withdrawals = await sourcesOf<{ id: number; reference: string; client_id: number; payment_method_id: number; amount_cents: number }>(
      "withdrawal",
      "SELECT id, reference, client_id, payment_method_id, amount_cents FROM withdrawals",
    );

    for (const t of batch) {
      const label = `Ledger transaction ${t.id} (${t.kind})`;
      const source = t.source_type === "deposit" ? deposits.get(Number(t.source_id)) : t.source_type === "withdrawal" ? withdrawals.get(Number(t.source_id)) : undefined;
      if (!source) {
        problems.push(`${label} belongs to ${t.source_type} ${t.source_id}, which does not exist.`);
        continue;
      }
      const clientId = Number(source.client_id);
      if (Number(t.client_id) !== clientId) problems.push(`${label} is for client ${t.client_id}, but ${source.reference} belongs to client ${clientId}.`);
      let want: [string, number][] | null = null;
      if (t.source_type === "deposit" && t.kind === "deposit" && "credited_cents" in source) {
        const x = Number(source.credited_cents ?? 0);
        want = [[walletAccount(clientId), x], [depositMethodAccount(Number(source.payment_method_id)), -x]];
      } else if (t.source_type === "withdrawal" && "amount_cents" in source) {
        const a = Number(source.amount_cents);
        if (t.kind === "withdrawal_hold") want = [[walletAccount(clientId), -a], [holdAccount(clientId), a]];
        if (t.kind === "withdrawal_paid") want = [[holdAccount(clientId), -a], [payoutAccount(Number(source.payment_method_id)), a]];
        if (t.kind === "withdrawal_release") want = [[holdAccount(clientId), -a], [walletAccount(clientId), a]];
      }
      if (!want) {
        problems.push(`${label} is not a kind of transaction a ${t.source_type} makes.`);
        continue;
      }
      const show = (list: [string, number][]) => list.map(([account, amount]) => `${account} ${amount}`).sort().join(", ");
      const got = entries.filter((e) => Number(e.transaction_id) === Number(t.id)).map((e): [string, number] => [e.account, Number(e.amount_cents)]);
      if (show(got) !== show(want)) problems.push(`${label} for ${source.reference} moves ${show(got) || "nothing"}, not ${show(want)}.`);
    }
  }
}
