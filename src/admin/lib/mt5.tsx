import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Unplug, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { money, signedMoney, textProblem } from "../components/money";
import { DecisionError } from "../components/ReviewWorkbench";
import { Badge, Dialog, Field, reviewTone, Spinner, useFeedback, type Tone } from "../components/ui";
import { ApiError, api, formatDate, type Page } from "./api";
import { useSession } from "./session";

// What the staff MT5 and packages APIs send, and the labels the MT5 pages
// share with the client page. Amounts are integer US cents.

export type Mt5State = "active" | "archived" | "suspended" | "creating" | "unknown" | "failed";
/** Staff balance and credit changes, asked for by one person and approved by another. */
export type StaffPurpose = "staff_balance_in" | "staff_balance_out" | "staff_credit_in" | "staff_credit_out";
export type OpPurpose = "wallet_to_mt5" | "mt5_to_wallet" | "demo_funding" | "demo_topup" | StaffPurpose;
/** awaiting_approval and cancelled are only for staff changes: waiting for a second person, or rejected before MT5 was asked. */
export type OpStatus = "awaiting_approval" | "sending" | "unknown" | "completed" | "failed" | "cancelled";
export type ReasonCode = "compensation" | "correction" | "bonus" | "chargeback" | "fee_refund" | "other";

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
  /** Staff balance and credit changes at or under this run on one person's word; 0 means every change needs a second person. */
  adjustSecondApprovalCents: number;
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

/**
 * One closed trade, from the CRM's copy of the account's MT5 deals: a fully
 * closed position, or one part of a netting position between reversals.
 * Prices are MT5's decimal text.
 */
export interface Mt5Trade {
  /** Unique within the account: the position, or "<position>-r<ticket>" for a part a reversal opened. */
  id: string;
  positionId: number;
  /** The reversal deal that opened this part of the position; null for the part it opened with. */
  reversalTicket: number | null;
  symbol: string;
  side: "buy" | "sell";
  lots: number;
  openPrice: string;
  closePrice: string;
  openedAt: string;
  closedAt: string;
  profitCents: number;
  commissionCents: number;
  swapCents: number;
  feeCents: number;
  /** Profit with commission, swap and fees. */
  netCents: number;
}

/** How far the CRM's copy of the account's deals reaches. */
export interface DealSync {
  /** Every deal up to this time is in the CRM. */
  syncedUntil: string | null;
  /** When the last sync ended, whether it worked or not. */
  syncedAt: string | null;
  /** Why the last sync failed, in MT5's or the gateway's words (staff only). */
  error: string | null;
  /** The last sync stopped before the present (a long history is read over several runs). */
  partial: boolean;
  running: boolean;
}

export interface Mt5TradePage extends Page<Mt5Trade> {
  /** Over every closed trade of the account, not only this page. */
  totals: { trades: number; lots: number; profitCents: number; commissionCents: number; swapCents: number; feeCents: number; netCents: number };
  sync: DealSync;
}

export interface DealSyncAnswer {
  result: { outcome: "complete" | "partial" | "failed" | "skipped"; pages: number; deals: number; newDeals: number; trades: number; error: { kind: string; code: string; message: string } | null };
  sync: DealSync;
}

// ---------- Queries ----------

export const SERVERS_KEY = ["mt5-servers"];
export const SETTINGS_KEY = ["mt5-settings"];
export const PACKAGES_KEY = ["account-packages"];
/** Every account list (the MT5 accounts page and each client's section) starts with this key. */
export const ACCOUNTS_KEY = ["mt5-accounts"];
export const accountKey = (id: number | string) => ["mt5-account", String(id)];
/** One account's closed trades, every page. */
export const tradesKey = (id: number | string) => ["mt5-trades", String(id)];

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
  staff_balance_in: "Balance added by staff",
  staff_balance_out: "Balance taken by staff",
  staff_credit_in: "Credit added by staff",
  staff_credit_out: "Credit taken by staff",
};

export const STAFF_PURPOSES: readonly StaffPurpose[] = ["staff_balance_in", "staff_balance_out", "staff_credit_in", "staff_credit_out"];
export const isStaffPurpose = (purpose: string): purpose is StaffPurpose => (STAFF_PURPOSES as readonly string[]).includes(purpose);

