import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, Check, Download, FileText, X } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import { DataGrid, gridQuery, type Column, type GridState } from "../components/DataGrid";
import { Badge, Dialog, ErrorText, Field, PageHeader, Spinner, useFeedback } from "../components/ui";
import { api, formatDate, qs, type Page } from "../lib/api";
import { useCan } from "../lib/session";

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
}

interface KycDetail extends KycSubmission {
  files: { id: number; slot: number; type: string; bytes: number; name: string; url: string }[];
  profile: { name: string; dob: string | null; country: string | null; city: string | null; address: string | null; zipcode: string | null; phone: string | null; phone_code: string | null } | null;
  history: KycSubmission[];
}

export function KycStatusBadge({ status }: { status: KycSubmission["status"] | "none" }) {
  if (status === "approved") return <Badge tone="good">Approved</Badge>;
  if (status === "rejected") return <Badge tone="bad">Rejected</Badge>;
  if (status === "pending") return <Badge tone="warn">Waiting for review</Badge>;
  return <Badge tone="neutral">Not submitted</Badge>;
}

const columns: Column<KycSubmission>[] = [
  { key: "submitted_at", header: "Sent", sortable: true, render: (s) => formatDate(s.submittedAt), width: "190px" },
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
  { key: "status", header: "Status", render: (s) => <KycStatusBadge status={s.status} /> },
  { key: "decided", header: "Reviewed by", render: (s) => (s.decidedBy ? `${s.decidedBy}, ${formatDate(s.decidedAt)}` : <span className="muted">Not yet</span>) },
];

