import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, CheckCircle2, History, Info, Play, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { DataGrid, gridQuery, type Column, type GridState } from "../components/DataGrid";
import { CopyText, formatDay, money, signedMoney, textProblem } from "../components/money";
import { DecisionError } from "../components/ReviewWorkbench";
import { Badge, Dialog, Field, PageHeader, Spinner, useFeedback, type Tone } from "../components/ui";
import { ApiError, api, formatDate, qs, type Page } from "../lib/api";
import {
  failureText,
  GatewayOffNotice,
  OpStatusBadge,
  PURPOSE_LABEL,
  RECON_KEY,
  RECON_SUMMARY_KEY,
  useMt5Servers,
  useReconSummary,
  type OpPurpose,
  type OpStatus,
  type ReconIssue,
  type ReconIssueKind,
  type ReconRun,
  type ReconSeverity,
  type ReconSummary,
} from "../lib/mt5";
import { useCan } from "../lib/session";

// MT5 reconciliation. Each night (and when staff press Run now) the CRM
// reads every open account's deals from MT5 and compares them with its own
// balance operations and the ledger, and lists the MT5 accounts in its
// groups that no CRM account has. What does not match is an issue, kept
// under the same key from run to run: a run that finds it again updates it,
// and a run that finds it no longer true resolves it. Staff who reconcile
// resolve the others with a note once they are explained or put right (with
// a 2FA code; the note goes in the audit log). Resolving changes nothing in
// MT5 or in the ledger, and a run only ever reads MT5.
//
// Logins, groups, server codes and MT5's comments are shown as they are:
// only staff see this page. An issue about a client is listed only to staff
// who may see that client, as the server decides.

const BASE = "/api/staff/mt5/reconciliation";

const KIND_LABEL: Record<ReconIssueKind, string> = {
  op_without_deal: "Completed, but no deal in MT5",
  deal_mismatch: "Deal does not match its operation",
  failed_op_has_deal: "Not completed, but MT5 has a deal",
  unknown_bis_deal: "BIS- deal no operation has",
  ledger_problem: "Ledger problem",
  funding_mismatch: "Funding line does not add up",
  external_balance_deal: "Money deal made outside the CRM",
  unsettled_op: "Operation open over an hour",
  account_missing: "Account not returned by MT5",
  unlinked_mt5_account: "MT5 account with no CRM account",
};
const KIND_OPTIONS = (Object.keys(KIND_LABEL) as ReconIssueKind[]).map((value) => ({ value, label: KIND_LABEL[value] }));

const SEVERITY: Record<ReconSeverity, { label: string; tone: Tone }> = {
  critical: { label: "Critical", tone: "bad" },
  warning: { label: "Warning", tone: "warn" },
  info: { label: "Info", tone: "info" },
};
const SEVERITY_OPTIONS = (Object.keys(SEVERITY) as ReconSeverity[]).map((value) => ({ value, label: SEVERITY[value].label }));
const SeverityBadge = ({ severity }: { severity: ReconSeverity }) => <Badge tone={SEVERITY[severity]?.tone ?? "neutral"}>{SEVERITY[severity]?.label ?? severity}</Badge>;

const STATUS_OPTIONS = [
  { value: "open", label: "Open" },
  { value: "resolved", label: "Resolved" },
];
const IssueStatusBadge = ({ i }: { i: ReconIssue }) => (i.status === "open" ? <Badge tone="warn">Open</Badge> : <Badge tone="good">Resolved</Badge>);

const RUN_STATUS: Record<ReconRun["status"], { label: string; tone: Tone }> = {
  running: { label: "Running", tone: "info" },
  done: { label: "Done", tone: "good" },
  failed: { label: "Failed", tone: "bad" },
};
const RunStatusBadge = ({ r }: { r: ReconRun }) => <Badge tone={RUN_STATUS[r.status]?.tone ?? "neutral"}>{RUN_STATUS[r.status]?.label ?? r.status}</Badge>;

/** States a run reopens whenever it finds them again, even after a person resolved them (the server's STATE_KINDS). */
const REOPENS: ReadonlySet<ReconIssueKind> = new Set<ReconIssueKind>(["ledger_problem", "funding_mismatch", "unsettled_op"]);
/** A run whose heartbeat is this old has stopped (the server's STALE_MS). */
const STALE_MS = 15 * 60_000;

// ---------- The facts in an issue's details ----------

interface DealFacts {
  server?: string;
  login?: number;
  ticket?: number;
  action?: number;
  amountCents?: number;
  comment?: string;
  time?: string;
}
interface OpFacts {
  reference?: string;
  purpose?: OpPurpose;
  status?: OpStatus;
  amountCents?: number;
  ticket?: number | null;
  /** The deal the operation should have in MT5. */
  expected?: { server?: string; login?: number; action?: number; amountCents?: number };
  completedAt?: string;
  failure?: string | null;
  since?: string;
  mt5HasDeal?: boolean;
  deal?: DealFacts;
  deals?: DealFacts[];
  reason?: string;
}
interface AccountFacts {
  server?: string;
  login?: number;
  group?: string;
  demo?: boolean;
  reason?: string;
}
interface FundingFacts {
  fundingAccount?: string;
  ledgerCents?: number;
  operationsCents?: number;
  server?: string | null;
  login?: number | null;
}

/** MT5 deal actions that move money or credit, as MT5 numbers them. */
const DEAL_ACTION: Record<number, string> = { 0: "buy", 1: "sell", 2: "balance", 3: "credit", 4: "charge", 5: "correction", 6: "bonus", 7: "commission" };
const act = (a: number | undefined) => (a === undefined ? "unknown" : (DEAL_ACTION[a] ?? `action ${a}`));
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const signed = (cents: number | undefined | null) => (typeof cents === "number" ? signedMoney(cents) : "–");
const where = (d: { login?: number | null; server?: string | null }) => `MT5 ${d.login ?? "–"}${d.server ? ` (${d.server})` : ""}`;
const purposeText = (p: OpPurpose | undefined) => (p ? (PURPOSE_LABEL[p] ?? p) : "operation");
const STATUS_WORD: Partial<Record<OpStatus, string>> = { failed: "failed", cancelled: "cancelled", awaiting_approval: "waiting for approval" };
const isDemoMoney = (p: OpPurpose | undefined) => p === "demo_funding" || p === "demo_topup";

