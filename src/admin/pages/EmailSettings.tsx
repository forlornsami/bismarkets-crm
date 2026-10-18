import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Info, MailCheck, Power, PowerOff, Send, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "wouter";
import type { MailProviderPreset } from "../../shared/mail-providers";
import { Badge, ErrorText, Field, PageHeader, PasswordInput, Spinner, useFeedback } from "../components/ui";
import { api, formatDate } from "../lib/api";
import { useCan, useSession } from "../lib/session";

interface MailSettings {
  enabled: boolean;
  provider: string;
  host: string | null;
  port: number;
  security: "tls" | "starttls" | "none";
  username: string | null;
  hasPassword: boolean;
  fromName: string;
  fromEmail: string | null;
  replyTo: string | null;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
  updatedAt: string;
}

interface SettingsResponse {
  settings: MailSettings;
  providers: MailProviderPreset[];
  outbox: { held: number; queued: number; failed: number };
}

const SECURITY = [
  { value: "tls", label: "SSL/TLS (usually port 465)" },
  { value: "starttls", label: "STARTTLS (usually port 587)" },
  { value: "none", label: "None (test servers only)" },
] as const;

type Form = { provider: string; host: string; port: string; security: MailSettings["security"]; username: string; password: string; fromName: string; fromEmail: string; replyTo: string };

const toForm = (s: MailSettings): Form => ({
  provider: s.provider,
  host: s.host ?? "",
  port: String(s.port),
  security: s.security,
  username: s.username ?? "",
  password: "",
  fromName: s.fromName,
  fromEmail: s.fromEmail ?? "",
  replyTo: s.replyTo ?? "",
});

export function EmailSettings() {
  const can = useCan();
  const editable = can("settings.manage");
  const q = useQuery({ queryKey: ["mail-settings"], queryFn: () => api.get<SettingsResponse>("/api/staff/mail-settings") });
  if (!q.data) return <Spinner size={22} />;
  const { settings, providers, outbox } = q.data;
  return (
    <>
      <PageHeader
        title="Email settings"
        description="The mail server the CRM sends every email through: sign-up codes, password resets, KYC results and messages from staff."
        badge={!editable && <Badge tone="neutral">View only</Badge>}
      />
      <div className="columns columns-wide">
        <ServerForm settings={settings} providers={providers} editable={editable} />
        <div className="stack">
          <SendingPanel settings={settings} outbox={outbox} editable={editable} />
          {editable && <TestPanel settings={settings} />}
        </div>
      </div>
    </>
  );
}

function ServerForm({ settings, providers, editable }: { settings: MailSettings; providers: MailProviderPreset[]; editable: boolean }) {
  const client = useQueryClient();
  const { toast, confirm } = useFeedback();
  const [form, setForm] = useState<Form>(() => toForm(settings));
  useEffect(() => setForm(toForm(settings)), [settings]);
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
  const preset = providers.find((p) => p.id === form.provider) ?? providers[providers.length - 1];
  const save = useMutation({
    mutationFn: () =>
      api.put<{ settings: MailSettings }>("/api/staff/mail-settings", {
        provider: form.provider,
        host: form.host,
        port: Number(form.port),
        security: form.security,
        username: form.username,
        password: form.password || undefined,
        fromName: form.fromName,
        fromEmail: form.fromEmail,
        replyTo: form.replyTo,
      }),
    onSuccess: (data) => {
      toast(data.settings.enabled ? "Email settings saved." : "Email settings saved. Send a test email, then switch sending on.");
      void client.invalidateQueries({ queryKey: ["mail-settings"] });
    },
  });
  return (
    <section className="panel">
      <div className="card-head">
        <div>
          <h2>Mail server</h2>
          <p>Pick your provider and the server details fill in. Then enter the mailbox login and the address emails come from.</p>
        </div>
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (settings.enabled && (await confirm({ title: "Change the mail server?", body: "Sending pauses until you send a test email that arrives, then switch it back on. Emails wait in the outbox meanwhile.", confirmLabel: "Save" })) === false) return;
          save.mutate();
        }}
      >
        <fieldset disabled={!editable} className="flush">
          <Field label="Provider">
            <select
              className="input"
              value={form.provider}
              onChange={(e) => {
                const p = providers.find((x) => x.id === e.target.value);
                if (!p) return;
                set(p.id === "custom" ? { provider: p.id } : { provider: p.id, host: p.host, port: String(p.port), security: p.security });
              }}
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>
          <div className="form-grid">
            <Field label="Server (host)">
              <input className="input" value={form.host} onChange={(e) => set({ host: e.target.value })} placeholder="smtp.example.com" required autoComplete="off" />
            </Field>
            <Field label="Port">
              <input className="input" value={form.port} onChange={(e) => set({ port: e.target.value })} inputMode="numeric" required />
            </Field>
          </div>
          <Field label="Security">
            <select className="input" value={form.security} onChange={(e) => set({ security: e.target.value as Form["security"] })}>
              {SECURITY.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>
          <div className="form-grid">
            <Field label="Username" hint={preset?.usernameHint}>
              <input className="input" value={form.username} onChange={(e) => set({ username: e.target.value })} autoComplete="off" />
            </Field>
            <Field label="Password" hint={settings.hasPassword ? "Saved. Leave empty to keep it." : preset?.passwordHint}>
              <PasswordInput className="input" value={form.password} onChange={(e) => set({ password: e.target.value })} autoComplete="new-password" placeholder={settings.hasPassword ? "••••••••" : ""} />
            </Field>
          </div>
          <div className="form-grid">
            <Field label="Sender name" hint="What clients see as the sender.">
              <input className="input" value={form.fromName} onChange={(e) => set({ fromName: e.target.value })} required />
            </Field>
            <Field label="Sender address" hint="Must be an address your provider lets you send from.">
              <input className="input" type="email" value={form.fromEmail} onChange={(e) => set({ fromEmail: e.target.value })} placeholder="no-reply@bismarkets.com" required />
            </Field>
          </div>
          <Field label="Reply-to address (optional)" hint="Where client replies go, for example your support mailbox.">
            <input className="input" type="email" value={form.replyTo} onChange={(e) => set({ replyTo: e.target.value })} placeholder="support@bismarkets.com" />
          </Field>
        </fieldset>
        <ErrorText error={save.error} />
        {editable && (
          <div className="actions">
            <span className="muted">The password is stored encrypted and is never shown again.</span>
            <button type="submit" className="button button-primary" disabled={save.isPending}>
              {save.isPending && <Spinner />} Save settings
            </button>
          </div>
        )}
      </form>
    </section>
  );
}