export const REASON_LABEL: Record<ReasonCode, string> = {
  compensation: "Compensation",
  correction: "Correction",
  bonus: "Bonus",
  chargeback: "Chargeback",
  fee_refund: "Fee refund",
  other: "Other",
};

const TAKES_OUT: readonly OpPurpose[] = ["mt5_to_wallet", "staff_balance_out", "staff_credit_out"];
/** The amount as it moves the MT5 balance (or, for a credit change, the credit): negative takes it out. */
export const opSignedCents = (op: Pick<Mt5Op, "purpose" | "amountCents">) => (TAKES_OUT.includes(op.purpose) ? -op.amountCents : op.amountCents);

// The review colour rule: waiting for a second person and still being sent are later steps (blue).
const OP_STATUS: Record<OpStatus, { label: string; tone: Tone }> = {
  awaiting_approval: { label: "Awaiting approval", tone: reviewTone("later") },
  sending: { label: "Sending", tone: reviewTone("later") },
  // Not a review step: MT5 has not confirmed it, so someone has to check it by hand.
  unknown: { label: "Not confirmed", tone: "warn" },
  completed: { label: "Completed", tone: reviewTone("done") },
  failed: { label: "Failed", tone: reviewTone("refused") },
  cancelled: { label: "Cancelled", tone: reviewTone("closed") },
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
  /** Open and let go to MT5 at least ten minutes ago: Mark failed may run. */
  canFail: boolean;
  /** Only on staff balance and credit changes. */
  change?: StaffChange;
}

