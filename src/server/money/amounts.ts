// Money amounts are integer minor units (cents, paisa) everywhere in the CRM.
// They are parsed from the decimal text the portal and app send without ever
// passing through a float, and shown back as numbers with two decimals.

/** The largest single amount anyone may enter: 10,000,000.00 in the method's currency. */
export const MAX_AMOUNT_MINOR = 1_000_000_000;

export type AmountProblem = "missing" | "invalid" | "decimals" | "zero" | "too_large";

/**
 * Parses "1250", "1250.5" or 1250.5 into minor units (125050), allowing at most
 * two decimals. Thousands separators, signs, exponents and spaces inside the
 * number are refused.
 */
export function parseAmount(value: unknown): { minor: number } | { problem: AmountProblem } {
  if (value === undefined || value === null || value === "") return { problem: "missing" };
  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { problem: "invalid" };
    // A JSON number such as 1e-7 or 12.345 is turned into text the way JavaScript would print it.
    text = String(value);
  } else if (typeof value === "string") {
    text = value.trim();
  } else {
    return { problem: "invalid" };
  }
  const match = /^(\d{1,12})(?:\.(\d+))?$/.exec(text);
  if (!match) return { problem: "invalid" };
  const fraction = match[2] ?? "";
  // "12.50" and "12.500" are fine; only digits that carry a value are counted.
  if (fraction.replace(/0+$/, "").length > 2) return { problem: "decimals" };
  const minor = Number(match[1]) * 100 + Number((fraction + "00").slice(0, 2));
  if (minor === 0) return { problem: "zero" };
  if (minor > MAX_AMOUNT_MINOR) return { problem: "too_large" };
  return { minor };
}

/** What each problem says to the client, next to the amount field. */
export const AMOUNT_MESSAGES: Record<AmountProblem, string> = {
  missing: "The amount field is required.",
  invalid: "Enter the amount as a number, such as 100 or 100.50.",
  decimals: "Use at most two decimal places.",
  zero: "The amount must be more than zero.",
  too_large: "This amount is above the most we accept in one request.",
};

/** 125050 → 1250.5, for JSON. */
export const toMajor = (minor: number) => Math.round(minor) / 100;

/** 125050 → "1,250.50", for emails, notifications and the admin panel. */
export const formatMinor = (minor: number) =>
  (minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 125050, "USD" → "USD 1,250.50". */
export const money = (minor: number, currency: string) => `${currency} ${formatMinor(minor)}`;

const RATE_SCALE = 1_000_000n;

/** A DECIMAL(18,6) rate as MySQL returns it ("280.000000") → integer millionths. */
export function rateMicros(rate: string | number): bigint {
  const text = typeof rate === "number" ? rate.toFixed(6) : rate.trim();
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text);
  if (!match) throw new Error(`Bad rate: ${rate}`);
  return BigInt(match[1]!) * RATE_SCALE + BigInt((match[2] ?? "").padEnd(6, "0"));
}

/**
 * Converts an amount in a method's currency to US cents. PKR is divided by the
 * rupees-per-dollar rate and rounded down, so a client is never credited a
 * fraction of a cent more than they sent.
 */
export function toUsdCents(minor: number, currency: "USD" | "PKR", usdToPkr: string | number): number {
  if (currency === "USD") return minor;
  return Number((BigInt(minor) * RATE_SCALE) / rateMicros(usdToPkr));
}

/** US cents to the method's currency (for minimums shown on PKR methods), rounded up. */
export function fromUsdCents(cents: number, currency: "USD" | "PKR", usdToPkr: string | number): number {
  if (currency === "USD") return cents;
  const scaled = BigInt(cents) * rateMicros(usdToPkr);
  return Number((scaled + RATE_SCALE - 1n) / RATE_SCALE);
}
