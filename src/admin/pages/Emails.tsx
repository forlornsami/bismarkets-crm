import { useQuery } from "@tanstack/react-query";
import { FlaskConical, Info } from "lucide-react";
import { useState } from "react";
import { DataGrid, gridQuery, type Column, type GridState } from "../components/DataGrid";
import { Badge, PageHeader, Spinner } from "../components/ui";
import { api, formatDate, qs, type Page } from "../lib/api";

interface Email {
  id: number;
  to: string;
  template: string;
  subject: string;
  clientId: number | null;
  status: "queued" | "sent" | "failed" | "held";
  createdAt: string;
}

const STATUS = { held: ["neutral", "Held"], queued: ["info", "Queued"], sent: ["good", "Sent"], failed: ["bad", "Failed"] } as const;

const columns: Column<Email>[] = [
  { key: "created_at", header: "Time", sortable: true, render: (e) => formatDate(e.createdAt), width: "180px" },
  { key: "to", header: "To", render: (e) => e.to },
  { key: "subject", header: "Subject", render: (e) => e.subject },
  { key: "status", header: "Status", render: (e) => <Badge tone={STATUS[e.status][0]}>{STATUS[e.status][1]}</Badge> },
];

function EmailBody({ id }: { id: number }) {
  const q = useQuery({ queryKey: ["email", id], queryFn: () => api.get<{ body: string }>(`/api/staff/emails/${id}`) });
  if (!q.data) return <Spinner />;
  return <pre className="email-body">{q.data.body}</pre>;
}

export function Emails() {
  const [state, setState] = useState<GridState>({ page: 1, pageSize: 25, sort: "created_at", dir: "desc", filters: {} });
  const [open, setOpen] = useState<number | null>(null);
  const list = useQuery({
    queryKey: ["emails", state],
    queryFn: () => api.get<Page<Email> & { testMode: boolean }>(`/api/staff/emails${qs(gridQuery(state))}`),
    placeholderData: (prev) => prev,
  });
  return (
    <>
      <PageHeader title="Email outbox" description="Every email the CRM sends to clients: codes, invites, password resets and notices." />
      <div className="notice">
        {list.data?.testMode ? <FlaskConical size={18} /> : <Info size={18} />}
        <p>
          No email provider is connected yet, so messages are held here instead of being delivered.
          {list.data?.testMode
            ? " This is a test server, so you can open a message to read its code or link and finish a sign-up yourself."
            : " Codes and links are hidden."}
        </p>
      </div>
      <DataGrid
        columns={columns}
        rows={list.data?.items}
        total={list.data?.total ?? 0}
        pages={list.data?.pages ?? 1}
        state={state}
        onChange={setState}
        rowKey={(e) => e.id}
        onRowClick={(e) => setOpen(open === e.id ? null : e.id)}
        expanded={(e) => (open === e.id ? <EmailBody id={e.id} /> : null)}
        loading={list.isLoading}
        error={list.error}
        searchPlaceholder="Search address or subject"
        emptyText="Emails appear here when clients sign up or reset their password."
      />
    </>
  );
}
