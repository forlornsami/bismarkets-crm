import { createHmac } from "node:crypto";
import nodemailer from "nodemailer";
import type { Logger } from "pino";
import type { Config } from "../config";
import { decryptField, encryptField, safeEqual } from "./crypto";
import type { Conn, Db } from "./db";
import { exec, one, rows, transaction } from "./db";
import { outboxContext } from "./email";

// Sending email through the provider staff configure under Settings > Email.
// The outbox is the queue: anything that sends email inserts a row in its own
// transaction, and the sender below delivers due rows with retries.

export interface MailSettings {
  enabled: boolean;
  provider: string;
  host: string | null;
  port: number;
  security: "tls" | "starttls" | "none";
  username: string | null;
  hasPassword: boolean;
  fromName: string;
  fromEmail: string | null;
  replyTo: string | null;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
  updatedAt: string;
}

interface SettingsRow {
  enabled: number;
  provider: string;
  host: string | null;
  port: number;
  security: MailSettings["security"];
  username: string | null;
  password_enc: Buffer | null;
  from_name: string;
  from_email: string | null;
  reply_to: string | null;
  last_test_at: Date | null;
  last_test_ok: number | null;
  last_test_error: string | null;
  updated_at: Date;
}

export const MAIL_PASSWORD_CONTEXT = "mail_settings:password";

export const sealMailPassword = (config: Config, password: string) => encryptField(config.dataKey, password, MAIL_PASSWORD_CONTEXT);

/** The settings as staff see them. The password itself is never returned. */
export async function loadMailSettings(conn: Conn | Db): Promise<MailSettings & { passwordEnc: Buffer | null }> {
  const r = await one<SettingsRow>(conn, "SELECT * FROM mail_settings WHERE id = 1");
  if (!r) throw new Error("mail_settings row is missing");
  return {
    enabled: r.enabled === 1,
    provider: r.provider,
    host: r.host,
    port: r.port,
    security: r.security,
    username: r.username,
    hasPassword: r.password_enc !== null,
    passwordEnc: r.password_enc,
    fromName: r.from_name,
    fromEmail: r.from_email,
    replyTo: r.reply_to,
    lastTestAt: r.last_test_at?.toISOString() ?? null,
    lastTestOk: r.last_test_ok === null ? null : r.last_test_ok === 1,
    lastTestError: r.last_test_error,
    updatedAt: r.updated_at.toISOString(),
  };
}

export const publicMailSettings = ({ passwordEnc: _hidden, ...rest }: Awaited<ReturnType<typeof loadMailSettings>>): MailSettings => rest;

export interface MailMessage {
  from: { name: string; address: string };
  to: string;
  replyTo?: string;
  subject: string;
  text: string;
  html: string;
  headers?: Record<string, string>;
}

export interface MailTransport {
  send(message: MailMessage): Promise<{ messageId: string }>;
  verify(): Promise<void>;
  close(): void;
}

export interface SmtpOptions {
  host: string;
  port: number;
  security: MailSettings["security"];
  username: string | null;
  password: string | null;
}

/** Builds an SMTP transport. Tests replace this through AppDeps.mailTransport. */
export type TransportFactory = (options: SmtpOptions) => MailTransport;

