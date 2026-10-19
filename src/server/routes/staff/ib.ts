import { Router, type Request } from "express";
import { z } from "zod";
import type { Permission } from "@shared/permissions";
import type { AppDeps } from "../../app";
import { lockClient } from "../../clients/kyc";
import { clientPictureUrl } from "../../clients/model";
import { auditContext, writeAudit } from "../../lib/audit";
import { exec, one, rows, transaction, type Conn } from "../../lib/db";
import { badRequest, conflict, handler, notFound, parse } from "../../lib/http";
import { likeTerm, listQuery, toPage } from "../../lib/pagination";
import { activeClaim, claim, CLAIM_MINUTES, release } from "../../lib/review";
import { appendNote, checklistOf, clientScope, internalNote, moneyId, reasonText } from "../../money/review";
import { loadTiers, partnerOf } from "../../ib/model";
import { activePartnersAmong, approvedDeposits, directReferralCounts, networkOf, TtlCache, usd, type Member } from "../../ib/network";
import {
  blockOf, can, IB_CHECKLIST, IB_REJECT_REASONS, IB_REMOVE_REASONS, NOT_FOUND, NOT_SET_UP_BY, REVIEW_SELECT, tellClient, verifiedName, warningCount, warningsFor, type ReviewRow,
} from "../../ib/review";
import { requirePermission, requireStepUp, staffActor, staffOf, type StaffContext } from "../../staff/session";

// The decision history shown with an application, from the audit log. Opening it is audited too, but not listed.
const TRAIL: Record<string, string> = {
  "ib.applied": "Sent by the client",
  "ib.approved": "Approved",
  "ib.rejected": "Rejected",
  "ib.removed": "IB status removed",
  "ib.review_taken_over": "Review taken over",
};
const text = (v: unknown) => (typeof v === "string" && v ? v : null);
const person = (staffId: number | null, name: string | null) => (staffId ? { id: staffId, name: name ?? "Staff" } : null);
const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;
const STATUSES = ["pending", "approved", "rejected", "removed", "all"] as const;

const approveBody = z.object({ checklist: checklistOf(IB_CHECKLIST.review), note: internalNote, tierId: moneyId.optional() }).strict();
const reasonBody = z.object({ reason: reasonText, note: internalNote }).strict();

