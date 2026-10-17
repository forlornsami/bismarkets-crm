import jsQR from "jsqr";
import sharp from "sharp";

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

/**
 * Whether a QR code's text names this address, on its own or inside a payment link such as
 * "tron:T...?amount=1". BEP20 addresses are compared without case (the mixed case is only a checksum).
 */
export function qrNamesAddress(text: string, address: string, ignoreCase: boolean): boolean {
  const norm = (s: string) => (ignoreCase ? s.toLowerCase() : s);
  return text.split(/[^0-9A-Za-z]+/).some((part) => norm(part) === norm(address));
}
