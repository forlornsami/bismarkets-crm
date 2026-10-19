import { Banknote, CheckCircle2, Clock, Hourglass, Users } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import { CopyText, dayProblem, daysAgo, formatDay, KIND_LABEL, money, networkLabel, textProblem, today, useWithdrawalSummary, WithdrawalStatusBadge } from "../components/money";
import { HoldNotices, nothingLeft, queueTab, SendBack, useNextItem, type CanDo, type Claimer, type Person } from "../components/queue";
import {
  ClientCard,
  clientColumn,
  DecidedNotice,
  decidedLine,
  handledBy,
  handledByColumn,
  NextOnly,
  NotYet,
  positionText,
  ReviewFootnote,
  ReviewHistory,
  ReviewItemMissing,
  ReviewQueuePage,
  statusColumn,
  toldClient,
  useReviewItem,
  waitingColumn,
  type CardClient,
  type ListClient,
  type TrailItem,
} from "../components/review";
import { DocumentViewer, ReviewDecision, ReviewLayout, Waiting, Warnings, type ReviewFile, type ReviewWarning } from "../components/ReviewWorkbench";
import { Badge, Field, useFeedback } from "../components/ui";
import { ApiError, formatDate } from "../lib/api";
import { useCan, useSession } from "../lib/session";
import { moneyReasonProblem, WITHDRAWAL_CHECKLIST, WITHDRAWAL_REJECT_REASONS, type ChecklistItem, type WithdrawalStatus } from "../../shared/money";

type Stage = "review" | "second" | "pay";
type ClientState = "active" | "frozen" | "closed";
type KycState = "none" | "partial" | "pending" | "approved" | "rejected";

export interface WithdrawalItem {
  id: number;
  reference: string;
  clientId: number;
  clientName: string;
  clientEmail: string;
  clientStatus: ClientState;
  kycStatus: KycState;
  /** The client as every review queue lists them. */
  client?: ListClient & { country: string | null; status: ClientState };
  methodName: string;
  typeName: string;
  kind: "bank" | "crypto";
  network: string;
  amountCents: number;
  status: WithdrawalStatus;
  needsSecondApproval: boolean;
  firstReviewedBy: Person | null;
  approvedBy: Person | null;
  paidBy: Person | null;
  createdAt: string;
  approvedAt: string | null;
  paidAt: string | null;
  claimedBy: Claimer | null;
  destinationEnding: string | null;
  /** Who finished it (paid or rejected) and when. */
  decidedBy?: Person | null;
  decidedAt?: string | null;
  warningCount?: number;
}

interface WithdrawalDetail extends Omit<WithdrawalItem, "client"> {
  destination: {
    methodName: string;
    typeName: string;
    kind: "bank" | "crypto";
    network: string;
    accountName: string;
    accountNumber: string;
    iban: string | null;
    swift: string | null;
    hasQr: boolean;
    qrUrl: string | null;
    full: boolean;
  };
  checklist: { first: ChecklistItem[]; second: ChecklistItem[]; pay: ChecklistItem[] } | unknown;
  rejectReasons: string[];
  client: CardClient & { verifiedName: string };
  wallet: { availableCents: number; heldCents: number };
  history: {
    deposits: { approvedCount: number; approvedTotalCents: number; byMethod: { methodName: string; kind: "bank" | "crypto"; totalCents: number; lastAt: string | null }[] };
    withdrawals: { paidCount: number; paidTotalCents: number; recent: { id: number; reference: string; status: WithdrawalStatus; amountCents: number; createdAt: string }[] };
  };
  warnings: ReviewWarning[];
  stage: Stage | null;
  can: { approve: CanDo; secondApprove: CanDo; pay: CanDo; reject: CanDo; returnToReview: CanDo };
  payoutReference: string | null;
  paidOn: string | null;
  /** Why it needs a second approval (pending only); empty when one is enough. */
  secondApprovalReasons?: string[];
  rejectReason?: string | null;
  firstReviewedAt?: string | null;
  /** Where this withdrawal stands among those waiting at its step. */
  queue?: { pending: number; position: number };
  trail?: TrailItem[];
}

