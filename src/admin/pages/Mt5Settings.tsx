import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Radio, Server, SlidersHorizontal } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { minorText, parseAmountText, textProblem } from "../components/money";
import { DecisionError } from "../components/ReviewWorkbench";
import { Badge, Dialog, EmptyState, ErrorText, Field, PageHeader, Spinner, useFeedback } from "../components/ui";
import { ApiError, api, formatDate } from "../lib/api";
import { GatewayOffNotice, leverageText, PACKAGES_KEY, SERVERS_KEY, SETTINGS_KEY, useMt5Servers, useMt5Settings, type Mt5Server, type Mt5Settings as Rules } from "../lib/mt5";
import { useCan } from "../lib/session";

// The MT5 servers the gateway serves and the rules for clients' MT5 accounts.
// The CRM knows each server by its gateway code, with a label and an on/off
// switch; its address and manager login live only in the gateway. Every
// change asks for a 2FA code and is recorded in the audit log.

/** The same rules the server and the gateway use. */
const SERVER_CODE = /^[a-z0-9_-]{1,16}$/;
const MT5_GROUP = /^[A-Za-z0-9_\\\-. ]{1,64}$/;

export function Mt5Settings() {
  const can = useCan();
  const editable = can("mt5.servers");
  const servers = useMt5Servers();
  const [editing, setEditing] = useState<{ code: string } | "new" | null>(null);
  const items = servers.data?.items ?? [];
  const current = editing && editing !== "new" ? items.find((s) => s.code === editing.code) : undefined;
  return (
    <>
      <PageHeader
        title="MT5 settings"
        description="The MT5 servers the gateway connects to, and the rules for clients' accounts. Server addresses and manager logins are kept in the gateway, never in the CRM. Every change asks for your 2FA code and is recorded in the audit log."
        badge={!editable && <Badge tone="neutral">View only</Badge>}
        actions={
          editable && (
            <button type="button" className="button button-primary" onClick={() => setEditing("new")}>
              <Plus size={16} /> Add server
            </button>
          )
        }
      />
      {servers.data && !servers.data.gatewayConfigured && <GatewayOffNotice />}
      <ErrorText error={servers.error} />
      <ServerTable items={items} loading={servers.isLoading} editable={editable} onEdit={(s) => setEditing({ code: s.code })} />
      {can("mt5.view") ? (
        <RulesCard servers={items} />
      ) : (
        <section className="panel">
          <h2 className="flush">Account rules</h2>
          <p className="muted">Reading the account rules needs the View MT5 accounts permission.</p>
        </section>
      )}
      {editing && (editing === "new" || current) && <ServerDialog key={editing === "new" ? "new" : current!.code} server={current} onClose={() => setEditing(null)} />}
    </>
  );
}

// ---------- Servers ----------

type Ping = { ok: true; latencyMs: number; serverTime: number | null } | { ok: false; latencyMs: number; error: { kind: string; code: string; message: string } };

/** MT5 reports its own clock (the trade server's time zone) as seconds; shown as that wall-clock time. */
const mt5Clock = (seconds: number) => new Date(seconds * 1000).toLocaleTimeString(undefined, { timeZone: "UTC", hour: "2-digit", minute: "2-digit", second: "2-digit" });

function PingResult({ result }: { result: Ping | "busy" | undefined }) {
  if (!result) return null;
  if (result === "busy")
    return (
      <small className="muted block">
        <Spinner size={12} /> Checking…
      </small>
    );
  return result.ok ? (
    <small className="block">
      <Badge tone="good">Reached</Badge>{" "}
      <span className="muted">
        {result.latencyMs} ms{result.serverTime ? ` · MT5 clock ${mt5Clock(result.serverTime)}` : ""}
      </span>
    </small>
  ) : (
    <small className="block">
      <Badge tone="bad">Not reached</Badge>{" "}
      <span className="error-text">
        {result.error.message} ({result.error.kind}/{result.error.code})
      </span>
    </small>
  );
}

