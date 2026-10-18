import { createHash, randomBytes, X509Certificate } from "node:crypto";
import https from "node:https";
import type { TLSSocket } from "node:tls";
import { generate } from "selfsigned";

// A fake MT5 Web API server for tests: HTTPS with a certificate made at test
// time, the real manager sign-in (challenges and password hashes, written
// here independently of the gateway's own code), sessions tied to the TLS
// socket (a request on a socket that has not signed in is refused and
// counted), users, accounts, deals and positions, and fault hooks to drop,
// delay or replace the next answer on a path. It speaks the formats in
// src/gateway/mt5/webapi.ts, which are themselves partly unconfirmed.
//
//   const fake = await startFakeMt5();
//   const config = loadGatewayConfig({
//     GATEWAY_SECRET: secret, GATEWAY_SERVERS: "live",
//     GATEWAY_SERVER_LIVE_HOST: fake.host, GATEWAY_SERVER_LIVE_PORT: String(fake.port),
//     GATEWAY_SERVER_LIVE_LOGIN: "9000", GATEWAY_SERVER_LIVE_PASSWORD: "Manager-Pass-1",
//     GATEWAY_SERVER_LIVE_CERT_SHA256: fake.certSha256, GATEWAY_SERVER_LIVE_GROUPS: "real\\standard",
//   });
//   const server = createGatewayServer(config, { pingIntervalMs: 0 });
//   server.listen(0, "127.0.0.1");
//   fake.addUser({ group: "real\\standard", balanceCents: 10_000 });
//   fake.faults.next("/api/trade/balance", { drop: "after" }); // the next balance's answer is lost
//   ...
//   expect(fake.state.unauthenticated).toBe(0);
//   await fake.close();

export interface FakeUser {
  login: number;
  group: string;
  name: string;
  email: string;
  country: string;
  leverage: number;
  rights: bigint;
  comment: string;
  mainPassword: string;
  investorPassword: string;
  /** Seconds, server time. */
  registration: number;
  balanceCents: number;
  creditCents: number;
  marginCents: number;
  /** Floating profit of open positions. */
  profitCents: number;
  /** Other fields MT5 keeps on a user, sent as they are and kept through updates. */
  extra: Record<string, string>;
}

export interface FakeDeal {
  ticket: number;
  login: number;
  action: number;
  entry: number;
  positionId: number;
  order: number;
  symbol: string;
  volume: number;
  price: string;
  profitCents: number;
  commissionCents: number;
  swapCents: number;
  feeCents: number;
  comment: string;
  /** Seconds, server time. */
  time: number;
}

/** What to do to the next request on a path (one-shot; several queue up in order). */
export type Fault =
  | { drop: "before" | "after" } // close the connection without answering, before or after applying it
  | { delayMs: number } // answer late (still applied)
  | { retcode: string } // answer with this retcode, applying nothing
  | { raw: string; apply?: boolean } // answer with this exact body, applying it only when `apply`
  | { status: number }; // answer with this HTTP status, applying nothing

export interface FakeRequest {
  seq: number;
  path: string;
  login: number | null;
  socket: number;
  signedIn: boolean;
}

export interface FakeState {
  users: Map<number, FakeUser>;
  deals: FakeDeal[];
  positions: Map<number, number>;
  /** TCP connections accepted (before any TLS). */
  tcpConnections: number;
  /** TLS connections that completed the handshake. */
  connections: number;
  /** Completed manager sign-ins. */
  signIns: number;
  /** Requests on a socket that had not signed in. The gateway must never cause one. */
  unauthenticated: number;
  /** Every request, in arrival order. */
  requests: FakeRequest[];
  /** Start and end of every request, in order, to check what overlapped. */
  events: Array<{ type: "start" | "end"; seq: number; path: string; login: number | null }>;
  /** The most writes that were in flight at once for one login (or one group, for user/add). */
  maxWritesInFlight: number;
  /** user/update bodies as received. */
  updates: Array<Record<string, unknown>>;
  /** Updates that tried to change an account's group (the gateway must never send one). */
  groupChanges: number;
}

