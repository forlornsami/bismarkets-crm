import { z } from "zod";
import { MIN_SECRET_LENGTH } from "../gateway/protocol";

const boolean = (fallback: boolean) =>
  z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? fallback : v === "true"));

const csv = z
  .string()
  .optional()
  .transform((v) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean));

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  CRM_DATABASE_URL: z.string().url().refine((v) => v.startsWith("mysql://"), "must be a mysql:// URL"),
  // 32 random bytes, base64. Encrypts 2FA secrets and, later, other sensitive fields.
  CRM_DATA_KEY: z
    .string()
    .refine((v) => Buffer.from(v, "base64").length === 32, "must be 32 bytes encoded as base64"),
  // The admin panel origin, e.g. https://staff.crmbismarkets.com. State-changing
  // staff requests must come from it.
  CRM_STAFF_ORIGIN: z.string().url(),
  // Comma-separated IPs or CIDRs allowed to reach the staff API. Empty = no
  // network restriction (only acceptable in development and tests).
  CRM_STAFF_ALLOWED_IPS: csv,
  // Comma-separated proxy IPs/CIDRs whose X-Forwarded-For is trusted, or "false".
  CRM_TRUSTED_PROXIES: z.string().default("false"),
  CRM_COOKIE_SECURE: boolean(true),
  CRM_SESSION_IDLE_MINUTES: z.coerce.number().int().min(1).max(120).default(15),
  CRM_SESSION_MAX_HOURS: z.coerce.number().int().min(1).max(24).default(8),
  CRM_STEPUP_MINUTES: z.coerce.number().int().min(1).max(30).default(5),
  CRM_LOGIN_MAX_FAILURES: z.coerce.number().int().min(3).max(20).default(5),
  CRM_LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  CRM_PASSWORD_BREACH_CHECK: boolean(true),
  CRM_SERVE_ADMIN: boolean(true),
  // Sites allowed to call the client API from a browser (the client portal).
  CRM_CLIENT_ORIGINS: csv,
  // The client portal, used in password-reset and log-in-as-client links.
  CRM_PORTAL_URL: z.string().url().default("https://bismarkets.global"),
  // This CRM's own public address, used for absolute picture URLs.
  CRM_PUBLIC_URL: z.string().url().default("https://crmbismarkets.com"),
  CRM_CLIENT_SESSION_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  CRM_CLIENT_IDLE_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  CRM_IMPERSONATION_MINUTES: z.coerce.number().int().min(5).max(120).default(30),
  // The support service (bismarkets-support) that receives signed account events.
  // Leave the URL empty to keep events queued without sending them.
  CRM_SUPPORT_EVENTS_URL: z.string().url().optional().or(z.literal("").transform(() => undefined)),
  CRM_SUPPORT_EVENTS_SECRET: z.string().optional().default(""),
  CRM_SUPPORT_EVENTS_ENVIRONMENT: z.enum(["staging", "production"]).default("production"),
  // The MT5 gateway (a separate process on this server). Leave the URL empty to
  // keep MT5 off: account lists still answer from the database, and every MT5
  // change is refused as "temporarily unavailable".
  CRM_MT5_GATEWAY_URL: z.string().url().optional().or(z.literal("").transform(() => undefined)),
  CRM_MT5_GATEWAY_SECRET: z.string().optional().default(""),
  CRM_LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export type Config = {
  env: "development" | "test" | "production";
  port: number;
  databaseUrl: string;
  dataKey: Buffer;
  staffOrigin: string;
  staffAllowedIps: string[];
  trustedProxies: string[] | false;
  cookieSecure: boolean;
  sessionIdleMs: number;
  sessionMaxMs: number;
  stepUpMs: number;
  loginMaxFailures: number;
  loginLockMs: number;
  passwordBreachCheck: boolean;
  serveAdmin: boolean;
  logLevel: string;
  clientOrigins: string[];
  portalUrl: string;
  publicUrl: string;
  clientSessionMs: number;
  clientIdleMs: number;
  impersonationMs: number;
  supportEvents: { url: string | null; secret: string; environment: "staging" | "production" };
  /** Where the MT5 gateway listens and the secret both sides sign with, or null when MT5 is off. */
  mt5Gateway: { url: string; secret: string } | null;
};

