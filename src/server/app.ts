import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import type { Logger } from "pino";
import pinoHttp from "pino-http";
import type { Config } from "./config";
import type { Db } from "./lib/db";
import { errorMiddleware, HttpError, notFound } from "./lib/http";
import { buildAllowList, isAllowed, normalizeIp } from "./lib/ip";
import { clientErrorMiddleware } from "./clients/errors";
import { clientAuthRouter } from "./routes/client/auth";
import { staffAuditRouter } from "./routes/staff/audit";
import { staffAuthRouter } from "./routes/staff/auth";
import { staffBrandingRouter } from "./routes/staff/branding";
import { staffClientsRouter } from "./routes/staff/clients";
import { staffEmailsRouter } from "./routes/staff/emails";
import { staffRolesRouter } from "./routes/staff/roles";
import { staffUsersRouter } from "./routes/staff/users";
import { staffSession } from "./staff/session";

export interface AppDeps {
  db: Db;
  config: Config;
  log: Logger;
  /** Injected so tests never call external services. */
  fetch: typeof fetch;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function createApp(deps: AppDeps): Express {
  const { db, config, log } = deps;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustedProxies);

  app.use(
    pinoHttp({
      logger: log,
      // Never log cookies, auth headers, bodies or query strings.
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: String(req.url ?? "").split("?")[0] }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use((req, _res, next) => {
    req.clientIp = normalizeIp(req.ip);
    next();
  });
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          "default-src": ["'self'"],
          "script-src": ["'self'"],
          "style-src": ["'self'"],
          "img-src": ["'self'", "data:"],
          "connect-src": ["'self'"],
          "frame-ancestors": ["'none'"],
          "form-action": ["'self'"],
          "object-src": ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: true,
      referrerPolicy: { policy: "no-referrer" },
      strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true, preload: false },
    }),
  );
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  app.get("/api/healthz", (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/api/readyz", async (_req, res) => {
    try {
      await db.query("SELECT 1 FROM audit_chain_head WHERE id = 1");
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  // ---- Staff API and admin panel: network allowlist, same-origin only. ----
  const allowList = buildAllowList(config.staffAllowedIps);
  const staffNetwork = (req: Request, _res: Response, next: NextFunction) => {
    // Outside the allowlist the staff surface simply does not exist.
    if (!isAllowed(allowList, req.clientIp)) return next(notFound());
    next();
  };
  const sameOrigin = (req: Request, _res: Response, next: NextFunction) => {
    if (SAFE_METHODS.has(req.method)) return next();
    if (req.get("origin") !== config.staffOrigin) return next(new HttpError(403, "BAD_ORIGIN", "Request blocked."));
    next();
  };

  const staff = express.Router();
  staff.use(staffNetwork, sameOrigin, express.json({ limit: "64kb" }));
  staff.use("/auth", staffAuthRouter(deps));
  // Logos are public to the staff network (the sign-in page shows them); changes check the session inside.
  staff.use("/branding", staffBrandingRouter(deps));
  staff.use(staffSession(db, config));
  staff.use("/users", staffUsersRouter(deps));
  staff.use("/roles", staffRolesRouter(deps));
  staff.use("/audit", staffAuditRouter(deps));
  staff.use("/clients", staffClientsRouter(deps));
  staff.use("/emails", staffEmailsRouter(deps));
  app.use("/api/staff", staff);

  // ---- Client API: what the client portal and app call, with Bearer tokens. ----
  // No cookies, so no CSRF; browsers may call it only from the portal's origin.
  const clientOrigins = new Set(config.clientOrigins);
  const client = express.Router();
  client.use((req, res, next) => {
    const origin = req.get("origin");
    if (origin && clientOrigins.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Expose-Headers", "Retry-After");
      if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE");
        res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept");
        res.setHeader("Access-Control-Max-Age", "600");
        return void res.status(204).end();
      }
    } else if (req.method === "OPTIONS") {
      return void res.status(204).end();
    }
    next();
  });
  client.use(express.json({ limit: "64kb" }));
  client.use(clientAuthRouter(deps));
  // Later phases add the remaining portal endpoints (accounts, money, IB).
  client.use((_req, _res, next) => next(new HttpError(404, "NOT_AVAILABLE", "This feature is not available yet.")));
  client.use(clientErrorMiddleware(log));
  app.use("/api", (req, res, next) => (req.path.startsWith("/staff/") || req.path === "/staff" ? next() : client(req, res, next)));
  app.use("/api", (_req, _res, next) => next(notFound()));

  if (config.serveAdmin) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const adminDir = [path.join(here, "admin"), path.join(here, "../../dist/admin")].find((dir) => existsSync(path.join(dir, "index.html")));
    if (adminDir) {
      app.use(staffNetwork, express.static(adminDir, { index: false, maxAge: "1h", immutable: false }));
      app.get(/^\/(?!api\/).*/, staffNetwork, (_req, res) => {
        res.setHeader("Cache-Control", "no-cache");
        res.sendFile(path.join(adminDir, "index.html"));
      });
    }
  }

  app.use((_req, _res, next) => next(notFound()));
  app.use(errorMiddleware(log));
  return app;
}
