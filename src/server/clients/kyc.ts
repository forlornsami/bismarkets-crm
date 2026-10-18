import type { Config } from "../config";
import { decryptField, encryptBytes, encryptField, sha256 } from "../lib/crypto";
import type { Conn } from "../lib/db";
import { exec, one, rows } from "../lib/db";
import { DOCUMENT_RULES, DocumentProblem, prepareDocument, type DocumentMime } from "../lib/documents";
import { HttpError } from "../lib/http";
import { activeClaim } from "../lib/review";
import { fieldError } from "./errors";
import type { ClientRow } from "./model";
import { KYC_TYPES } from "../../shared/kyc-types";

export { KYC_TYPES };

export type KycCategory = keyof typeof KYC_TYPES;
export const categoryForType = (type: number): KycCategory | null => (type === 3 ? "identity" : type === 4 ? "address" : null);
export const subTypeOf = (category: KycCategory, id: number) => KYC_TYPES[category].subTypes.find((s) => s.id === id);
export const otherCategory = (category: KycCategory): KycCategory => (category === "identity" ? "address" : "identity");
/** "proof of identity" or "proof of address", as clients read it. */
export const proofOf = (category: KycCategory) => (category === "identity" ? "proof of identity" : "proof of address");

export const KYC_MAX_BYTES = 10 * 1024 * 1024;

/** What a document really is, judged by its first bytes. Only images and PDFs are accepted. */
export function documentType(bytes: Buffer): DocumentMime | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (bytes.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (bytes.subarray(4, 8).toString("latin1") === "ftyp" && /^(heic|heix|mif1|msf1|heif)$/.test(bytes.subarray(8, 12).toString("latin1"))) return "image/heic";
  return null;
}

export const kycDocumentContext = (submissionId: number, slot: number) => `kyc_document:${submissionId}:${slot}`;

/** A KYC upload as sent: the form is read and each file's type checked, but nothing is processed yet. */
export interface KycUploadForm {
  category: KycCategory;
  subType: (typeof KYC_TYPES)[KycCategory]["subTypes"][number];
  /** Each file as sent, with its hash (used for duplicate checks). */
  sent: { original: Buffer; mime: DocumentMime; name: string; sha256: string }[];
  form: FormData;
}

export interface KycUpload extends KycUploadForm {
  /**
   * `bytes` and `mime` are what is stored; `sha256` is the hash of the file as
   * sent, for duplicate checks, and `sentMime`/`sentBytes` describe that file.
   * `pages` is 1 for a photo, and null for a PDF pdf.js cannot read.
   */
  files: { bytes: Buffer; mime: string; name: string; sha256: string; sentMime: DocumentMime; sentBytes: number; pages: number | null }[];
}

/**
 * Reads a multipart KYC upload (type, sub_type, document1, document2) the way
 * the portal and app send it. Files are checked by their bytes. This is the
 * quick part: run the account checks before prepareKycFiles.
 */
export async function readKycUpload(body: unknown, contentType: string | undefined): Promise<KycUploadForm> {
  if (!Buffer.isBuffer(body) || !contentType) throw fieldError("document1", "Attach your document.");
  let form: FormData;
  try {
    form = await new Response(new Uint8Array(body), { headers: { "content-type": contentType } }).formData();
  } catch {
    throw fieldError("document1", "Attach your document.");
  }
  const category = categoryForType(Number(form.get("type")));
  if (!category) throw fieldError("type", "Choose identity or proof of address.");
  const subType = subTypeOf(category, Number(form.get("sub_type")));
  if (!subType) throw fieldError("sub_type", "Choose a document type.");
  // Check every file before the slow part, so a bad back side fails fast.
  const sent: KycUploadForm["sent"] = [];
  for (let slot = 1; slot <= subType.documents; slot++) {
    const file = form.get(`document${slot}`);
    if (!file || typeof file !== "object") {
      throw fieldError(`document${slot}`, subType.documents === 2 ? "Attach both the front and the back." : "Attach your document.");
    }
    const original = Buffer.from(await (file as File).arrayBuffer());
    const mime = original.length > 0 && original.length <= KYC_MAX_BYTES ? documentType(original) : null;
    if (!mime) throw fieldError(`document${slot}`, DOCUMENT_RULES);
    sent.push({ original, mime, name: ((file as File).name || `document${slot}`).replace(/[^\w.\- ]+/g, "_").slice(0, 160), sha256: sha256(original) });
  }
  return { category, subType, sent, form };
}

