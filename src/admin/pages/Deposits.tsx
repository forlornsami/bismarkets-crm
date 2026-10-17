import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, Clock, Hourglass, Play, Users, X } from "lucide-react";
import { useState } from "react";
import { Link, useLocation } from "wouter";
import { DataGrid, gridQuery, type Column, type GridState } from "../components/DataGrid";
import {
  claimedAmount,
  CopyText,
  dayProblem,
  daysAgo,
  DepositStatusBadge,
  formatDay,
  HoldNotices,
  KIND_LABEL,
  minorText,
  money,
  networkLabel,
  NotesTrail,
  nothingLeft,
  parseAmountText,
  QueueTabs,
  queueTab,
  rateText,
  SendBack,
  SkippedNotice,
  textProblem,
  Tile,
  today,
  toUsdCents,
  useDepositSummary,
  useHold,
  useNextItem,
  usePaymentMethods,
  type CanDo,
  type Claimer,
  type MoneyNote,
  type Person,
} from "../components/money";
import { DocumentViewer, ReviewDecision, ReviewLayout, Waiting, Warnings, type ReviewFile, type ReviewWarning } from "../components/ReviewWorkbench";
import { Badge, ErrorText, Field, PageHeader, Spinner, useFeedback } from "../components/ui";
import { ApiError, api, formatDate, qs, type Page } from "../lib/api";
import { useCan, useSession } from "../lib/session";
import { DEPOSIT_CHECKLIST, DEPOSIT_REJECT_REASONS, type ChecklistItem, type DepositStatus } from "../../shared/money";
import { ClientStatus } from "./Clients";
import { KycStatusBadge } from "./Kyc";

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
  firstReviewedBy: Person | null;
  decidedBy: Person | null;
  createdAt: string;
  decidedAt: string | null;
  claimedBy: Claimer | null;
  warningCount: number;
}

interface DepositDetail extends DepositItem {
  network: string;
  usdRate: string | number;
  receivedMinor: number | null;
  senderName: string | null;
  bankReference: string | null;
  receivedOn: string | null;
  rejectReason: string | null;
  /** Read when the server sends it (the list item has only who gave the first approval). */
  firstReviewedAt?: string | null;
  notes: MoneyNote[] | null;
  proof: { mime: string; sizeBytes: number; width?: number; height?: number; sha256: string; editor: string | null; fileName: string; url: string } | null;
  client: { id: number; name: string; email: string; status: ClientState; kycStatus: KycState; verifiedName: string; country: string | null; createdAt: string; assignedTo: Person | number | null };
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
  expectedReference: string;
}

type Tab = "pending" | "second_approval" | "approved" | "rejected" | "all";
const OPEN = (s: DepositStatus | undefined) => s === "pending" || s === "second_approval";
const STAGE_WORD: Record<Stage, string> = { first: "first approvals", second: "second approvals" };
const STAGE_LABEL: Record<Stage, string> = { first: "First approval", second: "Second approval" };
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

const personName = (p: Person | null | undefined) => p?.name ?? "staff";

function StatusCell({ d }: { d: DepositItem }) {
  return (
    <span className="stack-tight">
      {OPEN(d.status) && d.claimedBy ? <Badge tone="info">Being reviewed by {d.claimedBy.name ?? "staff"}</Badge> : <DepositStatusBadge status={d.status} />}
      {d.warningCount > 0 && <small className="error-text">{d.warningCount === 1 ? "1 warning" : `${d.warningCount} warnings`}</small>}
    </span>
  );
}

