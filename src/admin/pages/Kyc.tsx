import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Clock, ExternalLink, FileText, Hourglass } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { CATEGORY_LABEL, KycStatusBadge, useKycSummary, WHAT, type Category, type KycSubmission } from "../components/kyc";
import { nothingLeft, queueTab, useNextItem, HoldNotices, type CanDo } from "../components/queue";
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
  type TrailItem,
} from "../components/review";
import { DecisionError, DocumentViewer, listOf, plainProblem, ReviewDecision, ReviewLayout, Waiting, Warnings, type ReviewFile, type ReviewWarning } from "../components/ReviewWorkbench";
import { Avatar, Badge, Spinner, useFeedback } from "../components/ui";
import { ApiError, api, formatDate } from "../lib/api";
import { useCan, useSession } from "../lib/session";

interface KycFile {
  id: number;
  slot: number;
  type: string;
  bytes: number;
  name: string;
  url: string;
  /** Pages the server counted: 1 for a photo, null for a PDF not counted yet. */
  pages?: number | null;
  /** This reviewer has already opened it, every page of a PDF (the server's record). */
  viewedByMe?: boolean;
  /** PDF pages this reviewer has already seen. */
  viewedPages?: number[];
}

/** The client's latest submission of the other category, for context. */
interface KycOther {
  id: number;
  category: Category;
  status: KycSubmission["status"];
  documentType: string;
  submittedAt: string;
  decidedAt: string | null;
  documents: number | KycFile[];
  files?: KycFile[];
}
const otherFilesOf = (other: KycOther | null) => (other ? (other.files ?? (Array.isArray(other.documents) ? other.documents : [])) : []);

interface KycDetail extends Omit<KycSubmission, "client"> {
  client: KycSubmission["client"] & Partial<CardClient>;
  files: KycFile[];
  profile: { name: string; dob: string | null; gender: string | null; country: string | null; city: string | null; address: string | null; zipcode: string | null } | null;
  history: (KycSubmission & { newer?: boolean })[];
  warnings: (ReviewWarning & { clientId?: number })[];
  checklist: { key: string; label: string }[];
  reasons: string[];
  rejectReasons?: string[];
  /** The ready-made reason for a document that cannot be shown at all. */
  unreadableReason?: string;
  /** The category while it waits for review. */
  stage?: Category | null;
  queue: { pending: number; position: number };
  can?: { approve: CanDo; reject: CanDo; requestNew: CanDo };
  mayApprove?: boolean;
  approveBlockedReason?: string | null;
  /** This reviewer uploaded the documents. */
  uploadedByMe?: boolean;
  isLatest?: boolean;
  other?: KycOther | null;
  trail?: TrailItem[];
}

type Tab = "pending" | "approved" | "rejected" | "withdrawn" | "all";
// The server's approveBlockedReason for a closed account, where every decision is refused.
const CLOSED = "This account is closed.";

// Items skipped in this browser tab, and the document type chosen with Start reviewing.
const TAB = queueTab<Category>("kyc", ["identity", "address"]);

const useKycNext = () =>
  useNextItem({
    base: "/api/staff/kyc",
    route: "/kyc",
    keys: ["kyc", "kyc-summary"],
    tab: TAB,
    nothing: (category, skips) => nothingLeft(category ? `No more ${WHAT[category]} is` : "Nothing more is", skips),
  });

const isPending = (s: { status: KycSubmission["status"] }) => s.status === "pending";

const columns = [
  waitingColumn<KycSubmission>("submitted_at", isPending, (s) => s.submittedAt),
  clientColumn<KycSubmission>((s) => ({ ...s.client, avatarUrl: s.client.avatarUrl ?? s.client.pictureUrl })),
  { key: "what", header: "Document", render: (s: KycSubmission) => `${s.categoryLabel}: ${s.documentType}` },
  { key: "country", header: "Country", render: (s: KycSubmission) => s.client.country ?? "–" },
  statusColumn<KycSubmission>({ badge: (s) => <KycStatusBadge status={s.status} />, open: isPending, claimedBy: (s) => s.claimedBy, warnings: (s) => s.warningCount }),
  handledByColumn<KycSubmission>((s) =>
    s.status === "withdrawn" ? <span className="muted">Taken back by the client</span> : s.decidedBy ? handledBy(s.status === "approved" ? "Approved" : "Rejected", s.decidedBy, s.decidedAt) : <NotYet />,
  ),
];

