import { describe, expect, it } from "vitest";
import type { BalanceOpRow, BalancePurpose, OpStatus } from "../src/server/mt5/operations";
import { evaluateOp, SETTLE_SLACK_MS, UNSETTLED_MS, type CachedDeal, type OpAccount } from "../src/server/mt5/reconcile";

// The comparison of one balance operation with its cached deals, without a
// database: when it is a match, when it is an issue, and when it is too soon
// to say.

const MINUTE = 60_000;
const NOW = Date.parse("2026-10-18T02:30:00.000Z");
const REF = "BIS-SABCD2345";

function op(o: { purpose?: BalancePurpose; status?: OpStatus; amount?: number; ticket?: number | null; createdAgo?: number; completedAgo?: number; approvedAgo?: number } = {}): BalanceOpRow {
  const status = o.status ?? "completed";
  const created = new Date(NOW - (o.createdAgo ?? 3 * 60 * MINUTE));
  return {
    id: 42, reference: REF, purpose: o.purpose ?? "staff_balance_in", client_id: 7, mt5_account_id: 9, server_code: "live", login: 500_123,
    amount_cents: o.amount ?? 25_000, status, mt5_ticket: o.ticket === undefined ? (status === "completed" ? 9_000_111 : null) : o.ticket,
    failure: status === "failed" ? "no_money" : status === "unknown" ? "timeout" : null, client_message: null, checks: 0, next_check_at: null, resolved_by: null,
    resolved_note: null, requested_ip: "", requested_by: 3, reason_code: "bonus", staff_note: "Promised bonus", approved_by: null,
    approved_at: o.approvedAgo === undefined ? null : new Date(NOW - o.approvedAgo), decided_note: null, created_at: created, updated_at: created,
    completed_at: status === "completed" ? new Date(NOW - (o.completedAgo ?? 2 * 60 * MINUTE)) : null,
  };
}

function deal(d: Partial<CachedDeal> = {}): CachedDeal {
  return { server: "live", ticket: 9_000_111, login: 500_123, action: 2, amountCents: 25_000, comment: REF, timeUtc: new Date(NOW - 2 * 60 * MINUTE), ...d };
}

/** Live, with deals cached to `ago` before now (default: now). */
const account = (ago = 0, demo = false): OpAccount => ({ is_demo: demo ? 1 : 0, deals_synced_until: new Date(NOW - ago) });
const kinds = (v: ReturnType<typeof evaluateOp>) => v.findings.map((f) => `${f.kind}:${f.severity}`);

