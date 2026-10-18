import { Router, type Request } from "express";
import { z } from "zod";
import { NOT_PLAIN } from "@shared/money";
import type { AppDeps } from "../../app";
import { clientName } from "../../clients/model";
import { auditContext, auditStandalone, writeAudit } from "../../lib/audit";
import { exec, one, rows, transaction, type Conn } from "../../lib/db";
import { conflict, handler, HttpError, notFound, parse } from "../../lib/http";
import { likeTerm, listQuery, toPage } from "../../lib/pagination";
import { RateLimiter } from "../../lib/rateLimit";
import { clientScope, moneyId } from "../../money/review";
import { claimRun, ISSUE_KINDS, loadRun, runClaimed, runFromDb, SELECT_RUN, SEVERITIES, type IssueKind, type RunRow, type Severity } from "../../mt5/reconcile";
import { requirePermission, requireStepUp, staffActor, staffOf, type StaffContext } from "../../staff/session";
import { anyPermission } from "./money";

// MT5 reconciliation for staff: the runs (nightly, or started here with "Run
// now"), the issues they found, and resolving an issue with a note once it is
// explained or put right. Seeing them takes wallet.reconcile or wallet.view;
// starting a run and resolving take wallet.reconcile, and resolving a fresh
// 2FA code too, as it takes an issue off the list. A run only reads MT5.
//
// An issue about a client is shown only to staff who may see that client;
// one about no client (a ledger problem, an MT5 account no CRM row has) only
// to staff who see every client. So are a run's counts and notes, which are
// across every client: staff who see only their own get them as null.

const NOT_FOUND = "That reconciliation issue does not exist or its client is not assigned to you.";
const RUN_NOT_FOUND = "That reconciliation run does not exist.";

const optional = <T extends z.ZodTypeAny>(schema: T) => schema.optional().or(z.literal("").transform(() => undefined));
const enumOf = <T extends string>(values: readonly T[]) => z.enum(values as [T, ...T[]]);

const pageQuery = listQuery(["id"], "id").pick({ page: true, pageSize: true });
const runsQuery = pageQuery.extend({
  kind: optional(z.enum(["nightly", "manual"])),
  status: optional(z.enum(["running", "done", "failed"])),
});
const issuesQuery = listQuery(["id"], "id").pick({ page: true, pageSize: true, q: true }).extend({
  status: z.enum(["open", "resolved", "all"]).default("open"),
  severity: optional(enumOf(SEVERITIES)),
  kind: optional(enumOf(ISSUE_KINDS)),
  runId: optional(moneyId),
  clientId: optional(moneyId),
  accountId: optional(moneyId),
});
const resolveBody = z
  .object({
    note: z
      .string({ required_error: "Write a note saying what you found and did", invalid_type_error: "Write a note saying what you found and did" })
      .trim()
      .min(10, "Write a note saying what you found and did (at least 10 characters)")
      .max(500, "Keep the note under 500 characters")
      .refine((v) => !NOT_PLAIN.test(v), "Write the note as plain text, without links or symbols like < > { }"),
  })
  .strict();

const iso = (d: Date | null) => d?.toISOString() ?? null;
const person = (id: number | null, name: string | null) => (id === null ? null : { id: Number(id), name: name ?? "" });

export function presentRun(r: RunRow, viewer: StaffContext) {
  const all = viewer.permissions.has("client.view_all");
  return {
    id: r.id,
    kind: r.kind,
    /** The UTC day a nightly run is for. */
    runDate: r.run_date ? r.run_date.toISOString().slice(0, 10) : null,
    status: r.status,
    startedAt: r.started_at.toISOString(),
    finishedAt: iso(r.finished_at),
    heartbeatAt: r.heartbeat_at.toISOString(),
    attempts: r.attempts,
    accountsTotal: all ? r.accounts_total : null,
    accountsChecked: all ? r.accounts_checked : null,
    issuesFound: all ? r.issues_found : null,
    issuesNew: all ? r.issues_new : null,
    criticalFound: all ? r.critical_found : null,
    error: r.error,
    /** What the run could not cover: a server out of reach, a limit reached. */
    notes: all ? r.notes : null,
    startedBy: person(r.started_by, r.started_by_name),
  };
}

