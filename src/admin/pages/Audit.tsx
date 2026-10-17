import { useMutation, useQuery } from "@tanstack/react-query";
import { CalendarRange, Download, ShieldCheck, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { DataGrid, gridQuery, type Column, type GridState } from "../components/DataGrid";
import { Badge, ErrorText, PageHeader, Spinner, useFeedback } from "../components/ui";
import { api, formatDate, qs, type AuditItem, type Page } from "../lib/api";
import { actionLabel } from "../lib/audit-labels";
import { useCan } from "../lib/session";

const columns: Column<AuditItem>[] = [
  { key: "time", header: "When", render: (a) => formatDate(a.occurredAt), width: "170px" },
  { key: "actor", header: "Who", render: (a) => (a.actor.type === "staff" ? <strong>{a.actor.label}</strong> : <Badge tone="neutral">{`${a.actor.type}${a.actor.label ? `: ${a.actor.label}` : ""}`}</Badge>) },
  {
    key: "action",
    header: "Action",
    render: (a) => (
      <span className="stack-tight">
        <span>{actionLabel(a.action)}</span>
        <code className="audit-action">{a.action}</code>
      </span>
    ),
  },
  { key: "entity", header: "Record", render: (a) => (a.entity.type ? `${a.entity.type} #${a.entity.id}` : "") },
  { key: "ip", header: "IP", render: (a) => <span className="muted">{a.ip}</span> },
];

export function AuditLog() {
  const can = useCan();
  const [state, setState] = useState<GridState>({ page: 1, pageSize: 50, filters: {} });
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const actions = useQuery({ queryKey: ["audit-actions"], queryFn: () => api.get<{ items: string[] }>("/api/staff/audit/actions") });
  // "To" includes the whole chosen day, so send the start of the next day.
  const toExclusive = to ? new Date(new Date(`${to}T00:00:00`).getTime() + 86_400_000).toISOString() : undefined;
  const params = { ...gridQuery(state), sort: undefined, dir: undefined, q: undefined, from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined, to: toExclusive };
  const list = useQuery({
    queryKey: ["audit", params],
    queryFn: () => api.get<Page<AuditItem>>(`/api/staff/audit${qs(params)}`),
    placeholderData: (prev) => prev,
  });
  const { toast } = useFeedback();
  const verify = useMutation({
    mutationFn: () => api.post<{ ok: boolean; checked: number; brokenAtId: number | null; reason: string | null }>("/api/staff/audit/verify"),
    onSuccess: (r) => toast(r.ok ? `Audit chain intact: ${r.checked.toLocaleString()} entries checked.` : `Audit chain broken at entry ${r.brokenAtId}.`, r.ok ? "good" : "bad"),
  });
  const exportCsv = useMutation({
    mutationFn: () => api.saveFile(`/api/staff/audit/export${qs(params)}`, `audit-${new Date().toISOString().slice(0, 10)}.csv`),
  });

  const actionPrefixes = [...new Set((actions.data?.items ?? []).map((a) => `${a.split(".")[0]}.`))];

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every sign-in, permission change and staff action is recorded here. Entries cannot be edited or deleted, and each one is chained to the one before it."
        badge={
          verify.data &&
          (verify.data.ok ? (
            <Badge tone="good">Chain intact</Badge>
          ) : (
            <Badge tone="bad">
              Broken at entry {verify.data.brokenAtId}: {verify.data.reason}
            </Badge>
          ))
        }
        actions={
          <>
            {can("audit.verify") && (
              <button type="button" className="button" onClick={() => verify.mutate()} disabled={verify.isPending}>
                {verify.isPending ? <Spinner /> : verify.data && !verify.data.ok ? <ShieldAlert size={16} /> : <ShieldCheck size={16} />} Verify chain
              </button>
            )}
            {can("audit.export") && (
              <button type="button" className="button" onClick={() => exportCsv.mutate()} disabled={exportCsv.isPending}>
                {exportCsv.isPending ? <Spinner /> : <Download size={16} />} Export CSV
              </button>
            )}
          </>
        }
      />
      <ErrorText error={verify.error ?? exportCsv.error} />
      <DataGrid
        columns={columns}
        rows={list.data?.items}
        total={list.data?.total ?? 0}
        pages={list.data?.pages ?? 1}
        state={state}
        onChange={setState}
        rowKey={(a) => a.id}
        loading={list.isLoading}
        error={list.error}
        onRowClick={(a) => setOpen(open === a.id ? null : a.id)}
        expanded={(a) =>
          open === a.id ? (
            <div className="audit-detail">
              {a.before !== null && (
                <div>
                  <h3>Before</h3>
                  <pre>{JSON.stringify(a.before, null, 2)}</pre>
                </div>
              )}
              {a.after !== null && (
                <div>
                  <h3>After</h3>
                  <pre>{JSON.stringify(a.after, null, 2)}</pre>
                </div>
              )}
              {a.meta !== null && (
                <div>
                  <h3>Details</h3>
                  <pre>{JSON.stringify(a.meta, null, 2)}</pre>
                </div>
              )}
              <p className="muted">
                Device: {a.userAgent || "unknown"} · Hash {a.hash.slice(0, 16)}…
              </p>
            </div>
          ) : null
        }
        toolbar={
          <span className="inline-field">
            <CalendarRange size={16} />
            <input className="input input-small" type="date" aria-label="From date" value={from} onChange={(e) => setFrom(e.target.value)} />
            <span>to</span>
            <input className="input input-small" type="date" aria-label="To date" value={to} onChange={(e) => setTo(e.target.value)} />
          </span>
        }
        filters={[
          {
            key: "action",
            label: "Action",
            options: [
              ...actionPrefixes.map((p) => ({ value: p, label: `All ${p.slice(0, -1)} actions` })),
              ...(actions.data?.items ?? []).map((a) => ({ value: a, label: actionLabel(a) })),
            ],
          },
          { key: "actorType", label: "Actor", options: [{ value: "staff", label: "Staff" }, { value: "client", label: "Client" }, { value: "system", label: "System" }] },
        ]}
      />
    </>
  );
}
