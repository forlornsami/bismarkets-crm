import { AlertTriangle, ArrowLeft, Check, Download, FileText, Info, Keyboard, Maximize2, RotateCcw, RotateCw, SkipForward, X, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Dialog, ErrorText, Spinner } from "./ui";

// The shared review screen for every approval queue: KYC now, deposits and
// withdrawals next. One item at a time, evidence on the left, what to check and
// the decision on the right, keyboard shortcuts for everything.

export interface ReviewFile {
  id: number;
  slot: number;
  type: string;
  bytes: number;
  url: string;
  label: string;
}

export interface ReviewWarning {
  tone: "bad" | "warn" | "info";
  text: string;
}

const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);
const isImage = (t: string) => t.startsWith("image/") && t !== "image/heic";
const typing = (e: KeyboardEvent) => {
  const el = e.target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
};

/** Keyboard shortcuts that stay quiet while the reviewer is typing. */
export function useShortcuts(map: Record<string, () => void>, enabled = true) {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (typing(e) && e.key !== "Escape") return;
      const fn = ref.current[e.key] ?? ref.current[e.key.toLowerCase()];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}

/** Large document viewer with zoom, rotate and front/back switching. */
export function DocumentViewer({ files }: { files: ReviewFile[] }) {
  const [index, setIndex] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [turn, setTurn] = useState(0);
  const file = files[Math.min(index, files.length - 1)];
  useEffect(() => {
    setZoom(1);
    setTurn(0);
  }, [index]);
  const step = (dir: number) => setZoom((z) => Math.min(4, Math.max(0.5, Math.round((z + dir * 0.25) * 100) / 100)));
  useShortcuts({
    "+": () => step(1),
    "=": () => step(1),
    "-": () => step(-1),
    "0": () => (setZoom(1), setTurn(0)),
    "[": () => setTurn((t) => t - 90),
    "]": () => setTurn((t) => t + 90),
    ArrowRight: () => setIndex((i) => (i + 1) % files.length),
    ArrowLeft: () => setIndex((i) => (i - 1 + files.length) % files.length),
  });
  if (!file) return <div className="viewer viewer-empty muted">No documents were attached.</div>;
  return (
    <div className="viewer">
      <div className="viewer-bar">
        {files.length > 1 && (
          <div className="viewer-pages" role="tablist" aria-label="Pages">
            {files.map((f, i) => (
              <button key={f.id} type="button" role="tab" aria-selected={i === index} className={i === index ? "active" : ""} onClick={() => setIndex(i)}>
                {f.label}
              </button>
            ))}
          </div>
        )}
        <span className="muted viewer-meta">{kb(file.bytes)}</span>
        {isImage(file.type) && (
          <span className="viewer-tools">
            <button type="button" className="icon-button" title="Zoom out (−)" onClick={() => step(-1)}>
              <ZoomOut size={17} />
            </button>
            <span className="viewer-zoom">{Math.round(zoom * 100)}%</span>
            <button type="button" className="icon-button" title="Zoom in (+)" onClick={() => step(1)}>
              <ZoomIn size={17} />
            </button>
            <button type="button" className="icon-button" title="Rotate left ([)" onClick={() => setTurn((t) => t - 90)}>
              <RotateCcw size={17} />
            </button>
            <button type="button" className="icon-button" title="Rotate right (])" onClick={() => setTurn((t) => t + 90)}>
              <RotateCw size={17} />
            </button>
            <a className="icon-button" title="Open full size in a new tab" href={file.url} target="_blank" rel="noreferrer">
              <Maximize2 size={17} />
            </a>
          </span>
        )}
      </div>
      <div className="viewer-stage" onWheel={(e) => e.ctrlKey && (e.preventDefault(), step(e.deltaY < 0 ? 1 : -1))}>
        {isImage(file.type) ? (
          <img
            key={file.id}
            src={file.url}
            alt={file.label}
            style={{ transform: `rotate(${turn}deg)`, width: `${zoom * 100}%`, maxWidth: zoom === 1 ? "100%" : "none" }}
            onDoubleClick={() => setZoom((z) => (z === 1 ? 2 : 1))}
          />
        ) : (
          <a className="viewer-file" href={file.url}>
            <FileText size={44} />
            <strong>{file.type === "application/pdf" ? "PDF document" : "HEIC photo"}</strong>
            <span className="muted">Browsers cannot show this safely inside the CRM. Download it to view.</span>
            <span className="button">
              <Download size={15} /> Download ({kb(file.bytes)})
            </span>
          </a>
        )}
      </div>
      {files.length > 1 && <p className="muted tight viewer-hint">← → switch pages · + − zoom · [ ] rotate · double-click to zoom</p>}
    </div>
  );
}