type Tab = "review" | "second_approval" | "to_pay" | "paid" | "rejected" | "all";
type Kind = "approve" | "second" | "pay" | "reject" | "return";
const OPEN = (s: WithdrawalStatus | undefined) => s === "pending" || s === "second_approval" || s === "approved";
const STAGE_WORD: Record<Stage, string> = { review: "reviews", second: "second approvals", pay: "payments" };
const STAGE_LABEL: Record<Stage, string> = { review: "Review", second: "Second approval", pay: "Payment" };
const START_LABEL: Record<Stage, string> = { review: "Start reviewing", second: "Start second approvals", pay: "Start paying" };
const STAGE_OF: Partial<Record<WithdrawalStatus, Stage>> = { pending: "review", second_approval: "second", approved: "pay" };
const PATH: Record<Kind, string> = { approve: "approve", second: "second-approve", pay: "pay", reject: "reject", return: "return" };

const TAB = queueTab<Stage>("withdrawals", ["review", "second", "pay"]);

const useWithdrawalNext = () =>
  useNextItem({
    base: "/api/staff/withdrawals",
    route: "/withdrawals",
    keys: ["withdrawals", "withdrawals-summary"],
    tab: TAB,
    nothing: (stage, skips) => nothingLeft(stage ? `No more ${STAGE_WORD[stage]} are` : "No more withdrawals are", skips),
  });

const checklistsOf = (d: WithdrawalDetail) => {
  const c = d.checklist as { first?: unknown; second?: unknown; pay?: unknown } | null;
  return c && typeof c === "object" && Array.isArray(c.first) && Array.isArray(c.second) && Array.isArray(c.pay)
    ? (c as { first: ChecklistItem[]; second: ChecklistItem[]; pay: ChecklistItem[] })
    : WITHDRAWAL_CHECKLIST;
};
const stageOf = (d: WithdrawalDetail): Stage | null => d.stage ?? STAGE_OF[d.status] ?? null;

const personName = (p: Person | null | undefined) => p?.name ?? "staff";
const destinationText = (w: Pick<WithdrawalItem, "typeName" | "network" | "destinationEnding" | "methodName">) =>
  [w.typeName || w.methodName, networkLabel(w.network), w.destinationEnding ? `ending ${w.destinationEnding.replace(/^\D*ending\s*/i, "")}` : ""].filter(Boolean).join(" · ");

const columns = [
  waitingColumn<WithdrawalItem>("created_at", (w) => OPEN(w.status), (w) => w.createdAt),
  clientColumn<WithdrawalItem>((w) => w.client ?? { id: w.clientId, name: w.clientName, email: w.clientEmail }),
  {
    key: "amount_cents",
    header: "Amount",
    sortable: true,
    render: (w: WithdrawalItem) => (
      <span className="stack-tight">
        <strong>{money(w.amountCents)}</strong>
        {(w.status === "pending" || w.status === "second_approval") && w.needsSecondApproval && <small className="muted">Needs two approvals</small>}
      </span>
    ),
  },
  {
    key: "destination",
    header: "To",
    optional: true,
    render: (w: WithdrawalItem) => (
      <span className="stack-tight">
        <span>{destinationText(w)}</span>
        <small className="muted mono">{w.reference}</small>
      </span>
    ),
  },
  statusColumn<WithdrawalItem>({ badge: (w) => <WithdrawalStatusBadge status={w.status} />, open: (w) => OPEN(w.status), claimedBy: (w) => w.claimedBy, warnings: (w) => w.warningCount }),
  handledByColumn<WithdrawalItem>((w) =>
    w.paidBy ? (
      handledBy("Paid", w.paidBy, w.paidAt)
    ) : w.status === "rejected" && w.decidedBy ? (
      handledBy("Rejected", w.decidedBy, w.decidedAt)
    ) : w.approvedBy ? (
      handledBy("Approved", w.approvedBy, w.approvedAt)
    ) : w.firstReviewedBy ? (
      <span>
        {personName(w.firstReviewedBy)} <small className="muted">(first approval)</small>
      </span>
    ) : (
      <NotYet />
    ),
  ),
];

