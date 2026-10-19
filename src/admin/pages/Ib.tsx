import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarPlus, CheckCircle2, Clock, Hourglass, Network, UserMinus } from "lucide-react";
import { useState } from "react";
import { Link, useLocation } from "wouter";
import { DataGrid, gridQuery, type Column, type GridState } from "../components/DataGrid";
import { IbStatusBadge, PartnerBadge, usdText, useIbSummary, type IbStatus } from "../components/ib";
import { KycStatusBadge } from "../components/kyc";
import { HoldNotices, nothingLeft, QueueTabs, queueTab, Tile, useNextItem, type CanDo, type Claimer, type Person } from "../components/queue";
import {
  ClientCard,
  clientColumn,
  DecidedNotice,
  decidedLine,
  handledBy,
  handledByColumn,
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
import { DecisionError, plainProblem, ReviewDecision, ReviewLayout, Waiting, Warnings, type ReviewWarning } from "../components/ReviewWorkbench";
import { Avatar, Badge, Field, PageHeader, Spinner, useFeedback } from "../components/ui";
import { api, formatDate, qs, type Page } from "../lib/api";
import { useCan, useSession } from "../lib/session";
import { moneyReasonProblem, type ChecklistItem } from "../../shared/money";

// IB applications (a queue like KYC, deposits and withdrawals) and the list of
// IB partners. Approving makes the client an introducing broker: their IB
// Dashboard opens in the portal and the app.

type KycWord = "none" | "pending" | "approved" | "rejected" | "withdrawn";
type ClientState = "active" | "frozen" | "closed";

interface IbApplicationRow {
  id: number;
  status: IbStatus;
  submittedAt: string;
  decidedAt: string | null;
  client: ListClient & { country: string | null; status: ClientState };
  kyc: { identity: KycWord; address: KycWord };
  referredClients: number;
  claimedBy: Claimer | null;
  decidedBy: Person | null;
  removedAt: string | null;
  removedBy: Person | null;
  warningCount: number;
}

interface IbDetail {
  id: number;
  status: IbStatus;
  stage: "review" | null;
  submittedAt: string;
  decidedAt: string | null;
  decidedBy: Person | null;
  /** Why it was rejected, or why the IB status was removed: what the client was told. */
  rejectReason: string | null;
  removedAt: string | null;
  removedBy: Person | null;
  termsVersion: string | null;
  submittedIp: string | null;
  submittedUserAgent: string | null;
  tierId: number | null;
  client: CardClient & { verifiedName: string };
  facts: {
    kyc: { identity: KycWord; address: KycWord };
    deposits: { count: number; totalUsd: number; firstAt: string | null } | null;
    withdrawals: { count: number; totalUsd: number } | null;
    wallet: { availableUsd: number } | null;
    mt5: { liveAccounts: number; lots: number } | null;
    referrals: { direct: number; funded: number; network: number; depositsUsd: number | null };
    sponsor: { id: number; name: string; isIb: boolean } | null;
  };
  earlier: { id: number; status: IbStatus; newer: boolean; submittedAt: string; decidedAt: string | null; reason: string | null }[];
  /** The client's partnership now, which may come from a newer application. */
  partner: {
    status: "active" | "removed";
    applicationId: number;
    tier: string;
    tierId: number;
    approvedAt: string;
    removedAt: string | null;
    removedReason: string | null;
    removedBy: Person | null;
  } | null;
  warnings: ReviewWarning[];
  checklist: { review: ChecklistItem[] };
  rejectReasons: string[];
  removeReasons: string[];
  tiers: { id: number; name: string; position: number }[];
  defaultTierId: number | null;
  can: { approve: CanDo; reject: CanDo; remove: CanDo };
  /** This reviewer set up the client's account or KYC, so another person must approve (four eyes). */
  setUpByMe: boolean;
  claimedBy: Claimer | null;
  claimMinutes: number;
  queue: { pending: number; position: number | null };
  trail: TrailItem[];
}

type Tab = IbStatus | "all";
type Kind = "approve" | "reject";
const isPending = (a: { status: IbStatus }) => a.status === "pending";

// IB applications have one step, so Start reviewing keeps to no stage.
const TAB = queueTab<never>("ib", []);

const useIbNext = () =>
  useNextItem({ base: "/api/staff/ib/applications", route: "/ib", keys: ["ib", "ib-summary"], tab: TAB, nothing: (_stage, skips) => nothingLeft("No more IB applications are", skips) });

const KYC_WORD: Record<KycWord, string> = { none: "not sent", pending: "waiting", approved: "verified", rejected: "rejected", withdrawn: "taken back" };

function KycCell({ kyc }: { kyc: IbApplicationRow["kyc"] }) {
  if (kyc.identity === "approved" && kyc.address === "approved") return <KycStatusBadge status="approved" />;
  return (
    <span className="stack-tight">
      <small>Identity {KYC_WORD[kyc.identity] ?? kyc.identity}</small>
      <small>Address {KYC_WORD[kyc.address] ?? kyc.address}</small>
    </span>
  );
}

const columns: Column<IbApplicationRow>[] = [
  waitingColumn<IbApplicationRow>("submitted_at", isPending, (a) => a.submittedAt),
  clientColumn<IbApplicationRow>((a) => a.client),
  { key: "country", header: "Country", optional: true, render: (a) => a.client.country ?? "–" },
  { key: "kyc", header: "KYC", render: (a) => <KycCell kyc={a.kyc} /> },
  { key: "referred", header: "Referred clients", render: (a) => a.referredClients.toLocaleString() },
  statusColumn<IbApplicationRow>({ badge: (a) => <IbStatusBadge status={a.status} />, open: isPending, claimedBy: (a) => a.claimedBy, warnings: (a) => a.warningCount }),
  handledByColumn<IbApplicationRow>((a) =>
    a.status === "removed" && a.removedBy ? handledBy("Removed", a.removedBy, a.removedAt) : a.decidedBy ? handledBy(a.status === "rejected" ? "Rejected" : "Approved", a.decidedBy, a.decidedAt) : <NotYet />,
  ),
];

export function IbApplications() {
  const can = useCan();
  const summary = useIbSummary();
  const next = useIbNext();
  const s = summary.data;
  return (
    <ReviewQueuePage<IbApplicationRow, Tab, never>
      title="IB applications"
      description="Clients who asked to become introducing brokers from the client portal or app. Check their KYC, history and referrals before you approve; approving opens their IB Dashboard."
      queue={TAB}
      next={next}
      mayReview={can("ib.decide")}
      stageOf={() => null}
      startLabel={() => "Start reviewing"}
      forMe={() => s?.forMe}
      summaryError={summary.error}
      tiles={[
        { icon: <Hourglass size={20} />, tone: "warn", label: "Waiting", value: s?.pending ?? "–", foot: s ? (s.oldestPendingAt ? `Oldest sent ${formatDate(s.oldestPendingAt)}` : "Nothing waiting") : "" },
        { icon: <Clock size={20} />, tone: "bad", label: "Waiting over 24 hours", value: s?.overdue ?? "–", foot: "Aim to clear these first" },
        { icon: <CheckCircle2 size={20} />, tone: "good", label: "Decided today", value: s?.decidedToday ?? "–", foot: s ? `${s.decidedTodayByMe} by you` : "" },
      ]}
      tabs={[
        { value: "pending", label: "Waiting", count: s?.pending, open: true },
        { value: "approved", label: "Approved", open: false },
        { value: "rejected", label: "Rejected", open: false },
        { value: "removed", label: "Removed", open: false },
        { value: "all", label: "All", open: false },
      ]}
      initialTab="pending"
      listKey="ib"
      listUrl="/api/staff/ib/applications"
      sort="submitted_at"
      columns={columns}
      rowKey={(a) => a.id}
      searchPlaceholder="Search client name, email, ID or referral code"
      rowHref={(a) => `/ib/${a.id}`}
      includeClosed
      empty={(tab) =>
        tab === "pending"
          ? { title: "Queue clear", text: "No IB applications are waiting. They appear here as soon as clients send them from the portal or app." }
          : { title: "Nothing here yet", text: "Applications appear here once they reach this status." }
      }
    />
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const notShown = (what: string) => <span className="muted">Your role does not show {what}.</span>;

/** What the reviewer weighs: what the client agreed to, their KYC, money and trading, and who they brought in. */
function ApplicationPanel({ d, open }: { d: IbDetail; open: boolean }) {
  const f = d.facts;
  // While this item is held, links open in a new tab so the hold and the ticked checks stay.
  const link = (href: string, text: string) =>
    open ? (
      <a href={href} target="_blank" rel="noreferrer">
        {text}
      </a>
    ) : (
      <Link href={href}>{text}</Link>
    );
  return (
    <div className="evidence-panel">
      <div className="card-head">
        <div>
          <div className="tile-label">IB application</div>
          <div className="tile-value">{d.client.verifiedName || d.client.name}</div>
        </div>
        <IbStatusBadge status={d.status} />
      </div>

      <h3>What the client agreed to</h3>
      <dl className="details">
        <dt>Terms</dt>
        <dd>{d.termsVersion ? `The IB program terms, version ${d.termsVersion}` : "The IB program terms"}</dd>
        <dt>Sent</dt>
        <dd>{formatDate(d.submittedAt)}</dd>
        <dt>From</dt>
        <dd>
          <span className="mono">{d.submittedIp ?? "–"}</span>
          {d.submittedUserAgent && <small className="muted block">{d.submittedUserAgent}</small>}
        </dd>
      </dl>

      <h3>KYC</h3>
      <dl className="details">
        <dt>Identity</dt>
        <dd>
          <KycStatusBadge status={f.kyc.identity} />
        </dd>
        <dt>Address</dt>
        <dd>
          <KycStatusBadge status={f.kyc.address} />
        </dd>
      </dl>

      <h3>Money and trading</h3>
      <dl className="details">
        <dt>Deposits</dt>
        <dd>
          {f.deposits ? (
            <>
              {plural(f.deposits.count, "approved deposit")}, {usdText(f.deposits.totalUsd)}
              {f.deposits.firstAt && <small className="muted block">First on {formatDate(f.deposits.firstAt)}</small>}
            </>
          ) : (
            notShown("deposits")
          )}
        </dd>
        <dt>Withdrawals</dt>
        <dd>{f.withdrawals ? `${plural(f.withdrawals.count, "paid withdrawal")}, ${usdText(f.withdrawals.totalUsd)}` : notShown("withdrawals")}</dd>
        <dt>Wallet</dt>
        <dd>{f.wallet ? `${usdText(f.wallet.availableUsd)} available` : notShown("the wallet")}</dd>
        <dt>MT5 accounts</dt>
        <dd>{f.mt5 ? `${plural(f.mt5.liveAccounts, "live account")}, ${f.mt5.lots.toLocaleString(undefined, { maximumFractionDigits: 2 })} lots traded` : notShown("MT5 accounts")}</dd>
      </dl>

      <h3>Referrals</h3>
      <dl className="details">
        <dt>Direct clients</dt>
        <dd>
          {plural(f.referrals.direct, "client")}, {f.referrals.funded.toLocaleString()} funded
          {f.referrals.direct > 0 && <small className="block">{link(`/clients?referredBy=${d.client.id}`, "Clients they referred")}</small>}
        </dd>
        <dt>Whole network</dt>
        <dd>
          {plural(f.referrals.network, "client")}
          <small className="muted block">Everyone below them, up to 10 levels down</small>
        </dd>
        <dt>Their deposits</dt>
        <dd>{f.referrals.depositsUsd !== null ? `${usdText(f.referrals.depositsUsd)} from direct clients` : notShown("deposits")}</dd>
      </dl>

      <h3>Sponsor</h3>
      {f.sponsor ? (
        <p className="tight">
          Referred by {link(`/clients/${f.sponsor.id}`, f.sponsor.name || `client ${f.sponsor.id}`)} {f.sponsor.isIb && <Badge tone="info">IB</Badge>}
          {f.sponsor.isIb && d.status === "pending" && <small className="muted block">If approved, they become a sub-IB in {f.sponsor.name || "their sponsor"}'s network.</small>}
        </p>
      ) : (
        <p className="muted tight">The client signed up without a referral.</p>
      )}

      <h3>Other applications</h3>
      {d.earlier.length ? (
        <ul className="session-list">
          {d.earlier.map((e) => (
            <li key={e.id}>
              <div>
                {link(`/ib/${e.id}`, `Sent ${formatDate(e.submittedAt)}`)} <IbStatusBadge status={e.status} /> {e.newer && <Badge tone="neutral">Newer</Badge>}
              </div>
              <small className="muted">
                {e.decidedAt ? `Decided ${formatDate(e.decidedAt)}` : "Not decided yet"}
                {e.reason ? ` · ${e.reason}` : ""}
              </small>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted tight">This is the client's only application.</p>
      )}
    </div>
  );
}

/** Ends an approved partnership: the client stops being an IB and is told why. Asks for a 2FA code. */
function RemoveIbStatus({ d }: { d: IbDetail }) {
  const client = useQueryClient();
  const { toast } = useFeedback();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const send = useMutation({
    mutationFn: () => api.post<IbDetail>(`/api/staff/ib/applications/${d.id}/remove`, { reason: reason.trim(), ...(note.trim() ? { note: note.trim() } : {}) }),
    onSuccess: (res) => {
      toast(`Removed ${d.client.name}'s IB status. They have been told why.`);
      setOpen(false);
      setReason("");
      setNote("");
      // The answer is the application as it is now, so the page shows it without opening (and auditing) it again.
      client.setQueryData(["ib-detail", d.id], res);
      for (const key of [["ib"], ["ib-summary"], ["ib-partners"], ["ib-partners-summary"], ["client", String(d.client.id)], ["client-activity", String(d.client.id)]]) {
        void client.invalidateQueries({ queryKey: key });
      }
    },
  });
  const reasonProblem = plainProblem(reason, "reason") ?? moneyReasonProblem(reason);
  const noteProblem = plainProblem(note, "note");
  if (!open)
    return (
      <button type="button" className="button button-small button-danger" onClick={() => setOpen(true)}>
        <UserMinus size={14} /> Remove IB status
      </button>
    );
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (reason.trim().length >= 5 && !reasonProblem && !noteProblem) send.mutate();
      }}
    >
      <p className="muted tight">The client stops being an IB partner straight away and sees this reason in the portal, by email and in their notifications. They can apply again later.</p>
      <span className="field-label">Reason the client will see</span>
      <div className="chips">
        {d.removeReasons.map((r) => (
          <button key={r} type="button" className={reason === r ? "chip active" : "chip"} onClick={() => setReason(r)}>
            {r}
          </button>
        ))}
      </div>
      <textarea className="input" aria-label="Reason the client will see" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} placeholder="Pick a reason above or write your own" autoFocus />
      {reasonProblem && <small className="error-text">{reasonProblem}</small>}
      <label className="review-note">
        <span className="field-label">Internal note for staff (optional, never shown to the client)</span>
        <textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} />
      </label>
      {noteProblem && <small className="error-text">{noteProblem}</small>}
      <DecisionError error={send.error} />
      <div className="actions actions-left">
        <button type="submit" className="button button-danger-solid" disabled={send.isPending || reason.trim().length < 5 || !!reasonProblem || !!noteProblem}>
          {send.isPending && <Spinner />} Remove IB status
        </button>
        <button type="button" className="button button-ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      <p className="muted tight">You'll be asked for your 2FA code.</p>
    </form>
  );
}

export function IbApplicationWorkbench({ id }: { id: string }) {
  const can = useCan();
  const me = useSession().staff.id;
  const next = useIbNext();
  const sid = Number(id);
  const mayDecide = can("ib.decide");
  const item = useReviewItem<IbDetail, Kind, IbDetail, never>({
    base: "/api/staff/ib/applications",
    route: "/ib",
    id: sid,
    detailKey: "ib-detail",
    queue: TAB,
    next,
    me,
    isOpen: isPending,
    holdable: (d) => {
      // An application this reviewer can never approve (a closed account, or a client they set up) stays free for colleagues,
      // unless it is already held for them.
      const notForMe = d.client.status === "closed" || d.setUpByMe;
      return isPending(d) && mayDecide && (!notForMe || d.claimedBy?.id === me);
    },
    claimedBy: (d) => d.claimedBy,
    paths: { approve: "approve", reject: "reject" },
    toast: (x, _res, d) =>
      x.kind === "approve" ? `Approved ${d.client.name}'s IB application. They have been told and can open their IB Dashboard.` : `Rejected ${d.client.name}'s IB application. They have been told why.`,
    clientId: (d) => d.client.id,
    invalidate: () => [["ib-partners"], ["ib-partners-summary"]],
    listKeys: ["ib", "ib-summary"],
    mayContinue: mayDecide,
  });
  const { d, hold, decide } = item;
  const [tierId, setTierId] = useState<number | null>(null);

  if (!d || item.detail.error) return <ReviewItemMissing error={item.detail.error} route="/ib" />;
  const open = item.open;
  const tiers = [...d.tiers].sort((a, b) => a.position - b.position);
  const tier = tierId ?? d.defaultTierId ?? tiers[0]?.id ?? null;
  const approveOk = d.can.approve.ok;
  const rejectOk = d.can.reject.ok;
  const canDecide = open && (approveOk || rejectOk) && !hold.heldBy && !hold.away;
  const blocked = !open
    ? null
    : !mayDecide
      ? "You can look at this application but not decide it."
      : hold.heldBy
        ? `${hold.heldBy} is reviewing this right now.`
        : !approveOk && !rejectOk
          ? (d.can.approve.reason ?? d.can.reject.reason ?? "You cannot decide this application.")
          : null;
  const current = d.partner && d.partner.applicationId === d.id ? d.partner : null;
  const decided =
    d.status === "approved"
      ? `${decidedLine("Approved", d.decidedBy, d.decidedAt)}${current ? ` IB level: ${current.tier}.` : ""}`
      : d.status === "rejected"
        ? `${decidedLine("Rejected", d.decidedBy, d.decidedAt)}${toldClient(d.rejectReason)}`
        : d.status === "removed"
          ? `${decidedLine("IB status removed", d.removedBy, d.removedAt)}${toldClient(d.rejectReason)}`
          : null;

  return (
    <ReviewLayout
      onBack={item.back}
      title={
        <>
          {d.client.name} <IbStatusBadge status={d.status} />
        </>
      }
      subtitle={
        <>
          IB application · sent {formatDate(d.submittedAt)}
          {open && (
            <>
              {" "}
              · waiting <Waiting since={d.submittedAt} />
            </>
          )}
        </>
      }
      position={open ? positionText(d.queue) : undefined}
      evidence={<ApplicationPanel d={d} open={open} />}
      side={
        <>
          <ClientCard client={d.client} />
          <Warnings items={d.warnings ?? []} />
          {open ? (
            <>
              <HoldNotices away={hold.away} heldBy={hold.heldBy} holdable={item.holdable} busy={hold.claim.isPending} onResume={hold.resume} onTakeOver={() => hold.claim.mutate(true)} />
              <ReviewDecision
                continues={item.mayContinue}
                reasonRule={moneyReasonProblem}
                resetKey={sid}
                checklist={d.checklist.review}
                reasons={d.rejectReasons}
                busy={decide.isPending || next.isPending}
                error={decide.error ?? next.error}
                canDecide={canDecide}
                blockedText={blocked}
                approveBlocked={approveOk ? null : d.can.approve.reason}
                approveHint={tiers.length === 0 ? "No IB levels are set up yet, so the application cannot be approved." : null}
                rejectBlocked={rejectOk ? null : d.can.reject.reason}
                hasDocuments={false}
                notePlaceholder="For example: checked the referrals with the sales team"
                fields={
                  canDecide &&
                  approveOk &&
                  tiers.length > 0 && (
                    <Field label="IB level" hint="The level the partner starts on.">
                      <select className="input" value={tier ?? ""} onChange={(e) => setTierId(Number(e.target.value))}>
                        {tiers.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                  )
                }
                footnote={<ReviewFootnote recorded="Opening an application" held={item.holdable && !hold.heldBy && !hold.away} />}
                onApprove={(checklist, note) => decide.mutate({ kind: "approve", body: { checklist, ...(tier ? { tierId: tier } : {}), ...(note ? { note } : {}) } })}
                onReject={(reason, _checklist, note) => decide.mutate({ kind: "reject", body: { reason, ...(note ? { note } : {}) } })}
                onSkip={item.holdable ? item.skip : undefined}
                onBack={item.back}
              />
            </>
          ) : (
            decided && <DecidedNotice>{decided}</DecidedNotice>
          )}
          {d.partner && d.partner.applicationId > d.id && (
            <p className="muted tight">
              The client's {d.partner.status === "active" ? "current IB partnership comes" : "IB partnership, since removed, came"} from{" "}
              <Link href={`/ib/${d.partner.applicationId}`}>a later application</Link>.
            </p>
          )}
          {d.status === "approved" && mayDecide && (d.can.remove.ok ? <RemoveIbStatus d={d} /> : d.can.remove.reason && <p className="muted tight">{d.can.remove.reason}</p>)}
          <ReviewHistory items={d.trail} />
        </>
      }
    />
  );
}

// ---------- Partners ----------

interface IbPartner {
  clientId: number;
  name: string;
  email: string;
  avatarUrl: string | null;
  clientStatus: ClientState;
  referralCode: string;
  tier: string;
  applicationId: number;
  approvedAt: string;
  approvedBy: Person | null;
  directClients: number;
  fundedClients: number;
  network: number;
  subIbs: number;
  sponsor: { id: number; name: string; isIb: boolean } | null;
  status: "active" | "removed";
  removedAt: string | null;
  removedBy: Person | null;
  removedReason: string | null;
}

type PartnerTab = "active" | "removed" | "all";

const partnerColumns: Column<IbPartner>[] = [
  {
    key: "name",
    header: "Client",
    sortable: true,
    render: (p) => (
      <span className="cell-person">
        <Avatar name={p.name} src={p.avatarUrl} />
        <span>
          <strong>
            {p.name}
            {p.clientStatus === "closed" && (
              <>
                {" "}
                <Badge tone="bad">Account closed</Badge>
              </>
            )}
          </strong>
          <small>
            {p.email} · {p.clientId}
          </small>
        </span>
      </span>
    ),
  },
  { key: "code", header: "Referral code", render: (p) => <span className="mono">{p.referralCode}</span> },
  { key: "tier", header: "Level", render: (p) => p.tier },
  {
    key: "direct",
    header: "Direct clients",
    render: (p) => (
      <span className="stack-tight">
        <span>{p.directClients.toLocaleString()}</span>
        <small className="muted">{p.fundedClients.toLocaleString()} funded</small>
      </span>
    ),
  },
  { key: "network", header: "Network", optional: true, render: (p) => p.network.toLocaleString() },
  { key: "subIbs", header: "Sub-IBs", optional: true, render: (p) => p.subIbs.toLocaleString() },
  { key: "sponsor", header: "Sponsor", optional: true, render: (p) => (p.sponsor ? <span>{p.sponsor.name || `Client ${p.sponsor.id}`}{p.sponsor.isIb && <> <Badge tone="info">IB</Badge></>}</span> : <span className="muted">None</span>) },
  {
    key: "approved_at",
    header: "Approved",
    sortable: true,
    render: (p) => (
      <span className="stack-tight">
        <span>{formatDate(p.approvedAt)}</span>
        {p.status === "removed" ? <small className="muted">{handledBy("Removed", p.removedBy, p.removedAt)}</small> : p.approvedBy && <small className="muted">by {p.approvedBy.name ?? "staff"}</small>}
      </span>
    ),
  },
];

export function IbPartners() {
  const [, navigate] = useLocation();
  const [tab, setTab] = useState<PartnerTab>("active");
  const [state, setState] = useState<GridState>({ page: 1, pageSize: 25, sort: "approved_at", dir: "desc", filters: {} });
  const summary = useQuery({ queryKey: ["ib-partners-summary"], queryFn: () => api.get<{ active: number; removed: number; newThisMonth: number }>("/api/staff/ib/partners/summary") });
  const list = useQuery({
    queryKey: ["ib-partners", tab, state],
    queryFn: () => api.get<Page<IbPartner>>(`/api/staff/ib/partners${qs({ ...gridQuery(state), status: tab })}`),
    placeholderData: (prev) => prev,
  });
  const s = summary.data;
  const columns = tab === "active" ? partnerColumns : [...partnerColumns.slice(0, 1), { key: "status", header: "Status", render: (p: IbPartner) => <PartnerBadge status={p.status} /> }, ...partnerColumns.slice(1)];
  return (
    <>
      <PageHeader title="IB partners" description="Clients approved as introducing brokers, with the clients they brought in. Open a partner to see their client profile and IB partnership." />
      {summary.error && <p className="error-text">The summary could not be loaded. {summary.error instanceof Error ? summary.error.message : ""}</p>}
      <div className="tiles">
        <Tile icon={<Network size={20} />} tone="good" label="Active partners" value={s?.active ?? "–"} foot="Their IB Dashboard is open" />
        <Tile icon={<CalendarPlus size={20} />} tone="info" label="New this month" value={s?.newThisMonth ?? "–"} foot="Approved since the 1st" />
        <Tile icon={<UserMinus size={20} />} tone="" label="Removed" value={s?.removed ?? "–"} foot="IB status taken away" />
      </div>
      <QueueTabs
        value={tab}
        onChange={(t) => {
          setTab(t);
          setState({ ...state, page: 1 });
        }}
        options={[
          { value: "active", label: "Active" },
          { value: "removed", label: "Removed" },
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
        rowKey={(p) => p.clientId}
        onRowClick={(p) => navigate(`/clients/${p.clientId}`)}
        loading={list.isLoading}
        error={list.error}
        searchPlaceholder="Search name, email, client ID or referral code"
        emptyTitle={tab === "removed" ? "Nobody removed" : "No IB partners yet"}
        emptyText={tab === "removed" ? "Partners whose IB status was removed appear here." : "Clients appear here once their IB application is approved."}
      />
    </>
  );
}
