import { ArrowLeft, Fingerprint, KeyRound, Lock, ScrollText, ShieldCheck } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { CopyBox, ErrorText, Field, PasswordInput, Spinner, ThemeSwitch } from "../components/ui";
import { api, setCsrf } from "../lib/api";
import { BRANDING_DEFAULTS, useBranding, useLogo } from "../lib/branding";

type LoginStep =
  | { step: "password" }
  | { step: "totp"; challenge: string }
  | { step: "enroll"; challenge: string; secret: string; otpauthUrl: string };

/** The sign-in screen layout, also used for the forced password change. */
export function AuthScreen({ children }: { children: React.ReactNode }) {
  const logo = useLogo();
  const darkLogo = (useBranding().data ?? BRANDING_DEFAULTS).logoDark.url;
  return (
    <div className="auth">
      <aside className="auth-aside">
        <img className="auth-aside-logo" src={darkLogo} alt="BIS CRM" />
        <div className="auth-pitch">
          <h2>The back office for BIS Markets.</h2>
          <p>Clients, KYC, deposits, withdrawals, MT5 accounts and IB partners, in one secure place.</p>
          <ul className="auth-points">
            <li>
              <ShieldCheck size={18} /> Two-factor sign-in for every staff account
            </li>
            <li>
              <Fingerprint size={18} /> Role-based permissions checked on every request
            </li>
            <li>
              <ScrollText size={18} /> Tamper-evident audit log of every action
            </li>
          </ul>
        </div>
        <div className="auth-foot">© {new Date().getFullYear()} BIS Markets. Authorised staff only.</div>
      </aside>
      <main className="auth-main">
        <div className="auth-top">
          <img className="auth-mobile-logo" src={logo} alt="BIS CRM" />
          <span />
          <ThemeSwitch />
        </div>
        <div className="auth-form-wrap">{children}</div>
      </main>
    </div>
  );
}

export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [state, setState] = useState<LoginStep>({ step: "password" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [qr, setQr] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (state.step === "enroll") QRCode.toDataURL(state.otpauthUrl, { margin: 0, width: 180 }).then(setQr, () => setQr(""));
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

  const stepIndex = state.step === "password" ? 1 : 2;

  return (
    <AuthScreen>
      <div className="auth-form">
        <div className="steps" aria-hidden>
          <span className="on" />
          <span className={stepIndex >= 2 ? "on" : ""} />
        </div>
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
            <h1>Sign in</h1>
            <p className="lead">Use your BIS Markets staff account.</p>
            <Field label="Work email">
              <input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@bismarkets.com" required autoFocus />
            </Field>
            <Field label="Password">
              <PasswordInput autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </Field>
            <ErrorText error={error} />
            <button type="submit" className="button button-primary button-block" disabled={busy}>
              {busy ? <Spinner /> : <KeyRound size={16} />} Continue
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
                <h1>Set up two-factor sign-in</h1>
                <p className="lead">Scan this code with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password or similar), then enter the 6-digit code it shows.</p>
                {qr && (
                  <div className="qr-wrap">
                    <img className="qr" src={qr} alt="Authenticator setup code" width={180} height={180} />
                  </div>
                )}
                <p className="muted tight">
                  Can't scan it? Enter this key instead:
                </p>
                <CopyBox value={state.secret} />
              </>
            ) : (
              <>
                <h1>Two-factor check</h1>
                <p className="lead">Enter the 6-digit code from your authenticator app.</p>
              </>
            )}
            <Field label="6-digit code">
              <input
                className="input code-input"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                placeholder="000000"
                required
                autoFocus
              />
            </Field>
            <ErrorText error={error} />
            <button type="submit" className="button button-primary button-block" disabled={busy || code.length !== 6}>
              {busy ? <Spinner /> : <ShieldCheck size={16} />}
              {state.step === "enroll" ? "Turn on 2FA and sign in" : "Sign in"}
            </button>
            <button type="button" className="button-link" onClick={() => setState({ step: "password" })}>
              <ArrowLeft size={15} /> Use a different account
            </button>
          </form>
        )}
        <p className="secure-note">
          <Lock size={13} /> Protected connection. Every sign-in is recorded.
        </p>
      </div>
    </AuthScreen>
  );
}
