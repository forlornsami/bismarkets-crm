import { useQuery } from "@tanstack/react-query";
import { Check, Copy, Wallet } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { ApiError, api, formatDate } from "../lib/api";
import { useCan } from "../lib/session";
import { DEPOSIT_STATUS_LABELS, NOT_PLAIN, WITHDRAWAL_STATUS_LABELS, type DepositStatus, type WithdrawalStatus } from "../../shared/money";
import { Badge, ErrorText, Spinner, reviewTone, type ReviewState } from "./ui";

// Pieces shared by the deposit, withdrawal and payment method screens. Amounts
// arrive from the staff API as integer cents (minor units) and are only ever
// turned into text here, never into floats used for arithmetic.

// The queue plumbing (tiles, tabs, skipping, holding an item, sending it back)
// moved to ./queue so KYC and IB applications share it too.
export { HoldNotices, QueueTabs, SendBack, SkippedNotice, Tile, nothingLeft, queueTab, useHold, useNextItem, type CanDo, type Claimer, type Person, type QueueTab } from "./queue";

// ---------- Amounts ----------

const TWO_DP = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 125050, "USD" → "USD 1,250.50". */
export const money = (minor: number | null | undefined, currency = "USD") => (minor === null || minor === undefined ? "–" : `${currency} ${TWO_DP.format(minor / 100)}`);

/** "+USD 100.00" or "−USD 100.00", for ledger entries. */
export const signedMoney = (minor: number, currency = "USD") => `${minor < 0 ? "−" : "+"}${money(Math.abs(minor), currency)}`;

/** A deposit's claimed amount: "PKR 280,000.00 (USD 1,000.00)", or just "USD 1,000.00". */
export const claimedAmount = (d: { currency: string; amountMinor: number; amountCents: number }) =>
  d.currency === "USD" ? money(d.amountCents) : `${money(d.amountMinor, d.currency)} (${money(d.amountCents)})`;

/** 125050 → "1250.50", to put an amount back into a text field. */
export const minorText = (minor: number | null | undefined) => (minor === null || minor === undefined ? "" : `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`);

const MAX_AMOUNT_MINOR = 1_000_000_000;

/** Reads "1250" or "1250.50" into minor units, with the same rules as the server. */
export function parseAmountText(text: string): { minor: number; problem?: undefined } | { minor?: undefined; problem: string } {
  const t = text.trim();
  if (!t) return { problem: "Enter the amount." };
  const m = /^(\d{1,12})(?:\.(\d+))?$/.exec(t);
  if (!m) return { problem: "Enter the amount as a number, such as 1250 or 1250.50, without commas." };
  const fraction = m[2] ?? "";
  if (fraction.replace(/0+$/, "").length > 2) return { problem: "Use at most two decimal places." };
  const minor = Number(m[1]) * 100 + Number(`${fraction}00`.slice(0, 2));
  if (minor === 0) return { problem: "The amount must be more than zero." };
  if (minor > MAX_AMOUNT_MINOR) return { problem: "This amount is too large." };
  return { minor };
}

const RATE_SCALE = 1_000_000n;
const rateMicros = (rate: string | number | null | undefined) => {
  if (rate === null || rate === undefined) return null;
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(typeof rate === "number" ? rate.toFixed(6) : String(rate).trim());
  if (!m) return null;
  const micros = BigInt(m[1]!) * RATE_SCALE + BigInt((m[2] ?? "").padEnd(6, "0"));
  return micros > 0n ? micros : null;
};

/** What a PKR amount credits in US cents, rounded down like the server; null when the rate is unreadable. */
export function toUsdCents(minor: number, currency: string, usdToPkr: string | number | null | undefined): number | null {
  if (currency === "USD") return minor;
  const micros = rateMicros(usdToPkr);
  return micros ? Number((BigInt(minor) * RATE_SCALE) / micros) : null;
}

/** "280.000000" → "280". */
export const rateText = (rate: string | number | null | undefined) => {
  const n = rateMicros(rate);
  if (!n) return String(rate ?? "");
  const whole = n / RATE_SCALE;
  const frac = (n % RATE_SCALE).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
};

