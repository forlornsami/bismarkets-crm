import { randomBytes } from "node:crypto";
import type { Request } from "express";
import { z } from "zod";
import { NOT_PLAIN } from "@shared/money";
import type { Config } from "../config";
import { decryptField } from "../lib/crypto";
import { one, type Conn } from "../lib/db";
import { HttpError } from "../lib/http";
import { fromUsdCents, toMajor } from "../money/amounts";
import type { MoneySettings } from "../money/settings";
import { FROZEN_FOR_CLIENT } from "../money/review";
import { fieldError } from "./errors";
import { kycRequired } from "./kyc";

// What the portal and app read about money: history rows, deposit methods,
// payout types and the client's saved payout accounts, in the shapes both
// front ends parse. Internal states never reach them: a deposit is pending,
// approved or rejected; a withdrawal is pending until it is paid.

// ---------- Who may move money ----------

/** Why this client may not move money now, as the error both front ends understand, or null. */
export function clientMoneyBlock(c: { status: string; kyc_status: string }): HttpError | null {
  if (c.status === "closed") return new HttpError(403, "ACCOUNT_CLOSED", "This account is closed. Please contact support.");
  // The portal recognises "account is frozen" and shows its restricted-account text.
  if (c.status === "frozen") return new HttpError(403, "ACCOUNT_FROZEN", FROZEN_FOR_CLIENT);
  if (c.kyc_status !== "approved") return kycRequired();
  return null;
}

/** Checked before a money form is read, and again with the client row locked. */
export async function assertClientMayMoveMoney(conn: Conn, clientId: number) {
  const c = await one<{ status: string; kyc_status: string }>(conn, "SELECT status, kyc_status FROM clients WHERE id = ?", [clientId]);
  const block = c ? clientMoneyBlock(c) : new HttpError(403, "ACCOUNT_CLOSED", "This account is closed. Please contact support.");
  if (block) throw block;
}

// ---------- Labels ----------

export type Network = "" | "trc20" | "bep20" | "binance_pay";
export const NETWORK_LABELS: Record<Network, string> = { "": "", trc20: "TRC20", bep20: "BEP20", binance_pay: "Binance Pay" };
export const networkLabel = (network: string) => NETWORK_LABELS[network as Network] ?? "";

/** What a wallet address or Pay ID looks like on each network, for staff and client forms alike. */
export const NETWORK_ADDRESS: Record<Exclude<Network, "">, { pattern: RegExp; message: string }> = {
  trc20: { pattern: /^T[1-9A-HJ-NP-Za-km-z]{33}$/, message: "A TRC20 address starts with T and has 34 characters." },
  bep20: { pattern: /^0x[0-9a-fA-F]{40}$/, message: "A BEP20 address starts with 0x followed by 40 letters and digits." },
  binance_pay: { pattern: /^\d{6,12}$/, message: "Enter the Binance Pay ID (6 to 12 digits)." },
};

/** Both front ends know pending, approved and rejected; second approval is still pending to the client. */
export const depositStatusLabel = (status: string) => (status === "approved" ? "approved" : status === "rejected" ? "rejected" : "pending");
/** A withdrawal stays pending until the money is sent: both front ends show "approved" as completed. */
export const withdrawalStatusLabel = (status: string) => (status === "paid" ? "approved" : status === "rejected" ? "rejected" : "pending");

// ---------- History rows ----------

export interface DepositRow {
  id: number;
  reference: string;
  method_name: string;
  amount_cents: number;
  credited_cents: number | null;
  status: string;
  reject_reason: string | null;
  created_at: Date;
  updated_at: Date;
}
export const DEPOSIT_ROW = "SELECT id, reference, method_name, amount_cents, credited_cents, status, reject_reason, created_at, updated_at FROM deposits";

export interface WithdrawalRow {
  id: number;
  reference: string;
  method_name: string;
  amount_cents: number;
  status: string;
  reject_reason: string | null;
  created_at: Date;
  updated_at: Date;
}
export const WITHDRAWAL_ROW = "SELECT id, reference, method_name, amount_cents, status, reject_reason, created_at, updated_at FROM withdrawals";

