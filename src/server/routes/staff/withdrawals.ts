import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { NOT_PLAIN, WITHDRAWAL_CHECKLIST, WITHDRAWAL_REJECT_REASONS, type WithdrawalStatus } from "@shared/money";
import type { Permission } from "@shared/permissions";
import type { AppDeps } from "../../app";
import { lockClient } from "../../clients/kyc";
import { clientName, type ClientRow } from "../../clients/model";
import { notifyClient } from "../../clients/notifications";
import { auditContext, writeAudit } from "../../lib/audit";
import { decryptBytes, sha256 } from "../../lib/crypto";
import { exec, one, rows, transaction, type Conn } from "../../lib/db";
import { queueEmail } from "../../lib/email";
import { queueSupportEvent } from "../../lib/events";
import { badRequest, conflict, forbidden, handler, HttpError, notFound, parse, unauthorized } from "../../lib/http";
import { likeTerm, listQuery, toPage } from "../../lib/pagination";
import { activeClaim, assertNotClaimedByOther, claim, CLAIM_MINUTES, release } from "../../lib/review";
import { money } from "../../money/amounts";
import { holdAccount, lockWallet, payoutAccount, postLedger, walletAccount } from "../../money/ledger";
import { compareNames } from "../../money/names";
import { normalizeAccount } from "../../money/references";
import { appendNote, assertMoneyCanMove, checklistOf, clientScope, endingOf, inScope, internalNote, masked, moneyId, reasonText, staffMoneyBlock } from "../../money/review";
import { loadMoneySettings, type MoneySettings } from "../../money/settings";
import { requirePermission, requireStepUp, staffActor, staffOf, type StaffContext } from "../../staff/session";

// The withdrawal queue. The client's money is held when they ask; staff check
// the request (twice above the limit or on a first withdrawal), send the money
// outside the CRM, and record the payout reference, which moves the held money
// out of the client's account. A rejection before payment puts it back in the
// wallet. Every withdrawal passes two different people before money leaves:
// two approvals, or one approval and a different payer.

const OPEN: readonly WithdrawalStatus[] = ["pending", "second_approval", "approved"];
const TAB_NAMES = ["open", "review", "second_approval", "to_pay", "paid", "rejected", "all"] as const;
type Tab = (typeof TAB_NAMES)[number];
/** The list's status filter: the working queues, the finished ones, or everything. */
const TABS: Record<Tab, readonly WithdrawalStatus[] | null> = {
  open: OPEN,
  review: ["pending"],
  second_approval: ["second_approval"],
  to_pay: ["approved"],
  paid: ["paid"],
  rejected: ["rejected"],
  all: null,
};
const QUEUE_TABS = new Set<Tab>(["open", "review", "second_approval", "to_pay"]);

/** Seeing a withdrawal's full destination (and its QR code) is for the people who check and pay it. */
const PAYOUT_PERMISSIONS: Permission[] = ["withdrawal.process", "withdrawal.approve", "withdrawal.pay"];
const seesFull = (staff: StaffContext) => PAYOUT_PERMISSIONS.some((p) => staff.permissions.has(p));

