import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Banknote, Clock, Hourglass, Play, Users, X } from "lucide-react";
import { useState } from "react";
import { Link, useLocation } from "wouter";
import { DataGrid, gridQuery, type Column, type GridState } from "../components/DataGrid";
import {
  CopyText,
  dayProblem,
  daysAgo,
  formatDay,
  HoldNotices,
  KIND_LABEL,
  money,
  networkLabel,
  NotesTrail,
  nothingLeft,
  QueueTabs,
  queueTab,
  SendBack,
  SkippedNotice,
  textProblem,
  Tile,
  today,
  useHold,
  useNextItem,
  useWithdrawalSummary,
  WithdrawalStatusBadge,
  type CanDo,
  type Claimer,
  type MoneyNote,
  type Person,
} from "../components/money";
import { DocumentViewer, ReviewDecision, ReviewLayout, Waiting, Warnings, type ReviewFile, type ReviewWarning } from "../components/ReviewWorkbench";
import { Badge, ErrorText, Field, PageHeader, Spinner, useFeedback } from "../components/ui";
import { ApiError, api, formatDate, qs, type Page } from "../lib/api";
import { useCan, useSession } from "../lib/session";
import { moneyReasonProblem, WITHDRAWAL_CHECKLIST, WITHDRAWAL_REJECT_REASONS, type ChecklistItem, type WithdrawalStatus } from "../../shared/money";
import { ClientStatus } from "./Clients";
import { KycStatusBadge } from "./Kyc";

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
}

interface WithdrawalDetail extends WithdrawalItem {
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
  notes: MoneyNote[] | null;
  checklist: { first: ChecklistItem[]; second: ChecklistItem[]; pay: ChecklistItem[] } | unknown;
  rejectReasons: string[];
  client: { id: number; name: string; email: string; status: ClientState; kycStatus: KycState; verifiedName: string; country: string | null; createdAt: string };
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
  /** Read when the server sends them (not part of the current contract). */
  rejectReason?: string | null;
  firstReviewedAt?: string | null;
}

type Tab = "review" | "second_approval" | "to_pay" | "paid" | "rejected" | "all";
const OPEN = (s: WithdrawalStatus | undefined) => s === "pending" || s === "second_approval" || s === "approved";
const TAB_OPEN: Record<Tab, boolean> = { review: true, second_approval: true, to_pay: true, paid: false, rejected: false, all: false };
const STAGE_WORD: Record<Stage, string> = { review: "reviews", second: "second approvals", pay: "payments" };
const STAGE_LABEL: Record<Stage, string> = { review: "Review", second: "Second approval", pay: "Payment" };
const START_LABEL: Record<Stage, string> = { review: "Start reviewing", second: "Start second approvals", pay: "Start paying" };
const STAGE_OF: Partial<Record<WithdrawalStatus, Stage>> = { pending: "review", second_approval: "second", approved: "pay" };

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

const personName = (p: Person | null | undefined) => p?.name ?? "staff";
const destinationText = (w: Pick<WithdrawalItem, "typeName" | "network" | "destinationEnding" | "methodName">) =>
  [w.typeName || w.methodName, networkLabel(w.network), w.destinationEnding ? `ending ${w.destinationEnding.replace(/^\D*ending\s*/i, "")}` : ""].filter(Boolean).join(" · ");

