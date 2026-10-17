import type { Conn } from "./db";
import { exec, one } from "./db";
import { conflict } from "./http";

/**
 * Review queue claims, shared by every approval queue (KYC, deposits and
 * withdrawals). Opening an item claims it for CLAIM_MINUTES so two reviewers
 * never work the same item; the claim is refreshed while it is open and
 * cleared when the item is decided.
 */
export const CLAIM_MINUTES = 15;

/** Each queue's table, and the statuses in which an item still waits for someone. */
const TABLES: Record<string, readonly string[]> = {
  kyc_submissions: ["pending"],
  deposits: ["pending", "second_approval"],
  withdrawals: ["pending", "second_approval", "approved"],
};
export type ReviewTable = "kyc_submissions" | "deposits" | "withdrawals";
const table = (name: string) => {
  if (!Object.hasOwn(TABLES, name)) throw new Error(`Not a review table: ${name}`);
  return name;
};

export interface Claim {
  claimed_by: number | null;
  claimed_until: Date | null;
  claimer_name?: string | null;
}

export const activeClaim = (c: Claim, now = Date.now()) => (c.claimed_by && c.claimed_until && c.claimed_until.getTime() > now ? c.claimed_by : null);

/**
 * Claims an item for staffId. Fails with 409 when someone else holds a live
 * claim, unless takeOver is set. Returns whether a claim held by someone else
 * was taken over.
 */
export async function claim(conn: Conn, tableName: ReviewTable, id: number, staffId: number, takeOver = false): Promise<{ tookOverFrom: number | null }> {
  const t = table(tableName);
  const row = await one<Claim & { status: string }>(conn, `SELECT status, claimed_by, claimed_until FROM ${t} WHERE id = ? FOR UPDATE`, [id]);
  if (!row || !TABLES[t]!.includes(row.status)) return { tookOverFrom: null };
  const holder = activeClaim(row);
  if (holder && holder !== staffId && !takeOver) throw conflict("Someone else is reviewing this item right now.");
  await exec(conn, `UPDATE ${t} SET claimed_by = ?, claimed_until = CURRENT_TIMESTAMP(3) + INTERVAL ? MINUTE WHERE id = ?`, [staffId, CLAIM_MINUTES, id]);
  return { tookOverFrom: holder && holder !== staffId ? holder : null };
}

export async function release(conn: Conn, tableName: ReviewTable, id: number, staffId: number) {
  await exec(conn, `UPDATE ${table(tableName)} SET claimed_by = NULL, claimed_until = NULL WHERE id = ? AND claimed_by = ?`, [id, staffId]);
}

/** Before a decision: the decider must not be overriding someone else's live claim. */
export function assertNotClaimedByOther(c: Claim, staffId: number) {
  const holder = activeClaim(c);
  if (holder && holder !== staffId) throw conflict(`${c.claimer_name ?? "Someone else"} is reviewing this item right now.`);
}
