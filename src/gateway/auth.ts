import { MAX_SKEW_MS, NONCE, requestSignature, sameHex } from "./protocol";

// Checks that a request comes from the CRM: an HMAC over the time, a one-time
// nonce, the path and the body (protocol.ts). The signature is checked first
// and in constant time, so a caller without the secret learns nothing and
// cannot fill the nonce memory.

/**
 * Nonces seen in the last minute. A nonce is accepted with a time up to 30 s
 * either side of ours, so it must be remembered for 60 s after we first see
 * it. The memory has a hard bound: when it is full of nonces that are still
 * live, new requests are refused rather than an old nonce forgotten early
 * (which would let it be replayed).
 */
export class NonceCache {
  // Insertion order is expiry order, as every entry lives the same time.
  private seen = new Map<string, number>();

  constructor(
    private max = 100_000,
    private ttlMs = 2 * MAX_SKEW_MS,
  ) {}

  add(nonce: string, now = Date.now()): "ok" | "replay" | "full" {
    for (const [key, expires] of this.seen) {
      if (expires > now) break;
      this.seen.delete(key);
    }
    if (this.seen.has(nonce)) return "replay";
    if (this.seen.size >= this.max) return "full";
    this.seen.set(nonce, now + this.ttlMs);
    return "ok";
  }

  get size() {
    return this.seen.size;
  }
}

export type Verdict = { ok: true } | { ok: false; status: 401 | 503; message: string };

/** Checks headers, signature, clock and nonce, in that order. Records the nonce only for a request that passed the rest. */
export function verifyRequest(input: {
  secret: string;
  timestamp: string | undefined;
  nonce: string | undefined;
  signature: string | undefined;
  path: string;
  body: string;
  nonces: NonceCache;
  now?: number;
}): Verdict {
  const now = input.now ?? Date.now();
  const { timestamp, nonce, signature } = input;
  if (!timestamp || !/^\d{1,16}$/.test(timestamp) || !nonce || !NONCE.test(nonce) || !signature) {
    return { ok: false, status: 401, message: "The request is not signed." };
  }
  if (!sameHex(signature, requestSignature(input.secret, timestamp, nonce, input.path, input.body))) {
    return { ok: false, status: 401, message: "The request's signature is wrong." };
  }
  if (Math.abs(now - Number(timestamp)) > MAX_SKEW_MS) {
    return { ok: false, status: 401, message: "The request's time is too far from the gateway's clock." };
  }
  const seen = input.nonces.add(nonce, now);
  if (seen === "replay") return { ok: false, status: 401, message: "The request was already received (replayed nonce)." };
  if (seen === "full") return { ok: false, status: 503, message: "Too many requests in the last minute." };
  return { ok: true };
}
