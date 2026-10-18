import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Ban, CandlestickChart, Gauge, HandCoins, KeyRound, Receipt, RefreshCw, ServerCog, ServerOff, ShieldAlert, ShieldCheck, UserCheck, Wallet, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { DataGrid, gridQuery, type Column, type GridState } from "../components/DataGrid";
import { CopyText, money, parseAmountText, signedMoney, textProblem } from "../components/money";
import { DecisionError } from "../components/ReviewWorkbench";
import { Badge, CopyBox, Dialog, EmptyState, ErrorText, Field, PageHeader, Spinner, useFeedback } from "../components/ui";
import { ApiError, api, formatDate, qs, type Page } from "../lib/api";
import {
  ACCOUNTS_KEY,
  accountKey,
  BalanceCell,
  changeAmountText,
  ChangeDecision,
  failureText,
  GatewayOffNotice,
  isOpen,
  leverageText,
  Mt5StateBadge,
  OPERATIONS_KEY,
  OpStatusBadge,
  opSignedCents,
  PURPOSE_LABEL,
  REASON_LABEL,
  tradesKey,
  typeLabel,
  useMt5Servers,
  useMt5Settings,
  useOperationChanged,
  type DealSync,
  type DealSyncAnswer,
  type Mt5AccountItem,
  type Mt5AccountPage,
  type Mt5Live,
  type Mt5Operation,
  type Mt5OperationPage,
  type Mt5Trade,
  type Mt5TradePage,
  type ReasonCode,
} from "../lib/mt5";
import { useCan } from "../lib/session";

// Clients' MT5 accounts: a list across every client this staff member may
// see, and one account's page with what MT5 says about it now, its closed
// trades (from the CRM's copy of its MT5 deals, with "Sync now") and the
// changes staff can make (leverage, suspend and reactivate, a new password,
// and balance or credit changes, which wait for a second person's approval
// unless the MT5 settings let small ones run at once). Every change asks for
// a 2FA code and is recorded in the audit log. MT5's own error text is shown
// to staff here; clients never see it.

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived by the client" },
  { value: "suspended", label: "Suspended" },
  { value: "creating", label: "Being opened" },
  { value: "unknown", label: "Not confirmed" },
  { value: "failed", label: "Not opened" },
];

const columns: Column<Mt5AccountItem>[] = [
  {
    key: "login",
    header: "Login",
    sortable: true,
    render: (a) => (
      <span className="stack-tight">
        {a.login !== null ? <strong className="mono">{a.login}</strong> : <span className="muted">No login yet</span>}
        <small className="muted">{a.serverLabel}</small>
      </span>
    ),
  },
  {
    key: "client",
    header: "Client",
    render: (a) => (
      <span className="stack-tight">
        <strong>{a.clientName}</strong>
        <small className="muted">
          {a.clientEmail} · {a.clientId}
        </small>
      </span>
    ),
  },
  {
    key: "type",
    header: "Type",
    render: (a) => (
      <span className="stack-tight">
        <span>{typeLabel(a)}</span>
        <small className="muted">{a.packageName}</small>
      </span>
    ),
  },
  { key: "leverage", header: "Leverage", optional: true, render: (a) => leverageText(a.leverage) },
  { key: "balance_cents", header: "Balance", sortable: true, render: (a) => <BalanceCell a={a} /> },
  { key: "status", header: "Status", render: (a) => <Mt5StateBadge state={a.state} /> },
  { key: "created_at", header: "Created", sortable: true, optional: true, render: (a) => formatDate(a.createdAt) },
];

const initialClient = () => {
  const v = new URLSearchParams(window.location.search).get("client");
  return v && /^\d{1,12}$/.test(v) ? v : "";
};

export function Mt5AccountsList() {
  const can = useCan();
  const [, navigate] = useLocation();
  const servers = useMt5Servers();
  const [state, setState] = useState<GridState>(() => {
    const clientId = initialClient();
    const filters: Record<string, string> = clientId ? { clientId } : {};
    return { page: 1, pageSize: 25, sort: "created_at", dir: "desc", filters };
  });
  const list = useQuery({
    queryKey: [...ACCOUNTS_KEY, state],
    queryFn: () => api.get<Page<Mt5AccountItem>>(`/api/staff/mt5/accounts${qs(gridQuery(state))}`),
    placeholderData: (prev) => prev,
  });
  return (
    <>
      <PageHeader
        title="MT5 accounts"
        description="Clients' MetaTrader 5 accounts, live and demo. The list shows the figures last read from MT5; open an account to read them now and to make changes."
        actions={
          (can("mt5.servers") || can("mt5.view")) && (
            <Link href="/settings/mt5" className="button">
              <ServerCog size={16} /> MT5 settings
            </Link>
          )
        }
      />
      {servers.data && !servers.data.gatewayConfigured && <GatewayOffNotice />}
      <DataGrid
        columns={columns}
        rows={list.data?.items}
        total={list.data?.total ?? 0}
        pages={list.data?.pages ?? 1}
        state={state}
        onChange={setState}
        rowKey={(a) => a.id}
        onRowClick={(a) => navigate(`/mt5/${a.id}`)}
        loading={list.isLoading}
        error={list.error}
        searchPlaceholder="Search login, client name, email or ID"
        filters={[
          { key: "type", label: "Type", options: [{ value: "real", label: "Live" }, { value: "demo", label: "Demo" }] },
          { key: "status", label: "Status", options: STATUS_OPTIONS },
        ]}
        toolbar={
          state.filters.clientId && (
            <span className="review-filter">
              Client {state.filters.clientId} only
              <button type="button" className="icon-button" aria-label="Show every client" title="Show every client" onClick={() => setState({ ...state, page: 1, filters: { ...state.filters, clientId: "" } })}>
                <X size={14} />
              </button>
            </span>
          )
        }
        emptyText="Accounts appear here as soon as clients open them in the portal or app."
      />
    </>
  );
}

