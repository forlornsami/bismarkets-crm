import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useLocation } from "wouter";
import { ApiError, api } from "../lib/api";
import { reopenItem } from "../lib/visits";
import { DecisionError, plainProblem } from "./ReviewWorkbench";
import { Badge, Spinner, useFeedback } from "./ui";

// The plumbing every approval queue shares (KYC, deposits, withdrawals and IB
// applications): which items this browser tab skipped, "Start reviewing" and
// approve-and-next, holding an item while it is reviewed, sending it back, and
// the tiles and tabs above each list.

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

/** A summary tile above a queue. */
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

export type NextItem = UseMutationResult<{ id: number | null }, Error, { release?: number }>;

/** "Start reviewing" and approve-and-next: claims the oldest item this reviewer can act on, or goes back to the queue. */
export function useNextItem<S extends string>({ base, route, keys, tab, nothing }: { base: string; route: string; keys: string[]; tab: QueueTab<S>; nothing: (stage: S | null, skips: number) => string }): NextItem {
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

export type Hold = ReturnType<typeof useHold>;

/**
 * Holds an item for this reviewer while they work on it: claimed when opened
 * (unless someone else holds it), renewed only while they are active, given up
 * after 10 idle minutes, and let go when they leave the item or close the tab.
 * `reload` fetches the item again and returns who holds it now (null when
 * nobody does or it is no longer waiting).
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
