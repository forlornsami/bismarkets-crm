import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { DEPOSIT_CHECKLIST, DEPOSIT_REJECT_REASONS, NOT_PLAIN, type DepositStatus } from "@shared/money";
import type { Permission } from "@shared/permissions";
import type { AppDeps } from "../../app";
import { lockClient } from "../../clients/kyc";
import type { ClientRow } from "../../clients/model";
import { notifyClient } from "../../clients/notifications";
import { auditContext, writeAudit } from "../../lib/audit";
import { decryptBytes, sha256 } from "../../lib/crypto";
import { exec, one, rows, transaction, type Conn } from "../../lib/db";
import { queueEmail } from "../../lib/email";
import { queueSupportEvent } from "../../lib/events";
import { badRequest, conflict, forbidden, handler, HttpError, notFound, parse, unauthorized } from "../../lib/http";
import { likeTerm, listQuery, toPage } from "../../lib/pagination";
import { activeClaim, claim, CLAIM_MINUTES, release } from "../../lib/review";
import { AMOUNT_MESSAGES, money, parseAmount, toUsdCents } from "../../money/amounts";
import { depositMethodAccount, lockWallet, postLedger, walletAccount, walletOf } from "../../money/ledger";
import { compareNames, type NameMatch } from "../../money/names";
import { depositProofContext } from "../../money/proofs";
import { bankReferenceKey } from "../../money/references";
import { appendNote, assertMoneyCanMove, checklistOf, clientScope, inScope, internalNote, moneyId, reasonText, staffMoneyBlock } from "../../money/review";
import { loadMoneySettings } from "../../money/settings";
import { requirePermission, requireStepUp, staffActor, staffOf, type StaffContext } from "../../staff/session";

const NOT_FOUND = "That deposit does not exist or its client is not assigned to you.";

interface StoredNote {
  at: string;
  by: number;
  byName: string;
  stage: string;
  text: string;
}

interface Row {
  id: number;
  reference: string;
  client_id: number;
  payment_method_id: number;
  method_name: string;
  status: DepositStatus;
  currency: "USD" | "PKR";
  amount_minor: number;
  usd_rate: string;
  rate_set_by: number | null;
  amount_cents: number;
  network: string;
  received_minor: number | null;
  credited_cents: number | null;
  needs_second_approval: number;
  sent_back_at: Date | null;
  sender_name: string | null;
  bank_reference: string | null;
  received_on: string | null;
  reject_reason: string | null;
  checklist: { first?: string[]; second?: string[] } | null;
  notes: StoredNote[] | null;
  first_reviewed_by: number | null;
  first_reviewer_name: string | null;
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
  assigned_staff_id: number | null;
  client_created_at: Date;
  method_kind: "bank" | "crypto";
  method_set_by: number | null;
  proof_sha: string | null;
  proof_editor: string | null;
  // Checks on the proof and the client's history, worked out by the query (see flagsOf).
  shared_others: number;
  reused_own: number;
  kyc_match: number;
  first_deposit: number;
}

const SELECT = `SELECT d.id, d.reference, d.client_id, d.payment_method_id, d.method_name, d.status, d.currency, d.amount_minor, d.usd_rate, d.rate_set_by, d.amount_cents, d.network,
  d.received_minor, d.credited_cents, d.needs_second_approval, d.sent_back_at, d.sender_name, d.bank_reference, DATE_FORMAT(d.received_on, '%Y-%m-%d') AS received_on, d.reject_reason, d.checklist, d.notes,
  d.first_reviewed_by, fr.name AS first_reviewer_name, d.decided_by, d.decided_at, dc.name AS decider_name, d.claimed_by, d.claimed_until, cl.name AS claimer_name, d.created_at,
  c.first_name, c.last_name, c.email, c.status AS client_status, c.kyc_status, c.assigned_staff_id, c.created_at AS client_created_at, pm.kind AS method_kind, pm.details_set_by AS method_set_by,
  p.sha256 AS proof_sha, p.editor AS proof_editor,
  EXISTS (SELECT 1 FROM deposit_proofs p2 JOIN deposits d2 ON d2.id = p2.deposit_id WHERE p2.sha256 = p.sha256 AND d2.client_id <> d.client_id) AS shared_others,
  EXISTS (SELECT 1 FROM deposit_proofs p2 JOIN deposits d2 ON d2.id = p2.deposit_id WHERE p2.sha256 = p.sha256 AND d2.client_id = d.client_id AND d2.id <> d.id) AS reused_own,
  EXISTS (SELECT 1 FROM kyc_documents k WHERE k.sha256 = p.sha256) AS kyc_match,
  NOT EXISTS (SELECT 1 FROM deposits d3 WHERE d3.client_id = d.client_id AND d3.status = 'approved' AND d3.id <> d.id) AS first_deposit
  FROM deposits d JOIN clients c ON c.id = d.client_id JOIN payment_methods pm ON pm.id = d.payment_method_id
  LEFT JOIN deposit_proofs p ON p.deposit_id = d.id
  LEFT JOIN staff_users fr ON fr.id = d.first_reviewed_by LEFT JOIN staff_users dc ON dc.id = d.decided_by LEFT JOIN staff_users cl ON cl.id = d.claimed_by`;

const person = (staffId: number | null, name: string | null) => (staffId ? { id: staffId, name: name ?? "Staff" } : null);
const verifiedName = (r: Pick<Row, "first_name" | "last_name">) => `${r.first_name} ${r.last_name}`.trim();
/** US cents the deposit would credit: what the reviewer found, or what the client says they sent until then. */
const expectedCents = (r: Row) => (r.credited_cents !== null ? Number(r.credited_cents) : r.received_minor !== null ? toUsdCents(Number(r.received_minor), r.currency, r.usd_rate) : Number(r.amount_cents));
/** Above the limit, or marked two-person (sent back from the second approval, or the client's was lately). */
const aboveLimit = (r: Row, threshold: number) => expectedCents(r) > threshold || r.needs_second_approval === 1;
const needsSecondApproval = (r: Row, threshold: number) =>
  r.status === "second_approval" || (r.status === "approved" ? r.first_reviewed_by !== null && r.first_reviewed_by !== r.decided_by : aboveLimit(r, threshold));

/**
 * What this staff member set that the deposit depends on: where clients pay its method (the account
 * details), or the rupee rate it uses. A first approval by that person is never enough alone.
 */