// ---------------- One account ----------------

type Change = "leverage" | "suspend" | "reactivate" | "password-main" | "password-investor" | "adjust";

const CLIENT_STATUS: Record<string, ReactNode> = { frozen: <Badge tone="info">Frozen</Badge>, closed: <Badge tone="bad">Closed</Badge> };

export function Mt5AccountDetail({ id }: { id: string }) {
  const can = useCan();
  const client = useQueryClient();
  const { toast } = useFeedback();
  // Every read asks MT5 for the account, so it is not repeated in the background: Refresh reads again.
  // An account that does not exist (or is not this staff member's to see) is not asked for twice.
  const page = useQuery({
    queryKey: accountKey(id),
    queryFn: () => api.get<Mt5AccountPage>(`/api/staff/mt5/accounts/${id}`),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: (count, e) => !(e instanceof ApiError && e.status < 500) && count < 1,
  });
  const servers = useMt5Servers();
  const [change, setChange] = useState<Change | null>(null);
  const refresh = useMutation({
    mutationFn: () => api.post<Mt5AccountPage>(`/api/staff/mt5/accounts/${id}/refresh`),
    onSuccess: (res) => {
      client.setQueryData(accountKey(id), res);
      void client.invalidateQueries({ queryKey: ACCOUNTS_KEY });
      toast("Read from MT5 just now.");
    },
    onError: (e) => toast(e instanceof Error ? e.message : "MT5 could not be read.", "bad"),
  });

  if (page.error) {
    return (
      <>
        <Link href="/mt5" className="back-link">
          <ArrowLeft size={15} /> All MT5 accounts
        </Link>
        <DecisionError error={page.error} />
      </>
    );
  }
  const d = page.data;
  if (!d)
    return (
      <div className="center-screen loading-block">
        <Spinner size={22} />
      </div>
    );
  const a = d.account;
  /** After a change (or an answer MT5 did not confirm): read the account, the lists and the client's activity again. */
  const changed = () => {
    void client.invalidateQueries({ queryKey: accountKey(id) });
    void client.invalidateQueries({ queryKey: ACCOUNTS_KEY });
    void client.invalidateQueries({ queryKey: ["client-activity", String(a.clientId)] });
  };
  const server = servers.data?.items.find((s) => s.code === a.serverCode);
  // Why changes cannot be made now, if they cannot (an account not open in MT5 has no Changes panel).
  const blocked =
    servers.data && !servers.data.gatewayConfigured
      ? "MT5 is not connected, so nothing can be changed."
      : server && !server.isEnabled
        ? "This account's server is switched off in the MT5 settings, so nothing can be changed."
        : null;
  const mayEdit = can("mt5.edit");
  const mayPassword = can("mt5.password");
  // Balance and credit changes are for live accounts only; demo money has its own top-ups.
  const mayAdjust = can("mt5.balance.adjust") && !a.isDemo;
  const clientPanel = (
    <section className="panel">
      <div className="card-head">
        <h2 className="flush">Client</h2>
        {CLIENT_STATUS[a.clientStatus]}
      </div>
      <dl className="details">
        <dt>Name</dt>
        <dd>{can("client.view") ? <Link href={`/clients/${a.clientId}`}>{a.clientName}</Link> : a.clientName}</dd>
        <dt>Email</dt>
        <dd>{a.clientEmail}</dd>
        <dt>Client ID</dt>
        <dd className="mono">{a.clientId}</dd>
      </dl>
      <Link href={`/mt5?client=${a.clientId}`}>All MT5 accounts of this client</Link>
    </section>
  );

  return (
    <>
      <Link href="/mt5" className="back-link">
        <ArrowLeft size={15} /> All MT5 accounts
      </Link>
      <PageHeader
        title={a.login ? `MT5 ${a.login}` : "MT5 account"}
        badge={<Mt5StateBadge state={a.state} />}
        description={`${typeLabel(a)} · ${a.packageName} · ${a.serverLabel} · ${a.clientName}`}
        actions={
          isOpen(a) && (
            <button type="button" className="button" title="Read the account and its money from MT5 now" disabled={refresh.isPending || page.isFetching} onClick={() => refresh.mutate()}>
              {refresh.isPending || page.isFetching ? <Spinner /> : <RefreshCw size={15} />} Refresh
            </button>
          )
        }
      />
      <StateNotices a={a} live={d.live} />
      {servers.data && !servers.data.gatewayConfigured && <GatewayOffNotice />}
      {server && !server.isEnabled && (
        <div className="notice notice-warn">
          <ServerOff size={18} />
          <p>The server {server.label} is switched off in the MT5 settings: clients cannot open accounts, change them or move money on it, and staff cannot change them.</p>
        </div>
      )}
      <div className="columns columns-wide">
        {isOpen(a) && <FiguresPanel a={a} live={d.live} />}
        <DetailsPanel a={a} live={d.live} />
        {!isOpen(a) && clientPanel}
      </div>
      {isOpen(a) && (
        <div className="columns columns-wide">
          {clientPanel}
          {(mayEdit || mayPassword || mayAdjust) && (
            <section className="panel">
              <div className="card-head">
                <div>
                  <h2 className="flush">Changes</h2>
                  <p>
                    Each change asks for your 2FA code and is recorded in the audit log. Leverage, passwords and suspensions are made in MT5 straight away; a balance or credit change waits for
                    a second person's approval unless the MT5 settings let small ones run at once.
                  </p>
                </div>
              </div>
              {blocked ? (
                <p className="muted">{blocked}</p>
              ) : (
                <div className="stack">
                  {mayAdjust &&
                    (a.clientStatus === "closed" ? (
                      <small className="muted">This client's account is closed, so their MT5 balance and credit cannot change.</small>
                    ) : (
                      <button type="button" className="button" onClick={() => setChange("adjust")}>
                        <HandCoins size={16} /> Change balance or credit
                      </button>
                    ))}
                  {mayEdit && (
                    <button type="button" className="button" onClick={() => setChange("leverage")}>
                      <Gauge size={16} /> Change leverage
                    </button>
                  )}
                  {mayPassword && (
                    <>
                      <button type="button" className="button" onClick={() => setChange("password-main")}>
                        <KeyRound size={16} /> Reset master password
                      </button>
                      <button type="button" className="button" onClick={() => setChange("password-investor")}>
                        <KeyRound size={16} /> Reset investor password
                      </button>
                    </>
                  )}
                  {mayEdit &&
                    (a.suspendedAt ? (
                      <button type="button" className="button" onClick={() => setChange("reactivate")}>
                        <ShieldCheck size={16} /> Reactivate
                      </button>
                    ) : (
                      <button type="button" className="button button-danger" onClick={() => setChange("suspend")}>
                        <Ban size={16} /> Suspend
                      </button>
                    ))}
                </div>
              )}
            </section>
          )}
        </div>
      )}
      {isOpen(a) && !a.isDemo && can("wallet.view") && <PendingChanges a={a} blocked={blocked} />}
      {isOpen(a) && <ClosedTrades a={a} blocked={blocked} />}
      {(isOpen(a) || d.operations.length > 0) && <Operations d={d} />}
      {change === "leverage" && <LeverageDialog a={a} onClose={() => setChange(null)} onChanged={changed} />}
      {(change === "suspend" || change === "reactivate") && <SuspendDialog a={a} mode={change} onClose={() => setChange(null)} onChanged={changed} />}
      {(change === "password-main" || change === "password-investor") && (
        <PasswordDialog a={a} type={change === "password-main" ? "main" : "investor"} onClose={() => setChange(null)} onChanged={changed} />
      )}
      {change === "adjust" && <AdjustDialog a={a} live={d.live} onClose={() => setChange(null)} />}
    </>
  );
}