/** In production the gateway is on this machine (plain HTTP on loopback) or reached over HTTPS. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Why a gateway URL is not acceptable, or null. */
function gatewayUrlProblem(raw: string, production: boolean): string | null {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") return "must be an http:// or https:// URL";
  if (url.username || url.password) return "must not contain a user name or password";
  if (url.search || url.hash) return "must not have a query string or fragment";
  if (production && url.protocol === "http:" && (!LOOPBACK_HOSTS.has(url.hostname) || !url.port)) {
    return "must be https, or http://127.0.0.1:<port> (or localhost or [::1]) on this server, in production";
  }
  return null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid CRM configuration: ${problems}`);
  }
  const c = parsed.data;
  if (c.NODE_ENV === "production") {
    if (!c.CRM_COOKIE_SECURE) throw new Error("Invalid CRM configuration: CRM_COOKIE_SECURE must be true in production");
    if (!c.CRM_STAFF_ORIGIN.startsWith("https://")) throw new Error("Invalid CRM configuration: CRM_STAFF_ORIGIN must be https in production");
    if (c.CRM_STAFF_ALLOWED_IPS.length === 0) {
      throw new Error("Invalid CRM configuration: CRM_STAFF_ALLOWED_IPS is required in production");
    }
  }
  if (c.CRM_SUPPORT_EVENTS_URL && c.CRM_SUPPORT_EVENTS_SECRET.length < 32) {
    throw new Error("Invalid CRM configuration: CRM_SUPPORT_EVENTS_SECRET must be at least 32 characters when CRM_SUPPORT_EVENTS_URL is set");
  }
  if (c.CRM_MT5_GATEWAY_URL) {
    const problem = gatewayUrlProblem(c.CRM_MT5_GATEWAY_URL, c.NODE_ENV === "production");
    if (problem) throw new Error(`Invalid CRM configuration: CRM_MT5_GATEWAY_URL ${problem}`);
    if (c.CRM_MT5_GATEWAY_SECRET.length < MIN_SECRET_LENGTH) {
      throw new Error(`Invalid CRM configuration: CRM_MT5_GATEWAY_SECRET must be at least ${MIN_SECRET_LENGTH} characters when CRM_MT5_GATEWAY_URL is set`);
    }
  }
  const proxies = c.CRM_TRUSTED_PROXIES.trim();
  return {
    env: c.NODE_ENV,
    port: c.PORT,
    databaseUrl: c.CRM_DATABASE_URL,
    dataKey: Buffer.from(c.CRM_DATA_KEY, "base64"),
    staffOrigin: new URL(c.CRM_STAFF_ORIGIN).origin,
    staffAllowedIps: c.CRM_STAFF_ALLOWED_IPS,
    trustedProxies: proxies === "" || proxies === "false" ? false : proxies.split(",").map((s) => s.trim()).filter(Boolean),
    cookieSecure: c.CRM_COOKIE_SECURE,
    sessionIdleMs: c.CRM_SESSION_IDLE_MINUTES * 60_000,
    sessionMaxMs: c.CRM_SESSION_MAX_HOURS * 3_600_000,
    stepUpMs: c.CRM_STEPUP_MINUTES * 60_000,
    loginMaxFailures: c.CRM_LOGIN_MAX_FAILURES,
    loginLockMs: c.CRM_LOGIN_LOCK_MINUTES * 60_000,
    passwordBreachCheck: c.CRM_PASSWORD_BREACH_CHECK,
    serveAdmin: c.CRM_SERVE_ADMIN,
    logLevel: c.CRM_LOG_LEVEL,
    clientOrigins: (c.CRM_CLIENT_ORIGINS.length ? c.CRM_CLIENT_ORIGINS : [c.CRM_PORTAL_URL]).map((o) => new URL(o).origin),
    portalUrl: c.CRM_PORTAL_URL.replace(/\/+$/, ""),
    publicUrl: c.CRM_PUBLIC_URL.replace(/\/+$/, ""),
    clientSessionMs: c.CRM_CLIENT_SESSION_DAYS * 86_400_000,
    clientIdleMs: c.CRM_CLIENT_IDLE_DAYS * 86_400_000,
    impersonationMs: c.CRM_IMPERSONATION_MINUTES * 60_000,
    supportEvents: {
      url: c.CRM_SUPPORT_EVENTS_URL ? c.CRM_SUPPORT_EVENTS_URL.replace(/\/+$/, "") : null,
      secret: c.CRM_SUPPORT_EVENTS_SECRET,
      environment: c.CRM_SUPPORT_EVENTS_ENVIRONMENT,
    },
    mt5Gateway: c.CRM_MT5_GATEWAY_URL ? { url: c.CRM_MT5_GATEWAY_URL.replace(/\/+$/, ""), secret: c.CRM_MT5_GATEWAY_SECRET } : null,
  };
}