/** Who asked for a staff change and why, who decided it, and what this staff member may do with it now. */
export interface StaffChange {
  deal: "balance" | "credit";
  /** The MT5 deal action: 2 balance, 3 credit. */
  dealAction: number;
  reasonCode: ReasonCode;
  /** The requester's note, for colleagues; the client never sees it. */
  note: string;
  requestedBy: Person | null;
  approvedBy: Person | null;
  approvedAt: string | null;
  /** The approver's or rejecter's note. */
  decidedNote: string | null;
  /** Ran on the requester's word alone (at or under the second-approval amount). */
  ranAtOnce: boolean;
  /** Waiting, and this staff member may approve it: never the person who asked for it. */
  canApprove: boolean;
  canReject: boolean;
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

/**
 * After an operation changed (a decision, a settle, or an answer saying it
 * changed meanwhile): the operation, the lists, the account and the client's
 * wallet and activity are read again.
 */
export function useOperationChanged() {
  const client = useQueryClient();
  // Without an id (a change MT5 refused as it was asked for), only the lists and the account.
  return (o: { id?: number; accountId: number; clientId: number }) => {
    if (o.id !== undefined) void client.invalidateQueries({ queryKey: operationKey(o.id) });
    void client.invalidateQueries({ queryKey: OPERATIONS_KEY });
    void client.invalidateQueries({ queryKey: accountKey(o.accountId) });
    void client.invalidateQueries({ queryKey: ACCOUNTS_KEY });
    void client.invalidateQueries({ queryKey: ["client-wallet", o.clientId] });
    void client.invalidateQueries({ queryKey: ["client-activity", String(o.clientId)] });
  };
}

// ---------- Staff balance and credit changes ----------

/** "+USD 100.00 to the balance", "−USD 20.00 of credit". */
export const changeAmountText = (o: Pick<Mt5Op, "purpose" | "amountCents">) =>
  `${signedMoney(opSignedCents(o))} ${o.purpose === "staff_credit_in" || o.purpose === "staff_credit_out" ? "credit" : "balance"}`;

/** What a staff change does, for the people deciding it. */
function ChangeSummary({ o }: { o: Mt5Operation }) {
  const c = o.change!;
  return (
    <dl className="details details-tight">
      <dt>Change</dt>
      <dd>
        <strong>{changeAmountText(o)}</strong>
        <small className="muted block">{PURPOSE_LABEL[o.purpose] ?? o.purpose}</small>
      </dd>
      <dt>Account</dt>
      <dd>
        MT5 <span className="mono">{o.login}</span> · {o.clientName}
      </dd>
      <dt>Reason</dt>
      <dd>{REASON_LABEL[c.reasonCode] ?? c.reasonCode}</dd>
      <dt>Note</dt>
      <dd className="pre-wrap">{c.note}</dd>
      <dt>Asked for by</dt>
      <dd>
        {c.requestedBy?.name ?? "–"}
        <small className="muted block">{formatDate(o.createdAt)}</small>
      </dd>
    </dl>
  );
}

const SAME_PERSON = "You asked for this change, so another person must approve it.";
/** Taking money or credit out is checked again against MT5's figures when it is approved. */
const takesOut = (o: Pick<Mt5Op, "purpose">) => o.purpose === "staff_balance_out" || o.purpose === "staff_credit_out";

/**
 * A decision's error, shown again as a toast when its dialog goes before the
 * person closed it. An answer saying the change no longer waits (MT5 refused
 * it once approved, or someone else decided it first) has the lists read
 * again, and the row holding the dialog then leaves the list (Transfers, the
 * account's changes waiting for approval) or stops offering the decision,
 * taking the dialog and its error with it. `keep` is for onError; `drop` for
 * closing the dialog and for a new try, once the person has seen it.
 */
function useKeptError(reference: string) {
  const { toast } = useFeedback();
  const kept = useRef({ open: false, message: "" });
  useEffect(() => {
    const k = kept.current;
    k.open = true;
    return () => {
      k.open = false;
      if (k.message) toast(`${reference}: ${k.message}`, "bad");
      k.message = "";
    };
  }, [reference, toast]);
  return {
    keep: (e: Error) => {
      // Gone already (its row left the list while the answer was on its way): straight to a toast.
      if (kept.current.open) kept.current.message = e.message;
      else toast(`${reference}: ${e.message}`, "bad");
    },
    drop: () => {
      kept.current.message = "";
    },
  };
}

/**
 * Approve and Reject for a staff change waiting for a second person, as the
 * server allows them to this staff member: the person who asked for a change
 * never approves it (they may cancel it). Approving asks for a 2FA code and
 * sends the change to MT5 at once; rejecting needs a note. Clicks and keys
 * stay here, so a list row around it does not open.
 */
export function ChangeDecision({ o, blocked, small, onDone }: { o: Mt5Operation; blocked?: string | null; small?: boolean; onDone?: (res: Mt5OperationPage) => void }) {
  const { staff } = useSession();
  const [open, setOpen] = useState<"approve" | "reject" | null>(null);
  const c = o.change;
  if (!c || o.status !== "awaiting_approval" || !(c.canApprove || c.canReject)) return null;
  const own = c.requestedBy?.id === staff.id;
  const size = small ? " button-small" : "";
  // Shown beside the buttons, not only as a tooltip: phones have none. In a list row it is shorter.
  const why = !c.canApprove ? (own ? (small ? "You asked for it, so another person approves it." : SAME_PERSON) : "You cannot approve this change.") : blocked;
  return (
    <span className="change-decision" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <span className="change-decision-buttons">
        <button type="button" className={`button button-primary${size}`} disabled={!c.canApprove || Boolean(blocked)} onClick={() => setOpen("approve")}>
          {!small && <Check size={15} />} Approve
        </button>
        {c.canReject && (
          <button type="button" className={`button button-danger${size}`} onClick={() => setOpen("reject")}>
            {!small && <X size={15} />} {own ? "Cancel it" : "Reject"}
          </button>
        )}
      </span>
      {why && <small className="muted">{why}</small>}
      {open === "approve" && <ApproveDialog o={o} onClose={() => setOpen(null)} onDone={onDone} />}
      {open === "reject" && <RejectDialog o={o} own={own} onClose={() => setOpen(null)} onDone={onDone} />}
    </span>
  );
}

function ApproveDialog({ o, onClose, onDone }: { o: Mt5Operation; onClose: () => void; onDone?: (res: Mt5OperationPage) => void }) {
  const { toast } = useFeedback();
  const changed = useOperationChanged();
  const error = useKeptError(o.reference);
  const close = () => {
    error.drop();
    onClose();
  };
  const [note, setNote] = useState("");
  const problem = note.trim() ? textProblem(note, "note", 1, 500) : null;
  const save = useMutation({
    mutationFn: () => api.post<Mt5OperationPage>(`/api/staff/mt5/operations/${o.id}/approve`, note.trim() ? { note: note.trim() } : {}),
    onMutate: error.drop,
    onSuccess: (res) => {
      const done = res.operation;
      toast(
        done.status === "completed"
          ? `${o.reference} is approved and MT5 made it${done.ticket !== null ? ` (ticket ${done.ticket})` : ""}.`
          : `${o.reference} is approved and sent. MT5 did not confirm it yet: the CRM searches MT5 for its deal and settles it.`,
      );
      changed(o);
      onDone?.(res);
      close();
    },
    // Decided by someone else meanwhile, over a limit now, or refused by MT5 (then it failed): show it as it is now.
    onError: (e) => {
      error.keep(e);
      if (e instanceof ApiError && e.status !== 403) changed(o);
    },
  });
  return (
    <Dialog open title={`Approve ${o.reference}?`} onClose={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!problem) save.mutate();
        }}
      >
        <p>Approving sends this change to MT5 straight away. It cannot be undone from here: a mistake needs a new change the other way.</p>
        <ChangeSummary o={o} />
        {takesOut(o) && (
          <p className="muted">
            {o.purpose === "staff_balance_out"
              ? "The CRM first checks MT5's figures again: at most what the account could withdraw now can be taken (its balance, less its credit and the margin its open trades use)."
              : "The CRM first checks MT5's figures again: at most the credit the account has now can be taken."}
          </p>
        )}
        <Field label="Note (optional)" hint={problem ? <span className="error-text">{problem}</span> : "Kept with the change and in the audit log. The client does not see it."}>
          <textarea className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </Field>
        <DecisionError error={save.error} />
        <div className="actions">
          <button type="button" className="button" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={save.isPending || Boolean(problem)} autoFocus>
            {save.isPending ? <Spinner /> : <Check size={16} />} Approve and send to MT5
          </button>
        </div>
        <p className="muted tight">You'll be asked for your 2FA code.</p>
      </form>
    </Dialog>
  );
}

