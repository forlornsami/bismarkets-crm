import { CheckCircle2, Clock, Hourglass, Users } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import {
  claimedAmount,
  CopyText,
  dayProblem,
  daysAgo,
  DepositStatusBadge,
  formatDay,
  KIND_LABEL,
  minorText,
  money,
  networkLabel,
  parseAmountText,
  rateText,
  textProblem,
  today,
  toUsdCents,
  useDepositSummary,
  usePaymentMethods,
} from "../components/money";
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
import { Badge, Field } from "../components/ui";
import { formatDate } from "../lib/api";
import { useCan, useSession } from "../lib/session";
import { DEPOSIT_CHECKLIST, DEPOSIT_REJECT_REASONS, moneyReasonProblem, type ChecklistItem, type DepositStatus } from "../../shared/money";

type Stage = "first" | "second";
type ClientState = "active" | "frozen" | "closed";
type KycState = "none" | "partial" | "pending" | "approved" | "rejected";

export interface DepositItem {
  id: number;
  reference: string;
  clientId: number;
  clientName: string;
  clientEmail: string;
  clientStatus: ClientState;
  kycStatus: KycState;
  /** The client as every review queue lists them. */
  client?: ListClient & { country: string | null; status: ClientState };
  methodId: number;
  methodName: string;
  methodKind: "bank" | "crypto";
  currency: "USD" | "PKR";
  amountMinor: number;
  amountCents: number;
  creditedCents: number | null;
  status: DepositStatus;
  needsSecondApproval: boolean;
  sentBack: boolean;
  twoPersonMark?: boolean;
  firstReviewedBy: Person | null;
  decidedBy: Person | null;
  createdAt: string;
  decidedAt: string | null;
  claimedBy: Claimer | null;
  warningCount: number;
}

interface DepositDetail extends Omit<DepositItem, "client"> {
  network: string;
  usdRate: string | number;
  receivedMinor: number | null;
  senderName: string | null;
  bankReference: string | null;
  receivedOn: string | null;
  rejectReason: string | null;
  /** Read when the server sends it (the list item has only who gave the first approval). */
  firstReviewedAt?: string | null;
  proof: { mime: string; sizeBytes: number; width?: number; height?: number; sha256: string; editor: string | null; fileName: string; url: string } | null;
  client: CardClient & { verifiedName: string };
  method: { id: number; name: string; kind: "bank" | "crypto"; currency: string; bankName: string; accountTitle: string; accountNumber: string; iban: string; walletAddress: string; network: string };
  wallet: { availableCents: number; heldCents: number };
  history: { approvedCount: number; approvedTotalCents: number; firstDeposit: boolean; recent: { id: number; reference: string; status: DepositStatus; amountCents: number; createdAt: string }[] };
  warnings: ReviewWarning[];
  proofOpenedByMe: boolean;
  stage: Stage | null;
  can: { approve: CanDo; secondApprove: CanDo; reject: CanDo; returnToFirst: CanDo };
  /** The step checklists (the contract also names the ticked keys `checklist`, so either shape is read). */
  checklist: { first: ChecklistItem[]; second: ChecklistItem[] } | unknown;
  rejectReasons: string[];
  claimMinutes: number;
  secondApprovalAboveCents: number;
  /** You set the method's account details or the rate: your approval goes to a second person. */
  setByYou?: boolean;
  expectedReference: string;
  /** Where this deposit stands among those waiting at its step. */
  queue?: { pending: number; position: number };
  trail?: TrailItem[];
}

type Tab = "pending" | "second_approval" | "approved" | "rejected" | "all";
type Kind = "approve" | "second" | "reject" | "return";
const OPEN = (s: DepositStatus | undefined) => s === "pending" || s === "second_approval";
const STAGE_WORD: Record<Stage, string> = { first: "first approvals", second: "second approvals" };
const STAGE_LABEL: Record<Stage, string> = { first: "First approval", second: "Second approval" };
const PATH: Record<Kind, string> = { approve: "approve", second: "second-approve", reject: "reject", return: "return" };
const UNREADABLE = DEPOSIT_REJECT_REASONS.find((r) => r.includes("could not be read")) ?? DEPOSIT_REJECT_REASONS[0]!;

