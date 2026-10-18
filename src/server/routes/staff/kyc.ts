import express, { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { AppDeps } from "../../app";
import {
  auditedFiles, checklistFor, describeMissing, KYC_MAX_BYTES, KYC_REJECT_REASONS, KYC_TYPES, KYC_UNREADABLE_REASON, kycDocumentContext, latestSubmissions, lockClient, missingProfileFields, otherCategory, overallStatus,
  parseKycUpload, proofOf, readProfileSnapshot, sameProfileValue, saveProfileSnapshot, storeSubmission, subTypeOf, VERIFIED_FIELDS,
  type KycCategory, type KycOverall, type LatestSubmissions, type RequiredProfileField, type SnapshotField,
} from "../../clients/kyc";
import { clientName, clientPictureUrl, loadClient, type ClientRow } from "../../clients/model";
import { auditContext, writeAudit } from "../../lib/audit";
import { decryptBytes, sha256 } from "../../lib/crypto";
import { heicAsJpeg, inspectPdf } from "../../lib/documents";
import { exec, one, rows, transaction, type Conn } from "../../lib/db";
import { queueEmail } from "../../lib/email";
import { queueSupportEvent } from "../../lib/events";
import { notifyClient } from "../../clients/notifications";
import { badRequest, forbidden, handler, HttpError, notFound, parse } from "../../lib/http";
import { likeTerm, listQuery, toPage } from "../../lib/pagination";
import { requirePermission, requireStepUp, staffActor, staffOf, type StaffContext } from "../../staff/session";
import { activeClaim, assertNotClaimedByOther, claim, CLAIM_MINUTES, release } from "../../lib/review";

const id = z.coerce.number().int().positive();
// The portal shows a rejection reason exactly as written, but only when it is plain text.
const plain = (v: string) => !/[<>{}`\\]|https?:|\bwww\./i.test(v);
const PLAIN_MESSAGE = "Write the reason as plain text, without links or symbols like < > { }";
const reasonText = z.string().trim().min(5, "Write a short reason (at least 5 characters)").max(500).refine(plain, PLAIN_MESSAGE);
// A note for colleagues, kept in the audit log and the decision trail. The client never sees it.
const internalNote = z
  .string()
  .trim()
  .max(500, "Keep the internal note under 500 characters")
  .refine(plain, "Write the note as plain text, without links or symbols like < > { }")
  .optional()
  .transform((v) => v || null);

const CLOSED = "This account is closed.";
const WITHDRAWN = "The client took this document back.";
const NOT_LATEST = "The client has a newer submission for this. Change that one instead.";

interface Row {
  id: number;
  client_id: number;
  category: KycCategory;
  sub_type: number;
  source: "client" | "staff";
  uploaded_by: number | null;
  uploader_name: string | null;
  staff_note: string | null;
  status: "pending" | "approved" | "rejected" | "withdrawn";
  reject_reason: string | null;
  submitted_at: Date;
  decided_at: Date | null;
  decider_name: string | null;
  claimed_by: number | null;
  claimed_until: Date | null;
  claimer_name: string | null;
  first_name: string;
  last_name: string;
  email: string;
  country: string | null;
  client_status: ClientRow["status"];
  picture_sha: string | null;
  documents: number;
}

const SELECT = `SELECT s.id, s.client_id, s.category, s.sub_type, s.source, s.uploaded_by, up.name AS uploader_name, s.staff_note, s.status, s.reject_reason, s.submitted_at, s.decided_at,
  u.name AS decider_name, s.claimed_by, s.claimed_until, cl.name AS claimer_name, c.first_name, c.last_name, c.email, c.country, c.status AS client_status, pp.sha256 AS picture_sha,
  (SELECT COUNT(*) FROM kyc_documents d WHERE d.submission_id = s.id) AS documents
  FROM kyc_submissions s JOIN clients c ON c.id = s.client_id LEFT JOIN staff_users u ON u.id = s.decided_by LEFT JOIN staff_users cl ON cl.id = s.claimed_by
  LEFT JOIN staff_users up ON up.id = s.uploaded_by
  LEFT JOIN profile_pictures pp ON pp.owner_type = 'client' AND pp.owner_id = s.client_id`;

const present = (r: Row) => ({
  id: r.id,
  client: { id: r.client_id, name: clientName(r), email: r.email, country: r.country, pictureUrl: clientPictureUrl("", r.client_id, r.picture_sha) },
  category: r.category,
  categoryLabel: KYC_TYPES[r.category].label,
  documentType: subTypeOf(r.category, r.sub_type)?.name ?? `Type ${r.sub_type}`,
  status: r.status,
  rejectReason: r.reject_reason,
  submittedAt: r.submitted_at.toISOString(),
  clientStatus: r.client_status,
  decidedAt: r.decided_at?.toISOString() ?? null,
  decidedBy: r.decider_name,
  documents: Number(r.documents),
  source: r.source,
  uploadedBy: r.source === "staff" ? (r.uploader_name ?? "staff") : null,
  staffNote: r.staff_note,
  claimedBy: activeClaim(r) ? { id: r.claimed_by!, name: r.claimer_name, until: r.claimed_until!.toISOString() } : null,
});

interface DocRow {
  id: number;
  submission_id: number;
  slot: number;
  mime: string;
  size_bytes: number;
  file_name: string;
  sha256: string;
  /** Null for a PDF stored before pages were counted, until a reviewer opens it and the server can count it. */
  pages: number | null;
}

const isPdf = (mime: string) => mime === "application/pdf";

/**
 * What one reviewer has opened of a client's documents, from the audit log.
 * A photo counts once fetched. A PDF counts when the review screen drew every
 * page. A download never counts: documents are reviewed inside the CRM.
 */
async function openedBy(conn: Conn, staffId: number, clientId: number) {
  const events = await rows<{ action: string; doc: number; page: number | null }>(
    conn,
    `SELECT action, CAST(meta_json->>'$.documentId' AS UNSIGNED) AS doc, CAST(meta_json->>'$.page' AS UNSIGNED) AS page
     FROM audit_log WHERE entity_type = 'client' AND entity_id = ? AND actor_type = 'staff' AND actor_id = ? AND action IN ('kyc.document_viewed', 'kyc.document_page_viewed')`,
    [String(clientId), staffId],
  );
  const seen = new Map<number, { fetched: boolean; pages: Set<number> }>();
  for (const e of events) {
    const doc = Number(e.doc);
    const s = seen.get(doc) ?? { fetched: false, pages: new Set<number>() };
    if (e.action === "kyc.document_viewed") s.fetched = true;
    else if (e.page) s.pages.add(Number(e.page));
    seen.set(doc, s);
  }
  return {
    /** Pages of a PDF the review screen drew for this reviewer. */
    pagesOf: (d: DocRow) => [...(seen.get(d.id)?.pages ?? [])].sort((a, b) => a - b),
    fully: (d: DocRow) => {
      const s = seen.get(d.id);
      if (!s?.fetched) return false;
      if (!isPdf(d.mime)) return true;
      if (d.pages === null) return false;
      for (let p = 1; p <= d.pages; p++) if (!s.pages.has(p)) return false;
      return true;
    },
  };
}

const ageOn = (dob: string, now = new Date()) => {
  const [y = 0, m = 1, d = 1] = dob.split("-").map(Number);
  let age = now.getUTCFullYear() - y;
  if (now.getUTCMonth() + 1 < m || (now.getUTCMonth() + 1 === m && now.getUTCDate() < d)) age--;
  return age;
};
const longDate = (d: Date | null) => (d ?? new Date()).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
type Warning = { tone: "bad" | "warn" | "info"; text: string; clientId?: number };

const FIELD_LABEL: Record<SnapshotField, string> = {
  first_name: "first name", last_name: "last name", dob: "date of birth", country: "country", city: "city", address: "address", zipcode: "postcode",
};
const listWords = (words: string[]) => (words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}` : (words[0] ?? ""));
/** The profile fields a reviewer compares with each category's documents. */
const COMPARED: Record<KycCategory, readonly SnapshotField[]> = {
  identity: VERIFIED_FIELDS.identity,
  address: ["first_name", "last_name", ...VERIFIED_FIELDS.address],
};

// The decision history shown with a submission, from the audit log.
const TRAIL: Record<string, string> = {
  "kyc.submitted": "Sent by the client",
  "kyc.uploaded_by_staff": "Uploaded by staff for the client",
  "kyc.approved": "Approved",
  "kyc.rejected": "Rejected",
  "kyc.decision_changed": "Decision changed",
  "kyc.new_document_requested": "New document requested",
  "kyc.approved_without_documents": "Approved without documents",
  "kyc.withdrawn_by_client": "Taken back by the client",
};
const text = (v: unknown) => (typeof v === "string" && v ? v : null);

/** The KYC review queue: open documents, approve or reject, all audited. */
export function staffKycRouter(deps: AppDeps): Router {
  const { db, config } = deps;
  const router = Router();
  const stepUp = requireStepUp(config);
  // kyc.view alone gives the queue and counts; opening a submission or its files needs kyc.documents.
  const openDocuments = requirePermission("kyc.view", "kyc.documents");
  const decide = requirePermission("kyc.decide", "kyc.documents");
  const ctx = (req: Request) => auditContext(req, staffActor(staffOf(req)));
  const scope = (staff: StaffContext) =>
    staff.permissions.has("client.view_all") ? { sql: "", params: [] as unknown[] } : { sql: " AND c.assigned_staff_id = ?", params: [staff.id] as unknown[] };
  /** Whether the staff member may see this client (for naming other clients in warnings). */
  const inScope = (staff: StaffContext, assignedTo: number | null) => staff.permissions.has("client.view_all") || assignedTo === staff.id;

  async function loadVisible(req: Request, submissionId: number, conn: Conn = db, lock = false) {
    const s = scope(staffOf(req));
    const row = await one<Row>(conn, `${SELECT} WHERE s.id = ?${s.sql}${lock ? " FOR UPDATE OF s" : ""}`, [submissionId, ...s.params]);
    if (!row) throw notFound("That submission does not exist or its client is not assigned to you.");
    return row;
  }

  /**
   * Every change locks the client row before reading submissions, so two
   * decisions for one client run one after the other and the second sees the
   * first. The client id is read first, before the transaction starts (it never
   * changes): read through the pool inside it, a transaction would wait for a
   * second connection while holding one, which hangs the server once every
   * connection does.
   */
  const clientOfSubmission = async (submissionId: number) =>
    (await one<{ client_id: number }>(db, "SELECT client_id FROM kyc_submissions WHERE id = ?", [submissionId]))?.client_id ?? null;

  async function lockClientOf(conn: Conn, clientId: number | null) {
    if (clientId !== null) await lockClient(conn, clientId);
  }

  const documentsOf = (submissionId: number) =>
    rows<DocRow>(db, "SELECT id, submission_id, slot, mime, size_bytes, file_name, sha256, pages FROM kyc_documents WHERE submission_id = ? ORDER BY slot", [submissionId]);

  type Outcome = {
    status: "approved" | "rejected";
    reason: string | null;
    checklist?: string[];
    action: string;
    meta?: Record<string, unknown>;
    internalNote?: string | null;
    /** Wording for a withdrawn approval, which asks the client for a new document. */
    askAgain?: boolean;
    /** Wording for an approval without documents (the client was verified another way). */
    offline?: boolean;
  };

  /** Records a decision and tells the client and the support service, in the caller's transaction (client row already locked). */
  async function settle(conn: Conn, req: Request, row: Row, o: Outcome) {
    const staff = staffOf(req);
    const before = await one<{ kyc_status: KycOverall }>(conn, "SELECT kyc_status FROM clients WHERE id = ? FOR UPDATE", [row.client_id]);
    await exec(
      conn,
      "UPDATE kyc_submissions SET status = ?, reject_reason = ?, decided_at = CURRENT_TIMESTAMP(3), decided_by = ?, claimed_by = NULL, claimed_until = NULL, checklist = COALESCE(?, checklist) WHERE id = ?",
      [o.status, o.status === "rejected" ? o.reason : null, staff.id, o.checklist ? JSON.stringify(o.checklist) : null, row.id],
    );
    // What the documents were checked against, as it stands at approval.
    if (o.status === "approved") await saveProfileSnapshot(conn, config, row.id, (await loadClient(conn, row.client_id))!);
    const latest = await latestSubmissions(conn, row.client_id, true);
    const overall = overallStatus(latest);
    await exec(conn, "UPDATE clients SET kyc_status = ?, kyc_approved_at = IF(? = 'approved', COALESCE(kyc_approved_at, CURRENT_TIMESTAMP(3)), NULL) WHERE id = ?", [overall, overall, row.client_id]);
    await writeAudit(conn, ctx(req), {
      action: o.action, entityType: "client", entityId: row.client_id,
      before: { status: row.status, decided_by: row.decider_name, kyc_status: before?.kyc_status }, after: { status: o.status, kyc_status: overall },
      meta: { submissionId: row.id, category: row.category, reason: o.reason, ...(o.checklist ? { checklist: o.checklist } : {}), ...(o.internalNote ? { internalNote: o.internalNote } : {}), ...o.meta },
    });
    // One event per decision, so the app sends one push: the overall result when it changes, otherwise this document's.
    const event = overall === "approved" && before?.kyc_status !== "approved" ? "kyc.approved"
      : overall === "rejected" && before?.kyc_status !== "rejected" ? "kyc.rejected"
      : (`kyc.${row.category}.${o.status}` as const);
    await queueSupportEvent(conn, config, { event, clientId: row.client_id, referenceId: row.id });
    await tellClient(conn, row, o, latest, overall);
  }

  /** The bell notification and email for a decision, saying what the client should do next. */
  async function tellClient(conn: Conn, row: Row, o: Outcome, latest: LatestSubmissions, overall: KycOverall) {
    const what = proofOf(row.category);
    if (o.status === "approved") {
      const otherKey = otherCategory(row.category);
      const other = latest[otherKey];
      const uploadOther = overall !== "approved" && other?.status !== "pending";
      const next = overall === "approved"
        ? "Your account is now fully verified."
        : uploadOther ? `Please also upload your ${proofOf(otherKey)}.` : `We will let you know when your ${proofOf(otherKey)} is checked.`;
      const title = o.offline ? `Your ${what} is confirmed` : `Your ${what} is approved`;
      const done = o.offline ? `We have confirmed your ${what}.` : `Your ${what} has been approved.`;
      await notifyClient(conn, row.client_id, { type: "kyc", title, body: o.offline ? `${done} ${next}` : next, link: "/profile", linkLabel: uploadOther ? "Upload now" : "View profile" });
      await queueEmail(conn, config, {
        to: row.email, template: o.offline ? "kyc_confirmed" : "kyc_approved", subject: title, clientId: row.client_id,
        text: `Hello ${row.first_name},\n\n${done} ${next}${uploadOther ? `\n\nYou can upload it in the client portal: ${config.portalUrl}/profile` : ""}\n\nBIS Markets`,
      });
      return;
    }
    const title = o.askAgain ? `Please upload a new ${what}` : `Your ${what} needs another look`;
    await notifyClient(conn, row.client_id, { type: "kyc", title, body: o.reason ?? "Please upload a new document.", link: "/profile", linkLabel: o.askAgain ? "Upload now" : "Upload again" });
    await queueEmail(conn, config, {
      to: row.email, template: o.askAgain ? "kyc_new_document" : "kyc_rejected", subject: o.askAgain ? title : "Your document needs another look", clientId: row.client_id,
      text: o.askAgain
        ? `Hello ${row.first_name},\n\nWe need a new ${what} from you.\n\n${o.reason}\n\nPlease upload it in the client portal: ${config.portalUrl}/profile\n\nBIS Markets`
        : `Hello ${row.first_name},\n\nWe could not approve your ${what}.\n\nReason: ${o.reason}\n\nPlease upload a new document in the client portal: ${config.portalUrl}/profile\n\nBIS Markets`,
    });
  }

  /**
   * Why this staff member may not approve this submission, or null. Whoever
   * uploaded documents for a client never approves them (four eyes, whatever
   * their role), and nothing is approved while the client's profile misses
   * details the documents are checked against. GET /:id shows the same text.
   */
  function approvalBlock(staff: StaffContext, row: Row, missing: RequiredProfileField[], isLatest: boolean): HttpError | null {
    if (!staff.permissions.has("kyc.decide") || !staff.permissions.has("kyc.documents")) return forbidden();
    if (row.client_status === "closed") return badRequest(CLOSED);
    if (row.status === "withdrawn") return badRequest(WITHDRAWN);
    if (row.status === "approved") return badRequest("This submission is already approved.");
    if (!isLatest) return badRequest(NOT_LATEST);
    if (Number(row.documents) > 0 && row.uploaded_by === staff.id) return forbidden("You uploaded these documents, so another reviewer must approve them.");
    if (Number(row.documents) === 0 && !staff.permissions.has("kyc.override")) return forbidden("Approving without documents needs the \"approve without documents\" permission.");
    if (missing.length) return badRequest(`Add the client's ${describeMissing(missing)} to their profile before approving.`);
    return null;
  }

  async function assertMayApprove(conn: Conn, req: Request, row: Row, latest: LatestSubmissions) {
    const client = await loadClient(conn, row.client_id);
    const block = approvalBlock(staffOf(req), row, client ? missingProfileFields(client) : [], latest[row.category]?.id === row.id);
    if (block) throw block;
  }

  /** Approving needs every document, and every page of a PDF, opened by this reviewer (see openedBy). */
  async function assertDocumentsOpened(conn: Conn, staff: StaffContext, row: Row) {
    const docs = await rows<DocRow>(conn, "SELECT id, submission_id, slot, mime, size_bytes, file_name, sha256, pages FROM kyc_documents WHERE submission_id = ?", [row.id]);
    const opened = await openedBy(conn, staff.id, row.client_id);
    if (!docs.every(opened.fully)) throw badRequest("Open every page of the document before approving.");
  }

  async function assertProfileComplete(conn: Conn, clientId: number) {
    const client = await loadClient(conn, clientId);
    const missing = client ? missingProfileFields(client) : [];
    if (missing.length) throw badRequest(`Add the client's ${describeMissing(missing)} to their profile before approving.`);
  }

  router.get(
    "/",
    requirePermission("kyc.view"),
    handler(async (req, res) => {
      const query = parse(
        listQuery(["submitted_at"], "submitted_at").extend({
          status: z.enum(["pending", "approved", "rejected", "withdrawn", "all"]).default("pending"),
          category: z.enum(["identity", "address"]).optional().or(z.literal("").transform(() => undefined)),
          clientId: id.optional(),
          includeClosed: z.enum(["0", "1"]).optional().or(z.literal("").transform(() => undefined)),
        }),
        req.query,
      );
      const where = ["1 = 1"];
      const params: unknown[] = [];
      const s = scope(staffOf(req));
      if (s.sql) (where.push("c.assigned_staff_id = ?"), params.push(...s.params));
      if (query.status !== "all") (where.push("s.status = ?"), params.push(query.status));
      // Nobody can act on a closed account, so its pending items stay out of the queue unless asked for.
      if (query.status === "pending" && query.includeClosed !== "1") where.push("c.status <> 'closed'");
      if (query.category) (where.push("s.category = ?"), params.push(query.category));
      if (query.clientId) (where.push("s.client_id = ?"), params.push(query.clientId));
      if (query.q) {
        const asId = /^\d{1,12}$/.test(query.q) ? Number(query.q) : 0;
        where.push("(c.id = ? OR c.email LIKE ? OR CONCAT(c.first_name, ' ', c.last_name) LIKE ?)");
        params.push(asId, likeTerm(query.q), likeTerm(query.q));
      }
      const clause = ` WHERE ${where.join(" AND ")}`;
      // Oldest first for the pending queue, so nobody waits longest.
      const dir = query.status === "pending" && !req.query.dir ? "ASC" : query.dir === "asc" ? "ASC" : "DESC";
      const total = await one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM kyc_submissions s JOIN clients c ON c.id = s.client_id${clause}`, params);
      const items = await rows<Row>(db, `${SELECT}${clause} ORDER BY s.submitted_at ${dir}, s.id ${dir} LIMIT ? OFFSET ?`, [...params, query.pageSize, (query.page - 1) * query.pageSize]);
      res.json(toPage(items.map(present), Number(total?.n ?? 0), query.page, query.pageSize));
    }),
  );

  router.get(
    "/summary",
    requirePermission("kyc.view"),
    handler(async (req, res) => {
      const s = scope(staffOf(req));
      const me = staffOf(req).id;
      const r = await one<{ pending: number; overdue: number; oldest: Date | null; today: number; mine: number }>(
        db,
        `SELECT SUM(s.status = 'pending' AND c.status <> 'closed') AS pending,
           SUM(s.status = 'pending' AND c.status <> 'closed' AND s.submitted_at < CURRENT_TIMESTAMP(3) - INTERVAL 24 HOUR) AS overdue,
           MIN(IF(s.status = 'pending' AND c.status <> 'closed', s.submitted_at, NULL)) AS oldest,
           SUM(s.decided_at >= CURRENT_DATE AND s.status IN ('approved', 'rejected')) AS today,
           SUM(s.decided_at >= CURRENT_DATE AND s.status IN ('approved', 'rejected') AND s.decided_by = ?) AS mine
         FROM kyc_submissions s JOIN clients c ON c.id = s.client_id WHERE 1 = 1${s.sql}`,
        [me, ...s.params],
      );
      res.json({
        pending: Number(r?.pending ?? 0),
        overdue: Number(r?.overdue ?? 0),
        oldestPendingAt: r?.oldest?.toISOString() ?? null,
        decidedToday: Number(r?.today ?? 0),
        decidedTodayByMe: Number(r?.mine ?? 0),
      });
    }),
  );

  // "Start reviewing" and "next": claims the oldest pending item nobody else holds.
  // Items the caller uploaded (they may not approve them) and closed accounts are skipped.
  router.post(
    "/next",
    decide,
    handler(async (req, res) => {
      const body = parse(
        z.object({ category: z.enum(["identity", "address"]).optional(), skip: z.array(id).max(200).default([]), release: id.optional() }).strict(),
        req.body ?? {},
      );
      const staff = staffOf(req);
      const s = scope(staff);
      const next = await transaction(db, async (conn) => {
        if (body.release) await release(conn, "kyc_submissions", body.release, staff.id);
        const where = [
          "s.status = 'pending'", "c.status <> 'closed'", "(s.uploaded_by IS NULL OR s.uploaded_by <> ?)",
          "(s.claimed_by IS NULL OR s.claimed_until < CURRENT_TIMESTAMP(3) OR s.claimed_by = ?)",
        ];
        const params: unknown[] = [staff.id, staff.id];
        if (s.sql) (where.push("c.assigned_staff_id = ?"), params.push(...s.params));
        if (body.category) (where.push("s.category = ?"), params.push(body.category));
        if (body.skip.length) (where.push(`s.id NOT IN (${body.skip.map(() => "?").join(",")})`), params.push(...body.skip));
        const row = await one<{ id: number }>(
          conn,
          `SELECT s.id FROM kyc_submissions s JOIN clients c ON c.id = s.client_id WHERE ${where.join(" AND ")} ORDER BY s.submitted_at, s.id LIMIT 1 FOR UPDATE OF s SKIP LOCKED`,
          params,
        );
        if (!row) return null;
        await claim(conn, "kyc_submissions", row.id, staff.id);
        return row.id;
      });
      res.json({ id: next });
    }),
  );

  router.post(
    "/:id/claim",
    decide,
    handler(async (req, res) => {
      const body = parse(z.object({ takeOver: z.boolean().default(false) }).strict(), req.body ?? {});
      const staff = staffOf(req);
      const row = await transaction(db, async (conn) => {
        const r = await loadVisible(req, parse(id, req.params.id), conn, true);
        const { tookOverFrom } = await claim(conn, "kyc_submissions", r.id, staff.id, body.takeOver);
        if (tookOverFrom) {
          await writeAudit(conn, ctx(req), { action: "kyc.review_taken_over", entityType: "client", entityId: r.client_id, meta: { submissionId: r.id, from: tookOverFrom } });
        }
        return loadVisible(req, r.id, conn);
      });
      res.json({ claimedBy: present(row).claimedBy, minutes: CLAIM_MINUTES });
    }),
  );

  router.post(
    "/:id/release",
    requirePermission("kyc.decide"),
    handler(async (req, res) => {
      await release(db, "kyc_submissions", parse(id, req.params.id), staffOf(req).id);
      res.json({ ok: true });
    }),
  );

  router.get(
    "/:id",
    openDocuments,
    handler(async (req, res) => {
      const staff = staffOf(req);
      const row = await loadVisible(req, parse(id, req.params.id));
      const client = (await loadClient(db, row.client_id))!;
      const docs = await documentsOf(row.id);
      const latest = await latestSubmissions(db, row.client_id);
      const isLatest = latest[row.category]?.id === row.id;
      const history = await rows<Row>(db, `${SELECT} WHERE s.client_id = ? AND s.category = ? AND s.id <> ? ORDER BY s.id DESC LIMIT 20`, [row.client_id, row.category, row.id]);
      // What this reviewer has opened (approving needs every document and every page of a PDF).
      const opened = await openedBy(db, staff.id, row.client_id);
      const file = (d: DocRow) => ({
        id: d.id, slot: d.slot, type: d.mime, bytes: d.size_bytes, name: d.file_name, url: `/api/staff/kyc/documents/${d.id}`, pages: d.pages,
        viewedByMe: opened.fully(d), ...(isPdf(d.mime) ? { viewedPages: opened.pagesOf(d) } : {}),
      });

      // The other category's latest submission, so a reviewer can compare without leaving this one.
      const otherLatest = latest[otherCategory(row.category)];
      const otherRow = otherLatest ? await one<Row>(db, `${SELECT} WHERE s.id = ?`, [otherLatest.id]) : undefined;
      const other = otherRow
        ? { id: otherRow.id, category: otherRow.category, status: otherRow.status, documentType: present(otherRow).documentType, submittedAt: otherRow.submitted_at.toISOString(), decidedAt: otherRow.decided_at?.toISOString() ?? null, documents: Number(otherRow.documents), files: (await documentsOf(otherRow.id)).map(file) }
        : null;

      const trailRows = await rows<{ occurred_at: Date; action: string; actor_type: string; staff_name: string | null; meta_json: Record<string, unknown> | null }>(
        db,
        `SELECT a.occurred_at, a.action, a.actor_type, u.name AS staff_name, a.meta_json FROM audit_log a LEFT JOIN staff_users u ON a.actor_type = 'staff' AND u.id = a.actor_id
         WHERE a.entity_type = 'client' AND a.entity_id = ? AND a.action IN (${Object.keys(TRAIL).map(() => "?").join(",")}) AND a.meta_json->'$.submissionId' = ? ORDER BY a.id`,
        [String(row.client_id), ...Object.keys(TRAIL), row.id],
      );
      const trail = trailRows.map((a) => {
        const meta = a.meta_json ?? {};
        return {
          at: a.occurred_at.toISOString(),
          action: a.action.replace(/^kyc\./, ""),
          label: a.action === "kyc.decision_changed" && text(meta.from) && text(meta.to) ? `Decision changed from ${meta.from} to ${meta.to}` : TRAIL[a.action]!,
          staff: a.actor_type === "staff" ? (a.staff_name ?? "Staff") : null,
          reason: text(meta.reason) ?? text(meta.note),
          internalNote: text(meta.internalNote),
        };
      });

      // Automatic checks the reviewer would otherwise have to work out by hand.
      const warnings: Warning[] = [];
      if (row.source === "staff") {
        warnings.push({
          tone: "info",
          text: docs.length
            ? `Uploaded by ${row.uploader_name ?? "staff"} on the client's behalf${row.staff_note ? `: ${row.staff_note}` : "."}`
            : `Added without documents by ${row.uploader_name ?? "staff"}${row.staff_note ? `: ${row.staff_note}` : "."}`,
        });
      }
      if (client.dob) {
        const age = ageOn(client.dob);
        if (age < 18) warnings.push({ tone: "bad", text: `The client is ${age} by the date of birth they entered, under 18.` });
        else if (age > 100) warnings.push({ tone: "warn", text: `The date of birth makes the client ${age}. Check it carefully.` });
      }
      if (client.status !== "active") warnings.push({ tone: "warn", text: `The account is ${client.status}.` });
      if (!client.email_verified_at) warnings.push({ tone: "warn", text: "The client has not verified their email address." });
      if (docs.length === 2 && docs[0]!.sha256 === docs[1]!.sha256) warnings.push({ tone: "bad", text: "The front and back are the same file." });
      if (docs.length) {
        const hashes = docs.map((d) => d.sha256);
        const marks = hashes.map(() => "?").join(",");
        // Another client sent the same file. Clients outside the reviewer's scope are not named.
        const dupes = await rows<{ client_id: number; first_name: string; last_name: string; assigned_staff_id: number | null }>(
          db,
          `SELECT DISTINCT s.client_id, c.first_name, c.last_name, c.assigned_staff_id FROM kyc_documents d JOIN kyc_submissions s ON s.id = d.submission_id JOIN clients c ON c.id = s.client_id
           WHERE d.sha256 IN (${marks}) AND s.client_id <> ? LIMIT 5`,
          [...hashes, row.client_id],
        );
        for (const d of dupes.filter((d) => inScope(staff, d.assigned_staff_id))) {
          warnings.push({ tone: "bad", text: `The same file was also uploaded by ${d.first_name} ${d.last_name} (client ${d.client_id}).`, clientId: d.client_id });
        }
        if (dupes.some((d) => !inScope(staff, d.assigned_staff_id))) warnings.push({ tone: "bad", text: "The same file was also uploaded by another client." });
        // The same client's own earlier files: a rejected file sent again, or the proof of identity reused as proof of address.
        const own = await rows<{ id: number; category: KycCategory; status: Row["status"]; decided_at: Date | null }>(
          db,
          `SELECT DISTINCT s.id, s.category, s.status, s.decided_at FROM kyc_documents d JOIN kyc_submissions s ON s.id = d.submission_id
           WHERE s.client_id = ? AND s.id <> ? AND d.sha256 IN (${marks}) ORDER BY s.id`,
          [row.client_id, row.id, ...hashes],
        );
        if (row.category === "address" && own.some((s) => s.category === "identity")) {
          warnings.push({ tone: "bad", text: "This file is the same as one the client sent as proof of identity." });
        }
        const rejectedBefore = own.filter((s) => s.status === "rejected" && s.id < row.id).at(-1);
        if (rejectedBefore) warnings.push({ tone: "bad", text: `The client sent the same file that was rejected on ${longDate(rejectedBefore.decided_at)}.` });
      }
      // The same person on another account: same date of birth and the same name (case, accents and spacing aside).
      if (client.dob) {
        const fullName = `${client.first_name} ${client.last_name}`.toLowerCase().replace(/\s+/g, " ").trim();
        const twins = await rows<{ id: number; first_name: string; last_name: string; status: string; assigned_staff_id: number | null }>(
          db,
          `SELECT id, first_name, last_name, status, assigned_staff_id FROM clients
           WHERE id <> ? AND dob = ? AND REGEXP_REPLACE(LOWER(TRIM(CONCAT(first_name, ' ', last_name))), '[[:space:]]+', ' ') = ? ORDER BY id LIMIT 5`,
          [client.id, client.dob, fullName],
        );
        for (const t of twins.filter((t) => inScope(staff, t.assigned_staff_id))) {
          warnings.push({
            tone: t.status === "active" ? "warn" : "bad",
            text: `The same person may have another account: ${t.first_name} ${t.last_name} (client ${t.id}${t.status === "active" ? "" : `, ${t.status}`}) has the same name and date of birth.`,
            clientId: t.id,
          });
        }
        const hidden = twins.filter((t) => !inScope(staff, t.assigned_staff_id));
        if (hidden.length) {
          warnings.push({ tone: hidden.some((t) => t.status !== "active") ? "bad" : "warn", text: "The same person may have another account: another client has the same name and date of birth." });
        }
      }
      // Profile details the documents are compared with that changed since they were sent (or approved).
      const sealed = await one<{ profile_snapshot_enc: Buffer | null }>(db, "SELECT profile_snapshot_enc FROM kyc_submissions WHERE id = ?", [row.id]);
      const snapshot = readProfileSnapshot(config, row.id, sealed?.profile_snapshot_enc ?? null);
      let changed: SnapshotField[];
      if (snapshot) {
        changed = COMPARED[row.category].filter((f) => !sameProfileValue(snapshot[f], client[f]));
      } else {
        const edits = await rows<{ meta_json: { fields?: unknown } | null }>(
          db,
          "SELECT meta_json FROM audit_log WHERE entity_type = 'client' AND entity_id = ? AND action IN ('client.profile_updated', 'client.updated', 'client.verified_details_changed') AND occurred_at > ?",
          [String(row.client_id), row.submitted_at],
        );
        const fields = new Set(edits.flatMap((e) => (Array.isArray(e.meta_json?.fields) ? (e.meta_json.fields as string[]) : [])));
        changed = COMPARED[row.category].filter((f) => fields.has(f));
      }
      if (changed.length) {
        warnings.push({ tone: "warn", text: `The client's ${listWords(changed.map((f) => FIELD_LABEL[f]))} changed after these documents were sent. Compare against the details shown here.` });
      }
      const rejected = history.filter((h) => h.status === "rejected" && h.id < row.id).length;
      if (rejected) warnings.push({ tone: "info", text: `${rejected} earlier attempt${rejected > 1 ? "s were" : " was"} rejected. See the history below.` });

      const s = scope(staff);
      const queue = await one<{ pending: number; ahead: number }>(
        db,
        `SELECT COUNT(*) AS pending, SUM(s.submitted_at < ?) AS ahead FROM kyc_submissions s JOIN clients c ON c.id = s.client_id WHERE s.status = 'pending' AND c.status <> 'closed'${s.sql}`,
        [row.submitted_at, ...s.params],
      );
      const block = approvalBlock(staff, row, missingProfileFields(client), isLatest);
      await transaction(db, (conn) => writeAudit(conn, ctx(req), { action: "kyc.viewed", entityType: "client", entityId: row.client_id, meta: { submissionId: row.id } }));
      res.json({
        ...present(row),
        client: { ...present(row).client, status: row.client_status },
        uploadedByMe: row.uploaded_by === staff.id && Number(row.documents) > 0,
        isLatest,
        mayApprove: block === null,
        approveBlockedReason: block?.message ?? null,
        files: docs.map(file),
        // The reviewer compares the documents with these details, so they are shown in full (kyc.documents).
        profile: { name: clientName(client), dob: client.dob, gender: client.gender, country: client.country, city: client.city, address: client.address, zipcode: client.zipcode },
        other,
        history: history.map((h) => ({ ...present(h), newer: h.id > row.id })),
        trail,
        warnings,
        checklist: checklistFor(row.category, row.sub_type),
        reasons: KYC_REJECT_REASONS[row.category],
        // Offered by the viewer when a document cannot be shown at all.
        unreadableReason: KYC_UNREADABLE_REASON,
        queue: { pending: Number(queue?.pending ?? 0), position: Number(queue?.ahead ?? 0) + 1 },
      });
    }),
  );

  // Documents are read only by the review screen's own requests, which send X-CRM-Viewer. A link, a
  // download, an image, a frame or the address bar cannot send a header, so a file is never opened or
  // saved outside the review screen (an admin page left open from before an update needs a reload).
  const fromReviewScreen = (req: Request, _res: Response, next: NextFunction) =>
    next(req.get("x-crm-viewer") === "1" ? undefined : forbidden("Open KYC documents from the review screen. If it is already open, reload it."));

  async function readDocument(req: Request) {
    const doc = await one<{ id: number; submission_id: number; slot: number; mime: string; file_name: string; pages: number | null; bytes_enc: Buffer }>(
      db,
      "SELECT id, submission_id, slot, mime, file_name, pages, bytes_enc FROM kyc_documents WHERE id = ?",
      [parse(id, req.params.docId)],
    );
    if (!doc) throw notFound();
    const sub = await loadVisible(req, doc.submission_id);
    return { doc, sub, bytes: decryptBytes(config.dataKey, doc.bytes_enc, kycDocumentContext(doc.submission_id, doc.slot)) };
  }

  /** The file for the review screen to draw. It is never sent as a download. */
  router.get(
    "/documents/:docId",
    openDocuments,
    fromReviewScreen,
    handler(async (req, res) => {
      const { doc, sub, bytes } = await readDocument(req);
      // PDFs stored before pages were counted are counted now, before any page can be marked as seen.
      // The reviewer's browser reads PDFs with no time or memory limit, so one the server's limited pdf.js
      // cannot open is never sent: it stays uncounted and can only be rejected as unreadable.
      if (isPdf(doc.mime) && doc.pages === null) {
        const { pages } = await inspectPdf(bytes);
        if (!pages) throw new HttpError(422, "UNREADABLE", "This PDF could not be opened.");
        await exec(db, "UPDATE kyc_documents SET pages = ? WHERE id = ? AND pages IS NULL", [pages, doc.id]);
      }
      // HEIC photos stored before uploads were converted are shown as JPEG, which every browser draws.
      const heic = doc.mime === "image/heic";
      const body = heic
        ? await heicAsJpeg(bytes).catch(() => {
            throw new HttpError(422, "UNREADABLE", "This photo could not be opened.");
          })
        : bytes;
      await transaction(db, (conn) =>
        writeAudit(conn, ctx(req), { action: "kyc.document_viewed", entityType: "client", entityId: sub.client_id, meta: { submissionId: sub.id, documentId: doc.id } }),
      );
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", heic ? "image/jpeg" : doc.mime);
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.setHeader("Content-Disposition", "inline");
      // The review screen checks the copy it gets against this. A browser extension that catches files
      // (a download manager, for one) can hand the page an empty or changed copy of a good document.
      res.setHeader("X-Document-SHA256", sha256(body));
      res.send(body);
    }),
  );

  // Saving the original to a computer is its own permission, needs a recent 2FA code and has its own
  // audit entry. It does not count as reviewing: approving needs the document opened in the review screen.
  router.get(
    "/documents/:docId/download",
    requirePermission("kyc.view", "kyc.documents", "kyc.download"),
    fromReviewScreen,
    stepUp,
    handler(async (req, res) => {
      const { doc, sub, bytes } = await readDocument(req);
      await transaction(db, (conn) =>
        writeAudit(conn, ctx(req), { action: "kyc.document_downloaded", entityType: "client", entityId: sub.client_id, meta: { submissionId: sub.id, documentId: doc.id } }),
      );
      const ext = isPdf(doc.mime) ? "pdf" : doc.mime.split("/")[1];
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", doc.mime);
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.setHeader("Content-Disposition", `attachment; filename="client-${sub.client_id}-${sub.category}-${doc.slot}.${ext}"`);
      res.send(bytes);
    }),
  );

  // The review screen reports each PDF page it drew: approving needs all of them.
  router.post(
    "/documents/:docId/pages",
    openDocuments,
    handler(async (req, res) => {
      const staff = staffOf(req);
      const { page } = parse(z.object({ page: z.number().int().min(1) }).strict(), req.body ?? {});
      const doc = await one<{ id: number; submission_id: number; mime: string; pages: number | null }>(db, "SELECT id, submission_id, mime, pages FROM kyc_documents WHERE id = ?", [
        parse(id, req.params.docId),
      ]);
      if (!doc) throw notFound();
      const sub = await loadVisible(req, doc.submission_id);
      if (!isPdf(doc.mime) || doc.pages === null || page > doc.pages) throw badRequest("That page is not part of this document.");
      await transaction(db, async (conn) => {
        const seen = await rows<{ action: string; page: number | null }>(
          conn,
          `SELECT action, CAST(meta_json->>'$.page' AS UNSIGNED) AS page FROM audit_log WHERE entity_type = 'client' AND entity_id = ? AND actor_type = 'staff' AND actor_id = ?
             AND action IN ('kyc.document_viewed', 'kyc.document_page_viewed') AND meta_json->'$.documentId' = ?`,
          [String(sub.client_id), staff.id, doc.id],
        );
        // Only a reviewer who fetched the file can have seen its pages; each page is recorded once.
        if (!seen.some((e) => e.action === "kyc.document_viewed")) throw badRequest("Open the document first.");
        if (seen.some((e) => e.action === "kyc.document_page_viewed" && Number(e.page) === page)) return;
        await writeAudit(conn, ctx(req), { action: "kyc.document_page_viewed", entityType: "client", entityId: sub.client_id, meta: { submissionId: sub.id, documentId: doc.id, page } });
      });
      res.status(204).end();
    }),
  );

  router.post(
    "/:id/decision",
    decide,
    stepUp,
    handler(async (req, res) => {
      const body = parse(
        z
          .object({ decision: z.enum(["approve", "reject"]), reason: z.string().trim().max(500).optional(), checklist: z.array(z.string().max(32)).max(10).default([]), internalNote })
          .strict()
          .refine((v) => v.decision === "approve" || (v.reason && v.reason.length >= 5), { message: "Tell the client why, so they can fix it", path: ["reason"] })
          // The portal shows the reason exactly as written, but only when it is plain text.
          .refine((v) => !v.reason || plain(v.reason), { message: PLAIN_MESSAGE, path: ["reason"] }),
        req.body,
      );
      const staff = staffOf(req);
      const submissionId = parse(id, req.params.id);
      const clientId = await clientOfSubmission(submissionId);
      const updated = await transaction(db, async (conn) => {
        await lockClientOf(conn, clientId);
        const row = await loadVisible(req, submissionId, conn, true);
        if (row.status === "withdrawn") throw badRequest(WITHDRAWN);
        if (row.status !== "pending") throw badRequest(`This submission was already ${row.status}${row.decider_name ? ` by ${row.decider_name}` : ""}.`);
        assertNotClaimedByOther(row, staff.id);
        if (row.client_status === "closed") throw badRequest(CLOSED);
        const required = checklistFor(row.category, row.sub_type).map((c) => c.key);
        const ticked = required.filter((k) => body.checklist.includes(k));
        if (body.decision === "approve") {
          if (ticked.length !== required.length) throw badRequest("Tick every check before approving.");
          await assertMayApprove(conn, req, row, await latestSubmissions(conn, row.client_id, true));
          await assertDocumentsOpened(conn, staff, row);
        }
        const status = body.decision === "approve" ? "approved" : "rejected";
        await settle(conn, req, row, { status, reason: body.reason ?? null, checklist: ticked, action: `kyc.${status}`, internalNote: body.internalNote });
        return loadVisible(req, row.id, conn);
      });
      res.json(present(updated));
    }),
  );

  // Change a decision later: approve a rejected document. Taking back an
  // approval is "Ask for a new document" (/request-new), which tells the client what to send.
  router.post(
    "/:id/change",
    decide,
    stepUp,
    handler(async (req, res) => {
      // Checked before the body, so the pointer shows even when no reason was given.
      if ((req.body as { status?: unknown } | undefined)?.status === "rejected") {
        throw badRequest("To take back an approval, use \"Ask for a new document\". It tells the client what to send instead.");
      }
      const body = parse(
        z.object({ status: z.literal("approved"), reason: reasonText, checklist: z.array(z.string().max(32)).max(10).default([]), internalNote }).strict(),
        req.body,
      );
      const staff = staffOf(req);
      const submissionId = parse(id, req.params.id);
      const clientId = await clientOfSubmission(submissionId);
      const updated = await transaction(db, async (conn) => {
        await lockClientOf(conn, clientId);
        const row = await loadVisible(req, submissionId, conn, true);
        if (row.status === "pending") throw badRequest("This submission has not been decided yet. Approve or reject it from the review screen.");
        await assertMayApprove(conn, req, row, await latestSubmissions(conn, row.client_id, true));
        let checklist: string[] | undefined;
        if (Number(row.documents) > 0) {
          const required = checklistFor(row.category, row.sub_type).map((c) => c.key);
          checklist = required.filter((k) => body.checklist.includes(k));
          if (checklist.length !== required.length) throw badRequest("Tick every check before approving.");
          await assertDocumentsOpened(conn, staff, row);
        }
        // The reason is for the audit log; the client is told the document is approved.
        await settle(conn, req, row, { status: "approved", reason: body.reason, checklist, action: "kyc.decision_changed", meta: { from: row.status, to: "approved" }, internalNote: body.internalNote });
        return loadVisible(req, row.id, conn);
      });
      res.json(present(updated));
    }),
  );

  // Upload documents on the client's behalf, for example ones they emailed in.
  router.post(
    "/upload",
    requirePermission("kyc.upload"),
    stepUp,
    express.raw({ type: "multipart/form-data", limit: 2 * KYC_MAX_BYTES + 256 * 1024 }),
    handler(async (req, res) => {
      const upload = await parseKycUpload(req.body, req.get("content-type"));
      const clientId = parse(id, upload.form.get("client_id"));
      const note = parse(reasonText, String(upload.form.get("note") ?? ""));
      const staff = staffOf(req);
      const created = await transaction(db, async (conn) => {
        const s = scope(staff);
        const client = await one<{ id: number; status: string }>(conn, `SELECT c.id, c.status FROM clients c WHERE c.id = ?${s.sql} FOR UPDATE`, [clientId, ...s.params]);
        if (!client) throw notFound("That client does not exist or is not assigned to you.");
        if (client.status === "closed") throw badRequest("This account is closed. Reopen it before adding documents.");
        // A plain read (the client row is locked): a locking one before the insert deadlocks with other clients' uploads.
        const current = (await latestSubmissions(conn, clientId))[upload.category];
        if (current && current.status !== "rejected") {
          throw badRequest(current.status === "approved" ? "This is already approved. Ask for a new document first if it needs replacing." : "A document is already waiting for review. Decide that one first.");
        }
        const profile = (await loadClient(conn, clientId))!;
        const submissionId = await storeSubmission(conn, config, { clientId, category: upload.category, subType: upload.subType.id, files: upload.files, ip: req.clientIp, uploadedBy: staff.id, note, profile });
        const overall = overallStatus(await latestSubmissions(conn, clientId, true));
        await exec(conn, "UPDATE clients SET kyc_status = ? WHERE id = ?", [overall, clientId]);
        await writeAudit(conn, ctx(req), {
          action: "kyc.uploaded_by_staff", entityType: "client", entityId: clientId,
          meta: { submissionId, category: upload.category, subType: upload.subType.name, note, files: auditedFiles(upload.files) },
        });
        await notifyClient(conn, clientId, { type: "kyc", title: `We added your ${proofOf(upload.category)}`, body: "Our team uploaded this document for you. It is now being checked.", link: "/profile", linkLabel: "View profile" });
        return loadVisible(req, submissionId, conn);
      });
      res.status(201).json(present(created));
    }),
  );

  // Approve without documents, for example a client verified another way. Needs kyc.override.
  router.post(
    "/approve-without-documents",
    requirePermission("kyc.override"),
    stepUp,
    handler(async (req, res) => {
      const body = parse(
        z.object({ clientId: id, category: z.enum(["identity", "address"]), subType: z.coerce.number().int().positive(), reason: reasonText, internalNote }).strict()
          .refine((v) => subTypeOf(v.category, v.subType), { message: "Choose a document type.", path: ["subType"] }),
        req.body,
      );
      const staff = staffOf(req);
      const updated = await transaction(db, async (conn) => {
        const s = scope(staff);
        const client = await one<{ id: number; status: string }>(conn, `SELECT c.id, c.status FROM clients c WHERE c.id = ?${s.sql} FOR UPDATE`, [body.clientId, ...s.params]);
        if (!client) throw notFound("That client does not exist or is not assigned to you.");
        if (client.status === "closed") throw badRequest(CLOSED);
        // A plain read (the client row is locked): a locking one before the insert deadlocks with other clients' uploads.
        const current = (await latestSubmissions(conn, body.clientId))[body.category];
        if (current?.status === "approved") throw badRequest("This is already approved.");
        if (current?.status === "pending") throw badRequest("A document is waiting for review. Open it and approve or reject it instead.");
        await assertProfileComplete(conn, body.clientId);
        const profile = (await loadClient(conn, body.clientId))!;
        const submissionId = await storeSubmission(conn, config, { clientId: body.clientId, category: body.category, subType: body.subType, files: [], ip: req.clientIp, uploadedBy: staff.id, note: body.reason, profile });
        const row = await loadVisible(req, submissionId, conn, true);
        await settle(conn, req, row, { status: "approved", reason: body.reason, action: "kyc.approved_without_documents", offline: true, internalNote: body.internalNote });
        return loadVisible(req, submissionId, conn);
      });
      res.json(present(updated));
    }),
  );

  // Ask for a new document after approval, for example when an ID has expired.
  // The approval stays in the audit log; the client sees the reason and can upload again.
  router.post(
    "/:id/request-new",
    decide,
    stepUp,
    handler(async (req, res) => {
      const body = parse(
        z.object({ reason: z.string().trim().min(5, "Tell the client what to upload").max(500), internalNote }).strict()
          .refine((v) => plain(v.reason), { message: PLAIN_MESSAGE, path: ["reason"] }),
        req.body,
      );
      const submissionId = parse(id, req.params.id);
      const clientId = await clientOfSubmission(submissionId);
      const updated = await transaction(db, async (conn) => {
        await lockClientOf(conn, clientId);
        const row = await loadVisible(req, submissionId, conn, true);
        if (row.status !== "approved") throw badRequest("Only an approved document can be requested again. Reject a pending one instead.");
        if (row.client_status === "closed") throw badRequest(CLOSED);
        if ((await latestSubmissions(conn, row.client_id, true))[row.category]?.id !== row.id) throw badRequest(NOT_LATEST);
        await settle(conn, req, row, { status: "rejected", reason: body.reason, action: "kyc.new_document_requested", askAgain: true, internalNote: body.internalNote });
        return loadVisible(req, row.id, conn);
      });
      res.json(present(updated));
    }),
  );

  return router;
}
