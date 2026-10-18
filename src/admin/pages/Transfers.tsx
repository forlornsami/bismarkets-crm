import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Ban, BookOpen, CheckCircle2, Hourglass, Search, ShieldAlert, X, XCircle } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { DataGrid, gridQuery, type Column, type GridState } from "../components/DataGrid";
import { CopyText, money, signedMoney, textProblem } from "../components/money";
import { DecisionError } from "../components/ReviewWorkbench";
import { Dialog, Field, PageHeader, Spinner, useFeedback } from "../components/ui";
import { ApiError, api, formatDate, qs, type Page } from "../lib/api";
import {
  ACCOUNTS_KEY,
  accountKey,
  failureText,
  GatewayOffNotice,
  OpStatusBadge,
  OPERATIONS_KEY,
  operationKey,
  PURPOSE_LABEL,
  STATE_LABEL,
  typeLabel,
  useMt5Servers,
  type Mt5Operation,
  type Mt5OperationPage,
  type OpLedgerTransaction,
  type OpPurpose,
} from "../lib/mt5";
import { useCan } from "../lib/session";

// MT5 balance operations: money clients move between their wallet and their
// MT5 accounts, and the demo balances the CRM asks MT5 to add. When MT5's
// answer is lost, the operation stays open (any money it moves stays held)
// until the CRM finds its deal in MT5, or finds MT5 never made it. Staff who
// reconcile can run that search now, or mark an operation failed once it is
// ten minutes old and MT5 still has no deal for it. Nobody can mark one
// completed by hand. MT5's own error text is shown to staff here; clients
// never see it.

