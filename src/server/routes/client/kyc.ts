import express, { Router } from "express";
import type { AppDeps } from "../../app";
import { fieldError } from "../../clients/errors";
import { KYC_MAX_BYTES, KYC_TYPES, kycEnvelope, latestSubmissions, missingProfileFields, overallStatus, parseKycUpload, storeSubmission } from "../../clients/kyc";
import { loadClient } from "../../clients/model";
import { clientActor, clientAuth, clientOf, noImpersonation } from "../../clients/session";
import { auditContext, writeAudit } from "../../lib/audit";
import { sha256 } from "../../lib/crypto";
import { exec, transaction } from "../../lib/db";
import { handler, HttpError } from "../../lib/http";
import { RateLimiter } from "../../lib/rateLimit";

export { kycDocumentContext } from "../../clients/kyc";

/** GET/POST /api/kyc and /api/kyc/types, as the portal's profile page and the app call them. */
export function clientKycRouter(deps: AppDeps): Router {
  const { db, config } = deps;
  const router = Router();
  const auth = clientAuth(db, config);
  const uploads = new RateLimiter(10, 60 * 60_000);

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

  router.post(
    "/kyc",
    auth,
    noImpersonation,
    express.raw({ type: "multipart/form-data", limit: 2 * KYC_MAX_BYTES + 256 * 1024 }),
    handler(async (req, res) => {
      const client = clientOf(req);
      if (client.status !== "active") throw new HttpError(403, "ACCOUNT_RESTRICTED", "Your account is restricted. Please contact support.");
      if (!uploads.take(String(client.id))) throw new HttpError(429, "THROTTLED", "Too many uploads. Please wait before retrying.");
      const { category, subType, files } = await parseKycUpload(req.body, req.get("content-type"));

      const row = (await loadClient(db, client.id))!;
      const missing = missingProfileFields(row);
      if (missing.length) throw fieldError("profile", "Please complete your profile before uploading documents.");

      await transaction(db, async (conn) => {
        await exec(conn, "SELECT id FROM clients WHERE id = ? FOR UPDATE", [client.id]);
        const latest = await latestSubmissions(conn, client.id);
        const current = latest[category];
        if (current && current.status !== "rejected") {
          throw new HttpError(422, "ALREADY_SUBMITTED", current.status === "approved" ? "This document is already approved." : "This document is already under review.");
        }
        const submissionId = await storeSubmission(conn, config, { clientId: client.id, category, subType: subType.id, files, ip: req.clientIp });
        const after = await latestSubmissions(conn, client.id);
        await exec(conn, "UPDATE clients SET kyc_status = ? WHERE id = ?", [overallStatus(after), client.id]);
        await writeAudit(conn, auditContext(req, clientActor(client)), {
          action: "kyc.submitted", entityType: "client", entityId: client.id,
          meta: { submissionId, category, subType: subType.name, files: files.map((f) => ({ type: f.mime, bytes: f.bytes.length, sha256: sha256(f.bytes) })) },
        });
      });
      res.status(201).json({ success: true, message: "Your document was submitted for review." });
    }),
  );

  return router;
}