export function WithdrawalsQueue() {
  const can = useCan();
  const mayReviewStep = can("withdrawal.process");
  const maySecond = can("withdrawal.approve");
  const mayPay = can("withdrawal.pay");
  const summary = useWithdrawalSummary();
  const next = useWithdrawalNext();
  const s = summary.data;
  const f = s?.forMe;
  return (
    <ReviewQueuePage<WithdrawalItem, Tab, Stage>
      title="Withdrawals"
      description="Withdrawal requests from the client portal and app. The money is held in the client's wallet until it is paid or rejected. Check the destination belongs to the client before you approve it."
      queue={TAB}
      next={next}
      mayReview={mayReviewStep || maySecond || mayPay}
      stageOf={(tab) => (tab === "review" && mayReviewStep ? "review" : tab === "second_approval" && maySecond ? "second" : tab === "to_pay" && mayPay ? "pay" : null)}
      startLabel={(stage) => (stage ? START_LABEL[stage] : "Start reviewing")}
      forMe={(stage) => (f ? (stage === "review" ? f.review : stage === "second" ? f.secondApproval : stage === "pay" ? f.toPay : f.review + f.secondApproval + f.toPay) : undefined)}
      summaryError={summary.error}
      tiles={[
        { icon: <Hourglass size={20} />, tone: "warn", label: "Waiting for review", value: s?.review ?? "–", foot: s ? (s.oldestOpenAt ? `Oldest sent ${formatDate(s.oldestOpenAt)}` : "Nothing waiting") : "" },
        { icon: <Users size={20} />, tone: "info", label: "Second approval", value: s?.secondApproval ?? "–", foot: s && maySecond ? `${f?.secondApproval ?? 0} for you` : "Large and first withdrawals" },
        { icon: <Banknote size={20} />, tone: "info", label: "To pay", value: s?.toPay ?? "–", foot: s && mayPay ? `${f?.toPay ?? 0} you can pay` : "Approved, not paid yet" },
        { icon: <Clock size={20} />, tone: "bad", label: "Waiting over 24 hours", value: s?.overdue ?? "–", foot: "Aim to clear these first" },
        { icon: <CheckCircle2 size={20} />, tone: "good", label: "Decided today", value: s?.decidedToday ?? "–", foot: s ? `${s.decidedTodayByMe ?? 0} by you` : "" },
      ]}
      tabs={[
        { value: "review", label: "Review", count: s?.review, open: true },
        { value: "second_approval", label: "Second approval", count: s?.secondApproval, open: true },
        { value: "to_pay", label: "To pay", count: s?.toPay, open: true },
        { value: "paid", label: "Paid", open: false },
        { value: "rejected", label: "Rejected", open: false },
        { value: "all", label: "All", open: false },
      ]}
      // Each person opens on the step they work on.
      initialTab={mayReviewStep ? "review" : maySecond ? "second_approval" : mayPay ? "to_pay" : "review"}
      listKey="withdrawals"
      listUrl="/api/staff/withdrawals"
      sort="created_at"
      columns={columns}
      rowKey={(w) => w.id}
      filters={[{ key: "kind", label: "Paid to", options: [{ value: "bank", label: "Bank accounts" }, { value: "crypto", label: "Crypto wallets" }] }]}
      searchPlaceholder="Search reference, client name, email or ID"
      rowHref={(w) => `/withdrawals/${w.id}`}
      empty={(tab) =>
        tab === "review"
          ? { title: "Queue clear", text: "Nothing is waiting for review. Withdrawal requests appear here as soon as clients send them." }
          : { title: tab === "second_approval" || tab === "to_pay" ? "Queue clear" : "Nothing here yet", text: "Withdrawals appear here once they reach this step." }
      }
    />
  );
}