/** Why a deal does not match the operation whose reference or ticket it carries, as one sentence. */
function mismatchText(d: OpFacts): string {
  const deal = d.deal ?? {};
  const exp = d.expected ?? {};
  const ref = d.reference ?? "the operation";
  const t = deal.ticket ?? "–";
  switch (d.reason) {
    case "amount":
      return `MT5 deal ${t} for ${ref} is ${signed(deal.amountCents)} instead of ${signed(exp.amountCents)}.`;
    case "sign":
      return `MT5 deal ${t} for ${ref} goes the other way: ${signed(deal.amountCents)} instead of ${signed(exp.amountCents)}.`;
    case "action":
      return `MT5 deal ${t} for ${ref} is a ${act(deal.action)} deal, not a ${act(exp.action)} deal.`;
    case "account":
      return `MT5 deal ${t} for ${ref} is on ${where(deal)}, not ${where(exp)}.`;
    case "duplicate":
      return `MT5 deal ${t} is a second deal for ${ref}: the money moved twice.`;
    case "ticket":
      return `MT5 answered ticket ${d.ticket ?? "–"} for ${ref}, but the deal with its reference is ticket ${t}.`;
    case "comment":
      return `MT5 deal ${t} has the ticket MT5 gave ${ref}, but its comment is "${deal.comment ?? ""}".`;
    default:
      return `MT5 deal ${t} does not match ${ref}.`;
  }
}

/** The issue in one sentence, for the list and the top of its page. */
function summaryText(i: ReconIssue): string {
  const op = i.details as OpFacts;
  const deal = i.details as DealFacts;
  const account = i.details as AccountFacts;
  const ref = op.reference ?? i.reference ?? "The operation";
  switch (i.kind) {
    case "op_without_deal":
      return `${ref} (${purposeText(op.purpose)}, ${money(op.amountCents)}) is completed, but MT5 has no deal with its reference.`;
    case "deal_mismatch":
      return mismatchText(op);
    case "failed_op_has_deal": {
      const n = op.deals?.length ?? 1;
      return `${ref} is ${STATUS_WORD[op.status ?? "failed"] ?? op.status}, but MT5 has ${n === 1 ? "a deal" : `${n} deals`} with its reference.`;
    }
    case "unknown_bis_deal":
      return `MT5 deal ${deal.ticket ?? "–"} on ${where(deal)}: ${signed(deal.amountCents)} ${act(deal.action)} with the comment ${deal.comment ?? ""}, which no CRM operation or account has.`;
    case "external_balance_deal":
      return `MT5 deal ${deal.ticket ?? "–"} on ${where(deal)}: ${signed(deal.amountCents)} ${act(deal.action)}, ${deal.comment ? `comment "${deal.comment}"` : "no comment"}. The CRM did not ask for it.`;
    case "ledger_problem":
      return String((i.details as { problem?: unknown }).problem ?? "The ledger check found a problem.");
    case "funding_mismatch": {
      const f = i.details as FundingFacts;
      const line = f.login ? `MT5 ${f.login}'s funding line` : `The ledger line ${f.fundingAccount ?? ""}`;
      return `${line} is ${money(f.ledgerCents)} in the ledger, but its completed transfers and balance changes add up to ${money(f.operationsCents)}.`;
    }
    case "unsettled_op":
      return op.status === "awaiting_approval"
        ? `${ref} (${purposeText(op.purpose)}, ${money(op.amountCents)}) has waited for a second person's approval since ${formatDate(op.since ?? null)}.`
        : `${ref} (${purposeText(op.purpose)}, ${money(op.amountCents)}) was sent to MT5 on ${formatDate(op.since ?? null)} and is still not settled.`;
    case "account_missing":
      return `${where(account)} is open in the CRM, but ${account.reason === "group_not_allowed" ? "MT5 has it in a group the gateway does not allow" : "MT5 has no account with this login"}.`;
    case "unlinked_mt5_account":
      return `MT5 ${account.login ?? "–"} is in the group ${account.group ?? "–"} on ${account.server ?? "–"}, but no CRM account has it.`;
    default:
      return i.key;
  }
}

/** What the issue means for the money, when there is more to say than the summary. */
function meaningText(i: ReconIssue): string | null {
  const op = i.details as OpFacts;
  const x = money(op.amountCents);
  const staffChange = op.purpose?.startsWith("staff_");
  switch (i.kind) {
    case "op_without_deal":
      if (op.purpose === "wallet_to_mt5") return `The client's wallet paid ${x} for it, but MT5 shows no deposit on the account.`;
      if (op.purpose === "mt5_to_wallet") return `The client's wallet received ${x}, but MT5 shows nothing taken from the account: the client may have the money twice.`;
      if (isDemoMoney(op.purpose)) return "Demo money only: no client money is involved.";
      return "The CRM shows the change as made, but MT5 has no deal for it.";
    case "deal_mismatch":
      return op.status === "sending" || op.status === "unknown"
        ? "The operation is not settled, and the CRM does not settle it on its own while this deal exists."
        : "MT5 moved a different amount of money from what the CRM recorded.";
    case "failed_op_has_deal":
      if (op.status === "awaiting_approval") return "The change is waiting for a second person and was never sent to MT5, yet MT5 has a deal for it. Find out who made the deal before anyone decides the change.";
      if (op.status === "cancelled") return "The change was rejected or cancelled before it was sent to MT5, yet MT5 has a deal for it.";
      if (op.purpose === "wallet_to_mt5") return `The transfer failed and ${x} went back to the client's wallet, but MT5 added it to the account too: the client has the money twice.`;
      if (op.purpose === "mt5_to_wallet") return `The transfer failed, so the client's wallet was not credited, but MT5 took ${x} from the account.`;
      if (isDemoMoney(op.purpose)) return "Demo money only: no client money is involved.";
      return staffChange ? "The change failed in the CRM, but MT5 made it." : null;
    case "unknown_bis_deal":
      return "The comment looks like one of the CRM's references, but the CRM never asked MT5 for this deal.";
    case "external_balance_deal":
      return "Someone changed the account's money in MT5 directly: a dealer or manager, or MT5 itself (commissions and bonuses). The client's wallet and the ledger were not involved.";
    case "ledger_problem":
      return "The CRM's ledger check found a problem in the ledger, which should never be wrong.";
    case "funding_mismatch": {
      const f = i.details as FundingFacts;
      const gap = (f.ledgerCents ?? 0) - (f.operationsCents ?? 0);
      return `Each MT5 account's funding line should equal what its completed transfers and staff balance changes moved. They are ${money(Math.abs(gap))} apart.`;
    }
    case "unsettled_op":
      if (op.status === "awaiting_approval") return "It is sent to MT5 only once a second person approves it.";
      return op.mt5HasDeal ? "MT5 has its deal, so the CRM should settle it soon." : "MT5 has no deal for it yet. Money a transfer moves stays held until it settles.";
    case "account_missing":
      return "While MT5 does not return it, the client cannot use it from the portal or app, and its trades and money are not read.";
    case "unlinked_mt5_account":
      return "It was opened in MT5 directly, or before the CRM. The CRM cannot show it to a client or move money for it.";
    default:
      return null;
  }
}

