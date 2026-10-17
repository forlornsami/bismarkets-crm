import { readFileSync } from "node:fs";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { documentType } from "../src/server/clients/kyc";
import { decryptField } from "../src/server/lib/crypto";
import { one } from "../src/server/lib/db";
import { outboxContext } from "../src/server/lib/email";
import { createStaff, hasDb, ORIGIN, post, setup, signIn, stepUp, type SignedIn, type TestEnv } from "./helpers";

const GOOD = "Sunny-Day-42!";
const png = readFileSync(new URL("../src/admin/public/brand/apple-touch-icon.png", import.meta.url));
const pdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const ALL = { identity: ["name", "dob", "valid", "clear"], address: ["name", "address", "recent", "clear"] };
const PROFILE = { phone: "7700900123", countryCode: "44", country: "United Kingdom", city: "London", address: "1 Baker St", zipcode: "W1A 1AA", dob: "1990-04-02", gender: "Female" };

describe("document sniffing", () => {
  it("accepts images and PDFs only", () => {
    expect(documentType(png)).toBe("image/png");
    expect(documentType(pdf)).toBe("application/pdf");
    expect(documentType(Buffer.from("<html><script>alert(1)</script></html>"))).toBeNull();
  });
});

describe.skipIf(!hasDb)("KYC", () => {
  let env: TestEnv;
  let reviewer: SignedIn;
  let second: SignedIn;
  let sales: SignedIn;
  let boss: SignedIn;
  let token: string;
  let clientId: number;
  const api = () => request(env.app);
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const upload = (type: number, subType: number, files: Buffer[], t = token) => {
    let r = api().post("/api/kyc").set("Authorization", `Bearer ${t}`).field("type", String(type)).field("sub_type", String(subType));
    files.forEach((f, i) => (r = r.attach(`document${i + 1}`, f, { filename: f === pdf ? "doc.pdf" : "doc.png", contentType: f === pdf ? "application/pdf" : "image/png" })));
    return r;
  };

  beforeAll(async () => {
    env = await setup();
    await createStaff(env.db, "comp@bis.test", "compliance");
    await createStaff(env.db, "sales@bis.test", "sales_agent");
    await createStaff(env.db, "comp2@bis.test", "compliance");
    reviewer = await signIn(env, "comp@bis.test");
    sales = await signIn(env, "sales@bis.test");
    second = await signIn(env, "comp2@bis.test");
    await createStaff(env.db, "boss@bis.test", "super_admin");
    boss = await signIn(env, "boss@bis.test");
    await api().post("/api/send-otp").send({ email: "kyc@client.test" });
    const row = await one<{ body_enc: Buffer; template: string }>(env.db, "SELECT body_enc, template FROM email_outbox ORDER BY id DESC LIMIT 1");
    const code = /code is (\d{6})/.exec(decryptField(env.config.dataKey, row!.body_enc, outboxContext("kyc@client.test", row!.template)))![1];
    const res = await api().post("/api/register").send({ first_name: "Kay", last_name: "Doe", email: "kyc@client.test", password: GOOD, password_confirmation: GOOD, verification_code: code });
    token = res.body.token;
    clientId = res.body.user.id;
  });
  afterAll(async () => {
    await env?.db.end();
  });

  it("lists the document types by the names the portal and app look up", async () => {
    const res = await api().get("/api/kyc/types").set(auth());
    expect(res.body.identity.map((t: { name: string }) => t.name)).toEqual(["ID Card", "Passport", "Driving License"]);
    expect(res.body.address[3]).toMatchObject({ sub_type: 4, type: 4, name: "ID Card Back" });
  });

  it("reports a fresh account as not submitted, with the missing profile fields", async () => {
    const res = await api().get("/api/kyc").set(auth());
    expect(res.body).toMatchObject({ success: true, email_verified: true, profile_complete: false, is_kyc_approved: false, overall_status: "not_submitted" });
    expect(res.body.missing_profile_fields).toContain("dob");
    expect(res.body.identity).toMatchObject({ type: 3, status: null, status_label: "Not submitted", can_submit: true });
    expect((await upload(3, 2, [png])).status).toBe(422);
  });

  it("keeps stored values when a form sends empty strings", async () => {
    await api().patch("/api/user").set(auth()).send(PROFILE);
    await api().patch("/api/user").set(auth()).send({ first_name: "Kay", last_name: "Doe", phone: "", country: "", city: "", gender: "" });
    const me = await api().get("/api/user").set(auth());
    expect(me.body).toMatchObject({ phone: "7700900123", country: "United Kingdom", city: "London", gender: "Female" });
    expect((await api().patch("/api/user").set(auth()).send({ phone: "+44 7700 900123", gender: "male" })).status).toBe(200);
    expect((await api().get("/api/user").set(auth())).body.gender).toBe("Male");
  });

  it("takes identity and address uploads, checks the files and refuses duplicates", async () => {
    expect((await upload(3, 1, [png])).body.errors.document2).toBeDefined();
    expect((await upload(3, 2, [Buffer.from("<html>not a passport</html>")])).status).toBe(422);
    expect((await upload(9, 1, [png])).body.errors.type).toBeDefined();
    const ok = await upload(3, 1, [png, png]);
    expect(ok.status).toBe(201);
    expect((await upload(3, 2, [png])).status).toBe(422);
    expect((await upload(4, 1, [pdf])).status).toBe(201);
    const env_ = (await api().get("/api/kyc").set(auth())).body;
    expect(env_).toMatchObject({ profile_complete: true, overall_status: "pending" });
    expect(env_.identity).toMatchObject({ status: 0, status_label: "Pending", can_submit: false, sub_type: 1, sub_type_label: "ID Card", document1_url: null });
    const stored = await one<{ bytes_enc: Buffer }>(env.db, "SELECT bytes_enc FROM kyc_documents LIMIT 1");
    expect(stored!.bytes_enc.includes(png.subarray(0, 16))).toBe(false);
  });

  it("lets a reviewer open documents and approve or reject with 2FA, all audited", async () => {
    const queue = await reviewer.agent.get("/api/staff/kyc");
    expect(queue.body.total).toBe(2);
    // A sales agent only sees submissions from clients assigned to them.
    expect((await sales.agent.get("/api/staff/kyc")).body.total).toBe(0);
    expect((await post(sales, `/api/staff/kyc/${queue.body.items[0].id}/decision`, { decision: "approve" })).status).toBe(403);
    const identity = queue.body.items.find((i: { category: string }) => i.category === "identity");
    const detail = await reviewer.agent.get(`/api/staff/kyc/${identity.id}`);
    expect(detail.body.files).toHaveLength(2);
    expect(detail.body.profile).toMatchObject({ name: "Kay Doe", dob: "1990-04-02" });
    expect(detail.body.client).toHaveProperty("pictureUrl", null);
    const file = await reviewer.agent.get(detail.body.files[0].url);
    expect(file.headers["content-type"]).toBe("image/png");
    expect(file.headers["content-security-policy"]).toContain("sandbox");
    expect(Buffer.compare(file.body as Buffer, png)).toBe(0);

    expect(detail.body.checklist.map((c: { key: string }) => c.key)).toEqual(ALL.identity);
    expect(detail.body.reasons.length).toBeGreaterThan(3);
    expect(detail.body.queue).toMatchObject({ pending: 2 });
    expect(detail.body.warnings.some((w: { text: string }) => w.text.includes("same file"))).toBe(true);

    expect((await post(reviewer, `/api/staff/kyc/${identity.id}/decision`, { decision: "approve" })).body.error.code).toBe("STEP_UP_REQUIRED");
    await stepUp(env, reviewer);
    await stepUp(env, second);
    // Opening an item claims it; a second reviewer is kept off it and "next" skips it.
    expect((await post(reviewer, `/api/staff/kyc/${identity.id}/claim`, {})).body.claimedBy.name).toBeTruthy();
    expect((await post(second, `/api/staff/kyc/${identity.id}/claim`, {})).status).toBe(409);
    expect((await post(second, `/api/staff/kyc/${identity.id}/decision`, { decision: "reject", reason: "Not readable at all" })).status).toBe(409);
    const nextForSecond = (await post(second, "/api/staff/kyc/next", {})).body.id;
    expect(nextForSecond).not.toBe(identity.id);
    expect(nextForSecond).toBeTruthy();
    expect((await post(second, "/api/staff/kyc/next", { skip: [nextForSecond], release: nextForSecond })).body.id).toBeNull();
    // Approving needs every check ticked.
    expect((await post(reviewer, `/api/staff/kyc/${identity.id}/decision`, { decision: "approve", checklist: ["name"] })).status).toBe(400);
    expect((await post(reviewer, `/api/staff/kyc/${identity.id}/decision`, { decision: "reject" })).status).toBe(400);
    expect((await post(reviewer, `/api/staff/kyc/${identity.id}/decision`, { decision: "reject", reason: "See https://example.com" })).status).toBe(400);
    const rejected = await post(reviewer, `/api/staff/kyc/${identity.id}/decision`, { decision: "reject", reason: "The photo is blurred, please upload a sharper one" });
    expect(rejected.body.status).toBe("rejected");
    expect((await post(reviewer, `/api/staff/kyc/${identity.id}/decision`, { decision: "approve", checklist: ALL.identity })).status).toBe(400);

    const seen = (await api().get("/api/kyc").set(auth())).body;
    expect(seen.identity).toMatchObject({ status: 2, status_label: "Rejected", can_submit: true, message: "The photo is blurred, please upload a sharper one" });
    expect(seen.overall_status).toBe("rejected");

    expect((await upload(3, 2, [png])).status).toBe(201);
    const again = (await reviewer.agent.get("/api/staff/kyc")).body.items;
    for (const item of again) expect((await post(reviewer, `/api/staff/kyc/${item.id}/decision`, { decision: "approve", checklist: ALL[item.category as "identity"] })).status).toBe(200);
    expect((await reviewer.agent.get("/api/staff/kyc/summary")).body).toMatchObject({ pending: 0, decidedTodayByMe: 3 });
    const done = (await api().get("/api/kyc").set(auth())).body;
    expect(done).toMatchObject({ is_kyc_approved: true, overall_status: "approved" });
    const client = await one<{ kyc_status: string; kyc_approved_at: Date | null }>(env.db, "SELECT kyc_status, kyc_approved_at FROM clients WHERE id = ?", [clientId]);
    expect(client).toMatchObject({ kyc_status: "approved" });
    expect(client!.kyc_approved_at).not.toBeNull();
    const actions = await one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM audit_log WHERE action IN ('kyc.approved', 'kyc.rejected', 'kyc.document_viewed', 'kyc.submitted') AND entity_id = ?", [String(clientId)]);
    expect(Number(actions?.n)).toBeGreaterThanOrEqual(7);
  });

  it("tells the client and the support service about every decision", async () => {
    const bell = (await api().get("/api/notifications?per_page=50").set(auth())).body;
    const titles = bell.data.map((n: { title: string }) => n.title);
    expect(titles).toContain("Your proof of identity needs another look");
    expect(bell.data.find((n: { title: string }) => n.title === "Your proof of identity needs another look")).toMatchObject({ type: "kyc", body: "The photo is blurred, please upload a sharper one", link: "/profile", read_at: null });
    expect(bell.unread_count).toBe(bell.data.length);
    const events = (await env.db.query("SELECT event FROM webhook_outbox WHERE client_id = ? ORDER BY id", [clientId]))[0] as { event: string }[];
    expect(events.map((e) => e.event)).toEqual(expect.arrayContaining(["kyc.identity.rejected", "kyc.rejected", "kyc.identity.approved", "kyc.address.approved", "kyc.approved"]));
    expect(events.filter((e) => e.event === "kyc.approved")).toHaveLength(1);
  });

  it("asks for a new document after approval, with 2FA, audited and shown to the client", async () => {
    const approved = (await reviewer.agent.get(`/api/staff/kyc?status=approved`)).body.items.find((i: { category: string }) => i.category === "address");
    expect((await post(sales, `/api/staff/kyc/${approved.id}/request-new`, { reason: "Please send a bill from this year" })).status).toBe(403);
    expect((await post(reviewer, `/api/staff/kyc/${approved.id}/request-new`, { reason: "See www.example.com" })).status).toBe(400);
    const res = await post(reviewer, `/api/staff/kyc/${approved.id}/request-new`, { reason: "Please send a bill from this year" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("rejected");
    expect((await post(reviewer, `/api/staff/kyc/${approved.id}/request-new`, { reason: "Please send a bill from this year" })).status).toBe(400);
    const seen = (await api().get("/api/kyc").set(auth())).body;
    expect(seen).toMatchObject({ is_kyc_approved: false, overall_status: "rejected" });
    expect(seen.address).toMatchObject({ status: 2, can_submit: true, message: "Please send a bill from this year" });
    expect((await api().get("/api/notifications").set(auth())).body.data[0]).toMatchObject({ title: "Please upload a new proof of address", body: "Please send a bill from this year" });
    expect(await one(env.db, "SELECT id FROM audit_log WHERE action = 'kyc.new_document_requested' AND entity_id = ?", [String(clientId)])).toBeTruthy();
    expect(await one(env.db, "SELECT id FROM email_outbox WHERE template = 'kyc_new_document' AND to_email = 'kyc@client.test'")).toBeTruthy();
  });

  it("changes a decision later in either direction, with a reason, 2FA and an audit entry", async () => {
    const all = (await reviewer.agent.get(`/api/staff/kyc?status=all&clientId=${clientId}`)).body.items as { id: number; category: string; status: string }[];
    const address = all.find((i) => i.category === "address")!;
    const identity = all.find((i) => i.category === "identity" && i.status === "approved")!;
    expect(address.status).toBe("rejected");
    expect((await post(sales, `/api/staff/kyc/${address.id}/change`, { status: "approved", reason: "Checked the bill again" })).status).toBe(403);
    expect((await post(reviewer, `/api/staff/kyc/${address.id}/change`, { status: "approved", reason: "ok" })).status).toBe(400);
    expect((await post(reviewer, `/api/staff/kyc/${address.id}/change`, { status: "approved", reason: "Checked the bill again" })).status).toBe(400);
    expect((await post(reviewer, `/api/staff/kyc/${address.id}/change`, { status: "rejected", reason: "Already rejected" })).status).toBe(400);
    const approved = await post(reviewer, `/api/staff/kyc/${address.id}/change`, { status: "approved", reason: "Checked the bill again", checklist: ALL.address });
    expect(approved.status).toBe(200);
    expect((await api().get("/api/kyc").set(auth())).body).toMatchObject({ is_kyc_approved: true, overall_status: "approved" });

    const rejected = await post(reviewer, `/api/staff/kyc/${identity.id}/change`, { status: "rejected", reason: "The passport has expired, please send a valid one" });
    expect(rejected.body.status).toBe("rejected");
    const seen = (await api().get("/api/kyc").set(auth())).body;
    expect(seen).toMatchObject({ is_kyc_approved: false, overall_status: "rejected" });
    expect(seen.identity).toMatchObject({ status: 2, can_submit: true, message: "The passport has expired, please send a valid one" });
    const audit = await one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'kyc.decision_changed' AND entity_id = ?", [String(clientId)]);
    expect(Number(audit?.n)).toBe(2);
  });

  it("lets staff upload documents for a client, which another reviewer must approve", async () => {
    const send = (s: SignedIn, files: Buffer[], extra: Record<string, string> = {}) => {
      let r = s.agent.post("/api/staff/kyc/upload").set("Origin", ORIGIN).set("X-CSRF-Token", s.csrf)
        .field("client_id", String(clientId)).field("type", "3").field("sub_type", "2").field("note", extra.note ?? "Sent by email on 16 October");
      files.forEach((f, i) => (r = r.attach(`document${i + 1}`, f, { filename: "passport.png", contentType: "image/png" })));
      return r;
    };
    expect((await send(sales, [png])).status).toBe(403);
    expect((await send(reviewer, [Buffer.from("<html>nope</html>")])).status).toBe(422);
    expect((await send(reviewer, [png], { note: "x" })).status).toBe(400);
    const res = await send(reviewer, [png]);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "pending", source: "staff", uploadedBy: "comp", documents: 1 });
    expect((await send(reviewer, [png])).status).toBe(400);
    expect((await api().get("/api/kyc").set(auth())).body.identity).toMatchObject({ status: 0, status_label: "Pending" });
    const detail = (await reviewer.agent.get(`/api/staff/kyc/${res.body.id}`)).body;
    expect(detail.warnings.some((w: { text: string }) => w.text.includes("on the client's behalf"))).toBe(true);
    // Four eyes: the uploader cannot approve their own upload.
    expect((await post(reviewer, `/api/staff/kyc/${res.body.id}/decision`, { decision: "approve", checklist: ALL.identity })).status).toBe(403);
    expect((await post(second, `/api/staff/kyc/${res.body.id}/decision`, { decision: "approve", checklist: ALL.identity })).status).toBe(200);
    expect(await one(env.db, "SELECT id FROM audit_log WHERE action = 'kyc.uploaded_by_staff' AND entity_id = ?", [String(clientId)])).toBeTruthy();
  });

  it("approves without documents only with the override permission", async () => {
    const address = ((await reviewer.agent.get(`/api/staff/kyc?status=all&clientId=${clientId}&category=address`)).body.items as { id: number }[])[0]!;
    await post(reviewer, `/api/staff/kyc/${address.id}/change`, { status: "rejected", reason: "Please send a newer statement" });
    const body = { clientId, category: "address", subType: 1, reason: "Verified by video call with compliance" };
    expect((await post(reviewer, "/api/staff/kyc/approve-without-documents", body)).status).toBe(403);
    await stepUp(env, boss);
    expect((await post(boss, "/api/staff/kyc/approve-without-documents", { ...body, subType: 9 })).status).toBe(400);
    const res = await post(boss, "/api/staff/kyc/approve-without-documents", body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "approved", documents: 0, source: "staff", staffNote: "Verified by video call with compliance" });
    expect((await post(boss, "/api/staff/kyc/approve-without-documents", body)).status).toBe(400);
    expect((await api().get("/api/kyc").set(auth())).body).toMatchObject({ is_kyc_approved: true, overall_status: "approved" });
    // Approving a document-less item again after a rejection also needs the override.
    await post(boss, `/api/staff/kyc/${res.body.id}/change`, { status: "rejected", reason: "Please send a bank statement after all" });
    expect((await post(reviewer, `/api/staff/kyc/${res.body.id}/change`, { status: "approved", reason: "Fine after all" })).status).toBe(403);
  });

  it("removes a profile picture when the client asks", async () => {
    await api().post("/api/user/profile-picture").set(auth()).attach("image", png, { filename: "me.png", contentType: "image/png" });
    expect((await api().get("/api/user").set(auth())).body.image_url).toBeTruthy();
    expect((await api().delete("/api/user/profile-picture").set(auth())).status).toBe(200);
    expect((await api().get("/api/user").set(auth())).body.image_url).toBeNull();
  });
});
