import { Router, type Request } from "express";
import type { AppDeps } from "../../app";
import { auditContext, auditStandalone } from "../../lib/audit";
import { one, type Conn } from "../../lib/db";
import { conflict, handler, HttpError, notFound, parse } from "../../lib/http";
import { listQuery, toPage } from "../../lib/pagination";
import { RateLimiter } from "../../lib/rateLimit";
import { clientScope, moneyId } from "../../money/review";
import { syncAccountDeals, syncStatus, type SyncState } from "../../mt5/deals";
import { serverEnabled } from "../../mt5/settings";
import { accountTradePage, presentStaffTotals, presentStaffTrade } from "../../mt5/trades";
import { requirePermission, staffActor, staffOf, type StaffContext } from "../../staff/session";

// An MT5 account's closed trades for staff, from the CRM's deals cache, and
// "Sync now", which reads the account's new deals from MT5 straight away.
// Both only read MT5, so mt5.view is enough; a sync is audited because it
// makes the CRM call MT5 on a person's word.

const NOT_FOUND = "That MT5 account does not exist or its client is not assigned to you.";
const NOT_OPEN = "This account is not open in MT5.";

type HistoryAccountRow = SyncState & { id: number; client_id: number; login: number | null; status: string; server_code: string };

const pageQuery = listQuery(["closed_at"], "closed_at").pick({ page: true, pageSize: true });

export function staffMt5HistoryRouter(deps: AppDeps): Router {
  const { db, log } = deps;
  const mt5 = deps.mt5 ?? null;
  const router = Router();
  const ctx = (req: Request) => auditContext(req, staffActor(staffOf(req)));
  // Each sync is a few MT5 reads; a held-down button should not become hundreds.
  const syncs = new RateLimiter(30, 10 * 60_000);

  /** An account of a client this staff member may see, or 404. */
  async function loadVisible(conn: Conn, staff: StaffContext, id: number): Promise<HistoryAccountRow> {
    const s = clientScope(staff);
    const a = await one<HistoryAccountRow>(
      conn,
      `SELECT a.id, a.client_id, a.login, a.status, a.server_code, a.deals_synced_until, a.deals_synced_at, a.deals_sync_error, a.deals_sync_partial
       FROM mt5_accounts a JOIN clients c ON c.id = a.client_id WHERE a.id = ?${s.sql}`,
      [id, ...s.params],
    );
    if (!a) throw notFound(NOT_FOUND);
    return { ...a, id: Number(a.id), client_id: Number(a.client_id), login: a.login === null ? null : Number(a.login) };
  }

  router.get(
    "/:id/trades",
    requirePermission("mt5.view"),
    handler(async (req, res) => {
      const query = parse(pageQuery, req.query);
      const a = await loadVisible(db, staffOf(req), parse(moneyId, req.params.id));
      const { totals, items } = await accountTradePage(db, a.id, query.page, query.pageSize);
      res.json({
        ...toPage(items.map(presentStaffTrade), totals.trades, query.page, query.pageSize),
        totals: presentStaffTotals(totals),
        sync: syncStatus(a.id, a),
      });
    }),
  );

  // Reads the account's deals from MT5 now (joining a sync already running) and answers how far the cache
  // is. A sync MT5 could not finish is not an error here: the answer says what went wrong.
  router.post(
    "/:id/sync-deals",
    requirePermission("mt5.view"),
    handler(async (req, res) => {
      const staff = staffOf(req);
      const id = parse(moneyId, req.params.id);
      const a = await loadVisible(db, staff, id);
      if (a.status !== "active" || a.login === null) throw conflict(NOT_OPEN);
      if (!mt5) throw new HttpError(422, "MT5_OFF", "MT5 is not connected: CRM_MT5_GATEWAY_URL is not set on this server.");
      if (!(await serverEnabled(db, a.server_code))) throw new HttpError(422, "MT5_SERVER_OFF", "This MT5 server is switched off. Switch it on in the MT5 settings first.");
      if (!syncs.take(String(staff.id))) throw new HttpError(429, "RATE_LIMITED", "Too many syncs. Wait a few minutes and try again.");
      const result = await syncAccountDeals(db, mt5, a.id, log);
      await auditStandalone(db, ctx(req), {
        action: "mt5.account.deals_synced", entityType: "client", entityId: a.client_id,
        meta: {
          accountId: a.id, login: a.login, outcome: result.outcome, pages: result.pages, newDeals: result.newDeals,
          ...(result.error ? { kind: result.error.kind, code: result.error.code } : {}),
        },
      });
      const now = await loadVisible(db, staff, id);
      res.json({
        result: { outcome: result.outcome, pages: result.pages, deals: result.deals, newDeals: result.newDeals, trades: result.trades, error: result.error },
        sync: syncStatus(now.id, now),
      });
    }),
  );

  return router;
}