export function Warnings({ items }: { items: ReviewWarning[] }) {
  if (!items.length) return <div className="review-ok"><Check size={15} /> No automatic warnings.</div>;
  return (
    <ul className="review-warnings">
      {items.map((w, i) => (
        <li key={i} className={`review-warning ${w.tone}`}>
          {w.tone === "info" ? <Info size={15} /> : <AlertTriangle size={15} />}
          <span>{w.text}</span>
        </li>
      ))}
    </ul>
  );
}

export interface ReviewDecisionProps {
  checklist: { key: string; label: string }[];
  reasons: string[];
  busy: boolean;
  error: unknown;
  canDecide: boolean;
  blockedText?: string | null;
  approveLabel?: string;
  onApprove: (ticked: string[]) => void;
  onReject: (reason: string, ticked: string[]) => void;
  onSkip?: () => void;
  onBack?: () => void;
  resetKey: string | number;
}

/** Checklist, approve and reject with ready-made reasons. */
export function ReviewDecision(props: ReviewDecisionProps) {
  const { checklist, reasons, busy, canDecide } = props;
  const [ticked, setTicked] = useState<string[]>([]);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [help, setHelp] = useState(false);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    setTicked([]);
    setRejecting(false);
    setReason("");
  }, [props.resetKey]);
  useEffect(() => {
    if (rejecting) reasonRef.current?.focus();
  }, [rejecting]);
  const allTicked = checklist.every((c) => ticked.includes(c.key));
  const toggle = (key: string) => setTicked((t) => (t.includes(key) ? t.filter((k) => k !== key) : [...t, key]));
  const approve = () => allTicked && !busy && canDecide && props.onApprove(ticked);
  const reject = () => reason.trim().length >= 5 && !busy && canDecide && props.onReject(reason.trim(), ticked);
  const keys: Record<string, () => void> = {
    a: approve,
    r: () => canDecide && setRejecting(true),
    s: () => props.onSkip?.(),
    "?": () => setHelp(true),
    Escape: () => (rejecting ? setRejecting(false) : props.onBack?.()),
    c: () => setTicked(allTicked ? [] : checklist.map((c) => c.key)),
  };
  checklist.forEach((c, i) => (keys[String(i + 1)] = () => toggle(c.key)));
  useShortcuts(keys, !help);

  return (
    <div className="review-decision">
      <div className="card-head">
        <h3 className="flush">Before you decide</h3>
        <button type="button" className="button button-ghost button-small" onClick={() => setHelp(true)} title="Keyboard shortcuts (?)">
          <Keyboard size={15} /> Shortcuts
        </button>
      </div>
      <ul className="review-checklist">
        {checklist.map((c, i) => (
          <li key={c.key}>
            <label>
              <input type="checkbox" checked={ticked.includes(c.key)} onChange={() => toggle(c.key)} disabled={!canDecide} />
              <span>{c.label}</span>
              <kbd>{i + 1}</kbd>
            </label>
          </li>
        ))}
      </ul>
      {props.blockedText && <p className="notice notice-warn tight">{props.blockedText}</p>}
      <ErrorText error={props.error} />
      {rejecting ? (
        <form
          className="review-reject"
          onSubmit={(e) => {
            e.preventDefault();
            reject();
          }}
        >
          <span className="field-label">Reason the client will see</span>
          <div className="chips">
            {reasons.map((r) => (
              <button key={r} type="button" className={reason === r ? "chip active" : "chip"} onClick={() => (setReason(r), reasonRef.current?.focus())}>
                {r}
              </button>
            ))}
          </div>
          <textarea
            ref={reasonRef}
            className="input"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && (e.preventDefault(), reject())}
            placeholder="Pick a reason above or write your own"
            maxLength={500}
          />
          <div className="actions">
            <button type="button" className="button" onClick={() => setRejecting(false)}>
              Back <kbd>Esc</kbd>
            </button>
            <button type="submit" className="button button-danger-solid" disabled={busy || reason.trim().length < 5}>
              {busy && <Spinner />} Reject and next <kbd>Ctrl ↵</kbd>
            </button>
          </div>
        </form>
      ) : (
        <div className="review-buttons">
          <button type="button" className="button button-primary button-big" disabled={!canDecide || !allTicked || busy} onClick={approve} title={allTicked ? undefined : "Tick every check first"}>
            {busy ? <Spinner /> : <Check size={17} />} {props.approveLabel ?? "Approve and next"} <kbd>A</kbd>
          </button>
          <div className="review-buttons-row">
            <button type="button" className="button button-danger" disabled={!canDecide || busy} onClick={() => setRejecting(true)}>
              <X size={15} /> Reject <kbd>R</kbd>
            </button>
            {props.onSkip && (
              <button type="button" className="button" disabled={busy} onClick={props.onSkip}>
                <SkipForward size={15} /> Skip <kbd>S</kbd>
              </button>
            )}
          </div>
          {!allTicked && canDecide && <p className="muted tight">Tick every check to approve, or press C to tick them all after checking.</p>}
        </div>
      )}
      <Dialog open={help} title="Keyboard shortcuts" onClose={() => setHelp(false)}>
        <dl className="details shortcuts">
          <dt><kbd>A</kbd></dt><dd>Approve and open the next item</dd>
          <dt><kbd>R</kbd></dt><dd>Reject (pick or write a reason, then Ctrl + Enter)</dd>
          <dt><kbd>S</kbd></dt><dd>Skip to the next item</dd>
          <dt><kbd>1</kbd>–<kbd>{checklist.length}</kbd></dt><dd>Tick a check</dd>
          <dt><kbd>C</kbd></dt><dd>Tick or untick every check</dd>
          <dt><kbd>←</kbd> <kbd>→</kbd></dt><dd>Front and back of the document</dd>
          <dt><kbd>+</kbd> <kbd>−</kbd> <kbd>0</kbd></dt><dd>Zoom in, out, reset</dd>
          <dt><kbd>[</kbd> <kbd>]</kbd></dt><dd>Rotate</dd>
          <dt><kbd>Esc</kbd></dt><dd>Back to the queue</dd>
        </dl>
      </Dialog>
    </div>
  );
}

