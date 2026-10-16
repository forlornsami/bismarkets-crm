import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, CheckCircle2, Clock, Hourglass, Play, UserCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { DataGrid, gridQuery, type Column, type GridState } from "../components/DataGrid";
import { DocumentViewer, ReviewDecision, ReviewLayout, Waiting, Warnings, type ReviewWarning } from "../components/ReviewWorkbench";
import { Badge, ErrorText, PageHeader, Spinner, useFeedback } from "../components/ui";
import { ApiError, api, formatDate, qs, type Page } from "../lib/api";
import { useCan, useSession } from "../lib/session";

export interface KycSubmission {
  id: number;
  client: { id: number; name: string; email: string; country: string | null };
  category: "identity" | "address";
  categoryLabel: string;
  documentType: string;
  status: "pending" | "approved" | "rejected";
  rejectReason: string | null;
  submittedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  documents: number;
  claimedBy: { id: number; name: string | null; until: string } | null;
}

interface KycDetail extends KycSubmission {
  files: { id: number; slot: number; type: string; bytes: number; name: string; url: string }[];
  profile: { name: string; dob: string | null; gender: string | null; country: string | null; city: string | null; address: string | null; zipcode: string | null; phone: string | null; phone_code: string | null } | null;
  history: KycSubmission[];
  warnings: ReviewWarning[];
  checklist: { key: string; label: string }[];
  reasons: string[];
  queue: { pending: number; position: number };
}

interface Summary {
  pending: number;
  overdue: number;
  oldestPendingAt: string | null;
  decidedToday: number;
  decidedTodayByMe: number;
}

export const useKycSummary = (enabled = true) =>
  useQuery({ queryKey: ["kyc-summary"], queryFn: () => api.get<Summary>("/api/staff/kyc/summary"), enabled, refetchInterval: 60_000 });

export function KycStatusBadge({ status }: { status: KycSubmission["status"] | "none" }) {
  if (status === "approved") return <Badge tone="good">Approved</Badge>;
  if (status === "rejected") return <Badge tone="bad">Rejected</Badge>;
  if (status === "pending") return <Badge tone="warn">Waiting for review</Badge>;
  return <Badge tone="neutral">Not submitted</Badge>;
}

// Items skipped in this browser tab, so "next" does not hand them straight back.
const SKIP_KEY = "kyc-skipped";
const skipped = (): number[] => {
  try {
    return JSON.parse(sessionStorage.getItem(SKIP_KEY) ?? "[]");
  } catch {
    return [];
  }
};
const remember = (ids: number[]) => {
  try {
    sessionStorage.setItem(SKIP_KEY, JSON.stringify(ids.slice(-200)));
  } catch {
    /* private mode */
  }
};

function useNextItem() {
  const [, navigate] = useLocation();
  const { toast } = useFeedback();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (opts: { release?: number; category?: string } = {}) => api.post<{ id: number | null }>("/api/staff/kyc/next", { skip: skipped(), ...opts }),
    onSuccess: (res) => {
      void client.invalidateQueries({ queryKey: ["kyc-summary"] });
      if (res.id) navigate(`/kyc/${res.id}`);
      else {
        remember([]);
        toast("The queue is clear. Nothing else is waiting.");
        navigate("/kyc");
      }
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

export function KycReview() {
  const can = useCan();
  const [, navigate] = useLocation();
  const [state, setState] = useState<GridState>({ page: 1, pageSize: 25, sort: "submitted_at", filters: { status: "pending" } });
  const summary = useKycSummary();
  const next = useNextItem();
  const list = useQuery({
    queryKey: ["kyc", state],
    queryFn: () => api.get<Page<KycSubmission>>(`/api/staff/kyc${qs({ ...gridQuery(state), status: state.filters.status || "all" })}`),
    placeholderData: (prev) => prev,
    refetchInterval: 30_000,
  });
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
          can("kyc.decide") && (
            <button type="button" className="button button-primary" disabled={next.isPending || !s?.pending} onClick={() => next.mutate({ category: state.filters.category || undefined })}>
              {next.isPending ? <Spinner /> : <Play size={16} />} Start reviewing{s?.pending ? ` (${s.pending})` : ""}
            </button>
          )
        }
      />
      <ErrorText error={next.error} />
      <div className="tiles">
        {tile(<Hourglass size={20} />, "warn", "Waiting", s?.pending ?? "–", s?.oldestPendingAt ? `Oldest sent ${formatDate(s.oldestPendingAt)}` : "Nothing waiting")}
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
        onChange={setState}
        rowKey={(s) => s.id}
        onRowClick={(s) => navigate(`/kyc/${s.id}`)}
        loading={list.isLoading}
        error={list.error}
        searchPlaceholder="Search client name, email or ID"
        filters={[
          { key: "status", label: "Status", options: [{ value: "pending", label: "Waiting for review" }, { value: "approved", label: "Approved" }, { value: "rejected", label: "Rejected" }] },
          { key: "category", label: "Document", options: [{ value: "identity", label: "Identity" }, { value: "address", label: "Proof of address" }] },
        ]}
        emptyText="Nothing here. Documents appear as soon as clients upload them."
      />
    </>
  );
}