export interface FakeMt5Options {
  /** Manager logins and passwords. Default: 9000 / "Manager-Pass-1". */
  managers?: Record<number, string>;
  /** The trade server's clock minus UTC, in minutes. */
  tzOffsetMinutes?: number;
  firstLogin?: number;
  /** The most deals one deal/get_page answer holds. */
  pageLimit?: number;
}

export interface FakeMt5 {
  host: string;
  port: number;
  /** SHA-256 of the certificate's DER, 64 lowercase hex digits. */
  certSha256: string;
  state: FakeState;
  faults: {
    next(path: string, fault: Fault): void;
    /** Closes every connection that is not carrying a request, as MT5 does with idle sessions. */
    closeIdleSockets(): Promise<number>;
    /** The next sign-in answers our challenge wrongly, as a server without the password would. */
    wrongServerProof: boolean;
    clear(): void;
  };
  addUser(user: Partial<FakeUser> & { group: string }): FakeUser;
  addDeal(deal: Partial<FakeDeal> & { login: number }): FakeDeal;
  /** Seconds, server time. */
  serverNow(): number;
  close(): Promise<void>;
}

const WRITE_PATHS = new Set(["/api/user/add", "/api/user/update", "/api/user/change_password", "/api/trade/balance"]);

const md5 = (...parts: Buffer[]) => parts.reduce((h, p) => h.update(p), createHash("md5")).digest();
const managerHash = (password: string) => md5(md5(Buffer.from(password, "utf16le")), Buffer.from("WebAPI"));

