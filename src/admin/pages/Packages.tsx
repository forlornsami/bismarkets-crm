import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Package, Pencil, Plus, Star } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { minorText, money, parseAmountText, textProblem } from "../components/money";
import { DecisionError } from "../components/ReviewWorkbench";
import { Badge, Dialog, EmptyState, ErrorText, Field, PageHeader, Spinner, useFeedback } from "../components/ui";
import { api, formatDate } from "../lib/api";
import { PACKAGES_KEY, usePackages, useMt5Servers, type AccountPackage } from "../lib/mt5";
import { useCan } from "../lib/session";

// Account packages: what clients choose from when they open a live account in
// the portal or app, and the MT5 group (on one server) each one opens
// accounts in. Clients see the name, description, highlights, spread,
// commission and minimum deposit exactly as written here; never the server
// or group. Every change asks for a 2FA code and is recorded in the audit log.

/** The same rule the server and the gateway use for an MT5 group name, such as real\standard. */
const MT5_GROUP = /^[A-Za-z0-9_\\\-. ]{1,64}$/;

export function Packages() {
  const can = useCan();
  const editable = can("package.manage");
  const packages = usePackages();
  const [editing, setEditing] = useState<{ id: number } | "new" | null>(null);
  const items = packages.data?.items ?? [];
  const current = editing && editing !== "new" ? items.find((p) => p.id === editing.id) : undefined;
  return (
    <>
      <PageHeader
        title="Account packages"
        description="What clients choose from when they open a live account in the portal or app. Each package opens accounts in one MT5 group on one server. Every change asks for your 2FA code and is recorded in the audit log."
        badge={!editable && <Badge tone="neutral">View only</Badge>}
        actions={
          editable && (
            <button type="button" className="button button-primary" onClick={() => setEditing("new")}>
              <Plus size={16} /> Add package
            </button>
          )
        }
      />
      <ErrorText error={packages.error} />
      <PackageTable items={items} loading={packages.isLoading} editable={editable} onEdit={(p) => setEditing({ id: p.id })} />
      <p className="muted tight">Demo accounts do not use a package: their server and group are set in the MT5 settings.</p>
      {editing && (editing === "new" || current) && <PackageDialog key={editing === "new" ? "new" : `edit-${editing.id}`} pkg={current} onClose={() => setEditing(null)} />}
    </>
  );
}

