import pino from "pino";

export const createLogger = (level: string) =>
  pino({
    level,
    redact: { paths: ["req.headers.cookie", "req.headers.authorization", "*.password", "*.token"], remove: true },
  });

/**
 * A request path as it may be logged: no query string, and no secret link token (a QR code
 * link is the only thing that protects the picture behind it).
 */
export const loggablePath = (url: string) => url.split("?")[0]!.replace(/^(\/api\/(?:payout|payment)-qr\/)[^/]+/, "$1:token");