/** What staff should know about the account's state before anything else. */
function StateNotices({ a, live }: { a: Mt5AccountItem; live: Mt5Live | null }) {
  const notices: { warn?: boolean; text: ReactNode }[] = [];
  if (a.state === "creating") notices.push({ text: "MT5 is opening this account. If its answer does not arrive, the CRM looks the account up in MT5 by its reference and settles it." });
  if (a.state === "unknown")
    notices.push({
      warn: true,
      text: (
        <>
          MT5 did not confirm that this account was opened. The CRM searches MT5 for it by its reference <span className="mono">{a.createRef}</span> and settles it ({a.checks}{" "}
          {a.checks === 1 ? "search" : "searches"} so far{a.nextCheckAt ? `, next ${formatDate(a.nextCheckAt)}` : ""}).{a.failure ? ` Last result: ${failureText(a.failure)}.` : ""} Do not open a
          replacement account for the client until this is settled.
        </>
      ),
    });
  if (a.state === "failed") notices.push({ text: `MT5 did not open this account.${a.failure ? ` Reason: ${failureText(a.failure)}.` : ""} Nothing was created in MT5; the client can try again.` });
  if (a.state === "suspended")
    notices.push({
      warn: true,
      text: `Suspended${a.suspendedBy?.name ? ` by ${a.suspendedBy.name}` : ""}${a.suspendedAt ? ` on ${formatDate(a.suspendedAt)}` : ""}: the client cannot sign in to this account in MT5.${a.suspendedReason ? ` Reason: ${a.suspendedReason}` : ""}`,
    });
  if (a.archivedAt && isOpen(a)) notices.push({ text: `The client archived this account on ${formatDate(a.archivedAt)}: trading is switched off in MT5 until they restore it in the portal or app.` });
  if (live?.error) notices.push({ warn: true, text: `MT5 could not be read just now: ${live.error.replace(/\.?$/, ".")} The figures shown are the last ones saved.` });
  return (
    <>
      {notices.map((n, i) => (
        <div key={i} className={n.warn ? "notice notice-warn" : "notice notice-page"}>
          <ShieldAlert size={18} />
          <p>{n.text}</p>
        </div>
      ))}
    </>
  );
}

function FiguresPanel({ a, live }: { a: Mt5AccountItem; live: Mt5Live | null }) {
  const f = live?.figures;
  const saved = a.snapshotAt !== null && a.balanceCents !== null;
  const cur = a.currency;
  const row = (label: string, value: number | null | undefined) => (
    <>
      <dt>{label}</dt>
      <dd>{money(value ?? null, cur)}</dd>
    </>
  );
  return (
    <section className="panel">
      <div className="card-head">
        <h2 className="flush">
          <Wallet size={18} /> Money in MT5
        </h2>
        {f ? <Badge tone="good">Live</Badge> : saved ? <Badge tone="neutral">Saved figures</Badge> : null}
      </div>
      {!f && !saved ? (
        <p className="muted">MT5 has not been read for this account yet.</p>
      ) : (
        <>
          <div className="tile-label">Balance</div>
          <div className="tile-value">{money(f ? f.balanceCents : a.balanceCents, cur)}</div>
          <dl className="details" style={{ marginTop: 12 }}>
            {row("Equity", f ? f.equityCents : a.equityCents)}
            {row("Credit", f ? f.creditCents : a.creditCents)}
            {row("Margin", f ? f.marginCents : a.marginCents)}
            {row("Free margin", f ? f.marginFreeCents : a.marginFreeCents)}
            {f && (
              <>
                <dt>Open profit</dt>
                <dd className={f.profitCents < 0 ? "error-text" : undefined}>{signedMoney(f.profitCents, cur)}</dd>
              </>
            )}
          </dl>
          <p className="muted tight">{f ? `Read from MT5 ${formatDate(a.snapshotAt ?? new Date().toISOString())}.` : `Last read from MT5 ${formatDate(a.snapshotAt)}.`}</p>
        </>
      )}
    </section>
  );
}

/** A value with a warning when MT5 says something different from the CRM. */
const Differs = ({ children, show }: { children: ReactNode; show: boolean }) =>
  show ? (
    <small className="error-text block">
      <ShieldAlert size={12} /> {children}
    </small>
  ) : null;

