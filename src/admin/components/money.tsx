import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, RotateCcw, Wallet } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { ApiError, api, formatDate } from "../lib/api";
import { useCan } from "../lib/session";
import { reopenItem } from "../lib/visits";
import { DEPOSIT_STATUS_LABELS, NOT_PLAIN, WITHDRAWAL_STATUS_LABELS, type DepositStatus, type WithdrawalStatus } from "../../shared/money";
import { DecisionError, plainProblem } from "./ReviewWorkbench";
import { Badge, ErrorText, Spinner, useFeedback, type Tone } from "./ui";

// Pieces shared by the deposit, withdrawal and payment method screens. Amounts
// arrive from the staff API as integer cents (minor units) and are only ever
// turned into text here, never into floats used for arithmetic.

export interface Person {
  id: number;
  name: string | null;
}
export interface Claimer extends Person {
  until: string;
}
/** Whether a step is possible for this reviewer right now, and why not. */
export interface CanDo {
  ok: boolean;
  reason: string | null;
}
export interface MoneyNote {
  at: string;
  byName: string | null;
  stage: string;
  text: string;
}

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

const DEPOSIT_TONE: Record<DepositStatus, Tone> = { pending: "warn", second_approval: "info", approved: "good", rejected: "bad" };
const WITHDRAWAL_TONE: Record<WithdrawalStatus, Tone> = { pending: "warn", second_approval: "info", approved: "info", paid: "good", rejected: "bad" };

export const DepositStatusBadge = ({ status }: { status: DepositStatus }) => <Badge tone={DEPOSIT_TONE[status] ?? "neutral"}>{DEPOSIT_STATUS_LABELS[status] ?? status}</Badge>;
export const WithdrawalStatusBadge = ({ status }: { status: WithdrawalStatus }) => <Badge tone={WITHDRAWAL_TONE[status] ?? "neutral"}>{WITHDRAWAL_STATUS_LABELS[status] ?? status}</Badge>;

export const NETWORK_LABEL: Record<string, string> = { trc20: "TRC20", bep20: "BEP20", binance_pay: "Binance Pay" };
export const networkLabel = (network: string | null | undefined) => (network ? (NETWORK_LABEL[network] ?? network) : "");
export const KIND_LABEL: Record<string, string> = { bank: "Bank", crypto: "Crypto" };

const NOTE_STAGE: Record<string, string> = {
  first_approval: "First approval",
  second_approval: "Second approval",
  returned: "Sent back",
  approved: "Approved",
  paid: "Paid",
  rejected: "Rejected",
};

/** Internal notes left at each step, oldest first. The client never sees them. */
export function NotesTrail({ notes }: { notes: MoneyNote[] | null | undefined }) {
  if (!notes?.length) return null;
  return (
    <>
      <h3>Internal notes</h3>
      <ol className="timeline trail">
        {notes.map((n, i) => (
          <li key={i} className="by-staff">
            <strong>{NOTE_STAGE[n.stage] ?? n.stage}</strong>
            <small className="muted">
              {formatDate(n.at)}
              {n.byName ? ` · ${n.byName}` : ""}
            </small>
            <small className="trail-note">{n.text}</small>
          </li>
        ))}
      </ol>
    </>
  );
}

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

/** A summary tile, as on the KYC queue. */
export function Tile({ icon, tone, label, value, foot }: { icon: ReactNode; tone: string; label: string; value: ReactNode; foot: string }) {
  return (
    <div className="tile">
      <span className={`tile-icon ${tone}`}>{icon}</span>
      <div>
        <div className="tile-label">{label}</div>
        <div className="tile-value">{value}</div>
        <div className="tile-foot">{foot}</div>
      </div>
    </div>
  );
}

/** Status tabs above a queue, with the number waiting where it is known. */
export function QueueTabs<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string; count?: number }[]; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist" aria-label="Status" style={{ marginBottom: 14 }}>
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
          {o.count ? <Badge tone="warn">{o.count > 999 ? "999+" : o.count}</Badge> : null}
        </button>
      ))}
    </div>
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

// ---------- Queue position for this browser tab ----------
// Items skipped in this tab, so "next" does not hand them straight back, and the
// step chosen with Start reviewing, so approve-and-next keeps to it.

export interface QueueTab<S extends string> {
  skipped: () => number[];
  remember: (ids: number[]) => void;
  stage: () => S | null;
  setStage: (stage: S | null) => void;
  useTab: () => { skipped: number[]; stage: S | null };
}

