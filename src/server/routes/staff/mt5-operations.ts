import { Router, type Request } from "express";
import { z } from "zod";
import { NOT_PLAIN } from "@shared/money";
import type { AppDeps } from "../../app";
import { clientName } from "../../clients/model";
import { auditContext, auditStandalone, writeAudit } from "../../lib/audit";
import { one, rows, type Conn } from "../../lib/db";
import { conflict, handler, HttpError, notFound, parse } from "../../lib/http";
import { likeTerm, listQuery, toPage } from "../../lib/pagination";
import { clientScope, moneyId } from "../../money/review";
import { staffMt5Error } from "../../mt5/errors";
import { GatewayError } from "../../mt5/gateway";
import { opFromDb, SELECT_OP, signedCents, type BalanceOpRow } from "../../mt5/operations";
import { checkBalanceOpDetailed, failBalanceOpByStaff, GIVE_UP_AGE_MS, STUCK_MS } from "../../mt5/resolver";
import { requirePermission, requireStepUp, staffActor, staffOf, type StaffContext } from "../../staff/session";

// MT5 balance operations for staff: wallet transfers and demo funding, with
// what is still open after a lost MT5 answer. Staff can run the resolver's
// search now ("Check now"), or mark an operation failed when it is at least
// ten minutes old and a search made now does not find its deal in MT5.
// Nobody can mark one completed: only a deal found in MT5 does that.

const NOT_FOUND = "That MT5 operation does not exist or its client is not assigned to you.";
const SETTLED = "This operation is already settled.";

const PURPOSES = ["wallet_to_mt5", "mt5_to_wallet", "demo_funding", "demo_topup"] as const;
const STATUSES = {
  all: [],
  open: ["sending", "unknown"],
  sending: ["sending"],
  unknown: ["unknown"],
  completed: ["completed"],
  failed: ["failed"],
} as const;

const failBody = z
  .object({
    note: z
      .string({ required_error: "Write a note saying what you checked", invalid_type_error: "Write a note saying what you checked" })
      .trim()
      .min(10, "Write a note saying what you checked (at least 10 characters)")
      .max(500, "Keep the note under 500 characters")
      .refine((v) => !NOT_PLAIN.test(v), "Write the note as plain text, without links or symbols like < > { }"),
  })
  .strict();

type StaffOpRow = BalanceOpRow & {
  first_name: string;
  last_name: string;
  email: string;
  is_demo: number;
  account_status: string;
  archived_at: Date | null;
  suspended_at: Date | null;
  resolved_by_name: string | null;
};

const SELECT_STAFF_OP = SELECT_OP.replace(
  "FROM mt5_balance_ops o",
  `, c.first_name, c.last_name, c.email, a.is_demo, a.status AS account_status, a.archived_at, a.suspended_at, rb.name AS resolved_by_name
   FROM mt5_balance_ops o JOIN clients c ON c.id = o.client_id JOIN mt5_accounts a ON a.id = o.mt5_account_id LEFT JOIN staff_users rb ON rb.id = o.resolved_by`,
);

/** opFromDb keeps the joined columns. */
const fromDb = (o: StaffOpRow) => opFromDb(o) as StaffOpRow;
const iso = (d: Date | null) => d?.toISOString() ?? null;
const isOpen = (o: BalanceOpRow) => o.status === "sending" || o.status === "unknown";
/** Still in its own request's hands: a search now could only find nothing yet. */
const inFlight = (o: BalanceOpRow) => o.status === "sending" && Date.now() - o.updated_at.getTime() < STUCK_MS;

function presentOp(o: StaffOpRow) {
  return {
    id: o.id,
    reference: o.reference,
    purpose: o.purpose,
    clientId: o.client_id,
    clientName: clientName(o),
    clientEmail: o.email,
    accountId: o.mt5_account_id,
    login: o.login,
    serverCode: o.server_code,
    isDemo: o.is_demo === 1,
    accountState: o.account_status !== "active" ? o.account_status : o.suspended_at ? "suspended" : o.archived_at ? "archived" : "active",
    amountCents: o.amount_cents,
    /** What MT5 is asked to add to the account: negative takes money out. */
    signedCents: signedCents(o),
    status: o.status,
    ticket: o.mt5_ticket,
    failure: o.failure,
    clientMessage: o.client_message,
    checks: o.checks,
    nextCheckAt: iso(o.next_check_at),
    resolvedBy: o.resolved_by === null ? null : { id: Number(o.resolved_by), name: o.resolved_by_name ?? "" },
    resolvedNote: o.resolved_note,
    createdAt: o.created_at.toISOString(),
    updatedAt: o.updated_at.toISOString(),
    completedAt: iso(o.completed_at),
    canCheck: isOpen(o) && !inFlight(o),
    canFail: isOpen(o) && Date.now() - o.created_at.getTime() >= GIVE_UP_AGE_MS,
  };
}