// ---------- Dates ----------

const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const today = () => isoDay(new Date());
export const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return isoDay(d);
};
/** "2026-10-17" → "17 Oct 2026" in the reviewer's own format. */
export const formatDay = (day: string | null | undefined) => {
  if (!day) return "–";
  const [y, m, d] = day.slice(0, 10).split("-").map(Number);
  return y && m && d ? new Date(y, m - 1, d).toLocaleDateString(undefined, { dateStyle: "medium" }) : day;
};

/** A date the reviewer read off a statement: not in the future and not older than `maxDays`. */
export function dayProblem(day: string, maxDays: number, what: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return `Enter the date ${what}.`;
  if (day > today()) return "The date cannot be in the future.";
  if (day < daysAgo(maxDays)) return `The date must be within the last ${maxDays} days.`;
  return null;
}

/** Text a reviewer types that the server stores (plain text only, with a length range). */
export function textProblem(text: string, label: string, min: number, max: number) {
  const t = text.trim();
  if (t.length < min) return `Enter the ${label}.`;
  if (t.length > max) return `Keep the ${label} under ${max} characters.`;
  if (NOT_PLAIN.test(t)) return `Write the ${label} as plain text, without links or symbols like < > { }`;
  return null;
}

// ---------- Labels ----------

const DEPOSIT_STATE: Record<DepositStatus, ReviewState> = { pending: "waiting", second_approval: "later", approved: "done", rejected: "refused" };
// An approved withdrawal still has to be paid: a later step, not done.
const WITHDRAWAL_STATE: Record<WithdrawalStatus, ReviewState> = { pending: "waiting", second_approval: "later", approved: "later", paid: "done", rejected: "refused" };

export const DepositStatusBadge = ({ status }: { status: DepositStatus }) => <Badge tone={DEPOSIT_STATE[status] ? reviewTone(DEPOSIT_STATE[status]) : "neutral"}>{DEPOSIT_STATUS_LABELS[status] ?? status}</Badge>;
export const WithdrawalStatusBadge = ({ status }: { status: WithdrawalStatus }) => (
  <Badge tone={WITHDRAWAL_STATE[status] ? reviewTone(WITHDRAWAL_STATE[status]) : "neutral"}>{WITHDRAWAL_STATUS_LABELS[status] ?? status}</Badge>
);

export const NETWORK_LABEL: Record<string, string> = { trc20: "TRC20", bep20: "BEP20", binance_pay: "Binance Pay" };
export const networkLabel = (network: string | null | undefined) => (network ? (NETWORK_LABEL[network] ?? network) : "");
export const KIND_LABEL: Record<string, string> = { bank: "Bank", crypto: "Crypto" };

/** A value with a small copy button, for references, account numbers and addresses. */
export function CopyText({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap", maxWidth: "100%" }}>
      <span className="mono" style={{ overflowWrap: "anywhere" }}>
        {value}
      </span>
      <button
        type="button"
        className="button button-ghost button-small"
        aria-label={`Copy the ${label}`}
        title={`Copy the ${label}`}
        onClick={async () => {
          await navigator.clipboard?.writeText(value).catch(() => undefined);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        }}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}

/** A picture the staff API serves (such as a QR code), drawn on a canvas: the CRM's content policy blocks blob: images. */
export function ImageCanvas({ url, size = 180, label }: { url: string; size?: number; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<"loading" | "ok" | "failed">("loading");
  const [error, setError] = useState<string>("");
  useEffect(() => {
    let cancelled = false;
    let bitmap: ImageBitmap | null = null;
    setState("loading");
    api
      .bytes(url)
      .then((data) => createImageBitmap(new Blob([data], { type: "image/png" })))
      .then((b) => {
        bitmap = b;
        const canvas = ref.current;
        if (cancelled || !canvas) return;
        const scale = Math.min(1, size / Math.max(b.width, b.height));
        const ratio = window.devicePixelRatio || 1;
        canvas.width = Math.max(1, Math.round(b.width * scale * ratio));
        canvas.height = Math.max(1, Math.round(b.height * scale * ratio));
        canvas.style.width = `${Math.round(b.width * scale)}px`;
        canvas.style.height = `${Math.round(b.height * scale)}px`;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(b, 0, 0, canvas.width, canvas.height);
        }
        setState("ok");
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof ApiError ? e.message : "The picture could not be shown.");
        setState("failed");
      });
    return () => {
      cancelled = true;
      bitmap?.close();
    };
  }, [url, size]);
  return (
    <span style={{ display: "inline-grid", placeItems: "center", minWidth: 60, minHeight: 60 }}>
      <canvas ref={ref} role="img" aria-label={label} hidden={state !== "ok"} onContextMenu={(e) => e.preventDefault()} />
      {state === "loading" && <Spinner />}
      {state === "failed" && <small className="error-text">{error}</small>}
    </span>
  );
}