const columns: Column<DepositItem>[] = [
  { key: "created_at", header: "Waiting", sortable: true, width: "110px", render: (d) => (OPEN(d.status) ? <Waiting since={d.createdAt} /> : <span className="muted">{formatDate(d.createdAt)}</span>) },
  {
    key: "client",
    header: "Client",
    render: (d) => (
      <span className="stack-tight">
        <strong>{d.clientName}</strong>
        <small className="muted">
          {d.clientEmail} · {d.clientId}
        </small>
      </span>
    ),
  },
  {
    key: "amount_cents",
    header: "Amount",
    sortable: true,
    render: (d) => (
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
    render: (d) => (
      <span className="stack-tight">
        <span>{d.methodName}</span>
        <small className="muted mono">{d.reference}</small>
      </span>
    ),
  },
  { key: "status", header: "Status", render: (d) => <StatusCell d={d} /> },
  {
    key: "reviewed",
    header: "Reviewed by",
    optional: true,
    render: (d) =>
      d.decidedBy ? (
        `${personName(d.decidedBy)}, ${formatDate(d.decidedAt)}`
      ) : d.firstReviewedBy ? (
        <span>
          {personName(d.firstReviewedBy)} <small className="muted">(first approval)</small>
        </span>
      ) : (
        <span className="muted">Not yet</span>
      ),
  },
];

const initialClient = () => {
  const v = new URLSearchParams(window.location.search).get("client");
  return v && /^\d{1,12}$/.test(v) ? v : "";
};

export function DepositsQueue() {
  const can = useCan();
  const [, navigate] = useLocation();
  const [tab, setTab] = useState<Tab>("pending");
  const [state, setState] = useState<GridState>(() => {
    const clientId = initialClient();
    const filters: Record<string, string> = clientId ? { clientId } : {};
    return { page: 1, pageSize: 25, sort: "created_at", dir: "asc", filters };
  });
  const summary = useDepositSummary();
  const methods = usePaymentMethods();
  const next = useDepositNext();
  const queue = TAB.useTab();
  const mayFirst = can("deposit.process", "deposit.proof");
  const maySecond = can("deposit.approve_large", "deposit.proof");
  const mayReview = mayFirst || maySecond;
  const mayOpen = can("deposit.proof");
  const list = useQuery({
    queryKey: ["deposits", tab, state],
    queryFn: () => api.get<Page<DepositItem>>(`/api/staff/deposits${qs({ ...gridQuery(state), status: tab })}`),
    placeholderData: (prev) => prev,
    refetchInterval: 30_000,
  });
  const changeTab = (t: Tab) => {
    // Waiting items read oldest first, decided ones newest first.
    setTab(t);
    setState({ ...state, page: 1, dir: OPEN(t as DepositStatus) ? "asc" : "desc" });
  };
  const s = summary.data;
  const stage: Stage | null = tab === "pending" && mayFirst ? "first" : tab === "second_approval" && maySecond ? "second" : null;
  const forMe = s ? (stage === "first" ? s.pending : stage === "second" ? s.secondApprovalForMe : (mayFirst ? s.pending : 0) + (maySecond ? s.secondApprovalForMe : 0)) : undefined;
  const start = () => {
    TAB.setStage(stage);
    next.mutate({});
  };
  const depositMethods = (methods.data?.items ?? []).filter((m) => m.direction === "deposit");
  return (
    <>
      <PageHeader
        title="Deposits"
        description="Deposit requests from the client portal and app. Find each payment in the bank statement or wallet history before you approve it; only then is the money added to the client's wallet."
        actions={
          mayReview && (
            <button type="button" className="button button-primary" disabled={next.isPending || forMe === 0} onClick={start}>
              {next.isPending ? <Spinner /> : <Play size={16} />} Start reviewing{stage ? ` ${STAGE_WORD[stage]}` : ""}
              {forMe ? ` (${forMe})` : ""}
            </button>
          )
        }
      />
      <ErrorText error={next.error} />
      {mayReview && (
        <SkippedNotice
          count={queue.skipped.length}
          busy={next.isPending}
          onReview={() => {
            TAB.remember([]);
            start();
          }}
        />
      )}
      {summary.error && <p className="error-text">The queue summary could not be loaded. {summary.error instanceof Error ? summary.error.message : ""}</p>}
      <div className="tiles">
        <Tile icon={<Hourglass size={20} />} tone="warn" label="Waiting" value={s?.pending ?? "–"} foot={s ? (s.oldestOpenAt ? `Oldest sent ${formatDate(s.oldestOpenAt)}` : "Nothing waiting") : ""} />
        <Tile icon={<Users size={20} />} tone="info" label="Second approval" value={s?.secondApproval ?? "–"} foot={s ? (maySecond ? `${s.secondApprovalForMe} for you` : "Above the approval limit") : ""} />
        <Tile icon={<Clock size={20} />} tone="bad" label="Waiting over 24 hours" value={s?.overdue ?? "–"} foot="Aim to clear these first" />
        <Tile icon={<CheckCircle2 size={20} />} tone="good" label="Decided today" value={s?.decidedToday ?? "–"} foot={s ? `${s.decidedTodayByMe} by you` : ""} />
      </div>
      <QueueTabs
        value={tab}
        onChange={changeTab}
        options={[
          { value: "pending", label: "Waiting", count: s?.pending },
          { value: "second_approval", label: "Second approval", count: s?.secondApproval },
          { value: "approved", label: "Approved" },
          { value: "rejected", label: "Rejected" },
          { value: "all", label: "All" },
        ]}
      />
      <DataGrid
        columns={columns}
        rows={list.data?.items}
        total={list.data?.total ?? 0}
        pages={list.data?.pages ?? 1}
        state={state}
        onChange={setState}
        rowKey={(d) => d.id}
        onRowClick={mayOpen ? (d) => navigate(`/deposits/${d.id}`) : undefined}
        loading={list.isLoading}
        error={list.error}
        searchPlaceholder="Search reference, client name, email or ID"
        filters={[{ key: "methodId", label: "Method", options: depositMethods.map((m) => ({ value: String(m.id), label: m.isEnabled ? m.name : `${m.name} (off)` })) }]}
        toolbar={
          state.filters.clientId && (
            <span className="review-filter">
              Client {state.filters.clientId} only
              <button type="button" className="icon-button" aria-label="Show every client" title="Show every client" onClick={() => setState({ ...state, page: 1, filters: { ...state.filters, clientId: "" } })}>
                <X size={14} />
              </button>
            </span>
          )
        }
        emptyTitle={tab === "pending" ? "Queue clear" : tab === "second_approval" ? "No second approvals waiting" : "Nothing here yet"}
        emptyText={tab === "pending" ? "Nothing is waiting for review. Deposit requests appear here as soon as clients send them." : "Deposits appear here once they reach this step."}
      />
      {!mayOpen && <p className="muted tight">Your role shows deposit status only. Opening a deposit and its payment proof needs the deposit proof permission.</p>}
    </>
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

/** `expectSecond` and `credits` are what this screen worked out, for the message when the server does not say. */
type Decision = { kind: "approve" | "second" | "reject" | "return"; body: Record<string, unknown>; expectSecond?: boolean; credits?: number | null };
const PATH: Record<Decision["kind"], string> = { approve: "approve", second: "second-approve", reject: "reject", return: "return" };

export function DepositWorkbench({ id }: { id: string }) {
  const can = useCan();
  const me = useSession().staff.id;
  const client = useQueryClient();
  const [, navigate] = useLocation();
  const { toast } = useFeedback();
  const next = useDepositNext();
  const queue = TAB.useTab();
  const sid = Number(id);
  // Opening a deposit is audited, so do not refetch it in the background.
  const detail = useQuery({ queryKey: ["deposit-detail", sid], queryFn: () => api.get<DepositDetail>(`/api/staff/deposits/${sid}`), staleTime: Infinity, refetchOnWindowFocus: false });
  const d = detail.data;
  const open = OPEN(d?.status);
  const stage: Stage | null = d ? (d.stage ?? (d.status === "pending" ? "first" : d.status === "second_approval" ? "second" : null)) : null;
  const mayFirst = can("deposit.process", "deposit.proof");
  const maySecond = can("deposit.approve_large", "deposit.proof") && d?.firstReviewedBy?.id !== me;
  // Only someone who can give this step's approval holds the item; the person who gave the first approval leaves the second to a colleague.
  const holdable = Boolean(open && ((stage === "first" && mayFirst) || (stage === "second" && maySecond)));
  const hold = useHold({
    base: "/api/staff/deposits",
    id: sid,
    me,
    open,
    holdable,
    claimedBy: d?.claimedBy,
    reload: async () => {
      const r = await detail.refetch();
      return r.data && OPEN(r.data.status) ? r.data.claimedBy : null;
    },
  });
  const [viewed, setViewed] = useState(false);
  const [rejectWith, setRejectWith] = useState<{ reason: string; key: number } | null>(null);
  // What the reviewer found in the statement (first approval).
  const [received, setReceived] = useState("");
  const [sender, setSender] = useState("");
  const [bankRef, setBankRef] = useState("");
  const [receivedOn, setReceivedOn] = useState("");

  const decide = useMutation({
    mutationFn: (x: Decision) => api.post<Partial<DepositDetail>>(`/api/staff/deposits/${sid}/${PATH[x.kind]}`, x.body),
    onSuccess: (res, x) => {
      hold.decided.current = true;
      TAB.remember(TAB.skipped().filter((v) => v !== sid));
      if (d) {
        const who = d.client?.name ?? d.clientName;
        const credited = res?.creditedCents ?? d.creditedCents ?? x.credits;
        const toWallet = credited ? `${money(credited)} is in ${who}'s wallet` : `The money is in ${who}'s wallet`;
        toast(
          x.kind === "reject"
            ? `Rejected ${d.reference}. ${who} has been told why.`
            : x.kind === "return"
              ? `Sent ${d.reference} back for a new first approval.`
              : x.kind === "approve" && (res?.status === "second_approval" || (res?.status === undefined && x.expectSecond))
                ? `${d.reference} now waits for a second approval from another person.`
                : `Approved ${d.reference}. ${toWallet} and they have been told.`,
        );
        for (const key of [["client-wallet", d.clientId], ["client-activity", String(d.clientId)], ["client", String(d.clientId)]]) void client.invalidateQueries({ queryKey: key });
      }
      // Shown fresh if it is opened again, without fetching (and auditing) it now.
      void client.invalidateQueries({ queryKey: ["deposit-detail", sid], refetchType: "none" });
      for (const key of [["deposits"], ["deposits-summary"]]) void client.invalidateQueries({ queryKey: key });
      next.mutate({});
    },
    // Someone else may have decided or taken the item, or the rules changed: show the item as it is now.
    onError: (e) => {
      if (e instanceof ApiError && e.code !== "STEP_UP_REQUIRED" && !e.details?.length && [400, 403, 409].includes(e.status)) void hold.refresh();
    },
  });
  const skip = () => {
    TAB.remember([...TAB.skipped().filter((x) => x !== sid), sid]);
    hold.decided.current = true;
    next.mutate({ release: sid });
  };
  const back = () => navigate("/deposits");

  if (detail.error)
    return (
      <>
        <Link href="/deposits" className="back-link">
          <ArrowLeft size={15} /> Queue
        </Link>
        <ErrorText error={detail.error} />
      </>
    );
  if (!d)
    return (
      <div className="center-screen loading-block">
        <Spinner size={22} />
      </div>
    );

  const lists = checklistsOf(d);
  const reasons = d.rejectReasons?.length ? d.rejectReasons : DEPOSIT_REJECT_REASONS;
  const proofFile: ReviewFile[] = d.proof ? [{ id: d.id, slot: 1, type: d.proof.mime, bytes: d.proof.sizeBytes, url: d.proof.url, label: "Payment proof" }] : [];
  const opened = d.proofOpenedByMe || viewed;
  const unopened = d.proof && !opened ? ["the payment proof"] : [];
  const crypto = d.methodKind === "crypto" || d.method?.kind === "crypto";

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
  const needsSecond = stage === "first" && (d.sentBack || (limit !== null ? (credited ?? d.amountCents) > limit : d.needsSecondApproval));
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
  const assigned = d.client?.assignedTo && typeof d.client.assignedTo === "object" ? d.client.assignedTo.name : null;

  return (
    <ReviewLayout
      onBack={back}
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
      headExtra={
        open &&
        holdable &&
        queue.stage && (
          <span className="review-filter">
            Next: {STAGE_WORD[queue.stage]} only
            <button type="button" className="icon-button" aria-label="Review every step next" title="Review every step next" onClick={() => TAB.setStage(null)}>
              <X size={14} />
            </button>
          </span>
        )
      }
      position={open && stage ? STAGE_LABEL[stage] : undefined}
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
          <h3 className="flush">Client</h3>
          <dl className="details details-tight">
            <dt>Verified name</dt>
            <dd>
              <strong>{d.client?.verifiedName || "–"}</strong>
            </dd>
            <dt>Client</dt>
            <dd>
              {/* A new tab, so the item stays held and the ticked checks stay. */}
              <a href={`/clients/${d.clientId}`} target="_blank" rel="noreferrer">
                {d.clientId} · {d.client?.email ?? d.clientEmail}
              </a>
            </dd>
            <dt>Account</dt>
            <dd>
              <ClientStatus c={{ status: d.client?.status ?? d.clientStatus, lockedUntil: null }} /> <KycStatusBadge status={d.client?.kycStatus ?? d.kycStatus} />
            </dd>
            <dt>Joined</dt>
            <dd>
              {d.client?.createdAt ? formatDate(d.client.createdAt) : "–"}
              {d.client?.country ? ` · ${d.client.country}` : ""}
            </dd>
            <dt>Assigned to</dt>
            <dd>{assigned ?? <span className="muted">Nobody</span>}</dd>
          </dl>

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
              {stage === "first" && canDecide && approveOk && (
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
              )}
              {stage === "second" && (
                <>
                  <h3 className="flush">What the first reviewer found</h3>
                  <Found d={d} />
                </>
              )}
              <ReviewDecision
                resetKey={sid}
                checklist={stage === "second" ? lists.second : lists.first}
                reasons={reasons}
                busy={decide.isPending || next.isPending}
                error={(decide.variables?.kind === "return" ? null : decide.error) ?? next.error}
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
                onApprove={(checklist, note) =>
                  stage === "second"
                    ? decide.mutate({
                        kind: "second",
                        body: { checklist, ...(note ? { note } : {}) },
                        credits: d.receivedMinor ? toUsdCents(d.receivedMinor, d.currency, d.usdRate) : null,
                      })
                    : decide.mutate({
                        kind: "approve",
                        body: { receivedAmount: received.trim(), senderName: sender.trim(), bankReference: bankRef.trim(), receivedOn, checklist, ...(note ? { note } : {}) },
                        expectSecond: needsSecond,
                        credits: credited,
                      })
                }
                onReject={(reason, _checklist, note) => decide.mutate({ kind: "reject", body: { reason, ...(note ? { note } : {}) } })}
                onSkip={holdable ? skip : undefined}
                onBack={back}
              />
              {stage === "second" && canDecide && (
                <SendBack
                  label="Send back to first approval"
                  help="The first approval is cleared and the deposit goes back to the queue, so someone checks the statement again."
                  blocked={d.can?.returnToFirst && !d.can.returnToFirst.ok ? d.can.returnToFirst.reason : null}
                  busy={decide.isPending || next.isPending}
                  error={decide.variables?.kind === "return" ? decide.error : null}
                  onSend={(note) => decide.mutate({ kind: "return", body: { note } })}
                />
              )}
              <p className="muted tight">
                Decisions ask for your 2FA code at most every few minutes. Opening the payment proof is recorded in the audit log.
                {holdable && !hold.heldBy && !hold.away ? " This item is held for you while you work on it." : ""}
              </p>
            </>
          ) : (
            <>
              <div className="notice">
                <p>
                  {d.status === "approved"
                    ? `Approved by ${personName(d.decidedBy)} on ${formatDate(d.decidedAt)}. ${money(d.creditedCents ?? d.amountCents)} was added to the wallet.`
                    : `Rejected by ${personName(d.decidedBy)} on ${formatDate(d.decidedAt)}.${d.rejectReason ? ` Told the client: ${d.rejectReason}` : ""}`}
                </p>
              </div>
              <Found d={d} />
            </>
          )}
          <NotesTrail notes={d.notes} />
        </>
      }
    />
  );
}
