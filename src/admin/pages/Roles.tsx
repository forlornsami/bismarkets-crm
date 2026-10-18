import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, KeyRound, Pencil, Plus, Search, Trash2, Users } from "lucide-react";
import { useState } from "react";
import { Badge, Dialog, ErrorText, Field, PageHeader, Spinner, useFeedback } from "../components/ui";
import { api, type Role } from "../lib/api";
import { useCan, useSession } from "../lib/session";
import { useRoles } from "./Staff";

interface Catalog {
  groups: { key: string; label: string; permissions: { permission: string; label: string }[] }[];
}

export function Roles() {
  const can = useCan();
  const roles = useRoles();
  const catalog = useCatalog();
  const totalPermissions = catalog.data?.groups.reduce((n, g) => n + g.permissions.length, 0) ?? 0;
  const [editing, setEditing] = useState<Role | "new" | null>(null);
  return (
    <>
      <PageHeader
        title="Roles and permissions"
        description="Every staff member has one role. The server checks the role's permissions on every request, so hiding a button is never the only protection."
        actions={
          can("role.manage") && (
            <button type="button" className="button button-primary" onClick={() => setEditing("new")}>
              <Plus size={16} /> New role
            </button>
          )
        }
      />
      <ErrorText error={roles.error} />
      <div className="role-grid">
        {(roles.data ?? []).map((r) => (
          <button key={r.id} type="button" className="role-card" onClick={() => setEditing(r)}>
            <div className="role-card-head">
              <h3>{r.name}</h3>
              {r.isSystem ? <Badge tone="neutral">Built-in</Badge> : <Badge tone="info">Custom</Badge>}
            </div>
            <p>{r.description || "No description."}</p>
            {totalPermissions > 0 && (
              <div className="meter" aria-hidden>
                <span style={{ width: `${Math.round((r.permissions.length / totalPermissions) * 100)}%` }} />
              </div>
            )}
            <div className="role-stats">
              <span>
                <KeyRound size={14} /> {r.permissions.length} permissions
              </span>
              <span>
                <Users size={14} /> {r.staffCount} staff
              </span>
              <span className="role-open">{can("role.manage") && r.editable ? <Pencil size={14} /> : <Eye size={14} />}</span>
            </div>
          </button>
        ))}
      </div>
      {editing && <RoleEditor role={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

const useCatalog = () => useQuery({ queryKey: ["permission-catalog"], queryFn: () => api.get<Catalog>("/api/staff/roles/permissions"), staleTime: Infinity });

function RoleEditor({ role, onClose }: { role: Role | null; onClose: () => void }) {
  const can = useCan();
  const session = useSession();
  const client = useQueryClient();
  const { toast, confirm } = useFeedback();
  const catalog = useCatalog();
  const [filter, setFilter] = useState("");
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [selected, setSelected] = useState<Set<string>>(new Set(role?.permissions ?? []));
  const own = role?.id === session.staff.role.id;
  const readOnly = !can("role.manage") || (role !== null && (!role.editable || own));
  const mine = new Set(session.permissions);

  const save = useMutation({
    mutationFn: () => {
      const body = { name, description, permissions: [...selected] };
      return role ? api.patch(`/api/staff/roles/${role.id}`, body) : api.post("/api/staff/roles", body);
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["roles"] });
      toast(role ? "Role saved." : "Role created.");
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/api/staff/roles/${role!.id}`),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["roles"] });
      toast("Role deleted.");
      onClose();
    },
  });
  const toggle = (p: string) => {
    const next = new Set(selected);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    setSelected(next);
  };
  const setGroup = (permissions: string[], on: boolean) => {
    const next = new Set(selected);
    for (const p of permissions) if (mine.has(p)) (on ? next.add(p) : next.delete(p));
    setSelected(next);
  };
  const term = filter.trim().toLowerCase();

  return (
    <Dialog open title={role ? role.name : "New role"} onClose={onClose} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {readOnly && (
          <p className="muted">
            {role && !role.editable ? "The Super Admin role always has every permission." : own ? "You cannot edit your own role." : "You can view this role but not change it."}
          </p>
        )}
        <Field label="Name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} disabled={readOnly} required minLength={2} />
        </Field>
        <Field label="What it is for">
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} disabled={readOnly} />
        </Field>
        <div className="permission-toolbar">
          <span className="input-icon grid-search">
            <Search size={16} />
            <input className="input input-small" type="search" placeholder="Find a permission" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Find a permission" />
          </span>
          <span className="muted">{selected.size} selected</span>
        </div>
        <div className="permission-groups">
          {(catalog.data?.groups ?? []).map((g) => {
            const visible = g.permissions.filter((p) => !term || p.label.toLowerCase().includes(term) || p.permission.includes(term) || g.label.toLowerCase().includes(term));
            if (visible.length === 0) return null;
            const all = g.permissions.map((p) => p.permission);
            const count = all.filter((p) => selected.has(p)).length;
            return (
              <fieldset key={g.key} className="permission-group">
                <legend>
                  {g.label}
                  <small>
                    {count}/{all.length}
                  </small>
                </legend>
                {!readOnly && (
                  <button type="button" className="button-link group-toggle" onClick={() => setGroup(all, count < all.length)}>
                    {count < all.length ? "Select all" : "Clear all"}
                  </button>
                )}
                {visible.map((p) => (
                  <label key={p.permission} className="check" title={!mine.has(p.permission) ? "You can only grant permissions you hold" : p.permission}>
                    <input type="checkbox" checked={selected.has(p.permission)} onChange={() => toggle(p.permission)} disabled={readOnly || !mine.has(p.permission)} />
                    {p.label}
                  </label>
                ))}
              </fieldset>
            );
          })}
        </div>
        <ErrorText error={save.error ?? remove.error} />
        <div className="actions">
          {role && !role.isSystem && !readOnly && (
            <button
              type="button"
              className="button button-danger"
              onClick={async () =>
                (await confirm({ title: "Delete this role?", body: `The ${role.name} role is removed. Roles that still have staff cannot be deleted.`, confirmLabel: "Delete role", danger: true })) && remove.mutate()
              }
            >
              <Trash2 size={15} /> Delete role
            </button>
          )}
          <button type="button" className="button" onClick={onClose}>
            {readOnly ? "Close" : "Cancel"}
          </button>
          {!readOnly && (
            <button type="submit" className="button button-primary" disabled={save.isPending}>
              {save.isPending && <Spinner />} Save role
            </button>
          )}
        </div>
      </form>
    </Dialog>
  );
}
