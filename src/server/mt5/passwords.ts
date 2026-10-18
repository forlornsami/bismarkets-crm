import { randomInt } from "node:crypto";

// MT5 passwords. The CRM checks them and passes them to the gateway once; it
// never stores, logs or audits them.

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

/** A 12-character password that meets the policy, for staff resets. Shown once, never kept. */
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