const NOT_FOUND = "That withdrawal does not exist or its client is not assigned to you.";
const UNREADABLE = "The destination of this withdrawal could not be read, so it cannot be approved or paid. You can still reject it.";
const SAME_PERSON = "You gave the first approval, so another person must give the second.";
const TWO_PERSON = "You approved this withdrawal on your own, so another person must pay it.";
const NO_HOLD = "This withdrawal's money is not on hold in the ledger, so it cannot be paid. Ask an administrator to check the ledger.";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// What staff type is shown to the client exactly as written, in the app as well as the portal.
const PLAIN = "Write it as plain text, without links or symbols like < > { }";
const payoutReferenceField = z
  .string({ required_error: "Enter the payout reference from the bank or the wallet" })
  .trim()
  .min(2, "Enter the payout reference from the bank or the wallet")
  .max(120, "Keep the payout reference under 120 characters")
  .refine((v) => !NOT_PLAIN.test(v), PLAIN);

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** The day the money was sent: a real date, not in the future (anywhere on earth), at most 30 days ago. */
const paidOnField = z
  .string({ required_error: "Enter the date the money was sent" })
  .trim()
  .superRefine((v, ctx) => {
    const ms = /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T00:00:00Z`) : Number.NaN;
    if (Number.isNaN(ms) || isoDay(ms) !== v) return void ctx.addIssue({ code: "custom", message: "Enter the date as YYYY-MM-DD" });
    if (v > isoDay(Date.now() + 14 * HOUR)) return void ctx.addIssue({ code: "custom", message: "The date the money was sent cannot be in the future" });
    if (v < isoDay(Date.now() - 30 * DAY)) ctx.addIssue({ code: "custom", message: "The date the money was sent must be within the last 30 days" });
  });

const requiredNote = internalNote.refine((v): v is string => v !== null, "Write a note saying what needs another look");

interface NoteEntry {
  at: string;
  by?: number;
  byName?: string;
  stage: string;
  text: string;
}

interface Row {
  id: number;
  reference: string;
  client_id: number;
  wallet_id: number;
  payout_method_id: number;
  payment_method_id: number;
  method_name: string;
  status: WithdrawalStatus;
  amount_cents: number;
  needs_second_approval: number;
  destination_enc: Buffer;
  destination_fingerprint: string;
  reject_reason: string | null;
  checklist: Partial<Record<"first" | "second" | "pay", string[]>> | null;
  notes: NoteEntry[] | null;
  first_reviewed_by: number | null;
  first_reviewed_at: Date | null;
  first_reviewer_name: string | null;
  approved_by: number | null;
  approved_at: Date | null;
  approver_name: string | null;
  paid_by: number | null;
  paid_at: Date | null;
  payer_name: string | null;
  payout_reference: string | null;
  paid_on: string | null;
  decided_by: number | null;
  decided_at: Date | null;
  decider_name: string | null;
  claimed_by: number | null;
  claimed_until: Date | null;
  claimer_name: string | null;
  created_at: Date;
  first_name: string;
  last_name: string;
  email: string;
  client_status: ClientRow["status"];
  kyc_status: ClientRow["kyc_status"];
  country: string | null;
  assigned_staff_id: number | null;
  client_created_at: Date;
  type_name: string;
  kind: "bank" | "crypto";
  type_network: string;
  /** Whether the client has another withdrawal that was paid (so this is not their first). */
  paid_before: number;
}

const SELECT = `SELECT w.id, w.reference, w.client_id, w.wallet_id, w.payout_method_id, w.payment_method_id, w.method_name, w.status, w.amount_cents,
  w.needs_second_approval, w.destination_enc, w.destination_fingerprint, w.reject_reason, w.checklist, w.notes,
  w.first_reviewed_by, w.first_reviewed_at, fr.name AS first_reviewer_name, w.approved_by, w.approved_at, ap.name AS approver_name,
  w.paid_by, w.paid_at, pb.name AS payer_name, w.payout_reference, DATE_FORMAT(w.paid_on, '%Y-%m-%d') AS paid_on,
  w.decided_by, w.decided_at, dc.name AS decider_name, w.claimed_by, w.claimed_until, cl.name AS claimer_name, w.created_at,
  c.first_name, c.last_name, c.email, c.status AS client_status, c.kyc_status, c.country, c.assigned_staff_id, c.created_at AS client_created_at,
  pm.name AS type_name, pm.kind, pm.network AS type_network,
  EXISTS (SELECT 1 FROM withdrawals p WHERE p.client_id = w.client_id AND p.status = 'paid' AND p.id <> w.id) AS paid_before
  FROM withdrawals w JOIN clients c ON c.id = w.client_id JOIN payment_methods pm ON pm.id = w.payment_method_id
  LEFT JOIN staff_users fr ON fr.id = w.first_reviewed_by LEFT JOIN staff_users ap ON ap.id = w.approved_by LEFT JOIN staff_users pb ON pb.id = w.paid_by
  LEFT JOIN staff_users dc ON dc.id = w.decided_by LEFT JOIN staff_users cl ON cl.id = w.claimed_by`;

/** Where the money goes, copied (encrypted) when the client asked, so a later edit cannot redirect it. */
interface Destination {
  methodName: string;
  typeName: string;
  kind: "bank" | "crypto";
  network: string;
  accountName: string;
  accountNumber: string;
  iban: string;
  swift: string;
  payoutMethodId: number | null;
  qrToken: string | null;
}

const NETWORK_LABELS: Record<string, string> = { trc20: "TRC20", bep20: "BEP20", binance_pay: "Binance Pay" };
const networkLabel = (v: string | null | undefined) => (v ? (NETWORK_LABELS[v] ?? v) : "");
const KIND_WORD = { bank: "bank", crypto: "crypto" } as const;
const lastFour = (v: string) => v.replace(/\s+/g, "").slice(-4);
const person = (id: number | null, name: string | null) => (id ? { id, name: name ?? "Staff" } : null);
const longDate = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const listWords = (words: string[]) => (words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}` : (words[0] ?? ""));
const usd = (cents: number) => money(cents, "USD");

type Warning = { tone: "bad" | "warn" | "info"; text: string; href?: string };
const TONE_ORDER = { bad: 0, warn: 1, info: 2 } as const;

// Account changes that often come before a fraudulent withdrawal.
const SECURITY_ACTIONS: Record<string, string> = {
  "client.password_reset": "password reset",
  "client.email_changed": "email address changed",
  "staff.email_changed": "email address changed by staff",
  "staff.verified_changed": "verified details changed by staff",
  "payout_method.added": "payout account added",
  "payout_method.updated": "payout account changed",
};

type Action = "approve" | "secondApprove" | "pay" | "reject" | "returnToReview";
const STAGE: Partial<Record<WithdrawalStatus, "review" | "second" | "pay">> = { pending: "review", second_approval: "second", approved: "pay" };

/** Who alone approved this withdrawal for payment, or null when two people did. */
const soleApprover = (r: Pick<Row, "first_reviewed_by" | "approved_by">) =>
  r.approved_by !== null && (r.first_reviewed_by === null || r.first_reviewed_by === r.approved_by) ? r.approved_by : null;

/** Why the item is not at the step an action needs, in words for the reviewer. */
function notAt(r: Row): HttpError {
  switch (r.status) {
    case "paid":
      return conflict(`This withdrawal was already paid${r.payer_name ? ` by ${r.payer_name}` : ""}.`);
    case "rejected":
      return conflict(`This withdrawal was already rejected${r.decider_name ? ` by ${r.decider_name}` : ""}.`);
    case "pending":
      return conflict("This withdrawal is waiting for its first review.");
    case "second_approval":
      return conflict("This withdrawal is waiting for a second approval.");
    case "approved":
      return conflict("This withdrawal is already approved and waiting to be paid.");
  }
}

/**
 * Why this staff member may not take this action on this withdrawal now, or
 * null. The decision routes throw it (after locking) and GET /:id shows the
 * same text, so the panel and the server always agree.
 */
function blockFor(action: Action, staff: StaffContext, r: Row, d: Destination | null): HttpError | null {
  const has = (p: Permission) => staff.permissions.has(p);
  const moneyBlock = () => {
    const block = staffMoneyBlock({ status: r.client_status, kyc_status: r.kyc_status });
    return block ? badRequest(block) : d ? null : badRequest(UNREADABLE);
  };
  switch (action) {
    case "approve":
      if (!has("withdrawal.process")) return forbidden("Approving withdrawals needs the \"check and approve withdrawals\" permission.");
      if (r.status !== "pending") return notAt(r);
      return moneyBlock();
    case "secondApprove":
      if (!has("withdrawal.approve")) return forbidden("The second approval needs the \"second approval on withdrawals\" permission.");
      if (r.status !== "second_approval") return notAt(r);
      if (r.first_reviewed_by === staff.id) return forbidden(SAME_PERSON);
      return moneyBlock();
    case "pay":
      if (!has("withdrawal.pay")) return forbidden("Recording a payment needs the \"record withdrawals as paid\" permission.");
      if (r.status !== "approved") return notAt(r);
      if (r.approved_by === null) return conflict("This withdrawal has no recorded approval, so it cannot be paid.");
      if (soleApprover(r) === staff.id) return forbidden(TWO_PERSON);
      return moneyBlock();
    case "reject":
      if (!has("withdrawal.reject")) return forbidden("Rejecting withdrawals needs the \"reject withdrawals\" permission.");
      if (!OPEN.includes(r.status)) return notAt(r);
      return null;
    case "returnToReview":
      if (!has("withdrawal.approve")) return forbidden("Sending a withdrawal back needs the \"second approval on withdrawals\" permission.");
      if (r.status !== "second_approval") return notAt(r);
      return null;
  }
}

/**
 * Why a withdrawal needs a second approval, from the rules: what was decided
 * when the client asked, the current limit, and the first-withdrawal rule.
 * Empty when one approval is enough.
 */
function secondApprovalReasons(r: Row, settings: MoneySettings): string[] {
  const reasons: string[] = [];
  if (r.needs_second_approval) reasons.push("It was marked for a second approval when the client asked or when it was sent back.");
  if (Number(r.amount_cents) > settings.withdrawal_second_approval_cents) reasons.push(`It is above the second-approval limit of ${usd(settings.withdrawal_second_approval_cents)}.`);
  if (settings.first_withdrawal_second_approval && !r.paid_before) reasons.push("It is the client's first withdrawal.");
  return reasons;
}

/** The withdrawal queue: check, approve (twice when needed), pay and record the payout, or reject. */
export function staffWithdrawalsRouter(deps: AppDeps): Router {
  const { db, config } = deps;
  const router = Router();
  const stepUp = requireStepUp(config);
  const view = requirePermission("withdrawal.view");
  /** Any of the permissions that act on a withdrawal (claims, "next", the QR code). */
  const actOn = (req: Request, _res: Response, next: NextFunction) => {
    const staff = req.staff;
    if (!staff) return next(unauthorized());
    next(staff.permissions.has("withdrawal.view") && seesFull(staff) ? undefined : forbidden());
  };
  const ctx = (req: Request) => auditContext(req, staffActor(staffOf(req)));

  async function loadVisible(staff: StaffContext, withdrawalId: number, conn: Conn = db, lock = false) {
    const s = clientScope(staff);
    const row = await one<Row>(conn, `${SELECT} WHERE w.id = ?${s.sql}${lock ? " FOR UPDATE OF w" : ""}`, [withdrawalId, ...s.params]);
    if (!row) throw notFound(NOT_FOUND);
    return row;
  }

  /**
   * Lock order for every change: the client row, then the wallet, then the
   * withdrawal. The client id is read first, before the transaction starts (it
   * never changes): read inside it, the read would fix the snapshot before the
   * locks are taken, and read through the pool, a transaction would wait for a
   * second connection while holding one, which hangs the server once every
   * connection does.
   */
  async function clientOfWithdrawal(withdrawalId: number) {
    const ref = await one<{ client_id: number }>(db, "SELECT client_id FROM withdrawals WHERE id = ?", [withdrawalId]);
    if (!ref) throw notFound(NOT_FOUND);
    return ref.client_id;
  }

  async function lockClientOf(conn: Conn, clientId: number) {
    await lockClient(conn, clientId);
    await lockWallet(conn, clientId);
  }

  /** The destination snapshot, or null when it cannot be decrypted (then nothing may be approved or paid). */
  function readDestination(r: Pick<Row, "reference" | "destination_enc" | "kind" | "type_name" | "type_network" | "method_name">): Destination | null {
    try {
      const raw = JSON.parse(decryptBytes(config.dataKey, r.destination_enc, `withdrawal:${r.reference}`).toString("utf8")) as Record<string, unknown>;
      const text = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : "");
      const payoutMethodId = Number(raw.payoutMethodId);
      return {
        methodName: text("methodName") || r.method_name,
        typeName: text("typeName") || r.type_name,
        kind: raw.kind === "bank" || raw.kind === "crypto" ? raw.kind : r.kind,
        network: networkLabel(text("network") || r.type_network),
        accountName: text("accountName"),
        accountNumber: text("accountNumber"),
        iban: text("iban"),
        swift: text("swift"),
        payoutMethodId: Number.isSafeInteger(payoutMethodId) && payoutMethodId > 0 ? payoutMethodId : null,
        qrToken: /^[0-9a-f]{32}$/.test(text("qrToken")) ? text("qrToken") : null,
      };
    } catch {
      return null;
    }
  }

  const present = (r: Row, settings: MoneySettings, d: Destination | null) => {
    // Pending: what the rules say now. Later: whether it went (or goes) through two approvals.
    const needsSecondApproval =
      r.status === "second_approval" || (r.approved_by !== null ? soleApprover(r) === null : secondApprovalReasons(r, settings).length > 0);
    const account = d ? d.accountNumber || d.iban : "";
    return {
      id: r.id,
      reference: r.reference,
      clientId: r.client_id,
      clientName: clientName(r),
      clientEmail: r.email,
      clientStatus: r.client_status,
      kycStatus: r.kyc_status,
      methodName: d?.methodName ?? r.method_name,
      typeName: d?.typeName ?? r.type_name,
      kind: d?.kind ?? r.kind,
      network: d?.network ?? networkLabel(r.type_network),
      amountCents: Number(r.amount_cents),
      status: r.status,
      needsSecondApproval,
      firstReviewedBy: person(r.first_reviewed_by, r.first_reviewer_name),
      approvedBy: person(r.approved_by, r.approver_name),
      paidBy: person(r.paid_by, r.payer_name),
      createdAt: r.created_at.toISOString(),
      approvedAt: r.approved_at?.toISOString() ?? null,
      paidAt: r.paid_at?.toISOString() ?? null,
      claimedBy: activeClaim(r) ? { id: r.claimed_by!, name: r.claimer_name, until: r.claimed_until!.toISOString() } : null,
      destinationEnding: account ? lastFour(account) : null,
      firstReviewedAt: r.first_reviewed_at?.toISOString() ?? null,
      decidedBy: person(r.decided_by, r.decider_name),
      decidedAt: r.decided_at?.toISOString() ?? null,
    };
  };

  interface PayoutRow {
    id: number;
    client_id: number;
    fingerprint: string;
    qr_token: string | null;
    created_at: Date;
    details_changed_at: Date;
    deleted_at: Date | null;
  }

  const payoutMethodOf = (r: Row) =>
    one<PayoutRow>(db, "SELECT id, client_id, fingerprint, qr_token, created_at, details_changed_at, deleted_at FROM client_payout_methods WHERE id = ?", [r.payout_method_id]);

  /** The QR image is shown only while it is still the one the client had when they asked. */
  const qrStillSame = (r: Row, d: Destination | null, payout: PayoutRow | undefined) =>
    Boolean(d?.qrToken && payout && payout.client_id === r.client_id && payout.qr_token === d.qrToken);

  interface MethodTotal {
    payment_method_id: number;
    name: string;
    kind: "bank" | "crypto";
    n: number;
    total: string | number;
    last_at: Date | null;
  }

  /** Checks a reviewer would otherwise work out by hand, worst first. */
  async function warningsFor(staff: StaffContext, r: Row, d: Destination | null, payout: PayoutRow | undefined, byMethod: MethodTotal[], settings: MoneySettings) {
    const warnings: Warning[] = [];
    const block = staffMoneyBlock({ status: r.client_status, kyc_status: r.kyc_status });
    if (block) warnings.push({ tone: "bad", text: block });
    if (!d) warnings.push({ tone: "bad", text: UNREADABLE });

    // The same account saved or paid out to by another client. Clients outside the reviewer's scope are not named.
    const others = await rows<{ id: number; first_name: string; last_name: string; assigned_staff_id: number | null }>(
      db,
      `SELECT c.id, c.first_name, c.last_name, c.assigned_staff_id FROM clients c WHERE c.id IN (
         SELECT client_id FROM client_payout_methods WHERE fingerprint = ? AND client_id <> ?
         UNION SELECT client_id FROM withdrawals WHERE destination_fingerprint = ? AND client_id <> ?) ORDER BY c.id LIMIT 5`,
      [r.destination_fingerprint, r.client_id, r.destination_fingerprint, r.client_id],
    );
    for (const o of others.filter((o) => inScope(staff, o.assigned_staff_id))) {
      warnings.push({ tone: "bad", text: `The same destination is also saved or used by ${o.first_name} ${o.last_name} (client ${o.id}).`, href: `/clients/${o.id}` });
    }
    if (others.some((o) => !inScope(staff, o.assigned_staff_id))) warnings.push({ tone: "bad", text: "The same destination is also saved or used by another client." });

    // A bank account should be in the client's verified name; a crypto wallet has no name to check.
    if (d?.kind === "bank") {
      const verified = clientName(r);
      if (!d.accountName.trim()) {
        warnings.push({ tone: "bad", text: "The account has no holder name, so it cannot be checked against the client's verified name." });
      } else {
        const match = compareNames(d.accountName, verified);
        if (match === "different") warnings.push({ tone: "bad", text: `The name on the account (${d.accountName}) does not match the client's verified name (${verified}).` });
        if (match === "similar") warnings.push({ tone: "info", text: `The name on the account (${d.accountName}) is close to the client's verified name (${verified}). Check it is the same person.` });
      }
    } else if (d?.kind === "crypto") {
      warnings.push({ tone: "info", text: "Crypto wallets carry no name; check the wallet belongs to the client." });
    }

    if (!r.paid_before) warnings.push({ tone: "warn", text: "This is the client's first withdrawal." });

    // A destination added or changed just before asking is a common sign of a taken-over account.
    const asked = r.created_at.getTime();
    if (payout) {
      const changed = payout.details_changed_at.getTime();
      if (changed > asked) {
        warnings.push({ tone: "warn", text: "The client changed this payout account after asking for this withdrawal. The money goes to the details shown here, as they were when the client asked." });
      } else if (asked - changed < 72 * HOUR) {
        const added = Math.abs(changed - payout.created_at.getTime()) < 1000;
        warnings.push({ tone: "warn", text: `The client ${added ? "added" : "changed"} this payout account on ${longDate(payout.details_changed_at)}, less than 72 hours before asking for this withdrawal.` });
      }
      if (payout.deleted_at) warnings.push({ tone: "info", text: "The client has since removed this payout account. The withdrawal still goes to the details shown here." });
    }
    if (d?.qrToken && !qrStillSame(r, d, payout)) {
      warnings.push({ tone: "warn", text: "The client replaced the QR code after asking for this withdrawal, so it is not shown. Pay to the address shown." });
    }

    // Staff edits are logged as client.updated (or client.verified_details_changed) with the fields they changed.
    const changes = await rows<{ action: string; at: Date }>(
      db,
      `SELECT action, MAX(occurred_at) AS at FROM (
         SELECT CASE WHEN action IN ('client.updated', 'client.verified_details_changed') AND JSON_CONTAINS(JSON_EXTRACT(meta_json, '$.fields'), '"email"')
                     THEN 'staff.email_changed' WHEN action = 'client.verified_details_changed' THEN 'staff.verified_changed' ELSE action END AS action,
                occurred_at
         FROM audit_log
         WHERE entity_type = 'client' AND entity_id = ? AND occurred_at >= ?
           AND action IN (${Object.keys(SECURITY_ACTIONS).map(() => "?").join(",")}, 'client.updated', 'client.verified_details_changed')
       ) c WHERE action IN (${Object.keys(SECURITY_ACTIONS).map(() => "?").join(",")}) GROUP BY action ORDER BY at`,
      [String(r.client_id), new Date(asked - 7 * DAY), ...Object.keys(SECURITY_ACTIONS), ...Object.keys(SECURITY_ACTIONS)],
    );
    if (changes.length) {
      warnings.push({ tone: "warn", text: `Recent security changes on this account: ${listWords(changes.map((c) => `${SECURITY_ACTIONS[c.action]} on ${longDate(c.at)}`))}.` });
    }

    // Money that came in just before it is asked out again.
    const funding = await one<{ total: string | null; recent: string | null }>(
      db,
      "SELECT SUM(credited_cents) AS total, SUM(IF(decided_at >= ?, credited_cents, 0)) AS recent FROM deposits WHERE client_id = ? AND status = 'approved' AND decided_at <= ?",
      [new Date(asked - 72 * HOUR), r.client_id, r.created_at],
    );
    const total = Number(funding?.total ?? 0);
    const recent = Number(funding?.recent ?? 0);
    if (total > 0 && recent * 2 > total) {
      warnings.push({ tone: "warn", text: `More than half of this client's deposits (${usd(recent)} of ${usd(total)}) arrived in the 72 hours before this request.` });
    }

    // Closed loop: money should go back the way it came.
    const kind = d?.kind ?? r.kind;
    const kinds = [...new Set(byMethod.map((m) => m.kind))];
    if (!kinds.length) warnings.push({ tone: "warn", text: "This client has no approved deposits." });
    else if (!kinds.includes(kind)) warnings.push({ tone: "warn", text: `This client deposited by ${listWords(kinds.map((k) => KIND_WORD[k]))}, but is withdrawing to ${KIND_WORD[kind]}.` });

    if (r.status === "pending" && secondApprovalReasons(r, settings).length) warnings.push({ tone: "info", text: "Needs a second approval from another person." });
    return warnings.sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone]);
  }

  /** Everything the review screen shows. Account details are shown in full only to those who check and pay withdrawals. */
  async function detail(staff: StaffContext, r: Row) {
    const settings = await loadMoneySettings(db);
    const d = readDestination(r);
    const full = seesFull(staff);
    const payout = await payoutMethodOf(r);
    const hasQr = qrStillSame(r, d, payout);
    const wallet = await one<{ available_cents: number; held_cents: number }>(db, "SELECT available_cents, held_cents FROM wallets WHERE id = ?", [r.wallet_id]);
    const byMethod = await rows<MethodTotal>(
      db,
      `SELECT d.payment_method_id, pm.name, pm.kind, COUNT(*) AS n, SUM(d.credited_cents) AS total, MAX(d.decided_at) AS last_at FROM deposits d JOIN payment_methods pm ON pm.id = d.payment_method_id
       WHERE d.client_id = ? AND d.status = 'approved' GROUP BY d.payment_method_id, pm.name, pm.kind ORDER BY total DESC, d.payment_method_id`,
      [r.client_id],
    );
    const paid = await one<{ n: number; total: string | null }>(db, "SELECT COUNT(*) AS n, SUM(amount_cents) AS total FROM withdrawals WHERE client_id = ? AND status = 'paid'", [r.client_id]);
    const recent = await rows<{ id: number; reference: string; status: WithdrawalStatus; amount_cents: number; created_at: Date; paid_at: Date | null }>(
      db,
      "SELECT id, reference, status, amount_cents, created_at, paid_at FROM withdrawals WHERE client_id = ? AND id <> ? ORDER BY created_at DESC, id DESC LIMIT 5",
      [r.client_id, r.id],
    );
    const can = (action: Action) => {
      const block = blockFor(action, staff, r, d);
      return { ok: block === null, reason: block?.message ?? null };
    };
    const shown = (v: string) => (full ? v : (masked(v) ?? ""));
    return {
      ...present(r, settings, d),
      destination: {
        methodName: d?.methodName ?? r.method_name,
        typeName: d?.typeName ?? r.type_name,
        kind: d?.kind ?? r.kind,
        network: d?.network ?? networkLabel(r.type_network),
        accountName: d?.accountName ?? "",
        accountNumber: shown(d?.accountNumber ?? ""),
        iban: shown(d?.iban ?? ""),
        swift: d?.swift ?? "",
        hasQr,
        qrUrl: full && hasQr ? `/api/staff/withdrawals/${r.id}/qr` : null,
        full,
      },
      notes: (r.notes ?? []).map((n) => ({ at: n.at, byName: n.byName ?? null, stage: n.stage, text: n.text })),
      checklist: WITHDRAWAL_CHECKLIST,
      ticked: { first: r.checklist?.first ?? [], second: r.checklist?.second ?? [], pay: r.checklist?.pay ?? [] },
      rejectReasons: WITHDRAWAL_REJECT_REASONS,
      rejectReason: r.reject_reason,
      client: {
        id: r.client_id,
        name: clientName(r),
        email: r.email,
        status: r.client_status,
        kycStatus: r.kyc_status,
        verifiedName: clientName(r),
        country: r.country,
        createdAt: r.client_created_at.toISOString(),
      },
      wallet: { availableCents: Number(wallet?.available_cents ?? 0), heldCents: Number(wallet?.held_cents ?? 0) },
      history: {
        deposits: {
          approvedCount: byMethod.reduce((sum, m) => sum + Number(m.n), 0),
          approvedTotalCents: byMethod.reduce((sum, m) => sum + Number(m.total), 0),
          byMethod: byMethod.map((m) => ({ methodName: m.name, kind: m.kind, totalCents: Number(m.total), lastAt: m.last_at?.toISOString() ?? null })),
        },
        withdrawals: {
          paidCount: Number(paid?.n ?? 0),
          paidTotalCents: Number(paid?.total ?? 0),
          recent: recent.map((w) => ({ id: w.id, reference: w.reference, status: w.status, amountCents: Number(w.amount_cents), createdAt: w.created_at.toISOString(), paidAt: w.paid_at?.toISOString() ?? null })),
        },
      },
      warnings: await warningsFor(staff, r, d, payout, byMethod, settings),
      stage: STAGE[r.status] ?? null,
      can: { approve: can("approve"), secondApprove: can("secondApprove"), pay: can("pay"), reject: can("reject"), returnToReview: can("returnToReview") },
      payoutReference: r.payout_reference,
      paidOn: r.paid_on,
      secondApprovalReasons: r.status === "pending" ? secondApprovalReasons(r, settings) : [],
      secondApprovalAboveCents: settings.withdrawal_second_approval_cents,
      claimMinutes: CLAIM_MINUTES,
    };
  }

  router.get(
    "/",
    view,
    handler(async (req, res) => {
      const query = parse(
        listQuery(["created_at", "amount_cents"], "created_at").extend({
          status: z.enum(TAB_NAMES).default("open"),
          methodId: moneyId.optional().or(z.literal("").transform(() => undefined)),
          clientId: moneyId.optional().or(z.literal("").transform(() => undefined)),
          kind: z.enum(["bank", "crypto"]).optional().or(z.literal("").transform(() => undefined)),
        }),
        req.query,
      );
      const s = clientScope(staffOf(req));
      let clause = ` WHERE 1 = 1${s.sql}`;
      const params: unknown[] = [...s.params];
      const statuses = TABS[query.status];
      if (statuses) (clause += ` AND w.status IN (${statuses.map(() => "?").join(",")})`), params.push(...statuses);
      if (query.methodId) (clause += " AND w.payment_method_id = ?"), params.push(query.methodId);
      if (query.clientId) (clause += " AND w.client_id = ?"), params.push(query.clientId);
      if (query.kind) (clause += " AND pm.kind = ?"), params.push(query.kind);
      if (query.q) {
        const asId = /^\d{1,12}$/.test(query.q) ? Number(query.q) : 0;
        clause += " AND (w.reference = ? OR c.id = ? OR c.email LIKE ? OR CONCAT(c.first_name, ' ', c.last_name) LIKE ?)";
        params.push(query.q.toUpperCase(), asId, likeTerm(query.q), likeTerm(query.q));
      }
      // Oldest first in the working queues, so nobody waits longest.
      const dir = QUEUE_TABS.has(query.status) && !req.query.dir ? "ASC" : query.dir === "asc" ? "ASC" : "DESC";
      const order = query.sort === "amount_cents" ? "w.amount_cents" : "w.created_at";
      const from = " FROM withdrawals w JOIN clients c ON c.id = w.client_id JOIN payment_methods pm ON pm.id = w.payment_method_id";
      const total = await one<{ n: number }>(db, `SELECT COUNT(*) AS n${from}${clause}`, params);
      const items = await rows<Row>(db, `${SELECT}${clause} ORDER BY ${order} ${dir}, w.id ${dir} LIMIT ? OFFSET ?`, [...params, query.pageSize, (query.page - 1) * query.pageSize]);
      const settings = await loadMoneySettings(db);
      res.json(toPage(items.map((r) => present(r, settings, readDestination(r))), Number(total?.n ?? 0), query.page, query.pageSize));
    }),
  );

  /** SQL for "this staff member may pay it": not when they alone approved it. */
  const PAYABLE_BY = "w.approved_by IS NOT NULL AND NOT (w.approved_by = ? AND (w.first_reviewed_by IS NULL OR w.first_reviewed_by = w.approved_by))";

  router.get(
    "/summary",
    view,
    handler(async (req, res) => {
      const staff = staffOf(req);
      const s = clientScope(staff);
      const r = await one<Record<"review" | "second" | "pay" | "overdue" | "today" | "mine" | "for_review" | "for_second" | "for_pay", string | null> & { oldest: Date | null }>(
        db,
        `SELECT SUM(w.status = 'pending') AS review, SUM(w.status = 'second_approval') AS second, SUM(w.status = 'approved') AS pay,
           SUM(w.status IN ('pending', 'second_approval', 'approved') AND w.created_at < CURRENT_TIMESTAMP(3) - INTERVAL 24 HOUR) AS overdue,
           MIN(IF(w.status IN ('pending', 'second_approval', 'approved'), w.created_at, NULL)) AS oldest,
           SUM(w.status IN ('paid', 'rejected') AND w.decided_at >= CURRENT_DATE) AS today,
           SUM(w.status IN ('paid', 'rejected') AND w.decided_at >= CURRENT_DATE AND w.decided_by = ?) AS mine,
           SUM(w.status = 'pending' AND c.status <> 'closed') AS for_review,
           SUM(w.status = 'second_approval' AND c.status <> 'closed' AND (w.first_reviewed_by IS NULL OR w.first_reviewed_by <> ?)) AS for_second,
           SUM(w.status = 'approved' AND c.status <> 'closed' AND ${PAYABLE_BY}) AS for_pay
         FROM withdrawals w JOIN clients c ON c.id = w.client_id
         WHERE (w.status IN ('pending', 'second_approval', 'approved') OR w.decided_at >= CURRENT_DATE)${s.sql}`,
        [staff.id, staff.id, staff.id, ...s.params],
      );
      const n = (v: string | null | undefined) => Number(v ?? 0);
      const has = (p: Permission) => staff.permissions.has(p);
      res.json({
        review: n(r?.review),
        secondApproval: n(r?.second),
        toPay: n(r?.pay),
        overdue: n(r?.overdue),
        oldestOpenAt: r?.oldest?.toISOString() ?? null,
        decidedToday: n(r?.today),
        decidedTodayByMe: n(r?.mine),
        forMe: {
          review: has("withdrawal.process") ? n(r?.for_review) : 0,
          secondApproval: has("withdrawal.approve") ? n(r?.for_second) : 0,
          toPay: has("withdrawal.pay") ? n(r?.for_pay) : 0,
        },
      });
    }),
  );

  // "Start reviewing" and "next": claims the oldest open item the caller can act on that nobody else holds.
  // Closed accounts are skipped (money cannot move; they can still be opened from the list and rejected).
  router.post(
    "/next",
    actOn,
    handler(async (req, res) => {
      const body = parse(
        z.object({ stage: z.enum(["review", "second", "pay"]).optional(), skip: z.array(moneyId).max(200).default([]), release: moneyId.optional() }).strict(),
        req.body ?? {},
      );
      const staff = staffOf(req);
      const stages = {
        review: { permission: "withdrawal.process", sql: "w.status = 'pending'", params: [] as unknown[] },
        second: { permission: "withdrawal.approve", sql: "(w.status = 'second_approval' AND (w.first_reviewed_by IS NULL OR w.first_reviewed_by <> ?))", params: [staff.id] },
        pay: { permission: "withdrawal.pay", sql: `(w.status = 'approved' AND ${PAYABLE_BY})`, params: [staff.id] },
      } as const;
      if (body.stage && !staff.permissions.has(stages[body.stage].permission)) throw forbidden();
      const keys: (keyof typeof stages)[] = body.stage ? [body.stage] : ["review", "second", "pay"];
      const allowed = keys.filter((k) => staff.permissions.has(stages[k].permission)).map((k) => stages[k]);
      const s = clientScope(staff);
      const next = await transaction(db, async (conn) => {
        if (body.release) await release(conn, "withdrawals", body.release, staff.id);
        if (!allowed.length) return null;
        const params: unknown[] = [staff.id, ...allowed.flatMap((a) => a.params), ...s.params];
        let clause = `c.status <> 'closed' AND (w.claimed_by IS NULL OR w.claimed_until < CURRENT_TIMESTAMP(3) OR w.claimed_by = ?) AND (${allowed.map((a) => a.sql).join(" OR ")})${s.sql}`;
        if (body.skip.length) (clause += ` AND w.id NOT IN (${body.skip.map(() => "?").join(",")})`), params.push(...body.skip);
        const row = await one<{ id: number }>(
          conn,
          `SELECT w.id FROM withdrawals w JOIN clients c ON c.id = w.client_id WHERE ${clause} ORDER BY w.created_at, w.id LIMIT 1 FOR UPDATE OF w SKIP LOCKED`,
          params,
        );
        if (!row) return null;
        await claim(conn, "withdrawals", row.id, staff.id);
        return row.id;
      });
      res.json({ id: next });
    }),
  );

  router.post(
    "/:id/claim",
    actOn,
    handler(async (req, res) => {
      const body = parse(z.object({ takeOver: z.boolean().default(false) }).strict(), req.body ?? {});
      const staff = staffOf(req);
      const row = await transaction(db, async (conn) => {
        const r = await loadVisible(staff, parse(moneyId, req.params.id), conn, true);
        const { tookOverFrom } = await claim(conn, "withdrawals", r.id, staff.id, body.takeOver);
        if (tookOverFrom) {
          await writeAudit(conn, ctx(req), {
            action: "withdrawal.review_taken_over", entityType: "client", entityId: r.client_id, meta: { withdrawalId: r.id, reference: r.reference, from: tookOverFrom },
          });
        }
        return loadVisible(staff, r.id, conn);
      });
      const claimedBy = activeClaim(row) ? { id: row.claimed_by!, name: row.claimer_name, until: row.claimed_until!.toISOString() } : null;
      res.json({ claimedBy, minutes: CLAIM_MINUTES });
    }),
  );

  router.post(
    "/:id/release",
    actOn,
    handler(async (req, res) => {
      await release(db, "withdrawals", parse(moneyId, req.params.id), staffOf(req).id);
      res.json({ ok: true });
    }),
  );

  router.get(
    "/:id",
    view,
    handler(async (req, res) => {
      const staff = staffOf(req);
      const row = await loadVisible(staff, parse(moneyId, req.params.id));
      const body = await detail(staff, row);
      // Recorded before anything is sent: who saw this withdrawal, and whether with the full account details.
      await transaction(db, (conn) =>
        writeAudit(conn, ctx(req), { action: "withdrawal.viewed", entityType: "client", entityId: row.client_id, meta: { withdrawalId: row.id, reference: row.reference, full: body.destination.full } }),
      );
      res.json(body);
    }),
  );

  // Like KYC documents, the QR code is read only by the review screen's own requests, which send
  // X-CRM-Viewer. A link, an image, a frame or the address bar cannot send a header.
  const fromReviewScreen = (req: Request, _res: Response, next: NextFunction) =>
    next(req.get("x-crm-viewer") === "1" ? undefined : forbidden("Open the QR code from the review screen. If it is already open, reload it."));
  const QR_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

  router.get(
    "/:id/qr",
    actOn,
    fromReviewScreen,
    handler(async (req, res) => {
      const staff = staffOf(req);
      const r = await loadVisible(staff, parse(moneyId, req.params.id));
      const d = readDestination(r);
      if (!d?.qrToken) throw notFound("This withdrawal has no QR code.");
      const qr = await one<{ client_id: number; qr_token: string | null; qr_mime: string | null; qr_bytes_enc: Buffer | null }>(
        db,
        "SELECT client_id, qr_token, qr_mime, qr_bytes_enc FROM client_payout_methods WHERE id = ?",
        [r.payout_method_id],
      );
      // A QR code the client uploaded after asking is not the destination they asked for.
      if (!qr?.qr_bytes_enc || qr.client_id !== r.client_id || qr.qr_token !== d.qrToken) {
        throw notFound("The client replaced this QR code after asking for the withdrawal. Pay to the address shown.");
      }
      const bytes = decryptBytes(config.dataKey, qr.qr_bytes_enc, `payout_qr:${r.client_id}:${qr.qr_token}`);
      await transaction(db, (conn) =>
        writeAudit(conn, ctx(req), { action: "withdrawal.qr_viewed", entityType: "client", entityId: r.client_id, meta: { withdrawalId: r.id, reference: r.reference } }),
      );
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", qr.qr_mime && QR_TYPES.has(qr.qr_mime) ? qr.qr_mime : "application/octet-stream");
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.setHeader("Content-Disposition", "inline");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      res.setHeader("X-Document-SHA256", sha256(bytes));
      res.send(bytes);
    }),
  );

  /**
   * Runs one decision: locks client, wallet and withdrawal in that order,
   * re-checks the step, the four-eyes rules, the claim and whether money may
   * move, then does the work, all in one transaction. Answers with the updated
   * review screen.
   */
  async function decide(req: Request, action: Action, work: (conn: Conn, r: Row, d: Destination | null) => Promise<void>) {
    const staff = staffOf(req);
    const withdrawalId = parse(moneyId, req.params.id);
    const clientId = await clientOfWithdrawal(withdrawalId);
    await transaction(db, async (conn) => {
      await lockClientOf(conn, clientId);
      const r = await loadVisible(staff, withdrawalId, conn, true);
      const d = readDestination(r);
      const block = blockFor(action, staff, r, d);
      if (block) throw block;
      assertNotClaimedByOther(r, staff.id);
      if (action === "approve" || action === "secondApprove" || action === "pay") await assertMoneyCanMove(conn, r.client_id);
      await work(conn, r, d);
    });
    return detail(staff, await loadVisible(staff, withdrawalId));
  }

  /** Moves the withdrawal from one status to the next; the status in WHERE makes a lost race fail loudly. */
  async function move(conn: Conn, r: Row, from: WithdrawalStatus, set: string, params: unknown[]) {
    const done = await exec(conn, `UPDATE withdrawals SET ${set}, claimed_by = NULL, claimed_until = NULL WHERE id = ? AND status = ?`, [...params, r.id, from]);
    if (done.affectedRows !== 1) throw conflict("This withdrawal changed while you were working on it. Reload it and try again.");
  }

  const setChecklist = (step: "first" | "second" | "pay") => `checklist = JSON_SET(COALESCE(checklist, JSON_OBJECT()), '$.${step}', CAST(? AS JSON))`;
  const auditBase = (r: Row) => ({ withdrawalId: r.id, reference: r.reference, amountCents: Number(r.amount_cents) });

  router.post(
    "/:id/approve",
    requirePermission("withdrawal.view", "withdrawal.process"),
    stepUp,
    handler(async (req, res) => {
      const body = parse(z.object({ checklist: checklistOf(WITHDRAWAL_CHECKLIST.first), note: internalNote }).strict(), req.body ?? {});
      const staff = staffOf(req);
      res.json(
        await decide(req, "approve", async (conn, r) => {
          // The rules as they stand now, with the settings share-locked so a change cannot slip in between.
          const reasons = secondApprovalReasons(r, await loadMoneySettings(conn, true));
          const entityId = r.client_id;
          if (reasons.length) {
            await move(conn, r, "pending", `status = 'second_approval', first_reviewed_by = ?, first_reviewed_at = CURRENT_TIMESTAMP(3), ${setChecklist("first")}`, [staff.id, JSON.stringify(body.checklist)]);
            await appendNote(conn, "withdrawals", r.id, staff, "first_approval", body.note);
            await writeAudit(conn, ctx(req), {
              action: "withdrawal.first_approved", entityType: "client", entityId, before: { status: r.status }, after: { status: "second_approval" },
              meta: { ...auditBase(r), checklist: body.checklist, secondApprovalReasons: reasons, ...(body.note ? { internalNote: body.note } : {}) },
            });
            return;
          }
          await move(
            conn, r, "pending",
            `status = 'approved', first_reviewed_by = ?, first_reviewed_at = CURRENT_TIMESTAMP(3), approved_by = ?, approved_at = CURRENT_TIMESTAMP(3), ${setChecklist("first")}`,
            [staff.id, staff.id, JSON.stringify(body.checklist)],
          );
          await appendNote(conn, "withdrawals", r.id, staff, "approved", body.note);
          await writeAudit(conn, ctx(req), {
            action: "withdrawal.approved", entityType: "client", entityId, before: { status: r.status }, after: { status: "approved" },
            meta: { ...auditBase(r), stage: "single", checklist: body.checklist, ...(body.note ? { internalNote: body.note } : {}) },
          });
        }),
      );
    }),
  );

  router.post(
    "/:id/second-approve",
    requirePermission("withdrawal.view", "withdrawal.approve"),
    stepUp,
    handler(async (req, res) => {
      const body = parse(z.object({ checklist: checklistOf(WITHDRAWAL_CHECKLIST.second), note: internalNote }).strict(), req.body ?? {});
      const staff = staffOf(req);
      res.json(
        await decide(req, "secondApprove", async (conn, r) => {
          await move(conn, r, "second_approval", `status = 'approved', approved_by = ?, approved_at = CURRENT_TIMESTAMP(3), ${setChecklist("second")}`, [staff.id, JSON.stringify(body.checklist)]);
          await appendNote(conn, "withdrawals", r.id, staff, "second_approval", body.note);
          await writeAudit(conn, ctx(req), {
            action: "withdrawal.approved", entityType: "client", entityId: r.client_id, before: { status: r.status }, after: { status: "approved" },
            meta: { ...auditBase(r), stage: "second", firstReviewer: person(r.first_reviewed_by, r.first_reviewer_name), checklist: body.checklist, ...(body.note ? { internalNote: body.note } : {}) },
          });
        }),
      );
    }),
  );

  // Send a withdrawal back from the second approval to the first review. It
  // then always needs a second approval again, whatever the rules say by then.
  router.post(
    "/:id/return",
    requirePermission("withdrawal.view", "withdrawal.approve"),
    stepUp,
    handler(async (req, res) => {
      const body = parse(z.object({ note: requiredNote }).strict(), req.body ?? {});
      const staff = staffOf(req);
      res.json(
        await decide(req, "returnToReview", async (conn, r) => {
          await move(
            conn, r, "second_approval",
            "status = 'pending', first_reviewed_by = NULL, first_reviewed_at = NULL, needs_second_approval = 1, checklist = JSON_REMOVE(COALESCE(checklist, JSON_OBJECT()), '$.first')",
            [],
          );
          await appendNote(conn, "withdrawals", r.id, staff, "returned", body.note);
          await writeAudit(conn, ctx(req), {
            action: "withdrawal.returned", entityType: "client", entityId: r.client_id, before: { status: r.status }, after: { status: "pending" },
            meta: { ...auditBase(r), firstReviewer: person(r.first_reviewed_by, r.first_reviewer_name), internalNote: body.note },
          });
        }),
      );
    }),
  );

  /** Whether the withdrawal's money is on hold in the ledger (it was put there when the client asked). */
  const isHeld = async (conn: Conn, r: Row) =>
    Boolean(await one(conn, "SELECT id FROM ledger_transactions WHERE source_type = 'withdrawal' AND source_id = ? AND kind = 'withdrawal_hold'", [r.id]));

  router.post(
    "/:id/pay",
    requirePermission("withdrawal.view", "withdrawal.pay"),
    stepUp,
    handler(async (req, res) => {
      const body = parse(
        z.object({ payoutReference: payoutReferenceField, paidOn: paidOnField, checklist: checklistOf(WITHDRAWAL_CHECKLIST.pay), note: internalNote, confirmReuse: z.boolean().default(false) }).strict(),
        req.body ?? {},
      );
      const staff = staffOf(req);
      res.json(
        await decide(req, "pay", async (conn, r, d) => {
          const amount = Number(r.amount_cents);
          if (!(await isHeld(conn, r))) throw conflict(NO_HOLD);
          // The same bank or wallet reference twice usually means one payment recorded for two withdrawals.
          const reused = await one<{ id: number; reference: string }>(
            conn,
            "SELECT id, reference FROM withdrawals WHERE id <> ? AND payout_reference IS NOT NULL AND UPPER(REGEXP_REPLACE(payout_reference, ?, '')) = ? ORDER BY id LIMIT 1",
            [r.id, "[\\s./-]", normalizeAccount(body.payoutReference)],
          );
          if (reused && !body.confirmReuse) {
            throw new HttpError(
              409, "PAYOUT_REFERENCE_USED",
              `This payout reference was already recorded for withdrawal ${reused.reference}. Check it, and confirm only if this payment really has the same reference.`,
              { withdrawalId: reused.id, reference: reused.reference },
            );
          }
          // The held money leaves the client's account for the payout type it went out through. Once only (postLedger refuses a repeat).
          await postLedger(conn, { kind: "withdrawal_paid", sourceType: "withdrawal", sourceId: r.id, clientId: r.client_id, staffId: staff.id, memo: `Withdrawal ${r.reference} paid` }, [
            { account: holdAccount(r.client_id), amount: -amount },
            { account: payoutAccount(r.payment_method_id), amount },
          ]);
          await move(
            conn, r, "approved",
            `status = 'paid', paid_by = ?, paid_at = CURRENT_TIMESTAMP(3), payout_reference = ?, paid_on = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP(3), ${setChecklist("pay")}`,
            [staff.id, body.payoutReference, body.paidOn, staff.id, JSON.stringify(body.checklist)],
          );
          await appendNote(conn, "withdrawals", r.id, staff, "paid", body.note);
          const account = d ? d.accountNumber || d.iban : "";
          await writeAudit(conn, ctx(req), {
            action: "withdrawal.paid", entityType: "client", entityId: r.client_id, before: { status: r.status }, after: { status: "paid" },
            meta: {
              ...auditBase(r), payoutReference: body.payoutReference, paidOn: body.paidOn, type: d?.typeName ?? r.type_name, accountEnding: account ? lastFour(account) : null,
              approvedBy: person(r.approved_by, r.approver_name), firstReviewer: person(r.first_reviewed_by, r.first_reviewer_name), checklist: body.checklist,
              ...(reused ? { payoutReferenceAlsoOn: reused.reference } : {}), ...(body.note ? { internalNote: body.note } : {}),
            },
          });
          await queueSupportEvent(conn, config, { event: "withdrawal.approved", clientId: r.client_id, referenceId: r.reference });
          const methodName = d?.methodName ?? r.method_name;
          const ending = account ? ` ${endingOf(account)}` : "";
          await notifyClient(conn, r.client_id, {
            type: "withdrawal", title: "Your withdrawal was sent",
            body: `${usd(amount)} was sent to your ${methodName} account${ending}. Payout reference: ${body.payoutReference}.`,
            link: "/transactions", linkLabel: "View history",
          });
          await queueEmail(conn, config, {
            to: r.email, template: "withdrawal_paid", subject: "Your withdrawal was sent", clientId: r.client_id,
            text: `Hello ${r.first_name},\n\nWe sent ${usd(amount)} to your ${methodName} account${ending} (request ${r.reference}).\n\nPayout reference: ${body.payoutReference}\n\nIf the money has not arrived in a few days, contact support and give them this payout reference.\n\nBIS Markets`,
          });
        }),
      );
    }),
  );

  router.post(
    "/:id/reject",
    requirePermission("withdrawal.view", "withdrawal.reject"),
    stepUp,
    handler(async (req, res) => {
      const body = parse(z.object({ reason: reasonText, note: internalNote }).strict(), req.body ?? {});
      const staff = staffOf(req);
      res.json(
        await decide(req, "reject", async (conn, r) => {
          const amount = Number(r.amount_cents);
          // The held money goes back to the wallet, once only. A withdrawal whose money was never held has nothing to return.
          const held = await isHeld(conn, r);
          if (held) {
            await postLedger(conn, { kind: "withdrawal_release", sourceType: "withdrawal", sourceId: r.id, clientId: r.client_id, staffId: staff.id, memo: `Withdrawal ${r.reference} rejected` }, [
              { account: holdAccount(r.client_id), amount: -amount },
              { account: walletAccount(r.client_id), amount },
            ]);
          }
          await move(conn, r, r.status, "status = 'rejected', reject_reason = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP(3)", [body.reason, staff.id]);
          await appendNote(conn, "withdrawals", r.id, staff, "rejected", body.note);
          await writeAudit(conn, ctx(req), {
            action: "withdrawal.rejected", entityType: "client", entityId: r.client_id, before: { status: r.status }, after: { status: "rejected" },
            meta: { ...auditBase(r), reason: body.reason, stage: STAGE[r.status], holdReleased: held, ...(body.note ? { internalNote: body.note } : {}) },
          });
          await queueSupportEvent(conn, config, { event: "withdrawal.rejected", clientId: r.client_id, referenceId: r.reference });
          // The reason is shown as written; "back in your wallet" is added unless the reason already says so.
          const back = /back in your wallet/i.test(body.reason) ? "" : ` ${usd(amount)} is back in your wallet.`;
          await notifyClient(conn, r.client_id, {
            type: "withdrawal", title: "Your withdrawal was not approved", body: `${body.reason}${/[.!?]$/.test(body.reason) ? "" : "."}${back}`,
            link: "/transactions", linkLabel: "View history",
          });
          await queueEmail(conn, config, {
            to: r.email, template: "withdrawal_rejected", subject: "Your withdrawal was not approved", clientId: r.client_id,
            text: `Hello ${r.first_name},\n\nWe could not send your withdrawal of ${usd(amount)} (request ${r.reference}).\n\nReason: ${body.reason}\n\nThe money is back in your wallet.\n\nBIS Markets`,
          });
        }),
      );
    }),
  );

  return router;
}