const TAB = queueTab<Stage>("deposits", ["first", "second"]);

const useDepositNext = () =>
  useNextItem({
    base: "/api/staff/deposits",
    route: "/deposits",
    keys: ["deposits", "deposits-summary"],
    tab: TAB,
    nothing: (stage, skips) => nothingLeft(stage ? `No more ${STAGE_WORD[stage]} are` : "No more deposits are", skips),
  });

const checklistsOf = (d: DepositDetail) => {
  const c = d.checklist as { first?: unknown; second?: unknown } | null;
  return c && typeof c === "object" && Array.isArray(c.first) && Array.isArray(c.second) ? (c as { first: ChecklistItem[]; second: ChecklistItem[] }) : DEPOSIT_CHECKLIST;
};
const stageOf = (d: DepositDetail): Stage | null => d.stage ?? (d.status === "pending" ? "first" : d.status === "second_approval" ? "second" : null);

const personName = (p: Person | null | undefined) => p?.name ?? "staff";

const columns = [
  waitingColumn<DepositItem>("created_at", (d) => OPEN(d.status), (d) => d.createdAt),
  clientColumn<DepositItem>((d) => d.client ?? { id: d.clientId, name: d.clientName, email: d.clientEmail }),
  {
    key: "amount_cents",
    header: "Amount",
    sortable: true,
    render: (d: DepositItem) => (
      <span className="stack-tight">
        <strong>{claimedAmount(d)}</strong>
        {d.status === "approved" && d.creditedCents !== null && d.creditedCents !== d.amountCents && <small className="muted">Credited {money(d.creditedCents)}</small>}
        {OPEN(d.status) && d.needsSecondApproval && <small className="muted">Needs two approvals</small>}
      </span>
    ),
  },
  {
    key: "method",
    header: "Method",
    optional: true,
    render: (d: DepositItem) => (
      <span className="stack-tight">
        <span>{d.methodName}</span>
        <small className="muted mono">{d.reference}</small>
      </span>
    ),
  },
  statusColumn<DepositItem>({ badge: (d) => <DepositStatusBadge status={d.status} />, open: (d) => OPEN(d.status), claimedBy: (d) => d.claimedBy, warnings: (d) => d.warningCount }),
  handledByColumn<DepositItem>((d) =>
    d.decidedBy ? (
      handledBy(d.status === "rejected" ? "Rejected" : "Approved", d.decidedBy, d.decidedAt)
    ) : d.firstReviewedBy ? (
      <span>
        {personName(d.firstReviewedBy)} <small className="muted">(first approval)</small>
      </span>
    ) : (
      <NotYet />
    ),
  ),
];

