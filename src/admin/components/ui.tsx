import { AlertTriangle, Check, CheckCircle2, Copy, Eye, EyeOff, Info, Laptop, Loader2, Moon, Sun, X, XCircle } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useTheme, type ThemePreference } from "../lib/theme";

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
          <X size={18} />
        </button>
      </header>
      {open && <div className="dialog-body">{children}</div>}
    </dialog>
  );
}

export const ErrorText = ({ error }: { error: unknown }) =>
  error ? (
    <p className="error-text" role="alert">
      {error instanceof Error ? error.message : String(error)}
    </p>
  ) : null;

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export type Tone = "good" | "warn" | "bad" | "info" | "neutral";
export const Badge = ({ tone, children }: { tone: Tone; children: ReactNode }) => <span className={`badge badge-${tone}`}>{children}</span>;

export const Spinner = ({ size = 16 }: { size?: number }) => <Loader2 size={size} className="spin" aria-hidden />;

export function CopyBox({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-box">
      <code>{value}</code>
      <button
        type="button"
        className="button button-small"
        onClick={async () => {
          await navigator.clipboard?.writeText(value).catch(() => undefined);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        }}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function PageHeader({ title, description, actions, badge }: { title: string; description?: ReactNode; actions?: ReactNode; badge?: ReactNode }) {
  return (
    <div className="page-head">
      <div className="page-head-text">
        <h1>
          {title} {badge}
        </h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      {icon}
      <strong>{title}</strong>
      {children && <span>{children}</span>}
    </div>
  );
}

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";

export function Avatar({ name, src, large, xl }: { name: string; src?: string | null; large?: boolean; xl?: boolean }) {
  const [broken, setBroken] = useState<string | null>(null);
  const cls = `avatar${large ? " avatar-lg" : ""}${xl ? " avatar-xl" : ""}`;
  return (
    <span className={cls} aria-hidden>
      {src && broken !== src ? <img src={src} alt="" onError={() => setBroken(src)} /> : initials(name)}
    </span>
  );
}

export function PasswordInput(props: Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">) {
  const [show, setShow] = useState(false);
  return (
    <span className="password-wrap">
      <input {...props} type={show ? "text" : "password"} className="input" />
      <button type="button" className="password-toggle" onClick={() => setShow(!show)} aria-label={show ? "Hide password" : "Show password"}>
        {show ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </span>
  );
}

const THEME_OPTIONS: { value: ThemePreference; label: string; icon: ReactNode }[] = [
  { value: "light", label: "Light", icon: <Sun size={15} /> },
  { value: "system", label: "System", icon: <Laptop size={15} /> },
  { value: "dark", label: "Dark", icon: <Moon size={15} /> },
];

export function ThemeSwitch() {
  const { preference, setPreference } = useTheme();
  return (
    <div className="segmented" role="group" aria-label="Theme">
      {THEME_OPTIONS.map((o) => (
        <button key={o.value} type="button" aria-pressed={preference === o.value} title={`${o.label} theme`} onClick={() => setPreference(o.value)}>
          {o.icon}
          <span className="sr-only">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

// ---------- Toasts and confirmations ----------

interface ToastItem {
  id: number;
  tone: "good" | "bad";
  text: string;
}

interface ConfirmOptions {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
}

interface Feedback {
  toast: (text: string, tone?: "good" | "bad") => void;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

const FeedbackContext = createContext<Feedback | null>(null);

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [pending, setPending] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);
  const nextId = useRef(1);

  const toast = useCallback((text: string, tone: "good" | "bad" = "good") => {
    // Toasts cannot show over a full-screen document, and a problem must be seen.
    if (tone === "bad" && document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    const id = nextId.current++;
    setToasts((list) => [...list, { id, tone, text }]);
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 4500);
  }, []);
  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>((resolve) => setPending({ ...options, resolve })), []);
  const settle = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };

  return (
    <FeedbackContext.Provider value={{ toast, confirm }}>
      {children}
      <Dialog open={pending !== null} title={pending?.title ?? ""} onClose={() => settle(false)}>
        {pending && (
          <>
            <div className={pending.danger ? "confirm-icon" : "confirm-icon neutral"}>{pending.danger ? <AlertTriangle size={20} /> : <Info size={20} />}</div>
            <div className="muted">{pending.body}</div>
            <div className="actions">
              <button type="button" className="button" onClick={() => settle(false)}>
                Cancel
              </button>
              <button type="button" className={pending.danger ? "button button-danger-solid" : "button button-primary"} onClick={() => settle(true)} autoFocus>
                {pending.confirmLabel}
              </button>
            </div>
          </>
        )}
      </Dialog>
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>
            {t.tone === "good" ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
            <p>{t.text}</p>
            <button type="button" className="icon-button" aria-label="Dismiss" onClick={() => setToasts((list) => list.filter((x) => x.id !== t.id))}>
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </FeedbackContext.Provider>
  );
}

export function useFeedback(): Feedback {
  const value = useContext(FeedbackContext);
  if (!value) throw new Error("useFeedback outside FeedbackProvider");
  return value;
}