export function KycReview() {
  const can = useCan();
  const summary = useKycSummary();
  const next = useKycNext();
  const s = summary.data;
  return (
    <ReviewQueuePage<KycSubmission, Tab, Category>
      title="KYC review"
      description="Identity and proof-of-address documents from the client portal and app. Start reviewing to work through the queue oldest first, one item at a time."
      queue={TAB}
      next={next}
      mayReview={can("kyc.decide", "kyc.documents")}
      // The Document filter on the Waiting tab keeps Start reviewing to that document type.
      stageOf={(tab, filters) => (tab === "pending" && (filters.category === "identity" || filters.category === "address") ? filters.category : null)}
      startLabel={(category) => (category ? `Start reviewing ${WHAT[category]}` : "Start reviewing")}
      forMe={(category) => (s ? (category ? (s.forMeByCategory?.[category] ?? s.pending) : (s.forMe ?? s.pending)) : undefined)}
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
        { value: "withdrawn", label: "Taken back by client", open: false },
        { value: "all", label: "All", open: false },
      ]}
      initialTab="pending"
      listKey="kyc"
      listUrl="/api/staff/kyc"
      sort="submitted_at"
      columns={columns}
      rowKey={(s) => s.id}
      filters={[{ key: "category", label: "Document", options: [{ value: "identity", label: "Identity" }, { value: "address", label: "Proof of address" }] }]}
      searchPlaceholder="Search client name, email or ID"
      rowHref={can("kyc.documents") ? (s) => `/kyc/${s.id}` : null}
      noOpenText="Your role shows KYC status only. Opening a submission and its documents needs the KYC documents permission."
      includeClosed
      empty={(tab) =>
        tab === "pending"
          ? { title: "Queue clear", text: "Nothing is waiting for review. Documents appear here as soon as clients upload them." }
          : { title: "Nothing here yet", text: "Submissions appear here once they reach this status." }
      }
    />
  );
}

