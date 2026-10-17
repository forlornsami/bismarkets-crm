import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Eye,
  ExternalLink,
  KeyRound,
  Lock,
  LockOpen,
  LogOut,
  Pencil,
  Pin,
  ShieldAlert,
  Snowflake,
  Trash2,
  UserPlus,
  UserRoundCheck,
  Users,
  UserX,
  CalendarPlus,
  History,
  Mail,
} from "lucide-react";
import { useState } from "react";
import { Link, useLocation } from "wouter";
import { DataGrid, gridQuery, type Column, type GridState } from "../components/DataGrid";
import { Avatar, Badge, Dialog, EmptyState, ErrorText, Field, PageHeader, Spinner, useFeedback } from "../components/ui";
import { api, formatDate, qs, type Page } from "../lib/api";
import { useCan, useSession } from "../lib/session";
import { COUNTRIES } from "../../shared/countries";
import { actionLabel } from "../lib/audit-labels";
import { OutboxGrid } from "./Emails";
import { ClientKyc, KycStatusBadge } from "./Kyc";

export interface Client {
  id: number;
  marketingOptOutAt: string | null;
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  emailVerified: boolean;
  status: "active" | "frozen" | "closed";
  statusReason: string | null;
  country: string | null;
  city: string | null;
  gender: string | null;
  businessName: string | null;
  phone: string | null;
  phoneCode: string | null;
  address: string | null;
  zipcode: string | null;
  dob: string | null;
  hasPassword: boolean;
  referralCode: string;
  referredBy: { id: number; name: string | null } | null;
  source: "portal" | "app" | "staff" | "import";
  assigned: { id: number; name: string | null } | null;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  lastLoginIp: string | null;
  createdAt: string;
  pictureUrl: string | null;
  kycStatus: "none" | "partial" | "pending" | "approved" | "rejected";
  kycApprovedAt: string | null;
  importantNotice: string | null;
  /** Fields checked against the client's KYC documents (camelCase, as in the edit form). */
  lockedFields?: string[];
  activeSessions?: number;
  notesCount?: number;
  referrals?: number;
}

interface Summary {
  total: number;
  active: number;
  frozen: number;
  closed: number;
  newToday: number;
  newThisWeek: number;
  unassigned: number;
  countries: string[];
}

interface Assignee {
  id: number;
  name: string;
  email: string;
}

const SOURCE_LABEL = { portal: "Client portal", app: "Mobile app", staff: "Added by staff", import: "Imported" } as const;

export function ClientStatus({ c }: { c: Pick<Client, "status" | "lockedUntil"> }) {
  if (c.status === "closed") return <Badge tone="bad">Closed</Badge>;
  if (c.status === "frozen") return <Badge tone="info">Frozen</Badge>;
  if (c.lockedUntil) return <Badge tone="warn">Locked</Badge>;
  return <Badge tone="good">Active</Badge>;
}

const columns: Column<Client>[] = [
  {
    key: "name",
    header: "Client",
    sortable: true,
    render: (c) => (
      <span className="cell-person">
        <Avatar name={c.name} src={c.pictureUrl} />
        <span>
          <strong>{c.name}</strong>
          <small>{c.email}</small>
        </span>
      </span>
    ),
  },
  { key: "id", header: "Client ID", sortable: true, optional: true, render: (c) => <span className="mono">{c.id}</span> },
  { key: "country", header: "Country", render: (c) => c.country ?? <span className="muted">Not given</span> },
  { key: "status", header: "Status", render: (c) => <ClientStatus c={c} /> },
  { key: "kyc", header: "KYC", render: (c) => <KycStatusBadge status={c.kycStatus} /> },
  { key: "assigned", header: "Assigned to", render: (c) => c.assigned?.name ?? <span className="muted">Nobody</span> },
  { key: "created_at", header: "Joined", sortable: true, render: (c) => formatDate(c.createdAt) },
  { key: "last_login_at", header: "Last sign-in", sortable: true, optional: true, render: (c) => formatDate(c.lastLoginAt) },
];

const useSummary = () => useQuery({ queryKey: ["clients-summary"], queryFn: () => api.get<Summary>("/api/staff/clients/summary") });
const useAssignees = (enabled = true) => useQuery({ queryKey: ["client-assignees"], queryFn: () => api.get<{ items: Assignee[] }>("/api/staff/clients/assignees"), enabled });