export const smtpTransport: TransportFactory = (o) => {
  const transporter = nodemailer.createTransport({
    host: o.host,
    port: o.port,
    secure: o.security === "tls",
    requireTLS: o.security === "starttls",
    ignoreTLS: o.security === "none",
    auth: o.username ? { user: o.username, pass: o.password ?? "" } : undefined,
    tls: { minVersion: "TLSv1.2", rejectUnauthorized: true, servername: o.host },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return {
    async send(m) {
      const info = await transporter.sendMail({ ...m, disableFileAccess: true, disableUrlAccess: true });
      return { messageId: String(info.messageId ?? "") };
    },
    async verify() {
      await transporter.verify();
    },
    close: () => transporter.close(),
  };
};

export function smtpOptions(config: Config, s: Awaited<ReturnType<typeof loadMailSettings>>): SmtpOptions | null {
  if (!s.host || !s.fromEmail) return null;
  return {
    host: s.host,
    port: s.port,
    security: s.security,
    username: s.username,
    password: s.passwordEnc ? decryptField(config.dataKey, s.passwordEnc, MAIL_PASSWORD_CONTEXT) : null,
  };
}

/** Readable error for staff, without credentials or long server dumps. */
export function describeMailError(e: unknown): string {
  const err = e as { code?: string; responseCode?: number; response?: string; message?: string };
  const code = err.code ?? "";
  if (code === "EAUTH") return "The mail server rejected the username or password.";
  if (code === "ESOCKET" && /certificate|self.signed|CERT/i.test(err.message ?? "")) return "The mail server's security certificate is not valid.";
  if (code === "ECONNECTION" || code === "ESOCKET" || /ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(err.message ?? "")) {
    return "Could not connect to the mail server. Check the host, port and security setting.";
  }
  if (code === "ETIMEDOUT" || /timeout/i.test(err.message ?? "")) return "The mail server did not answer in time. Check the host and port.";
  const text = (err.response ?? err.message ?? "Unknown error").replace(/\s+/g, " ").trim();
  return (err.responseCode ? `The mail server said: ${text}` : text).slice(0, 290);
}

// ---------- Rendering ----------

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Plain text to simple, safe HTML: paragraphs, line breaks and clickable https links. */
export function textToHtml(text: string) {
  return text
    .trim()
    .split(/\n{2,}/)
    .map((para) => {
      const html = escapeHtml(para)
        .replace(/https:\/\/[^\s<>"']+[^\s<>"'.,;:!?)]/g, (url) => `<a href="${url}" style="color:#1d4ed8">${url}</a>`)
        .replace(/\n/g, "<br>");
      return `<p style="margin:0 0 16px">${html}</p>`;
    })
    .join("");
}

export function renderEmailHtml(text: string, opts: { brand: string; unsubscribeUrl?: string }) {
  const footer = opts.unsubscribeUrl
    ? `You are receiving this because you have an account with ${escapeHtml(opts.brand)}. <a href="${escapeHtml(opts.unsubscribeUrl)}" style="color:#64748b">Unsubscribe from news and offers</a>.`
    : `This email was sent by ${escapeHtml(opts.brand)}.`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:24px;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:8px">
<tr><td style="padding:24px 32px;border-bottom:1px solid #e2e8f0;font-size:18px;font-weight:bold">${escapeHtml(opts.brand)}</td></tr>
<tr><td style="padding:32px;font-size:15px;line-height:1.6">${textToHtml(text)}</td></tr>
<tr><td style="padding:16px 32px;border-top:1px solid #e2e8f0;font-size:12px;color:#64748b">${footer}</td></tr>
</table></td></tr></table></body></html>`;
}

// ---------- Unsubscribe links ----------

const unsubscribeKey = (config: Config) => createHmac("sha256", config.dataKey).update("email-unsubscribe-v1").digest();

export const unsubscribeToken = (config: Config, clientId: number) =>
  createHmac("sha256", unsubscribeKey(config)).update(`client:${clientId}`).digest("base64url").slice(0, 32);

export const checkUnsubscribeToken = (config: Config, clientId: number, token: string) => safeEqual(unsubscribeToken(config, clientId), token);

export const unsubscribeUrl = (config: Config, clientId: number) =>
  `${config.publicUrl}/email/unsubscribe?c=${clientId}&t=${unsubscribeToken(config, clientId)}`;

// ---------- Sender ----------

const MAX_ATTEMPTS = 8;
const LEASE_MS = 5 * 60_000;
const backoffMs = (attempt: number) => Math.min(6 * 3_600_000, 60_000 * 2 ** (attempt - 1));

interface DueRow {
  id: number;
  to_email: string;
  template: string;
  category: "system" | "service" | "marketing";
  subject: string;
  body_enc: Buffer;
  client_id: number | null;
  attempts: number;
}

/**
 * Sends due emails. Rows are claimed by moving them to 'sending' with a lease,
 * so several processes can run this and a crash mid-send is retried later.
 */
export async function deliverEmails(db: Db, config: Config, makeTransport: TransportFactory, log?: Logger, batch = 25) {
  const settings = await loadMailSettings(db);
  if (!settings.enabled) return 0;
  const options = smtpOptions(config, settings);
  if (!options || !settings.fromEmail) return 0;

  const due = await transaction(db, async (conn) => {
    const list = await rows<DueRow>(
      conn,
      `SELECT id, to_email, template, category, subject, body_enc, client_id, attempts FROM email_outbox
       WHERE status IN ('queued', 'sending') AND next_attempt_at <= CURRENT_TIMESTAMP(3) ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED`,
      [batch],
    );
    if (list.length) {
      await exec(conn, `UPDATE email_outbox SET status = 'sending', next_attempt_at = ? WHERE id IN (${list.map(() => "?").join(",")})`, [
        new Date(Date.now() + LEASE_MS),
        ...list.map((r) => r.id),
      ]);
    }
    return list;
  });
  if (!due.length) return 0;

  const transport = makeTransport(options);
  const brand = settings.fromName;
  let sent = 0;
  try {
    for (const row of due) {
      const attempts = row.attempts + 1;
      try {
        // Marketing emails respect an unsubscribe made after they were queued.
        if (row.category === "marketing" && row.client_id) {
          const c = await one<{ opted_out: Date | null }>(db, "SELECT marketing_opt_out_at AS opted_out FROM clients WHERE id = ?", [row.client_id]);
          if (c?.opted_out) {
            await exec(db, "UPDATE email_outbox SET status = 'cancelled', last_error = 'The client unsubscribed from news and offers.' WHERE id = ?", [row.id]);
            continue;
          }
        }
        const text = decryptField(config.dataKey, row.body_enc, outboxContext(row.to_email, row.template));
        const unsub = row.category === "marketing" && row.client_id ? unsubscribeUrl(config, row.client_id) : undefined;
        const fullText = unsub ? `${text}\n\nTo stop news and offers, open: ${unsub}` : text;
        const info = await transport.send({
          from: { name: settings.fromName, address: settings.fromEmail },
          to: row.to_email,
          replyTo: settings.replyTo ?? undefined,
          subject: row.subject,
          text: fullText,
          html: renderEmailHtml(text, { brand, unsubscribeUrl: unsub }),
          headers: unsub ? { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : undefined,
        });
        sent++;
        await exec(db, "UPDATE email_outbox SET status = 'sent', attempts = ?, sent_at = CURRENT_TIMESTAMP(3), last_error = NULL, provider_id = ? WHERE id = ?", [
          attempts,
          info.messageId.slice(0, 200) || null,
          row.id,
        ]);
      } catch (e) {
        const responseCode = (e as { responseCode?: number }).responseCode ?? 0;
        // A 5xx reply about this message (bad address, rejected content) will not change on retry.
        const permanent = responseCode >= 500 && responseCode < 600 && (e as { code?: string }).code !== "EAUTH";
        const failed = permanent || attempts >= MAX_ATTEMPTS;
        const error = describeMailError(e);
        await exec(db, "UPDATE email_outbox SET status = ?, attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?", [
          failed ? "failed" : "queued",
          attempts,
          error,
          new Date(Date.now() + backoffMs(attempts)),
          row.id,
        ]);
        if (failed) log?.warn({ emailId: row.id, error }, "Email could not be delivered");
      }
    }
  } finally {
    transport.close();
  }
  return sent;
}

export function startEmailSender(db: Db, config: Config, makeTransport: TransportFactory, log: Logger, everyMs = 5_000) {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    deliverEmails(db, config, makeTransport, log)
      .catch((e) => log.error({ err: e }, "Email sender failed"))
      .finally(() => (running = false));
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