/** Page frame: back link, title, queue position, evidence left, decision right. */
export function ReviewLayout({ title, subtitle, position, onBack, evidence, side }: { title: ReactNode; subtitle?: ReactNode; position?: string; onBack: () => void; evidence: ReactNode; side: ReactNode }) {
  return (
    <div className="review">
      <div className="review-head">
        <button type="button" className="back-link button-link" onClick={onBack}>
          <ArrowLeft size={15} /> Queue
        </button>
        <div className="review-title">
          <h1 className="flush">{title}</h1>
          {subtitle && <div className="muted">{subtitle}</div>}
        </div>
        {position && <span className="review-position">{position}</span>}
      </div>
      <div className="review-body">
        <section className="panel review-evidence">{evidence}</section>
        <aside className="panel review-side">{side}</aside>
      </div>
    </div>
  );
}

/** "Waiting 3 h" with a colour once it is getting late. */
export function Waiting({ since, now = Date.now() }: { since: string; now?: number }) {
  const mins = Math.max(0, Math.round((now - new Date(since).getTime()) / 60_000));
  const text = mins < 60 ? `${mins} min` : mins < 48 * 60 ? `${Math.round(mins / 60)} h` : `${Math.round(mins / 1440)} days`;
  const tone = mins >= 24 * 60 ? "bad" : mins >= 4 * 60 ? "warn" : "neutral";
  return <span className={`waiting waiting-${tone}`}>{text}</span>;
}