/** "Opened in MT5" while MT5 has not given the date. */
const OPENED_TEXT: Record<Mt5AccountItem["status"], string> = { active: "Not known yet", creating: "Not confirmed yet", unknown: "Not confirmed yet", failed: "Not opened" };

function DetailsPanel({ a, live }: { a: Mt5AccountItem; live: Mt5Live | null }) {
  const can = useCan();
  const u = live?.user;
  return (
    <section className="panel">
      <div className="card-head">
        <h2 className="flush">Account</h2>
      </div>
      <dl className="details">
        <dt>Login</dt>
        <dd>{a.login ? <CopyText value={String(a.login)} label="login" /> : <span className="muted">No login yet</span>}</dd>
        <dt>Server</dt>
        <dd>
          {a.serverLabel} <span className="muted mono">({a.serverCode})</span>
        </dd>
        <dt>Type</dt>
        <dd>{typeLabel(a)}</dd>
        <dt>Package</dt>
        <dd>{a.packageId && can("package.view") ? <Link href="/packages">{a.packageName}</Link> : a.packageName}</dd>
        <dt>MT5 group</dt>
        <dd>
          <span className="mono">{a.group}</span>
          <Differs show={Boolean(u && u.group !== a.group)}>MT5 has it in {u?.group}</Differs>
        </dd>
        <dt>Leverage</dt>
        <dd>
          {leverageText(a.leverage)}
          <Differs show={Boolean(u && u.leverage !== a.leverage)}>MT5 says {leverageText(u?.leverage)}</Differs>
        </dd>
        <dt>Currency</dt>
        <dd>{a.currency}</dd>
        {u && (
          <>
            <dt>Sign-in</dt>
            <dd>
              {u.enabled ? "On in MT5" : "Off in MT5"}
              <Differs show={u.enabled === Boolean(a.suspendedAt)}>{a.suspendedAt ? "The CRM has it suspended" : "The CRM does not have it suspended"}</Differs>
            </dd>
            <dt>Trading</dt>
            <dd>
              {u.tradeDisabled ? "Off in MT5" : "On in MT5"}
              <Differs show={u.tradeDisabled !== Boolean(a.archivedAt)}>{a.archivedAt ? "The client archived it in the CRM" : "The CRM does not have it archived"}</Differs>
            </dd>
            <dt>Name in MT5</dt>
            <dd>{u.name || <span className="muted">None</span>}</dd>
            <dt>Email in MT5</dt>
            <dd>{u.email || <span className="muted">None</span>}</dd>
          </>
        )}
        <dt>Opened in MT5</dt>
        <dd>{a.registeredAt ? formatDate(a.registeredAt) : <span className="muted">{OPENED_TEXT[a.status]}</span>}</dd>
        <dt>Asked for</dt>
        <dd>{formatDate(a.createdAt)}</dd>
        <dt>Reference</dt>
        <dd>
          <span className="mono">{a.createRef}</span>
          <small className="muted block">The comment on the account in MT5.</small>
        </dd>
      </dl>
    </section>
  );
}

