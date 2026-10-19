import type { ChecklistItem } from "@shared/money";
import type { Config } from "../config";
import type { ClientRow } from "../clients/model";
import { notifyClient } from "../clients/notifications";
import { one, rows, type Conn } from "../lib/db";
import { queueEmail } from "../lib/email";
import { badRequest, conflict, forbidden, type HttpError } from "../lib/http";
import { activeClaim } from "../lib/review";
import { inScope } from "../money/review";
import type { StaffContext } from "../staff/session";
import type { ApplicationStatus } from "./model";

// The IB application review: what a reviewer confirms, the ready-made reasons,
// who may take each step, and the automatic checks shown as warnings. The
// review screen and the decisions use the same rules, so the screen never
// offers a step the server would refuse.

/** Every item must be ticked before approving. */
export const IB_CHECKLIST: { review: ChecklistItem[] } = {
  review: [
    { key: "kyc", label: "Identity and address are verified" },
    { key: "single", label: "The client has no other IB account" },
    { key: "referrals", label: "Referred clients are real, separate people" },
    { key: "standing", label: "Account and trading history raise no concerns" },
  ],
};

/** Ready-made reasons for a rejection, shown to the client as written. The reviewer can edit them. */
export const IB_REJECT_REASONS = [
  "Please complete identity and address verification, then apply again.",
  "Your account needs more deposit or trading history before it can join the IB program. Please apply again later.",
  "We could not approve an IB account linked to this profile. Please contact support.",
  "Your application does not meet our IB program requirements. Please contact support for details.",
];

/** Ready-made reasons for ending a partnership. */
export const IB_REMOVE_REASONS = [
  "Your IB account no longer meets our IB program requirements. Please contact support for details.",
  "We found activity that breaks the IB program terms. Please contact support.",
  "Your IB partnership was ended at your request.",
];

export const NOT_FOUND = "That application does not exist or its client is not assigned to you.";

/** An application with what the review needs about its client, as the staff routes read it. */
export interface ReviewRow {
  id: number;
  client_id: number;
  status: ApplicationStatus;
  terms_version: string;
  submitted_at: Date;
  submitted_ip: string | null;
  submitted_user_agent: string | null;
  decided_at: Date | null;
  decided_by: number | null;
  decider_name: string | null;
  reject_reason: string | null;
  checklist: string[] | null;
  tier_id: number | null;
  removed_at: Date | null;
  removed_by: number | null;
  remover_name: string | null;
  notes: { at: string; by: number; byName: string; stage: string; text: string }[] | null;
  claimed_by: number | null;
  claimed_until: Date | null;
  claimer_name: string | null;
  first_name: string;
  last_name: string;
  email: string;
  email_verified_at: Date | null;
  client_status: ClientRow["status"];
  kyc_status: ClientRow["kyc_status"];
  country: string | null;
  dob: string | null;
  assigned_staff_id: number | null;
  assigned_name: string | null;
  created_by_staff_id: number | null;
  client_created_at: Date;
  referred_by: number | null;
  created_ip: string | null;
  last_login_ip: string | null;
  picture_sha: string | null;
  // The latest identity and address submissions (taken-back ones skipped): status, and who uploaded it for the client.
  kyc_identity: "pending" | "approved" | "rejected" | null;
  kyc_identity_by: number | null;
  kyc_address: "pending" | "approved" | "rejected" | null;
  kyc_address_by: number | null;
  referred_clients: number;
  rejected_before: number;
  removed_before: number;
}

const latestKyc = (category: "identity" | "address", column: "status" | "uploaded_by") =>
  `(SELECT k.${column} FROM kyc_submissions k WHERE k.client_id = a.client_id AND k.category = '${category}' AND k.status <> 'withdrawn' ORDER BY k.id DESC LIMIT 1)`;

