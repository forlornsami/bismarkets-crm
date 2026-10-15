import type { Express } from "express";
import pino from "pino";
import request from "supertest";
import { createApp } from "../src/server/app";
import { loadConfig, type Config } from "../src/server/config";
import { createDb, exec, one, rows, type Db } from "../src/server/lib/db";
import { hashPassword } from "../src/server/lib/passwords";
import { base32Decode, currentStep, hotp } from "../src/server/lib/totp";
import { migrate } from "../src/server/migrate";
import { seedRoles } from "../src/server/seed";

export const TEST_DB_URL = process.env.CRM_TEST_DATABASE_URL ?? "";
export const hasDb = TEST_DB_URL !== "";
export const ORIGIN = "https://staff.test.local";

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    CRM_DATABASE_URL: TEST_DB_URL || "mysql://u:p@127.0.0.1:3306/none",
    CRM_DATA_KEY: Buffer.alloc(32, 7).toString("base64"),
    CRM_STAFF_ORIGIN: ORIGIN,
    CRM_COOKIE_SECURE: "false",
    CRM_PASSWORD_BREACH_CHECK: "false",
    CRM_SERVE_ADMIN: "false",
    CRM_LOG_LEVEL: "silent",
    ...overrides,
  });
}

/** Drops every table (the audit triggers block row deletes, not DROP TABLE), then migrates and seeds. */
export async function resetDatabase(db: Db) {
  await exec(db, "SET FOREIGN_KEY_CHECKS = 0");
  const tables = await rows<{ name: string }>(db, "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()");
  for (const t of tables) await db.query(`DROP TABLE IF EXISTS \`${t.name}\``);
  await exec(db, "SET FOREIGN_KEY_CHECKS = 1");
  await migrate(db, undefined, () => undefined);
  await seedRoles(db);
}

export interface TestEnv {
  db: Db;
  config: Config;
  app: Express;
}

export async function setup(overrides: Record<string, string> = {}): Promise<TestEnv> {
  const config = testConfig(overrides);
  const db = createDb(TEST_DB_URL);
  await resetDatabase(db);
  const app = createApp({ db, config, log: pino({ level: "silent" }), fetch: (async () => new Response("", { status: 503 })) as typeof fetch });
  return { db, config, app };
}

/** A code for the current step shifted by `offset` (−1, 0 or +1 are all accepted). */
export const codeFor = (secret: string, offset = 0) => hotp(base32Decode(secret), currentStep() + offset);

export const PASSWORD = "Correct-Horse-Battery-9";

export async function createStaff(db: Db, email: string, roleSlug: string, opts: { status?: string; mustChange?: boolean } = {}) {
  const role = await one<{ id: number }>(db, "SELECT id FROM roles WHERE slug = ?", [roleSlug]);
  if (!role) throw new Error(`no role ${roleSlug}`);
  const result = await exec(db, "INSERT INTO staff_users (email, name, password_hash, role_id, status, must_change_password) VALUES (?, ?, ?, ?, ?, ?)", [
    email,
    email.split("@")[0],
    await hashPassword(PASSWORD),
    role.id,
    opts.status ?? "active",
    opts.mustChange ? 1 : 0,
  ]);
  return result.insertId;
}

/** Lets the next code be accepted again by clearing the replay marker. */
export const forgetLastStep = (db: Db, staffId: number) => exec(db, "UPDATE staff_users SET totp_last_step = NULL WHERE id = ?", [staffId]);

export interface SignedIn {
  agent: ReturnType<typeof request.agent>;
  csrf: string;
  secret: string;
  staffId: number;
}

/** Full first sign-in: password, 2FA enrollment, session. */
export async function signIn(env: TestEnv, email: string, password = PASSWORD): Promise<SignedIn> {
  const agent = request.agent(env.app);
  const login = await agent.post("/api/staff/auth/login").set("Origin", ORIGIN).send({ email, password });
  if (login.status !== 200) throw new Error(`login failed ${login.status} ${JSON.stringify(login.body)}`);
  const secret: string = login.body.secret;
  if (login.body.step !== "enroll") throw new Error("expected enrollment for a new account");
  const verify = await agent.post("/api/staff/auth/verify").set("Origin", ORIGIN).send({ challenge: login.body.challenge, code: codeFor(secret, -1) });
  if (verify.status !== 200) throw new Error(`verify failed ${verify.status} ${JSON.stringify(verify.body)}`);
  const staff = await one<{ id: number }>(env.db, "SELECT id FROM staff_users WHERE email = ?", [email]);
  return { agent, csrf: verify.body.csrfToken, secret, staffId: staff!.id };
}

export async function stepUp(env: TestEnv, s: SignedIn) {
  await forgetLastStep(env.db, s.staffId);
  const res = await s.agent.post("/api/staff/auth/step-up").set("Origin", ORIGIN).set("X-CSRF-Token", s.csrf).send({ code: codeFor(s.secret) });
  if (res.status !== 200) throw new Error(`step-up failed ${res.status} ${JSON.stringify(res.body)}`);
}

export const post = (s: SignedIn, url: string, body: unknown = {}) => s.agent.post(url).set("Origin", ORIGIN).set("X-CSRF-Token", s.csrf).send(body as object);
export const patch = (s: SignedIn, url: string, body: unknown = {}) => s.agent.patch(url).set("Origin", ORIGIN).set("X-CSRF-Token", s.csrf).send(body as object);
export const del = (s: SignedIn, url: string) => s.agent.delete(url).set("Origin", ORIGIN).set("X-CSRF-Token", s.csrf);
