import pino from "pino";

// JSON lines on stdout for journald. Nothing logs a request body, an MT5 URL
// (a password change carries the password in it) or the secret; the redaction
// is a second guard in case a field with such a name is ever passed in.

export const createGatewayLogger = (level: string, destination?: pino.DestinationStream) =>
  pino(
    {
      level,
      base: { service: "mt5-gateway" },
      redact: {
        paths: ["password", "investorPassword", "secret", "*.password", "*.investorPassword", "*.secret", "*.passwordHash"],
        censor: "[hidden]",
      },
    },
    destination,
  );

export type GatewayLogger = pino.Logger;
