import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, FilePlus2, Info, Mail, Pencil, Search, Send, Trash2, Users, UserRound, UsersRound, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { COUNTRIES } from "../../shared/countries";
import { DataGrid, gridQuery, type Column, type GridState } from "../components/DataGrid";
import { Avatar, Badge, Dialog, EmptyState, ErrorText, Field, PageHeader, Spinner, useFeedback } from "../components/ui";
import { api, formatDate, qs, type Page } from "../lib/api";
import { useCan } from "../lib/session";
import { OutboxGrid } from "./Emails";

type Category = "service" | "marketing";

interface Template {
  id: number;
  name: string;
  subject: string;
  body: string;
  category: Category;
  updatedAt: string;
  updatedBy: string | null;
}

interface Campaign {
  id: number;
  audience: "clients" | "staff";
  audienceLabel: string;
  category: Category;
  subject: string;
  recipients: number;
  createdBy: { id: number; name: string };
  createdAt: string;
  delivery: { sent: number; failed: number; waiting: number; cancelled: number };
}

interface ClientHit {
  id: number;
  name: string;
  email: string;
  status: string;
  pictureUrl: string | null;
}

interface Directory {
  staff: { id: number; name: string; email: string; roleId: number; role: string }[];
  roles: { id: number; name: string; members: number }[];
}

interface Preview {
  count: number;
  tooMany: boolean;
  sample: { id: number; email: string; name: string }[];
  rendered: { to: string; subject: string; body: string } | null;
  deliveryOn: boolean;
}

const PLACEHOLDERS = [
  { key: "first_name", label: "First name" },
  { key: "last_name", label: "Last name" },
  { key: "full_name", label: "Full name" },
  { key: "email", label: "Email" },
  { key: "client_id", label: "Client number" },
  { key: "portal_url", label: "Portal address" },
];

const CategoryBadge = ({ category }: { category: Category }) => (category === "marketing" ? <Badge tone="warn">News and offers</Badge> : <Badge tone="info">Service</Badge>);

const useTemplates = () => useQuery({ queryKey: ["email-templates"], queryFn: () => api.get<{ items: Template[] }>("/api/staff/messages/templates") });

function useDebounced<T>(value: T, ms = 400) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Like Field, for groups of controls: a label element must not wrap several inputs. */
function FieldGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field" role="group" aria-label={label}>
      <span className="field-label">{label}</span>
      {children}
    </div>
  );
}

const toggle = <T,>(list: T[], item: T) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);

// ---------------------------------------------------------------------------
// Compose
// ---------------------------------------------------------------------------

type Mode = "client" | "clients" | "staff";

interface GroupFilter {
  status: string[];
  kyc: string[];
  countries: string[];
  assigned: string;
  registeredFrom: string;
  registeredTo: string;
}

const EMPTY_GROUP: GroupFilter = { status: ["active", "frozen"], kyc: [], countries: [], assigned: "", registeredFrom: "", registeredTo: "" };

