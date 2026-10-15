import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { api, setCsrf } from "../lib/api";
import { CopyBox, ErrorText, Field } from "../components/ui";

type LoginStep =
  | { step: "password" }
  | { step: "totp"; challenge: string }
  | { step: "enroll"; challenge: string; secret: string; otpauthUrl: string };

export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [state, setState] = useState<LoginStep>({ step: "password" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [qr, setQr] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (state.step === "enroll") QRCode.toDataURL(state.otpauthUrl, { margin: 1, width: 200 }).then(setQr, () => setQr(""));
  }, [state]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <div className="login-card">
        <h1>BIS Markets CRM</h1>
        {state.step === "password" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const res = await api.post<LoginStep & { step: "totp" | "enroll" }>("/api/staff/auth/login", { email, password });
                setPassword("");
                setCode("");
                setState(res);
              });
            }}
          >
            <p className="muted">Staff sign-in</p>
            <Field label="Email">
              <input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            </Field>
            <Field label="Password">
              <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </Field>
            <ErrorText error={error} />
            <button type="submit" className="button button-primary button-block" disabled={busy}>
              Continue
            </button>
          </form>
        )}
        {state.step !== "password" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const res = await api.post<{ csrfToken: string }>("/api/staff/auth/verify", { challenge: state.challenge, code });
                setCsrf(res.csrfToken);
                onSignedIn();
              });
            }}
          >
            {state.step === "enroll" ? (
              <>
                <p>Two-factor sign-in is required for every staff account. Scan this code with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password or similar), then enter the 6-digit code it shows.</p>
                {qr && <img className="qr" src={qr} alt="Authenticator setup code" width={200} height={200} />}
                <p className="muted">Can't scan? Enter this key instead:</p>
                <CopyBox value={state.secret} />
              </>
            ) : (
              <p>Enter the 6-digit code from your authenticator app.</p>
            )}
            <Field label="6-digit code">
              <input className="input" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
            </Field>
            <ErrorText error={error} />
            <button type="submit" className="button button-primary button-block" disabled={busy}>
              {state.step === "enroll" ? "Turn on 2FA and sign in" : "Sign in"}
            </button>
            <button type="button" className="button button-link" onClick={() => setState({ step: "password" })}>
              Start again
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
