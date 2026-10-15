import { z } from "zod";

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
};

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
  };
}
