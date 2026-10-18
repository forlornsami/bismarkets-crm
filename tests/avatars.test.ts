import { readFileSync } from "node:fs";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { one } from "../src/server/lib/db";
import { createStaff, del, hasDb, ORIGIN, setup, signIn, type SignedIn, type TestEnv } from "./helpers";

const picture = readFileSync(new URL("../src/admin/public/brand/apple-touch-icon.png", import.meta.url));
// A PNG header that claims 16x16 pixels.
const tiny = Buffer.from(readFileSync(new URL("../src/admin/public/brand/favicon.png", import.meta.url)));
tiny.writeUInt32BE(16, 16);
tiny.writeUInt32BE(16, 20);

describe.skipIf(!hasDb)("staff profile pictures", () => {
  let env: TestEnv;
  let boss: SignedIn;
  let agent: SignedIn;
  let agentId: number;
  let bossId: number;
  const put = (s: SignedIn, url: string, body: Buffer, type = "image/png") =>
    s.agent.put(url).set("Origin", ORIGIN).set("X-CSRF-Token", s.csrf).set("Content-Type", type).send(body);

  beforeAll(async () => {
    env = await setup();
    bossId = await createStaff(env.db, "boss@bis.test", "super_admin");
    agentId = await createStaff(env.db, "agent@bis.test", "support_agent");
    boss = await signIn(env, "boss@bis.test");
    agent = await signIn(env, "agent@bis.test");
  });
  afterAll(async () => {
    await env?.db.end();
  });

  it("lets anyone set their own picture and shows it in their session", async () => {
    const saved = await put(agent, "/api/staff/users/me/avatar", picture);
    expect(saved.status).toBe(200);
    expect(saved.body.avatarUrl).toMatch(new RegExp(`^/api/staff/users/${agentId}/avatar\\?v=[0-9a-f]{16}$`));
    const session = await agent.agent.get("/api/staff/auth/session");
    expect(session.body.staff.avatarUrl).toBe(saved.body.avatarUrl);

    const file = await boss.agent.get(saved.body.avatarUrl);
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toBe("image/png");
    expect(file.headers["content-security-policy"]).toContain("sandbox");
    expect(Buffer.compare(file.body as Buffer, picture)).toBe(0);

    const listed = await boss.agent.get(`/api/staff/users/${agentId}`);
    expect(listed.body.avatarUrl).toBe(saved.body.avatarUrl);
    const audit = await one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'staff.avatar_updated' AND entity_id = ?", [String(agentId)]);
    expect(Number(audit?.n)).toBe(1);
  });

  it("checks the file itself and needs a session and the CSRF token", async () => {
    expect((await put(agent, "/api/staff/users/me/avatar", Buffer.from("<svg/>"), "image/svg+xml")).status).toBe(400);
    expect((await put(agent, "/api/staff/users/me/avatar", picture, "image/webp")).status).toBe(400);
    expect((await put(agent, "/api/staff/users/me/avatar", tiny)).status).toBe(400);
    const noCsrf = await agent.agent.put("/api/staff/users/me/avatar").set("Origin", ORIGIN).set("Content-Type", "image/png").send(picture);
    expect(noCsrf.body.error.code).toBe("CSRF");
    const anon = await request(env.app).get(`/api/staff/users/${agentId}/avatar`);
    expect(anon.status).toBe(401);
  });

  it("only lets managers change someone else's picture", async () => {
    expect((await put(agent, `/api/staff/users/${bossId}/avatar`, picture)).status).toBe(403);
    expect((await put(boss, `/api/staff/users/${agentId}/avatar`, picture)).status).toBe(200);
    const removed = await del(boss, `/api/staff/users/${agentId}/avatar`);
    expect(removed.body.avatarUrl).toBeNull();
    expect((await boss.agent.get(`/api/staff/users/${agentId}/avatar`)).status).toBe(404);
  });
});