const setBy = (r: Row, staffId: number | null) => ({
  method: staffId !== null && r.method_set_by !== null && Number(r.method_set_by) === staffId,
  rate: staffId !== null && r.currency === "PKR" && r.rate_set_by !== null && Number(r.rate_set_by) === staffId,
});
const setsAny = (s: ReturnType<typeof setBy>) => s.method || s.rate;
const setWords = (s: ReturnType<typeof setBy>) =>
  [s.method && "this method's account details", s.rate && "the rupee rate this deposit uses"].filter(Boolean).join(" and ");

type Warning = { tone: "bad" | "warn" | "info"; text: string; href?: string };

/**
 * What looks wrong about a deposit, before any names or references are looked
 * up. The queue counts these; the review screen turns each one into a warning.
 */
function flagsOf(r: Row, threshold: number) {
  const sender: NameMatch | null = r.sender_name ? compareNames(r.sender_name, verifiedName(r)) : null;
  return {
    block: staffMoneyBlock({ status: r.client_status, kyc_status: r.kyc_status }),
    sharedWithOthers: Number(r.shared_others) === 1,
    kycMatch: Number(r.kyc_match) === 1,
    reusedOwn: Number(r.reused_own) === 1,
    editor: r.proof_editor,
    sender,
    amountDiffers: r.received_minor !== null && Number(r.received_minor) !== Number(r.amount_minor),
    firstDeposit: Number(r.first_deposit) === 1,
    newClient: r.client_created_at.getTime() > Date.now() - 24 * 3_600_000,
    unassigned: r.assigned_staff_id === null,
    aboveLimit: r.status === "second_approval" || (r.status === "pending" && aboveLimit(r, threshold)),
  };
}

/** Warnings the queue counts (bad and warn; the bank reference check is on the review screen only). */
const warningCount = (f: ReturnType<typeof flagsOf>) =>
  [f.block, f.sharedWithOthers, f.kycMatch, f.reusedOwn, f.editor, f.sender === "different", f.amountDiffers, f.firstDeposit, f.newClient, f.unassigned].filter(Boolean).length;

const present = (r: Row, threshold: number) => ({
  id: r.id,
  reference: r.reference,
  clientId: r.client_id,
  clientName: verifiedName(r),
  clientEmail: r.email,
  clientStatus: r.client_status,
  kycStatus: r.kyc_status,
  methodId: r.payment_method_id,
  methodName: r.method_name,
  methodKind: r.method_kind,
  currency: r.currency,
  amountMinor: Number(r.amount_minor),
  amountCents: Number(r.amount_cents),
  creditedCents: r.credited_cents === null ? null : Number(r.credited_cents),
  status: r.status,
  needsSecondApproval: needsSecondApproval(r, threshold),
  /** Sent back from the second approval: the next first approval goes to a second person whatever the amount. */
  sentBack: r.sent_back_at !== null,
  /** Two people decide whatever the amount: sent back, or the client's other deposit was sent back lately. */
  twoPersonMark: r.needs_second_approval === 1,
  firstReviewedBy: person(r.first_reviewed_by, r.first_reviewer_name),
  decidedBy: person(r.decided_by, r.decider_name),
  createdAt: r.created_at.toISOString(),
  decidedAt: r.decided_at?.toISOString() ?? null,
  claimedBy: activeClaim(r) ? { id: r.claimed_by!, name: r.claimer_name ?? "Staff", until: r.claimed_until!.toISOString() } : null,
  warningCount: warningCount(flagsOf(r, threshold)),
});

type Action = "approve" | "secondApprove" | "reject" | "returnToFirst";
const NEEDS: Record<Action, { permissions: Permission[]; denied: string }> = {
  approve: { permissions: ["deposit.process", "deposit.proof"], denied: "You do not have permission to approve deposits." },
  secondApprove: { permissions: ["deposit.approve_large", "deposit.proof"], denied: "Only staff who may approve large deposits can give the second approval." },
  reject: { permissions: ["deposit.reject", "deposit.proof"], denied: "You do not have permission to reject deposits." },
  returnToFirst: { permissions: ["deposit.approve_large", "deposit.proof"], denied: "Only staff who may approve large deposits can send one back." },
};
const STATUSES: Record<Action, DepositStatus[]> = {
  approve: ["pending"],
  secondApprove: ["second_approval"],
  reject: ["pending", "second_approval"],
  returnToFirst: ["second_approval"],
};

function statusProblem(r: Row) {
  if (r.status === "approved") return `This deposit was already approved${r.decider_name ? ` by ${r.decider_name}` : ""}.`;
  if (r.status === "rejected") return `This deposit was already rejected${r.decider_name ? ` by ${r.decider_name}` : ""}.`;
  if (r.status === "second_approval") return `This deposit already has its first approval${r.first_reviewer_name ? ` from ${r.first_reviewer_name}` : ""} and is waiting for a second.`;
  return "This deposit has not had its first approval yet.";
}

/**
 * Why this staff member may not take this step now, or null. The review screen
 * shows the same text the decision would fail with. `money` adds the account
 * check (frozen, closed, KYC); decisions run it again with the client row locked.
 */
function blockOf(staff: StaffContext, r: Row, action: Action, money = true): HttpError | null {
  const need = NEEDS[action];
  if (!need.permissions.every((p) => staff.permissions.has(p))) return forbidden(need.denied);
  if (!STATUSES[action].includes(r.status)) return badRequest(statusProblem(r));
  const holder = activeClaim(r);
  if (holder && holder !== staff.id) return conflict(`${r.claimer_name ?? "Someone else"} is reviewing this deposit right now.`);
  // Four eyes: above the limit, the person who gave the first approval never gives the second.
  if (action === "secondApprove" && r.first_reviewed_by === staff.id) return forbidden("You gave the first approval, so another person must give the second.");
  // A second reviewer objected: a first reviewer rejecting it would let the client send it again with a clean slate.
  if (action === "reject" && r.sent_back_at !== null && !staff.permissions.has("deposit.approve_large")) {
    return forbidden("This deposit was sent back from the second approval, so only staff who give second approvals can reject it.");
  }
  if (money && (action === "approve" || action === "secondApprove")) {
    const block = staffMoneyBlock({ status: r.client_status, kyc_status: r.kyc_status });
    if (block) return badRequest(block);
  }
  return null;
}