export function KycReview() {
  const [state, setState] = useState<GridState>({ page: 1, pageSize: 25, sort: "submitted_at", filters: { status: "pending" } });
  const [open, setOpen] = useState<number | null>(null);
  const list = useQuery({
    queryKey: ["kyc", state],
    queryFn: () => api.get<Page<KycSubmission>>(`/api/staff/kyc${qs({ ...gridQuery(state), status: state.filters.status || "all" })}`),
    placeholderData: (prev) => prev,
  });
  return (
    <>
      <PageHeader title="KYC review" description="Identity and proof-of-address documents sent from the client portal and app. Oldest first, so nobody waits longest." />
      <DataGrid
        columns={columns}
        rows={list.data?.items}
        total={list.data?.total ?? 0}
        pages={list.data?.pages ?? 1}
        state={state}
        onChange={setState}
        rowKey={(s) => s.id}
        onRowClick={(s) => setOpen(s.id)}
        loading={list.isLoading}
        error={list.error}
        searchPlaceholder="Search client name, email or ID"
        filters={[
          { key: "status", label: "Status", options: [{ value: "pending", label: "Waiting for review" }, { value: "approved", label: "Approved" }, { value: "rejected", label: "Rejected" }] },
          { key: "category", label: "Document", options: [{ value: "identity", label: "Identity" }, { value: "address", label: "Proof of address" }] },
        ]}
        emptyText="Nothing waiting. Documents appear here when clients upload them."
      />
      {open !== null && <KycReviewDialog id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);

export function KycReviewDialog({ id, onClose }: { id: number; onClose: () => void }) {
  const can = useCan();
  const client = useQueryClient();
  const { toast } = useFeedback();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  // Opening a submission is audited, so do not refetch it in the background.
  const detail = useQuery({ queryKey: ["kyc-detail", id], queryFn: () => api.get<KycDetail>(`/api/staff/kyc/${id}`), staleTime: Infinity, refetchOnWindowFocus: false });
  const decide = useMutation({
    mutationFn: (decision: "approve" | "reject") => api.post<KycSubmission>(`/api/staff/kyc/${id}/decision`, decision === "reject" ? { decision, reason } : { decision }),
    onSuccess: (res) => {
      toast(res.status === "approved" ? "Approved. The client has been told." : "Rejected. The client has been told why.");
      for (const key of [["kyc"], ["kyc-detail", id], ["kyc-summary"], ["client"], ["clients"], ["client-kyc"], ["client-activity"]]) void client.invalidateQueries({ queryKey: key });
      onClose();
    },
  });
  const d = detail.data;
  return (
    <Dialog open title={d ? `${d.categoryLabel}: ${d.documentType}` : "KYC submission"} onClose={onClose} wide>
      {detail.error ? (
        <ErrorText error={detail.error} />
      ) : !d ? (
        <Spinner />
      ) : (
        <div className="kyc-review">
          <div className="kyc-docs">
            {d.files.map((f) =>
              f.type.startsWith("image/") && f.type !== "image/heic" ? (
                <a key={f.id} href={f.url} target="_blank" rel="noreferrer" className="kyc-doc">
                  <img src={f.url} alt={`${d.documentType}, ${f.slot === 1 ? "front" : "back"}`} />
                  <small className="muted">
                    {d.files.length > 1 ? (f.slot === 1 ? "Front" : "Back") : "Document"} · {kb(f.bytes)} · click to open full size
                  </small>
                </a>
              ) : (
                <a key={f.id} href={f.url} className="kyc-doc kyc-doc-file">
                  <FileText size={36} />
                  <span>
                    {f.type === "application/pdf" ? "PDF" : "Photo (HEIC)"} · {kb(f.bytes)}
                  </span>
                  <span className="button button-small">
                    <Download size={14} /> Download to view
                  </span>
                </a>
              ),
            )}
          </div>
          <aside className="kyc-side">
            <div className="card-head">
              <h3 className="flush">What the client entered</h3>
              <KycStatusBadge status={d.status} />
            </div>
            <dl className="details details-tight">
              <dt>Name</dt>
              <dd>{d.profile?.name}</dd>
              <dt>Date of birth</dt>
              <dd>{d.profile?.dob ?? "–"}</dd>
              <dt>Country</dt>
              <dd>{d.profile?.country ?? "–"}</dd>
              {d.category === "address" && (
                <>
                  <dt>Address</dt>
                  <dd>{[d.profile?.address, d.profile?.city, d.profile?.zipcode].filter(Boolean).join(", ") || "–"}</dd>
                </>
              )}
              <dt>Client</dt>
              <dd>
                <Link href={`/clients/${d.client.id}`} onClick={onClose}>
                  {d.client.id} · {d.client.email}
                </Link>
              </dd>
              <dt>Sent</dt>
              <dd>{formatDate(d.submittedAt)}</dd>
            </dl>
            {d.status !== "pending" && (
              <p className="muted tight">
                {d.status === "approved" ? "Approved" : "Rejected"} by {d.decidedBy ?? "staff"} on {formatDate(d.decidedAt)}.{d.rejectReason ? ` Reason: ${d.rejectReason}` : ""}
              </p>
            )}
            {d.history.length > 0 && (
              <>
                <h3>Earlier attempts</h3>
                <ul className="session-list">
                  {d.history.map((h) => (
                    <li key={h.id}>
                      <div>
                        <strong>{h.documentType}</strong> <KycStatusBadge status={h.status} />
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
            {d.status === "pending" && can("kyc.decide") && (
              <div className="kyc-actions">
                {rejecting ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      decide.mutate("reject");
                    }}
                  >
                    <Field label="Reason the client will see" hint="Say what to fix, such as a blurred photo or an expired document.">
                      <textarea className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} minLength={5} maxLength={500} required autoFocus />
                    </Field>
                    <ErrorText error={decide.error} />
                    <div className="actions">
                      <button type="button" className="button" onClick={() => setRejecting(false)}>
                        Back
                      </button>
                      <button type="submit" className="button button-danger-solid" disabled={decide.isPending}>
                        {decide.isPending && <Spinner />} Reject document
                      </button>
                    </div>
                  </form>
                ) : (
                  <>
                    <ErrorText error={decide.error} />
                    <div className="actions">
                      <button type="button" className="button button-danger" onClick={() => setRejecting(true)}>
                        <X size={15} /> Reject
                      </button>
                      <button type="button" className="button button-primary" disabled={decide.isPending} onClick={() => decide.mutate("approve")}>
                        {decide.isPending ? <Spinner /> : <Check size={15} />} Approve
                      </button>
                    </div>
                    <p className="muted tight">Deciding asks for your 2FA code. Opening documents is recorded in the audit log.</p>
                  </>
                )}
              </div>
            )}
          </aside>
        </div>
      )}
    </Dialog>
  );
}

/** The KYC panel on a client's page. */
export function ClientKyc({ clientId, status }: { clientId: number; status: "none" | "pending" | "approved" | "rejected" }) {
  const can = useCan();
  const [open, setOpen] = useState<number | null>(null);
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
                  <button type="button" className="button-link" onClick={() => setOpen(s.id)}>
                    <KycStatusBadge status={s.status} /> {s.documentType}, {formatDate(s.submittedAt)}
                  </button>
                ) : (
                  <KycStatusBadge status="none" />
                )}
                {s?.rejectReason && <small className="muted block">Reason: {s.rejectReason}</small>}
              </dd>,
            ];
          })}
        </dl>
      )}
      {open !== null && <KycReviewDialog id={open} onClose={() => setOpen(null)} />}
    </section>
  );
}
