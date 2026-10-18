import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { NOT_PLAIN } from "@shared/money";
import type { Mt5Account } from "../../../gateway/protocol";
import type { AppDeps } from "../../app";
import { clientName } from "../../clients/model";
import { auditContext, auditStandalone, writeAudit } from "../../lib/audit";
import { one, rows, type Conn, type Db } from "../../lib/db";
import { conflict, handler, HttpError, notFound, parse } from "../../lib/http";
import { likeTerm, listQuery, toPage } from "../../lib/pagination";
import { money } from "../../money/amounts";
import { clientScope, moneyId } from "../../money/review";
import { loadAccount, withAccountLock, writeSnapshot, type AccountRow } from "../../mt5/accounts";
import { callMt5, staffMt5Error } from "../../mt5/errors";
import { GatewayError, type Mt5Gateway } from "../../mt5/gateway";
import {
  approveStaffOp, cancelStaffOp, dealAction, isStaffPurpose, opFromDb, PURPOSES, runBalanceOp, SELECT_OP, sentAt, signedCents, staffChangeMeta,
  STAFF_PURPOSES, type BalanceOpRow, type StaffPurpose,
} from "../../mt5/operations";
import { checkBalanceOpDetailed, failBalanceOpByStaff, GIVE_UP_AGE_MS, STUCK_MS } from "../../mt5/resolver";
import { loadMt5Settings } from "../../mt5/settings";
import { withdrawableCents } from "../../mt5/transfers";
import { requirePermission, requireStepUp, staffActor, staffOf, type StaffContext } from "../../staff/session";

// MT5 balance operations for staff: wallet transfers, demo funding and staff
// balance and credit changes, with what is still open after a lost MT5
// answer. Staff can run the resolver's search now ("Check now"), or mark an
// operation failed when it was let go to MT5 at least ten minutes ago and a
// search made now does not find its deal in MT5. Nobody can mark one
// completed: only a deal found in MT5 does that.
//
// A staff change waiting for a second person is approved here (mt5.balance.adjust
// and a fresh 2FA code, never by the person who asked for it, with the limits
// checked again on MT5's figures now) and then sent at once, or rejected (the
// requester may cancel their own). What staff/mt5-adjustments.ts needs to ask
// for a change is exported from here too.

const NOT_FOUND = "That MT5 operation does not exist or its client is not assigned to you.";
const SETTLED = "This operation is already settled.";
const NOT_A_CHANGE = "Only staff balance and credit changes are approved or rejected.";
const NOT_AWAITING = "This change is no longer waiting for approval.";
const SAME_PERSON = "You asked for this change, so another person must approve it.";
const BUSY = "Another operation on this account is still being processed. Try again once it has settled.";
const CLOSED = "This client's account is closed, so their MT5 balance and credit cannot change.";

/** Every purpose, and "staff" for the four staff changes together. */
const PURPOSES_FILTER = ["wallet_to_mt5", "mt5_to_wallet", "demo_funding", "demo_topup", ...STAFF_PURPOSES, "staff"] as const;
const STATUSES = {
  all: [],
  open: ["sending", "unknown"],
  sending: ["sending"],
  unknown: ["unknown"],
  completed: ["completed"],
  failed: ["failed"],
  awaiting_approval: ["awaiting_approval"],
  cancelled: ["cancelled"],
} as const;

const note = (required: boolean) => {
  const text = z
    .string({ required_error: "Write a note saying what you checked", invalid_type_error: "Write a note saying what you checked" })
    .trim()
    .max(500, "Keep the note under 500 characters")
    .refine((v) => !NOT_PLAIN.test(v), "Write the note as plain text, without links or symbols like < > { }");
  return required ? text.refine((v) => v.length >= 10, "Write a note saying what you checked (at least 10 characters)") : text;
};
const failBody = z.object({ note: note(true) }).strict();
const rejectBody = z.object({ note: note(true) }).strict();
const approveBody = z.object({ note: note(false).optional().transform((v) => v || null) }).strict();

type StaffOpRow = BalanceOpRow & {
  first_name: string;
  last_name: string;
  email: string;
  is_demo: number;
  account_status: string;
  archived_at: Date | null;
  suspended_at: Date | null;
  resolved_by_name: string | null;
  requested_by_name: string | null;
  approved_by_name: string | null;
};

const SELECT_STAFF_OP = SELECT_OP.replace(
  "FROM mt5_balance_ops o",
  `, c.first_name, c.last_name, c.email, a.is_demo, a.status AS account_status, a.archived_at, a.suspended_at, rb.name AS resolved_by_name,
     rq.name AS requested_by_name, ap.name AS approved_by_name
   FROM mt5_balance_ops o JOIN clients c ON c.id = o.client_id JOIN mt5_accounts a ON a.id = o.mt5_account_id LEFT JOIN staff_users rb ON rb.id = o.resolved_by
   LEFT JOIN staff_users rq ON rq.id = o.requested_by LEFT JOIN staff_users ap ON ap.id = o.approved_by`,
);

