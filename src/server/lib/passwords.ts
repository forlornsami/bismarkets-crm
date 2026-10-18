import { createHash } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";

// Argon2id with OWASP's recommended minimum (19 MiB memory, 2 iterations).
const OPTIONS = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (password: string) => hash(password, OPTIONS);

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}

// A real hash of a random value, verified when the email is unknown so a
// missing account takes as long to refuse as a wrong password.
let dummyHash: Promise<string> | undefined;
export const dummyPasswordHash = () => (dummyHash ??= hashPassword(`dummy-${Math.random()}`));

export function passwordProblem(password: string, email: string): string | null {
  if (password.length < 12) return "Use at least 12 characters.";
  if (password.length > 128) return "Use at most 128 characters.";
  if (password.toLowerCase().includes(email.split("@")[0]!.toLowerCase())) return "Do not include your email name.";
  if (new Set(password).size < 5) return "Use more varied characters.";
  return null;
}

/**
 * Have I Been Pwned range check (k-anonymity: only the first 5 hex characters
 * of the SHA-1 leave the server). Returns false when the service is
 * unreachable, so an outage never blocks staff from setting a password.
 */
export async function isBreachedPassword(password: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const digest = createHash("sha1").update(password).digest("hex").toUpperCase();
  const prefix = digest.slice(0, 5);
  const suffix = digest.slice(5);
  try {
    const response = await fetchImpl(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { "Add-Padding": "true" },
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return false;
    const body = await response.text();
    return body.split("\n").some((line) => {
      const [hashSuffix, count] = line.trim().split(":");
      return hashSuffix === suffix && Number(count) > 0;
    });
  } catch {
    return false;
  }
}