export function DepositsQueue() {
  const can = useCan();
  const summary = useDepositSummary();
  const methods = usePaymentMethods();
  const next = useDepositNext();
  const mayFirst = can("deposit.process", "deposit.proof");
  const maySecond = can("deposit.approve_large", "deposit.proof");
  const s = summary.data;
  const f = s ? (s.forMe ?? { first: mayFirst ? s.pending : 0, second: maySecond ? s.secondApprovalForMe : 0 }) : undefined;
  const depositMethods = (methods.data?.items ?? []).filter((m) => m.direction === "deposit");
  return (
    <ReviewQueuePage<DepositItem, Tab, Stage>
      title="Deposits"
      description="Deposit requests from the client portal and app. Find each payment in the bank statement or wallet history before you approve it; only then is the money added to the client's wallet."
      queue={TAB}
      next={next}
      mayReview={mayFirst || maySecond}
      stageOf={(tab) => (tab === "pending" && mayFirst ? "first" : tab === "second_approval" && maySecond ? "second" : null)}
      startLabel={(stage) => `Start reviewing${stage ? ` ${STAGE_WORD[stage]}` : ""}`}
      forMe={(stage) => (f ? (stage === "first" ? f.first : stage === "second" ? f.second : f.first + f.second) : undefined)}
      summaryError={summary.error}
      tiles={[
        { icon: <Hourglass size={20} />, tone: "warn", label: "Waiting", value: s?.pending ?? "–", foot: s ? (s.oldestOpenAt ? `Oldest sent ${formatDate(s.oldestOpenAt)}` : "Nothing waiting") : "" },
        { icon: <Users size={20} />, tone: "info", label: "Second approval", value: s?.secondApproval ?? "–", foot: s && f ? (maySecond ? `${f.second} for you` : "Above the approval limit") : "" },
        { icon: <Clock size={20} />, tone: "bad", label: "Waiting over 24 hours", value: s?.overdue ?? "–", foot: "Aim to clear these first" },
        { icon: <CheckCircle2 size={20} />, tone: "good", label: "Decided today", value: s?.decidedToday ?? "–", foot: s ? `${s.decidedTodayByMe} by you` : "" },
      ]}
      tabs={[
        { value: "pending", label: "Waiting", count: s?.pending, open: true },
        { value: "second_approval", label: "Second approval", count: s?.secondApproval, open: true },
        { value: "approved", label: "Approved", open: false },
        { value: "rejected", label: "Rejected", open: false },
        { value: "all", label: "All", open: false },
      ]}
      initialTab="pending"
      listKey="deposits"
      listUrl="/api/staff/deposits"
      sort="created_at"
      columns={columns}
      rowKey={(d) => d.id}
      filters={[{ key: "methodId", label: "Method", options: depositMethods.map((m) => ({ value: String(m.id), label: m.isEnabled ? m.name : `${m.name} (off)` })) }]}
      searchPlaceholder="Search reference, client name, email or ID"
      rowHref={can("deposit.proof") ? (d) => `/deposits/${d.id}` : null}
      noOpenText="Your role shows deposit status only. Opening a deposit and its payment proof needs the deposit proof permission."
      empty={(tab) =>
        tab === "pending"
          ? { title: "Queue clear", text: "Nothing is waiting for review. Deposit requests appear here as soon as clients send them." }
          : tab === "second_approval"
            ? { title: "No second approvals waiting", text: "Deposits appear here once they reach this step." }
            : { title: "Nothing here yet", text: "Deposits appear here once they reach this step." }
      }
    />
  );
}

/** What the first reviewer found in the statement. */
function Found({ d }: { d: DepositDetail }) {
  if (d.receivedMinor === null || d.receivedMinor === undefined) return null;
  const credited = d.creditedCents ?? toUsdCents(d.receivedMinor, d.currency, d.usdRate);
  return (
    <dl className="details details-tight">
      <dt>Amount received</dt>
      <dd>
        <strong>{money(d.receivedMinor, d.currency)}</strong>
        {d.currency !== "USD" && credited !== null && <small className="muted block">Credits {money(credited)}</small>}
        {d.receivedMinor !== d.amountMinor && <small className="error-text block">The client said {money(d.amountMinor, d.currency)}</small>}
      </dd>
      <dt>{d.methodKind === "crypto" ? "Sent from" : "Sender"}</dt>
      <dd>{d.senderName ?? "–"}</dd>
      <dt>{d.methodKind === "crypto" ? "Transaction ID" : "Bank reference"}</dt>
      <dd className="mono">{d.bankReference ?? "–"}</dd>
      <dt>Received on</dt>
      <dd>{formatDay(d.receivedOn)}</dd>
      {d.firstReviewedBy && (
        <>
          <dt>First approval</dt>
          <dd>
            {personName(d.firstReviewedBy)}
            {d.firstReviewedAt ? `, ${formatDate(d.firstReviewedAt)}` : ""}
          </dd>
        </>
      )}
    </dl>
  );
}

