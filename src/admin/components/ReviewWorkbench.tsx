import { AlertTriangle, ArrowLeft, Check, ChevronLeft, ChevronRight, Download, FileText, Info, Keyboard, Maximize2, Minimize2, RotateCcw, RotateCw, SkipForward, X, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { ApiError, api } from "../lib/api";
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
  /** Pages the server counted (null for a PDF it could not count yet). */
  pages?: number | null;
}

export interface ReviewWarning {
  tone: "bad" | "warn" | "info";
  text: string;
  /** Opens in a new tab, so the item stays held while the reviewer looks. */
  href?: string;
  linkLabel?: string;
}

const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);
const isPdf = (t: string) => t === "application/pdf";
// HEIC is converted to JPEG when it is uploaded, and the server sends older HEIC uploads as JPEG too.
const isImage = (t: string) => t.startsWith("image/");
// Only fields that take text count as typing; a focused checkbox must not swallow the shortcuts.
const TEXT_ENTRY = 'textarea, select, [contenteditable=""], [contenteditable="true"], input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=reset])';
const typing = (e: KeyboardEvent) => {
  const el = e.target as HTMLElement | null;
  return !!el && typeof el.matches === "function" && (el.matches(TEXT_ENTRY) || el.isContentEditable);
};
// The server refuses links and markup in anything a reviewer writes (the same rule), so say so before the 2FA prompt.
const NOT_PLAIN = /[<>{}`\\]|https?:|\bwww\./i;
export const plainProblem = (text: string, what: "reason" | "note") => (NOT_PLAIN.test(text) ? `Write the ${what} as plain text, without links or symbols like < > { }` : null);

/** A refused decision, in the server's own words for each field rather than just "Check the highlighted fields." */
export function DecisionError({ error }: { error: unknown }) {
  const details = error instanceof ApiError ? error.details : undefined;
  if (!details?.length) return <ErrorText error={error} />;
  return (
    <p className="error-text" role="alert">
      {details.map((d) => d.message).join(" ")}
    </p>
  );
}

/** "a, b and c" */
export const listOf = (items: string[]) => (items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

// ---------- Shortcut setting ----------
// Single-key shortcuts can be switched off (WCAG 2.1.4). The choice is kept in
// this browser only; it is a convenience, so a blocked storage just means "on".

const SHORTCUTS_KEY = "review-shortcuts";
let shortcutsOn = (() => {
  try {
    return localStorage.getItem(SHORTCUTS_KEY) !== "off";
  } catch {
    return true;
  }
})();
const shortcutListeners = new Set<() => void>();

export function useShortcutsSetting(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(
    (fn) => {
      shortcutListeners.add(fn);
      return () => shortcutListeners.delete(fn);
    },
    () => shortcutsOn,
  );
  const set = useCallback((value: boolean) => {
    shortcutsOn = value;
    try {
      localStorage.setItem(SHORTCUTS_KEY, value ? "on" : "off");
    } catch {
      /* private mode: the choice lasts until the page reloads */
    }
    shortcutListeners.forEach((fn) => fn());
  }, []);
  return [on, set];
}

/**
 * Keyboard shortcuts that stay quiet while the reviewer is typing, while any
 * dialog (such as the 2FA prompt) is open, and, for letters, digits and
 * symbols, when the reviewer has switched single-key shortcuts off. While
 * something is full screen, only shortcuts whose `scope` is inside it work, so
 * nothing hidden behind it (such as the decision) is changed unseen.
 */
export function useShortcuts(map: Record<string, (e: KeyboardEvent) => void>, enabled = true, scope?: RefObject<HTMLElement | null>) {
  const ref = useRef(map);
  ref.current = map;
  const [on] = useShortcutsSetting();
  const onRef = useRef(on);
  onRef.current = on;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.defaultPrevented) return;
      if (document.querySelector("dialog[open]")) return;
      const full = document.fullscreenElement;
      if (full && !(scope?.current && full.contains(scope.current))) return;
      if (e.key.length === 1 && !onRef.current) return;
      if (typing(e) && e.key !== "Escape") return;
      const fn = ref.current[e.key] ?? ref.current[e.key.toLowerCase()];
      if (!fn) return;
      e.preventDefault();
      fn(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}

// ---------- Document viewer ----------

// pdf.js loads only when a PDF is opened, so the rest of the CRM stays small.
// Its worker is bundled with the CRM and served from it, never from a CDN. The
// "legacy" build carries polyfills: the plain build needs very new browser
// features (such as Map.prototype.getOrInsertComputed) and fails without them.
let pdfjs: Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> | null = null;
const loadPdfjs = () =>
  (pdfjs ??= Promise.all([import("pdfjs-dist/legacy/build/pdf.mjs"), import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")])
    .then(([lib, worker]) => {
      lib.GlobalWorkerOptions.workerSrc = worker.default;
      return lib;
    })
    .catch((e) => {
      pdfjs = null;
      throw e;
    }));

/** `fileProblem`: the file itself cannot be read (not the connection), so rejecting it is offered. */
type Opened = { kind: "image"; bitmap: ImageBitmap } | { kind: "pdf"; doc: PDFDocumentProxy } | { kind: "failed"; message: string; fileProblem: boolean };

const dispose = (o: Opened) => {
  if (o.kind === "image") o.bitmap.close();
  if (o.kind === "pdf") void o.doc.loadingTask.destroy();
};

/**
 * Fetches a document and prepares it for drawing. Fetching is what the server
 * records as "viewed", so this runs only for the page on screen, never ahead.
 */
async function openFile(file: ReviewFile): Promise<Opened> {
  // Only a failure while reading the file itself says the file is bad; fetching it or loading pdf.js is the connection.
  let reading = false;
  let slow = false;
  try {
    const data = await api.bytes(file.url);
    if (isPdf(file.type)) {
      const lib = await loadPdfjs();
      reading = true;
      // Drawn to a canvas only: no text, annotation, form or script layer, and
      // nothing in the file is ever run as code. pdf.js 6 dropped eval entirely;
      // isEvalSupported stays false for any older build.
      const options = {
        data: new Uint8Array(data),
        isEvalSupported: false,
        enableXfa: false,
        useWasm: false,
        wasmUrl: "/pdfjs/decoders/",
        cMapUrl: "/pdfjs/cmaps/",
        standardFontDataUrl: "/pdfjs/standard_fonts/",
        maxImageSize: PDF_MAX_IMAGE_PIXELS,
        verbosity: 0,
      } as Parameters<typeof lib.getDocument>[0];
      const task = lib.getDocument(options);
      const timer = setTimeout(() => {
        slow = true;
        void task.destroy();
      }, PDF_OPEN_MS);
      try {
        return { kind: "pdf", doc: await task.promise };
      } finally {
        clearTimeout(timer);
      }
    }
    reading = true;
    return { kind: "image", bitmap: await createImageBitmap(new Blob([data], { type: file.type === "image/heic" ? "image/jpeg" : file.type }), { imageOrientation: "from-image" }) };
  } catch (e) {
    const name = (e as { name?: string })?.name;
    const failed = (message: string, fileProblem: boolean): Opened => ({ kind: "failed", message, fileProblem });
    if (slow) return failed("This PDF took too long to open.", true);
    if (name === "PasswordException") return failed("This PDF is protected with a password.", true);
    // The server opens every PDF with this same pdf.js before sending it, so a copy that arrived intact
    // and still does not open is this browser's problem, never a reason to reject the client's file.
    if (name === "InvalidPDFException") return failed("This browser could not open the PDF, although the CRM checked that the file opens. Try again in a private window or another browser.", false);
    if (e instanceof ApiError) return failed(e.message, e.code === "UNREADABLE");
    // pdf.js starts its worker when the first file is read; a worker that fails to load is not the file's fault.
    if (!reading || (e instanceof Error && /worker/i.test(e.message))) return failed("The document could not be loaded. Check your connection and try again.", false);
    return failed("The browser could not read this file.", true);
  }
}

// The browser's pdf.js has no time or memory limit of its own (the server only sends PDFs its own,
// limited pdf.js could open): opening gives up after this long, and larger images are not drawn.
const PDF_OPEN_MS = 20_000;
const PDF_MAX_IMAGE_PIXELS = 50_000_000;

// Canvas limits that hold on every browser, Safari included.
const MAX_AREA = 16_000_000;
const MAX_SIDE = 8192;

/** One page drawn to fit the stage, then zoomed and turned; turning never clips. `onDrawn` runs each time a PDF page is on screen. */
function PageCanvas({
  opened, page, turn, zoom, box, label, onDrawn, fallback,
}: { opened: Exclude<Opened, { kind: "failed" }>; page: number; turn: number; zoom: number; box: { w: number; h: number }; label: string; onDrawn?: (page: number) => void; fallback?: ReactNode }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const drawn = useRef(onDrawn);
  drawn.current = onDrawn;
  const rotation = ((turn % 360) + 360) % 360;
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || box.w < 20 || box.h < 20) return;
    setError(null);
    let cancelled = false;
    let task: RenderTask | null = null;
    const measure = (w: number, h: number) => {
      const fit = Math.min(box.w / w, box.h / h);
      const cssW = w * fit * zoom;
      const cssH = h * fit * zoom;
      const ratio = Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_AREA / (cssW * cssH)), MAX_SIDE / Math.max(cssW, cssH));
      return { fit, cssW, cssH, ratio };
    };
    const place = (width: number, height: number, cssW: number, cssH: number) => {
      canvas.width = width;
      canvas.height = height;
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      return canvas.getContext("2d");
    };
    if (opened.kind === "image") {
      const { bitmap } = opened;
      const sideways = rotation % 180 !== 0;
      const { cssW, cssH, ratio } = measure(sideways ? bitmap.height : bitmap.width, sideways ? bitmap.width : bitmap.height);
      const cw = Math.max(1, Math.round(cssW * ratio));
      const ch = Math.max(1, Math.round(cssH * ratio));
      const ctx = place(cw, ch, cssW, cssH);
      if (!ctx) return;
      ctx.imageSmoothingQuality = "high";
      ctx.translate(cw / 2, ch / 2);
      ctx.rotate((rotation * Math.PI) / 180);
      const [dw, dh] = sideways ? [ch, cw] : [cw, ch];
      ctx.drawImage(bitmap, -dw / 2, -dh / 2, dw, dh);
      return;
    }
    void (async () => {
      try {
        const p = await opened.doc.getPage(page);
        if (cancelled) return;
        const pageRotation = (p.rotate + rotation) % 360;
        const base = p.getViewport({ scale: 1, rotation: pageRotation });
        const { fit, cssW, cssH, ratio } = measure(base.width, base.height);
        const viewport = p.getViewport({ scale: fit * zoom * ratio, rotation: pageRotation });
        // Draw off screen first, so zooming does not flash a blank page.
        const off = document.createElement("canvas");
        off.width = Math.max(1, Math.floor(viewport.width));
        off.height = Math.max(1, Math.floor(viewport.height));
        task = p.render({ canvas: off, viewport });
        await task.promise;
        if (cancelled) return;
        place(off.width, off.height, cssW, cssH)?.drawImage(off, 0, 0);
        off.width = off.height = 0;
        drawn.current?.(page);
      } catch (e) {
        if (!cancelled && (e as { name?: string })?.name !== "RenderingCancelledException") setError(`Page ${page} could not be shown.`);
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [opened, page, rotation, zoom, box.w, box.h, attempt]);
  return (
    <>
      {error && (
        <div className="viewer-file">
          <AlertTriangle size={40} />
          <strong>{error}</strong>
          <span className="actions">
            <button type="button" className="button" onClick={() => setAttempt((a) => a + 1)}>
              Try again
            </button>
            {fallback}
          </span>
        </div>
      )}
      {/* Kept while the error shows, so the next page, zoom or turn draws again. */}
      <canvas ref={ref} className="viewer-page" role="img" aria-label={label} style={error ? { display: "none" } : undefined} />
    </>
  );
}

/**
 * Large document viewer: photos and PDFs drawn to fit, with zoom, rotate,
 * full screen, front/back and page switching. Tabs show which documents are not
 * opened yet. A photo counts as opened once it is on screen (`onViewed`); a PDF
 * page by page (`onPageViewed`). Documents are only ever drawn inside the page:
 * nothing is offered to open in a tab or save, except the audited download.
 */
export function DocumentViewer({
  files, viewed, pagesSeen, onViewed, onPageViewed, onDownload, onUnreadable, banner,
}: {
  files: ReviewFile[];
  viewed?: ReadonlySet<number>;
  /** PDF pages already seen, by file: later pages not seen yet get a dot on "Next page". */
  pagesSeen?: ReadonlyMap<number, ReadonlySet<number>>;
  onViewed?: (fileId: number) => void;
  onPageViewed?: (fileId: number, page: number, pages: number) => void;
  /** Saves the original file; given only to staff who may download documents. */
  onDownload?: (file: ReviewFile) => void;
  /** Starts rejecting the submission as unreadable, offered when a document cannot be shown. */
  onUnreadable?: () => void;
  banner?: ReactNode;
}) {
  const [index, setIndex] = useState(0);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [turn, setTurn] = useState(0);
  const [opened, setOpened] = useState<Record<number, Opened>>({});
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [shortcutsOn] = useShortcutsSetting();
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);
  const canFullscreen = typeof document !== "undefined" && document.fullscreenEnabled;
  const loading = useRef(new Set<number>());
  const all = useRef(opened);
  all.current = opened;
  const alive = useRef(true);
  const viewedRef = useRef(onViewed);
  viewedRef.current = onViewed;
  const pageViewedRef = useRef(onPageViewed);
  pageViewedRef.current = onPageViewed;
  // A different set of files (such as the client's other document) starts at its first page.
  // Reset while rendering, so a page from the old position is never fetched by mistake.
  const filesKey = files.map((f) => f.id).join(",");
  const [shownKey, setShownKey] = useState(filesKey);
  if (shownKey !== filesKey) {
    setShownKey(filesKey);
    setIndex(0);
    setPage(1);
  }
  const file = files[shownKey === filesKey ? Math.min(index, files.length - 1) : 0];
  const current = file ? opened[file.id] : undefined;
  const pages = current?.kind === "pdf" ? current.doc.numPages : 1;
  const unseenAhead = Boolean(file && pagesSeen && !viewed?.has(file.id) && Array.from({ length: pages - page }, (_, i) => page + 1 + i).some((p) => !pagesSeen.get(file.id)?.has(p)));

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      Object.values(all.current).forEach(dispose);
    };
  }, []);
  useEffect(() => {
    setZoom(1);
    setTurn(0);
  }, [file?.id]);
  useEffect(() => {
    const onChange = () => setFull(!!root.current && document.fullscreenElement === root.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void root.current?.requestFullscreen().catch(() => undefined);
  };
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => entry && setBox({ w: Math.floor(entry.contentRect.width), h: Math.floor(entry.contentRect.height) }));
    observer.observe(el);
    return () => observer.disconnect();
  }, [Boolean(file)]);
  // Open the document on screen (only that one: opening is what gets recorded as viewed).
  useEffect(() => {
    if (!file || !(isPdf(file.type) || isImage(file.type)) || opened[file.id] || loading.current.has(file.id)) return;
    loading.current.add(file.id);
    void openFile(file).then((o) => {
      loading.current.delete(file.id);
      if (!alive.current) return dispose(o);
      setOpened((prev) => ({ ...prev, [file.id]: o }));
    });
  }, [file, opened]);
  // A photo counts as opened once it is on screen; PDF pages are counted as they are drawn.
  useEffect(() => {
    if (file && current?.kind === "image") viewedRef.current?.(file.id);
  }, [file?.id, current]);

  const step = (dir: number) => setZoom((z) => Math.min(4, Math.max(0.5, Math.round((z + dir * 0.25) * 100) / 100)));
  const go = (dir: 1 | -1) => {
    if (dir === 1 && page < pages) return setPage(page + 1);
    if (dir === -1 && page > 1) return setPage(page - 1);
    if (files.length < 2) return;
    const next = (index + dir + files.length) % files.length;
    const o = opened[files[next]!.id];
    setIndex(next);
    setPage(dir === -1 && o?.kind === "pdf" ? o.doc.numPages : 1);
  };
  const retry = (id: number) =>
    setOpened((prev) => {
      const { [id]: _, ...rest } = prev;
      return rest;
    });
  useShortcuts({
    "+": () => step(1),
    "=": () => step(1),
    "-": () => step(-1),
    "0": () => (setZoom(1), setTurn(0)),
    "[": () => setTurn((t) => t - 90),
    "]": () => setTurn((t) => t + 90),
    ArrowRight: () => go(1),
    ArrowLeft: () => go(-1),
    f: () => canFullscreen && toggleFull(),
  }, true, root);

  // Drag to move around a zoomed page with the mouse; touch screens scroll natively.
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = stage.current;
    if (!el || e.pointerType !== "mouse" || e.button !== 0 || (el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight)) return;
    drag.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
    el.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = stage.current;
    if (!el || !drag.current) return;
    el.scrollLeft = drag.current.left - (e.clientX - drag.current.x);
    el.scrollTop = drag.current.top - (e.clientY - drag.current.y);
  };
  const endDrag = () => {
    drag.current = null;
  };

  if (!file) return <div className="viewer viewer-empty muted">No documents were attached.</div>;
  const drawable = current && current.kind !== "failed";
  const rejectButton = onUnreadable && (
    <button
      type="button"
      className="button button-danger"
      onClick={() => {
        // The reason is filled in beside the document, so leave full screen first.
        if (full) toggleFull();
        onUnreadable();
      }}
    >
      <X size={15} /> Reject as unreadable
    </button>
  );
  const saveButton = onDownload && (
    <button type="button" className="button button-ghost" onClick={() => onDownload(file)}>
      <Download size={15} /> Download the original
    </button>
  );
  return (
    <div className="viewer" ref={root}>
      <div className="viewer-bar">
        {files.length > 1 && (
          <div className="viewer-pages" role="tablist" aria-label="Documents">
            {files.map((f, i) => {
              const unseen = viewed && !viewed.has(f.id);
              return (
                <button
                  key={f.id}
                  type="button"
                  role="tab"
                  aria-selected={i === index}
                  className={i === index ? "active" : ""}
                  onClick={() => (setIndex(i), setPage(1))}
                  title={unseen ? "Not opened yet" : undefined}
                >
                  {f.label}
                  {unseen && (
                    <>
                      <span className="viewer-dot" aria-hidden />
                      <span className="sr-only">(not opened yet)</span>
                    </>
                  )}
                </button>
              );
            })}
          </div>
        )}
        {pages > 1 && (
          <span className="viewer-paging">
            <button type="button" className="icon-button" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              <ChevronLeft size={17} />
            </button>
            <span>
              Page {page} of {pages}
            </span>
            <button
              type="button"
              className="icon-button"
              aria-label={unseenAhead ? "Next page (not opened yet)" : "Next page"}
              title={unseenAhead ? "The next pages are not opened yet" : undefined}
              disabled={page >= pages}
              onClick={() => setPage(page + 1)}
            >
              <ChevronRight size={17} />
              {unseenAhead && <span className="viewer-dot" aria-hidden />}
            </button>
          </span>
        )}
        <span className="muted viewer-meta">
          {isPdf(file.type) ? "PDF · " : ""}
          {file.bytes > 0 ? kb(file.bytes) : ""}
        </span>
        {drawable && (
          <span className="viewer-tools">
            <button type="button" className="icon-button" title="Zoom out (−)" aria-label="Zoom out" onClick={() => step(-1)}>
              <ZoomOut size={17} />
            </button>
            <button type="button" className="viewer-zoom" title="Fit to the screen (0)" onClick={() => (setZoom(1), setTurn(0))}>
              {zoom === 1 ? "Fit" : `${Math.round(zoom * 100)}%`}
            </button>
            <button type="button" className="icon-button" title="Zoom in (+)" aria-label="Zoom in" onClick={() => step(1)}>
              <ZoomIn size={17} />
            </button>
            <button type="button" className="icon-button" title="Turn left ([)" aria-label="Turn left" onClick={() => setTurn((t) => t - 90)}>
              <RotateCcw size={17} />
            </button>
            <button type="button" className="icon-button" title="Turn right (])" aria-label="Turn right" onClick={() => setTurn((t) => t + 90)}>
              <RotateCw size={17} />
            </button>
            {canFullscreen && (
              <button type="button" className="icon-button" title={full ? "Leave full screen (F)" : "Full screen (F)"} aria-label={full ? "Leave full screen" : "Full screen"} onClick={toggleFull}>
                {full ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
              </button>
            )}
            {onDownload && (
              <button type="button" className="icon-button" title="Download the original (recorded in the audit log)" aria-label="Download the original" onClick={() => onDownload(file)}>
                <Download size={17} />
              </button>
            )}
          </span>
        )}
      </div>
      {banner && <div className="viewer-banner">{banner}</div>}
      <div
        ref={stage}
        className={zoom > 1 ? "viewer-stage zoomed" : "viewer-stage"}
        onWheel={(e) => e.ctrlKey && (e.preventDefault(), step(e.deltaY < 0 ? 1 : -1))}
        onDoubleClick={() => drawable && setZoom((z) => (z === 1 ? 2 : 1))}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        // No "Save image as" on a drawn page: originals leave the CRM only through the audited download.
        onContextMenu={(e) => e.preventDefault()}
      >
        {!isPdf(file.type) && !isImage(file.type) ? (
          <div className="viewer-file">
            <FileText size={44} />
            <strong>This type of file cannot be shown here</strong>
            <span className="muted">Ask the client for a photo or a PDF instead.</span>
            {(rejectButton || saveButton) && (
              <span className="actions">
                {rejectButton}
                {saveButton}
              </span>
            )}
          </div>
        ) : !current ? (
          <div className="viewer-note muted">
            <Spinner /> Opening the document…
          </div>
        ) : current.kind === "failed" ? (
          <div className="viewer-file">
            <AlertTriangle size={40} />
            <strong>This document could not be shown</strong>
            <span className="muted">
              {current.message}
              {current.fileProblem && rejectButton ? " If it still does not open, reject it so the client sends it again." : ""}
            </span>
            <span className="actions">
              <button type="button" className="button" onClick={() => retry(file.id)}>
                Try again
              </button>
              {current.fileProblem && rejectButton}
              {saveButton}
            </span>
          </div>
        ) : (
          <PageCanvas
            key={file.id}
            opened={current}
            page={Math.min(page, pages)}
            turn={turn}
            zoom={zoom}
            box={box}
            label={pages > 1 ? `${file.label}, page ${page} of ${pages}` : file.label}
            onDrawn={current.kind === "pdf" ? (p) => pageViewedRef.current?.(file.id, p, pages) : undefined}
            fallback={
              <>
                {rejectButton}
                {saveButton}
              </>
            }
          />
        )}
      </div>
      {shortcutsOn && <p className="muted tight viewer-hint shortcut-hint">← → pages · + − zoom · 0 fit · [ ] turn · F full screen · double-click to zoom, drag to move</p>}
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
          <span>
            {w.text}
            {w.href && (
              <>
                {" "}
                <a href={w.href} target="_blank" rel="noreferrer">
                  {w.linkLabel ?? "Open"}
                </a>
              </>
            )}
          </span>
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
  /** Whether this reviewer may approve or reject right now. */
  canDecide: boolean;
  blockedText?: string | null;
  /** Why approving is not possible (rejecting still is). */
  approveBlocked?: string | null;
  /** What the reviewer has not opened yet, ready to read ("the back", "page 2 of the document"); approving waits for them. */
  unopened?: string[];
  /** Something the reviewer still has to do before approving, such as a field to fill in; shown as a hint, not a warning. */
  approveHint?: string | null;
  /** Approving needs an internal note, for this reason (the note box opens). */
  noteRequired?: string | null;
  /** Why rejecting is not possible (approving may still be). */
  rejectBlocked?: string | null;
  /** An example for the internal note box. */
  notePlaceholder?: string;
  approveLabel?: string;
  /** Whether a decision opens the next item (default yes); false for staff who may only reject, who go back to the list. */
  continues?: boolean;
  /** Opens the rejection with this reason filled in; each new `key` opens it again. */
  rejectWith?: { reason: string; key: number } | null;
  /** Extra rules for the reason, such as what the app can show. */
  reasonRule?: (reason: string) => string | null;
  /** What to fill in before approving (what the payment showed, the IB level), between the checklist and the buttons. */
  fields?: ReactNode;
  /** Other steps while the item is in review (send back), under the buttons. */
  secondaryActions?: ReactNode;
  /** The line about 2FA and the audit log, at the bottom. */
  footnote?: ReactNode;
  /** False when there is no document viewer, so the shortcut help leaves out its keys. */
  hasDocuments?: boolean;
  /** Label above the rejection reason. */
  reasonLabel?: string;
  onApprove: (ticked: string[], internalNote?: string) => void;
  onReject: (reason: string, ticked: string[], internalNote?: string) => void;
  onSkip?: () => void;
  onBack?: () => void;
  resetKey: string | number;
}

/** Checklist, approve and reject with ready-made reasons, and an optional note for staff. */
export function ReviewDecision(props: ReviewDecisionProps) {
  const { checklist, reasons, busy, canDecide } = props;
  const unopened = props.unopened ?? [];
  const hasDocuments = props.hasDocuments ?? true;
  const [ticked, setTicked] = useState<string[]>([]);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [help, setHelp] = useState(false);
  const [keysOn, setKeysOn] = useShortcutsSetting();
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    setTicked([]);
    setRejecting(false);
    setReason("");
    setNote("");
    setNoteOpen(false);
  }, [props.resetKey]);
  useEffect(() => {
    if (rejecting) reasonRef.current?.focus();
  }, [rejecting]);
  const rejectWith = props.rejectWith;
  useEffect(() => {
    if (!rejectWith || !canDecide) return;
    setReason(rejectWith.reason);
    setRejecting(true);
    reasonRef.current?.focus();
  }, [rejectWith?.key]);
  const noteRequired = props.noteRequired ?? null;
  useEffect(() => {
    if (noteRequired) setNoteOpen(true);
  }, [noteRequired]);
  const allTicked = checklist.every((c) => ticked.includes(c.key));
  const internalNote = note.trim() || undefined;
  const noteMissing = Boolean(noteRequired && !internalNote);
  const mayApprove = canDecide && !props.approveBlocked && unopened.length === 0 && !props.approveHint && !noteMissing;
  const mayReject = canDecide && !props.rejectBlocked;
  const noteProblem = plainProblem(note, "note");
  const reasonProblem = plainProblem(reason, "reason") ?? props.reasonRule?.(reason) ?? null;
  const toggle = (key: string) => setTicked((t) => (t.includes(key) ? t.filter((k) => k !== key) : [...t, key]));
  const approve = () => allTicked && !busy && mayApprove && !noteProblem && props.onApprove(ticked, internalNote);
  const reject = () => reason.trim().length >= 5 && !reasonProblem && !noteProblem && !busy && mayReject && props.onReject(reason.trim(), ticked, internalNote);
  const keys: Record<string, (e: KeyboardEvent) => void> = {
    a: approve,
    r: () => mayReject && !busy && setRejecting(true),
    s: () => !busy && props.onSkip?.(),
    "?": () => setHelp(true),
    Escape: (e) => {
      if (rejecting) setRejecting(false);
      else if (typing(e)) (e.target as HTMLElement).blur();
      else props.onBack?.();
    },
    // Ticking everything at once only makes sense after every document was looked at.
    c: () => canDecide && unopened.length === 0 && setTicked(allTicked ? [] : checklist.map((c) => c.key)),
  };
  checklist.forEach((c, i) => (keys[String(i + 1)] = () => canDecide && toggle(c.key)));
  useShortcuts(keys, !help);
  const k = (key: string) => keysOn && <kbd>{key}</kbd>;

  return (
    <div className="review-decision">
      <div className="card-head">
        <h3 className="flush">Before you decide</h3>
        <button type="button" className="button button-ghost button-small shortcut-hint" onClick={() => setHelp(true)} title="Keyboard shortcuts (?)">
          <Keyboard size={15} /> Shortcuts
        </button>
      </div>
      <ul className="review-checklist">
        {checklist.map((c, i) => (
          <li key={c.key}>
            <label>
              <input type="checkbox" checked={ticked.includes(c.key)} onChange={() => toggle(c.key)} disabled={!canDecide} />
              <span>{c.label}</span>
              {k(String(i + 1))}
            </label>
          </li>
        ))}
      </ul>
      {props.blockedText && <p className="notice notice-warn tight">{props.blockedText}</p>}
      {props.fields}
      {canDecide &&
        (noteOpen ? (
          <label className="review-note">
            <span className="field-label">Internal note for staff (never shown to the client)</span>
            <textarea className="input" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder={props.notePlaceholder ?? "For example: asked a colleague to check the address"} autoFocus />
            {noteProblem && <small className="error-text">{noteProblem}</small>}
          </label>
        ) : (
          <button type="button" className="button-link review-note-toggle" onClick={() => setNoteOpen(true)}>
            Add an internal note
          </button>
        ))}
      <DecisionError error={props.error} />
      {rejecting ? (
        <form
          className="review-reject"
          onSubmit={(e) => {
            e.preventDefault();
            reject();
          }}
        >
          <span className="field-label">{props.reasonLabel ?? "Reason the client will see"}</span>
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
          {reasonProblem && <small className="error-text">{reasonProblem}</small>}
          <div className="actions">
            <button type="button" className="button" onClick={() => setRejecting(false)}>
              Back <kbd>Esc</kbd>
            </button>
            <button type="submit" className="button button-danger-solid" disabled={busy || reason.trim().length < 5 || !!reasonProblem || !!noteProblem}>
              {busy && <Spinner />} Reject{props.continues === false ? "" : " and next"} <kbd>Ctrl ↵</kbd>
            </button>
          </div>
        </form>
      ) : (
        <div className="review-buttons">
          <button type="button" className="button button-primary button-big" disabled={!mayApprove || !allTicked || busy || !!noteProblem} onClick={approve} title={allTicked ? undefined : "Tick every check first"}>
            {busy ? <Spinner /> : <Check size={17} />} {props.approveLabel ?? "Approve and next"} {k("A")}
          </button>
          <div className="review-buttons-row">
            <button type="button" className="button button-danger" disabled={!mayReject || busy} onClick={() => setRejecting(true)} title={canDecide && props.rejectBlocked ? props.rejectBlocked : undefined}>
              <X size={15} /> Reject {k("R")}
            </button>
            {props.onSkip && (
              <button type="button" className="button" disabled={busy} onClick={props.onSkip}>
                <SkipForward size={15} /> Skip {k("S")}
              </button>
            )}
          </div>
          {canDecide && props.approveBlocked ? (
            <p className="notice notice-warn tight">{props.approveBlocked}</p>
          ) : canDecide && unopened.length > 0 ? (
            <p className="muted tight">Open {listOf(unopened)} before approving.</p>
          ) : canDecide && props.approveHint ? (
            <p className="muted tight">{props.approveHint}</p>
          ) : canDecide && noteMissing ? (
            <p className="muted tight">{noteRequired}</p>
          ) : (
            !allTicked &&
            canDecide && (
              <p className="muted tight">
                Tick every check to approve{keysOn && <span className="shortcut-hint">, or press C to tick them all {hasDocuments ? "after checking" : "once you have checked"}</span>}.
              </p>
            )
          )}
          {canDecide && props.rejectBlocked && <p className="muted tight">{props.rejectBlocked}</p>}
        </div>
      )}
      {props.secondaryActions}
      {props.footnote}
      <Dialog open={help} title="Keyboard shortcuts" onClose={() => setHelp(false)}>
        <label className="check shortcut-toggle">
          <input type="checkbox" checked={keysOn} onChange={(e) => setKeysOn(e.target.checked)} />
          <span>
            Use single-key shortcuts
            <small className="muted block">The letters, numbers and symbols below. Esc and the arrow keys always work.</small>
          </span>
        </label>
        <dl className="details shortcuts">
          <dt><kbd>A</kbd></dt><dd>Approve and open the next item</dd>
          <dt><kbd>R</kbd></dt><dd>Reject (pick or write a reason, then Ctrl + Enter)</dd>
          <dt><kbd>S</kbd></dt><dd>Skip to the next item</dd>
          <dt><kbd>1</kbd>–<kbd>{checklist.length}</kbd></dt><dd>Tick a check</dd>
          <dt><kbd>C</kbd></dt><dd>{hasDocuments ? "Tick or untick every check, once every document is open" : "Tick or untick every check"}</dd>
          {hasDocuments && (
            <>
              <dt><kbd>←</kbd> <kbd>→</kbd></dt><dd>Pages, front and back of the document</dd>
              <dt><kbd>+</kbd> <kbd>−</kbd> <kbd>0</kbd></dt><dd>Zoom in, out, fit to the screen</dd>
              <dt><kbd>[</kbd> <kbd>]</kbd></dt><dd>Turn left or right</dd>
              <dt><kbd>F</kbd></dt><dd>Show the document full screen, or leave full screen</dd>
            </>
          )}
          <dt><kbd>Esc</kbd></dt><dd>Back to the queue</dd>
        </dl>
      </Dialog>
    </div>
  );
}

/** Page frame: back link, title, queue position, evidence left, decision right. */
export function ReviewLayout({ title, subtitle, position, headExtra, onBack, evidence, side }: { title: ReactNode; subtitle?: ReactNode; position?: string; headExtra?: ReactNode; onBack: () => void; evidence: ReactNode; side: ReactNode }) {
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
        {headExtra}
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