export const REVIEW_SELECT = `SELECT a.id, a.client_id, a.status, a.terms_version, a.submitted_at, a.submitted_ip, a.submitted_user_agent, a.decided_at, a.decided_by, dc.name AS decider_name,
  a.reject_reason, a.checklist, a.tier_id, a.removed_at, a.removed_by, rm.name AS remover_name, a.notes, a.claimed_by, a.claimed_until, cl.name AS claimer_name,
  c.first_name, c.last_name, c.email, c.email_verified_at, c.status AS client_status, c.kyc_status, c.country, DATE_FORMAT(c.dob, '%Y-%m-%d') AS dob,
  c.assigned_staff_id, asg.name AS assigned_name, c.created_by_staff_id, c.created_at AS client_created_at, c.referred_by, c.created_ip, c.last_login_ip, pp.sha256 AS picture_sha,
  ${latestKyc("identity", "status")} AS kyc_identity, ${latestKyc("identity", "uploaded_by")} AS kyc_identity_by,
  ${latestKyc("address", "status")} AS kyc_address, ${latestKyc("address", "uploaded_by")} AS kyc_address_by,
  (SELECT COUNT(*) FROM clients rc WHERE rc.referred_by = a.client_id) AS referred_clients,
  (SELECT COUNT(*) FROM ib_applications e WHERE e.client_id = a.client_id AND e.id < a.id AND e.status = 'rejected') AS rejected_before,
  (SELECT COUNT(*) FROM ib_applications e WHERE e.client_id = a.client_id AND e.id < a.id AND e.status = 'removed') AS removed_before
  FROM ib_applications a JOIN clients c ON c.id = a.client_id
  LEFT JOIN profile_pictures pp ON pp.owner_type = 'client' AND pp.owner_id = c.id
  LEFT JOIN staff_users asg ON asg.id = c.assigned_staff_id LEFT JOIN staff_users dc ON dc.id = a.decided_by
  LEFT JOIN staff_users rm ON rm.id = a.removed_by LEFT JOIN staff_users cl ON cl.id = a.claimed_by`;

export const verifiedName = (r: Pick<ReviewRow, "first_name" | "last_name">) => `${r.first_name} ${r.last_name}`.trim();

/**
 * Four eyes: whoever set up this client (created the account, is their account
 * manager, or uploaded or approved without documents one of their current
 * verified KYC submissions) never approves their IB application alone.
 */
export const setUpBy = (r: ReviewRow, staffId: number) =>
  r.created_by_staff_id === staffId ||
  r.assigned_staff_id === staffId ||
  (r.kyc_identity === "approved" && r.kyc_identity_by === staffId) ||
  (r.kyc_address === "approved" && r.kyc_address_by === staffId);

/** The same rule in SQL (aliases `a` and `c`), for `next` and the "for me" count. Takes the staff id three times. */
export const NOT_SET_UP_BY = `COALESCE(c.created_by_staff_id, 0) <> ? AND COALESCE(c.assigned_staff_id, 0) <> ?
  AND NOT EXISTS (SELECT 1 FROM kyc_submissions k WHERE k.client_id = a.client_id AND k.status = 'approved' AND k.uploaded_by = ?
    AND k.id = (SELECT MAX(k2.id) FROM kyc_submissions k2 WHERE k2.client_id = k.client_id AND k2.category = k.category AND k2.status <> 'withdrawn'))`;

export const FOUR_EYES = "You set up this client's account or KYC, so another person must approve their IB application.";
const NO_DECIDE = "You can look at this application but not decide it.";

export type Action = "approve" | "reject" | "remove";

/**
 * Why this staff member may not take this step now, or null. The review
 * screen shows the same text the decision fails with; decisions run it again
 * with the client and the application locked. `partnerActive` is whether the
 * client's partnership from this application is still active (remove only).
 */
