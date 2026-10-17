import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, KeyRound, LogOut, Mail, MonitorSmartphone, Pencil, Power, ShieldOff, Unlock, UserPlus } from "lucide-react";
import { useState } from "react";
import { Link, useLocation } from "wouter";
import { AvatarEditor } from "../components/AvatarEditor";
import { DataGrid, gridQuery, type Column, type GridState } from "../components/DataGrid";
import { Avatar, Badge, CopyBox, Dialog, EmptyState, ErrorText, Field, PageHeader, Spinner, useFeedback } from "../components/ui";
import { api, formatDate, qs, type Page, type Role, type StaffMember } from "../lib/api";
import { useCan, useSession } from "../lib/session";

export const useRoles = () => useQuery({ queryKey: ["roles"], queryFn: () => api.get<{ items: Role[] }>("/api/staff/roles").then((r) => r.items) });

export function StatusBadge({ s }: { s: StaffMember }) {
  if (s.status === "disabled") return <Badge tone="bad">Disabled</Badge>;
  if (s.lockedUntil) return <Badge tone="warn">Locked</Badge>;
  return <Badge tone="good">Active</Badge>;
}

const columns: Column<StaffMember>[] = [
  {
    key: "name",
    header: "Name",
    sortable: true,
    render: (s) => (
      <span className="cell-person">
        <Avatar name={s.name} src={s.avatarUrl} />
        <span>
          <strong>{s.name}</strong>
          <small>{s.email}</small>
        </span>
      </span>
    ),
  },
  { key: "email", header: "Email", sortable: true, render: (s) => s.email },
  { key: "role", header: "Role", render: (s) => s.role.name },
  { key: "status", header: "Status", render: (s) => <StatusBadge s={s} /> },
  { key: "2fa", header: "2FA", render: (s) => (s.twoFactorEnabled ? <Badge tone="good">On</Badge> : <Badge tone="warn">Not set up</Badge>) },
  { key: "last_login_at", header: "Last sign-in", sortable: true, optional: true, render: (s) => formatDate(s.lastLoginAt) },
  { key: "created_at", header: "Created", sortable: true, optional: true, render: (s) => formatDate(s.createdAt) },
];

