import { inspect } from "node:util";
import { z } from "zod";
import { MIN_SECRET_LENGTH, MT5_GROUP, SERVER_CODE } from "./protocol";
import { passwordHash } from "./mt5/webapi";

// The gateway's settings, all from its own environment file. Only the
// gateway holds MT5 manager credentials, so this is the one place they are
// read. A problem names the setting, never its value: the value may be a
// password.

/** A secret that prints as "[hidden]" in logs, JSON and the console. */
export class Hidden<T> {
  #value: T;
  constructor(value: T) {
    this.#value = value;
  }
  reveal(): T {
    return this.#value;
  }
  toJSON() {
    return "[hidden]";
  }
  [inspect.custom]() {
    return "[hidden]";
  }
}

export interface Mt5ServerConfig {
  /** The code the CRM names this server by ("live", "demo"). */
  code: string;
  host: string;
  port: number;
  /** The manager login the gateway signs in with. */
  login: number;
  /** The manager password, already hashed the way MT5's sign-in needs it (the text itself is not kept). */
  passwordHash: Hidden<Buffer>;
  /** SHA-256 of the server's certificate as 64 lowercase hex digits, or null to require a CA-signed certificate. */
  certSha256: string | null;
  /** Live groups the CRM may use on this server, exact names. */
  groups: string[];
  /** Demo groups the CRM may use on this server, exact names. */
  demoGroups: string[];
  connections: number;
  version: number;
  agent: string;
  /** The trade server's clock minus UTC, in minutes; MT5 deal times are in server time. */
  tzOffsetMinutes: number;
}

export interface GatewayConfig {
  host: string;
  port: number;
  secret: Hidden<string>;
  logLevel: string;
  servers: Mt5ServerConfig[];
  leverages: number[];
  maxOpCents: number;
  dailyCreditCents: number;
  demoMaxOpCents: number;
}

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

/** Empty and blank values count as unset, so a commented-out value falls back to its default. */
const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : typeof v === "string" ? v.trim() : v);

const whole = (min: number, max: number, fallback?: number) => {
  const message = `must be a whole number from ${min} to ${max}`;
  return z.preprocess(
    (v) => blank(v) ?? (fallback === undefined ? undefined : String(fallback)),
    z
      .string({ required_error: "is required" })
      .regex(/^-?\d{1,16}$/, message)
      .transform(Number)
      .pipe(z.number().int().min(min, message).max(max, message)),
  );
};

const csv = z.preprocess(blank, z.string().optional()).transform((v) => [...new Set((v ?? "").split(",").map((s) => s.trim()).filter(Boolean))]);
const groupList = csv.refine((groups) => groups.every((g) => MT5_GROUP.test(g)), "each group must be an MT5 group name (letters, digits, \\ _ - . and spaces, up to 64)");

const schema = z.object({
  GATEWAY_HOST: z.preprocess(blank, z.string().default("127.0.0.1")),
  GATEWAY_PORT: whole(1, 65535, 3100),
  GATEWAY_SECRET: z.string({ required_error: "is required" }).min(MIN_SECRET_LENGTH, `must be at least ${MIN_SECRET_LENGTH} characters`),
  // Custom messages, as zod's own would repeat the value it was given.
  GATEWAY_LOG_LEVEL: z.preprocess(blank, z.enum(LOG_LEVELS, { message: `must be one of ${LOG_LEVELS.join(", ")}` }).default("info")),
  GATEWAY_ALLOW_REMOTE: z.preprocess(blank, z.enum(["true", "false"], { message: "must be true or false" }).default("false")),
  GATEWAY_SERVERS: csv.refine((codes) => codes.length > 0, "list at least one server code"),
  // The leverages accounts may have, as whole numbers ("2000" is 1:2000).
  GATEWAY_LEVERAGES: z
    .preprocess((v) => blank(v) ?? "2000", z.string())
    .transform((v) => [...new Set(v.split(",").map((s) => s.trim()).filter(Boolean))])
    .refine((v) => v.length > 0 && v.every((s) => /^\d{1,6}$/.test(s) && Number(s) >= 1 && Number(s) <= 100_000), "must be a comma list of whole numbers from 1 to 100000")
    .transform((v) => v.map(Number)),
  GATEWAY_MAX_OP_CENTS: whole(1, Number.MAX_SAFE_INTEGER, 10_000_000),
  GATEWAY_DAILY_CREDIT_CENTS: whole(1, Number.MAX_SAFE_INTEGER, 50_000_000),
  GATEWAY_DEMO_MAX_OP_CENTS: whole(1, Number.MAX_SAFE_INTEGER, 10_000_000),
});