export function queueTab<S extends string>(name: string, stages: readonly S[]): QueueTab<S> {
  const skipKey = `${name}-skipped`;
  const stageKey = `${name}-stage`;
  const listeners = new Set<() => void>();
  let version = 0;
  const read = (key: string): unknown => {
    try {
      return JSON.parse(sessionStorage.getItem(key) ?? "null");
    } catch {
      return null;
    }
  };
  const write = (key: string, value: unknown) => {
    try {
      if (value === null) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode */
    }
    version++;
    listeners.forEach((fn) => fn());
  };
  const skipped = () => {
    const v = read(skipKey);
    return Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x)) : [];
  };
  const stage = () => {
    const v = read(stageKey);
    return (stages as readonly unknown[]).includes(v) ? (v as S) : null;
  };
  const subscribe = (fn: () => void) => {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  };
  const snapshot = () => version;
  return {
    skipped,
    remember: (ids) => write(skipKey, ids.length ? ids.slice(-200) : null),
    stage,
    setStage: (s) => write(stageKey, s),
    useTab: () => {
      useSyncExternalStore(subscribe, snapshot);
      return { skipped: skipped(), stage: stage() };
    },
  };
}

/** "Start reviewing" and approve-and-next: claims the oldest item this reviewer can act on, or goes back to the queue. */
export function useNextItem<S extends string>({ base, route, keys, tab, nothing }: { base: string; route: string; keys: string[]; tab: QueueTab<S>; nothing: (stage: S | null, skips: number) => string }) {
  const [location, navigate] = useLocation();
  const { toast } = useFeedback();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (opts: { release?: number } = {}) => {
      const stage = tab.stage();
      return api.post<{ id: number | null }>(`${base}/next`, { skip: tab.skipped(), ...(stage ? { stage } : {}), ...opts });
    },
    onSuccess: (res) => {
      for (const key of keys) void client.invalidateQueries({ queryKey: [key] });
      if (res.id) {
        if (location === `${route}/${res.id}`) reopenItem();
        return navigate(`${route}/${res.id}`);
      }
      toast(nothing(tab.stage(), tab.skipped().length));
      navigate(route);
    },
  });
}

export const nothingLeft = (what: string, skips: number) =>
  skips ? `${what} waiting for you right now, apart from the ${skips === 1 ? "item" : `${skips} items`} you skipped.` : `${what} waiting for you right now.`;

/** The notice about skipped items, with a way to go through them again. */
export function SkippedNotice({ count, busy, onReview }: { count: number; busy: boolean; onReview: () => void }) {
  if (!count) return null;
  return (
    <div className="notice notice-row">
      <p>
        You skipped {count === 1 ? "an item" : `${count} items`} in this tab, so Start reviewing passes over {count === 1 ? "it" : "them"}.
      </p>
      <button type="button" className="button button-small" disabled={busy} onClick={onReview}>
        Review skipped items
      </button>
    </div>
  );
}

// ---------- Holding an item while it is reviewed ----------

const IDLE_MS = 10 * 60_000; // let go of an item after 10 minutes without any activity
const RENEW_MS = 5 * 60_000; // the server holds a claim for 15 minutes

/**
 * Holds an item for this reviewer while they work on it, as on the KYC screen:
 * claimed when opened (unless someone else holds it), renewed only while they
 * are active, given up after 10 idle minutes, and let go when they leave the
 * item or close the tab. `reload` fetches the item again and returns who holds
 * it now (null when nobody does or it is no longer waiting).
 */
