import { useEffect, useRef, useState } from "react";
import { api, onStepUpRequired } from "../lib/api";
import { Dialog, ErrorText, Field } from "./ui";

/**
 * Listens for STEP_UP_REQUIRED from any API call, asks for a 2FA code, and
 * lets the original request retry once the code is accepted.
 */
export function StepUpHost() {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  useEffect(() => {
    onStepUpRequired(
      () =>
        new Promise<boolean>((resolve) => {
          resolver.current = resolve;
          setCode("");
          setError(null);
          setOpen(true);
        }),
    );
    return () => onStepUpRequired(null);
  }, []);

  const finish = (ok: boolean) => {
    setOpen(false);
    resolver.current?.(ok);
    resolver.current = null;
  };

  return (
    <Dialog open={open} title="Confirm with 2FA" onClose={() => finish(false)}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api.post("/api/staff/auth/step-up", { code });
            finish(true);
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>This action needs a fresh code from your authenticator app.</p>
        <Field label="6-digit code">
          <input className="input" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} autoFocus required />
        </Field>
        <ErrorText error={error} />
        <div className="actions">
          <button type="button" className="button" onClick={() => finish(false)}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={busy}>
            Confirm
          </button>
        </div>
      </form>
    </Dialog>
  );
}