function ServerTable({ items, loading, editable, onEdit }: { items: Mt5Server[]; loading: boolean; editable: boolean; onEdit: (s: Mt5Server) => void }) {
  const client = useQueryClient();
  const { toast, confirm } = useFeedback();
  // Only reads: a ping changes nothing, so its answer stays on this screen and is not audited.
  const [pings, setPings] = useState<Record<string, Ping | "busy">>({});
  const ping = async (code: string) => {
    setPings((p) => ({ ...p, [code]: "busy" }));
    try {
      const res = await api.post<Ping>(`/api/staff/mt5/servers/${code}/ping`);
      setPings((p) => ({ ...p, [code]: res }));
    } catch (e) {
      const error = { kind: "error", code: e instanceof ApiError ? e.code : "ERROR", message: e instanceof Error ? e.message : "The check did not run." };
      setPings((p) => ({ ...p, [code]: { ok: false, latencyMs: 0, error } }));
    }
  };
  const toggle = useMutation({
    mutationFn: (s: Mt5Server) => api.patch<Mt5Server>(`/api/staff/mt5/servers/${s.code}`, { isEnabled: !s.isEnabled }),
    onSuccess: (_res, s) => {
      toast(s.isEnabled ? `${s.label} is switched off.` : `${s.label} is switched on.`);
      void client.invalidateQueries({ queryKey: SERVERS_KEY });
    },
    onError: (e) => toast(e instanceof Error ? e.message : "That did not work.", "bad"),
  });
  const flip = async (s: Mt5Server) => {
    if (
      s.isEnabled &&
      !(await confirm({
        title: `Switch off ${s.label}?`,
        body: "Until it is switched on again, clients cannot open accounts on this server, change them or move money to and from them, and staff cannot change them. Accounts stay open in MT5 and clients can keep trading.",
        confirmLabel: "Switch off",
        danger: true,
      }))
    )
      return;
    toggle.mutate(s);
  };
  const cols = editable ? 5 : 4;
  return (
    <section className="grid" style={{ marginBottom: 18 }}>
      <div className="grid-toolbar">
        <div>
          <h2 className="flush">
            <Server size={18} /> Servers
          </h2>
          <small className="muted">Each code must match one in the gateway's GATEWAY_SERVERS. Check the connection before switching a server on.</small>
        </div>
      </div>
      <div className="grid-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Server</th>
              <th>Used by</th>
              <th>Connection</th>
              <th>Switched on</th>
              {editable && <th aria-label="Edit" />}
            </tr>
          </thead>
          <tbody>
            {items.map((s) => (
              <tr key={s.code}>
                <td data-label="Server">
                  <span className="stack-tight">
                    <strong>
                      {s.label} {s.isDemoServer && <Badge tone="info">Demo accounts</Badge>}
                    </strong>
                    <small className="muted mono">{s.code}</small>
                  </span>
                </td>
                <td data-label="Used by">
                  {s.usage.packages} {s.usage.packages === 1 ? "package" : "packages"} · {s.usage.accounts.toLocaleString()} open {s.usage.accounts === 1 ? "account" : "accounts"}
                </td>
                <td data-label="Connection">
                  {editable ? (
                    <span className="stack-tight">
                      <button type="button" className="button button-small" disabled={pings[s.code] === "busy"} onClick={() => void ping(s.code)}>
                        <Radio size={14} /> Check connection
                      </button>
                      <PingResult result={pings[s.code]} />
                    </span>
                  ) : (
                    <span className="muted">Needs the server permission</span>
                  )}
                </td>
                <td data-label="Switched on">
                  {editable ? (
                    <label className="check grid-check">
                      <input type="checkbox" checked={s.isEnabled} disabled={toggle.isPending} onChange={() => void flip(s)} />
                      <span>{s.isEnabled ? "On" : "Off"}</span>
                    </label>
                  ) : s.isEnabled ? (
                    <Badge tone="good">On</Badge>
                  ) : (
                    <Badge tone="neutral">Off</Badge>
                  )}
                </td>
                {editable && (
                  <td>
                    <button type="button" className="button button-small" onClick={() => onEdit(s)}>
                      <Pencil size={14} /> Edit
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {!loading && items.length === 0 && (
              <tr>
                <td colSpan={cols} className="empty">
                  <EmptyState icon={<Server size={32} />} title="No servers yet">
                    Add each server the gateway serves, with the same code. Clients cannot open accounts until one is added and switched on.
                  </EmptyState>
                </td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={cols}>
                  <Spinner />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ServerDialog({ server, onClose }: { server?: Mt5Server; onClose: () => void }) {
  const client = useQueryClient();
  const { toast } = useFeedback();
  const [code, setCode] = useState(server?.code ?? "");
  const [label, setLabel] = useState(server?.label ?? "");
  const [isEnabled, setIsEnabled] = useState(server?.isEnabled ?? false);
  const [tried, setTried] = useState(false);
  const problems = {
    code: server ? null : !code.trim() ? "Enter the server code." : SERVER_CODE.test(code.trim()) ? null : "Use 1 to 16 lower-case letters, digits, - or _ (the code in the gateway).",
    label: label.trim().length < 2 ? "Enter a label of at least 2 characters." : textProblem(label, "label", 2, 60),
  };
  const ok = !problems.code && !problems.label;
  const changed = server ? label.trim() !== server.label || isEnabled !== server.isEnabled : true;
  const save = useMutation({
    mutationFn: () => {
      if (!server) return api.post<Mt5Server>("/api/staff/mt5/servers", { code: code.trim(), label: label.trim(), isEnabled });
      const body: Record<string, unknown> = {};
      if (label.trim() !== server.label) body.label = label.trim();
      if (isEnabled !== server.isEnabled) body.isEnabled = isEnabled;
      return api.patch<Mt5Server>(`/api/staff/mt5/servers/${server.code}`, body);
    },
    onSuccess: () => {
      toast(server ? `${label.trim()} saved.` : `${label.trim()} added.`);
      void client.invalidateQueries({ queryKey: SERVERS_KEY });
      // Package rows show the server's label.
      void client.invalidateQueries({ queryKey: PACKAGES_KEY });
      onClose();
    },
  });
  const hint = (problem: string | null, text: ReactNode) => (problem && (tried || (server ? false : code !== "")) ? <span className="error-text">{problem}</span> : text);
  return (
    <Dialog open title={server ? `Edit ${server.label}` : "Add an MT5 server"} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (ok && changed) save.mutate();
        }}
      >
        {server ? (
          <Field label="Code" hint="The code cannot change: packages and accounts refer to it.">
            <input className="input mono" value={server.code} disabled />
          </Field>
        ) : (
          <Field label="Code" hint={hint(problems.code, "Exactly as in the gateway's GATEWAY_SERVERS, such as live or demo. It cannot change later.")}>
            <input className="input mono" value={code} onChange={(e) => setCode(e.target.value)} maxLength={16} autoComplete="off" spellCheck={false} autoFocus />
          </Field>
        )}
        <Field label="Label" hint={tried && problems.label ? <span className="error-text">{problems.label}</span> : "What staff see, such as Live or Demo."}>
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} autoFocus={Boolean(server)} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={isEnabled} onChange={(e) => setIsEnabled(e.target.checked)} />
          <span>
            Switched on
            <small className="muted block">{server ? "Clients and staff can use accounts on this server." : "Leave it off until Check connection reaches the server."}</small>
          </span>
        </label>
        <DecisionError error={save.error} />
        <div className="actions">
          <button type="button" className="button" onClick={onClose}>
            {server && !changed ? "Close" : "Cancel"}
          </button>
          <button type="submit" className="button button-primary" disabled={save.isPending || (tried && !ok) || !changed}>
            {save.isPending && <Spinner />} {server ? "Save changes" : "Add server"}
          </button>
        </div>
        <p className="muted tight">You'll be asked for your 2FA code.</p>
      </form>
    </Dialog>
  );
}

// ---------- Account rules ----------

type AmountKey = "demoMaxOpeningCents" | "demoMaxTopupCents" | "demoMaxBalanceCents" | "maxTransferCents";
type CountKey = "maxLiveAccounts" | "maxDemoAccounts";
type RulesForm = Record<AmountKey | CountKey, string> & { leverages: string; demoServerCode: string; demoGroup: string };

const AMOUNTS: { key: AmountKey; label: string; help: string }[] = [
  { key: "demoMaxOpeningCents", label: "Largest demo starting balance", help: "The most a client can choose as the starting balance of a new demo account." },
  { key: "demoMaxTopupCents", label: "Largest demo top-up", help: "The most a client can add to a demo account at a time." },
  { key: "demoMaxBalanceCents", label: "Most a demo account may hold", help: "A top-up that would take a demo account above this is refused." },
  { key: "maxTransferCents", label: "Largest transfer", help: "The largest single transfer between a client's wallet and a live MT5 account." },
];
const COUNTS: { key: CountKey; label: string; help: string }[] = [
  { key: "maxLiveAccounts", label: "Live accounts per client", help: "Accounts being opened count too." },
  { key: "maxDemoAccounts", label: "Demo accounts per client", help: "Accounts being opened count too." },
];

const formOf = (s: Rules): RulesForm => ({
  leverages: s.leverages.join(", "),
  maxLiveAccounts: String(s.maxLiveAccounts),
  maxDemoAccounts: String(s.maxDemoAccounts),
  demoServerCode: s.demoServerCode ?? "",
  demoGroup: s.demoGroup ?? "",
  demoMaxOpeningCents: minorText(s.demoMaxOpeningCents),
  demoMaxTopupCents: minorText(s.demoMaxTopupCents),
  demoMaxBalanceCents: minorText(s.demoMaxBalanceCents),
  maxTransferCents: minorText(s.maxTransferCents),
});

/** "2000, 1000, 1:500" → [2000, 1000, 500], in the order given, without repeats. */
function leveragesOf(text: string): { list: number[]; problem?: undefined } | { list?: undefined; problem: string } {
  const parts = text
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map((p) => p.replace(/^1:/, ""));
  if (!parts.length) return { problem: "Offer at least one leverage." };
  if (parts.some((p) => !/^\d{1,5}$/.test(p) || Number(p) < 1 || Number(p) > 10_000)) return { problem: "Enter whole numbers from 1 to 10000, separated by commas, such as 2000, 1000, 500." };
  const list = [...new Set(parts.map(Number))];
  if (list.length > 12) return { problem: "Offer at most 12 leverages." };
  return { list };
}

function RulesCard({ servers }: { servers: Mt5Server[] }) {
  const can = useCan();
  const client = useQueryClient();
  const { toast } = useFeedback();
  const settings = useMt5Settings();
  const editable = can("mt5.servers");
  const [form, setForm] = useState<RulesForm | null>(null);
  const s = settings.data;
  useEffect(() => {
    if (s && !form) setForm(formOf(s));
  }, [s, form]);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch<Rules>("/api/staff/mt5/settings", body),
    onSuccess: (res) => {
      toast("MT5 rules saved.");
      client.setQueryData(SETTINGS_KEY, res);
      setForm(formOf(res));
      // The servers list marks the demo server.
      void client.invalidateQueries({ queryKey: SERVERS_KEY });
    },
  });
  if (settings.error)
    return (
      <section className="panel">
        <h2 className="flush">Account rules</h2>
        <ErrorText error={settings.error} />
      </section>
    );
  if (!s || !form)
    return (
      <section className="panel">
        <Spinner />
      </section>
    );
  const initial = formOf(s);
  const problems: Partial<Record<keyof RulesForm, string>> = {};
  const body: Record<string, unknown> = {};
  const lev = leveragesOf(form.leverages);
  if (lev.problem !== undefined) problems.leverages = lev.problem;
  else if (lev.list.join(",") !== s.leverages.join(",")) body.leverages = lev.list;
  for (const c of COUNTS) {
    const t = form[c.key].trim();
    if (!/^\d{1,4}$/.test(t) || Number(t) < 1 || Number(t) > 1000) problems[c.key] = "Enter a whole number from 1 to 1000.";
    else if (Number(t) !== s[c.key]) body[c.key] = Number(t);
  }
  const cents: Partial<Record<AmountKey, number>> = {};
  for (const a of AMOUNTS) {
    const r = parseAmountText(form[a.key]);
    if (r.problem) problems[a.key] = r.problem;
    else {
      cents[a.key] = r.minor;
      if (r.minor !== s[a.key]) body[a.key] = r.minor;
    }
  }
  const opening = cents.demoMaxOpeningCents;
  const most = cents.demoMaxBalanceCents;
  if (opening !== undefined && most !== undefined && most < opening) problems.demoMaxBalanceCents = "This must be at least the largest demo starting balance.";
  const demoServer = form.demoServerCode;
  const demoGroup = form.demoGroup.trim();
  if (demoGroup && !MT5_GROUP.test(demoGroup)) problems.demoGroup = "Enter the MT5 group exactly as the broker named it (letters, digits, \\ _ - . and spaces).";
  else if (!demoServer !== !demoGroup) problems[demoGroup ? "demoServerCode" : "demoGroup"] = "Set both the demo server and the demo group, or neither.";
  if (demoServer !== (s.demoServerCode ?? "")) body.demoServerCode = demoServer || null;
  if (demoGroup !== (s.demoGroup ?? "")) body.demoGroup = demoGroup || null;
  const dirty = Object.keys(body).length > 0;
  const ok = Object.keys(problems).length === 0;
  // Saved rules are always valid, so a problem only shows after a change (on that field or on the one it depends on).
  const hint = (key: keyof RulesForm, help: ReactNode) => (problems[key] ? <span className="error-text">{problems[key]}</span> : help);
  const knownDemo = !demoServer || servers.some((x) => x.code === demoServer);
  return (
    <section className="panel">
      <div className="card-head">
        <div>
          <h2 className="flush">
            <SlidersHorizontal size={18} /> Account rules
          </h2>
          <p>
            Amounts are in US dollars.{s.updatedBy ? ` Last changed ${formatDate(s.updatedAt)} by ${s.updatedBy.name}.` : ""}
          </p>
        </div>
        {!editable && <Badge tone="neutral">View only</Badge>}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty && ok) save.mutate(body);
        }}
      >
        <h3>Live and demo accounts</h3>
        <div className="form-grid">
          <Field
            label="Leverages clients can choose"
            hint={hint(
              "leverages",
              <>
                Whole numbers separated by commas: 2000 is 1:2000. Package cards show 1:2000 when it is offered. The gateway's own list must include each one.
                {lev.list && <span className="block">Clients see: {lev.list.map((n) => leverageText(n)).join(", ")}</span>}
              </>,
            )}
          >
            <input className="input" value={form.leverages} disabled={!editable} onChange={(e) => setForm({ ...form, leverages: e.target.value })} maxLength={100} />
          </Field>
          {COUNTS.map((c) => (
            <Field key={c.key} label={c.label} hint={hint(c.key, c.help)}>
              <input className="input" inputMode="numeric" value={form[c.key]} disabled={!editable} onChange={(e) => setForm({ ...form, [c.key]: e.target.value })} maxLength={4} />
            </Field>
          ))}
        </div>
        <h3>Demo accounts</h3>
        <div className="form-grid">
          <Field label="Demo server" hint={hint("demoServerCode", "Where demo accounts open. Leave the server and the group empty to stop new demo accounts.")}>
            <select className="input" value={demoServer} disabled={!editable} onChange={(e) => setForm({ ...form, demoServerCode: e.target.value })}>
              <option value="">No demo accounts</option>
              {!knownDemo && <option value={demoServer}>{demoServer}</option>}
              {servers.map((x) => (
                <option key={x.code} value={x.code}>
                  {x.label} ({x.code}){x.isEnabled ? "" : ", switched off"}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Demo group" hint={hint("demoGroup", "The MT5 group demo accounts open in, such as demo\\usd. The gateway must allow it as a demo group.")}>
            <input className="input mono" value={form.demoGroup} disabled={!editable} onChange={(e) => setForm({ ...form, demoGroup: e.target.value })} maxLength={64} autoComplete="off" spellCheck={false} />
          </Field>
        </div>
        <h3>Limits</h3>
        <div className="form-grid">
          {AMOUNTS.map((a) => (
            <Field key={a.key} label={`${a.label} (USD)`} hint={hint(a.key, a.help)}>
              <input className="input" inputMode="decimal" value={form[a.key]} disabled={!editable} onChange={(e) => setForm({ ...form, [a.key]: e.target.value })} maxLength={16} />
            </Field>
          ))}
        </div>
        {editable && (
          <>
            <DecisionError error={save.error} />
            <div className="actions">
              {dirty && (
                <button type="button" className="button" onClick={() => setForm(initial)}>
                  Undo changes
                </button>
              )}
              <button type="submit" className="button button-primary" disabled={!dirty || !ok || save.isPending}>
                {save.isPending && <Spinner />} Save rules
              </button>
            </div>
            <p className="muted tight">You'll be asked for your 2FA code. New rules apply to requests made from now on; accounts already open keep their leverage.</p>
          </>
        )}
      </form>
    </section>
  );
}
