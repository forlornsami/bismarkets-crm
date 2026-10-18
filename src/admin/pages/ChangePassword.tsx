import { useState } from "react";
import { ErrorText, Field, PasswordInput, Spinner, useFeedback } from "../components/ui";
import { api } from "../lib/api";

/** A rough guide only; the server enforces the real rules and checks known breaches. */
function strength(pw: string): number {
  if (pw.length === 0) return 0;
  let score = pw.length >= 12 ? 2 : 1;
  if (pw.length >= 16) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw) && /\d/.test(pw)) score++;
  return Math.min(score, 4);
}
const STRENGTH_LABEL = ["", "Too short", "Fair", "Good", "Strong"];

export function ChangePassword({ forced, onDone }: { forced: boolean; onDone: () => void }) {
  const { toast } = useFeedback();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const score = strength(next);

  return (
    <form
      className={forced ? "auth-form" : "panel narrow"}
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        if (next !== confirm) return setError(new Error("The two new passwords do not match."));
        setBusy(true);
        try {
          await api.post("/api/staff/auth/password", { currentPassword: current, newPassword: next });
          setCurrent("");
          setNext("");
          setConfirm("");
          if (!forced) toast("Password changed. Your other sessions were signed out.");
          onDone();
        } catch (err) {
          setError(err);
        } finally {
          setBusy(false);
        }
      }}
    >
      {forced ? (
        <>
          <h1>Choose your password</h1>
          <p className="lead">You signed in with a temporary password. Set your own before continuing.</p>
        </>
      ) : (
        <div className="card-head">
          <div>
            <h2>Change password</h2>
            <p>Changing it signs you out everywhere else.</p>
          </div>
        </div>
      )}
      <Field label={forced ? "Temporary password" : "Current password"}>
        <PasswordInput autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </Field>
      <Field
        label="New password"
        hint={
          <>
            <span className="strength" data-score={score} aria-hidden>
              <span />
              <span />
              <span />
              <span />
            </span>
            {next ? STRENGTH_LABEL[score] : "At least 12 characters. A short sentence works well."}
          </>
        }
      >
        <PasswordInput autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={12} />
      </Field>
      <Field label="Repeat new password">
        <PasswordInput autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
      </Field>
      <ErrorText error={error} />
      <button type="submit" className={forced ? "button button-primary button-block" : "button button-primary"} disabled={busy}>
        {busy && <Spinner />} Save password
      </button>
    </form>
  );
}
