import type { Config } from "../config";
import { encryptField } from "./crypto";
import { exec, type Conn } from "./db";

export interface OutgoingEmail {
  to: string;
  template: string;
  subject: string;
  text: string;
  /** Codes and links that must not be readable in the stored copy. */
  secrets?: string[];
  clientId?: number | null;
}

export const outboxContext = (to: string, template: string) => `email_outbox:${to}:${template}`;

/**
 * Queues an email inside the caller's transaction. No mail provider is
 * connected yet, so messages are held in the outbox. The readable copy has
 * every secret blanked; the full text is stored only encrypted.
 */
export async function queueEmail(conn: Conn, config: Config, email: OutgoingEmail) {
  let redacted = email.text;
  for (const secret of email.secrets ?? []) redacted = redacted.split(secret).join("••••••");
  await exec(
    conn,
    "INSERT INTO email_outbox (to_email, template, subject, body_text, body_enc, client_id, status) VALUES (?, ?, ?, ?, ?, ?, 'held')",
    [email.to, email.template, email.subject, redacted, encryptField(config.dataKey, email.text, outboxContext(email.to, email.template)), email.clientId ?? null],
  );
}
