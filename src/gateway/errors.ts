import type { GatewayErrorCode, GatewayErrorKind } from "./protocol";

// How an operation fails inside the gateway. The kind is what the CRM acts on
// (protocol.ts explains each); `message` is for staff and logs, never for a
// client, and never carries a password or the secret.

export class OpError extends Error {
  constructor(
    public kind: GatewayErrorKind,
    public code: GatewayErrorCode,
    message: string,
    public retcode?: number,
  ) {
    super(message);
  }
}

export const refused = (code: GatewayErrorCode, message: string, retcode?: number) => new OpError("refused", code, message, retcode);
export const unavailable = (code: GatewayErrorCode, message: string, retcode?: number) => new OpError("unavailable", code, message, retcode);
export const unknownOutcome = (code: GatewayErrorCode, message: string, retcode?: number) => new OpError("unknown", code, message, retcode);
/** The request broke one of the gateway's own rules: a CRM bug or an attack. Nothing was sent. */
export const policy = (message: string) => new OpError("bad_request", "policy", message);
