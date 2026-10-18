import { randomBytes } from "node:crypto";
import {
  HEADERS, PROTOCOL_PREFIX, requestSignature, responseSignature, sameHex, WRITE_OPS,
  type GatewayAnswer, type GatewayErrorCode, type GatewayErrorKind, type OpName, type Ops,
} from "../../gateway/protocol";

// The CRM's side of the MT5 gateway. Everything the CRM does in MT5 goes
// through `Mt5Gateway.call`, which either returns the operation's result or
// throws a GatewayError saying whether anything may have happened. Tests
// pass their own Mt5Gateway, so no test talks to a real MT5 server.

export class GatewayError extends Error {
  constructor(
    public kind: GatewayErrorKind,
    public code: GatewayErrorCode,
    message: string,
    public retcode?: number,
  ) {
    super(message);
  }
  /** Nothing happened in MT5: safe to tell the client it did not work. */
  get definite() {
    return this.kind !== "unknown";
  }
}

export interface Mt5Gateway {
  call<K extends OpName>(op: K, req: Ops[K]["req"]): Promise<Ops[K]["res"]>;
}

/** How long the CRM waits for the gateway. Writes stay under the app's 30-second limit for a whole request. */
export const READ_TIMEOUT_MS = 8_000;
export const WRITE_TIMEOUT_MS = 20_000;

/**
 * Calls the gateway over HTTP. A connection that was refused never reached
 * the gateway (unavailable); any other lost answer to a write is unknown. An
 * answer without a valid signature is not trusted: unknown for a write,
 * unavailable for a read.
 */
export function httpGateway(opts: { url: string; secret: string; fetch: typeof fetch; log?: { error: (obj: unknown, msg: string) => void } }): Mt5Gateway {
  const base = opts.url.replace(/\/+$/, "");
  return {
    async call(op, req) {
      const write = WRITE_OPS.has(op);
      const lost = (code: GatewayErrorCode, message: string) => new GatewayError(write ? "unknown" : "unavailable", code, message);
      const path = PROTOCOL_PREFIX + op;
      const body = JSON.stringify(req);
      const timestamp = String(Date.now());
      const nonce = randomBytes(16).toString("hex");
      let res: Response;
      try {
        res = await opts.fetch(base + path, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            [HEADERS.timestamp]: timestamp,
            [HEADERS.nonce]: nonce,
            [HEADERS.signature]: requestSignature(opts.secret, timestamp, nonce, path, body),
          },
          body,
          redirect: "error",
          signal: AbortSignal.timeout(write ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS),
        });
      } catch (error) {
        const cause = (error as { cause?: { code?: string } }).cause;
        if (cause?.code === "ECONNREFUSED") throw new GatewayError("unavailable", "connection", "The MT5 gateway is not running.");
        const timedOut = (error as { name?: string }).name === "TimeoutError";
        throw lost(timedOut ? "timeout" : "connection", timedOut ? "The MT5 gateway did not answer in time." : "The connection to the MT5 gateway failed.");
      }
      let text: string;
      try {
        text = await res.text();
      } catch {
        throw lost("connection", "The MT5 gateway's answer was cut off.");
      }
      if (!sameHex(res.headers.get(HEADERS.signature), responseSignature(opts.secret, nonce, res.status, text))) {
        opts.log?.error({ op, status: res.status }, "MT5 gateway answer has no valid signature: check CRM_MT5_GATEWAY_SECRET and that the gateway is the one listening");
        throw lost("bad_signature", "The MT5 gateway's answer could not be verified.");
      }
      let answer: GatewayAnswer<Ops[typeof op]["res"]>;
      try {
        answer = JSON.parse(text);
      } catch {
        throw lost("bad_request", "The MT5 gateway's answer was not JSON.");
      }
      if (answer.ok) return answer.result;
      const e = answer.error;
      throw new GatewayError(e.kind, e.code, e.message, e.retcode);
    },
  };
}
