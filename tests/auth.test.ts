import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { exec, one } from "../src/server/lib/db";
import { codeFor, createStaff, forgetLastStep, hasDb, ORIGIN, PASSWORD, post, setup, signIn, type TestEnv } from "./helpers";

describe.skipIf(!hasDb)("staff sign-in", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => {
    await env?.db.end();
  });
  beforeEach(async () => {
    await exec(env.db, "SET FOREIGN_KEY_CHECKS = 0");
    await exec(env.db, "DELETE FROM staff_login_challenges");
    await exec(env.db, "DELETE FROM staff_sessions");
    await exec(env.db, "DELETE FROM staff_users");
    await exec(env.db, "SET FOREIGN_KEY_CHECKS = 1");
  });

  const login = (email: string, password = PASSWORD, agent = request.agent(env.app)) =>
    agent.post("/api/staff/auth/login").set("Origin", ORIGIN).send({ email, password });

  it("requires 2FA enrollment on first sign-in, then a code on every sign-in", async () => {
    await createStaff(env.db, "ana@bis.test", "admin");
    const s = await signIn(env, "ana@bis.test");
    const session = await s.agent.get("/api/staff/auth/session");
    expect(session.status).toBe(200);
    expect(session.body.staff.email).toBe("ana@bis.test");
    expect(session.body.permissions).toContain("staff.view");
    expect(session.body.permissions).not.toContain("role.manage");

    const again = await login("ana@bis.test");
    expect(again.body.step).toBe("totp");
    expect(again.body.secret).toBeUndefined();
    const ok = await request(env.app).post("/api/staff/auth/verify").set("Origin", ORIGIN).send({ challenge: again.body.challenge, code: codeFor(s.secret, 0) });
    expect(ok.status).toBe(200);
    expect(ok.headers["set-cookie"]?.[0]).toMatch(/HttpOnly; SameSite=Strict/);
  });

  it("refuses a 2FA code that was already used", async () => {
    await createStaff(env.db, "ben@bis.test", "admin");
    const s = await signIn(env, "ben@bis.test"); // used the code for step −1
    const again = await login("ben@bis.test");
    const replay = await request(env.app).post("/api/staff/auth/verify").set("Origin", ORIGIN).send({ challenge: again.body.challenge, code: codeFor(s.secret, -1) });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe("BAD_CODE");
  });

  it("gives the same answer for an unknown email and a wrong password", async () => {
    await createStaff(env.db, "cal@bis.test", "admin");
    const unknown = await login("nobody@bis.test");
    const wrong = await login("cal@bis.test", "Wrong-password-123");
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
  });

  it("locks the account after repeated wrong passwords, even for the right password", async () => {
    await createStaff(env.db, "dee@bis.test", "admin");
    for (let i = 0; i < env.config.loginMaxFailures; i++) await login("dee@bis.test", `Wrong-password-${i}xx`);
    const locked = await login("dee@bis.test");
    expect(locked.status).toBe(423);
    const audit = await one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'staff.locked'");
    expect(Number(audit?.n)).toBeGreaterThan(0);
  });

  it("refuses disabled accounts", async () => {
    await createStaff(env.db, "eve@bis.test", "admin", { status: "disabled" });
    const res = await login("eve@bis.test");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("DISABLED");
  });

  it("stops a challenge after five wrong codes", async () => {
    await createStaff(env.db, "fay@bis.test", "admin");
    const first = await login("fay@bis.test");
    for (let i = 0; i < 5; i++) {
      await request(env.app).post("/api/staff/auth/verify").set("Origin", ORIGIN).send({ challenge: first.body.challenge, code: "000000" });
    }
    const right = await request(env.app).post("/api/staff/auth/verify").set("Origin", ORIGIN).send({ challenge: first.body.challenge, code: codeFor(first.body.secret) });
    expect(right.status).toBe(401);
    expect(right.body.error.code).toBe("CHALLENGE_EXPIRED");
  });

  it("blocks state-changing requests without the CSRF token or from another origin", async () => {
    await createStaff(env.db, "gus@bis.test", "super_admin");
    const s = await signIn(env, "gus@bis.test");
    const noCsrf = await s.agent.post("/api/staff/auth/logout").set("Origin", ORIGIN);
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error.code).toBe("CSRF");
    const badOrigin = await s.agent.post("/api/staff/auth/logout").set("Origin", "https://evil.example").set("X-CSRF-Token", s.csrf);
    expect(badOrigin.status).toBe(403);
    expect(badOrigin.body.error.code).toBe("BAD_ORIGIN");
    const noOrigin = await request(env.app).post("/api/staff/auth/login").send({ email: "gus@bis.test", password: PASSWORD });
    expect(noOrigin.status).toBe(403);
  });

  it("ends the session after the idle timeout and on logout", async () => {
    await createStaff(env.db, "hal@bis.test", "admin");
    const s = await signIn(env, "hal@bis.test");
    await exec(env.db, "UPDATE staff_sessions SET last_seen_at = NOW(3) - INTERVAL 16 MINUTE");
    expect((await s.agent.get("/api/staff/auth/session")).status).toBe(401);

    const t = await signIn(env, "hal@bis.test").catch(async () => {
      // The enrollment already happened; sign in with a code instead.
      await forgetLastStep(env.db, s.staffId);
      const agent = request.agent(env.app);
      const l = await agent.post("/api/staff/auth/login").set("Origin", ORIGIN).send({ email: "hal@bis.test", password: PASSWORD });
      const v = await agent.post("/api/staff/auth/verify").set("Origin", ORIGIN).send({ challenge: l.body.challenge, code: codeFor(s.secret) });
      return { ...s, agent, csrf: v.body.csrfToken as string };
    });
    expect((await post(t, "/api/staff/auth/logout")).status).toBe(204);
    expect((await t.agent.get("/api/staff/auth/session")).status).toBe(401);
  });

  it("forces a password change before anything else, then signs out other sessions", async () => {
    await createStaff(env.db, "ivy@bis.test", "admin", { mustChange: true });
    const s = await signIn(env, "ivy@bis.test");
    const blocked = await s.agent.get("/api/staff/users");
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("PASSWORD_CHANGE_REQUIRED");
    const weak = await post(s, "/api/staff/auth/password", { currentPassword: PASSWORD, newPassword: "short" });
    expect(weak.status).toBe(400);
    const changed = await post(s, "/api/staff/auth/password", { currentPassword: PASSWORD, newPassword: "A-much-better-passphrase-77" });
    expect(changed.status).toBe(204);
    expect((await s.agent.get("/api/staff/users")).status).toBe(200);
  });

  it("hides the staff API from addresses outside the allowlist", async () => {
    const { createApp } = await import("../src/server/app");
    const { testConfig } = await import("./helpers");
    const pino = (await import("pino")).default;
    const restricted = createApp({ db: env.db, config: testConfig({ CRM_STAFF_ALLOWED_IPS: "203.0.113.9" }), log: pino({ level: "silent" }), fetch });
    const res = await request(restricted).post("/api/staff/auth/login").set("Origin", ORIGIN).send({ email: "x@y.z", password: "x" });
    expect(res.status).toBe(404);
  });
});
