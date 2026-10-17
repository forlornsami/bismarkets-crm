import express, { Router, type Request } from "express";
import { z } from "zod";
import type { AppDeps } from "../../app";
import {
  checkEmailCode,
  clientName,
  clientPasswordProblem,
  CODE_TTL_MS,
  codeHash,
  emailField,
  loadClient,
  nameField,
  newEmailCode,
  newReferralCode,
  presentForPortal,
  profileColumns,
  profileFields,
  updateClientColumns,
  type ClientRow,
  type CodePurpose,
} from "../../clients/model";
import { latestSubmissions, lockClient, lockedProfileFields, sameProfileValue } from "../../clients/kyc";
import { createResetLink } from "../../clients/reset";
import { fieldError, TooManyRequests, validate, ValidationError } from "../../clients/errors";
import { bearerToken, clientActor, clientAuth, clientOf, createClientSession, noImpersonation, revokeClientSession, revokeClientSessions } from "../../clients/session";
import { notifyClient } from "../../clients/notifications";
import { auditContext, auditStandalone, writeAudit } from "../../lib/audit";
import { sha256 } from "../../lib/crypto";
import { exec, one, transaction } from "../../lib/db";
import { queueEmail } from "../../lib/email";
import { handler, HttpError } from "../../lib/http";
import { dummyPasswordHash, hashPassword, isBreachedPassword, verifyPassword } from "../../lib/passwords";
import { deletePicture, PICTURE_MAX_BYTES, savePicture, sendPicture } from "../../lib/pictures";
import { RateLimiter } from "../../lib/rateLimit";

const OK_RESET = "If this email is registered, we have sent a password reset link.";

const anyString = z.union([z.string(), z.number()]).transform(String).optional();

/** Throws a Laravel-style 429 when the limiter refuses this key. */
function limit(limiter: RateLimiter, key: string, message?: string) {
  if (!limiter.take(key)) throw new TooManyRequests(limiter.retryAfter(key), message);
}

