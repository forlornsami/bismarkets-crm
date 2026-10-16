import { Router } from "express";
import { z } from "zod";
import type { AppDeps } from "../../app";
import { auditContext, auditStandalone, writeAudit } from "../../lib/audit";
import { decryptField, encryptField, randomToken, sha256 } from "../../lib/crypto";
import { exec, one, transaction } from "../../lib/db";
import { badRequest, handler, HttpError, parse, unauthorized } from "../../lib/http";
import { dummyPasswordHash, hashPassword, isBreachedPassword, passwordProblem, verifyPassword } from "../../lib/passwords";
import { staffAvatarUrl } from "../../lib/pictures";
import { RateLimiter } from "../../lib/rateLimit";
import { newTotpSecret, otpauthUrl, verifyTotp } from "../../lib/totp";
import {
  clearSessionCookie,
  createSession,
  csrfFor,
  cookieName,
  revokeStaffSessions,
  setSessionCookie,
  staffActor,
  staffOf,
  staffSession,
} from "../../staff/session";
import { readCookie } from "../../lib/cookies";

const CHALLENGE_MS = 5 * 60_000;
const CHALLENGE_MAX_ATTEMPTS = 5;
const GENERIC_LOGIN_ERROR = "Email or password is incorrect.";

export const totpContext = (staffId: number) => `staff:${staffId}:totp`;
const pendingContext = (challengeHash: string) => `challenge:${challengeHash}:totp`;

interface StaffAuthRow {
  id: number;
  email: string;
  name: string;
  password_hash: string;
  status: string;
  failed_login_count: number;
  locked_until: Date | null;
  totp_secret_enc: Buffer | null;
  totp_enabled_at: Date | null;
  totp_last_step: number | null;
  must_change_password: number;
}

export function sessionPayload(staff: ReturnType<typeof staffOf>, csrfToken: string, stepUpMs: number, avatarUrl: string | null = null) {
  return {
    staff: {
      id: staff.id,
      avatarUrl,
      email: staff.email,
      name: staff.name,
      role: { id: staff.roleId, slug: staff.roleSlug, name: staff.roleName },
      mustChangePassword: staff.mustChangePassword,
    },
    permissions: [...staff.permissions].sort(),
    csrfToken,
    expiresAt: staff.sessionExpiresAt.toISOString(),
    stepUpUntil: staff.stepUpAt ? new Date(staff.stepUpAt.getTime() + stepUpMs).toISOString() : null,
  };
}

