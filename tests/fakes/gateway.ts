import { MT5_GROUP, MT5_REFERENCE, SERVER_CODE, type Mt5Account, type Mt5Deal, type Mt5User, type OpName, type Ops } from "../../src/gateway/protocol";
import { GatewayError, type Mt5Gateway } from "../../src/server/mt5/gateway";

// An in-memory MT5 gateway for tests: every operation, with the same rules
// as the real gateway (server and group allow-lists, the leverage list, the
// BIS- comment format, a balance deal that is never made twice for one
// comment, no_money when check_margin would leave the account short), plus
// faults on demand and helpers to look inside.

export type Fault =
  | { kind: "refused"; code: GatewayError["code"]; message?: string }
  /** Never reached MT5. */
  | { kind: "unavailable" }
  /** The gateway refused the request itself. */
  | { kind: "bad_request" }
  /** The answer was lost before MT5 did anything. */
  | { kind: "unknown-before" }
  /** MT5 did it, then the answer was lost. */
  | { kind: "unknown-after" };

export interface FakeServer {
  /** Live groups the gateway allows. */
  groups: string[];
  /** Demo groups the gateway allows. */
  demoGroups: string[];
}

export interface FakeUser extends Mt5User {
  server: string;
  passwords: { main: string; investor: string };
  balanceCents: number;
  creditCents: number;
  marginCents: number;
  profitCents: number;
  positions: number;
}

/** What one call looked like, with passwords blanked out. */
export interface FakeCall {
  op: OpName;
  req: Record<string, unknown>;
}

const RIGHTS_ENABLED = 0x1n;
const RIGHTS_TRADE_DISABLED = 0x4n;
const DEFAULT_RIGHTS = 0x163n;

export class FakeGateway implements Mt5Gateway {
  readonly servers = new Map<string, FakeServer>();
  readonly leverages: Set<number>;
  readonly users = new Map<string, FakeUser>();
  readonly deals: (Mt5Deal & { server: string })[] = [];
  readonly calls: FakeCall[] = [];
  /** Per-operation cap for one balance deal, in cents, like GATEWAY_MAX_OP_CENTS. */
  maxOpCents = 10_000_000;
  /** Every call answers "unavailable" while true (the gateway is down). */
  down = false;
  private faults = new Map<OpName, { fault: Fault; when?: (req: Record<string, unknown>) => boolean }[]>();
  private pauses = new Map<OpName, { reached: () => void; released: Promise<void> }[]>();
  private nextLogin = 500_001;
  private nextTicket = 9_000_001;

  constructor(opts: { servers?: Record<string, FakeServer>; leverages?: number[] } = {}) {
    for (const [code, s] of Object.entries(opts.servers ?? { live: { groups: ["real\\standard", "real\\raw"], demoGroups: [] }, demo: { groups: [], demoGroups: ["demo\\usd"] } })) {
      this.servers.set(code, s);
    }
    this.leverages = new Set(opts.leverages ?? [100, 500, 1000, 2000]);
  }

  // ---------- Test controls ----------

  /**
   * The next `times` calls of `op` meet `fault`; with `when`, only the calls
   * whose request it accepts (e.g. `(r) => r.type === "investor"`).
   */
  failNext(op: OpName, fault: Fault, times = 1, when?: (req: Record<string, unknown>) => boolean) {
    const list = this.faults.get(op) ?? [];
    for (let i = 0; i < times; i++) list.push({ fault, when });
    this.faults.set(op, list);
  }

