import type { Conn } from "../lib/db";
import { exec } from "../lib/db";

// The bell in the client portal and app. Rows are written in the same
// transaction as the change they describe.

export type NotificationType = "kyc" | "security" | "account";

export const NOTIFICATION_TYPES: { value: NotificationType; label: string }[] = [
  { value: "kyc", label: "Verification" },
  { value: "security", label: "Security" },
  { value: "account", label: "Account" },
];

export async function notifyClient(
  conn: Conn,
  clientId: number,
  n: { type: NotificationType; title: string; body: string; link?: string; linkLabel?: string },
) {
  await exec(conn, "INSERT INTO client_notifications (client_id, type, title, body, link, link_label) VALUES (?, ?, ?, ?, ?, ?)", [
    clientId, n.type, n.title.slice(0, 160), n.body.slice(0, 1000), n.link ?? null, n.linkLabel ?? null,
  ]);
}
