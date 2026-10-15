import type { Request } from "express";
import { exec, one, rows, type Conn, type Db, transaction } from "./db";
import { sha256 } from "./crypto";

export interface AuditActor {
  type: "staff" | "client" | "system";
  id: number | null;
  label: string;
}

export interface AuditEntry {
  action: string;
  entityType?: string;
  entityId?: string | number;
  before?: unknown;
  after?: unknown;
  meta?: unknown;
}

export interface AuditContext {
  actor: AuditActor;
  ip: string;
  userAgent: string;
}

export const GENESIS_HASH = "0".repeat(64);

/** Stable JSON: object keys sorted, so the same content always hashes the same. */
export function canonical(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

interface Hashable {
  occurredAt: Date;
  actorType: string;
  actorId: number | null;
  actorLabel: string;
  action: string;
  entityType: string;
  entityId: string;
  ip: string;
  userAgent: string;
  before: unknown;
  after: unknown;
  meta: unknown;
}

export function entryHash(prevHash: string, e: Hashable): string {
  return sha256(
    prevHash +
      canonical({
        occurred_at: e.occurredAt.toISOString(),
        actor_type: e.actorType,
        actor_id: e.actorId,
        actor_label: e.actorLabel,
        action: e.action,
        entity_type: e.entityType,
        entity_id: e.entityId,
        ip: e.ip,
        user_agent: e.userAgent,
        before: e.before ?? null,
        after: e.after ?? null,
        meta: e.meta ?? null,
      }),
  );
}

/** Millisecond precision matches DATETIME(3), so the stored time re-hashes identically. */
const nowMs = () => new Date(Math.floor(Date.now()));

const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));

/**
 * Appends one entry inside the caller's transaction. The chain head row is
 * locked, so concurrent writers queue instead of forking the chain. Call it in
 * the same transaction as the change it records: both commit or neither does.
 */
export async function writeAudit(conn: Conn, ctx: AuditContext, entry: AuditEntry): Promise<void> {
  const head = await one<{ last_hash: string }>(conn, "SELECT last_hash FROM audit_chain_head WHERE id = 1 FOR UPDATE");
  if (!head) throw new Error("Audit chain head missing; run migrations.");
  const record: Hashable = {
    occurredAt: nowMs(),
    actorType: ctx.actor.type,
    actorId: ctx.actor.id,
    actorLabel: ctx.actor.label.slice(0, 254),
    action: entry.action,
    entityType: entry.entityType ?? "",
    entityId: entry.entityId === undefined ? "" : String(entry.entityId),
    ip: ctx.ip.slice(0, 45),
    userAgent: ctx.userAgent.slice(0, 255),
    before: entry.before ?? null,
    after: entry.after ?? null,
    meta: entry.meta ?? null,
  };
  const hash = entryHash(head.last_hash, record);
  const result = await exec(
    conn,
    `INSERT INTO audit_log (occurred_at, actor_type, actor_id, actor_label, action, entity_type, entity_id,
       ip, user_agent, before_json, after_json, meta_json, prev_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.occurredAt, record.actorType, record.actorId, record.actorLabel, record.action, record.entityType,
      record.entityId, record.ip, record.userAgent, json(record.before), json(record.after), json(record.meta),
      head.last_hash, hash,
    ],
  );
  await exec(conn, "UPDATE audit_chain_head SET last_id = ?, last_hash = ? WHERE id = 1", [result.insertId, hash]);
}

/** Records an event on its own (for events with no other database change, such as a failed login). */
export const auditStandalone = (db: Db, ctx: AuditContext, entry: AuditEntry) =>
  transaction(db, (conn) => writeAudit(conn, ctx, entry));

export function auditContext(req: Request, actor: AuditActor): AuditContext {
  return { actor, ip: req.clientIp, userAgent: String(req.get("user-agent") ?? "") };
}

interface AuditRow {
  id: number;
  occurred_at: Date;
  actor_type: string;
  actor_id: number | null;
  actor_label: string;
  action: string;
  entity_type: string;
  entity_id: string;
  ip: string;
  user_agent: string;
  before_json: unknown;
  after_json: unknown;
  meta_json: unknown;
  prev_hash: string;
  hash: string;
}

export interface ChainReport {
  ok: boolean;
  checked: number;
  brokenAtId: number | null;
  reason: string | null;
}

/** Re-computes every hash from the first entry; reports the first break. */
export async function verifyAuditChain(db: Db, batch = 1000): Promise<ChainReport> {
  let prev = GENESIS_HASH;
  let lastId = 0;
  let checked = 0;
  for (;;) {
    const page = await rows<AuditRow>(db, "SELECT * FROM audit_log WHERE id > ? ORDER BY id LIMIT ?", [lastId, batch]);
    for (const r of page) {
      if (r.prev_hash !== prev) return { ok: false, checked, brokenAtId: r.id, reason: "Entry does not follow the previous entry" };
      const expected = entryHash(prev, {
        occurredAt: r.occurred_at, actorType: r.actor_type, actorId: r.actor_id, actorLabel: r.actor_label,
        action: r.action, entityType: r.entity_type, entityId: r.entity_id, ip: r.ip, userAgent: r.user_agent,
        before: r.before_json, after: r.after_json, meta: r.meta_json,
      });
      if (expected !== r.hash) return { ok: false, checked, brokenAtId: r.id, reason: "Entry content does not match its hash" };
      prev = r.hash;
      lastId = r.id;
      checked += 1;
    }
    if (page.length < batch) break;
  }
  const head = await one<{ last_id: number; last_hash: string }>(db, "SELECT last_id, last_hash FROM audit_chain_head WHERE id = 1");
  if (!head || head.last_hash !== prev || Number(head.last_id) !== lastId) {
    return { ok: false, checked, brokenAtId: lastId || null, reason: "Newest entries are missing" };
  }
  return { ok: true, checked, brokenAtId: null, reason: null };
}
