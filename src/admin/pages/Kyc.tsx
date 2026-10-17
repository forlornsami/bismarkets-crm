import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, BadgeCheck, CheckCircle2, Clock, ExternalLink, FileText, Hourglass, Play, UserCheck, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link, useLocation } from "wouter";
import { DataGrid, gridQuery, type Column, type GridState } from "../components/DataGrid";
import { DecisionError, DocumentViewer, listOf, plainProblem, ReviewDecision, ReviewLayout, Waiting, Warnings, type ReviewFile, type ReviewWarning } from "../components/ReviewWorkbench";
import { Avatar, Badge, Dialog, ErrorText, Field, PageHeader, Spinner, useFeedback } from "../components/ui";
import { ApiError, api, formatDate, qs, type Page } from "../lib/api";
import { KYC_TYPES } from "../../shared/kyc-types";
import { useCan, useSession } from "../lib/session";

type Category = "identity" | "address";

export interface KycSubmission {
  id: number;
  /** `status` is read when the server sends it (not part of the current contract). */
  client: { id: number; name: string; email: string; country: string | null; pictureUrl: string | null; status?: string };
  category: Category;
  categoryLabel: string;
  documentType: string;
  status: "pending" | "approved" | "rejected" | "withdrawn";
  rejectReason: string | null;
  submittedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  documents: number;
  source: "client" | "staff";
  uploadedBy: string | null;
  staffNote: string | null;
  claimedBy: { id: number; name: string | null; until: string } | null;
}

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

interface KycTrailEntry {
  at: string;
  action: string;
  label: string;
  staff: string | null;
  reason: string | null;
  internalNote: string | null;
}

interface KycDetail extends KycSubmission {
  files: KycFile[];
  profile: { name: string; dob: string | null; gender: string | null; country: string | null; city: string | null; address: string | null; zipcode: string | null } | null;
  history: (KycSubmission & { newer?: boolean })[];
  warnings: (ReviewWarning & { clientId?: number })[];
  checklist: { key: string; label: string }[];
  reasons: string[];
  queue: { pending: number; position: number };
  mayApprove?: boolean;
  approveBlockedReason?: string | null;
  /** This reviewer uploaded the documents (read when the server sends it; not part of the current contract). */
  uploadedByMe?: boolean;
  isLatest?: boolean;
  other?: KycOther | null;
  trail?: KycTrailEntry[];
}

interface Summary {
  pending: number;
  overdue: number;
  oldestPendingAt: string | null;
  decidedToday: number;
  decidedTodayByMe: number;
}

const WHAT: Record<Category, string> = { identity: "proof of identity", address: "proof of address" };
const CATEGORY_LABEL: Record<Category, string> = { identity: "Identity", address: "Proof of address" };
// The server's approveBlockedReason for a closed account, where every decision is refused.
const CLOSED = "This account is closed.";

export const useKycSummary = (enabled = true) =>
  useQuery({ queryKey: ["kyc-summary"], queryFn: () => api.get<Summary>("/api/staff/kyc/summary"), enabled, refetchInterval: 60_000 });

export function KycStatusBadge({ status }: { status: KycSubmission["status"] | "none" | "partial" }) {
  if (status === "approved") return <Badge tone="good">Approved</Badge>;
  if (status === "partial") return <Badge tone="info">Partly verified</Badge>;
  if (status === "rejected") return <Badge tone="bad">Rejected</Badge>;
  if (status === "pending") return <Badge tone="warn">Waiting for review</Badge>;
  if (status === "withdrawn") return <Badge tone="neutral">Taken back by client</Badge>;
  return <Badge tone="neutral">Not submitted</Badge>;
}