export function StaffList() {
  const can = useCan();
  const [, navigate] = useLocation();
  const roles = useRoles();
  const [state, setState] = useState<GridState>({ page: 1, pageSize: 25, sort: "created_at", dir: "desc", filters: {} });
  const [creating, setCreating] = useState(false);
  const list = useQuery({
    queryKey: ["staff", state],
    queryFn: () => api.get<Page<StaffMember>>(`/api/staff/users${qs(gridQuery(state))}`),
    placeholderData: (prev) => prev,
  });
  return (
    <>
      <PageHeader
        title="Staff"
        description="People who can sign in to the CRM, their roles and their security status."
        actions={
          can("staff.create") && (
            <button type="button" className="button button-primary" onClick={() => setCreating(true)}>
              <UserPlus size={16} /> Add staff
            </button>
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
        rowKey={(s) => s.id}
        onRowClick={(s) => navigate(`/staff/${s.id}`)}
        loading={list.isLoading}
        error={list.error}
        searchPlaceholder="Search name or email"
        filters={[
          { key: "status", label: "Status", options: [{ value: "active", label: "Active" }, { value: "disabled", label: "Disabled" }] },
          { key: "roleId", label: "Role", options: (roles.data ?? []).map((r) => ({ value: String(r.id), label: r.name })) },
          { key: "twoFactor", label: "2FA", options: [{ value: "enabled", label: "On" }, { value: "pending", label: "Not set up" }] },
        ]}
        emptyText="Add the first staff member to get started."
      />
      <NewStaffDialog open={creating} onClose={() => setCreating(false)} roles={roles.data ?? []} />
    </>
  );
}

function NewStaffDialog({ open, onClose, roles }: { open: boolean; onClose: () => void; roles: Role[] }) {
  const client = useQueryClient();
  const [form, setForm] = useState({ name: "", email: "", roleId: "" });
  const [created, setCreated] = useState<{ staff: StaffMember; temporaryPassword: string } | null>(null);
  const create = useMutation({
    mutationFn: () => api.post<{ staff: StaffMember; temporaryPassword: string }>("/api/staff/users", { ...form, roleId: Number(form.roleId) }),
    onSuccess: (res) => {
      setCreated(res);
      void client.invalidateQueries({ queryKey: ["staff"] });
    },
  });
  const close = () => {
    setCreated(null);
    setForm({ name: "", email: "", roleId: "" });
    create.reset();
    onClose();
  };
  return (
    <Dialog open={open} title={created ? "Staff account created" : "Add staff"} onClose={close}>
      {created ? (
        <>
          <p>
            Give <strong>{created.staff.email}</strong> this temporary password through a private channel. It is shown only once. At first sign-in they set their own password and turn on 2FA.
          </p>
          <CopyBox value={created.temporaryPassword} />
          <div className="actions">
            <button type="button" className="button button-primary" onClick={close}>
              Done
            </button>
          </div>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Field label="Full name">
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required minLength={2} />
          </Field>
          <Field label="Work email">
            <input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
          </Field>
          <Field label="Role">
            <select className="input" value={form.roleId} onChange={(e) => setForm({ ...form, roleId: e.target.value })} required>
              <option value="">Choose a role</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>
          <ErrorText error={create.error} />
          <div className="actions">
            <button type="button" className="button" onClick={close}>
              Cancel
            </button>
            <button type="submit" className="button button-primary" disabled={create.isPending}>
              {create.isPending && <Spinner />} Create account
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

export function StaffDetail({ id }: { id: string }) {
  const can = useCan();
  const session = useSession();
  const client = useQueryClient();
  const { toast, confirm } = useFeedback();
  const roles = useRoles();
  const member = useQuery({ queryKey: ["staff-member", id], queryFn: () => api.get<StaffMember>(`/api/staff/users/${id}`) });
  const sessions = useQuery({
    queryKey: ["staff-sessions", id],
    queryFn: () => api.get<{ items: { createdAt: string; lastSeenAt: string; ip: string; userAgent: string }[] }>(`/api/staff/users/${id}/sessions`),
    enabled: can("staff.security"),
  });
  const [edit, setEdit] = useState<{ name: string; roleId: string; countries: string; desks: string } | null>(null);
  const [notice, setNotice] = useState<{ text: string; password?: string } | null>(null);
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["staff-member", id] });
    void client.invalidateQueries({ queryKey: ["staff-sessions", id] });
    void client.invalidateQueries({ queryKey: ["staff"] });
  };
  const save = useMutation({
    mutationFn: () =>
      api.patch<StaffMember>(`/api/staff/users/${id}`, {
        name: edit!.name,
        roleId: Number(edit!.roleId),
        scopeCountries: edit!.countries.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
        scopeDesks: edit!.desks.split(",").map((s) => s.trim()).filter(Boolean),
      }),
    onSuccess: () => {
      setEdit(null);
      toast("Changes saved.");
      refresh();
    },
  });
  const action = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown; label: string }) => api.post<{ temporaryPassword?: string }>(`/api/staff/users/${id}/${path}`, body ?? {}),
    onSuccess: (res, vars) => {
      if (res?.temporaryPassword) setNotice({ text: vars.label, password: res.temporaryPassword });
      else toast(vars.label);
      refresh();
    },
    onError: (err) => toast(err instanceof Error ? err.message : "That did not work.", "bad"),
  });

  const s = member.data;
  if (member.error) return <ErrorText error={member.error} />;
  if (!s)
    return (
      <div className="center-screen loading-block">
        <Spinner size={22} />
      </div>
    );
  const self = s.id === session.staff.id;
  const run = async (path: string, label: string, body?: unknown, ask?: { title: string; body: string; confirmLabel: string; danger?: boolean }) => {
    if (ask && !(await confirm(ask))) return;
    setNotice(null);
    action.mutate({ path, body, label });
  };

  return (
    <>
      <Link href="/staff" className="back-link">
        <ArrowLeft size={15} /> All staff
      </Link>
      <PageHeader
        title={s.name}
        badge={<StatusBadge s={s} />}
        description={`${s.role.name} · ${s.email}`}
        actions={
          <>
            {can("comms.send", "comms.bulk") && s.status === "active" && (
              <Link href={`/messages/new?staff=${s.id}`} className="button">
                <Mail size={15} /> Send email
              </Link>
            )}
            {can("staff.edit") && !edit && (
              <button
                type="button"
                className="button"
                onClick={() => setEdit({ name: s.name, roleId: String(s.role.id), countries: s.scope.countries.join(", "), desks: s.scope.desks.join(", ") })}
              >
                <Pencil size={15} /> Edit details
              </button>
            )}
          </>
        }
      />
      <div className="columns">
        <section className="panel">
          <h2>Profile</h2>
          {edit ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate();
              }}
            >
              <Field label="Full name">
                <input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} required />
              </Field>
              <Field label="Role">
                <select className="input" value={edit.roleId} onChange={(e) => setEdit({ ...edit, roleId: e.target.value })} disabled={self}>
                  {(roles.data ?? []).map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Countries they cover" hint="Two-letter codes separated by commas, such as AE, PK. Empty means all.">
                <input className="input" value={edit.countries} onChange={(e) => setEdit({ ...edit, countries: e.target.value })} />
              </Field>
              <Field label="Desks" hint="Separated by commas. Empty means all.">
                <input className="input" value={edit.desks} onChange={(e) => setEdit({ ...edit, desks: e.target.value })} />
              </Field>
              <ErrorText error={save.error} />
              <div className="actions">
                <button type="button" className="button" onClick={() => setEdit(null)}>
                  Cancel
                </button>
                <button type="submit" className="button button-primary" disabled={save.isPending}>
                  {save.isPending && <Spinner />} Save changes
                </button>
              </div>
            </form>
          ) : (
            <>
              {self || can("staff.edit") ? (
                <AvatarEditor staffId={self ? "me" : s.id} name={s.name} src={s.avatarUrl} onChanged={refresh} />
              ) : (
                <Avatar name={s.name} src={s.avatarUrl} xl />
              )}
              <dl className="details">
                <dt>Email</dt>
                <dd>{s.email}</dd>
                <dt>Role</dt>
                <dd>{s.role.name}</dd>
                <dt>2FA</dt>
                <dd>{s.twoFactorEnabled ? "On" : "Not set up yet"}</dd>
                <dt>Countries</dt>
                <dd>{s.scope.countries.join(", ") || "All"}</dd>
                <dt>Desks</dt>
                <dd>{s.scope.desks.join(", ") || "All"}</dd>
                <dt>Last sign-in</dt>
                <dd>
                  {formatDate(s.lastLoginAt)}
                  {s.lastLoginIp ? ` from ${s.lastLoginIp}` : ""}
                </dd>
                <dt>Created</dt>
                <dd>{formatDate(s.createdAt)}</dd>
              </dl>
            </>
          )}
        </section>
        {(can("staff.disable") || can("staff.security")) && (
          <section className="panel">
            <div className="card-head">
              <div>
                <h2>Security</h2>
                <p>Each action asks for your 2FA code and signs this person out of every device.</p>
              </div>
            </div>
            <div className="stack">
              {can("staff.security") && !self && s.lockedUntil && (
                <button type="button" className="button" onClick={() => run("unlock", "Account unlocked.")}>
                  <Unlock size={16} /> Unlock sign-in
                </button>
              )}
              {can("staff.security") && !self && (
                <>
                  <button
                    type="button"
                    className="button"
                    onClick={() =>
                      run("reset-password", "Temporary password created. Share it privately; it is shown only once.", undefined, {
                        title: "Reset password?",
                        body: `${s.name} gets a new temporary password and must choose their own at next sign-in.`,
                        confirmLabel: "Reset password",
                      })
                    }
                  >
                    <KeyRound size={16} /> Reset password
                  </button>
                  <button
                    type="button"
                    className="button"
                    onClick={() =>
                      run("reset-2fa", "2FA reset. They will set it up again at next sign-in.", undefined, {
                        title: "Reset 2FA?",
                        body: `${s.name} will scan a new QR code at next sign-in. Use this when they lose their phone.`,
                        confirmLabel: "Reset 2FA",
                      })
                    }
                  >
                    <ShieldOff size={16} /> Reset 2FA
                  </button>
                </>
              )}
              {can("staff.security") && (
                <button type="button" className="button" onClick={() => run("revoke-sessions", "Signed out of all other sessions.")}>
                  <LogOut size={16} /> Sign out everywhere
                </button>
              )}
              {can("staff.disable") && !self && (
                <button
                  type="button"
                  className={s.status === "active" ? "button button-danger" : "button"}
                  onClick={() =>
                    run(
                      "status",
                      s.status === "active" ? "Account disabled." : "Account enabled.",
                      { status: s.status === "active" ? "disabled" : "active" },
                      s.status === "active"
                        ? { title: "Disable this account?", body: `${s.email} is signed out at once and cannot sign in until someone enables the account again.`, confirmLabel: "Disable account", danger: true }
                        : undefined,
                    )
                  }
                >
                  <Power size={16} /> {s.status === "active" ? "Disable account" : "Enable account"}
                </button>
              )}
            </div>
            {notice && (
              <div className="notice">
                <KeyRound size={16} />
                <div>
                  <p>{notice.text}</p>
                  {notice.password && <CopyBox value={notice.password} />}
                </div>
              </div>
            )}
          </section>
        )}
      </div>
      {can("staff.security") && (
        <section className="grid">
          <div className="grid-toolbar">
            <h2 className="flush">Active sessions</h2>
          </div>
          <div className="grid-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Signed in</th>
                  <th>Last active</th>
                  <th>IP address</th>
                  <th>Device</th>
                </tr>
              </thead>
              <tbody>
                {(sessions.data?.items ?? []).map((x) => (
                  <tr key={x.createdAt + x.ip}>
                    <td>{formatDate(x.createdAt)}</td>
                    <td>{formatDate(x.lastSeenAt)}</td>
                    <td>
                      <code>{x.ip}</code>
                    </td>
                    <td className="truncate" title={x.userAgent}>
                      {x.userAgent}
                    </td>
                  </tr>
                ))}
                {sessions.data?.items.length === 0 && (
                  <tr>
                    <td colSpan={4} className="empty">
                      <EmptyState icon={<MonitorSmartphone size={32} />} title="No active sessions" />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