export function staffAuthRouter(deps: AppDeps): Router {
  const { db, config } = deps;
  const router = Router();
  const ipLimiter = new RateLimiter(20, 15 * 60_000);
  const emailLimiter = new RateLimiter(10, 15 * 60_000);
  const codeLimiter = new RateLimiter(20, 15 * 60_000);
  const session = staffSession(db, config);
  const system = (label: string) => ({ type: "system" as const, id: null, label });

  router.post(
    "/login",
    handler(async (req, res) => {
      const body = parse(
        z.object({ email: z.string().trim().toLowerCase().email().max(254), password: z.string().min(1).max(256) }),
        req.body,
      );
      if (!ipLimiter.take(req.clientIp) || !emailLimiter.take(body.email)) {
        throw new HttpError(429, "RATE_LIMITED", "Too many attempts. Wait a few minutes and try again.");
      }
      const user = await one<StaffAuthRow>(db, "SELECT * FROM staff_users WHERE email = ?", [body.email]);
      const passwordOk = await verifyPassword(user?.password_hash ?? (await dummyPasswordHash()), body.password);
      if (!user) {
        await auditStandalone(db, auditContext(req, system(body.email)), { action: "staff.login_failed", meta: { reason: "unknown_email" } });
        throw unauthorized(GENERIC_LOGIN_ERROR);
      }
      const ctx = auditContext(req, staffActor(user));
      if (user.locked_until && user.locked_until.getTime() > Date.now()) {
        await auditStandalone(db, ctx, { action: "staff.login_failed", entityType: "staff", entityId: user.id, meta: { reason: "locked" } });
        throw new HttpError(423, "LOCKED", "This account is temporarily locked after too many attempts. Try again later or ask an admin to unlock it.");
      }
      if (!passwordOk) {
        const failures = user.failed_login_count + 1;
        const lock = failures >= config.loginMaxFailures;
        await transaction(db, async (conn) => {
          await exec(conn, "UPDATE staff_users SET failed_login_count = ?, locked_until = ? WHERE id = ?", [
            lock ? 0 : failures,
            lock ? new Date(Date.now() + config.loginLockMs) : null,
            user.id,
          ]);
          await writeAudit(conn, ctx, { action: lock ? "staff.locked" : "staff.login_failed", entityType: "staff", entityId: user.id, meta: { reason: "bad_password", failures } });
        });
        throw unauthorized(GENERIC_LOGIN_ERROR);
      }
      if (user.status !== "active") {
        await auditStandalone(db, ctx, { action: "staff.login_failed", entityType: "staff", entityId: user.id, meta: { reason: "disabled" } });
        throw new HttpError(403, "DISABLED", "This account is disabled. Contact an administrator.");
      }

      const challenge = randomToken();
      const challengeHash = sha256(challenge);
      const enrolled = Boolean(user.totp_enabled_at && user.totp_secret_enc);
      const pendingSecret = enrolled ? null : newTotpSecret();
      await exec(
        db,
        `INSERT INTO staff_login_challenges (id, staff_id, kind, pending_secret_enc, ip, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          challengeHash,
          user.id,
          enrolled ? "totp" : "enroll",
          pendingSecret ? encryptField(config.dataKey, pendingSecret, pendingContext(challengeHash)) : null,
          req.clientIp,
          new Date(Date.now() + CHALLENGE_MS),
        ],
      );
      if (enrolled) {
        res.json({ step: "totp", challenge });
      } else {
        res.json({ step: "enroll", challenge, secret: pendingSecret, otpauthUrl: otpauthUrl(pendingSecret!, user.email) });
      }
    }),
  );

  router.post(
    "/verify",
    handler(async (req, res) => {
      const body = parse(z.object({ challenge: z.string().min(20).max(128), code: z.string().trim() }), req.body);
      if (!codeLimiter.take(req.clientIp)) throw new HttpError(429, "RATE_LIMITED", "Too many attempts. Wait a few minutes and try again.");
      const challengeHash = sha256(body.challenge);
      const result = await transaction(db, async (conn) => {
        const ch = await one<{ staff_id: number; kind: "totp" | "enroll"; pending_secret_enc: Buffer | null; attempts: number; expires_at: Date; used_at: Date | null }>(
          conn,
          "SELECT * FROM staff_login_challenges WHERE id = ? FOR UPDATE",
          [challengeHash],
        );
        if (!ch || ch.used_at || ch.expires_at.getTime() <= Date.now() || ch.attempts >= CHALLENGE_MAX_ATTEMPTS) {
          return { error: "expired" as const };
        }
        const user = await one<StaffAuthRow>(conn, "SELECT * FROM staff_users WHERE id = ? FOR UPDATE", [ch.staff_id]);
        if (!user || user.status !== "active") return { error: "expired" as const };
        const ctx = auditContext(req, staffActor(user));

        let secret: string;
        if (ch.kind === "enroll") {
          if (!ch.pending_secret_enc) return { error: "expired" as const };
          secret = decryptField(config.dataKey, ch.pending_secret_enc, pendingContext(challengeHash));
        } else {
          if (!user.totp_secret_enc) return { error: "expired" as const };
          secret = decryptField(config.dataKey, user.totp_secret_enc, totpContext(user.id));
        }
        const step = verifyTotp(secret, body.code);
        if (step === null || (user.totp_last_step !== null && step <= user.totp_last_step && ch.kind === "totp")) {
          await exec(conn, "UPDATE staff_login_challenges SET attempts = attempts + 1 WHERE id = ?", [challengeHash]);
          await writeAudit(conn, ctx, { action: "staff.2fa_failed", entityType: "staff", entityId: user.id });
          return { error: "bad_code" as const };
        }
        await exec(conn, "UPDATE staff_login_challenges SET used_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [challengeHash]);
        if (ch.kind === "enroll") {
          await exec(conn, "UPDATE staff_users SET totp_secret_enc = ?, totp_enabled_at = CURRENT_TIMESTAMP(3), totp_last_step = ? WHERE id = ?", [
            encryptField(config.dataKey, secret, totpContext(user.id)),
            step,
            user.id,
          ]);
          await writeAudit(conn, ctx, { action: "staff.2fa_enrolled", entityType: "staff", entityId: user.id });
        } else {
          await exec(conn, "UPDATE staff_users SET totp_last_step = ? WHERE id = ?", [step, user.id]);
        }
        await exec(
          conn,
          "UPDATE staff_users SET failed_login_count = 0, locked_until = NULL, last_login_at = CURRENT_TIMESTAMP(3), last_login_ip = ? WHERE id = ?",
          [req.clientIp, user.id],
        );
        const created = await createSession(conn, config, user.id, req.clientIp, String(req.get("user-agent") ?? ""));
        await writeAudit(conn, ctx, { action: "staff.login", entityType: "staff", entityId: user.id });
        return { created, mustChangePassword: user.must_change_password === 1 };
      });
      if ("error" in result) {
        if (result.error === "bad_code") throw new HttpError(401, "BAD_CODE", "That code is not correct. Check your authenticator app and try again.");
        throw new HttpError(401, "CHALLENGE_EXPIRED", "This sign-in has expired. Start again.");
      }
      setSessionCookie(res, config, result.created.token, result.created.expiresAt);
      res.json({ ok: true, csrfToken: result.created.csrfToken, mustChangePassword: result.mustChangePassword });
    }),
  );

  router.get(
    "/session",
    session,
    handler(async (req, res) => {
      const token = readCookie(req.headers.cookie, cookieName(config))!;
      const staff = staffOf(req);
      const picture = await one<{ sha256: string }>(db, "SELECT sha256 FROM profile_pictures WHERE owner_type = 'staff' AND owner_id = ?", [staff.id]);
      res.json(sessionPayload(staff, csrfFor(config, token), config.stepUpMs, staffAvatarUrl(staff.id, picture?.sha256)));
    }),
  );

  router.post(
    "/logout",
    session,
    handler(async (req, res) => {
      const staff = staffOf(req);
      await transaction(db, async (conn) => {
        await exec(conn, "UPDATE staff_sessions SET revoked_at = CURRENT_TIMESTAMP(3), revoked_reason = 'logout' WHERE id = ?", [staff.sessionId]);
        await writeAudit(conn, auditContext(req, staffActor(staff)), { action: "staff.logout", entityType: "staff", entityId: staff.id });
      });
      clearSessionCookie(res, config);
      res.status(204).end();
    }),
  );

  router.post(
    "/step-up",
    session,
    handler(async (req, res) => {
      const staff = staffOf(req);
      const body = parse(z.object({ code: z.string().trim() }), req.body);
      if (!codeLimiter.take(`stepup:${staff.id}`)) throw new HttpError(429, "RATE_LIMITED", "Too many attempts. Wait a few minutes and try again.");
      const until = await transaction(db, async (conn) => {
        const user = await one<StaffAuthRow>(conn, "SELECT * FROM staff_users WHERE id = ? FOR UPDATE", [staff.id]);
        if (!user?.totp_secret_enc) return null;
        const step = verifyTotp(decryptField(config.dataKey, user.totp_secret_enc, totpContext(user.id)), body.code);
        const ctx = auditContext(req, staffActor(staff));
        if (step === null || (user.totp_last_step !== null && step <= user.totp_last_step)) {
          await writeAudit(conn, ctx, { action: "staff.stepup_failed", entityType: "staff", entityId: staff.id });
          return null;
        }
        await exec(conn, "UPDATE staff_users SET totp_last_step = ? WHERE id = ?", [step, staff.id]);
        await exec(conn, "UPDATE staff_sessions SET stepup_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [staff.sessionId]);
        await writeAudit(conn, ctx, { action: "staff.stepup", entityType: "staff", entityId: staff.id });
        return new Date(Date.now() + config.stepUpMs);
      });
      // A failed step-up is a 400, not a 401: the session is still valid.
      if (!until) throw new HttpError(400, "BAD_CODE", "That code is not correct, or was already used. Wait for the next code.");
      res.json({ stepUpUntil: until.toISOString() });
    }),
  );

  router.post(
    "/password",
    session,
    handler(async (req, res) => {
      const staff = staffOf(req);
      const body = parse(z.object({ currentPassword: z.string().min(1).max(256), newPassword: z.string().min(1).max(256) }), req.body);
      if (!codeLimiter.take(`password:${staff.id}`)) throw new HttpError(429, "RATE_LIMITED", "Too many attempts. Wait a few minutes and try again.");
      const user = await one<StaffAuthRow>(db, "SELECT * FROM staff_users WHERE id = ?", [staff.id]);
      if (!user || !(await verifyPassword(user.password_hash, body.currentPassword))) {
        throw badRequest("Your current password is not correct.");
      }
      const problem = passwordProblem(body.newPassword, user.email);
      if (problem) throw badRequest(problem);
      if (body.newPassword === body.currentPassword) throw badRequest("Choose a password you have not used here before.");
      if (config.passwordBreachCheck && (await isBreachedPassword(body.newPassword, deps.fetch))) {
        throw badRequest("This password has appeared in a data breach. Choose a different one.");
      }
      const hashed = await hashPassword(body.newPassword);
      await transaction(db, async (conn) => {
        await exec(conn, "UPDATE staff_users SET password_hash = ?, must_change_password = 0, password_changed_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [hashed, staff.id]);
        await revokeStaffSessions(conn, staff.id, "password_changed", staff.sessionId);
        await writeAudit(conn, auditContext(req, staffActor(staff)), { action: "staff.password_changed", entityType: "staff", entityId: staff.id });
      });
      res.status(204).end();
    }),
  );

  return router;
}