// ---------- The reviewer's queue settings for this browser tab ----------
// Items skipped in this tab, so "next" does not hand them straight back, and the
// document type chosen with Start reviewing, so approve-and-next keeps to it.
const SKIP_KEY = "kyc-skipped";
const CATEGORY_KEY = "kyc-category";
const queueListeners = new Set<() => void>();
let queueVersion = 0;
const readTab = (key: string): unknown => {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
};
const writeTab = (key: string, value: unknown) => {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode */
  }
  queueVersion++;
  queueListeners.forEach((fn) => fn());
};
const skipped = (): number[] => {
  const v = readTab(SKIP_KEY);
  return Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x)) : [];
};
const remember = (ids: number[]) => writeTab(SKIP_KEY, ids.length ? ids.slice(-200) : null);
const nextCategory = (): Category | null => {
  const v = readTab(CATEGORY_KEY);
  return v === "identity" || v === "address" ? v : null;
};
const setNextCategory = (category: Category | null) => writeTab(CATEGORY_KEY, category);
function useQueueTab() {
  useSyncExternalStore(
    (fn) => {
      queueListeners.add(fn);
      return () => queueListeners.delete(fn);
    },
    () => queueVersion,
  );
  return { skipped: skipped(), category: nextCategory() };
}

const nothingWaiting = (category: Category | null, skips: number) => {
  const what = category ? `No more ${WHAT[category]} is` : "Nothing more is";
  return skips ? `${what} waiting for you right now, apart from the ${skips === 1 ? "item" : `${skips} items`} you skipped.` : `${what} waiting for you right now.`;
};

function useNextItem() {
  const [, navigate] = useLocation();
  const { toast } = useFeedback();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (opts: { release?: number } = {}) => {
      const category = nextCategory();
      return api.post<{ id: number | null }>("/api/staff/kyc/next", { skip: skipped(), ...(category ? { category } : {}), ...opts });
    },
    onSuccess: (res) => {
      void client.invalidateQueries({ queryKey: ["kyc-summary"] });
      void client.invalidateQueries({ queryKey: ["kyc"] });
      if (res.id) return navigate(`/kyc/${res.id}`);
      toast(nothingWaiting(nextCategory(), skipped().length));
      navigate("/kyc");
    },
  });
}

const columns: Column<KycSubmission>[] = [
  { key: "submitted_at", header: "Waiting", sortable: true, render: (s) => (s.status === "pending" ? <Waiting since={s.submittedAt} /> : <span className="muted">{formatDate(s.submittedAt)}</span>), width: "120px" },
  {
    key: "client",
    header: "Client",
    render: (s) => (
      <span className="cell-person">
        <Avatar name={s.client.name} src={s.client.pictureUrl} />
        <span>
          <strong>{s.client.name}</strong>
          <small>
            {s.client.email} · {s.client.id}
          </small>
        </span>
      </span>
    ),
  },
  { key: "what", header: "Document", render: (s) => `${s.categoryLabel}: ${s.documentType}` },
  { key: "country", header: "Country", render: (s) => s.client.country ?? "–" },
  {
    key: "status",
    header: "Status",
    render: (s) =>
      s.status === "pending" && s.claimedBy ? (
        <Badge tone="info">Being reviewed by {s.claimedBy.name ?? "staff"}</Badge>
      ) : (
        <KycStatusBadge status={s.status} />
      ),
  },
  { key: "decided", header: "Reviewed by", render: (s) => (s.decidedBy ? `${s.decidedBy}, ${formatDate(s.decidedAt)}` : <span className="muted">Not yet</span>) },
];

// The queue opens on what is waiting, oldest first; Clear comes back here.
const QUEUE_FILTERS = { status: "pending" };

