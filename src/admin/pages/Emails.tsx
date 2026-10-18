import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FlaskConical, Info, RotateCcw, Send, XCircle } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import { DataGrid, gridQuery, type Column, type GridState } from "../components/DataGrid";
import { Badge, PageHeader, Spinner, useFeedback } from "../components/ui";
import { api, formatDate, qs, type Page } from "../lib/api";
import { useCan } from "../lib/session";

type Status = "queued" | "sending" | "sent" | "failed" | "held" | "cancelled";

interface Email {
  id: number;
  to: string;
  template: string;
  category: "system" | "service" | "marketing";
  subject: string;
  clientId: number | null;
  staffUserId: number | null;
  campaignId: number | null;
  status: Status;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
}

const STATUS: Record<Status, [tone: "neutral" | "info" | "good" | "bad" | "warn", label: string]> = {
  held: ["neutral", "Held"],
  queued: ["info", "Waiting to send"],
  sending: ["info", "Sending"],
  sent: ["good", "Sent"],
  failed: ["bad", "Failed"],
  cancelled: ["neutral", "Cancelled"],
};

const STATUS_FILTER = { key: "status", label: "Status", options: (Object.keys(STATUS) as Status[]).map((s) => ({ value: s, label: STATUS[s][1] })) };

export const EmailStatus = ({ status }: { status: Status }) => <Badge tone={STATUS[status][0]}>{STATUS[status][1]}</Badge>;

function EmailBody({ email, onChanged }: { email: Email; onChanged: () => void }) {
  const can = useCan();
  const { toast, confirm } = useFeedback();
  const q = useQuery({ queryKey: ["email", email.id], queryFn: () => api.get<{ body: string }>(`/api/staff/emails/${email.id}`) });
  const act = useMutation({
    mutationFn: (what: "retry" | "cancel") => api.post(`/api/staff/emails/${email.id}/${what}`),
    onSuccess: (_d, what) => {
      toast(what === "retry" ? "The email will be sent again." : "The email was cancelled.");
      onChanged();
    },
    onError: (err) => toast(err instanceof Error ? err.message : "That did not work.", "bad"),
  });
  if (!q.data) return <Spinner />;
  return (
    <div className="stack">
      {email.lastError && (
        <div className="notice notice-warn">
          <XCircle size={18} />
          <p>
            {email.status === "failed" ? "Delivery failed" : `Attempt ${email.attempts} failed`}: {email.lastError}
          </p>
        </div>
      )}
      <pre className="email-body">{q.data.body}</pre>
      <div className="actions actions-left">
        {email.sentAt && <span className="muted">Sent {formatDate(email.sentAt)}</span>}
        {email.campaignId && <Link href={`/messages/${email.campaignId}`}>Open the email this belongs to</Link>}
        {email.clientId && <Link href={`/clients/${email.clientId}`}>Open client {email.clientId}</Link>}
        {can("comms.send") && (email.status === "failed" || email.status === "held") && (
          <button type="button" className="button button-small" disabled={act.isPending} onClick={() => act.mutate("retry")}>
            <RotateCcw size={14} /> Send again
          </button>
        )}
        {can("comms.send") && (email.status === "held" || email.status === "queued") && (
          <button
            type="button"
            className="button button-small"
            disabled={act.isPending}
            onClick={async () => {
              if (await confirm({ title: "Cancel this email?", body: `It will not be sent to ${email.to}.`, confirmLabel: "Cancel email", danger: true })) act.mutate("cancel");
            }}
          >
            <XCircle size={14} /> Cancel
          </button>
        )}
      </div>
    </div>
  );
}

/** The outbox as a grid, optionally narrowed to one client, colleague or sent email. */
export function OutboxGrid({ clientId, campaignId, staffUserId, emptyText }: { clientId?: number; campaignId?: number; staffUserId?: number; emptyText?: string }) {
  const client = useQueryClient();
  const [state, setState] = useState<GridState>({ page: 1, pageSize: campaignId || clientId ? 10 : 25, sort: "created_at", dir: "desc", filters: {} });
  const [open, setOpen] = useState<number | null>(null);
  const list = useQuery({
    queryKey: ["emails", state, clientId, campaignId, staffUserId],
    queryFn: () => api.get<Page<Email> & { testMode: boolean; deliveryOn: boolean }>(`/api/staff/emails${qs({ ...gridQuery(state), clientId, campaignId, staffUserId })}`),
    placeholderData: (prev) => prev,
    refetchInterval: (q) => (q.state.data?.items.some((e) => e.status === "queued" || e.status === "sending") ? 5000 : false),
  });
  const columns: Column<Email>[] = [
    { key: "created_at", header: "Time", sortable: true, render: (e) => formatDate(e.createdAt), width: "180px" },
    { key: "to", header: "To", render: (e) => e.to },
    { key: "subject", header: "Subject", render: (e) => e.subject },
    { key: "status", header: "Status", render: (e) => <EmailStatus status={e.status} />, width: "150px" },
  ];
  return (
    <DataGrid
      columns={columns}
      rows={list.data?.items}
      total={list.data?.total ?? 0}
      pages={list.data?.pages ?? 1}
      state={state}
      onChange={setState}
      rowKey={(e) => e.id}
      onRowClick={(e) => setOpen(open === e.id ? null : e.id)}
      expanded={(e) => (open === e.id ? <EmailBody email={e} onChanged={() => void client.invalidateQueries({ queryKey: ["emails"] })} /> : null)}
      loading={list.isLoading}
      error={list.error}
      filters={[STATUS_FILTER]}
      searchPlaceholder="Search address or subject"
      emptyText={emptyText ?? "Emails appear here when clients sign up, reset their password or staff send them a message."}
    />
  );
}

export function Emails() {
  const can = useCan();
  const status = useQuery({
    queryKey: ["emails", "mode"],
    queryFn: () => api.get<Page<Email> & { testMode: boolean; deliveryOn: boolean }>(`/api/staff/emails${qs({ pageSize: 1 })}`),
  });
  const on = status.data?.deliveryOn;
  return (
    <>
      <PageHeader
        title="Email outbox"
        description="Every email the CRM sends: codes, invites, password resets, KYC results and messages from staff. Open one to read it."
        actions={
          can("comms.send") && (
            <Link href="/messages/new" className="button button-primary">
              <Send size={15} /> Send email
            </Link>
          )
        }
      />
      {status.data && !on && (
        <div className="notice">
          {status.data.testMode ? <FlaskConical size={18} /> : <Info size={18} />}
          <p>
            Sending is switched off, so new emails are held here instead of being delivered.
            {can("settings.view") && (
              <>
                {" "}
                Set up the mail provider in <Link href="/settings/email">Email settings</Link>.
              </>
            )}
            {status.data.testMode ? " This is a test server, so you can open a message to read its code or link and finish a sign-up yourself." : " Codes and links are hidden."}
          </p>
        </div>
      )}
      <OutboxGrid />
    </>
  );
}
