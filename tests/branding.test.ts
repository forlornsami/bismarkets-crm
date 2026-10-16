import { readFileSync } from "node:fs";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { imageInfo } from "../src/server/lib/images";
import { one } from "../src/server/lib/db";
import { createStaff, del, hasDb, ORIGIN, setup, signIn, stepUp, type SignedIn, type TestEnv } from "./helpers";

const logo = readFileSync(new URL("../src/admin/public/brand/logo-light.png", import.meta.url));
const icon = readFileSync(new URL("../src/admin/public/brand/favicon.png", import.meta.url));

describe("image sniffing", () => {
  it("reads PNG dimensions and refuses other content", () => {
    expect(imageInfo(logo)).toMatchObject({ type: "image/png", width: 1200 });
    expect(imageInfo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull();
    expect(imageInfo(Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x40, 0x03]))).toMatchObject({ type: "image/jpeg", width: 64, height: 32 });
    expect(imageInfo(Buffer.alloc(0))).toBeNull();
  });
});

describe.skipIf(!hasDb)("branding", () => {
  let env: TestEnv;
  let boss: SignedIn;
  let admin: SignedIn;
  const put = (s: SignedIn, slot: string, body: Buffer, type = "image/png") =>
    s.agent.put(`/api/staff/branding/${slot}`).set("Origin", ORIGIN).set("X-CSRF-Token", s.csrf).set("Content-Type", type).send(body);

  beforeAll(async () => {
    env = await setup();
    await createStaff(env.db, "boss@bis.test", "super_admin");
    await createStaff(env.db, "admin@bis.test", "admin");
    boss = await signIn(env, "boss@bis.test");
    admin = await signIn(env, "admin@bis.test");
  });
  afterAll(async () => {
    await env?.db.end();
  });

  it("serves the built-in logos to the sign-in page without a session", async () => {
    const res = await request(env.app).get("/api/staff/branding");
    expect(res.status).toBe(200);
    expect(res.body.logoLight).toMatchObject({ url: "/brand/logo-light.png", custom: false });
    expect(res.body.logoDark.url).toBe("/brand/logo-dark.png");
  });

  it("needs settings.manage, a fresh 2FA code and the CSRF token to change a logo", async () => {
    expect((await request(env.app).put("/api/staff/branding/logo_light").set("Origin", ORIGIN).set("Content-Type", "image/png").send(logo)).status).toBe(401);
    expect((await put(admin, "logo_light", logo)).status).toBe(403);
    const noStepUp = await put(boss, "logo_light", logo);
    expect(noStepUp.body.error.code).toBe("STEP_UP_REQUIRED");
    await stepUp(env, boss);
    const noCsrf = await boss.agent.put("/api/staff/branding/logo_light").set("Origin", ORIGIN).set("Content-Type", "image/png").send(logo);
    expect(noCsrf.body.error.code).toBe("CSRF");
  });

  it("rejects files that are not real images or do not match their type", async () => {
    await stepUp(env, boss);
    expect((await put(boss, "logo_light", Buffer.from("<svg/>"), "image/svg+xml")).status).toBe(400);
    expect((await put(boss, "logo_light", Buffer.from("not an image"))).status).toBe(400);
    expect((await put(boss, "logo_light", logo, "image/jpeg")).status).toBe(400);
    expect((await put(boss, "logo_light", icon)).body.error.message).toMatch(/at least 120 pixels/);
    expect((await put(boss, "favicon", logo)).body.error.message).toMatch(/at most 1024 pixels/);
    expect((await put(boss, "logo_light", Buffer.concat([logo, Buffer.alloc(1024 * 1024)]))).status).toBe(413);
  });

  it("stores, serves, audits and resets a custom logo", async () => {
    await stepUp(env, boss);
    const saved = await put(boss, "logo_dark", logo);
    expect(saved.status).toBe(200);
    expect(saved.body.url).toMatch(/^\/api\/staff\/branding\/files\/logo_dark\?v=[0-9a-f]{16}$/);

    const info = await request(env.app).get("/api/staff/branding");
    expect(info.body.logoDark).toMatchObject({ custom: true, width: 1200 });
    const file = await request(env.app).get(saved.body.url);
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toBe("image/png");
    expect(file.headers["cache-control"]).toContain("immutable");
    expect(file.headers["content-security-policy"]).toContain("sandbox");
    expect(Buffer.compare(file.body as Buffer, logo)).toBe(0);
    expect((await request(env.app).get("/api/staff/branding/files/logo_dark").set("If-None-Match", file.headers.etag!)).status).toBe(304);

    const audit = await one<{ actor_id: number; after_json: { width: number } }>(env.db, "SELECT actor_id, after_json FROM audit_log WHERE action = 'branding.updated' ORDER BY id DESC LIMIT 1");
    expect(audit).toMatchObject({ actor_id: boss.staffId, after_json: { width: 1200 } });

    expect((await del(boss, "/api/staff/branding/logo_dark")).status).toBe(204);
    expect((await request(env.app).get("/api/staff/branding")).body.logoDark.custom).toBe(false);
    expect((await request(env.app).get(saved.body.url)).status).toBe(404);
    expect(await one(env.db, "SELECT id FROM audit_log WHERE action = 'branding.reset'")).toBeTruthy();
  });
});
