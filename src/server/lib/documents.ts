import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import sharp, { type Metadata } from "sharp";

// KYC photos are decoded and re-encoded before they are stored: that drops
// EXIF (GPS location, device), applies the camera's rotation, refuses
// decompression bombs and photos too small to read, and turns HEIC into JPEG
// so every reviewer's browser can show it. PDFs are stored as sent, except
// that ones needing a password to open are refused.

export const DOCUMENT_RULES = "Use a JPG, PNG, WebP or HEIC photo, or a PDF, up to 10 MB.";
const UNREADABLE = `This photo could not be opened. ${DOCUMENT_RULES}`;
export const MAX_DOCUMENT_PIXELS = 50_000_000;
export const MIN_SHORT_SIDE = 400;

export type DocumentMime = "image/jpeg" | "image/png" | "image/webp" | "image/heic" | "application/pdf";

/** A problem with the file itself, worded for the client. */
export class DocumentProblem extends Error {}

// Decoded document pixels must not linger in libvips' operation cache.
sharp.cache(false);

/** What to store for an uploaded document: the re-encoded image, or the PDF as sent. */
export async function prepareDocument(bytes: Buffer, mime: DocumentMime): Promise<{ bytes: Buffer; mime: string }> {
  if (mime === "application/pdf") {
    if (await pdfNeedsPassword(bytes)) throw new DocumentProblem("Remove the password from the PDF and upload it again.");
    return { bytes, mime };
  }
  let meta: Metadata;
  try {
    meta = await sharp(bytes).metadata();
  } catch {
    throw new DocumentProblem(UNREADABLE);
  }
  if (!meta.width || !meta.height) throw new DocumentProblem(UNREADABLE);
  if (meta.width * meta.height > MAX_DOCUMENT_PIXELS) throw new DocumentProblem("This photo is too large to process. Use a photo under 50 megapixels or a scan.");
  if (Math.min(meta.width, meta.height) < MIN_SHORT_SIDE) throw new DocumentProblem("This photo is too small to read. Take it closer or use a scan.");

  let input = bytes;
  let out = mime;
  if (mime === "image/heic") {
    // libvips reads AVIF-coded HEIF itself; iPhone HEIC (HEVC) goes through heic-convert.
    if (meta.compression !== "av1") {
      try {
        input = await heicToPng(bytes);
      } catch {
        throw new DocumentProblem(UNREADABLE);
      }
    }
    out = "image/jpeg";
  }
  try {
    const image = sharp(input, { limitInputPixels: MAX_DOCUMENT_PIXELS, autoOrient: true });
    const encoded = out === "image/png" ? image.png() : out === "image/webp" ? image.webp({ quality: 90 }) : image.flatten({ background: "#ffffff" }).jpeg({ quality: 90 });
    // Metadata is not copied unless asked for, so EXIF and XMP are dropped here.
    return { bytes: await encoded.toBuffer(), mime: out };
  } catch {
    throw new DocumentProblem(UNREADABLE);
  }
}

/**
 * True when the PDF cannot be opened without a password. Many bank statements
 * are encrypted with an empty user password (owner restrictions only); those
 * open without a prompt and are accepted.
 */
export async function pdfNeedsPassword(bytes: Buffer): Promise<boolean> {
  if (!bytes.includes("/Encrypt")) return false;
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  try {
    await task.promise;
    return false;
  } catch (error) {
    return (error as { name?: string }).name === "PasswordException";
  } finally {
    await task.destroy();
  }
}

// heic-convert decodes in WebAssembly on the calling thread, which takes
// seconds for a phone photo, so it runs in a short-lived worker and never
// blocks other requests. At most two run at a time.
const requireHere = createRequire(import.meta.url);
const HEIC_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
require(workerData.module)({ buffer: workerData.bytes, format: "PNG" }).then(
  (png) => parentPort.postMessage({ png }),
  (error) => parentPort.postMessage({ error: String((error && error.message) || error) }),
);`;
const HEIC_TIMEOUT_MS = 60_000;
let heicRunning = 0;
const heicWaiting: (() => void)[] = [];

export async function heicToPng(bytes: Buffer): Promise<Buffer> {
  // A finished conversion hands its slot straight to the next one waiting.
  if (heicRunning < 2) heicRunning++;
  else await new Promise<void>((resolve) => heicWaiting.push(resolve));
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const worker = new Worker(HEIC_WORKER, {
        eval: true,
        workerData: { module: requireHere.resolve("heic-convert"), bytes },
        resourceLimits: { maxOldGenerationSizeMb: 512 },
      });
      const timer = setTimeout(() => {
        reject(new Error("HEIC conversion timed out"));
        void worker.terminate();
      }, HEIC_TIMEOUT_MS);
      worker.once("message", (m: { png?: Uint8Array; error?: string }) => {
        clearTimeout(timer);
        if (m.png) resolve(Buffer.from(m.png.buffer, m.png.byteOffset, m.png.byteLength));
        else reject(new Error(m.error ?? "HEIC conversion failed"));
        void worker.terminate();
      });
      worker.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      worker.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("HEIC conversion stopped"));
      });
    });
  } finally {
    const next = heicWaiting.shift();
    if (next) next();
    else heicRunning--;
  }
}