/** One submission at a time: documents on the left, checks and the decision on the right. */
/** Takes back an approval when a document has expired or turns out to be wrong; the client is asked to upload again. */
function RequestNewDocument({ id, clientId, reasons }: { id: number; clientId: number; reasons: string[] }) {
  const client = useQueryClient();
  const { toast } = useFeedback();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const send = useMutation({
    mutationFn: () => api.post<KycSubmission>(`/api/staff/kyc/${id}/request-new`, { reason: reason.trim() }),
    onSuccess: (res) => {
      toast(`Asked ${res.client.name} for a new ${res.documentType}. The client has been told why.`);
      setOpen(false);
      setReason("");
      client.setQueryData(["kyc-detail", id], (old: KycDetail | undefined) => (old ? { ...old, ...res } : old));
      for (const key of [["kyc"], ["kyc-summary"], ["client", String(clientId)], ["client-kyc", clientId], ["client-activity", String(clientId)]]) void client.invalidateQueries({ queryKey: key });
    },
  });
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
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} autoFocus />
      </label>
      {send.error && <ErrorText error={send.error} />}
      <div className="actions actions-left">
        <button type="submit" className="button button-danger" disabled={send.isPending || reason.trim().length < 5}>
          Withdraw approval and ask again
        </button>
        <button type="button" className="button button-ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function KycWorkbench({ id }: { id: string }) {
  const can = useCan();
  const session = useSession();
  const client = useQueryClient();
  const [, navigate] = useLocation();
  const { toast } = useFeedback();
  const next = useNextItem();
  const sid = Number(id);
  // Opening a submission is audited, so do not refetch it in the background.
  const detail = useQuery({ queryKey: ["kyc-detail", sid], queryFn: () => api.get<KycDetail>(`/api/staff/kyc/${sid}`), staleTime: Infinity, refetchOnWindowFocus: false });
  const d = detail.data;
  const pending = d?.status === "pending";
  const mayDecide = can("kyc.decide");
  const [heldBy, setHeldBy] = useState<string | null>(null);
  const decided = useRef(false);
  useEffect(() => setHeldBy(null), [sid]);

  const claim = useMutation({
    mutationFn: (takeOver: boolean) => api.post<{ claimedBy: KycSubmission["claimedBy"] }>(`/api/staff/kyc/${sid}/claim`, { takeOver }),
    onSuccess: () => setHeldBy(null),
    onError: (e) => {
      if (e instanceof ApiError && e.status === 409) setHeldBy(d?.claimedBy?.name ?? "Someone else");
    },
  });
  // Hold the item while it is open, refresh the hold, and let go on leaving.
  useEffect(() => {
    if (!pending || !mayDecide) return;
    decided.current = false;
    claim.mutate(false);
    const timer = setInterval(() => !decided.current && claim.mutate(false), 5 * 60_000);
    return () => {
      clearInterval(timer);
      if (!decided.current) void api.post(`/api/staff/kyc/${sid}/release`).catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid, pending, mayDecide]);

  const decide = useMutation({
    mutationFn: (body: { decision: "approve" | "reject"; reason?: string; checklist: string[] }) => api.post<KycSubmission>(`/api/staff/kyc/${sid}/decision`, body),
    onSuccess: (res) => {
      decided.current = true;
      toast(res.status === "approved" ? `Approved ${res.client.name}'s ${res.documentType}. The client has been told.` : `Rejected ${res.client.name}'s ${res.documentType}. The client has been told why.`);
      client.removeQueries({ queryKey: ["kyc-detail", sid] });
      for (const key of [["kyc"], ["kyc-summary"], ["client", String(res.client.id)], ["clients"], ["client-kyc", res.client.id], ["client-activity", String(res.client.id)]]) void client.invalidateQueries({ queryKey: key });
      next.mutate({});
    },
  });
  const skip = () => {
    remember([...skipped(), sid]);
    decided.current = true;
    next.mutate({ release: sid });
  };
  const back = () => navigate("/kyc");

  if (detail.error) return <ErrorText error={detail.error} />;
  if (!d) return <Spinner />;
  const p = d.profile;
  const blocked = !pending
    ? null
    : heldBy
      ? `${heldBy} is reviewing this right now.`
      : !mayDecide
        ? "You can look at this submission but not approve or reject it."
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
      position={pending ? `${d.queue.position} of ${d.queue.pending} waiting` : undefined}
      evidence={<DocumentViewer files={d.files.map((f) => ({ ...f, label: d.files.length > 1 ? (f.slot === 1 ? "Front" : "Back") : "Document" }))} />}
      side={
        <>
          <h3 className="flush">Compare with what the client entered</h3>
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
              <Link href={`/clients/${d.client.id}`}>
                {d.client.id} · {d.client.email}
              </Link>
            </dd>
          </dl>
          <Warnings items={d.warnings} />
          {pending ? (
            <>
              {heldBy && mayDecide && (
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
                canDecide={mayDecide && !heldBy}
                blockedText={blocked}
                onApprove={(checklist) => decide.mutate({ decision: "approve", checklist })}
                onReject={(reason, checklist) => decide.mutate({ decision: "reject", reason, checklist })}
                onSkip={mayDecide ? skip : undefined}
                onBack={back}
              />
              <p className="muted tight">
                Decisions ask for your 2FA code at most every few minutes. Opening documents is recorded in the audit log.
                {d.claimedBy?.id === session.staff.id ? " This item is held for you while it is open." : ""}
              </p>
            </>
          ) : (
            <div className="notice">
              <p>
                {d.status === "approved" ? "Approved" : "Rejected"} by {d.decidedBy ?? "staff"} on {formatDate(d.decidedAt)}.{d.rejectReason ? ` Reason: ${d.rejectReason}` : ""}
              </p>
            </div>
          )}
          {d.status === "approved" && mayDecide && <RequestNewDocument id={sid} clientId={d.client.id} reasons={d.reasons} />}
          {d.history.length > 0 && (
            <>
              <h3>Earlier attempts</h3>
              <ul className="session-list">
                {d.history.map((h) => (
                  <li key={h.id}>
                    <div>
                      <Link href={`/kyc/${h.id}`}>{h.documentType}</Link> <KycStatusBadge status={h.status} />
                    </div>
                    <small className="muted">
                      {formatDate(h.submittedAt)}
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
export function ClientKyc({ clientId, status }: { clientId: number; status: "none" | "pending" | "approved" | "rejected" }) {
  const can = useCan();
  const list = useQuery({
    queryKey: ["client-kyc", clientId],
    queryFn: () => api.get<Page<KycSubmission>>(`/api/staff/kyc${qs({ clientId, status: "all", pageSize: 50 })}`),
    enabled: can("kyc.view"),
  });
  const latest = (category: KycSubmission["category"]) => list.data?.items.find((s) => s.category === category);
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
      ) : (
        <dl className="details">
          {(["identity", "address"] as const).map((cat) => {
            const s = latest(cat);
            return [
              <dt key={`${cat}-t`}>{cat === "identity" ? "Identity" : "Proof of address"}</dt>,
              <dd key={`${cat}-d`}>
                {s ? (
                  <Link href={`/kyc/${s.id}`}>
                    <KycStatusBadge status={s.status} /> {s.documentType}, {formatDate(s.submittedAt)}
                  </Link>
                ) : (
                  <KycStatusBadge status="none" />
                )}
                {s?.rejectReason && <small className="muted block">Reason: {s.rejectReason}</small>}
              </dd>,
            ];
          })}
        </dl>
      )}
    </section>
  );
}
