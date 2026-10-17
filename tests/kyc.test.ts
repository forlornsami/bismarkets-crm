import { readFileSync } from "node:fs";
import { crc32 } from "node:zlib";
import express from "express";
import sharp from "sharp";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clientErrorMiddleware } from "../src/server/clients/errors";
import { documentType, kycDocumentContext, kycRequired } from "../src/server/clients/kyc";
import { createClientSession } from "../src/server/clients/session";
import { decryptBytes, decryptField, encryptBytes, sha256 } from "../src/server/lib/crypto";
import { exec, one, rows } from "../src/server/lib/db";
import { DocumentProblem, inspectPdf, prepareDocument } from "../src/server/lib/documents";
import { outboxContext } from "../src/server/lib/email";
import { createStaff, hasDb, ORIGIN, patch, post, setup, signIn, stepUp, type SignedIn, type TestEnv } from "./helpers";

const GOOD = "Sunny-Day-42!";
const icon = readFileSync(new URL("../src/admin/public/brand/apple-touch-icon.png", import.meta.url));
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const heic = fixture("photo.heic");
const lockedPdf = fixture("locked.pdf");
const ownerPdf = fixture("owner-password.pdf");
/** A PDF with blank pages; pdf.js rebuilds the missing cross-reference table. */
const pdfOf = (pages: number) => {
  const kids = Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`).join(" ");
  const pageObjects = Array.from({ length: pages }, (_, i) => `${i + 3} 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n`).join("");
  return Buffer.from(`%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[${kids}]/Count ${pages}>>endobj\n${pageObjects}trailer<</Root 1 0 R>>\n%%EOF\n`);
};
const pdf = pdfOf(2);
const brokenPdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
/** Counts two pages, but the second one is missing. */
const missingPagePdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R 9 0 R]/Count 2>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
const UNREADABLE_PDF = "This PDF could not be opened. It may be damaged. Save it again as a PDF, or upload a photo of the document.";
/** A plain photo big enough to read; each colour gives a different file. */
const photo = (background: string, width = 640, height = 440) => sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();
const [front, back, passport, other] = await Promise.all([photo("#336699"), photo("#993366"), photo("#669933"), photo("#cc9900")]);
const HTML = Buffer.from("<html><script>alert(1)</script></html>");
const RULES = "Use a JPG, PNG, WebP or HEIC photo, or a PDF, up to 10 MB.";
const LOCKED = "This was checked with your documents. Contact support to change it.";
/** A document request as the review screen sends it. */
const view = (s: SignedIn, url: string) => s.agent.get(url).set("X-CRM-Viewer", "1");
const ALL = { identity: ["name", "dob", "valid", "clear"], address: ["name", "address", "recent", "clear"] };
const PROFILE = { phone: "7700900123", countryCode: "44", country: "United Kingdom", city: "London", address: "1 Baker St", zipcode: "W1A 1AA", dob: "1990-04-02", gender: "Female" };

describe("document sniffing", () => {
  it("accepts images and PDFs only", () => {
    expect(documentType(front)).toBe("image/png");
    expect(documentType(pdf)).toBe("application/pdf");
    expect(documentType(heic)).toBe("image/heic");
    expect(documentType(HTML)).toBeNull();
  });
});

describe("document handling", () => {
  const problem = (work: Promise<unknown>) => work.then(() => null, (e: unknown) => (e instanceof DocumentProblem ? e.message : `unexpected: ${String(e)}`));

  it("re-encodes photos, dropping EXIF and location and applying the rotation", async () => {
    const jpeg = await sharp({ create: { width: 800, height: 500, channels: 3, background: "#3366aa" } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .withExifMerge({ IFD0: { Make: "PhoneMaker" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "51/1 30/1 0/1" } })
      .toBuffer();
    expect((await sharp(jpeg).metadata()).exif).toBeDefined();
    const out = await prepareDocument(jpeg, "image/jpeg");
    expect(out.pages).toBe(1);
    expect(out.mime).toBe("image/jpeg");
    const meta = await sharp(out.bytes).metadata();
    expect(meta).toMatchObject({ format: "jpeg", width: 500, height: 800 });
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    expect(out.bytes.includes("PhoneMaker")).toBe(false);
  });

  it("turns an iPhone HEIC photo into a JPEG", async () => {
    const out = await prepareDocument(heic, "image/heic");
    expect(out.mime).toBe("image/jpeg");
    expect(documentType(out.bytes)).toBe("image/jpeg");
    expect(await sharp(out.bytes).metadata()).toMatchObject({ width: 480, height: 400 });
  });

  it("refuses photos too small to read, too large to process or broken", async () => {
    expect(await problem(prepareDocument(await photo("#000000", 300, 900), "image/png"))).toBe("This photo is too small to read. Take it closer or use a scan.");
    // A tiny file whose header claims 10000 x 10000 pixels: refused before anything is decoded.
    const bomb = Buffer.from(await photo("#000000", 10, 10));
    bomb.writeUInt32BE(10_000, 16);
    bomb.writeUInt32BE(10_000, 20);
    bomb.writeUInt32BE(crc32(bomb.subarray(12, 29)), 29);
    expect(await problem(prepareDocument(bomb, "image/png"))).toBe("This photo is too large to process. Use a photo under 50 megapixels or a scan.");
    const junk = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(100)]);
    expect(await problem(prepareDocument(junk, "image/jpeg"))).toBe(`This photo could not be opened. ${RULES}`);
  });

  it("refuses PDFs that need a password, are damaged or are too long, but keeps ones with only owner restrictions", async () => {
    expect(await problem(prepareDocument(lockedPdf, "application/pdf"))).toBe("Remove the password from the PDF and upload it again.");
    expect(await prepareDocument(ownerPdf, "application/pdf")).toMatchObject({ bytes: ownerPdf, pages: 1 });
    // Pages are counted so approving can require every one.
    expect(await prepareDocument(pdf, "application/pdf")).toMatchObject({ bytes: pdf, pages: 2 });
    expect(await prepareDocument(pdfOf(20), "application/pdf")).toMatchObject({ pages: 20 });
    // Every document is read inside the CRM, so one the review screen could not show is refused.
    expect(await problem(prepareDocument(brokenPdf, "application/pdf"))).toBe(UNREADABLE_PDF);
    expect(await problem(prepareDocument(missingPagePdf, "application/pdf"))).toBe(UNREADABLE_PDF);
    expect(await problem(prepareDocument(pdfOf(21), "application/pdf"))).toBe("This PDF has 21 pages, and the most we accept is 20. Upload only the pages that show your details.");
  });

  it("reads PDFs off the main thread and gives up on one that would hang it", async () => {
    // A cross-reference stream with no entry widths and a huge range keeps pdf.js busy for minutes.
    const hang = Buffer.from("%PDF-1.5\n1 0 obj<</Type/XRef/Size 2000000000/W[0 0 0]/Index[0 2000000000]/Root 2 0 R/Length 0>>stream\n\nendstream\nendobj\nstartxref\n9\n%%EOF\n");
    let ticks = 0;
    const timer = setInterval(() => ticks++, 50);
    const started = Date.now();
    expect(await inspectPdf(hang, 1000)).toEqual({ needsPassword: false, pages: null, brokenPage: false });
    clearInterval(timer);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(ticks).toBeGreaterThan(10);
  });
});

describe("KYC gate", () => {
  it("answers money, account and IB routes with the exact text the app looks for", async () => {
    const app = express();
    app.get("/gated", () => {
      throw kycRequired();
    });
    app.use(clientErrorMiddleware({ error: () => undefined }));
    const res = await request(app).get("/gated");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ message: "You must complete your KYC first." });
  });
});

describe.skipIf(!hasDb)("KYC", () => {
  let env: TestEnv;
  let reviewer: SignedIn;
  let second: SignedIn;
  let sales: SignedIn;
  let salesManager: SignedIn;
  let support: SignedIn;
  let scoped: SignedIn;
  let boss: SignedIn;
  let token: string;
  let clientId: number;
  const api = () => request(env.app);
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const auth = () => bearer(token);
  const fileInfo = (f: Buffer) => {
    const type = documentType(f);
    return { filename: type === "application/pdf" ? "doc.pdf" : type === "image/heic" ? "photo.heic" : "doc.png", contentType: type ?? "text/html" };
  };
  const upload = (type: number, subType: number, files: Buffer[], t = token) => {
    let r = api().post("/api/kyc").set(bearer(t)).field("type", String(type)).field("sub_type", String(subType));
    files.forEach((f, i) => (r = r.attach(`document${i + 1}`, f, fileInfo(f))));
    return r;
  };
  const withdraw = (type: number, t = token) => api().post("/api/kyc/withdraw").set(bearer(t)).send({ type });
  const warnings = async (s: SignedIn, submissionId: number) => ((await s.agent.get(`/api/staff/kyc/${submissionId}`)).body.warnings as { text: string }[]).map((w) => w.text);

  async function register(email: string, first = "Kay", last = "Doe") {
    await api().post("/api/send-otp").send({ email });
    const row = await one<{ body_enc: Buffer; template: string }>(env.db, "SELECT body_enc, template FROM email_outbox WHERE to_email = ? ORDER BY id DESC LIMIT 1", [email]);
    const code = /code is (\d{6})/.exec(decryptField(env.config.dataKey, row!.body_enc, outboxContext(email, row!.template)))![1];
    const res = await api().post("/api/register").send({ first_name: first, last_name: last, email, password: GOOD, password_confirmation: GOOD, verification_code: code });
    return { token: res.body.token as string, id: res.body.user.id as number };
  }

  /** Opens the submission and every page of it, as a reviewer must before approving. */
  async function openAll(s: SignedIn, submissionId: number) {
    const detail = (await s.agent.get(`/api/staff/kyc/${submissionId}`)).body;
    for (const f of detail.files) {
      expect((await view(s, f.url)).status).toBe(200);
      if (f.type === "application/pdf") for (let page = 1; page <= f.pages; page++) expect((await post(s, `/api/staff/kyc/documents/${f.id}/pages`, { page })).status).toBe(204);
    }
    return detail as { checklist: { key: string }[] };
  }
  async function approve(s: SignedIn, submissionId: number) {
    const detail = await openAll(s, submissionId);
    return post(s, `/api/staff/kyc/${submissionId}/decision`, { decision: "approve", checklist: detail.checklist.map((c) => c.key) });
  }
  const kycEvents = async (id: number) =>
    ((await env.db.query("SELECT event FROM webhook_outbox WHERE client_id = ? AND event LIKE 'kyc.%' ORDER BY id", [id]))[0] as { event: string }[]).map((e) => e.event);

  beforeAll(async () => {
    env = await setup();
    // A reviewer who sees only the clients assigned to them.
    await exec(env.db, "INSERT INTO roles (slug, name) VALUES ('kyc_scoped', 'Scoped reviewer')");
    await exec(
      env.db,
      "INSERT INTO role_permissions (role_id, permission) SELECT r.id, p.name FROM roles r JOIN (SELECT 'kyc.view' AS name UNION SELECT 'kyc.documents' UNION SELECT 'client.view') p WHERE r.slug = 'kyc_scoped'",
    );
    const staff = [
      ["comp@bis.test", "compliance"], ["comp2@bis.test", "compliance"], ["sales@bis.test", "sales_agent"], ["salesboss@bis.test", "sales_manager"],
      ["support@bis.test", "support_agent"], ["scoped@bis.test", "kyc_scoped"], ["boss@bis.test", "super_admin"],
    ];
    for (const [email, role] of staff) await createStaff(env.db, email!, role!);
    reviewer = await signIn(env, "comp@bis.test");
    second = await signIn(env, "comp2@bis.test");
    sales = await signIn(env, "sales@bis.test");
    salesManager = await signIn(env, "salesboss@bis.test");
    support = await signIn(env, "support@bis.test");
    scoped = await signIn(env, "scoped@bis.test");
    boss = await signIn(env, "boss@bis.test");
    ({ token, id: clientId } = await register("kyc@client.test"));
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
    expect(res.body).toMatchObject({ success: true, email_verified: true, profile_complete: false, is_kyc_approved: false, overall_status: "not_submitted", locked_profile_fields: [] });
    expect(res.body.missing_profile_fields).toContain("dob");
    expect(res.body.missing_profile_fields).not.toContain("zipcode");
    expect(res.body.identity).toMatchObject({ type: 3, status: null, status_label: "Not submitted", can_submit: true, can_withdraw: false });
    const refused = await upload(3, 2, [passport]);
    expect(refused.status).toBe(422);
    expect(refused.body.missing_profile_fields).toEqual(res.body.missing_profile_fields);
    expect(refused.body.errors.profile[0]).toMatch(/^Please add your .+ to your profile before uploading documents\.$/);
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
    expect((await upload(3, 1, [front])).body.errors.document2).toEqual(["Attach both the front and the back."]);
    const html = await upload(3, 2, [HTML]);
    expect(html.status).toBe(422);
    expect(html.body.errors.document1).toEqual([RULES]);
    expect((await upload(3, 2, [lockedPdf])).body.errors.document1).toEqual(["Remove the password from the PDF and upload it again."]);
    expect((await upload(3, 2, [brokenPdf])).body.errors.document1).toEqual([UNREADABLE_PDF]);
    expect((await upload(3, 2, [await photo("#000000", 300, 300)])).body.errors.document1).toEqual(["This photo is too small to read. Take it closer or use a scan."]);
    expect((await upload(9, 1, [front])).body.errors.type).toBeDefined();
    expect((await upload(3, 1, [front, back])).status).toBe(201);
    // A retry after a timeout repeats the upload that already got through: accepted, stored once.
    expect((await upload(3, 1, [front, back])).status).toBe(201);
    const twice = await upload(3, 2, [passport]);
    expect(twice.status).toBe(422);
    expect(twice.body).toEqual({ message: "This document is already under review.", errors: { document1: ["This document is already under review."] } });
    // Refused before the photo is processed, so the client is told what matters.
    expect((await upload(3, 2, [await photo("#000000", 300, 300)])).body.errors.document1).toEqual(["This document is already under review."]);
    expect((await upload(4, 1, [pdf])).status).toBe(201);
    expect(Number((await one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM kyc_submissions WHERE client_id = ?", [clientId]))!.n)).toBe(2);

    const seen = (await api().get("/api/kyc").set(auth())).body;
    expect(seen).toMatchObject({ profile_complete: true, overall_status: "pending", locked_profile_fields: ["first_name", "last_name", "dob", "country", "city", "address", "zipcode"] });
    expect(seen.identity).toMatchObject({ status: 0, status_label: "Pending", can_submit: false, can_withdraw: true, sub_type: 1, sub_type_label: "ID Card", document1_url: null });

    // Stored encrypted and re-encoded, with the hash of each file as sent and a copy of the profile it is checked against.
    const stored = await rows<{ bytes_enc: Buffer; sha256: string; snapshot: Buffer | null }>(
      env.db,
      "SELECT d.bytes_enc, d.sha256, s.profile_snapshot_enc AS snapshot FROM kyc_documents d JOIN kyc_submissions s ON s.id = d.submission_id WHERE s.client_id = ? ORDER BY d.id",
      [clientId],
    );
    expect(stored[0]!.bytes_enc.includes(front.subarray(0, 16))).toBe(false);
    expect(stored.map((d) => d.sha256)).toEqual([sha256(front), sha256(back), sha256(pdf)]);
    expect(stored.every((d) => d.snapshot !== null)).toBe(true);

    // The client is told in the app that it arrived; no email for that.
    const bell = (await api().get("/api/notifications?per_page=50").set(auth())).body.data as { title: string; body: string }[];
    expect(bell.filter((n) => n.title === "We received your proof of identity")).toEqual([expect.objectContaining({ body: "We will check it and let you know the result here." })]);
    expect(bell.map((n) => n.title)).toContain("We received your proof of address");
    expect(await one(env.db, "SELECT id FROM email_outbox WHERE to_email = 'kyc@client.test' AND template LIKE 'kyc%'")).toBeUndefined();
  });

  it("shows documents only to staff allowed to open them", async () => {
    const queue = (await reviewer.agent.get("/api/staff/kyc")).body;
    expect(queue.total).toBe(2);
    const identity = queue.items.find((i: { category: string }) => i.category === "identity");
    const docId = (await one<{ id: number }>(env.db, "SELECT id FROM kyc_documents WHERE submission_id = ? LIMIT 1", [identity.id]))!.id;
    // A sales agent only sees submissions from clients assigned to them, and never opens documents.
    expect((await sales.agent.get("/api/staff/kyc")).body.total).toBe(0);
    expect((await sales.agent.get(`/api/staff/kyc/${identity.id}`)).status).toBe(403);
    // Support sees the queue and the status, not the documents or the details checked against them.
    expect((await support.agent.get("/api/staff/kyc")).body.total).toBe(2);
    expect((await support.agent.get(`/api/staff/kyc/${identity.id}`)).status).toBe(403);
    expect((await support.agent.get(`/api/staff/kyc/documents/${docId}`)).status).toBe(403);
    expect((await post(support, "/api/staff/kyc/next", {})).status).toBe(403);
    // A reviewer limited to their own clients cannot open other clients' documents.
    expect((await scoped.agent.get(`/api/staff/kyc/${identity.id}`)).status).toBe(404);
    expect((await view(scoped, `/api/staff/kyc/documents/${docId}`)).status).toBe(404);
    expect(await one(env.db, "SELECT id FROM audit_log WHERE action = 'kyc.document_viewed'")).toBeUndefined();
  });

  it("lets a reviewer open documents and approve or reject with 2FA, all audited", async () => {
    const queue = (await reviewer.agent.get("/api/staff/kyc")).body;
    const identity = queue.items.find((i: { category: string }) => i.category === "identity");
    const address = queue.items.find((i: { category: string }) => i.category === "address");
    expect((await post(sales, `/api/staff/kyc/${identity.id}/decision`, { decision: "approve" })).status).toBe(403);
    const detail = (await reviewer.agent.get(`/api/staff/kyc/${identity.id}`)).body;
    expect(detail.files.map((f: { viewedByMe: boolean }) => f.viewedByMe)).toEqual([false, false]);
    expect(detail.profile).toMatchObject({ name: "Kay Doe", dob: "1990-04-02", city: "London" });
    expect(detail.profile).not.toHaveProperty("phone");
    expect(detail.profile).not.toHaveProperty("phoneCode");
    expect(detail.client).toHaveProperty("pictureUrl", null);
    expect(detail).toMatchObject({ isLatest: true, mayApprove: true, approveBlockedReason: null });
    expect(detail.other).toMatchObject({ id: address.id, category: "address", status: "pending", documentType: "Bank Statement", documents: 1, decidedAt: null });
    expect(detail.other.files).toHaveLength(1);
    expect(detail.trail).toEqual([expect.objectContaining({ action: "submitted", label: "Sent by the client", staff: null, reason: null, internalNote: null })]);
    expect(detail.checklist.map((c: { key: string }) => c.key)).toEqual(ALL.identity);
    expect(detail.reasons.length).toBeGreaterThan(3);
    expect(detail.queue).toMatchObject({ pending: 2 });

    const file = await view(reviewer, detail.files[0].url);
    expect(file.headers["content-type"]).toBe("image/png");
    expect(file.headers["content-security-policy"]).toContain("sandbox");
    expect(file.headers["content-disposition"]).toBe("inline");
    expect(file.headers["x-content-type-options"]).toBe("nosniff");
    expect(await sharp(file.body as Buffer).metadata()).toMatchObject({ format: "png", width: 640, height: 440 });
    // Files are only for the review screen to draw: never sent as a download, and refused to a link, image or tab.
    const bill = await view(reviewer, detail.other.files[0].url);
    expect(bill.headers["content-type"]).toBe("application/pdf");
    expect(bill.headers["content-disposition"]).toBe("inline");
    expect(bill.headers["content-security-policy"]).toContain("sandbox");
    expect(bill.headers["x-content-type-options"]).toBe("nosniff");
    const opened = await reviewer.agent.get(detail.files[1].url).set("Sec-Fetch-Dest", "empty").set("Sec-Fetch-Mode", "navigate");
    expect(opened.status).toBe(403);
    expect(opened.body.error.message).toBe("Open KYC documents from the review screen. If it is already open, reload it.");
    expect(detail.reasons).toContain(detail.unreadableReason);
    expect(detail.other.files[0]).toMatchObject({ pages: 2, viewedByMe: false, viewedPages: [] });
    expect(detail.files[0]).toMatchObject({ pages: 1 });
    expect(detail.files[0]).not.toHaveProperty("viewedPages");

    expect((await post(reviewer, `/api/staff/kyc/${identity.id}/decision`, { decision: "approve" })).body.error.code).toBe("STEP_UP_REQUIRED");
    await stepUp(env, reviewer);
    await stepUp(env, second);
    // Claiming keeps a second reviewer off the item, "next" skips it, and the client can no longer take it back.
    expect((await post(reviewer, `/api/staff/kyc/${identity.id}/claim`, {})).body.claimedBy.name).toBeTruthy();
    expect((await post(second, `/api/staff/kyc/${identity.id}/claim`, {})).status).toBe(409);
    expect((await post(second, `/api/staff/kyc/${identity.id}/decision`, { decision: "reject", reason: "Not readable at all" })).status).toBe(409);
    expect((await api().get("/api/kyc").set(auth())).body.identity.can_withdraw).toBe(false);
    const nextForSecond = (await post(second, "/api/staff/kyc/next", {})).body.id;
    expect(nextForSecond).toBe(address.id);
    expect((await post(second, "/api/staff/kyc/next", { skip: [nextForSecond], release: nextForSecond })).body.id).toBeNull();

    // Approving needs every check ticked and every page opened by this reviewer.
    expect((await post(reviewer, `/api/staff/kyc/${identity.id}/decision`, { decision: "approve", checklist: ["name"] })).status).toBe(400);
    const unopened = await post(reviewer, `/api/staff/kyc/${identity.id}/decision`, { decision: "approve", checklist: ALL.identity });
    expect(unopened.status).toBe(400);
    expect(unopened.body.error.message).toBe("Open every page of the document before approving.");
    expect((await reviewer.agent.get(`/api/staff/kyc/${identity.id}`)).body.files.map((f: { viewedByMe: boolean }) => f.viewedByMe)).toEqual([true, false]);

    expect((await post(reviewer, `/api/staff/kyc/${identity.id}/decision`, { decision: "reject" })).status).toBe(400);
    expect((await post(reviewer, `/api/staff/kyc/${identity.id}/decision`, { decision: "reject", reason: "See https://example.com" })).status).toBe(400);
    expect((await post(reviewer, `/api/staff/kyc/${identity.id}/decision`, { decision: "reject", reason: "Too blurry to read", internalNote: "<b>no</b>" })).status).toBe(400);
    const rejected = await post(reviewer, `/api/staff/kyc/${identity.id}/decision`, {
      decision: "reject", reason: "The photo is blurred, please upload a sharper one", internalNote: "Corners cut off on the back as well",
    });
    expect(rejected.body.status).toBe("rejected");
    expect((await post(reviewer, `/api/staff/kyc/${identity.id}/decision`, { decision: "approve", checklist: ALL.identity })).status).toBe(400);

    const seen = (await api().get("/api/kyc").set(auth())).body;
    expect(seen.identity).toMatchObject({ status: 2, status_label: "Rejected", can_submit: true, can_withdraw: false, message: "The photo is blurred, please upload a sharper one" });
    expect(seen.overall_status).toBe("rejected");
    // A rejected proof of identity frees the name and date of birth again; the pending address keeps its fields.
    expect(seen.locked_profile_fields).toEqual(["country", "city", "address", "zipcode"]);

    // The client sends the rejected photo again, as a passport this time.
    expect((await upload(3, 2, [front])).status).toBe(201);
    const resent = (await reviewer.agent.get("/api/staff/kyc")).body.items.find((i: { category: string }) => i.category === "identity");
    const resentDetail = (await reviewer.agent.get(`/api/staff/kyc/${resent.id}`)).body;
    expect(resentDetail.warnings.map((w: { text: string }) => w.text)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^The client sent the same file that was rejected on \d{1,2} [A-Z][a-z]+ \d{4}\.$/), "1 earlier attempt was rejected. See the history below."]),
    );
    expect(resentDetail.history).toEqual([expect.objectContaining({ id: identity.id, status: "rejected", newer: false })]);
    const earlier = (await reviewer.agent.get(`/api/staff/kyc/${identity.id}`)).body;
    expect(earlier).toMatchObject({ isLatest: false, mayApprove: false, approveBlockedReason: "The client has a newer submission for this. Change that one instead." });
    expect(earlier.history[0]).toMatchObject({ id: resent.id, newer: true });
    expect(earlier.trail.map((t: { action: string }) => t.action)).toEqual(["submitted", "rejected"]);
    expect(earlier.trail[1]).toMatchObject({
      label: "Rejected", staff: "comp", reason: "The photo is blurred, please upload a sharper one", internalNote: "Corners cut off on the back as well",
    });

    // A PDF counts as opened once the review screen drew every page of it, or the reviewer downloaded it.
    const billFile = (s: SignedIn) => s.agent.get(`/api/staff/kyc/${address.id}`).then((r) => r.body.files[0] as { id: number; url: string; viewedByMe: boolean; viewedPages: number[] });
    const billId = (await billFile(reviewer)).id;
    const page = (s: SignedIn, n: unknown, docId = billId) => post(s, `/api/staff/kyc/documents/${docId}/pages`, { page: n });
    expect((await page(second, 1)).body.error.message).toBe("Open the document first.");
    expect((await page(support, 1)).status).toBe(403);
    expect((await page(reviewer, 3)).body.error.message).toBe("That page is not part of this document.");
    expect((await page(reviewer, 0)).status).toBe(400);
    expect((await page(reviewer, 1, detail.files[0].id)).body.error.message).toBe("That page is not part of this document.");
    expect((await page(reviewer, 1)).status).toBe(204);
    expect((await page(reviewer, 1)).status).toBe(204);
    expect(await billFile(reviewer)).toMatchObject({ viewedByMe: false, viewedPages: [1] });
    const halfRead = await post(reviewer, `/api/staff/kyc/${address.id}/decision`, { decision: "approve", checklist: ALL.address });
    expect(halfRead.body.error.message).toBe("Open every page of the document before approving.");
    expect((await page(reviewer, 2)).status).toBe(204);
    expect(await billFile(reviewer)).toMatchObject({ viewedByMe: true, viewedPages: [1, 2] });
    // Each page is recorded once, and kept out of the client's activity list.
    const pageViews = await one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'kyc.document_page_viewed' AND entity_id = ?", [String(clientId)]);
    expect(Number(pageViews!.n)).toBe(2);
    expect((await reviewer.agent.get(`/api/staff/clients/${clientId}/activity`)).body.items.some((a: { action: string }) => a.action === "kyc.document_page_viewed")).toBe(false);
    // Saving the original is its own permission, with a fresh 2FA code, and recorded on its own. It never counts as reviewing.
    const billUrl = (await billFile(boss)).url;
    expect((await view(support, `${billUrl}/download`)).status).toBe(403);
    // Reviewers do not download by default, compliance included: only a Super Admin, or a role a Super Admin gave it to.
    expect((await view(scoped, `${billUrl}/download`)).body.error.code).toBe("FORBIDDEN");
    expect((await view(reviewer, `${billUrl}/download`)).body.error.code).toBe("FORBIDDEN");
    expect((await view(boss, `${billUrl}/download`)).body.error.code).toBe("STEP_UP_REQUIRED");
    await stepUp(env, boss);
    expect((await boss.agent.get(`${billUrl}/download`)).status).toBe(403);
    const saved = await view(boss, `${billUrl}/download`);
    expect(saved.status).toBe(200);
    expect(saved.headers["content-disposition"]).toBe(`attachment; filename="client-${clientId}-address-1.pdf"`);
    expect(Buffer.compare(saved.body as Buffer, pdf)).toBe(0);
    expect(await billFile(boss)).toMatchObject({ viewedByMe: false, viewedPages: [] });
    const downloads = await rows<{ actor_id: number; meta_json: { documentId: number } }>(env.db, "SELECT actor_id, meta_json FROM audit_log WHERE action = 'kyc.document_downloaded' AND entity_id = ?", [String(clientId)]);
    expect(downloads).toEqual([expect.objectContaining({ actor_id: boss.staffId, meta_json: expect.objectContaining({ documentId: billId }) })]);

    for (const item of (await reviewer.agent.get("/api/staff/kyc")).body.items) expect((await approve(reviewer, item.id)).status).toBe(200);
    expect((await reviewer.agent.get("/api/staff/kyc/summary")).body).toMatchObject({ pending: 0, decidedTodayByMe: 3 });
    const done = (await api().get("/api/kyc").set(auth())).body;
    expect(done).toMatchObject({ is_kyc_approved: true, overall_status: "approved" });
    expect(done.locked_profile_fields).toHaveLength(7);
    const client = await one<{ kyc_status: string; kyc_approved_at: Date | null }>(env.db, "SELECT kyc_status, kyc_approved_at FROM clients WHERE id = ?", [clientId]);
    expect(client).toMatchObject({ kyc_status: "approved" });
    expect(client!.kyc_approved_at).not.toBeNull();
    const actions = await one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM audit_log WHERE action IN ('kyc.approved', 'kyc.rejected', 'kyc.document_viewed', 'kyc.submitted') AND entity_id = ?", [String(clientId)]);
    expect(Number(actions?.n)).toBeGreaterThanOrEqual(7);
  });

  it("tells the client what comes next, and the support service once per decision", async () => {
    const bell = (await api().get("/api/notifications?per_page=50").set(auth())).body;
    const titled = (title: string) => bell.data.filter((n: { title: string }) => n.title === title);
    expect(titled("Your proof of identity needs another look")).toEqual([
      expect.objectContaining({ type: "kyc", body: "The photo is blurred, please upload a sharper one", link: "/profile", read_at: null }),
    ]);
    expect(titled("Your proof of address is approved")).toEqual([expect.objectContaining({ body: "We will let you know when your proof of identity is checked." })]);
    expect(titled("Your proof of identity is approved")).toEqual([expect.objectContaining({ body: "Your account is now fully verified." })]);
    expect(titled("We received your proof of identity")).toHaveLength(2);
    expect(bell.unread_count).toBe(bell.data.length);
    // One push per decision: the overall result when it changes, otherwise the document's own.
    expect(await kycEvents(clientId)).toEqual(["kyc.rejected", "kyc.address.approved", "kyc.approved"]);
    const mails = await rows<{ template: string; subject: string; body_text: string }>(env.db, "SELECT template, subject, body_text FROM email_outbox WHERE to_email = 'kyc@client.test' AND template LIKE 'kyc%' ORDER BY id");
    expect(mails.map((m) => m.template)).toEqual(["kyc_rejected", "kyc_approved", "kyc_approved"]);
    expect(mails[1]).toMatchObject({ subject: "Your proof of address is approved" });
    expect(mails[1]!.body_text).toContain("Your proof of address has been approved. We will let you know when your proof of identity is checked.");
    expect(mails[2]!.body_text).toContain("Your account is now fully verified.");
  });

  it("asks for a new document after approval, with 2FA, audited and shown to the client", async () => {
    const approved = (await reviewer.agent.get(`/api/staff/kyc?status=approved`)).body.items.find((i: { category: string }) => i.category === "address");
    expect((await post(sales, `/api/staff/kyc/${approved.id}/request-new`, { reason: "Please send a bill from this year" })).status).toBe(403);
    expect((await post(reviewer, `/api/staff/kyc/${approved.id}/request-new`, { reason: "See www.example.com" })).status).toBe(400);
    const res = await post(reviewer, `/api/staff/kyc/${approved.id}/request-new`, { reason: "Please send a bill from this year", internalNote: "The statement is from 2024" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("rejected");
    expect((await post(reviewer, `/api/staff/kyc/${approved.id}/request-new`, { reason: "Please send a bill from this year" })).status).toBe(400);
    const seen = (await api().get("/api/kyc").set(auth())).body;
    expect(seen).toMatchObject({ is_kyc_approved: false, overall_status: "rejected", locked_profile_fields: ["first_name", "last_name", "dob"] });
    expect(seen.address).toMatchObject({ status: 2, can_submit: true, message: "Please send a bill from this year" });
    expect((await api().get("/api/notifications").set(auth())).body.data[0]).toMatchObject({ title: "Please upload a new proof of address", body: "Please send a bill from this year" });
    expect(await one(env.db, "SELECT id FROM audit_log WHERE action = 'kyc.new_document_requested' AND entity_id = ?", [String(clientId)])).toBeTruthy();
    expect(await one(env.db, "SELECT id FROM email_outbox WHERE template = 'kyc_new_document' AND to_email = 'kyc@client.test'")).toBeTruthy();
    expect((await kycEvents(clientId)).at(-1)).toBe("kyc.rejected");
    const trail = (await reviewer.agent.get(`/api/staff/kyc/${approved.id}`)).body.trail;
    expect(trail.at(-1)).toMatchObject({ action: "new_document_requested", label: "New document requested", staff: "comp", reason: "Please send a bill from this year", internalNote: "The statement is from 2024" });
  });

  it("approves a rejected document on a second look, but never takes an approval back through a change", async () => {
    const all = (await reviewer.agent.get(`/api/staff/kyc?status=all&clientId=${clientId}`)).body.items as { id: number; category: string; status: string }[];
    const address = all.find((i) => i.category === "address")!;
    const identity = all.find((i) => i.category === "identity" && i.status === "approved")!;
    const oldIdentity = all.find((i) => i.category === "identity" && i.status === "rejected")!;
    expect(address.status).toBe("rejected");
    expect((await post(sales, `/api/staff/kyc/${address.id}/change`, { status: "approved", reason: "Checked the bill again" })).status).toBe(403);
    expect((await post(reviewer, `/api/staff/kyc/${address.id}/change`, { status: "approved", reason: "ok" })).status).toBe(400);
    expect((await post(reviewer, `/api/staff/kyc/${address.id}/change`, { status: "approved", reason: "Checked the bill again" })).body.error.message).toBe("Tick every check before approving.");
    const takeBack = await post(reviewer, `/api/staff/kyc/${identity.id}/change`, { status: "rejected", reason: "The passport has expired, please send a valid one" });
    expect(takeBack.status).toBe(400);
    expect(takeBack.body.error.message).toContain("Ask for a new document");
    expect((await post(reviewer, `/api/staff/kyc/${identity.id}/change`, { status: "rejected" })).body.error.message).toBe(takeBack.body.error.message);
    const stale = await post(reviewer, `/api/staff/kyc/${oldIdentity.id}/change`, { status: "approved", reason: "It was readable after all", checklist: ALL.identity });
    expect(stale.body.error.message).toBe("The client has a newer submission for this. Change that one instead.");
    // A reviewer who never opened the bill cannot approve it.
    const unseen = await post(second, `/api/staff/kyc/${address.id}/change`, { status: "approved", reason: "Checked the bill again", checklist: ALL.address });
    expect(unseen.body.error.message).toBe("Open every page of the document before approving.");
    const approved = await post(reviewer, `/api/staff/kyc/${address.id}/change`, { status: "approved", reason: "Checked the bill again", checklist: ALL.address, internalNote: "Spoke to the client" });
    expect(approved.status).toBe(200);
    expect((await api().get("/api/kyc").set(auth())).body).toMatchObject({ is_kyc_approved: true, overall_status: "approved" });
    const trail = (await reviewer.agent.get(`/api/staff/kyc/${address.id}`)).body.trail;
    expect(trail.map((t: { action: string }) => t.action)).toEqual(["submitted", "approved", "new_document_requested", "decision_changed"]);
    expect(trail.at(-1)).toMatchObject({ label: "Decision changed from rejected to approved", staff: "comp", reason: "Checked the bill again", internalNote: "Spoke to the client" });
    const audit = await one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'kyc.decision_changed' AND entity_id = ?", [String(clientId)]);
    expect(Number(audit?.n)).toBe(1);
    expect((await kycEvents(clientId)).at(-1)).toBe("kyc.approved");
  });

  it("lets staff upload documents for a client, which another reviewer must approve", async () => {
    const send = (s: SignedIn, files: Buffer[], extra: Record<string, string> = {}) => {
      let r = s.agent.post("/api/staff/kyc/upload").set("Origin", ORIGIN).set("X-CSRF-Token", s.csrf)
        .field("client_id", String(clientId)).field("type", "3").field("sub_type", "2").field("note", extra.note ?? "Sent by email on 16 October");
      files.forEach((f, i) => (r = r.attach(`document${i + 1}`, f, { filename: "passport.png", contentType: "image/png" })));
      return r;
    };
    expect((await send(sales, [passport])).status).toBe(403);
    expect((await send(reviewer, [HTML])).status).toBe(422);
    expect((await send(reviewer, [passport], { note: "x" })).status).toBe(400);
    const blocked = await send(reviewer, [passport]);
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.message).toBe("This is already approved. Ask for a new document first if it needs replacing.");
    const identity = (await reviewer.agent.get(`/api/staff/kyc?status=approved&clientId=${clientId}&category=identity`)).body.items[0];
    expect((await post(reviewer, `/api/staff/kyc/${identity.id}/request-new`, { reason: "The passport has expired, please send a valid one" })).status).toBe(200);

    const res = await send(reviewer, [passport]);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "pending", source: "staff", uploadedBy: "comp", documents: 1 });
    expect((await send(reviewer, [passport])).status).toBe(400);
    expect((await api().get("/api/kyc").set(auth())).body.identity).toMatchObject({ status: 0, status_label: "Pending", can_withdraw: false });
    const taken = await withdraw(3);
    expect(taken.status).toBe(422);
    expect(taken.body.errors.type).toEqual(["Our team added this document for you. Please contact support to change it."]);
    expect((await one<{ s: Buffer | null }>(env.db, "SELECT profile_snapshot_enc AS s FROM kyc_submissions WHERE id = ?", [res.body.id]))!.s).not.toBeNull();

    const detail = (await reviewer.agent.get(`/api/staff/kyc/${res.body.id}`)).body;
    expect(detail.warnings.some((w: { text: string }) => w.text.includes("on the client's behalf"))).toBe(true);
    expect(detail).toMatchObject({ mayApprove: false, uploadedByMe: true, approveBlockedReason: "You uploaded these documents, so another reviewer must approve them." });
    expect(detail.client.status).toBe("active");
    expect((await second.agent.get(`/api/staff/kyc/${res.body.id}`)).body.uploadedByMe).toBe(false);
    expect(detail.trail).toEqual([expect.objectContaining({ action: "uploaded_by_staff", label: "Uploaded by staff for the client", staff: "comp", reason: "Sent by email on 16 October" })]);
    // Four eyes: the uploader cannot approve their own upload, and "next" never hands it to them.
    await openAll(reviewer, res.body.id);
    expect((await post(reviewer, `/api/staff/kyc/${res.body.id}/decision`, { decision: "approve", checklist: ALL.identity })).status).toBe(403);
    expect((await post(reviewer, "/api/staff/kyc/next", {})).body.id).toBeNull();
    expect((await post(second, "/api/staff/kyc/next", {})).body.id).toBe(res.body.id);
    await stepUp(env, second);
    expect((await approve(second, res.body.id)).status).toBe(200);
    expect(await one(env.db, "SELECT id FROM audit_log WHERE action = 'kyc.uploaded_by_staff' AND entity_id = ?", [String(clientId)])).toBeTruthy();
  });

  it("approves without documents only with the override permission", async () => {
    const address = (await reviewer.agent.get(`/api/staff/kyc?status=approved&clientId=${clientId}&category=address`)).body.items[0];
    expect((await post(reviewer, `/api/staff/kyc/${address.id}/request-new`, { reason: "Please send a newer statement" })).status).toBe(200);
    const body = { clientId, category: "address", subType: 1, reason: "Verified by video call with compliance", internalNote: "Call recorded in the ticket" };
    expect((await post(reviewer, "/api/staff/kyc/approve-without-documents", body)).status).toBe(403);
    await stepUp(env, boss);
    expect((await post(boss, "/api/staff/kyc/approve-without-documents", { ...body, subType: 9 })).status).toBe(400);
    const res = await post(boss, "/api/staff/kyc/approve-without-documents", body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "approved", documents: 0, source: "staff", staffNote: "Verified by video call with compliance" });
    expect((await post(boss, "/api/staff/kyc/approve-without-documents", body)).status).toBe(400);
    const seen = (await api().get("/api/kyc").set(auth())).body;
    expect(seen).toMatchObject({ is_kyc_approved: true, overall_status: "approved" });
    // Nothing was sent, so the portal and app do not say "sent on <date>".
    expect(seen.address).toMatchObject({ source: "staff", has_documents: false, submitted_at: null, sub_type_label: "Bank Statement" });
    expect(seen.identity).toMatchObject({ has_documents: true });
    expect(seen.identity.submitted_at).toBeTruthy();
    // The client page's activity list keeps internal notes and audit-only reasons for staff who may open KYC.
    const activity = async (s: SignedIn) =>
      ((await s.agent.get(`/api/staff/clients/${clientId}/activity`)).body.items as { action: string; meta: Record<string, unknown> | null }[]).find((a) => a.action === "kyc.approved_without_documents")!.meta;
    expect(await activity(boss)).toMatchObject({ internalNote: "Call recorded in the ticket", reason: "Verified by video call with compliance" });
    expect(await activity(support)).toEqual({ submissionId: res.body.id, category: "address" });
    // The client was verified another way, so they are told it is confirmed rather than that a document was approved.
    expect((await api().get("/api/notifications").set(auth())).body.data[0]).toMatchObject({
      title: "Your proof of address is confirmed", body: "We have confirmed your proof of address. Your account is now fully verified.",
    });
    expect(await one(env.db, "SELECT id FROM email_outbox WHERE template = 'kyc_confirmed' AND subject = 'Your proof of address is confirmed'")).toBeTruthy();

    // Approving a document-less item again after a rejection also needs the override.
    expect((await post(boss, `/api/staff/kyc/${res.body.id}/request-new`, { reason: "Please send a bank statement after all" })).status).toBe(200);
    expect((await post(reviewer, `/api/staff/kyc/${res.body.id}/change`, { status: "approved", reason: "Fine after all" })).status).toBe(403);
    const detail = (await boss.agent.get(`/api/staff/kyc/${res.body.id}`)).body;
    expect(detail.trail.map((t: { action: string }) => t.action)).toEqual(["approved_without_documents", "new_document_requested"]);
    expect(detail.trail[0]).toMatchObject({ staff: "boss", reason: "Verified by video call with compliance", internalNote: "Call recorded in the ticket" });
    expect((await post(boss, `/api/staff/kyc/${res.body.id}/change`, { status: "approved", reason: "Fine after all" })).status).toBe(200);
  });

  it("removes a profile picture when the client asks", async () => {
    await api().post("/api/user/profile-picture").set(auth()).attach("image", icon, { filename: "me.png", contentType: "image/png" });
    expect((await api().get("/api/user").set(auth())).body.image_url).toBeTruthy();
    expect((await api().delete("/api/user/profile-picture").set(auth())).status).toBe(200);
    expect((await api().get("/api/user").set(auth())).body.image_url).toBeNull();
  });

  it("locks verified details for the client and lets them take back a pending upload", async () => {
    const lia = await register("lia@client.test", "Lia", "Stone");
    const a = bearer(lia.token);
    await api().patch("/api/user").set(a).send(PROFILE);
    expect((await upload(3, 2, [other], lia.token)).status).toBe(201);
    expect((await api().get("/api/kyc").set(a)).body.locked_profile_fields).toEqual(["first_name", "last_name", "dob"]);
    // The portal sends the whole form: unchanged values (case and spacing aside) pass and are not rewritten.
    expect((await api().patch("/api/user").set(a).send({ ...PROFILE, first_name: "lia ", last_name: "Stone", city: "Leeds" })).status).toBe(200);
    expect((await api().get("/api/user").set(a)).body).toMatchObject({ first_name: "Lia", city: "Leeds" });
    const changed = await api().patch("/api/user").set(a).send({ dob: "1991-01-01", last_name: "Stoner", city: "York" });
    expect(changed.status).toBe(422);
    expect(changed.body.errors).toEqual({ last_name: [LOCKED], dob: [LOCKED] });
    expect((await api().get("/api/user").set(a)).body).toMatchObject({ last_name: "Stone", city: "Leeds" });

    const sub = (await one<{ id: number }>(env.db, "SELECT id FROM kyc_submissions WHERE client_id = ?", [lia.id]))!.id;
    expect((await api().get("/api/kyc").set(a)).body.identity.can_withdraw).toBe(true);
    await post(reviewer, `/api/staff/kyc/${sub}/claim`, {});
    expect((await api().get("/api/kyc").set(a)).body.identity.can_withdraw).toBe(false);
    const busy = await withdraw(3, lia.token);
    expect(busy.status).toBe(409);
    expect(busy.body).toEqual({ message: "A reviewer is checking this document now." });
    await post(reviewer, `/api/staff/kyc/${sub}/release`, {});
    expect((await withdraw(9, lia.token)).body.errors.type).toEqual(["Choose identity or proof of address."]);
    expect((await withdraw(3, lia.token)).body).toEqual({ success: true, message: "Your document was taken back. You can upload a new one now." });
    const after = (await api().get("/api/kyc").set(a)).body;
    expect(after).toMatchObject({ overall_status: "not_submitted", locked_profile_fields: [] });
    expect(after.identity).toMatchObject({ status: null, can_submit: true, can_withdraw: false });
    expect(await one(env.db, "SELECT s.status, c.kyc_status FROM kyc_submissions s JOIN clients c ON c.id = s.client_id WHERE s.id = ?", [sub])).toEqual({ status: "withdrawn", kyc_status: "none" });
    expect((await withdraw(3, lia.token)).body.errors.type).toEqual(["There is no document waiting for review to take back."]);

    // Staff still see it in the history, and cannot decide it.
    expect((await reviewer.agent.get(`/api/staff/kyc?status=withdrawn&clientId=${lia.id}`)).body.items.map((i: { id: number }) => i.id)).toEqual([sub]);
    expect((await reviewer.agent.get(`/api/staff/kyc/${sub}`)).body.trail.map((t: { label: string }) => t.label)).toEqual(["Sent by the client", "Taken back by the client"]);
    await stepUp(env, reviewer);
    expect((await post(reviewer, `/api/staff/kyc/${sub}/decision`, { decision: "reject", reason: "Not readable at all" })).body.error.message).toBe("The client took this document back.");
    expect((await upload(3, 2, [other], lia.token)).status).toBe(201);

    // Staff viewing the portal as the client cannot upload or take anything back.
    const view = await createClientSession(env.db, env.config, lia.id, "127.0.0.1", "test", { staffId: boss.staffId, reason: "Checking KYC" });
    expect((await upload(3, 2, [passport], view.token)).status).toBe(403);
    expect((await withdraw(3, view.token)).status).toBe(403);
  });

  it("lets only staff with the override permission change verified details, with fresh 2FA", async () => {
    const lia = (await one<{ id: number }>(env.db, "SELECT id FROM clients WHERE email = 'lia@client.test'"))!.id;
    expect((await boss.agent.get(`/api/staff/clients/${lia}`)).body.lockedFields).toEqual(["firstName", "lastName", "dob"]);
    const refused = await patch(salesManager, `/api/staff/clients/${lia}`, { lastName: "Stoner" });
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toBe("These details were checked against the client's documents. Ask a compliance admin to change them.");
    expect((await patch(salesManager, `/api/staff/clients/${lia}`, { city: "York" })).status).toBe(200);
    await exec(env.db, "UPDATE staff_sessions SET stepup_at = NULL");
    expect((await patch(boss, `/api/staff/clients/${lia}`, { lastName: "Stoner" })).body.error.code).toBe("STEP_UP_REQUIRED");
    await stepUp(env, boss);
    expect((await patch(boss, `/api/staff/clients/${lia}`, { lastName: "Stoner" })).status).toBe(200);
    const audit = await one<{ meta_json: { verifiedFields: string[] } }>(env.db, "SELECT meta_json FROM audit_log WHERE action = 'client.verified_details_changed' AND entity_id = ?", [String(lia)]);
    expect(audit!.meta_json.verifiedFields).toEqual(["last_name"]);
    // The reviewer is told which detail changed after the documents were sent.
    const sub = (await one<{ id: number }>(env.db, "SELECT id FROM kyc_submissions WHERE client_id = ? AND status = 'pending'", [lia]))!.id;
    expect(await warnings(reviewer, sub)).toContain("The client's last name changed after these documents were sent. Compare against the details shown here.");
  });

  it("leaves blank details open to fill in while a staff upload waits, and keeps an approval as it was checked", async () => {
    const bo = await register("blank@client.test", "Bo", "Blank");
    const b = bearer(bo.token);
    await stepUp(env, reviewer);
    const staffUpload = await reviewer.agent.post("/api/staff/kyc/upload").set("Origin", ORIGIN).set("X-CSRF-Token", reviewer.csrf)
      .field("client_id", String(bo.id)).field("type", "4").field("sub_type", "1").field("note", "Sent by email on 16 October")
      .attach("document1", await photo("#123456"), { filename: "bill.png", contentType: "image/png" });
    expect(staffUpload.status).toBe(201);
    // Nothing was checked yet, so the empty address fields are not locked.
    expect((await api().get("/api/kyc").set(b)).body.locked_profile_fields).toEqual([]);
    expect((await boss.agent.get(`/api/staff/clients/${bo.id}`)).body.lockedFields).toEqual([]);
    const { zipcode: _zip, address: _address, ...partial } = PROFILE;
    expect((await api().patch("/api/user").set(b).send({ ...partial, dob: "1985-05-05" })).status).toBe(200);
    expect((await api().get("/api/kyc").set(b)).body.locked_profile_fields).toEqual(["country", "city"]);
    expect((await api().patch("/api/user").set(b).send({ city: "Leeds" })).body.errors).toEqual({ city: [LOCKED] });
    // Staff without the override may fill in a blank detail too, but not change one that is filled.
    const refused = "These details were checked against the client's documents. Ask a compliance admin to change them.";
    expect((await patch(salesManager, `/api/staff/clients/${bo.id}`, { city: "York" })).body.error.message).toBe(refused);
    expect((await patch(salesManager, `/api/staff/clients/${bo.id}`, { address: "1 Baker St" })).status).toBe(200);
    expect((await api().get("/api/kyc").set(b)).body.locked_profile_fields).toEqual(["country", "city", "address"]);

    // Approved without a postcode: it stays as the reviewer saw it, blank.
    await stepUp(env, second);
    expect((await approve(second, staffUpload.body.id)).status).toBe(200);
    expect((await api().get("/api/kyc").set(b)).body.locked_profile_fields).toEqual(["country", "city", "address", "zipcode"]);
    expect((await api().patch("/api/user").set(b).send({ zipcode: "LS1 1AA" })).body.errors).toEqual({ zipcode: [LOCKED] });
    expect((await patch(salesManager, `/api/staff/clients/${bo.id}`, { zipcode: "LS1 1AA" })).body.error.message).toBe(refused);
  });

  it("warns about the same person, reused files and shared files without naming clients out of scope", async () => {
    const shared = await photo("#123456");
    const annA = await register("ann.a@client.test", "Ann", "Twin");
    const annB = await register("ann.b@client.test", "ann", "TWIN");
    for (const c of [annA, annB]) await api().patch("/api/user").set(bearer(c.token)).send({ ...PROFILE, dob: "1985-05-05" });
    expect((await upload(3, 1, [shared, shared], annA.token)).status).toBe(201);
    expect((await upload(3, 2, [shared], annB.token)).status).toBe(201);
    expect((await upload(4, 2, [shared], annB.token)).status).toBe(201);
    await exec(env.db, "UPDATE clients SET assigned_staff_id = ? WHERE id = ?", [scoped.staffId, annB.id]);
    const [aIdentity, bIdentity, bAddress] = (await rows<{ id: number }>(env.db, "SELECT id FROM kyc_submissions WHERE client_id IN (?, ?) ORDER BY id", [annA.id, annB.id])).map((r) => r.id);

    expect(await warnings(reviewer, aIdentity!)).toContain("The front and back are the same file.");
    expect(await warnings(reviewer, bIdentity!)).toEqual(expect.arrayContaining([
      `The same person may have another account: Ann Twin (client ${annA.id}) has the same name and date of birth.`,
      `The same file was also uploaded by Ann Twin (client ${annA.id}).`,
    ]));
    // A reviewer limited to their own clients is warned without being told who the other client is.
    const limited = await warnings(scoped, bIdentity!);
    expect(limited).toEqual(expect.arrayContaining([
      "The same person may have another account: another client has the same name and date of birth.",
      "The same file was also uploaded by another client.",
    ]));
    expect(limited.join(" ")).not.toContain(`client ${annA.id}`);
    expect(limited.join(" ")).not.toContain("Ann Twin");
    expect((await scoped.agent.get(`/api/staff/kyc/${aIdentity}`)).status).toBe(404);
    expect(await warnings(scoped, bAddress!)).toContain("This file is the same as one the client sent as proof of identity.");
  });

  it("lets frozen accounts upload, and keeps closed accounts out of the queue and out of reach", async () => {
    const fred = await register("frozen@client.test", "Fred", "Frost");
    await api().patch("/api/user").set(bearer(fred.token)).send({ ...PROFILE, dob: "1980-02-02" });
    await exec(env.db, "UPDATE clients SET status = 'frozen' WHERE id = ?", [fred.id]);
    expect((await api().get("/api/kyc").set(bearer(fred.token))).body.identity.can_submit).toBe(true);
    expect((await upload(3, 2, [heic], fred.token)).status).toBe(201);
    // HEIC photos are kept as a JPEG every browser shows; duplicate checks use the file as sent.
    const doc = await one<{ submission_id: number; mime: string; file_name: string; sha256: string }>(
      env.db,
      "SELECT d.submission_id, d.mime, d.file_name, d.sha256 FROM kyc_documents d JOIN kyc_submissions s ON s.id = d.submission_id WHERE s.client_id = ?",
      [fred.id],
    );
    expect(doc).toMatchObject({ mime: "image/jpeg", file_name: "photo.jpg", sha256: sha256(heic) });
    const sub = doc!.submission_id;
    // The audit log describes the stored JPEG, with its hash, and the HEIC as sent.
    const sealed = await one<{ bytes_enc: Buffer }>(env.db, "SELECT bytes_enc FROM kyc_documents WHERE submission_id = ? AND slot = 1", [sub]);
    const kept = decryptBytes(env.config.dataKey, sealed!.bytes_enc, kycDocumentContext(sub, 1));
    const logged = await one<{ meta_json: { files: unknown[] } }>(env.db, "SELECT meta_json FROM audit_log WHERE action = 'kyc.submitted' AND entity_id = ?", [String(fred.id)]);
    expect(logged!.meta_json.files).toEqual([
      { type: "image/jpeg", bytes: kept.length, sha256: sha256(kept), sent: { type: "image/heic", bytes: heic.length, sha256: sha256(heic) } },
    ]);
    // A HEIC photo stored before uploads were converted reaches the review screen as a JPEG.
    await exec(env.db, "UPDATE kyc_documents SET mime = 'image/heic', bytes_enc = ? WHERE submission_id = ? AND slot = 1", [encryptBytes(env.config.dataKey, heic, kycDocumentContext(sub, 1)), sub]);
    const shown = await view(reviewer, (await reviewer.agent.get(`/api/staff/kyc/${sub}`)).body.files[0].url);
    expect(shown.headers["content-type"]).toBe("image/jpeg");
    expect((await sharp(shown.body as Buffer).metadata()).format).toBe("jpeg");
    // A PDF stored before pages were counted is counted when first opened, broken pages included, so all stay required.
    // One the server cannot read stays uncounted, and can then only be rejected.
    const legacyPdf = async (bytes: Buffer) => {
      await exec(env.db, "UPDATE kyc_documents SET mime = 'application/pdf', pages = NULL, bytes_enc = ? WHERE submission_id = ? AND slot = 1", [encryptBytes(env.config.dataKey, bytes, kycDocumentContext(sub, 1)), sub]);
      const f = (await reviewer.agent.get(`/api/staff/kyc/${sub}`)).body.files[0];
      expect((await view(reviewer, f.url)).status).toBe(200);
      return { id: f.id as number, pages: (await one<{ pages: number | null }>(env.db, "SELECT pages FROM kyc_documents WHERE id = ?", [f.id]))!.pages };
    };
    expect((await legacyPdf(missingPagePdf)).pages).toBe(2);
    const unread = await legacyPdf(brokenPdf);
    expect(unread.pages).toBeNull();
    expect((await post(reviewer, `/api/staff/kyc/documents/${unread.id}/pages`, { page: 1 })).body.error.message).toBe("That page is not part of this document.");
    expect((await reviewer.agent.get(`/api/staff/kyc/${sub}`)).body.files[0]).toMatchObject({ pages: null, viewedByMe: false });
    expect(await warnings(reviewer, sub)).toContain("The account is frozen.");

    const pendingBefore = (await reviewer.agent.get("/api/staff/kyc/summary")).body.pending;
    await exec(env.db, "UPDATE clients SET status = 'closed' WHERE id = ?", [fred.id]);
    expect((await reviewer.agent.get("/api/staff/kyc/summary")).body.pending).toBe(pendingBefore - 1);
    expect((await reviewer.agent.get("/api/staff/kyc?pageSize=100")).body.items.map((i: { id: number }) => i.id)).not.toContain(sub);
    expect((await reviewer.agent.get("/api/staff/kyc?pageSize=100&includeClosed=1")).body.items.map((i: { id: number }) => i.id)).toContain(sub);
    const next = (await post(reviewer, "/api/staff/kyc/next", {})).body.id;
    expect(next).not.toBe(sub);
    if (next) await post(reviewer, `/api/staff/kyc/${next}/release`, {});
    expect((await reviewer.agent.get(`/api/staff/kyc/${sub}`)).body).toMatchObject({ mayApprove: false, approveBlockedReason: "This account is closed." });
    await stepUp(env, reviewer);
    expect((await post(reviewer, `/api/staff/kyc/${sub}/decision`, { decision: "reject", reason: "Not readable at all" })).body.error.message).toBe("This account is closed.");
    await stepUp(env, boss);
    const offline = await post(boss, "/api/staff/kyc/approve-without-documents", { clientId: fred.id, category: "address", subType: 1, reason: "Verified by video call" });
    expect(offline.body.error.message).toBe("This account is closed.");
    const staffUpload = await reviewer.agent.post("/api/staff/kyc/upload").set("Origin", ORIGIN).set("X-CSRF-Token", reviewer.csrf)
      .field("client_id", String(fred.id)).field("type", "4").field("sub_type", "1").field("note", "Sent by email on 16 October")
      .attach("document1", passport, { filename: "bill.png", contentType: "image/png" });
    expect(staffUpload.body.error.message).toBe("This account is closed. Reopen it before adding documents.");
  });

  it("approves both documents at the same time without a stale status, and keeps the evidence", async () => {
    const rae = await register("race@client.test", "Rae", "Case");
    await api().patch("/api/user").set(bearer(rae.token)).send({ ...PROFILE, dob: "1975-03-03" });
    expect((await upload(3, 2, [await photo("#0a0a0a")], rae.token)).status).toBe(201);
    expect((await upload(4, 4, [await photo("#fafafa")], rae.token)).status).toBe(201);
    const [identity, address] = (await rows<{ id: number }>(env.db, "SELECT id FROM kyc_submissions WHERE client_id = ? ORDER BY id", [rae.id])).map((r) => r.id);
    await openAll(reviewer, identity!);
    // The back of an ID card proves the address but carries no recent date.
    const backOfCard = await openAll(reviewer, address!);
    expect(backOfCard.checklist.map((c) => c.key)).toEqual(["name", "address", "valid", "clear"]);
    await stepUp(env, reviewer);
    expect((await post(reviewer, `/api/staff/kyc/${address}/decision`, { decision: "approve", checklist: ALL.address })).status).toBe(400);
    const results = await Promise.all([
      post(reviewer, `/api/staff/kyc/${identity}/decision`, { decision: "approve", checklist: ALL.identity }),
      post(reviewer, `/api/staff/kyc/${address}/decision`, { decision: "approve", checklist: ["name", "address", "valid", "clear"] }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const row = await one<{ kyc_status: string; kyc_approved_at: Date | null }>(env.db, "SELECT kyc_status, kyc_approved_at FROM clients WHERE id = ?", [rae.id]);
    expect(row!.kyc_status).toBe("approved");
    expect(row!.kyc_approved_at).not.toBeNull();
    const events = await kycEvents(rae.id);
    expect(events).toHaveLength(2);
    expect(events.filter((e) => e === "kyc.approved")).toHaveLength(1);
    // KYC evidence never disappears with a client row, nor documents with their submission.
    await expect(exec(env.db, "DELETE FROM clients WHERE id = ?", [rae.id])).rejects.toThrow(/fk_kyc_client/);
    await expect(exec(env.db, "DELETE FROM kyc_submissions WHERE id = ?", [identity])).rejects.toThrow(/fk_kyc_doc_submission/);
  });

  it("throttles uploads by stored documents only, and needs no postcode", async () => {
    const tom = await register("throttle@client.test", "Tom", "Hill");
    const { zipcode: _zip, ...noZip } = PROFILE;
    await api().patch("/api/user").set(bearer(tom.token)).send({ ...noZip, dob: "1970-01-01" });
    expect((await api().get("/api/kyc").set(bearer(tom.token))).body).toMatchObject({ profile_complete: true, missing_profile_fields: [] });
    // Failed attempts do not use up the allowance.
    for (let i = 0; i < 3; i++) expect((await upload(3, 2, [HTML], tom.token)).status).toBe(422);
    const file = await photo("#445566");
    for (let i = 0; i < 10; i++) {
      expect((await upload(3, 2, [file], tom.token)).status).toBe(201);
      expect((await withdraw(3, tom.token)).status).toBe(200);
    }
    const limited = await upload(3, 2, [file], tom.token);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect(limited.body).toEqual({ message: "Too many uploads. Please wait before trying again." });
  });

  it("takes many new clients' first uploads at the same time", async () => {
    // Their rows all land in the same index gap, where a locking read before the insert would deadlock.
    const people: { token: string; id: number }[] = [];
    for (const [i, c] of [..."ABCDEFGH"].entries()) people.push(await register(`burst.${i}@client.test`, "Bea", `Burst${c}`));
    await Promise.all(people.map((p, i) => api().patch("/api/user").set(bearer(p.token)).send({ ...PROFILE, dob: `1960-01-${String(i + 10)}` })));
    const results = await Promise.all(people.map((p) => upload(4, 1, [pdf], p.token)));
    expect(results.map((r) => r.status)).toEqual(people.map(() => 201));
    const states = await rows<{ kyc_status: string }>(env.db, `SELECT kyc_status FROM clients WHERE id IN (${people.map(() => "?").join(", ")})`, people.map((p) => p.id));
    expect(states.map((s) => s.kyc_status)).toEqual(people.map(() => "pending"));
  });
});
