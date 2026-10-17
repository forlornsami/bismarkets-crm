import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownToLine, ArrowUpFromLine, ImageUp, Lock, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ImageCanvas, KIND_LABEL, minorText, money, networkLabel, NETWORK_LABEL, parseAmountText, rateText, usePaymentMethods, type PaymentMethod, type Person } from "../components/money";
import { DecisionError } from "../components/ReviewWorkbench";
import { Badge, Dialog, EmptyState, ErrorText, Field, PageHeader, Spinner, useFeedback } from "../components/ui";
import { api, formatDate } from "../lib/api";
import { useCan } from "../lib/session";
import { NOT_PLAIN } from "../../shared/money";

// Where clients send deposits (the broker's own accounts), the kinds of
// account clients can withdraw to, and the money limits. Every change asks for
// a 2FA code and is recorded in the audit log.

type Direction = PaymentMethod["direction"];
type Kind = PaymentMethod["kind"];

const METHODS_KEY = ["payment-methods"];

export function PaymentMethods() {
  const can = useCan();
  const editable = can("payment.manage");
  const methods = usePaymentMethods();
  const [editing, setEditing] = useState<{ id: number } | { direction: Direction } | null>(null);
  const items = methods.data?.items ?? [];
  const current = editing && "id" in editing ? items.find((m) => m.id === editing.id) : undefined;
  return (
    <>
      <PageHeader
        title="Payment methods"
        description="The accounts clients pay deposits into, the kinds of account they can withdraw to, and the money limits. Every change asks for your 2FA code and is recorded in the audit log."
        badge={!editable && <Badge tone="neutral">View only</Badge>}
        actions={
          editable && (
            <>
              <button type="button" className="button" onClick={() => setEditing({ direction: "withdrawal" })}>
                <Plus size={16} /> Add payout type
              </button>
              <button type="button" className="button button-primary" onClick={() => setEditing({ direction: "deposit" })}>
                <Plus size={16} /> Add deposit method
              </button>
            </>
          )
        }
      />
      <ErrorText error={methods.error} />
      <MethodTable
        title="Deposit methods"
        icon={<ArrowDownToLine size={18} />}
        help="The broker's own bank accounts and wallets. Every verified client sees these details when they deposit."
        direction="deposit"
        items={items.filter((m) => m.direction === "deposit")}
        loading={methods.isLoading}
        editable={editable}
        onEdit={(m) => setEditing({ id: m.id })}
      />
      <MethodTable
        title="Payout types"
        icon={<ArrowUpFromLine size={18} />}
        help="The kinds of account clients can save for withdrawals. The portal sorts them by name, so bank types say Bank or Wire and crypto types say TRC, BEP or Binance."
        direction="withdrawal"
        items={items.filter((m) => m.direction === "withdrawal")}
        loading={methods.isLoading}
        editable={editable}
        onEdit={(m) => setEditing({ id: m.id })}
      />
      <LimitsCard />
      {editing && (!("id" in editing) || current) && (
        <MethodDialog
          key={"id" in editing ? `edit-${editing.id}` : `new-${editing.direction}`}
          method={current}
          direction={current?.direction ?? ("direction" in editing ? editing.direction : "deposit")}
          onCreated={(m) => (m.direction === "deposit" && m.kind === "crypto" ? setEditing({ id: m.id }) : setEditing(null))}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function MethodTable({ title, icon, help, direction, items, loading, editable, onEdit }: { title: string; icon: ReactNode; help: string; direction: Direction; items: PaymentMethod[]; loading: boolean; editable: boolean; onEdit: (m: PaymentMethod) => void }) {
  const client = useQueryClient();
  const { toast, confirm } = useFeedback();
  const toggle = useMutation({
    mutationFn: (m: PaymentMethod) => api.patch<PaymentMethod>(`/api/staff/money/methods/${m.id}`, { isEnabled: !m.isEnabled }),
    onSuccess: (_res, m) => {
      toast(m.isEnabled ? `${m.name} is turned off. Clients no longer see it.` : `${m.name} is turned on. Clients can use it now.`);
      void client.invalidateQueries({ queryKey: METHODS_KEY });
    },
    onError: (e) => toast(e instanceof Error ? e.message : "That did not work.", "bad"),
  });
  const flip = async (m: PaymentMethod) => {
    if (
      m.isEnabled &&
      !(await confirm({
        title: `Turn off ${m.name}?`,
        body: direction === "deposit" ? "Clients stop seeing it straight away. Deposits already sent with it stay in the queue." : "Clients can no longer save or use accounts of this type. Withdrawals already sent stay in the queue.",
        confirmLabel: "Turn off",
      }))
    )
      return;
    toggle.mutate(m);
  };
  const deposit = direction === "deposit";
  return (
    <section className="grid" style={{ marginBottom: 18 }}>
      <div className="grid-toolbar">
        <div>
          <h2 className="flush">
            {icon} {title}
          </h2>
          <small className="muted">{help}</small>
        </div>
      </div>
      <div className="grid-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>{deposit ? "Pay into" : "Network"}</th>
              {deposit ? <th>Minimum</th> : <th>QR code</th>}
              {deposit && <th>QR code</th>}
              <th>In use</th>
              <th>Shown to clients</th>
              {editable && <th aria-label="Edit" />}
            </tr>
          </thead>
          <tbody>
            {items.map((m) => (
              <tr key={m.id}>
                <td data-label="Name">
                  <span className="stack-tight">
                    <strong>{m.name}</strong>
                    <small className="muted">
                      {KIND_LABEL[m.kind]}
                      {deposit ? ` · ${m.currency}` : ""}
                      {m.network ? ` · ${networkLabel(m.network)}` : ""}
                    </small>
                  </span>
                </td>
                <td data-label={deposit ? "Pay into" : "Network"}>
                  {deposit ? (
                    m.kind === "bank" ? (
                      <span className="stack-tight">
                        <span>{m.bankName}</span>
                        <small className="muted">
                          {m.accountTitle} · <span className="mono">{m.iban || m.accountNumber}</span>
                        </small>
                      </span>
                    ) : (
                      <span className="mono truncate" title={m.walletAddress} style={{ display: "inline-block", maxWidth: 220 }}>
                        {m.walletAddress}
                      </span>
                    )
                  ) : (
                    networkLabel(m.network) || <span className="muted">–</span>
                  )}
                </td>
                {deposit ? (
                  <td data-label="Minimum">{m.minMinor ? money(m.minMinor, m.currency) : <span className="muted">The general minimum</span>}</td>
                ) : (
                  <td data-label="QR code">{m.kind === "crypto" ? (m.askQr ? "Client must add one" : "Not asked") : <span className="muted">–</span>}</td>
                )}
                {deposit && <td data-label="QR code">{m.kind === "crypto" ? (m.hasQr ? <Badge tone="good">Added</Badge> : <Badge tone="warn">None</Badge>) : <span className="muted">–</span>}</td>}
                <td data-label="In use">
                  {m.usage?.open ? `${m.usage.open} open · ` : ""}
                  {m.usage?.total ?? 0} in total
                </td>
                <td data-label="Shown to clients">
                  {editable ? (
                    <label className="check grid-check">
                      <input type="checkbox" checked={m.isEnabled} disabled={toggle.isPending} onChange={() => void flip(m)} />
                      <span>{m.isEnabled ? "On" : "Off"}</span>
                    </label>
                  ) : m.isEnabled ? (
                    <Badge tone="good">On</Badge>
                  ) : (
                    <Badge tone="neutral">Off</Badge>
                  )}
                </td>
                {editable && (
                  <td>
                    <button type="button" className="button button-small" onClick={() => onEdit(m)}>
                      <Pencil size={14} /> Edit
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {!loading && items.length === 0 && (
              <tr>
                <td colSpan={editable ? 7 : 6} className="empty">
                  <EmptyState icon={deposit ? <ArrowDownToLine size={32} /> : <ArrowUpFromLine size={32} />} title={deposit ? "No deposit methods yet" : "No payout types yet"}>
                    {deposit ? "Clients cannot deposit until at least one method is added and turned on." : "Clients cannot save a payout account until at least one type is added and turned on."}
                  </EmptyState>
                </td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={editable ? 7 : 6}>
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

// ---------- Add or edit a method ----------

interface Draft {
  kind: Kind;
  name: string;
  currency: "USD" | "PKR";
  network: PaymentMethod["network"];
  bankName: string;
  accountTitle: string;
  accountNumber: string;
  iban: string;
  walletAddress: string;
  amountNote: string;
  feeLabel: string;
  processingLabel: string;
  min: string;
  askQr: boolean;
  isEnabled: boolean;
  sortOrder: string;
}

const draftOf = (m: PaymentMethod | undefined): Draft => ({
  kind: m?.kind ?? "bank",
  name: m?.name ?? "",
  currency: m?.currency ?? "USD",
  network: m?.network ?? "",
  bankName: m?.bankName ?? "",
  accountTitle: m?.accountTitle ?? "",
  accountNumber: m?.accountNumber ?? "",
  iban: m?.iban ?? "",
  walletAddress: m?.walletAddress ?? "",
  amountNote: m?.amountNote ?? "",
  feeLabel: m?.feeLabel ?? "",
  processingLabel: m?.processingLabel ?? "",
  min: minorText(m?.minMinor),
  askQr: m?.askQr ?? false,
  isEnabled: m?.isEnabled ?? true,
  sortOrder: String(m?.sortOrder ?? 0),
});

/** The fields that apply to this direction and kind, as the server takes them. */
function bodyOf(direction: Direction, f: Draft): Record<string, unknown> {
  const b: Record<string, unknown> = { name: f.name.trim(), isEnabled: f.isEnabled, sortOrder: Number(f.sortOrder.trim() || 0) };
  if (direction === "deposit") {
    const min = f.min.trim() ? parseAmountText(f.min) : null;
    Object.assign(b, { amountNote: f.amountNote.trim(), feeLabel: f.feeLabel.trim(), processingLabel: f.processingLabel.trim(), minMinor: min?.minor ?? null });
    if (f.kind === "bank") Object.assign(b, { currency: f.currency, bankName: f.bankName.trim(), accountTitle: f.accountTitle.trim(), accountNumber: f.accountNumber.trim(), iban: f.iban.trim() });
    else Object.assign(b, { currency: "USD", network: f.network, walletAddress: f.walletAddress.trim() });
  } else if (f.kind === "crypto") Object.assign(b, { network: f.network, askQr: f.askQr });
  return b;
}

const ACCOUNT_FIELDS = ["currency", "bankName", "accountTitle", "accountNumber", "iban", "network", "walletAddress"];

// The same checks the server makes, so mistakes show before the 2FA prompt.
const NETWORK_WORD: Record<Exclude<Draft["network"], "">, { word: RegExp; example: string }> = {
  trc20: { word: /trc/i, example: "USDT TRC20" },
  bep20: { word: /bep/i, example: "USDT BEP20" },
  binance_pay: { word: /binance/i, example: "Binance Pay" },
};
const ADDRESS: Record<Exclude<Draft["network"], "">, { pattern: RegExp; message: string }> = {
  trc20: { pattern: /^T[1-9A-HJ-NP-Za-km-z]{33}$/, message: "A TRC20 address starts with T and has 34 characters." },
  bep20: { pattern: /^0x[0-9a-fA-F]{40}$/, message: "A BEP20 address starts with 0x followed by 40 letters and digits." },
  binance_pay: { pattern: /^\d{6,12}$/, message: "Enter the Binance Pay ID (6 to 12 digits)." },
};
const ACCOUNT_TEXT = /^[A-Za-z0-9 ./-]*$/;

function problemsOf(direction: Direction, f: Draft): Partial<Record<keyof Draft, string>> {
  const p: Partial<Record<keyof Draft, string>> = {};
  const text = (key: keyof Draft, label: string, max: number, required: boolean) => {
    const v = String(f[key]).trim();
    if (required && !v) p[key] = `Enter the ${label}.`;
    else if (v.length > max) p[key] = `Keep the ${label} under ${max} characters.`;
    else if (NOT_PLAIN.test(v)) p[key] = `Write the ${label} as plain text, without links or symbols like < > { }`;
  };
  text("name", "name", 80, true);
  if (!p.name && f.name.trim().length < 2) p.name = "Enter a name of at least 2 characters.";
  if (f.kind === "crypto" && !f.network) p.network = "Choose the network.";
  if (!p.name && direction === "withdrawal") {
    if (f.kind === "bank" && !/bank|wire/i.test(f.name)) p.name = "Put “Bank” or “Wire” in the name (for example “Bank transfer”), so the portal and app show the bank form.";
    if (f.kind === "crypto" && f.network && (!NETWORK_WORD[f.network].word.test(f.name) || /bank|wire|iban/i.test(f.name)))
      p.name = `Name it after its network (for example “${NETWORK_WORD[f.network].example}”), so the portal and app show the right form.`;
  }
  if (direction === "deposit") {
    if (f.kind === "bank") {
      text("bankName", "bank name", 120, true);
      text("accountTitle", "account title", 120, true);
      text("accountNumber", "account number", 64, true);
      text("iban", "IBAN", 64, false);
      for (const [key, label] of [["accountNumber", "account number"], ["iban", "IBAN"]] as const) {
        if (!p[key] && !ACCOUNT_TEXT.test(f[key].trim())) p[key] = `Use letters, digits, spaces and - . / only in the ${label}.`;
      }
      if (!p.accountNumber && f.accountNumber.trim().length < 4) p.accountNumber = "Enter the account number (at least 4 characters).";
      if (!p.iban && f.iban.trim() && f.iban.replace(/[\s./-]/g, "").length < 8) p.iban = "Enter the full IBAN, or leave it empty.";
    } else {
      const address = f.walletAddress.trim();
      if (!address) p.walletAddress = `Enter the ${f.network === "binance_pay" ? "Binance Pay ID" : "wallet address"}.`;
      else if (f.network && !ADDRESS[f.network].pattern.test(address)) p.walletAddress = ADDRESS[f.network].message;
    }
    text("amountNote", "note", 300, false);
    text("feeLabel", "fee text", 60, false);
    text("processingLabel", "processing time", 60, false);
    if (f.min.trim()) {
      const r = parseAmountText(f.min);
      if (r.problem) p.min = r.problem;
    }
  }
  if (!/^-?\d{1,7}$/.test(f.sortOrder.trim() || "0") || Math.abs(Number(f.sortOrder)) > 1_000_000) p.sortOrder = "Enter a whole number.";
  return p;
}

function MethodDialog({ method, direction, onCreated, onClose }: { method?: PaymentMethod; direction: Direction; onCreated: (m: PaymentMethod) => void; onClose: () => void }) {
  const client = useQueryClient();
  const { toast } = useFeedback();
  const initial = useRef(draftOf(method));
  const [f, setF] = useState<Draft>(initial.current);
  const [tried, setTried] = useState(false);
  const set = (patch: Partial<Draft>) => setF((old) => ({ ...old, ...patch }));
  const deposit = direction === "deposit";
  const problems = problemsOf(direction, f);
  const ok = Object.keys(problems).length === 0;
  const show = (key: keyof Draft) => (tried || String(f[key]).trim() !== String(initial.current[key]).trim() ? problems[key] : undefined);
  const before = bodyOf(direction, initial.current);
  const after = bodyOf(direction, f);
  const changed = Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k]));
  const accountChanged = Boolean(method && deposit && changed.some((k) => ACCOUNT_FIELDS.includes(k)));
  // Deposits waiting for review were paid to these details, so they stay as they are until those are decided.
  const lockAccount = Boolean(method && deposit && method.usage?.open > 0);
  const save = useMutation({
    mutationFn: () => {
      if (!method) return api.post<PaymentMethod>("/api/staff/money/methods", { direction, kind: f.kind, ...after });
      const patch: Record<string, unknown> = {};
      for (const k of changed) patch[k] = after[k];
      return api.patch<PaymentMethod>(`/api/staff/money/methods/${method.id}`, patch);
    },
    onSuccess: (res) => {
      // A new method is shown straight away (its QR code is added in the same dialog), then the list reloads.
      if (!method && res && typeof res === "object" && "id" in res)
        client.setQueryData(METHODS_KEY, (old: { items: PaymentMethod[] } | undefined) => (old ? { items: [...old.items.filter((m) => m.id !== res.id), { ...res, direction, kind: f.kind }] } : old));
      void client.invalidateQueries({ queryKey: METHODS_KEY });
      if (method) {
        toast(`${f.name.trim()} saved.`);
        onClose();
      } else {
        const created = res && typeof res === "object" && "id" in res ? res : null;
        toast(created && deposit && f.kind === "crypto" ? `${f.name.trim()} added. Add its QR code below.` : `${f.name.trim()} added.`);
        if (created) onCreated({ ...created, direction, kind: f.kind });
        else onClose();
      }
    },
  });
  const hint = (key: keyof Draft, text?: ReactNode) => (show(key) ? <span className="error-text">{show(key)}</span> : text);
  const title = method ? `Edit ${method.name}` : deposit ? "Add a deposit method" : "Add a payout type";
  return (
    <Dialog open title={title} onClose={onClose} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (ok && (!method || changed.length)) save.mutate();
        }}
      >
        {!method && (
          <Field label="Kind">
            <div className="tabs" role="tablist" aria-label="Kind">
              {(["bank", "crypto"] as const).map((k) => (
                <button key={k} type="button" role="tab" aria-selected={f.kind === k} onClick={() => set({ kind: k, ...(k === "crypto" ? { currency: "USD" } : { network: "", askQr: false }) })}>
                  {k === "bank" ? "Bank account" : "Crypto wallet"}
                </button>
              ))}
            </div>
          </Field>
        )}
        <div className="form-grid">
          <Field label="Name clients see" hint={hint("name", deposit ? "For example: Meezan Bank (PKR) or USDT TRC20." : f.kind === "bank" ? "For example: Bank transfer." : "For example: USDT TRC20.")}>
            <input className="input" value={f.name} onChange={(e) => set({ name: e.target.value })} maxLength={80} autoFocus />
          </Field>
          {deposit && f.kind === "bank" && (
            <Field label="Currency clients pay in" hint="PKR deposits are converted to the USD wallet at the rate under Limits.">
              <select className="input" value={f.currency} disabled={lockAccount} onChange={(e) => set({ currency: e.target.value as Draft["currency"] })}>
                <option value="USD">USD</option>
                <option value="PKR">PKR</option>
              </select>
            </Field>
          )}
          {f.kind === "crypto" && (
            <Field label="Network" hint={hint("network")}>
              <select className="input" value={f.network} disabled={lockAccount} onChange={(e) => set({ network: e.target.value as Draft["network"] })}>
                <option value="">{deposit ? "Choose a network" : "Not set"}</option>
                {Object.entries(NETWORK_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
        {deposit && f.kind === "bank" && (
          <div className="form-grid">
            <Field label="Bank name" hint={hint("bankName")}>
              <input className="input" value={f.bankName} disabled={lockAccount} onChange={(e) => set({ bankName: e.target.value })} maxLength={120} />
            </Field>
            <Field label="Account title" hint={hint("accountTitle", "The account holder's name, exactly as the bank has it.")}>
              <input className="input" value={f.accountTitle} disabled={lockAccount} onChange={(e) => set({ accountTitle: e.target.value })} maxLength={120} />
            </Field>
            <Field label="Account number" hint={hint("accountNumber")}>
              <input className="input mono" value={f.accountNumber} disabled={lockAccount} onChange={(e) => set({ accountNumber: e.target.value })} maxLength={64} autoComplete="off" />
            </Field>
            <Field label="IBAN (optional)" hint={hint("iban")}>
              <input className="input mono" value={f.iban} disabled={lockAccount} onChange={(e) => set({ iban: e.target.value })} maxLength={64} autoComplete="off" />
            </Field>
          </div>
        )}
        {deposit && f.kind === "crypto" && (
          <Field
            label={f.network === "binance_pay" ? "Our Binance Pay ID" : "Our wallet address"}
            hint={hint("walletAddress", f.network === "binance_pay" ? "Clients send to this Binance Pay ID." : "Clients send crypto to this address. Copy it from the wallet; do not type it.")}
          >
            <input className="input mono" value={f.walletAddress} disabled={lockAccount} onChange={(e) => set({ walletAddress: e.target.value })} maxLength={128} autoComplete="off" />
          </Field>
        )}
        {lockAccount && method && (
          <div className="notice">
            <Lock size={16} />
            <p>
              {method.usage.open === 1 ? "A deposit waiting for review was" : `${method.usage.open} deposits waiting for review were`} paid to these details, so they cannot change now. To use
              another account, add a new method and turn this one off. The name, wording and order can still change.
            </p>
          </div>
        )}
        {accountChanged && (
          <div className="notice notice-warn">
            <p>Clients pay into these details. Check every character: a mistake sends client money to the wrong account. The old and new details are kept in the audit log.</p>
          </div>
        )}
        {deposit && (
          <>
            <Field label="Note for clients (optional)" hint={hint("amountNote", "Shown with the payment details. The CRM adds a line asking clients to write BIS and their client ID as the payment reference.")}>
              <textarea className="input" rows={2} value={f.amountNote} onChange={(e) => set({ amountNote: e.target.value })} maxLength={300} />
            </Field>
            <div className="form-grid">
              <Field label={`Minimum (${f.kind === "crypto" ? "USD" : f.currency}, optional)`} hint={hint("min", "Leave empty to use the minimum deposit under Limits.")}>
                <input className="input" inputMode="decimal" value={f.min} onChange={(e) => set({ min: e.target.value })} maxLength={16} />
              </Field>
              <Field label="Fee text (optional)" hint={hint("feeLabel", "For example: No fee.")}>
                <input className="input" value={f.feeLabel} onChange={(e) => set({ feeLabel: e.target.value })} maxLength={60} />
              </Field>
              <Field label="Processing time (optional)" hint={hint("processingLabel", "For example: Within 1 working day.")}>
                <input className="input" value={f.processingLabel} onChange={(e) => set({ processingLabel: e.target.value })} maxLength={60} />
              </Field>
            </div>
          </>
        )}
        {!deposit && f.kind === "crypto" && (
          <label className="check">
            <input type="checkbox" checked={f.askQr} onChange={(e) => set({ askQr: e.target.checked })} />
            <span>
              Ask the client for a QR code of their wallet
              <small className="muted block">Clients must upload one when they save an account of this type.</small>
            </span>
          </label>
        )}
        <div className="form-grid">
          <Field label="Order" hint={hint("sortOrder", "Lower numbers are listed first.")}>
            <input className="input" inputMode="numeric" value={f.sortOrder} onChange={(e) => set({ sortOrder: e.target.value })} maxLength={7} />
          </Field>
          <Field label="Shown to clients">
            <label className="check">
              <input type="checkbox" checked={f.isEnabled} onChange={(e) => set({ isEnabled: e.target.checked })} />
              <span>{f.isEnabled ? "On" : "Off"}</span>
            </label>
          </Field>
        </div>
        {method && deposit && method.kind === "crypto" && <QrSection method={method} />}
        <DecisionError error={save.error} />
        <div className="actions">
          <button type="button" className="button" onClick={onClose}>
            {method && !changed.length ? "Close" : "Cancel"}
          </button>
          <button type="submit" className="button button-primary" disabled={save.isPending || (tried && !ok) || (Boolean(method) && !changed.length)}>
            {save.isPending && <Spinner />} {method ? "Save changes" : "Add"}
          </button>
        </div>
        <p className="muted tight">You'll be asked for your 2FA code.</p>
      </form>
    </Dialog>
  );
}

const QR_TYPES = ["image/png", "image/jpeg", "image/webp"];
const QR_MAX = 2 * 1024 * 1024;

/** The QR code clients scan to pay a crypto deposit method. */
function QrSection({ method }: { method: PaymentMethod }) {
  const client = useQueryClient();
  const { toast, confirm } = useFeedback();
  const input = useRef<HTMLInputElement>(null);
  const done = (text: string) => {
    toast(text);
    void client.invalidateQueries({ queryKey: METHODS_KEY });
  };
  const upload = useMutation({
    mutationFn: (file: File) => api.post(`/api/staff/money/methods/${method.id}/qr`, file),
    onSuccess: () => done("QR code saved. Clients see it with the wallet address."),
    onError: (e) => toast(e instanceof Error ? e.message : "The QR code could not be saved.", "bad"),
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/api/staff/money/methods/${method.id}/qr`),
    onSuccess: () => done("QR code removed."),
    onError: (e) => toast(e instanceof Error ? e.message : "The QR code could not be removed.", "bad"),
  });
  const pick = (file: File | undefined) => {
    if (!file) return;
    if (!QR_TYPES.includes(file.type)) return toast("Choose a PNG, JPEG or WebP image.", "bad");
    if (file.size > QR_MAX) return toast("The image must be 2 MB or smaller.", "bad");
    upload.mutate(file);
  };
  const busy = upload.isPending || remove.isPending;
  return (
    <section className="review-other" style={{ marginBottom: 14 }}>
      <div className="review-other-head">
        <strong>QR code</strong>
        {method.hasQr ? <Badge tone="good">Added</Badge> : <Badge tone="warn">None</Badge>}
      </div>
      {method.hasQr ? (
        <div className="qr-wrap">
          <ImageCanvas key={method.updatedAt} url={method.qrUrl ?? `/api/staff/money/methods/${method.id}/qr`} label={`QR code for ${method.name}`} size={200} />
        </div>
      ) : (
        <small className="muted">Clients scan it to pay. Make it from the same wallet address shown above, and scan it once yourself to check.</small>
      )}
      <div className="kyc-actions">
        <button type="button" className="button button-small" disabled={busy} onClick={() => input.current?.click()}>
          {upload.isPending ? <Spinner /> : <ImageUp size={14} />} {method.hasQr ? "Replace" : "Upload"}
        </button>
        {method.hasQr && (
          <button
            type="button"
            className="button button-small button-ghost"
            disabled={busy}
            onClick={async () => (await confirm({ title: "Remove the QR code?", body: "Clients will see only the wallet address.", confirmLabel: "Remove" })) && remove.mutate()}
          >
            <Trash2 size={14} /> Remove
          </button>
        )}
        <small className="muted">PNG, JPEG or WebP, up to 2 MB</small>
      </div>
      <input
        ref={input}
        type="file"
        accept={QR_TYPES.join(",")}
        hidden
        onChange={(e) => {
          pick(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </section>
  );
}

// ---------- Money limits ----------

interface MoneySettings {
  minDepositCents: number;
  minWithdrawalCents: number;
  maxWithdrawalCents: number | null;
  minTransferCents: number;
  usdToPkr: string;
  depositSecondApprovalCents: number;
  withdrawalSecondApprovalCents: number;
  firstWithdrawalSecondApproval: boolean;
  updatedAt: string | null;
  updatedBy: Person | null;
}

type AmountKey = "minDepositCents" | "minWithdrawalCents" | "maxWithdrawalCents" | "minTransferCents" | "depositSecondApprovalCents" | "withdrawalSecondApprovalCents";

/** `approval`: changing it needs settings.manage, because it decides when a second person must approve. */
const AMOUNTS: { key: AmountKey; label: string; help: string; approval?: boolean; optional?: boolean }[] = [
  { key: "minDepositCents", label: "Minimum deposit", help: "The smallest deposit a client can ask for. PKR methods convert it at the rate below unless they have their own minimum." },
  { key: "minWithdrawalCents", label: "Minimum withdrawal", help: "The smallest withdrawal a client can ask for." },
  { key: "maxWithdrawalCents", label: "Maximum withdrawal", help: "The largest single withdrawal. Leave empty for no limit.", optional: true },
  { key: "minTransferCents", label: "Minimum transfer", help: "The smallest transfer a client can make between their accounts." },
  { key: "depositSecondApprovalCents", label: "Deposit second-approval limit", help: "Deposits that credit more than this need a second person to approve them.", approval: true },
  { key: "withdrawalSecondApprovalCents", label: "Withdrawal second-approval limit", help: "Withdrawals above this need a second person to approve them.", approval: true },
];

type LimitsForm = Record<AmountKey, string> & { usdToPkr: string; firstWithdrawalSecondApproval: boolean };

const formOf = (s: MoneySettings): LimitsForm => ({
  minDepositCents: minorText(s.minDepositCents),
  minWithdrawalCents: minorText(s.minWithdrawalCents),
  maxWithdrawalCents: minorText(s.maxWithdrawalCents),
  minTransferCents: minorText(s.minTransferCents),
  depositSecondApprovalCents: minorText(s.depositSecondApprovalCents),
  withdrawalSecondApprovalCents: minorText(s.withdrawalSecondApprovalCents),
  usdToPkr: rateText(s.usdToPkr),
  firstWithdrawalSecondApproval: Boolean(s.firstWithdrawalSecondApproval),
});

const RATE = /^\d{1,9}(\.\d{1,6})?$/;

function LimitsCard() {
  const can = useCan();
  const client = useQueryClient();
  const { toast } = useFeedback();
  const settings = useQuery({ queryKey: ["money-settings"], queryFn: () => api.get<MoneySettings>("/api/staff/money/settings") });
  const mayLimits = can("payment.manage");
  const mayApproval = can("settings.manage");
  const [form, setForm] = useState<LimitsForm | null>(null);
  const s = settings.data;
  useEffect(() => {
    if (s && !form) setForm(formOf(s));
  }, [s, form]);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch<MoneySettings>("/api/staff/money/settings", body),
    onSuccess: (res) => {
      toast("Limits saved.");
      if (res && typeof res === "object" && "minDepositCents" in res) {
        client.setQueryData(["money-settings"], res);
        setForm(formOf(res));
      } else {
        setForm(null);
        void settings.refetch();
      }
      void client.invalidateQueries({ queryKey: ["deposits-summary"] });
      void client.invalidateQueries({ queryKey: ["withdrawals-summary"] });
    },
  });
  if (settings.error)
    return (
      <section className="panel">
        <h2 className="flush">Limits</h2>
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
  const problems: Partial<Record<keyof LimitsForm, string>> = {};
  const cents: Partial<Record<AmountKey, number | null>> = {};
  for (const a of AMOUNTS) {
    const text = form[a.key].trim();
    if (!text && a.optional) cents[a.key] = null;
    else {
      const r = parseAmountText(text);
      if (r.problem) problems[a.key] = r.problem;
      else cents[a.key] = r.minor;
    }
  }
  if (!RATE.test(form.usdToPkr.trim()) || /^0+(\.0+)?$/.test(form.usdToPkr.trim())) problems.usdToPkr = "Enter the rate as a number above zero, with up to 6 decimals, such as 280 or 279.5.";
  else {
    // As the server checks it: one change moves the rate by at most 20% either way.
    const [was, now] = [Number(initial.usdToPkr), Number(form.usdToPkr.trim())];
    if (was > 0 && (now * 100 > was * 120 || was * 100 > now * 120)) problems.usdToPkr = `Change the rate by at most 20% at a time (now ${initial.usdToPkr}). For a bigger change, make it in steps.`;
  }
  const max = cents.maxWithdrawalCents;
  const min = cents.minWithdrawalCents;
  if (typeof max === "number" && typeof min === "number" && max < min) problems.maxWithdrawalCents = "The maximum must be at least the minimum withdrawal.";
  const body: Record<string, unknown> = {};
  for (const a of AMOUNTS) if (form[a.key].trim() !== initial[a.key].trim()) body[a.key] = cents[a.key];
  if (form.usdToPkr.trim() !== initial.usdToPkr) body.usdToPkr = form.usdToPkr.trim();
  if (form.firstWithdrawalSecondApproval !== initial.firstWithdrawalSecondApproval) body.firstWithdrawalSecondApproval = form.firstWithdrawalSecondApproval;
  const dirty = Object.keys(body).length > 0;
  const ok = Object.keys(problems).length === 0;
  const lock = (approval?: boolean) =>
    (approval ? !mayApproval : !mayLimits) ? (
      <span className="lock-hint">
        <Lock size={12} /> {approval ? "Changing this needs the Change system settings permission." : "Changing this needs the payment methods permission."}
      </span>
    ) : null;
  const editableAny = mayLimits || mayApproval;
  return (
    <section className="panel">
      <div className="card-head">
        <div>
          <h2 className="flush">Limits</h2>
          <p>
            All amounts are in US dollars.{s.updatedAt ? ` Last changed ${formatDate(s.updatedAt)}${s.updatedBy?.name ? ` by ${s.updatedBy.name}` : ""}.` : ""}
          </p>
        </div>
        {!editableAny && <Badge tone="neutral">View only</Badge>}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty && ok) save.mutate(body);
        }}
      >
        <div className="form-grid">
          {AMOUNTS.map((a) => (
            <Field
              key={a.key}
              label={`${a.label} (USD)`}
              hint={
                <>
                  {problems[a.key] && form[a.key] !== initial[a.key] ? <span className="error-text block">{problems[a.key]}</span> : a.help}
                  {lock(a.approval) && <span className="block">{lock(a.approval)}</span>}
                </>
              }
            >
              <input
                className="input"
                inputMode="decimal"
                value={form[a.key]}
                placeholder={a.optional ? "No limit" : undefined}
                disabled={a.approval ? !mayApproval : !mayLimits}
                onChange={(e) => setForm({ ...form, [a.key]: e.target.value })}
                maxLength={16}
              />
            </Field>
          ))}
          <Field
            label="Rupees per US dollar"
            hint={
              <>
                {problems.usdToPkr && form.usdToPkr !== initial.usdToPkr ? <span className="error-text block">{problems.usdToPkr}</span> : "Converts PKR deposits into the USD wallet. Each request keeps the rate it was made at."}
                {lock() && <span className="block">{lock()}</span>}
              </>
            }
          >
            <input className="input" inputMode="decimal" value={form.usdToPkr} disabled={!mayLimits} onChange={(e) => setForm({ ...form, usdToPkr: e.target.value })} maxLength={20} />
          </Field>
        </div>
        <label className="check">
          <input type="checkbox" checked={form.firstWithdrawalSecondApproval} disabled={!mayApproval} onChange={(e) => setForm({ ...form, firstWithdrawalSecondApproval: e.target.checked })} />
          <span>
            Second approval for every client's first withdrawal
            <small className="muted block">A client's first withdrawal needs a second person, whatever the amount.</small>
            {lock(true) && <small className="block">{lock(true)}</small>}
          </span>
        </label>
        {editableAny && (
          <>
            <DecisionError error={save.error} />
            <div className="actions">
              {dirty && (
                <button type="button" className="button" onClick={() => setForm(initial)}>
                  Undo changes
                </button>
              )}
              <button type="submit" className="button button-primary" disabled={!dirty || !ok || save.isPending}>
                {save.isPending && <Spinner />} Save limits
              </button>
            </div>
            <p className="muted tight">You'll be asked for your 2FA code. Changes apply to new requests and to decisions made from now on.</p>
          </>
        )}
      </form>
    </section>
  );
}
