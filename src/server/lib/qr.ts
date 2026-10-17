import jsQR from "jsqr";
import sharp from "sharp";
import { NETWORK_ADDRESS } from "../clients/money";

type Network = keyof typeof NETWORK_ADDRESS;

/** The text a QR code picture holds, or null when no code can be read in it. */
export async function readQrText(image: Buffer): Promise<string | null> {
  try {
    // Scaled down first: a QR code reads as well at this size, and reading costs time per pixel.
    const { data, info } = await sharp(image, { limitInputPixels: 4096 * 4096 })
      .resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), info.width, info.height)?.data ?? null;
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