describe("evaluateOp", () => {
  it("a completed operation with its own deal is a match, done with for good", () => {
    const v = evaluateOp(op(), account(), [deal()], NOW);
    expect(v.findings).toEqual([]);
    expect(v.cleared).toEqual(expect.arrayContaining(["op_without_deal:42", "unsettled_op:42", "failed_op_has_deal:42"]));
    expect(v.check).toEqual({ outcome: "matched", tickets: [9_000_111] });
  });

  it("matches each purpose's action and sign: credit is action 3, money out is negative", () => {
    expect(evaluateOp(op({ purpose: "staff_credit_in" }), account(), [deal({ action: 3 })], NOW).check?.outcome).toBe("matched");
    expect(evaluateOp(op({ purpose: "staff_credit_out" }), account(), [deal({ action: 3, amountCents: -25_000 })], NOW).check?.outcome).toBe("matched");
    expect(evaluateOp(op({ purpose: "mt5_to_wallet" }), account(), [deal({ amountCents: -25_000 })], NOW).check?.outcome).toBe("matched");
  });

  it("a completed operation without a deal is critical only once the cache is complete to an hour past it", () => {
    // Completed 2 hours ago; the cache is complete to 59 minutes after that: too soon to say.
    const early = evaluateOp(op(), account(2 * 60 * MINUTE - SETTLE_SLACK_MS + MINUTE), [], NOW);
    expect(early).toEqual({ findings: [], cleared: expect.any(Array), check: null });
    expect(early.cleared).not.toContain("op_without_deal:42");
    // Not synced at all, or no account row: too soon too.
    expect(evaluateOp(op(), { is_demo: 0, deals_synced_until: null }, [], NOW).findings).toEqual([]);
    expect(evaluateOp(op(), undefined, [], NOW).findings).toEqual([]);
    const late = evaluateOp(op(), account(2 * 60 * MINUTE - SETTLE_SLACK_MS), [], NOW);
    expect(kinds(late)).toEqual(["op_without_deal:critical"]);
    expect(late.findings[0]).toMatchObject({ key: "op_without_deal:42", accountId: 9, clientId: 7, opId: 42, dealTicket: null });
    expect(late.findings[0]!.details).toMatchObject({ reference: REF, expected: { server: "live", login: 500_123, action: 2, amountCents: 25_000 } });
    // An operation with an issue is looked at again each run.
    expect(late.check).toBeNull();
  });

  it("on a demo account the same problems are warnings, never critical", () => {
    expect(kinds(evaluateOp(op({ purpose: "demo_funding" }), account(0, true), [], NOW))).toEqual(["op_without_deal:warning"]);
    expect(kinds(evaluateOp(op({ purpose: "demo_topup", status: "failed" }), account(0, true), [deal()], NOW))).toEqual(["failed_op_has_deal:warning"]);
  });

  it("a deal with its reference that is not its own is a mismatch, saying why", () => {
    const reason = (d: Partial<CachedDeal>, o = op()) => evaluateOp(o, account(), [deal({ ticket: 9_000_222, ...d })], NOW).findings.map((f) => [f.kind, f.details.reason]);
    expect(reason({ amountCents: 24_999 })).toEqual([["deal_mismatch", "amount"]]);
    expect(reason({ amountCents: -25_000 })).toEqual([["deal_mismatch", "sign"]]);
    expect(reason({ action: 3 })).toEqual([["deal_mismatch", "action"]]);
    expect(reason({ login: 500_124 })).toEqual([["deal_mismatch", "account"]]);
    expect(reason({ server: "demo" })).toEqual([["deal_mismatch", "account"]]);
    // MT5's ticket for the operation, under another comment.
    expect(reason({ ticket: 9_000_111, comment: "manual" })).toEqual([["deal_mismatch", "comment"]]);
    const v = evaluateOp(op(), account(), [deal({ ticket: 9_000_222, amountCents: 1 })], NOW);
    expect(v.findings[0]).toMatchObject({ key: "deal_mismatch:live:9000222", severity: "critical", dealTicket: 9_000_222, opId: 42 });
    // A wrong deal is not also "no deal".
    expect(v.findings).toHaveLength(1);
  });

  it("a second deal for one reference is money moved twice", () => {
    const v = evaluateOp(op(), account(), [deal({ ticket: 9_000_333 }), deal()], NOW);
    expect(v.findings.map((f) => [f.key, f.details.reason])).toEqual([["deal_mismatch:live:9000333", "duplicate"]]);
    expect(v.check).toBeNull();
  });

  it("its own deal under another ticket than MT5 answered, that ticket not cached, is a mismatch", () => {
    const v = evaluateOp(op({ ticket: 9_000_999 }), account(), [deal()], NOW);
    expect(v.findings.map((f) => [f.key, f.details.reason])).toEqual([["deal_mismatch:live:9000111", "ticket"]]);
  });

  it("compares references exactly: the same letters in another case are another comment", () => {
    const v = evaluateOp(op(), account(2 * 60 * MINUTE - SETTLE_SLACK_MS), [deal({ comment: REF.toLowerCase(), ticket: 9_000_444 })], NOW);
    expect(kinds(v)).toEqual(["op_without_deal:critical"]);
  });

  it("a failed or cancelled operation must have no deal", () => {
    const failed = evaluateOp(op({ status: "failed" }), account(), [], NOW);
    expect(failed.findings).toEqual([]);
    expect(failed.check).toEqual({ outcome: "no_deal", tickets: [] });
    expect(failed.cleared).toContain("failed_op_has_deal:42");
    const paid = evaluateOp(op({ status: "failed" }), account(), [deal()], NOW);
    expect(kinds(paid)).toEqual(["failed_op_has_deal:critical"]);
    expect(paid.findings[0]).toMatchObject({ dealTicket: 9_000_111, details: { failure: "no_money", deals: [expect.objectContaining({ ticket: 9_000_111, amountCents: 25_000 })] } });
    expect(paid.check).toBeNull();
    expect(kinds(evaluateOp(op({ status: "cancelled" }), account(), [deal()], NOW))).toEqual(["failed_op_has_deal:critical"]);
  });

  it("a change waiting for approval was never sent: a deal for it is critical, and waiting over an hour is a warning", () => {
    const fresh = evaluateOp(op({ status: "awaiting_approval", createdAgo: 30 * MINUTE }), account(), [], NOW);
    expect(fresh).toMatchObject({ findings: [], check: null });
    expect(fresh.cleared).toContain("unsettled_op:42");
    expect(kinds(evaluateOp(op({ status: "awaiting_approval", createdAgo: UNSETTLED_MS + MINUTE }), account(), [], NOW))).toEqual(["unsettled_op:warning"]);
    expect(kinds(evaluateOp(op({ status: "awaiting_approval", createdAgo: 30 * MINUTE }), account(), [deal()], NOW))).toEqual(["failed_op_has_deal:critical"]);
  });

  it("an operation still sending or unknown is a warning after an hour from when it was let go, never a missing deal", () => {
    expect(evaluateOp(op({ status: "unknown", createdAgo: 30 * MINUTE }), account(), [], NOW)).toMatchObject({ findings: [], check: null });
    // Asked for long ago but approved 30 minutes ago: let go 30 minutes ago.
    expect(evaluateOp(op({ status: "sending", createdAgo: 5 * 60 * MINUTE, approvedAgo: 30 * MINUTE }), account(), [], NOW).findings).toEqual([]);
    const stuck = evaluateOp(op({ status: "unknown", createdAgo: 2 * 60 * MINUTE }), account(), [deal({ ticket: 9_000_555 })], NOW);
    expect(kinds(stuck)).toEqual(["unsettled_op:warning"]);
    expect(stuck.findings[0]!.details).toMatchObject({ failure: "timeout", mt5HasDeal: true });
    expect(stuck.check).toBeNull();
    expect(kinds(evaluateOp(op({ status: "sending", createdAgo: 30 * MINUTE }), account(), [deal({ amountCents: 5 })], NOW))).toEqual(["deal_mismatch:critical"]);
  });

  it("the facts it reports do not change between runs unless the operation or its deals do", () => {
    const a = evaluateOp(op(), account(2 * 60 * MINUTE - SETTLE_SLACK_MS), [], NOW);
    const b = evaluateOp(op(), account(0), [], NOW + 24 * 60 * MINUTE);
    expect(b.findings[0]!.details).toEqual(a.findings[0]!.details);
  });
});
