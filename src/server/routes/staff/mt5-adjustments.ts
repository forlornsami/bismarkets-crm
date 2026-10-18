import { Router, type Request } from "express";
import { z } from "zod";
import { NOT_PLAIN } from "@shared/money";
import type { AppDeps } from "../../app";
import { lockClient } from "../../clients/kyc";
import { auditContext, writeAudit } from "../../lib/audit";
import { one, transaction, type Conn } from "../../lib/db";
import { conflict, handler, notFound, parse } from "../../lib/http";
import { MAX_AMOUNT_MINOR } from "../../money/amounts";
import { clientScope, moneyId } from "../../money/review";
import { accountFromDb, loadAccount, SELECT_ACCOUNT, withAccountLock, type AccountRow } from "../../mt5/accounts";
import {
  insertBalanceOp, loadOp, REASON_CODES, runBalanceOp, STAFF_PURPOSES, staffChangeMeta, type BalanceOpRow, type StaffPurpose,
} from "../../mt5/operations";
import { loadMt5Settings } from "../../mt5/settings";
import { requirePermission, requireStepUp, staffActor, staffOf, type StaffContext } from "../../staff/session";
import { answerChange, assertChangeable, checkChangeLimits, gatewayFor } from "./mt5-operations";

// Staff balance and credit changes to a client's live MT5 account: money or
// credit in or out, for compensation, a correction, a bonus, a chargeback, a
// fee refund or another written reason. Asking needs mt5.balance.adjust and a
// fresh 2FA code; the limits are checked on MT5's figures now. A second
// person then approves it (staff/mt5-operations.ts), unless the MT5 settings
// let changes this small run on one person's word: then it is sent at once,
// as long as what that person ran alone in the last 24 hours stays within
// the same amount (so one large change cannot be split into small ones).
// Balance changes post to the ledger when MT5 has made them; credit does not
// (it is the broker's money lent, not the client's). The client is told
// once the change is made, and never sees it among their transfers.

const NOT_FOUND = "That MT5 account does not exist or its client is not assigned to you.";
const BUSY = "Another operation on this account is still being processed. Try again once it has settled.";
const CLOSED = "This client's account is closed, so their MT5 balance and credit cannot change.";
/** The same change asked for again this soon by the same person is the first one again (a double click). */
const REPEAT_SECONDS = 30;

const KIND_PURPOSE = {
  balance_in: "staff_balance_in",
  balance_out: "staff_balance_out",
  credit_in: "staff_credit_in",
  credit_out: "staff_credit_out",
} as const satisfies Record<string, StaffPurpose>;

const adjustmentBody = z
  .object({
    kind: z.enum(["balance_in", "balance_out", "credit_in", "credit_out"], {
      errorMap: () => ({ message: "Choose balance in, balance out, credit in or credit out" }),
    }),
    amountCents: z
      .number({ required_error: "Enter the amount in cents", invalid_type_error: "Enter the amount in cents, as a whole number" })
      .int("Enter the amount in cents, as a whole number")
      .positive("The amount must be more than zero")
      .max(MAX_AMOUNT_MINOR, "This amount is too large"),
    reasonCode: z.enum(REASON_CODES, { errorMap: () => ({ message: "Choose the reason for this change" }) }),
    note: z
      .string({ required_error: "Write a note saying why", invalid_type_error: "Write a note saying why" })
      .trim()
      .min(10, "Write a note saying why (at least 10 characters)")
      .max(500, "Keep the note under 500 characters")
      .refine((v) => !NOT_PLAIN.test(v), "Write the note as plain text, without links or symbols like < > { }"),
  })
  .strict();

const staffList = STAFF_PURPOSES.map(() => "?").join(", ");

/**
 * What this person has already run on their own word (no second person) in
 * the last 24 hours, in and out, balance and credit, on any account: changes
 * not yet known to have failed count.
 */
async function ranAloneToday(conn: Conn, staffId: number): Promise<number> {
  const r = await one<{ n: number | string | null }>(
    conn,
    `SELECT COALESCE(SUM(amount_cents), 0) AS n FROM mt5_balance_ops
     WHERE requested_by = ? AND approved_by IS NULL AND purpose IN (${staffList}) AND status IN ('sending', 'unknown', 'completed')
       AND created_at > CURRENT_TIMESTAMP(3) - INTERVAL 1 DAY`,
    [staffId, ...STAFF_PURPOSES],
  );
  return Number(r?.n ?? 0);
}

/**
 * The same change from the same person in the last 30 seconds, if any. One
 * that was cancelled or definitely not made is not repeated: asking again is
 * a new try, which can never make the change twice.
 */
async function repeatOf(conn: Conn, staffId: number, purpose: StaffPurpose, accountId: number, cents: number): Promise<number | null> {
  const r = await one<{ id: number }>(
    conn,
    `SELECT id FROM mt5_balance_ops WHERE requested_by = ? AND purpose = ? AND mt5_account_id = ? AND amount_cents = ? AND status NOT IN ('cancelled', 'failed')
       AND created_at > CURRENT_TIMESTAMP(3) - INTERVAL ${REPEAT_SECONDS} SECOND
     ORDER BY id DESC LIMIT 1`,
    [staffId, purpose, accountId, cents],
  );
  return r ? Number(r.id) : null;
}

