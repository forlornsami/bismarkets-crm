import express, { Router, type Request } from "express";
import { z } from "zod";
import type { AppDeps } from "../../app";
import { KYC_CHECKLIST, KYC_MAX_BYTES, KYC_REJECT_REASONS, KYC_TYPES, kycDocumentContext, latestSubmissions, overallStatus, parseKycUpload, storeSubmission, subTypeOf, type KycCategory } from "../../clients/kyc";
import { clientName } from "../../clients/model";
import { auditContext, writeAudit } from "../../lib/audit";
import { decryptBytes, sha256 } from "../../lib/crypto";
import { exec, one, rows, transaction } from "../../lib/db";
import { queueEmail } from "../../lib/email";
import { queueSupportEvent } from "../../lib/events";
import { notifyClient } from "../../clients/notifications";
import { badRequest, forbidden, handler, notFound, parse } from "../../lib/http";
import { likeTerm, listQuery, toPage } from "../../lib/pagination";
import { requirePermission, requireStepUp, staffActor, staffOf, type StaffContext } from "../../staff/session";
import { activeClaim, assertNotClaimedByOther, claim, CLAIM_MINUTES, release } from "../../lib/review";

const id = z.coerce.number().int().positive();
// The portal shows a rejection reason exactly as written, but only when it is plain text.
const plain = (v: string) => !/[<>{}`\\]|https?:|\bwww\./i.test(v);
const PLAIN_MESSAGE = "Write the reason as plain text, without links or symbols like < > { }";
const reasonText = z.string().trim().min(5, "Write a short reason (at least 5 characters)").max(500).refine(plain, PLAIN_MESSAGE);

interface Row {
  id: number;
  client_id: number;
  category: KycCategory;
  sub_type: number;
  source: "client" | "staff";
  uploaded_by: number | null;
  uploader_name: string | null;
  staff_note: string | null;
  status: "pending" | "approved" | "rejected";
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
  documents: number;
}

const SELECT = `SELECT s.id, s.client_id, s.category, s.sub_type, s.source, s.uploaded_by, up.name AS uploader_name, s.staff_note, s.status, s.reject_reason, s.submitted_at, s.decided_at,
  u.name AS decider_name, s.claimed_by, s.claimed_until, cl.name AS claimer_name, c.first_name, c.last_name, c.email, c.country,
  (SELECT COUNT(*) FROM kyc_documents d WHERE d.submission_id = s.id) AS documents
  FROM kyc_submissions s JOIN clients c ON c.id = s.client_id LEFT JOIN staff_users u ON u.id = s.decided_by LEFT JOIN staff_users cl ON cl.id = s.claimed_by
  LEFT JOIN staff_users up ON up.id = s.uploaded_by`;

const present = (r: Row) => ({
  id: r.id,
  client: { id: r.client_id, name: clientName(r), email: r.email, country: r.country },
  category: r.category,
  categoryLabel: KYC_TYPES[r.category].label,
  documentType: subTypeOf(r.category, r.sub_type)?.name ?? `Type ${r.sub_type}`,
  status: r.status,
  rejectReason: r.reject_reason,
  submittedAt: r.submitted_at.toISOString(),
  decidedAt: r.decided_at?.toISOString() ?? null,
  decidedBy: r.decider_name,
  documents: Number(r.documents),
  source: r.source,
  uploadedBy: r.source === "staff" ? (r.uploader_name ?? "staff") : null,
  staffNote: r.staff_note,
  claimedBy: activeClaim(r) ? { id: r.claimed_by!, name: r.claimer_name, until: r.claimed_until!.toISOString() } : null,
});

const ageOn = (dob: string, now = new Date()) => {
  const [y = 0, m = 1, d = 1] = dob.split("-").map(Number);
  let age = now.getUTCFullYear() - y;
  if (now.getUTCMonth() + 1 < m || (now.getUTCMonth() + 1 === m && now.getUTCDate() < d)) age--;
  return age;
};
type Warning = { tone: "bad" | "warn" | "info"; text: string; clientId?: number };

/** The KYC review queue: open documents, approve or reject, all audited. */
export function staffKycRouter(deps: AppDeps): Router {
  const { db, config } = deps;
  const router = Router();
  const stepUp = requireStepUp(config);
  const ctx = (req: Request) => auditContext(req, staffActor(staffOf(req)));
  const scope = (staff: StaffContext) =>
    staff.permissions.has("client.view_all") ? { sql: "", params: [] as unknown[] } : { sql: " AND c.assigned_staff_id = ?", params: [staff.id] as unknown[] };

  async function loadVisible(req: Request, submissionId: number, conn = db as Parameters<typeof one>[0], lock = false) {
    const s = scope(staffOf(req));
    const row = await one<Row>(conn, `${SELECT} WHERE s.id = ?${s.sql}${lock ? " FOR UPDATE OF s" : ""}`, [submissionId, ...s.params]);
    if (!row) throw notFound("That submission does not exist or its client is not assigned to you.");
    return row;
  }

  type Outcome = {
    status: "approved" | "rejected";
    reason: string | null;
    checklist?: string[];
    action: string;
    meta?: Record<string, unknown>;
    /** Wording for a withdrawn approval, which asks the client for a new document. */
    askAgain?: boolean;
  };

  /** Records a decision and tells the client and the support service, in the caller's transaction. */
  async function settle(conn: Parameters<typeof exec>[0], req: Request, row: Row, o: Outcome) {
    const staff = staffOf(req);
    await exec(
      conn,
      "UPDATE kyc_submissions SET status = ?, reject_reason = ?, decided_at = CURRENT_TIMESTAMP(3), decided_by = ?, claimed_by = NULL, claimed_until = NULL, checklist = COALESCE(?, checklist) WHERE id = ?",
      [o.status, o.status === "rejected" ? o.reason : null, staff.id, o.checklist ? JSON.stringify(o.checklist) : null, row.id],
    );
    const before = await one<{ kyc_status: string }>(conn, "SELECT kyc_status FROM clients WHERE id = ? FOR UPDATE", [row.client_id]);
    const overall = overallStatus(await latestSubmissions(conn, row.client_id));
    await exec(conn, "UPDATE clients SET kyc_status = ?, kyc_approved_at = IF(? = 'approved', COALESCE(kyc_approved_at, CURRENT_TIMESTAMP(3)), NULL) WHERE id = ?", [overall, overall, row.client_id]);
    await writeAudit(conn, ctx(req), {
      action: o.action, entityType: "client", entityId: row.client_id,
      before: { status: row.status, decided_by: row.decider_name, kyc_status: before?.kyc_status }, after: { status: o.status, kyc_status: overall },
      meta: { submissionId: row.id, category: row.category, reason: o.reason, ...(o.checklist ? { checklist: o.checklist } : {}), ...o.meta },
    });
    const what = row.category === "identity" ? "proof of identity" : "proof of address";
    await queueSupportEvent(conn, config, { event: `kyc.${row.category}.${o.status}`, clientId: row.client_id, referenceId: row.id });
    if (overall === "approved" && before?.kyc_status !== "approved") await queueSupportEvent(conn, config, { event: "kyc.approved", clientId: row.client_id, referenceId: row.id });
    if (o.status === "rejected") await queueSupportEvent(conn, config, { event: "kyc.rejected", clientId: row.client_id, referenceId: row.id });
    const fullyVerified = overall === "approved";
    if (o.status === "approved") {
      await notifyClient(conn, row.client_id, { type: "kyc", title: `Your ${what} is approved`, body: fullyVerified ? "Your account is now fully verified." : "Thank you. We will let you know when the rest of your documents are checked.", link: "/profile", linkLabel: "View profile" });
      await queueEmail(conn, config, {
        to: row.email, template: "kyc_approved", subject: "Your document was approved", clientId: row.client_id,
        text: `Hello ${row.first_name},\n\nYour ${what} has been approved.${fullyVerified ? " Your account is now fully verified." : ""}\n\nBIS Markets`,
      });
    } else {
      const title = o.askAgain ? `Please upload a new ${what}` : `Your ${what} needs another look`;
      await notifyClient(conn, row.client_id, { type: "kyc", title, body: o.reason ?? "Please upload a new document.", link: "/profile", linkLabel: o.askAgain ? "Upload now" : "Upload again" });
      await queueEmail(conn, config, {
        to: row.email, template: o.askAgain ? "kyc_new_document" : "kyc_rejected", subject: o.askAgain ? title : "Your document needs another look", clientId: row.client_id,
        text: o.askAgain
          ? `Hello ${row.first_name},\n\nWe need a new ${what} from you.\n\n${o.reason}\n\nPlease upload it in the client portal: ${config.portalUrl}/profile\n\nBIS Markets`
          : `Hello ${row.first_name},\n\nWe could not approve your ${what}.\n\nReason: ${o.reason}\n\nPlease upload a new document in the client portal: ${config.portalUrl}/profile\n\nBIS Markets`,
      });
    }
  }

  /** Staff who uploaded documents themselves need kyc.override to approve them (four eyes). */
  function assertMayApprove(req: Request, row: Row) {
    const staff = staffOf(req);
    if (row.uploaded_by === staff.id && !staff.permissions.has("kyc.override")) {
      throw forbidden("You uploaded these documents, so another reviewer must approve them.");
    }
    if (Number(row.documents) === 0 && !staff.permissions.has("kyc.override")) {
      throw forbidden("Approving without documents needs the \"approve without documents\" permission.");
    }
  }

  async function assertLatest(conn: Parameters<typeof exec>[0], row: Row) {
    const latest = await latestSubmissions(conn, row.client_id);
    if (latest[row.category]?.id !== row.id) throw badRequest("The client has a newer submission for this. Change that one instead.");
  }

  router.get(
    "/",
    requirePermission("kyc.view"),
    handler(async (req, res) => {
      const query = parse(
        listQuery(["submitted_at"], "submitted_at").extend({
          status: z.enum(["pending", "approved", "rejected", "all"]).default("pending"),
          category: z.enum(["identity", "address"]).optional().or(z.literal("").transform(() => undefined)),
          clientId: id.optional(),
        }),
        req.query,
      );
      const where = ["1 = 1"];
      const params: unknown[] = [];
      const s = scope(staffOf(req));
      if (s.sql) (where.push("c.assigned_staff_id = ?"), params.push(...s.params));
      if (query.status !== "all") (where.push("s.status = ?"), params.push(query.status));
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
        `SELECT SUM(s.status = 'pending') AS pending,
           SUM(s.status = 'pending' AND s.submitted_at < CURRENT_TIMESTAMP(3) - INTERVAL 24 HOUR) AS overdue,
           MIN(IF(s.status = 'pending', s.submitted_at, NULL)) AS oldest,
           SUM(s.decided_at >= CURRENT_DATE) AS today,
           SUM(s.decided_at >= CURRENT_DATE AND s.decided_by = ?) AS mine
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
  router.post(
    "/next",
    requirePermission("kyc.decide"),
    handler(async (req, res) => {
      const body = parse(
        z.object({ category: z.enum(["identity", "address"]).optional(), skip: z.array(id).max(200).default([]), release: id.optional() }).strict(),
        req.body ?? {},
      );
      const staff = staffOf(req);
      const s = scope(staff);
      const next = await transaction(db, async (conn) => {
        if (body.release) await release(conn, "kyc_submissions", body.release, staff.id);
        const where = ["s.status = 'pending'", "(s.claimed_by IS NULL OR s.claimed_until < CURRENT_TIMESTAMP(3) OR s.claimed_by = ?)"];
        const params: unknown[] = [staff.id];
        if (s.sql) (where.push("c.assigned_staff_id = ?"), params.push(...s.params));
        if (body.category) (where.push("s.category = ?"), params.push(body.category));
        if (body.skip.length) (where.push(`s.id NOT IN (${body.skip.map(() => "?").join(",")})`), params.push(...body.skip));
        const row = await one<{ id: number }>(
          conn,
          `SELECT s.id FROM kyc_submissions s JOIN clients c ON c.id = s.client_id WHERE ${where.join(" AND ")} ORDER BY s.submitted_at, s.id LIMIT 1 FOR UPDATE SKIP LOCKED`,
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
    requirePermission("kyc.decide"),
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
    requirePermission("kyc.view"),
    handler(async (req, res) => {
      const row = await loadVisible(req, parse(id, req.params.id));
      const docs = await rows<{ id: number; slot: number; mime: string; size_bytes: number; file_name: string; sha256: string }>(
        db,
        "SELECT id, slot, mime, size_bytes, file_name, sha256 FROM kyc_documents WHERE submission_id = ? ORDER BY slot",
        [row.id],
      );
      // The reviewer compares the documents with what the client entered, so the profile is shown in full here.
      const profile = await one<{ first_name: string; last_name: string; dob: string | null; country: string | null; city: string | null; address: string | null; zipcode: string | null; phone: string | null; phone_code: string | null; gender: string | null; status: string; email_verified_at: Date | null }>(
        db,
        "SELECT first_name, last_name, DATE_FORMAT(dob, '%Y-%m-%d') AS dob, country, city, address, zipcode, phone, phone_code, gender, status, email_verified_at FROM clients WHERE id = ?",
        [row.client_id],
      );
      const history = await rows<Row>(db, `${SELECT} WHERE s.client_id = ? AND s.category = ? AND s.id <> ? ORDER BY s.id DESC LIMIT 20`, [row.client_id, row.category, row.id]);

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
      if (profile?.dob) {
        const age = ageOn(profile.dob);
        if (age < 18) warnings.push({ tone: "bad", text: `The client is ${age} by the date of birth they entered, under 18.` });
        else if (age > 100) warnings.push({ tone: "warn", text: `The date of birth makes the client ${age}. Check it carefully.` });
      }
      if (profile && profile.status !== "active") warnings.push({ tone: "warn", text: `The account is ${profile.status}.` });
      if (profile && !profile.email_verified_at) warnings.push({ tone: "warn", text: "The client has not verified their email address." });
      if (docs.length === 2 && docs[0]!.sha256 === docs[1]!.sha256) warnings.push({ tone: "bad", text: "The front and back are the same file." });
      if (docs.length) {
        const dupes = await rows<{ client_id: number; first_name: string; last_name: string }>(
          db,
          `SELECT DISTINCT s.client_id, c.first_name, c.last_name FROM kyc_documents d JOIN kyc_submissions s ON s.id = d.submission_id JOIN clients c ON c.id = s.client_id
           WHERE d.sha256 IN (${docs.map(() => "?").join(",")}) AND s.client_id <> ? LIMIT 5`,
          [...docs.map((d) => d.sha256), row.client_id],
        );
        for (const d of dupes) warnings.push({ tone: "bad", text: `The same file was also uploaded by ${d.first_name} ${d.last_name} (client ${d.client_id}).`, clientId: d.client_id });
      }
      const edited = await one<{ n: number }>(
        db,
        "SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'client' AND entity_id = ? AND action IN ('client.profile_updated', 'client.updated') AND occurred_at > ?",
        [String(row.client_id), row.submitted_at],
      );
      if (Number(edited?.n)) warnings.push({ tone: "info", text: "The profile was edited after these documents were sent. Compare against the details shown here." });
      const rejected = history.filter((h) => h.status === "rejected").length;
      if (rejected) warnings.push({ tone: "info", text: `${rejected} earlier attempt${rejected > 1 ? "s were" : " was"} rejected. See the history below.` });

      const s = scope(staffOf(req));
      const queue = await one<{ pending: number; ahead: number }>(
        db,
        `SELECT COUNT(*) AS pending, SUM(s.submitted_at < ?) AS ahead FROM kyc_submissions s JOIN clients c ON c.id = s.client_id WHERE s.status = 'pending'${s.sql}`,
        [row.submitted_at, ...s.params],
      );
      await transaction(db, (conn) => writeAudit(conn, ctx(req), { action: "kyc.viewed", entityType: "client", entityId: row.client_id, meta: { submissionId: row.id } }));
      res.json({
        ...present(row),
        files: docs.map((d) => ({ id: d.id, slot: d.slot, type: d.mime, bytes: d.size_bytes, name: d.file_name, url: `/api/staff/kyc/documents/${d.id}` })),
        profile: profile
          ? { name: `${profile.first_name} ${profile.last_name}`, dob: profile.dob, gender: profile.gender, country: profile.country, city: profile.city, address: profile.address, zipcode: profile.zipcode, phone: profile.phone, phone_code: profile.phone_code }
          : null,
        history: history.map(present),
        warnings,
        checklist: KYC_CHECKLIST[row.category],
        reasons: KYC_REJECT_REASONS[row.category],
        queue: { pending: Number(queue?.pending ?? 0), position: Number(queue?.ahead ?? 0) + 1 },
      });
    }),
  );

  router.get(
    "/documents/:docId",
    requirePermission("kyc.view"),
    handler(async (req, res) => {
      const doc = await one<{ id: number; submission_id: number; slot: number; mime: string; file_name: string; bytes_enc: Buffer }>(
        db,
        "SELECT id, submission_id, slot, mime, file_name, bytes_enc FROM kyc_documents WHERE id = ?",
        [parse(id, req.params.docId)],
      );
      if (!doc) throw notFound();
      const sub = await loadVisible(req, doc.submission_id);
      const bytes = decryptBytes(config.dataKey, doc.bytes_enc, kycDocumentContext(doc.submission_id, doc.slot));
      await transaction(db, (conn) => writeAudit(conn, ctx(req), { action: "kyc.document_viewed", entityType: "client", entityId: sub.client_id, meta: { submissionId: sub.id, documentId: doc.id } }));
      const image = doc.mime.startsWith("image/") && doc.mime !== "image/heic";
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", doc.mime);
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      // Images open in the review screen; PDFs and HEIC photos download instead.
      const ext = doc.mime === "application/pdf" ? "pdf" : doc.mime.split("/")[1];
      res.setHeader("Content-Disposition", image ? "inline" : `attachment; filename="client-${sub.client_id}-${sub.category}-${doc.slot}.${ext}"`);
      res.send(bytes);
    }),
  );

  router.post(
    "/:id/decision",
    requirePermission("kyc.decide"),
    stepUp,
    handler(async (req, res) => {
      const body = parse(
        z
          .object({ decision: z.enum(["approve", "reject"]), reason: z.string().trim().max(500).optional(), checklist: z.array(z.string().max(32)).max(10).default([]) })
          .strict()
          .refine((v) => v.decision === "approve" || (v.reason && v.reason.length >= 5), { message: "Tell the client why, so they can fix it", path: ["reason"] })
          // The portal shows the reason exactly as written, but only when it is plain text.
          .refine((v) => !v.reason || !/[<>{}`\\]|https?:|\bwww\./i.test(v.reason), { message: "Write the reason as plain text, without links or symbols like < > { }", path: ["reason"] }),
        req.body,
      );
      const staff = staffOf(req);
      const updated = await transaction(db, async (conn) => {
        const row = await loadVisible(req, parse(id, req.params.id), conn, true);
        if (row.status !== "pending") throw badRequest(`This submission was already ${row.status}${row.decider_name ? ` by ${row.decider_name}` : ""}.`);
        assertNotClaimedByOther(row, staff.id);
        const required = KYC_CHECKLIST[row.category].map((c) => c.key);
        const ticked = required.filter((k) => body.checklist.includes(k));
        if (body.decision === "approve") {
          if (ticked.length !== required.length) throw badRequest("Tick every check before approving.");
          assertMayApprove(req, row);
        }
        const status = body.decision === "approve" ? "approved" : "rejected";
        await settle(conn, req, row, { status, reason: body.reason ?? null, checklist: ticked, action: `kyc.${status}` });
        return loadVisible(req, row.id, conn);
      });
      res.json(present(updated));
    }),
  );

  // Change a decision later: approve a rejected document, or reject an approved one.
  router.post(
    "/:id/change",
    requirePermission("kyc.decide"),
    stepUp,
    handler(async (req, res) => {
      const body = parse(
        z.object({ status: z.enum(["approved", "rejected"]), reason: reasonText, checklist: z.array(z.string().max(32)).max(10).default([]) }).strict(),
        req.body,
      );
      const updated = await transaction(db, async (conn) => {
        const row = await loadVisible(req, parse(id, req.params.id), conn, true);
        if (row.status === "pending") throw badRequest("This submission has not been decided yet. Approve or reject it from the review screen.");
        if (row.status === body.status) throw badRequest(`This submission is already ${row.status}.`);
        await assertLatest(conn, row);
        let checklist: string[] | undefined;
        if (body.status === "approved") {
          assertMayApprove(req, row);
          if (Number(row.documents) > 0) {
            const required = KYC_CHECKLIST[row.category].map((c) => c.key);
            checklist = required.filter((k) => body.checklist.includes(k));
            if (checklist.length !== required.length) throw badRequest("Tick every check before approving.");
          }
        }
        // An approval's reason is for the audit log; a rejection's reason is shown to the client.
        await settle(conn, req, row, { status: body.status, reason: body.reason, checklist, action: "kyc.decision_changed", meta: { from: row.status, to: body.status } });
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
        const current = (await latestSubmissions(conn, clientId))[upload.category];
        if (current && current.status !== "rejected") {
          throw badRequest(current.status === "approved" ? "This is already approved. Change that decision first if the document needs replacing." : "A document is already waiting for review. Decide that one first.");
        }
        const submissionId = await storeSubmission(conn, config, { clientId, category: upload.category, subType: upload.subType.id, files: upload.files, ip: req.clientIp, uploadedBy: staff.id, note });
        const overall = overallStatus(await latestSubmissions(conn, clientId));
        await exec(conn, "UPDATE clients SET kyc_status = ? WHERE id = ?", [overall, clientId]);
        await writeAudit(conn, ctx(req), {
          action: "kyc.uploaded_by_staff", entityType: "client", entityId: clientId,
          meta: { submissionId, category: upload.category, subType: upload.subType.name, note, files: upload.files.map((f) => ({ type: f.mime, bytes: f.bytes.length, sha256: sha256(f.bytes) })) },
        });
        const what = upload.category === "identity" ? "proof of identity" : "proof of address";
        await notifyClient(conn, clientId, { type: "kyc", title: `We added your ${what}`, body: "Our team uploaded this document for you. It is now being checked.", link: "/profile", linkLabel: "View profile" });
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
        z.object({ clientId: id, category: z.enum(["identity", "address"]), subType: z.coerce.number().int().positive(), reason: reasonText }).strict()
          .refine((v) => subTypeOf(v.category, v.subType), { message: "Choose a document type.", path: ["subType"] }),
        req.body,
      );
      const staff = staffOf(req);
      const updated = await transaction(db, async (conn) => {
        const s = scope(staff);
        const client = await one<{ id: number }>(conn, `SELECT c.id FROM clients c WHERE c.id = ?${s.sql} FOR UPDATE`, [body.clientId, ...s.params]);
        if (!client) throw notFound("That client does not exist or is not assigned to you.");
        const current = (await latestSubmissions(conn, body.clientId))[body.category];
        if (current?.status === "approved") throw badRequest("This is already approved.");
        if (current?.status === "pending") throw badRequest("A document is waiting for review. Open it and approve or reject it instead.");
        const submissionId = await storeSubmission(conn, config, { clientId: body.clientId, category: body.category, subType: body.subType, files: [], ip: req.clientIp, uploadedBy: staff.id, note: body.reason });
        const row = await loadVisible(req, submissionId, conn, true);
        await settle(conn, req, row, { status: "approved", reason: body.reason, action: "kyc.approved_without_documents" });
        return loadVisible(req, submissionId, conn);
      });
      res.json(present(updated));
    }),
  );

  // Ask for a new document after approval, for example when an ID has expired.
  // The approval stays in the audit log; the client sees the reason and can upload again.
  router.post(
    "/:id/request-new",
    requirePermission("kyc.decide"),
    stepUp,
    handler(async (req, res) => {
      const body = parse(
        z.object({ reason: z.string().trim().min(5, "Tell the client what to upload").max(500) }).strict()
          .refine((v) => !/[<>{}`\\]|https?:|\bwww\./i.test(v.reason), { message: "Write the reason as plain text, without links or symbols like < > { }", path: ["reason"] }),
        req.body,
      );
      const updated = await transaction(db, async (conn) => {
        const row = await loadVisible(req, parse(id, req.params.id), conn, true);
        if (row.status !== "approved") throw badRequest("Only an approved document can be requested again. Reject a pending one instead.");
        await assertLatest(conn, row);
        await settle(conn, req, row, { status: "rejected", reason: body.reason, action: "kyc.new_document_requested", askAgain: true });
        return loadVisible(req, row.id, conn);
      });
      res.json(present(updated));
    }),
  );

  return router;
}