export function DepositWorkbench({ id }: { id: string }) {
  const can = useCan();
  const me = useSession().staff.id;
  const next = useDepositNext();
  const queue = TAB.useTab();
  const sid = Number(id);
  const mayFirst = can("deposit.process", "deposit.proof");
  const maySecondAtAll = can("deposit.approve_large", "deposit.proof");
  // The person who gave the first approval leaves the second to a colleague.
  const maySecondOf = (d: DepositDetail) => maySecondAtAll && d.firstReviewedBy?.id !== me;
  const item = useReviewItem<DepositDetail, Kind, Partial<DepositDetail>, Stage>({
    base: "/api/staff/deposits",
    route: "/deposits",
    id: sid,
    detailKey: "deposit-detail",
    queue: TAB,
    next,
    me,
    isOpen: (d) => OPEN(d.status),
    // Only someone who can give this step's approval holds the item.
    holdable: (d) => OPEN(d.status) && ((stageOf(d) === "first" && mayFirst) || (stageOf(d) === "second" && maySecondOf(d))),
    claimedBy: (d) => d.claimedBy,
    paths: PATH,
    toast: (x, res, d) => {
      const who = d.client?.name ?? d.clientName;
      const what = `${who}'s deposit ${d.reference}`;
      const credited = res?.creditedCents ?? d.creditedCents ?? x.expect?.credits;
      if (x.kind === "reject") return `Rejected ${what}. They have been told why.`;
      if (x.kind === "return") return `Sent ${what} back for a new first approval.`;
      if (x.kind === "approve" && (res?.status === "second_approval" || (res?.status === undefined && x.expect?.second))) return `${what} now waits for a second approval from another person.`;
      return `Approved ${what}. ${credited ? `${money(credited)} is in their wallet` : "The money is in their wallet"} and they have been told.`;
    },
    clientId: (d) => d.clientId,
    invalidate: (d) => [["client-wallet", d.clientId]],
    listKeys: ["deposits", "deposits-summary"],
    mayContinue: mayFirst || maySecondAtAll,
  });
  const { d, hold, decide } = item;
  const [viewed, setViewed] = useState(false);
  const [rejectWith, setRejectWith] = useState<{ reason: string; key: number } | null>(null);
  // What the reviewer found in the statement (first approval).
  const [received, setReceived] = useState("");
  const [sender, setSender] = useState("");
  const [bankRef, setBankRef] = useState("");
  const [receivedOn, setReceivedOn] = useState("");

  if (!d) return <ReviewItemMissing error={item.detail.error} route="/deposits" />;
  const open = item.open;
  const holdable = item.holdable;
  const stage = stageOf(d);
  const maySecond = maySecondOf(d);
  const lists = checklistsOf(d);
  const reasons = d.rejectReasons?.length ? d.rejectReasons : DEPOSIT_REJECT_REASONS;
  const proofFile: ReviewFile[] = d.proof ? [{ id: d.id, slot: 1, type: d.proof.mime, bytes: d.proof.sizeBytes, url: d.proof.url, label: "Payment proof" }] : [];
  const opened = d.proofOpenedByMe || viewed;
  const unopened = d.proof && !opened ? ["the payment proof"] : [];
  const crypto = d.methodKind === "crypto" || d.method?.kind === "crypto";
  const sending = decide.isPending || next.isPending;

  // Who may do what at this step, as the server worked it out when the item was opened.
  const stageCan = stage === "first" ? d.can?.approve : stage === "second" ? d.can?.secondApprove : undefined;
  const approveOk = stageCan ? stageCan.ok : stage === "first" ? mayFirst : stage === "second" && maySecond;
  const rejectOk = d.can?.reject ? d.can.reject.ok : can("deposit.reject", "deposit.proof");
  const canDecide = open && (approveOk || rejectOk) && !hold.heldBy && !hold.away;
  const blocked = !open
    ? null
    : !approveOk && !rejectOk
      ? (stageCan?.reason ?? d.can?.reject?.reason ?? "You can look at this deposit but not approve or reject it.")
      : hold.heldBy
        ? `${hold.heldBy} is reviewing this right now.`
        : null;
  const approveBlocked = !approveOk
    ? (stageCan?.reason ?? "You cannot approve this deposit.")
    : !d.proof
      ? "This request has no payment proof, so it cannot be approved. Reject it so the client sends a new one."
      : null;
  const rejectBlocked = rejectOk ? null : (d.can?.reject?.reason ?? "You cannot reject deposits.");

  // The first approval's details, checked here the way the server checks them.
  const parsed = parseAmountText(received);
  const amountProblem = received.trim() ? (parsed.problem ?? null) : null;
  const senderProblem = sender.trim() ? textProblem(sender, crypto ? "sender" : "sender name", 2, 160) : null;
  const refProblem = bankRef.trim() ? textProblem(bankRef, crypto ? "transaction ID" : "bank reference", 2, 80) : null;
  const dateProblem = receivedOn ? dayProblem(receivedOn, 180, "the money arrived") : null;
  const anyProblem = amountProblem || senderProblem || refProblem || dateProblem;
  const complete = parsed.minor !== undefined && sender.trim() && bankRef.trim() && receivedOn && !anyProblem;
  const differs = parsed.minor !== undefined && parsed.minor !== d.amountMinor;
  const credited = parsed.minor !== undefined ? toUsdCents(parsed.minor, d.currency, d.usdRate) : null;
  const limit = typeof d.secondApprovalAboveCents === "number" ? d.secondApprovalAboveCents : null;
  const needsSecond = stage === "first" && (d.sentBack || d.twoPersonMark || d.setByYou || (limit !== null ? (credited ?? d.amountCents) > limit : d.needsSecondApproval));
  const approveHint =
    stage === "first" && !complete
      ? anyProblem
        ? "Fix the details above first."
        : `Fill in what you found in the ${crypto ? "wallet history" : "statement"}: the amount received, the ${crypto ? "sender" : "sender's name"}, the ${crypto ? "transaction ID" : "bank reference"} and the date.`
      : null;
  const noteRequired = stage === "first" && differs ? "The amount received differs from what the client said. Add an internal note explaining why." : null;

  const m = d.method;
  const recentLink = (r: DepositDetail["history"]["recent"][number]) =>
    // While this item is held, a new tab keeps the hold and the ticked checks.
    open ? (
      <a href={`/deposits/${r.id}`} target="_blank" rel="noreferrer">
        {r.reference}
      </a>
    ) : (
      <Link href={`/deposits/${r.id}`}>{r.reference}</Link>
    );
  const cardClient: CardClient = d.client ?? { id: d.clientId, name: d.clientName, email: d.clientEmail, status: d.clientStatus, kycStatus: d.kycStatus };

  return (
    <ReviewLayout
      onBack={item.back}
      title={
        <>
          {d.client?.name ?? d.clientName} <DepositStatusBadge status={d.status} />
        </>
      }
      subtitle={
        <>
          <span className="mono">{d.reference}</span> · {claimedAmount(d)} by {d.methodName} · sent {formatDate(d.createdAt)}
          {open && (
            <>
              {" "}
              · waiting <Waiting since={d.createdAt} />
            </>
          )}
        </>
      }
      headExtra={open && holdable && queue.stage && <NextOnly what={STAGE_WORD[queue.stage]} clearLabel="Review every step next" onClear={() => TAB.setStage(null)} />}
      position={open && stage ? positionText(d.queue, STAGE_LABEL[stage]) : undefined}
      evidence={
        <DocumentViewer
          files={proofFile}
          viewed={opened ? new Set([d.id]) : new Set()}
          onViewed={() => setViewed(true)}
          onUnreadable={open && rejectOk && !hold.heldBy && !hold.away ? () => setRejectWith({ reason: UNREADABLE, key: Date.now() }) : undefined}
        />
      }
      side={
        <>
          <ClientCard client={{ ...cardClient, kycStatus: cardClient.kycStatus ?? d.kycStatus }} />

          <h3>Payment</h3>
          <dl className="details details-tight">
            <dt>Client says</dt>
            <dd>
              <strong>{money(d.amountMinor, d.currency)}</strong>
              {d.currency !== "USD" && (
                <small className="muted block">
                  {money(d.amountCents)} at {rateText(d.usdRate)} {d.currency} per US dollar
                </small>
              )}
            </dd>
            <dt>Reference to look for</dt>
            <dd>
              <CopyText value={d.expectedReference || `BIS-${d.clientId}`} label="payment reference" />
              <small className="muted block">Clients are asked to write this on the payment.</small>
            </dd>
            <dt>Paid into</dt>
            <dd>
              {m?.name ?? d.methodName} <small className="muted">({KIND_LABEL[d.methodKind] ?? d.methodKind})</small>
            </dd>
            {m?.kind === "bank" ? (
              <>
                {m.bankName && (
                  <>
                    <dt>Bank</dt>
                    <dd>{m.bankName}</dd>
                  </>
                )}
                {m.accountTitle && (
                  <>
                    <dt>Account title</dt>
                    <dd>{m.accountTitle}</dd>
                  </>
                )}
                {m.accountNumber && (
                  <>
                    <dt>Account number</dt>
                    <dd className="mono">{m.accountNumber}</dd>
                  </>
                )}
                {m.iban && (
                  <>
                    <dt>IBAN</dt>
                    <dd className="mono">{m.iban}</dd>
                  </>
                )}
              </>
            ) : m ? (
              <>
                <dt>Network</dt>
                <dd>{networkLabel(m.network || d.network) || "–"}</dd>
                <dt>Our wallet</dt>
                <dd className="mono">{m.walletAddress || "–"}</dd>
              </>
            ) : null}
            {d.network && m?.kind !== "crypto" && (
              <>
                <dt>Network</dt>
                <dd>{networkLabel(d.network)}</dd>
              </>
            )}
          </dl>

          <h3>Wallet and history</h3>
          <dl className="details details-tight">
            <dt>Wallet</dt>
            <dd>
              {money(d.wallet?.availableCents)}
              {d.wallet?.heldCents ? <small className="muted block">{money(d.wallet.heldCents)} held for withdrawals</small> : null}
            </dd>
            <dt>Approved before</dt>
            <dd>
              {d.history?.firstDeposit ? (
                <Badge tone="warn">First deposit</Badge>
              ) : (
                `${d.history?.approvedCount ?? 0} deposit${d.history?.approvedCount === 1 ? "" : "s"}, ${money(d.history?.approvedTotalCents ?? 0)}`
              )}
            </dd>
          </dl>
          {(d.history?.recent?.length ?? 0) > 0 && (
            <ul className="session-list">
              {d.history.recent.map((r) => (
                <li key={r.id}>
                  <div>
                    {recentLink(r)} <DepositStatusBadge status={r.status} />
                  </div>
                  <small className="muted">
                    {money(r.amountCents)} · {formatDate(r.createdAt)}
                  </small>
                </li>
              ))}
            </ul>
          )}

          <Warnings items={d.warnings ?? []} />

          {open ? (
            <>
              <HoldNotices away={hold.away} heldBy={hold.heldBy} holdable={holdable} busy={hold.claim.isPending} onResume={hold.resume} onTakeOver={() => hold.claim.mutate(true)} />
              {stage === "second" && (
                <>
                  <h3 className="flush">What the first reviewer found</h3>
                  <Found d={d} />
                </>
              )}
              <ReviewDecision
                reasonRule={moneyReasonProblem}
                resetKey={sid}
                checklist={stage === "second" ? lists.second : lists.first}
                reasons={reasons}
                busy={sending}
                error={(item.variables?.kind === "return" ? null : decide.error) ?? next.error}
                canDecide={canDecide}
                blockedText={blocked}
                approveBlocked={approveBlocked}
                approveHint={approveHint}
                noteRequired={noteRequired}
                rejectBlocked={rejectBlocked}
                unopened={unopened}
                rejectWith={rejectWith}
                approveLabel={needsSecond ? "Approve (needs a second approval)" : undefined}
                notePlaceholder="For example: the bank shows a fee taken from the amount"
                fields={
                  stage === "first" &&
                  canDecide &&
                  approveOk && (
                    <fieldset className="flush stack">
                      <h3 className="flush">What you found in the {crypto ? "wallet history" : "statement"}</h3>
                      <Field
                        label={`Amount received (${d.currency})`}
                        hint={
                          amountProblem ? (
                            <span className="error-text">{amountProblem}</span>
                          ) : parsed.minor !== undefined ? (
                            <>
                              {d.currency !== "USD" && credited !== null ? `Credits ${money(credited)} at ${rateText(d.usdRate)} ${d.currency} per US dollar. ` : `Credits ${money(credited)}. `}
                              {differs && <span className="error-text">The client said {money(d.amountMinor, d.currency)}.</span>}
                            </>
                          ) : (
                            `Exactly as the ${crypto ? "wallet history" : "statement"} shows it, such as ${minorText(d.amountMinor)}.`
                          )
                        }
                      >
                        <input className="input" inputMode="decimal" autoComplete="off" value={received} onChange={(e) => setReceived(e.target.value)} maxLength={16} />
                      </Field>
                      <Field
                        label={crypto ? "Sent from" : "Sender name"}
                        hint={senderProblem ? <span className="error-text">{senderProblem}</span> : crypto ? "The sending wallet or Binance account shown in the history." : "As the statement shows it."}
                      >
                        <input className="input" autoComplete="off" value={sender} onChange={(e) => setSender(e.target.value)} maxLength={160} />
                      </Field>
                      <Field
                        label={crypto ? "Transaction ID" : "Bank reference"}
                        hint={refProblem ? <span className="error-text">{refProblem}</span> : "Each payment can be credited only once, so this must be the payment's own reference."}
                      >
                        <input className="input mono" autoComplete="off" value={bankRef} onChange={(e) => setBankRef(e.target.value)} maxLength={80} />
                      </Field>
                      <Field label="Received on" hint={dateProblem ? <span className="error-text">{dateProblem}</span> : undefined}>
                        <input className="input" type="date" value={receivedOn} min={daysAgo(180)} max={today()} onChange={(e) => setReceivedOn(e.target.value)} />
                      </Field>
                    </fieldset>
                  )
                }
                secondaryActions={
                  stage === "second" &&
                  canDecide && (
                    <SendBack
                      label="Send back to first approval"
                      help="The first approval is cleared and the deposit goes back to the queue, so someone checks the statement again."
                      blocked={d.can?.returnToFirst && !d.can.returnToFirst.ok ? d.can.returnToFirst.reason : null}
                      busy={sending}
                      error={item.variables?.kind === "return" ? decide.error : null}
                      onSend={(note) => decide.mutate({ kind: "return", body: { note } })}
                    />
                  )
                }
                footnote={<ReviewFootnote recorded="Opening the payment proof" held={holdable && !hold.heldBy && !hold.away} />}
                onApprove={(checklist, note) =>
                  stage === "second"
                    ? decide.mutate({
                        kind: "second",
                        body: { checklist, ...(note ? { note } : {}) },
                        expect: { credits: d.receivedMinor ? toUsdCents(d.receivedMinor, d.currency, d.usdRate) : null },
                      })
                    : decide.mutate({
                        kind: "approve",
                        body: { receivedAmount: received.trim(), senderName: sender.trim(), bankReference: bankRef.trim(), receivedOn, checklist, ...(note ? { note } : {}) },
                        expect: { second: needsSecond, credits: credited },
                      })
                }
                onReject={(reason, _checklist, note) => decide.mutate({ kind: "reject", body: { reason, ...(note ? { note } : {}) } })}
                onSkip={holdable ? item.skip : undefined}
                onBack={item.back}
              />
            </>
          ) : (
            <>
              <DecidedNotice>
                {d.status === "approved"
                  ? `${decidedLine("Approved", d.decidedBy, d.decidedAt)} ${money(d.creditedCents ?? d.amountCents)} was added to the wallet.`
                  : `${decidedLine("Rejected", d.decidedBy, d.decidedAt)}${toldClient(d.rejectReason)}`}
              </DecidedNotice>
              <Found d={d} />
            </>
          )}
          <ReviewHistory items={d.trail} />
        </>
      }
    />
  );
}
