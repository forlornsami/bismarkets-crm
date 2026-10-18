import { randomBytes } from "node:crypto";
import https from "node:https";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import tls, { type TLSSocket } from "node:tls";
import type { Mt5ServerConfig } from "../config";
import { OpError, unavailable, unknownOutcome } from "../errors";
import { sameHex } from "../protocol";
import { parseRetcode, retcodeError, SESSION_RETCODES } from "./retcodes";
import {
  authAnswer, authStart, Mt5FormatError, parseReply, randAnswer, readClientRandAnswer, readServerRand, testAccess,
  type Mt5Request, type Reply,
} from "./webapi";

// One signed-in connection to an MT5 server. MT5 ties the manager's sign-in
// to the TLS connection it happened on, so every request must go on that
// same socket: a request on a socket that never signed in would at best be
// refused and at worst run as someone else's session. The connection is a
// keep-alive agent with a single socket, and three things keep requests on
// the right one:
// - the agent opens a socket only while signing in, and hands it over only
//   after the TLS handshake and the certificate check;
// - every request waits for its socket and checks it is the signed-in one
//   before writing a byte (if not, it is dropped with nothing sent);
// - a closed socket ends the session, so the next request signs in again.

const MAX_ANSWER_BYTES = 8 * 1024 * 1024;
/** The longest one MT5 request may take; the operation's deadline may cut it shorter. */
const REQUEST_MS = 10_000;
/** A write goes only on a connection that answered this recently; an older one is pinged first. */
const FRESH_MS = 5_000;

/** A failure below MT5's answer. `sent` says whether any byte of the request may have reached MT5. */
export class TransportError extends Error {
  constructor(
    public sent: boolean,
    public code: "connection" | "timeout" | "mt5_error",
    message: string,
  ) {
    super(message);
  }
}

const NOT_SIGNED_IN = "There is no signed-in connection to MT5.";

/**
 * A keep-alive agent with one socket that it opens only when the sign-in asks
 * for one. Any other request that would need a new socket fails before
 * anything is sent.
 */
class SessionAgent extends https.Agent {
  open: (() => Promise<TLSSocket>) | null = null;

  override createConnection(_options: https.RequestOptions, callback?: (err: Error | null, stream: Duplex) => void): Duplex | null | undefined {
    const open = this.open;
    this.open = null;
    const done = callback ?? (() => undefined);
    if (!open) done(new TransportError(false, "connection", NOT_SIGNED_IN), undefined as never);
    else open().then((socket) => done(null, socket), (error: Error) => done(error, undefined as never));
    return undefined;
  }
}

/** A transport failure as the CRM should read it: after a write's bytes went out, nobody knows. */
const transportFailure = (error: TransportError, write: boolean) =>
  error.sent && write
    ? unknownOutcome(error.code, `${error.message} The write may or may not have happened.`)
    : unavailable(error.code, error.message);

export class Mt5Connection {
  private agent: SessionAgent | null = null;
  private session: TLSSocket | null = null;
  /** When MT5 last answered on this connection (ms). */
  lastAnswerAt = 0;
  /** Set by the first sign-in: the pool keeps such a connection signed in. */
  wanted = false;

  constructor(private server: Mt5ServerConfig) {}

  get signedIn() {
    return this.session !== null && !this.session.destroyed;
  }

  /** Drops the session and its socket; the next request signs in on a new one. */
  close() {
    this.session = null;
    const agent = this.agent;
    this.agent = null;
    agent?.destroy();
  }