function Operations({ d }: { d: Mt5AccountPage }) {
  const can = useCan();
  const a = d.account;
  // Each operation, with Check now and Mark failed, lives on the Transfers page.
  const transfers = can("wallet.view");
  return (
    <section className="grid" style={{ marginBottom: 18 }}>
      <div className="grid-toolbar">
        <div>
          <h2 className="flush">
            <Receipt size={18} /> Balance operations
          </h2>
          <small className="muted">The latest 20 balance and credit operations the CRM asked MT5 to make on this account.</small>
        </div>
        {transfers && d.operations.length > 0 && (
          <div className="grid-toolbar-end">
            <Link href={`/transfers?account=${a.id}`}>All on the Transfers page</Link>
          </div>
        )}
      </div>
      <div className="grid-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Asked for</th>
              <th>Operation</th>
              <th>Amount</th>
              <th>Status</th>
              <th>MT5 ticket</th>
            </tr>
          </thead>
          <tbody>
            {d.operations.map((o) => (
              <tr key={o.id}>
                <td data-label="Asked for">{formatDate(o.createdAt)}</td>
                <td data-label="Operation">
                  <span className="stack-tight">
                    <span>{PURPOSE_LABEL[o.purpose] ?? o.purpose}</span>
                    <small className="muted mono">{transfers ? <Link href={`/transfers/${o.id}`}>{o.reference}</Link> : o.reference}</small>
                  </span>
                </td>
                <td data-label="Amount">
                  <strong>{signedMoney(opSignedCents(o), a.currency)}</strong>
                </td>
                <td data-label="Status">
                  <span className="stack-tight">
                    <OpStatusBadge status={o.status} />
                    {o.failure && <small className="muted">{failureText(o.failure)}</small>}
                    {o.status === "unknown" && (
                      <small className="muted">
                        {o.checks} {o.checks === 1 ? "search" : "searches"}
                        {o.nextCheckAt ? `, next ${formatDate(o.nextCheckAt)}` : ""}
                      </small>
                    )}
                    {o.status === "completed" && o.completedAt && <small className="muted">{formatDate(o.completedAt)}</small>}
                  </span>
                </td>
                <td data-label="MT5 ticket">{o.ticket !== null ? <span className="mono">{o.ticket}</span> : <span className="muted">–</span>}</td>
              </tr>
            ))}
            {d.operations.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">
                  <EmptyState icon={<Receipt size={32} />} title="No balance operations yet">
                    Transfers, demo top-ups and staff balance and credit changes for this account appear here.
                  </EmptyState>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------- Staff changes waiting for approval ----------------

/** This account's staff balance and credit changes that wait for a second person, with Approve and Reject. */
function PendingChanges({ a, blocked }: { a: Mt5AccountItem; blocked: string | null }) {
  // Another person may decide one at any moment, so the list is read again while it is on screen.
  const list = useQuery({
    queryKey: [...OPERATIONS_KEY, "account-awaiting", String(a.id)],
    queryFn: () => api.get<Page<Mt5Operation>>(`/api/staff/mt5/operations${qs({ accountId: a.id, status: "awaiting_approval", sort: "created_at", dir: "asc", pageSize: 50 })}`),
    refetchInterval: 30_000,
  });
  const items = list.data?.items ?? [];
  if (list.error) return <ErrorText error={list.error} />;
  if (!items.length) return null;
  const more = (list.data?.total ?? 0) - items.length;
  return (
    <section className="grid" style={{ marginBottom: 18 }}>
      <div className="grid-toolbar">
        <div>
          <h2 className="flush">
            <UserCheck size={18} /> Waiting for approval
          </h2>
          <small className="muted">Staff changes to this account's balance or credit. Each is sent to MT5 only once a second person approves it.</small>
        </div>
        {more > 0 && (
          <div className="grid-toolbar-end">
            <Link href={`/transfers?account=${a.id}&status=awaiting_approval`}>All {list.data!.total} on the Transfers page</Link>
          </div>
        )}
      </div>
      <div className="grid-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Change</th>
              <th>Reason</th>
              <th>Asked for by</th>
              <th>Decision</th>
            </tr>
          </thead>
          <tbody>
            {items.map((o) => (
              <tr key={o.id}>
                <td data-label="Change">
                  <span className="stack-tight">
                    <strong className="nowrap">{changeAmountText(o)}</strong>
                    <small className="muted mono">
                      <Link href={`/transfers/${o.id}`}>{o.reference}</Link>
                    </small>
                  </span>
                </td>
                <td data-label="Reason">
                  <span className="stack-tight">
                    <span>{o.change ? (REASON_LABEL[o.change.reasonCode] ?? o.change.reasonCode) : "–"}</span>
                    {o.change && <small className="muted pre-wrap">{o.change.note}</small>}
                  </span>
                </td>
                <td data-label="Asked for by">
                  <span className="stack-tight">
                    <span>{o.change?.requestedBy?.name ?? "–"}</span>
                    <small className="muted">{formatDate(o.createdAt)}</small>
                  </span>
                </td>
                <td data-label="Decision">
                  <ChangeDecision o={o} blocked={blocked} small />
                  {o.change && !o.change.canApprove && !o.change.canReject && <small className="muted">Needs someone allowed to make MT5 balance and credit operations.</small>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------- Closed trades ----------------

/** 0.5 → "0.50", 1.2345 → "1.2345": at least two decimals, as MT5 shows lots. */
const lotsText = (lots: number) => lots.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });

/** A signed amount, red when it is a loss. */
const Pnl = ({ cents, currency, strong }: { cents: number; currency: string; strong?: boolean }) => {
  const text = cents === 0 ? money(0, currency) : signedMoney(cents, currency);
  const cls = `nowrap${cents < 0 ? " error-text" : ""}`;
  return strong ? <strong className={cls}>{text}</strong> : <span className={cls}>{text}</span>;
};

const tradeColumns = (currency: string): Column<Mt5Trade>[] => [
  {
    key: "trade",
    header: "Trade",
    render: (t) => (
      <span className="stack-tight">
        <strong>
          {t.symbol || "–"} <span className={t.side === "buy" ? "trade-side buy" : "trade-side sell"}>{t.side === "buy" ? "Buy" : "Sell"}</span>
        </strong>
        <small className="muted mono nowrap">
          Position {t.positionId}
          {t.reversalTicket ? ` · after reversal ${t.reversalTicket}` : ""}
        </small>
      </span>
    ),
  },
  { key: "lots", header: "Lots", render: (t) => <span className="nowrap">{lotsText(t.lots)}</span> },
  {
    key: "price",
    header: "Open and close price",
    render: (t) => (
      <span className="mono nowrap trade-price">
        <span>{t.openPrice}</span> <span>→ {t.closePrice}</span>
      </span>
    ),
  },
  {
    key: "closed_at",
    header: "Closed",
    render: (t) => (
      <span className="stack-tight trade-when">
        <span>{formatDate(t.closedAt)}</span>
        <small className="muted">Opened {formatDate(t.openedAt)}</small>
      </span>
    ),
  },
  { key: "profit", header: "Profit", render: (t) => <Pnl cents={t.profitCents} currency={currency} /> },
  { key: "commission", header: "Commission", optional: true, render: (t) => <Pnl cents={t.commissionCents} currency={currency} /> },
  { key: "swap", header: "Swap", optional: true, render: (t) => <Pnl cents={t.swapCents} currency={currency} /> },
  {
    key: "net",
    header: "Net",
    render: (t) => (
      <span className="stack-tight">
        <Pnl cents={t.netCents} currency={currency} strong />
        {t.feeCents !== 0 && <small className="muted">Fees {signedMoney(t.feeCents, currency)}</small>}
      </span>
    ),
  },
];

/** How far the CRM's copy of the account's deals reaches, in a sentence. */
function SyncLine({ s }: { s: DealSync }) {
  if (s.running)
    return (
      <>
        <Spinner size={12} /> Reading this account's deals from MT5 now…
      </>
    );
  if (!s.syncedAt) return <>Not read from MT5 yet. The CRM reads every open account's deals on its own, at least once a day.</>;
  const until = s.syncedUntil ? ` Trades closed up to ${formatDate(s.syncedUntil)} are here.` : "";
  if (s.error)
    return (
      <span className="error-text">
        The last sync ({formatDate(s.syncedAt)}) did not finish: {s.error.replace(/\.?$/, ".")}
        {until}
      </span>
    );
  if (s.partial) return <>Part of the history is read so far ({formatDate(s.syncedAt)}).{until} The rest is read on the next syncs.</>;
  return <>Synced from MT5 {formatDate(s.syncedAt)}.{until}</>;
}

/** What "Sync now" found, for the toast. */
function syncMessage(res: DealSyncAnswer): [string, "good" | "bad"] {
  const r = res.result;
  const found = r.newDeals === 1 ? "1 new deal" : `${r.newDeals.toLocaleString()} new deals`;
  if (r.outcome === "failed") return [`The sync stopped: ${(r.error?.message ?? "MT5 could not be read").replace(/\.?$/, ".")}${r.newDeals ? ` ${found} were saved before that.` : ""}`, "bad"];
  if (r.outcome === "skipped") return ["This account cannot be synced now: it is not open in MT5, or its server is switched off.", "bad"];
  if (r.outcome === "partial") return [`Read ${found}, but not the whole history yet. Sync again, or let the CRM's own sync read the rest.`, "good"];
  return [r.newDeals ? `Synced: ${found} from MT5.` : "Synced: MT5 has nothing new for this account.", "good"];
}

/** The account's fully closed positions, newest close first, from the CRM's copy of its MT5 deals. */
function ClosedTrades({ a, blocked }: { a: Mt5AccountItem; blocked: string | null }) {
  const client = useQueryClient();
  const { toast } = useFeedback();
  const [state, setState] = useState<GridState>({ page: 1, pageSize: 25, filters: {} });
  const trades = useQuery({
    queryKey: [...tradesKey(a.id), state.page, state.pageSize],
    queryFn: () => api.get<Mt5TradePage>(`/api/staff/mt5/accounts/${a.id}/trades${qs({ page: state.page, pageSize: state.pageSize })}`),
    placeholderData: (prev) => prev,
    // A sync running elsewhere (the CRM's own, or a colleague's Sync now) is followed until it ends.
    refetchInterval: (q) => (q.state.data?.sync.running ? 5_000 : false),
  });
  const sync = useMutation({
    mutationFn: () => api.post<DealSyncAnswer>(`/api/staff/mt5/accounts/${a.id}/sync-deals`),
    onSuccess: (res) => {
      toast(...syncMessage(res));
      void client.invalidateQueries({ queryKey: tradesKey(a.id) });
    },
    onError: (e) => toast(e instanceof Error ? e.message : "MT5 could not be read.", "bad"),
  });
  const d = trades.data;
  const t = d?.totals;
  const busy = sync.isPending || Boolean(d?.sync.running);
  return (
    <div style={{ marginBottom: 18 }}>
      <DataGrid
        columns={tradeColumns(a.currency)}
        rows={d?.items}
        total={d?.total ?? 0}
        pages={d?.pages ?? 1}
        state={state}
        onChange={setState}
        rowKey={(x) => x.id}
        loading={trades.isLoading}
        error={trades.error}
        toolbar={
          <div className="trades-bar">
            <div className="trades-bar-text">
              <h2 className="flush">
                <CandlestickChart size={18} /> Closed trades
              </h2>
              <small className="muted">{d ? <SyncLine s={d.sync} /> : "Positions closed in MT5, from the CRM's copy of this account's deals."}</small>
              {t && t.trades > 0 && (
                <small className="trade-totals">
                  {t.trades.toLocaleString()} {t.trades === 1 ? "trade" : "trades"} · {lotsText(t.lots)} lots · Profit <Pnl cents={t.profitCents} currency={a.currency} /> · Commission{" "}
                  <Pnl cents={t.commissionCents} currency={a.currency} /> · Swap <Pnl cents={t.swapCents} currency={a.currency} /> · Net <Pnl cents={t.netCents} currency={a.currency} strong />
                </small>
              )}
            </div>
            <span className="stack-tight trades-bar-end">
              <button type="button" className="button button-small" title="Read this account's new deals from MT5 now" disabled={busy || Boolean(blocked)} onClick={() => sync.mutate()}>
                {busy ? <Spinner /> : <RefreshCw size={14} />} Sync now
              </button>
              {blocked && <small className="muted">{blocked}</small>}
            </span>
          </div>
        }
        emptyTitle="No closed trades yet"
        emptyText={
          d && !d.sync.syncedAt
            ? "The CRM has not read this account's deals from MT5 yet. Sync now reads them."
            : "A trade appears here once its position is fully closed in MT5 and the CRM has read its deals."
        }
      />
    </div>
  );
}

// ---------------- Changes ----------------

/** After an answer MT5 did not confirm, the account is read again so staff see what MT5 has now. */
const unconfirmed = (e: unknown) => e instanceof ApiError && (e.code === "MT5_UNCONFIRMED" || e.code === "MT5_DIFFERENT");

function LeverageDialog({ a, onClose, onChanged }: { a: Mt5AccountItem; onClose: () => void; onChanged: () => void }) {
  const { toast } = useFeedback();
  const settings = useMt5Settings();
  const offered = [...new Set([...(settings.data?.leverages ?? []), a.leverage])].sort((x, y) => y - x);
  const [choice, setChoice] = useState(String(a.leverage));
  const [other, setOther] = useState("");
  const text = choice === "other" ? other.trim() : choice;
  const value = /^\d{1,5}$/.test(text) ? Number(text) : NaN;
  const problem = choice === "other" && other.trim() && !(value >= 1 && value <= 10_000) ? "Enter a whole number from 1 to 10000, such as 500 for 1:500." : null;
  const ready = value >= 1 && value <= 10_000 && value !== a.leverage;
  const save = useMutation({
    mutationFn: () => api.post<{ account: Mt5AccountItem }>(`/api/staff/mt5/accounts/${a.id}/leverage`, { leverage: value }),
    onSuccess: () => {
      toast(`Leverage changed to ${leverageText(value)}.`);
      onChanged();
      onClose();
    },
    onError: (e) => unconfirmed(e) && onChanged(),
  });
  return (
    <Dialog open title={`Change the leverage of ${a.login}`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) save.mutate();
        }}
      >
        <p>
          The account is at <strong>{leverageText(a.leverage)}</strong> now. The change is made in MT5 straight away.
        </p>
        <Field label="New leverage" hint={problem ? <span className="error-text">{problem}</span> : "The list is the leverages clients may choose. The gateway refuses any leverage it does not allow."}>
          <select className="input" value={choice} onChange={(e) => setChoice(e.target.value)} autoFocus>
            {offered.map((n) => (
              <option key={n} value={n}>
                {leverageText(n)}
                {n === a.leverage ? " (now)" : ""}
              </option>
            ))}
            <option value="other">Another leverage…</option>
          </select>
        </Field>
        {choice === "other" && (
          <Field label="Leverage (1:…)">
            <input className="input" inputMode="numeric" value={other} onChange={(e) => setOther(e.target.value)} placeholder="500" maxLength={5} autoFocus />
          </Field>
        )}
        <DecisionError error={save.error} />
        <div className="actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={!ready || save.isPending}>
            {save.isPending && <Spinner />} Change leverage
          </button>
        </div>
        <p className="muted tight">You'll be asked for your 2FA code.</p>
      </form>
    </Dialog>
  );
}

const SUSPEND_COPY = {
  suspend: {
    title: "Suspend",
    body: "Sign-in to this account is switched off in MT5: the client cannot trade on it or open it in MetaTrader, and the portal and app show it as suspended. Open trades stay open, and only staff can reactivate it.",
    button: "Suspend account",
    done: "Account suspended. The client can no longer sign in to it.",
  },
  reactivate: {
    title: "Reactivate",
    body: "Sign-in to this account is switched on again in MT5, and the client can use it as before.",
    button: "Reactivate account",
    done: "Account reactivated.",
  },
} as const;

function SuspendDialog({ a, mode, onClose, onChanged }: { a: Mt5AccountItem; mode: "suspend" | "reactivate"; onClose: () => void; onChanged: () => void }) {
  const { toast } = useFeedback();
  const copy = SUSPEND_COPY[mode];
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  const problem = reason.trim().length < 5 ? "Enter the reason (at least 5 characters)." : textProblem(reason, "reason", 5, 300);
  const save = useMutation({
    mutationFn: () => api.post<{ account: Mt5AccountItem }>(`/api/staff/mt5/accounts/${a.id}/${mode}`, { reason: reason.trim() }),
    onSuccess: () => {
      toast(copy.done);
      onChanged();
      onClose();
    },
    onError: (e) => unconfirmed(e) && onChanged(),
  });
  return (
    <Dialog open title={`${copy.title} ${a.login}?`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (!problem) save.mutate();
        }}
      >
        <p>{copy.body}</p>
        {mode === "reactivate" && a.suspendedReason && (
          <p className="muted">
            Suspended{a.suspendedBy?.name ? ` by ${a.suspendedBy.name}` : ""} because: {a.suspendedReason}
          </p>
        )}
        <Field label="Reason" hint={tried && problem ? <span className="error-text">{problem}</span> : "Kept in the audit log. The client does not see it."}>
          <textarea className="input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} autoFocus />
        </Field>
        <DecisionError error={save.error} />
        <div className="actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={mode === "suspend" ? "button button-danger-solid" : "button button-primary"} disabled={save.isPending || (tried && Boolean(problem))}>
            {save.isPending && <Spinner />} {copy.button}
          </button>
        </div>
        <p className="muted tight">You'll be asked for your 2FA code.</p>
      </form>
    </Dialog>
  );
}

const PASSWORD_WORD = { main: "master", investor: "investor" } as const;

function PasswordDialog({ a, type, onClose, onChanged }: { a: Mt5AccountItem; type: "main" | "investor"; onClose: () => void; onChanged: () => void }) {
  const word = PASSWORD_WORD[type];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // The new password lives only in this dialog: not in the query cache, and gone once the dialog closes.
  const [made, setMade] = useState<{ login: string; password: string } | null>(null);
  const reset = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ login: string; type: string; password: string }>(`/api/staff/mt5/accounts/${a.id}/password`, { type });
      setMade({ login: res.login, password: res.password });
      onChanged();
    } catch (e) {
      setError(e);
      if (unconfirmed(e)) onChanged();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open title={made ? `New ${word} password` : `Reset the ${word} password of ${a.login}?`} onClose={onClose}>
      {made ? (
        <>
          <p>
            The {word} password of MT5 account <strong className="mono">{made.login}</strong> is now:
          </p>
          <CopyBox value={made.password} />
          <div className="notice notice-warn" style={{ marginTop: 14 }}>
            <KeyRound size={18} />
            <p>Staff are shown it only this once. The client can see it with the account's details in their portal and app, and was told in their notifications. Never send it by email or chat.</p>
          </div>
          <div className="actions">
            <button type="button" className="button button-primary" onClick={onClose}>
              Done
            </button>
          </div>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void reset();
          }}
        >
          <p>
            {type === "main"
              ? "The CRM makes a new master password, sets it in MT5 and shows it to you once. The current one stops working at once."
              : "The CRM makes a new investor (read-only) password, sets it in MT5 and shows it to you once. The current one stops working at once."}{" "}
            The client is told in their notifications.
          </p>
          <DecisionError error={error} />
          <div className="actions">
            <button type="button" className="button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="button button-danger-solid" disabled={busy}>
              {busy && <Spinner />} Reset {word} password
            </button>
          </div>
          <p className="muted tight">You'll be asked for your 2FA code.</p>
        </form>
      )}
    </Dialog>
  );
}