/** opFromDb keeps the joined columns. */
const fromDb = (o: StaffOpRow) => opFromDb(o) as StaffOpRow;
const iso = (d: Date | null) => d?.toISOString() ?? null;
const person = (id: number | null, name: string | null) => (id === null ? null : { id, name: name ?? "" });
const isOpen = (o: BalanceOpRow) => o.status === "sending" || o.status === "unknown";
/** Still in its own request's hands: a search now could only find nothing yet. */
const inFlight = (o: BalanceOpRow) => o.status === "sending" && Date.now() - o.updated_at.getTime() < STUCK_MS;
const usd = (cents: number) => money(cents, "USD");

/**
 * One operation as staff see it. A staff change also carries `change`: what
 * kind of deal it is, why and by whom it was asked for, who approved or
 * rejected it, and whether this staff member may approve or reject it now
 * (never their own approval, as the server refuses it).
 */
function presentOp(o: StaffOpRow, viewer: StaffContext) {
  const awaiting = o.status === "awaiting_approval";
  const mayDecide = awaiting && viewer.permissions.has("mt5.balance.adjust");
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
    resolvedBy: person(o.resolved_by, o.resolved_by_name),
    resolvedNote: o.resolved_note,
    createdAt: o.created_at.toISOString(),
    updatedAt: o.updated_at.toISOString(),
    completedAt: iso(o.completed_at),
    canCheck: isOpen(o) && !inFlight(o),
    canFail: isOpen(o) && Date.now() - sentAt(o).getTime() >= GIVE_UP_AGE_MS,
    ...(isStaffPurpose(o.purpose)
      ? {
          change: {
            deal: PURPOSES[o.purpose].deal,
            dealAction: dealAction(o),
            reasonCode: o.reason_code,
            note: o.staff_note,
            requestedBy: person(o.requested_by, o.requested_by_name),
            approvedBy: person(o.approved_by, o.approved_by_name),
            approvedAt: iso(o.approved_at),
            decidedNote: o.decided_note,
            /** Ran on the requester's word alone (at or under the second-approval amount). */
            ranAtOnce: o.approved_by === null && !awaiting && o.status !== "cancelled",
            canApprove: mayDecide && o.requested_by !== viewer.id,
            canReject: mayDecide,
          },
        }
      : {}),
  };
}

/** An operation of a client this staff member may see, or 404. */
async function loadVisible(conn: Conn, staff: StaffContext, id: number): Promise<StaffOpRow> {
  const s = clientScope(staff);
  const o = await one<StaffOpRow>(conn, `${SELECT_STAFF_OP} WHERE o.id = ?${s.sql}`, [id, ...s.params]);
  if (!o) throw notFound(NOT_FOUND);
  return fromDb(o);
}

/** The operation with the ledger transactions it made (none for demo money or credit, and none yet for an open transfer from MT5). */
export async function operationPage(db: Db, staff: StaffContext, id: number) {
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
  return { operation: presentOp(o, staff), ledger };
}

/** Why MT5 or the gateway said no to a staff change, as staff read it. */
function refusedChange(failure: string | null, details: Record<string, unknown>): HttpError {
  if (failure === "unavailable") return new HttpError(422, "MT5_UNAVAILABLE", "MT5 could not be reached, so nothing was changed. Ask for the change again.", details);
  if (failure === "bad_request") return new HttpError(400, "MT5_BAD_REQUEST", "The MT5 gateway would not accept this change, so nothing was changed.", details);
  if (failure === "no_money") return new HttpError(422, "MT5_REFUSED", "MT5 refused: the account does not have the money, credit or free margin for this.", details);
  if (failure === "over_limit") return new HttpError(422, "MT5_REFUSED", "The MT5 gateway refused: this is over its limit for one operation, or for the day.", details);
  return new HttpError(422, "MT5_REFUSED", `MT5 refused this change (${failure ?? "refused"}).`, details);
}

/**
 * The answer to a staff change once it has run (or was only written): its
 * page with `done` (200, or 201 for a new one) when MT5 made it or it waits
 * for approval, 202 when MT5's answer was lost (the resolver settles it), and
 * the refusal when MT5 definitely did not make it.
 */
export async function answerChange(res: Response, db: Db, staff: StaffContext, op: BalanceOpRow, created: boolean) {
  const page = await operationPage(db, staff, op.id);
  if (op.status === "failed") throw refusedChange(op.failure, { operationId: op.id, reference: op.reference, failure: op.failure });
  res.status(op.status === "sending" || op.status === "unknown" ? 202 : created ? 201 : 200).json(page);
}