  /**
   * Sends one request on the signed-in socket, signing in first when needed,
   * and returns MT5's answer once its retcode is 0; anything else throws an
   * OpError. A read is tried once more on a fresh sign-in when the connection
   * fails or MT5 says the session is not valid. A write is tried again only
   * when nothing of it was sent: once a byte may have reached MT5, a lost
   * answer is an unknown outcome. `beforeSend` runs just before a write goes
   * out (after any sign-in or ping) and may stop it by throwing.
   */
  async request(request: Mt5Request, opts: { deadline: number; beforeSend?: () => void }): Promise<Reply> {
    const { deadline } = opts;
    if (request.write && this.signedIn && Date.now() - this.lastAnswerAt > FRESH_MS) {
      // A socket that sat idle may have been closed by MT5 a moment ago. Find
      // out with a read, which can safely be retried, not with the write.
      try {
        await this.request(testAccess(), { deadline });
      } catch (error) {
        throw error instanceof OpError && error.kind === "unavailable" ? error : unavailable("connection", "MT5 did not answer a ping before the write.");
      }
    }
    for (let attempt = 1; ; attempt++) {
      if (!this.signedIn) await this.signIn(deadline);
      if (request.write) opts.beforeSend?.();
      let reply: Reply;
      try {
        reply = await this.exchange(request, deadline, (socket) => socket === this.session);
      } catch (error) {
        this.close();
        if (!(error instanceof TransportError)) throw error;
        if (attempt === 1 && (!error.sent || !request.write)) continue;
        throw transportFailure(error, request.write);
      }
      const rc = parseRetcode(reply.retcode);
      if (!rc) {
        const message = "MT5's answer has no retcode.";
        throw request.write ? unknownOutcome("mt5_error", message) : unavailable("mt5_error", message);
      }
      if (rc.code === 0) return reply;
      if (SESSION_RETCODES.has(rc.code)) {
        this.close();
        if (attempt === 1 && !request.write) continue;
      }
      throw retcodeError(rc, { write: request.write });
    }
  }

  /** Keeps an idle session alive (MT5 drops idle ones), or signs in again a connection that lost its session. */
  async keepAlive(deadline: number) {
    if (this.signedIn) await this.request(testAccess(), { deadline });
    else if (this.wanted) await this.signIn(deadline);
  }