export function blockOf(staff: StaffContext, r: ReviewRow, action: Action, partnerActive = false): HttpError | null {
  if (!staff.permissions.has("ib.decide")) return forbidden(NO_DECIDE);
  if (action === "remove") {
    if (r.status !== "approved" || !partnerActive) return badRequest(r.status === "removed" ? "This client's IB status was already removed." : "Only an approved IB partner's status can be removed.");
    // Removing is allowed whatever the account's state: a frozen or closed account must not stay an IB.
    return null;
  }
  if (r.status !== "pending") return badRequest("This application was already decided.");
  if (r.client_status === "closed") return badRequest("This account is closed.");
  const holder = activeClaim(r);
  if (holder && holder !== staff.id) return conflict(`${r.claimer_name ?? "Someone else"} is reviewing this right now.`);
  if (action === "reject") return null;
  if (r.client_status === "frozen") return badRequest("This account is frozen. Unfreeze it before approving.");
  if (r.kyc_status !== "approved") return badRequest("Identity and address must both be verified before approving.");
  if (setUpBy(r, staff.id)) return forbidden(FOUR_EYES);
  return null;
}

export const can = (staff: StaffContext, r: ReviewRow, action: Action, partnerActive = false) => {
  const block = blockOf(staff, r, action, partnerActive);
  return { ok: block === null, reason: block?.message ?? null };
};

/** Bad and warn flags worked out by the query alone, for the queue's count (the review screen looks further). */
export const warningCount = (r: ReviewRow) =>
  [r.kyc_status !== "approved", r.client_status !== "active", !r.email_verified_at, Number(r.rejected_before) > 0, Number(r.removed_before) > 0].filter(Boolean).length;

export type Warning = { tone: "bad" | "warn" | "info"; text: string; href?: string; linkLabel?: string };

const KYC_WORD: Record<string, string> = { pending: "waiting for review", approved: "verified", rejected: "rejected" };
const kycWord = (s: string | null) => (s ? (KYC_WORD[s] ?? s) : "not sent");
const longDate = (d: Date | null) => (d ?? new Date()).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

interface OtherClient {
  id: number;
  first_name: string;
  last_name: string;
  assigned_staff_id: number | null;
}

/** The applicant's sign-up, sign-in and application IP addresses (staff view-only sessions are not the client's). */
async function addressesOf(conn: Conn, r: ReviewRow) {
  const sessions = await rows<{ ip: string }>(conn, "SELECT DISTINCT ip FROM client_sessions WHERE client_id = ? AND kind = 'login' ORDER BY ip LIMIT 200", [r.client_id]);
  return [...new Set([r.created_ip, r.last_login_ip, r.submitted_ip, ...sessions.map((s) => s.ip)].filter((ip): ip is string => Boolean(ip)))];
}

/** Clients (from `among`) that signed up or signed in from one of these addresses. */
const sharingIps = (marks: string) =>
  `(c2.created_ip IN (${marks}) OR c2.last_login_ip IN (${marks})
    OR EXISTS (SELECT 1 FROM client_sessions s2 WHERE s2.client_id = c2.id AND s2.kind = 'login' AND s2.ip IN (${marks})))`;

/**
 * The review screen's warnings, worst first. Another client is named and
 * linked only when the reviewer may see them; otherwise one unnamed line.
 * Money and trading facts are mentioned only to staff who may see them.
 */
