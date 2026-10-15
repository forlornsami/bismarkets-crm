import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Badge, Dialog, ErrorText, Field } from "../components/ui";
import { api, type Role } from "../lib/api";
import { useCan, useSession } from "../lib/session";
import { useRoles } from "./Staff";

interface Catalog {
  groups: { key: string; label: string; permissions: { permission: string; label: string }[] }[];
}

export function Roles() {
  const can = useCan();
  const roles = useRoles();
  const [editing, setEditing] = useState<Role | "new" | null>(null);
  return (
    <>
      <h1>Roles and permissions</h1>
      <p className="muted">Every staff member has one role. The server checks the role's permissions on every request.</p>
      {can("role.manage") && (
        <div className="actions actions-left">
          <button type="button" className="button button-primary" onClick={() => setEditing("new")}>
            New role
          </button>
        </div>
      )}
      <ErrorText error={roles.error} />
      <table className="table">
        <thead>
          <tr>
            <th>Role</th>
            <th>What it is for</th>
            <th>Permissions</th>
            <th>Staff</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(roles.data ?? []).map((r) => (
            <tr key={r.id}>
              <td>
                <strong>{r.name}</strong> {r.isSystem && <Badge tone="neutral">Built-in</Badge>}
              </td>
              <td>{r.description}</td>
              <td>{r.permissions.length}</td>
              <td>{r.staffCount}</td>
              <td>
                <button type="button" className="button button-small" onClick={() => setEditing(r)}>
                  {can("role.manage") && r.editable ? "Edit" : "View"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing && <RoleEditor role={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function RoleEditor({ role, onClose }: { role: Role | null; onClose: () => void }) {
  const can = useCan();
  const session = useSession();
  const client = useQueryClient();
  const catalog = useQuery({ queryKey: ["permission-catalog"], queryFn: () => api.get<Catalog>("/api/staff/roles/permissions") });
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
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/api/staff/roles/${role!.id}`),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["roles"] });
      onClose();
    },
  });
  const toggle = (p: string) => {
    const next = new Set(selected);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    setSelected(next);
  };

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
        <div className="permission-groups">
          {(catalog.data?.groups ?? []).map((g) => (
            <fieldset key={g.key} className="permission-group">
              <legend>{g.label}</legend>
              {g.permissions.map((p) => (
                <label key={p.permission} className="check" title={!mine.has(p.permission) ? "You can only grant permissions you hold" : p.permission}>
                  <input type="checkbox" checked={selected.has(p.permission)} onChange={() => toggle(p.permission)} disabled={readOnly || !mine.has(p.permission)} />
                  {p.label}
                </label>
              ))}
            </fieldset>
          ))}
        </div>
        <ErrorText error={save.error ?? remove.error} />
        <div className="actions">
          {role && !role.isSystem && !readOnly && (
            <button type="button" className="button button-danger" onClick={() => window.confirm(`Delete the ${role.name} role?`) && remove.mutate()}>
              Delete role
            </button>
          )}
          <button type="button" className="button" onClick={onClose}>
            {readOnly ? "Close" : "Cancel"}
          </button>
          {!readOnly && (
            <button type="submit" className="button button-primary" disabled={save.isPending}>
              Save role
            </button>
          )}
        </div>
      </form>
    </Dialog>
  );
}