const serverSchema = z.object({
  HOST: z.preprocess(blank, z.string({ required_error: "is required" }).regex(/^(?:[A-Za-z0-9.-]{1,253}|[0-9A-Fa-f:]{2,39})$/, "must be a host name or IP address")),
  PORT: whole(1, 65535, 443),
  LOGIN: whole(1, Number.MAX_SAFE_INTEGER),
  PASSWORD: z.string({ required_error: "is required" }).min(1, "is required").max(128, "must be at most 128 characters"),
  CERT_SHA256: z.preprocess(blank, z.string().optional()).transform((v, ctx) => {
    if (v === undefined) return null;
    const pin = normalizePin(v);
    if (pin === null) ctx.addIssue({ code: "custom", message: "must be a SHA-256 fingerprint, 64 hex digits with or without colons" });
    return pin;
  }),
  GROUPS: groupList,
  DEMO_GROUPS: groupList,
  CONNECTIONS: whole(1, 16, 2),
  VERSION: whole(1, 1_000_000, 3211),
  AGENT: z.preprocess(blank, z.string().regex(/^[A-Za-z0-9_.-]{1,32}$/, "must be letters, digits, _ . or -, up to 32").default("BISCRM")),
  TZ_OFFSET_MINUTES: whole(-1440, 1440, 0),
});

/** The part of a server's variable names that comes from its code: "live-2" → "LIVE_2". */
export const serverEnvKey = (code: string) => code.toUpperCase().replace(/-/g, "_");

const isLoopback = (host: string) => host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);

/** "AB:CD:…" or "abcd…" → 64 lowercase hex digits, or null when it is neither. */
export function normalizePin(value: string): string | null {
  const text = value.trim().toLowerCase();
  if (/^[0-9a-f]{64}$/.test(text)) return text;
  if (/^[0-9a-f]{2}(:[0-9a-f]{2}){31}$/.test(text)) return text.replace(/:/g, "");
  return null;
}

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const problems: string[] = [];
  const issues = (prefix: string, error: z.ZodError) => error.issues.forEach((i) => problems.push(`${prefix}${i.path.join(".")}: ${i.message}`));

  const parsed = schema.safeParse(env);
  if (!parsed.success) issues("", parsed.error);
  const c = parsed.success ? parsed.data : null;
  // The CRM reaches the gateway on the same host. Listening anywhere else
  // puts the signed API on the network, so it takes a deliberate setting.
  if (c && !isLoopback(c.GATEWAY_HOST) && c.GATEWAY_ALLOW_REMOTE !== "true") {
    problems.push("GATEWAY_HOST: must be a loopback address (127.0.0.1, ::1 or localhost) unless GATEWAY_ALLOW_REMOTE=true");
  }

  const keys = new Set<string>();
  const servers: Mt5ServerConfig[] = [];
  for (const code of c?.GATEWAY_SERVERS ?? []) {
    if (!SERVER_CODE.test(code)) {
      problems.push(`GATEWAY_SERVERS: "${code}" is not a server code (lowercase letters, digits, _ and -, up to 16)`);
      continue;
    }
    const key = serverEnvKey(code);
    if (keys.has(key)) {
      problems.push(`GATEWAY_SERVERS: two codes share the variable names GATEWAY_SERVER_${key}_*`);
      continue;
    }
    keys.add(key);
    const prefix = `GATEWAY_SERVER_${key}_`;
    const own = Object.fromEntries(Object.keys(serverSchema.shape).map((name) => [name, env[prefix + name]]));
    const s = serverSchema.safeParse(own);
    if (!s.success) {
      issues(prefix, s.error);
      continue;
    }
    const { GROUPS: groups, DEMO_GROUPS: demoGroups } = s.data;
    if (groups.length + demoGroups.length === 0) problems.push(`${prefix}GROUPS: list at least one live or demo group`);
    if (groups.some((g) => demoGroups.includes(g))) problems.push(`${prefix}DEMO_GROUPS: a group cannot be both live and demo`);
    servers.push({
      code,
      host: s.data.HOST,
      port: s.data.PORT,
      login: s.data.LOGIN,
      passwordHash: new Hidden(passwordHash(s.data.PASSWORD)),
      certSha256: s.data.CERT_SHA256,
      groups,
      demoGroups,
      connections: s.data.CONNECTIONS,
      version: s.data.VERSION,
      agent: s.data.AGENT,
      tzOffsetMinutes: s.data.TZ_OFFSET_MINUTES,
    });
  }
  // A mistyped name (a pin under the wrong key, say) would otherwise be ignored without a word.
  for (const name of Object.keys(env)) {
    if (!name.startsWith("GATEWAY_") || name in schema.shape) continue;
    const known = [...keys].some((key) => Object.keys(serverSchema.shape).some((s) => name === `GATEWAY_SERVER_${key}_${s}`));
    if (!known) problems.push(`${name}: is not a gateway setting (or its server is not in GATEWAY_SERVERS)`);
  }
  if (problems.length || !c) throw new Error(`Invalid gateway configuration: ${problems.join("; ")}`);
  return {
    host: c.GATEWAY_HOST,
    port: c.GATEWAY_PORT,
    secret: new Hidden(c.GATEWAY_SECRET),
    logLevel: c.GATEWAY_LOG_LEVEL,
    servers,
    leverages: c.GATEWAY_LEVERAGES,
    maxOpCents: c.GATEWAY_MAX_OP_CENTS,
    dailyCreditCents: c.GATEWAY_DAILY_CREDIT_CENTS,
    demoMaxOpCents: c.GATEWAY_DEMO_MAX_OP_CENTS,
  };
}