function PackageTable({ items, loading, editable, onEdit }: { items: AccountPackage[]; loading: boolean; editable: boolean; onEdit: (p: AccountPackage) => void }) {
  const client = useQueryClient();
  const { toast, confirm } = useFeedback();
  const toggle = useMutation({
    mutationFn: (p: AccountPackage) => api.patch<AccountPackage>(`/api/staff/packages/${p.id}`, { isVisible: !p.isVisible }),
    onSuccess: (_res, p) => {
      toast(p.isVisible ? `${p.name} is hidden. Clients can no longer choose it.` : `${p.name} is shown. Clients can choose it now.`);
      void client.invalidateQueries({ queryKey: PACKAGES_KEY });
    },
    onError: (e) => toast(e instanceof Error ? e.message : "That did not work.", "bad"),
  });
  const flip = async (p: AccountPackage) => {
    if (
      p.isVisible &&
      !(await confirm({
        title: `Hide ${p.name}?`,
        body: "Clients stop seeing it when they open a live account. Accounts already opened with it stay as they are.",
        confirmLabel: "Hide package",
      }))
    )
      return;
    toggle.mutate(p);
  };
  const cols = editable ? 8 : 7;
  return (
    <section className="grid" style={{ marginBottom: 18 }}>
      <div className="grid-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Package</th>
              <th>Spread</th>
              <th>Commission</th>
              <th>Minimum deposit</th>
              <th className="col-optional">MT5</th>
              <th>Open accounts</th>
              <th>Shown to clients</th>
              {editable && <th aria-label="Edit" />}
            </tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <tr key={p.id}>
                <td data-label="Package">
                  <span className="stack-tight">
                    <strong>
                      {p.name} {p.isRecommended && <Badge tone="info">Recommended</Badge>}
                    </strong>
                    {p.description && (
                      <small className="muted truncate" title={p.description} style={{ display: "inline-block", maxWidth: 320 }}>
                        {p.description}
                      </small>
                    )}
                  </span>
                </td>
                <td data-label="Spread">{p.spreadLabel}</td>
                <td data-label="Commission">{p.commissionLabel ?? <span className="muted" title="The portal shows “Unavailable”.">Not set</span>}</td>
                <td data-label="Minimum deposit">{p.minDepositCents ? money(p.minDepositCents) : <span className="muted">None</span>}</td>
                <td data-label="MT5" className="col-optional">
                  <span className="stack-tight">
                    <span>{p.serverLabel}</span>
                    <small className="muted mono">{p.mt5Group}</small>
                  </span>
                </td>
                <td data-label="Open accounts">{p.accounts.toLocaleString()}</td>
                <td data-label="Shown to clients">
                  {editable ? (
                    <label className="check grid-check">
                      <input type="checkbox" checked={p.isVisible} disabled={toggle.isPending} onChange={() => void flip(p)} />
                      <span>{p.isVisible ? "Shown" : "Hidden"}</span>
                    </label>
                  ) : p.isVisible ? (
                    <Badge tone="good">Shown</Badge>
                  ) : (
                    <Badge tone="neutral">Hidden</Badge>
                  )}
                </td>
                {editable && (
                  <td>
                    <button type="button" className="button button-small" onClick={() => onEdit(p)}>
                      <Pencil size={14} /> Edit
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {!loading && items.length === 0 && (
              <tr>
                <td colSpan={cols} className="empty">
                  <EmptyState icon={<Package size={32} />} title="No packages yet">
                    Clients cannot open a live account until at least one package is added and shown.
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

// ---------- Add or edit a package ----------

interface Draft {
  name: string;
  description: string;
  highlights: string;
  spreadLabel: string;
  commissionLabel: string;
  minDeposit: string;
  serverCode: string;
  mt5Group: string;
  isRecommended: boolean;
  isVisible: boolean;
  sortOrder: string;
}

const draftOf = (p: AccountPackage | undefined): Draft => ({
  name: p?.name ?? "",
  description: p?.description ?? "",
  highlights: (p?.highlights ?? []).join("\n"),
  spreadLabel: p?.spreadLabel ?? "",
  commissionLabel: p?.commissionLabel ?? "",
  minDeposit: p?.minDepositCents ? minorText(p.minDepositCents) : "",
  serverCode: p?.serverCode ?? "",
  mt5Group: p?.mt5Group ?? "",
  isRecommended: p?.isRecommended ?? false,
  isVisible: p?.isVisible ?? true,
  sortOrder: String(p?.sortOrder ?? 0),
});

/** One highlight per line; empty lines are left out (the portal refuses an empty highlight). */
const highlightLines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

/** "", "0" or "0.00" is no minimum; anything else is an amount as on the other money screens. */
function minDepositOf(text: string): { cents: number; problem?: undefined } | { cents?: undefined; problem: string } {
  const t = text.trim();
  if (!t || /^0+(\.0{1,2})?$/.test(t)) return { cents: 0 };
  const r = parseAmountText(t);
  return r.problem !== undefined ? { problem: r.problem } : { cents: r.minor };
}

/** The fields as the server takes them. */
function bodyOf(f: Draft): Record<string, unknown> {
  return {
    name: f.name.trim(),
    description: f.description.trim(),
    highlights: highlightLines(f.highlights),
    spreadLabel: f.spreadLabel.trim(),
    commissionLabel: f.commissionLabel.trim() || null,
    minDepositCents: minDepositOf(f.minDeposit).cents ?? 0,
    serverCode: f.serverCode,
    mt5Group: f.mt5Group.trim(),
    isRecommended: f.isRecommended,
    isVisible: f.isVisible,
    sortOrder: Number(f.sortOrder.trim() || 0),
  };
}

// The same checks the server makes, so mistakes show before the 2FA prompt.
function problemsOf(f: Draft): Partial<Record<keyof Draft, string>> {
  const p: Partial<Record<keyof Draft, string>> = {};
  const text = (key: keyof Draft, label: string, min: number, max: number) => {
    const problem = textProblem(String(f[key]), label, min, max);
    if (problem) p[key] = problem;
  };
  text("name", "name", 2, 60);
  if (!p.name && f.name.trim().length < 2) p.name = "Enter a name of at least 2 characters.";
  text("description", "description", 0, 300);
  text("spreadLabel", "spread", 1, 40);
  text("commissionLabel", "commission", 0, 40);
  const lines = highlightLines(f.highlights);
  if (lines.length > 8) p.highlights = "Write at most 8 highlights, one per line.";
  else {
    const long = lines.find((l) => l.length > 80);
    if (long) p.highlights = `Keep each highlight under 81 characters (“${long.slice(0, 24)}…” is longer).`;
    else
      for (const l of lines) {
        const problem = textProblem(l, "highlights", 1, 80);
        if (problem) {
          p.highlights = problem;
          break;
        }
      }
  }
  const min = minDepositOf(f.minDeposit);
  if (min.problem) p.minDeposit = min.problem;
  if (!f.serverCode) p.serverCode = "Choose the MT5 server.";
  if (!f.mt5Group.trim()) p.mt5Group = "Enter the MT5 group.";
  else if (!MT5_GROUP.test(f.mt5Group.trim())) p.mt5Group = "Enter the MT5 group exactly as the broker named it (letters, digits, \\ _ - . and spaces).";
  if (!/^-?\d{1,7}$/.test(f.sortOrder.trim() || "0") || Math.abs(Number(f.sortOrder)) > 1_000_000) p.sortOrder = "Enter a whole number.";
  return p;
}

function PackageDialog({ pkg, onClose }: { pkg?: AccountPackage; onClose: () => void }) {
  const can = useCan();
  const client = useQueryClient();
  const { toast } = useFeedback();
  // Staff who cannot read the server list type the code instead.
  const mayServers = can("mt5.view") || can("mt5.servers");
  const servers = useMt5Servers(mayServers);
  const initial = useRef(draftOf(pkg));
  const [f, setF] = useState<Draft>(initial.current);
  const [tried, setTried] = useState(false);
  const set = (patch: Partial<Draft>) => setF((old) => ({ ...old, ...patch }));
  const problems = problemsOf(f);
  const ok = Object.values(problems).every((v) => !v);
  const show = (key: keyof Draft) => (tried || String(f[key]).trim() !== String(initial.current[key]).trim() ? problems[key] : undefined);
  const before = bodyOf(initial.current);
  const after = bodyOf(f);
  const changed = Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k]));
  const movesAccounts = Boolean(pkg && pkg.accounts > 0 && (changed.includes("serverCode") || changed.includes("mt5Group")));
  const save = useMutation({
    mutationFn: () => {
      if (!pkg) return api.post<AccountPackage>("/api/staff/packages", after);
      const patch: Record<string, unknown> = {};
      for (const k of changed) patch[k] = after[k];
      return api.patch<AccountPackage>(`/api/staff/packages/${pkg.id}`, patch);
    },
    onSuccess: () => {
      toast(pkg ? `${f.name.trim()} saved.` : `${f.name.trim()} added.`);
      void client.invalidateQueries({ queryKey: PACKAGES_KEY });
      void client.invalidateQueries({ queryKey: ["mt5-servers"] });
      onClose();
    },
  });
  const hint = (key: keyof Draft, text?: ReactNode) => (show(key) ? <span className="error-text">{show(key)}</span> : text);
  const serverList = servers.data?.items ?? [];
  // A package can keep a server that is switched off; it shows here so the choice is not lost.
  const knownServer = serverList.some((s) => s.code === f.serverCode);
  return (
    <Dialog open title={pkg ? `Edit ${pkg.name}` : "Add an account package"} onClose={onClose} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (ok && (!pkg || changed.length)) save.mutate();
        }}
      >
        <h3>What clients see</h3>
        <div className="form-grid">
          <Field label="Name" hint={hint("name", "For example: Classic, Raw Spread.")}>
            <input className="input" value={f.name} onChange={(e) => set({ name: e.target.value })} maxLength={60} autoFocus />
          </Field>
          <Field label="Spread" hint={hint("spreadLabel", "A number, such as 1.2, shows as “1.2 pips”; other text, such as From 0.0, shows as written.")}>
            <input className="input" value={f.spreadLabel} onChange={(e) => set({ spreadLabel: e.target.value })} maxLength={40} />
          </Field>
          <Field label="Commission (optional)" hint={hint("commissionLabel", "A number, such as 7, shows as “$7”. Left empty, the portal shows “Unavailable”.")}>
            <input className="input" value={f.commissionLabel} onChange={(e) => set({ commissionLabel: e.target.value })} maxLength={40} />
          </Field>
          <Field label="Minimum deposit (USD)" hint={hint("minDeposit", "Clients need this much in their wallet to open an account. Leave empty for none.")}>
            <input className="input" inputMode="decimal" value={f.minDeposit} onChange={(e) => set({ minDeposit: e.target.value })} maxLength={16} placeholder="0" />
          </Field>
        </div>
        <Field label="Description (optional)" hint={hint("description")}>
          <textarea className="input input-area" rows={2} value={f.description} onChange={(e) => set({ description: e.target.value })} maxLength={300} />
        </Field>
        <Field label="Highlights (optional)" hint={hint("highlights", "One per line, up to 8 lines. Shown as a list on the package card.")}>
          <textarea className="input input-area" rows={4} value={f.highlights} onChange={(e) => set({ highlights: e.target.value })} placeholder={"Spreads from 0.0 pips\nNo requotes"} />
        </Field>
        <div className="check-row">
          <label className="check">
            <input type="checkbox" checked={f.isRecommended} onChange={(e) => set({ isRecommended: e.target.checked })} />
            <span>
              <Star size={13} /> Recommended
              <small className="muted block">The portal and app point clients to it.</small>
            </span>
          </label>
          <label className="check">
            <input type="checkbox" checked={f.isVisible} onChange={(e) => set({ isVisible: e.target.checked })} />
            <span>
              Shown to clients
              <small className="muted block">Hidden packages cannot be chosen for new accounts.</small>
            </span>
          </label>
        </div>
        <h3 style={{ marginTop: 18 }}>In MT5 (clients never see this)</h3>
        <div className="form-grid">
          <Field label="MT5 server" hint={hint("serverCode", servers.error ? "The server list could not be loaded." : undefined)}>
            {mayServers && !servers.error ? (
              <select className="input" value={f.serverCode} onChange={(e) => set({ serverCode: e.target.value })}>
                <option value="">Choose a server</option>
                {!knownServer && f.serverCode && <option value={f.serverCode}>{f.serverCode}</option>}
                {serverList.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.label} ({s.code}){s.isEnabled ? "" : ", switched off"}
                  </option>
                ))}
              </select>
            ) : (
              <input className="input mono" value={f.serverCode} onChange={(e) => set({ serverCode: e.target.value.trim() })} maxLength={16} />
            )}
          </Field>
          <Field label="MT5 group" hint={hint("mt5Group", "Exactly as the broker named it, such as real\\standard. The gateway must allow it too.")}>
            <input className="input mono" value={f.mt5Group} onChange={(e) => set({ mt5Group: e.target.value })} maxLength={64} autoComplete="off" spellCheck={false} />
          </Field>
          <Field label="Order" hint={hint("sortOrder", "Lower numbers are listed first.")}>
            <input className="input" inputMode="numeric" value={f.sortOrder} onChange={(e) => set({ sortOrder: e.target.value })} maxLength={8} />
          </Field>
        </div>
        {movesAccounts && pkg && (
          <div className="notice notice-warn">
            <p>
              {pkg.accounts === 1 ? "One account was" : `${pkg.accounts.toLocaleString()} accounts were`} opened with this package. They stay on their current server and group; only accounts
              opened from now on use the new one.
            </p>
          </div>
        )}
        {pkg && (
          <p className="muted tight">
            Last changed {formatDate(pkg.updatedAt)}
            {pkg.updatedBy?.name ? ` by ${pkg.updatedBy.name}` : ""}.
          </p>
        )}
        <DecisionError error={save.error} />
        <div className="actions">
          <button type="button" className="button" onClick={onClose}>
            {pkg && !changed.length ? "Close" : "Cancel"}
          </button>
          <button type="submit" className="button button-primary" disabled={save.isPending || (tried && !ok) || (Boolean(pkg) && !changed.length)}>
            {save.isPending && <Spinner />} {pkg ? "Save changes" : "Add package"}
          </button>
        </div>
        <p className="muted tight">You'll be asked for your 2FA code.</p>
      </form>
    </Dialog>
  );
}
