import { Router, type Request } from "express";
import { z } from "zod";
import type { AppDeps } from "../../app";
import { KYC_TYPES, latestSubmissions, overallStatus, subTypeOf, type KycCategory } from "../../clients/kyc";
import { clientName } from "../../clients/model";
import { auditContext, writeAudit } from "../../lib/audit";
import { decryptBytes } from "../../lib/crypto";
import { exec, one, rows, transaction } from "../../lib/db";
import { queueEmail } from "../../lib/email";
import { badRequest, handler, notFound, parse } from "../../lib/http";
import { likeTerm, listQuery, toPage } from "../../lib/pagination";
import { requirePermission, requireStepUp, staffActor, staffOf, type StaffContext } from "../../staff/session";
import { kycDocumentContext } from "../client/kyc";

const id = z.coerce.number().int().positive();

interface Row {
  id: number;
  client_id: number;
  category: KycCategory;
  sub_type: number;
  status: "pending" | "approved" | "rejected";
  reject_reason: string | null;
  submitted_at: Date;
  decided_at: Date | null;
  decider_name: string | null;
  first_name: string;
  last_name: string;
  email: string;
  country: string | null;
  documents: number;
}

const SELECT = `SELECT s.id, s.client_id, s.category, s.sub_type, s.status, s.reject_reason, s.submitted_at, s.decided_at,
  u.name AS decider_name, c.first_name, c.last_name, c.email, c.country,
  (SELECT COUNT(*) FROM kyc_documents d WHERE d.submission_id = s.id) AS documents
  FROM kyc_submissions s JOIN clients c ON c.id = s.client_id LEFT JOIN staff_users u ON u.id = s.decided_by`;

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
});

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
      const r = await one<{ pending: number; today: number }>(
        db,
        `SELECT SUM(s.status = 'pending') AS pending, SUM(s.decided_at >= CURRENT_DATE) AS today
         FROM kyc_submissions s JOIN clients c ON c.id = s.client_id WHERE 1 = 1${s.sql}`,
        s.params,
      );
      res.json({ pending: Number(r?.pending ?? 0), decidedToday: Number(r?.today ?? 0) });
    }),
  );

  router.get(
    "/:id",
    requirePermission("kyc.view"),
    handler(async (req, res) => {
      const row = await loadVisible(req, parse(id, req.params.id));
      const docs = await rows<{ id: number; slot: number; mime: string; size_bytes: number; file_name: string }>(
        db,
        "SELECT id, slot, mime, size_bytes, file_name FROM kyc_documents WHERE submission_id = ? ORDER BY slot",
        [row.id],
      );
      // The reviewer compares the documents with what the client entered, so the profile is shown in full here.
      const profile = await one<{ first_name: string; last_name: string; dob: string | null; country: string | null; city: string | null; address: string | null; zipcode: string | null; phone: string | null; phone_code: string | null }>(
        db,
        "SELECT first_name, last_name, DATE_FORMAT(dob, '%Y-%m-%d') AS dob, country, city, address, zipcode, phone, phone_code FROM clients WHERE id = ?",
        [row.client_id],
      );
      const history = await rows<Row>(db, `${SELECT} WHERE s.client_id = ? AND s.category = ? AND s.id <> ? ORDER BY s.id DESC LIMIT 20`, [row.client_id, row.category, row.id]);
      await transaction(db, (conn) => writeAudit(conn, ctx(req), { action: "kyc.viewed", entityType: "client", entityId: row.client_id, meta: { submissionId: row.id } }));
      res.json({
        ...present(row),
        files: docs.map((d) => ({ id: d.id, slot: d.slot, type: d.mime, bytes: d.size_bytes, name: d.file_name, url: `/api/staff/kyc/documents/${d.id}` })),
        profile: profile ? { ...profile, name: `${profile.first_name} ${profile.last_name}` } : null,
        history: history.map(present),
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
          .object({ decision: z.enum(["approve", "reject"]), reason: z.string().trim().max(500).optional() })
          .strict()
          .refine((v) => v.decision === "approve" || (v.reason && v.reason.length >= 5), { message: "Tell the client why, so they can fix it", path: ["reason"] }),
        req.body,
      );
      const staff = staffOf(req);
      const updated = await transaction(db, async (conn) => {
        const row = await loadVisible(req, parse(id, req.params.id), conn, true);
        if (row.status !== "pending") throw badRequest(`This submission was already ${row.status}.`);
        const status = body.decision === "approve" ? "approved" : "rejected";
        await exec(conn, "UPDATE kyc_submissions SET status = ?, reject_reason = ?, decided_at = CURRENT_TIMESTAMP(3), decided_by = ? WHERE id = ?", [
          status, status === "rejected" ? body.reason : null, staff.id, row.id,
        ]);
        const before = await one<{ kyc_status: string }>(conn, "SELECT kyc_status FROM clients WHERE id = ? FOR UPDATE", [row.client_id]);
        const overall = overallStatus(await latestSubmissions(conn, row.client_id));
        await exec(conn, "UPDATE clients SET kyc_status = ?, kyc_approved_at = IF(? = 'approved', COALESCE(kyc_approved_at, CURRENT_TIMESTAMP(3)), NULL) WHERE id = ?", [overall, overall, row.client_id]);
        await writeAudit(conn, ctx(req), {
          action: `kyc.${status}`, entityType: "client", entityId: row.client_id,
          before: { status: row.status, kyc_status: before?.kyc_status }, after: { status, kyc_status: overall },
          meta: { submissionId: row.id, category: row.category, reason: body.reason ?? null },
        });
        const what = row.category === "identity" ? "proof of identity" : "proof of address";
        await queueEmail(conn, config, {
          to: row.email,
          template: `kyc_${status}`,
          subject: status === "approved" ? "Your document was approved" : "Your document needs another look",
          text:
            status === "approved"
              ? `Hello ${row.first_name},\n\nYour ${what} has been approved.${overall === "approved" ? " Your account is now fully verified." : ""}\n\nBIS Markets`
              : `Hello ${row.first_name},\n\nWe could not approve your ${what}.\n\nReason: ${body.reason}\n\nPlease upload a new document in the client portal: ${config.portalUrl}/profile\n\nBIS Markets`,
          clientId: row.client_id,
        });
        return loadVisible(req, row.id, conn);
      });
      res.json(present(updated));
    }),
  );

  return router;
}