function SendingPanel({ settings, outbox, editable }: { settings: MailSettings; outbox: SettingsResponse["outbox"]; editable: boolean }) {
  const client = useQueryClient();
  const { toast } = useFeedback();
  const [releaseHeld, setReleaseHeld] = useState(false);
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.post<{ settings: MailSettings; released: number }>("/api/staff/mail-settings/enabled", { enabled, releaseHeld }),
    onSuccess: (data) => {
      toast(data.settings.enabled ? `Sending is on.${data.released ? ` ${data.released} held email(s) will go out now.` : ""}` : "Sending is off. New emails will be held.");
      void client.invalidateQueries({ queryKey: ["mail-settings"] });
      void client.invalidateQueries({ queryKey: ["emails"] });
    },
    onError: (err) => toast(err instanceof Error ? err.message : "That did not work.", "bad"),
  });
  const ready = settings.lastTestOk === true;
  return (
    <section className="panel">
      <div className="card-head">
        <div>
          <h2>Sending</h2>
          <p>{settings.enabled ? `Emails are delivered through ${settings.host}.` : "Sending is off. Emails wait in the outbox until you switch it on."}</p>
        </div>
        {settings.enabled ? <Badge tone="good">On</Badge> : <Badge tone="neutral">Off</Badge>}
      </div>
      <dl className="details">
        <dt>Last test</dt>
        <dd>
          {settings.lastTestAt ? (
            <span className="inline-field">
              {settings.lastTestOk ? <CheckCircle2 size={15} className="success-text" /> : <XCircle size={15} className="error-text" />}
              {settings.lastTestOk ? "Arrived at the mail server" : (settings.lastTestError ?? "Failed")} · {formatDate(settings.lastTestAt)}
            </span>
          ) : settings.lastTestOk === null && settings.host ? (
            <span className="muted">Not tested since the server was changed</span>
          ) : (
            <span className="muted">Never</span>
          )}
        </dd>
        <dt>Outbox</dt>
        <dd>
          <Link href="/emails">
            {outbox.queued} waiting · {outbox.held} held · {outbox.failed} failed
          </Link>
        </dd>
      </dl>
      {editable &&
        (settings.enabled ? (
          <div className="actions">
            <button type="button" className="button" disabled={toggle.isPending} onClick={() => toggle.mutate(false)}>
              <PowerOff size={15} /> Switch sending off
            </button>
          </div>
        ) : (
          <>
            {!ready && (
              <div className="notice">
                <Info size={18} />
                <p>Save the mail server, then send a test email. Once it arrives you can switch sending on.</p>
              </div>
            )}
            {ready && outbox.held > 0 && (
              <label className="check">
                <input type="checkbox" checked={releaseHeld} onChange={(e) => setReleaseHeld(e.target.checked)} />
                <span>Also send the emails held in the last 24 hours. Older ones stay held, because their codes and links have expired.</span>
              </label>
            )}
            <div className="actions">
              <button type="button" className="button button-primary" disabled={!ready || toggle.isPending} onClick={() => toggle.mutate(true)}>
                <Power size={15} /> Switch sending on
              </button>
            </div>
          </>
        ))}
    </section>
  );
}

function TestPanel({ settings }: { settings: MailSettings }) {
  const client = useQueryClient();
  const { staff } = useSession();
  const [to, setTo] = useState(staff.email);
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; error: string | null }>("/api/staff/mail-settings/test", { to }),
    onSettled: () => void client.invalidateQueries({ queryKey: ["mail-settings"] }),
  });
  return (
    <section className="panel">
      <div className="card-head">
        <div>
          <h2>Send a test email</h2>
          <p>Uses the saved settings. Check the inbox (and spam folder) of the address below.</p>
        </div>
        <MailCheck size={20} className="muted" />
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          test.mutate();
        }}
      >
        <Field label="Send to">
          <input className="input" type="email" value={to} onChange={(e) => setTo(e.target.value)} required />
        </Field>
        {test.data && (
          <p className={test.data.ok ? "success-text" : "error-text"}>
            {test.data.ok ? `Sent. The mail server accepted it for ${to}.` : test.data.error}
          </p>
        )}
        <ErrorText error={test.error} />
        <div className="actions">
          <button type="submit" className="button" disabled={test.isPending || !settings.host || !settings.fromEmail}>
            {test.isPending ? <Spinner /> : <Send size={15} />} Send test email
          </button>
        </div>
      </form>
    </section>
  );
}