/** Re-encodes the photos of an upload (see lib/documents). The slow part: HEIC conversion can take a while. */
export async function prepareKycFiles(upload: KycUploadForm): Promise<KycUpload["files"]> {
  const files: KycUpload["files"] = [];
  for (const [i, f] of upload.sent.entries()) {
    let stored: { bytes: Buffer; mime: string; pages: number | null };
    try {
      stored = await prepareDocument(f.original, f.mime);
    } catch (error) {
      if (error instanceof DocumentProblem) throw fieldError(`document${i + 1}`, error.message);
      throw error;
    }
    const name = stored.mime === f.mime ? f.name : f.name.replace(/\.(heic|heif)$/i, "") + ".jpg";
    files.push({ bytes: stored.bytes, mime: stored.mime, name, sha256: f.sha256, sentMime: f.mime, sentBytes: f.original.length, pages: stored.pages });
  }
  return files;
}

/** readKycUpload and prepareKycFiles in one go. */
export async function parseKycUpload(body: unknown, contentType: string | undefined): Promise<KycUpload> {
  const upload = await readKycUpload(body, contentType);
  return { ...upload, files: await prepareKycFiles(upload) };
}

/**
 * The files of an upload as the audit log records them: what is stored, with
 * its hash, and the file as sent, so stored evidence can be checked against the log.
 */
export const auditedFiles = (files: KycUpload["files"]) =>
  files.map((f) => ({ type: f.mime, bytes: f.bytes.length, sha256: sha256(f.bytes), sent: { type: f.sentMime, bytes: f.sentBytes, sha256: f.sha256 } }));

// ---- Profile details the documents are checked against ----

/** The profile fields each category's documents verify. */
export const VERIFIED_FIELDS = {
  identity: ["first_name", "last_name", "dob"],
  address: ["country", "city", "address", "zipcode"],
} as const satisfies Record<KycCategory, readonly (keyof ClientRow)[]>;

const SNAPSHOT_FIELDS = [...VERIFIED_FIELDS.identity, ...VERIFIED_FIELDS.address] as const;
export type SnapshotField = (typeof SNAPSHOT_FIELDS)[number];
export type ProfileSnapshot = Record<SnapshotField, string | null>;

export const kycProfileContext = (submissionId: number) => `kyc_profile:${submissionId}`;

/** Keeps an encrypted copy of what the documents are checked against, so it can be reconstructed later. */
export async function saveProfileSnapshot(conn: Conn, config: Config, submissionId: number, client: Pick<ClientRow, SnapshotField>) {
  const snapshot = Object.fromEntries(SNAPSHOT_FIELDS.map((f) => [f, client[f] ?? null]));
  await exec(conn, "UPDATE kyc_submissions SET profile_snapshot_enc = ? WHERE id = ?", [
    encryptField(config.dataKey, JSON.stringify(snapshot), kycProfileContext(submissionId)), submissionId,
  ]);
}

export function readProfileSnapshot(config: Config, submissionId: number, sealed: Buffer | null): ProfileSnapshot | null {
  if (!sealed) return null;
  try {
    return JSON.parse(decryptField(config.dataKey, sealed, kycProfileContext(submissionId))) as ProfileSnapshot;
  } catch {
    return null;
  }
}

/** Compares profile values the way a person would: case, extra spaces and Unicode forms do not count. */
export const sameProfileValue = (a: unknown, b: unknown) => normalised(a) === normalised(b);
const normalised = (v: unknown) => (v === null || v === undefined ? "" : String(v)).normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();

