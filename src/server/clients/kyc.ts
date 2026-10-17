import type { Config } from "../config";
import { encryptBytes, sha256 } from "../lib/crypto";
import type { Conn } from "../lib/db";
import { exec, one, rows } from "../lib/db";
import { fieldError } from "./errors";
import type { ClientRow } from "./model";
import { KYC_TYPES } from "../../shared/kyc-types";

export { KYC_TYPES };

export type KycCategory = keyof typeof KYC_TYPES;
export const categoryForType = (type: number): KycCategory | null => (type === 3 ? "identity" : type === 4 ? "address" : null);
export const subTypeOf = (category: KycCategory, id: number) => KYC_TYPES[category].subTypes.find((s) => s.id === id);

export const KYC_MAX_BYTES = 10 * 1024 * 1024;

/** What a document really is, judged by its first bytes. Only images and PDFs are accepted. */
export function documentType(bytes: Buffer): string | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (bytes.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (bytes.subarray(4, 8).toString("latin1") === "ftyp" && /^(heic|heix|mif1|msf1|heif)$/.test(bytes.subarray(8, 12).toString("latin1"))) return "image/heic";
  return null;
}

export const kycDocumentContext = (submissionId: number, slot: number) => `kyc_document:${submissionId}:${slot}`;

export interface KycUpload {
  category: KycCategory;
  subType: (typeof KYC_TYPES)[KycCategory]["subTypes"][number];
  files: { bytes: Buffer; mime: string; name: string }[];
  form: FormData;
}

/**
 * Reads a multipart KYC upload (type, sub_type, document1, document2) the way
 * the portal and app send it. Files are checked by their bytes.
 */
export async function parseKycUpload(body: unknown, contentType: string | undefined): Promise<KycUpload> {
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
  const files: KycUpload["files"] = [];
  for (let slot = 1; slot <= subType.documents; slot++) {
    const file = form.get(`document${slot}`);
    if (!file || typeof file !== "object") {
      throw fieldError(`document${slot}`, subType.documents === 2 ? "Attach both the front and the back." : "Attach your document.");
    }
    const bytes = Buffer.from(await (file as File).arrayBuffer());
    if (bytes.length === 0 || bytes.length > KYC_MAX_BYTES) throw fieldError(`document${slot}`, "Each file must be an image or PDF no larger than 10 MB.");
    const mime = documentType(bytes);
    if (!mime) throw fieldError(`document${slot}`, "Each file must be an image or PDF no larger than 10 MB.");
    files.push({ bytes, mime, name: ((file as File).name || `document${slot}`).replace(/[^\w.\- ]+/g, "_").slice(0, 160) });
  }
  return { category, subType, files, form };
}

/** Saves a submission and its encrypted files in the caller's transaction. */
export async function storeSubmission(
  conn: Conn,
  config: Config,
  input: { clientId: number; category: KycCategory; subType: number; files: KycUpload["files"]; ip: string; uploadedBy?: number; note?: string | null; status?: "pending" | "approved" },
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
    await exec(conn, "INSERT INTO kyc_documents (submission_id, slot, mime, size_bytes, sha256, file_name, bytes_enc) VALUES (?, ?, ?, ?, ?, ?, ?)", [
      submissionId, slot, f.mime, f.bytes.length, sha256(f.bytes), f.name, encryptBytes(config.dataKey, f.bytes, kycDocumentContext(submissionId, slot)),
    ]);
  }
  return submissionId;
}

/** Profile fields a client must fill in before sending documents. */
export const REQUIRED_PROFILE_FIELDS = ["first_name", "last_name", "phone", "country", "city", "address", "zipcode", "dob"] as const;
export const missingProfileFields = (c: ClientRow) => REQUIRED_PROFILE_FIELDS.filter((f) => !c[f]);

interface SubmissionRow {
  id: number;
  category: KycCategory;
  sub_type: number;
  status: "pending" | "approved" | "rejected";
  reject_reason: string | null;
  submitted_at: Date;
}

export async function latestSubmissions(conn: Conn, clientId: number) {
  const list = await rows<SubmissionRow>(
    conn,
    `SELECT s.id, s.category, s.sub_type, s.status, s.reject_reason, s.submitted_at FROM kyc_submissions s
     JOIN (SELECT category, MAX(id) AS id FROM kyc_submissions WHERE client_id = ? GROUP BY category) l ON l.id = s.id`,
    [clientId],
  );
  return { identity: list.find((s) => s.category === "identity") ?? null, address: list.find((s) => s.category === "address") ?? null };
}

/** The client's overall KYC state, kept on the client row for lists and later money checks. */
export function overallStatus(latest: Awaited<ReturnType<typeof latestSubmissions>>): "none" | "pending" | "approved" | "rejected" {
  const states = [latest.identity?.status, latest.address?.status];
  if (states.every((s) => s === "approved")) return "approved";
  if (states.includes("rejected")) return "rejected";
  if (states.includes("pending")) return "pending";
  return "none";
}

const STATUS_CODE = { pending: 0, approved: 1, rejected: 2 } as const;
const STATUS_LABEL = { pending: "Pending", approved: "Approved", rejected: "Rejected" } as const;

/** GET /api/kyc: the status envelope the portal and app parse. Document links are never exposed. */
export async function kycEnvelope(conn: Conn, client: ClientRow) {
  const latest = await latestSubmissions(conn, client.id);
  const missing = missingProfileFields(client);
  const category = (key: KycCategory) => {
    const s = latest[key];
    const def = KYC_TYPES[key];
    if (!s) {
      return { type: def.type, status: null, status_label: "Not submitted", can_submit: true, sub_type: null, sub_type_label: null, message: null, submitted_at: null, document1_url: null, document2_url: null };
    }
    return {
      type: def.type,
      status: STATUS_CODE[s.status],
      status_label: STATUS_LABEL[s.status],
      can_submit: s.status === "rejected",
      sub_type: s.sub_type,
      sub_type_label: subTypeOf(key, s.sub_type)?.name ?? null,
      message: s.status === "rejected" ? s.reject_reason : null,
      reason: s.status === "rejected" ? s.reject_reason : null,
      submitted_at: s.submitted_at.toISOString(),
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

/** Ready-made rejection reasons. The reviewer can edit them before sending. */
export const KYC_REJECT_REASONS: Record<KycCategory, string[]> = {
  identity: [
    "The photo is blurred. Please upload a sharper photo.",
    "Part of the document is cut off. Please show all four corners.",
    "The document has expired. Please upload a valid one.",
    "The name on the document does not match your profile.",
    "The date of birth does not match your profile.",
    "Please upload both the front and the back of the document.",
  ],
  address: [
    "The document is older than 3 months. Please upload a recent one.",
    "The address does not match your profile.",
    "The name on the document does not match your profile.",
    "The document is not readable. Please upload a clearer copy.",
    "This type of document is not accepted. Please send a bank statement or utility bill.",
  ],
};
