// MT5 sends money as decimal text ("1250.5", "-0.01", sometimes with more
// digits than cents, or an exponent). The gateway turns it into integer cents
// without any float in between, and sends cents back to MT5 as exact text.

const DECIMAL = /^([+-]?)(\d{1,30})(?:\.(\d{0,30}))?(?:[eE]([+-]?\d{1,2}))?$/;

/**
 * Decimal text → integer cents. More than two decimals round half away from
 * zero ("1.005" → 101, "-1.005" → -101). Throws on anything that is not a
 * plain decimal number or does not fit in a safe integer.
 */
export function centsFromDecimal(text: string): number {
  const match = typeof text === "string" && text.length <= 64 ? DECIMAL.exec(text) : null;
  if (!match) throw new Error("not a decimal amount");
  const [, sign, whole, fraction = "", exponent = "0"] = match;
  // value = digits × 10^-scale, so cents = digits × 10^(2 - scale).
  const digits = BigInt(whole! + fraction);
  const shift = 2 - (fraction.length - Number(exponent));
  let cents: bigint;
  if (shift >= 0) {
    cents = digits * 10n ** BigInt(shift);
  } else {
    const divisor = 10n ** BigInt(-shift);
    cents = digits / divisor;
    if ((digits % divisor) * 2n >= divisor) cents += 1n;
  }
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("amount out of range");
  return sign === "-" && cents !== 0n ? -Number(cents) : Number(cents);
}

/** Integer cents → MT5 decimal text: 12345 → "123.45", -5 → "-0.05". */
export function decimalFromCents(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new Error("cents must be a safe integer");
  const abs = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
