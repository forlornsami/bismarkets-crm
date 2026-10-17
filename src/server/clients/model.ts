import { createHmac, randomInt } from "node:crypto";
import { z } from "zod";
import type { Config } from "../config";
import { exec, one, type Conn } from "../lib/db";
import { pictureVersion } from "../lib/pictures";

export interface ClientRow {
  id: number;
  marketing_opt_out_at: Date | null;
  email: string;
  first_name: string;
  last_name: string;
  password_hash: string | null;
  status: "active" | "frozen" | "closed";
  status_reason: string | null;
  kyc_status: "none" | "partial" | "pending" | "approved" | "rejected";
  kyc_approved_at: Date | null;
  important_notice: string | null;
  email_verified_at: Date | null;
  phone: string | null;
  phone_code: string | null;
  country: string | null;
  city: string | null;
  address: string | null;
  zipcode: string | null;
  dob: string | null;
  gender: "Male" | "Female" | null;
  bio: string | null;
  business_name: string | null;
  referral_code: string;
  referred_by: number | null;
  source: "portal" | "app" | "staff" | "import";
  assigned_staff_id: number | null;
  failed_login_count: number;
  locked_until: Date | null;
  last_login_at: Date | null;
  last_login_ip: string | null;
  created_at: Date;
  updated_at: Date;
  picture_sha: string | null;
}

export const SELECT_CLIENT = `SELECT c.id, c.email, c.first_name, c.last_name, c.password_hash, c.status, c.status_reason, c.kyc_status, c.kyc_approved_at, c.marketing_opt_out_at, c.important_notice,
  c.email_verified_at, c.phone, c.phone_code, c.country, c.city, c.address, c.zipcode,
  DATE_FORMAT(c.dob, '%Y-%m-%d') AS dob, c.gender, c.bio, c.business_name, c.referral_code, c.referred_by, c.source,
  c.assigned_staff_id, c.failed_login_count, c.locked_until, c.last_login_at, c.last_login_ip, c.created_at, c.updated_at,
  p.sha256 AS picture_sha
  FROM clients c LEFT JOIN profile_pictures p ON p.owner_type = 'client' AND p.owner_id = c.id`;

export async function loadClient(conn: Conn, id: number, lock = false) {
  return one<ClientRow>(conn, `${SELECT_CLIENT} WHERE c.id = ?${lock ? " FOR UPDATE OF c" : ""}`, [id]);
}

export const clientName = (c: Pick<ClientRow, "first_name" | "last_name">) => `${c.first_name} ${c.last_name}`.trim();

/** The picture URL is public but unguessable: it carries part of the image hash. */
export const clientPictureUrl = (base: string, id: number, hash: string | null) =>
  hash ? `${base}/api/pictures/client/${id}?v=${pictureVersion(hash)}` : null;

/** GET /api/user: the shape the portal, app and support service read. Never carries staff flags. */
export function presentForPortal(config: Config, c: ClientRow, sessionId?: string) {
  const picture = clientPictureUrl(config.publicUrl, c.id, c.picture_sha);
  return {
    id: c.id,
    name: clientName(c),
    first_name: c.first_name,
    last_name: c.last_name,
    email: c.email,
    email_verified_at: c.email_verified_at?.toISOString() ?? null,
    phone: c.phone,
    countryCode: c.phone_code,
    country_code: c.phone_code,
    country: c.country,
    city: c.city,
    address: c.address,
    zipcode: c.zipcode,
    dob: c.dob,
    date_of_birth: c.dob,
    gender: c.gender,
    bio: c.bio,
    business_name: c.business_name,
    avatar: picture,
    image_url: picture,
    image_name: picture,
    profile_picture: picture,
    referral_code: c.referral_code,
    status: c.status,
    important_notice: c.important_notice,
    kyc_status: c.kyc_status,
    session_id: sessionId ? sessionId.slice(0, 32) : undefined,
    created_at: c.created_at.toISOString(),
  };
}

// ---- Validation shared by sign-up, the profile form and staff edits ----

export const trimmed = (max: number) => z.string().trim().max(max, `Must be at most ${max} characters.`);
export const optionalText = (max: number) =>
  z
    .union([z.string(), z.null()])
    .optional()
    // An empty string means "not filled in on this form" and leaves the stored
    // value alone (the portal and app send every field on every save); null clears it.
    .transform((v) => (v === undefined || (v !== null && v.trim() === "") ? undefined : v === null ? null : v.trim()))
    .refine((v) => v === undefined || v === null || v.length <= max, `Must be at most ${max} characters.`);

export const emailField = z
  .string({ required_error: "The email field is required." })
  .trim()
  .toLowerCase()
  .max(254, "The email must be at most 254 characters.")
  .email("The email must be a valid email address.");