/**
 * Both front ends read the rejection reason from the first of message,
 * rejection_reason, note, comment, description and more, so a row carries no
 * other free text, and the reason only once rejected.
 */
function historyRow(r: { id: number; reference: string; method_name: string; status: string; reject_reason: string | null; created_at: Date; updated_at: Date }, label: string, cents: number) {
  return {
    id: r.id,
    reference: r.reference,
    // A string label: an id or object here would be shown as the method.
    method: r.method_name,
    method_name: r.method_name,
    amount: toMajor(cents),
    currency: "USD",
    status_label: label,
    status: label,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
    ...(label === "rejected" && r.reject_reason ? { message: r.reject_reason, rejection_reason: r.reject_reason } : {}),
  };
}

/** The amount is what reached the wallet once approved, else the claimed amount in US dollars. */
export const presentDeposit = (d: DepositRow) => historyRow(d, depositStatusLabel(d.status), Number(d.credited_cents ?? d.amount_cents));
export const presentWithdrawal = (w: WithdrawalRow) => historyRow(w, withdrawalStatusLabel(w.status), Number(w.amount_cents));

// ---------- Pagination ----------

/** ?page&per_page as both front ends send them; anything odd falls back to the defaults instead of failing the page. */
export function pageQuery(query: unknown) {
  const q = (query ?? {}) as Record<string, unknown>;
  return {
    page: z.coerce.number().int().min(1).max(1_000_000).catch(1).parse(q.page ?? 1),
    perPage: z.coerce.number().int().min(1).max(200).catch(15).parse(q.per_page ?? 15),
  };
}

/**
 * Rows at `data`, metadata both at the top level and under `pagination`.
 * `current_page` echoes the request, and last_page is at least 1: both front
 * ends check them on every page.
 */
export function paged<T>(data: T[], page: number, perPage: number, total: number) {
  const meta = { current_page: page, last_page: Math.max(1, Math.ceil(total / perPage)), per_page: perPage, total };
  return { success: true, data, pagination: meta, ...meta };
}

// ---------- Forms ----------

/** A money form as the portal and app send it: multipart (read raw by the route), or JSON. */
export interface MoneyForm {
  values: Record<string, unknown>;
  files: Map<string, File>;
}

/** More parts than any money form has. Parsing runs on the main thread, and its cost grows with the parts. */
const MAX_FORM_PARTS = 24;
/** The longest text value any money form field needs (a reason or a name is far shorter). */
const MAX_FORM_TEXT = 4096;

/** How many parts a multipart body has, counted by its boundary without parsing it; null without a boundary. */
function partCount(body: Buffer, contentType: string): number | null {
  const match = /boundary=(?:"([^"]{1,70})"|([^;\s]{1,70}))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary) return null;
  const marker = Buffer.from(`--${boundary}`);
  let seen = 0;
  for (let at = body.indexOf(marker); at !== -1 && seen <= MAX_FORM_PARTS + 1; at = body.indexOf(marker, at + marker.length)) seen++;
  // The last boundary closes the form.
  return Math.max(0, seen - 1);
}

/** Reads a multipart body (a Buffer from express.raw) or a parsed JSON body. Files come with multipart only. */
export async function readMoneyForm(req: Request, brokenField: string, brokenMessage: string): Promise<MoneyForm> {
  const body = req.body as unknown;
  const files = new Map<string, File>();
  if (Buffer.isBuffer(body)) {
    const parts = partCount(body, req.get("content-type") ?? "");
    if (parts === null || parts > MAX_FORM_PARTS) throw fieldError(brokenField, brokenMessage);
    let form: FormData;
    try {
      form = await new Response(new Uint8Array(body), { headers: { "content-type": req.get("content-type") ?? "" } }).formData();
    } catch {
      throw fieldError(brokenField, brokenMessage);
    }
    const values: Record<string, unknown> = {};
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") {
        if (value.length > MAX_FORM_TEXT) throw fieldError(key.slice(0, 40), "This is too long.");
        if (!(key in values)) values[key] = value;
      } else if (!files.has(key)) {
        files.set(key, value);
      }
    }
    return { values, files };
  }
  const values = body !== null && typeof body === "object" && !Array.isArray(body) ? { ...(body as Record<string, unknown>) } : {};
  return { values, files };
}