interface IssueRow {
  id: number;
  issue_key: string;
  kind: IssueKind;
  severity: Severity;
  status: "open" | "resolved";
  mt5_account_id: number | null;
  client_id: number | null;
  op_id: number | null;
  deal_ticket: number | null;
  details: Record<string, unknown>;
  first_run_id: number;
  last_run_id: number;
  reopened: number;
  resolved_by: number | null;
  resolved_at: Date | null;
  resolved_note: string | null;
  created_at: Date;
  updated_at: Date;
  login: number | null;
  server_code: string | null;
  is_demo: number | null;
  first_name: string | null;
  last_name: string | null;
  reference: string | null;
  resolved_by_name: string | null;
}

const ISSUE_FROM = `FROM mt5_recon_issues i LEFT JOIN clients c ON c.id = i.client_id LEFT JOIN mt5_accounts a ON a.id = i.mt5_account_id
  LEFT JOIN mt5_balance_ops o ON o.id = i.op_id LEFT JOIN staff_users rb ON rb.id = i.resolved_by`;
const SELECT_ISSUE = `SELECT i.id, i.issue_key, i.kind, i.severity, i.status, i.mt5_account_id, i.client_id, i.op_id, i.deal_ticket, i.details, i.first_run_id,
  i.last_run_id, i.reopened, i.resolved_by, i.resolved_at, i.resolved_note, i.created_at, i.updated_at, a.login, a.server_code, a.is_demo,
  c.first_name, c.last_name, o.reference, rb.name AS resolved_by_name ${ISSUE_FROM}`;
const idOrNull = (v: number | null) => (v === null ? null : Number(v));

function presentIssue(i: IssueRow, viewer: StaffContext) {
  return {
    id: Number(i.id),
    key: i.issue_key,
    kind: i.kind,
    severity: i.severity,
    status: i.status,
    accountId: idOrNull(i.mt5_account_id),
    login: idOrNull(i.login),
    serverCode: i.server_code,
    isDemo: i.is_demo === null ? null : Number(i.is_demo) === 1,
    clientId: idOrNull(i.client_id),
    clientName: i.first_name === null ? null : clientName({ first_name: i.first_name, last_name: i.last_name ?? "" }),
    opId: idOrNull(i.op_id),
    reference: i.reference,
    dealTicket: idOrNull(i.deal_ticket),
    /** The facts as last found: amounts in cents, logins, tickets, MT5's comment. */
    details: i.details,
    firstRunId: Number(i.first_run_id),
    lastRunId: Number(i.last_run_id),
    reopened: Number(i.reopened),
    createdAt: i.created_at.toISOString(),
    updatedAt: i.updated_at.toISOString(),
    resolvedBy: person(i.resolved_by, i.resolved_by_name),
    resolvedAt: iso(i.resolved_at),
    resolvedNote: i.resolved_note,
    /** A run found it no longer true. */
    resolvedAutomatically: i.status === "resolved" && i.resolved_by === null,
    canResolve: i.status === "open" && viewer.permissions.has("wallet.reconcile"),
  };
}

/** An issue this staff member may see, or 404. */
async function loadVisible(conn: Conn, staff: StaffContext, id: number): Promise<IssueRow> {
  const s = clientScope(staff);
  const i = await one<IssueRow>(conn, `${SELECT_ISSUE} WHERE i.id = ?${s.sql}`, [id, ...s.params]);
  if (!i) throw notFound(NOT_FOUND);
  return i;
}