export async function warningsFor(conn: Conn, staff: StaffContext, r: ReviewRow): Promise<Warning[]> {
  const out: Warning[] = [];
  if (r.kyc_status !== "approved") {
    out.push({ tone: "bad", text: `KYC is not complete: identity is ${kycWord(r.kyc_identity)} and address is ${kycWord(r.kyc_address)}.` });
  }
  if (r.client_status === "frozen") out.push({ tone: "bad", text: "This account is frozen." });
  if (r.client_status === "closed") out.push({ tone: "bad", text: "This account is closed." });

  const ips = await addressesOf(conn, r);
  if (ips.length) {
    const marks = ips.map(() => "?").join(",");
    const ipParams = [...ips, ...ips, ...ips];
    // Self-referral: clients this applicant referred who use the applicant's own connection.
    const referred = await rows<OtherClient>(
      conn,
      `SELECT c2.id, c2.first_name, c2.last_name, c2.assigned_staff_id FROM clients c2 WHERE c2.referred_by = ? AND ${sharingIps(marks)} ORDER BY c2.id LIMIT 50`,
      [r.client_id, ...ipParams],
    );
    const shown = referred.filter((o) => inScope(staff, o.assigned_staff_id));
    for (const o of shown.slice(0, 5)) {
      out.push({ tone: "warn", text: `${o.first_name} ${o.last_name} (client ${o.id}), whom this client referred, signed up or signed in from this client's IP address.`, href: `/clients/${o.id}`, linkLabel: "Open client" });
    }
    const unnamed = referred.length - Math.min(shown.length, 5);
    if (unnamed > 0) out.push({ tone: "warn", text: `${unnamed} other ${plural(unnamed, "client", "clients")} signed up or signed in from this client's IP addresses.` });
    // Another IB on the same connection: the same person may be applying twice.
    const ibs = await rows<OtherClient>(
      conn,
      `SELECT c2.id, c2.first_name, c2.last_name, c2.assigned_staff_id FROM ib_partners p JOIN clients c2 ON c2.id = p.client_id
       WHERE p.status = 'active' AND c2.status <> 'closed' AND c2.id <> ? AND ${sharingIps(marks)} ORDER BY c2.id LIMIT 20`,
      [r.client_id, ...ipParams],
    );
    const named = ibs.filter((o) => inScope(staff, o.assigned_staff_id));
    for (const o of named.slice(0, 3)) {
      out.push({ tone: "warn", text: `${o.first_name} ${o.last_name} (client ${o.id}) is an IB and shares an IP address with this client.`, href: `/clients/${o.id}`, linkLabel: "Open client" });
    }
    if (ibs.length > named.slice(0, 3).length) out.push({ tone: "warn", text: `${named.length ? "Another" : "An existing"} IB shares an IP address with this client.` });
  }

  // The same person on another account: same date of birth and the same name (the KYC check).
  if (r.dob) {
    const fullName = `${r.first_name} ${r.last_name}`.toLowerCase().replace(/\s+/g, " ").trim();
    const twins = await rows<OtherClient & { status: string }>(
      conn,
      `SELECT id, first_name, last_name, status, assigned_staff_id FROM clients
       WHERE id <> ? AND dob = ? AND REGEXP_REPLACE(LOWER(TRIM(CONCAT(first_name, ' ', last_name))), '[[:space:]]+', ' ') = ? ORDER BY id LIMIT 5`,
      [r.client_id, r.dob, fullName],
    );
    for (const t of twins.filter((t) => inScope(staff, t.assigned_staff_id))) {
      out.push({
        tone: "warn",
        text: `The same person may have another account: ${t.first_name} ${t.last_name} (client ${t.id}${t.status === "active" ? "" : `, ${t.status}`}) has the same name and date of birth.`,
        href: `/clients/${t.id}`,
        linkLabel: "Open client",
      });
    }
    if (twins.some((t) => !inScope(staff, t.assigned_staff_id))) out.push({ tone: "warn", text: "The same person may have another account: another client has the same name and date of birth." });
  }

  const earlier = await rows<{ status: ApplicationStatus; removed_at: Date | null; reject_reason: string | null }>(
    conn,
    "SELECT status, removed_at, reject_reason FROM ib_applications WHERE client_id = ? AND id < ? AND status IN ('rejected', 'removed') ORDER BY id DESC LIMIT 20",
    [r.client_id, r.id],
  );
  const removed = earlier.find((e) => e.status === "removed");
  if (removed) out.push({ tone: "warn", text: `This client was an IB before. Their IB status was removed on ${longDate(removed.removed_at)}${removed.reject_reason ? `: ${removed.reject_reason}` : "."}` });
  const rejected = earlier.filter((e) => e.status === "rejected").length;
  if (rejected) out.push({ tone: "warn", text: `${rejected} earlier IB ${plural(rejected, "application was", "applications were")} rejected.` });
  if (!r.email_verified_at) out.push({ tone: "warn", text: "The client has not verified their email address." });

  if (staff.permissions.has("deposit.view")) {
    const funded = await one<{ ok: number }>(conn, "SELECT 1 AS ok FROM deposits WHERE client_id = ? AND status = 'approved' LIMIT 1", [r.client_id]);
    if (!funded) out.push({ tone: "info", text: "The client has no approved deposits yet." });
  }
  if (staff.permissions.has("mt5.view")) {
    const traded = await one<{ ok: number }>(
      conn,
      "SELECT 1 AS ok FROM mt5_trades t JOIN mt5_accounts m ON m.id = t.mt5_account_id WHERE t.client_id = ? AND m.is_demo = 0 LIMIT 1",
      [r.client_id],
    );
    if (!traded) out.push({ tone: "info", text: "The client has not traded on a live MT5 account yet." });
  }
  if (r.client_created_at.getTime() > Date.now() - 7 * 86_400_000) out.push({ tone: "info", text: "The account was opened less than 7 days ago." });
  if (r.referred_by) {
    const sponsor = await one<OtherClient>(
      conn,
      `SELECT c2.id, c2.first_name, c2.last_name, c2.assigned_staff_id FROM ib_partners p JOIN clients c2 ON c2.id = p.client_id
       WHERE p.client_id = ? AND p.status = 'active' AND c2.status <> 'closed'`,
      [r.referred_by],
    );
    if (sponsor && r.status === "pending") {
      out.push({
        tone: "info",
        text: `Approving makes this client a sub-IB in the network of ${sponsor.first_name} ${sponsor.last_name} (client ${sponsor.id}).`,
        ...(inScope(staff, sponsor.assigned_staff_id) ? { href: `/clients/${sponsor.id}`, linkLabel: "Open sponsor" } : {}),
      });
    }
  }
  const order = { bad: 0, warn: 1, info: 2 };
  return out.sort((a, b) => order[a.tone] - order[b.tone]);
}