/** Approves a document that was rejected earlier, for example after the client explained it. */
function ApproveLater({ id, clientId, checklist, hasFiles, blocked, unopened }: { id: number; clientId: number; checklist: { key: string; label: string }[]; hasFiles: boolean; blocked: string | null; unopened: string[] }) {
  const client = useQueryClient();
  const { toast } = useFeedback();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [ticked, setTicked] = useState<string[]>([]);
  const send = useMutation({
    mutationFn: () => api.post<KycSubmission>(`/api/staff/kyc/${id}/change`, { status: "approved", reason: reason.trim(), checklist: ticked }),
    onSuccess: (res) => {
      toast(`Approved ${res.client.name}'s ${res.documentType}. They have been told.`);
      setOpen(false);
      client.setQueryData(["kyc-detail", id], (old: KycDetail | undefined) => (old ? { ...old, ...res } : old));
      for (const key of [["kyc-detail", id], ["kyc"], ["kyc-summary"], ["client", String(clientId)], ["client-kyc", clientId], ["client-activity", String(clientId)]]) void client.invalidateQueries({ queryKey: key });
    },
  });
  if (blocked) return <p className="muted tight">{blocked}</p>;
  if (!open)
    return (
      <button type="button" className="button button-small" onClick={() => setOpen(true)}>
        Approve now
      </button>
    );
  const reasonProblem = plainProblem(reason, "reason");
  const ready = reason.trim().length >= 5 && !reasonProblem && unopened.length === 0 && (!hasFiles || checklist.every((c) => ticked.includes(c.key)));
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        send.mutate();
      }}
    >
      <p className="muted tight">This replaces the rejection. The client is told the document is approved.</p>
      {hasFiles && (
        <ul className="review-checklist">
          {checklist.map((c) => (
            <li key={c.key}>
              <label>
                <input type="checkbox" checked={ticked.includes(c.key)} onChange={() => setTicked((t) => (t.includes(c.key) ? t.filter((k) => k !== c.key) : [...t, c.key]))} />
                <span>{c.label}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <label>
        Why it is approved now (kept in the audit log, not shown to the client)
        <textarea className="input" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} autoFocus />
      </label>
      {reasonProblem && <small className="error-text">{reasonProblem}</small>}
      {unopened.length > 0 && <p className="muted tight">Open {listOf(unopened)} before approving.</p>}
      <DecisionError error={send.error} />
      <div className="actions actions-left">
        <button type="submit" className="button button-primary" disabled={send.isPending || !ready}>
          {send.isPending && <Spinner />} Approve
        </button>
        <button type="button" className="button button-ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Takes back an approval when a document has expired or turns out to be wrong; the client is asked to upload again. */
function RequestNewDocument({ id, clientId, reasons }: { id: number; clientId: number; reasons: string[] }) {
  const client = useQueryClient();
  const { toast } = useFeedback();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const send = useMutation({
    mutationFn: () => api.post<KycSubmission>(`/api/staff/kyc/${id}/request-new`, { reason: reason.trim(), ...(note.trim() ? { note: note.trim() } : {}) }),
    onSuccess: (res) => {
      toast(`Asked ${res.client.name} for a new ${res.documentType}. They have been told why.`);
      setOpen(false);
      setReason("");
      setNote("");
      client.setQueryData(["kyc-detail", id], (old: KycDetail | undefined) => (old ? { ...old, ...res } : old));
      for (const key of [["kyc-detail", id], ["kyc"], ["kyc-summary"], ["client", String(clientId)], ["client-kyc", clientId], ["client-activity", String(clientId)]]) void client.invalidateQueries({ queryKey: key });
    },
  });
  const reasonProblem = plainProblem(reason, "reason");
  const noteProblem = plainProblem(note, "note");
  if (!open)
    return (
      <button type="button" className="button button-small" onClick={() => setOpen(true)}>
        Ask for a new document
      </button>
    );
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        send.mutate();
      }}
    >
      <p className="muted tight">The approval is withdrawn and the client sees this reason in the portal, by email and in their notifications.</p>
      <div className="chips">
        {reasons.map((r) => (
          <button key={r} type="button" className={`chip${reason === r ? " active" : ""}`} onClick={() => setReason(r)}>
            {r}
          </button>
        ))}
      </div>
      <label>
        Reason shown to the client
        <textarea className="input" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} autoFocus />
      </label>
      {reasonProblem && <small className="error-text">{reasonProblem}</small>}
      <label>
        Internal note for staff (optional, never shown to the client)
        <textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} />
      </label>
      {noteProblem && <small className="error-text">{noteProblem}</small>}
      <DecisionError error={send.error} />
      <div className="actions actions-left">
        <button type="submit" className="button button-danger" disabled={send.isPending || reason.trim().length < 5 || !!reasonProblem || !!noteProblem}>
          Withdraw approval and ask again
        </button>
        <button type="button" className="button button-ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

const fileLabel = (f: KycFile, count: number) => (count > 1 ? (f.slot === 1 ? "Front" : "Back") : "Document");
const reviewFiles = (files: KycFile[]): ReviewFile[] => files.map((f) => ({ ...f, label: fileLabel(f, files.length) }));

/** The client's other document (identity when checking an address, and the other way round). */
function OtherCategory({ category, other, showing, onToggle }: { category: Category; other: KycOther | null; showing: boolean; onToggle: () => void }) {
  const files = otherFilesOf(other);
  return (
    <div className="review-other">
      <div className="review-other-head">
        <strong>{CATEGORY_LABEL[category]}</strong>
        <KycStatusBadge status={other?.status ?? "none"} />
      </div>
      {other ? (
        <>
          <small className="muted">
            {other.documentType} · sent {formatDate(other.submittedAt)}
            {other.decidedAt ? ` · decided ${formatDate(other.decidedAt)}` : ""}
          </small>
          <div className="kyc-actions">
            {files.length > 0 && (
              <button type="button" className="button button-small" onClick={onToggle}>
                <FileText size={14} /> {showing ? "Back to this submission" : "View its documents"}
              </button>
            )}
            <a className="button button-small button-ghost" href={`/kyc/${other.id}`} target="_blank" rel="noreferrer">
              <ExternalLink size={14} /> Open in a new tab
            </a>
          </div>
        </>
      ) : (
        <small className="muted">The client has not sent this yet.</small>
      )}
    </div>
  );
}


export function KycWorkbench({ id }: { id: string }) {
  const can = useCan();
  const me = useSession().staff.id;
  const { toast } = useFeedback();
  const next = useKycNext();
  const tab = TAB.useTab();
  const sid = Number(id);
  const mayDecide = can("kyc.decide", "kyc.documents");
  const item = useReviewItem<KycDetail, "approve" | "reject", KycSubmission, Category>({
    base: "/api/staff/kyc",
    route: "/kyc",
    id: sid,
    detailKey: "kyc-detail",
    queue: TAB,
    next,
    me,
    isOpen: isPending,
    holdable: (d) => {
      // Decisions on a closed account are refused, so there is nothing to hold or decide.
      const closed = d.client.status === "closed" || d.approveBlockedReason === CLOSED;
      // An item this reviewer can never finish (their own upload) stays free for colleagues.
      const notForMe = typeof d.uploadedByMe === "boolean" ? d.uploadedByMe || closed : d.mayApprove === false;
      // One already held for them (Start reviewing claims it) is always held, so it is renewed and let go properly.
      return isPending(d) && mayDecide && (!notForMe || d.claimedBy?.id === me);
    },
    claimedBy: (d) => d.claimedBy,
    paths: { approve: "decision", reject: "decision" },
    toast: (_x, res) =>
      res.status === "approved" ? `Approved ${res.client.name}'s ${res.documentType}. They have been told.` : `Rejected ${res.client.name}'s ${res.documentType}. They have been told why.`,
    clientId: (d) => d.client.id,
    invalidate: (d) => [["clients"], ["client-kyc", d.client.id]],
    listKeys: ["kyc", "kyc-summary"],
    mayContinue: mayDecide,
  });
  const { d, hold } = item;
  const pending = item.open;
  const [viewed, setViewed] = useState<ReadonlySet<number>>(() => new Set());
  // PDF pages seen so far, and each PDF's page count as the viewer read it.
  const [pagesSeen, setPagesSeen] = useState<ReadonlyMap<number, ReadonlySet<number>>>(() => new Map());
  const [pageCounts, setPageCounts] = useState<ReadonlyMap<number, number>>(() => new Map());
  const reported = useRef(new Set<string>());
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const mounted = useRef(true);
  useEffect(() => () => void (mounted.current = false), []);
  const [showOther, setShowOther] = useState(false);
  const [rejectWith, setRejectWith] = useState<{ reason: string; key: number } | null>(null);
  // Saving an original needs kyc.download and a recent 2FA code; the server records each download.
  const download = useCallback((f: ReviewFile) => {
    api.saveFile(`${f.url}/download`, f.label).catch((e: unknown) => {
      if (!(e instanceof ApiError && e.code === "STEP_UP_REQUIRED")) toastRef.current(e instanceof ApiError ? e.message : "The file could not be downloaded.", "bad");
    });
  }, []);

  // Documents the server already saw this reviewer open (for example before a reload) count as opened.
  useEffect(() => {
    const seen = d?.files.filter((f) => f.viewedByMe).map((f) => f.id) ?? [];
    if (seen.length) setViewed((prev) => (seen.every((x) => prev.has(x)) ? prev : new Set([...prev, ...seen])));
    for (const f of d?.files ?? []) {
      for (const p of f.viewedPages ?? []) reported.current.add(`${f.id}:${p}`);
      if (f.viewedPages?.length) setPagesSeen((prev) => new Map(prev).set(f.id, new Set([...(prev.get(f.id) ?? []), ...f.viewedPages!])));
    }
  }, [d]);
  const markViewed = useCallback((fileId: number) => setViewed((prev) => (prev.has(fileId) ? prev : new Set(prev).add(fileId))), []);
  // Each PDF page drawn is reported once; it counts here only after the server recorded it, as approving checks there.
  // A dropped connection is retried a few times; after that the reviewer is told, and redrawing the page tries again.
  const markPage = useCallback((fileId: number, page: number, pages: number) => {
    setPageCounts((prev) => (prev.get(fileId) === pages ? prev : new Map(prev).set(fileId, pages)));
    const key = `${fileId}:${page}`;
    if (reported.current.has(key)) return;
    reported.current.add(key);
    const send = (attempt: number) =>
      api.post(`/api/staff/kyc/documents/${fileId}/pages`, { page }).then(
        () => setPagesSeen((prev) => new Map(prev).set(fileId, new Set(prev.get(fileId) ?? []).add(page))),
        (e: unknown) => {
          if (!mounted.current) return;
          const passing = !(e instanceof ApiError) || e.status >= 500 || e.status === 429;
          if (passing && attempt < 3) return void setTimeout(() => mounted.current && send(attempt + 1), 1000 * 2 ** attempt);
          reported.current.delete(key);
          toastRef.current(`Page ${page} could not be marked as opened. Zoom or turn the page to try again.`, "bad");
        },
      );
    void send(0);
  }, []);

  if (!d || item.detail.error) return <ReviewItemMissing error={item.detail.error} route="/kyc" />;
  const closed = d.client.status === "closed" || d.approveBlockedReason === CLOSED;
  const heldBy = hold.heldBy;
  const p = d.profile;
  const files = reviewFiles(d.files);
  // What is left to open of each file, worded for the hint ("the back", "page 2 of the document"); null once fully opened.
  const leftToOpen = (f: ReviewFile) => {
    if (viewed.has(f.id)) return null;
    const what = `the ${f.label.toLowerCase()}`;
    const total = f.type === "application/pdf" ? (f.pages ?? pageCounts.get(f.id)) : undefined;
    const seen = pagesSeen.get(f.id);
    if (!total || !seen?.size) return what;
    const missing = Array.from({ length: total }, (_, i) => i + 1).filter((p) => !seen.has(p));
    if (!missing.length) return null;
    return missing.length === 1 ? `page ${missing[0]} of ${what}` : missing.length <= 3 ? `pages ${listOf(missing.map(String))} of ${what}` : `${missing.length} more pages of ${what}`;
  };
  const unopened = files.map(leftToOpen).filter((u): u is string => u !== null);
  const opened = new Set(files.filter((f) => leftToOpen(f) === null).map((f) => f.id));
  const otherCategory: Category = d.category === "identity" ? "address" : "identity";
  const other = d.other ?? null;
  const otherFiles = reviewFiles(otherFilesOf(other));
  const showingOther = showOther && otherFiles.length > 0;
  const latest = d.isLatest !== false;
  // History is newest first, so this is the client's current submission (a withdrawn upload does not count).
  const newer = d.history.find((h) => h.newer && h.status !== "withdrawn");
  const approveBlocked = d.can
    ? d.can.approve.ok
      ? null
      : (d.can.approve.reason ?? "You cannot approve this submission.")
    : d.mayApprove === false
      ? (d.approveBlockedReason ?? "You cannot approve this submission.")
      : null;
  const reasons = d.rejectReasons?.length ? d.rejectReasons : d.reasons;
  const warnings: ReviewWarning[] = d.warnings.map((w) => (w.clientId && !w.href ? { ...w, href: `/clients/${w.clientId}`, linkLabel: "Open that client" } : w));
  const blocked = !pending
    ? null
    : !mayDecide
      ? "You can look at this submission but not approve or reject it."
      : closed
        ? "This account is closed. Reopen it before deciding."
        : heldBy
          ? `${heldBy} is reviewing this right now.`
          : null;
  const requestNew = d.can?.requestNew ?? { ok: mayDecide, reason: null };

  return (
    <ReviewLayout
      onBack={item.back}
      title={
        <>
          {d.client.name} <KycStatusBadge status={d.status} />
        </>
      }
      subtitle={
        <>
          {d.categoryLabel}: {d.documentType} · sent {formatDate(d.submittedAt)}
          {pending && (
            <>
              {" "}
              · waiting <Waiting since={d.submittedAt} />
            </>
          )}
        </>
      }
      headExtra={pending && mayDecide && tab.stage && <NextOnly what={WHAT[tab.stage]} clearLabel="Review every document type next" onClear={() => TAB.setStage(null)} />}
      position={pending ? positionText(d.queue, `${WHAT[d.category].charAt(0).toUpperCase()}${WHAT[d.category].slice(1)}`) : undefined}
      evidence={
        <DocumentViewer
          files={showingOther ? otherFiles : files}
          viewed={showingOther ? undefined : opened}
          pagesSeen={showingOther ? undefined : pagesSeen}
          onViewed={showingOther ? undefined : markViewed}
          onPageViewed={showingOther ? undefined : markPage}
          onDownload={can("kyc.download") ? download : undefined}
          onUnreadable={
            !showingOther && pending && mayDecide && !heldBy && !hold.away && !closed && d.unreadableReason ? () => setRejectWith({ reason: d.unreadableReason!, key: Date.now() }) : undefined
          }
          banner={
            showingOther &&
            other && (
              <>
                Showing the client's {WHAT[other.category]} ({other.documentType}, {other.status === "pending" ? "waiting for review" : other.status}).{" "}
                <button type="button" className="button-link" onClick={() => setShowOther(false)}>
                  Back to this submission
                </button>
              </>
            )
          }
        />
      }
      side={
        <>
          <ClientCard client={{ ...d.client, status: (d.client.status ?? "active") as CardClient["status"] }} picture={false} />
          <h3>Compare with what the client entered</h3>
          <div className="review-person">
            <Avatar name={d.client.name} src={d.client.avatarUrl ?? d.client.pictureUrl} xl />
            <small className="muted">{(d.client.avatarUrl ?? d.client.pictureUrl) ? "Profile picture the client uploaded" : "No profile picture"}</small>
          </div>
          <dl className="details details-tight">
            <dt>Name</dt>
            <dd>
              <strong>{p?.name}</strong>
            </dd>
            <dt>Date of birth</dt>
            <dd>{p?.dob ?? "–"}</dd>
            {d.category === "identity" && (
              <>
                <dt>Gender</dt>
                <dd>{p?.gender ?? "–"}</dd>
              </>
            )}
            <dt>Country</dt>
            <dd>{p?.country ?? "–"}</dd>
            {d.category === "address" && (
              <>
                <dt>Address</dt>
                <dd>
                  <strong>{p?.address ?? "–"}</strong>
                  <br />
                  {[p?.city, p?.zipcode].filter(Boolean).join(", ")}
                </dd>
              </>
            )}
          </dl>
          <OtherCategory category={otherCategory} other={other} showing={showingOther} onToggle={() => setShowOther(!showOther)} />
          <Warnings items={warnings} />
          {pending ? (
            <>
              <HoldNotices away={hold.away} heldBy={heldBy} holdable={item.holdable} busy={hold.claim.isPending} onResume={hold.resume} onTakeOver={() => hold.claim.mutate(true)} />
              <ReviewDecision
                continues={item.mayContinue}
                resetKey={sid}
                checklist={d.checklist}
                reasons={reasons}
                busy={item.decide.isPending || next.isPending}
                error={item.decide.error ?? next.error}
                canDecide={mayDecide && !heldBy && !hold.away && !closed}
                blockedText={blocked}
                approveBlocked={approveBlocked}
                unopened={unopened}
                rejectWith={rejectWith}
                onApprove={(checklist, note) => item.decide.mutate({ kind: "approve", body: { decision: "approve", checklist, ...(note ? { note } : {}) } })}
                onReject={(reason, checklist, note) => item.decide.mutate({ kind: "reject", body: { decision: "reject", reason, checklist, ...(note ? { note } : {}) } })}
                onSkip={item.holdable ? item.skip : undefined}
                onBack={item.back}
                footnote={<ReviewFootnote recorded="Opening documents" held={item.holdable && !heldBy && !hold.away} />}
              />
            </>
          ) : (
            <DecidedNotice>
              {d.status === "withdrawn" ? "The client took this upload back before it was reviewed." : `${decidedLine(d.status === "approved" ? "Approved" : "Rejected", d.decidedBy, d.decidedAt)}${toldClient(d.rejectReason)}`}
            </DecidedNotice>
          )}
          {!latest && newer && (
            <div className="notice notice-warn">
              <p>
                The client sent a newer {WHAT[d.category]} after this one. Make any changes there.{" "}
                {pending ? (
                  <a href={`/kyc/${newer.id}`} target="_blank" rel="noreferrer">
                    Open the newer one
                  </a>
                ) : (
                  <Link href={`/kyc/${newer.id}`}>Open the newer one</Link>
                )}
              </p>
            </div>
          )}
          {latest && d.status === "approved" && mayDecide && (requestNew.ok ? <RequestNewDocument id={sid} clientId={d.client.id} reasons={reasons} /> : requestNew.reason && <p className="muted tight">{requestNew.reason}</p>)}
          {latest && d.status === "rejected" && mayDecide && (
            <ApproveLater id={sid} clientId={d.client.id} checklist={d.checklist} hasFiles={d.files.length > 0} blocked={approveBlocked} unopened={unopened} />
          )}
          <ReviewHistory items={d.trail} />
          {d.history.length > 0 && (
            <>
              <h3>Other attempts</h3>
              <ul className="session-list">
                {d.history.map((h) => (
                  <li key={h.id}>
                    <div>
                      <Badge tone={h.newer ? "info" : "neutral"}>{h.newer ? "Later" : "Earlier"}</Badge>
                      {/* While this item is held, a new tab keeps the hold and the ticked checks. */}
                      {pending ? (
                        <a href={`/kyc/${h.id}`} target="_blank" rel="noreferrer">
                          {h.documentType}
                        </a>
                      ) : (
                        <Link href={`/kyc/${h.id}`}>{h.documentType}</Link>
                      )}{" "}
                      <KycStatusBadge status={h.status} />
                    </div>
                    <small className="muted">
                      Sent {formatDate(h.submittedAt)}
                      {h.decidedBy && (h.status === "approved" || h.status === "rejected") ? ` · ${h.status} by ${h.decidedBy}, ${formatDate(h.decidedAt)}` : ""}
                      {h.rejectReason ? ` · ${h.rejectReason}` : ""}
                    </small>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      }
    />
  );
}
