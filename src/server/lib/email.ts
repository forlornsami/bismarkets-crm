import type { Config } from "../config";
import { encryptField } from "./crypto";
import { exec, one, type Conn } from "./db";

export interface OutgoingEmail {
  to: string;
  template: string;
  subject: string;
  text: string;
  /** Codes and links that must not be readable in the stored copy. */
  secrets?: string[];
  clientId?: number | null;
  staffUserId?: number | null;
  campaignId?: number | null;
  /** 'system' for account emails, 'service' or 'marketing' for emails staff write. */
  category?: "system" | "service" | "marketing";
}

export const outboxContext = (to: string, template: string) => `email_outbox:${to}:${template}`;

/** Whether new email goes out now ('queued') or waits in the outbox ('held'). */
export async function mailEnabled(conn: Conn) {
  const r = await one<{ enabled: number }>(conn, "SELECT enabled FROM mail_settings WHERE id = 1");
  return r?.enabled === 1;
}

/**
 * Queues an email inside the caller's transaction, so it goes out only if the
 * change commits. Until a mail provider is switched on in Settings > Email,
 * messages are held in the outbox. The readable copy has every secret
 * blanked; the full text is stored only encrypted.
 */
export async function queueEmail(conn: Conn, config: Config, email: OutgoingEmail, status?: "queued" | "held") {
  let redacted = email.text;
  for (const secret of email.secrets ?? []) redacted = redacted.split(secret).join("••••••");
  const state = status ?? ((await mailEnabled(conn)) ? "queued" : "held");
  await exec(
    conn,
    `INSERT INTO email_outbox (to_email, template, category, subject, body_text, body_enc, client_id, staff_user_id, campaign_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      email.to,
      email.template,
      email.category ?? "system",
      email.subject,
      redacted,
      encryptField(config.dataKey, email.text, outboxContext(email.to, email.template)),
      email.clientId ?? null,
      email.staffUserId ?? null,
      email.campaignId ?? null,
      state,
    ],
  );
}
