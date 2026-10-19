import express, { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import type { AppDeps } from "../../app";
import { fieldError, TooManyRequests, ValidationError } from "../../clients/errors";
import { kycRequired, lockClient } from "../../clients/kyc";
import { assertClientMayMoveMoney, formFlag, formText, readMoneyForm } from "../../clients/money";
import { clientName } from "../../clients/model";
import { clientActor, clientAuth, clientOf, noImpersonation } from "../../clients/session";
import { auditContext, writeAudit } from "../../lib/audit";
import { exec, one, rows, transaction } from "../../lib/db";
import { forbidden, handler, HttpError } from "../../lib/http";
import { RateLimiter } from "../../lib/rateLimit";
import { AMOUNT_MESSAGES, parseAmount } from "../../money/amounts";
import { activePartner, IB_TERMS_VERSION, latestApplication, loadTiers, mayApply, openApplication, presentIbRequest, type ApplicationRow, type PartnerRow } from "../../ib/model";
import {
  activePartnersAmong, approvedDeposits, directReferralCounts, inSubIbNetworks, lots, lotsTraded, monthWindow, networkOf, paidWithdrawals, TtlCache, usd, type Member,
} from "../../ib/network";

const HOUR = 60 * 60_000;
const TERMS = "Please accept the IB Terms & Conditions.";
const ON_HOLD = "Your account is on hold, so you cannot apply right now. Please contact support.";
const NOT_IB = "This is only available to approved IB partners.";
const MONTH = /^20\d{2}-(0[1-9]|1[0-2])$/;
/** Direct referrals listed on the referral page, newest first. */
const MAX_REFERRALS = 1_000;

/** Reads a small multipart form (the app sends forms); a body that is too large becomes a field error. */
function multipart(field: string, message: string): RequestHandler {
  const raw = express.raw({ type: "multipart/form-data", limit: "64kb" });
  return (req, res, next) =>
    raw(req, res, (error?: unknown) => {
      if ((error as { status?: number } | undefined)?.status === 413) return next(fieldError(field, message));
      next(error);
    });
}
const urlencoded = express.urlencoded({ extended: false, limit: "8kb" });

/** ?month=YYYY-MM, the current UTC month when not sent. */
function monthOf(value: unknown): string {
  if (value === undefined || value === "") return new Date().toISOString().slice(0, 7);
  if (typeof value !== "string" || !MONTH.test(value)) throw fieldError("month", "Enter the month as YYYY-MM.");
  return value;
}

/** A whole number from the query between min and max; anything odd falls back to `fallback`, too large is capped. */
function intQuery(value: unknown, fallback: number, max: number): number {
  const n = typeof value === "string" && /^\d{1,9}$/.test(value) ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : fallback;
}

const pagination = (page: number, perPage: number, total: number) => ({ current_page: page, per_page: perPage, total, last_page: Math.max(1, Math.ceil(total / perPage)) });

/** Network-wide figures for the dashboard (cached for a minute per IB and month). */
interface Figures {
  teamCount: number;
  directCount: number;
  fundedDirect: number;
  directDepositCents: number;
  teamDepositCents: number;
  directWithdrawalCents: number;
  directLots: number;
  monthDirectCents: number;
  monthTeamCents: number;
  subIbCount: number;
  inSubIbNetworks: number;
}

/**
 * The portal and app's IB program: the application (any signed-in client),
 * and the IB dashboard, referral link and network (approved IBs only).
 * Commissions, the IB wallet and its transfers come in a later round: their
 * figures are 0 and their lists are empty. No answer here is a 401 for a
 * signed-in client (the app signs out on any 401), and refusals are 4xx other
 * than 408 and 409 (the app treats those as "uncertain").
 */
export function clientIbRouter(deps: AppDeps): Router {
  const { db, config, log } = deps;
  const router = Router();
  const auth = clientAuth(db, config);
  const ctx = (req: Request) => auditContext(req, clientActor(clientOf(req)));

  // Stored applications per hour; refused attempts do not use them up.
  const applications = new RateLimiter(5, HOUR);
  const applyAttempts = new RateLimiter(20, HOUR);
  const transfers = new RateLimiter(10, HOUR);
  const transferAttempts = new RateLimiter(30, HOUR);
  // Every IB read, shared: the network reads are the heaviest client reads there are.
  const reads = new RateLimiter(120, 60_000);
  const networks = new TtlCache<Member[]>(60_000);
  const figures = new TtlCache<Figures>(60_000);

  const gate = (stored: RateLimiter, attempts: RateLimiter, message: string) => (req: Request, _res: Response, next: NextFunction) => {
    const key = String(clientOf(req).id);
    if (stored.isLimited(key)) return next(new TooManyRequests(stored.retryAfter(key), message));
    if (!attempts.take(key)) return next(new TooManyRequests(attempts.retryAfter(key), "Too many attempts. Please wait before trying again."));
    next();
  };
  const applyGate = gate(applications, applyAttempts, "Too many IB applications. Please wait before trying again.");
  const transferGate = gate(transfers, transferAttempts, "Too many transfers. Please wait before trying again.");
  const readGate = (req: Request, _res: Response, next: NextFunction) => {
    const key = String(clientOf(req).id);
    if (!reads.take(key)) return next(new TooManyRequests(reads.retryAfter(key), "Too many requests. Please wait a moment and try again."));
    next();
  };

  /**
   * Approved IBs only: an active partnership on an open account. KYC is not
   * checked again here: a partnership stays usable if KYC is later withdrawn,
   * until staff remove it.
   */
  const ibOnly = (req: Request, res: Response, next: NextFunction) => {
    activePartner(db, clientOf(req).id).then((partner) => {
      if (!partner) return next(forbidden(NOT_IB));
      res.locals.ibPartner = partner;
      next();
    }, next);
  };
  const partnerOf = (res: Response) => res.locals.ibPartner as PartnerRow;
  const mayMoveMoney = (req: Request, _res: Response, next: NextFunction) => {
    assertClientMayMoveMoney(db, clientOf(req).id).then(() => next(), next);
  };

  const networkFor = (ibId: number) => networks.get(String(ibId), () => networkOf(db, ibId, log));
  const codeOf = async (clientId: number) => (await one<{ referral_code: string }>(db, "SELECT referral_code FROM clients WHERE id = ?", [clientId]))!.referral_code;
  const referralLink = (code: string) => `${config.portalUrl}/register?ref=${encodeURIComponent(code)}`;

  /** Names for these clients, for rows the IB sees (never emails, phones or MT5 logins). */
  async function namesOf(ids: readonly number[]) {
    if (!ids.length) return new Map<number, string>();
    const found = await rows<{ id: number; first_name: string; last_name: string }>(
      db, `SELECT id, first_name, last_name FROM clients WHERE id IN (${ids.map(() => "?").join(",")})`, [...ids],
    );
    return new Map(found.map((c) => [Number(c.id), clientName(c)]));
  }

  // ---------- The application ----------

  // Never KYC-gated and never a 404: both front ends decide from it whether to show the form.
  router.get(
    "/ib-request",
    auth,
    readGate,
    handler(async (req, res) => {
      const clientId = clientOf(req).id;
      const latest = await latestApplication(db, clientId);
      const client = (await one<{ status: string; kyc_status: string }>(db, "SELECT status, kyc_status FROM clients WHERE id = ?", [clientId]))!;
      res.json(presentIbRequest(latest, mayApply(client, latest)));
    }),
  );

  router.post(
    "/ib-request",
    auth,
    noImpersonation,
    applyGate,
    multipart("terms", TERMS),
    urlencoded,
    handler(async (req, res) => {
      const client = clientOf(req);
      const form = await readMoneyForm(req, "terms", TERMS);
      const terms = form.values.terms;
      if (formFlag(terms) !== true && formText(terms)?.toLowerCase() !== "on") throw fieldError("terms", TERMS);
      // Checked before the lock for a quick answer, and again with the client row locked.
      const refusal = (c: { status: string; kyc_status: string } | undefined) => {
        if (!c || c.status === "closed") return new HttpError(403, "ACCOUNT_CLOSED", "This account is closed. Please contact support.");
        if (c.kyc_status !== "approved") return kycRequired();
        if (c.status === "frozen") return new ValidationError({ account: [ON_HOLD] });
        return null;
      };
      const before = refusal(await one<{ status: string; kyc_status: string }>(db, "SELECT status, kyc_status FROM clients WHERE id = ?", [client.id]));
      if (before) throw before;
      // A retried or doubled submit is answered with the application already open, never an error.
      const open = await openApplication(db, client.id);
      if (open) return void res.json(presentIbRequest(open, false));
      let result: { app: ApplicationRow; created: boolean };
      try {
        result = await transaction(db, async (conn) => {
          await lockClient(conn, client.id);
          const block = refusal(await one<{ status: string; kyc_status: string }>(conn, "SELECT status, kyc_status FROM clients WHERE id = ?", [client.id]));
          if (block) throw block;
          const existing = await openApplication(conn, client.id);
          if (existing) return { app: existing, created: false };
          const inserted = await exec(
            conn,
            "INSERT INTO ib_applications (client_id, terms_version, submitted_ip, submitted_user_agent) VALUES (?, ?, ?, ?)",
            [client.id, IB_TERMS_VERSION, req.clientIp.slice(0, 45), (req.get("user-agent") ?? "").slice(0, 255)],
          );
          await writeAudit(conn, ctx(req), {
            action: "ib.applied", entityType: "client", entityId: client.id, after: { status: "pending" },
            meta: { applicationId: inserted.insertId, termsVersion: IB_TERMS_VERSION },
          });
          return { app: (await latestApplication(conn, client.id))!, created: true };
        });
      } catch (error) {
        // uq_ib_app_open: another request opened one first.
        const e = error as { code?: string; message?: string };
        if (e.code !== "ER_DUP_ENTRY" || !(e.message ?? "").includes("uq_ib_app_open")) throw error;
        result = { app: (await openApplication(db, client.id))!, created: false };
      }
      if (result.created) applications.take(String(client.id));
      res.status(result.created ? 201 : 200).json(presentIbRequest(result.app, false));
    }),
  );

  // ---------- IB dashboard and network (approved IBs) ----------

  async function figuresOf(ibId: number, month: string): Promise<Figures> {
    return figures.get(`${ibId}:${month}`, async () => {
      const members = await networkFor(ibId);
      const ids = members.map((m) => m.id);
      const direct = members.filter((m) => m.level === 1).map((m) => m.id);
      const deposits = await approvedDeposits(db, ids);
      const monthly = await approvedDeposits(db, ids, monthWindow(month));
      const withdrawals = await paidWithdrawals(db, direct);
      const traded = await lotsTraded(db, direct);
      const subIbs = await activePartnersAmong(db, ids);
      const sum = (list: readonly number[], of: (id: number) => number) => list.reduce((total, id) => total + of(id), 0);
      return {
        teamCount: members.length,
        directCount: direct.length,
        fundedDirect: direct.filter((id) => (deposits.get(id)?.count ?? 0) > 0).length,
        directDepositCents: sum(direct, (id) => deposits.get(id)?.cents ?? 0),
        teamDepositCents: sum(ids, (id) => deposits.get(id)?.cents ?? 0),
        directWithdrawalCents: sum(direct, (id) => withdrawals.get(id)?.cents ?? 0),
        directLots: sum(direct, (id) => traded.get(id) ?? 0),
        monthDirectCents: sum(direct, (id) => monthly.get(id)?.cents ?? 0),
        monthTeamCents: sum(ids, (id) => monthly.get(id)?.cents ?? 0),
        subIbCount: subIbs.size,
        inSubIbNetworks: inSubIbNetworks(members, subIbs),
      };
    });
  }

  // Top level, not wrapped in `data`: the portal reads it that way. Both tier keys, as each front end reads one.
  router.get(
    "/ib-dashboard",
    auth,
    readGate,
    ibOnly,
    handler(async (req, res) => {
      const month = monthOf(req.query.month);
      const partner = partnerOf(res);
      const f = await figuresOf(partner.client_id, month);
      const tiers = await loadTiers(db);
      const next = tiers.find((t) => t.position > partner.tier_position);
      const code = await codeOf(partner.client_id);
      // At the top level there is nothing to reach: both front ends read all targets 0 as "top tier".
      const progress = {
        category_name: next?.name ?? partner.tier_name,
        clients: { current: f.fundedDirect, required: next ? next.min_clients : 0 },
        deposit: { current: usd(f.directDepositCents), required: next ? usd(Number(next.min_deposit_cents)) : 0 },
        volume: { current: lots(f.directLots), required: next ? lots(Number(next.min_volume_lots)) : 0 },
      };
      const sources = [
        { source: "Direct clients", count: f.directCount },
        { source: "Sub-IB networks", count: f.inSubIbNetworks },
      ].filter((s) => s.count > 0);
      res.json({
        success: true,
        month,
        ib_eligible: partner.tier_name,
        ib_tier: partner.tier_name,
        referral_code: code,
        referral_link: referralLink(code),
        promotion_progress: progress,
        overall_statistics: {
          ib_commissions: 0,
          ib_direct_bonus: { amount: 0, lots: 0 },
          team_count: f.teamCount,
          active_clients: f.fundedDirect,
          total_clients: f.directCount,
          sub_ib_count: f.subIbCount,
          direct_team_sales: usd(f.directDepositCents),
          total_team_sales: usd(f.teamDepositCents),
          total_deposits: usd(f.directDepositCents),
          total_withdrawals: usd(f.directWithdrawalCents),
        },
        monthly_statistics: { team_business_bonus: 0, direct_team_sales: usd(f.monthDirectCents), total_team_sales: usd(f.monthTeamCents) },
        pending_commission: 0,
        paid_commission: 0,
        monthly_growth: [],
        referral_breakdown: sources,
      });
    }),
  );

  router.get(
    "/ib-referrals",
    auth,
    readGate,
    ibOnly,
    handler(async (_req, res) => {
      const ibId = partnerOf(res).client_id;
      const code = await codeOf(ibId);
      const direct = await rows<{ id: number; first_name: string; last_name: string; created_at: Date }>(
        db, `SELECT id, first_name, last_name, created_at FROM clients WHERE referred_by = ? AND id <> ? ORDER BY created_at DESC, id DESC LIMIT ${MAX_REFERRALS}`, [ibId, ibId],
      );
      const ids = direct.map((c) => Number(c.id));
      const deposits = await approvedDeposits(db, ids);
      const traded = await lotsTraded(db, ids);
      res.json({
        success: true,
        referral_code: code,
        referral_link: referralLink(code),
        custom_referral_links: [],
        clients: direct.map((c) => ({
          id: Number(c.id),
          client_id: String(c.id),
          name: clientName(c),
          join_date: c.created_at.toISOString(),
          created_at: c.created_at.toISOString(),
          funded: (deposits.get(Number(c.id))?.count ?? 0) > 0,
          trading_volume: lots(traded.get(Number(c.id)) ?? 0),
          total_deposits: usd(deposits.get(Number(c.id))?.cents ?? 0),
        })),
      });
    }),
  );

  // The whole network below the IB. The portal reads page 1 of 500 only; the app reads every page and checks `total`.
  router.get(
    "/team",
    auth,
    readGate,
    ibOnly,
    handler(async (req, res) => {
      const ibId = partnerOf(res).client_id;
      const page = intQuery(req.query.page, 1, 1_000_000);
      const perPage = intQuery(req.query.per_page, 100, 500);
      const members = await networkFor(ibId);
      const slice = members.slice((page - 1) * perPage, page * perPage);
      const ids = slice.map((m) => m.id);
      const names = await namesOf([...new Set([...ids, ...slice.map((m) => m.sponsorId)])]);
      const counts = await directReferralCounts(db, ids);
      const deposits = await approvedDeposits(db, ids);
      const ibs = await activePartnersAmong(db, ids);
      res.json({
        success: true,
        team_members: slice.map((m) => {
          const name = names.get(m.id) ?? "";
          const cents = deposits.get(m.id)?.cents ?? 0;
          return {
            id: m.id,
            client_id: String(m.id),
            name,
            display_name: `${m.id}-${name}`,
            created_at: m.createdAt.toISOString(),
            joined_at: m.createdAt.toISOString(),
            sponsor: { id: m.sponsorId, name: names.get(m.sponsorId) ?? "" },
            level: m.level,
            // Funded or not, never the account's own state: a freeze is not the IB's business.
            status: (deposits.get(m.id)?.count ?? 0) > 0 ? "active" : "inactive",
            is_ib: ibs.has(m.id),
            clients: counts.get(m.id) ?? 0,
            client_count: counts.get(m.id) ?? 0,
            deposit: usd(cents),
            total_deposits: usd(cents),
            mt5_account_id: null,
          };
        }),
        summary: { total_count: members.length },
        pagination: pagination(page, perPage, members.length),
      });
    }),
  );

  // Active IBs inside the network. No `type` key: the portal refuses any value it does not know.
  router.get(
    "/sub-ibs",
    auth,
    readGate,
    ibOnly,
    handler(async (req, res) => {
      const ibId = partnerOf(res).client_id;
      const page = intQuery(req.query.page, 1, 1_000_000);
      const perPage = intQuery(req.query.per_page, 500, 500);
      const members = await networkFor(ibId);
      const ibs = await activePartnersAmong(db, members.map((m) => m.id));
      const subIbs = members.filter((m) => ibs.has(m.id));
      const slice = subIbs.slice((page - 1) * perPage, page * perPage);
      const ids = slice.map((m) => m.id);
      const names = await namesOf([...new Set([...ids, ...slice.map((m) => m.sponsorId)])]);
      const approved = ids.length
        ? await rows<{ client_id: number; approved_at: Date }>(db, `SELECT client_id, approved_at FROM ib_partners WHERE client_id IN (${ids.map(() => "?").join(",")})`, ids)
        : [];
      const approvedAt = new Map(approved.map((p) => [Number(p.client_id), p.approved_at]));
      res.json({
        success: true,
        sub_ibs: slice.map((m) => {
          const name = names.get(m.id) ?? "";
          return {
            id: m.id,
            sub_ib: { id: m.id, name, display_name: `${m.id}-${name}`, client_id: String(m.id) },
            sponsor: { id: m.sponsorId, name: names.get(m.sponsorId) ?? "" },
            level: m.level,
            status: "active",
            joined_at: m.createdAt.toISOString(),
            created_at: (approvedAt.get(m.id) ?? m.createdAt).toISOString(),
            commissions: [],
          };
        }),
        pagination: pagination(page, perPage, subIbs.length),
      });
    }),
  );

  // Commission plans come in a later round: every list is empty, with the envelope both front ends check.
  router.get(
    "/ib-commissions",
    auth,
    readGate,
    ibOnly,
    handler(async (req, res) => {
      const type = req.query.type ?? "IB";
      if (type !== "IB" && type !== "Team" && type !== "SUB_IB") throw fieldError("type", "Choose IB, Team or SUB_IB.");
      const page = intQuery(req.query.page, 1, 1_000_000);
      const perPage = intQuery(req.query.per_page, 100, 100);
      res.json({ success: true, commissions: [], summary: { total_count: 0, total_amount: 0, total_paid: 0 }, pagination: pagination(page, perPage, 0) });
    }),
  );

  router.get(
    "/direct-bonuses",
    auth,
    readGate,
    ibOnly,
    handler(async (req, res) => {
      const page = intQuery(req.query.current_page ?? req.query.page, 1, 1_000_000);
      const perPage = intQuery(req.query.per_page, 15, 100);
      res.json({ success: true, data: [], total: 0, current_page: page, per_page: perPage, last_page: 1 });
    }),
  );

  for (const path of ["/team-ledger", "/direct-team-ledger"]) {
    router.get(
      path,
      auth,
      readGate,
      ibOnly,
      handler(async (req, res) => {
        monthOf(req.query.month);
        res.json({ success: true, data: [] });
      }),
    );
  }

  // Commission to wallet. The IB wallet comes with commissions in a later round; until then its
  // balance is 0, so every request is refused with a definite answer (never 408 or 409) and nothing moves.
  router.post(
    "/transfer/ib-to-wallet",
    auth,
    noImpersonation,
    ibOnly,
    mayMoveMoney,
    transferGate,
    multipart("amount", "Enter an amount."),
    handler(async (req, _res) => {
      const form = await readMoneyForm(req, "amount", "Enter an amount.");
      const amount = parseAmount(form.values.amount);
      if ("problem" in amount) throw fieldError("amount", AMOUNT_MESSAGES[amount.problem]);
      const refused = new ValidationError({ amount: ["Your IB commission balance is USD 0.00, so there is nothing to transfer yet."] });
      refused.message = "Your IB commission balance is USD 0.00.";
      throw refused;
    }),
  );

  return router;
}