const STATUS_OPTIONS = [
  { value: "open", label: "Open (not settled)" },
  { value: "sending", label: "Sending" },
  { value: "unknown", label: "Not confirmed" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
];
const OPEN_FILTERS = ["open", "sending", "unknown"];
const PURPOSE_OPTIONS = (Object.keys(PURPOSE_LABEL) as OpPurpose[]).map((value) => ({ value, label: PURPOSE_LABEL[value] }));

/** The server's own rule: staff may mark an operation failed once it is this old. */
const FAIL_AFTER_MS = 10 * 60_000;

const isOpenOp = (o: Pick<Mt5Operation, "status">) => o.status === "sending" || o.status === "unknown";
const searches = (n: number) => `${n} ${n === 1 ? "search" : "searches"}`;

/** Where the CRM's search for an open operation's deal stands, in a few words. `checks` counts only searches that found nothing. */
function searchState(o: Mt5Operation) {
  if (o.failure === "mismatch") return "A deal with its reference does not match";
  const next = o.nextCheckAt ? formatDate(o.nextCheckAt) : null;
  if (o.checks === 0) return next ? `First search ${next}` : "Not searched yet";
  return `${searches(o.checks)} found nothing${next ? `, next ${next}` : ""}`;
}

/** Status, with what staff need beside it: the searches so far, the ticket, or who marked it failed. */
function OpStatus({ o }: { o: Mt5Operation }) {
  return (
    <span className="stack-tight">
      <OpStatusBadge status={o.status} />
      {o.status === "sending" && o.canCheck && <small className="muted">No answer saved for over 2 minutes</small>}
      {o.status === "unknown" && <small className="muted">{searchState(o)}</small>}
      {o.status === "completed" && o.ticket !== null && <small className="muted">Ticket {o.ticket}</small>}
      {o.status === "failed" && o.resolvedBy && <small className="muted">Marked by {o.resolvedBy.name}</small>}
    </span>
  );
}

const columns: Column<Mt5Operation>[] = [
  { key: "reference", header: "Reference", render: (o) => <strong className="mono nowrap">{o.reference}</strong> },
  {
    key: "client",
    header: "Client",
    render: (o) => (
      <span className="stack-tight">
        <strong>{o.clientName}</strong>
        <small className="muted">
          {o.clientEmail} · {o.clientId}
        </small>
      </span>
    ),
  },
  {
    key: "login",
    header: "Account",
    render: (o) => (
      <span className="stack-tight">
        <span className="mono">{o.login}</span>
        <small className="muted">
          {typeLabel(o)}
          {o.accountState === "archived" ? " · Archived" : o.accountState !== "active" ? ` · ${STATE_LABEL[o.accountState] ?? o.accountState}` : ""}
        </small>
      </span>
    ),
  },
  { key: "purpose", header: "Direction", optional: true, render: (o) => PURPOSE_LABEL[o.purpose] ?? o.purpose },
  {
    key: "amount_cents",
    header: "Amount",
    sortable: true,
    render: (o) => (
      <span className="stack-tight">
        <strong className="nowrap">{money(o.amountCents)}</strong>
        {/* Where the Direction column is left out for room. */}
        <small className="muted tablet-only">{PURPOSE_LABEL[o.purpose] ?? o.purpose}</small>
      </span>
    ),
  },
  { key: "status", header: "Status", render: (o) => <OpStatus o={o} /> },
  { key: "created_at", header: "Created", sortable: true, optional: true, render: (o) => formatDate(o.createdAt) },
  {
    key: "failure",
    header: "Failure reason",
    optional: true,
    // An open operation's reason is its last search result, so it reads as provisional.
    render: (o) => (o.failure ? <span className={o.status === "failed" ? undefined : "muted"}>{failureText(o.failure)}</span> : <span className="muted">–</span>),
  },
];

/** Starting filters from the address: ?client=, ?account= (from an MT5 account's page) and ?status=. */
function initialFilters() {
  const search = new URLSearchParams(window.location.search);
  const id = (name: string) => {
    const v = search.get(name);
    return v && /^\d{1,12}$/.test(v) ? v : "";
  };
  const status = search.get("status") ?? "";
  const filters: Record<string, string> = {};
  if (id("client")) filters.clientId = id("client");
  if (id("account")) filters.accountId = id("account");
  if (STATUS_OPTIONS.some((o) => o.value === status)) filters.status = status;
  return filters;
}

export function TransfersList() {
  const can = useCan();
  const [, navigate] = useLocation();
  const servers = useMt5Servers(can("mt5.view") || can("mt5.servers"));
  const [state, setState] = useState<GridState>(() => ({ page: 1, pageSize: 25, sort: "created_at", dir: "desc", filters: initialFilters() }));
  const { clientId, accountId } = state.filters;
  const list = useQuery({
    queryKey: [...OPERATIONS_KEY, state],
    queryFn: () => api.get<Page<Mt5Operation>>(`/api/staff/mt5/operations${qs(gridQuery(state))}`),
    placeholderData: (prev) => prev,
    refetchInterval: 30_000,
  });
  // Operations still open for the client or account shown (or for everyone), whatever the other filters.
  const open = useQuery({
    queryKey: [...OPERATIONS_KEY, "open", clientId ?? "", accountId ?? ""],
    queryFn: () => api.get<Page<Mt5Operation>>(`/api/staff/mt5/operations${qs({ status: "open", pageSize: 1, clientId, accountId })}`),
    refetchInterval: 30_000,
  });
  const openCount = open.data?.total ?? 0;
  const showingOpen = OPEN_FILTERS.includes(state.filters.status ?? "");
  // The account filter comes from an MT5 account's page as its id; staff know the account by its login.
  const login = accountId ? list.data?.items.find((o) => String(o.accountId) === accountId)?.login : undefined;
  const drop = (key: string) => setState({ ...state, page: 1, filters: { ...state.filters, [key]: "" } });

  return (
    <>
      <PageHeader
        title="Transfers"
        description="Money clients move between their wallet and their MT5 accounts, and demo balances added in MT5. When MT5's answer is lost, the operation stays open and the CRM searches MT5 for its deal until it can settle it."
      />
      {servers.data && !servers.data.gatewayConfigured && <GatewayOffNotice />}
      {openCount > 0 && !showingOpen && (
        <div className="notice notice-warn notice-row">
          <Hourglass size={18} />
          <p>
            {openCount === 1 ? "1 operation is" : `${openCount} operations are`} not settled yet. Money a transfer moves stays held until MT5's deal is found or the operation fails.
          </p>
          <button type="button" className="button button-small" onClick={() => setState({ ...state, page: 1, filters: { ...state.filters, status: "open" } })}>
            Show {openCount === 1 ? "it" : "them"}
          </button>
        </div>
      )}
      <DataGrid
        columns={columns}
        rows={list.data?.items}
        total={list.data?.total ?? 0}
        pages={list.data?.pages ?? 1}
        state={state}
        onChange={setState}
        rowKey={(o) => o.id}
        onRowClick={(o) => navigate(`/transfers/${o.id}`)}
        loading={list.isLoading}
        error={list.error}
        searchPlaceholder="Search reference, login, client name, email or ID"
        filters={[
          { key: "status", label: "Status", options: STATUS_OPTIONS },
          { key: "purpose", label: "Direction", options: PURPOSE_OPTIONS },
        ]}
        toolbar={
          <>
            {clientId && (
              <span className="review-filter">
                Client {clientId} only
                <button type="button" className="icon-button" aria-label="Show every client" title="Show every client" onClick={() => drop("clientId")}>
                  <X size={14} />
                </button>
              </span>
            )}
            {accountId && (
              <span className="review-filter">
                {login ? `MT5 ${login} only` : "One MT5 account only"}
                <button type="button" className="icon-button" aria-label="Show every account" title="Show every account" onClick={() => drop("accountId")}>
                  <X size={14} />
                </button>
              </span>
            )}
          </>
        }
        emptyText="Transfers appear here as soon as clients move money between their wallet and MT5 in the portal or app."
      />
    </>
  );
}

// ---------------- One operation ----------------

interface CheckAnswer extends Mt5OperationPage {
  result: "completed" | "failed" | "unknown" | "skipped";
  /** Why MT5 could not be searched, in MT5's words (staff only). */
  searchError: { kind: string; code: string; message: string } | null;
}

/** What the money did, or will do, for this operation's direction and status. */
function moneyEffect(o: Mt5Operation): string {
  const x = money(o.amountCents);
  if (o.purpose === "wallet_to_mt5") {
    if (isOpenOp(o)) return `${x} stays held in the client's wallet until then.`;
    return o.status === "completed" ? `${x} left the client's wallet.` : `${x} went back to the client's wallet.`;
  }
  if (o.purpose === "mt5_to_wallet") {
    if (isOpenOp(o)) return `The client's wallet gets ${x} only once the deal is found.`;
    return o.status === "completed" ? `${x} was added to the client's wallet.` : "The client's wallet was not credited.";
  }
  return "Demo money: the client's wallet is not involved.";
}

/** What staff should know about the operation's state before anything else. */
function StatusNotice({ o }: { o: Mt5Operation }) {
  let warn = false;
  let icon = <Hourglass size={18} />;
  let text: ReactNode;
  if (o.status === "sending") {
    warn = o.canCheck;
    text = o.canCheck
      ? `The CRM sent this to MT5 but saved no answer (last change ${formatDate(o.updatedAt)}). It searches MT5 for the deal by its reference and settles it.`
      : "The CRM is sending this to MT5 right now. It settles as soon as MT5 answers.";
  } else if (o.status === "unknown") {
    warn = true;
    icon = <ShieldAlert size={18} />;
    text =
      o.failure === "mismatch" ? (
        "MT5 has a deal with this reference, but its amount or direction does not match this operation. The CRM does not settle it on its own, and it cannot be marked failed while that deal exists: check the deal in MT5."
      ) : (
        <>
          MT5 did not confirm this operation. The CRM searches MT5 for a deal with the reference <span className="mono">{o.reference}</span> and settles it.
          {o.checks > 0 ? ` ${searches(o.checks)} found nothing so far.` : ""}
          {o.nextCheckAt ? ` Next search ${formatDate(o.nextCheckAt)}.` : ""}
          {o.failure ? ` Last result: ${failureText(o.failure)}.` : ""}
        </>
      );
  } else if (o.status === "completed") {
    icon = <CheckCircle2 size={18} />;
    text = `MT5 made the deal${o.ticket !== null ? ` (ticket ${o.ticket})` : ""}${o.completedAt ? ` on ${formatDate(o.completedAt)}` : ""}.`;
  } else {
    icon = <XCircle size={18} />;
    text = o.resolvedBy
      ? `Marked failed by ${o.resolvedBy.name} on ${formatDate(o.completedAt ?? o.updatedAt)}, after a search in MT5 found no deal.`
      : `MT5 did not make this deal.${o.failure ? ` Reason: ${failureText(o.failure)}.` : ""}`;
  }
  return (
    <div className={warn ? "notice notice-warn" : "notice notice-page"}>
      {icon}
      <p>
        {text} {moneyEffect(o)}
      </p>
    </div>
  );
}

/** "Check now" told staff what it found. */
function checkMessage(res: CheckAnswer): [string, "good" | "bad"] {
  const o = res.operation;
  if (res.searchError) return [`MT5 could not be searched: ${res.searchError.message.replace(/\.?$/, ".")} Nothing was settled.`, "bad"];
  if (res.result === "completed") return [`MT5 has the deal${o.ticket !== null ? ` (ticket ${o.ticket})` : ""}. ${o.reference} is completed.`, "good"];
  if (res.result === "failed") return [`MT5 still has no deal for ${o.reference}, so it is now failed. ${moneyEffect(o)}`, "good"];
  if (res.result === "skipped") return [`${o.reference} was settled by another check just now.`, "good"];
  if (o.failure === "mismatch") return ["MT5 has a deal with this reference, but it does not match this operation. Nothing was settled.", "bad"];
  return [`MT5 has no deal for ${o.reference} yet. The CRM searches again${o.nextCheckAt ? ` ${formatDate(o.nextCheckAt)}` : " soon"}.`, "good"];
}

export function TransferDetail({ id }: { id: string }) {
  const can = useCan();
  const client = useQueryClient();
  const { toast } = useFeedback();
  // Reading an operation does not ask MT5, so an open one is read again while it is on screen: the resolver may settle it at any moment.
  const page = useQuery({
    queryKey: operationKey(id),
    queryFn: () => api.get<Mt5OperationPage>(`/api/staff/mt5/operations/${id}`),
    refetchInterval: (q) => (q.state.data && isOpenOp(q.state.data.operation) ? 20_000 : false),
    retry: (count, e) => !(e instanceof ApiError && e.status < 500) && count < 1,
  });
  const servers = useMt5Servers(can("mt5.view") || can("mt5.servers"));
  const [failing, setFailing] = useState(false);
  /** After a settle (or an answer that says it was settled meanwhile): the lists, the account and the client's wallet change too. */
  const changed = (o: Mt5Operation) => {
    void client.invalidateQueries({ queryKey: operationKey(id) });
    void client.invalidateQueries({ queryKey: OPERATIONS_KEY });
    void client.invalidateQueries({ queryKey: accountKey(o.accountId) });
    void client.invalidateQueries({ queryKey: ACCOUNTS_KEY });
    void client.invalidateQueries({ queryKey: ["client-wallet", o.clientId] });
    void client.invalidateQueries({ queryKey: ["client-activity", String(o.clientId)] });
  };
  const check = useMutation({
    mutationFn: () => api.post<CheckAnswer>(`/api/staff/mt5/operations/${id}/check`),
    onSuccess: (res) => {
      client.setQueryData<Mt5OperationPage>(operationKey(id), { operation: res.operation, ledger: res.ledger });
      changed(res.operation);
      toast(...checkMessage(res));
    },
    onError: (e) => {
      toast(e instanceof Error ? e.message : "MT5 could not be searched.", "bad");
      // Settled meanwhile, or still being sent: show it as it is now.
      if (e instanceof ApiError && e.status === 409 && page.data) changed(page.data.operation);
    },
  });

  if (page.error) {
    return (
      <>
        <Link href="/transfers" className="back-link">
          <ArrowLeft size={15} /> All transfers
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
  const o = d.operation;
  const mayReconcile = can("wallet.reconcile");
  const gatewayOff = Boolean(servers.data && !servers.data.gatewayConfigured);

  return (
    <>
      <Link href="/transfers" className="back-link">
        <ArrowLeft size={15} /> All transfers
      </Link>
      <PageHeader
        title={o.reference}
        badge={<OpStatusBadge status={o.status} />}
        description={`${PURPOSE_LABEL[o.purpose] ?? o.purpose} · ${money(o.amountCents)} · MT5 ${o.login} · ${o.clientName}`}
      />
      <StatusNotice o={o} />
      {gatewayOff && <GatewayOffNotice />}
      <div className="columns columns-wide">
        <OperationPanel o={o} />
        {isOpenOp(o) && mayReconcile && (
          <SettlePanel o={o} blocked={gatewayOff ? "MT5 is not connected, so operations cannot be checked or marked failed." : null} checking={check.isPending} onCheck={() => check.mutate()} onFail={() => setFailing(true)} />
        )}
        <AccountPanel o={o} />
        <LedgerPanel o={o} ledger={d.ledger} />
      </div>
      {failing && (
        <FailDialog
          o={o}
          onClose={() => setFailing(false)}
          onChanged={() => changed(o)}
          onDone={(res) => {
            client.setQueryData<Mt5OperationPage>(operationKey(id), res);
            changed(res.operation);
          }}
        />
      )}
    </>
  );
}

function OperationPanel({ o }: { o: Mt5Operation }) {
  return (
    <section className="panel">
      <div className="card-head">
        <h2 className="flush">Operation</h2>
      </div>
      <dl className="details">
        <dt>Reference</dt>
        <dd>
          <CopyText value={o.reference} label="reference" />
          <small className="muted block">The comment on the deal in MT5.</small>
        </dd>
        <dt>Direction</dt>
        <dd>{PURPOSE_LABEL[o.purpose] ?? o.purpose}</dd>
        <dt>Amount</dt>
        <dd>
          {money(o.amountCents)}
          <small className="muted block">MT5 balance {signedMoney(o.signedCents)}</small>
        </dd>
        <dt>Status</dt>
        <dd>
          <OpStatusBadge status={o.status} />
        </dd>
        <dt>MT5 ticket</dt>
        <dd>{o.ticket !== null ? <span className="mono">{o.ticket}</span> : <span className="muted">{o.status === "completed" ? "Not recorded" : "None"}</span>}</dd>
        {o.failure && (
          <>
            <dt>{o.status === "failed" ? "Failure reason" : "Last result"}</dt>
            <dd>
              {failureText(o.failure)} <span className="muted mono">({o.failure})</span>
            </dd>
          </>
        )}
        {o.clientMessage && o.status === "failed" && (
          <>
            <dt>Told the client</dt>
            <dd>{o.clientMessage}</dd>
          </>
        )}
        {(isOpenOp(o) || o.checks > 0) && (
          <>
            <dt>Searches that found nothing</dt>
            <dd>
              {o.checks}
              {isOpenOp(o) && o.nextCheckAt && <small className="muted block">Next {formatDate(o.nextCheckAt)}</small>}
            </dd>
          </>
        )}
        <dt>Asked for</dt>
        <dd>{formatDate(o.createdAt)}</dd>
        <dt>Last change</dt>
        <dd>{formatDate(o.updatedAt)}</dd>
        {o.completedAt && (
          <>
            <dt>Settled</dt>
            <dd>{formatDate(o.completedAt)}</dd>
          </>
        )}
        {o.resolvedBy && (
          <>
            <dt>Marked failed by</dt>
            <dd>
              {o.resolvedBy.name}
              {o.resolvedNote && <small className="muted block">Note: {o.resolvedNote}</small>}
            </dd>
          </>
        )}
      </dl>
    </section>
  );
}

function SettlePanel({ o, blocked, checking, onCheck, onFail }: { o: Mt5Operation; blocked: string | null; checking: boolean; onCheck: () => void; onFail: () => void }) {
  const failFrom = new Date(new Date(o.createdAt).getTime() + FAIL_AFTER_MS).toISOString();
  return (
    <section className="panel">
      <div className="card-head">
        <div>
          <h2 className="flush">Settle it now</h2>
          <p>Only a deal found in MT5 completes an operation. Nobody can mark one completed by hand.</p>
        </div>
      </div>
      {blocked ? (
        <p className="muted">{blocked}</p>
      ) : (
        <div className="stack">
          <button type="button" className="button" disabled={!o.canCheck || checking} onClick={onCheck}>
            {checking ? <Spinner /> : <Search size={16} />} Check now
          </button>
          <small className="muted">
            {o.canCheck
              ? "Searches MT5 for the deal now, as the CRM does on its own, and settles the operation if the answer is clear."
              : "It is still being sent to MT5. Check now opens two minutes after its last change."}
          </small>
          <button type="button" className="button button-danger" disabled={!o.canFail || checking} onClick={onFail}>
            <Ban size={16} /> Mark failed
          </button>
          <small className="muted">
            {o.canFail
              ? "For an operation MT5 never made. The CRM searches MT5 once more first, and changes nothing if it finds a deal."
              : `Possible from ${formatDate(failFrom)}, once the operation is ten minutes old: until then MT5 may still be making the deal.`}
          </small>
        </div>
      )}
    </section>
  );
}

function AccountPanel({ o }: { o: Mt5Operation }) {
  const can = useCan();
  return (
    <section className="panel">
      <div className="card-head">
        <h2 className="flush">Client and account</h2>
      </div>
      <dl className="details">
        <dt>Client</dt>
        <dd>{can("client.view") ? <Link href={`/clients/${o.clientId}`}>{o.clientName}</Link> : o.clientName}</dd>
        <dt>Email</dt>
        <dd>{o.clientEmail}</dd>
        <dt>Client ID</dt>
        <dd className="mono">{o.clientId}</dd>
        <dt>MT5 login</dt>
        <dd>{can("mt5.view") ? <Link href={`/mt5/${o.accountId}`}>{o.login}</Link> : <span className="mono">{o.login}</span>}</dd>
        <dt>Type</dt>
        <dd>{typeLabel(o)}</dd>
        <dt>Server</dt>
        <dd className="mono">{o.serverCode}</dd>
        <dt>Account</dt>
        <dd>{STATE_LABEL[o.accountState] ?? o.accountState}</dd>
      </dl>
      <div className="stack">
        <Link href={`/transfers?account=${o.accountId}`}>All operations on MT5 {o.login}</Link>
        <Link href={`/transfers?client=${o.clientId}`}>All operations of this client</Link>
      </div>
    </section>
  );
}

// ---------------- Ledger ----------------

const LEDGER_KIND: Record<string, string> = {
  transfer_hold: "Held for the transfer",
  transfer_out: "Sent to MT5",
  transfer_release: "Returned to the wallet",
  transfer_in: "Received from MT5",
};

/** The ledger transactions an operation should have made by now (the server's ledger check uses the same rules). */
function expectedKinds(o: Mt5Operation): string[] {
  if (o.purpose === "wallet_to_mt5") return isOpenOp(o) ? ["transfer_hold"] : o.status === "completed" ? ["transfer_hold", "transfer_out"] : ["transfer_hold", "transfer_release"];
  if (o.purpose === "mt5_to_wallet") return o.status === "completed" ? ["transfer_in"] : [];
  return [];
}

/** "client:12:wallet" → "Client's wallet", with the raw ledger account beside it. */
function ledgerAccount(account: string, o: Mt5Operation) {
  if (/^client:\d+:wallet$/.test(account)) return "Client's wallet";
  if (/^client:\d+:hold$/.test(account)) return "Held in the client's wallet";
  if (account === `mt5_funding:${o.accountId}`) return `MT5 ${o.login}`;
  return account;
}

function LedgerPanel({ o, ledger }: { o: Mt5Operation; ledger: OpLedgerTransaction[] }) {
  const expected = expectedKinds(o);
  const actual = ledger.map((t) => t.kind);
  const matches = expected.length === actual.length && expected.every((k, i) => k === actual[i]);
  return (
    <section className="panel">
      <div className="card-head">
        <h2 className="flush">
          <BookOpen size={18} /> Ledger
        </h2>
      </div>
      {ledger.length === 0 ? (
        <p className="muted">
          {o.purpose === "demo_funding" || o.purpose === "demo_topup"
            ? "Demo money is not in the ledger."
            : o.purpose === "mt5_to_wallet" && o.status !== "completed"
              ? "Nothing is written to the ledger until MT5's deal is found."
              : "No ledger entries."}
        </p>
      ) : (
        <ul className="session-list">
          {ledger.map((t) => (
            <li key={t.id}>
              <div>
                <strong>{LEDGER_KIND[t.kind] ?? t.kind}</strong>
                <small className="muted">{formatDate(t.createdAt)}</small>
              </div>
              {t.entries.map((e, i) => (
                <div key={i}>
                  <span>{ledgerAccount(e.account, o)}</span>
                  <small className="muted mono">{e.account}</small>
                  <strong className="ledger-amount">{signedMoney(e.amountCents)}</strong>
                </div>
              ))}
            </li>
          ))}
        </ul>
      )}
      {!matches && (
        <div className="notice notice-warn" style={{ margin: "14px 0 0" }}>
          <ShieldAlert size={18} />
          <p>
            The ledger does not match this operation's status: it should have {expected.length ? expected.map((k) => LEDGER_KIND[k] ?? k).join(", then ") : "no entries"}. Tell an administrator; the
            CRM's ledger check reports it too.
          </p>
        </div>
      )}
    </section>
  );
}

// ---------------- Mark failed ----------------

/** What marking it failed does with the money, by direction. */
function failEffect(o: Mt5Operation) {
  if (o.purpose === "wallet_to_mt5") return `The ${money(o.amountCents)} held in ${o.clientName}'s wallet goes back to it, and the client is told the transfer did not go through.`;
  if (o.purpose === "mt5_to_wallet") return `No money moves: the client's wallet was never credited for it. The client is told the transfer did not go through.`;
  return "Demo money only: nothing moves in the client's wallet.";
}

interface DealFound {
  ticket: number;
  action: number;
  amountCents: number;
  expectedCents: number;
}
/** MT5 has a deal with the operation's reference, so it was not marked failed (the server sends the deal in `details`). */
function dealFound(e: unknown): DealFound | null {
  if (!(e instanceof ApiError) || e.code !== "MT5_DEAL_FOUND") return null;
  const d = e.details as unknown as Partial<DealFound> | undefined;
  return d && !Array.isArray(d) && Number.isInteger(d.amountCents) && Number.isInteger(d.expectedCents) ? (d as DealFound) : null;
}

function FailDialog({ o, onClose, onChanged, onDone }: { o: Mt5Operation; onClose: () => void; onChanged: () => void; onDone: (res: Mt5OperationPage) => void }) {
  const { toast } = useFeedback();
  const [note, setNote] = useState("");
  const [tried, setTried] = useState(false);
  const problem = note.trim().length < 10 ? "Write what you checked (at least 10 characters)." : textProblem(note, "note", 10, 500);
  const save = useMutation({
    mutationFn: () => api.post<Mt5OperationPage>(`/api/staff/mt5/operations/${o.id}/fail`, { note: note.trim() }),
    onSuccess: (res) => {
      toast(`${o.reference} is marked failed.${o.purpose === "wallet_to_mt5" ? ` ${money(o.amountCents)} is back in ${o.clientName}'s wallet.` : ""}`);
      onDone(res);
      onClose();
    },
    // Settled meanwhile, too new, or MT5 has a deal: read it again so the page shows it as it is now.
    onError: (e) => e instanceof ApiError && e.status === 409 && onChanged(),
  });
  const deal = dealFound(save.error);
  return (
    <Dialog open title={`Mark ${o.reference} failed?`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (!problem) save.mutate();
        }}
      >
        <p>
          Use this only for an operation MT5 never made. {failEffect(o)}
        </p>
        <p className="muted">Before anything changes, the CRM searches MT5 once more. If MT5 has a deal with this reference, the operation stays as it is.</p>
        <Field label="Note" hint={tried && problem ? <span className="error-text">{problem}</span> : "What you checked, for example the account's deals in MT5. Kept in the audit log; the client does not see it."}>
          <textarea className="input input-area" rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} autoFocus />
        </Field>
        {deal ? (
          <div className="notice notice-warn">
            <ShieldAlert size={18} />
            <p>
              {save.error instanceof Error ? save.error.message : ""} MT5's deal is {signedMoney(deal.amountCents)}
              {deal.action !== 2 ? ` and is not a balance deal (action ${deal.action})` : ""}; this operation expects {signedMoney(deal.expectedCents)}.
            </p>
          </div>
        ) : (
          <DecisionError error={save.error} />
        )}
        <div className="actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button-danger-solid" disabled={save.isPending || (tried && Boolean(problem))}>
            {save.isPending && <Spinner />} Mark failed
          </button>
        </div>
        <p className="muted tight">You'll be asked for your 2FA code.</p>
      </form>
    </Dialog>
  );
}
