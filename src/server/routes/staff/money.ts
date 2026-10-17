import { randomBytes } from "node:crypto";
import express, { Router, type NextFunction, type Request, type Response } from "express";
import sharp from "sharp";
import { z } from "zod";
import { NOT_PLAIN } from "@shared/money";
import type { Permission } from "@shared/permissions";
import type { AppDeps } from "../../app";
import { NETWORK_ADDRESS as ADDRESS } from "../../clients/money";
import { auditContext, writeAudit } from "../../lib/audit";
import { sha256 } from "../../lib/crypto";
import { exec, one, rows, transaction, type Conn } from "../../lib/db";
import { badRequest, conflict, forbidden, handler, notFound, parse, unauthorized } from "../../lib/http";
import { imageInfo } from "../../lib/images";
import { qrNamesAddress, readQrText } from "../../lib/qr";
import { MAX_AMOUNT_MINOR, rateMicros } from "../../money/amounts";
import { walletOf } from "../../money/ledger";
import { clientScope, moneyId } from "../../money/review";
import { loadMoneySettings, type MoneySettings } from "../../money/settings";
import { requirePermission, requireStepUp, staffActor, staffOf, type StaffContext } from "../../staff/session";

/** Passes when the staff member holds at least one of the permissions. */
export const anyPermission =
  (...allowed: Permission[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    const staff = req.staff;
    if (!staff) return next(unauthorized());
    if (!allowed.some((p) => staff.permissions.has(p))) return next(forbidden());
    next();
  };

// ---- Money settings ----

/** The API's names for the money_settings columns, and who may change each one. */
const SETTINGS = {
  minDepositCents: { column: "min_deposit_cents", permission: "payment.manage" },
  minWithdrawalCents: { column: "min_withdrawal_cents", permission: "payment.manage" },
  maxWithdrawalCents: { column: "max_withdrawal_cents", permission: "payment.manage" },
  minTransferCents: { column: "min_transfer_cents", permission: "payment.manage" },
  usdToPkr: { column: "usd_to_pkr", permission: "payment.manage" },
  // The limits above which a second person must approve guard against one person moving money alone.
  depositSecondApprovalCents: { column: "deposit_second_approval_cents", permission: "settings.manage" },
  withdrawalSecondApprovalCents: { column: "withdrawal_second_approval_cents", permission: "settings.manage" },
  firstWithdrawalSecondApproval: { column: "first_withdrawal_second_approval", permission: "settings.manage" },
} as const satisfies Record<string, { column: keyof MoneySettings; permission: Permission }>;
type SettingKey = keyof typeof SETTINGS;
const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

const cents = z
  .number({ invalid_type_error: "Enter the amount in cents, as a whole number" })
  .int("Enter the amount in cents, as a whole number")
  .positive("The amount must be more than zero")
  .max(MAX_AMOUNT_MINOR, "This amount is too large");

const settingsBody = z
  .object({
    minDepositCents: cents.optional(),
    minWithdrawalCents: cents.optional(),
    maxWithdrawalCents: cents.nullable().optional(),
    minTransferCents: cents.optional(),
    usdToPkr: z
      .string({ invalid_type_error: "Enter the rate as text, such as \"280.50\"" })
      .trim()
      .regex(/^\d{1,9}(\.\d{1,6})?$/, "Enter the rate as a number with at most 6 decimals, such as 280.50")
      .refine((v) => !/^\d{1,9}(\.\d{1,6})?$/.test(v) || rateMicros(v) > 0n, "The rate must be more than zero")
      .optional(),
    depositSecondApprovalCents: cents.optional(),
    withdrawalSecondApprovalCents: cents.optional(),
    firstWithdrawalSecondApproval: z.boolean().optional(),
  })
  .strict();
type SettingsBody = z.infer<typeof settingsBody>;

/** "280.000000" → "280", "278.500000" → "278.5". */
const rateText = (rate: string) => (rate.includes(".") ? rate.replace(/0+$/, "").replace(/\.$/, "") : rate);

function settingsOut(s: MoneySettings, updater: { id: number; name: string } | null) {
  return {
    minDepositCents: s.min_deposit_cents,
    minWithdrawalCents: s.min_withdrawal_cents,
    maxWithdrawalCents: s.max_withdrawal_cents,
    minTransferCents: s.min_transfer_cents,
    usdToPkr: rateText(s.usd_to_pkr),
    depositSecondApprovalCents: s.deposit_second_approval_cents,
    withdrawalSecondApprovalCents: s.withdrawal_second_approval_cents,
    firstWithdrawalSecondApproval: s.first_withdrawal_second_approval,
    updatedAt: s.updated_at.toISOString(),
    updatedBy: updater,
  };
}

/** Whether a value sent for a setting differs from the stored one (rates compared as numbers). */
function differs(key: SettingKey, sent: unknown, current: ReturnType<typeof settingsOut>) {
  if (key === "usdToPkr") {
    if (typeof sent !== "string" || !/^\d{1,9}(\.\d{1,6})?$/.test(sent.trim())) return true;
    return rateMicros(sent.trim()) !== rateMicros(current.usdToPkr);
  }
  return sent !== current[key];
}

/** The settings a body would change, refused (403) when the staff member may not change one of them. */
function assertMayChange(staff: StaffContext, body: Record<string, unknown>, current: ReturnType<typeof settingsOut>): SettingKey[] {
  const changed = SETTING_KEYS.filter((k) => Object.hasOwn(body, k) && differs(k, body[k], current));
  if (changed.some((k) => SETTINGS[k].permission === "settings.manage") && !staff.permissions.has("settings.manage")) {
    throw forbidden("Changing the second-approval limits needs the settings.manage permission.");
  }
  if (changed.some((k) => SETTINGS[k].permission === "payment.manage") && !staff.permissions.has("payment.manage")) {
    throw forbidden("Changing the deposit, withdrawal and transfer limits or the rupee rate needs the payment.manage permission.");
  }
  return changed;
}

// ---- Payment methods ----

type Direction = "deposit" | "withdrawal";
type Kind = "bank" | "crypto";
type Network = "" | "trc20" | "bep20" | "binance_pay";

interface MethodRow {
  id: number;
  direction: Direction;
  kind: Kind;
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
  ask_qr: number;
  is_enabled: number;
  sort_order: number;
  created_at: Date;
  updated_at: Date;
  open_count: number;
  total_count: number;
}

const SELECT_METHOD = `SELECT pm.id, pm.direction, pm.kind, pm.name, pm.currency, pm.network, pm.bank_name, pm.account_title, pm.account_number, pm.iban, pm.wallet_address,
  pm.qr_token, pm.amount_note, pm.fee_label, pm.processing_label, pm.min_minor, pm.ask_qr, pm.is_enabled, pm.sort_order, pm.created_at, pm.updated_at,
  IF(pm.direction = 'deposit',
    (SELECT COUNT(*) FROM deposits d WHERE d.payment_method_id = pm.id AND d.status IN ('pending', 'second_approval')),
    (SELECT COUNT(*) FROM withdrawals w WHERE w.payment_method_id = pm.id AND w.status IN ('pending', 'second_approval', 'approved'))) AS open_count,
  IF(pm.direction = 'deposit',
    (SELECT COUNT(*) FROM deposits d WHERE d.payment_method_id = pm.id),
    (SELECT COUNT(*) FROM withdrawals w WHERE w.payment_method_id = pm.id)) AS total_count
  FROM payment_methods pm`;

/** The staff copy of a method's QR image. The version changes with each new image, so a browser never shows an old one. */
const staffQrUrl = (m: Pick<MethodRow, "id" | "qr_token">) => (m.qr_token ? `/api/staff/money/methods/${m.id}/qr?v=${sha256(m.qr_token).slice(0, 12)}` : null);

const presentMethod = (m: MethodRow) => ({
  id: m.id,
  direction: m.direction,
  kind: m.kind,
  name: m.name,
  currency: m.currency,
  network: m.network,
  bankName: m.bank_name,
  accountTitle: m.account_title,
  accountNumber: m.account_number,
  iban: m.iban,
  walletAddress: m.wallet_address,
  hasQr: m.qr_token !== null,
  qrUrl: staffQrUrl(m),
  amountNote: m.amount_note,
  feeLabel: m.fee_label,
  processingLabel: m.processing_label,
  minMinor: m.min_minor === null ? null : Number(m.min_minor),
  askQr: m.ask_qr === 1,
  isEnabled: m.is_enabled === 1,
  sortOrder: m.sort_order,
  createdAt: m.created_at.toISOString(),
  updatedAt: m.updated_at.toISOString(),
  usage: { open: Number(m.open_count), total: Number(m.total_count) },
});

const PLAIN = "Use plain text, without links or symbols like < > { }";
const plainText = (max: number) =>
  z
    .string({ invalid_type_error: "Enter text" })
    .trim()
    .max(max, `Keep this under ${max + 1} characters`)
    .refine((v) => !NOT_PLAIN.test(v), PLAIN);
// Account numbers and IBANs: letters, digits, spaces and - . / only.
const accountText = (max: number) =>
  z
    .string({ invalid_type_error: "Enter text" })
    .trim()
    .max(max, `Keep this under ${max + 1} characters`)
    .regex(/^[A-Za-z0-9 ./-]*$/, "Use letters, digits, spaces and - . / only");

/** Every field a method can have, as the API names them. */
const methodFields = {
  name: plainText(80),
  currency: z.enum(["USD", "PKR"]),
  network: z.enum(["", "trc20", "bep20", "binance_pay"]),
  bankName: plainText(120),
  accountTitle: plainText(120),
  accountNumber: accountText(64),
  iban: accountText(64),
  walletAddress: z
    .string({ invalid_type_error: "Enter text" })
    .trim()
    .max(128, "Keep this under 129 characters")
    .regex(/^[A-Za-z0-9]*$/, "Use letters and digits only, with no spaces"),
  amountNote: plainText(300),
  feeLabel: plainText(60),
  processingLabel: plainText(60),
  minMinor: z.number().int("Enter the minimum in minor units, as a whole number").positive("The minimum must be more than zero").max(MAX_AMOUNT_MINOR).nullable(),
  askQr: z.boolean(),
  isEnabled: z.boolean(),
  sortOrder: z.number().int().min(-1_000_000).max(1_000_000),
};
type MethodFields = { [K in keyof typeof methodFields]: z.infer<(typeof methodFields)[K]> };
type MethodInput = MethodFields & { direction: Direction; kind: Kind };

const DEFAULTS: MethodFields = {
  name: "", currency: "USD", network: "", bankName: "", accountTitle: "", accountNumber: "", iban: "", walletAddress: "",
  amountNote: "", feeLabel: "", processingLabel: "", minMinor: null, askQr: false, isEnabled: true, sortOrder: 0,
};

const createBody = z
  .object(methodFields)
  .partial()
  .extend({ direction: z.enum(["deposit", "withdrawal"]), kind: z.enum(["bank", "crypto"]) })
  .strict();
const updateBody = z
  .object(methodFields)
  .partial()
  .extend({ direction: z.enum(["deposit", "withdrawal"]).optional(), kind: z.enum(["bank", "crypto"]).optional() })
  .strict();

const fromRow = (m: MethodRow): MethodInput => ({
  direction: m.direction, kind: m.kind, name: m.name, currency: m.currency, network: m.network, bankName: m.bank_name, accountTitle: m.account_title,
  accountNumber: m.account_number, iban: m.iban, walletAddress: m.wallet_address, amountNote: m.amount_note, feeLabel: m.fee_label,
  processingLabel: m.processing_label, minMinor: m.min_minor === null ? null : Number(m.min_minor), askQr: m.ask_qr === 1, isEnabled: m.is_enabled === 1, sortOrder: m.sort_order,
});

const COLUMNS: Record<keyof MethodInput, string> = {
  direction: "direction", kind: "kind", name: "name", currency: "currency", network: "network", bankName: "bank_name", accountTitle: "account_title",
  accountNumber: "account_number", iban: "iban", walletAddress: "wallet_address", amountNote: "amount_note", feeLabel: "fee_label",
  processingLabel: "processing_label", minMinor: "min_minor", askQr: "ask_qr", isEnabled: "is_enabled", sortOrder: "sort_order",
};
/** Where client money is sent: changing any of these on a deposit method redirects it. */
const ACCOUNT_FIELDS = ["currency", "network", "bankName", "accountTitle", "accountNumber", "iban", "walletAddress"] as const;

// The portal and app decide which form to show for a payout type by its name
// (bank: "bank", "wire" or "iban"; otherwise crypto), so names must agree with the kind.
// The portal also files a new wallet under the type whose name, without spaces,
// contains "USDTTRC20", "USDTBEP20" or "Binance": a name like "TRC20" or
// "USDT-TRC20" would send a Tron wallet to another type.
const NETWORK_WORD: Record<Exclude<Network, "">, { word: RegExp; example: string }> = {
  trc20: { word: /usdttrc20/i, example: "USDT TRC20" },
  bep20: { word: /usdtbep20/i, example: "USDT BEP20" },
  binance_pay: { word: /binance/i, example: "Binance Pay" },
};

/**
 * Brings a method's fields in line with its direction and kind (fields that do
 * not apply are cleared) and lists what is missing or wrong, in parse()'s format.
 */
function settleMethod(m: MethodInput): { method: MethodInput; problems: { field: string; message: string }[] } {
  const problems: { field: string; message: string }[] = [];
  const out: MethodInput = { ...m };
  const problem = (field: string, message: string) => problems.push({ field, message });
  if (out.name.length < 2) problem("name", "Enter a name of at least 2 characters");
  if (out.kind === "bank") out.network = "";
  if (out.kind === "crypto") Object.assign(out, { bankName: "", accountTitle: "", accountNumber: "", iban: "" });
  if (out.direction === "withdrawal") {
    // A payout type is only a kind of account clients add themselves; the broker's details and minimums do not apply.
    Object.assign(out, { currency: "USD", bankName: "", accountTitle: "", accountNumber: "", iban: "", walletAddress: "", minMinor: null });
    if (out.kind === "bank") {
      out.askQr = false;
      if (!/bank|wire/i.test(out.name)) problem("name", "Name a bank payout type with the word \"bank\" or \"wire\" (for example \"Bank transfer\"), so the portal and app show the bank form.");
    } else {
      if (!out.network) problem("network", "Choose the network.");
      else if (!NETWORK_WORD[out.network].word.test(out.name.replace(/\s+/g, "")) || /bank|wire|iban/i.test(out.name)) {
        problem("name", `Name this payout type after its network (for example "${NETWORK_WORD[out.network].example}"), so the portal and app show the right form.`);
      }
    }
    if (m.currency === "PKR") problem("currency", "Only bank deposit methods can be in PKR.");
    return { method: out, problems };
  }
  out.askQr = false;
  if (out.kind === "bank") {
    if (!out.bankName) problem("bankName", "Enter the bank name.");
    if (!out.accountTitle) problem("accountTitle", "Enter the account title.");
    if (out.accountNumber.length < 4) problem("accountNumber", "Enter the account number (at least 4 characters).");
    if (out.iban && out.iban.replace(/[\s./-]/g, "").length < 8) problem("iban", "Enter the full IBAN, or leave it empty.");
    out.walletAddress = "";
  } else {
    if (out.currency === "PKR") problem("currency", "Only bank deposit methods can be in PKR.");
    if (!out.network) problem("network", "Choose the network.");
    if (!out.walletAddress) problem("walletAddress", "Enter the wallet address.");
    else if (out.network && !ADDRESS[out.network].pattern.test(out.walletAddress)) problem("walletAddress", ADDRESS[out.network].message);
  }
  return { method: out, problems };
}

const MAX_QR_BYTES = 2 * 1024 * 1024;
const QR_TYPES = ["image/png", "image/jpeg", "image/webp"];

/** Deposit methods, payout types, money limits and client wallets. */
export function staffMoneyRouter(deps: AppDeps): Router {
  const { db, config } = deps;
  const router = Router();
  const stepUp = requireStepUp(config);
  const ctx = (req: Request) => auditContext(req, staffActor(staffOf(req)));
  const seeMethods = anyPermission("payment.manage", "deposit.view", "withdrawal.view");

  /** The settings as the API shows them. `lock` takes the row for update first (a change is about to follow). */
  async function currentSettings(conn: Conn, lock = false) {
    if (lock) await one(conn, "SELECT id FROM money_settings WHERE id = 1 FOR UPDATE");
    const s = await loadMoneySettings(conn);
    const by = s.updated_by ? await one<{ id: number; name: string }>(conn, "SELECT id, name FROM staff_users WHERE id = ?", [s.updated_by]) : undefined;
    return settingsOut(s, by ?? null);
  }

  router.get(
    "/settings",
    anyPermission("payment.manage", "settings.view", "deposit.view", "withdrawal.view"),
    handler(async (_req, res) => {
      res.json(await currentSettings(db));
    }),
  );

  router.patch(
    "/settings",
    anyPermission("payment.manage", "settings.manage"),
    // Checked before the 2FA prompt too, so nobody is asked for a code to make a change they may not make.
    (req: Request, _res: Response, next: NextFunction) => {
      currentSettings(db)
        .then((current) => assertMayChange(staffOf(req), (req.body ?? {}) as Record<string, unknown>, current))
        .then(() => next(), next);
    },
    stepUp,
    handler(async (req, res) => {
      const body: SettingsBody = parse(settingsBody, req.body ?? {});
      const staff = staffOf(req);
      const updated = await transaction(db, async (conn) => {
        const current = await currentSettings(conn, true);
        const changed = assertMayChange(staff, body, current);
        if (!changed.length) return current;
        const next = { ...current, ...Object.fromEntries(changed.map((k) => [k, body[k]])) } as ReturnType<typeof settingsOut>;
        if (next.maxWithdrawalCents !== null && next.maxWithdrawalCents < next.minWithdrawalCents) {
          throw badRequest("Check the highlighted fields.", [{ field: "maxWithdrawalCents", message: "The maximum withdrawal must be at least the minimum withdrawal." }]);
        }
        const values = changed.map((k) => (k === "firstWithdrawalSecondApproval" ? (body[k] ? 1 : 0) : body[k]));
        await exec(conn, `UPDATE money_settings SET ${changed.map((k) => `${SETTINGS[k].column} = ?`).join(", ")}, updated_by = ? WHERE id = 1`, [...values, staff.id]);
        const after = await currentSettings(conn);
        await writeAudit(conn, ctx(req), {
          action: "money_settings.updated", entityType: "money_settings", entityId: 1,
          before: Object.fromEntries(changed.map((k) => [k, current[k]])),
          after: Object.fromEntries(changed.map((k) => [k, after[k]])),
        });
        return after;
      });
      res.json(updated);
    }),
  );

  async function loadMethod(conn: Conn, methodId: number, lock = false) {
    const m = await one<MethodRow>(conn, `${SELECT_METHOD} WHERE pm.id = ?${lock ? " FOR UPDATE OF pm" : ""}`, [methodId]);
    if (!m) throw notFound("That payment method does not exist.");
    return m;
  }

  router.get(
    "/methods",
    seeMethods,
    handler(async (_req, res) => {
      const items = await rows<MethodRow>(db, `${SELECT_METHOD} ORDER BY pm.direction, pm.sort_order, pm.id`);
      res.json({ items: items.map(presentMethod) });
    }),
  );

  router.post(
    "/methods",
    requirePermission("payment.manage"),
    stepUp,
    handler(async (req, res) => {
      const body = parse(createBody, req.body ?? {});
      const { method, problems } = settleMethod({ ...DEFAULTS, ...body } as MethodInput);
      if (problems.length) throw badRequest("Check the highlighted fields.", problems);
      const staff = staffOf(req);
      const created = await transaction(db, async (conn) => {
        const keys = Object.keys(COLUMNS) as (keyof MethodInput)[];
        const r = await exec(conn, `INSERT INTO payment_methods (${keys.map((k) => COLUMNS[k]).join(", ")}, updated_by) VALUES (${keys.map(() => "?").join(", ")}, ?)`, [
          ...keys.map((k) => (typeof method[k] === "boolean" ? (method[k] ? 1 : 0) : method[k])), staff.id,
        ]);
        await writeAudit(conn, ctx(req), { action: "payment_method.created", entityType: "payment_method", entityId: r.insertId, after: method });
        return loadMethod(conn, r.insertId);
      });
      res.status(201).json(presentMethod(created));
    }),
  );

  router.patch(
    "/methods/:id",
    requirePermission("payment.manage"),
    stepUp,
    handler(async (req, res) => {
      const methodId = parse(moneyId, req.params.id);
      const body = parse(updateBody, req.body ?? {});
      const staff = staffOf(req);
      const updated = await transaction(db, async (conn) => {
        const row = await loadMethod(conn, methodId, true);
        const current = fromRow(row);
        if (body.direction && body.direction !== current.direction) throw badRequest("A method cannot change between deposit and payout. Add a new one instead.");
        if (body.kind && body.kind !== current.kind) throw badRequest("A method cannot change between bank and crypto. Add a new one instead.");
        // Switching a method off (or moving it) is always allowed, even if an older row would not pass today's checks.
        const onlySwitch = Object.keys(body).every((k) => ["isEnabled", "sortOrder", "direction", "kind"].includes(k));
        const { method, problems } = onlySwitch ? { method: { ...current, ...body } as MethodInput, problems: [] } : settleMethod({ ...current, ...body } as MethodInput);
        if (problems.length) throw badRequest("Check the highlighted fields.", problems);
        const changed = (Object.keys(COLUMNS) as (keyof MethodInput)[]).filter((k) => method[k] !== current[k]);
        if (!changed.length) return row;
        // Deposits waiting for review were paid to the details shown when they were made, and are checked against them.
        if (row.direction === "deposit" && Number(row.open_count) > 0 && changed.some((k) => (ACCOUNT_FIELDS as readonly string[]).includes(k))) {
          throw conflict("Deposits waiting for review were paid to this account. Review them first, or add a new method and disable this one.");
        }
        // Clients' saved wallets were checked against this network, and their withdrawals are paid on it.
        if (row.direction === "withdrawal" && changed.includes("network")) {
          const used = await one<{ n: number }>(
            conn,
            `SELECT (SELECT COUNT(*) FROM client_payout_methods WHERE payment_method_id = ? AND deleted_at IS NULL)
                  + (SELECT COUNT(*) FROM withdrawals WHERE payment_method_id = ? AND status IN ('pending', 'second_approval', 'approved')) AS n`,
            [methodId, methodId],
          );
          if (Number(used?.n ?? 0) > 0) throw conflict("Clients have accounts saved under this payout type. Add a new type for the other network and disable this one.");
        }
        // A QR code of the old address would send clients' money there.
        const qrRemoved = changed.includes("walletAddress") && row.qr_token !== null;
        await exec(conn, `UPDATE payment_methods SET ${changed.map((k) => `${COLUMNS[k]} = ?`).join(", ")}${qrRemoved ? ", qr_mime = NULL, qr_bytes = NULL, qr_token = NULL" : ""}, updated_by = ? WHERE id = ?`, [
          ...changed.map((k) => (typeof method[k] === "boolean" ? (method[k] ? 1 : 0) : method[k])), staff.id, methodId,
        ]);
        await writeAudit(conn, ctx(req), {
          action: "payment_method.updated", entityType: "payment_method", entityId: methodId,
          before: Object.fromEntries(changed.map((k) => [k, current[k]])),
          after: Object.fromEntries(changed.map((k) => [k, method[k]])),
          meta: { direction: row.direction, kind: row.kind, name: method.name, accountChanged: changed.some((k) => (ACCOUNT_FIELDS as readonly string[]).includes(k)), ...(qrRemoved ? { qrRemoved } : {}) },
        });
        return loadMethod(conn, methodId);
      });
      res.json(presentMethod(updated));
    }),
  );

  // The QR code clients scan to pay a crypto deposit method. Stored re-encoded as PNG, so nothing hidden in the file survives.
  router.post(
    "/methods/:id/qr",
    requirePermission("payment.manage"),
    stepUp,
    express.raw({ type: QR_TYPES, limit: MAX_QR_BYTES }),
    handler(async (req, res) => {
      const methodId = parse(moneyId, req.params.id);
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (bytes.length === 0) throw badRequest("Upload the QR code as a PNG, JPEG or WebP image.");
      const info = imageInfo(bytes);
      if (!info || info.type !== req.get("content-type")?.split(";")[0]?.trim()) throw badRequest("This file is not a valid PNG, JPEG or WebP image.");
      if (Math.min(info.width, info.height) < 64) throw badRequest("The QR code image must be at least 64 pixels on each side.");
      if (Math.max(info.width, info.height) > 4096) throw badRequest("The QR code image can be at most 4096 pixels on each side.");
      let png: Buffer;
      try {
        png = await sharp(bytes, { limitInputPixels: 4096 * 4096 }).png().toBuffer();
      } catch {
        throw badRequest("This image could not be opened.");
      }
      // Clients scan the picture, so it must hold the address reviewers check deposits against.
      const text = await readQrText(png);
      if (!text) throw badRequest("No QR code could be read in this picture. Upload a clear picture of the QR code alone.");
      const token = randomBytes(16).toString("hex");
      const staff = staffOf(req);
      const updated = await transaction(db, async (conn) => {
        const row = await loadMethod(conn, methodId, true);
        if (row.direction !== "deposit" || row.kind !== "crypto") throw badRequest("Only crypto deposit methods have a QR code.");
        if (!row.wallet_address || !qrNamesAddress(text, row.wallet_address, row.network === "bep20")) {
          throw badRequest(`This QR code does not hold the method's wallet address (${row.wallet_address || "none saved"}). Upload the QR code of that address.`);
        }
        const before = await one<{ qr_bytes: Buffer | null }>(conn, "SELECT qr_bytes FROM payment_methods WHERE id = ?", [methodId]);
        await exec(conn, "UPDATE payment_methods SET qr_mime = 'image/png', qr_bytes = ?, qr_token = ?, updated_by = ? WHERE id = ?", [png, token, staff.id, methodId]);
        await writeAudit(conn, ctx(req), {
          action: "payment_method.qr_changed", entityType: "payment_method", entityId: methodId,
          before: before?.qr_bytes ? { sha256: sha256(before.qr_bytes) } : null,
          after: { sha256: sha256(png), bytes: png.length, width: info.width, height: info.height, text: text.slice(0, 300) },
          meta: { name: row.name, sent: { type: info.type, bytes: bytes.length, sha256: sha256(bytes) } },
        });
        return loadMethod(conn, methodId);
      });
      res.json(presentMethod(updated));
    }),
  );

  router.delete(
    "/methods/:id/qr",
    requirePermission("payment.manage"),
    stepUp,
    handler(async (req, res) => {
      const methodId = parse(moneyId, req.params.id);
      const staff = staffOf(req);
      const updated = await transaction(db, async (conn) => {
        const row = await loadMethod(conn, methodId, true);
        if (!row.qr_token) return row;
        const before = await one<{ qr_bytes: Buffer | null }>(conn, "SELECT qr_bytes FROM payment_methods WHERE id = ?", [methodId]);
        await exec(conn, "UPDATE payment_methods SET qr_mime = NULL, qr_bytes = NULL, qr_token = NULL, updated_by = ? WHERE id = ?", [staff.id, methodId]);
        await writeAudit(conn, ctx(req), {
          action: "payment_method.qr_removed", entityType: "payment_method", entityId: methodId,
          before: before?.qr_bytes ? { sha256: sha256(before.qr_bytes) } : null, after: null, meta: { name: row.name },
        });
        return loadMethod(conn, methodId);
      });
      res.json(presentMethod(updated));
    }),
  );

  router.get(
    "/methods/:id/qr",
    seeMethods,
    handler(async (req, res) => {
      const qr = await one<{ qr_mime: string | null; qr_bytes: Buffer | null }>(db, "SELECT qr_mime, qr_bytes FROM payment_methods WHERE id = ?", [parse(moneyId, req.params.id)]);
      if (!qr?.qr_bytes || !qr.qr_mime) throw notFound();
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", qr.qr_mime);
      res.setHeader("Content-Disposition", "inline");
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      res.send(qr.qr_bytes);
    }),
  );

  // A client's wallet on their page: balances, totals and the latest ledger entries.
  router.get(
    "/clients/:id/wallet",
    requirePermission("wallet.view", "client.view"),
    handler(async (req, res) => {
      const clientId = parse(moneyId, req.params.id);
      const s = clientScope(staffOf(req));
      const client = await one<{ id: number }>(db, `SELECT c.id FROM clients c WHERE c.id = ?${s.sql}`, [clientId, ...s.params]);
      if (!client) throw notFound("That client does not exist or is not assigned to you.");
      const wallet = await walletOf(db, clientId);
      const totals = await one<{ deposited: string | null; pending: number; withdrawn: string | null; open: number }>(
        db,
        `SELECT (SELECT SUM(credited_cents) FROM deposits WHERE client_id = ? AND status = 'approved') AS deposited,
           (SELECT COUNT(*) FROM deposits WHERE client_id = ? AND status IN ('pending', 'second_approval')) AS pending,
           (SELECT SUM(amount_cents) FROM withdrawals WHERE client_id = ? AND status = 'paid') AS withdrawn,
           (SELECT COUNT(*) FROM withdrawals WHERE client_id = ? AND status IN ('pending', 'second_approval', 'approved')) AS open`,
        [clientId, clientId, clientId, clientId],
      );
      // Only the client's own accounts (wallet and hold) carry client_id on their entries.
      const entries = await rows<{ created_at: Date; kind: string; account: string; amount_cents: number; reference: string | null; source_type: string; source_id: number }>(
        db,
        `SELECT e.created_at, t.kind, e.account, e.amount_cents, COALESCE(d.reference, w.reference) AS reference, t.source_type, t.source_id
         FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id
         LEFT JOIN deposits d ON t.source_type = 'deposit' AND d.id = t.source_id
         LEFT JOIN withdrawals w ON t.source_type = 'withdrawal' AND w.id = t.source_id
         WHERE e.client_id = ? ORDER BY e.id DESC LIMIT 20`,
        [clientId],
      );
      res.json({
        walletKey: wallet.wallet_key,
        availableCents: wallet.available_cents,
        heldCents: wallet.held_cents,
        currency: "USD",
        totals: {
          depositedCents: Number(totals?.deposited ?? 0),
          withdrawnCents: Number(totals?.withdrawn ?? 0),
          pendingDeposits: Number(totals?.pending ?? 0),
          openWithdrawals: Number(totals?.open ?? 0),
        },
        entries: entries.map((e) => ({
          at: e.created_at.toISOString(),
          kind: e.kind,
          account: e.account.endsWith(":hold") ? "hold" : "wallet",
          amountCents: Number(e.amount_cents),
          reference: e.reference,
          sourceType: e.source_type,
          sourceId: Number(e.source_id),
        })),
      });
    }),
  );

  return router;
}
