import { Router } from "express";
import { z } from "zod";
import { MAIL_PROVIDERS } from "@shared/mail-providers";
import type { AppDeps } from "../../app";
import { emailField } from "../../clients/model";
import { auditContext, writeAudit } from "../../lib/audit";
import { exec, one, transaction } from "../../lib/db";
import { badRequest, handler, parse } from "../../lib/http";
import { describeMailError, loadMailSettings, publicMailSettings, renderEmailHtml, sealMailPassword, smtpOptions, smtpTransport } from "../../lib/mailer";
import { RateLimiter } from "../../lib/rateLimit";
import { requirePermission, requireStepUp, staffActor, staffOf } from "../../staff/session";

const hostname = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "Enter the mail server's host name, such as smtp.hostinger.com.");

const optionalEmail = z
  .union([emailField, z.literal(""), z.null()])
  .optional()
  .transform((v) => (v ? v : null));

const settingsBody = z.object({
  provider: z.enum(MAIL_PROVIDERS.map((p) => p.id) as [string, ...string[]]),
  host: hostname,
  port: z.coerce.number().int().min(1).max(65535),
  security: z.enum(["tls", "starttls", "none"]),
  username: z.string().trim().max(254).optional().transform((v) => v || null),
  /** Left out or empty keeps the saved password; `clearPassword` removes it. */
  password: z.string().max(500).optional(),
  clearPassword: z.boolean().optional(),
  fromName: z.string().trim().min(1, "Enter the sender name clients will see.").max(80).regex(/^[^<>"\r\n]+$/, "The sender name cannot contain < > or quotes."),
  fromEmail: emailField,
  replyTo: optionalEmail,
});

/**
 * Settings > Email: the SMTP provider the CRM sends through. Reading needs
 * settings.view; changing, testing or switching sending on needs
 * settings.manage and a fresh 2FA code. The password is stored encrypted and
 * never sent back. Changing the connection pauses sending until a test passes.
 */
export function staffMailRouter(deps: AppDeps): Router {
  const { db, config } = deps;
  const makeTransport = deps.mailTransport ?? smtpTransport;
  const router = Router();
  const stepUp = requireStepUp(config);
  const testLimit = new RateLimiter(10, 15 * 60_000);

  router.get(
    "/",
    requirePermission("settings.view"),
    handler(async (_req, res) => {
      const settings = publicMailSettings(await loadMailSettings(db));
      const counts = await one<{ held: number; queued: number; failed: number }>(
        db,
        "SELECT SUM(status = 'held') AS held, SUM(status IN ('queued', 'sending')) AS queued, SUM(status = 'failed') AS failed FROM email_outbox",
      );
      res.json({
        settings,
        providers: MAIL_PROVIDERS,
        outbox: { held: Number(counts?.held ?? 0), queued: Number(counts?.queued ?? 0), failed: Number(counts?.failed ?? 0) },
      });
    }),
  );

  router.put(
    "/",
    requirePermission("settings.manage"),
    stepUp,
    handler(async (req, res) => {
      const body = parse(settingsBody, req.body);
      if (body.security === "none" && config.env === "production") throw badRequest("Choose SSL/TLS or STARTTLS. Unencrypted mail servers are not allowed.");
      const actor = staffOf(req);
      await transaction(db, async (conn) => {
        const before = await loadMailSettings(conn);
        const newPassword = body.password ? sealMailPassword(config, body.password) : undefined;
        const connectionChanged =
          before.host !== body.host ||
          before.port !== body.port ||
          before.security !== body.security ||
          before.username !== body.username ||
          before.fromEmail !== body.fromEmail ||
          newPassword !== undefined ||
          (body.clearPassword === true && before.hasPassword);
        await exec(
          conn,
          `UPDATE mail_settings SET provider = ?, host = ?, port = ?, security = ?, username = ?, from_name = ?, from_email = ?, reply_to = ?,
             password_enc = ${newPassword ? "?" : body.clearPassword ? "NULL" : "password_enc"},
             enabled = ${connectionChanged ? 0 : "enabled"},
             last_test_ok = ${connectionChanged ? "NULL" : "last_test_ok"},
             updated_by = ?
           WHERE id = 1`,
          [body.provider, body.host, body.port, body.security, body.username, body.fromName, body.fromEmail, body.replyTo, ...(newPassword ? [newPassword] : []), actor.id],
        );
        await writeAudit(conn, auditContext(req, staffActor(actor)), {
          action: "mail.settings_updated",
          entityType: "mail_settings",
          entityId: "1",
          before: { provider: before.provider, host: before.host, port: before.port, security: before.security, username: before.username, fromName: before.fromName, fromEmail: before.fromEmail, replyTo: before.replyTo, enabled: before.enabled },
          after: {
            provider: body.provider, host: body.host, port: body.port, security: body.security, username: body.username, fromName: body.fromName, fromEmail: body.fromEmail, replyTo: body.replyTo,
            passwordChanged: newPassword !== undefined || (body.clearPassword === true && before.hasPassword),
            enabled: connectionChanged ? false : before.enabled,
          },
        });
      });
      res.json({ settings: publicMailSettings(await loadMailSettings(db)) });
    }),
  );

  // Sends one email straight through the saved settings, so staff see at once whether they work.
  router.post(
    "/test",
    requirePermission("settings.manage"),
    stepUp,
    handler(async (req, res) => {
      const { to } = parse(z.object({ to: emailField }), req.body);
      const actor = staffOf(req);
      if (!testLimit.take(String(actor.id))) throw badRequest("Too many test emails. Wait a few minutes and try again.");
      const settings = await loadMailSettings(db);
      const options = smtpOptions(config, settings);
      if (!options || !settings.fromEmail) throw badRequest("Save the mail server and sender address first.");
      let error: string | null = null;
      const transport = makeTransport(options);
      try {
        const text = `This is a test email from the BIS Markets CRM.\n\nIf you can read this, emails to clients and staff will be delivered through ${settings.host}.\n\nSent by ${actor.email}.`;
        await transport.send({
          from: { name: settings.fromName, address: settings.fromEmail },
          to,
          replyTo: settings.replyTo ?? undefined,
          subject: "Test email from the BIS Markets CRM",
          text,
          html: renderEmailHtml(text, { brand: settings.fromName }),
        });
      } catch (e) {
        error = describeMailError(e);
      } finally {
        transport.close();
      }
      await transaction(db, async (conn) => {
        await exec(conn, "UPDATE mail_settings SET last_test_at = CURRENT_TIMESTAMP(3), last_test_ok = ?, last_test_error = ? WHERE id = 1", [error ? 0 : 1, error]);
        await writeAudit(conn, auditContext(req, staffActor(actor)), {
          action: "mail.test_sent",
          entityType: "mail_settings",
          entityId: "1",
          meta: { to, ok: !error, error },
        });
      });
      res.json({ ok: !error, error, settings: publicMailSettings(await loadMailSettings(db)) });
    }),
  );

  // Switches delivery on or off. On needs a passing test of the current settings.
  router.post(
    "/enabled",
    requirePermission("settings.manage"),
    stepUp,
    handler(async (req, res) => {
      const { enabled, releaseHeld } = parse(z.object({ enabled: z.boolean(), releaseHeld: z.boolean().optional() }), req.body);
      const actor = staffOf(req);
      const released = await transaction(db, async (conn) => {
        const before = await loadMailSettings(conn);
        if (enabled && before.lastTestOk !== true) throw badRequest("Send a test email that arrives before switching sending on.");
        await exec(conn, "UPDATE mail_settings SET enabled = ?, updated_by = ? WHERE id = 1", [enabled ? 1 : 0, actor.id]);
        let count = 0;
        // Held emails can carry codes that have since expired, so releasing them is a choice.
        if (enabled && releaseHeld) {
          const r = await exec(conn, "UPDATE email_outbox SET status = 'queued', next_attempt_at = CURRENT_TIMESTAMP(3) WHERE status = 'held' AND created_at > CURRENT_TIMESTAMP(3) - INTERVAL 1 DAY");
          count = r.affectedRows;
        }
        await writeAudit(conn, auditContext(req, staffActor(actor)), {
          action: enabled ? "mail.sending_enabled" : "mail.sending_disabled",
          entityType: "mail_settings",
          entityId: "1",
          before: { enabled: before.enabled },
          after: { enabled },
          meta: enabled ? { releasedHeld: count } : undefined,
        });
        return count;
      });
      res.json({ settings: publicMailSettings(await loadMailSettings(db)), released });
    }),
  );

  return router;
}
