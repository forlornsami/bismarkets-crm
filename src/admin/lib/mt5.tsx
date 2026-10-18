import { useQuery } from "@tanstack/react-query";
import { Unplug } from "lucide-react";
import { money } from "../components/money";
import { Badge, type Tone } from "../components/ui";
import { api, formatDate } from "./api";

// What the staff MT5 and packages APIs send, and the labels the MT5 pages
// share with the client page. Amounts are integer US cents.

export type Mt5State = "active" | "archived" | "suspended" | "creating" | "unknown" | "failed";
export type OpPurpose = "wallet_to_mt5" | "mt5_to_wallet" | "demo_funding" | "demo_topup";
export type OpStatus = "sending" | "unknown" | "completed" | "failed";

interface Person {
  id: number;
  name: string;
}

export interface Mt5AccountItem {
  id: number;
  clientId: number;
  clientName: string;
  clientEmail: string;
  clientStatus: "active" | "frozen" | "closed";
  login: number | null;
  serverCode: string;
  serverLabel: string;
  isDemo: boolean;
  type: "real" | "demo";
  packageId: number | null;
  packageName: string;
  group: string;
  currency: string;
  leverage: number;
  /** The row as stored: creating, active, unknown or failed. */
  status: "creating" | "active" | "unknown" | "failed";
  /** What staff read: an active row is also archived (by the client) or suspended (by staff). */
  state: Mt5State;
  createRef: string;
  failure: string | null;
  checks: number;
  nextCheckAt: string | null;
  archivedAt: string | null;
  suspendedAt: string | null;
  suspendedBy: Person | null;
  suspendedReason: string | null;
  balanceCents: number | null;
  creditCents: number | null;
  equityCents: number | null;
  marginCents: number | null;
  marginFreeCents: number | null;
  snapshotAt: string | null;
  registeredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Mt5Op {
  id: number;
  reference: string;
  purpose: OpPurpose;
  amountCents: number;
  status: OpStatus;
  ticket: number | null;
  failure: string | null;
  clientMessage: string | null;
  checks: number;
  nextCheckAt: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** What MT5 said when the account was opened on the staff page (null when it is not open in MT5). */
export interface Mt5Live {
  user: {
    login: number;
    group: string;
    name: string;
    email: string;
    leverage: number;
    enabled: boolean;
    tradeDisabled: boolean;
    registeredAt: string | null;
  } | null;
  figures: { balanceCents: number; creditCents: number; equityCents: number; marginCents: number; marginFreeCents: number; profitCents: number } | null;
  error: string | null;
}

export interface Mt5AccountPage {
  account: Mt5AccountItem;
  live: Mt5Live | null;
  operations: Mt5Op[];
}

export interface Mt5Server {
  code: string;
  label: string;
  isEnabled: boolean;
  isDemoServer: boolean;
  usage: { packages: number; accounts: number };
  createdAt: string;
  updatedAt: string;
  updatedBy: Person | null;
}

export interface Mt5Settings {
  demoServerCode: string | null;
  demoGroup: string | null;
  leverages: number[];
  maxLiveAccounts: number;
  maxDemoAccounts: number;
  demoMaxOpeningCents: number;
  demoMaxTopupCents: number;
  demoMaxBalanceCents: number;
  maxTransferCents: number;
  gatewayConfigured: boolean;
  updatedAt: string;
  updatedBy: Person | null;
}

export interface AccountPackage {
  id: number;
  name: string;
  description: string;
  highlights: string[];
  spreadLabel: string;
  commissionLabel: string | null;
  minDepositCents: number;
  serverCode: string;
  mt5Group: string;
  isRecommended: boolean;
  isVisible: boolean;
  sortOrder: number;
  serverLabel: string;
  /** Accounts open in MT5 with this package. */
  accounts: number;
  createdAt: string;
  updatedAt: string;
  updatedBy: Person | null;
}

// ---------- Queries ----------

export const SERVERS_KEY = ["mt5-servers"];
export const SETTINGS_KEY = ["mt5-settings"];
export const PACKAGES_KEY = ["account-packages"];
/** Every account list (the MT5 accounts page and each client's section) starts with this key. */
export const ACCOUNTS_KEY = ["mt5-accounts"];
export const accountKey = (id: number | string) => ["mt5-account", String(id)];

export const useMt5Servers = (enabled = true) =>
  useQuery({ queryKey: SERVERS_KEY, queryFn: () => api.get<{ items: Mt5Server[]; gatewayConfigured: boolean }>("/api/staff/mt5/servers"), enabled, staleTime: 60_000 });

export const useMt5Settings = (enabled = true) => useQuery({ queryKey: SETTINGS_KEY, queryFn: () => api.get<Mt5Settings>("/api/staff/mt5/settings"), enabled, staleTime: 60_000 });

export const usePackages = (enabled = true) => useQuery({ queryKey: PACKAGES_KEY, queryFn: () => api.get<{ items: AccountPackage[] }>("/api/staff/packages"), enabled });

// ---------- Labels ----------

export const STATE_LABEL: Record<Mt5State, string> = {
  active: "Active",
  archived: "Archived by the client",
  suspended: "Suspended",
  creating: "Being opened",
  unknown: "Not confirmed",
  failed: "Not opened",
};
const STATE_TONE: Record<Mt5State, Tone> = { active: "good", archived: "neutral", suspended: "bad", creating: "info", unknown: "warn", failed: "neutral" };

export const Mt5StateBadge = ({ state }: { state: Mt5State }) => <Badge tone={STATE_TONE[state] ?? "neutral"}>{STATE_LABEL[state] ?? state}</Badge>;

/** True once the account exists in MT5 (it may still be archived or suspended). */
export const isOpen = (a: Pick<Mt5AccountItem, "status" | "login">) => a.status === "active" && a.login !== null;

/** The last figures read from MT5, for a list row. */
export function BalanceCell({ a }: { a: Mt5AccountItem }) {
  if (!isOpen(a)) return <span className="muted">–</span>;
  if (a.balanceCents === null) return <span className="muted">Not read yet</span>;
  return (
    <span className="stack-tight" title={a.snapshotAt ? `Read from MT5 ${formatDate(a.snapshotAt)}` : undefined}>
      <strong>{money(a.balanceCents, a.currency)}</strong>
      {a.equityCents !== null && a.equityCents !== a.balanceCents && <small className="muted">Equity {money(a.equityCents, a.currency)}</small>}
    </span>
  );
}

/** 2000 → "1:2000". */
export const leverageText = (n: number | null | undefined) => (n ? `1:${n}` : "–");

export const typeLabel = (a: { isDemo: boolean }) => (a.isDemo ? "Demo" : "Live");

export const PURPOSE_LABEL: Record<OpPurpose, string> = {
  wallet_to_mt5: "Wallet to MT5",
  mt5_to_wallet: "MT5 to wallet",
  demo_funding: "Demo starting balance",
  demo_topup: "Demo top-up",
};

/** The amount as it moves the MT5 balance: only MT5 to wallet takes money out. */
export const opSignedCents = (op: Pick<Mt5Op, "purpose" | "amountCents">) => (op.purpose === "mt5_to_wallet" ? -op.amountCents : op.amountCents);

const OP_STATUS: Record<OpStatus, { label: string; tone: Tone }> = {
  sending: { label: "Sending", tone: "info" },
  unknown: { label: "Not confirmed", tone: "warn" },
  completed: { label: "Completed", tone: "good" },
  failed: { label: "Failed", tone: "bad" },
};
export const OpStatusBadge = ({ status }: { status: OpStatus }) => <Badge tone={OP_STATUS[status]?.tone ?? "neutral"}>{OP_STATUS[status]?.label ?? status}</Badge>;

/** Why an account or operation failed or is stuck, as staff read it; unknown codes show as they are. */
const FAILURE_LABEL: Record<string, string> = {
  not_found: "MT5 has no record of it",
  login_taken: "The login MT5 found is already linked to another CRM account",
  not_recorded: "MT5 opened it, but the CRM could not save the login",
  mismatch: "MT5 has a deal with this reference that does not match",
  unavailable: "MT5 could not be reached",
  bad_request: "The gateway refused the request",
  unknown: "MT5 did not answer",
  no_money: "Not enough money or free margin",
  invalid_password: "MT5 did not accept the password",
  trade_disabled: "Trading is switched off for this account",
  login_exists: "The login already exists in MT5",
  limit_reached: "An MT5 limit was reached",
  too_frequent: "Too many requests to MT5",
  group_not_allowed: "The gateway does not allow this MT5 group",
  over_limit: "Over the gateway's money limit",
  policy: "Against a gateway rule",
  mt5_error: "MT5 returned an error",
  auth: "The gateway could not sign in to MT5",
  connection: "No connection to MT5",
  timeout: "MT5 did not answer in time",
  bad_signature: "The gateway did not trust the request",
};
export const failureText = (code: string | null | undefined) => (code ? (FAILURE_LABEL[code] ?? code) : "");

// ---------- Balance operations (the Transfers page) ----------

/** A balance operation as the staff operations API sends it, with its client and account. */
export interface Mt5Operation extends Mt5Op {
  clientId: number;
  clientName: string;
  clientEmail: string;
  accountId: number;
  login: number;
  serverCode: string;
  isDemo: boolean;
  /** Active, archived or suspended; the account's own status when it is not open in MT5. */
  accountState: Mt5State;
  /** What MT5 is asked to add to the account: negative takes money out. */
  signedCents: number;
  resolvedBy: Person | null;
  /** The note of the staff member who marked it failed (internal). */
  resolvedNote: string | null;
  updatedAt: string;
  /** Open, and not a request still being sent: Check now may run. */
  canCheck: boolean;
  /** Open and at least ten minutes old: Mark failed may run. */
  canFail: boolean;
}

/** A ledger transaction an operation made, with its balanced entries. */
export interface OpLedgerTransaction {
  id: number;
  kind: string;
  createdAt: string;
  entries: { account: string; amountCents: number }[];
}

export interface Mt5OperationPage {
  operation: Mt5Operation;
  ledger: OpLedgerTransaction[];
}

/** Every operations list (and the open count) starts with this key. */
export const OPERATIONS_KEY = ["mt5-operations"];
export const operationKey = (id: number | string) => ["mt5-operation", String(id)];

/** Shown while the CRM has no gateway address: lists still work, changes in MT5 do not. */
export function GatewayOffNotice() {
  return (
    <div className="notice notice-warn">
      <Unplug size={18} />
      <p>MT5 is not connected: CRM_MT5_GATEWAY_URL is not set on this server. Lists show what the CRM saved, and nothing can be changed in MT5 until the gateway is connected.</p>
    </div>
  );
}
