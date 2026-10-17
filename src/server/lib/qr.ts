import { createRequire } from "node:module";
import sharp from "sharp";
import { NETWORK_ADDRESS } from "../clients/money";
import { inWorker } from "./documents";

type Network = keyof typeof NETWORK_ADDRESS;

// jsQR runs on the calling thread, and a crafted picture (fine stripes, noise) can keep it busy
// for many seconds, so it reads in a short-lived worker that is stopped when it takes too long.
const requireHere = createRequire(import.meta.url);
const QR_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const jsQR = require(workerData.module);
const { bytes, width, height } = workerData;
const found = jsQR(new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.length), width, height);
parentPort.postMessage({ text: found ? found.data : null });`;
const QR_TIMEOUT_MS = 5_000;

/** The text a QR code picture holds, or null when no code can be read in it (in time). */
export async function readQrText(image: Buffer, timeoutMs = QR_TIMEOUT_MS): Promise<string | null> {
  try {
    // Scaled down first: a QR code reads as well at this size, and reading costs time per pixel.
    const { data, info } = await sharp(image, { limitInputPixels: 4096 * 4096 })
      .resize({ width: 1000, height: 1000, fit: "inside", withoutEnlargement: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { text } = await inWorker<{ text?: string | null; error?: string }>(
      QR_WORKER, { module: requireHere.resolve("jsqr"), bytes: data, width: info.width, height: info.height }, timeoutMs, 128,
    );
    return text ?? null;
  } catch {
    return null;
  }
}

// The USDT contract, which a token payment link names besides the payee
// (as in "ethereum:<contract>@56/transfer?address=<payee>").
const TOKEN_CONTRACTS: Record<Network, readonly string[]> = {
  trc20: ["TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"],
  bep20: ["0x55d398326f99059fF775485246999027B3197955"],
  binance_pay: [],
};

/**
 * Whether a QR code's text pays this address and no other: the address appears on its own or
 * inside a payment link such as "tron:T...?amount=1", and nothing else in it is shaped like an
 * address of the network (a link may otherwise pay one address while naming ours in a parameter).
 * BEP20 addresses are compared without case (the mixed case is only a checksum).
 */
export function qrPaysOnly(text: string, address: string, network: Network): boolean {
  const norm = (s: string) => (network === "bep20" ? s.toLowerCase() : s);
  const parts = text.split(/[^0-9A-Za-z]+/).filter(Boolean);
  const allowed = new Set([address, ...TOKEN_CONTRACTS[network]].map(norm));
  return parts.some((p) => norm(p) === norm(address)) && parts.every((p) => !NETWORK_ADDRESS[network].pattern.test(p) || allowed.has(norm(p)));
}