/** A form value as text: strings as sent, numbers as JavaScript prints them, anything else as missing. */
export const formText = (value: unknown) => (typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : undefined);

/** '1', 'true', 1 and true are yes; '0', 'false', 0, false and '' are no; anything else counts as not sent. */
export function formFlag(value: unknown): boolean | undefined {
  if (value === true || value === 1 || value === "1" || value === "true") return true;
  if (value === false || value === 0 || value === "0" || value === "false" || value === "") return false;
  return undefined;
}

/** A positive whole-number id sent as text or a number, or null. */
export function formId(value: unknown): number | null {
  const text = formText(value)?.trim() ?? "";
  if (!/^\d{1,15}$/.test(text)) return null;
  const id = Number(text);
  return id > 0 && Number.isSafeInteger(id) ? id : null;
}

/** File names are kept for reviewers only; anything unusual becomes an underscore. */
export const safeFileName = (name: string, fallback: string) => (name || fallback).replace(/[^\w.\- ]+/g, "_").slice(0, 160);

// ---------- Deposit methods ----------

export interface DepositMethodRow {
  id: number;
  kind: "bank" | "crypto";
  name: string;
  currency: "USD" | "PKR";
  network: Network;
  bank_name: string;
  account_title: string;
  account_number: string;
  iban: string;
  wallet_address: string;
  qr_token: string | null;
  amount_note: string;
  fee_label: string;
  processing_label: string;
  min_minor: number | null;
}
export const DEPOSIT_METHOD = `SELECT id, kind, name, currency, network, bank_name, account_title, account_number, iban, wallet_address,
  IF(qr_bytes IS NULL, NULL, qr_token) AS qr_token, amount_note, fee_label, processing_label, min_minor
  FROM payment_methods WHERE direction = 'deposit' AND is_enabled = 1`;

/** A method's minimum in its own currency: its own, or the global US-dollar minimum converted (rounded up). */
export const depositMinimum = (m: Pick<DepositMethodRow, "min_minor" | "currency">, s: MoneySettings) =>
  m.min_minor !== null ? Number(m.min_minor) : fromUsdCents(s.min_deposit_cents, m.currency, s.usd_to_pkr);

/** A method a client could pay into: one missing its account details is not offered at all. */
export const payableMethod = (m: DepositMethodRow) =>
  m.name.trim() !== "" && (m.kind === "bank" ? Boolean(m.account_number || m.iban) : Boolean(m.wallet_address));

/** The client's static payment reference, so staff can match a bank payment to them. */
export const paymentReference = (clientId: number) => `BIS-${clientId}`;

export const depositQrUrl = (config: Config, token: string) => `${config.publicUrl}/api/payment-qr/${token}`;
export const payoutQrUrl = (config: Config, token: string) => `${config.publicUrl}/api/payout-qr/${token}`;

/**
 * One row of GET /api/deposit-methods. The portal refuses the whole list when
 * any row is incomplete, so every row carries an id, name, currency and a
 * minimum. Each is manual with a proof screenshot: nothing here is automated.
 */