export function clientAuthRouter(deps: AppDeps): Router {
  const { db, config } = deps;
  const router = Router();
  const auth = clientAuth(db, config);

  const loginIp = new RateLimiter(30, 15 * 60_000);
  const loginEmail = new RateLimiter(10, 15 * 60_000);
  const registerIp = new RateLimiter(40, 60 * 60_000);
  const otpEmailBurst = new RateLimiter(1, 60_000);
  const otpEmailHour = new RateLimiter(6, 60 * 60_000);
  const otpIp = new RateLimiter(30, 60 * 60_000);
  const verifyIp = new RateLimiter(40, 15 * 60_000);
  const resetEmail = new RateLimiter(3, 60 * 60_000);
  const resetIp = new RateLimiter(20, 60 * 60_000);

  const ctx = (req: Request, client: { id: number; email: string }) => auditContext(req, clientActor(client));
  const emailTaken = async (email: string) => Boolean(await one(db, "SELECT id FROM clients WHERE email = ?", [email]));

  /** A Bearer token is optional on send-otp / verify-otp; a bad one is ignored. */
  async function optionalClient(req: Request) {
    if (!bearerToken(req)) return null;
    return new Promise<ReturnType<typeof clientOf> | null>((resolve) => {
      void auth(req, {} as never, (err?: unknown) => resolve(err ? null : (req.client ?? null)));
    });
  }

  function purposeFor(email: string, signedIn: { email: string } | null, requested?: string): CodePurpose {
    if (!signedIn) return "register";
    if (requested === "withdrawal" || requested === "update_email") return requested;
    return email === signedIn.email ? "withdrawal" : "update_email";
  }

  // ---------- Sign in ----------

  router.post(
    "/login",
    handler(async (req, res) => {
      limit(loginIp, req.clientIp);
      const body = validate(z.object({ email: emailField, password: z.string({ required_error: "The password field is required." }).min(1, "The password field is required.").max(256) }), req.body);
      limit(loginEmail, body.email);
      const client = await one<Pick<ClientRow, "id" | "email" | "password_hash" | "status" | "failed_login_count" | "locked_until">>(
        db,
        "SELECT id, email, password_hash, status, failed_login_count, locked_until FROM clients WHERE email = ?",
        [body.email],
      );
      const valid = await verifyPassword(client?.password_hash ?? (await dummyPasswordHash()), body.password);
      if (client?.locked_until && client.locked_until.getTime() > Date.now()) {
        throw new TooManyRequests(Math.ceil((client.locked_until.getTime() - Date.now()) / 1000), "Too many failed sign-in attempts. Please wait before retrying.");
      }
      if (!client || !client.password_hash || !valid) {
        if (client) {
          const failures = client.failed_login_count + 1;
          const lock = failures >= config.loginMaxFailures;
          await exec(db, "UPDATE clients SET failed_login_count = ?, locked_until = ? WHERE id = ?", [lock ? 0 : failures, lock ? new Date(Date.now() + config.loginLockMs) : null, client.id]);
          await auditStandalone(db, ctx(req, client), { action: lock ? "client.locked" : "client.login_failed", entityType: "client", entityId: client.id });
        }
        throw new HttpError(422, "INVALID_CREDENTIALS", "Invalid credentials.");
      }
      if (client.status === "closed") throw new HttpError(403, "ACCOUNT_CLOSED", "This account is closed. Please contact support.");
      const session = await transaction(db, async (conn) => {
        await exec(conn, "UPDATE clients SET failed_login_count = 0, locked_until = NULL, last_login_at = CURRENT_TIMESTAMP(3), last_login_ip = ? WHERE id = ?", [req.clientIp, client.id]);
        const created = await createClientSession(conn, config, client.id, req.clientIp, req.get("user-agent") ?? "");
        await writeAudit(conn, ctx(req, client), { action: "client.login", entityType: "client", entityId: client.id });
        return created;
      });
      const row = (await loadClient(db, client.id))!;
      res.json({ message: "Login successful.", token: session.token, access_token: session.token, token_type: "Bearer", expires_at: session.expiresAt.toISOString(), user: presentForPortal(config, row) });
    }),
  );

  router.post(
    "/logout",
    auth,
    handler(async (req, res) => {
      const client = clientOf(req);
      await transaction(db, async (conn) => {
        await revokeClientSession(conn, config, client.id, client.sessionId, "logout");
        await writeAudit(conn, ctx(req, client), { action: client.kind === "impersonation" ? "client.impersonation_ended" : "client.logout", entityType: "client", entityId: client.id });
      });
      res.json({ message: "Logged out." });
    }),
  );

  // ---------- Email codes ----------

  router.post(
    "/send-otp",
    handler(async (req, res) => {
      limit(otpIp, req.clientIp);
      const body = validate(z.object({ email: emailField, type: anyString, purpose: anyString }).passthrough(), req.body);
      const signedIn = await optionalClient(req);
      if (signedIn?.kind === "impersonation") throw new HttpError(403, "VIEW_ONLY", "This is a view-only staff session. Changes are not allowed.");
      const purpose = purposeFor(body.email, signedIn, body.purpose ?? body.type);
      // A withdrawal code always goes to the client's own address, whatever the form sent.
      const email = purpose === "withdrawal" ? signedIn!.email : body.email;
      if (purpose !== "withdrawal" && (await emailTaken(email))) throw fieldError("email", "The email has already been taken.");
      // A signed-in client's codes are theirs alone: counted, replaced and checked per client,
      // so another client asking for codes to the same address cannot cancel or block them.
      const key = signedIn ? `${purpose}:client:${signedIn.id}` : `${purpose}:${email}`;
      limit(otpEmailBurst, key, "Please wait before requesting another code.");
      limit(otpEmailHour, key, "Too many codes requested. Please wait before retrying.");
      const code = newEmailCode();
      await transaction(db, async (conn) => {
        if (signedIn)
          await exec(conn, "UPDATE email_codes SET consumed_at = CURRENT_TIMESTAMP(3) WHERE email = ? AND purpose = ? AND client_id = ? AND consumed_at IS NULL", [email, purpose, signedIn.id]);
        else await exec(conn, "UPDATE email_codes SET consumed_at = CURRENT_TIMESTAMP(3) WHERE email = ? AND purpose = ? AND consumed_at IS NULL", [email, purpose]);
        await exec(conn, "INSERT INTO email_codes (email, purpose, client_id, code_hash, expires_at) VALUES (?, ?, ?, ?, ?)", [
          email, purpose, signedIn?.id ?? null, codeHash(config, email, purpose, code), new Date(Date.now() + CODE_TTL_MS),
        ]);
        const what = purpose === "register" ? "finish creating your BIS Markets account" : purpose === "withdrawal" ? "confirm your withdrawal" : "confirm your new email address";
        await queueEmail(conn, config, {
          to: email,
          template: `otp_${purpose}`,
          subject: "Your BIS Markets verification code",
          text: `Your verification code is ${code}\n\nUse it to ${what}. It expires in 10 minutes.\n\nIf you did not ask for this code, ignore this email. BIS Markets staff will never ask you for it.`,
          secrets: [code],
          clientId: signedIn?.id ?? null,
        });
      });
      res.json({ success: true, message: "Verification code sent to your email." });
    }),
  );

  router.post(
    "/verify-otp",
    handler(async (req, res) => {
      limit(verifyIp, req.clientIp);
      const body = validate(
        z.object({ email: emailField, verification_code: z.string({ required_error: "The verification code field is required." }).trim().min(1, "The verification code field is required.").max(12), type: anyString, purpose: anyString }).passthrough(),
        req.body,
      );
      const signedIn = await optionalClient(req);
      // Without a session only a sign-up code can be checked. Withdrawal and new-email codes
      // need the client's own session and only their own code counts, so a stranger who
      // knows an address cannot use up its codes with wrong guesses.
      const purpose = signedIn ? purposeFor(body.email, signedIn, body.purpose ?? body.type) : "register";
      const email = purpose === "withdrawal" ? signedIn!.email : body.email;
      // Checking does not use the code up: the portal sends it again with the real request.
      const ok = await transaction(db, (conn) => checkEmailCode(conn, config, email, purpose, body.verification_code, false, signedIn?.id));
      if (!ok) throw fieldError("verification_code", "The verification code is invalid or has expired.");
      res.json({ success: true, message: "Code verified." });
    }),
  );

  // ---------- Sign up ----------

  router.post(
    "/register",
    handler(async (req, res) => {
      limit(registerIp, req.clientIp);
      const raw = (req.body ?? {}) as Record<string, unknown>;
      const errors: Record<string, string[]> = {};
      const field = <T,>(name: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T | undefined => {
        const r = schema.safeParse(raw[name]);
        if (r.success) return r.data;
        errors[name] = [r.error.issues[0]!.message];
        return undefined;
      };
      const firstName = field("first_name", nameField("first name"));
      const lastName = field("last_name", nameField("last name"));
      const email = field("email", emailField);
      const referral = z.string().trim().max(32).optional().catch(undefined).parse(raw.referral_code ?? req.query.referral_code) || undefined;
      const code = typeof raw.verification_code === "string" ? raw.verification_code.trim() : "";

      // Same order as the old CRM: the portal first sends a probe with an empty
      // code and expects only `verification_code` back when the email is free.
      if (email && (await emailTaken(email))) errors.email = ["The email has already been taken."];
      let referrer: number | null = null;
      if (referral) {
        const r = await one<{ id: number }>(db, "SELECT id FROM clients WHERE referral_code = ? AND status <> 'closed'", [referral.toUpperCase()]);
        if (r) referrer = r.id;
        else errors.referral_code = ["The selected referral code is invalid."];
      }
      if (!code) errors.verification_code = ["The verification code field is required."];
      if (Object.keys(errors).length) throw new ValidationError(errors);

      const codeOk = await transaction(db, (conn) => checkEmailCode(conn, config, email!, "register", code, false));
      if (!codeOk) throw fieldError("verification_code", "The verification code is invalid or has expired.");

      const password = typeof raw.password === "string" ? raw.password : "";
      if (!password) throw fieldError("password", "The password field is required.");
      if (password !== raw.password_confirmation) throw fieldError("password", "The password confirmation does not match.");
      const problem = clientPasswordProblem(password, email!);
      if (problem) throw fieldError("password", problem);
      if (config.passwordBreachCheck && (await isBreachedPassword(password, deps.fetch))) {
        throw fieldError("password", "This password has appeared in a data breach. Please choose a different one.");
      }
      const passwordHash = await hashPassword(password);

      const created = await transaction(db, async (conn) => {
        if (!(await checkEmailCode(conn, config, email!, "register", code, true))) return null;
        let clientId = 0;
        for (let attempt = 0; attempt < 5 && !clientId; attempt++) {
          try {
            const result = await exec(
              conn,
              `INSERT INTO clients (email, first_name, last_name, password_hash, email_verified_at, referral_code, referred_by, source, created_ip, password_changed_at)
               VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP(3), ?, ?, 'portal', ?, CURRENT_TIMESTAMP(3))`,
              [email, firstName, lastName, passwordHash, newReferralCode(), referrer, req.clientIp],
            );
            clientId = result.insertId;
          } catch (err) {
            const message = (err as { code?: string; message?: string }).message ?? "";
            if ((err as { code?: string }).code !== "ER_DUP_ENTRY") throw err;
            if (message.includes("uq_clients_email")) throw fieldError("email", "The email has already been taken.");
          }
        }
        if (!clientId) throw new Error("Could not allocate a referral code");
        const session = await createClientSession(conn, config, clientId, req.clientIp, req.get("user-agent") ?? "");
        await writeAudit(conn, ctx(req, { id: clientId, email: email! }), {
          action: "client.registered", entityType: "client", entityId: clientId,
          after: { email, first_name: firstName, last_name: lastName, referred_by: referrer, source: "portal" },
        });
        await queueEmail(conn, config, {
          to: email!,
          template: "welcome",
          subject: "Welcome to BIS Markets",
          text: `Hello ${firstName},\n\nYour BIS Markets account is ready. Your client ID is ${clientId}.\n\nNext, complete your profile and verify your identity in the client portal: ${config.portalUrl}/dashboard\n\nBIS Markets`,
          clientId,
        });
        return { clientId, session };
      });
      if (!created) throw fieldError("verification_code", "The verification code is invalid or has expired.");
      const row = (await loadClient(db, created.clientId))!;
      res.status(201).json({ message: "Registration successful.", token: created.session.token, access_token: created.session.token, token_type: "Bearer", user: presentForPortal(config, row) });
    }),
  );

  // ---------- Password reset ----------

  router.post(
    "/forgot-password",
    handler(async (req, res) => {
      limit(resetIp, req.clientIp);
      const body = validate(z.object({ email: emailField }), req.body);
      limit(resetEmail, body.email, "Please wait before retrying.");
      const client = await one<{ id: number; email: string; first_name: string; status: string }>(db, "SELECT id, email, first_name, status FROM clients WHERE email = ?", [body.email]);
      if (client && client.status !== "closed") {
        await createResetLink(db, config, req, client, null);
      }
      res.json({ message: OK_RESET });
    }),
  );

  router.post(
    "/reset-password",
    handler(async (req, res) => {
      limit(resetIp, req.clientIp);
      const body = validate(
        z.object({
          token: z.string({ required_error: "The reset link is incomplete." }).min(10, "The reset link is incomplete.").max(200),
          email: emailField.optional(),
          password: z.string({ required_error: "The password field is required." }).min(1, "The password field is required."),
          password_confirmation: z.string().optional(),
        }),
        req.body,
      );
      if (body.password !== body.password_confirmation) throw fieldError("password", "The password confirmation does not match.");
      const reset = await one<{ client_id: number; email: string }>(
        db,
        `SELECT r.client_id, c.email FROM client_password_resets r JOIN clients c ON c.id = r.client_id
         WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > CURRENT_TIMESTAMP(3) AND c.status <> 'closed'`,
        [sha256(body.token)],
      );
      if (!reset || (body.email && body.email !== reset.email)) throw fieldError("email", "This password reset link is invalid or has expired.");
      const problem = clientPasswordProblem(body.password, reset.email);
      if (problem) throw fieldError("password", problem);
      if (config.passwordBreachCheck && (await isBreachedPassword(body.password, deps.fetch))) {
        throw fieldError("password", "This password has appeared in a data breach. Please choose a different one.");
      }
      const passwordHash = await hashPassword(body.password);
      await transaction(db, async (conn) => {
        const used = await exec(conn, "UPDATE client_password_resets SET used_at = CURRENT_TIMESTAMP(3) WHERE token_hash = ? AND used_at IS NULL", [sha256(body.token)]);
        if (used.affectedRows !== 1) throw fieldError("email", "This password reset link is invalid or has expired.");
        await exec(conn, "UPDATE clients SET password_hash = ?, password_changed_at = CURRENT_TIMESTAMP(3), failed_login_count = 0, locked_until = NULL, email_verified_at = COALESCE(email_verified_at, CURRENT_TIMESTAMP(3)) WHERE id = ?", [passwordHash, reset.client_id]);
        const revoked = await revokeClientSessions(conn, config, reset.client_id, "password_reset");
        await notifyClient(conn, reset.client_id, { type: "security", title: "Password changed", body: "Your password was changed and you were signed out on every device. If this was not you, contact support straight away." });
        await writeAudit(conn, ctx(req, { id: reset.client_id, email: reset.email }), { action: "client.password_reset", entityType: "client", entityId: reset.client_id, meta: { sessionsRevoked: revoked } });
        await queueEmail(conn, config, {
          to: reset.email,
          template: "password_changed",
          subject: "Your BIS Markets password was changed",
          text: `Your BIS Markets password was just changed and you were signed out everywhere.\n\nIf this was not you, contact support immediately.`,
          clientId: reset.client_id,
        });
      });
      res.json({ message: "Your password has been reset." });
    }),
  );

  // ---------- Profile ----------

  router.get(
    "/user",
    auth,
    handler(async (req, res) => {
      const client = clientOf(req);
      const row = await loadClient(db, client.id);
      if (!row) throw new HttpError(401, "UNAUTHENTICATED", "Unauthenticated.");
      const user: Record<string, unknown> = presentForPortal(config, row, client.sessionId);
      if (client.kind === "impersonation") {
        // A staff member viewing the portal as this client. The flags let the
        // portal show a read-only banner, and make the support service refuse
        // the token so staff cannot chat or register devices as the client.
        const staff = await one<{ name: string }>(db, "SELECT name FROM staff_users WHERE id = ?", [client.staffId]);
        Object.assign(user, { impersonation: true, impersonated_by: staff?.name ?? "Staff", is_staff: true, read_only: true });
      }
      res.json(user);
    }),
  );

  router.patch(
    "/user",
    auth,
    noImpersonation,
    handler(async (req, res) => {
      const client = clientOf(req);
      const raw = (req.body ?? {}) as Record<string, unknown>;
      // The app sends both dob and date_of_birth; either is fine.
      if (raw.dob === undefined && raw.date_of_birth !== undefined) raw.dob = raw.date_of_birth;
      if (raw.countryCode === undefined && raw.country_code !== undefined) raw.countryCode = raw.country_code;
      const body = validate(
        z.object({ first_name: nameField("first name").optional(), last_name: nameField("last name").optional(), ...profileFields }).passthrough(),
        raw,
      );
      const updated = await transaction(db, async (conn) => {
        await lockClient(conn, client.id);
        const before = (await loadClient(conn, client.id))!;
        const old = before as unknown as Record<string, unknown>;
        // Details checked against documents under review or approved stay as
        // they are. The portal and app send the whole form, so only a real
        // change is refused; an unchanged value is simply not written.
        const locked = new Set<string>(lockedProfileFields(await latestSubmissions(conn, client.id, true), before));
        const refused: Record<string, string[]> = {};
        const columns = profileColumns(body).filter(([k, v]) => {
          if (!locked.has(k)) return true;
          if (!sameProfileValue(old[k], v)) refused[k] = ["This was checked with your documents. Contact support to change it."];
          return false;
        });
        if (Object.keys(refused).length) throw new ValidationError(refused);
        await updateClientColumns(conn, client.id, columns);
        const changed = columns.filter(([k, v]) => String(old[k] ?? "") !== String(v ?? "")).map(([k]) => k);
        if (changed.length) await writeAudit(conn, ctx(req, client), { action: "client.profile_updated", entityType: "client", entityId: client.id, meta: { fields: changed } });
        return (await loadClient(conn, client.id))!;
      });
      res.json({ message: "Profile updated.", user: presentForPortal(config, updated) });
    }),
  );

  router.post(
    "/user/profile-picture",
    auth,
    noImpersonation,
    // The portal and app send the picture twice (image and image_name), so allow for both copies.
    express.raw({ type: "multipart/form-data", limit: 2 * PICTURE_MAX_BYTES + 64 * 1024 }),
    handler(async (req, res) => {
      const client = clientOf(req);
      if (!Buffer.isBuffer(req.body)) throw fieldError("image", "Choose a picture to upload.");
      let form: FormData;
      try {
        form = await new Response(new Uint8Array(req.body), { headers: { "content-type": req.get("content-type")! } }).formData();
      } catch {
        throw fieldError("image", "Choose a picture to upload.");
      }
      const file = [form.get("image"), form.get("image_name"), form.get("profile_picture"), form.get("avatar")].find((v): v is File => typeof v === "object" && v !== null);
      if (!file) throw fieldError("image", "Choose a picture to upload.");
      const bytes = Buffer.from(await file.arrayBuffer());
      const saved = await transaction(db, async (conn) => {
        let result;
        try {
          result = await savePicture(conn, "client", client.id, { bytes });
        } catch (err) {
          if (err instanceof HttpError) throw fieldError("image", "The image must be a JPEG, PNG or WebP file of at least 32 pixels and at most 1 MB.");
          throw err;
        }
        await writeAudit(conn, ctx(req, client), { action: "client.picture_updated", entityType: "client", entityId: client.id, after: { sha256: result.sha256, type: result.type, bytes: result.bytes } });
        return result;
      });
      const row = (await loadClient(db, client.id))!;
      const user = presentForPortal(config, row);
      res.json({ message: "Profile picture updated.", image_url: user.image_url, image_name: user.image_name, user, sha256: saved.sha256 });
    }),
  );

  router.delete(
    "/user/profile-picture",
    auth,
    noImpersonation,
    handler(async (req, res) => {
      const client = clientOf(req);
      await transaction(db, async (conn) => {
        if (await deletePicture(conn, "client", client.id)) {
          await writeAudit(conn, ctx(req, client), { action: "client.picture_removed_by_client", entityType: "client", entityId: client.id });
        }
      });
      const row = (await loadClient(db, client.id))!;
      res.json({ message: "Profile picture removed.", user: presentForPortal(config, row) });
    }),
  );

  // Pictures load in <img> tags on the portal's own domain, without a token,
  // so the URL itself carries part of the image hash and is unguessable.
  router.get(
    "/pictures/client/:id",
    handler(async (req, res) => {
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      await sendPicture(db, "client", z.coerce.number().int().positive().parse(req.params.id), req, res, true);
    }),
  );

  router.post(
    "/update-email",
    auth,
    noImpersonation,
    handler(async (req, res) => {
      const client = clientOf(req);
      limit(verifyIp, req.clientIp);
      const body = validate(
        z.object({
          email: emailField,
          verification_code: z.string({ required_error: "The verification code field is required." }).trim().min(1, "The verification code field is required.").max(12),
          password: z.string({ required_error: "The password field is required." }).min(1, "The password field is required.").max(256),
        }),
        req.body,
      );
      const row = (await loadClient(db, client.id))!;
      if (!row.password_hash || !(await verifyPassword(row.password_hash, body.password))) throw fieldError("password", "The password is incorrect.");
      if (body.email === row.email) throw fieldError("email", "This is already your email address.");
      if (await emailTaken(body.email)) throw fieldError("email", "The email has already been taken.");
      const ok = await transaction(db, (conn) => checkEmailCode(conn, config, body.email, "update_email", body.verification_code, false, client.id));
      if (!ok) throw fieldError("verification_code", "The verification code is invalid or has expired.");
      await transaction(db, async (conn) => {
        if (!(await checkEmailCode(conn, config, body.email, "update_email", body.verification_code, true, client.id))) throw fieldError("verification_code", "The verification code is invalid or has expired.");
        try {
          await exec(conn, "UPDATE clients SET email = ?, email_verified_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [body.email, client.id]);
        } catch (err) {
          if ((err as { code?: string }).code === "ER_DUP_ENTRY") throw fieldError("email", "The email has already been taken.");
          throw err;
        }
        await writeAudit(conn, ctx(req, client), { action: "client.email_changed", entityType: "client", entityId: client.id, before: { email: row.email }, after: { email: body.email } });
        await notifyClient(conn, client.id, { type: "security", title: "Sign-in email changed", body: `Your sign-in email is now ${body.email}. If this was not you, contact support straight away.` });
        await queueEmail(conn, config, {
          to: row.email,
          template: "email_changed",
          subject: "Your BIS Markets email was changed",
          text: `Hello ${clientName(row)},\n\nThe sign-in email for your BIS Markets account was changed to ${body.email}.\n\nIf this was not you, contact support immediately.`,
          clientId: client.id,
        });
      });
      res.json({ message: "Email updated." });
    }),
  );

  return router;
}
