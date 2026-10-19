import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { ArrowLeft, Play, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { ApiError, api, formatDate, qs, type Page } from "../lib/api";
import { ClientStatus } from "../pages/Clients";
import { DataGrid, gridQuery, type Column, type FilterDef, type GridState } from "./DataGrid";
import { KycStatusBadge } from "./kyc";
import { QueueTabs, SkippedNotice, Tile, useHold, type Claimer, type NextItem, type Person, type QueueTab } from "./queue";
import { Waiting } from "./ReviewWorkbench";
import { Avatar, Badge, ErrorText, PageHeader, Spinner, useFeedback } from "./ui";

// The one list page and the workbench pieces every approval queue is built
// from (KYC, deposits, withdrawals and IB applications), so they look and
// behave the same. The server decides who may do what; these only show it.

// ---------- The list page ----------

export interface QueueTabOption<T extends string> {
  value: T;
  label: string;
  count?: number;
  /** Items here still wait for a step: listed oldest first, and closed accounts can be shown. */
  open: boolean;
}

export interface QueueTile {
  icon: ReactNode;
  tone: string;
  label: string;
  value: ReactNode;
  foot: string;
}

export interface ReviewQueuePageProps<Row, T extends string, S extends string> {
  title: string;
  description: ReactNode;
  queue: QueueTab<S>;
  next: NextItem;
  /** Shows Start reviewing. */
  mayReview: boolean;
  /** The step Start reviewing works through from this tab and these filters, or null for every step. */
  stageOf: (tab: T, filters: Record<string, string>) => S | null;
  startLabel: (stage: S | null) => string;
  /** How many items Start reviewing would hand this person now; 0 disables it. */
  forMe: (stage: S | null) => number | undefined;
  tiles: QueueTile[];
  summaryError?: unknown;
  tabs: QueueTabOption<T>[];
  initialTab: T;
  listKey: string;
  listUrl: string;
  /** The column the list is sorted by first (the waiting column). */
  sort: string;
  columns: Column<Row>[];
  rowKey: (row: Row) => number;
  filters?: FilterDef[];
  searchPlaceholder: string;
  /** Where a row opens, or null when this role may see the list but not open items. */
  rowHref: ((row: Row) => string) | null;
  /** Why rows do not open, under the list. */
  noOpenText?: string;
  /** Reads ?client= and shows "Client N only" (on unless turned off). */
  clientFilter?: boolean;
  /** Offers "Show closed accounts" on open tabs (closed accounts are left out there unless asked for). */
  includeClosed?: boolean;
  empty: (tab: T) => { title: string; text: string };
}

const clientFromUrl = () => {
  const v = new URLSearchParams(window.location.search).get("client");
  return v && /^\d{1,12}$/.test(v) ? v : "";
};

/** One approval queue: Start reviewing, the skipped notice, the tiles, the status tabs and the list. */
export function ReviewQueuePage<Row, T extends string, S extends string>(p: ReviewQueuePageProps<Row, T, S>) {
  const [, navigate] = useLocation();
  const queue = p.queue.useTab();
  const isOpen = (t: T) => p.tabs.find((o) => o.value === t)?.open ?? false;
  const [tab, setTab] = useState<T>(p.initialTab);
  const [state, setState] = useState<GridState>(() => {
    const clientId = p.clientFilter === false ? "" : clientFromUrl();
    const filters: Record<string, string> = clientId ? { clientId } : {};
    return { page: 1, pageSize: 25, sort: p.sort, dir: isOpen(p.initialTab) ? "asc" : "desc", filters };
  });
  const showClosed = Boolean(p.includeClosed && isOpen(tab) && state.filters.includeClosed === "1");
  const list = useQuery({
    queryKey: [p.listKey, tab, state],
    queryFn: () => api.get<Page<Row>>(`${p.listUrl}${qs({ ...gridQuery(state), status: tab, includeClosed: showClosed ? "1" : undefined })}`),
    placeholderData: (prev) => prev,
    refetchInterval: 30_000,
  });
  const changeTab = (t: T) => {
    // Waiting items read oldest first, decided ones newest first. "Show closed accounts" only applies to
    // waiting items, and a hidden filter must not look active.
    const { includeClosed: _, ...rest } = state.filters;
    setTab(t);
    setState({ ...state, page: 1, dir: isOpen(t) ? "asc" : "desc", filters: isOpen(t) ? state.filters : rest });
  };
  const stage = p.mayReview ? p.stageOf(tab, state.filters) : null;
  const forMe = p.forMe(stage);
  const start = () => {
    p.queue.setStage(stage);
    p.next.mutate({});
  };
  const empty = p.empty(tab);
  const clientChip = p.clientFilter !== false && state.filters.clientId && (
    <span className="review-filter">
      Client {state.filters.clientId} only
      <button type="button" className="icon-button" aria-label="Show every client" title="Show every client" onClick={() => setState({ ...state, page: 1, filters: { ...state.filters, clientId: "" } })}>
        <X size={14} />
      </button>
    </span>
  );
  const closedBox = p.includeClosed && isOpen(tab) && (
    <label className="check grid-check">
      <input type="checkbox" checked={state.filters.includeClosed === "1"} onChange={(e) => setState({ ...state, page: 1, filters: { ...state.filters, includeClosed: e.target.checked ? "1" : "" } })} />
      <span>Show closed accounts</span>
    </label>
  );
  return (
    <>
      <PageHeader
        title={p.title}
        description={p.description}
        actions={
          p.mayReview && (
            <button type="button" className="button button-primary" disabled={p.next.isPending || forMe === 0} onClick={start}>
              {p.next.isPending ? <Spinner /> : <Play size={16} />} {p.startLabel(stage)}
              {forMe ? ` (${forMe})` : ""}
            </button>
          )
        }
      />
      <ErrorText error={p.next.error} />
      {p.mayReview && (
        <SkippedNotice
          count={queue.skipped.length}
          busy={p.next.isPending}
          onReview={() => {
            p.queue.remember([]);
            start();
          }}
        />
      )}
      {Boolean(p.summaryError) && <p className="error-text">The queue summary could not be loaded. {p.summaryError instanceof Error ? p.summaryError.message : ""}</p>}
      <div className="tiles">
        {p.tiles.map((t) => (
          <Tile key={t.label} {...t} />
        ))}
      </div>
      <QueueTabs value={tab} onChange={changeTab} options={p.tabs.map(({ value, label, count }) => ({ value, label, count }))} />
      <DataGrid
        columns={p.columns}
        rows={list.data?.items}
        total={list.data?.total ?? 0}
        pages={list.data?.pages ?? 1}
        state={state}
        onChange={setState}
        rowKey={p.rowKey}
        onRowClick={p.rowHref ? (r) => navigate(p.rowHref!(r)) : undefined}
        loading={list.isLoading}
        error={list.error}
        searchPlaceholder={p.searchPlaceholder}
        filters={p.filters}
        toolbar={
          (clientChip || closedBox) && (
            <>
              {clientChip}
              {closedBox}
            </>
          )
        }
        emptyTitle={empty.title}
        emptyText={empty.text}
      />
      {!p.rowHref && p.noOpenText && <p className="muted tight">{p.noOpenText}</p>}
    </>
  );
}

// ---------- Columns every queue shares ----------

/** The first column of every queue: how long an open item has waited, or when a decided one was sent. */
export const waitingColumn = <Row,>(key: string, open: (r: Row) => boolean, at: (r: Row) => string): Column<Row> => ({
  key,
  header: "Waiting",
  sortable: true,
  width: "110px",
  render: (r) => (open(r) ? <Waiting since={at(r)} /> : <span className="muted">{formatDate(at(r))}</span>),
});

export interface ListClient {
  id: number;
  name: string;
  email: string;
  avatarUrl?: string | null;
}

export const clientColumn = <Row,>(of: (r: Row) => ListClient): Column<Row> => ({
  key: "client",
  header: "Client",
  render: (r) => {
    const c = of(r);
    return (
      <span className="cell-person">
        <Avatar name={c.name} src={c.avatarUrl} />
        <span>
          <strong>{c.name}</strong>
          <small>
            {c.email} · {c.id}
          </small>
        </span>
      </span>
    );
  },
});

/** The status badge, or who is reviewing an open item right now, with the number of warnings under it. */
export const statusColumn = <Row,>(o: { badge: (r: Row) => ReactNode; open: (r: Row) => boolean; claimedBy: (r: Row) => Pick<Claimer, "name"> | null; warnings?: (r: Row) => number | undefined }): Column<Row> => ({
  key: "status",
  header: "Status",
  render: (r) => {
    const holder = o.open(r) ? o.claimedBy(r) : null;
    const n = o.warnings?.(r) ?? 0;
    return (
      <span className="stack-tight">
        {holder ? <Badge tone="info">Being reviewed by {holder.name ?? "staff"}</Badge> : o.badge(r)}
        {n > 0 && <small className="error-text">{n === 1 ? "1 warning" : `${n} warnings`}</small>}
      </span>
    );
  },
});

export const handledByColumn = <Row,>(render: (r: Row) => ReactNode): Column<Row> => ({ key: "handled", header: "Handled by", optional: true, render });

const nameOf = (p: Person | string | null | undefined) => (typeof p === "string" ? p : (p?.name ?? null));

/** "Approved by Sam Lee, 17 Oct 2026, 10:04", for the Handled by column. */
export const handledBy = (verb: string, by: Person | string | null | undefined, at: string | null | undefined) => `${verb} by ${nameOf(by) ?? "staff"}${at ? `, ${formatDate(at)}` : ""}`;

export const NotYet = () => <span className="muted">Not yet</span>;

// ---------- The workbench ----------

/** A decision on the item: which step (`kind`, mapped to its path) and what is sent. */
export interface Decision<K extends string> {
  kind: K;
  body: Record<string, unknown>;
  /** What this screen worked out, for the message when the server's answer does not say. */
  expect?: { second?: boolean; credits?: number | null };
}

export interface ReviewItemOptions<D, K extends string, R, S extends string> {
  /** "/api/staff/deposits" */
  base: string;
  /** "/deposits" */
  route: string;
  id: number;
  detailKey: string;
  queue: QueueTab<S>;
  next: NextItem;
  me: number;
  /** The item still waits for a step. */
  isOpen: (d: D) => boolean;
  /** This reviewer holds the item while working on it. */
  holdable: (d: D) => boolean;
  claimedBy: (d: D) => Claimer | null | undefined;
  paths: Record<K, string>;
  /** Sends a decision another way (to ask before sending it again); `post` sends a body to the decision's path. */
  send?: (x: Decision<K>, post: (body: Record<string, unknown>) => Promise<R>) => Promise<R>;
  /** Whether a refused decision reloads the item (default yes). */
  refreshOn?: (e: ApiError) => boolean;
  toast: (x: Decision<K>, res: R, d: D) => string;
  clientId: (d: D) => number;
  /** More queries to refresh after a decision (the client's page and activity always are). */
  invalidate?: (d: D) => QueryKey[];
  /** The queue's list and summary keys. */
  listKeys: string[];
  /** After a decision, open the next item (otherwise back to the list). */
  mayContinue: boolean;
}

/**
 * Loading one item, holding it while it is reviewed, deciding it and moving
 * on: the same for every queue. Opening an item is audited, so it is never
 * fetched again in the background.
 */
export function useReviewItem<D, K extends string, R, S extends string>(o: ReviewItemOptions<D, K, R, S>) {
  const [, navigate] = useLocation();
  const client = useQueryClient();
  const { toast } = useFeedback();
  const detail = useQuery({ queryKey: [o.detailKey, o.id], queryFn: () => api.get<D>(`${o.base}/${o.id}`), staleTime: Infinity, refetchOnWindowFocus: false });
  const d = detail.data;
  const open = d ? o.isOpen(d) : false;
  const holdable = d ? o.holdable(d) : false;
  const hold = useHold({
    base: o.base,
    id: o.id,
    me: o.me,
    open,
    holdable,
    claimedBy: d ? o.claimedBy(d) : undefined,
    reload: async () => {
      const r = await detail.refetch();
      return r.data && o.isOpen(r.data) ? o.claimedBy(r.data) : null;
    },
  });
  const back = () => navigate(o.route);
  const decide = useMutation({
    mutationFn: (x: Decision<K>) => {
      const post = (body: Record<string, unknown>) => api.post<R>(`${o.base}/${o.id}/${o.paths[x.kind]}`, body);
      return o.send ? o.send(x, post) : post(x.body);
    },
    onSuccess: (res, x) => {
      hold.decided.current = true;
      o.queue.remember(o.queue.skipped().filter((v) => v !== o.id));
      if (d) {
        toast(o.toast(x, res, d));
        const cid = o.clientId(d);
        for (const key of [["client", String(cid)], ["client-activity", String(cid)], ...(o.invalidate?.(d) ?? [])]) void client.invalidateQueries({ queryKey: key });
      }
      // Shown fresh if it is opened again, without fetching (and auditing) it now.
      void client.invalidateQueries({ queryKey: [o.detailKey, o.id], refetchType: "none" });
      for (const key of o.listKeys) void client.invalidateQueries({ queryKey: [key] });
      // Staff who may only reject have no queue to be handed the next item from.
      if (o.mayContinue) o.next.mutate({});
      else back();
    },
    // Someone else may have decided or taken the item, or the rules changed: show the item as it is now.
    // A refused field (such as a link in the note) is the reviewer's to fix, and reloading would audit another view.
    onError: (e) => {
      if (e instanceof ApiError && e.code !== "STEP_UP_REQUIRED" && !e.details?.length && [400, 403, 409].includes(e.status) && (o.refreshOn?.(e) ?? true)) void hold.refresh();
    },
  });
  const skip = () => {
    o.queue.remember([...o.queue.skipped().filter((x) => x !== o.id), o.id]);
    hold.decided.current = true;
    o.next.mutate({ release: o.id });
  };
  return { detail, d, open, holdable, hold, decide, variables: decide.variables, skip, back };
}

/** The workbench while its item loads, or when it cannot be opened. */
export function ReviewItemMissing({ error, route }: { error: unknown; route: string }) {
  if (error)
    return (
      <>
        <Link href={route} className="back-link">
          <ArrowLeft size={15} /> Queue
        </Link>
        <ErrorText error={error} />
      </>
    );
  return (
    <div className="center-screen loading-block">
      <Spinner size={22} />
    </div>
  );
}

/** "Second approval · 2 of 5 waiting", or just "2 of 5 waiting" for a queue with one step. */
export const positionText = (q: { pending: number; position: number | null } | null | undefined, stage?: string | null) => {
  const where = q && q.position ? `${q.position} of ${q.pending} waiting` : null;
  return [stage, where].filter(Boolean).join(" · ") || undefined;
};

/** "Next: second approvals only ✕" in the workbench head, while Start reviewing keeps to one step. */
export function NextOnly({ what, clearLabel, onClear }: { what: string; clearLabel: string; onClear: () => void }) {
  return (
    <span className="review-filter">
      Next: {what} only
      <button type="button" className="icon-button" aria-label={clearLabel} title={clearLabel} onClick={onClear}>
        <X size={14} />
      </button>
    </span>
  );
}

export interface CardClient {
  id: number;
  name: string;
  verifiedName?: string | null;
  email: string;
  avatarUrl?: string | null;
  status: "active" | "frozen" | "closed";
  kycStatus?: "none" | "partial" | "pending" | "approved" | "rejected";
  country?: string | null;
  joinedAt?: string | null;
  createdAt?: string | null;
  assignedTo?: Person | number | null;
}

/** The client beside every item: who they are, their account and KYC, when they joined and who looks after them. */
export function ClientCard({ client, picture = true, children }: { client: CardClient; picture?: boolean; children?: ReactNode }) {
  const assigned = client.assignedTo && typeof client.assignedTo === "object" ? (client.assignedTo.name ?? "Staff") : null;
  const joined = client.joinedAt ?? client.createdAt ?? null;
  const verified = <strong>{client.verifiedName || "–"}</strong>;
  return (
    <>
      <h3 className="flush">Client</h3>
      <dl className="details details-tight">
        <dt>Verified name</dt>
        <dd>
          {picture ? (
            <span className="cell-person">
              <Avatar name={client.verifiedName || client.name} src={client.avatarUrl} />
              {verified}
            </span>
          ) : (
            verified
          )}
        </dd>
        <dt>Client</dt>
        <dd>
          {/* A new tab, so the item stays held and the ticked checks stay. */}
          <a href={`/clients/${client.id}`} target="_blank" rel="noreferrer">
            {client.id} · {client.email}
          </a>
        </dd>
        <dt>Account</dt>
        <dd>
          <ClientStatus c={{ status: client.status, lockedUntil: null }} /> {client.kycStatus && <KycStatusBadge status={client.kycStatus} />}
        </dd>
        <dt>Joined</dt>
        <dd>
          {joined ? formatDate(joined) : "–"}
          {client.country ? ` · ${client.country}` : ""}
        </dd>
        <dt>Assigned to</dt>
        <dd>{assigned ?? <span className="muted">Nobody</span>}</dd>
        {children}
      </dl>
    </>
  );
}

/** "Approved by Sam Lee on 17 Oct 2026, 10:04." */
export const decidedLine = (verb: string, by: Person | string | null | undefined, at: string | null | undefined) =>
  `${verb} by ${nameOf(by) ?? "staff"}${at ? ` on ${formatDate(at)}` : ""}.`;
/** " Told the client: …", after a decided line, when the client was given a reason. */
export const toldClient = (reason: string | null | undefined) => (reason ? ` Told the client: ${reason}` : "");

/** How a decided item ended, in the queue's own words. */
export function DecidedNotice({ children }: { children: ReactNode }) {
  return (
    <div className="notice">
      <p>{children}</p>
    </div>
  );
}

/** The line under every decision about 2FA and the audit log. */
export function ReviewFootnote({ recorded, held }: { recorded: string; held: boolean }) {
  return (
    <p className="muted tight">
      Decisions ask for your 2FA code at most every few minutes. {recorded} is recorded in the audit log.
      {held ? " This item is held for you while you work on it." : ""}
    </p>
  );
}

/** One line of "What happened", as every queue's server sends it. */
export interface TrailItem {
  at: string;
  action: string;
  label: string;
  /** Null for the client. */
  staff: string | null;
  reason: string | null;
  internalNote: string | null;
}

// Steps whose reason went to the client; any other reason was kept for staff.
const TOLD_CLIENT = /(^|\.)(rejected|new_document_requested|removed)$/;

/** What happened to the item, oldest first, from the audit log: decisions and internal notes, never who opened it. */
export function ReviewHistory({ items }: { items: TrailItem[] | null | undefined }) {
  if (!items?.length) return null;
  return (
    <>
      <h3>What happened</h3>
      <ol className="timeline trail">
        {items.map((t, i) => (
          <li key={i} className={t.staff ? "by-staff" : ""}>
            <strong>{t.label}</strong>
            <small className="muted">
              {formatDate(t.at)}
              {t.staff ? ` · ${t.staff}` : ""}
            </small>
            {t.reason && <small>{TOLD_CLIENT.test(t.action) ? `Told the client: ${t.reason}` : t.action === "uploaded_by_staff" ? `Note: ${t.reason}` : `Reason: ${t.reason}`}</small>}
            {t.internalNote && <small className="trail-note">Internal note: {t.internalNote}</small>}
          </li>
        ))}
      </ol>
    </>
  );
}