const plainField = (min: number, max: number, missing: string) =>
  z
    .string({ required_error: missing, invalid_type_error: missing })
    .trim()
    .min(min, missing)
    .max(max, `Keep this under ${max + 1} characters`)
    .refine((v) => !NOT_PLAIN.test(v), "Use plain text, without links or symbols like < > { }");

const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const receivedOnField = z
  .string({ required_error: "Enter the date the payment arrived", invalid_type_error: "Enter the date the payment arrived" })
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the date as YYYY-MM-DD")
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && isoDate(new Date(`${v}T00:00:00Z`)) === v, "Enter a real date")
  // Not after today anywhere in the world (UTC+14), so a reviewer east of UTC can enter their own today.
  .refine((v) => v <= isoDate(new Date(Date.now() + 14 * 3_600_000)), "The date cannot be in the future")
  .refine((v) => v >= isoDate(new Date(Date.now() - 180 * 86_400_000)), "The payment must have arrived in the last 180 days");

const approveBody = z
  .object({
    receivedAmount: z.union([z.string().max(32), z.number()], { required_error: "Enter the amount that arrived", invalid_type_error: "Enter the amount that arrived" }),
    senderName: plainField(2, 160, "Enter the sender's name as the statement shows it"),
    bankReference: plainField(2, 80, "Enter the bank or transaction reference"),
    receivedOn: receivedOnField,
    checklist: checklistOf(DEPOSIT_CHECKLIST.first),
    note: internalNote,
  })
  .strict();
const secondApproveBody = z.object({ checklist: checklistOf(DEPOSIT_CHECKLIST.second), note: internalNote }).strict();
const returnBody = z.object({ note: plainField(5, 500, "Write a note for the first reviewer (at least 5 characters)") }).strict();
const rejectBody = z.object({ reason: reasonText, note: internalNote }).strict();

