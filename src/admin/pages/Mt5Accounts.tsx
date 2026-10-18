import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Ban, Gauge, KeyRound, Receipt, RefreshCw, ServerCog, ServerOff, ShieldAlert, ShieldCheck, Wallet, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { DataGrid, gridQuery, type Column, type GridState } from "../components/DataGrid";
import { CopyText, money, signedMoney, textProblem } from "../components/money";
import { DecisionError } from "../components/ReviewWorkbench";
import { Badge, CopyBox, Dialog, EmptyState, Field, PageHeader, Spinner, useFeedback } from "../components/ui";
import { ApiError, api, formatDate, qs, type Page } from "../lib/api";
import {
  ACCOUNTS_KEY,
  accountKey,
  BalanceCell,
  failureText,
  GatewayOffNotice,
  isOpen,
  leverageText,
  Mt5StateBadge,
  OpStatusBadge,
  opSignedCents,
  PURPOSE_LABEL,
  typeLabel,
  useMt5Servers,
  useMt5Settings,
  type Mt5AccountItem,
  type Mt5AccountPage,
  type Mt5Live,
} from "../lib/mt5";
import { useCan } from "../lib/session";

// Clients' MT5 accounts: a list across every client this staff member may
// see, and one account's page with what MT5 says about it now and the
// changes staff can make (leverage, suspend and reactivate, a new password).
// Every change asks for a 2FA code and is recorded in the audit log. MT5's
// own error text is shown to staff here; clients never see it.

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

type Change = "leverage" | "suspend" | "reactivate" | "password-main" | "password-investor";

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
          {(mayEdit || mayPassword) && (
            <section className="panel">
              <div className="card-head">
                <div>
                  <h2 className="flush">Changes</h2>
                  <p>Each change is made in MT5 straight away, asks for your 2FA code and is recorded in the audit log.</p>
                </div>
              </div>
              {blocked ? (
                <p className="muted">{blocked}</p>
              ) : (
                <div className="stack">
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
      {(isOpen(a) || d.operations.length > 0) && <Operations d={d} />}
      {change === "leverage" && <LeverageDialog a={a} onClose={() => setChange(null)} onChanged={changed} />}
      {(change === "suspend" || change === "reactivate") && <SuspendDialog a={a} mode={change} onClose={() => setChange(null)} onChanged={changed} />}
      {(change === "password-main" || change === "password-investor") && (
        <PasswordDialog a={a} type={change === "password-main" ? "main" : "investor"} onClose={() => setChange(null)} onChanged={changed} />
      )}
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
          <small className="muted">The latest 20 balance changes the CRM asked MT5 to make on this account.</small>
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
                    Transfers and demo top-ups for this account appear here.
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
          <textarea className="input input-area" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} autoFocus />
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
            <p>This is the only time it is shown: the CRM does not keep it. Give it to the client over a secure channel, never by email or chat. The client was told in their notifications.</p>
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
