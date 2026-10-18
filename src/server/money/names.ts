// Compares the name on a payment or a payout account with the client's
// verified name. It only raises a warning for the reviewer: names are written
// many ways, so it never decides anything by itself.

const TITLES = new Set(["mr", "mrs", "ms", "miss", "dr", "sir", "madam", "mst", "mt"]);
// Common spellings of the same name, mapped to one form.
const SAME = new Map<string, string>([
  ["mohammad", "muhammad"], ["mohammed", "muhammad"], ["muhammed", "muhammad"], ["mohamed", "muhammad"], ["mohd", "muhammad"], ["md", "muhammad"], ["muhamad", "muhammad"],
  ["ahmad", "ahmed"], ["syed", "sayed"], ["sayyed", "sayed"], ["saiyed", "sayed"],
]);

export function nameTokens(name: string): string[] {
  return name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}]+/gu, " ")
    .split(" ")
    .filter((t) => t.length > 0 && !TITLES.has(t))
    .map((t) => SAME.get(t) ?? t);
}

export type NameMatch = "same" | "similar" | "different";

/**
 * "same": the same words in any order ("Khan Ali" and "Ali Khan").
 * "similar": one name contains the other, or they share two or more words
 * ("Ali Raza Khan" and "Ali Khan").
 * "different": anything else, including a payment from someone else.
 */
export function compareNames(a: string, b: string): NameMatch {
  const left = nameTokens(a);
  const right = nameTokens(b);
  if (!left.length || !right.length) return "different";
  const sorted = (t: string[]) => [...t].sort().join(" ");
  if (sorted(left) === sorted(right) || left.join("") === right.join("")) return "same";
  const shared = left.filter((t) => right.includes(t)).length;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  if (shorter.every((t) => longer.includes(t)) && shorter.length >= 1 && shared >= Math.min(2, shorter.length)) return "similar";
  if (shared >= 2) return "similar";
  return "different";
}
