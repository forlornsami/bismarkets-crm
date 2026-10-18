import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import type { PoolConnection } from "mysql2/promise";
import { lockClient } from "../clients/kyc";
import type { Config } from "../config";
import { decryptField, encryptField } from "../lib/crypto";
import { exec, one, rows, transaction, type Conn, type Db } from "../lib/db";
import { GatewayError } from "./gateway";

// MT5 passwords. The CRM checks them, passes them to the gateway, and keeps
// them sealed (mt5_account_passwords) so the client's own portal and app can
// show them again, as the old CRM did. They are never logged or audited, and
// only the client's own session reads them back: never staff, not even staff
// viewing as the client.

export const MT5_PASSWORD_MESSAGE = "The password must be 8 to 16 characters with upper and lower case letters, a number and a symbol.";

/**
 * 8 to 16 printable ASCII characters without spaces, with a lower case letter,
 * an upper case letter, a digit and a symbol: what MT5 asks of trader
 * passwords, checked here so a client reads our words rather than MT5's.
 */
export function mt5PasswordOk(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[\x21-\x7e]{8,16}$/.test(value) &&
    /[a-z]/.test(value) &&
    /[A-Z]/.test(value) &&
    /[0-9]/.test(value) &&
    /[^A-Za-z0-9]/.test(value)
  );
}

// No look-alike characters (I l 1 O 0), and symbols that are easy to type on a phone.
const LOWER = "abcdefghijkmnopqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "23456789";
const SYMBOLS = "!#$%*+-=?@";
const ALL = LOWER + UPPER + DIGITS + SYMBOLS;

/** A 12-character password that meets the policy, for staff resets. Shown to staff once; kept only for the client. */
export function generateMt5Password(length = 12): string {
  const pick = (set: string) => set[randomInt(set.length)]!;
  const chars = [pick(LOWER), pick(UPPER), pick(DIGITS), pick(SYMBOLS)];
  while (chars.length < length) chars.push(pick(ALL));
  // Fisher-Yates, so the guaranteed characters are not always first.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join("");
}

// ---------- Kept passwords ----------

export type Mt5PasswordType = "main" | "investor";
/** An account's kept passwords; null is "not available" (never kept, forgotten, or it does not open). */
export type Mt5Passwords = Record<Mt5PasswordType, string | null>;
/** The account a password belongs to: its id and its client's, both bound into the seal. */
type Owner = { id: number; client_id: number };
type KeptRow = { sealed: Buffer; set_at: Date; set_by: "client" | "staff" };

/** Bound into every seal, so a value copied to another account, client or type does not open. */
export const mt5PasswordContext = (accountId: number, clientId: number, type: Mt5PasswordType) => `mt5_password|${accountId}|${clientId}|${type}`;

/** The same password, in constant time: hashes are compared, so not even the length shows. Nothing kept is never the same. */
export function samePassword(value: string, kept: string | null): boolean {
  if (kept === null) return false;
  return timingSafeEqual(createHash("sha256").update(value).digest(), createHash("sha256").update(kept).digest());
}

/** Seals one password for its account, in place of any kept before. */
export async function keepMt5Password(conn: Conn, config: Config, a: Owner, type: Mt5PasswordType, password: string, by: "client" | "staff") {
  await exec(
    conn,
    `INSERT INTO mt5_account_passwords (account_id, type, sealed, set_by) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE sealed = VALUES(sealed), set_by = VALUES(set_by), set_at = CURRENT_TIMESTAMP(3)`,
    [a.id, type, encryptField(config.dataKey, password, mt5PasswordContext(a.id, a.client_id, type)), by],
  );
}

/** Forgets both of an account's passwords: MT5 never opened it. */
export async function forgetMt5Passwords(conn: Conn, accountId: number) {
  await exec(conn, "DELETE FROM mt5_account_passwords WHERE account_id = ?", [accountId]);
}

/**
 * The kept passwords of these accounts, opened, by account id. Callers check
 * first that the session is the client's own. A value that does not open
 * (sealed for another row, or under another key) is not available, and logged
 * with nothing secret in it.
 */
export async function openMt5Passwords(conn: Conn, config: Config, accounts: Owner[], log: { warn: (obj: unknown, msg: string) => void }): Promise<Map<number, Mt5Passwords>> {
  const out = new Map<number, Mt5Passwords>(accounts.map((a) => [a.id, { main: null, investor: null }]));
  if (!accounts.length) return out;
  const clientOf = new Map(accounts.map((a) => [a.id, a.client_id]));
  const kept = await rows<{ account_id: number; type: Mt5PasswordType; sealed: Buffer }>(
    conn,
    `SELECT account_id, type, sealed FROM mt5_account_passwords WHERE account_id IN (${accounts.map(() => "?").join(", ")})`,
    accounts.map((a) => a.id),
  );
  for (const k of kept) {
    const id = Number(k.account_id);
    try {
      out.get(id)![k.type] = decryptField(config.dataKey, k.sealed, mt5PasswordContext(id, clientOf.get(id)!, k.type));
    } catch {
      log.warn({ accountId: id, type: k.type }, "A kept MT5 password does not open; it is shown as not available");
    }
  }
  return out;
}

/** Takes one kept password out while a change to it is on its way; returns it as it was, still sealed. */
async function setAside(db: Db, accountId: number, type: Mt5PasswordType): Promise<KeptRow | null> {
  return transaction(db, async (conn) => {
    const kept = await one<KeptRow>(conn, "SELECT sealed, set_at, set_by FROM mt5_account_passwords WHERE account_id = ? AND type = ? FOR UPDATE", [accountId, type]);
    if (kept) await exec(conn, "DELETE FROM mt5_account_passwords WHERE account_id = ? AND type = ?", [accountId, type]);
    return kept ?? null;
  });
}

/**
 * Sets one password in MT5 (`send`, a user.password call) and keeps it once
 * MT5 confirms it. While the change is on its way the kept one is set aside,
 * so neither a lost answer nor the process stopping halfway can leave a
 * password the account may no longer have: MT5 saying no, or never being
 * reached, puts it back; a lost answer (even after its one retry) leaves none,
 * since MT5 may have either. `confirmed` runs in the transaction that keeps
 * the new one, with the client row locked first as everywhere (the caller's
 * audit). Callers hold withAccountLock, so two changes to one account never
 * cross between MT5 and the database.
 */
export async function changeMt5Password(
  db: Db,
  config: Config,
  change: { account: Owner; type: Mt5PasswordType; password: string; by: "client" | "staff" },
  send: () => Promise<unknown>,
  confirmed?: (conn: PoolConnection) => Promise<void>,
) {
  const { account, type } = change;
  const before = await setAside(db, account.id, type);
  try {
    await send();
  } catch (error) {
    // Only a definite no: anything else may have changed it. If it cannot be put back, it shows as not available.
    if (error instanceof GatewayError && error.definite && before) {
      await exec(
        db,
        "INSERT INTO mt5_account_passwords (account_id, type, sealed, set_at, set_by) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE account_id = account_id",
        [account.id, type, before.sealed, before.set_at, before.set_by],
      ).catch(() => undefined);
    }
    throw error;
  }
  await transaction(db, async (conn) => {
    await lockClient(conn, account.client_id);
    await keepMt5Password(conn, config, account, type, change.password, change.by);
    await confirmed?.(conn);
  });
}