export function staffMt5OperationsRouter(deps: AppDeps): Router {
  const { db, config, log } = deps;
  const mt5 = deps.mt5 ?? null;
  const router = Router();
  const stepUp = requireStepUp(config);
  const ctx = (req: Request) => auditContext(req, staffActor(staffOf(req)));

  /** An operation of a client this staff member may see, or 404. */
  async function loadVisible(conn: Conn, staff: StaffContext, id: number): Promise<StaffOpRow> {
    const s = clientScope(staff);
    const o = await one<StaffOpRow>(conn, `${SELECT_STAFF_OP} WHERE o.id = ?${s.sql}`, [id, ...s.params]);
    if (!o) throw notFound(NOT_FOUND);
    return fromDb(o);
  }

  const gateway = () => {
    if (!mt5) throw new HttpError(422, "MT5_OFF", "MT5 is not connected: CRM_MT5_GATEWAY_URL is not set on this server.");
    return mt5;
  };

  router.get(
    "/",
    requirePermission("wallet.view"),
    handler(async (req, res) => {
      const optional = <T extends z.ZodTypeAny>(schema: T) => schema.optional().or(z.literal("").transform(() => undefined));
      const query = parse(
        listQuery(["created_at", "amount_cents"], "created_at").extend({
          status: z.enum(Object.keys(STATUSES) as [keyof typeof STATUSES, ...(keyof typeof STATUSES)[]]).default("all"),
          purpose: optional(z.enum(PURPOSES)),
          clientId: optional(moneyId),
          accountId: optional(moneyId),
        }),
        req.query,
      );
      const s = clientScope(staffOf(req));
      let clause = ` WHERE 1 = 1${s.sql}`;
      const params: unknown[] = [...s.params];
      const statuses: readonly string[] = STATUSES[query.status];
      if (statuses.length) (clause += ` AND o.status IN (${statuses.map(() => "?").join(", ")})`), params.push(...statuses);
      if (query.purpose) (clause += " AND o.purpose = ?"), params.push(query.purpose);
      if (query.clientId) (clause += " AND o.client_id = ?"), params.push(query.clientId);
      if (query.accountId) (clause += " AND o.mt5_account_id = ?"), params.push(query.accountId);
      if (query.q) {
        const asNumber = /^\d{1,15}$/.test(query.q) ? Number(query.q) : 0;
        clause += " AND (o.reference = ? OR o.login = ? OR c.id = ? OR c.email LIKE ? OR CONCAT(c.first_name, ' ', c.last_name) LIKE ?)";
        params.push(query.q.toUpperCase(), asNumber, asNumber, likeTerm(query.q), likeTerm(query.q));
      }
      const dir = query.dir === "asc" ? "ASC" : "DESC";
      const order = query.sort === "amount_cents" ? "o.amount_cents" : "o.created_at";
      const from = " FROM mt5_balance_ops o JOIN clients c ON c.id = o.client_id";
      const total = await one<{ n: number }>(db, `SELECT COUNT(*) AS n${from}${clause}`, params);
      const items = await rows<StaffOpRow>(db, `${SELECT_STAFF_OP}${clause} ORDER BY ${order} ${dir}, o.id ${dir} LIMIT ? OFFSET ?`, [
        ...params, query.pageSize, (query.page - 1) * query.pageSize,
      ]);
      res.json(toPage(items.map(fromDb).map(presentOp), Number(total?.n ?? 0), query.page, query.pageSize));
    }),
  );

  /** The operation with the ledger transactions it made (none for demo money, and none yet for an open transfer from MT5). */
  async function operationPage(staff: StaffContext, id: number) {
    const o = await loadVisible(db, staff, id);
    const entries = await rows<{ transaction_id: number; kind: string; created_at: Date; account: string; amount_cents: number }>(
      db,
      `SELECT t.id AS transaction_id, t.kind, t.created_at, e.account, e.amount_cents
       FROM ledger_transactions t JOIN ledger_entries e ON e.transaction_id = t.id
       WHERE t.source_type = 'mt5_op' AND t.source_id = ? ORDER BY t.id, e.id`,
      [o.id],
    );
    const ledger: { id: number; kind: string; createdAt: string; entries: { account: string; amountCents: number }[] }[] = [];
    for (const e of entries) {
      let t = ledger.at(-1);
      if (t?.id !== Number(e.transaction_id)) ledger.push((t = { id: Number(e.transaction_id), kind: e.kind, createdAt: e.created_at.toISOString(), entries: [] }));
      t.entries.push({ account: e.account, amountCents: Number(e.amount_cents) });
    }
    return { operation: presentOp(o), ledger };
  }

  router.get(
    "/:id",
    requirePermission("wallet.view"),
    handler(async (req, res) => {
      res.json(await operationPage(staffOf(req), parse(moneyId, req.params.id)));
    }),
  );

  // The resolver's search, now: a deal found settles the operation. Finding nothing changes nothing:
  // only the resolver's own schedule, or "mark failed" with 2FA and a note, gives the money back.
  router.post(
    "/:id/check",
    requirePermission("wallet.view", "wallet.reconcile"),
    handler(async (req, res) => {
      const staff = staffOf(req);
      const id = parse(moneyId, req.params.id);
      const o = await loadVisible(db, staff, id);
      if (!isOpen(o)) throw conflict(SETTLED);
      if (inFlight(o)) throw conflict("This operation is still being sent to MT5. Check it again in a couple of minutes.");
      const { result, error } = await checkBalanceOpDetailed(db, gateway(), o.id, log, { mayGiveUp: false });
      await auditStandalone(db, ctx(req), {
        action: "mt5.operation.checked", entityType: "client", entityId: o.client_id,
        meta: { opId: o.id, reference: o.reference, purpose: o.purpose, login: o.login, amountCents: o.amount_cents, result, ...(error ? { kind: error.kind, code: error.code } : {}) },
      });
      const page = await operationPage(staff, id);
      res.json({
        result,
        // Why MT5 could not be searched, in MT5's words (staff only).
        searchError: error ? { kind: error.kind, code: error.code, message: error.message } : null,
        ...page,
      });
    }),
  );

  // A person's decision that MT5 never made the deal. Only after ten minutes, and only when a search made
  // now finds nothing; settled exactly as the resolver gives up on one (a transfer to MT5 gives the money back).
  router.post(
    "/:id/fail",
    requirePermission("wallet.view", "wallet.reconcile"),
    stepUp,
    handler(async (req, res) => {
      const { note } = parse(failBody, req.body ?? {});
      const staff = staffOf(req);
      const id = parse(moneyId, req.params.id);
      const o = await loadVisible(db, staff, id);
      if (!isOpen(o)) throw conflict(SETTLED);
      let outcome;
      try {
        outcome = await failBalanceOpByStaff(db, gateway(), o.id, { staffId: staff.id, note }, (conn, op) =>
          writeAudit(conn, ctx(req), {
            action: "mt5.operation.failed", entityType: "client", entityId: op.client_id,
            before: { status: o.status }, after: { status: op.status },
            meta: { opId: op.id, reference: op.reference, purpose: op.purpose, accountId: op.mt5_account_id, login: op.login, amountCents: op.amount_cents, internalNote: note },
          }),
        log);
      } catch (error) {
        throw error instanceof GatewayError ? staffMt5Error(error) : error;
      }
      if (!outcome.done) {
        if (outcome.reason === "settled") throw conflict(SETTLED);
        if (outcome.reason === "too_new") throw conflict("Wait until the operation is at least ten minutes old: MT5 may still be making the deal.");
        const d = outcome.deal!;
        throw new HttpError(
          409,
          "MT5_DEAL_FOUND",
          `MT5 has a deal with this reference (ticket ${d.ticket}), so it cannot be marked failed. Use Check now to settle it, or look at the deal in MT5 if it does not match.`,
          { ticket: d.ticket, action: d.action, amountCents: d.profitCents, expectedCents: signedCents(outcome.op) },
        );
      }
      res.json(await operationPage(staff, id));
    }),
  );

  return router;
}