/** The IB application queue (claim, approve, reject, remove IB status) and the list of IB partners. */
export function staffIbRouter(deps: AppDeps): Router {
  const { db, config, log } = deps;
  const router = Router();
  const stepUp = requireStepUp(config);
  const ctx = (req: Request) => auditContext(req, staffActor(staffOf(req)));
  const view = requirePermission("ib.view");
  const decide = requirePermission("ib.view", "ib.decide");
  // Network sizes for the partners list, which would otherwise walk every partner's network on every page.
  const networks = new TtlCache<Member[]>(60_000);
  const networkFor = (clientId: number) => networks.get(String(clientId), () => networkOf(db, clientId, log));

  async function loadVisible(req: Request, applicationId: number, conn: Conn = db, lock = false) {
    const s = clientScope(staffOf(req));
    const row = await one<ReviewRow>(conn, `${REVIEW_SELECT} WHERE a.id = ?${s.sql}${lock ? " FOR UPDATE OF a" : ""}`, [applicationId, ...s.params]);
    if (!row) throw notFound(NOT_FOUND);
    return row;
  }

  /**
   * Decisions lock the client row, then the application, like every other
   * review. The client id is read first, through a scoped query, before the
   * transaction starts (it never changes): nobody takes locks on a client they
   * may not see, and the transaction never waits for a second connection.
   */
  async function clientOfApplication(req: Request, applicationId: number) {
    const s = clientScope(staffOf(req));
    const ref = await one<{ client_id: number }>(db, `SELECT a.client_id FROM ib_applications a JOIN clients c ON c.id = a.client_id WHERE a.id = ?${s.sql}`, [applicationId, ...s.params]);
    if (!ref) throw notFound(NOT_FOUND);
    return ref.client_id;
  }

  async function lockApplication(conn: Conn, req: Request, applicationId: number, clientId: number) {
    await lockClient(conn, clientId);
    return loadVisible(req, applicationId, conn, true);
  }

  const presentRow = (r: ReviewRow) => ({
    id: r.id,
    status: r.status,
    submittedAt: r.submitted_at.toISOString(),
    decidedAt: iso(r.decided_at),
    client: {
      id: r.client_id, name: verifiedName(r), email: r.email, avatarUrl: clientPictureUrl("", r.client_id, r.picture_sha), country: r.country, status: r.client_status,
    },
    kyc: { identity: r.kyc_identity ?? "none", address: r.kyc_address ?? "none" },
    referredClients: Number(r.referred_clients),
    claimedBy: activeClaim(r) ? { id: r.claimed_by!, name: r.claimer_name ?? "Staff", until: r.claimed_until!.toISOString() } : null,
    decidedBy: person(r.decided_by, r.decider_name),
    removedAt: iso(r.removed_at),
    removedBy: person(r.removed_by, r.remover_name),
    warningCount: warningCount(r),
  });

  /** Waiting applications in the reviewer's scope (accounts not closed, plus this one), and where this one stands among them. */
  async function queueOf(staff: StaffContext, r: ReviewRow) {
    const s = clientScope(staff);
    const q = await one<{ pending: number; ahead: string | null }>(
      db,
      `SELECT COUNT(*) AS pending, SUM(a.submitted_at < ? OR (a.submitted_at = ? AND a.id < ?)) AS ahead FROM ib_applications a JOIN clients c ON c.id = a.client_id
       WHERE a.status = 'pending' AND (c.status <> 'closed' OR a.id = ?)${s.sql}`,
      [r.submitted_at, r.submitted_at, r.id, r.id, ...s.params],
    );
    return { pending: Number(q?.pending ?? 0), position: r.status === "pending" ? Number(q?.ahead ?? 0) + 1 : null };
  }

  /** The review screen's view of one application. Writes nothing. */
  async function detailOf(req: Request, applicationId: number) {
    const staff = staffOf(req);
    const has = (p: Permission) => staff.permissions.has(p);
    const r = await loadVisible(req, applicationId);
    const tiers = await loadTiers(db);
    const partner = await partnerOf(db, r.client_id);
    const partnerActive = partner?.status === "active" && Number(partner.application_id) === r.id;
    const members = await networkOf(db, r.client_id, log);
    const direct = members.filter((m) => m.level === 1).map((m) => m.id);
    const directDeposits = await approvedDeposits(db, direct);
    const own = (await approvedDeposits(db, [r.client_id])).get(r.client_id);
    const paid = has("withdrawal.view")
      ? await one<{ n: number; cents: string | null }>(db, "SELECT COUNT(*) AS n, SUM(amount_cents) AS cents FROM withdrawals WHERE client_id = ? AND status = 'paid'", [r.client_id])
      : undefined;
    const wallet = has("wallet.view") ? await one<{ available_cents: number }>(db, "SELECT available_cents FROM wallets WHERE client_id = ? AND currency = 'USD'", [r.client_id]) : undefined;
    const mt5 = has("mt5.view")
      ? await one<{ accounts: number; volume: string | null }>(
          db,
          `SELECT (SELECT COUNT(*) FROM mt5_accounts WHERE client_id = ? AND is_demo = 0 AND status = 'active') AS accounts,
                  (SELECT SUM(t.volume) FROM mt5_trades t JOIN mt5_accounts m ON m.id = t.mt5_account_id WHERE t.client_id = ? AND m.is_demo = 0) AS volume`,
          [r.client_id, r.client_id],
        )
      : undefined;
    const sponsor = r.referred_by
      ? await one<{ id: number; first_name: string; last_name: string }>(db, "SELECT id, first_name, last_name FROM clients WHERE id = ?", [r.referred_by])
      : undefined;
    const sponsorIsIb = sponsor ? (await activePartnersAmong(db, [sponsor.id])).has(sponsor.id) : false;
    const earlier = await rows<{ id: number; status: ReviewRow["status"]; submitted_at: Date; decided_at: Date | null; removed_at: Date | null; reject_reason: string | null }>(
      db, "SELECT id, status, submitted_at, decided_at, removed_at, reject_reason FROM ib_applications WHERE client_id = ? AND id <> ? ORDER BY id DESC LIMIT 20", [r.client_id, r.id],
    );
    const remover = partner?.removed_by ? await one<{ name: string }>(db, "SELECT name FROM staff_users WHERE id = ?", [partner.removed_by]) : undefined;
    const trailRows = await rows<{ occurred_at: Date; action: string; actor_type: string; staff_name: string | null; meta_json: Record<string, unknown> | null }>(
      db,
      `SELECT a.occurred_at, a.action, a.actor_type, u.name AS staff_name, a.meta_json FROM audit_log a LEFT JOIN staff_users u ON a.actor_type = 'staff' AND u.id = a.actor_id
       WHERE a.entity_type = 'client' AND a.entity_id = ? AND a.action IN (${Object.keys(TRAIL).map(() => "?").join(",")}) AND a.meta_json->'$.applicationId' = ? ORDER BY a.id`,
      [String(r.client_id), ...Object.keys(TRAIL), r.id],
    );
    const assigned = person(r.assigned_staff_id, r.assigned_name);
    return {
      id: r.id,
      status: r.status,
      stage: r.status === "pending" ? ("review" as const) : null,
      submittedAt: r.submitted_at.toISOString(),
      decidedAt: iso(r.decided_at),
      decidedBy: person(r.decided_by, r.decider_name),
      rejectReason: r.reject_reason,
      removedAt: iso(r.removed_at),
      removedBy: person(r.removed_by, r.remover_name),
      termsVersion: r.terms_version,
      submittedIp: r.submitted_ip,
      submittedUserAgent: r.submitted_user_agent,
      tierId: r.tier_id,
      checked: r.checklist ?? null,
      client: {
        id: r.client_id,
        name: verifiedName(r),
        verifiedName: verifiedName(r),
        email: r.email,
        avatarUrl: clientPictureUrl("", r.client_id, r.picture_sha),
        status: r.client_status,
        kycStatus: r.kyc_status,
        country: r.country,
        joinedAt: r.client_created_at.toISOString(),
        assignedTo: assigned,
        emailVerified: r.email_verified_at !== null,
      },
      // Money and trading facts only for staff who may see them; the screen says so for a null block.
      facts: {
        kyc: { identity: r.kyc_identity ?? "none", address: r.kyc_address ?? "none" },
        deposits: has("deposit.view") ? { count: own?.count ?? 0, totalUsd: usd(own?.cents ?? 0), firstAt: iso(own?.firstAt) } : null,
        withdrawals: paid ? { count: Number(paid.n), totalUsd: usd(Number(paid.cents ?? 0)) } : null,
        wallet: has("wallet.view") ? { availableUsd: usd(Number(wallet?.available_cents ?? 0)) } : null,
        mt5: mt5 ? { liveAccounts: Number(mt5.accounts), lots: Math.round(Number(mt5.volume ?? 0) / 100) / 100 } : null,
        referrals: {
          direct: direct.length,
          funded: direct.filter((id) => (directDeposits.get(id)?.count ?? 0) > 0).length,
          network: members.length,
          depositsUsd: has("deposit.view") ? usd(direct.reduce((t, id) => t + (directDeposits.get(id)?.cents ?? 0), 0)) : null,
        },
        sponsor: sponsor ? { id: sponsor.id, name: `${sponsor.first_name} ${sponsor.last_name}`.trim(), isIb: sponsorIsIb } : null,
      },
      earlier: earlier.map((e) => ({
        id: e.id, status: e.status, newer: e.id > r.id, submittedAt: e.submitted_at.toISOString(), decidedAt: iso(e.status === "removed" ? e.removed_at : e.decided_at), reason: e.reject_reason,
      })),
      // The client's current partnership, which may come from a newer application than this one.
      partner: partner
        ? {
            status: partner.status, applicationId: Number(partner.application_id), tier: partner.tier_name, tierId: partner.tier_id, approvedAt: partner.approved_at.toISOString(),
            removedAt: iso(partner.removed_at), removedReason: partner.removed_reason, removedBy: person(partner.removed_by, remover?.name ?? null),
          }
        : null,
      warnings: await warningsFor(db, staff, r),
      checklist: { review: IB_CHECKLIST.review },
      rejectReasons: IB_REJECT_REASONS,
      removeReasons: IB_REMOVE_REASONS,
      tiers: tiers.map((t) => ({ id: t.id, name: t.name, position: t.position })),
      defaultTierId: tiers[0]?.id ?? null,
      can: { approve: can(staff, r, "approve"), reject: can(staff, r, "reject"), remove: can(staff, r, "remove", partnerActive) },
      claimedBy: presentRow(r).claimedBy,
      claimMinutes: CLAIM_MINUTES,
      queue: await queueOf(staff, r),
      notes: (r.notes ?? []).map((n) => ({ at: n.at, byName: n.byName, stage: n.stage, text: n.text })),
      trail: trailRows.map((a) => {
        const meta = a.meta_json ?? {};
        return {
          at: a.occurred_at.toISOString(),
          action: a.action.replace(/^ib\./, ""),
          label: TRAIL[a.action]!,
          staff: a.actor_type === "staff" ? (a.staff_name ?? "Staff") : null,
          reason: text(meta.reason),
          internalNote: text(meta.internalNote),
        };
      }),
    };
  }

  // ---------- Queue ----------

  router.get(
    "/applications",
    view,
    handler(async (req, res) => {
      const blank = z.literal("").transform(() => undefined);
      const query = parse(
        listQuery(["submitted_at", "decided_at"], "submitted_at").extend({
          status: z.enum(STATUSES).default("pending"),
          clientId: moneyId.optional().or(blank),
          includeClosed: z.enum(["0", "1"]).optional().or(blank),
        }),
        req.query,
      );
      const where = ["1 = 1"];
      const params: unknown[] = [];
      const s = clientScope(staffOf(req));
      if (s.sql) (where.push("c.assigned_staff_id = ?"), params.push(...s.params));
      if (query.status !== "all") (where.push("a.status = ?"), params.push(query.status));
      // Waiting applications of closed accounts are left out unless asked for: nothing can be approved there.
      if (query.status === "pending" && query.includeClosed !== "1") where.push("c.status <> 'closed'");
      if (query.clientId) (where.push("a.client_id = ?"), params.push(query.clientId));
      if (query.q) {
        const asId = /^\d{1,12}$/.test(query.q) ? Number(query.q) : 0;
        where.push("(a.id = ? OR c.id = ? OR c.email LIKE ? OR CONCAT(c.first_name, ' ', c.last_name) LIKE ? OR c.referral_code = ?)");
        params.push(asId, asId, likeTerm(query.q), likeTerm(query.q), query.q.toUpperCase());
      }
      const clause = ` WHERE ${where.join(" AND ")}`;
      // Oldest first while waiting, so nobody waits longest.
      const dir = query.status === "pending" && !req.query.dir ? "ASC" : query.dir === "asc" ? "ASC" : "DESC";
      const total = await one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ib_applications a JOIN clients c ON c.id = a.client_id${clause}`, params);
      const items = await rows<ReviewRow>(db, `${REVIEW_SELECT}${clause} ORDER BY a.${query.sort} ${dir}, a.id ${dir} LIMIT ? OFFSET ?`, [...params, query.pageSize, (query.page - 1) * query.pageSize]);
      res.json(toPage(items.map(presentRow), Number(total?.n ?? 0), query.page, query.pageSize));
    }),
  );

  router.get(
    "/applications/summary",
    view,
    handler(async (req, res) => {
      const staff = staffOf(req);
      const s = clientScope(staff);
      const r = await one<{ pending: string | null; overdue: string | null; oldest: Date | null; today: string | null; mine: string | null }>(
        db,
        `SELECT SUM(a.status = 'pending' AND c.status <> 'closed') AS pending,
           SUM(a.status = 'pending' AND c.status <> 'closed' AND a.submitted_at < CURRENT_TIMESTAMP(3) - INTERVAL 24 HOUR) AS overdue,
           MIN(IF(a.status = 'pending' AND c.status <> 'closed', a.submitted_at, NULL)) AS oldest,
           SUM(a.status IN ('approved', 'rejected', 'removed') AND a.decided_at >= CURRENT_DATE) AS today,
           SUM(a.status IN ('approved', 'rejected', 'removed') AND a.decided_at >= CURRENT_DATE AND a.decided_by = ?) AS mine
         FROM ib_applications a JOIN clients c ON c.id = a.client_id
         WHERE (a.status = 'pending' OR a.decided_at >= CURRENT_DATE)${s.sql}`,
        [staff.id, ...s.params],
      );
      // What `next` would hand this person now: in scope, not closed, not held by someone else, and not set up by them.
      const forMe = staff.permissions.has("ib.decide")
        ? await one<{ n: number }>(
            db,
            `SELECT COUNT(*) AS n FROM ib_applications a JOIN clients c ON c.id = a.client_id
             WHERE a.status = 'pending' AND c.status <> 'closed' AND (a.claimed_by IS NULL OR a.claimed_until < CURRENT_TIMESTAMP(3) OR a.claimed_by = ?)
               AND ${NOT_SET_UP_BY}${s.sql}`,
            [staff.id, staff.id, staff.id, staff.id, ...s.params],
          )
        : undefined;
      res.json({
        pending: Number(r?.pending ?? 0),
        overdue: Number(r?.overdue ?? 0),
        oldestPendingAt: iso(r?.oldest),
        decidedToday: Number(r?.today ?? 0),
        decidedTodayByMe: Number(r?.mine ?? 0),
        forMe: Number(forMe?.n ?? 0),
      });
    }),
  );

  // "Start reviewing" and "next": claims the oldest waiting application this person may decide.
  router.post(
    "/applications/next",
    decide,
    handler(async (req, res) => {
      // IB applications have one step; `stage` is accepted so the shared queue screen can always send it.
      const body = parse(z.object({ skip: z.array(moneyId).max(200).default([]), release: moneyId.optional(), stage: z.literal("review").optional() }).strict(), req.body ?? {});
      const staff = staffOf(req);
      const next = await transaction(db, async (conn) => {
        if (body.release) await release(conn, "ib_applications", body.release, staff.id);
        const where = [
          "a.status = 'pending'", "c.status <> 'closed'", "(a.claimed_by IS NULL OR a.claimed_until < CURRENT_TIMESTAMP(3) OR a.claimed_by = ?)", NOT_SET_UP_BY,
        ];
        const params: unknown[] = [staff.id, staff.id, staff.id, staff.id];
        const s = clientScope(staff);
        if (s.sql) (where.push("c.assigned_staff_id = ?"), params.push(...s.params));
        if (body.skip.length) (where.push(`a.id NOT IN (${body.skip.map(() => "?").join(",")})`), params.push(...body.skip));
        const row = await one<{ id: number }>(
          conn,
          `SELECT a.id FROM ib_applications a JOIN clients c ON c.id = a.client_id WHERE ${where.join(" AND ")} ORDER BY a.submitted_at, a.id LIMIT 1 FOR UPDATE OF a SKIP LOCKED`,
          params,
        );
        if (!row) return null;
        await claim(conn, "ib_applications", row.id, staff.id);
        return row.id;
      });
      res.json({ id: next });
    }),
  );

  router.post(
    "/applications/:id/claim",
    decide,
    handler(async (req, res) => {
      const body = parse(z.object({ takeOver: z.boolean().default(false) }).strict(), req.body ?? {});
      const staff = staffOf(req);
      const applicationId = parse(moneyId, req.params.id);
      const clientId = await clientOfApplication(req, applicationId);
      const row = await transaction(db, async (conn) => {
        const r = await lockApplication(conn, req, applicationId, clientId);
        const { tookOverFrom } = await claim(conn, "ib_applications", r.id, staff.id, body.takeOver);
        if (tookOverFrom) {
          await writeAudit(conn, ctx(req), { action: "ib.review_taken_over", entityType: "client", entityId: r.client_id, meta: { applicationId: r.id, from: tookOverFrom } });
        }
        return loadVisible(req, r.id, conn);
      });
      res.json({ claimedBy: presentRow(row).claimedBy, minutes: CLAIM_MINUTES });
    }),
  );

  router.post(
    "/applications/:id/release",
    decide,
    handler(async (req, res) => {
      const r = await loadVisible(req, parse(moneyId, req.params.id));
      await release(db, "ib_applications", r.id, staffOf(req).id);
      res.json({ ok: true });
    }),
  );

  router.get(
    "/applications/:id",
    view,
    handler(async (req, res) => {
      const out = await detailOf(req, parse(moneyId, req.params.id));
      await transaction(db, (conn) =>
        writeAudit(conn, ctx(req), { action: "ib.application_viewed", entityType: "client", entityId: out.client.id, meta: { applicationId: out.id } }),
      );
      res.json(out);
    }),
  );

  // ---------- Decisions ----------

  router.post(
    "/applications/:id/approve",
    decide,
    stepUp,
    handler(async (req, res) => {
      const body = parse(approveBody, req.body ?? {});
      const staff = staffOf(req);
      const applicationId = parse(moneyId, req.params.id);
      const clientId = await clientOfApplication(req, applicationId);
      await transaction(db, async (conn) => {
        const r = await lockApplication(conn, req, applicationId, clientId);
        const block = blockOf(staff, r, "approve");
        if (block) throw block;
        const tiers = await loadTiers(conn);
        const tier = body.tierId === undefined ? tiers[0] : tiers.find((t) => t.id === body.tierId);
        if (!tier) throw badRequest("Check the highlighted fields.", [{ field: "tierId", message: "Choose an IB level from the list." }]);
        // What the reviewer was warned about, as it stands now, kept with the decision.
        const warnings = (await warningsFor(conn, staff, r)).filter((w) => w.tone !== "info").map((w) => w.text);
        const done = await exec(
          conn,
          `UPDATE ib_applications SET status = 'approved', decided_by = ?, decided_at = CURRENT_TIMESTAMP(3), checklist = ?, tier_id = ?, claimed_by = NULL, claimed_until = NULL
           WHERE id = ? AND status = 'pending'`,
          [staff.id, JSON.stringify(body.checklist), tier.id, r.id],
        );
        if (done.affectedRows !== 1) throw conflict("This application changed while you were approving it. Reload it.");
        // A client approved again after a removal keeps the one partnership row, active again.
        await exec(
          conn,
          `INSERT INTO ib_partners (client_id, status, application_id, tier_id, approved_at, approved_by) VALUES (?, 'active', ?, ?, CURRENT_TIMESTAMP(3), ?)
           ON DUPLICATE KEY UPDATE status = 'active', application_id = VALUES(application_id), tier_id = VALUES(tier_id), approved_at = VALUES(approved_at),
             approved_by = VALUES(approved_by), removed_at = NULL, removed_by = NULL, removed_reason = NULL`,
          [r.client_id, r.id, tier.id, staff.id],
        );
        await appendNote(conn, "ib_applications", r.id, staff, "approved", body.note);
        await writeAudit(conn, ctx(req), {
          action: "ib.approved", entityType: "client", entityId: r.client_id,
          before: { status: "pending" }, after: { status: "approved", tier: tier.name },
          meta: { applicationId: r.id, tier: { id: tier.id, name: tier.name }, checklist: body.checklist, warnings, ...(body.note ? { internalNote: body.note } : {}) },
        });
        await tellClient(conn, config, { id: r.client_id, email: r.email, first_name: r.first_name }, { kind: "approved" });
      });
      res.json(await detailOf(req, applicationId));
    }),
  );

  // Rejecting is allowed for frozen accounts and without verified KYC; not for a closed account.
  router.post(
    "/applications/:id/reject",
    decide,
    stepUp,
    handler(async (req, res) => {
      const body = parse(reasonBody, req.body ?? {});
      const staff = staffOf(req);
      const applicationId = parse(moneyId, req.params.id);
      const clientId = await clientOfApplication(req, applicationId);
      await transaction(db, async (conn) => {
        const r = await lockApplication(conn, req, applicationId, clientId);
        const block = blockOf(staff, r, "reject");
        if (block) throw block;
        const done = await exec(
          conn,
          `UPDATE ib_applications SET status = 'rejected', reject_reason = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP(3), claimed_by = NULL, claimed_until = NULL
           WHERE id = ? AND status = 'pending'`,
          [body.reason, staff.id, r.id],
        );
        if (done.affectedRows !== 1) throw conflict("This application changed while you were rejecting it. Reload it.");
        await appendNote(conn, "ib_applications", r.id, staff, "rejected", body.note);
        await writeAudit(conn, ctx(req), {
          action: "ib.rejected", entityType: "client", entityId: r.client_id,
          before: { status: "pending" }, after: { status: "rejected" },
          meta: { applicationId: r.id, reason: body.reason, ...(body.note ? { internalNote: body.note } : {}) },
        });
        await tellClient(conn, config, { id: r.client_id, email: r.email, first_name: r.first_name }, { kind: "rejected", reason: body.reason });
      });
      res.json(await detailOf(req, applicationId));
    }),
  );

  // Ends an approved partnership, whatever the account's state. The client sees "rejected" with the reason and may apply again.
  router.post(
    "/applications/:id/remove",
    decide,
    stepUp,
    handler(async (req, res) => {
      const body = parse(reasonBody, req.body ?? {});
      const staff = staffOf(req);
      const applicationId = parse(moneyId, req.params.id);
      const clientId = await clientOfApplication(req, applicationId);
      await transaction(db, async (conn) => {
        const r = await lockApplication(conn, req, applicationId, clientId);
        // Every change to a partnership holds the client lock taken above, so a plain read is current.
        const partner = await partnerOf(conn, r.client_id);
        const block = blockOf(staff, r, "remove", partner?.status === "active" && Number(partner.application_id) === r.id);
        if (block) throw block;
        const done = await exec(
          conn,
          "UPDATE ib_applications SET status = 'removed', removed_at = CURRENT_TIMESTAMP(3), removed_by = ?, reject_reason = ? WHERE id = ? AND status = 'approved'",
          [staff.id, body.reason, r.id],
        );
        if (done.affectedRows !== 1) throw conflict("This application changed while you were removing the IB status. Reload it.");
        await exec(
          conn,
          "UPDATE ib_partners SET status = 'removed', removed_at = CURRENT_TIMESTAMP(3), removed_by = ?, removed_reason = ? WHERE client_id = ? AND status = 'active'",
          [staff.id, body.reason, r.client_id],
        );
        await appendNote(conn, "ib_applications", r.id, staff, "removed", body.note);
        await writeAudit(conn, ctx(req), {
          action: "ib.removed", entityType: "client", entityId: r.client_id,
          before: { status: "approved", tier: partner!.tier_name }, after: { status: "removed" },
          meta: { applicationId: r.id, tier: { id: partner!.tier_id, name: partner!.tier_name }, reason: body.reason, ...(body.note ? { internalNote: body.note } : {}) },
        });
        await tellClient(conn, config, { id: r.client_id, email: r.email, first_name: r.first_name }, { kind: "removed", reason: body.reason });
      });
      res.json(await detailOf(req, applicationId));
    }),
  );

  // ---------- Partners ----------

  const PARTNER_SORT = { approved_at: "p.approved_at", name: "c.last_name" } as const;

  router.get(
    "/partners",
    view,
    handler(async (req, res) => {
      const staff = staffOf(req);
      const query = parse(listQuery(["approved_at", "name"], "approved_at").extend({ status: z.enum(["active", "removed", "all"]).default("active") }), req.query);
      const where = ["1 = 1"];
      const params: unknown[] = [];
      const s = clientScope(staff);
      if (s.sql) (where.push("c.assigned_staff_id = ?"), params.push(...s.params));
      if (query.status !== "all") (where.push("p.status = ?"), params.push(query.status));
      if (query.q) {
        const asId = /^\d{1,12}$/.test(query.q) ? Number(query.q) : 0;
        where.push("(c.id = ? OR c.email LIKE ? OR CONCAT(c.first_name, ' ', c.last_name) LIKE ? OR c.referral_code = ?)");
        params.push(asId, likeTerm(query.q), likeTerm(query.q), query.q.toUpperCase());
      }
      const clause = ` WHERE ${where.join(" AND ")}`;
      const from = "FROM ib_partners p JOIN clients c ON c.id = p.client_id JOIN ib_tiers t ON t.id = p.tier_id";
      const total = await one<{ n: number }>(db, `SELECT COUNT(*) AS n ${from}${clause}`, params);
      const list = await rows<{
        client_id: number; status: "active" | "removed"; application_id: number; tier_name: string; approved_at: Date; approved_by: number | null; approver_name: string | null;
        removed_at: Date | null; removed_by: number | null; remover_name: string | null; removed_reason: string | null;
        first_name: string; last_name: string; email: string; referral_code: string; client_status: string; referred_by: number | null; picture_sha: string | null;
      }>(
        db,
        `SELECT p.client_id, p.status, p.application_id, t.name AS tier_name, p.approved_at, p.approved_by, ap.name AS approver_name, p.removed_at, p.removed_by, rm.name AS remover_name,
           p.removed_reason, c.first_name, c.last_name, c.email, c.referral_code, c.status AS client_status, c.referred_by, pp.sha256 AS picture_sha
         ${from} LEFT JOIN staff_users ap ON ap.id = p.approved_by LEFT JOIN staff_users rm ON rm.id = p.removed_by
         LEFT JOIN profile_pictures pp ON pp.owner_type = 'client' AND pp.owner_id = c.id
         ${clause} ORDER BY ${PARTNER_SORT[query.sort]} ${query.dir === "asc" ? "ASC" : "DESC"}, p.client_id DESC LIMIT ? OFFSET ?`,
        [...params, query.pageSize, (query.page - 1) * query.pageSize],
      );
      const ids = list.map((p) => Number(p.client_id));
      const direct = await directReferralCounts(db, ids);
      const funded = ids.length
        ? await rows<{ id: number; n: number }>(
            db,
            `SELECT r.referred_by AS id, COUNT(DISTINCT r.id) AS n FROM clients r JOIN deposits d ON d.client_id = r.id AND d.status = 'approved'
             WHERE r.referred_by IN (${ids.map(() => "?").join(",")}) GROUP BY r.referred_by`,
            ids,
          )
        : [];
      const fundedOf = new Map(funded.map((f) => [Number(f.id), Number(f.n)]));
      const sponsorIds = [...new Set(list.map((p) => p.referred_by).filter((v): v is number => v !== null).map(Number))];
      const sponsors = sponsorIds.length
        ? await rows<{ id: number; first_name: string; last_name: string }>(db, `SELECT id, first_name, last_name FROM clients WHERE id IN (${sponsorIds.map(() => "?").join(",")})`, sponsorIds)
        : [];
      const sponsorIbs = await activePartnersAmong(db, sponsorIds);
      const sponsorOf = new Map(sponsors.map((c) => [Number(c.id), { id: Number(c.id), name: `${c.first_name} ${c.last_name}`.trim(), isIb: sponsorIbs.has(Number(c.id)) }]));
      const items = [];
      for (const p of list) {
        const members = await networkFor(Number(p.client_id));
        const subIbs = await activePartnersAmong(db, members.map((m) => m.id));
        items.push({
          clientId: Number(p.client_id),
          name: `${p.first_name} ${p.last_name}`.trim(),
          email: p.email,
          avatarUrl: clientPictureUrl("", Number(p.client_id), p.picture_sha),
          clientStatus: p.client_status,
          referralCode: p.referral_code,
          tier: p.tier_name,
          applicationId: Number(p.application_id),
          approvedAt: p.approved_at.toISOString(),
          approvedBy: person(p.approved_by, p.approver_name),
          directClients: direct.get(Number(p.client_id)) ?? 0,
          fundedClients: fundedOf.get(Number(p.client_id)) ?? 0,
          network: members.length,
          subIbs: subIbs.size,
          sponsor: p.referred_by ? (sponsorOf.get(Number(p.referred_by)) ?? null) : null,
          status: p.status,
          removedAt: iso(p.removed_at),
          removedBy: person(p.removed_by, p.remover_name),
          removedReason: p.removed_reason,
        });
      }
      res.json(toPage(items, Number(total?.n ?? 0), query.page, query.pageSize));
    }),
  );

  router.get(
    "/partners/summary",
    view,
    handler(async (req, res) => {
      const s = clientScope(staffOf(req));
      const now = new Date();
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const r = await one<{ active: string | null; removed: string | null; recent: string | null }>(
        db,
        `SELECT SUM(p.status = 'active') AS active, SUM(p.status = 'removed') AS removed, SUM(p.status = 'active' AND p.approved_at >= ?) AS recent
         FROM ib_partners p JOIN clients c ON c.id = p.client_id WHERE 1 = 1${s.sql}`,
        [monthStart, ...s.params],
      );
      res.json({ active: Number(r?.active ?? 0), removed: Number(r?.removed ?? 0), newThisMonth: Number(r?.recent ?? 0) });
    }),
  );

  return router;
}
