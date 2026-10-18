import http from "node:http";
import { NonceCache, verifyRequest } from "./auth";
import type { GatewayConfig } from "./config";
import { OpError } from "./errors";
import { createGatewayLogger, type GatewayLogger } from "./log";
import { Gateway, OP_SCHEMAS } from "./ops";
import {
  HEADERS, MAX_BODY_BYTES, OP_NAMES, PROTOCOL_PREFIX, responseSignature, WRITE_OPS,
  type GatewayErrorCode, type GatewayErrorKind, type OpName,
} from "./protocol";

// The gateway's HTTP side: POST /v1/<op> from the CRM, and GET /healthz.
// Plain node:http, as it serves one caller and a dozen operations.
//
// A request is checked in this order, and anything that fails gets an
// unsigned 4xx (the CRM treats it as unverifiable): body size, signature,
// clock, nonce, operation name, body shape. Only then does the operation run,
// and its answer is signed over the request's nonce so the CRM knows it came
// from the gateway.

/** A bit under the CRM's own waits (8 s for reads, 20 s for writes), so the answer arrives before the CRM gives up. */
const READ_DEADLINE_MS = 7_000;
const WRITE_DEADLINE_MS = 18_000;
/** Operations running at once; past this the gateway answers "unavailable" rather than queue without end. */
const MAX_IN_FLIGHT = 64;

const STATUS: Record<GatewayErrorKind, number> = { bad_request: 400, refused: 422, unavailable: 503, unknown: 502 };

export interface GatewayDeps {
  log?: GatewayLogger;
  /** How often idle MT5 connections are pinged; 0 turns it off. */
  pingIntervalMs?: number;
}

export type GatewayServer = http.Server & {
  /** Operations still running (the shutdown waits for these). */
  inFlight(): number;
};

const header = (req: http.IncomingMessage, name: string) => {
  const value = req.headers[name];
  return typeof value === "string" ? value : undefined;
};

/** The body, or null if it is over the limit (then it is not read any further). */
function readBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    if (Number(header(req, "content-length") ?? 0) > MAX_BODY_BYTES) return resolve(null);
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) return void chunks.push(chunk);
      req.removeAllListeners("data");
      req.pause();
      resolve(null);
    });
    req.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.once("error", reject);
  });
}

/** An answer the CRM cannot verify: the request itself was not acceptable. */
function refuseUnsigned(res: http.ServerResponse, status: number, code: GatewayErrorCode, message: string) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...(status === 413 ? { Connection: "close" } : {}) });
  res.end(JSON.stringify({ ok: false, error: { kind: "bad_request", code, message } }));
}

export function createGatewayServer(config: GatewayConfig, deps: GatewayDeps = {}): GatewayServer {
  const log = deps.log ?? createGatewayLogger(config.logLevel);
  const gateway = new Gateway(config, log, { pingIntervalMs: deps.pingIntervalMs });
  const nonces = new NonceCache();
  let inFlight = 0;

  const answer = (res: http.ServerResponse, nonce: string, status: number, payload: unknown) => {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      [HEADERS.signature]: responseSignature(config.secret.reveal(), nonce, status, body),
    });
    res.end(body);
  };

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const path = req.url ?? "";
    if (req.method === "GET" && path === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method !== "POST" || !path.startsWith(PROTOCOL_PREFIX)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: { kind: "bad_request", code: "bad_request", message: "Not found." } }));
      return;
    }
    const body = await readBody(req);
    if (body === null) return refuseUnsigned(res, 413, "bad_request", `The body is over ${MAX_BODY_BYTES} bytes.`);
    const nonce = header(req, HEADERS.nonce);
    const verdict = verifyRequest({
      secret: config.secret.reveal(),
      timestamp: header(req, HEADERS.timestamp),
      nonce,
      signature: header(req, HEADERS.signature),
      path,
      body,
      nonces,
    });
    if (!verdict.ok) {
      log.warn({ path: path.slice(0, 64), remote: req.socket.remoteAddress, reason: verdict.message }, "Refused a request that is not properly signed");
      return refuseUnsigned(res, verdict.status, verdict.status === 503 ? "too_frequent" : "bad_signature", verdict.message);
    }
    const op = path.slice(PROTOCOL_PREFIX.length) as OpName;
    if (!OP_NAMES.includes(op)) return refuseUnsigned(res, 400, "bad_request", "Unknown operation.");
    let input: unknown;
    try {
      input = JSON.parse(body);
    } catch {
      return refuseUnsigned(res, 400, "bad_request", "The body is not JSON.");
    }
    const parsed = OP_SCHEMAS[op].safeParse(input);
    if (!parsed.success) {
      // Field names only: the values may be passwords.
      const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(body)"))].join(", ");
      log.warn({ op, fields }, "Refused a request with an invalid body");
      return refuseUnsigned(res, 400, "bad_request", `Invalid body: ${fields}.`);
    }
    const write = WRITE_OPS.has(op);
    if (inFlight >= MAX_IN_FLIGHT) {
      return answer(res, nonce!, 503, { ok: false, error: { kind: "unavailable", code: "too_frequent", message: "The gateway is busy; nothing was sent." } });
    }
    const aborted = new AbortController();
    res.once("close", () => {
      if (!res.writableFinished) aborted.abort();
    });
    inFlight++;
    try {
      const result = await gateway.run(op, parsed.data, { deadline: Date.now() + (write ? WRITE_DEADLINE_MS : READ_DEADLINE_MS), signal: aborted.signal });
      answer(res, nonce!, 200, { ok: true, result });
    } catch (error) {
      if (error instanceof OpError) {
        const e = { kind: error.kind, code: error.code, message: error.message, ...(error.retcode === undefined ? {} : { retcode: error.retcode }) };
        answer(res, nonce!, STATUS[error.kind], { ok: false, error: e });
      } else {
        // A bug, not an MT5 answer. After a write it cannot be said that nothing happened.
        log.error({ op, err: error }, "Gateway operation failed unexpectedly");
        const kind: GatewayErrorKind = write ? "unknown" : "unavailable";
        answer(res, nonce!, STATUS[kind], { ok: false, error: { kind, code: "mt5_error", message: "The gateway failed while handling the operation." } });
      }
    } finally {
      inFlight--;
    }
  }

  const server = http.createServer({ requestTimeout: 30_000, headersTimeout: 10_000, keepAliveTimeout: 5_000, maxHeaderSize: 8 * 1024 }, (req, res) => {
    handle(req, res).catch((error) => {
      log.error({ err: error }, "Gateway request failed");
      if (!res.headersSent) refuseUnsigned(res, 400, "bad_request", "The request could not be read.");
      else res.destroy();
    });
  }) as GatewayServer;
  server.inFlight = () => inFlight;
  server.on("close", () => gateway.close());
  return server;
}