// ---------- Telling the client ----------

type Decision = { kind: "approved" } | { kind: "rejected"; reason: string } | { kind: "removed"; reason: string };

/** The bell notification and the email for a decision, in the caller's transaction. The support service gets no IB event. */
export async function tellClient(conn: Conn, config: Config, client: { id: number; email: string; first_name: string }, d: Decision) {
  const hello = `Hello ${client.first_name},\n\n`;
  if (d.kind === "approved") {
    const title = "Your IB application is approved";
    await notifyClient(conn, client.id, {
      type: "ib", title, body: "You are now a BIS Markets Introducing Broker. Open your IB Dashboard to get your referral link.", link: "/ib-dashboard", linkLabel: "Open IB Dashboard",
    });
    await queueEmail(conn, config, {
      to: client.email, template: "ib_approved", subject: title, clientId: client.id,
      text: `${hello}You are now a BIS Markets Introducing Broker.\n\nOpen your IB Dashboard in the client portal to get your referral link and follow your network: ${config.portalUrl}/ib-dashboard\n\nBIS Markets`,
    });
    return;
  }
  if (d.kind === "rejected") {
    const title = "Your IB application was not approved";
    await notifyClient(conn, client.id, { type: "ib", title, body: d.reason, link: "/become-ib", linkLabel: "View application" });
    await queueEmail(conn, config, {
      to: client.email, template: "ib_rejected", subject: title, clientId: client.id,
      text: `${hello}We could not approve your application to become a BIS Markets Introducing Broker.\n\nReason: ${d.reason}\n\nYou can see your application in the client portal: ${config.portalUrl}/become-ib\n\nBIS Markets`,
    });
    return;
  }
  const title = "Your IB partnership has ended";
  await notifyClient(conn, client.id, { type: "ib", title, body: d.reason, link: "/become-ib", linkLabel: "View details" });
  await queueEmail(conn, config, {
    to: client.email, template: "ib_removed", subject: title, clientId: client.id,
    text: `${hello}Your BIS Markets Introducing Broker partnership has ended.\n\nReason: ${d.reason}\n\nIf you have any questions, please contact support. You can see the details in the client portal: ${config.portalUrl}/become-ib\n\nBIS Markets`,
  });
}