  /**
   * Holds the next call of `op` until `release()`. `reached` resolves when
   * the call arrives, so a test can line up a second request behind it.
   */
  pause(op: OpName) {
    let reached!: () => void;
    let release!: () => void;
    const arrived = new Promise<void>((resolve) => (reached = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    const list = this.pauses.get(op) ?? [];
    list.push({ reached, released });
    this.pauses.set(op, list);
    return { reached: arrived, release };
  }

  /** Forgets pending faults and pauses. */
  clearFaults() {
    this.faults.clear();
    this.pauses.clear();
  }

  user(server: string, login: number): FakeUser | undefined {
    return this.users.get(`${server}:${login}`);
  }

  /** Puts an account straight into MT5 (as if opened elsewhere). */
  addUser(server: string, u: Partial<FakeUser> & { group: string }): FakeUser {
    const login = u.login ?? this.nextLogin++;
    const user: FakeUser = {
      login, group: u.group, name: u.name ?? "Test User", email: u.email ?? "user@test.local", leverage: u.leverage ?? 2000, rights: (u.rights ?? DEFAULT_RIGHTS.toString()),
      enabled: true, tradeDisabled: false, comment: u.comment ?? "", registeredAt: u.registeredAt ?? new Date().toISOString(), server,
      passwords: u.passwords ?? { main: "Main-Pass-1", investor: "Inv-Pass-1" }, balanceCents: u.balanceCents ?? 0, creditCents: u.creditCents ?? 0,
      marginCents: u.marginCents ?? 0, profitCents: u.profitCents ?? 0, positions: u.positions ?? 0,
    };
    this.users.set(`${server}:${login}`, this.withRights(user));
    return this.users.get(`${server}:${login}`)!;
  }

  /** Changes an account's money or open positions, as trading would. */
  setAccount(server: string, login: number, change: Partial<Pick<FakeUser, "balanceCents" | "creditCents" | "marginCents" | "profitCents" | "positions">>) {
    const u = this.user(server, login);
    if (!u) throw new Error(`no fake MT5 user ${server}:${login}`);
    Object.assign(u, change);
  }

  /** Plants a deal, for instance one with a reference that does not match its amount. */
  addDeal(server: string, d: Partial<Mt5Deal> & { login: number; comment: string; profitCents: number }) {
    const deal = this.makeDeal(server, d.login, d.profitCents, d.comment, d.action ?? 2);
    Object.assign(deal, d);
    this.deals.push(deal);
    return deal;
  }

  dealsOf(server: string, login: number) {
    return this.deals.filter((d) => d.server === server && d.login === login);
  }

  callsTo(op: OpName) {
    return this.calls.filter((c) => c.op === op);
  }

  // ---------- The gateway ----------

  async call<K extends OpName>(op: K, req: Ops[K]["req"]): Promise<Ops[K]["res"]> {
    const body = req as Record<string, unknown>;
    this.calls.push({ op, req: Object.fromEntries(Object.entries(body).map(([k, v]) => [k, /password/i.test(k) ? "***" : v])) });
    const pause = this.pauses.get(op)?.shift();
    if (pause) {
      pause.reached();
      await pause.released;
    }
    if (this.down) throw new GatewayError("unavailable", "connection", "No connection to MT5.");
    const queued = this.faults.get(op) ?? [];
    const at = queued.findIndex((f) => !f.when || f.when(body));
    const fault = at < 0 ? undefined : queued.splice(at, 1)[0]!.fault;
    if (fault?.kind === "refused") throw new GatewayError("refused", fault.code, fault.message ?? `MT5 refused (${fault.code})`);
    if (fault?.kind === "unavailable") throw new GatewayError("unavailable", "connection", "No connection to MT5.");
    if (fault?.kind === "bad_request") throw new GatewayError("bad_request", "bad_request", "The gateway refused the request.");
    if (fault?.kind === "unknown-before") throw new GatewayError("unknown", "timeout", "MT5 did not answer in time.");
    const result = this.apply(op, body) as Ops[K]["res"];
    if (fault?.kind === "unknown-after") throw new GatewayError("unknown", "timeout", "MT5 did not answer in time.");
    return structuredClone(result);
  }

  private apply(op: OpName, r: Record<string, unknown>): unknown {
    const server = this.server(r.server);
    switch (op) {
      case "ping":
        return { serverTime: Math.floor(Date.now() / 1000) };
      case "user.get":
        return this.publicUser(this.allowedUser(server, r.login));
      case "accounts.get": {
        const logins = r.logins as number[];
        if (!Array.isArray(logins) || logins.length < 1 || logins.length > 100) this.badRequest();
        const accounts: Mt5Account[] = [];
        const missing: number[] = [];
        for (const login of logins) {
          const u = this.user(server, login);
          if (!u || !this.groupAllowed(server, u.group)) missing.push(login);
          else accounts.push(this.figures(u));
        }
        return { accounts, missing };
      }
      case "user.create": {
        const group = String(r.group);
        this.assertGroup(server, group);
        this.assertLeverage(r.leverage);
        if (!MT5_REFERENCE.test(String(r.comment))) this.badRequest();
        for (const p of [r.password, r.investorPassword]) if (typeof p !== "string" || p.length < 8) throw new GatewayError("refused", "invalid_password", "3006 Invalid account password");
        const user = this.addUser(server, {
          group, name: String(r.name), email: String(r.email), leverage: Number(r.leverage), comment: String(r.comment),
          passwords: { main: String(r.password), investor: String(r.investorPassword) },
        });
        return { login: user.login };
      }
      case "user.find": {
        const group = String(r.group);
        this.assertGroup(server, group);
        const found = [...this.users.values()].filter((u) => u.server === server && u.group === group && u.comment === r.comment).at(-1);
        return { login: found?.login ?? null };
      }
      case "user.update": {
        const u = this.allowedUser(server, r.login);
        if (r.leverage !== undefined) {
          this.assertLeverage(r.leverage);
          u.leverage = Number(r.leverage);
        }
        let rights = BigInt(u.rights);
        if (r.enabled !== undefined) rights = r.enabled ? rights | RIGHTS_ENABLED : rights & ~RIGHTS_ENABLED;
        if (r.tradeDisabled !== undefined) rights = r.tradeDisabled ? rights | RIGHTS_TRADE_DISABLED : rights & ~RIGHTS_TRADE_DISABLED;
        u.rights = rights.toString();
        this.withRights(u);
        return this.publicUser(u);
      }
      case "user.password": {
        const u = this.allowedUser(server, r.login);
        if (r.type !== "main" && r.type !== "investor") this.badRequest();
        if (typeof r.password !== "string" || r.password.length < 8) throw new GatewayError("refused", "invalid_password", "3006 Invalid account password");
        u.passwords[r.type as "main" | "investor"] = r.password;
        return {};
      }
      case "positions.total":
        return { total: this.allowedUser(server, r.login).positions };
      case "balance": {
        const u = this.allowedUser(server, r.login);
        const amount = Number(r.amountCents);
        const comment = String(r.comment);
        if (!MT5_REFERENCE.test(comment) || !Number.isSafeInteger(amount) || amount === 0) this.badRequest();
        if (Math.abs(amount) > this.maxOpCents) throw new GatewayError("refused", "over_limit", "Above the gateway's per-operation cap.");
        // Never twice for one comment: a repeat answers the first deal.
        const earlier = this.deals.find((d) => d.server === server && d.login === u.login && d.action === 2 && d.comment === comment);
        if (earlier) return { ticket: earlier.ticket, duplicate: true };
        if (r.checkMargin && amount < 0) {
          const f = this.figures(u);
          if (u.balanceCents + amount < 0 || f.marginFreeCents + amount < 0) throw new GatewayError("refused", "no_money", "10019 Not enough money");
        }
        u.balanceCents += amount;
        const deal = this.makeDeal(server, u.login, amount, comment, 2);
        this.deals.push(deal);
        return { ticket: deal.ticket, duplicate: false };
      }
      case "deal.find": {
        const u = this.allowedUser(server, r.login);
        const from = Date.parse(String(r.from));
        const deal = this.deals.find((d) => d.server === server && d.login === u.login && d.comment === r.comment && Date.parse(d.timeUtc) >= from);
        return { deal: deal ? this.publicDeal(deal) : null };
      }
      case "deals.page": {
        const u = this.allowedUser(server, r.login);
        const [from, to] = [Date.parse(String(r.from)), Date.parse(String(r.to))];
        const list = this.deals.filter((d) => d.server === server && d.login === u.login && Date.parse(d.timeUtc) >= from && Date.parse(d.timeUtc) <= to);
        const offset = Number(r.offset ?? 0);
        const limit = Math.min(1000, Number(r.limit ?? 1000));
        return { total: list.length, deals: list.slice(offset, offset + limit).map((d) => this.publicDeal(d)) };
      }
    }
    return this.badRequest();
  }

  // ---------- Rules ----------

  private badRequest(): never {
    throw new GatewayError("bad_request", "bad_request", "The gateway refused the request.");
  }

  private server(code: unknown): string {
    if (typeof code !== "string" || !SERVER_CODE.test(code) || !this.servers.has(code)) this.badRequest();
    return code as string;
  }

  private groupAllowed(server: string, group: string) {
    const s = this.servers.get(server)!;
    return s.groups.includes(group) || s.demoGroups.includes(group);
  }

  private assertGroup(server: string, group: string) {
    if (!MT5_GROUP.test(group)) this.badRequest();
    if (!this.groupAllowed(server, group)) throw new GatewayError("refused", "group_not_allowed", "This group is not in the gateway's list.");
  }

  private assertLeverage(leverage: unknown) {
    if (!this.leverages.has(Number(leverage))) throw new GatewayError("refused", "policy", "This leverage is not in the gateway's list.");
  }

  /** The login's user, refused unless its group is allowed (as the real gateway checks before every operation). */
  private allowedUser(server: string, login: unknown): FakeUser {
    const u = typeof login === "number" ? this.user(server, login) : undefined;
    if (!u) throw new GatewayError("refused", "not_found", "13 Not found");
    if (!this.groupAllowed(server, u.group)) throw new GatewayError("refused", "group_not_allowed", "This account's group is not in the gateway's list.");
    return u;
  }

  private withRights(u: FakeUser): FakeUser {
    const rights = BigInt(u.rights);
    u.enabled = (rights & RIGHTS_ENABLED) !== 0n;
    u.tradeDisabled = (rights & RIGHTS_TRADE_DISABLED) !== 0n;
    return u;
  }

  private publicUser(u: FakeUser): Mt5User {
    return { login: u.login, group: u.group, name: u.name, email: u.email, leverage: u.leverage, rights: u.rights, enabled: u.enabled, tradeDisabled: u.tradeDisabled, comment: u.comment, registeredAt: u.registeredAt };
  }

  private figures(u: FakeUser): Mt5Account {
    const equity = u.balanceCents + u.creditCents + u.profitCents;
    return { login: u.login, balanceCents: u.balanceCents, creditCents: u.creditCents, equityCents: equity, marginCents: u.marginCents, marginFreeCents: equity - u.marginCents, profitCents: u.profitCents };
  }

  private makeDeal(server: string, login: number, amount: number, comment: string, action: number): Mt5Deal & { server: string } {
    const now = Date.now();
    return {
      server, ticket: this.nextTicket++, login, action, entry: 0, positionId: 0, order: 0, symbol: "", volume: 0, price: "0", profitCents: amount,
      commissionCents: 0, swapCents: 0, feeCents: 0, comment, time: Math.floor(now / 1000), timeMsc: now, timeUtc: new Date(now).toISOString(),
    };
  }

  private publicDeal(d: Mt5Deal & { server: string }): Mt5Deal {
    const { server: _server, ...deal } = d;
    return deal;
  }
}