/** Saves a submission and its encrypted files in the caller's transaction. */
export async function storeSubmission(
  conn: Conn,
  config: Config,
  input: {
    clientId: number; category: KycCategory; subType: number; files: KycUpload["files"]; ip: string;
    /** The client's profile now, kept with the submission. */
    profile: Pick<ClientRow, SnapshotField>;
    uploadedBy?: number; note?: string | null; status?: "pending" | "approved";
  },
) {
  const staff = input.uploadedBy !== undefined;
  const result = await exec(
    conn,
    `INSERT INTO kyc_submissions (client_id, category, sub_type, source, uploaded_by, staff_note, submitted_ip, status, decided_at, decided_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.clientId, input.category, input.subType, staff ? "staff" : "client", input.uploadedBy ?? null, input.note ?? null, input.ip,
      input.status ?? "pending", input.status === "approved" ? new Date() : null, input.status === "approved" ? input.uploadedBy ?? null : null,
    ],
  );
  const submissionId = result.insertId;
  for (const [i, f] of input.files.entries()) {
    const slot = i + 1;
    await exec(conn, "INSERT INTO kyc_documents (submission_id, slot, mime, size_bytes, sha256, file_name, pages, bytes_enc) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
      submissionId, slot, f.mime, f.bytes.length, f.sha256, f.name, f.pages, encryptBytes(config.dataKey, f.bytes, kycDocumentContext(submissionId, slot)),
    ]);
  }
  await saveProfileSnapshot(conn, config, submissionId, input.profile);
  return submissionId;
}

/** Profile fields a client must fill in before sending documents. The postcode is optional: many countries have none. */
export const REQUIRED_PROFILE_FIELDS = ["first_name", "last_name", "phone", "country", "city", "address", "dob"] as const;
export type RequiredProfileField = (typeof REQUIRED_PROFILE_FIELDS)[number];
export const missingProfileFields = (c: ClientRow) => REQUIRED_PROFILE_FIELDS.filter((f) => !c[f]);

const PROFILE_FIELD_LABEL: Record<RequiredProfileField, string> = {
  first_name: "first name", last_name: "last name", phone: "phone number", country: "country", city: "city", address: "address", dob: "date of birth",
};

/** "date of birth, address and city" */
export function describeMissing(fields: readonly RequiredProfileField[]) {
  const words = fields.map((f) => PROFILE_FIELD_LABEL[f]);
  return words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}` : (words[0] ?? "");
}

export interface SubmissionRow {
  id: number;
  category: KycCategory;
  sub_type: number;
  source: "client" | "staff";
  status: "pending" | "approved" | "rejected";
  reject_reason: string | null;
  submitted_at: Date;
  claimed_by: number | null;
  claimed_until: Date | null;
}

/**
 * Each category's latest submission; ones the client took back are skipped.
 * `lock` makes it a locking read, which sees every committed row instead of the
 * transaction's older snapshot. Pass `lock` only to recompute the status after a
 * write (or to decide on a submission); never before inserting a submission: its
 * gap locks deadlock two clients' uploads. With the client row locked first, a
 * plain read there already sees every earlier KYC change of that client.
 */
export async function latestSubmissions(conn: Conn, clientId: number, lock = false) {
  const list = await rows<SubmissionRow>(
    conn,
    `SELECT id, category, sub_type, source, status, reject_reason, submitted_at, claimed_by, claimed_until FROM kyc_submissions
     WHERE client_id = ? AND status <> 'withdrawn' ORDER BY id DESC${lock ? " FOR SHARE" : ""}`,
    [clientId],
  );
  return { identity: list.find((s) => s.category === "identity") ?? null, address: list.find((s) => s.category === "address") ?? null };
}

export type LatestSubmissions = Awaited<ReturnType<typeof latestSubmissions>>;

/** Locks the client row. Every KYC change takes this lock first, before reading submissions. */
export const lockClient = (conn: Conn, clientId: number) =>
  one<{ id: number; status: ClientRow["status"] }>(conn, "SELECT id, status FROM clients WHERE id = ? FOR UPDATE", [clientId]);

/**
 * Profile fields (snake_case) that are under review or verified, so neither the
 * client nor most staff may change them. Once approved, every field stays as the
 * reviewer saw it, blank ones included. While under review, a blank field was
 * never checked, so it stays open to fill in (staff may upload for a client
 * whose profile is still empty); the reviewer is warned of the change.
 */
export function lockedProfileFields(latest: LatestSubmissions, profile: Pick<ClientRow, SnapshotField>): SnapshotField[] {
  const of = (key: KycCategory): readonly SnapshotField[] => {
    const s = latest[key];
    if (s?.status === "approved") return VERIFIED_FIELDS[key];
    if (s?.status === "pending") return VERIFIED_FIELDS[key].filter((f) => !sameProfileValue(profile[f], ""));
    return [];
  };
  return [...of("identity"), ...of("address")];
}

export type KycOverall = "none" | "partial" | "pending" | "approved" | "rejected";

/** The client's overall KYC state, kept on the client row for lists and later money checks. */
export function overallStatus(latest: LatestSubmissions): KycOverall {
  const states = [latest.identity?.status, latest.address?.status];
  if (states.every((s) => s === "approved")) return "approved";
  if (states.includes("rejected")) return "rejected";
  if (states.includes("pending")) return "pending";
  // One document approved and the other not sent yet.
  if (states.includes("approved")) return "partial";
  return "none";
}

/**
 * The 403 every KYC-gated client route answers (money, accounts and IB, as
 * they are built). The app matches this exact text, so always use this helper.
 */
export const kycRequired = () => new HttpError(403, "KYC_REQUIRED", "You must complete your KYC first.");

const STATUS_CODE = { pending: 0, approved: 1, rejected: 2 } as const;
const STATUS_LABEL = { pending: "Pending", approved: "Approved", rejected: "Rejected" } as const;

/** GET /api/kyc: the status envelope the portal and app parse. Document links are never exposed. */
export async function kycEnvelope(conn: Conn, client: ClientRow) {
  const latest = await latestSubmissions(conn, client.id);
  const ids = [latest.identity?.id, latest.address?.id].filter((v): v is number => v !== undefined);
  const withFiles = new Set(
    ids.length ? (await rows<{ submission_id: number }>(conn, `SELECT DISTINCT submission_id FROM kyc_documents WHERE submission_id IN (${ids.map(() => "?").join(",")})`, ids)).map((r) => r.submission_id) : [],
  );
  const missing = missingProfileFields(client);
  // Frozen accounts may still send documents: a freeze only pauses money.
  const open = client.status !== "closed";
  const category = (key: KycCategory) => {
    const s = latest[key];
    const def = KYC_TYPES[key];
    if (!s) {
      return { type: def.type, status: null, status_label: "Not submitted", can_submit: open, can_withdraw: false, sub_type: null, sub_type_label: null, message: null, submitted_at: null, document1_url: null, document2_url: null };
    }
    return {
      type: def.type,
      status: STATUS_CODE[s.status],
      status_label: STATUS_LABEL[s.status],
      can_submit: open && s.status === "rejected",
      // The client can take back their own upload until a reviewer opens it.
      can_withdraw: open && s.status === "pending" && s.source === "client" && !activeClaim(s),
      sub_type: s.sub_type,
      sub_type_label: subTypeOf(key, s.sub_type)?.name ?? null,
      message: s.status === "rejected" ? s.reject_reason : null,
      reason: s.status === "rejected" ? s.reject_reason : null,
      // Who sent it, and whether there are files: an approval without documents was never "sent" by the client.
      source: s.source,
      has_documents: withFiles.has(s.id),
      submitted_at: withFiles.has(s.id) ? s.submitted_at.toISOString() : null,
      document1_url: null,
      document2_url: null,
    };
  };
  const overall = overallStatus(latest);
  return {
    success: true,
    email_verified: client.email_verified_at !== null,
    profile_complete: missing.length === 0,
    missing_profile_fields: missing,
    locked_profile_fields: lockedProfileFields(latest, client),
    is_kyc_approved: overall === "approved",
    overall_status: overall === "none" ? "not_submitted" : overall,
    identity: category("identity"),
    address: category("address"),
  };
}

export async function kycStatusOf(conn: Conn, clientId: number) {
  return (await one<{ kyc_status: string }>(conn, "SELECT kyc_status FROM clients WHERE id = ?", [clientId]))?.kyc_status ?? "none";
}

/** What a reviewer confirms before approving. All items must be ticked to approve. */
export const KYC_CHECKLIST: Record<KycCategory, { key: string; label: string }[]> = {
  identity: [
    { key: "name", label: "Name matches the profile" },
    { key: "dob", label: "Date of birth matches" },
    { key: "valid", label: "Document is genuine and not expired" },
    { key: "clear", label: "Photo is sharp with all four corners visible" },
  ],
  address: [
    { key: "name", label: "Name matches the profile" },
    { key: "address", label: "Address matches the profile" },
    { key: "recent", label: "Dated within the last 3 months" },
    { key: "clear", label: "Whole page is readable" },
  ],
};

// The back of an ID card shows the address but carries no recent date.
const ID_CARD_BACK = 4;
const ID_CARD_BACK_CHECKLIST = [
  { key: "name", label: "Name matches the profile" },
  { key: "address", label: "Address matches the profile" },
  { key: "valid", label: "Card is valid and not expired" },
  { key: "clear", label: "Photo is sharp with all four corners visible" },
];

/** The checklist for a submission's document type. */
export const checklistFor = (category: KycCategory, subType: number) =>
  category === "address" && subType === ID_CARD_BACK ? ID_CARD_BACK_CHECKLIST : KYC_CHECKLIST[category];

/** For a document the review screen cannot show at all. */
export const KYC_UNREADABLE_REASON = "The file could not be opened. Please upload it again as a clear photo or a PDF.";

/** Ready-made rejection reasons. The reviewer can edit them before sending. */
export const KYC_REJECT_REASONS: Record<KycCategory, string[]> = {
  identity: [
    "The photo is blurred. Please upload a sharper photo.",
    "Part of the document is cut off. Please show all four corners.",
    "The document has expired. Please upload a valid one.",
    "The name on the document does not match your profile.",
    "The date of birth does not match your profile.",
    "Please upload both the front and the back of the document.",
    KYC_UNREADABLE_REASON,
  ],
  address: [
    "The document is older than 3 months. Please upload a recent one.",
    "The address does not match your profile.",
    "The name on the document does not match your profile.",
    "The document is not readable. Please upload a clearer copy.",
    "This type of document is not accepted. Please choose one of the document types listed on your profile page.",
    KYC_UNREADABLE_REASON,
  ],
};