export function presentDepositMethod(config: Config, m: DepositMethodRow, settings: MoneySettings, clientId: number) {
  const details: Record<string, string> = {};
  if (m.kind === "bank") {
    // Only a bank transfer has a reference field; a wallet transfer is matched by its transaction id.
    const reference = `Write ${paymentReference(clientId)} as the payment reference.`;
    details.amount_note = m.amount_note ? `${m.amount_note}\n${reference}` : reference;
    // The portal reads line 1 as the bank name and the labelled lines after it; other lines are not shown.
    details.bank_details = [m.bank_name || m.name, m.account_title && `Account Title: ${m.account_title}`, m.account_number && `Account No: ${m.account_number}`, m.iban && `IBAN: ${m.iban}`]
      .filter(Boolean)
      .join("\n");
    Object.assign(details, { bank_name: m.bank_name, account_title: m.account_title, account_number: m.account_number, iban: m.iban });
  } else {
    if (m.amount_note) details.amount_note = m.amount_note;
    details.wallet_address = m.wallet_address;
    details.network = networkLabel(m.network);
    if (m.qr_token) details.qr_code_url = depositQrUrl(config, m.qr_token);
  }
  return {
    id: String(m.id),
    name: m.name,
    method_name: m.name,
    currency: m.currency,
    min_amount: toMajor(depositMinimum(m, settings)),
    is_enabled: true,
    requires_slip: true,
    type: "manual",
    fee: m.fee_label || "0",
    // Without one the portal shows "Unavailable", so say what does happen.
    processing: m.processing_label || "Added after our team checks it",
    details,
  };
}

// ---------- Payout types (GET /api/payment-methods) ----------

export interface PayoutTypeRow {
  id: number;
  kind: "bank" | "crypto";
  name: string;
  network: Network;
  ask_qr: number;
  is_enabled: number;
}
export const PAYOUT_TYPE = "SELECT id, kind, name, network, ask_qr, is_enabled FROM payment_methods WHERE direction = 'withdrawal'";

/**
 * Both front ends classify a type by its name ("bank"/"wire", "trc"/"bep"/"binance").
 * `manual` makes them ask for a QR image; `hosted` does not. No min_amount:
 * the app would take it as the withdrawal minimum.
 */
export const presentPayoutType = (t: PayoutTypeRow) => ({
  id: String(t.id),
  name: t.name,
  method_name: t.name,
  type: t.kind === "crypto" && !t.ask_qr ? "hosted" : "manual",
  network: networkLabel(t.network),
  currency: "USD",
  is_enabled: true,
});

// ---------- Saved payout accounts ----------

export const payoutAccountContext = (clientId: number) => `payout_method:${clientId}:account_number`;
export const payoutIbanContext = (clientId: number) => `payout_method:${clientId}:iban`;
export const payoutQrContext = (clientId: number, token: string) => `payout_qr:${clientId}:${token}`;
/** The secret part of a QR image's URL. */
export const newQrToken = () => randomBytes(16).toString("hex");
export const QR_TOKEN = /^[a-f0-9]{32}$/;

export interface PayoutMethodRow {
  id: number;
  client_id: number;
  payment_method_id: number;
  method_name: string;
  account_name: string;
  account_number_enc: Buffer;
  iban_enc: Buffer | null;
  swift: string;
  fingerprint: string;
  qr_token: string | null;
  is_default: number;
  created_at: Date;
  type_name: string;
  kind: "bank" | "crypto";
  network: Network;
  ask_qr: number;
  type_enabled: number;
}
export const PAYOUT_METHOD = `SELECT m.id, m.client_id, m.payment_method_id, m.method_name, m.account_name, m.account_number_enc, m.iban_enc, m.swift, m.fingerprint,
  IF(m.qr_bytes_enc IS NULL, NULL, m.qr_token) AS qr_token, m.is_default, m.created_at,
  t.name AS type_name, t.kind, t.network, t.ask_qr, t.is_enabled AS type_enabled
  FROM client_payout_methods m JOIN payment_methods t ON t.id = m.payment_method_id`;

/** The account number and IBAN, decrypted exactly as the client sent them. */
export function openPayoutMethod(config: Config, m: Pick<PayoutMethodRow, "client_id" | "account_number_enc" | "iban_enc">) {
  let unreadable = false;
  const open = (sealed: Buffer | null, context: string) => {
    if (!sealed) return "";
    try {
      return decryptField(config.dataKey, sealed, context);
    } catch {
      unreadable = true;
      return "";
    }
  };
  const accountNumber = open(m.account_number_enc, payoutAccountContext(m.client_id));
  const iban = open(m.iban_enc, payoutIbanContext(m.client_id));
  /** unreadable: a stored detail failed to decrypt (shown empty, and never paid out to). */
  return { accountNumber, iban, unreadable };
}