/** The gateway, when MT5 is on and the account's server is switched on in the CRM. */
export async function gatewayFor(db: Db, mt5: Mt5Gateway | null, server: string): Promise<Mt5Gateway> {
  if (!mt5) throw new HttpError(422, "MT5_OFF", "MT5 is not connected: CRM_MT5_GATEWAY_URL is not set on this server.");
  const row = await one<{ is_enabled: number }>(db, "SELECT is_enabled FROM mt5_servers WHERE code = ?", [server]);
  if (row?.is_enabled !== 1) throw new HttpError(422, "MT5_SERVER_OFF", "This MT5 server is switched off. Switch it on in the MT5 settings first.");
  return mt5;
}

/** A live account open in MT5 whose client is not closed: the only kind a staff change may touch. */
export async function assertChangeable(db: Db, a: AccountRow | undefined): Promise<AccountRow & { login: number }> {
  if (!a || a.status !== "active" || a.login === null) throw conflict("This account is not open in MT5.");
  if (a.is_demo === 1) throw conflict("Balance and credit changes are for live accounts only.");
  const client = await one<{ status: string }>(db, "SELECT status FROM clients WHERE id = ?", [a.client_id]);
  if (client?.status === "closed") throw conflict(CLOSED);
  return a as AccountRow & { login: number };
}

/** How long a staff change waits for the account's figures from MT5. */
const FIGURES_BUDGET_MS = 5_000;

/** The account's figures from MT5 now (saved as its snapshot), or the reason, for staff, that they could not be read. */
async function liveFigures(db: Db, gateway: Mt5Gateway, a: AccountRow & { login: number }, log: AppDeps["log"]): Promise<Mt5Account> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), FIGURES_BUDGET_MS)));
  let res: { accounts: Mt5Account[]; missing: number[] } | null;
  try {
    res = await Promise.race([callMt5(gateway, "accounts.get", { server: a.server_code, logins: [a.login] }, log), late]);
  } catch (error) {
    throw error instanceof GatewayError ? staffMt5Error(error) : error;
  } finally {
    clearTimeout(timer);
  }
  if (!res) throw new HttpError(422, "MT5_UNAVAILABLE", "MT5 did not answer in time, so the account's figures could not be checked.");
  const figures = res.accounts.find((f) => f.login === a.login);
  if (!figures) throw new HttpError(422, "MT5_UNAVAILABLE", "MT5 does not know this login, or the gateway no longer allows its group.");
  await writeSnapshot(db, a.id, figures);
  return figures;
}

/**
 * The limits a staff change keeps, checked when it is asked for and again
 * when it is approved, on MT5's figures as they are then: at most the MT5
 * transfer limit; balance taken out at most what the account could
 * withdraw (never its credit, never the margin its trades use); credit taken
 * out at most the credit it has.
 */
export async function checkChangeLimits(db: Db, gateway: Mt5Gateway, a: AccountRow & { login: number }, purpose: StaffPurpose, amountCents: number, log: AppDeps["log"]) {
  const settings = await loadMt5Settings(db);
  if (amountCents > settings.maxTransferCents) {
    throw new HttpError(422, "OVER_LIMIT", `One change can be at most ${usd(settings.maxTransferCents)}, the MT5 transfer limit in the MT5 settings.`);
  }
  if (purpose !== "staff_balance_out" && purpose !== "staff_credit_out") return;
  const figures = await liveFigures(db, gateway, a, log);
  if (purpose === "staff_balance_out") {
    const most = withdrawableCents(figures);
    if (amountCents > most) {
      throw new HttpError(422, "OVER_WITHDRAWABLE", `At most ${usd(most)} can be taken from this account now: its balance, less its credit and the margin its open trades use.`, {
        withdrawableCents: most,
      });
    }
  } else if (amountCents > figures.creditCents) {
    throw new HttpError(422, "OVER_CREDIT", `This account has ${usd(figures.creditCents)} of credit now.`, { creditCents: figures.creditCents });
  }
}