/** Where the money goes, large, with copy buttons for whoever sends it. */
function Destination({ d }: { d: WithdrawalDetail }) {
  const x = d.destination;
  const full = Boolean(x?.full);
  if (!x) return <div className="viewer viewer-empty muted">The destination could not be read.</div>;
  const value = (v: string, label: string) => (full ? <CopyText value={v} label={label} /> : <span className="mono">{v}</span>);
  return (
    <div style={{ padding: 20 }}>
      <div className="card-head">
        <div>
          <div className="tile-label">Send</div>
          <div className="tile-value">{money(d.amountCents)}</div>
        </div>
        {full ? <Badge tone="info">Full details</Badge> : <Badge tone="neutral">Masked</Badge>}
      </div>
      <dl className="details" style={{ fontSize: 15 }}>
        <dt>Type</dt>
        <dd>
          {x.typeName} <small className="muted">({KIND_LABEL[x.kind] ?? x.kind})</small>
          {x.network ? ` · ${networkLabel(x.network)}` : ""}
        </dd>
        <dt>Client's label</dt>
        <dd>{x.methodName || "–"}</dd>
        {x.kind === "bank" && (
          <>
            <dt>Account name</dt>
            <dd>
              <strong>{x.accountName || "–"}</strong>
            </dd>
          </>
        )}
        <dt>{x.kind === "crypto" ? "Wallet address" : "Account number"}</dt>
        <dd>{x.accountNumber ? value(x.accountNumber, x.kind === "crypto" ? "wallet address" : "account number") : "–"}</dd>
        {x.iban && (
          <>
            <dt>IBAN</dt>
            <dd>{value(x.iban, "IBAN")}</dd>
          </>
        )}
        {x.swift && (
          <>
            <dt>SWIFT / BIC</dt>
            <dd>{value(x.swift, "SWIFT code")}</dd>
          </>
        )}
        <dt>Verified name</dt>
        <dd>{d.client?.verifiedName || "–"}</dd>
      </dl>
      {!full && <p className="muted tight">Only staff who check, approve or pay withdrawals see the full details.</p>}
      {full && x.kind === "crypto" && !x.hasQr && <p className="muted tight">The client did not attach a QR code for this wallet.</p>}
      {!full && x.hasQr && <p className="muted tight">The client attached a QR code, shown to staff who handle withdrawals.</p>}
    </div>
  );
}

/** A payout reference already recorded on another withdrawal: allowed only when the reviewer confirms it. */
const reused = (e: unknown): e is ApiError => e instanceof ApiError && e.status === 409 && (e.code === "PAYOUT_REFERENCE_USED" || /payout reference/i.test(e.message));

