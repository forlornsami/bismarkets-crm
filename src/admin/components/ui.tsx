import { useEffect, useRef, type ReactNode } from "react";

export function Dialog({ open, title, onClose, children, wide }: { open: boolean; title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog ref={ref} className={wide ? "dialog dialog-wide" : "dialog"} onClose={onClose} onCancel={onClose}>
      <header className="dialog-head">
        <h2>{title}</h2>
        <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </header>
      {open && <div className="dialog-body">{children}</div>}
    </dialog>
  );
}

export const ErrorText = ({ error }: { error: unknown }) =>
  error ? <p className="error-text" role="alert">{error instanceof Error ? error.message : String(error)}</p> : null;

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export const Badge = ({ tone, children }: { tone: "good" | "warn" | "bad" | "neutral"; children: ReactNode }) => (
  <span className={`badge badge-${tone}`}>{children}</span>
);

export function CopyBox({ value }: { value: string }) {
  return (
    <div className="copy-box">
      <code>{value}</code>
      <button type="button" className="button button-small" onClick={() => navigator.clipboard?.writeText(value)}>
        Copy
      </button>
    </div>
  );
}
