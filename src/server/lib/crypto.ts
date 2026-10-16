import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** A URL-safe random token with 256 bits of entropy. */
export const randomToken = () => randomBytes(32).toString("base64url");

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const VERSION = 1;

/**
 * AES-256-GCM field encryption. Layout: version(1) | iv(12) | tag(16) | ciphertext.
 * `context` is bound as associated data so a value encrypted for one column or
 * row cannot be swapped into another.
 */
export function encryptField(key: Buffer, plaintext: string, context: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
}

export function decryptField(key: Buffer, sealed: Buffer, context: string): string {
  if (sealed.length < 29 || sealed[0] !== VERSION) throw new Error("Unsupported encrypted field");
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(1, 13));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(sealed.subarray(13, 29));
  return Buffer.concat([decipher.update(sealed.subarray(29)), decipher.final()]).toString("utf8");
}

/** Same layout as encryptField, for binary content such as uploaded documents. */
export function encryptBytes(key: Buffer, plaintext: Buffer, context: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
}

export function decryptBytes(key: Buffer, sealed: Buffer, context: string): Buffer {
  if (sealed.length < 29 || sealed[0] !== VERSION) throw new Error("Unsupported encrypted field");
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(1, 13));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(sealed.subarray(13, 29));
  return Buffer.concat([decipher.update(sealed.subarray(29)), decipher.final()]);
}