const columns: Column<WithdrawalItem>[] = [
  { key: "created_at", header: "Waiting", sortable: true, width: "110px", render: (w) => (OPEN(w.status) ? <Waiting since={w.createdAt} /> : <span className="muted">{formatDate(w.createdAt)}</span>) },
  {
    key: "client",
    header: "Client",
    render: (w) => (
      <span className="stack-tight">
        <strong>{w.clientName}</strong>
        <small className="muted">
          {w.clientEmail} · {w.clientId}
        </small>
      </span>
    ),
  },
  {
    key: "amount_cents",
    header: "Amount",
    sortable: true,
    render: (w) => (
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
    render: (w) => (
      <span className="stack-tight">
        <span>{destinationText(w)}</span>
        <small className="muted mono">{w.reference}</small>
      </span>
    ),
  },
  {
    key: "status",
    header: "Status",
    render: (w) => (OPEN(w.status) && w.claimedBy ? <Badge tone="info">Being reviewed by {w.claimedBy.name ?? "staff"}</Badge> : <WithdrawalStatusBadge status={w.status} />),
  },
  {
    key: "by",
    header: "Handled by",
    optional: true,
    render: (w) =>
      w.paidBy ? (
        `Paid by ${personName(w.paidBy)}, ${formatDate(w.paidAt)}`
      ) : w.status === "rejected" && w.decidedBy ? (
        `Rejected by ${personName(w.decidedBy)}, ${formatDate(w.decidedAt ?? null)}`
      ) : w.approvedBy ? (
        `Approved by ${personName(w.approvedBy)}, ${formatDate(w.approvedAt)}`
      ) : w.firstReviewedBy ? (
        <span>
          {personName(w.firstReviewedBy)} <small className="muted">(first approval)</small>
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

export function WithdrawalsQueue() {
  const can = useCan();
  const [, navigate] = useLocation();
  const mayReviewStep = can("withdrawal.process");
  const maySecond = can("withdrawal.approve");
  const mayPay = can("withdrawal.pay");
  // Each person opens on the step they work on.
  const [tab, setTab] = useState<Tab>(mayReviewStep ? "review" : maySecond ? "second_approval" : mayPay ? "to_pay" : "review");
  const [state, setState] = useState<GridState>(() => {
    const clientId = initialClient();
    const filters: Record<string, string> = clientId ? { clientId } : {};
    return { page: 1, pageSize: 25, sort: "created_at", dir: "asc", filters };
  });
  const summary = useWithdrawalSummary();
  const next = useWithdrawalNext();
  const queue = TAB.useTab();
  const mayReview = mayReviewStep || maySecond || mayPay;
  const list = useQuery({
    queryKey: ["withdrawals", tab, state],
    queryFn: () => api.get<Page<WithdrawalItem>>(`/api/staff/withdrawals${qs({ ...gridQuery(state), status: tab })}`),
    placeholderData: (prev) => prev,
    refetchInterval: 30_000,
  });
  const changeTab = (t: Tab) => {
    // Waiting items read oldest first, finished ones newest first.
    setTab(t);
    setState({ ...state, page: 1, dir: TAB_OPEN[t] ? "asc" : "desc" });
  };
  const s = summary.data;
  const stage: Stage | null = tab === "review" && mayReviewStep ? "review" : tab === "second_approval" && maySecond ? "second" : tab === "to_pay" && mayPay ? "pay" : null;
  const f = s?.forMe;
  const forMe = f ? (stage === "review" ? f.review : stage === "second" ? f.secondApproval : stage === "pay" ? f.toPay : f.review + f.secondApproval + f.toPay) : undefined;
  const start = () => {
    TAB.setStage(stage);
    next.mutate({});
  };
  return (
    <>
      <PageHeader
        title="Withdrawals"
        description="Withdrawal requests from the client portal and app. The money is held in the client's wallet until it is paid or rejected. Check the destination belongs to the client before you approve it."
        actions={
          mayReview && (
            <button type="button" className="button button-primary" disabled={next.isPending || forMe === 0} onClick={start}>
              {next.isPending ? <Spinner /> : <Play size={16} />} {stage ? START_LABEL[stage] : "Start reviewing"}
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
        <Tile icon={<Hourglass size={20} />} tone="warn" label="Waiting for review" value={s?.review ?? "–"} foot={s ? (s.oldestOpenAt ? `Oldest sent ${formatDate(s.oldestOpenAt)}` : "Nothing waiting") : ""} />
        <Tile icon={<Users size={20} />} tone="info" label="Second approval" value={s?.secondApproval ?? "–"} foot={s && maySecond ? `${s.forMe?.secondApproval ?? 0} for you` : "Large and first withdrawals"} />
        <Tile icon={<Banknote size={20} />} tone="" label="To pay" value={s?.toPay ?? "–"} foot={s && mayPay ? `${s.forMe?.toPay ?? 0} you can pay` : "Approved, not paid yet"} />
        <Tile icon={<Clock size={20} />} tone="bad" label="Open over 24 hours" value={s?.overdue ?? "–"} foot={s ? `${s.decidedToday} finished today${s.decidedTodayByMe != null ? `, ${s.decidedTodayByMe} by you` : ""}` : "Aim to clear these first"} />
      </div>
      <QueueTabs
        value={tab}
        onChange={changeTab}
        options={[
          { value: "review", label: "Review", count: s?.review },
          { value: "second_approval", label: "Second approval", count: s?.secondApproval },
          { value: "to_pay", label: "To pay", count: s?.toPay },
          { value: "paid", label: "Paid" },
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
        rowKey={(w) => w.id}
        onRowClick={(w) => navigate(`/withdrawals/${w.id}`)}
        loading={list.isLoading}
        error={list.error}
        searchPlaceholder="Search reference, client name, email or ID"
        filters={[{ key: "kind", label: "Paid to", options: [{ value: "bank", label: "Bank accounts" }, { value: "crypto", label: "Crypto wallets" }] }]}
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
        emptyTitle={TAB_OPEN[tab] ? "Queue clear" : "Nothing here yet"}
        emptyText={tab === "review" ? "Nothing is waiting for review. Withdrawal requests appear here as soon as clients send them." : "Withdrawals appear here once they reach this step."}
      />
    </>
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

type Decision = { kind: "approve" | "second" | "pay" | "reject" | "return"; body: Record<string, unknown> };
const PATH: Record<Decision["kind"], string> = { approve: "approve", second: "second-approve", pay: "pay", reject: "reject", return: "return" };
/** A payout reference already recorded on another withdrawal: allowed only when the reviewer confirms it. */
const reused = (e: unknown): e is ApiError => e instanceof ApiError && e.status === 409 && (e.code === "PAYOUT_REFERENCE_USED" || /payout reference/i.test(e.message));

export function WithdrawalWorkbench({ id }: { id: string }) {
  const can = useCan();
  const me = useSession().staff.id;
  const client = useQueryClient();
  const [, navigate] = useLocation();
  const { toast, confirm } = useFeedback();
  const next = useWithdrawalNext();
  const queue = TAB.useTab();
  const sid = Number(id);
  // Opening a withdrawal is audited, so do not refetch it in the background.
  const detail = useQuery({ queryKey: ["withdrawal-detail", sid], queryFn: () => api.get<WithdrawalDetail>(`/api/staff/withdrawals/${sid}`), staleTime: Infinity, refetchOnWindowFocus: false });
  const d = detail.data;
  const open = OPEN(d?.status);
  const stage: Stage | null = d ? (d.stage ?? STAGE_OF[d.status] ?? null) : null;
  // Paying a withdrawal that only one person approved needs a second person.
  const singleApprover = d?.approvedBy && (!d.firstReviewedBy || d.firstReviewedBy.id === d.approvedBy.id) ? d.approvedBy.id : null;
  const mayStage =
    stage === "review" ? can("withdrawal.process") : stage === "second" ? can("withdrawal.approve") && d?.firstReviewedBy?.id !== me : stage === "pay" ? can("withdrawal.pay") && singleApprover !== me : false;
  const holdable = Boolean(open && mayStage);
  const hold = useHold({
    base: "/api/staff/withdrawals",
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
  const [payoutRef, setPayoutRef] = useState("");
  const [paidOn, setPaidOn] = useState("");

  const decide = useMutation({
    mutationFn: async (x: Decision) => {
      const url = `/api/staff/withdrawals/${sid}/${PATH[x.kind]}`;
      try {
        return await api.post<Partial<WithdrawalDetail>>(url, x.body);
      } catch (e) {
        // A payout reference already used on another withdrawal is allowed only when the reviewer confirms it.
        if (x.kind === "pay" && reused(e)) {
          const ok = await confirm({
            title: "Use this payout reference again?",
            body: e.message,
            confirmLabel: "Mark as paid anyway",
            danger: true,
          });
          if (ok) return api.post<Partial<WithdrawalDetail>>(url, { ...x.body, confirmReuse: true });
        }
        throw e;
      }
    },
    onSuccess: (res, x) => {
      hold.decided.current = true;
      TAB.remember(TAB.skipped().filter((v) => v !== sid));
      if (d) {
        const who = d.client?.name ?? d.clientName;
        toast(
          x.kind === "reject"
            ? `Rejected ${d.reference}. ${money(d.amountCents)} is back in ${who}'s wallet and they have been told why.`
            : x.kind === "return"
              ? `Sent ${d.reference} back for a new review.`
              : x.kind === "pay"
                ? `Marked ${d.reference} as paid. ${who} has been told.`
                : x.kind === "approve" && res?.status === "second_approval"
                  ? `${d.reference} now waits for a second approval from another person.`
                  : `Approved ${d.reference}. It is ready to be paid.`,
        );
        for (const key of [["client-wallet", d.clientId], ["client-activity", String(d.clientId)], ["client", String(d.clientId)]]) void client.invalidateQueries({ queryKey: key });
      }
      // Shown fresh if it is opened again, without fetching (and auditing) it now.
      void client.invalidateQueries({ queryKey: ["withdrawal-detail", sid], refetchType: "none" });
      for (const key of [["withdrawals"], ["withdrawals-summary"]]) void client.invalidateQueries({ queryKey: key });
      next.mutate({});
    },
    // Someone else may have decided or taken the item, or the rules changed: show the item as it is now.
    onError: (e) => {
      if (e instanceof ApiError && e.code !== "STEP_UP_REQUIRED" && !e.details?.length && [400, 403, 409].includes(e.status) && !reused(e)) void hold.refresh();
    },
  });
  const skip = () => {
    TAB.remember([...TAB.skipped().filter((x) => x !== sid), sid]);
    hold.decided.current = true;
    next.mutate({ release: sid });
  };
  const back = () => navigate("/withdrawals");

  if (detail.error)
    return (
      <>
        <Link href="/withdrawals" className="back-link">
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
  const reasons = d.rejectReasons?.length ? d.rejectReasons : WITHDRAWAL_REJECT_REASONS;
  const x = d.destination;
  const qr: ReviewFile[] = x?.full && x.hasQr && x.qrUrl ? [{ id: d.id, slot: 1, type: "image/png", bytes: 0, url: x.qrUrl, label: "Wallet QR code" }] : [];

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

  return (
    <ReviewLayout
      onBack={back}
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
      headExtra={
        open &&
        holdable &&
        queue.stage && (
          <span className="review-filter">
            Next: {STAGE_WORD[queue.stage]} only
            <button type="button" className="icon-button" aria-label="Work on every step next" title="Work on every step next" onClick={() => TAB.setStage(null)}>
              <X size={14} />
            </button>
          </span>
        )
      }
      position={open && stage ? STAGE_LABEL[stage] : undefined}
      evidence={
        <>
          <Destination d={d} />
          {qr.length > 0 && <DocumentViewer files={qr} />}
        </>
      }
      side={
        <>
          <Warnings items={d.warnings ?? []} />

          <h3>Client</h3>
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
            <dt>Wallet</dt>
            <dd>
              {money(d.wallet?.availableCents)} available
              <small className="muted block">{money(d.wallet?.heldCents)} held, this withdrawal included</small>
            </dd>
          </dl>

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
              {stage === "pay" && canDecide && approveOk && (
                <fieldset className="flush stack">
                  <h3 className="flush">The payment you sent</h3>
                  <Field label="Payout reference" hint={refProblem ? <span className="error-text">{refProblem}</span> : "The transaction reference from the bank or the wallet. The client sees it."}>
                    <input className="input mono" autoComplete="off" value={payoutRef} onChange={(e) => setPayoutRef(e.target.value)} maxLength={120} />
                  </Field>
                  <Field label="Sent on" hint={dateProblem ? <span className="error-text">{dateProblem}</span> : undefined}>
                    <input className="input" type="date" value={paidOn} min={daysAgo(30)} max={today()} onChange={(e) => setPaidOn(e.target.value)} />
                  </Field>
                </fieldset>
              )}
              <ReviewDecision
                reasonRule={moneyReasonProblem}
                resetKey={sid}
                checklist={checklist}
                reasons={reasons}
                busy={decide.isPending || next.isPending}
                error={(decide.variables?.kind === "return" ? null : decide.error) ?? next.error}
                canDecide={canDecide}
                blockedText={blocked}
                approveBlocked={approveBlocked}
                approveHint={approveHint}
                rejectBlocked={rejectBlocked}
                approveLabel={approveLabel}
                notePlaceholder="For example: called the client to confirm the new account"
                onApprove={(ticked, note) => {
                  const extra = note ? { note } : {};
                  if (stage === "pay") decide.mutate({ kind: "pay", body: { payoutReference: payoutRef.trim(), paidOn, checklist: ticked, ...extra } });
                  else if (stage === "second") decide.mutate({ kind: "second", body: { checklist: ticked, ...extra } });
                  else decide.mutate({ kind: "approve", body: { checklist: ticked, ...extra } });
                }}
                onReject={(reason, _ticked, note) => decide.mutate({ kind: "reject", body: { reason, ...(note ? { note } : {}) } })}
                onSkip={holdable ? skip : undefined}
                onBack={back}
              />
              {stage === "second" && canDecide && (
                <SendBack
                  label="Send back to review"
                  help="The first approval is cleared and the withdrawal goes back to the review queue. The money stays held."
                  blocked={d.can?.returnToReview && !d.can.returnToReview.ok ? d.can.returnToReview.reason : null}
                  busy={decide.isPending || next.isPending}
                  error={decide.variables?.kind === "return" ? decide.error : null}
                  onSend={(note) => decide.mutate({ kind: "return", body: { note } })}
                />
              )}
              <p className="muted tight">
                Decisions ask for your 2FA code at most every few minutes. Opening a withdrawal is recorded in the audit log.
                {holdable && !hold.heldBy && !hold.away ? " This item is held for you while you work on it." : ""}
              </p>
            </>
          ) : (
            <div className="notice">
              <p>
                {d.status === "paid"
                  ? `Paid by ${personName(d.paidBy)} on ${formatDate(d.paidAt)}.${d.payoutReference ? ` Payout reference ${d.payoutReference}` : ""}${d.paidOn ? `, sent ${formatDay(d.paidOn)}.` : d.payoutReference ? "." : ""}`
                  : `Rejected${d.decidedBy ? ` by ${personName(d.decidedBy)}` : ""}${d.decidedAt ? ` on ${formatDate(d.decidedAt)}` : ""}. The money went back to the client's wallet.${d.rejectReason ? ` Told the client: ${d.rejectReason}` : ""}`}
              </p>
            </div>
          )}
          <NotesTrail notes={d.notes} />
        </>
      }
    />
  );
}