/** The deposit review queue: check the payment, approve (twice above the limit) or reject. */
export function staffDepositsRouter(deps: AppDeps): Router {
  const { db, config } = deps;
  const router = Router();
  const stepUp = requireStepUp(config);
  const ctx = (req: Request) => auditContext(req, staffActor(staffOf(req)));
  // deposit.view gives the queue and counts; opening a deposit or its proof needs deposit.proof.
  const openDeposit = requirePermission("deposit.view", "deposit.proof");
  // Claiming is for those who can approve at either stage.
  const review = (req: Request, _res: Response, next: NextFunction) => {
    const p = req.staff?.permissions;
    if (!p) return next(unauthorized());
    next(p.has("deposit.proof") && (p.has("deposit.process") || p.has("deposit.approve_large")) ? undefined : forbidden());
  };

  async function loadVisible(req: Request, depositId: number, conn: Conn = db, lock = false) {
    const s = clientScope(staffOf(req));
    const row = await one<Row>(conn, `${SELECT} WHERE d.id = ?${s.sql}${lock ? " FOR UPDATE OF d" : ""}`, [depositId, ...s.params]);
    if (!row) throw notFound(NOT_FOUND);
    return row;
  }

  /**
   * Every change takes the locks in the same order as everything else that
   * moves money: the client row, then the wallet, then the deposit. The client
   * id is read first, before the transaction starts (it never changes): read
   * inside it, the read would fix the snapshot before the locks are taken, and
   * read through the pool, a transaction would wait for a second connection
   * while holding one, which hangs the server once every connection does.
   */
  async function clientOfDeposit(req: Request, depositId: number) {
    // Scoped first, so nobody takes locks on a client they may not see.
    const s = clientScope(staffOf(req));
    const ref = await one<{ client_id: number }>(db, `SELECT d.client_id FROM deposits d JOIN clients c ON c.id = d.client_id WHERE d.id = ?${s.sql}`, [depositId, ...s.params]);
    if (!ref) throw notFound(NOT_FOUND);
    return ref.client_id;
  }

  async function lockDeposit(conn: Conn, req: Request, depositId: number, clientId: number) {
    await lockClient(conn, clientId);
    await lockWallet(conn, clientId);
    return loadVisible(req, depositId, conn, true);
  }

  /** Approving needs the proof opened by this reviewer in the review screen, from the audit log. */
  async function proofOpenedBy(conn: Conn, staffId: number, r: Pick<Row, "id" | "client_id">) {
    const seen = await one<{ ok: number }>(
      conn,
      `SELECT 1 AS ok FROM audit_log WHERE entity_type = 'client' AND entity_id = ? AND actor_type = 'staff' AND actor_id = ?
         AND action = 'deposit.proof_viewed' AND meta_json->'$.depositId' = ? LIMIT 1`,
      [String(r.client_id), staffId, r.id],
    );
    return Boolean(seen);
  }

  /** The review screen's warnings, worded for staff. Other clients are named only when the reviewer may see them. */
  async function warningsFor(conn: Conn, staff: StaffContext, r: Row, threshold: number): Promise<Warning[]> {
    const f = flagsOf(r, threshold);
    const out: Warning[] = [];
    if (f.block) out.push({ tone: "bad", text: f.block });
    if (f.sharedWithOthers && r.proof_sha) {
      const others = await rows<{ client_id: number; first_name: string; last_name: string; assigned_staff_id: number | null }>(
        conn,
        `SELECT DISTINCT d2.client_id, c2.first_name, c2.last_name, c2.assigned_staff_id FROM deposit_proofs p2 JOIN deposits d2 ON d2.id = p2.deposit_id JOIN clients c2 ON c2.id = d2.client_id
         WHERE p2.sha256 = ? AND d2.client_id <> ? ORDER BY d2.client_id LIMIT 20`,
        [r.proof_sha, r.client_id],
      );
      const named = others.find((o) => inScope(staff, o.assigned_staff_id));
      const rest = others.length - (named ? 1 : 0);
      const more = rest ? ` and ${rest} other client${rest > 1 ? "s" : ""}` : "";
      out.push(
        named
          ? { tone: "bad", text: `The same screenshot was also sent by ${named.first_name} ${named.last_name} (client ${named.client_id})${more}.`, href: `/clients/${named.client_id}` }
          : { tone: "bad", text: `The same screenshot was also sent by ${rest > 1 ? `${rest} other clients` : "another client"}.` },
      );
    }
    if (f.kycMatch && r.proof_sha) {
      const owners = await rows<{ client_id: number; first_name: string; last_name: string; assigned_staff_id: number | null }>(
        conn,
        `SELECT DISTINCT s.client_id, c2.first_name, c2.last_name, c2.assigned_staff_id FROM kyc_documents k JOIN kyc_submissions s ON s.id = k.submission_id JOIN clients c2 ON c2.id = s.client_id
         WHERE k.sha256 = ? ORDER BY s.client_id LIMIT 20`,
        [r.proof_sha],
      );
      const other = owners.find((o) => o.client_id !== r.client_id && inScope(staff, o.assigned_staff_id));
      if (owners.some((o) => o.client_id === r.client_id)) out.push({ tone: "bad", text: "The screenshot is the same file as one of the client's KYC documents, not a payment." });
      else if (other) out.push({ tone: "bad", text: `The screenshot is the same file as a KYC document of ${other.first_name} ${other.last_name} (client ${other.client_id}).`, href: `/clients/${other.client_id}` });
      else out.push({ tone: "bad", text: "The screenshot is the same file as another client's KYC document." });
    }
    // The same bank payment entered on another deposit (the unique key already stops it for the same method).
    if (r.bank_reference) {
      const normalized = bankReferenceKey(r.payment_method_id, r.bank_reference).split(":")[1] ?? "";
      const used = normalized
        ? await rows<{ id: number; reference: string; client_id: number; assigned_staff_id: number | null }>(
            conn,
            `SELECT d2.id, d2.reference, d2.client_id, c2.assigned_staff_id FROM deposits d2 JOIN clients c2 ON c2.id = d2.client_id
             WHERE d2.bank_reference_key LIKE ? AND d2.id <> ? ORDER BY d2.id LIMIT 5`,
            [`%:${normalized.replace(/[\\%_]/g, (m) => `\\${m}`)}`, r.id],
          )
        : [];
      for (const u of used) {
        out.push({ tone: "bad", text: `This bank reference was also entered on deposit ${u.reference}.`, ...(inScope(staff, u.assigned_staff_id) ? { href: `/deposits/${u.id}` } : {}) });
      }
    }
    if (f.reusedOwn && r.proof_sha) {
      const own = await rows<{ id: number; reference: string }>(
        conn,
        "SELECT d2.id, d2.reference FROM deposit_proofs p2 JOIN deposits d2 ON d2.id = p2.deposit_id WHERE p2.sha256 = ? AND d2.client_id = ? AND d2.id <> ? ORDER BY d2.id LIMIT 3",
        [r.proof_sha, r.client_id, r.id],
      );
      if (own[0]) out.push({ tone: "warn", text: `The client sent the same screenshot before, with deposit ${own.map((o) => o.reference).join(", ")}.`, href: `/deposits/${own[0].id}` });
    }
    if (f.editor) out.push({ tone: "warn", text: `The screenshot was saved by ${f.editor}. Check it closely for signs of editing.` });
    if (f.sender === "different") out.push({ tone: "warn", text: "The sender name does not match the client's verified name." });
    if (f.sender === "similar") out.push({ tone: "info", text: "The sender name is close to the client's verified name, but not the same." });
    if (f.amountDiffers) {
      out.push({ tone: "warn", text: `The amount that arrived (${money(Number(r.received_minor), r.currency)}) differs from what the client entered (${money(Number(r.amount_minor), r.currency)}).` });
    }
    if (f.firstDeposit) out.push({ tone: "warn", text: "This is the client's first deposit." });
    if (f.newClient) out.push({ tone: "warn", text: "The client registered less than 24 hours ago." });
    if (f.unassigned) out.push({ tone: "warn", text: "The client is not assigned to anyone on the team." });
    if (f.aboveLimit) {
      const why =
        r.status !== "pending" || r.needs_second_approval !== 1 ? ""
        : r.sent_back_at ? " It was sent back from the second approval, so this applies whatever the amount."
        : " The client's other deposit was sent back from the second approval, so this applies whatever the amount.";
      out.push({ tone: "info", text: `Needs a second approval from another person.${why}` });
    }
    const mine = setBy(r, staff.id);
    if (r.status === "pending" && setsAny(mine)) {
      out.push({ tone: "info", text: `You set ${setWords(mine)}, so another person must also approve this deposit, whatever the amount.` });
    }
    const firsts = setBy(r, r.first_reviewed_by);
    if (r.status === "second_approval" && setsAny(firsts)) {
      const check = [firsts.method && "the account is the company's own", firsts.rate && "the rate is right"].filter(Boolean).join(" and ");
      out.push({ tone: "warn", text: `The first reviewer set ${setWords(firsts)}. Check that ${check} before approving.` });
    }
    const order = { bad: 0, warn: 1, info: 2 };
    return out.sort((a, b) => order[a.tone] - order[b.tone]);
  }

  /** The review screen's view of one deposit. Writes nothing. */
  async function detailOf(req: Request, depositId: number) {
    const staff = staffOf(req);
    const r = await loadVisible(req, depositId);
    const settings = await loadMoneySettings(db);
    const threshold = settings.deposit_second_approval_cents;
    const client = (await one<{ country: string | null; assigned_name: string | null }>(
      db,
      "SELECT c.country, a.name AS assigned_name FROM clients c LEFT JOIN staff_users a ON a.id = c.assigned_staff_id WHERE c.id = ?",
      [r.client_id],
    ))!;
    const method = (await one<{ id: number; name: string; kind: "bank" | "crypto"; currency: string; bank_name: string; account_title: string; account_number: string; iban: string; wallet_address: string; network: string }>(
      db,
      "SELECT id, name, kind, currency, bank_name, account_title, account_number, iban, wallet_address, network FROM payment_methods WHERE id = ?",
      [r.payment_method_id],
    ))!;
    const proof = await one<{ mime: string; size_bytes: number; sha256: string; editor: string | null; file_name: string }>(
      db,
      "SELECT mime, size_bytes, sha256, editor, file_name FROM deposit_proofs WHERE deposit_id = ?",
      [r.id],
    );
    const wallet = await walletOf(db, r.client_id);
    const approved = await one<{ n: number; total: string | null }>(
      db,
      "SELECT COUNT(*) AS n, SUM(credited_cents) AS total FROM deposits WHERE client_id = ? AND status = 'approved' AND id <> ?",
      [r.client_id, r.id],
    );
    const recent = await rows<{ id: number; reference: string; status: DepositStatus; cents: number; created_at: Date }>(
      db,
      "SELECT id, reference, status, COALESCE(credited_cents, amount_cents) AS cents, created_at FROM deposits WHERE client_id = ? AND id <> ? ORDER BY id DESC LIMIT 5",
      [r.client_id, r.id],
    );
    const action = (a: Action) => {
      const block = blockOf(staff, r, a);
      return { ok: block === null, reason: block?.message ?? null };
    };
    return {
      ...present(r, threshold),
      network: r.network,
      usdRate: r.usd_rate,
      receivedMinor: r.received_minor === null ? null : Number(r.received_minor),
      senderName: r.sender_name,
      bankReference: r.bank_reference,
      receivedOn: r.received_on,
      rejectReason: r.reject_reason,
      // The ticked items of each step so far (the items themselves are in `checklist`).
      checked: { first: r.checklist?.first ?? null, second: r.checklist?.second ?? null },
      notes: (r.notes ?? []).map((n) => ({ at: n.at, byName: n.byName, stage: n.stage, text: n.text })),
      proof: proof
        ? { mime: proof.mime, sizeBytes: Number(proof.size_bytes), sha256: proof.sha256, editor: proof.editor, fileName: proof.file_name, url: `/api/staff/deposits/${r.id}/proof` }
        : null,
      client: {
        id: r.client_id,
        name: verifiedName(r),
        email: r.email,
        status: r.client_status,
        kycStatus: r.kyc_status,
        verifiedName: verifiedName(r),
        country: client.country,
        createdAt: r.client_created_at.toISOString(),
        assignedTo: person(r.assigned_staff_id, client.assigned_name),
      },
      method: {
        id: method.id, name: method.name, kind: method.kind, currency: method.currency, bankName: method.bank_name, accountTitle: method.account_title,
        accountNumber: method.account_number, iban: method.iban, walletAddress: method.wallet_address, network: method.network,
      },
      wallet: { availableCents: wallet.available_cents, heldCents: wallet.held_cents },
      history: {
        approvedCount: Number(approved?.n ?? 0),
        approvedTotalCents: Number(approved?.total ?? 0),
        firstDeposit: Number(approved?.n ?? 0) === 0,
        recent: recent.map((d) => ({ id: d.id, reference: d.reference, status: d.status, amountCents: Number(d.cents), createdAt: d.created_at.toISOString() })),
      },
      warnings: await warningsFor(db, staff, r, threshold),
      proofOpenedByMe: await proofOpenedBy(db, staff.id, r),
      stage: r.status === "pending" ? ("first" as const) : r.status === "second_approval" ? ("second" as const) : null,
      /** This reviewer set the method's account details or the rate: their approval goes to a second person. */
      setByYou: r.status === "pending" && setsAny(setBy(r, staff.id)),
      can: { approve: action("approve"), secondApprove: action("secondApprove"), reject: action("reject"), returnToFirst: action("returnToFirst") },
      checklist: { first: DEPOSIT_CHECKLIST.first, second: DEPOSIT_CHECKLIST.second },
      rejectReasons: DEPOSIT_REJECT_REASONS,
      claimMinutes: CLAIM_MINUTES,
      secondApprovalAboveCents: threshold,
      expectedReference: `BIS-${r.client_id}`,
    };
  }

  /** A bank payment can be credited once: the reference must not be on another deposit of the same method. */
  async function assertReferenceFree(conn: Conn, key: string, depositId: number) {
    const taken = await one<{ reference: string }>(conn, "SELECT reference FROM deposits WHERE bank_reference_key = ? AND id <> ?", [key, depositId]);
    if (taken) throw conflict(`This bank reference was already used for deposit ${taken.reference}.`);
  }

  /**
   * Credits the wallet with what arrived, marks the deposit approved and tells
   * the client and the support service, in the caller's transaction (client,
   * wallet and deposit already locked). The ledger refuses a second credit of
   * the same deposit, so it can never be added twice.
   */
  async function credit(conn: Conn, req: Request, r: Row, o: { stage: "single" | "second"; receivedMinor: number; checklist: string[]; note: string | null; warnings: string[] }) {
    const staff = staffOf(req);
    const credited = toUsdCents(o.receivedMinor, r.currency, r.usd_rate);
    await postLedger(conn, { kind: "deposit", sourceType: "deposit", sourceId: r.id, clientId: r.client_id, staffId: staff.id, memo: `Deposit ${r.reference}` }, [
      { account: walletAccount(r.client_id), amount: credited },
      { account: depositMethodAccount(r.payment_method_id), amount: -credited },
    ]);
    const done = await exec(
      conn,
      "UPDATE deposits SET status = 'approved', credited_cents = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP(3), claimed_by = NULL, claimed_until = NULL WHERE id = ? AND status IN ('pending', 'second_approval')",
      [credited, staff.id, r.id],
    );
    if (done.affectedRows !== 1) throw conflict("This deposit changed while you were approving it. Reload it.");
    await writeAudit(conn, ctx(req), {
      action: "deposit.approved", entityType: "client", entityId: r.client_id,
      before: { status: r.status }, after: { status: "approved", creditedCents: credited },
      meta: {
        depositId: r.id, reference: r.reference, stage: o.stage, creditedCents: credited,
        received: { minor: o.receivedMinor, currency: r.currency, usdRate: r.usd_rate }, method: { id: r.payment_method_id, name: r.method_name },
        checklist: o.checklist, warnings: o.warnings,
        ...(o.stage === "second" ? { firstReviewer: person(r.first_reviewed_by, r.first_reviewer_name) } : {}),
        ...(o.note ? { internalNote: o.note } : {}),
      },
    });
    await queueSupportEvent(conn, config, { event: "deposit.approved", clientId: r.client_id, referenceId: r.reference });
    const amount = money(credited, "USD");
    await notifyClient(conn, r.client_id, { type: "deposit", title: "Your deposit was added to your wallet", body: `${amount} is now in your wallet.`, link: "/transactions", linkLabel: "View history" });
    await queueEmail(conn, config, {
      to: r.email, template: "deposit_approved", subject: "Your deposit was added to your wallet", clientId: r.client_id,
      text: `Hello ${r.first_name},\n\nWe have received your payment and added ${amount} to your wallet (deposit ${r.reference}).\n\nYou can see it in your history in the client portal: ${config.portalUrl}/transactions\n\nBIS Markets`,
    });
  }

  router.get(
    "/",
    requirePermission("deposit.view"),
    handler(async (req, res) => {
      const blank = z.literal("").transform(() => undefined);
      const query = parse(
        listQuery(["created_at", "amount_cents"], "created_at").extend({
          status: z.enum(["open", "pending", "second_approval", "approved", "rejected", "all"]).default("open"),
          methodId: moneyId.optional().or(blank),
          clientId: moneyId.optional().or(blank),
        }),
        req.query,
      );
      const where = ["1 = 1"];
      const params: unknown[] = [];
      const s = clientScope(staffOf(req));
      if (s.sql) (where.push("c.assigned_staff_id = ?"), params.push(...s.params));
      if (query.status === "open") where.push("d.status IN ('pending', 'second_approval')");
      else if (query.status !== "all") (where.push("d.status = ?"), params.push(query.status));
      if (query.methodId) (where.push("d.payment_method_id = ?"), params.push(query.methodId));
      if (query.clientId) (where.push("d.client_id = ?"), params.push(query.clientId));
      if (query.q) {
        const asId = /^\d{1,12}$/.test(query.q) ? Number(query.q) : 0;
        where.push("(d.reference = ? OR c.id = ? OR c.email LIKE ? OR CONCAT(c.first_name, ' ', c.last_name) LIKE ?)");
        params.push(query.q.toUpperCase(), asId, likeTerm(query.q), likeTerm(query.q));
      }
      const clause = ` WHERE ${where.join(" AND ")}`;
      // Oldest first while waiting, so nobody waits longest.
      const waiting = ["open", "pending", "second_approval"].includes(query.status);
      const dir = waiting && !req.query.dir ? "ASC" : query.dir === "asc" ? "ASC" : "DESC";
      const total = await one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM deposits d JOIN clients c ON c.id = d.client_id${clause}`, params);
      const items = await rows<Row>(db, `${SELECT}${clause} ORDER BY d.${query.sort} ${dir}, d.id ${dir} LIMIT ? OFFSET ?`, [...params, query.pageSize, (query.page - 1) * query.pageSize]);
      const threshold = (await loadMoneySettings(db)).deposit_second_approval_cents;
      res.json(toPage(items.map((r) => present(r, threshold)), Number(total?.n ?? 0), query.page, query.pageSize));
    }),
  );

  router.get(
    "/summary",
    requirePermission("deposit.view"),
    handler(async (req, res) => {
      const staff = staffOf(req);
      const s = clientScope(staff);
      const r = await one<{ pending: string | null; second: string | null; overdue: string | null; oldest: Date | null; today: string | null; mine: string | null; forMe: string | null }>(
        db,
        `SELECT SUM(d.status = 'pending') AS pending, SUM(d.status = 'second_approval') AS second,
           SUM(d.status IN ('pending', 'second_approval') AND d.created_at < CURRENT_TIMESTAMP(3) - INTERVAL 24 HOUR) AS overdue,
           MIN(IF(d.status IN ('pending', 'second_approval'), d.created_at, NULL)) AS oldest,
           SUM(d.status IN ('approved', 'rejected') AND d.decided_at >= CURRENT_DATE) AS today,
           SUM(d.status IN ('approved', 'rejected') AND d.decided_at >= CURRENT_DATE AND d.decided_by = ?) AS mine,
           SUM(d.status = 'second_approval' AND (d.first_reviewed_by IS NULL OR d.first_reviewed_by <> ?)) AS forMe
         FROM deposits d JOIN clients c ON c.id = d.client_id
         WHERE (d.status IN ('pending', 'second_approval') OR d.decided_at >= CURRENT_DATE)${s.sql}`,
        [staff.id, staff.id, ...s.params],
      );
      res.json({
        pending: Number(r?.pending ?? 0),
        secondApproval: Number(r?.second ?? 0),
        overdue: Number(r?.overdue ?? 0),
        oldestOpenAt: r?.oldest?.toISOString() ?? null,
        decidedToday: Number(r?.today ?? 0),
        decidedTodayByMe: Number(r?.mine ?? 0),
        secondApprovalForMe: staff.permissions.has("deposit.approve_large") ? Number(r?.forMe ?? 0) : 0,
      });
    }),
  );

  // "Start reviewing" and "next": claims the oldest open deposit nobody else holds that the caller can act on.
  router.post(
    "/next",
    review,
    handler(async (req, res) => {
      const body = parse(z.object({ stage: z.enum(["first", "second"]).optional(), skip: z.array(moneyId).max(200).default([]), release: moneyId.optional() }).strict(), req.body ?? {});
      const staff = staffOf(req);
      const first = staff.permissions.has("deposit.process") && body.stage !== "second";
      const second = staff.permissions.has("deposit.approve_large") && body.stage !== "first";
      const next = await transaction(db, async (conn) => {
        if (body.release) await release(conn, "deposits", body.release, staff.id);
        if (!first && !second) return null;
        const stages = [first ? "d.status = 'pending'" : "", second ? "(d.status = 'second_approval' AND d.first_reviewed_by <> ?)" : ""].filter(Boolean);
        const where = [`(${stages.join(" OR ")})`, "c.status <> 'closed'", "(d.claimed_by IS NULL OR d.claimed_until < CURRENT_TIMESTAMP(3) OR d.claimed_by = ?)"];
        const params: unknown[] = [...(second ? [staff.id] : []), staff.id];
        const s = clientScope(staff);
        if (s.sql) (where.push("c.assigned_staff_id = ?"), params.push(...s.params));
        if (body.skip.length) (where.push(`d.id NOT IN (${body.skip.map(() => "?").join(",")})`), params.push(...body.skip));
        const row = await one<{ id: number }>(
          conn,
          `SELECT d.id FROM deposits d JOIN clients c ON c.id = d.client_id WHERE ${where.join(" AND ")} ORDER BY d.created_at, d.id LIMIT 1 FOR UPDATE OF d SKIP LOCKED`,
          params,
        );
        if (!row) return null;
        await claim(conn, "deposits", row.id, staff.id);
        return row.id;
      });
      res.json({ id: next });
    }),
  );

  router.post(
    "/:id/claim",
    review,
    handler(async (req, res) => {
      const body = parse(z.object({ takeOver: z.boolean().default(false) }).strict(), req.body ?? {});
      const staff = staffOf(req);
      const row = await transaction(db, async (conn) => {
        const r = await loadVisible(req, parse(moneyId, req.params.id), conn, true);
        const { tookOverFrom } = await claim(conn, "deposits", r.id, staff.id, body.takeOver);
        if (tookOverFrom) {
          await writeAudit(conn, ctx(req), { action: "deposit.review_taken_over", entityType: "client", entityId: r.client_id, meta: { depositId: r.id, reference: r.reference, from: tookOverFrom } });
        }
        return loadVisible(req, r.id, conn);
      });
      res.json({ claimedBy: present(row, 0).claimedBy, minutes: CLAIM_MINUTES });
    }),
  );

  router.post(
    "/:id/release",
    review,
    handler(async (req, res) => {
      await release(db, "deposits", parse(moneyId, req.params.id), staffOf(req).id);
      res.json({ ok: true });
    }),
  );

  router.get(
    "/:id",
    openDeposit,
    handler(async (req, res) => {
      const out = await detailOf(req, parse(moneyId, req.params.id));
      await transaction(db, (conn) =>
        writeAudit(conn, ctx(req), { action: "deposit.viewed", entityType: "client", entityId: out.clientId, meta: { depositId: out.id, reference: out.reference } }),
      );
      res.json(out);
    }),
  );

  // Proofs are read only by the review screen's own requests, which send X-CRM-Viewer (as KYC documents):
  // a link, an image, a frame or the address bar cannot send a header, so a proof is never opened outside it.
  const fromReviewScreen = (req: Request, _res: Response, next: NextFunction) =>
    next(req.get("x-crm-viewer") === "1" ? undefined : forbidden("Open payment proofs from the review screen. If it is already open, reload it."));

  router.get(
    "/:id/proof",
    openDeposit,
    fromReviewScreen,
    handler(async (req, res) => {
      const r = await loadVisible(req, parse(moneyId, req.params.id));
      const proof = await one<{ mime: string; bytes_enc: Buffer }>(db, "SELECT mime, bytes_enc FROM deposit_proofs WHERE deposit_id = ?", [r.id]);
      if (!proof) throw notFound("This deposit has no payment proof.");
      const body = decryptBytes(config.dataKey, proof.bytes_enc, depositProofContext(r.id, r.client_id, r.reference));
      await transaction(db, (conn) =>
        writeAudit(conn, ctx(req), { action: "deposit.proof_viewed", entityType: "client", entityId: r.client_id, meta: { depositId: r.id, reference: r.reference } }),
      );
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", proof.mime);
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.setHeader("Content-Disposition", "inline");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      // The review screen checks the copy it gets against this (a browser extension can hand it a changed file).
      res.setHeader("X-Document-SHA256", sha256(body));
      res.send(body);
    }),
  );

  // First approval: the reviewer found the payment and enters what arrived. Up to the limit this
  // credits the wallet; above it, another person must give the second approval.
  router.post(
    "/:id/approve",
    requirePermission("deposit.process", "deposit.proof"),
    stepUp,
    handler(async (req, res) => {
      const body = parse(approveBody, req.body ?? {});
      const staff = staffOf(req);
      const depositId = parse(moneyId, req.params.id);
      const clientId = await clientOfDeposit(req, depositId);
      await transaction(db, async (conn) => {
        const r = await lockDeposit(conn, req, depositId, clientId);
        const block = blockOf(staff, r, "approve", false);
        if (block) throw block;
        if (!(await proofOpenedBy(conn, staff.id, r))) throw badRequest("Open the payment proof before approving.");
        await assertMoneyCanMove(conn, r.client_id);
        const received = parseAmount(body.receivedAmount);
        if ("problem" in received) throw badRequest("Check the highlighted fields.", [{ field: "receivedAmount", message: AMOUNT_MESSAGES[received.problem] }]);
        if (received.minor !== Number(r.amount_minor) && !body.note) throw badRequest("Add a note explaining why the received amount differs.");
        const credited = toUsdCents(received.minor, r.currency, r.usd_rate);
        if (credited <= 0) throw badRequest("The received amount is too small to add to the wallet.");
        const key = bankReferenceKey(r.payment_method_id, body.bankReference);
        await assertReferenceFree(conn, key, r.id);
        // Read with a share lock, so a limit cannot change half-way through this decision.
        const threshold = (await loadMoneySettings(conn, true)).deposit_second_approval_cents;
        try {
          await exec(
            conn,
            `UPDATE deposits SET received_minor = ?, sender_name = ?, bank_reference = ?, bank_reference_key = ?, received_on = ?, checklist = JSON_OBJECT('first', CAST(? AS JSON)),
               first_reviewed_by = ?, first_reviewed_at = CURRENT_TIMESTAMP(3), claimed_by = NULL, claimed_until = NULL WHERE id = ? AND status = 'pending'`,
            [received.minor, body.senderName, body.bankReference, key, body.receivedOn, JSON.stringify(body.checklist), staff.id, r.id],
          );
        } catch (error) {
          if ((error as { code?: string }).code === "ER_DUP_ENTRY") {
            await assertReferenceFree(conn, key, r.id);
            throw conflict("This bank reference was already used for another deposit.");
          }
          throw error;
        }
        const entered = await loadVisible(req, r.id, conn);
        const warnings = (await warningsFor(conn, staff, entered, threshold)).filter((w) => w.tone !== "info").map((w) => w.text);
        const mine = setBy(r, staff.id);
        if (credited > threshold || r.needs_second_approval === 1 || setsAny(mine)) {
          await exec(conn, "UPDATE deposits SET status = 'second_approval' WHERE id = ?", [r.id]);
          await appendNote(conn, "deposits", r.id, staff, "first_approval", body.note);
          await writeAudit(conn, ctx(req), {
            action: "deposit.first_approved", entityType: "client", entityId: r.client_id,
            before: { status: "pending" }, after: { status: "second_approval" },
            meta: {
              depositId: r.id, reference: r.reference, received: { minor: received.minor, currency: r.currency, usdRate: r.usd_rate }, creditedCents: credited,
              senderName: body.senderName, bankReference: body.bankReference, receivedOn: body.receivedOn, method: { id: r.payment_method_id, name: r.method_name },
              checklist: body.checklist, warnings, thresholdCents: threshold, ...(setsAny(mine) ? { reviewerSet: mine } : {}), ...(body.note ? { internalNote: body.note } : {}),
            },
          });
          return;
        }
        await appendNote(conn, "deposits", r.id, staff, "approved", body.note);
        await credit(conn, req, entered, { stage: "single", receivedMinor: received.minor, checklist: body.checklist, note: body.note, warnings });
      });
      res.json(await detailOf(req, depositId));
    }),
  );

  router.post(
    "/:id/second-approve",
    requirePermission("deposit.approve_large", "deposit.proof"),
    stepUp,
    handler(async (req, res) => {
      const body = parse(secondApproveBody, req.body ?? {});
      const staff = staffOf(req);
      const depositId = parse(moneyId, req.params.id);
      const clientId = await clientOfDeposit(req, depositId);
      await transaction(db, async (conn) => {
        const r = await lockDeposit(conn, req, depositId, clientId);
        const block = blockOf(staff, r, "secondApprove", false);
        if (block) throw block;
        if (!(await proofOpenedBy(conn, staff.id, r))) throw badRequest("Open the payment proof before approving.");
        await assertMoneyCanMove(conn, r.client_id);
        if (r.received_minor === null) throw badRequest("The first approval is missing what arrived. Send it back to the first reviewer.");
        await exec(conn, "UPDATE deposits SET checklist = JSON_SET(COALESCE(checklist, JSON_OBJECT()), '$.second', CAST(? AS JSON)) WHERE id = ?", [JSON.stringify(body.checklist), r.id]);
        await appendNote(conn, "deposits", r.id, staff, "second_approval", body.note);
        const threshold = (await loadMoneySettings(conn, true)).deposit_second_approval_cents;
        const warnings = (await warningsFor(conn, staff, r, threshold)).filter((w) => w.tone !== "info").map((w) => w.text);
        await credit(conn, req, r, { stage: "second", receivedMinor: Number(r.received_minor), checklist: body.checklist, note: body.note, warnings });
      });
      res.json(await detailOf(req, depositId));
    }),
  );

  // The second reviewer disagrees with what the first one entered: back to the first step, with a note.
  router.post(
    "/:id/return",
    requirePermission("deposit.approve_large", "deposit.proof"),
    stepUp,
    handler(async (req, res) => {
      const body = parse(returnBody, req.body ?? {});
      const staff = staffOf(req);
      const depositId = parse(moneyId, req.params.id);
      const clientId = await clientOfDeposit(req, depositId);
      await transaction(db, async (conn) => {
        const r = await lockDeposit(conn, req, depositId, clientId);
        const block = blockOf(staff, r, "returnToFirst");
        if (block) throw block;
        await exec(
          conn,
          `UPDATE deposits SET status = 'pending', received_minor = NULL, sender_name = NULL, bank_reference = NULL, bank_reference_key = NULL, received_on = NULL, checklist = NULL,
             first_reviewed_by = NULL, first_reviewed_at = NULL, needs_second_approval = 1, sent_back_at = CURRENT_TIMESTAMP(3), claimed_by = NULL, claimed_until = NULL
             WHERE id = ? AND status = 'second_approval'`,
          [r.id],
        );
        // The client's other deposits still waiting for a first approval become two-person too, as later ones do.
        const others = await rows<{ id: number }>(
          conn, "SELECT id FROM deposits WHERE client_id = ? AND id <> ? AND status = 'pending' AND needs_second_approval = 0 FOR UPDATE", [r.client_id, r.id],
        );
        if (others.length) await exec(conn, `UPDATE deposits SET needs_second_approval = 1 WHERE id IN (${others.map(() => "?").join(", ")})`, others.map((o) => o.id));
        await appendNote(conn, "deposits", r.id, staff, "returned", body.note);
        await writeAudit(conn, ctx(req), {
          action: "deposit.returned", entityType: "client", entityId: r.client_id,
          before: { status: "second_approval", receivedMinor: r.received_minor === null ? null : Number(r.received_minor), senderName: r.sender_name, bankReference: r.bank_reference, receivedOn: r.received_on },
          after: { status: "pending" },
          meta: {
            depositId: r.id, reference: r.reference, firstReviewer: person(r.first_reviewed_by, r.first_reviewer_name), internalNote: body.note,
            ...(others.length ? { alsoTwoPerson: others.map((o) => o.id) } : {}),
          },
        });
      });
      res.json(await detailOf(req, depositId));
    }),
  );

  // Rejecting is allowed for frozen and closed accounts, and at either step.
  router.post(
    "/:id/reject",
    requirePermission("deposit.reject", "deposit.proof"),
    stepUp,
    handler(async (req, res) => {
      const body = parse(rejectBody, req.body ?? {});
      const staff = staffOf(req);
      const depositId = parse(moneyId, req.params.id);
      const clientId = await clientOfDeposit(req, depositId);
      await transaction(db, async (conn) => {
        const r = await lockDeposit(conn, req, depositId, clientId);
        const block = blockOf(staff, r, "reject");
        if (block) throw block;
        // The bank reference is freed: this payment was never credited.
        const done = await exec(
          conn,
          `UPDATE deposits SET status = 'rejected', reject_reason = ?, bank_reference_key = NULL, decided_by = ?, decided_at = CURRENT_TIMESTAMP(3), claimed_by = NULL, claimed_until = NULL
           WHERE id = ? AND status IN ('pending', 'second_approval')`,
          [body.reason, staff.id, r.id],
        );
        if (done.affectedRows !== 1) throw conflict("This deposit changed while you were rejecting it. Reload it.");
        await appendNote(conn, "deposits", r.id, staff, "rejected", body.note);
        await writeAudit(conn, ctx(req), {
          action: "deposit.rejected", entityType: "client", entityId: r.client_id,
          before: { status: r.status }, after: { status: "rejected" },
          meta: { depositId: r.id, reference: r.reference, stage: r.status === "pending" ? "first" : "second", reason: body.reason, ...(body.note ? { internalNote: body.note } : {}) },
        });
        await queueSupportEvent(conn, config, { event: "deposit.rejected", clientId: r.client_id, referenceId: r.reference });
        await notifyClient(conn, r.client_id, { type: "deposit", title: "Your deposit request was not approved", body: body.reason, link: "/transactions", linkLabel: "View history" });
        await queueEmail(conn, config, {
          to: r.email, template: "deposit_rejected", subject: "Your deposit request was not approved", clientId: r.client_id,
          text: `Hello ${r.first_name},\n\nWe could not approve your deposit request ${r.reference} for ${money(Number(r.amount_minor), r.currency)}.\n\nReason: ${body.reason}\n\nIf you have any questions, please contact support.\n\nBIS Markets`,
        });
      });
      res.json(await detailOf(req, depositId));
    }),
  );

  return router;
}
