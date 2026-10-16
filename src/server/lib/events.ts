import { createHmac, randomUUID } from "node:crypto";
import type { Config } from "../config";
import type { Logger } from "pino";
import type { Conn, Db } from "./db";
import { exec, rows, transaction } from "./db";

// Account events for bismarkets-support, which pushes them to the client app
// and signs devices out. The contract is fixed by its
// POST /api/client-notifications/events/crm route: schema_version 1, an
// HMAC-SHA256 signature over timestamp, method, path, event id and body.

export type SupportEvent =
  | "kyc.approved" | "kyc.rejected"
  | "kyc.identity.approved" | "kyc.identity.rejected"
  | "kyc.address.approved" | "kyc.address.rejected"
  | "account.disabled" | "account.enabled" | "session.revoked";

export const SUPPORT_EVENTS_PATH = "/api/client-notifications/events/crm";
const MAX_ATTEMPTS = 12;

/** The session reference the support service sees: the same value GET /api/user returns as session_id. */
export const sessionRef = (sessionId: string) => sessionId.slice(0, 32);

/** Queues an event in the caller's transaction, so it is sent only if the change commits. */
export async function queueSupportEvent(
  conn: Conn,
  config: Config,
  input: { event: SupportEvent; clientId: number; referenceId?: string | number; sessionId?: string },
) {
  const eventId = randomUUID();
  const payload: Record<string, unknown> = {
    schema_version: 1,
    environment: config.supportEvents.environment,
    source: "crm",
    event_id: eventId,
    event: input.event,
    user_id: String(input.clientId),
    occurred_at: new Date().toISOString(),
  };
  if (input.referenceId !== undefined) payload.reference_id = String(input.referenceId);
  if (input.sessionId) payload.session_id = sessionRef(input.sessionId);
  await exec(conn, "INSERT INTO webhook_outbox (event_id, event, client_id, payload) VALUES (?, ?, ?, ?)", [eventId, input.event, input.clientId, JSON.stringify(payload)]);
  return eventId;
}

export function signSupportEvent(secret: string, eventId: string, body: string, timestamp = Math.floor(Date.now() / 1000)) {
  const ts = String(timestamp);
  const signature = "v1=" + createHmac("sha256", secret).update(`${ts}\nPOST\n${SUPPORT_EVENTS_PATH}\n${eventId}\n`).update(body).digest("hex");
  return { timestamp: ts, signature };
}

const backoffMs = (attempt: number) => Math.min(6 * 3_600_000, 30_000 * 2 ** (attempt - 1));

/** Sends due events. Safe to run from several processes: rows are claimed with SKIP LOCKED. */
export async function deliverSupportEvents(db: Db, config: Config, doFetch: typeof fetch, log?: Logger, batch = 20) {
  const { url, secret } = config.supportEvents;
  if (!url || secret.length < 32) return 0;
  let sent = 0;
  await transaction(db, async (conn) => {
    const due = await rows<{ id: number; event_id: string; payload: string | object; attempts: number }>(
      conn,
      "SELECT id, event_id, payload, attempts FROM webhook_outbox WHERE status = 'queued' AND next_attempt_at <= CURRENT_TIMESTAMP(3) ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED",
      [batch],
    );
    for (const row of due) {
      const body = typeof row.payload === "string" ? row.payload : JSON.stringify(row.payload);
      const { timestamp, signature } = signSupportEvent(secret, row.event_id, body);
      let status = 0;
      let error: string | null = null;
      try {
        const res = await doFetch(url + SUPPORT_EVENTS_PATH, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json", "X-Event-ID": row.event_id, "X-Event-Timestamp": timestamp, "X-Event-Signature": signature },
          body,
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        });
        status = res.status;
        if (!res.ok) error = `HTTP ${res.status}`;
      } catch (e) {
        error = (e as Error).message.slice(0, 200);
      }
      const attempts = row.attempts + 1;
      if (!error) {
        sent++;
        await exec(conn, "UPDATE webhook_outbox SET status = 'delivered', attempts = ?, last_status = ?, last_error = NULL, delivered_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [attempts, status, row.id]);
        continue;
      }
      // 4xx other than timeouts and rate limits will not succeed on retry.
      const permanent = status >= 400 && status < 500 && status !== 408 && status !== 429;
      const failed = permanent || attempts >= MAX_ATTEMPTS;
      await exec(conn, "UPDATE webhook_outbox SET status = ?, attempts = ?, last_status = ?, last_error = ?, next_attempt_at = ? WHERE id = ?", [
        failed ? "failed" : "queued", attempts, status || null, error, new Date(Date.now() + backoffMs(attempts)), row.id,
      ]);
      if (failed) log?.warn({ eventId: row.event_id, status, error }, "Support event could not be delivered");
    }
  });
  return sent;
}

/** Runs the sender every few seconds in the server process. */
export function startSupportEventSender(db: Db, config: Config, doFetch: typeof fetch, log: Logger, everyMs = 5_000) {
  if (!config.supportEvents.url) {
    log.info("Support events are queued but not sent: CRM_SUPPORT_EVENTS_URL is not set");
    return () => undefined;
  }
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    deliverSupportEvents(db, config, doFetch, log)
      .catch((e) => log.error({ err: e }, "Support event sender failed"))
      .finally(() => (running = false));
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