function RejectDialog({ o, own, onClose, onDone }: { o: Mt5Operation; own: boolean; onClose: () => void; onDone?: (res: Mt5OperationPage) => void }) {
  const { toast } = useFeedback();
  const changed = useOperationChanged();
  const error = useKeptError(o.reference);
  const close = () => {
    error.drop();
    onClose();
  };
  const [note, setNote] = useState("");
  const [tried, setTried] = useState(false);
  const problem = note.trim().length < 10 ? "Write why (at least 10 characters)." : textProblem(note, "note", 10, 500);
  const save = useMutation({
    mutationFn: () => api.post<Mt5OperationPage>(`/api/staff/mt5/operations/${o.id}/reject`, { note: note.trim() }),
    onMutate: error.drop,
    onSuccess: (res) => {
      toast(own ? `${o.reference} is cancelled. Nothing was sent to MT5.` : `${o.reference} is rejected. Nothing was sent to MT5.`);
      changed(o);
      onDone?.(res);
      close();
    },
    // Decided by someone else meanwhile: show it as it is now.
    onError: (e) => {
      error.keep(e);
      if (e instanceof ApiError && e.status === 409) changed(o);
    },
  });
  return (
    <Dialog open title={own ? `Cancel ${o.reference}?` : `Reject ${o.reference}?`} onClose={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (!problem) save.mutate();
        }}
      >
        <p>
          {own
            ? "Your change is cancelled before anyone approves it. Nothing is sent to MT5."
            : `The change is not made in MT5 and cannot be approved later. ${o.change?.requestedBy?.name ?? "The person who asked"} can ask for it again if it is needed.`}
        </p>
        <ChangeSummary o={o} />
        <Field label="Note" hint={tried && problem ? <span className="error-text">{problem}</span> : "Why, for the person who asked and the audit log. The client does not see it."}>
          <textarea className="input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} autoFocus />
        </Field>
        <DecisionError error={save.error} />
        <div className="actions">
          <button type="button" className="button" onClick={close}>
            Keep it
          </button>
          <button type="submit" className="button button-danger-solid" disabled={save.isPending || (tried && Boolean(problem))}>
            {save.isPending ? <Spinner /> : <X size={16} />} {own ? "Cancel the change" : "Reject the change"}
          </button>
        </div>
        <p className="muted tight">You'll be asked for your 2FA code.</p>
      </form>
    </Dialog>
  );
}