export function staffMt5OperationsRouter(deps: AppDeps): Router {
  const { db, config, log } = deps;
  const mt5 = deps.mt5 ?? null;
  const router = Router();
  const stepUp = requireStepUp(config);
  const ctx = (req: Request) => auditContext(req, staffActor(staffOf(req)));

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
          purpose: optional(z.enum(PURPOSES_FILTER)),
          clientId: optional(moneyId),
          accountId: optional(moneyId),
        }),
        req.query,
      );
      const staff = staffOf(req);
      const s = clientScope(staff);
      let clause = ` WHERE 1 = 1${s.sql}`;
      const params: unknown[] = [...s.params];
      const statuses: readonly string[] = STATUSES[query.status];
      if (statuses.length) (clause += ` AND o.status IN (${statuses.map(() => "?").join(", ")})`), params.push(...statuses);
      const purposes: readonly string[] = query.purpose === "staff" ? STAFF_PURPOSES : query.purpose ? [query.purpose] : [];
      if (purposes.length) (clause += ` AND o.purpose IN (${purposes.map(() => "?").join(", ")})`), params.push(...purposes);
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
      res.json(toPage(items.map(fromDb).map((o) => presentOp(o, staff)), Number(total?.n ?? 0), query.page, query.pageSize));
    }),
  );

  router.get(
    "/:id",
    requirePermission("wallet.view"),
    handler(async (req, res) => {
      res.json(await operationPage(db, staffOf(req), parse(moneyId, req.params.id)));
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
      const page = await operationPage(db, staff, id);
      res.json({
        result,
        // Why MT5 could not be searched, in MT5's words (staff only).
        searchError: error ? { kind: error.kind, code: error.code, message: error.message } : null,
        ...page,
      });
    }),
  );

  // A person's decision that MT5 never made the deal. Only ten minutes after it was let go to MT5, and only when a
  // search made now finds nothing; settled exactly as the resolver gives up on one (a transfer to MT5 gives the money back).
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
          { ticket: d.ticket, action: d.action, amountCents: d.profitCents, expectedCents: signedCents(outcome.op), expectedAction: dealAction(outcome.op) },
        );
      }
      res.json(await operationPage(db, staff, id));
    }),
  );

  /** A staff change of a client this staff member may see, still waiting for a decision. */
  async function awaitingChange(staff: StaffContext, id: number) {
    const o = await loadVisible(db, staff, id);
    if (!isStaffPurpose(o.purpose)) throw conflict(NOT_A_CHANGE);
    if (o.status !== "awaiting_approval") throw conflict(NOT_AWAITING);
    return o as StaffOpRow & { purpose: StaffPurpose };
  }

  // The second person's yes: the limits again on MT5's figures now, then the change is let go to MT5, once.
  router.post(
    "/:id/approve",
    requirePermission("mt5.balance.adjust"),
    stepUp,
    handler(async (req, res) => {
      const { note } = parse(approveBody, req.body ?? {});
      const staff = staffOf(req);
      const o = await awaitingChange(staff, parse(moneyId, req.params.id));
      // Checked by person, not by session: another sign-in of the same staff member is still them.
      if (o.requested_by === staff.id) throw new HttpError(403, "SAME_PERSON", SAME_PERSON);
      const settled = await withAccountLock(o.mt5_account_id, async () => {
        const a = await assertChangeable(db, await loadAccount(db, o.mt5_account_id));
        const gw = await gatewayFor(db, mt5, a.server_code);
        await checkChangeLimits(db, gw, a, o.purpose, o.amount_cents, log);
        const decision = await approveStaffOp(db, o.id, { staffId: staff.id, note }, (conn, op) =>
          writeAudit(conn, ctx(req), {
            action: "mt5.adjustment.approved", entityType: "client", entityId: op.client_id,
            before: { status: "awaiting_approval" }, after: { status: op.status }, meta: { ...staffChangeMeta(op), internalNote: note },
          }),
        );
        if (!decision.done) {
          if (decision.reason === "same_person") throw new HttpError(403, "SAME_PERSON", SAME_PERSON);
          if (decision.reason === "busy") throw conflict(BUSY);
          if (decision.reason === "closed") throw conflict(CLOSED);
          throw conflict(NOT_AWAITING);
        }
        try {
          return await runBalanceOp({ db, mt5: gw, log }, o.id);
        } catch (error) {
          // Not MT5's answer (a fault on this side after the call): the operation stays as it is for the resolver.
          log.error({ err: error, opId: o.id }, "Running an approved MT5 staff change failed");
          return (await loadVisible(db, staff, o.id)) as BalanceOpRow;
        }
      });
      await answerChange(res, db, staff, settled, false);
    }),
  );

  // A no. Anyone with mt5.balance.adjust may reject a change; the requester rejecting their own cancels it.
  router.post(
    "/:id/reject",
    requirePermission("mt5.balance.adjust"),
    handler(async (req, res) => {
      const { note } = parse(rejectBody, req.body ?? {});
      const staff = staffOf(req);
      const o = await awaitingChange(staff, parse(moneyId, req.params.id));
      const own = o.requested_by === staff.id;
      const decision = await cancelStaffOp(db, o.id, { staffId: staff.id, note }, (conn, op) =>
        writeAudit(conn, ctx(req), {
          action: own ? "mt5.adjustment.cancelled" : "mt5.adjustment.rejected", entityType: "client", entityId: op.client_id,
          before: { status: "awaiting_approval" }, after: { status: op.status }, meta: { ...staffChangeMeta(op), internalNote: note },
        }),
      );
      if (!decision.done) throw conflict(NOT_AWAITING);
      res.json(await operationPage(db, staff, o.id));
    }),
  );

  return router;
}
