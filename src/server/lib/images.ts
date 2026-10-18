// Identifies uploaded images by their bytes, never by the name or the
// Content-Type the browser sent. Only raster formats are accepted: SVG can
// carry scripts, so it is refused outright.

export type ImageType = "image/png" | "image/jpeg" | "image/webp";

export interface ImageInfo {
  type: ImageType;
  width: number;
  height: number;
}

function pngInfo(b: Buffer): ImageInfo | null {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (b.length < 24 || !b.subarray(0, 8).equals(signature) || b.toString("latin1", 12, 16) !== "IHDR") return null;
  return { type: "image/png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function jpegInfo(b: Buffer): ImageInfo | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const length = b.readUInt16BE(i + 2);
    // Start-of-frame markers carry the dimensions (excluding DHT, JPG and DAC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { type: "image/jpeg", height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + length;
  }
  return null;
}

function webpInfo(b: Buffer): ImageInfo | null {
  if (b.length < 30 || b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WEBP") return null;
  const chunk = b.toString("latin1", 12, 16);
  if (chunk === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
    return { type: "image/webp", width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L" && b[20] === 0x2f) {
    const bits = b.readUInt32LE(21);
    return { type: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    return { type: "image/webp", width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  }
  return null;
}

export function imageInfo(bytes: Buffer): ImageInfo | null {
  const info = pngInfo(bytes) ?? jpegInfo(bytes) ?? webpInfo(bytes);
  if (!info || info.width < 1 || info.height < 1) return null;
  return info;
}
