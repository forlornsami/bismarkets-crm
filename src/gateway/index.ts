import { loadGatewayConfig } from "./config";
import { createGatewayLogger } from "./log";
import { createGatewayServer } from "./server";

// The MT5 gateway service (dist/gateway.mjs). It runs as its own systemd
// service and OS user, listens on 127.0.0.1, and is the only process that
// holds MT5 manager credentials (docs/DEPLOY.md, docs/SECURITY.md).

const config = loadGatewayConfig(process.env);
// The config holds the secret and the password hashes now. Taking them out of
// the environment keeps them from child processes and environment dumps.
for (const key of Object.keys(process.env)) {
  if (key === "GATEWAY_SECRET" || /^GATEWAY_SERVER_.+_PASSWORD$/.test(key)) delete process.env[key];
}
const log = createGatewayLogger(config.logLevel);
const server = createGatewayServer(config, { log });

server.listen(config.port, config.host, () => {
  const servers = config.servers.map((s) => ({
    code: s.code, host: s.host, port: s.port, login: s.login, pinned: s.certSha256 !== null, groups: s.groups, demoGroups: s.demoGroups, connections: s.connections,
  }));
  log.info({ host: config.host, port: config.port, servers, leverages: config.leverages }, "MT5 gateway listening");
});

let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal, inFlight: server.inFlight() }, "Shutting down");
  // Stop taking requests, but let operations already running get MT5's
  // answer: a write cut off mid-way would become an unknown outcome.
  server.close(() => process.exit(0));
  const started = Date.now();
  const wait = setInterval(() => {
    if (server.inFlight() === 0) server.closeAllConnections();
    if (Date.now() - started > 25_000) {
      log.error({ inFlight: server.inFlight() }, "Operations still running at shutdown; their outcome is unknown to the CRM");
      process.exit(1);
    }
  }, 100);
  wait.unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