export function useHold({ base, id, me, open, holdable, claimedBy, reload }: { base: string; id: number; me: number; open: boolean; holdable: boolean; claimedBy: Claimer | null | undefined; reload: () => Promise<Claimer | null | undefined> }) {
  const heldByOther = useRef(false);
  heldByOther.current = Boolean(claimedBy && claimedBy.id !== me);
  const [heldBy, setHeldBy] = useState<string | null>(null);
  const [away, setAway] = useState(false);
  const decided = useRef(false);
  const lastActive = useRef(Date.now());
  const lastRenew = useRef(0);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  useEffect(() => {
    if (open && claimedBy && claimedBy.id !== me) setHeldBy(claimedBy.name ?? "Another reviewer");
  }, [open, claimedBy?.id, claimedBy?.name, me]);

  const refresh = useCallback(async () => {
    const holder = await reloadRef.current();
    setHeldBy(holder && holder.id !== me ? (holder.name ?? "Another reviewer") : null);
  }, [me]);

  const claim = useMutation({
    mutationFn: (takeOver: boolean) => api.post<{ claimedBy?: Claimer | null }>(`${base}/${id}/claim`, { takeOver }),
    onSuccess: (res, takeOver) => {
      const holder = res?.claimedBy;
      if (holder === undefined || holder?.id === me) {
        lastRenew.current = Date.now();
        setHeldBy(null);
        setAway(false);
        // What this reviewer may do was worked out while a colleague held the item: load it again.
        if (takeOver) void reloadRef.current();
      } else void refresh();
    },
    onError: (e) => {
      if (e instanceof ApiError && (e.status === 409 || e.status === 400)) {
        setAway(false);
        void refresh();
      }
    },
  });
  const claimRef = useRef(claim.mutate);
  claimRef.current = claim.mutate;

  useEffect(() => {
    if (!holdable) return;
    decided.current = false;
    lastActive.current = Date.now();
    // When someone else holds it, the screen already names them; claiming would only be refused.
    if (!heldByOther.current) claimRef.current(false);
    const release = () => void api.post(`${base}/${id}/release`).catch(() => undefined);
    const onActivity = () => {
      lastActive.current = Date.now();
    };
    const activity = ["pointerdown", "pointermove", "keydown", "wheel", "scroll", "touchstart"];
    activity.forEach((ev) => window.addEventListener(ev, onActivity, { capture: true, passive: true }));
    const timer = setInterval(() => {
      if (decided.current || !lastRenew.current) return;
      const now = Date.now();
      if (now - lastActive.current >= IDLE_MS) {
        lastRenew.current = 0;
        release();
        setAway(true);
      } else if (now - lastRenew.current >= RENEW_MS && lastActive.current > lastRenew.current) {
        lastRenew.current = now;
        claimRef.current(false);
      }
    }, 30_000);
    const onHide = () => {
      if (decided.current) return;
      lastRenew.current = 0;
      api.sendOnExit(`${base}/${id}/release`);
    };
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted && !decided.current) claimRef.current(false);
    };
    window.addEventListener("pagehide", onHide);
    window.addEventListener("pageshow", onShow);
    return () => {
      clearInterval(timer);
      activity.forEach((ev) => window.removeEventListener(ev, onActivity, { capture: true }));
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("pageshow", onShow);
      lastRenew.current = 0;
      if (!decided.current) release();
    };
  }, [base, id, holdable]);

  const resume = () => {
    lastActive.current = Date.now();
    claim.mutate(false);
  };
  return { heldBy, away, claim, decided, refresh, resume };
}

/** The "released while you were away" notice and the take-over button, under the warnings. */
export function HoldNotices({ away, heldBy, holdable, busy, onResume, onTakeOver }: { away: boolean; heldBy: string | null; holdable: boolean; busy: boolean; onResume: () => void; onTakeOver: () => void }) {
  return (
    <>
      {away && (
        <div className="notice notice-warn notice-row">
          <p>You were away for a while, so this item was released for other reviewers.</p>
          <button type="button" className="button button-small" disabled={busy} onClick={onResume}>
            Continue reviewing
          </button>
        </div>
      )}
      {heldBy && holdable && (
        <button type="button" className="button button-small" onClick={onTakeOver} disabled={busy}>
          Take over the review
        </button>
      )}
    </>
  );
}

/** Sends an item back to the earlier step with a note for colleagues (second approval only). */
export function SendBack({ label, help, blocked, busy, error, onSend }: { label: string; help: string; blocked: string | null; busy: boolean; error: unknown; onSend: (note: string) => void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const problem = plainProblem(note, "note");
  if (blocked) return <p className="muted tight">{blocked}</p>;
  if (!open)
    return (
      <button type="button" className="button button-small" disabled={busy} onClick={() => setOpen(true)}>
        <RotateCcw size={14} /> {label}
      </button>
    );
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (note.trim().length >= 5 && !problem) onSend(note.trim());
      }}
    >
      <p className="muted tight">{help}</p>
      <label className="review-note">
        <span className="field-label">What needs another look (internal, never shown to the client)</span>
        <textarea className="input" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
      </label>
      {problem && <small className="error-text">{problem}</small>}
      <DecisionError error={error} />
      <div className="actions actions-left">
        <button type="submit" className="button button-primary" disabled={busy || note.trim().length < 5 || !!problem}>
          {busy && <Spinner />} {label}
        </button>
        <button type="button" className="button button-ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
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
}

export interface WithdrawalSummary {
  review: number;
  secondApproval: number;
  toPay: number;
  overdue: number;
  oldestOpenAt: string | null;
  decidedToday: number;
  decidedTodayByMe?: number;
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
};

/** The client's USD wallet: balance, money held for withdrawals, totals and the latest ledger entries. */
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
              <small className="muted block">Set aside for withdrawals not paid yet</small>
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