const dec = (cents: number) => `${cents < 0 ? "-" : ""}${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;
const cents = (text: string | null) => {
  const m = /^(-?)(\d+)\.(\d{2})$/.exec(text ?? "");
  if (!m) return null;
  const v = Number(m[2]) * 100 + Number(m[3]);
  return m[1] ? -v : v;
};
// MT5's documented rule for client passwords: four kinds of character.
const strongEnough = (p: string) => p.length >= 8 && /[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p) && /[^A-Za-z0-9]/.test(p);

export async function startFakeMt5(opts: FakeMt5Options = {}): Promise<FakeMt5> {
  const pems = await generate([{ name: "commonName", value: "mt5.fake.test" }], {
    keyType: "ec",
    curve: "P-256",
    algorithm: "sha256",
    notBeforeDate: new Date(Date.now() - 60_000),
    extensions: [{ name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }, { type: 7, ip: "127.0.0.1" }] }],
  });
  const certSha256 = new X509Certificate(pems.cert).fingerprint256.replace(/:/g, "").toLowerCase();
  const managers = new Map(Object.entries(opts.managers ?? { 9000: "Manager-Pass-1" }).map(([login, pw]) => [Number(login), managerHash(pw)]));
  const tz = opts.tzOffsetMinutes ?? 0;
  const pageLimit = opts.pageLimit ?? 1000;
  const serverNow = () => Math.floor(Date.now() / 1000) + tz * 60;

  const state: FakeState = {
    users: new Map(), deals: [], positions: new Map(), tcpConnections: 0, connections: 0, signIns: 0, unauthenticated: 0,
    requests: [], events: [], maxWritesInFlight: 0, updates: [], groupChanges: 0,
  };
  let nextLogin = opts.firstLogin ?? 100_001;
  let nextTicket = 500_001;
  let seq = 0;
  const queued = new Map<string, Fault[]>();
  const sessions = new WeakMap<TLSSocket, { id: number; signedIn: boolean; hash?: Buffer; srvRand?: Buffer }>();
  const sockets = new Set<TLSSocket>();
  const busy = new Map<TLSSocket, number>();
  const writesInFlight = new Map<string, number>();

  const faults: FakeMt5["faults"] = {
    next(path, fault) {
      queued.set(path, [...(queued.get(path) ?? []), fault]);
    },
    async closeIdleSockets() {
      const idle = [...sockets].filter((s) => !busy.get(s));
      await Promise.all(idle.map((s) => new Promise<void>((resolve) => {
        s.once("close", () => resolve());
        s.destroy();
      })));
      return idle.length;
    },
    wrongServerProof: false,
    clear() {
      queued.clear();
      faults.wrongServerProof = false;
    },
  };

  const addUser: FakeMt5["addUser"] = (u) => {
    const login = u.login ?? nextLogin++;
    const user: FakeUser = {
      login, group: u.group, name: u.name ?? "Test Client", email: u.email ?? `c${login}@client.test`, country: u.country ?? "Pakistan",
      leverage: u.leverage ?? 2000, rights: u.rights ?? 0x163n, comment: u.comment ?? "", mainPassword: u.mainPassword ?? "Main-Pass-1",
      investorPassword: u.investorPassword ?? "Invest-Pass-1", registration: u.registration ?? serverNow(), balanceCents: u.balanceCents ?? 0,
      creditCents: u.creditCents ?? 0, marginCents: u.marginCents ?? 0, profitCents: u.profitCents ?? 0, extra: u.extra ?? {},
    };
    state.users.set(login, user);
    return user;
  };

  const addDeal: FakeMt5["addDeal"] = (d) => {
    const deal: FakeDeal = {
      ticket: d.ticket ?? nextTicket++, login: d.login, action: d.action ?? 2, entry: d.entry ?? 0, positionId: d.positionId ?? 0, order: d.order ?? 0,
      symbol: d.symbol ?? "", volume: d.volume ?? 0, price: d.price ?? "0.00000", profitCents: d.profitCents ?? 0, commissionCents: d.commissionCents ?? 0,
      swapCents: d.swapCents ?? 0, feeCents: d.feeCents ?? 0, comment: d.comment ?? "", time: d.time ?? serverNow(),
    };
    state.deals.push(deal);
    return deal;
  };

  const userJson = (u: FakeUser) => ({
    ...u.extra,
    Login: String(u.login), Group: u.group, Rights: u.rights.toString(), Name: u.name, Email: u.email, Country: u.country, Comment: u.comment,
    Leverage: String(u.leverage), Registration: String(u.registration), Balance: dec(u.balanceCents), Credit: dec(u.creditCents),
  });
  const dealJson = (d: FakeDeal) => ({
    Deal: String(d.ticket), Login: String(d.login), Action: String(d.action), Entry: String(d.entry), PositionID: String(d.positionId), Order: String(d.order),
    Symbol: d.symbol, Volume: String(d.volume), Price: d.price, Profit: dec(d.profitCents), Commission: dec(d.commissionCents), Storage: dec(d.swapCents),
    Fee: dec(d.feeCents), Comment: d.comment, Time: String(d.time), TimeMsc: String(d.time * 1000),
  });
  const dealsIn = (q: URLSearchParams) => {
    const login = Number(q.get("login"));
    const from = Number(q.get("from"));
    const to = Number(q.get("to"));
    return state.deals.filter((d) => d.login === login && d.time >= from && d.time <= to).sort((a, b) => a.time - b.time || a.ticket - b.ticket);
  };
  const DONE = "0 Done";
  const NOT_FOUND = { retcode: "13 Not found" };

  /** One authenticated request: what MT5 would do and answer. */
  function route(method: string, path: string, q: URLSearchParams, body: string): { status: number; json: unknown } {
    const ok = (json: object) => ({ status: 200, json: { retcode: DONE, ...json } });
    const user = q.has("login") ? state.users.get(Number(q.get("login"))) : undefined;
    switch (path) {
      case "/api/test/access":
        return ok({});
      case "/api/time/server":
        return ok({ answer: { time: `${serverNow()} server` } });
      case "/api/user/get":
        return user ? ok({ answer: userJson(user) }) : { status: 200, json: NOT_FOUND };
      case "/api/user/account/get": {
        if (!user) return { status: 200, json: NOT_FOUND };
        const equity = user.balanceCents + user.creditCents + user.profitCents;
        return ok({
          answer: {
            Login: String(user.login), CurrencyDigits: "2", Balance: dec(user.balanceCents), Credit: dec(user.creditCents), Margin: dec(user.marginCents),
            MarginFree: dec(equity - user.marginCents), MarginLevel: "0.00", MarginLeverage: String(user.leverage), Profit: dec(user.profitCents),
            Storage: "0.00", Commission: "0.00", Floating: dec(user.profitCents), Equity: dec(equity),
          },
        });
      }
      case "/api/user/logins": {
        const group = q.get("group");
        return ok({ answer: [...state.users.values()].filter((u) => u.group === group).map((u) => String(u.login)) });
      }
      case "/api/position/get_total":
        return user ? ok({ answer: { total: String(state.positions.get(user.login) ?? 0) } }) : { status: 200, json: NOT_FOUND };
      case "/api/user/add": {
        if (method !== "POST") return { status: 405, json: {} };
        const record = JSON.parse(body) as Record<string, string>;
        const main = q.get("pass_main") ?? "";
        const investor = q.get("pass_investor") ?? "";
        if (!strongEnough(main) || !strongEnough(investor)) return { status: 200, json: { retcode: "3006 Invalid account password" } };
        if (record.Login !== "0") return { status: 200, json: { retcode: "3 Invalid parameters" } };
        const made = addUser({
          group: record.Group!, name: record.Name, email: record.Email, country: record.Country, comment: record.Comment, leverage: Number(record.Leverage),
          rights: BigInt(record.Rights!), mainPassword: main, investorPassword: investor,
        });
        return ok({ answer: userJson(made) });
      }
      case "/api/user/update": {
        if (method !== "POST") return { status: 405, json: {} };
        if (!user) return { status: 200, json: NOT_FOUND };
        const record = JSON.parse(body) as Record<string, string>;
        state.updates.push(record);
        if (record.Login !== String(user.login)) return { status: 200, json: { retcode: "3 Invalid parameters" } };
        if (record.Group !== user.group) state.groupChanges++;
        const { Login: _l, Group: _g, Balance: _b, Credit: _c, Registration: _r, Leverage, Rights, Name, Email, Country, Comment, ...rest } = record;
        Object.assign(user, { leverage: Number(Leverage), rights: BigInt(Rights!), name: Name, email: Email, country: Country, comment: Comment, extra: rest });
        return ok({ answer: userJson(user) });
      }
      case "/api/user/change_password": {
        if (!user) return { status: 200, json: NOT_FOUND };
        const password = q.get("password") ?? "";
        if (!strongEnough(password)) return { status: 200, json: { retcode: "3006 Invalid account password" } };
        if (q.get("type") === "main") user.mainPassword = password;
        else if (q.get("type") === "investor") user.investorPassword = password;
        else return { status: 200, json: { retcode: "3 Invalid parameters" } };
        return ok({});
      }
      case "/api/trade/balance": {
        if (!user) return { status: 200, json: NOT_FOUND };
        const amount = cents(q.get("balance"));
        if (q.get("type") !== "2" || amount === null || amount === 0) return { status: 200, json: { retcode: "3 Invalid parameters" } };
        const free = user.balanceCents + user.creditCents + user.profitCents - user.marginCents;
        if (q.get("check_margin") === "1" && amount < 0 && (user.balanceCents + amount < 0 || free + amount < 0)) {
          return { status: 200, json: { retcode: "10019 Not enough money" } };
        }
        user.balanceCents += amount;
        const deal = addDeal({ login: user.login, action: 2, profitCents: amount, comment: q.get("comment") ?? "" });
        return ok({ answer: { ticket: String(deal.ticket) } });
      }
      case "/api/deal/get_total":
        return ok({ answer: { total: String(dealsIn(q).length) } });
      case "/api/deal/get_page": {
        const offset = Number(q.get("offset") ?? 0);
        const total = Math.min(Number(q.get("total") ?? pageLimit), pageLimit);
        return ok({ answer: dealsIn(q).slice(offset, offset + total).map(dealJson) });
      }
      default:
        return { status: 404, json: { retcode: "3 Invalid parameters" } };
    }
  }

  function signIn(path: string, q: URLSearchParams, session: { signedIn: boolean; hash?: Buffer; srvRand?: Buffer }) {
    if (path === "/api/auth/start") {
      const hash = managers.get(Number(q.get("login")));
      if (q.get("type") !== "manager" || !hash || !q.get("version") || !q.get("agent")) return { retcode: "1001 Invalid account" };
      session.hash = hash;
      session.srvRand = randomBytes(16);
      return { retcode: DONE, version_access: "5370", srv_rand: session.srvRand.toString("hex") };
    }
    if (!session.hash || !session.srvRand) return { retcode: "3 Invalid parameters" };
    if (q.get("srv_rand_answer") !== md5(session.hash, session.srvRand).toString("hex")) return { retcode: "3006 Invalid account password" };
    const cliRand = Buffer.from(q.get("cli_rand") ?? "", "hex");
    if (cliRand.length !== 16) return { retcode: "3 Invalid parameters" };
    session.signedIn = true;
    state.signIns++;
    const proof = faults.wrongServerProof ? randomBytes(16) : md5(session.hash, cliRand);
    faults.wrongServerProof = false;
    return { retcode: DONE, cli_rand_answer: proof.toString("hex") };
  }

  const server = https.createServer({ key: pems.private, cert: pems.cert }, (req, res) => {
    const socket = req.socket as TLSSocket;
    const session = sessions.get(socket)!;
    const url = new URL(req.url ?? "/", "https://mt5.fake.test");
    const path = url.pathname;
    const q = url.searchParams;
    const login = q.has("login") ? Number(q.get("login")) : null;
    const n = ++seq;
    state.requests.push({ seq: n, path, login, socket: session.id, signedIn: session.signedIn });
    state.events.push({ type: "start", seq: n, path, login });
    busy.set(socket, (busy.get(socket) ?? 0) + 1);
    const writeKey = WRITE_PATHS.has(path) ? (login === null ? `add:${path}` : String(login)) : null;
    if (writeKey) {
      writesInFlight.set(writeKey, (writesInFlight.get(writeKey) ?? 0) + 1);
      state.maxWritesInFlight = Math.max(state.maxWritesInFlight, writesInFlight.get(writeKey)!);
    }
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      busy.set(socket, (busy.get(socket) ?? 1) - 1);
      if (writeKey) writesInFlight.set(writeKey, (writesInFlight.get(writeKey) ?? 1) - 1);
      state.events.push({ type: "end", seq: n, path, login });
    };
    res.once("close", finish);
    const send = (status: number, text: string) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(text);
    };
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (path.startsWith("/api/auth/")) return send(200, JSON.stringify(signIn(path, q, session)));
      if (!session.signedIn) {
        state.unauthenticated++;
        return send(403, JSON.stringify({ retcode: "8 Not enough permissions" }));
      }
      const list = queued.get(path);
      const fault = list?.shift();
      if (list && list.length === 0) queued.delete(path);
      if (fault && "delayMs" in fault) await new Promise((r) => setTimeout(r, fault.delayMs));
      if (fault && "drop" in fault && fault.drop === "before") return void socket.destroy();
      if (fault && "status" in fault) return send(fault.status, "{}");
      if (fault && "retcode" in fault) return send(200, JSON.stringify({ retcode: fault.retcode }));
      if (fault && "raw" in fault && !fault.apply) return send(200, fault.raw);
      const result = route(req.method ?? "GET", path, q, body);
      if (fault && "drop" in fault) return void socket.destroy();
      if (fault && "raw" in fault) return send(200, fault.raw);
      send(result.status, JSON.stringify(result.json));
    });
  });
  // Long enough that the fake never drops an idle socket on its own; tests do it with closeIdleSockets.
  server.keepAliveTimeout = 120_000;
  server.on("connection", () => void state.tcpConnections++);
  server.on("secureConnection", (socket: TLSSocket) => {
    state.connections++;
    sessions.set(socket, { id: state.connections, signedIn: false });
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  return {
    host: "127.0.0.1",
    port,
    certSha256,
    state,
    faults,
    addUser,
    addDeal,
    serverNow,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
