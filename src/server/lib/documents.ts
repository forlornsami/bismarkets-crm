import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import sharp, { type Metadata } from "sharp";

// KYC photos are decoded and re-encoded before they are stored: that drops
// EXIF (GPS location, device), applies the camera's rotation, refuses
// decompression bombs and photos too small to read, and turns HEIC into JPEG
// so every reviewer's browser can show it. PDFs are stored as sent, except
// that ones needing a password to open are refused; their pages are counted so
// approving can require every page to be opened.

export const DOCUMENT_RULES = "Use a JPG, PNG, WebP or HEIC photo, or a PDF, up to 10 MB.";
const UNREADABLE = `This photo could not be opened. ${DOCUMENT_RULES}`;
export const MAX_DOCUMENT_PIXELS = 50_000_000;
export const MIN_SHORT_SIDE = 400;

export type DocumentMime = "image/jpeg" | "image/png" | "image/webp" | "image/heic" | "application/pdf";

/** A problem with the file itself, worded for the client. */
export class DocumentProblem extends Error {}

// Decoded document pixels must not linger in libvips' operation cache.
sharp.cache(false);

/** What to store for an uploaded document: the re-encoded image, or the PDF as sent, with its page count. */
export async function prepareDocument(bytes: Buffer, mime: DocumentMime): Promise<{ bytes: Buffer; mime: string; pages: number | null }> {
  if (mime === "application/pdf") {
    const pdf = await inspectPdf(bytes);
    if (pdf.needsPassword) throw new DocumentProblem("Remove the password from the PDF and upload it again.");
    return { bytes, mime, pages: pdf.pages };
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
    return { bytes: await encoded.toBuffer(), mime: out, pages: 1 };
  } catch {
    throw new DocumentProblem(UNREADABLE);
  }
}

/**
 * Opens a PDF the way the review screen will. `pages` is null when pdf.js
 * cannot read the file in time (the reviewer then downloads it). Many bank
 * statements are encrypted with an empty user password (owner restrictions
 * only); those open without a prompt and are accepted.
 */
export async function inspectPdf(bytes: Buffer, timeoutMs = PDF_TIMEOUT_MS): Promise<{ needsPassword: boolean; pages: number | null }> {
  // pdf.js has no worker of its own in Node and parses on the calling thread,
  // where a crafted PDF could block every request or exhaust the heap. So it
  // runs in a short-lived worker with a time and memory limit; giving up only
  // means the page count is unknown.
  try {
    const m = await inWorker<{ pages?: number; password?: boolean; error?: string }>(PDF_WORKER, { module: requireHere.resolve("pdfjs-dist/legacy/build/pdf.mjs"), bytes }, timeoutMs, 256);
    return { needsPassword: m.password === true, pages: typeof m.pages === "number" ? m.pages : null };
  } catch {
    return { needsPassword: false, pages: null };
  }
}

// heic-convert decodes in WebAssembly on the calling thread, which takes
// seconds for a phone photo, so it runs in a short-lived worker too and never
// blocks other requests. At most two workers run at a time.
const requireHere = createRequire(import.meta.url);
const HEIC_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
require(workerData.module)({ buffer: workerData.bytes, format: "PNG" }).then(
  (png) => parentPort.postMessage({ png }),
  (error) => parentPort.postMessage({ error: String((error && error.message) || error) }),
);`;
const HEIC_TIMEOUT_MS = 60_000;
const PDF_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const { pathToFileURL } = require("node:url");
import(pathToFileURL(workerData.module).href).then(async (pdfjs) => {
  const task = pdfjs.getDocument({ data: workerData.bytes, disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  try {
    parentPort.postMessage({ pages: (await task.promise).numPages });
  } catch (error) {
    parentPort.postMessage({ password: !!error && error.name === "PasswordException" });
  } finally {
    await task.destroy();
  }
}, (error) => parentPort.postMessage({ error: String((error && error.message) || error) }));`;
const PDF_TIMEOUT_MS = 10_000;
let running = 0;
const waiting: (() => void)[] = [];

/** Runs `code` in a fresh worker and resolves with its one message; it is stopped after `timeoutMs`. */
async function inWorker<T extends { error?: string }>(code: string, workerData: { module: string; bytes: Buffer }, timeoutMs: number, maxOldGenerationSizeMb: number): Promise<T> {
  // A finished worker hands its slot straight to the next one waiting.
  if (running < 2) running++;
  else await new Promise<void>((resolve) => waiting.push(resolve));
  try {
    return await new Promise<T>((resolve, reject) => {
      // The bytes are copied into the worker; the caller's buffer is what gets stored.
      const worker = new Worker(code, { eval: true, workerData, resourceLimits: { maxOldGenerationSizeMb } });
      const timer = setTimeout(() => {
        reject(new Error("The worker timed out"));
        void worker.terminate();
      }, timeoutMs);
      worker.once("message", (m: T) => {
        clearTimeout(timer);
        if (m.error) reject(new Error(m.error));
        else resolve(m);
        void worker.terminate();
      });
      worker.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      worker.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("The worker stopped"));
      });
    });
  } finally {
    const next = waiting.shift();
    if (next) next();
    else running--;
  }
}

export async function heicToPng(bytes: Buffer): Promise<Buffer> {
  const { png } = await inWorker<{ png?: Uint8Array; error?: string }>(HEIC_WORKER, { module: requireHere.resolve("heic-convert"), bytes }, HEIC_TIMEOUT_MS, 512);
  if (!png) throw new Error("HEIC conversion failed");
  return Buffer.from(png.buffer, png.byteOffset, png.byteLength);
}
