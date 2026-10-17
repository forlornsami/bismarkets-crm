import { createApp } from "./app";
import { loadConfig } from "./config";
import { createDb } from "./lib/db";
import { createLogger } from "./lib/logger";
import { startSupportEventSender } from "./lib/events";
import { smtpTransport, startEmailSender } from "./lib/mailer";

const config = loadConfig();
const log = createLogger(config.logLevel);
const db = createDb(config.databaseUrl);
const app = createApp({ db, config, log, fetch });

const stopEvents = startSupportEventSender(db, config, fetch, log);
const stopEmails = startEmailSender(db, config, smtpTransport, log);
const server = app.listen(config.port, () => log.info({ port: config.port }, "CRM listening"));

function shutdown(signal: string) {
  log.info({ signal }, "Shutting down");
  stopEvents();
  stopEmails();
  server.close(() => {
    db.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