// ---------- Queue summaries (also used for the navigation badges) ----------

export interface DepositSummary {
  pending: number;
  secondApproval: number;
  overdue: number;
  oldestOpenAt: string | null;
  decidedToday: number;
  decidedTodayByMe: number;
  secondApprovalForMe: number;
  /** What Start reviewing would hand this reviewer now at each step (leaves out items colleagues hold). */
  forMe?: { first: number; second: number };
}

export interface WithdrawalSummary {
  review: number;
  secondApproval: number;
  toPay: number;
  overdue: number;
  oldestOpenAt: string | null;
  decidedToday: number;
  decidedTodayByMe: number;
  forMe: { review: number; secondApproval: number; toPay: number };
}

export const useDepositSummary = (enabled = true) =>
  useQuery({ queryKey: ["deposits-summary"], queryFn: () => api.get<DepositSummary>("/api/staff/deposits/summary"), enabled, refetchInterval: 60_000 });

export const useWithdrawalSummary = (enabled = true) =>
  useQuery({ queryKey: ["withdrawals-summary"], queryFn: () => api.get<WithdrawalSummary>("/api/staff/withdrawals/summary"), enabled, refetchInterval: 60_000 });

/** Deposits waiting for something this staff member can do. */
export function useDepositsForMe() {
  const can = useCan();
  const mine = can("deposit.view", "deposit.proof") && (can("deposit.process") || can("deposit.approve_large"));
  const s = useDepositSummary(mine).data;
  if (!mine || !s) return 0;
  if (s.forMe) return s.forMe.first + s.forMe.second;
  return (can("deposit.process") ? s.pending : 0) + (can("deposit.approve_large") ? s.secondApprovalForMe : 0);
}

/** Withdrawals waiting for something this staff member can do. */
export function useWithdrawalsForMe() {
  const can = useCan();
  const mine = can("withdrawal.view") && (can("withdrawal.process") || can("withdrawal.approve") || can("withdrawal.pay"));
  const s = useWithdrawalSummary(mine).data;
  if (!mine || !s?.forMe) return 0;
  return s.forMe.review + s.forMe.secondApproval + s.forMe.toPay;
}

// ---------- Methods (for filters) ----------

export interface PaymentMethod {
  id: number;
  direction: "deposit" | "withdrawal";
  kind: "bank" | "crypto";
  name: string;
  currency: "USD" | "PKR";
  network: "" | "trc20" | "bep20" | "binance_pay";
  bankName: string;
  accountTitle: string;
  accountNumber: string;
  iban: string;
  walletAddress: string;
  hasQr: boolean;
  qrUrl: string | null;
  amountNote: string;
  feeLabel: string;
  processingLabel: string;
  minMinor: number | null;
  askQr: boolean;
  isEnabled: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  usage: { open: number; total: number };
}

export const usePaymentMethods = (enabled = true) =>
  useQuery({ queryKey: ["payment-methods"], queryFn: () => api.get<{ items: PaymentMethod[] }>("/api/staff/money/methods"), enabled, staleTime: 60_000 });

// ---------- A client's wallet (client detail page) ----------