export function KycReview() {
  const can = useCan();
  const [, navigate] = useLocation();
  const [state, setState] = useState<GridState>({ page: 1, pageSize: 25, sort: "submitted_at", dir: "asc", filters: { ...QUEUE_FILTERS } });
  const summary = useKycSummary();
  const next = useNextItem();
  const tab = useQueueTab();
  const mayReview = can("kyc.decide", "kyc.documents");
  const mayOpen = can("kyc.documents");
  const status = state.filters.status ?? "";
  const category = (state.filters.category || null) as Category | null;
  const list = useQuery({
    queryKey: ["kyc", state],
    queryFn: () =>
      api.get<Page<KycSubmission>>(
        `/api/staff/kyc${qs({ ...gridQuery(state), status: status || "all", includeClosed: status === "pending" && state.filters.includeClosed === "1" ? "1" : undefined })}`,
      ),
    placeholderData: (prev) => prev,
    refetchInterval: 30_000,
  });
  const onChange = (nextState: GridState) => {
    // Waiting items read oldest first, decided ones newest first.
    const newStatus = nextState.filters.status ?? "";
    if (newStatus !== status && nextState.sort === state.sort && nextState.dir === state.dir) nextState = { ...nextState, dir: newStatus === "pending" ? "asc" : "desc" };
    // "Show closed accounts" only applies to waiting items; a hidden filter must not look active.
    if (newStatus !== "pending" && nextState.filters.includeClosed) {
      const { includeClosed: _, ...rest } = nextState.filters;
      nextState = { ...nextState, filters: rest };
    }
    setState(nextState);
  };
  const start = () => {
    setNextCategory(category);
    next.mutate({});
  };
  const s = summary.data;
  const tile = (icon: React.ReactNode, tone: string, label: string, value: React.ReactNode, foot: string) => (
    <div className="tile">
      <span className={`tile-icon ${tone}`}>{icon}</span>
      <div>
        <div className="tile-label">{label}</div>
        <div className="tile-value">{value}</div>
        <div className="tile-foot">{foot}</div>
      </div>
    </div>
  );
  return (
    <>
      <PageHeader
        title="KYC review"
        description="Identity and proof-of-address documents from the client portal and app. Start reviewing to work through the queue oldest first, one item at a time."
        actions={
          mayReview && (
            <button type="button" className="button button-primary" disabled={next.isPending || s?.pending === 0} onClick={start}>
              {next.isPending ? <Spinner /> : <Play size={16} />} Start reviewing{category ? ` ${WHAT[category]}` : s?.pending ? ` (${s.pending})` : ""}
            </button>
          )
        }
      />
      <ErrorText error={next.error} />
      {mayReview && tab.skipped.length > 0 && (
        <div className="notice notice-row">
          <p>
            You skipped {tab.skipped.length === 1 ? "an item" : `${tab.skipped.length} items`} in this tab, so Start reviewing passes over {tab.skipped.length === 1 ? "it" : "them"}.
          </p>
          <button
            type="button"
            className="button button-small"
            disabled={next.isPending}
            onClick={() => {
              remember([]);
              start();
            }}
          >
            Review skipped items
          </button>
        </div>
      )}
      {summary.error && <p className="error-text">The queue summary could not be loaded. {summary.error instanceof Error ? summary.error.message : ""}</p>}
      <div className="tiles">
        {tile(<Hourglass size={20} />, "warn", "Waiting", s?.pending ?? "–", s ? (s.oldestPendingAt ? `Oldest sent ${formatDate(s.oldestPendingAt)}` : "Nothing waiting") : "")}
        {tile(<Clock size={20} />, "bad", "Waiting over 24 hours", s?.overdue ?? "–", "Aim to clear these first")}
        {tile(<CheckCircle2 size={20} />, "good", "Reviewed today", s?.decidedToday ?? "–", "By everyone")}
        {tile(<UserCheck size={20} />, "", "Reviewed by you today", s?.decidedTodayByMe ?? "–", "Approved or rejected")}
      </div>
      <DataGrid
        columns={columns}
        rows={list.data?.items}
        total={list.data?.total ?? 0}
        pages={list.data?.pages ?? 1}
        state={state}
        onChange={onChange}
        rowKey={(s) => s.id}
        onRowClick={mayOpen ? (s) => navigate(`/kyc/${s.id}`) : undefined}
        loading={list.isLoading}
        error={list.error}
        searchPlaceholder="Search client name, email or ID"
        filters={[
          { key: "status", label: "Status", options: [{ value: "pending", label: "Waiting for review" }, { value: "approved", label: "Approved" }, { value: "rejected", label: "Rejected" }] },
          { key: "category", label: "Document", options: [{ value: "identity", label: "Identity" }, { value: "address", label: "Proof of address" }] },
        ]}
        defaultFilters={QUEUE_FILTERS}
        toolbar={
          status === "pending" && (
            <label className="check grid-check">
              <input type="checkbox" checked={state.filters.includeClosed === "1"} onChange={(e) => onChange({ ...state, page: 1, filters: { ...state.filters, includeClosed: e.target.checked ? "1" : "" } })} />
              <span>Show closed accounts</span>
            </label>
          )
        }
        emptyTitle="Queue clear"
        emptyText="Nothing is waiting for review. Documents appear here as soon as clients upload them."
      />
    </>
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
      toast(`Approved ${res.client.name}'s ${res.documentType}. The client has been told.`);
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
    mutationFn: () => api.post<KycSubmission>(`/api/staff/kyc/${id}/request-new`, { reason: reason.trim(), ...(note.trim() ? { internalNote: note.trim() } : {}) }),
    onSuccess: (res) => {
      toast(`Asked ${res.client.name} for a new ${res.documentType}. The client has been told why.`);
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

/** What happened to this submission, from the audit log, oldest first. */
function Trail({ items }: { items: KycTrailEntry[] }) {
  return (
    <ol className="timeline trail">
      {items.map((t, i) => {
        const toClient = /(^|\.)(rejected|new_document_requested)$/.test(t.action);
        return (
          <li key={i} className={t.staff ? "by-staff" : ""}>
            <strong>{t.label}</strong>
            <small className="muted">
              {formatDate(t.at)}
              {t.staff ? ` · ${t.staff}` : ""}
            </small>
            {t.reason && <small>{toClient ? `Told the client: ${t.reason}` : t.action === "uploaded_by_staff" ? `Note: ${t.reason}` : `Reason: ${t.reason}`}</small>}
            {t.internalNote && <small className="trail-note">Internal note: {t.internalNote}</small>}
          </li>
        );
      })}
    </ol>
  );
}

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

const IDLE_MS = 10 * 60_000; // let go of an item after 10 minutes without any activity
const RENEW_MS = 5 * 60_000; // the server holds a claim for 15 minutes

export function KycWorkbench({ id }: { id: string }) {
  const can = useCan();
  const session = useSession();
  const me = session.staff.id;
  const client = useQueryClient();
  const [, navigate] = useLocation();
  const { toast } = useFeedback();
  const next = useNextItem();
  const tab = useQueueTab();
  const sid = Number(id);
  // Opening a submission is audited, so do not refetch it in the background.
  const detail = useQuery({ queryKey: ["kyc-detail", sid], queryFn: () => api.get<KycDetail>(`/api/staff/kyc/${sid}`), staleTime: Infinity, refetchOnWindowFocus: false });
  const d = detail.data;
  const pending = d?.status === "pending";
  const mayDecide = can("kyc.decide", "kyc.documents");
  // Decisions on a closed account are refused, so there is nothing to hold or decide.
  const closed = d?.client.status === "closed" || d?.approveBlockedReason === CLOSED;
  // An item this reviewer can never finish (their own upload) stays free for colleagues. Until the server
  // says which items are their own uploads, any item they may not approve counts as one.
  const notForMe = typeof d?.uploadedByMe === "boolean" ? d.uploadedByMe || closed : d?.mayApprove === false;
  // One already held for them (Start reviewing claims it) is always held, so it is renewed and let go properly.
  const holdable = Boolean(pending && mayDecide && (!notForMe || d?.claimedBy?.id === me));
  const heldByOther = useRef(false);
  heldByOther.current = Boolean(d?.claimedBy && d.claimedBy.id !== me);
  const [heldBy, setHeldBy] = useState<string | null>(null);
  const [away, setAway] = useState(false);
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
  const decided = useRef(false);
  const lastActive = useRef(Date.now());
  const lastRenew = useRef(0);

  // Documents the server already saw this reviewer open (for example before a reload) count as opened.
  useEffect(() => {
    const seen = d?.files.filter((f) => f.viewedByMe).map((f) => f.id) ?? [];
    if (seen.length) setViewed((prev) => (seen.every((x) => prev.has(x)) ? prev : new Set([...prev, ...seen])));
    for (const f of d?.files ?? []) {
      for (const p of f.viewedPages ?? []) reported.current.add(`${f.id}:${p}`);
      if (f.viewedPages?.length) setPagesSeen((prev) => new Map(prev).set(f.id, new Set([...(prev.get(f.id) ?? []), ...f.viewedPages!])));
    }
    if (d && d.status === "pending" && d.claimedBy && d.claimedBy.id !== me) setHeldBy(d.claimedBy.name ?? "Another reviewer");
  }, [d, me]);
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
          toastRef.current(`Page ${page} could not be marked as opened. Zoom or turn the page to try again, or download the PDF.`, "bad");
        },
      );
    void send(0);
  }, []);

  // Reload the item to learn who holds it now, or whether it was decided meanwhile.
  const refresh = async () => {
    const r = await detail.refetch();
    const holder = r.data?.status === "pending" ? r.data.claimedBy : null;
    setHeldBy(holder && holder.id !== me ? (holder.name ?? "Another reviewer") : null);
  };
  const claim = useMutation({
    mutationFn: (takeOver: boolean) => api.post<{ claimedBy: KycSubmission["claimedBy"] }>(`/api/staff/kyc/${sid}/claim`, { takeOver }),
    onSuccess: (res) => {
      if (res.claimedBy?.id === me) {
        lastRenew.current = Date.now();
        setHeldBy(null);
        setAway(false);
      } else void refresh();
    },
    onError: (e) => {
      if (e instanceof ApiError && (e.status === 409 || e.status === 400)) {
        setAway(false);
        void refresh();
      }
    },
  });
  const claimRef = useRef(claim.mutate);
  claimRef.current = claim.mutate;

  // Hold the item while the reviewer works on it. The hold is renewed only while
  // they are active, given up after 10 idle minutes, and let go when they leave
  // the item or close the tab.
  useEffect(() => {
    if (!holdable) return;
    decided.current = false;
    lastActive.current = Date.now();
    // When someone else holds it, the screen already names them; claiming would only be refused (and reload the item).
    if (!heldByOther.current) claimRef.current(false);
    const release = () => void api.post(`/api/staff/kyc/${sid}/release`).catch(() => undefined);
    const onActivity = () => {
      lastActive.current = Date.now();
    };
    const activity = ["pointerdown", "pointermove", "keydown", "wheel", "scroll", "touchstart"];
    activity.forEach((ev) => window.addEventListener(ev, onActivity, { capture: true, passive: true }));
    const timer = setInterval(() => {
      if (decided.current || !lastRenew.current) return;
      const now = Date.now();
      if (now - lastActive.current >= IDLE_MS) {
        lastRenew.current = 0;
        release();
        setAway(true);
      } else if (now - lastRenew.current >= RENEW_MS && lastActive.current > lastRenew.current) {
        lastRenew.current = now;
        claimRef.current(false);
      }
    }, 30_000);
    const onHide = () => {
      if (decided.current) return;
      lastRenew.current = 0;
      api.sendOnExit(`/api/staff/kyc/${sid}/release`);
    };
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted && !decided.current) claimRef.current(false);
    };
    window.addEventListener("pagehide", onHide);
    window.addEventListener("pageshow", onShow);
    return () => {
      clearInterval(timer);
      activity.forEach((ev) => window.removeEventListener(ev, onActivity, { capture: true }));
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("pageshow", onShow);
      lastRenew.current = 0;
      if (!decided.current) release();
    };
  }, [sid, holdable]);

  const decide = useMutation({
    mutationFn: (body: { decision: "approve" | "reject"; reason?: string; checklist: string[]; internalNote?: string }) => api.post<KycSubmission>(`/api/staff/kyc/${sid}/decision`, body),
    onSuccess: (res) => {
      decided.current = true;
      remember(skipped().filter((x) => x !== sid));
      toast(res.status === "approved" ? `Approved ${res.client.name}'s ${res.documentType}. The client has been told.` : `Rejected ${res.client.name}'s ${res.documentType}. The client has been told why.`);
      // Shown fresh if it is opened again, without fetching (and auditing) it now.
      void client.invalidateQueries({ queryKey: ["kyc-detail", sid], refetchType: "none" });
      for (const key of [["kyc"], ["kyc-summary"], ["client", String(res.client.id)], ["clients"], ["client-kyc", res.client.id], ["client-activity", String(res.client.id)]]) void client.invalidateQueries({ queryKey: key });
      next.mutate({});
    },
    // Someone else may have decided or taken the item, or the rules changed: show the item as it is now.
    // A refused field (such as a link in the note) is the reviewer's to fix, and reloading would audit another view.
    onError: (e) => {
      if (e instanceof ApiError && e.code !== "STEP_UP_REQUIRED" && !e.details?.length && [400, 403, 409].includes(e.status)) void refresh();
    },
  });
  const skip = () => {
    remember([...skipped().filter((x) => x !== sid), sid]);
    decided.current = true;
    next.mutate({ release: sid });
  };
  const back = () => navigate("/kyc");

  if (detail.error)
    return (
      <>
        <Link href="/kyc" className="back-link">
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
  const trail = d.trail ?? [];
  const latest = d.isLatest !== false;
  // History is newest first, so this is the client's current submission (a withdrawn upload does not count).
  const newer = d.history.find((h) => h.newer && h.status !== "withdrawn");
  const approveBlocked = d.mayApprove === false ? (d.approveBlockedReason ?? "You cannot approve this submission.") : null;
  const warnings: ReviewWarning[] = d.warnings.map((w) => (w.clientId ? { ...w, href: `/clients/${w.clientId}`, linkLabel: "Open that client" } : w));
  const blocked = !pending
    ? null
    : !mayDecide
      ? "You can look at this submission but not approve or reject it."
      : closed
        ? "This account is closed. Reopen it before deciding."
        : heldBy
        ? `${heldBy} is reviewing this right now.`
        : null;

  return (
    <ReviewLayout
      onBack={back}
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
      headExtra={
        pending &&
        mayDecide &&
        tab.category && (
          <span className="review-filter">
            Next: {WHAT[tab.category]} only
            <button type="button" className="icon-button" aria-label="Review every document type next" title="Review every document type next" onClick={() => setNextCategory(null)}>
              <X size={14} />
            </button>
          </span>
        )
      }
      position={pending ? `${d.queue.position} of ${d.queue.pending} waiting` : undefined}
      evidence={
        <DocumentViewer
          files={showingOther ? otherFiles : files}
          viewed={showingOther ? undefined : opened}
          pagesSeen={showingOther ? undefined : pagesSeen}
          onViewed={showingOther ? undefined : markViewed}
          onPageViewed={showingOther ? undefined : markPage}
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
          <h3 className="flush">Compare with what the client entered</h3>
          <div className="review-person">
            <Avatar name={d.client.name} src={d.client.pictureUrl} xl />
            <small className="muted">{d.client.pictureUrl ? "Profile picture the client uploaded" : "No profile picture"}</small>
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
            <dt>Client</dt>
            <dd>
              {/* A new tab, so the item stays held and the ticked checks stay. */}
              <a href={`/clients/${d.client.id}`} target="_blank" rel="noreferrer">
                {d.client.id} · {d.client.email}
              </a>
            </dd>
          </dl>
          <OtherCategory category={otherCategory} other={other} showing={showingOther} onToggle={() => setShowOther(!showOther)} />
          <Warnings items={warnings} />
          {pending ? (
            <>
              {away && (
                <div className="notice notice-warn notice-row">
                  <p>You were away for a while, so this item was released for other reviewers.</p>
                  <button
                    type="button"
                    className="button button-small"
                    disabled={claim.isPending}
                    onClick={() => {
                      lastActive.current = Date.now();
                      claim.mutate(false);
                    }}
                  >
                    Continue reviewing
                  </button>
                </div>
              )}
              {heldBy && holdable && (
                <button type="button" className="button button-small" onClick={() => claim.mutate(true)} disabled={claim.isPending}>
                  Take over the review
                </button>
              )}
              <ReviewDecision
                resetKey={sid}
                checklist={d.checklist}
                reasons={d.reasons}
                busy={decide.isPending || next.isPending}
                error={decide.error ?? next.error}
                canDecide={mayDecide && !heldBy && !away && !closed}
                blockedText={blocked}
                approveBlocked={approveBlocked}
                unopened={unopened}
                onApprove={(checklist, internalNote) => decide.mutate({ decision: "approve", checklist, internalNote })}
                onReject={(reason, checklist, internalNote) => decide.mutate({ decision: "reject", reason, checklist, internalNote })}
                onSkip={mayDecide ? skip : undefined}
                onBack={back}
              />
              <p className="muted tight">
                Decisions ask for your 2FA code at most every few minutes. Opening documents is recorded in the audit log.
                {holdable && !heldBy && !away ? " This item is held for you while you work on it." : ""}
              </p>
            </>
          ) : (
            <div className="notice">
              <p>
                {d.status === "withdrawn"
                  ? "The client took this upload back before it was reviewed."
                  : `${d.status === "approved" ? "Approved" : "Rejected"} by ${d.decidedBy ?? "staff"} on ${formatDate(d.decidedAt)}.${d.rejectReason ? ` Reason: ${d.rejectReason}` : ""}`}
              </p>
            </div>
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
          {latest && d.status === "approved" && mayDecide && <RequestNewDocument id={sid} clientId={d.client.id} reasons={d.reasons} />}
          {latest && d.status === "rejected" && mayDecide && (
            <ApproveLater id={sid} clientId={d.client.id} checklist={d.checklist} hasFiles={d.files.length > 0} blocked={approveBlocked} unopened={unopened} />
          )}
          {trail.length > 0 && (
            <>
              <h3>What happened</h3>
              <Trail items={trail} />
            </>
          )}
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

/** The KYC panel on a client's page. */
export function ClientKyc({ clientId, status }: { clientId: number; status: "none" | "partial" | "pending" | "approved" | "rejected" }) {
  const can = useCan();
  const list = useQuery({
    queryKey: ["client-kyc", clientId],
    queryFn: () => api.get<Page<KycSubmission>>(`/api/staff/kyc${qs({ clientId, status: "all", pageSize: 50 })}`),
    enabled: can("kyc.view"),
  });
  const mayOpen = can("kyc.documents");
  // Newest first; an upload the client took back no longer counts.
  const latest = (category: Category) => list.data?.items.find((s) => s.category === category && s.status !== "withdrawn");
  const [action, setAction] = useState<{ category: Category; mode: "upload" | "approve" } | null>(null);
  return (
    <section className="panel">
      <div className="card-head">
        <h2 className="flush">
          <BadgeCheck size={18} /> Verification
        </h2>
        <KycStatusBadge status={status} />
      </div>
      {!can("kyc.view") ? (
        <p className="muted">You do not have access to KYC documents.</p>
      ) : list.error ? (
        <ErrorText error={list.error} />
      ) : !list.data ? (
        <Spinner />
      ) : (
        <dl className="details">
          {(["identity", "address"] as const).map((cat) => {
            const s = latest(cat);
            const what = (
              <>
                <KycStatusBadge status={s?.status ?? "none"} /> {s?.documentType}
              </>
            );
            return [
              <dt key={`${cat}-t`}>{CATEGORY_LABEL[cat]}</dt>,
              <dd key={`${cat}-d`}>
                {s && mayOpen ? <Link href={`/kyc/${s.id}`}>{what}</Link> : what}
                {s && (
                  <small className="muted block">
                    Sent {formatDate(s.submittedAt)}
                    {s.decidedBy && (s.status === "approved" || s.status === "rejected") ? ` · ${s.status} by ${s.decidedBy}, ${formatDate(s.decidedAt)}` : ""}
                  </small>
                )}
                {s?.rejectReason && <small className="muted block">Reason: {s.rejectReason}</small>}
                {s?.source === "staff" && (
                  <small className="muted block">
                    {s.documents ? `Uploaded by ${s.uploadedBy}` : `Added without documents by ${s.uploadedBy}`}
                    {s.staffNote ? `: ${s.staffNote}` : ""}
                  </small>
                )}
                {(!s || s.status === "rejected") && (can("kyc.upload") || can("kyc.override")) && (
                  <span className="kyc-actions">
                    {can("kyc.upload") && (
                      <button type="button" className="button button-small" onClick={() => setAction({ category: cat, mode: "upload" })}>
                        Upload for client
                      </button>
                    )}
                    {can("kyc.override") && (
                      <button type="button" className="button button-small" onClick={() => setAction({ category: cat, mode: "approve" })}>
                        Approve without documents
                      </button>
                    )}
                  </span>
                )}
              </dd>,
            ];
          })}
        </dl>
      )}
      {action && <StaffKycDialog clientId={clientId} category={action.category} mode={action.mode} onClose={() => setAction(null)} />}
    </section>
  );
}

/** A small preview of a chosen file, drawn on a canvas (blob: images are blocked by the CRM's content policy). */
function ChosenFile({ file }: { file: File }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [preview, setPreview] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let bitmap: ImageBitmap | null = null;
    setPreview(false);
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return;
    createImageBitmap(file, { resizeWidth: 144, resizeQuality: "medium", imageOrientation: "from-image" })
      .then((b) => {
        bitmap = b;
        const canvas = ref.current;
        if (cancelled || !canvas) return;
        canvas.width = b.width;
        canvas.height = b.height;
        canvas.getContext("2d")?.drawImage(b, 0, 0);
        setPreview(true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      bitmap?.close();
    };
  }, [file]);
  const size = file.size > 1024 * 1024 ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(file.size / 1024)} KB`;
  return (
    <span className="file-chosen">
      <canvas ref={ref} className="file-thumb" hidden={!preview} aria-hidden />
      {!preview && <FileText size={28} className="muted" />}
      <span>
        <strong>{file.name}</strong>
        <small className="muted block">{size}</small>
      </span>
    </span>
  );
}

/** Upload documents for the client, or approve without documents. Both ask for a 2FA code and are audited. */
function StaffKycDialog({ clientId, category, mode, onClose }: { clientId: number; category: Category; mode: "upload" | "approve"; onClose: () => void }) {
  const client = useQueryClient();
  const { toast } = useFeedback();
  const types = KYC_TYPES[category].subTypes;
  const [subType, setSubType] = useState<number>(types[0]!.id);
  const [files, setFiles] = useState<(File | null)[]>([null, null]);
  const [note, setNote] = useState("");
  const needs = types.find((t) => t.id === subType)?.documents ?? 1;
  const what = WHAT[category];
  const send = useMutation({
    mutationFn: () => {
      if (mode === "approve") return api.post<KycSubmission>("/api/staff/kyc/approve-without-documents", { clientId, category, subType, reason: note.trim() });
      const form = new FormData();
      form.set("client_id", String(clientId));
      form.set("type", String(KYC_TYPES[category].type));
      form.set("sub_type", String(subType));
      form.set("note", note.trim());
      files.slice(0, needs).forEach((f, i) => f && form.set(`document${i + 1}`, f));
      return api.form<KycSubmission>("/api/staff/kyc/upload", form);
    },
    onSuccess: () => {
      toast(mode === "approve" ? `The client's ${what} is approved without documents.` : `Uploaded. The ${what} is now waiting for another reviewer.`);
      for (const key of [["kyc"], ["kyc-summary"], ["client", String(clientId)], ["client-kyc", clientId], ["client-activity", String(clientId)], ["clients"]]) void client.invalidateQueries({ queryKey: key });
      onClose();
    },
  });
  const ready = note.trim().length >= 5 && (mode === "approve" || files.slice(0, needs).every(Boolean));
  return (
    <Dialog open title={mode === "approve" ? `Approve ${what} without documents` : `Upload ${what} for the client`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send.mutate();
        }}
      >
        <p className="muted">
          {mode === "approve"
            ? "Use this only when the client was verified another way. The client is told they are verified, and the reason is kept in the audit log."
            : "For documents the client sent another way, such as by email. Another reviewer approves them from the KYC queue."}
        </p>
        <Field label="Document type">
          <select
            className="input"
            value={subType}
            onChange={(e) => {
              setSubType(Number(e.target.value));
              // A file picked for another type must never go up unseen.
              setFiles([null, null]);
            }}
          >
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
        {mode === "upload" &&
          Array.from({ length: needs }, (_, i) => (
            <Field key={`${subType}-${i}`} label={needs === 2 ? (i === 0 ? "Front" : "Back") : "Document"} hint="JPG, PNG, WebP or HEIC photo, or a PDF, up to 10 MB">
              <input
                className="input"
                type="file"
                accept="image/jpeg,image/png,image/webp,image/heic,.heic,application/pdf,.pdf"
                onChange={(e) => setFiles((f) => f.map((old, j) => (j === i ? (e.target.files?.[0] ?? null) : old)))}
              />
              {files[i] && <ChosenFile file={files[i]} />}
            </Field>
          ))}
        <Field label={mode === "approve" ? "How the client was verified" : "Where these documents came from"} hint="Kept in the audit log. You'll be asked for your 2FA code.">
          <textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} required />
        </Field>
        <ErrorText error={send.error} />
        <div className="actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={send.isPending || !ready}>
            {send.isPending && <Spinner />} {mode === "approve" ? "Approve without documents" : "Upload"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