export const nameField = (label: string) =>
  z
    .string({ required_error: `The ${label} field is required.` })
    .trim()
    .min(1, `The ${label} field is required.`)
    .max(80, `The ${label} must be at most 80 characters.`)
    .regex(/^[\p{L}\p{M}' .-]+$/u, `The ${label} may only contain letters, spaces, apostrophes and hyphens.`);

const realDate = (v: string) => {
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

export const profileFields = {
  phone: optionalText(32).refine((v) => !v || (/^\+?[0-9 ().-]+$/.test(v) && v.replace(/\D/g, "").length >= 4 && v.replace(/\D/g, "").length <= 17), "The phone number may only contain digits."),
  countryCode: optionalText(6)
    .transform((v) => (v ? v.replace(/^\+/, "") : v))
    .refine((v) => !v || /^[0-9]{1,4}$/.test(v), "The country code must be the dialling code, such as 44."),
  country: optionalText(80),
  city: optionalText(80),
  address: optionalText(255),
  zipcode: optionalText(20),
  gender: z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => (v === undefined || v === "" ? undefined : v === null ? null : v.toLowerCase() === "male" ? "Male" : v.toLowerCase() === "female" ? "Female" : "invalid"))
    .refine((v) => v !== "invalid", "The gender must be Male or Female.")
    .transform((v) => v as "Male" | "Female" | null | undefined),
  dob: optionalText(10).refine((v) => {
    if (!v) return true;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !realDate(v)) return false;
    const age = (Date.now() - new Date(`${v}T00:00:00Z`).getTime()) / (365.25 * 86_400_000);
    return age >= 18 && age < 120;
  }, "The date of birth must be a real date (YYYY-MM-DD) and you must be at least 18."),
  bio: optionalText(1000),
  business_name: optionalText(120),
};

/** Turns parsed profile fields into column updates, skipping fields that were not sent. */
export function profileColumns(p: { [K in keyof typeof profileFields]?: string | null } & { first_name?: string; last_name?: string }) {
  const map: Record<string, unknown> = {
    first_name: p.first_name,
    last_name: p.last_name,
    phone: p.phone,
    phone_code: p.countryCode,
    country: p.country,
    city: p.city,
    address: p.address,
    zipcode: p.zipcode,
    gender: p.gender,
    dob: p.dob,
    bio: p.bio,
    business_name: p.business_name,
  };
  return Object.entries(map).filter(([, v]) => v !== undefined) as [string, unknown][];
}

export async function updateClientColumns(conn: Conn, clientId: number, columns: [string, unknown][]) {
  if (columns.length === 0) return;
  await exec(conn, `UPDATE clients SET ${columns.map(([k]) => `\`${k}\` = ?`).join(", ")} WHERE id = ?`, [...columns.map(([, v]) => v), clientId]);
}

/** Matches the rules the portal and app show while typing. */
export function clientPasswordProblem(password: string, email: string): string | null {
  if (password.length < 8) return "The password must be at least 8 characters.";
  if (password.length > 128) return "The password must be at most 128 characters.";
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password)) return "The password must contain at least one uppercase and one lowercase letter.";
  if (!/[0-9]/.test(password)) return "The password must contain at least one number.";
  if (!/[^A-Za-z0-9]/.test(password)) return "The password must contain at least one symbol.";
  const local = email.split("@")[0]!.toLowerCase();
  if (local.length >= 4 && password.toLowerCase().includes(local)) return "The password must not contain your email name.";
  return null;
}

// ---- Referral codes ----

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function newReferralCode() {
  let code = "";
  for (let i = 0; i < 8; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

// ---- One-time email codes ----

export type CodePurpose = "register" | "withdrawal" | "update_email";
export const CODE_TTL_MS = 10 * 60_000;
export const CODE_MAX_ATTEMPTS = 5;

export const codeHash = (config: Config, email: string, purpose: CodePurpose, code: string) =>
  createHmac("sha256", config.dataKey).update(`email-code:${purpose}:${email}:${code.trim().toUpperCase()}`).digest("hex");

export const newEmailCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0");

interface CodeRow {
  id: number;
  code_hash: string;
  attempts: number;
}

/**
 * Checks the latest live code for this email and purpose. Wrong guesses count
 * against it; after five the code is dead. `consume` marks it used.
 */
/**
 * Checks the newest live code for this email and purpose. Codes a signed-in
 * client asked for (withdrawal, new email) pass `clientId`: only that client's
 * own code is checked, so nobody else's guesses or requests can touch it.
 */
export async function checkEmailCode(conn: Conn, config: Config, email: string, purpose: CodePurpose, code: string, consume: boolean, clientId?: number) {
  const row = await one<CodeRow>(
    conn,
    `SELECT id, code_hash, attempts FROM email_codes
     WHERE email = ? AND purpose = ?${clientId === undefined ? "" : " AND client_id = ?"} AND consumed_at IS NULL AND expires_at > CURRENT_TIMESTAMP(3)
     ORDER BY id DESC LIMIT 1 FOR UPDATE`,
    clientId === undefined ? [email, purpose] : [email, purpose, clientId],
  );
  if (!row || row.attempts >= CODE_MAX_ATTEMPTS) return false;
  if (row.code_hash !== codeHash(config, email, purpose, code)) {
    await exec(conn, "UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?", [row.id]);
    return false;
  }
  if (consume) await exec(conn, "UPDATE email_codes SET consumed_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [row.id]);
  return true;
}
