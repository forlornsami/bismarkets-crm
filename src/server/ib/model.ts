import type { Conn } from "../lib/db";
import { one, rows } from "../lib/db";

// IB applications and partnerships as the CRM stores them, and as the portal
// and app read them. Both front ends know four statuses, all lower case:
// none, pending, approved and rejected. A partnership staff removed later
// reads as rejected, with the reason, so the client can apply again.

/** The IB terms the portal and app show with the application form. Stored with each application. */
export const IB_TERMS_VERSION = "2026-10";

export type ApplicationStatus = "pending" | "approved" | "rejected" | "removed";
export type ClientIbStatus = "none" | "pending" | "approved" | "rejected";

export const clientIbStatus = (status: ApplicationStatus | null | undefined): ClientIbStatus =>
  !status ? "none" : status === "removed" ? "rejected" : status;

export interface ApplicationRow {
  id: number;
  client_id: number;
  status: ApplicationStatus;
  terms_version: string;
  submitted_at: Date;
  submitted_ip: string | null;
  submitted_user_agent: string | null;
  decided_at: Date | null;
  decided_by: number | null;
  reject_reason: string | null;
  checklist: string[] | null;
  tier_id: number | null;
  removed_at: Date | null;
  removed_by: number | null;
  updated_at: Date;
}

const APPLICATION = `SELECT id, client_id, status, terms_version, submitted_at, submitted_ip, submitted_user_agent, decided_at, decided_by, reject_reason, checklist, tier_id,
  removed_at, removed_by, updated_at FROM ib_applications`;

/** The client's latest application, which decides what the portal and app show. */
export const latestApplication = (conn: Conn, clientId: number) =>
  one<ApplicationRow>(conn, `${APPLICATION} WHERE client_id = ? ORDER BY submitted_at DESC, id DESC LIMIT 1`, [clientId]);

/** The pending or approved application, if any (there is at most one: see uq_ib_app_open). */
export const openApplication = (conn: Conn, clientId: number) =>
  one<ApplicationRow>(conn, `${APPLICATION} WHERE client_id = ? AND status IN ('pending', 'approved') ORDER BY id DESC LIMIT 1`, [clientId]);

export const isOpen = (a: Pick<ApplicationRow, "status"> | undefined) => a?.status === "pending" || a?.status === "approved";

export interface TierRow {
  id: number;
  name: string;
  position: number;
  min_clients: number;
  min_deposit_cents: number;
  min_volume_lots: string;
}

/** Every IB level, entry level first. */
export const loadTiers = (conn: Conn) =>
  rows<TierRow>(conn, "SELECT id, name, position, min_clients, min_deposit_cents, min_volume_lots FROM ib_tiers ORDER BY position");

export interface PartnerRow {
  client_id: number;
  status: "active" | "removed";
  application_id: number;
  tier_id: number;
  tier_name: string;
  tier_position: number;
  approved_at: Date;
  approved_by: number | null;
  removed_at: Date | null;
  removed_by: number | null;
  removed_reason: string | null;
  client_status: "active" | "frozen" | "closed";
}

const PARTNER = `SELECT p.client_id, p.status, p.application_id, p.tier_id, t.name AS tier_name, t.position AS tier_position, p.approved_at, p.approved_by,
  p.removed_at, p.removed_by, p.removed_reason, c.status AS client_status
  FROM ib_partners p JOIN ib_tiers t ON t.id = p.tier_id JOIN clients c ON c.id = p.client_id`;

/** The client's partnership row, active or removed. */
export const partnerOf = (conn: Conn, clientId: number) => one<PartnerRow>(conn, `${PARTNER} WHERE p.client_id = ?`, [clientId]);

/**
 * The client's partnership if they are an IB now. A closed account is not an
 * IB anywhere (its own reads, its sponsor's sub-IBs and counts), even before
 * staff remove the partnership.
 */
export const activePartner = (conn: Conn, clientId: number) =>
  one<PartnerRow>(conn, `${PARTNER} WHERE p.client_id = ? AND p.status = 'active' AND c.status <> 'closed'`, [clientId]);

/** Whether this client may send an IB application now: verified, not on hold, and nothing open. */
export const mayApply = (client: { status: string; kyc_status: string }, latest: ApplicationRow | undefined) =>
  client.status === "active" && client.kyc_status === "approved" && !isOpen(latest);

const STATE: Record<ApplicationStatus | "none", { label: string; message: string }> = {
  none: { label: "Not applied", message: "No IB application found." },
  pending: { label: "Pending review", message: "Your IB application is being reviewed." },
  approved: { label: "Approved", message: "You are an approved IB partner." },
  rejected: { label: "Not approved", message: "Your IB application was not approved." },
  removed: { label: "Partnership ended", message: "Your IB partnership has ended." },
};

const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

/**
 * GET /api/ib-request (and the POST's answer): the status at the top level and
 * under `data`, which both front ends read, always lower case. Dates are UTC.
 */
export function presentIbRequest(app: ApplicationRow | undefined, canSubmit: boolean) {
  const status = clientIbStatus(app?.status);
  const state = STATE[app?.status ?? "none"];
  const ended = app?.status === "rejected" || app?.status === "removed";
  return {
    success: true,
    status,
    can_submit: canSubmit,
    status_label: state.label,
    message: state.message,
    data: {
      id: app?.id ?? null,
      status,
      terms: Boolean(app),
      created_at: iso(app?.submitted_at),
      updated_at: iso(app?.updated_at),
      submitted_at: iso(app?.submitted_at),
      // For a removed partnership, when it ended.
      decided_at: iso(app?.status === "removed" ? app.removed_at : app?.decided_at),
      rejection_reason: ended ? app.reject_reason : null,
      removed: app?.status === "removed",
    },
  };
}