function ClientSearch({ value, onChange }: { value: ClientHit | null; onChange: (c: ClientHit | null) => void }) {
  const [q, setQ] = useState("");
  const term = useDebounced(q.trim(), 300);
  const hits = useQuery({
    queryKey: ["client-search", term],
    queryFn: () => api.get<Page<ClientHit>>(`/api/staff/clients${qs({ q: term, pageSize: 6 })}`),
    enabled: term.length >= 2,
  });
  if (value) {
    return (
      <div className="recipient-card">
        <Avatar name={value.name} src={value.pictureUrl} />
        <div>
          <strong>{value.name}</strong>
          <span className="muted">
            Client {value.id} · {value.email}
          </span>
        </div>
        <button type="button" className="icon-button" aria-label="Choose another client" onClick={() => onChange(null)}>
          <X size={16} />
        </button>
      </div>
    );
  }
  return (
    <div className="picker">
      <span className="input-icon">
        <Search size={16} />
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, email or client number" autoFocus />
      </span>
      {term.length >= 2 && (
        <ul className="picker-list">
          {hits.isLoading && (
            <li className="muted">
              <Spinner /> Searching
            </li>
          )}
          {hits.data?.items.length === 0 && <li className="muted">No client matches.</li>}
          {hits.data?.items.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => onChange(c)}>
                <Avatar name={c.name} src={c.pictureUrl} />
                <span>
                  <strong>{c.name}</strong>
                  <span className="muted">
                    Client {c.id} · {c.email}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CheckGroup({ label, options, value, onChange }: { label: string; options: { value: string; label: string }[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <FieldGroup label={label}>
      <div className="check-row">
        {options.map((o) => (
          <label key={o.value} className="check">
            <input type="checkbox" checked={value.includes(o.value)} onChange={() => onChange(toggle(value, o.value))} />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </FieldGroup>
  );
}

function GroupFilters({ value, onChange }: { value: GroupFilter; onChange: (v: GroupFilter) => void }) {
  const set = (patch: Partial<GroupFilter>) => onChange({ ...value, ...patch });
  return (
    <>
      <CheckGroup
        label="Account status"
        options={[
          { value: "active", label: "Active" },
          { value: "frozen", label: "Frozen" },
          { value: "closed", label: "Closed" },
        ]}
        value={value.status}
        onChange={(status) => set({ status })}
      />
      <CheckGroup
        label="KYC (leave all unticked for everyone)"
        options={[
          { value: "none", label: "Not submitted" },
          { value: "pending", label: "Waiting for review" },
          { value: "approved", label: "Approved" },
          { value: "rejected", label: "Rejected" },
        ]}
        value={value.kyc}
        onChange={(kyc) => set({ kyc })}
      />
      <FieldGroup label="Countries (leave empty for all)">
        <select
          className="input"
          aria-label="Add a country"
          value=""
          onChange={(e) => {
            if (e.target.value && !value.countries.includes(e.target.value)) set({ countries: [...value.countries, e.target.value] });
          }}
        >
          <option value="">Add a country…</option>
          {COUNTRIES.map((c) => (
            <option key={c.iso2} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
        {value.countries.length > 0 && (
          <div className="chips chips-spaced">
            {value.countries.map((c) => (
              <button key={c} type="button" className="chip" onClick={() => set({ countries: value.countries.filter((x) => x !== c) })} aria-label={`Remove ${c}`}>
                {c} <X size={12} />
              </button>
            ))}
          </div>
        )}
      </FieldGroup>
      <div className="form-grid">
        <Field label="Account manager">
          <select className="input" value={value.assigned} onChange={(e) => set({ assigned: e.target.value })}>
            <option value="">Anyone</option>
            <option value="me">My clients</option>
            <option value="none">Nobody assigned</option>
          </select>
        </Field>
        <Field label="Registered from">
          <input className="input" type="date" value={value.registeredFrom} onChange={(e) => set({ registeredFrom: e.target.value })} />
        </Field>
        <Field label="Registered until">
          <input className="input" type="date" value={value.registeredTo} onChange={(e) => set({ registeredTo: e.target.value })} />
        </Field>
      </div>
    </>
  );
}

interface StaffSelection {
  by: "all" | "roles" | "people";
  roleIds: number[];
  staffIds: number[];
}

function StaffPicker({ value, onChange }: { value: StaffSelection; onChange: (v: StaffSelection) => void }) {
  const dir = useQuery({ queryKey: ["message-directory"], queryFn: () => api.get<Directory>("/api/staff/messages/directory") });
  if (!dir.data) return <Spinner />;
  return (
    <>
      <Field label="Which staff">
        <select className="input" value={value.by} onChange={(e) => onChange({ by: e.target.value as StaffSelection["by"], roleIds: [], staffIds: [] })}>
          <option value="all">Everyone with an active account</option>
          <option value="roles">Everyone in some roles</option>
          <option value="people">Chosen people</option>
        </select>
      </Field>
      {value.by === "roles" && (
        <div className="check-list-box">
          {dir.data.roles
            .filter((r) => r.members > 0)
            .map((r) => (
              <label key={r.id} className="check">
                <input type="checkbox" checked={value.roleIds.includes(r.id)} onChange={() => onChange({ ...value, roleIds: toggle(value.roleIds, r.id) })} />
                <span>
                  {r.name} <span className="muted">({r.members})</span>
                </span>
              </label>
            ))}
        </div>
      )}
      {value.by === "people" && (
        <div className="check-list-box">
          {dir.data.staff.map((s) => (
            <label key={s.id} className="check">
              <input type="checkbox" checked={value.staffIds.includes(s.id)} onChange={() => onChange({ ...value, staffIds: toggle(value.staffIds, s.id) })} />
              <span>
                {s.name} <span className="muted">· {s.role}</span>
              </span>
            </label>
          ))}
        </div>
      )}
    </>
  );
}

export function ComposeEmail() {
  const can = useCan();
  const bulk = can("comms.bulk");
  const search = new URLSearchParams(useSearch());
  const [, navigate] = useLocation();
  const client = useQueryClient();
  const { toast, confirm } = useFeedback();
  const presetClient = Number(search.get("client")) || null;
  const presetStaff = Number(search.get("staff")) || null;

  const [mode, setMode] = useState<Mode>(presetStaff && bulk ? "staff" : "client");
  const [picked, setPicked] = useState<ClientHit | null>(null);
  const [group, setGroup] = useState<GroupFilter>(EMPTY_GROUP);
  const [staffSel, setStaffSel] = useState<StaffSelection>({ by: presetStaff ? "people" : "all", roleIds: [], staffIds: presetStaff ? [presetStaff] : [] });
  const [category, setCategory] = useState<Category>("service");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const templates = useTemplates();

  useQuery({
    queryKey: ["client", String(presetClient), "compose"],
    queryFn: async () => {
      const c = await api.get<ClientHit>(`/api/staff/clients/${presetClient}`);
      setPicked(c);
      return c;
    },
    enabled: presetClient !== null,
  });

  const audience = useMemo(() => {
    if (mode === "client") return picked ? { audience: "clients", category, filter: { clientIds: [picked.id] } } : null;
    if (mode === "staff") {
      if (staffSel.by === "people") return staffSel.staffIds.length ? { audience: "staff", filter: { staffIds: staffSel.staffIds } } : null;
      if (staffSel.by === "roles") return staffSel.roleIds.length ? { audience: "staff", filter: { roleIds: staffSel.roleIds } } : null;
      return { audience: "staff", filter: {} };
    }
    if (group.status.length === 0) return null;
    const f: Record<string, unknown> = { status: group.status };
    if (group.kyc.length) f.kyc = group.kyc;
    if (group.countries.length) f.countries = group.countries;
    if (group.assigned) f.assigned = group.assigned;
    if (group.registeredFrom) f.registeredFrom = group.registeredFrom;
    if (group.registeredTo) f.registeredTo = group.registeredTo;
    return { audience: "clients", category, filter: f };
  }, [mode, picked, staffSel, group, category]);

  const payload = useDebounced(audience ? { ...audience, subject, body } : null);
  const preview = useQuery({
    queryKey: ["message-preview", payload],
    queryFn: () => api.post<Preview>("/api/staff/messages/preview", payload),
    enabled: payload !== null,
    placeholderData: (prev) => prev,
    retry: false,
  });

  const send = useMutation({
    mutationFn: () => api.post<{ id: number; recipients: number; held: boolean }>("/api/staff/messages/send", { ...audience, subject, body, templateId: templateId ?? undefined, expectedCount: preview.data?.count }),
    onSuccess: (data) => {
      toast(data.held ? `Saved for ${data.recipients} recipient(s). It will go out once sending is switched on.` : `Sending to ${data.recipients} recipient(s).`);
      void client.invalidateQueries({ queryKey: ["messages"] });
      void client.invalidateQueries({ queryKey: ["emails"] });
      navigate(`/messages/${data.id}`);
    },
  });

  const insert = (key: string) => {
    const el = bodyRef.current;
    const token = `{{${key}}}`;
    if (!el) return setBody((b) => b + token);
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    setBody(body.slice(0, start) + token + body.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const count = preview.data?.count ?? 0;
  const canSend = audience !== null && payload !== null && subject.trim() !== "" && body.trim() !== "" && count > 0 && !preview.data?.tooMany && !preview.isFetching && preview.data !== undefined;

  return (
    <>
      <Link href="/messages" className="back-link">
        <ArrowLeft size={15} /> Sent emails
      </Link>
      <PageHeader title="Send email" description="Write to one client, a group of clients, or your colleagues. Every email is recorded in the outbox and the audit log." />
      {preview.data && !preview.data.deliveryOn && (
        <div className="notice notice-warn">
          <Info size={18} />
          <p>
            Sending is switched off, so this email will be held in the outbox until the mail provider is set up
            {can("settings.view") ? (
              <>
                {" "}
                in <Link href="/settings/email">Email settings</Link>.
              </>
            ) : (
              "."
            )}
          </p>
        </div>
      )}
      <div className="columns columns-wide compose">
        <section className="panel">
          <FieldGroup label="Send to">
            <div className="tabs" role="tablist">
              <button type="button" role="tab" aria-selected={mode === "client"} onClick={() => setMode("client")}>
                <UserRound size={15} /> One client
              </button>
              {bulk && (
                <button type="button" role="tab" aria-selected={mode === "clients"} onClick={() => setMode("clients")}>
                  <Users size={15} /> Group of clients
                </button>
              )}
              {bulk && (
                <button type="button" role="tab" aria-selected={mode === "staff"} onClick={() => setMode("staff")}>
                  <UsersRound size={15} /> Staff
                </button>
              )}
            </div>
          </FieldGroup>
          {mode === "client" && <ClientSearch value={picked} onChange={setPicked} />}
          {mode === "clients" && <GroupFilters value={group} onChange={setGroup} />}
          {mode === "staff" && <StaffPicker value={staffSel} onChange={setStaffSel} />}

          {mode !== "staff" && (
            <Field label="Kind of email">
              <select className="input" value={category} onChange={(e) => setCategory(e.target.value as Category)}>
                <option value="service">Service: about their account or our service</option>
                <option value="marketing">News and offers: promotions and newsletters</option>
              </select>
              {category === "marketing" && (
                <p className="field-hint">News and offers go only to verified addresses that have not unsubscribed, never to closed accounts, and carry an unsubscribe link.</p>
              )}
            </Field>
          )}

          <hr className="divider" />

          {(templates.data?.items.length ?? 0) > 0 && (
            <Field label="Start from a template">
              <select
                className="input"
                value={templateId ?? ""}
                onChange={(e) => {
                  const t = templates.data?.items.find((x) => x.id === Number(e.target.value));
                  setTemplateId(t?.id ?? null);
                  if (t) {
                    setSubject(t.subject);
                    setBody(t.body);
                    if (mode !== "staff") setCategory(t.category);
                  }
                }}
              >
                <option value="">No template</option>
                {templates.data?.items.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Subject">
            <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} required />
          </Field>
          <Field label="Message" hint="Plain text. Blank lines start a new paragraph and https:// links become clickable.">
            <textarea ref={bodyRef} className="input compose-body" value={body} onChange={(e) => setBody(e.target.value)} rows={12} maxLength={20000} />
          </Field>
          <div className="placeholder-bar">
            <span className="muted">Insert:</span>
            {PLACEHOLDERS.filter((p) => mode !== "staff" || (p.key !== "client_id" && p.key !== "portal_url")).map((p) => (
              <button key={p.key} type="button" className="chip" onClick={() => insert(p.key)}>
                {p.label}
              </button>
            ))}
          </div>
          <ErrorText error={send.error ?? (preview.error && subject + body ? preview.error : null)} />
          <div className="actions">
            {can("comms.templates") && (
              <button type="button" className="button" disabled={!subject.trim() || !body.trim()} onClick={() => setSavingTemplate(true)}>
                <FilePlus2 size={15} /> Save as template
              </button>
            )}
            <button
              type="button"
              className="button button-primary"
              disabled={!canSend || send.isPending}
              onClick={async () => {
                const ok = await confirm({
                  title: count === 1 ? "Send this email?" : `Send to ${count.toLocaleString()} people?`,
                  body: count === 1 ? `It goes to ${preview.data?.sample[0]?.email}.` : "Each person gets their own copy with their name filled in. This cannot be undone once it is sent.",
                  confirmLabel: "Send",
                });
                if (ok) send.mutate();
              }}
            >
              {send.isPending ? <Spinner /> : <Send size={15} />} Send{count > 1 ? ` to ${count.toLocaleString()}` : ""}
            </button>
          </div>
        </section>

        <section className="panel preview-panel">
          <div className="card-head">
            <div>
              <h2>Preview</h2>
              <p>
                {preview.isFetching ? (
                  <Spinner />
                ) : preview.data ? (
                  preview.data.tooMany ? (
                    "Too many recipients. Narrow the group."
                  ) : (
                    `Goes to ${count.toLocaleString()} ${count === 1 ? "person" : "people"}.`
                  )
                ) : (
                  "Choose who to send to."
                )}
              </p>
            </div>
            <Mail size={20} className="muted" />
          </div>
          {preview.data && preview.data.sample.length > 0 && (
            <ul className="recipient-sample">
              {preview.data.sample.map((r) => (
                <li key={r.id}>
                  <strong>{r.name}</strong> <span className="muted">{r.email}</span>
                </li>
              ))}
              {count > preview.data.sample.length && <li className="muted">and {(count - preview.data.sample.length).toLocaleString()} more</li>}
            </ul>
          )}
          {preview.data?.rendered && (subject || body) && (
            <div className="email-preview">
              <div className="email-preview-head">
                <span className="muted">To</span> {preview.data.rendered.to}
                <br />
                <span className="muted">Subject</span> <strong>{preview.data.rendered.subject}</strong>
              </div>
              <div className="email-preview-body">{preview.data.rendered.body}</div>
              {category === "marketing" && mode !== "staff" && <div className="email-preview-foot">Unsubscribe from news and offers</div>}
            </div>
          )}
        </section>
      </div>
      {savingTemplate && (
        <TemplateDialog
          initial={{ id: 0, name: "", subject, body, category: mode === "staff" ? "service" : category, updatedAt: "", updatedBy: null }}
          onClose={() => setSavingTemplate(false)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Sent emails
// ---------------------------------------------------------------------------

function Delivery({ c }: { c: Campaign }) {
  const { sent, failed, waiting } = c.delivery;
  return (
    <span className="delivery">
      <span className="success-text">{sent} sent</span>
      {waiting > 0 && <span className="muted"> · {waiting} waiting</span>}
      {failed > 0 && <span className="error-text"> · {failed} failed</span>}
    </span>
  );
}

export function SentEmails() {
  const can = useCan();
  const [, navigate] = useLocation();
  const [state, setState] = useState<GridState>({ page: 1, pageSize: 25, sort: "created_at", dir: "desc", filters: {} });
  const list = useQuery({
    queryKey: ["messages", state],
    queryFn: () => api.get<Page<Campaign>>(`/api/staff/messages${qs(gridQuery(state))}`),
    placeholderData: (prev) => prev,
  });
  const columns: Column<Campaign>[] = [
    { key: "created_at", header: "Sent", sortable: true, render: (c) => formatDate(c.createdAt), width: "170px" },
    {
      key: "subject",
      header: "Subject",
      render: (c) => (
        <span className="stack-tight">
          <strong>{c.subject}</strong>
          <span className="muted">{c.audienceLabel}</span>
        </span>
      ),
    },
    { key: "category", header: "Kind", render: (c) => (c.audience === "staff" ? <Badge tone="neutral">Staff</Badge> : <CategoryBadge category={c.category} />), width: "150px" },
    { key: "recipients", header: "Recipients", render: (c) => c.recipients.toLocaleString(), width: "110px" },
    { key: "delivery", header: "Delivery", render: (c) => <Delivery c={c} /> },
    { key: "by", header: "By", render: (c) => c.createdBy.name },
  ];
  return (
    <>
      <PageHeader
        title="Sent emails"
        description="Emails staff have written to clients and colleagues, with how many were delivered."
        actions={
          can("comms.send") && (
            <Link href="/messages/new" className="button button-primary">
              <Send size={15} /> Send email
            </Link>
          )
        }
      />
      <DataGrid
        columns={columns}
        rows={list.data?.items}
        total={list.data?.total ?? 0}
        pages={list.data?.pages ?? 1}
        state={state}
        onChange={setState}
        rowKey={(c) => c.id}
        onRowClick={(c) => navigate(`/messages/${c.id}`)}
        loading={list.isLoading}
        error={list.error}
        searchPlaceholder="Search subject or recipients"
        emptyText="Nothing sent yet. Use Send email to write to a client or the team."
      />
    </>
  );
}

export function SentEmailDetail({ id }: { id: string }) {
  const q = useQuery({
    queryKey: ["messages", "detail", id],
    queryFn: () => api.get<Campaign & { body: string }>(`/api/staff/messages/${id}`),
    refetchInterval: (query) => ((query.state.data?.delivery.waiting ?? 0) > 0 ? 5000 : false),
  });
  if (q.error) return <ErrorText error={q.error} />;
  if (!q.data) return <Spinner size={22} />;
  const c = q.data;
  return (
    <>
      <Link href="/messages" className="back-link">
        <ArrowLeft size={15} /> Sent emails
      </Link>
      <PageHeader title={c.subject} description={`${c.audienceLabel} · sent by ${c.createdBy.name} on ${formatDate(c.createdAt)}`} badge={c.audience === "staff" ? <Badge tone="neutral">Staff</Badge> : <CategoryBadge category={c.category} />} />
      <div className="tiles">
        <div className="tile">
          <span className="tile-label">Recipients</span>
          <span className="tile-value">{c.recipients.toLocaleString()}</span>
        </div>
        <div className="tile">
          <span className="tile-label">Sent</span>
          <span className="tile-value">{c.delivery.sent.toLocaleString()}</span>
        </div>
        <div className="tile">
          <span className="tile-label">Waiting</span>
          <span className="tile-value">{c.delivery.waiting.toLocaleString()}</span>
        </div>
        <div className="tile">
          <span className="tile-label">Failed or cancelled</span>
          <span className="tile-value">{(c.delivery.failed + c.delivery.cancelled).toLocaleString()}</span>
        </div>
      </div>
      <section className="panel">
        <div className="card-head">
          <h2 className="flush">Message as written</h2>
        </div>
        <pre className="email-body">{c.body}</pre>
      </section>
      <h2 className="section-title">Recipients</h2>
      <OutboxGrid campaignId={c.id} emptyText="No recipients." />
    </>
  );
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function TemplateDialog({ initial, onClose }: { initial: Template; onClose: () => void }) {
  const client = useQueryClient();
  const { toast } = useFeedback();
  const [t, setT] = useState(initial);
  const set = (patch: Partial<Template>) => setT((x) => ({ ...x, ...patch }));
  const save = useMutation({
    mutationFn: () => {
      const body = { name: t.name, subject: t.subject, body: t.body, category: t.category };
      return t.id ? api.patch(`/api/staff/messages/templates/${t.id}`, body) : api.post("/api/staff/messages/templates", body);
    },
    onSuccess: () => {
      toast(t.id ? "Template updated." : "Template saved.");
      void client.invalidateQueries({ queryKey: ["email-templates"] });
      onClose();
    },
  });
  return (
    <Dialog open title={t.id ? "Edit template" : "New template"} onClose={onClose} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="form-grid">
          <Field label="Template name">
            <input className="input" value={t.name} onChange={(e) => set({ name: e.target.value })} maxLength={80} required autoFocus />
          </Field>
          <Field label="Kind of email">
            <select className="input" value={t.category} onChange={(e) => set({ category: e.target.value as Category })}>
              <option value="service">Service</option>
              <option value="marketing">News and offers</option>
            </select>
          </Field>
        </div>
        <Field label="Subject">
          <input className="input" value={t.subject} onChange={(e) => set({ subject: e.target.value })} maxLength={200} required />
        </Field>
        <Field label="Message" hint="Placeholders such as {{first_name}} are filled in for each recipient.">
          <textarea className="input compose-body" value={t.body} onChange={(e) => set({ body: e.target.value })} rows={10} required />
        </Field>
        <ErrorText error={save.error} />
        <div className="actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={save.isPending}>
            {save.isPending && <Spinner />} Save template
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function EmailTemplates() {
  const can = useCan();
  const editable = can("comms.templates");
  const client = useQueryClient();
  const { toast, confirm } = useFeedback();
  const templates = useTemplates();
  const [editing, setEditing] = useState<Template | null>(null);
  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/api/staff/messages/templates/${id}`),
    onSuccess: () => {
      toast("Template deleted.");
      void client.invalidateQueries({ queryKey: ["email-templates"] });
    },
    onError: (err) => toast(err instanceof Error ? err.message : "Delete failed.", "bad"),
  });
  const blank: Template = { id: 0, name: "", subject: "", body: "", category: "service", updatedAt: "", updatedBy: null };
  return (
    <>
      <PageHeader
        title="Email templates"
        description="Saved emails staff can start from when writing to clients or colleagues."
        badge={!editable && <Badge tone="neutral">View only</Badge>}
        actions={
          editable && (
            <button type="button" className="button button-primary" onClick={() => setEditing(blank)}>
              <FilePlus2 size={15} /> New template
            </button>
          )
        }
      />
      {templates.isLoading && <Spinner size={22} />}
      {templates.data?.items.length === 0 && (
        <EmptyState icon={<Mail size={22} />} title="No templates yet">
          Save emails you send often, such as a welcome call follow-up or a maintenance notice.
        </EmptyState>
      )}
      <div className="template-grid">
        {templates.data?.items.map((t) => (
          <section key={t.id} className="panel template-card">
            <div className="card-head">
              <div>
                <h2>{t.name}</h2>
                <p>{t.subject}</p>
              </div>
              <CategoryBadge category={t.category} />
            </div>
            <p className="template-body">{t.body}</p>
            <div className="actions">
              <span className="muted">
                Updated {formatDate(t.updatedAt)}
                {t.updatedBy ? ` by ${t.updatedBy}` : ""}
              </span>
              {editable && (
                <>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Delete ${t.name}`}
                    onClick={async () => {
                      if (await confirm({ title: `Delete "${t.name}"?`, body: "Emails already sent from it are not affected.", confirmLabel: "Delete", danger: true })) remove.mutate(t.id);
                    }}
                  >
                    <Trash2 size={15} />
                  </button>
                  <button type="button" className="button button-small" onClick={() => setEditing(t)}>
                    <Pencil size={14} /> Edit
                  </button>
                </>
              )}
            </div>
          </section>
        ))}
      </div>
      {editing && <TemplateDialog initial={editing} onClose={() => setEditing(null)} />}
    </>
  );
}
