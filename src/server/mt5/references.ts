import { randomInt } from "node:crypto";
import { MT5_REFERENCE } from "../../gateway/protocol";

// The comment the CRM puts on every MT5 user it creates and every balance
// deal it sends. It is how a lost answer is settled later: the resolver
// searches MT5 for it instead of sending anything again.

// Crockford base32 without I, L, O and U, as in money/references.ts.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A account, T transfer, D demo funding or top-up, S staff balance or credit change. */
export type Mt5ReferenceKind = "A" | "T" | "D" | "S";

/** "BIS-A7K3M9Q2X": 13 characters, well under MT5's comment limit, and matched by the gateway's MT5_REFERENCE. */
export function mt5Reference(kind: Mt5ReferenceKind): string {
  let out = `BIS-${kind}`;
  for (let i = 0; i < 8; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  if (!MT5_REFERENCE.test(out)) throw new Error("MT5 reference does not match the gateway's format");
  return out;
}

/** Runs an insert with a fresh reference, trying again in the (very unlikely) case it is taken. */
export async function withMt5Reference<T>(kind: Mt5ReferenceKind, insert: (reference: string) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const reference = mt5Reference(kind);
    try {
      return await insert(reference);
    } catch (error) {
      const e = error as { code?: string; message?: string };
      // Only the reference's own unique key: any other duplicate is a real conflict.
      if (attempt < 4 && e.code === "ER_DUP_ENTRY" && /uq_mt5_op_reference|uq_mt5_account_create_ref/.test(e.message ?? "")) continue;
      throw error;
    }
  }
}
