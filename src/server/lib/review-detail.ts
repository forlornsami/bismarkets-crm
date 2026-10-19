import { clientName, clientPictureUrl, type ClientRow } from "../clients/model";
import { one, rows, type Conn } from "./db";

// Pieces every review screen shares (KYC, deposits, withdrawals and IB
// applications), so one review UI draws each queue the same way: the client
// beside the item, and the trail of decisions taken on it.

/** The client as every review screen shows it beside the item. */
export interface ReviewClient {
  id: number;
  name: string;
  verifiedName: string;
  email: string;
  /** Relative, so the admin panel loads it from its own origin. */
  avatarUrl: string | null;
  status: ClientRow["status"];
  kycStatus: ClientRow["kyc_status"];
  country: string | null;
  joinedAt: string;
  assignedTo: { id: number; name: string } | null;
  emailVerified: boolean;
}

/** The client card of a review screen. The caller has already checked the client is in the staff member's scope. */
export async function reviewClient(conn: Conn, clientId: number): Promise<ReviewClient> {
  const c = await one<
    Pick<ClientRow, "id" | "first_name" | "last_name" | "email" | "status" | "kyc_status" | "country" | "created_at" | "email_verified_at" | "assigned_staff_id" | "picture_sha"> & {
      assigned_name: string | null;
    }
  >(
    conn,
    `SELECT c.id, c.first_name, c.last_name, c.email, c.status, c.kyc_status, c.country, c.created_at, c.email_verified_at, c.assigned_staff_id, a.name AS assigned_name,
       p.sha256 AS picture_sha
     FROM clients c LEFT JOIN staff_users a ON a.id = c.assigned_staff_id LEFT JOIN profile_pictures p ON p.owner_type = 'client' AND p.owner_id = c.id
     WHERE c.id = ?`,
    [clientId],
  );
  if (!c) throw new Error(`Client ${clientId} does not exist`);
  return {
    id: c.id,
    name: clientName(c),
    verifiedName: clientName(c),
    email: c.email,
    avatarUrl: clientPictureUrl("", c.id, c.picture_sha),
    status: c.status,
    kycStatus: c.kyc_status,
    country: c.country,
    joinedAt: c.created_at.toISOString(),
    assignedTo: c.assigned_staff_id ? { id: c.assigned_staff_id, name: c.assigned_name ?? "Staff" } : null,
    emailVerified: c.email_verified_at !== null,
  };
}

/** One line of a review screen's "What happened". */
export interface TrailItem {
  at: string;
  action: string;
  label: string;
  /** The staff member who did it, or null for the client. */
  staff: string | null;
  /** What the client was told. */
  reason: string | null;
  /** For colleagues only. */
  internalNote: string | null;
}

type Meta = Record<string, unknown>;
/** The trail's name for an audit action, and its line (from the entry's meta, and the name of the reviewer a take-over took the item from). */
export type TrailStep = { action: string; label: string | ((meta: Meta, tookOverFrom: string | null) => string) };

const text = (v: unknown) => (typeof v === "string" && v ? v : null);

/**
 * What happened to one item, oldest first, from the client's audit log: the
 * actions in `steps` only (decisions, never views). `idKey` is the meta key
 * that names the item (depositId, withdrawalId and so on).
 */
export async function reviewTrail(conn: Conn, o: { clientId: number; idKey: string; id: number; steps: Record<string, TrailStep> }): Promise<TrailItem[]> {
  if (!/^[A-Za-z]+$/.test(o.idKey)) throw new Error(`Not a meta key: ${o.idKey}`);
  const actions = Object.keys(o.steps);
  const found = await rows<{ occurred_at: Date; action: string; actor_type: string; staff_name: string | null; from_name: string | null; meta_json: Meta | null }>(
    conn,
    `SELECT a.occurred_at, a.action, a.actor_type, u.name AS staff_name, f.name AS from_name, a.meta_json
     FROM audit_log a LEFT JOIN staff_users u ON a.actor_type = 'staff' AND u.id = a.actor_id
       LEFT JOIN staff_users f ON a.action LIKE '%.review_taken_over' AND f.id = CAST(a.meta_json->>'$.from' AS UNSIGNED)
     WHERE a.entity_type = 'client' AND a.entity_id = ? AND a.action IN (${actions.map(() => "?").join(",")}) AND a.meta_json->'$.${o.idKey}' = ?
     ORDER BY a.id`,
    [String(o.clientId), ...actions, o.id],
  );
  return found.map((a) => {
    const meta = a.meta_json ?? {};
    const step = o.steps[a.action]!;
    return {
      at: a.occurred_at.toISOString(),
      action: step.action,
      label: typeof step.label === "string" ? step.label : step.label(meta, a.from_name),
      staff: a.actor_type === "staff" ? (a.staff_name ?? "Staff") : null,
      reason: text(meta.reason),
      internalNote: text(meta.internalNote),
    };
  });
}

/** The line for a take-over of someone else's claim. */
export const tookOver = (_meta: Meta, from: string | null) => (from ? `Took over the review from ${from}` : "Took over the review");