interface WalletEntry {
  at: string;
  kind: string;
  account: "wallet" | "hold";
  amountCents: number;
  reference: string | null;
  sourceType: string;
  sourceId: number;
}
interface ClientWalletData {
  walletKey: string;
  availableCents: number;
  heldCents: number;
  currency: string;
  totals: { depositedCents: number; withdrawnCents: number; pendingDeposits: number; openWithdrawals: number };
  entries: WalletEntry[];
}

const ENTRY_LABEL: Record<string, string> = {
  deposit: "Deposit added",
  withdrawal_hold: "Withdrawal requested",
  withdrawal_paid: "Withdrawal paid",
  withdrawal_release: "Withdrawal rejected, money returned",
  transfer_hold: "Transfer to MT5 requested",
  transfer_release: "Transfer to MT5 failed, money returned",
  transfer_out: "Transferred to MT5",
  transfer_in: "Transferred from MT5",
};

/** The client's USD wallet: balance, money held for withdrawals and transfers, totals and the latest ledger entries. */
export function ClientWallet({ clientId }: { clientId: number }) {
  const can = useCan();
  const allowed = can("wallet.view");
  const wallet = useQuery({ queryKey: ["client-wallet", clientId], queryFn: () => api.get<ClientWalletData>(`/api/staff/money/clients/${clientId}/wallet`), enabled: allowed });
  if (!allowed) return null;
  const w = wallet.data;
  const link = (e: WalletEntry) => {
    const label = e.reference ?? `${e.sourceType} ${e.sourceId}`;
    if (e.sourceType === "deposit" && can("deposit.view", "deposit.proof")) return <Link href={`/deposits/${e.sourceId}`}>{label}</Link>;
    if (e.sourceType === "withdrawal" && can("withdrawal.view")) return <Link href={`/withdrawals/${e.sourceId}`}>{label}</Link>;
    if (e.sourceType === "mt5_op" && can("wallet.view")) return <Link href={`/transfers/${e.sourceId}`}>{label}</Link>;
    return label;
  };
  return (
    <section className="panel">
      <div className="card-head">
        <h2 className="flush">
          <Wallet size={18} /> Wallet
        </h2>
        {w && <span className="muted mono">{w.walletKey}</span>}
      </div>
      {wallet.error ? (
        <ErrorText error={wallet.error} />
      ) : !w ? (
        <Spinner />
      ) : (
        <>
          <dl className="details">
            <dt>Available</dt>
            <dd>
              <strong>{money(w.availableCents, w.currency)}</strong>
            </dd>
            <dt>Held</dt>
            <dd>
              {money(w.heldCents, w.currency)}
              <small className="muted block">Held for withdrawals and transfers not finished yet</small>
            </dd>
            <dt>Deposited</dt>
            <dd>
              {money(w.totals.depositedCents, w.currency)}
              {w.totals.pendingDeposits > 0 && (
                <small className="muted block">
                  {can("deposit.view") ? <Link href={`/deposits?client=${clientId}`}>{w.totals.pendingDeposits} waiting for review</Link> : `${w.totals.pendingDeposits} waiting for review`}
                </small>
              )}
            </dd>
            <dt>Withdrawn</dt>
            <dd>
              {money(w.totals.withdrawnCents, w.currency)}
              {w.totals.openWithdrawals > 0 && (
                <small className="muted block">
                  {can("withdrawal.view") ? <Link href={`/withdrawals?client=${clientId}`}>{w.totals.openWithdrawals} in progress</Link> : `${w.totals.openWithdrawals} in progress`}
                </small>
              )}
            </dd>
          </dl>
          <h3>Latest entries</h3>
          {w.entries.length === 0 ? (
            <p className="muted">No money has moved yet.</p>
          ) : (
            <ul className="session-list">
              {w.entries.map((e, i) => (
                <li key={i}>
                  <div>
                    <strong>{ENTRY_LABEL[e.kind] ?? e.kind}</strong> <Badge tone={e.amountCents < 0 ? "neutral" : "good"}>{signedMoney(e.amountCents, w.currency)}</Badge>{" "}
                    <span className="muted">{e.account === "hold" ? "held" : "wallet"}</span>
                  </div>
                  <small className="muted">
                    {formatDate(e.at)} · {link(e)}
                  </small>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