export function WithdrawalWorkbench({ id }: { id: string }) {
  const can = useCan();
  const me = useSession().staff.id;
  const { confirm } = useFeedback();
  const next = useWithdrawalNext();
  const queue = TAB.useTab();
  const sid = Number(id);
  // Paying a withdrawal that only one person approved needs a second person.
  const singleApproverOf = (d: WithdrawalDetail) => (d.approvedBy && (!d.firstReviewedBy || d.firstReviewedBy.id === d.approvedBy.id) ? d.approvedBy.id : null);
  const mayStageOf = (d: WithdrawalDetail) => {
    const stage = stageOf(d);
    return stage === "review"
      ? can("withdrawal.process")
      : stage === "second"
        ? can("withdrawal.approve") && d.firstReviewedBy?.id !== me
        : stage === "pay"
          ? can("withdrawal.pay") && singleApproverOf(d) !== me
          : false;
  };
  const item = useReviewItem<WithdrawalDetail, Kind, Partial<WithdrawalDetail>, Stage>({
    base: "/api/staff/withdrawals",
    route: "/withdrawals",
    id: sid,
    detailKey: "withdrawal-detail",
    queue: TAB,
    next,
    me,
    isOpen: (d) => OPEN(d.status),
    holdable: (d) => OPEN(d.status) && mayStageOf(d),
    claimedBy: (d) => d.claimedBy,
    paths: PATH,
    // A payout reference already used on another withdrawal is allowed only when the reviewer confirms it.
    send: async (x, post) => {
      try {
        return await post(x.body);
      } catch (e) {
        if (x.kind === "pay" && reused(e)) {
          const ok = await confirm({ title: "Use this payout reference again?", body: e.message, confirmLabel: "Mark as paid anyway", danger: true });
          if (ok) return post({ ...x.body, confirmReuse: true });
        }
        throw e;
      }
    },
    refreshOn: (e) => !reused(e),
    toast: (x, res, d) => {
      const what = `${d.client?.name ?? d.clientName}'s withdrawal ${d.reference}`;
      if (x.kind === "reject") return `Rejected ${what}. ${money(d.amountCents)} is back in their wallet and they have been told why.`;
      if (x.kind === "return") return `Sent ${what} back for a new review.`;
      if (x.kind === "pay") return `Marked ${what} as paid. They have been told.`;
      if (x.kind === "approve" && res?.status === "second_approval") return `${what} now waits for a second approval from another person.`;
      return `Approved ${what}. It is ready to be paid.`;
    },
    clientId: (d) => d.clientId,
    invalidate: (d) => [["client-wallet", d.clientId]],
    listKeys: ["withdrawals", "withdrawals-summary"],
    mayContinue: can("withdrawal.process") || can("withdrawal.approve") || can("withdrawal.pay"),
  });
  const { d, hold, decide } = item;
  const [payoutRef, setPayoutRef] = useState("");
  const [paidOn, setPaidOn] = useState("");

  if (!d) return <ReviewItemMissing error={item.detail.error} route="/withdrawals" />;
  const open = item.open;
  const holdable = item.holdable;
  const stage = stageOf(d);
  const mayStage = mayStageOf(d);
  const lists = checklistsOf(d);
  const reasons = d.rejectReasons?.length ? d.rejectReasons : WITHDRAWAL_REJECT_REASONS;
  const x = d.destination;
  const qr: ReviewFile[] = x?.full && x.hasQr && x.qrUrl ? [{ id: d.id, slot: 1, type: "image/png", bytes: 0, url: x.qrUrl, label: "Wallet QR code" }] : [];
  const sending = decide.isPending || next.isPending;

  // Who may do what at this step, as the server worked it out when the item was opened.
  const stageCan = stage === "review" ? d.can?.approve : stage === "second" ? d.can?.secondApprove : stage === "pay" ? d.can?.pay : undefined;
  const approveOk = stageCan ? stageCan.ok : mayStage;
  const rejectOk = d.can?.reject ? d.can.reject.ok : can("withdrawal.reject");
  const canDecide = open && (approveOk || rejectOk) && !hold.heldBy && !hold.away;
  const blocked = !open
    ? null
    : !approveOk && !rejectOk
      ? (stageCan?.reason ?? d.can?.reject?.reason ?? "You can look at this withdrawal but not approve, pay or reject it.")
      : hold.heldBy
        ? `${hold.heldBy} is reviewing this right now.`
        : null;
  const approveBlocked = approveOk ? null : (stageCan?.reason ?? (stage === "pay" ? "You cannot mark this withdrawal as paid." : "You cannot approve this withdrawal."));
  const rejectBlocked = rejectOk ? null : (d.can?.reject?.reason ?? "You cannot reject withdrawals.");

  // The payment's details, checked here the way the server checks them.
  const refProblem = payoutRef.trim() ? textProblem(payoutRef, "payout reference", 2, 120) : null;
  const dateProblem = paidOn ? dayProblem(paidOn, 30, "the money was sent") : null;
  const payComplete = payoutRef.trim() && paidOn && !refProblem && !dateProblem;
  const approveHint =
    stage === "pay" && !payComplete ? (refProblem || dateProblem ? "Fix the payment details above first." : "Send the money first, then enter the payout reference and the date you sent it.") : null;
  const needsSecond = stage === "review" && (Boolean(d.secondApprovalReasons?.length) || d.needsSecondApproval);
  const approveLabel = stage === "pay" ? "Mark as paid" : needsSecond ? "Approve (needs a second approval)" : undefined;
  const checklist = stage === "pay" ? lists.pay : stage === "second" ? lists.second : lists.first;

  const h = d.history;
  const recentLink = (r: WithdrawalDetail["history"]["withdrawals"]["recent"][number]) =>
    open ? (
      <a href={`/withdrawals/${r.id}`} target="_blank" rel="noreferrer">
        {r.reference}
      </a>
    ) : (
      <Link href={`/withdrawals/${r.id}`}>{r.reference}</Link>
    );
  const cardClient: CardClient = d.client ?? { id: d.clientId, name: d.clientName, email: d.clientEmail, status: d.clientStatus, kycStatus: d.kycStatus };

  return (
    <ReviewLayout
      onBack={item.back}
      title={
        <>
          {d.client?.name ?? d.clientName} <WithdrawalStatusBadge status={d.status} />
        </>
      }
      subtitle={
        <>
          <span className="mono">{d.reference}</span> · {money(d.amountCents)} to {destinationText(d)} · sent {formatDate(d.createdAt)}
          {open && (
            <>
              {" "}
              · waiting <Waiting since={d.createdAt} />
            </>
          )}
        </>
      }
      headExtra={open && holdable && queue.stage && <NextOnly what={STAGE_WORD[queue.stage]} clearLabel="Work on every step next" onClear={() => TAB.setStage(null)} />}
      position={open && stage ? positionText(d.queue, STAGE_LABEL[stage]) : undefined}
      evidence={
        <>
          <Destination d={d} />
          {qr.length > 0 && <DocumentViewer files={qr} />}
        </>
      }
      side={
        <>
          <ClientCard client={{ ...cardClient, kycStatus: cardClient.kycStatus ?? d.kycStatus }}>
            <dt>Wallet</dt>
            <dd>
              {money(d.wallet?.availableCents)} available
              <small className="muted block">{money(d.wallet?.heldCents)} held, this withdrawal included</small>
            </dd>
          </ClientCard>

          <h3>How the client deposited</h3>
          {h?.deposits?.approvedCount ? (
            <>
              <p className="muted tight">
                {h.deposits.approvedCount} approved deposit{h.deposits.approvedCount === 1 ? "" : "s"}, {money(h.deposits.approvedTotalCents)} in total.
              </p>
              <ul className="session-list">
                {h.deposits.byMethod.map((b, i) => (
                  <li key={i}>
                    <div>
                      <strong>{b.methodName}</strong> <Badge tone={b.kind === x?.kind ? "good" : "neutral"}>{KIND_LABEL[b.kind] ?? b.kind}</Badge>
                    </div>
                    <small className="muted">
                      {money(b.totalCents)}
                      {b.lastAt ? ` · last ${formatDate(b.lastAt)}` : ""}
                    </small>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="muted tight">No approved deposits.</p>
          )}
          <h3>Earlier withdrawals</h3>
          {h?.withdrawals?.recent?.length ? (
            <>
              <p className="muted tight">
                {h.withdrawals.paidCount} paid, {money(h.withdrawals.paidTotalCents)} in total.
              </p>
              <ul className="session-list">
                {h.withdrawals.recent.map((r) => (
                  <li key={r.id}>
                    <div>
                      {recentLink(r)} <WithdrawalStatusBadge status={r.status} />
                    </div>
                    <small className="muted">
                      {money(r.amountCents)} · {formatDate(r.createdAt)}
                    </small>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="muted tight">This is the client's first withdrawal.</p>
          )}

          <Warnings items={d.warnings ?? []} />

          {open ? (
            <>
              <HoldNotices away={hold.away} heldBy={hold.heldBy} holdable={holdable} busy={hold.claim.isPending} onResume={hold.resume} onTakeOver={() => hold.claim.mutate(true)} />
              {(stage === "second" || stage === "pay") && d.firstReviewedBy && (
                <p className="muted tight">
                  {stage === "pay" && d.approvedBy && d.approvedBy.id !== d.firstReviewedBy.id
                    ? `Approved by ${personName(d.firstReviewedBy)}, then by ${personName(d.approvedBy)}${d.approvedAt ? ` on ${formatDate(d.approvedAt)}` : ""}.`
                    : stage === "pay"
                      ? `Approved by ${personName(d.approvedBy ?? d.firstReviewedBy)}${d.approvedAt ? ` on ${formatDate(d.approvedAt)}` : ""}, so another person must pay it.`
                      : `First approval by ${personName(d.firstReviewedBy)}${d.firstReviewedAt ? ` on ${formatDate(d.firstReviewedAt)}` : ""}.`}
                </p>
              )}
              <ReviewDecision
                reasonRule={moneyReasonProblem}
                resetKey={sid}
                checklist={checklist}
                reasons={reasons}
                busy={sending}
                error={(item.variables?.kind === "return" ? null : decide.error) ?? next.error}
                canDecide={canDecide}
                blockedText={blocked}
                approveBlocked={approveBlocked}
                approveHint={approveHint}
                rejectBlocked={rejectBlocked}
                approveLabel={approveLabel}
                hasDocuments={qr.length > 0}
                notePlaceholder="For example: called the client to confirm the new account"
                fields={
                  stage === "pay" &&
                  canDecide &&
                  approveOk && (
                    <fieldset className="flush stack">
                      <h3 className="flush">The payment you sent</h3>
                      <Field label="Payout reference" hint={refProblem ? <span className="error-text">{refProblem}</span> : "The transaction reference from the bank or the wallet. The client sees it."}>
                        <input className="input mono" autoComplete="off" value={payoutRef} onChange={(e) => setPayoutRef(e.target.value)} maxLength={120} />
                      </Field>
                      <Field label="Sent on" hint={dateProblem ? <span className="error-text">{dateProblem}</span> : undefined}>
                        <input className="input" type="date" value={paidOn} min={daysAgo(30)} max={today()} onChange={(e) => setPaidOn(e.target.value)} />
                      </Field>
                    </fieldset>
                  )
                }
                secondaryActions={
                  stage === "second" &&
                  canDecide && (
                    <SendBack
                      label="Send back to review"
                      help="The first approval is cleared and the withdrawal goes back to the review queue. The money stays held."
                      blocked={d.can?.returnToReview && !d.can.returnToReview.ok ? d.can.returnToReview.reason : null}
                      busy={sending}
                      error={item.variables?.kind === "return" ? decide.error : null}
                      onSend={(note) => decide.mutate({ kind: "return", body: { note } })}
                    />
                  )
                }
                footnote={<ReviewFootnote recorded="Opening a withdrawal" held={holdable && !hold.heldBy && !hold.away} />}
                onApprove={(ticked, note) => {
                  const extra = note ? { note } : {};
                  if (stage === "pay") decide.mutate({ kind: "pay", body: { payoutReference: payoutRef.trim(), paidOn, checklist: ticked, ...extra } });
                  else if (stage === "second") decide.mutate({ kind: "second", body: { checklist: ticked, ...extra } });
                  else decide.mutate({ kind: "approve", body: { checklist: ticked, ...extra } });
                }}
                onReject={(reason, _ticked, note) => decide.mutate({ kind: "reject", body: { reason, ...(note ? { note } : {}) } })}
                onSkip={holdable ? item.skip : undefined}
                onBack={item.back}
              />
            </>
          ) : (
            <DecidedNotice>
              {d.status === "paid"
                ? `${decidedLine("Paid", d.paidBy, d.paidAt)}${d.payoutReference ? ` Payout reference ${d.payoutReference}` : ""}${d.paidOn ? `, sent ${formatDay(d.paidOn)}.` : d.payoutReference ? "." : ""}`
                : `${decidedLine("Rejected", d.decidedBy, d.decidedAt)} The money went back to the client's wallet.${toldClient(d.rejectReason)}`}
            </DecidedNotice>
          )}
          <ReviewHistory items={d.trail} />
        </>
      }
    />
  );
}