// ---------------- Balance and credit ----------------

type AdjustKind = "balance_in" | "balance_out" | "credit_in" | "credit_out";

const ADJUST_KINDS: { value: AdjustKind; label: string; help: string }[] = [
  { value: "balance_in", label: "Add to the balance", help: "The client's own money: they can trade it and withdraw it." },
  { value: "balance_out", label: "Take from the balance", help: "At most what the account could withdraw now: its balance, less its credit and the margin its open trades use." },
  { value: "credit_in", label: "Add credit", help: "The broker's money lent for trading: it adds to equity and free margin, and cannot be withdrawn." },
  { value: "credit_out", label: "Take credit away", help: "At most the credit the account has now. MT5 refuses it if the open trades need that margin." },
];

const REASON_OPTIONS = Object.entries(REASON_LABEL) as [ReasonCode, string][];

/** What the client could take out now, by the transfer rule: never the credit, never the margin open trades use. */
const withdrawable = (f: { balanceCents: number; equityCents: number; creditCents: number; marginCents: number }) =>
  Math.max(0, Math.min(f.balanceCents, f.equityCents - f.creditCents - f.marginCents));

function AdjustDialog({ a, live, onClose }: { a: Mt5AccountItem; live: Mt5Live | null; onClose: () => void }) {
  const { toast } = useFeedback();
  const changed = useOperationChanged();
  const settings = useMt5Settings();
  const [kind, setKind] = useState<AdjustKind>("balance_in");
  const [amount, setAmount] = useState("");
  const [reasonCode, setReasonCode] = useState<ReasonCode | "">("");
  const [note, setNote] = useState("");
  const [tried, setTried] = useState(false);
  const cur = a.currency;
  // MT5's figures as this page last read them; the server reads them again when the change is asked for and when it is approved.
  const f = live?.figures ?? (a.balanceCents !== null && a.equityCents !== null ? { balanceCents: a.balanceCents, creditCents: a.creditCents ?? 0, equityCents: a.equityCents, marginCents: a.marginCents ?? 0 } : null);
  const parsed = parseAmountText(amount);
  const max = settings.data?.maxTransferCents;
  const problems = {
    amount: parsed.problem ?? (max !== undefined && parsed.minor > max ? `One change can be at most ${money(max, cur)}, the transfer limit in the MT5 settings.` : null),
    reason: reasonCode ? null : "Choose the reason.",
    note: note.trim().length < 10 ? "Write why (at least 10 characters)." : textProblem(note, "note", 10, 500),
  };
  const ok = !problems.amount && !problems.reason && !problems.note;
  const threshold = settings.data?.adjustSecondApprovalCents ?? 0;
  const cents = parsed.minor ?? 0;
  const second = threshold === 0 || cents > threshold;
  const save = useMutation({
    mutationFn: () => api.post<Mt5OperationPage>(`/api/staff/mt5/accounts/${a.id}/adjustments`, { kind, amountCents: cents, reasonCode, note: note.trim() }),
    onSuccess: (res) => {
      const o = res.operation;
      toast(
        o.status === "awaiting_approval"
          ? `${o.reference} is waiting for a second person's approval. It is sent to MT5 once someone else approves it.`
          : o.status === "completed"
            ? `MT5 made the change: ${changeAmountText(o)}${o.ticket !== null ? ` (ticket ${o.ticket})` : ""}.`
            : `${o.reference} was sent, but MT5 did not confirm it yet. The CRM searches MT5 for its deal and settles it.`,
      );
      changed(o);
      onClose();
    },
    // MT5 refused it (the change is saved as failed) or the account changed meanwhile: read the account again.
    onError: (e) => e instanceof ApiError && e.status !== 403 && changed({ accountId: a.id, clientId: a.clientId }),
  });
  const help = ADJUST_KINDS.find((k) => k.value === kind)!.help;
  const limitHint =
    kind === "balance_out" && f
      ? `About ${money(withdrawable(f), cur)} could be taken now, by the figures on this page.`
      : kind === "credit_out" && f
        ? `The account has ${money(f.creditCents, cur)} of credit, by the figures on this page.`
        : max !== undefined
          ? `At most ${money(max, cur)} in one change.`
          : null;
  const show = (key: keyof typeof problems, text: ReactNode) => (tried && problems[key] ? <span className="error-text">{problems[key]}</span> : text);
  return (
    <Dialog open title={`Change the balance or credit of ${a.login}`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (ok) save.mutate();
        }}
      >
        {f && (
          <p className="muted">
            Now: balance {money(f.balanceCents, cur)}, credit {money(f.creditCents, cur)}, equity {money(f.equityCents, cur)}.
          </p>
        )}
        <fieldset className="flush adjust-kinds">
          <legend className="field-label">Change</legend>
          {ADJUST_KINDS.map((k) => (
            <label key={k.value} className="check">
              <input type="radio" name="adjust-kind" value={k.value} checked={kind === k.value} onChange={() => setKind(k.value)} />
              <span>{k.label}</span>
            </label>
          ))}
          <small className="field-hint block">{help}</small>
        </fieldset>
        <Field label={`Amount (${cur})`} hint={show("amount", limitHint)}>
          <input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="100.00" maxLength={16} autoFocus />
        </Field>
        <Field label="Reason" hint={show("reason", null)}>
          <select className="input" value={reasonCode} onChange={(e) => setReasonCode(e.target.value as ReasonCode)}>
            <option value="">Choose…</option>
            {REASON_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Note" hint={show("note", "Why, for the second person and the audit log. The client does not see it.")}>
          <textarea className="input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </Field>
        <div className="notice notice-page">
          <UserCheck size={18} />
          <p>
            {threshold === 0
              ? "Another person must approve this change before it is sent to MT5."
              : second
                ? `Over ${money(threshold, cur)}: another person must approve this change before it is sent to MT5.`
                : `Up to ${money(threshold, cur)} runs at once on your word, as long as what you ran alone in the last 24 hours stays within ${money(threshold, cur)}. Otherwise it waits for another person's approval.`}{" "}
            The client is told once MT5 has made it.
          </p>
        </div>
        <DecisionError error={save.error} />
        <div className="actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={save.isPending || (tried && !ok) || settings.isLoading}>
            {save.isPending && <Spinner />} {second ? "Ask for approval" : "Make the change"}
          </button>
        </div>
        <p className="muted tight">You'll be asked for your 2FA code.</p>
      </form>
    </Dialog>
  );
}
