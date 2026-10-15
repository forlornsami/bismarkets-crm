import { useState } from "react";
import { api } from "../lib/api";
import { ErrorText, Field } from "../components/ui";

export function ChangePassword({ forced, onDone }: { forced: boolean; onDone: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  return (
    <form
      className={forced ? "login-card" : "panel narrow"}
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
          setDone(true);
          onDone();
        } catch (err) {
          setError(err);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2>{forced ? "Set your own password" : "Change password"}</h2>
      {forced && <p>You signed in with a temporary password. Choose your own before continuing.</p>}
      <Field label="Current password">
        <input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </Field>
      <Field label="New password" hint="At least 12 characters. A short sentence works well.">
        <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={12} />
      </Field>
      <Field label="Repeat new password">
        <input className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
      </Field>
      <ErrorText error={error} />
      {done && !forced && <p className="success-text">Password changed. Your other sessions were signed out.</p>}
      <button type="submit" className="button button-primary" disabled={busy}>
        Save password
      </button>
    </form>
  );
}