export function staffMt5AdjustmentsRouter(deps: AppDeps): Router {
  const { db, config, log } = deps;
  const mt5 = deps.mt5 ?? null;
  const router = Router();
  const stepUp = requireStepUp(config);
  const ctx = (req: Request) => auditContext(req, staffActor(staffOf(req)));

  /** An account of a client this staff member may see, or 404. */
  async function loadVisible(conn: Conn, staff: StaffContext, id: number): Promise<AccountRow> {
    const s = clientScope(staff);
    const a = await one<AccountRow>(conn, `${SELECT_ACCOUNT} JOIN clients c ON c.id = a.client_id WHERE a.id = ?${s.sql}`, [id, ...s.params]);
    if (!a) throw notFound(NOT_FOUND);
    return accountFromDb(a);
  }

  router.post(
    "/:id/adjustments",
    requirePermission("mt5.balance.adjust"),
    stepUp,
    handler(async (req, res) => {
      const body = parse(adjustmentBody, req.body ?? {});
      const staff = staffOf(req);
      const id = parse(moneyId, req.params.id);
      const purpose = KIND_PURPOSE[body.kind];
      const first = await loadVisible(db, staff, id);

      const started = await withAccountLock(first.id, async () => {
        // Read again once it is this change's turn on the account.
        const a = await assertChangeable(db, await loadVisible(db, staff, id));
        const gateway = await gatewayFor(db, mt5, a.server_code);

        // Before MT5 is read: a double click on a change that already took money out would otherwise be refused for want of it.
        const earlier = await repeatOf(db, staff.id, purpose, a.id, body.amountCents);
        if (earlier) return { opId: earlier, atOnce: false, repeat: true };

        await checkChangeLimits(db, gateway, a, purpose, body.amountCents, log);

        const written = await transaction(db, async (conn) => {
          await lockClient(conn, a.client_id);
          // Then this person's row, before the first plain read: two of their changes at once count against their
          // 24 hours one after the other. Never before the client's row: their approval or settle on this client
          // holds that one and then needs this one, so the other order deadlocks.
          await one(conn, "SELECT id FROM staff_users WHERE id = ? FOR UPDATE", [staff.id]);
          const client = await one<{ status: string }>(conn, "SELECT status FROM clients WHERE id = ?", [a.client_id]);
          if (client?.status === "closed") throw conflict(CLOSED);
          const locked = await loadAccount(conn, a.id, true);
          if (!locked || locked.status !== "active" || locked.login !== a.login || locked.is_demo === 1) throw conflict("This account is not open in MT5.");
          // Checked again under the locks: two clicks at once both get here, one after the other.
          const again = await repeatOf(conn, staff.id, purpose, a.id, body.amountCents);
          if (again) return { opId: again, atOnce: false, repeat: true };

          const settings = await loadMt5Settings(conn);
          const threshold = settings.adjustSecondApprovalCents;
          const ranAlone = threshold > 0 && body.amountCents <= threshold ? await ranAloneToday(conn, staff.id) : 0;
          const atOnce = threshold > 0 && body.amountCents <= threshold && ranAlone + body.amountCents <= threshold;
          if (atOnce && (await one(conn, "SELECT id FROM mt5_balance_ops WHERE mt5_account_id = ? AND status IN ('sending', 'unknown') LIMIT 1", [a.id]))) {
            throw conflict(BUSY);
          }

          const { id: opId } = await insertBalanceOp(conn, {
            purpose, clientId: a.client_id, accountId: a.id, serverCode: a.server_code, login: a.login, amountCents: body.amountCents, ip: req.clientIp,
            staff: { requestedBy: staff.id, reasonCode: body.reasonCode, note: body.note, awaitingApproval: !atOnce },
          });
          const op = (await loadOp(conn, opId))!;
          await writeAudit(conn, ctx(req), {
            action: "mt5.adjustment.requested", entityType: "client", entityId: a.client_id,
            after: { status: op.status },
            meta: {
              ...staffChangeMeta(op), internalNote: body.note, secondApproval: !atOnce, secondApprovalOverCents: threshold,
              // Why a change under the amount still waits: what this person already ran alone today.
              ...(threshold > 0 && body.amountCents <= threshold ? { ranAloneTodayCents: ranAlone } : {}),
            },
          });
          return { opId, atOnce, repeat: false };
        });
        if (!written.atOnce) return written;

        try {
          await runBalanceOp({ db, mt5: gateway, log }, written.opId);
        } catch (error) {
          // Not MT5's answer (a fault on this side after the call): the operation stays as it is for the resolver.
          log.error({ err: error, opId: written.opId }, "Running an MT5 staff change failed");
        }
        return written;
      });

      const op = (await loadOp(db, started.opId)) as BalanceOpRow;
      await answerChange(res, db, staff, op, !started.repeat);
    }),
  );

  return router;
}