  /**
   * The manager sign-in (mt5-webapi.md §1): MT5 sends a random challenge,
   * we answer it with the password hash and send our own, and MT5 must answer
   * ours. Both requests go on the one new socket, which becomes the session.
   */
  private async signIn(deadline: number): Promise<void> {
    this.close();
    const agent = new SessionAgent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1, scheduling: "fifo" });
    this.agent = agent;
    let opened: TLSSocket | null = null;
    agent.open = async () => (opened = await this.openSocket(deadline));
    const onOpened = (socket: TLSSocket) => socket === opened;
    try {
      const start = await this.exchange(authStart(this.server), deadline, onOpened);
      agent.open = null;
      this.expectDone(start);
      const hash = this.server.passwordHash.reveal();
      const cliRand = randomBytes(16);
      const answer = await this.exchange(authAnswer(randAnswer(hash, readServerRand(start)), cliRand.toString("hex")), deadline, onOpened);
      this.expectDone(answer);
      // MT5 proves it knows the password too, so a look-alike server cannot pass for it.
      if (!sameHex(readClientRandAnswer(answer), randAnswer(hash, cliRand))) {
        throw unavailable("auth", `MT5 server ${this.server.code} did not prove it knows the manager password.`);
      }
      this.session = opened;
      this.wanted = true;
    } catch (error) {
      this.close();
      if (error instanceof OpError) throw error;
      if (error instanceof TransportError) throw unavailable(error.code, error.message);
      if (error instanceof Mt5FormatError) throw unavailable("auth", `MT5's sign-in answer was not understood: ${error.message}`);
      throw error;
    }
  }

  private expectDone(reply: Reply) {
    const rc = parseRetcode(reply.retcode);
    if (!rc) throw unavailable("auth", "MT5's sign-in answer has no retcode.");
    if (rc.code !== 0) throw retcodeError(rc, { write: false, signingIn: true });
  }

  /** Opens a TLS socket and checks the certificate before anyone can write to it. */
  private openSocket(deadline: number): Promise<TLSSocket> {
    const { host, port, certSha256, code } = this.server;
    return new Promise((resolve, reject) => {
      const socket = tls.connect({
        host,
        port,
        servername: isIP(host) ? undefined : host,
        // With a pin, the pin is the check (MT5 access servers often have a
        // certificate of their own). Without one the certificate must chain to
        // a trusted CA and name the host; there is no way to skip both.
        rejectUnauthorized: certSha256 === null,
        minVersion: "TLSv1.2",
      });
      const fail = (error: Error) => {
        clearTimeout(timer);
        socket.destroy();
        reject(error instanceof TransportError ? error : new TransportError(false, "connection", `Could not connect to MT5 server ${code} (${(error as NodeJS.ErrnoException).code ?? error.message}).`));
      };
      const timer = setTimeout(() => fail(new TransportError(false, "timeout", `MT5 server ${code} did not complete the TLS handshake in time.`)), Math.max(1, deadline - Date.now()));
      socket.once("error", fail);
      socket.once("secureConnect", () => {
        if (certSha256 !== null) {
          const seen = (socket.getPeerCertificate().fingerprint256 ?? "").replace(/:/g, "").toLowerCase();
          if (!sameHex(seen, certSha256)) {
            fail(new TransportError(false, "connection", `MT5 server ${code}'s certificate does not match its pin (CERT_SHA256).`));
            return;
          }
        } else if (!socket.authorized) {
          fail(new TransportError(false, "connection", `MT5 server ${code}'s certificate is not trusted.`));
          return;
        }
        clearTimeout(timer);
        socket.removeListener("error", fail);
        // A request in flight hears about errors itself; an idle socket is just dropped.
        socket.on("error", () => undefined);
        socket.once("close", () => {
          if (this.session === socket) this.session = null;
        });
        resolve(socket);
      });
    });
  }

  /**
   * One HTTP exchange. `accept` sees the socket the agent gives the request,
   * and nothing is written unless it says yes.
   */
  private exchange(request: Mt5Request, deadline: number, accept: (socket: TLSSocket) => boolean): Promise<Reply> {
    const agent = this.agent;
    const ms = Math.min(REQUEST_MS, deadline - Date.now());
    if (!agent) return Promise.reject(new TransportError(false, "connection", NOT_SIGNED_IN));
    if (ms <= 0) return Promise.reject(new TransportError(false, "timeout", "No time was left to ask MT5."));
    const body = request.body === undefined ? undefined : JSON.stringify(request.body);
    const query = request.query ? `?${new URLSearchParams(request.query).toString()}` : "";
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(body));
    }
    return new Promise<Reply>((resolve, reject) => {
      let sent = false;
      let settled = false;
      const req = https.request({ agent, host: this.server.host, port: this.server.port, method: request.method, path: request.path + query, headers });
      const settle = (error: TransportError | null, reply?: Reply) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          reject(error);
          req.destroy();
        } else {
          resolve(reply!);
        }
      };
      const lost = (error: Error) =>
        settle(error instanceof TransportError ? error : new TransportError(sent, "connection", `The connection to MT5 failed (${(error as NodeJS.ErrnoException).code ?? error.message}).`));
      const timer = setTimeout(() => settle(new TransportError(sent, "timeout", "MT5 did not answer in time.")), ms);
      req.on("error", lost);
      req.once("socket", (socket) => {
        if (socket.destroyed || !accept(socket as TLSSocket)) {
          settle(new TransportError(false, "connection", "The socket is not the signed-in one; nothing was sent."));
          return;
        }
        sent = true;
        req.end(body);
      });
      req.once("response", (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_ANSWER_BYTES) settle(new TransportError(true, "mt5_error", "MT5's answer is too large."));
          else chunks.push(chunk);
        });
        res.on("error", lost);
        res.once("end", () => {
          if (!res.complete) return lost(new Error("answer cut off"));
          if (res.statusCode !== 200) {
            // MT5 reports its own errors in a 200 answer; any other status leaves the session in doubt.
            this.close();
            return settle(new TransportError(true, "mt5_error", `MT5 answered HTTP ${res.statusCode}.`));
          }
          let reply: Reply;
          try {
            reply = parseReply(Buffer.concat(chunks).toString("utf8"));
          } catch {
            return settle(new TransportError(true, "mt5_error", "MT5's answer is not a JSON object."));
          }
          this.lastAnswerAt = Date.now();
          settle(null, reply);
        });
      });
    });
  }
}
