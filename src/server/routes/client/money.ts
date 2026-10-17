import express, { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import type { AppDeps } from "../../app";
import { fieldError, TooManyRequests, validate } from "../../clients/errors";
import { lockClient } from "../../clients/kyc";
import {
  assertClientMayMoveMoney, DEPOSIT_METHOD, DEPOSIT_ROW, depositMinimum, formFlag, formId, formText, lastFour, newQrToken, openPayoutMethod, paged, pageQuery,
  PAYOUT_METHOD, PAYOUT_TYPE, payoutAccountContext, payoutFields, payoutIbanContext, payoutQrContext, payableMethod, presentDeposit, presentDepositMethod, presentPayoutMethod,
  withdrawalDestinationContext,
  presentPayoutType, presentWithdrawal, QR_TOKEN, readMoneyForm, safeFileName, WITHDRAWAL_ROW,
  type DepositMethodRow, type DepositRow, type MoneyForm, type PayoutFields, type PayoutMethodRow, type PayoutTypeRow, type WithdrawalRow,
} from "../../clients/money";
import { checkEmailCode, loadClient } from "../../clients/model";
import { notifyClient } from "../../clients/notifications";
import { clientActor, clientAuth, clientOf, noImpersonation } from "../../clients/session";
import { auditContext, writeAudit } from "../../lib/audit";
import { decryptBytes, encryptBytes, encryptField, sha256 } from "../../lib/crypto";
import { exec, one, rows, transaction, type Conn } from "../../lib/db";
import { queueEmail } from "../../lib/email";
import { handler, HttpError, notFound } from "../../lib/http";
import { RateLimiter } from "../../lib/rateLimit";
import { AMOUNT_MESSAGES, money, parseAmount, toMajor, toUsdCents } from "../../money/amounts";
import { holdAccount, lockWallet, postLedger, walletAccount, walletOf, type WalletRow } from "../../money/ledger";
import { depositProofContext, prepareProof, PROOF_MAX_BYTES, PROOF_RULES, ProofProblem, proofType, type PreparedProof } from "../../money/proofs";
import { destinationFingerprint, withReference } from "../../money/references";
import { endingOf, masked } from "../../money/review";
import { loadMoneySettings } from "../../money/settings";

const HOUR = 60 * 60_000;
/** A proof or QR image of up to 10 MB, plus the rest of the form. */
const IMAGE_FORM_LIMIT = PROOF_MAX_BYTES + 512 * 1024;
const OPEN_DEPOSITS = ["pending", "second_approval"];
const OPEN_WITHDRAWALS = ["pending", "second_approval", "approved"];
const MAX_OPEN_DEPOSITS = 5;
const MAX_OPEN_WITHDRAWALS = 3;
const MAX_PAYOUT_METHODS = 10;
/** A retry of the same request (same method, amount and screenshot) within this time is answered with the first one. */
const RETRY_MINUTES = 30;

const NO_PROOF = "Attach a screenshot of your payment.";
const REFRESH = "Refresh the page and try again.";
const NO_DESTINATION = "Choose where to send the money.";
const WRONG_CODE = "The code is wrong or has expired. Request a new code.";
const QR_RULES = "Upload a picture of the QR code: JPG, PNG, WebP, HEIC or GIF, up to 10 MB.";
const QR_MISSING = "Upload a picture of your wallet's QR code.";
const QR_KEPT = "This account type needs your wallet's QR code. To change the details, remove this account and add it again with its QR code.";
const NO_TYPE = "Choose an account type.";
const IN_USE = "This account is used by a withdrawal in progress. You can change it once that withdrawal is finished.";
const IN_USE_REMOVE = "This account is used by a withdrawal in progress. You can remove it once that withdrawal is finished.";
const QR_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const EXTENSION: Record<PreparedProof["mime"], string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

const payoutNotFound = () => new HttpError(404, "NOT_FOUND", "Payout account not found.");

/** The wallet as both front ends read it from /api/user/stats: `amount` is what the client can use now. */
const presentWallet = (w: WalletRow) => ({
  wallet_key: w.wallet_key, wallet_name: "Main Wallet", wallet_id: w.id, amount: toMajor(w.available_cents), currency: "USD", type: "main", is_default: true,
});

/** Reads a multipart body up to `limit`. A file that is too large becomes a field error, which the portal shows as written. */
function multipart(limit: number, field: string, message: string): RequestHandler {
  const raw = express.raw({ type: "multipart/form-data", limit });
  return (req, res, next) =>
    raw(req, res, (error?: unknown) => {
      if ((error as { status?: number } | undefined)?.status === 413) return next(fieldError(field, message));
      next(error);
    });
}

/** Sends a QR image so it can only ever be shown as a picture, even from another site's <img>. */
function sendQr(res: Response, mime: string | null, bytes: Buffer, cache: string) {
  if (!mime || !QR_IMAGE_TYPES.has(mime)) throw notFound();
  res.setHeader("Content-Type", mime);
  res.setHeader("Content-Disposition", "inline");
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", cache);
  res.send(bytes);
}

/** What a deposit request asks for, checked but not yet stored. */
interface DepositRequest {
  method: DepositMethodRow;
  amountMinor: number;
  /** Rupees per dollar for a PKR method, 1 for USD, as shown to the client now. */
  rate: string;
  /** Who set that rupee rate (null for USD): they cannot approve this deposit alone. */
  rateSetBy: number | null;
  amountCents: number;
  network: string;
  original: Buffer;
  sha256: string;
  fileName: string;
}

/** The portal and app's money endpoints: wallet summary, deposit methods, deposits, withdrawals, saved payout accounts and history. */
export function clientMoneyRouter(deps: AppDeps): Router {
  const { db, config } = deps;
  const router = Router();
  const auth = clientAuth(db, config);
  const ctx = (req: Request) => auditContext(req, clientActor(clientOf(req)));

  // Stored requests per hour; failed attempts do not use them up. The looser
  // attempt limits stop someone hammering the slow image processing or guessing codes.
  const deposits = new RateLimiter(10, HOUR);
  const depositAttempts = new RateLimiter(30, HOUR);
  const withdrawals = new RateLimiter(5, HOUR);
  const withdrawalAttempts = new RateLimiter(10, HOUR);
  const payoutChanges = new RateLimiter(20, HOUR);
  const payoutAttempts = new RateLimiter(30, HOUR);

  /** Refuses a throttled client before the body (up to 10 MB) is read. */
  const gate = (stored: RateLimiter, attempts: RateLimiter, message: string) => (req: Request, _res: Response, next: NextFunction) => {
    const key = String(clientOf(req).id);
    if (stored.isLimited(key)) return next(new TooManyRequests(stored.retryAfter(key), message));
    if (!attempts.take(key)) return next(new TooManyRequests(attempts.retryAfter(key), "Too many attempts. Please wait before trying again."));
    next();
  };
  const depositGate = gate(deposits, depositAttempts, "Too many deposit requests. Please wait before trying again.");
  const withdrawalGate = gate(withdrawals, withdrawalAttempts, "Too many withdrawal requests. Please wait before trying again.");
  const payoutGate = gate(payoutChanges, payoutAttempts, "Too many changes to your payout accounts. Please wait before trying again.");

  /** KYC approved and not frozen, checked before the body is read (and again with the client row locked). */
  const mayMoveMoney = (req: Request, _res: Response, next: NextFunction) => {
    assertClientMayMoveMoney(db, clientOf(req).id).then(() => next(), next);
  };

  // ---------- Wallet and limits ----------

  router.get(
    "/user/stats",
    auth,
    handler(async (req, res) => {
      const clientId = clientOf(req).id;
      const [wallet, settings] = await Promise.all([walletOf(db, clientId), loadMoneySettings(db)]);
      const dep = await one<{ total: string | null; open: string | null }>(
        db,
        "SELECT SUM(IF(status = 'approved', credited_cents, 0)) AS total, SUM(status IN ('pending', 'second_approval')) AS open FROM deposits WHERE client_id = ?",
        [clientId],
      );
      const wd = await one<{ total: string | null; open: string | null }>(
        db,
        "SELECT SUM(IF(status = 'paid', amount_cents, 0)) AS total, SUM(status IN ('pending', 'second_approval', 'approved')) AS open FROM withdrawals WHERE client_id = ?",
        [clientId],
      );
      const recentDeposits = await rows<DepositRow>(db, `${DEPOSIT_ROW} WHERE client_id = ? ORDER BY created_at DESC, id DESC LIMIT 5`, [clientId]);
      const recentWithdrawals = await rows<WithdrawalRow>(db, `${WITHDRAWAL_ROW} WHERE client_id = ? ORDER BY created_at DESC, id DESC LIMIT 5`, [clientId]);
      const minTransfer = toMajor(settings.min_transfer_cents);
      res.json({
        success: true,
        wallet: presentWallet(wallet),
        currency: "USD",
        deposits: { total_approved: toMajor(Number(dep?.total ?? 0)), pending_count: Number(dep?.open ?? 0) },
        withdrawals: { total_approved: toMajor(Number(wd?.total ?? 0)), pending_count: Number(wd?.open ?? 0) },
        minimum_amounts: { min_transfer: minTransfer, min_internal_transfer: minTransfer },
        recent_deposits: recentDeposits.map(presentDeposit),
        recent_withdrawals: recentWithdrawals.map(presentWithdrawal),
      });
    }),
  );

  router.get(
    "/withdrawal-options",
    auth,
    handler(async (req, res) => {
      const [wallet, settings] = await Promise.all([walletOf(db, clientOf(req).id), loadMoneySettings(db)]);
      const min = toMajor(settings.min_withdrawal_cents);
      const max = settings.max_withdrawal_cents === null ? undefined : toMajor(settings.max_withdrawal_cents);
      res.json({
        success: true,
        wallet_key: wallet.wallet_key,
        wallets: [{ wallet_key: wallet.wallet_key, is_default: true, currency: "USD", amount: toMajor(wallet.available_cents) }],
        currency: "USD",
        min_amount: min,
        ...(max === undefined ? {} : { max_amount: max }),
        settings: { min_withdrawal_amount: min, ...(max === undefined ? {} : { max_withdrawal_amount: max }) },
      });
    }),
  );

  // ---------- Deposit methods and QR images ----------

  router.get(
    "/deposit-methods",
    auth,
    handler(async (req, res) => {
      const clientId = clientOf(req).id;
      const [wallet, settings] = await Promise.all([walletOf(db, clientId), loadMoneySettings(db)]);
      const methods = (await rows<DepositMethodRow>(db, `${DEPOSIT_METHOD} ORDER BY sort_order, id`)).filter(payableMethod);
      res.json({
        success: true,
        settings: { min_deposit_amount: toMajor(settings.min_deposit_cents), usd_to_pkr: Number(settings.usd_to_pkr) },
        wallets: [{ wallet_key: wallet.wallet_key, is_default: true, currency: "USD" }],
        payment_methods: methods.map((m) => presentDepositMethod(config, m, settings, clientId)),
      });
    }),
  );

  // Public: the portal shows deposit QR codes in plain <img> tags, without a
  // token, so the URL itself carries an unguessable token.
  router.get(
    "/payment-qr/:token",
    handler(async (req, res) => {
      const token = String(req.params.token);
      if (!QR_TOKEN.test(token)) throw notFound();
      const row = await one<{ qr_mime: string | null; qr_bytes: Buffer }>(
        db,
        "SELECT qr_mime, qr_bytes FROM payment_methods WHERE qr_token = ? AND direction = 'deposit' AND is_enabled = 1 AND qr_bytes IS NOT NULL",
        [token],
      );
      if (!row) throw notFound();
      sendQr(res, row.qr_mime, row.qr_bytes, "public, max-age=300");
    }),
  );

  // Public for the same reason: the app shows a saved account's QR without a token.
  router.get(
    "/payout-qr/:token",
    handler(async (req, res) => {
      const token = String(req.params.token);
      if (!QR_TOKEN.test(token)) throw notFound();
      const row = await one<{ client_id: number; qr_mime: string | null; qr_bytes_enc: Buffer }>(
        db,
        "SELECT client_id, qr_mime, qr_bytes_enc FROM client_payout_methods WHERE qr_token = ? AND deleted_at IS NULL AND qr_bytes_enc IS NOT NULL",
        [token],
      );
      if (!row) throw notFound();
      let bytes: Buffer;
      try {
        bytes = decryptBytes(config.dataKey, row.qr_bytes_enc, payoutQrContext(row.client_id, token));
      } catch {
        throw notFound();
      }
      sendQr(res, row.qr_mime, bytes, "private, no-store");
    }),
  );

  // ---------- Payout types and saved payout accounts ----------

  router.get(
    "/payment-methods",
    auth,
    handler(async (_req, res) => {
      const data = (await rows<PayoutTypeRow>(db, `${PAYOUT_TYPE} AND is_enabled = 1 ORDER BY sort_order, id`)).map(presentPayoutType);
      res.json({ success: true, data, payment_methods: data });
    }),
  );

  router.get(
    "/user-payment-methods",
    auth,
    handler(async (req, res) => {
      const list = await rows<PayoutMethodRow>(db, `${PAYOUT_METHOD} WHERE m.client_id = ? AND m.deleted_at IS NULL ORDER BY m.id DESC`, [clientOf(req).id]);
      // Staff looking through the client's eyes see the endings only: full details are on the
      // withdrawal review screen, for the staff who check and pay withdrawals, and recorded there.
      const viewOnly = clientOf(req).kind === "impersonation";
      const data = list
        .map((m) => presentPayoutMethod(config, m))
        .map((m) => (viewOnly ? { ...m, account_number: masked(m.account_number) ?? "", iban: masked(m.iban) ?? "", qr_code_url: null } : m));
      res.json({ success: true, data, user_payment_methods: data });
    }),
  );

  // ---------- History ----------

  router.get(
    "/deposits",
    auth,
    handler(async (req, res) => {
      const clientId = clientOf(req).id;
      const { page, perPage } = pageQuery(req.query);
      const total = Number((await one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM deposits WHERE client_id = ?", [clientId]))?.n ?? 0);
      const list = await rows<DepositRow>(db, `${DEPOSIT_ROW} WHERE client_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, [clientId, perPage, (page - 1) * perPage]);
      res.json(paged(list.map(presentDeposit), page, perPage, total));
    }),
  );

  router.get(
    "/withdrawals",
    auth,
    handler(async (req, res) => {
      const clientId = clientOf(req).id;
      const { page, perPage } = pageQuery(req.query);
      const total = Number((await one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM withdrawals WHERE client_id = ?", [clientId]))?.n ?? 0);
      const list = await rows<WithdrawalRow>(db, `${WITHDRAWAL_ROW} WHERE client_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, [clientId, perPage, (page - 1) * perPage]);
      res.json(paged(list.map(presentWithdrawal), page, perPage, total));
    }),
  );

  // Transfers come with the MT5 work. Until then both history pages need an
  // empty list rather than an error, or the whole page fails.
  router.get(
    "/transfers",
    auth,
    handler(async (req, res) => {
      const { page, perPage } = pageQuery(req.query);
      res.json(paged([], page, perPage, 0));
    }),
  );

  router.get(
    "/ib-transfer-history",
    auth,
    handler(async (req, res) => {
      const { page, perPage } = pageQuery(req.query);
      res.json({ success: true, data: { history: [], pagination: { current_page: page, last_page: 1, per_page: perPage, total: 0 } } });
    }),
  );

  // Instant (hosted) deposits are not built; both clients read a 404 as "no active payment".
  router.get(
    "/deposits/automated/active",
    auth,
    handler(async () => {
      throw new HttpError(404, "NOT_FOUND", "No active payment.");
    }),
  );

  // ---------- Deposit requests ----------

  /** Checks a deposit form quickly (method, wallet, amount, the file's type), before the slow image processing. */
  async function readDeposit(form: MoneyForm, clientId: number): Promise<DepositRequest> {
    const methodId = formId(form.values.method);
    const method = methodId ? await one<DepositMethodRow>(db, `${DEPOSIT_METHOD} AND id = ?`, [methodId]) : undefined;
    if (!method || !payableMethod(method)) throw fieldError("method", "Choose a deposit method.");
    const wallet = await walletOf(db, clientId);
    if (formText(form.values.wallet_key)?.trim() !== wallet.wallet_key) throw fieldError("wallet_key", REFRESH);
    const amount = parseAmount(form.values.amount);
    if ("problem" in amount) throw fieldError("amount", AMOUNT_MESSAGES[amount.problem]);
    const settings = await loadMoneySettings(db);
    const minimum = depositMinimum(method, settings);
    if (amount.minor < minimum) throw fieldError("amount", `The minimum deposit for this method is ${money(minimum, method.currency)}.`);
    const rate = method.currency === "USD" ? "1.000000" : settings.usd_to_pkr;
    const amountCents = toUsdCents(amount.minor, method.currency, rate);
    if (amountCents < 1) throw fieldError("amount", `The minimum deposit for this method is ${money(minimum, method.currency)}.`);
    const file = form.files.get("file_name");
    if (!file) throw fieldError("file_name", NO_PROOF);
    const original = Buffer.from(await file.arrayBuffer());
    if (!original.length) throw fieldError("file_name", NO_PROOF);
    // Judged by the bytes only: Android files may have no extension or an odd type.
    if (original.length > PROOF_MAX_BYTES || !proofType(original)) throw fieldError("file_name", PROOF_RULES);
    // Recorded as sent, for staff; it changes nothing (every method here is manual).
    const network = formText(form.values.network)?.trim() ?? "";
    return {
      method, amountMinor: amount.minor, rate, rateSetBy: method.currency === "USD" ? null : settings.usd_to_pkr_set_by, amountCents, network: /^[\w.-]{1,16}$/.test(network) ? network : "",
      original, sha256: sha256(original), fileName: safeFileName(file.name, "payment"),
    };
  }

  /**
   * The deposit this request repeats (a retry after a timeout whose first
   * attempt got through), or null when it is new. Refuses a sixth open request
   * and a screenshot already sent with another request. A screenshot sent with
   * a rejected request may come again: staff may have asked for the request to
   * be sent again with another method.
   */
  async function admitDeposit(conn: Conn, clientId: number, d: DepositRequest): Promise<DepositRow | null> {
    const sameProof = await rows<DepositRow & { payment_method_id: number; amount_minor: number; recent: number }>(
      conn,
      `SELECT d.id, d.reference, d.method_name, d.amount_cents, d.credited_cents, d.status, d.reject_reason, d.created_at, d.updated_at,
         d.payment_method_id, d.amount_minor, d.created_at > CURRENT_TIMESTAMP(3) - INTERVAL ${RETRY_MINUTES} MINUTE AS recent
       FROM deposits d JOIN deposit_proofs p ON p.deposit_id = d.id
       WHERE d.client_id = ? AND p.sha256 = ? ORDER BY d.id DESC`,
      [clientId, d.sha256],
    );
    const repeat = sameProof.find(
      (r) => OPEN_DEPOSITS.includes(r.status) && Number(r.recent) === 1 && Number(r.payment_method_id) === d.method.id && Number(r.amount_minor) === d.amountMinor,
    );
    if (repeat) return repeat;
    const open = await one<{ n: number }>(conn, "SELECT COUNT(*) AS n FROM deposits WHERE client_id = ? AND status IN ('pending', 'second_approval')", [clientId]);
    if (Number(open?.n ?? 0) >= MAX_OPEN_DEPOSITS) {
      throw fieldError("amount", `You already have ${MAX_OPEN_DEPOSITS} deposits waiting for review. Please wait for them to be checked.`);
    }
    const used = sameProof.find((r) => r.status !== "rejected");
    if (used) throw fieldError("file_name", `This screenshot was already sent with request ${used.reference}. Send a screenshot of the new payment.`);
    return null;
  }

  router.post(
    "/deposits",
    auth,
    noImpersonation,
    depositGate,
    mayMoveMoney,
    multipart(IMAGE_FORM_LIMIT, "file_name", PROOF_RULES),
    handler(async (req, res) => {
      const client = clientOf(req);
      // The JSON form is the instant (hosted) checkout, which is not built.
      if (!Buffer.isBuffer(req.body) && req.is("application/json")) throw fieldError("method", "Instant deposits are not available yet. Please choose another method.");
      const form = await readMoneyForm(req, "file_name", NO_PROOF);
      const request = await readDeposit(form, client.id);
      const accepted = (row: DepositRow) =>
        res.status(201).json({ success: true, message: "Your deposit request was sent. We will add the money to your wallet once we confirm the payment.", deposit: presentDeposit(row) });
      // The quick checks first, so a refused request never waits for image processing.
      const repeat = await admitDeposit(db, client.id, request);
      if (repeat) return void accepted(repeat);
      let proof: PreparedProof;
      try {
        proof = await prepareProof(request.original);
      } catch (error) {
        if (error instanceof ProofProblem) throw fieldError("file_name", error.message);
        throw error;
      }

      const stored = await transaction(db, async (conn) => {
        await lockClient(conn, client.id);
        // Checked again with the client row locked: nothing else changes this client's money meanwhile.
        await assertClientMayMoveMoney(conn, client.id);
        const wallet = await lockWallet(conn, client.id);
        const again = await admitDeposit(conn, client.id, request);
        if (again) return { row: again, isNew: false };
        const { method } = request;
        if (!(await one(conn, `${DEPOSIT_METHOD} AND id = ?`, [method.id]))) throw fieldError("method", "Choose a deposit method.");
        const { id, reference } = await withReference("D", async (reference) => {
          const r = await exec(
            conn,
            `INSERT INTO deposits (reference, client_id, wallet_id, payment_method_id, method_name, currency, amount_minor, usd_rate, rate_set_by, amount_cents, network, submitted_ip)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [reference, client.id, wallet.id, method.id, method.name, method.currency, request.amountMinor, request.rate, request.rateSetBy, request.amountCents, request.network, req.clientIp],
          );
          return { id: r.insertId, reference };
        });
        // The stored copy is re-encoded (HEIC becomes JPEG, GIF becomes PNG); its name follows the new type.
        const fileName = proof.mime === proof.sentMime ? request.fileName : `${request.fileName.replace(/\.[A-Za-z0-9]{1,5}$/, "")}.${EXTENSION[proof.mime]}`;
        await exec(conn, "INSERT INTO deposit_proofs (deposit_id, mime, size_bytes, sha256, file_name, editor, bytes_enc) VALUES (?, ?, ?, ?, ?, ?, ?)", [
          id, proof.mime, proof.bytes.length, proof.sha256, fileName.slice(0, 160), proof.editor, encryptBytes(config.dataKey, proof.bytes, depositProofContext(id, client.id, reference)),
        ]);
        await writeAudit(conn, ctx(req), {
          action: "deposit.requested", entityType: "client", entityId: client.id,
          meta: {
            depositId: id, reference, method: method.name, amountMinor: request.amountMinor, currency: method.currency, amountCents: request.amountCents,
            proof: { type: proof.sentMime, bytes: proof.sentBytes, sha256: proof.sha256, editor: proof.editor, stored: { type: proof.mime, bytes: proof.bytes.length, sha256: sha256(proof.bytes) } },
          },
        });
        const paid = method.currency === "USD" ? money(request.amountCents, "USD") : `${money(request.amountMinor, method.currency)} (about ${money(request.amountCents, "USD")})`;
        await notifyClient(conn, client.id, {
          type: "deposit", title: "We received your deposit request", body: `We will check your payment of ${paid} and add it to your wallet.`, link: "/transactions", linkLabel: "View history",
        });
        return { row: (await one<DepositRow>(conn, `${DEPOSIT_ROW} WHERE id = ?`, [id]))!, isNew: true };
      });
      if (stored.isNew) deposits.take(String(client.id));
      accepted(stored.row);
    }),
  );

  // ---------- Withdrawal requests ----------

  /** The client's saved account to pay out to, or the field error that says why it cannot be used. */
  async function usablePayoutMethod(conn: Conn, clientId: number, id: number | null) {
    const payout = id
      ? await one<PayoutMethodRow>(conn, `${PAYOUT_METHOD} WHERE m.id = ? AND m.client_id = ? AND m.deleted_at IS NULL AND t.direction = 'withdrawal'`, [id, clientId])
      : undefined;
    if (!payout) throw fieldError("method", NO_DESTINATION);
    if (!payout.type_enabled) throw fieldError("method", `Withdrawals to ${payout.type_name} accounts are paused. Choose another account or contact support.`);
    return payout;
  }

  router.post(
    "/withdrawals",
    auth,
    noImpersonation,
    withdrawalGate,
    mayMoveMoney,
    express.raw({ type: "multipart/form-data", limit: "64kb" }),
    handler(async (req, res) => {
      const client = clientOf(req);
      const form = await readMoneyForm(req, "method", NO_DESTINATION);
      const methodId = formId(form.values.method);
      await usablePayoutMethod(db, client.id, methodId);
      const wallet = await walletOf(db, client.id);
      if (formText(form.values.wallet_key)?.trim() !== wallet.wallet_key) throw fieldError("wallet_key", REFRESH);
      const amount = parseAmount(form.values.amount);
      if ("problem" in amount) throw fieldError("amount", AMOUNT_MESSAGES[amount.problem]);
      const cents = amount.minor;
      const checkLimits = (s: Awaited<ReturnType<typeof loadMoneySettings>>) => {
        if (cents < s.min_withdrawal_cents) throw fieldError("amount", `The minimum withdrawal is ${money(s.min_withdrawal_cents, "USD")}.`);
        if (s.max_withdrawal_cents !== null && cents > s.max_withdrawal_cents) throw fieldError("amount", `The maximum withdrawal is ${money(s.max_withdrawal_cents, "USD")}.`);
      };
      checkLimits(await loadMoneySettings(db));
      const code = formText(form.values.verification_code)?.trim() ?? "";
      if (!code) throw fieldError("verification_code", "Enter the code we emailed you.");
      if (code.length > 12) throw fieldError("verification_code", WRONG_CODE);
      // In its own transaction, so a wrong guess is counted even though this request then fails.
      if (!(await transaction(db, (conn) => checkEmailCode(conn, config, client.email, "withdrawal", code, false, client.id)))) throw fieldError("verification_code", WRONG_CODE);

      const row = await transaction(db, async (conn) => {
        await lockClient(conn, client.id);
        await assertClientMayMoveMoney(conn, client.id);
        const profile = (await loadClient(conn, client.id))!;
        const locked = await lockWallet(conn, client.id);
        // Read again under the locks: every change to saved payout accounts takes the client row lock first.
        const payout = await usablePayoutMethod(conn, client.id, methodId);
        const { accountNumber, iban, unreadable } = openPayoutMethod(config, payout);
        // Details that cannot be read are never sent on as an empty destination.
        if (unreadable || !accountNumber) throw fieldError("method", "This account could not be read. Remove it and add it again.");
        const settings = await loadMoneySettings(conn);
        checkLimits(settings);
        if (locked.available_cents < cents) throw fieldError("amount", `This is more than your available balance of ${money(locked.available_cents, "USD")}.`);
        const open = await one<{ n: number }>(conn, "SELECT COUNT(*) AS n FROM withdrawals WHERE client_id = ? AND status IN ('pending', 'second_approval', 'approved')", [client.id]);
        if (Number(open?.n ?? 0) >= MAX_OPEN_WITHDRAWALS) {
          throw fieldError("amount", `You already have ${MAX_OPEN_WITHDRAWALS} withdrawals in progress. Please wait for them to finish.`);
        }
        // Used up together with the hold: both happen, or neither does.
        if (!(await checkEmailCode(conn, config, client.email, "withdrawal", code, true, client.id))) throw fieldError("verification_code", WRONG_CODE);
        const paidBefore = await one(conn, "SELECT id FROM withdrawals WHERE client_id = ? AND status = 'paid' LIMIT 1", [client.id]);
        const needsSecond = cents > settings.withdrawal_second_approval_cents || (settings.first_withdrawal_second_approval && !paidBefore);
        // A copy of the destination as it is now, so a later edit cannot redirect this withdrawal.
        const destination = {
          methodName: payout.method_name, typeName: payout.type_name, kind: payout.kind, network: payout.network, accountName: payout.account_name,
          accountNumber, iban, swift: payout.swift, payoutMethodId: payout.id, qrToken: payout.qr_token,
        };
        const { id, reference } = await withReference("W", async (reference) => {
          const r = await exec(
            conn,
            `INSERT INTO withdrawals (reference, client_id, wallet_id, payout_method_id, payment_method_id, method_name, amount_cents, needs_second_approval,
               destination_enc, destination_fingerprint, requested_ip)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)`,
            [reference, client.id, locked.id, payout.id, payout.payment_method_id, payout.method_name, cents, needsSecond ? 1 : 0, payout.fingerprint, req.clientIp],
          );
          return { id: r.insertId, reference };
        });
        // Sealed once the row exists, as the copy is bound to its id.
        await exec(conn, "UPDATE withdrawals SET destination_enc = ? WHERE id = ?", [
          encryptField(config.dataKey, JSON.stringify(destination), withdrawalDestinationContext(id, client.id, reference)),
          id,
        ]);
        await postLedger(conn, { kind: "withdrawal_hold", sourceType: "withdrawal", sourceId: id, clientId: client.id, staffId: null, memo: `Withdrawal ${reference}` }, [
          { account: walletAccount(client.id), amount: -cents },
          { account: holdAccount(client.id), amount: cents },
        ]);
        await writeAudit(conn, ctx(req), {
          action: "withdrawal.requested", entityType: "client", entityId: client.id,
          meta: { withdrawalId: id, reference, amountCents: cents, method: payout.method_name, type: payout.type_name, accountEnding: lastFour(accountNumber), needsSecondApproval: needsSecond },
        });
        const where = `${money(cents, "USD")} to your ${payout.method_name} account ${endingOf(accountNumber)}`.trim();
        await notifyClient(conn, client.id, {
          type: "withdrawal", title: "We received your withdrawal request", body: `${where}. We will let you know when it is sent.`, link: "/transactions", linkLabel: "View history",
        });
        await queueEmail(conn, config, {
          to: profile.email, template: "withdrawal_requested", subject: "We received your withdrawal request", clientId: client.id,
          text: `Hello ${profile.first_name},\n\nWe received your request to withdraw ${where}. We will let you know when it is sent.\n\nIf you did not ask for this, contact support straight away and change your password.\n\nBIS Markets`,
        });
        return (await one<WithdrawalRow>(conn, `${WITHDRAWAL_ROW} WHERE id = ?`, [id]))!;
      });
      withdrawals.take(String(client.id));
      res.status(201).json({ success: true, message: "Your withdrawal request was sent.", withdrawal: presentWithdrawal(row) });
    }),
  );

  // ---------- Saved payout accounts ----------

  const loadPayoutMethod = (conn: Conn, clientId: number, id: number) =>
    one<PayoutMethodRow>(conn, `${PAYOUT_METHOD} WHERE m.id = ? AND m.client_id = ? AND m.deleted_at IS NULL`, [id, clientId]);

  /**
   * A payout type the client may save an account for. `anyState` allows a disabled one (an account already saved under it).
   * `lock` holds it while the account is saved, so staff cannot change its network meanwhile.
   */
  async function payoutType(conn: Conn, id: number | null, anyState = false, lock = false) {
    const type = id ? await one<PayoutTypeRow>(conn, `${PAYOUT_TYPE} AND id = ?${lock ? " FOR SHARE" : ""}`, [id]) : undefined;
    if (!type || (!anyState && !type.is_enabled)) throw fieldError("payment_method_id", NO_TYPE);
    return type;
  }

  /** The QR picture of a wallet address, re-encoded like a payment proof, or null when none was sent. */
  async function readQr(form: MoneyForm): Promise<PreparedProof | null> {
    const file = form.files.get("file_name");
    if (!file) return null;
    const original = Buffer.from(await file.arrayBuffer());
    if (!original.length || original.length > PROOF_MAX_BYTES || !proofType(original)) throw fieldError("file_name", QR_RULES);
    try {
      return await prepareProof(original);
    } catch (error) {
      if (!(error instanceof ProofProblem)) throw error;
      if (/too small/.test(error.message)) throw fieldError("file_name", "This QR code picture is too small. Upload a larger picture of it.");
      if (/too large/.test(error.message)) throw fieldError("file_name", error.message);
      throw fieldError("file_name", `This picture could not be opened. ${QR_RULES}`);
    }
  }

  const countSaved = async (conn: Conn, clientId: number) =>
    Number((await one<{ n: number }>(conn, "SELECT COUNT(*) AS n FROM client_payout_methods WHERE client_id = ? AND deleted_at IS NULL", [clientId]))?.n ?? 0);
  const tooMany = () => fieldError("payment_method_id", `You can save up to ${MAX_PAYOUT_METHODS} payout accounts. Remove one to add another.`);
  const inUse = async (conn: Conn, payoutMethodId: number) =>
    Boolean(await one(conn, `SELECT id FROM withdrawals WHERE payout_method_id = ? AND status IN (${OPEN_WITHDRAWALS.map(() => "?").join(", ")}) LIMIT 1`, [payoutMethodId, ...OPEN_WITHDRAWALS]));

  /** The create and update answer: the portal reads data (or the root), the app reads id. */
  const payoutEnvelope = (p: ReturnType<typeof presentPayoutMethod>) => ({
    success: true, message: "Payout account saved.", data: p, user_payment_method: p, id: p.id, method_name: p.method_name, created_at: p.created_at,
  });

  /** Tells the client an account can now receive their money, in the bell and by email. */
  async function warnNewDestination(conn: Conn, clientId: number, f: PayoutFields, change: "added" | "changed") {
    const profile = (await loadClient(conn, clientId))!;
    const account = `${f.method_name} ${endingOf(f.account_number)}`.trim();
    await notifyClient(conn, clientId, {
      type: "security",
      title: change === "added" ? "A payout account was added" : "A payout account was changed",
      body: `${account} can now receive withdrawals. If this was not you, contact support straight away.`,
    });
    await queueEmail(conn, config, {
      to: profile.email, template: change === "added" ? "payout_method_added" : "payout_method_updated", clientId,
      subject: change === "added" ? "A payout account was added to your BIS Markets account" : "A payout account on your BIS Markets account was changed",
      text: `Hello ${profile.first_name},\n\nA payout account was ${change} on your BIS Markets account: ${account}. Withdrawals can now be sent to it.\n\nIf this was not you, contact support straight away and change your password.\n\nBIS Markets`,
    });
  }

  const sealedDetails = (id: number, clientId: number, typeId: number, f: PayoutFields) => ({
    account: encryptField(config.dataKey, f.account_number, payoutAccountContext(id, clientId)),
    iban: f.iban ? encryptField(config.dataKey, f.iban, payoutIbanContext(id, clientId)) : null,
    fingerprint: destinationFingerprint(config.dataKey, typeId, f.iban || f.account_number),
  });

  router.post(
    "/user-payment-methods",
    auth,
    noImpersonation,
    payoutGate,
    mayMoveMoney,
    multipart(IMAGE_FORM_LIMIT, "file_name", QR_RULES),
    handler(async (req, res) => {
      const client = clientOf(req);
      const form = await readMoneyForm(req, "payment_method_id", NO_TYPE);
      const type = await payoutType(db, formId(form.values.payment_method_id));
      const fields = validate(payoutFields(type), form.values);
      if ((await countSaved(db, client.id)) >= MAX_PAYOUT_METHODS) throw tooMany();
      // A QR picture only means something for a crypto wallet.
      const qr = type.kind === "crypto" ? await readQr(form) : null;
      if (type.ask_qr && !qr) throw fieldError("file_name", QR_MISSING);

      const id = await transaction(db, async (conn) => {
        await lockClient(conn, client.id);
        await assertClientMayMoveMoney(conn, client.id);
        // Checked again against the type as it is now: staff may have changed it while the picture was read.
        const lockedType = await payoutType(conn, type.id, false, true);
        const fields = validate(payoutFields(lockedType), form.values);
        if (lockedType.ask_qr && !qr) throw fieldError("file_name", QR_MISSING);
        const saved = await countSaved(conn, client.id);
        if (saved >= MAX_PAYOUT_METHODS) throw tooMany();
        const isDefault = saved === 0 || formFlag(form.values.is_default) === true;
        const token = qr ? newQrToken() : null;
        // Inserted first, as the sealed details are bound to the row's id.
        const r = await exec(
          conn,
          `INSERT INTO client_payout_methods (client_id, payment_method_id, method_name, account_name, account_number_enc, iban_enc, swift, fingerprint, qr_mime, qr_bytes_enc, qr_token, is_default, created_ip)
           VALUES (?, ?, ?, ?, '', NULL, ?, '', ?, ?, ?, ?, ?)`,
          [
            client.id, lockedType.id, fields.method_name, fields.account_name, fields.swift,
            qr?.mime ?? null, qr && token ? encryptBytes(config.dataKey, qr.bytes, payoutQrContext(client.id, token)) : null, token, isDefault ? 1 : 0, req.clientIp,
          ],
        );
        const sealed = sealedDetails(r.insertId, client.id, lockedType.id, fields);
        await exec(conn, "UPDATE client_payout_methods SET account_number_enc = ?, iban_enc = ?, fingerprint = ? WHERE id = ?", [sealed.account, sealed.iban, sealed.fingerprint, r.insertId]);
        if (isDefault) await exec(conn, "UPDATE client_payout_methods SET is_default = 0 WHERE client_id = ? AND id <> ? AND is_default = 1", [client.id, r.insertId]);
        await writeAudit(conn, ctx(req), {
          action: "payout_method.added", entityType: "client", entityId: client.id,
          meta: { id: r.insertId, type: lockedType.name, kind: lockedType.kind, ending: lastFour(fields.account_number), qr: Boolean(qr), default: isDefault },
        });
        await warnNewDestination(conn, client.id, fields, "added");
        return r.insertId;
      });
      payoutChanges.take(String(client.id));
      res.status(201).json(payoutEnvelope(presentPayoutMethod(config, (await loadPayoutMethod(db, client.id, id))!)));
    }),
  );

  /** What an update asks for, merged over the saved account: a field that is not sent keeps its value. */
  async function readPayoutUpdate(conn: Conn, before: PayoutMethodRow, form: MoneyForm, lock = false) {
    const typeId = form.values.payment_method_id === undefined ? before.payment_method_id : formId(form.values.payment_method_id);
    // Keeping an account under a type that was switched off is fine; moving one to it is not.
    const type = await payoutType(conn, typeId, typeId === before.payment_method_id, lock);
    const opened = openPayoutMethod(config, before);
    const current: Record<string, unknown> = { method_name: before.method_name, account_name: before.account_name, account_number: opened.accountNumber, iban: opened.iban, swift: before.swift };
    for (const key of ["method_name", "account_name", "account_number", "iban", "swift"]) if (form.values[key] !== undefined) current[key] = form.values[key];
    const fields = validate(payoutFields(type), current);
    const changed = [
      fields.method_name !== before.method_name && "method_name",
      fields.account_name !== before.account_name && "account_name",
      fields.account_number !== opened.accountNumber && "account_number",
      fields.iban !== opened.iban && "iban",
      fields.swift !== before.swift && "swift",
      type.id !== before.payment_method_id && "payment_method_id",
    ].filter((f): f is string => Boolean(f));
    return { type, fields, changed };
  }

  router.post(
    "/user-payment-methods/:id",
    auth,
    noImpersonation,
    payoutGate,
    mayMoveMoney,
    multipart(IMAGE_FORM_LIMIT, "file_name", QR_RULES),
    handler(async (req, res) => {
      const client = clientOf(req);
      const id = formId(req.params.id);
      if (!id) throw payoutNotFound();
      const form = await readMoneyForm(req, "payment_method_id", NO_TYPE);
      const first = await loadPayoutMethod(db, client.id, id);
      if (!first) throw payoutNotFound();
      // The quick checks first, so a refused change never waits for image processing.
      const preview = await readPayoutUpdate(db, first, form);
      const qr = preview.type.kind === "crypto" ? await readQr(form) : null;

      const saved = await transaction(db, async (conn) => {
        await lockClient(conn, client.id);
        await assertClientMayMoveMoney(conn, client.id);
        const before = await loadPayoutMethod(conn, client.id, id);
        if (!before) throw payoutNotFound();
        const { type, fields, changed } = await readPayoutUpdate(conn, before, form, true);
        // A QR picture of the old address no longer matches: it goes unless a new one comes with the change.
        const keepQr = !changed.includes("account_number") && !changed.includes("payment_method_id") && type.kind === "crypto";
        const dropQr = !qr && Boolean(before.qr_token) && !keepQr;
        if (qr || dropQr) changed.push("qr");
        if (type.ask_qr && changed.includes("payment_method_id") && !qr) throw fieldError("file_name", QR_MISSING);
        // A type that asks for the QR code never ends up with changed details and no QR code on file.
        const hasQr = Boolean(qr) || (Boolean(before.qr_token) && !dropQr);
        if (type.ask_qr && !hasQr && changed.some((f) => f !== "method_name")) {
          throw fieldError(changed.includes("account_number") ? "account_number" : "file_name", QR_KEPT);
        }
        const detailsChanged = changed.some((f) => f !== "method_name");
        // The withdrawal keeps a copy of the account details, but staff see the QR picture from here.
        if (detailsChanged && (await inUse(conn, id))) throw fieldError("method", IN_USE);
        const flag = formFlag(form.values.is_default);
        const defaultChanged = flag !== undefined && flag !== (before.is_default === 1);
        if (!changed.length && !defaultChanged) return false;

        const sets: [string, unknown][] = [["method_name", fields.method_name]];
        if (detailsChanged) {
          const sealed = sealedDetails(id, client.id, type.id, fields);
          sets.push(["payment_method_id", type.id], ["account_name", fields.account_name], ["account_number_enc", sealed.account], ["iban_enc", sealed.iban], ["swift", fields.swift], ["fingerprint", sealed.fingerprint]);
        }
        if (qr) {
          const token = newQrToken();
          sets.push(["qr_mime", qr.mime], ["qr_bytes_enc", encryptBytes(config.dataKey, qr.bytes, payoutQrContext(client.id, token))], ["qr_token", token]);
        } else if (dropQr) {
          sets.push(["qr_mime", null], ["qr_bytes_enc", null], ["qr_token", null]);
        }
        if (flag !== undefined) sets.push(["is_default", flag ? 1 : 0]);
        await exec(
          conn,
          `UPDATE client_payout_methods SET ${sets.map(([k]) => `\`${k}\` = ?`).join(", ")}${detailsChanged ? ", details_changed_at = CURRENT_TIMESTAMP(3)" : ""} WHERE id = ?`,
          [...sets.map(([, v]) => v), id],
        );
        if (flag === true) await exec(conn, "UPDATE client_payout_methods SET is_default = 0 WHERE client_id = ? AND id <> ? AND is_default = 1", [client.id, id]);
        await writeAudit(conn, ctx(req), {
          action: "payout_method.updated", entityType: "client", entityId: client.id,
          // Which fields changed, never their values.
          meta: { id, type: type.name, ending: lastFour(fields.account_number), fields: changed, ...(defaultChanged ? { default: flag } : {}) },
        });
        if (detailsChanged) await warnNewDestination(conn, client.id, fields, "changed");
        return true;
      });
      if (saved) payoutChanges.take(String(client.id));
      res.json(payoutEnvelope(presentPayoutMethod(config, (await loadPayoutMethod(db, client.id, id))!)));
    }),
  );

  router.delete(
    "/user-payment-methods/:id",
    auth,
    noImpersonation,
    payoutGate,
    mayMoveMoney,
    handler(async (req, res) => {
      const client = clientOf(req);
      const id = formId(req.params.id);
      if (!id) throw payoutNotFound();
      await transaction(db, async (conn) => {
        await lockClient(conn, client.id);
        await assertClientMayMoveMoney(conn, client.id);
        const before = await loadPayoutMethod(conn, client.id, id);
        if (!before) throw payoutNotFound();
        if (await inUse(conn, id)) throw fieldError("method", IN_USE_REMOVE);
        // Kept for the withdrawals that used it; the QR link stops working.
        await exec(conn, "UPDATE client_payout_methods SET deleted_at = CURRENT_TIMESTAMP(3), is_default = 0 WHERE id = ?", [id]);
        if (before.is_default) {
          const next = await one<{ id: number }>(conn, "SELECT id FROM client_payout_methods WHERE client_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1", [client.id]);
          if (next) await exec(conn, "UPDATE client_payout_methods SET is_default = 1 WHERE id = ?", [next.id]);
        }
        const { accountNumber } = openPayoutMethod(config, before);
        await writeAudit(conn, ctx(req), {
          action: "payout_method.removed", entityType: "client", entityId: client.id, meta: { id, type: before.type_name, ending: lastFour(accountNumber) },
        });
      });
      payoutChanges.take(String(client.id));
      res.json({ success: true, message: "Payout account removed." });
    }),
  );

  return router;
}

