import pino from "pino";

export const createLogger = (level: string) =>
  pino({
    level,
    redact: { paths: ["req.headers.cookie", "req.headers.authorization", "*.password", "*.token"], remove: true },
  });