/**
 * One saved payout account. The app re-reads the list after every save and
 * checks that method_name, account_number, account_name, iban, swift,
 * is_default and payment_method_id come back exactly as it sent them.
 */
export function presentPayoutMethod(config: Config, m: PayoutMethodRow) {
  const { accountNumber, iban } = openPayoutMethod(config, m);
  return {
    id: m.id,
    user_payment_method_id: m.id,
    payment_method_id: String(m.payment_method_id),
    payment_method_name: m.type_name,
    method_name: m.method_name,
    account_name: m.account_name,
    account_number: accountNumber,
    iban,
    swift: m.swift,
    network: networkLabel(m.network),
    currency: "USD",
    is_default: m.is_default === 1,
    qr_code_url: m.qr_token ? payoutQrUrl(config, m.qr_token) : null,
    created_at: m.created_at.toISOString(),
  };
}

/** Last four characters of an account number or address, for the audit log (never the whole number). */
export const lastFour = (account: string) => account.replace(/\s+/g, "").slice(-4);

/** Letters, digits, spaces and - . / : only: enough for account numbers, IBANs, wallet addresses and Pay IDs. */
const ACCOUNT_CHARS = /^[A-Za-z0-9 \-./:]*$/;
const ACCOUNT_CHARS_MESSAGE = "Use only letters, numbers, spaces and - . / :";
// Worded without the symbols themselves: the portal shows a message as written only when it is plain text.
const PLAIN_TEXT_MESSAGE = "Use plain text only, without angle brackets, curly brackets, backslashes or web links.";

const text = (required: string) =>
  z.preprocess((v) => formText(v)?.trim(), z.string({ required_error: required, invalid_type_error: required }));
const optionalText = () => z.preprocess((v) => formText(v)?.trim() ?? "", z.string());

/** The fields of a saved payout account, checked for its account type (and a wallet address for its network). */
export const payoutFields = ({ kind, network }: { kind: "bank" | "crypto"; network: Network }) =>
  z.object({
    method_name: text("Enter a name for this account.")
      .pipe(z.string().min(1, "Enter a name for this account.").max(120, "Keep the account name under 120 characters.").refine((v) => !NOT_PLAIN.test(v), PLAIN_TEXT_MESSAGE)),
    account_name: optionalText().pipe(
      z
        .string()
        .max(120, "Keep the account holder's name under 120 characters.")
        .refine((v) => !NOT_PLAIN.test(v), PLAIN_TEXT_MESSAGE)
        .refine((v) => kind !== "bank" || v.length > 0, "Enter the account holder's name."),
    ),
    account_number: text(kind === "bank" ? "Enter the account number." : "Enter the wallet address or Pay ID.").pipe(
      z
        .string()
        .min(4, kind === "bank" ? "Enter the full account number." : "Enter the full wallet address or Pay ID.")
        .max(kind === "bank" ? 64 : 128, kind === "bank" ? "The account number can be at most 64 characters." : "The wallet address can be at most 128 characters.")
        .regex(ACCOUNT_CHARS, ACCOUNT_CHARS_MESSAGE)
        // Saved under the wrong network, an address would be paid on the wrong chain.
        .refine(
          (v) => kind !== "crypto" || !network || NETWORK_ADDRESS[network].pattern.test(v),
          network ? `This is not a ${NETWORK_LABELS[network]} ${network === "binance_pay" ? "Pay ID" : "address"}. ${NETWORK_ADDRESS[network].message}` : "",
        ),
    ),
    iban: optionalText().pipe(z.string().max(64, "The IBAN can be at most 64 characters.").regex(ACCOUNT_CHARS, ACCOUNT_CHARS_MESSAGE)),
    swift: optionalText().pipe(z.string().max(32, "The SWIFT code can be at most 32 characters.").regex(ACCOUNT_CHARS, ACCOUNT_CHARS_MESSAGE)),
  });
export type PayoutFields = z.infer<ReturnType<typeof payoutFields>>;
