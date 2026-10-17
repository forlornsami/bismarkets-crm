import express, { Router, type NextFunction, type Request, type Response } from "express";
import type { AppDeps } from "../../app";
import { fieldError, TooManyRequests, ValidationError } from "../../clients/errors";
import {
  auditedFiles, categoryForType, describeMissing, KYC_MAX_BYTES, KYC_TYPES, kycEnvelope, latestSubmissions, lockClient, missingProfileFields, overallStatus, prepareKycFiles, proofOf,
  readKycUpload, storeSubmission, type KycUploadForm, type SubmissionRow,
} from "../../clients/kyc";
import { loadClient } from "../../clients/model";
import { notifyClient } from "../../clients/notifications";
import { clientActor, clientAuth, clientOf, noImpersonation } from "../../clients/session";
import { auditContext, writeAudit } from "../../lib/audit";
import { exec, rows, transaction, type Conn } from "../../lib/db";
import { conflict, handler, HttpError } from "../../lib/http";
import { RateLimiter } from "../../lib/rateLimit";
import { activeClaim } from "../../lib/review";

export { kycDocumentContext } from "../../clients/kyc";

/** GET/POST /api/kyc, /api/kyc/types and /api/kyc/withdraw, as the portal's profile page and the app call them. */
export function clientKycRouter(deps: AppDeps): Router {
  const { db, config } = deps;
  const router = Router();
  const auth = clientAuth(db, config);
  // Ten stored uploads an hour; failed attempts do not use them up. The looser
  // attempt limit only stops someone hammering the (slow) photo processing.
  const uploads = new RateLimiter(10, 60 * 60_000);
  const attempts = new RateLimiter(30, 60 * 60_000);

  /** Refuses a throttled client before the body (up to 20 MB) is read. */
  const uploadGate = (req: Request, _res: Response, next: NextFunction) => {
    const key = String(clientOf(req).id);
    if (uploads.isLimited(key)) return next(new TooManyRequests(uploads.retryAfter(key), "Too many uploads. Please wait before trying again."));
    if (!attempts.take(key)) return next(new TooManyRequests(attempts.retryAfter(key), "Too many upload attempts. Please wait before trying again."));
    next();
  };

  router.get(
    "/kyc/types",
    auth,
    handler(async (_req, res) => {
      const list = (key: keyof typeof KYC_TYPES) =>
        KYC_TYPES[key].subTypes.map((s) => ({ id: s.id, sub_type: s.id, type: KYC_TYPES[key].type, name: s.name, documents: s.documents }));
      res.json({
        success: true,
        identity: list("identity"),
        address: list("address"),
        types: [
          { id: KYC_TYPES.identity.type, name: KYC_TYPES.identity.label },
          { id: KYC_TYPES.address.type, name: KYC_TYPES.address.label },
        ],
      });
    }),
  );

  router.get(
    "/kyc",
    auth,
    handler(async (req, res) => {
      const row = (await loadClient(db, clientOf(req).id))!;
      res.json(await kycEnvelope(db, row));
    }),
  );

  /** True when a retry repeats the pending upload exactly (same type and the same files as sent). */
  async function sameAsPending(conn: Conn, current: SubmissionRow, upload: KycUploadForm) {
    if (current.status !== "pending" || current.sub_type !== upload.subType.id) return false;
    const stored = await rows<{ sha256: string }>(conn, "SELECT sha256 FROM kyc_documents WHERE submission_id = ? ORDER BY slot", [current.id]);
    return stored.length === upload.sent.length && stored.every((d, i) => d.sha256 === upload.sent[i]!.sha256);
  }

  /**
   * Refuses an upload the account cannot take now. `repeat` is true when it
   * repeats the pending upload exactly: a retry after a timeout, whose first
   * attempt already got through.
   */
  async function admit(conn: Conn, clientId: number, upload: KycUploadForm) {
    const row = await loadClient(conn, clientId);
    if (!row || row.status === "closed") throw new HttpError(403, "ACCOUNT_CLOSED", "This account is closed. Please contact support.");
    // A plain read: a locking one would take gap locks that deadlock two clients' uploads.
    const current = (await latestSubmissions(conn, clientId))[upload.category];
    if (current && (await sameAsPending(conn, current, upload))) return { row, repeat: true };
    if (current && current.status !== "rejected") {
      // A field error, so the portal shows the text as written.
      throw fieldError("document1", current.status === "approved" ? "This document is already approved." : "This document is already under review.");
    }
    const missing = missingProfileFields(row);
    if (missing.length) {
      throw new ValidationError({ profile: [`Please add your ${describeMissing(missing)} to your profile before uploading documents.`] }, { missing_profile_fields: missing });
    }
    return { row, repeat: false };
  }

  router.post(
    "/kyc",
    auth,
    noImpersonation,
    uploadGate,
    express.raw({ type: "multipart/form-data", limit: 2 * KYC_MAX_BYTES + 256 * 1024 }),
    handler(async (req, res) => {
      const client = clientOf(req);
      const upload = await readKycUpload(req.body, req.get("content-type"));
      const { category, subType } = upload;
      const accepted = () => res.status(201).json({ success: true, message: "Your document was submitted for review." });
      // The quick checks first, so a refused upload never waits for photo processing.
      if ((await admit(db, client.id, upload)).repeat) return void accepted();
      const files = await prepareKycFiles(upload);

      const stored = await transaction(db, async (conn) => {
        await lockClient(conn, client.id);
        // Checked again with the client row locked: nothing else changes this client's KYC meanwhile.
        const { row, repeat } = await admit(conn, client.id, upload);
        if (repeat) return false;
        const submissionId = await storeSubmission(conn, config, { clientId: client.id, category, subType: subType.id, files, ip: req.clientIp, profile: row });
        const after = await latestSubmissions(conn, client.id, true);
        await exec(conn, "UPDATE clients SET kyc_status = ? WHERE id = ?", [overallStatus(after), client.id]);
        await writeAudit(conn, auditContext(req, clientActor(client)), {
          action: "kyc.submitted", entityType: "client", entityId: client.id,
          meta: { submissionId, category, subType: subType.name, files: auditedFiles(files) },
        });
        await notifyClient(conn, client.id, { type: "kyc", title: `We received your ${proofOf(category)}`, body: "We will check it and let you know the result here.", link: "/profile", linkLabel: "View profile" });
        return true;
      });
      if (stored) uploads.take(String(client.id));
      accepted();
    }),
  );

  // Takes back a pending upload nobody has started checking, so the client can send the right file.
  router.post(
    "/kyc/withdraw",
    auth,
    noImpersonation,
    handler(async (req, res) => {
      const client = clientOf(req);
      const category = categoryForType(Number((req.body as { type?: unknown } | undefined)?.type));
      if (!category) throw fieldError("type", "Choose identity or proof of address.");
      await transaction(db, async (conn) => {
        await lockClient(conn, client.id);
        // Write locks up front: a share lock raised to a write lock later could deadlock with a reviewer claiming the same row.
        await rows(conn, "SELECT id FROM kyc_submissions WHERE client_id = ? FOR UPDATE", [client.id]);
        const current = (await latestSubmissions(conn, client.id, true))[category];
        if (!current || current.status !== "pending") throw fieldError("type", "There is no document waiting for review to take back.");
        if (current.source !== "client") throw fieldError("type", "Our team added this document for you. Please contact support to change it.");
        if (activeClaim(current)) throw conflict("A reviewer is checking this document now.");
        await exec(conn, "UPDATE kyc_submissions SET status = 'withdrawn', decided_at = CURRENT_TIMESTAMP(3), claimed_by = NULL, claimed_until = NULL WHERE id = ?", [current.id]);
        const after = await latestSubmissions(conn, client.id, true);
        await exec(conn, "UPDATE clients SET kyc_status = ? WHERE id = ?", [overallStatus(after), client.id]);
        await writeAudit(conn, auditContext(req, clientActor(client)), {
          action: "kyc.withdrawn_by_client", entityType: "client", entityId: client.id, meta: { submissionId: current.id, category },
        });
      });
      res.json({ success: true, message: "Your document was taken back. You can upload a new one now." });
    }),
  );

  return router;
}