export function staffMt5ReconciliationRouter(deps: AppDeps): Router {
  const { db, config, log } = deps;
  const mt5 = deps.mt5 ?? null;
  const router = Router();
  const stepUp = requireStepUp(config);
  const ctx = (req: Request) => auditContext(req, staffActor(staffOf(req)));
  const see = anyPermission("wallet.reconcile", "wallet.view");
  // A run reads every account's deals from MT5: a held-down button should not queue many.
  const starts = new RateLimiter(10, 60 * 60_000);

  // The open issues by severity (for the dashboard), the last run that ended, and the one running.
  router.get(
    "/summary",
    see,
    handler(async (req, res) => {
      const staff = staffOf(req);
      const s = clientScope(staff);
      const counts = await rows<{ severity: Severity; n: number }>(
        db,
        `SELECT i.severity, COUNT(*) AS n FROM mt5_recon_issues i LEFT JOIN clients c ON c.id = i.client_id WHERE i.status = 'open'${s.sql} GROUP BY i.severity`,
        s.params,
      );
      const open = { critical: 0, warning: 0, info: 0 };
      for (const c of counts) open[c.severity] = Number(c.n);
      const last = await one<RunRow>(db, `${SELECT_RUN} WHERE r.status <> 'running' ORDER BY r.id DESC LIMIT 1`);
      const running = await one<RunRow>(db, `${SELECT_RUN} WHERE r.status = 'running' LIMIT 1`);
      res.json({ open, lastRun: last ? presentRun(runFromDb(last), staff) : null, running: running ? presentRun(runFromDb(running), staff) : null });
    }),
  );

  router.get(
    "/runs",
    see,
    handler(async (req, res) => {
      const query = parse(runsQuery, req.query);
      let clause = " WHERE 1 = 1";
      const params: unknown[] = [];
      if (query.kind) (clause += " AND r.kind = ?"), params.push(query.kind);
      if (query.status) (clause += " AND r.status = ?"), params.push(query.status);
      const total = await one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM mt5_recon_runs r${clause}`, params);
      const items = await rows<RunRow>(db, `${SELECT_RUN}${clause} ORDER BY r.id DESC LIMIT ? OFFSET ?`, [...params, query.pageSize, (query.page - 1) * query.pageSize]);
      const staff = staffOf(req);
      res.json(toPage(items.map((r) => presentRun(runFromDb(r), staff)), Number(total?.n ?? 0), query.page, query.pageSize));
    }),
  );

  router.get(
    "/runs/:id",
    see,
    handler(async (req, res) => {
      const run = await loadRun(db, parse(moneyId, req.params.id));
      if (!run) throw notFound(RUN_NOT_FOUND);
      res.json({ run: presentRun(run, staffOf(req)) });
    }),
  );

  // Starts a run now and answers at once (202): it takes minutes, and its row says how far it is.
  router.post(
    "/runs",
    requirePermission("wallet.reconcile"),
    handler(async (req, res) => {
      parse(z.object({}).strict(), req.body ?? {});
      const staff = staffOf(req);
      if (!mt5) throw new HttpError(422, "MT5_OFF", "MT5 is not connected: CRM_MT5_GATEWAY_URL is not set on this server.");
      if (!starts.take(String(staff.id))) throw new HttpError(429, "RATE_LIMITED", "Too many runs started. Wait a while and try again.");
      const claimed = await claimRun(db, { kind: "manual", staffId: staff.id });
      if (!claimed) throw new HttpError(409, "RUN_RUNNING", "A reconciliation run is already running. Wait for it to finish.");
      await auditStandalone(db, ctx(req), { action: "mt5.reconciliation.run_started", entityType: "mt5_recon_run", entityId: claimed.id, meta: { runId: claimed.id } });
      runClaimed(db, mt5, log, claimed).catch((e) => log.error({ err: e, runId: claimed.id }, "MT5 reconciliation run failed"));
      res.status(202).json({ run: presentRun((await loadRun(db, claimed.id))!, staff) });
    }),
  );

  router.get(
    "/issues",
    see,
    handler(async (req, res) => {
      const query = parse(issuesQuery, req.query);
      const staff = staffOf(req);
      const s = clientScope(staff);
      let clause = ` WHERE 1 = 1${s.sql}`;
      const params: unknown[] = [...s.params];
      if (query.status !== "all") (clause += " AND i.status = ?"), params.push(query.status);
      if (query.severity) (clause += " AND i.severity = ?"), params.push(query.severity);
      if (query.kind) (clause += " AND i.kind = ?"), params.push(query.kind);
      // The issues a run found: first, or again.
      if (query.runId) (clause += " AND (i.first_run_id = ? OR i.last_run_id = ?)"), params.push(query.runId, query.runId);
      if (query.clientId) (clause += " AND i.client_id = ?"), params.push(query.clientId);
      if (query.accountId) (clause += " AND i.mt5_account_id = ?"), params.push(query.accountId);
      if (query.q) {
        const asNumber = /^\d{1,19}$/.test(query.q) ? query.q : "0";
        clause += " AND (i.issue_key LIKE ? OR o.reference = ? OR a.login = ? OR i.deal_ticket = ? OR CONCAT(c.first_name, ' ', c.last_name) LIKE ?)";
        params.push(likeTerm(query.q), query.q.toUpperCase(), asNumber, asNumber, likeTerm(query.q));
      }
      const total = await one<{ n: number }>(db, `SELECT COUNT(*) AS n ${ISSUE_FROM}${clause}`, params);
      const items = await rows<IssueRow>(
        db,
        `${SELECT_ISSUE}${clause} ORDER BY FIELD(i.severity, 'critical', 'warning', 'info'), i.id DESC LIMIT ? OFFSET ?`,
        [...params, query.pageSize, (query.page - 1) * query.pageSize],
      );
      res.json(toPage(items.map((i) => presentIssue(i, staff)), Number(total?.n ?? 0), query.page, query.pageSize));
    }),
  );

  router.get(
    "/issues/:id",
    see,
    handler(async (req, res) => {
      const staff = staffOf(req);
      res.json({ issue: presentIssue(await loadVisible(db, staff, parse(moneyId, req.params.id)), staff) });
    }),
  );

  // Takes an issue off the list with a note. A run that finds it again reopens it when it is a state that
  // should not last (a ledger problem, a funding gap, an operation still open) or its facts changed.
  router.post(
    "/issues/:id/resolve",
    requirePermission("wallet.reconcile"),
    stepUp,
    handler(async (req, res) => {
      const { note } = parse(resolveBody, req.body ?? {});
      const staff = staffOf(req);
      const id = parse(moneyId, req.params.id);
      const seen = await loadVisible(db, staff, id);
      await transaction(db, async (conn) => {
        const now = await one<{ status: string }>(conn, "SELECT status FROM mt5_recon_issues WHERE id = ? FOR UPDATE", [id]);
        if (now?.status !== "open") throw conflict("This issue is already resolved.");
        await exec(conn, "UPDATE mt5_recon_issues SET status = 'resolved', resolved_by = ?, resolved_at = CURRENT_TIMESTAMP(3), resolved_note = ? WHERE id = ?", [staff.id, note, id]);
        await writeAudit(conn, ctx(req), {
          action: "mt5.reconciliation.issue_resolved",
          ...(seen.client_id === null ? { entityType: "mt5_recon_issue", entityId: id } : { entityType: "client", entityId: Number(seen.client_id) }),
          before: { status: "open" }, after: { status: "resolved" },
          meta: {
            issueId: id, issueKey: seen.issue_key, kind: seen.kind, severity: seen.severity, accountId: idOrNull(seen.mt5_account_id), opId: idOrNull(seen.op_id),
            dealTicket: idOrNull(seen.deal_ticket), internalNote: note,
          },
        });
      });
      res.json({ issue: presentIssue(await loadVisible(db, staff, id), staff) });
    }),
  );

  return router;
}