/** What staff should do about it. */
function todoText(i: ReconIssue): string {
  const op = i.details as OpFacts;
  switch (i.kind) {
    case "op_without_deal":
      return "Look for the deal in MT5, among the account's deals around the time it completed. If MT5 has it under another comment, or never made it, put the account right and tell an administrator, then resolve this with what you found and did.";
    case "deal_mismatch":
      return "Compare the deal in MT5 with the operation. Put the account right in MT5 (or with a staff balance change), then resolve this with what you did.";
    case "failed_op_has_deal":
      return "Check the deal in MT5 and who made it. Put the money right with the client and in MT5, then resolve this with what you did.";
    case "unknown_bis_deal":
      return "Find out in MT5 who made this deal (its dealer or manager login). It may be a mistake, or someone copying the CRM's references. Until it is explained, the account's MT5 money and the CRM's records differ by its amount.";
    case "external_balance_deal":
      return "Check it was meant to happen, then resolve this with who made it and why.";
    case "ledger_problem":
      return "Tell an administrator straight away. The ledger check (verify-ledger) reports the same problem, and the transaction it names shows what wrote it.";
    case "funding_mismatch":
      return "Tell an administrator: the ledger and this account's operations disagree. Compare the account's completed operations on the Transfers page with its ledger entries.";
    case "unsettled_op":
      return op.status === "awaiting_approval"
        ? "Approve or reject it on the Transfers page."
        : "Open the operation on the Transfers page: Check now searches MT5 for its deal again, and Mark failed is there for one MT5 never made.";
    case "account_missing":
      return "Check the login in MT5: was the account deleted, or moved to another group? Put it back, or tell the client.";
    case "unlinked_mt5_account":
      return "Find out whose account it is and why it is not in the CRM.";
    default:
      return "Check it, then resolve it with a note.";
  }
}

/** Whether a run resolves an open issue on its own, and when (the server's rules). */
function selfText(i: ReconIssue): string {
  const op = i.details as OpFacts;
  const never = "Runs do not resolve this on their own: MT5 keeps its deals, so it stays open until a person resolves it.";
  switch (i.kind) {
    case "op_without_deal":
      return "A run resolves this on its own once MT5 has a deal with its reference that matches it.";
    case "failed_op_has_deal":
      return op.status === "awaiting_approval" ? "If the change is approved and completes, a run resolves this on its own, and lists on its own any deal that does not match it." : never;
    case "unsettled_op":
      return op.status === "awaiting_approval" ? "A run resolves this on its own once the change is approved or rejected." : "A run resolves this on its own once the operation is settled.";
    case "account_missing":
      return "A run resolves this on its own once MT5 returns the account again, or once the account is closed in the CRM.";
    case "unlinked_mt5_account":
      return "A run resolves this on its own once a CRM account has this login, or MT5 no longer has it in the group.";
    case "ledger_problem":
      return "A run resolves this on its own once the ledger check no longer finds it.";
    case "funding_mismatch":
      return "A run resolves this on its own once the funding line and the account's operations agree.";
    default:
      return never;
  }
}
/** What a later run does with an issue a person resolves now. */
const reopenText = (kind: ReconIssueKind) =>
  REOPENS.has(kind)
    ? "If a later run still finds it, it opens again: resolve it once it is put right, or once you are sure it is meant to be so."
    : "A later run that finds it just as it is now leaves it resolved. It opens again only if what the run finds changes.";
/** What a later run does with a resolved issue. */
const afterText = (i: ReconIssue) =>
  i.resolvedAutomatically
    ? "If a later run finds it again, it opens again."
    : REOPENS.has(i.kind)
      ? "If a later run still finds it, it opens again."
      : "A later run that finds it just as it was leaves it resolved; it opens again only if what the run finds changes.";

// ---------- Small helpers ----------

/** "5 min ago", "3 h ago", "2 days ago". */
function ago(iso: string) {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 1) return "Just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

