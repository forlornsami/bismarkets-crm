import pino from "pino";

export const createLogger = (level: string) =>
  pino({
    level,
    redact: { paths: ["req.headers.cookie", "req.headers.authorization", "*.password", "*.token"], remove: true },
  });

/**
 * A request path as it may be logged: no query string, and no secret link token (a QR code
 * link is the only thing that protects the picture behind it). Routing ignores case and extra
 * slashes, so the redaction does too, and any long hex run (a token's shape) goes as well.
 */
export const loggablePath = (url: string) =>
  url
    .split("?")[0]!
    .replace(/(\/(?:payout|payment)(?:-|%2d)qr\/+)[^/]+/gi, "$1:token")
    .replace(/[0-9a-f]{24,}/gi, ":token");
