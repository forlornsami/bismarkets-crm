import { randomInt } from "node:crypto";
import { createHmac } from "node:crypto";

// Crockford base32 without I, L, O and U, so a reference read over the phone is unambiguous.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** "D-7K3M9Q2X" for a deposit, "W-…" for a withdrawal. Never numeric, as both clients expect. */
export function newReference(prefix: "D" | "W"): string {
  let out = `${prefix}-`;
  for (let i = 0; i < 8; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/** Runs an insert with a fresh reference, trying again in the (very unlikely) case it is taken. */
export async function withReference<T>(prefix: "D" | "W", insert: (reference: string) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const reference = newReference(prefix);
    try {
      return await insert(reference);
    } catch (error) {
      const e = error as { code?: string; message?: string };
      if (attempt < 4 && e.code === "ER_DUP_ENTRY" && /reference/.test(e.message ?? "") && !/bank_reference/.test(e.message ?? "")) continue;
      throw error;
    }
  }
}

/** Account numbers and IBANs compared without spaces, dashes or case. */
export const normalizeAccount = (value: string) => value.replace(/[\s\-./]/g, "").toUpperCase();

/**
 * A keyed hash of a payout destination, to find the same account saved by
 * another client without storing it readably. Keyed, so the short account
 * numbers cannot be guessed from a database copy alone.
 */
export const destinationFingerprint = (dataKey: Buffer, paymentMethodId: number, account: string) =>
  createHmac("sha256", dataKey).update(`payout-destination:${paymentMethodId}:${normalizeAccount(account)}`).digest("hex");

/** A bank's transaction reference, compared without spaces or case, per deposit method. */
export const bankReferenceKey = (paymentMethodId: number, reference: string) => `${paymentMethodId}:${normalizeAccount(reference)}`.slice(0, 120);