export function ClientsList() {
  const can = useCan();
  const [, navigate] = useLocation();
  const summary = useSummary();
  const [state, setState] = useState<GridState>({ page: 1, pageSize: 25, sort: "created_at", dir: "desc", filters: {} });
  // The dashboard's "Add a client" shortcut opens the form straight away.
  const [creating, setCreating] = useState(() => new URLSearchParams(window.location.search).get("new") === "1");
  const list = useQuery({
    queryKey: ["clients", state],
    queryFn: () => api.get<Page<Client>>(`/api/staff/clients${qs(gridQuery(state))}`),
    placeholderData: (prev) => prev,
  });
  const s = summary.data;
  const show = (n: number | undefined) => (n === undefined ? "–" : n.toLocaleString());
  const tile = (icon: React.ReactNode, tone: string, label: string, value: number | undefined, foot: string, filter?: Record<string, string>) => (
    <button type="button" className="tile tile-button" onClick={() => filter && setState({ ...state, page: 1, filters: filter })} disabled={!filter}>
      <span className={`tile-icon ${tone}`}>{icon}</span>
      <div>
        <div className="tile-label">{label}</div>
        <div className="tile-value">{show(value)}</div>
        <div className="tile-foot">{foot}</div>
      </div>
    </button>
  );

  return (
    <>
      <PageHeader
        title="Clients"
        description="Everyone with a client portal account: profiles, status, assignment, notes and activity."
        actions={
          can("client.create") && (
            <button type="button" className="button button-primary" onClick={() => setCreating(true)}>
              <UserPlus size={16} /> Add client
            </button>
          )
        }
      />
      <div className="tiles">
        {tile(<Users size={20} />, "", "All clients", s?.total, `${show(s?.active)} active`, {})}
        {tile(<CalendarPlus size={20} />, "good", "New this week", s?.newThisWeek, `${show(s?.newToday)} today`)}
        {tile(<Snowflake size={20} />, "info", "Frozen", s?.frozen, `${show(s?.closed)} closed`, { status: "frozen" })}
        {tile(<UserX size={20} />, "warn", "Unassigned", s?.unassigned, "No account manager yet", { assigned: "none" })}
      </div>
      <DataGrid
        columns={columns}
        rows={list.data?.items}
        total={list.data?.total ?? 0}
        pages={list.data?.pages ?? 1}
        state={state}
        onChange={setState}
        rowKey={(c) => c.id}
        onRowClick={(c) => navigate(`/clients/${c.id}`)}
        loading={list.isLoading}
        error={list.error}
        searchPlaceholder="Search name, email, client ID or referral code"
        filters={[
          { key: "status", label: "Status", options: [{ value: "active", label: "Active" }, { value: "frozen", label: "Frozen" }, { value: "closed", label: "Closed" }] },
          { key: "kyc", label: "KYC", options: [{ value: "none", label: "Not submitted" }, { value: "partial", label: "Partly verified" }, { value: "pending", label: "Waiting for review" }, { value: "approved", label: "Approved" }, { value: "rejected", label: "Rejected" }] },
          { key: "assigned", label: "Assigned", options: [{ value: "me", label: "To me" }, { value: "none", label: "Nobody" }] },
          { key: "country", label: "Country", options: (s?.countries ?? []).map((c) => ({ value: c, label: c })) },
          { key: "source", label: "Joined via", options: Object.entries(SOURCE_LABEL).map(([value, label]) => ({ value, label })) },
          { key: "verified", label: "Email", options: [{ value: "yes", label: "Verified" }, { value: "no", label: "Not verified" }] },
        ]}
        emptyText="Clients appear here as soon as they sign up in the client portal."
      />
      <NewClientDialog open={creating} onClose={() => setCreating(false)} onCreated={(c) => navigate(`/clients/${c.id}`)} />
    </>
  );
}

function NewClientDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (c: Client) => void }) {
  const client = useQueryClient();
  const can = useCan();
  const assignees = useAssignees(open && can("client.assign"));
  const blank = { firstName: "", lastName: "", email: "", phone: "", countryCode: "", country: "", city: "", assignedStaffId: "", sendInvite: true };
  const [form, setForm] = useState(blank);
  const set = (patch: Partial<typeof blank>) => setForm({ ...form, ...patch });
  const create = useMutation({
    mutationFn: () =>
      api.post<Client>("/api/staff/clients", {
        firstName: form.firstName,
        lastName: form.lastName,
        email: form.email,
        phone: form.phone || null,
        countryCode: form.countryCode || null,
        country: form.country || null,
        city: form.city || null,
        assignedStaffId: form.assignedStaffId ? Number(form.assignedStaffId) : null,
        sendInvite: form.sendInvite,
      }),
    onSuccess: (c) => {
      void client.invalidateQueries({ queryKey: ["clients"] });
      void client.invalidateQueries({ queryKey: ["clients-summary"] });
      close();
      onCreated(c);
    },
  });
  const close = () => {
    setForm(blank);
    create.reset();
    onClose();
  };
  return (
    <Dialog open={open} title="Add client" onClose={close} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <div className="form-grid">
          <Field label="First name">
            <input className="input" value={form.firstName} onChange={(e) => set({ firstName: e.target.value })} required autoFocus />
          </Field>
          <Field label="Last name">
            <input className="input" value={form.lastName} onChange={(e) => set({ lastName: e.target.value })} required />
          </Field>
          <Field label="Email">
            <input className="input" type="email" value={form.email} onChange={(e) => set({ email: e.target.value })} required />
          </Field>
          <Field label="Phone" hint="Dialling code, then the number.">
            <span className="phone-pair">
              <input className="input" value={form.countryCode} onChange={(e) => set({ countryCode: e.target.value })} placeholder="44" inputMode="numeric" aria-label="Dialling code" />
              <input className="input" value={form.phone} onChange={(e) => set({ phone: e.target.value })} inputMode="tel" aria-label="Phone number" />
            </span>
          </Field>
          <Field label="Country">
            <CountrySelect value={form.country} onChange={(country, dial) => set({ country, countryCode: form.countryCode || dial })} />
          </Field>
          <Field label="City">
            <input className="input" value={form.city} onChange={(e) => set({ city: e.target.value })} />
          </Field>
          {can("client.assign") && (
            <Field label="Account manager">
              <select className="input" value={form.assignedStaffId} onChange={(e) => set({ assignedStaffId: e.target.value })}>
                <option value="">Nobody yet</option>
                {(assignees.data?.items ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
        <label className="check">
          <input type="checkbox" checked={form.sendInvite} onChange={(e) => set({ sendInvite: e.target.checked })} />
          <span>Email them a link to set their password (valid for 72 hours)</span>
        </label>
        <ErrorText error={create.error} />
        <div className="actions">
          <button type="button" className="button" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={create.isPending}>
            {create.isPending && <Spinner />} Add client
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------------- Client detail ----------------

interface Note {
  id: number;
  body: string;
  pinned: boolean;
  createdAt: string;
  author: { id: number; name: string | null } | null;
}
interface ClientSession {
  ref: string;
  kind: "login" | "impersonation";
  staffName: string | null;
  reason: string | null;
  ip: string;
  userAgent: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}
interface Activity {
  id: number;
  at: string;
  actorType: string;
  actor: string;
  action: string;
  ip: string;
  meta?: unknown;
}
interface Revealed {
  phone: string | null;
  phoneCode: string | null;
  address: string | null;
  zipcode: string | null;
  dob: string | null;
}


function CountrySelect({ value, onChange, disabled }: { value: string; onChange: (country: string, dial: string) => void; disabled?: boolean }) {
  const known = COUNTRIES.some((c) => c.name === value);
  return (
    <select
      className="input"
      value={value}
      disabled={disabled}
      onChange={(e) => {
        const c = COUNTRIES.find((x) => x.name === e.target.value);
        onChange(e.target.value, c?.dial.replace(/\D/g, "") ?? "");
      }}
    >
      <option value="">Not given</option>
      {!known && value && <option value={value}>{value}</option>}
      {COUNTRIES.map((c) => (
        <option key={c.iso2} value={c.name}>
          {c.name}
        </option>
      ))}
    </select>
  );
}

export function ClientDetail({ id }: { id: string }) {
  const can = useCan();
  const session = useSession();
  const client = useQueryClient();
  const { toast, confirm } = useFeedback();
  const c = useQuery({ queryKey: ["client", id], queryFn: () => api.get<Client>(`/api/staff/clients/${id}`) });
  const assignees = useAssignees(can("client.assign"));
  const [editing, setEditing] = useState(false);
  const [statusDialog, setStatusDialog] = useState<Client["status"] | null>(null);
  const [impersonating, setImpersonating] = useState(false);
  const [revealed, setRevealed] = useState<Revealed | null>(null);

  const refresh = () => {
    for (const key of [["client", id], ["client-sessions", id], ["client-activity", id], ["client-notes", id], ["clients"], ["clients-summary"]]) void client.invalidateQueries({ queryKey: key });
  };
  const action = useMutation({
    mutationFn: ({ path, body, method = "post" }: { path: string; body?: unknown; label: string; method?: "post" | "del" }) =>
      method === "del" ? api.del(`/api/staff/clients/${id}/${path}`) : api.post(`/api/staff/clients/${id}/${path}`, body ?? {}),
    onSuccess: (_res, vars) => {
      toast(vars.label);
      refresh();
    },
    onError: (err) => toast(err instanceof Error ? err.message : "That did not work.", "bad"),
  });
  const reveal = useMutation({
    mutationFn: () => api.post<Revealed>(`/api/staff/clients/${id}/reveal`, {}),
    onSuccess: setRevealed,
    onError: (err) => toast(err instanceof Error ? err.message : "That did not work.", "bad"),
  });

  if (c.error) return <ErrorText error={c.error} />;
  const d = c.data;
  if (!d)
    return (
      <div className="center-screen loading-block">
        <Spinner size={22} />
      </div>
    );
  const pii = (field: keyof Revealed, masked: string | null) => (revealed ? revealed[field] : masked) ?? <span className="muted">Not given</span>;
  const run = async (path: string, label: string, ask?: { title: string; body: string; confirmLabel: string; danger?: boolean }, method?: "post" | "del") => {
    if (ask && !(await confirm(ask))) return;
    action.mutate({ path, label, method });
  };

  return (
    <>
      <Link href="/clients" className="back-link">
        <ArrowLeft size={15} /> All clients
      </Link>
      <PageHeader
        title={d.name}
        badge={<ClientStatus c={d} />}
        description={`Client ${d.id} · ${d.email}`}
        actions={
          <>
            {can("client.impersonate") && d.status !== "closed" && (
              <button type="button" className="button" onClick={() => setImpersonating(true)}>
                <ExternalLink size={15} /> Log in as client
              </button>
            )}
            {can("comms.send") && (
              <Link href={`/messages/new?client=${d.id}`} className="button">
                <Mail size={15} /> Send email
              </Link>
            )}
            {can("client.edit") && (
              <button type="button" className="button" onClick={() => setEditing(true)}>
                <Pencil size={15} /> Edit details
              </button>
            )}
          </>
        }
      />
      {d.status !== "active" && (
        <div className="notice notice-warn">
          <ShieldAlert size={18} />
          <p>
            {d.status === "frozen" ? "This account is frozen: the client can sign in and look, but cannot move money." : "This account is closed: the client cannot sign in."}
            {d.statusReason ? ` Reason: ${d.statusReason}` : ""}
          </p>
        </div>
      )}
      <div className="columns columns-wide">
        <section className="panel">
          <div className="profile-head">
            <Avatar name={d.name} src={d.pictureUrl} xl />
            <div>
              <h2 className="flush">{d.name}</h2>
              <span className="muted">
                {d.email} {d.emailVerified ? <Badge tone="good">Verified</Badge> : <Badge tone="warn">Not verified</Badge>}
              </span>
            </div>
          </div>
          <div className="card-head">
            <h3 className="flush">Personal details</h3>
            {can("client.pii.reveal") &&
              (revealed ? (
                <button type="button" className="button button-ghost button-small" onClick={() => setRevealed(null)}>
                  Hide again
                </button>
              ) : (
                <button type="button" className="button button-ghost button-small" disabled={reveal.isPending} onClick={() => reveal.mutate()}>
                  {reveal.isPending ? <Spinner /> : <Eye size={15} />} Show full details
                </button>
              ))}
          </div>
          <dl className="details">
            <dt>Phone</dt>
            <dd>
              {d.phoneCode && (revealed?.phone ?? d.phone) ? `+${d.phoneCode} ` : ""}
              {pii("phone", d.phone)}
            </dd>
            <dt>Date of birth</dt>
            <dd>{pii("dob", d.dob)}</dd>
            <dt>Gender</dt>
            <dd>{d.gender ?? <span className="muted">Not given</span>}</dd>
            <dt>Country</dt>
            <dd>{d.country ?? <span className="muted">Not given</span>}</dd>
            <dt>City</dt>
            <dd>{d.city ?? <span className="muted">Not given</span>}</dd>
            <dt>Address</dt>
            <dd>{pii("address", d.address)}</dd>
            <dt>Postcode</dt>
            <dd>{pii("zipcode", d.zipcode)}</dd>
            {d.businessName && (
              <>
                <dt>Business</dt>
                <dd>{d.businessName}</dd>
              </>
            )}
          </dl>
          {revealed && <p className="muted tight">Viewing full details was recorded in the audit log.</p>}
        </section>

        <section className="panel">
          <div className="card-head">
            <h2 className="flush">Account</h2>
          </div>
          <dl className="details">
            <dt>Status</dt>
            <dd>
              <ClientStatus c={d} />
            </dd>
            <dt>Joined</dt>
            <dd>
              {formatDate(d.createdAt)} · {SOURCE_LABEL[d.source]}
            </dd>
            <dt>Password</dt>
            <dd>{d.hasPassword ? "Set" : "Not set yet (invite sent)"}</dd>
            <dt>Last sign-in</dt>
            <dd>
              {formatDate(d.lastLoginAt)}
              {d.lastLoginIp ? ` from ${d.lastLoginIp}` : ""}
            </dd>
            <dt>Signed in now</dt>
            <dd>{d.activeSessions ?? 0} session(s)</dd>
            <dt>News and offers</dt>
            <dd>{d.marketingOptOutAt ? `Unsubscribed ${formatDate(d.marketingOptOutAt)}` : "Subscribed"}</dd>
            <dt>Referral code</dt>
            <dd className="mono">{d.referralCode}</dd>
            <dt>Referred by</dt>
            <dd>{d.referredBy ? <Link href={`/clients/${d.referredBy.id}`}>{d.referredBy.name ?? `Client ${d.referredBy.id}`}</Link> : <span className="muted">Nobody</span>}</dd>
            <dt>Has referred</dt>
            <dd>{d.referrals ?? 0} client(s)</dd>
            <dt>Account manager</dt>
            <dd>
              {can("client.assign") ? (
                <select
                  className="input input-small"
                  aria-label="Account manager"
                  value={d.assigned?.id ?? ""}
                  onChange={(e) => action.mutate({ path: "assign", body: { staffId: e.target.value ? Number(e.target.value) : null }, label: "Account manager updated." })}
                >
                  <option value="">Nobody</option>
                  {(assignees.data?.items ?? []).map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                      {a.id === session.staff.id ? " (you)" : ""}
                    </option>
                  ))}
                </select>
              ) : (
                (d.assigned?.name ?? <span className="muted">Nobody</span>)
              )}
            </dd>
          </dl>
          <div className="stack">
            {can("client.portal_password") && d.status !== "closed" && (
              <button
                type="button"
                className="button"
                onClick={() => run("password-reset", `Password reset link sent to ${d.email}.`, { title: "Send a password reset link?", body: `${d.email} gets a one-time link to set a new password. Their current password keeps working until they use it.`, confirmLabel: "Send link" })}
              >
                <KeyRound size={15} /> Send password reset link
              </button>
            )}
            {can("client.edit") && d.lockedUntil && (
              <button type="button" className="button" onClick={() => run("unlock", "Account unlocked.")}>
                <LockOpen size={15} /> Unlock sign-in
              </button>
            )}
            {can("client.status") && (d.activeSessions ?? 0) > 0 && (
              <button
                type="button"
                className="button"
                onClick={() => run("revoke-sessions", "Signed out everywhere.", { title: "Sign this client out everywhere?", body: "Every portal and app session ends now. They can sign in again.", confirmLabel: "Sign out" })}
              >
                <LogOut size={15} /> Sign out everywhere
              </button>
            )}
            {can("client.edit") && d.pictureUrl && (
              <button type="button" className="button" onClick={() => run("picture", "Picture removed.", { title: "Remove their profile picture?", body: "Initials will show instead.", confirmLabel: "Remove" }, "del")}>
                <Trash2 size={15} /> Remove picture
              </button>
            )}
            {can("client.status") && (
              <div className="actions-split">
                {d.status !== "active" && (
                  <button type="button" className="button" onClick={() => setStatusDialog("active")}>
                    <UserRoundCheck size={15} /> Reactivate
                  </button>
                )}
                {d.status === "active" && (
                  <button type="button" className="button" onClick={() => setStatusDialog("frozen")}>
                    <Snowflake size={15} /> Freeze
                  </button>
                )}
                {d.status !== "closed" && (
                  <button type="button" className="button button-danger" onClick={() => setStatusDialog("closed")}>
                    <UserX size={15} /> Close account
                  </button>
                )}
              </div>
            )}
          </div>
        </section>
      </div>

      <div className="columns columns-wide">
        <ClientKyc clientId={d.id} status={d.kycStatus} />
        <section className="panel">
          <div className="card-head">
            <h2 className="flush">Notice for the client</h2>
          </div>
          {d.importantNotice ? <p>{d.importantNotice}</p> : <p className="muted">None. Staff who can edit clients can add one under Edit details; the client sees it on their profile.</p>}
        </section>
      </div>
      <div className="columns columns-wide">
        <Notes id={id} />
        <Sessions id={id} />
      </div>
      <ActivityPanel id={id} />
      {can("comms.view") && (
        <>
          <h2 className="section-title">Emails to this client</h2>
          <OutboxGrid clientId={d.id} emptyText="No emails to this client yet." />
        </>
      )}

      {editing && <EditClientDialog c={d} onClose={() => setEditing(false)} onSaved={refresh} />}
      <StatusDialog c={d} target={statusDialog} onClose={() => setStatusDialog(null)} onDone={refresh} />
      <ImpersonateDialog c={d} open={impersonating} onClose={() => setImpersonating(false)} onDone={refresh} />
    </>
  );
}

function Notes({ id }: { id: string }) {
  const can = useCan();
  const client = useQueryClient();
  const notes = useQuery({ queryKey: ["client-notes", id], queryFn: () => api.get<{ items: Note[] }>(`/api/staff/clients/${id}/notes`) });
  const [body, setBody] = useState("");
  const [pinned, setPinned] = useState(false);
  const add = useMutation({
    mutationFn: () => api.post(`/api/staff/clients/${id}/notes`, { body, pinned }),
    onSuccess: () => {
      setBody("");
      setPinned(false);
      void client.invalidateQueries({ queryKey: ["client-notes", id] });
      void client.invalidateQueries({ queryKey: ["client-activity", id] });
    },
  });
  return (
    <section className="panel">
      <div className="card-head">
        <h2 className="flush">Notes</h2>
      </div>
      {can("client.notes") && (
        <form
          className="note-form"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <textarea className="input" rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Add a note for the team (calls, promises, follow-ups)" maxLength={4000} required />
          <div className="note-form-foot">
            <label className="check">
              <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
              <span>Pin to top</span>
            </label>
            <button type="submit" className="button button-primary button-small" disabled={add.isPending || !body.trim()}>
              {add.isPending && <Spinner />} Add note
            </button>
          </div>
          <ErrorText error={add.error} />
        </form>
      )}
      {notes.data && notes.data.items.length === 0 && <p className="muted">No notes yet.</p>}
      <ul className="note-list">
        {notes.data?.items.map((n) => (
          <li key={n.id} className={n.pinned ? "note pinned" : "note"}>
            <p>{n.body}</p>
            <small className="muted">
              {n.pinned && <Pin size={12} />} {n.author?.name ?? "Deleted staff member"} · {formatDate(n.createdAt)}
            </small>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Sessions({ id }: { id: string }) {
  const sessions = useQuery({ queryKey: ["client-sessions", id], queryFn: () => api.get<{ items: ClientSession[] }>(`/api/staff/clients/${id}/sessions`) });
  return (
    <section className="panel">
      <div className="card-head">
        <h2 className="flush">Signed in on</h2>
      </div>
      {sessions.data && sessions.data.items.length === 0 && <p className="muted">Not signed in anywhere right now.</p>}
      <ul className="session-list">
        {sessions.data?.items.map((s) => (
          <li key={s.ref}>
            <div>
              <strong>{s.kind === "impersonation" ? `Staff view by ${s.staffName ?? "staff"}` : shortAgent(s.userAgent)}</strong>
              {s.kind === "impersonation" && <Badge tone="info">View only</Badge>}
            </div>
            <small className="muted">
              {s.ip} · last active {formatDate(s.lastSeenAt)} · ends {formatDate(s.expiresAt)}
            </small>
            {s.reason && <small className="muted">Reason: {s.reason}</small>}
          </li>
        ))}
      </ul>
    </section>
  );
}

const shortAgent = (ua: string) => {
  if (!ua) return "Unknown device";
  if (/okhttp|Expo|Dalvik|BISMarkets/i.test(ua)) return "Mobile app";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
};

// What the client was told is KYC status (kyc.view); every other reason is compliance's own reasoning (kyc.documents).
const TOLD_THE_CLIENT = new Set(["kyc.rejected", "kyc.new_document_requested"]);

// For KYC entries: which document, and the reason given when this staff member may see it.
function kycDetail(a: Activity, reasons: "all" | "client" | "none") {
  if (!a.action.startsWith("kyc.")) return null;
  let meta = a.meta;
  if (typeof meta === "string") {
    try {
      meta = JSON.parse(meta);
    } catch {
      return null;
    }
  }
  if (!meta || typeof meta !== "object") return null;
  const m = meta as { category?: unknown; reason?: unknown };
  const parts = [m.category === "identity" ? "Proof of identity" : m.category === "address" ? "Proof of address" : null];
  const showReason = reasons === "all" || (reasons === "client" && TOLD_THE_CLIENT.has(a.action));
  if (showReason && typeof m.reason === "string" && m.reason) parts.push(`Reason: ${m.reason}`);
  return parts.filter(Boolean).join(" · ") || null;
}

function ActivityPanel({ id }: { id: string }) {
  const can = useCan();
  const reasons = can("kyc.documents") ? "all" : can("kyc.view") ? "client" : "none";
  const activity = useQuery({ queryKey: ["client-activity", id], queryFn: () => api.get<{ items: Activity[] }>(`/api/staff/clients/${id}/activity`) });
  return (
    <section className="panel">
      <div className="card-head">
        <div>
          <h2 className="flush">Activity</h2>
          <p>From the audit log: what the client and staff did on this account.</p>
        </div>
      </div>
      {activity.data && activity.data.items.length === 0 && <EmptyState icon={<History size={32} />} title="No activity yet">Sign-ins and changes appear here.</EmptyState>}
      <ol className="timeline">
        {activity.data?.items.map((a) => (
          <li key={a.id} className={a.actorType === "staff" ? "by-staff" : ""}>
            <strong>{actionLabel(a.action)}</strong>
            {kycDetail(a, reasons) && <small>{kycDetail(a, reasons)}</small>}
            <small className="muted">
              {formatDate(a.at)} · {a.actorType === "staff" ? `by ${a.actor}` : a.actorType === "client" ? "by the client" : "system"}
              {a.ip ? ` · ${a.ip}` : ""}
            </small>
          </li>
        ))}
      </ol>
    </section>
  );
}

function EditClientDialog({ c, onClose, onSaved }: { c: Client; onClose: () => void; onSaved: () => void }) {
  const can = useCan();
  const { toast } = useFeedback();
  const initial = {
    firstName: c.firstName,
    lastName: c.lastName,
    email: c.email,
    country: c.country ?? "",
    city: c.city ?? "",
    gender: c.gender ?? "",
    business_name: c.businessName ?? "",
    importantNotice: c.importantNotice ?? "",
  };
  const [form, setForm] = useState(initial);
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  // Details checked against the client's documents: only a compliance admin changes them, with a 2FA code.
  const locked = new Set(c.lockedFields ?? []);
  const mayChangeVerified = can("kyc.override");
  const lockedFor = (field: string) => locked.has(field) && !mayChangeVerified;
  const lockHint = (field: string) =>
    locked.has(field) ? (
      <span className="lock-hint">
        <Lock size={12} /> {mayChangeVerified ? "Checked against the client's documents. Changing it needs your 2FA code." : "Checked against the client's documents. Ask a compliance admin to change it."}
      </span>
    ) : undefined;
  const save = useMutation({
    mutationFn: () => {
      // Only what was changed goes up, so untouched details are never part of the edit.
      const body: Record<string, unknown> = {};
      for (const key of Object.keys(form) as (keyof typeof form)[]) {
        if (form[key] !== initial[key]) body[key] = key === "importantNotice" ? form.importantNotice.trim() || null : form[key];
      }
      return Object.keys(body).length ? api.patch<Client>(`/api/staff/clients/${c.id}`, body) : Promise.resolve(c);
    },
    onSuccess: () => {
      toast("Client updated.");
      onSaved();
      onClose();
    },
  });
  return (
    <Dialog open title="Edit client" onClose={onClose} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="form-grid">
          <Field label="First name" hint={lockHint("firstName")}>
            <input className="input" value={form.firstName} onChange={(e) => set({ firstName: e.target.value })} disabled={lockedFor("firstName")} required />
          </Field>
          <Field label="Last name" hint={lockHint("lastName")}>
            <input className="input" value={form.lastName} onChange={(e) => set({ lastName: e.target.value })} disabled={lockedFor("lastName")} required />
          </Field>
          <Field label="Sign-in email" hint={form.email !== c.email ? "Changing it needs your 2FA code, and the old address is told." : undefined}>
            <input className="input" type="email" value={form.email} onChange={(e) => set({ email: e.target.value })} required />
          </Field>
          <Field label="Gender">
            <select className="input" value={form.gender} onChange={(e) => set({ gender: e.target.value })}>
              <option value="">Not given</option>
              <option value="Male">Male</option>
              <option value="Female">Female</option>
            </select>
          </Field>
          <Field label="Country" hint={lockHint("country")}>
            <CountrySelect value={form.country} onChange={(country) => set({ country })} disabled={lockedFor("country")} />
          </Field>
          <Field label="City" hint={lockHint("city")}>
            <input className="input" value={form.city} onChange={(e) => set({ city: e.target.value })} disabled={lockedFor("city")} />
          </Field>
          <Field label="Business name">
            <input className="input" value={form.business_name} onChange={(e) => set({ business_name: e.target.value })} />
          </Field>
        </div>
        <Field label="Notice shown to the client" hint="Appears at the top of their portal and app profile. Leave empty for none.">
          <textarea className="input" rows={2} maxLength={500} value={form.importantNotice} onChange={(e) => set({ importantNotice: e.target.value })} />
        </Field>
        <p className="muted tight">
          The client changes their phone in the portal. Their address and date of birth lock once documents for them are sent. To let the client change them, reject the
          waiting document, or use Ask for a new document on an approved one.
        </p>
        <ErrorText error={save.error} />
        <div className="actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={save.isPending}>
            {save.isPending && <Spinner />} Save changes
          </button>
        </div>
      </form>
    </Dialog>
  );
}

const STATUS_COPY = {
  active: { title: "Reactivate this account?", body: "The client can sign in and use the portal normally again.", button: "Reactivate", danger: false },
  frozen: { title: "Freeze this account?", body: "The client can still sign in and look, but deposits, withdrawals and transfers will be blocked.", button: "Freeze account", danger: false },
  closed: { title: "Close this account?", body: "The client is signed out everywhere and cannot sign in again until someone reactivates the account.", button: "Close account", danger: true },
} as const;

function StatusDialog({ c, target, onClose, onDone }: { c: Client; target: Client["status"] | null; onClose: () => void; onDone: () => void }) {
  const { toast } = useFeedback();
  const [reason, setReason] = useState("");
  const change = useMutation({
    mutationFn: () => api.post<Client>(`/api/staff/clients/${c.id}/status`, { status: target, reason }),
    onSuccess: (res) => {
      toast(res.status === "active" ? "Account reactivated." : `Account ${res.status}.`);
      setReason("");
      onDone();
      onClose();
    },
  });
  const copy = target ? STATUS_COPY[target] : null;
  return (
    <Dialog open={Boolean(target)} title={copy?.title ?? ""} onClose={onClose}>
      {copy && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            change.mutate();
          }}
        >
          <p>{copy.body}</p>
          <Field label="Reason" hint="Kept in the audit log. You'll be asked for your 2FA code.">
            <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} maxLength={255} autoFocus />
          </Field>
          <ErrorText error={change.error} />
          <div className="actions">
            <button type="button" className="button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className={copy.danger ? "button button-danger-solid" : "button button-primary"} disabled={change.isPending}>
              {change.isPending && <Spinner />} {copy.button}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function ImpersonateDialog({ c, open, onClose, onDone }: { c: Client; open: boolean; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const start = useMutation({
    mutationFn: () => api.post<{ url: string; expiresAt: string }>(`/api/staff/clients/${c.id}/impersonate`, { reason }),
    onSuccess: (res) => {
      setLink(res);
      onDone();
    },
  });
  const close = () => {
    setLink(null);
    setReason("");
    start.reset();
    onClose();
  };
  return (
    <Dialog open={open} title={link ? "Portal session ready" : `Log in as ${c.name}`} onClose={close}>
      {link ? (
        <>
          <p>
            Open the client portal as <strong>{c.name}</strong>. The portal asks you to confirm, then shows exactly what they see. The session is view-only and ends at {formatDate(link.expiresAt)}.
          </p>
          <div className="actions">
            <button type="button" className="button" onClick={close}>
              Close
            </button>
            <a className="button button-primary" href={link.url} target="_blank" rel="noreferrer noopener" onClick={() => setTimeout(close, 200)}>
              <ExternalLink size={15} /> Open client portal
            </a>
          </div>
          <p className="muted tight">Tip: use a private window so your own portal sign-in is not replaced.</p>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            start.mutate();
          }}
        >
          <p>You will see the client portal exactly as this client does. You cannot change anything or move money, and the session ends automatically.</p>
          <Field label="Why do you need to see their portal?" hint="Kept in the audit log with your name. You'll be asked for your 2FA code.">
            <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Client called about a missing deposit" required minLength={5} maxLength={255} autoFocus />
          </Field>
          <ErrorText error={start.error} />
          <div className="actions">
            <button type="button" className="button" onClick={close}>
              Cancel
            </button>
            <button type="submit" className="button button-primary" disabled={start.isPending}>
              {start.isPending && <Spinner />} Continue
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
