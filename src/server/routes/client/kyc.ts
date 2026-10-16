import express, { Router } from "express";
import type { AppDeps } from "../../app";
import { fieldError } from "../../clients/errors";
import { categoryForType, documentType, KYC_MAX_BYTES, KYC_TYPES, kycEnvelope, missingProfileFields, latestSubmissions, overallStatus, subTypeOf } from "../../clients/kyc";
import { loadClient } from "../../clients/model";
import { clientActor, clientAuth, clientOf, noImpersonation } from "../../clients/session";
import { auditContext, writeAudit } from "../../lib/audit";
import { encryptBytes, sha256 } from "../../lib/crypto";
import { exec, transaction } from "../../lib/db";
import { handler, HttpError } from "../../lib/http";
import { RateLimiter } from "../../lib/rateLimit";

export const kycDocumentContext = (submissionId: number, slot: number) => `kyc_document:${submissionId}:${slot}`;

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
      if (!Buffer.isBuffer(req.body)) throw fieldError("document1", "Attach your document.");
      let form: FormData;
      try {
        form = await new Response(new Uint8Array(req.body), { headers: { "content-type": req.get("content-type")! } }).formData();
      } catch {
        throw fieldError("document1", "Attach your document.");
      }
      const category = categoryForType(Number(form.get("type")));
      if (!category) throw fieldError("type", "Choose identity or proof of address.");
      const subType = subTypeOf(category, Number(form.get("sub_type")));
      if (!subType) throw fieldError("sub_type", "Choose a document type.");

      const files: { bytes: Buffer; mime: string; name: string }[] = [];
      for (let slot = 1; slot <= subType.documents; slot++) {
        const file = form.get(`document${slot}`);
        if (!file || typeof file !== "object") {
          throw fieldError(`document${slot}`, subType.documents === 2 ? "Attach both the front and the back." : "Attach your document.");
        }
        const bytes = Buffer.from(await (file as File).arrayBuffer());
        if (bytes.length === 0 || bytes.length > KYC_MAX_BYTES) throw fieldError(`document${slot}`, "Each file must be an image or PDF no larger than 10 MB.");
        const mime = documentType(bytes);
        if (!mime) throw fieldError(`document${slot}`, "Each file must be an image or PDF no larger than 10 MB.");
        files.push({ bytes, mime, name: ((file as File).name || `document${slot}`).replace(/[^\w.\- ]+/g, "_").slice(0, 160) });
      }

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
        const result = await exec(conn, "INSERT INTO kyc_submissions (client_id, category, sub_type, submitted_ip) VALUES (?, ?, ?, ?)", [client.id, category, subType.id, req.clientIp]);
        const submissionId = result.insertId;
        for (const [i, f] of files.entries()) {
          const slot = i + 1;
          await exec(conn, "INSERT INTO kyc_documents (submission_id, slot, mime, size_bytes, sha256, file_name, bytes_enc) VALUES (?, ?, ?, ?, ?, ?, ?)", [
            submissionId, slot, f.mime, f.bytes.length, sha256(f.bytes), f.name, encryptBytes(config.dataKey, f.bytes, kycDocumentContext(submissionId, slot)),
          ]);
        }
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
