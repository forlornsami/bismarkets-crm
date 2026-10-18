import type { Mt5ServerConfig } from "../config";
import { unavailable } from "../errors";
import type { GatewayLogger } from "../log";
import { Mt5Connection } from "./connection";
import type { Mt5Request, Reply } from "./webapi";

// A few signed-in connections per MT5 server, each carrying one request at a
// time. Idle ones are pinged so MT5 does not drop their session, and one
// that fails its ping signs in again straight away.

/** How long a request waits for a free connection before giving up (nothing is sent). */
const POOL_WAIT_MS = 5_000;
/** How long a ping or a background sign-in may take. */
const KEEPALIVE_MS = 10_000;

export class Mt5Pool {
  private connections: Mt5Connection[];
  private idle: Mt5Connection[];
  private waiters: Array<(connection: Mt5Connection) => void> = [];
  private timer: NodeJS.Timeout | null = null;
  private pinging = false;
  private failing = false;
  private closed = false;

  constructor(
    readonly server: Mt5ServerConfig,
    private log: GatewayLogger,
    pingIntervalMs = 20_000,
  ) {
    this.connections = Array.from({ length: server.connections }, () => new Mt5Connection(server));
    this.idle = [...this.connections];
    if (pingIntervalMs > 0) {
      this.timer = setInterval(() => void this.keepAlive(pingIntervalMs), pingIntervalMs);
      this.timer.unref();
    }
  }

  get size() {
    return this.connections.length;
  }

  /**
   * Sends one request on a free connection (see Mt5Connection.request).
   * `beforeSend` runs just before a write goes out and may stop it.
   */
  async request(request: Mt5Request, opts: { deadline: number; beforeSend?: () => void }): Promise<Reply> {
    const connection = await this.acquire(Math.min(POOL_WAIT_MS, opts.deadline - Date.now()));
    try {
      return await connection.request(request, opts);
    } finally {
      this.release(connection);
    }
  }

  close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    for (const connection of this.connections) connection.close();
  }

  private acquire(waitMs: number): Promise<Mt5Connection> {
    if (this.closed) return Promise.reject(unavailable("connection", "The gateway is shutting down."));
    // The most recently used connection first: it is the one most surely
    // still signed in, and a second session only opens when two requests
    // run at once.
    const free = this.idle.pop();
    if (free) return Promise.resolve(free);
    return new Promise((resolve, reject) => {
      const take = (connection: Mt5Connection) => {
        clearTimeout(timer);
        resolve(connection);
      };
      const timer = setTimeout(() => {
        const at = this.waiters.indexOf(take);
        if (at >= 0) this.waiters.splice(at, 1);
        reject(unavailable("connection", `Every connection to MT5 server ${this.server.code} stayed busy; nothing was sent.`));
      }, Math.max(0, waitMs));
      this.waiters.push(take);
    });
  }

  private release(connection: Mt5Connection) {
    const next = this.waiters.shift();
    if (next) next(connection);
    else this.idle.push(connection);
  }

  /** Pings connections that have been idle for an interval, and signs in again any that lost their session. */
  private async keepAlive(intervalMs: number) {
    if (this.pinging || this.closed) return;
    this.pinging = true;
    try {
      const due = this.idle.filter((c) => c.wanted && (!c.signedIn || Date.now() - c.lastAnswerAt >= intervalMs));
      for (const connection of due) {
        const at = this.idle.indexOf(connection);
        if (at < 0 || this.closed) continue;
        this.idle.splice(at, 1);
        try {
          await connection.keepAlive(Date.now() + KEEPALIVE_MS).catch(async () => {
            connection.close();
            await connection.keepAlive(Date.now() + KEEPALIVE_MS);
          });
          if (this.failing) this.log.info({ server: this.server.code }, "MT5 connection is back");
          this.failing = false;
        } catch (error) {
          // Logged once when it starts failing, not every interval.
          if (!this.failing) {
            const e = error as { kind?: string; code?: string; message?: string };
            this.log.warn({ server: this.server.code, kind: e.kind, code: e.code, reason: e.message }, "MT5 connection lost and could not sign in again");
          }
          this.failing = true;
        } finally {
          this.release(connection);
        }
      }
    } finally {
      this.pinging = false;
    }
  }
}
