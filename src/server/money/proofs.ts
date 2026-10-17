import sharp, { type Metadata } from "sharp";
import { sha256 } from "../lib/crypto";
import { heicToPng, MAX_DOCUMENT_PIXELS } from "../lib/documents";

// Proofs of payment are screenshots or photos of a bank transfer or a crypto
// payment. They are re-encoded like KYC photos (dropping metadata and anything
// hidden in the file), but small screenshots and GIFs are accepted, since the
// portal offers them. Before re-encoding, the file is searched for the name of
// a photo editor, a hint for the reviewer that the screenshot may have been changed.

export const PROOF_MAX_BYTES = 10 * 1024 * 1024;
export const PROOF_RULES = "Upload a screenshot or photo of your payment: JPG, PNG, WebP, HEIC or GIF, up to 10 MB.";
const MIN_SHORT_SIDE = 120;

export type ProofMime = "image/jpeg" | "image/png" | "image/webp" | "image/heic" | "image/gif";

export class ProofProblem extends Error {}

export function proofType(bytes: Buffer): ProofMime | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (bytes.subarray(4, 8).toString("latin1") === "ftyp" && /^(heic|heix|mif1|msf1|heif)$/.test(bytes.subarray(8, 12).toString("latin1"))) return "image/heic";
  return null;
}

// Editors that write their name into the Software tag, XMP CreatorTool or a PNG text chunk.
const EDITORS: [RegExp, string][] = [
  [/Adobe Photoshop/i, "Adobe Photoshop"],
  [/Photoshop Express/i, "Photoshop Express"],
  [/Lightroom/i, "Adobe Lightroom"],
  [/GIMP/, "GIMP"],
  [/paint\.net/i, "Paint.NET"],
  [/PicsArt/i, "PicsArt"],
  [/Snapseed/i, "Snapseed"],
  [/Canva/, "Canva"],
  [/Pixelmator/i, "Pixelmator"],
  [/Affinity Photo/i, "Affinity Photo"],
  [/Photopea/i, "Photopea"],
  [/PhotoDirector/i, "PhotoDirector"],
  [/Fotor/, "Fotor"],
  [/PhotoScape/i, "PhotoScape"],
  [/Polarr/i, "Polarr"],
  [/Pixlr/i, "Pixlr"],
  [/Inkscape/i, "Inkscape"],
  [/CorelDRAW|Corel PHOTO-PAINT|PaintShop Pro/i, "Corel"],
];

/** The editor named in a file's metadata, or null. Only the metadata area at the start of the file is searched. */
export function editorIn(bytes: Buffer): string | null {
  const head = bytes.subarray(0, Math.min(bytes.length, 512 * 1024)).toString("latin1");
  for (const [pattern, name] of EDITORS) if (pattern.test(head)) return name;
  return null;
}

export interface PreparedProof {
  bytes: Buffer;
  mime: "image/jpeg" | "image/png" | "image/webp";
  /** Of the file as sent, to find the same proof used twice. */
  sha256: string;
  sentMime: ProofMime;
  sentBytes: number;
  editor: string | null;
  width: number;
  height: number;
}

/** Checks and re-encodes a proof. Throws ProofProblem with text for the client. */
export async function prepareProof(original: Buffer): Promise<PreparedProof> {
  const sentMime = original.length > 0 && original.length <= PROOF_MAX_BYTES ? proofType(original) : null;
  if (!sentMime) throw new ProofProblem(PROOF_RULES);
  let meta: Metadata;
  try {
    meta = await sharp(original, { limitInputPixels: false }).metadata();
  } catch {
    throw new ProofProblem(`This image could not be opened. ${PROOF_RULES}`);
  }
  if (!meta.width || !meta.height) throw new ProofProblem(`This image could not be opened. ${PROOF_RULES}`);
  if (meta.width * meta.height > MAX_DOCUMENT_PIXELS) throw new ProofProblem("This image is too large to process. Use a screenshot or a photo under 50 megapixels.");
  if (Math.min(meta.width, meta.height) < MIN_SHORT_SIDE) throw new ProofProblem("This image is too small to read. Upload the full screenshot of the payment.");

  let input = original;
  let mime: PreparedProof["mime"] = sentMime === "image/gif" ? "image/png" : sentMime === "image/heic" ? "image/jpeg" : sentMime;
  if (sentMime === "image/heic" && meta.compression !== "av1") {
    try {
      input = await heicToPng(original);
    } catch {
      throw new ProofProblem(`This image could not be opened. ${PROOF_RULES}`);
    }
  }
  try {
    // A GIF keeps only its first frame. Metadata is not copied unless asked for.
    const image = sharp(input, { limitInputPixels: MAX_DOCUMENT_PIXELS, autoOrient: true, pages: 1 });
    const encoded = mime === "image/png" ? image.png() : mime === "image/webp" ? image.webp({ quality: 90 }) : image.flatten({ background: "#ffffff" }).jpeg({ quality: 90 });
    const { data, info } = await encoded.toBuffer({ resolveWithObject: true });
    if (info.format === "jpeg") mime = "image/jpeg";
    return { bytes: data, mime, sha256: sha256(original), sentMime, sentBytes: original.length, editor: editorIn(original), width: info.width, height: info.height };
  } catch {
    throw new ProofProblem(`This image could not be opened. ${PROOF_RULES}`);
  }
}

export const depositProofContext = (reference: string) => `deposit_proof:${reference}`;
