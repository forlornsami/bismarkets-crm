import { createApp } from "./app";
import { loadConfig } from "./config";
import { createDb } from "./lib/db";
import { createLogger } from "./lib/logger";
import { startSupportEventSender } from "./lib/events";
import { smtpTransport, startEmailSender } from "./lib/mailer";
import { httpGateway } from "./mt5/gateway";
import { startMt5Resolver } from "./mt5/resolver";

const config = loadConfig();
const log = createLogger(config.logLevel);
const db = createDb(config.databaseUrl);
// MT5 is off (null) unless CRM_MT5_GATEWAY_URL is set.
const mt5 = config.mt5Gateway ? httpGateway({ url: config.mt5Gateway.url, secret: config.mt5Gateway.secret, fetch, log }) : null;
const app = createApp({ db, config, log, fetch, mt5 });

const stopEvents = startSupportEventSender(db, config, fetch, log);
const stopEmails = startEmailSender(db, config, smtpTransport, log);
const stopMt5 = startMt5Resolver(db, mt5, log);
const server = app.listen(config.port, () => log.info({ port: config.port }, "CRM listening"));

function shutdown(signal: string) {
  log.info({ signal }, "Shutting down");
  stopEvents();
  stopEmails();
  stopMt5();
  server.close(() => {
    db.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