// ---------- Reconciliation ----------

export type ReconSeverity = "critical" | "warning" | "info";
/** What a reconciliation run found, by the server's issue kinds (critical ones first, as the server lists them). */
export type ReconIssueKind =
  | "op_without_deal"
  | "deal_mismatch"
  | "failed_op_has_deal"
  | "unknown_bis_deal"
  | "ledger_problem"
  | "funding_mismatch"
  | "external_balance_deal"
  | "unsettled_op"
  | "account_missing"
  | "unlinked_mt5_account";

/** One reconciliation run: nightly, or started by staff with Run now. */
export interface ReconRun {
  id: number;
  kind: "nightly" | "manual";
  /** The UTC day a nightly run is for (YYYY-MM-DD). */
  runDate: string | null;
  status: "running" | "done" | "failed";
  startedAt: string;
  finishedAt: string | null;
  /** When the run last made progress: one this old has stopped. */
  heartbeatAt: string;
  attempts: number;
  /** Null for staff who see only their own clients: these count across every client. */
  accountsTotal: number | null;
  /** Null for staff who see only their own clients: these count across every client. */
  accountsChecked: number | null;
  /** Null for staff who see only their own clients: these count across every client. */
  issuesFound: number | null;
  /** New, or found again after being resolved. Null for staff who see only their own clients: these count across every client. */
  issuesNew: number | null;
  /** Null for staff who see only their own clients: these count across every client. */
  criticalFound: number | null;
  error: string | null;
  /** What the run could not cover: a server out of reach, a limit reached. Null too for staff who see only their own clients. */
  notes: string | null;
  startedBy: Person | null;
}

/** Something a run found that does not match, under a key that stays the same from run to run. */
export interface ReconIssue {
  id: number;
  key: string;
  kind: ReconIssueKind;
  severity: ReconSeverity;
  status: "open" | "resolved";
  accountId: number | null;
  login: number | null;
  serverCode: string | null;
  isDemo: boolean | null;
  clientId: number | null;
  clientName: string | null;
  opId: number | null;
  reference: string | null;
  dealTicket: number | null;
  /** The facts as last found, for staff: amounts in cents, logins, tickets, MT5's comment. */
  details: Record<string, unknown>;
  firstRunId: number;
  lastRunId: number;
  reopened: number;
  createdAt: string;
  updatedAt: string;
  resolvedBy: Person | null;
  resolvedAt: string | null;
  resolvedNote: string | null;
  /** A run found it no longer true. */
  resolvedAutomatically: boolean;
  canResolve: boolean;
}

export interface ReconSummary {
  /** Open issues about the clients this staff member may see. */
  open: Record<ReconSeverity, number>;
  lastRun: ReconRun | null;
  running: ReconRun | null;
}

/** The reconciliation summary, issues and runs all start with this key. */
export const RECON_KEY = ["mt5-recon"];
export const RECON_SUMMARY_KEY = [...RECON_KEY, "summary"];

/** Staff balance and credit changes waiting for this person's approval (never their own), for the Transfers badge. */
export const useMt5OpsSummary = (enabled = true) =>
  useQuery({ queryKey: [...OPERATIONS_KEY, "summary"], queryFn: () => api.get<{ awaitingForMe: number }>("/api/staff/mt5/operations/summary"), enabled, refetchInterval: 60_000 });

/**
 * Open issues by severity, the last run and the one running (wallet.reconcile
 * or wallet.view). The nav and the dashboard read it every minute; the
 * reconciliation page (`live`) every 10 seconds while a run is going.
 */
export const useReconSummary = (enabled = true, live = false) =>
  useQuery({
    queryKey: RECON_SUMMARY_KEY,
    queryFn: () => api.get<ReconSummary>("/api/staff/mt5/reconciliation/summary"),
    enabled,
    refetchInterval: (q) => (live && q.state.data?.running ? 10_000 : 60_000),
  });