/** How long a run took (or has taken so far). */
function took(r: ReconRun) {
  const s = Math.max(0, Math.round(((r.finishedAt ? new Date(r.finishedAt).getTime() : Date.now()) - new Date(r.startedAt).getTime()) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** "Nightly, for 17 Oct 2026" or "Run now, by Bilal Admin". */
const runKind = (r: ReconRun) => (r.kind === "nightly" ? `Nightly, for ${formatDay(r.runDate)}` : `Run now, by ${r.startedBy?.name ?? "staff"}`);
const issuesText = (n: number) => `${n.toLocaleString()} ${n === 1 ? "issue" : "issues"}`;
/** A run's count, or a dash: staff who see only their own clients get none, as it counts across every client. */
const count = (n: number | null) => (n === null ? "–" : n.toLocaleString());

/** The client and MT5 account an issue is about, for a list row. */
function Subject({ i }: { i: ReconIssue }) {
  const d = i.details as AccountFacts;
  const login = i.login ?? d.login ?? null;
  const demo = i.isDemo ?? d.demo ?? null;
  // The server code is on the issue's page; a row has room for the login and whether it is live.
  return (
    <span className="stack-tight">
      {i.clientName ? <strong>{i.clientName}</strong> : <span className="muted">{i.kind === "ledger_problem" ? "The ledger" : "No client"}</span>}
      {login !== null && (
        <small className="muted">
          MT5 <span className="mono">{login}</span>
          {demo === true ? " · Demo" : demo === false ? " · Live" : ""}
        </small>
      )}
    </span>
  );
}

const issueColumns: Column<ReconIssue>[] = [
  {
    key: "issue",
    header: "Issue",
    render: (i) => (
      <span className="stack-tight">
        <strong>{KIND_LABEL[i.kind] ?? i.kind}</strong>
        <small className="muted">{summaryText(i)}</small>
      </span>
    ),
  },
  { key: "severity", header: "Severity", render: (i) => <SeverityBadge severity={i.severity} /> },
  { key: "subject", header: "Client and account", render: (i) => <Subject i={i} /> },
  {
    key: "status",
    header: "Status",
    render: (i) => (
      <span className="stack-tight">
        <IssueStatusBadge i={i} />
        {i.status === "resolved" && <small className="muted">{i.resolvedAutomatically ? "No longer found by a run" : `By ${i.resolvedBy?.name ?? "staff"}`}</small>}
        {i.reopened > 0 && <small className="muted">Came back {i.reopened === 1 ? "once" : `${i.reopened} times`}</small>}
      </span>
    ),
  },
  {
    key: "found",
    header: "Found",
    optional: true,
    render: (i) => (
      <span className="stack-tight">
        <span className="nowrap">{formatDate(i.createdAt)}</span>
        <small className="muted">
          Run {i.firstRunId}
          {i.lastRunId !== i.firstRunId ? `, last in run ${i.lastRunId}` : ""}
        </small>
      </span>
    ),
  },
];

const runColumns: Column<ReconRun>[] = [
  {
    key: "run",
    header: "Run",
    render: (r) => (
      <span className="stack-tight">
        <strong>Run {r.id}</strong>
        <small className="muted">{runKind(r)}</small>
      </span>
    ),
  },
  {
    key: "status",
    header: "Status",
    render: (r) => (
      <span className="stack-tight">
        <RunStatusBadge r={r} />
        {r.status === "done" && r.notes && <small className="muted">Did not check everything</small>}
        {r.status === "failed" && r.error && <small className="muted">{r.error}</small>}
        {r.attempts > 1 && <small className="muted">Attempt {r.attempts}</small>}
      </span>
    ),
  },
  {
    key: "started",
    header: "Started",
    render: (r) => (
      <span className="stack-tight">
        <span className="nowrap">{formatDate(r.startedAt)}</span>
        <small className="muted">{r.status === "running" ? `Running for ${took(r)}` : `Took ${took(r)}`}</small>
      </span>
    ),
  },
  {
    key: "accounts",
    header: "Accounts",
    render: (r) =>
      r.accountsTotal === null ? (
        <span className="muted">–</span>
      ) : (
        <span className="stack-tight">
          <span>
            {count(r.accountsChecked)} of {r.accountsTotal.toLocaleString()}
          </span>
          <small className="muted">read from MT5</small>
        </span>
      ),
  },
  {
    key: "found",
    header: "Found",
    render: (r) =>
      r.status === "running" ? (
        <span className="muted">Counted when it ends</span>
      ) : r.issuesFound === null ? (
        <span className="muted">–</span>
      ) : (
        <span className="stack-tight">
          <strong>{issuesText(r.issuesFound)}</strong>
          <small className="muted">
            {count(r.issuesNew)} new or back · {count(r.criticalFound)} critical
          </small>
        </span>
      ),
  },
];

/** Starting filters and tab from the address: ?severity=, ?kind=, ?status=open|resolved|all, ?client=, ?account=, ?run=, ?tab=runs. */
function initialFromAddress(): { tab: "issues" | "runs"; filters: Record<string, string> } {
  const search = new URLSearchParams(window.location.search);
  const id = (name: string) => {
    const v = search.get(name);
    return v && /^\d{1,12}$/.test(v) ? v : "";
  };
  const one = (name: string, allowed: { value: string }[]) => {
    const v = search.get(name) ?? "";
    return allowed.some((o) => o.value === v) ? v : "";
  };
  const status = search.get("status");
  const filters: Record<string, string> = { status: status === "all" ? "" : one("status", STATUS_OPTIONS) || "open" };
  if (one("severity", SEVERITY_OPTIONS)) filters.severity = one("severity", SEVERITY_OPTIONS);
  if (one("kind", KIND_OPTIONS)) filters.kind = one("kind", KIND_OPTIONS);
  if (id("client")) filters.clientId = id("client");
  if (id("account")) filters.accountId = id("account");
  if (id("run")) filters.runId = id("run");
  return { tab: search.get("tab") === "runs" ? "runs" : "issues", filters };
}

// ---------------- The page ----------------

export function Reconciliation() {
  const can = useCan();
  const client = useQueryClient();
  const { toast } = useFeedback();
  const [, navigate] = useLocation();
  const [initial] = useState(initialFromAddress);
  const [tab, setTab] = useState(initial.tab);
  const [issues, setIssues] = useState<GridState>({ page: 1, pageSize: 25, filters: initial.filters });
  const [runs, setRuns] = useState<GridState>({ page: 1, pageSize: 10, filters: {} });
  const [openRun, setOpenRun] = useState<number | null>(null);
  const summary = useReconSummary(true, true);
  const servers = useMt5Servers(can("mt5.view") || can("mt5.servers"));
  const running = summary.data?.running ?? null;
  const last = summary.data?.lastRun ?? null;

  // Issues are written as a run goes, so the lists are read again while one runs, and once more when it ends.
  const issueParams = { ...gridQuery(issues), sort: undefined, dir: undefined, status: issues.filters.status || "all" };
  const issueList = useQuery({
    queryKey: [...RECON_KEY, "issues", issueParams],
    queryFn: () => api.get<Page<ReconIssue>>(`${BASE}/issues${qs(issueParams)}`),
    placeholderData: (prev) => prev,
    refetchInterval: running ? 30_000 : false,
  });
  const runParams = { ...gridQuery(runs), sort: undefined, dir: undefined, q: undefined };
  const runList = useQuery({
    queryKey: [...RECON_KEY, "runs", runParams],
    queryFn: () => api.get<Page<ReconRun>>(`${BASE}/runs${qs(runParams)}`),
    placeholderData: (prev) => prev,
    enabled: tab === "runs",
    refetchInterval: running ? 10_000 : false,
  });
  const seen = useRef<number | null>(null);
  useEffect(() => {
    const was = seen.current;
    seen.current = running?.id ?? null;
    if (was === null || was === seen.current) return;
    void client.invalidateQueries({ queryKey: RECON_KEY });
    const ended = last?.id === was ? last : null;
    if (!ended) return;
    if (ended.status === "failed") toast(`Run ${ended.id} failed: ${ended.error ?? "see the server log"}`, "bad");
    else toast(ended.issuesFound === null ? `Run ${ended.id} ended.` : `Run ${ended.id} ended: ${issuesText(ended.issuesFound)} found, ${count(ended.issuesNew)} new or back.`, "good");
  }, [running?.id, last, client, toast]);

  const start = useMutation({
    mutationFn: () => api.post<{ run: ReconRun }>(`${BASE}/runs`, {}),
    onSuccess: ({ run }) => {
      client.setQueryData<ReconSummary>(RECON_SUMMARY_KEY, (s) => (s ? { ...s, running: run } : s));
      void client.invalidateQueries({ queryKey: RECON_KEY });
      toast(`Run ${run.id} started. It first reads every open account's deals from MT5, which can take a few minutes; this page follows it.`);
    },
    onError: (e) => {
      toast(e instanceof Error ? e.message : "The run could not be started.", "bad");
      // Another run started meanwhile: show it.
      if (e instanceof ApiError && e.code === "RUN_RUNNING") void client.invalidateQueries({ queryKey: RECON_SUMMARY_KEY });
    },
  });

  const gatewayOff = Boolean(servers.data && !servers.data.gatewayConfigured);
  const stale = running && Date.now() - new Date(running.heartbeatAt).getTime() > STALE_MS;
  const showSeverity = (severity: ReconSeverity) => {
    setTab("issues");
    setIssues({ ...issues, page: 1, filters: { ...issues.filters, status: "open", severity } });
  };
  const showRun = (runId: number) => {
    setTab("issues");
    setIssues({ ...issues, page: 1, filters: { status: "", runId: String(runId) } });
  };
  const drop = (key: string) => setIssues({ ...issues, page: 1, filters: { ...issues.filters, [key]: "" } });
  const { clientId, accountId, runId } = issues.filters;
  // The client and account filters come as ids (from an issue's page); staff know them by name and login.
  const sample = issueList.data?.items[0];
  const chip = (label: string, key: string, title: string) => (
    <span className="review-filter">
      {label}
      <button type="button" className="icon-button" aria-label={title} title={title} onClick={() => drop(key)}>
        <X size={14} />
      </button>
    </span>
  );

  return (
    <>
      <PageHeader
        title="Reconciliation"
        description="Each night the CRM reads every open MT5 account's deals and checks them against its own operations and the ledger, and looks for MT5 accounts the CRM does not have. Whatever does not match is listed here until a run finds it no longer true or someone resolves it with a note. A run only reads MT5: nothing on this page changes MT5 or money."
        actions={
          can("wallet.reconcile") && (
            <button
              type="button"
              className="button button-primary"
              disabled={start.isPending || Boolean(running) || gatewayOff}
              title={running ? "A run is going now" : gatewayOff ? "MT5 is not connected" : "Check MT5 against the CRM now, as the nightly run does"}
              onClick={() => start.mutate()}
            >
              {start.isPending ? <Spinner /> : <Play size={16} />} Run now
            </button>
          )
        }
      />
      {gatewayOff && <GatewayOffNotice />}
      {running && (
        <div className={stale ? "notice notice-warn" : "notice notice-page"}>
          {stale ? <AlertTriangle size={18} /> : <Spinner size={18} />}
          <p>
            Run {running.id} ({runKind(running)}) has been running since {formatDate(running.startedAt)}
            {/* Staff who see only their own clients get no account count: it is across every client. */}
            {running.accountsTotal === null
              ? "."
              : running.accountsTotal
                ? `: ${count(running.accountsChecked)} of ${running.accountsTotal.toLocaleString()} accounts read from MT5 so far.`
                : ": it is starting."}{" "}
            {stale
              ? `It has made no progress since ${formatDate(running.heartbeatAt)}, so its process may have stopped: another CRM process takes a nightly run over, and marks any other failed.`
              : "Issues appear as it finds them, and this page follows it until it ends."}
          </p>
        </div>
      )}
      {!running && last?.status === "failed" && (
        <div className="notice notice-warn">
          <AlertTriangle size={18} />
          <p>
            The last run (run {last.id}, {runKind(last)}) failed on {formatDate(last.finishedAt)}: {last.error ?? "see the server log."}
            {can("wallet.reconcile") ? " Start another with Run now." : ""}
          </p>
        </div>
      )}
      {!running && last?.status === "done" && last.notes && (
        <div className="notice notice-page">
          <Info size={18} />
          <p>The last run could not check everything, so some issues may not be listed yet. {last.notes}</p>
        </div>
      )}
      <SummaryTiles s={summary.data} error={summary.error} active={tab === "issues" && issues.filters.status === "open" ? issues.filters.severity : undefined} onSeverity={showSeverity} />
      <div className="tabs page-tabs" role="tablist" aria-label="Reconciliation">
        <button type="button" role="tab" aria-selected={tab === "issues"} onClick={() => setTab("issues")}>
          <ShieldAlert size={15} /> Issues
        </button>
        <button type="button" role="tab" aria-selected={tab === "runs"} onClick={() => setTab("runs")}>
          <History size={15} /> Runs
        </button>
      </div>
      {tab === "issues" ? (
        <DataGrid
          columns={issueColumns}
          rows={issueList.data?.items}
          total={issueList.data?.total ?? 0}
          pages={issueList.data?.pages ?? 1}
          state={issues}
          onChange={setIssues}
          rowKey={(i) => i.id}
          onRowClick={(i) => navigate(`/reconciliation/issues/${i.id}`)}
          loading={issueList.isLoading}
          error={issueList.error}
          searchPlaceholder="Reference, login, ticket or client"
          filters={[
            { key: "status", label: "Status", options: STATUS_OPTIONS },
            { key: "severity", label: "Severity", options: SEVERITY_OPTIONS },
            { key: "kind", label: "Kind", options: KIND_OPTIONS },
          ]}
          defaultFilters={{ status: "open" }}
          toolbar={
            <>
              {clientId && chip(sample?.clientId === Number(clientId) && sample.clientName ? `${sample.clientName} only` : `Client ${clientId} only`, "clientId", "Show every client")}
              {accountId && chip(sample?.accountId === Number(accountId) && sample.login ? `MT5 ${sample.login} only` : "One MT5 account only", "accountId", "Show every account")}
              {runId && chip(`Found by run ${runId}`, "runId", "Show what every run found")}
            </>
          }
          emptyTitle="No open issues"
          emptyText={
            last
              ? "MT5 and the CRM agree on everything the runs checked."
              : "No run has checked MT5 yet. The nightly run starts at the hour set on the server, or a staff member who reconciles can press Run now."
          }
        />
      ) : (
        <DataGrid
          columns={runColumns}
          rows={runList.data?.items}
          total={runList.data?.total ?? 0}
          pages={runList.data?.pages ?? 1}
          state={runs}
          onChange={setRuns}
          rowKey={(r) => r.id}
          onRowClick={(r) => setOpenRun(openRun === r.id ? null : r.id)}
          expanded={(r) => (openRun === r.id ? <RunDetails r={r} onShowIssues={() => showRun(r.id)} /> : null)}
          loading={runList.isLoading}
          error={runList.error}
          filters={[
            { key: "kind", label: "Kind", options: [{ value: "nightly", label: "Nightly" }, { value: "manual", label: "Run now" }] },
            { key: "status", label: "Status", options: (Object.keys(RUN_STATUS) as ReconRun["status"][]).map((value) => ({ value, label: RUN_STATUS[value].label })) },
          ]}
          emptyTitle="No runs yet"
          emptyText="The nightly run starts at the hour set on the server (CRM_MT5_RECONCILE_HOUR_UTC, 02:00 UTC unless changed). Staff who reconcile can also press Run now."
        />
      )}
    </>
  );
}

/** Open issues by severity (each opens the list filtered to it), and when the last run ended. */
function SummaryTiles({ s, error, active, onSeverity }: { s: ReconSummary | undefined; error: unknown; active?: string; onSeverity: (s: ReconSeverity) => void }) {
  const tiles: { severity: ReconSeverity; label: string; foot: string; icon: ReactNode; tone: string }[] = [
    { severity: "critical", label: "Open critical issues", foot: "MT5 and the CRM disagree about money", icon: <ShieldAlert size={20} />, tone: "bad" },
    { severity: "warning", label: "Open warnings", foot: "Worth checking", icon: <AlertTriangle size={20} />, tone: "warn" },
    { severity: "info", label: "Open for information", foot: "Demo accounts, nothing urgent", icon: <Info size={20} />, tone: "info" },
  ];
  const last = s?.lastRun ?? null;
  return (
    <div className="tiles">
      {tiles.map((t) => {
        const n = s?.open[t.severity];
        return (
          <button key={t.severity} type="button" className="tile tile-button" aria-pressed={active === t.severity} onClick={() => onSeverity(t.severity)}>
            <span className={n === undefined ? "tile-icon" : n ? `tile-icon ${t.tone}` : "tile-icon good"}>{n === 0 ? <ShieldCheck size={20} /> : t.icon}</span>
            <div>
              <div className="tile-label">{t.label}</div>
              <div className="tile-value">{n === undefined ? "–" : n.toLocaleString()}</div>
              <div className="tile-foot">{error ? "Could not load" : n === undefined ? "Checking" : n ? t.foot : "None open"}</div>
            </div>
          </button>
        );
      })}
      <div className="tile">
        <span className={last?.status === "failed" ? "tile-icon bad" : "tile-icon info"}>
          <History size={20} />
        </span>
        <div>
          <div className="tile-label">Last run</div>
          <div className="tile-value">{last?.finishedAt ? ago(last.finishedAt) : s ? "None yet" : "–"}</div>
          <div className="tile-foot">
            {last ? `${last.kind === "nightly" ? "Nightly" : "Run now"} · ${RUN_STATUS[last.status]?.label ?? last.status}${last.status === "done" && last.issuesFound !== null ? ` · ${issuesText(last.issuesFound)} found` : ""}` : s ? "No run has finished" : ""}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A run's full record, under its row. */
function RunDetails({ r, onShowIssues }: { r: ReconRun; onShowIssues: () => void }) {
  return (
    <div className="run-details">
      <dl className="details details-tight">
        <dt>Run</dt>
        <dd>{runKind(r)}</dd>
        <dt>Started</dt>
        <dd>{formatDate(r.startedAt)}</dd>
        <dt>{r.finishedAt ? "Ended" : "Last progress"}</dt>
        <dd>
          {formatDate(r.finishedAt ?? r.heartbeatAt)}
          <small className="muted block">{r.finishedAt ? `Took ${took(r)}` : `Running for ${took(r)}`}</small>
        </dd>
        <dt>Accounts</dt>
        <dd>
          {r.accountsTotal === null ? (
            <>
              –<small className="muted block">The counts are across every client, so only staff who see every client get them.</small>
            </>
          ) : (
            `${count(r.accountsChecked)} of ${r.accountsTotal.toLocaleString()} open accounts read from MT5`
          )}
        </dd>
        {r.status !== "running" && (
          <>
            <dt>Found</dt>
            <dd>{r.issuesFound === null ? "–" : `${issuesText(r.issuesFound)}: ${count(r.issuesNew)} new or back again, ${count(r.criticalFound)} critical`}</dd>
          </>
        )}
        {r.attempts > 1 && (
          <>
            <dt>Attempts</dt>
            <dd>{r.attempts}: the CRM stopped while it ran, and another process ran it again</dd>
          </>
        )}
        {r.error && (
          <>
            <dt>Why it failed</dt>
            <dd>{r.error}</dd>
          </>
        )}
        {r.notes && (
          <>
            <dt>Not checked</dt>
            <dd className="pre-wrap">{r.notes}</dd>
          </>
        )}
      </dl>
      {r.status !== "running" && (
        <button type="button" className="button button-small" onClick={onShowIssues}>
          <ShieldAlert size={14} /> Show the issues it found
        </button>
      )}
    </div>
  );
}

// ---------------- One issue ----------------

export function ReconIssueDetail({ id }: { id: string }) {
  const client = useQueryClient();
  const [resolving, setResolving] = useState(false);
  const key = [...RECON_KEY, "issue", id];
  const page = useQuery({
    queryKey: key,
    queryFn: () => api.get<{ issue: ReconIssue }>(`${BASE}/issues/${id}`),
    retry: (count, e) => !(e instanceof ApiError && e.status < 500) && count < 1,
  });

  if (page.error) {
    return (
      <>
        <Link href="/reconciliation" className="back-link">
          <ArrowLeft size={15} /> Reconciliation
        </Link>
        <DecisionError error={page.error} />
      </>
    );
  }
  const i = page.data?.issue;
  if (!i)
    return (
      <div className="center-screen loading-block">
        <Spinner size={22} />
      </div>
    );
  const meaning = meaningText(i);
  const login = i.login ?? (i.details as AccountFacts).login ?? null;

  return (
    <>
      <Link href="/reconciliation" className="back-link">
        <ArrowLeft size={15} /> Reconciliation
      </Link>
      <PageHeader
        title={KIND_LABEL[i.kind] ?? i.kind}
        badge={
          <>
            <SeverityBadge severity={i.severity} /> <IssueStatusBadge i={i} />
          </>
        }
        description={`Issue ${i.id}${i.clientName ? ` · ${i.clientName}` : ""}${login ? ` · MT5 ${login}` : ""}`}
      />
      <div className={i.status === "open" && i.severity !== "info" ? "notice notice-warn" : "notice notice-page"}>
        {i.status === "resolved" ? <CheckCircle2 size={18} /> : i.severity === "critical" ? <ShieldAlert size={18} /> : i.severity === "warning" ? <AlertTriangle size={18} /> : <Info size={18} />}
        <p>
          {/* The ledger check's own words are long, and shown in full under What the run found. */}
          {i.kind === "ledger_problem" ? meaning : `${summaryText(i)}${meaning ? ` ${meaning}` : ""}`}
          {i.status === "resolved" && (i.resolvedAutomatically ? " A later run no longer found it." : ` Resolved by ${i.resolvedBy?.name ?? "staff"}${i.resolvedAt ? ` on ${formatDate(i.resolvedAt)}` : ""}.`)}
        </p>
      </div>
      <div className="columns columns-wide">
        <FactsPanel i={i} />
        <TodoPanel i={i} onResolve={() => setResolving(true)} />
        <SubjectPanel i={i} />
        <HistoryPanel i={i} />
      </div>
      {resolving && (
        <ResolveDialog
          i={i}
          onClose={() => setResolving(false)}
          onChanged={() => void client.invalidateQueries({ queryKey: RECON_KEY })}
          onDone={(issue) => {
            client.setQueryData(key, { issue });
            void client.invalidateQueries({ queryKey: RECON_KEY });
          }}
        />
      )}
    </>
  );
}

function OpDetails({ d }: { d: OpFacts }) {
  const exp = d.expected ?? {};
  return (
    <dl className="details">
      <dt>Reference</dt>
      <dd>{d.reference ? <CopyText value={d.reference} label="reference" /> : "–"}</dd>
      <dt>Operation</dt>
      <dd>{purposeText(d.purpose)}</dd>
      <dt>Status when found</dt>
      <dd>{d.status ? <OpStatusBadge status={d.status} /> : "–"}</dd>
      <dt>Amount</dt>
      <dd>{money(d.amountCents)}</dd>
      <dt>MT5 ticket saved</dt>
      <dd>{d.ticket ? <span className="mono">{d.ticket}</span> : <span className="muted">None</span>}</dd>
      <dt>Its deal should be</dt>
      <dd>
        {signed(exp.amountCents)} {act(exp.action)}
        <small className="muted block">On {where(exp)}, with the reference as its comment</small>
      </dd>
      {d.completedAt && (
        <>
          <dt>Completed</dt>
          <dd>{formatDate(d.completedAt)}</dd>
        </>
      )}
      {d.since && (
        <>
          <dt>{d.status === "awaiting_approval" ? "Waiting since" : "Sent to MT5"}</dt>
          <dd>{formatDate(d.since)}</dd>
        </>
      )}
      {d.failure && (
        <>
          <dt>{d.status === "failed" ? "Failure reason" : "Last result"}</dt>
          <dd>
            {failureText(d.failure)} <span className="muted mono">({d.failure})</span>
          </dd>
        </>
      )}
      {d.mt5HasDeal !== undefined && d.status !== "awaiting_approval" && (
        <>
          <dt>Its deal in MT5</dt>
          <dd>{d.mt5HasDeal ? "Found" : "Not found yet"}</dd>
        </>
      )}
    </dl>
  );
}

function DealDetails({ d }: { d: DealFacts }) {
  return (
    <dl className="details">
      <dt>MT5 ticket</dt>
      <dd className="mono">{d.ticket ?? "–"}</dd>
      <dt>Account</dt>
      <dd>{where(d)}</dd>
      <dt>Kind of deal</dt>
      <dd>
        {cap(act(d.action))}
        {d.action !== undefined && <span className="muted"> (action {d.action})</span>}
      </dd>
      <dt>Amount</dt>
      <dd>{signed(d.amountCents)}</dd>
      <dt>Comment</dt>
      <dd>{d.comment ? <span className="mono">{d.comment}</span> : <span className="muted">None</span>}</dd>
      <dt>Time</dt>
      <dd>{formatDate(d.time ?? null)}</dd>
    </dl>
  );
}

const MISMATCH_REASON: Record<string, string> = {
  amount: "Another amount",
  sign: "The other direction",
  action: "Another kind of deal",
  account: "Another account",
  duplicate: "A second deal for one operation",
  ticket: "Another ticket from the one MT5 answered",
  comment: "Another comment on the ticket MT5 answered",
};

/** The facts the run recorded, field by field, with the record itself folded away under them. */
function FactsPanel({ i }: { i: ReconIssue }) {
  let body: ReactNode;
  if (i.kind === "op_without_deal" || i.kind === "unsettled_op") {
    body = (
      <>
        <h3>Operation in the CRM</h3>
        <OpDetails d={i.details as OpFacts} />
      </>
    );
  } else if (i.kind === "deal_mismatch" || i.kind === "failed_op_has_deal") {
    const d = i.details as OpFacts;
    const deals = i.kind === "deal_mismatch" ? (d.deal ? [d.deal] : []) : (d.deals ?? []);
    body = (
      <>
        <h3>Operation in the CRM</h3>
        <OpDetails d={d} />
        {deals.map((deal, n) => (
          <div key={deal.ticket ?? n}>
            <h3>{deals.length > 1 ? `Deal ${n + 1} of ${deals.length} in MT5` : "Deal in MT5"}</h3>
            <DealDetails d={deal} />
          </div>
        ))}
        {i.kind === "deal_mismatch" && d.reason && (
          <dl className="details">
            <dt>Does not match by</dt>
            <dd>{MISMATCH_REASON[d.reason] ?? d.reason}</dd>
          </dl>
        )}
      </>
    );
  } else if (i.kind === "unknown_bis_deal" || i.kind === "external_balance_deal") {
    body = (
      <>
        <h3>Deal in MT5</h3>
        <DealDetails d={i.details as DealFacts} />
      </>
    );
  } else if (i.kind === "account_missing" || i.kind === "unlinked_mt5_account") {
    const d = i.details as AccountFacts;
    body = (
      <dl className="details">
        <dt>MT5 login</dt>
        <dd className="mono">{d.login ?? "–"}</dd>
        <dt>Server</dt>
        <dd className="mono">{d.server ?? "–"}</dd>
        {d.group && (
          <>
            <dt>MT5 group</dt>
            <dd className="mono">{d.group}</dd>
          </>
        )}
        <dt>Type</dt>
        <dd>{d.demo ? "Demo" : "Live"}</dd>
        {d.reason && (
          <>
            <dt>MT5 answered</dt>
            <dd>
              {failureText(d.reason)} <span className="muted mono">({d.reason})</span>
            </dd>
          </>
        )}
      </dl>
    );
  } else if (i.kind === "funding_mismatch") {
    const d = i.details as FundingFacts;
    body = (
      <dl className="details">
        <dt>Ledger line</dt>
        <dd className="mono">{d.fundingAccount ?? "–"}</dd>
        <dt>In the ledger</dt>
        <dd>{money(d.ledgerCents)}</dd>
        <dt>From its operations</dt>
        <dd>
          {money(d.operationsCents)}
          <small className="muted block">Completed transfers and staff balance changes</small>
        </dd>
        <dt>Difference</dt>
        <dd>{signed((d.ledgerCents ?? 0) - (d.operationsCents ?? 0))}</dd>
      </dl>
    );
  } else {
    body = <p className="pre-wrap">{summaryText(i)}</p>;
  }
  return (
    <section className="panel">
      <div className="card-head">
        <h2 className="flush">What the run found</h2>
      </div>
      {body}
      <details className="raw-details">
        <summary>The record as the run saved it</summary>
        <pre>{JSON.stringify(i.details, null, 2)}</pre>
      </details>
    </section>
  );
}

function TodoPanel({ i, onResolve }: { i: ReconIssue; onResolve: () => void }) {
  const can = useCan();
  const op = i.details as OpFacts;
  const reference = i.reference ?? op.reference;
  return (
    <section className="panel">
      <div className="card-head">
        <h2 className="flush">{i.status === "open" ? "What to do" : "Resolved"}</h2>
      </div>
      {i.status === "open" ? (
        <>
          <p>{todoText(i)}</p>
          <p className="muted">{selfText(i)}</p>
        </>
      ) : (
        <>
          <p>
            {i.resolvedAutomatically ? "A run found it no longer true" : `${i.resolvedBy?.name ?? "A staff member"} resolved it`}
            {i.resolvedAt ? ` on ${formatDate(i.resolvedAt)}` : ""}.
          </p>
          {i.resolvedNote && (
            <p className="pre-wrap">
              <span className="muted">Note: </span>
              {i.resolvedNote}
            </p>
          )}
          <p className="muted">{afterText(i)}</p>
        </>
      )}
      <div className="stack">
        {i.opId !== null && can("wallet.view") && (
          <Link href={`/transfers/${i.opId}`}>
            {i.kind === "unsettled_op" && op.status === "awaiting_approval" ? "Approve or reject it on the Transfers page" : `Open the operation ${reference ?? ""}`}
          </Link>
        )}
        {i.accountId !== null && can("mt5.view") && <Link href={`/mt5/${i.accountId}`}>Open MT5 {i.login ?? "account"} and its trades</Link>}
        {i.status === "open" &&
          (i.canResolve ? (
            <button type="button" className="button button-primary" onClick={onResolve}>
              <CheckCircle2 size={16} /> Resolve with a note
            </button>
          ) : (
            <small className="muted">Resolving needs the permission to run and review reconciliation.</small>
          ))}
      </div>
    </section>
  );
}

function SubjectPanel({ i }: { i: ReconIssue }) {
  const can = useCan();
  const d = i.details as AccountFacts & FundingFacts;
  const login = i.login ?? d.login ?? null;
  const server = i.serverCode ?? d.server ?? null;
  const demo = i.isDemo ?? d.demo ?? null;
  return (
    <section className="panel">
      <div className="card-head">
        <h2 className="flush">Client and account</h2>
      </div>
      <dl className="details">
        <dt>Client</dt>
        <dd>
          {i.clientId === null ? (
            <span className="muted">{i.kind === "ledger_problem" ? "Not about one client: the whole ledger" : "No client in the CRM"}</span>
          ) : can("client.view") ? (
            <Link href={`/clients/${i.clientId}`}>{i.clientName ?? `Client ${i.clientId}`}</Link>
          ) : (
            (i.clientName ?? `Client ${i.clientId}`)
          )}
        </dd>
        {i.clientId !== null && (
          <>
            <dt>Client ID</dt>
            <dd className="mono">{i.clientId}</dd>
          </>
        )}
        <dt>MT5 account</dt>
        <dd>
          {login === null ? (
            <span className="muted">None</span>
          ) : i.accountId !== null && can("mt5.view") ? (
            <Link href={`/mt5/${i.accountId}`}>{login}</Link>
          ) : (
            <span className="mono">{login}</span>
          )}
          {login !== null && (
            <small className="muted block">
              {server ? `Server ${server}` : ""}
              {demo === true ? " · Demo" : demo === false ? " · Live" : ""}
              {i.accountId === null ? (i.kind === "unlinked_mt5_account" ? " · no CRM account when found" : " · not in the CRM") : ""}
            </small>
          )}
        </dd>
      </dl>
      <div className="stack">
        {i.clientId !== null && <Link href={`/reconciliation?client=${i.clientId}&status=all`}>Every issue about this client</Link>}
        {i.accountId !== null && <Link href={`/reconciliation?account=${i.accountId}&status=all`}>Every issue on MT5 {login ?? "this account"}</Link>}
      </div>
    </section>
  );
}

function HistoryPanel({ i }: { i: ReconIssue }) {
  return (
    <section className="panel">
      <div className="card-head">
        <h2 className="flush">History</h2>
      </div>
      <dl className="details">
        <dt>First found</dt>
        <dd>
          {formatDate(i.createdAt)}
          <small className="muted block">
            By <Link href={`/reconciliation?run=${i.firstRunId}&status=all`}>run {i.firstRunId}</Link>
          </small>
        </dd>
        <dt>Last found</dt>
        <dd>
          <Link href={`/reconciliation?run=${i.lastRunId}&status=all`}>Run {i.lastRunId}</Link>
        </dd>
        <dt>Came back</dt>
        <dd>{i.reopened ? `${i.reopened === 1 ? "Once" : `${i.reopened} times`} after it was resolved` : <span className="muted">Never</span>}</dd>
        {i.status === "resolved" && (
          <>
            <dt>Resolved</dt>
            <dd>
              {i.resolvedAutomatically ? "By a run" : (i.resolvedBy?.name ?? "Staff")}
              {i.resolvedAt && <small className="muted block">{formatDate(i.resolvedAt)}</small>}
            </dd>
          </>
        )}
        <dt>Issue key</dt>
        <dd className="mono">{i.key}</dd>
      </dl>
    </section>
  );
}

function ResolveDialog({ i, onClose, onChanged, onDone }: { i: ReconIssue; onClose: () => void; onChanged: () => void; onDone: (issue: ReconIssue) => void }) {
  const { toast } = useFeedback();
  const [note, setNote] = useState("");
  const [tried, setTried] = useState(false);
  const problem = note.trim().length < 10 ? "Write what you found and did (at least 10 characters)." : textProblem(note, "note", 10, 500);
  const save = useMutation({
    mutationFn: () => api.post<{ issue: ReconIssue }>(`${BASE}/issues/${i.id}/resolve`, { note: note.trim() }),
    onSuccess: (res) => {
      toast(`Issue ${i.id} is resolved.`);
      onDone(res.issue);
      onClose();
    },
    // Resolved meanwhile (by a colleague or a run): show it as it is now.
    onError: (e) => e instanceof ApiError && e.status === 409 && onChanged(),
  });
  return (
    <Dialog open title={`Resolve issue ${i.id}?`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (!problem) save.mutate();
        }}
      >
        <p>{summaryText(i)}</p>
        <p className="muted">
          Resolving takes it off the open list, with your note, and records it in the audit log. It changes nothing in MT5 or in the ledger. {reopenText(i.kind)}
        </p>
        <Field label="Note" hint={tried && problem ? <span className="error-text">{problem}</span> : "What you found and what was done, for colleagues and the audit log."}>
          <textarea className="input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} autoFocus />
        </Field>
        <DecisionError error={save.error} />
        <div className="actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={save.isPending || (tried && Boolean(problem))}>
            {save.isPending ? <Spinner /> : <CheckCircle2 size={16} />} Resolve
          </button>
        </div>
        <p className="muted tight">You'll be asked for your 2FA code.</p>
      </form>
    </Dialog>
  );
}
