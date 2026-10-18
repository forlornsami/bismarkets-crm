import jsQR from "jsqr";
import QRCode from "qrcode";
import sharp from "sharp";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEPOSIT_CHECKLIST, DEPOSIT_REJECT_REASONS } from "@shared/money";
import { encryptBytes, sha256 } from "../src/server/lib/crypto";
import { exec, one, rows } from "../src/server/lib/db";
import { verifyLedger, walletOf } from "../src/server/money/ledger";
import { depositProofContext } from "../src/server/money/proofs";
import { newReference } from "../src/server/money/references";
import { createStaff, del, hasDb, ORIGIN, patch, post, setup, signIn, stepUp, type SignedIn, type TestEnv } from "./helpers";

const FIRST = DEPOSIT_CHECKLIST.first.map((c) => c.key);
const SECOND = DEPOSIT_CHECKLIST.second.map((c) => c.key);
const today = () => new Date().toISOString().slice(0, 10);
/** A proof request as the review screen sends it. */
const view = (s: SignedIn, url: string) => s.agent.get(url).set("X-CRM-Viewer", "1");
let shade = 0;
/** A different screenshot each time. */
const screenshot = () => {
  shade++;
  return sharp({ create: { width: 420, height: 300, channels: 3, background: { r: shade % 256, g: Math.floor(shade / 256) % 256, b: 90 } } }).png().toBuffer();
};
const TRC20 = "TJ1aBcDeFgHiJkLmNoPqRsTuVwXyZ12345";

describe.skipIf(!hasDb)("staff deposits", () => {
  let env: TestEnv;
  let agent: SignedIn;
  let agent2: SignedIn;
  let manager: SignedIn;
  let manager2: SignedIn;
  let sales: SignedIn;
  let support: SignedIn;
  let auditor: SignedIn;
  let dealing: SignedIn;
  let scoped: SignedIn;
  let boss: SignedIn;
  let usdBank: number;
  let pkrBank: number;
  let crypto: number;
  let seq = 0;
  let refSeq = 0;
  const bankRef = () => `FT-${Date.now() % 100000}-${++refSeq}`;

  async function makeClient(o: { first?: string; last?: string; status?: string; kyc?: string; assignedTo?: number | null; hoursOld?: number } = {}) {
    seq++;
    const r = await exec(
      env.db,
      "INSERT INTO clients (email, first_name, last_name, referral_code, source, status, kyc_status, assigned_staff_id, created_at) VALUES (?, ?, ?, ?, 'portal', ?, ?, ?, ?)",
      [
        `dep${seq}@client.test`, o.first ?? "Ali", o.last ?? "Khan", `DEP${String(seq).padStart(5, "0")}`, o.status ?? "active", o.kyc ?? "approved",
        o.assignedTo === undefined ? agent.staffId : o.assignedTo, new Date(Date.now() - (o.hoursOld ?? 72) * 3_600_000),
      ],
    );
    return r.insertId;
  }

  async function makeMethod(o: Record<string, unknown>) {
    const m = { direction: "deposit", kind: "bank", name: "Bank transfer", currency: "USD", network: "", bank_name: "Meezan Bank", account_title: "BIS Markets Ltd", account_number: "0101234567", ...o };
    const keys = Object.keys(m);
    const r = await exec(env.db, `INSERT INTO payment_methods (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`, Object.values(m));
    return r.insertId;
  }

  /** A deposit as the client API stores it: the row and its encrypted proof. */
  async function makeDeposit(
    clientId: number,
    methodId: number,
    o: { amountMinor?: number; currency?: "USD" | "PKR"; rate?: string; rateSetBy?: number; proof?: Buffer; editor?: string | null; hoursOld?: number } = {},
  ) {
    const wallet = await walletOf(env.db, clientId);
    const reference = newReference("D");
    const currency = o.currency ?? "USD";
    const rate = currency === "USD" ? "1" : (o.rate ?? "280");
    const amountMinor = o.amountMinor ?? 10_000;
    const amountCents = currency === "USD" ? amountMinor : Math.floor((amountMinor * 1_000_000) / Math.round(Number(rate) * 1_000_000));
    const method = await one<{ name: string }>(env.db, "SELECT name FROM payment_methods WHERE id = ?", [methodId]);
    const r = await exec(
      env.db,
      "INSERT INTO deposits (reference, client_id, wallet_id, payment_method_id, method_name, currency, amount_minor, usd_rate, rate_set_by, amount_cents, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [reference, clientId, wallet.id, methodId, method!.name, currency, amountMinor, rate, o.rateSetBy ?? null, amountCents, new Date(Date.now() - (o.hoursOld ?? 1) * 3_600_000)],
    );
    const proof = o.proof ?? (await screenshot());
    await exec(env.db, "INSERT INTO deposit_proofs (deposit_id, mime, size_bytes, sha256, file_name, editor, bytes_enc) VALUES (?, 'image/png', ?, ?, 'payment.png', ?, ?)", [
      r.insertId, proof.length, sha256(proof), o.editor ?? null, encryptBytes(env.config.dataKey, proof, depositProofContext(r.insertId, clientId, reference)),
    ]);
    return { id: r.insertId, reference, proof };
  }

  const url = (id: number, path = "") => `/api/staff/deposits/${id}${path}`;
  const detail = async (s: SignedIn, id: number) => (await s.agent.get(url(id))).body;
  const openProof = async (s: SignedIn, id: number) => expect((await view(s, url(id, "/proof"))).status).toBe(200);
  const approve = (s: SignedIn, id: number, o: Record<string, unknown> = {}) =>
    post(s, url(id, "/approve"), { receivedAmount: "100.00", senderName: "Ali Khan", bankReference: bankRef(), receivedOn: today(), checklist: FIRST, ...o });
  const secondApprove = (s: SignedIn, id: number, o: Record<string, unknown> = {}) => post(s, url(id, "/second-approve"), { checklist: SECOND, ...o });
  const reject = (s: SignedIn, id: number, reason = DEPOSIT_REJECT_REASONS[0]) => post(s, url(id, "/reject"), { reason });
  const status = async (id: number) => (await one<{ status: string }>(env.db, "SELECT status FROM deposits WHERE id = ?", [id]))!.status;
  const credits = async (id: number) => Number((await one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM ledger_transactions WHERE source_type = 'deposit' AND source_id = ? AND kind = 'deposit'", [id]))!.n);
  const available = async (clientId: number) => (await walletOf(env.db, clientId)).available_cents;
  const events = async (clientId: number) =>
    (await rows<{ event: string; payload: { reference_id?: string } & Record<string, unknown> }>(env.db, "SELECT event, payload FROM webhook_outbox WHERE client_id = ? ORDER BY id", [clientId])).map((e) => ({
      event: e.event,
      ref: e.payload.reference_id,
      keys: Object.keys(e.payload).sort(),
    }));
  const bells = (clientId: number) => rows<{ type: string; title: string; body: string; link: string }>(env.db, "SELECT type, title, body, link FROM client_notifications WHERE client_id = ? ORDER BY id", [clientId]);
  const emails = (clientId: number) => rows<{ template: string; subject: string; body_text: string }>(env.db, "SELECT template, subject, body_text FROM email_outbox WHERE client_id = ? ORDER BY id", [clientId]);
  const audits = (action: string, depositId: number) =>
    rows<{ actor_id: number; meta_json: Record<string, unknown>; before_json: unknown; after_json: unknown }>(
      env.db,
      "SELECT actor_id, meta_json, before_json, after_json FROM audit_log WHERE action = ? AND meta_json->'$.depositId' = ? ORDER BY id",
      [action, depositId],
    );

  beforeAll(async () => {
    env = await setup({ CRM_STEPUP_MINUTES: "30" });
    // A reviewer who sees only the clients assigned to them.
    await exec(env.db, "INSERT INTO roles (slug, name) VALUES ('money_scoped', 'Scoped finance')");
    await exec(
      env.db,
      `INSERT INTO role_permissions (role_id, permission) SELECT r.id, p.name FROM roles r JOIN (SELECT 'deposit.view' AS name UNION SELECT 'deposit.proof' UNION SELECT 'deposit.process'
         UNION SELECT 'deposit.reject' UNION SELECT 'wallet.view' UNION SELECT 'client.view') p WHERE r.slug = 'money_scoped'`,
    );
    const staff = [
      ["agent@bis.test", "finance_agent"], ["agent2@bis.test", "finance_agent"], ["manager@bis.test", "finance_manager"], ["manager2@bis.test", "finance_manager"],
      ["sales@bis.test", "sales_agent"], ["support@bis.test", "support_agent"], ["auditor@bis.test", "auditor"], ["dealing@bis.test", "dealing"],
      ["scoped@bis.test", "money_scoped"], ["boss@bis.test", "super_admin"],
    ];
    for (const [email, role] of staff) await createStaff(env.db, email!, role!);
    [agent, agent2, manager, manager2, sales, support, auditor, dealing, scoped, boss] = (await Promise.all(staff.map(([email]) => signIn(env, email!)))) as [
      SignedIn, SignedIn, SignedIn, SignedIn, SignedIn, SignedIn, SignedIn, SignedIn, SignedIn, SignedIn,
    ];
    // agent2 is left without a fresh code for the step-up test.
    for (const s of [agent, manager, manager2, auditor, scoped, boss]) await stepUp(env, s);
    usdBank = await makeMethod({ name: "Bank transfer (USD)" });
    pkrBank = await makeMethod({ name: "Meezan Bank (PKR)", currency: "PKR", iban: "PK36MEZN0001010123456702" });
    crypto = await makeMethod({ kind: "crypto", name: "USDT TRC20", network: "trc20", bank_name: "", account_title: "", account_number: "", wallet_address: TRC20 });
  });
  afterAll(async () => {
    await env?.db.end();
  });

  it("shows the queue to deposit.view, but the review screen and the proof only with deposit.proof", async () => {
    const clientId = await makeClient();
    const d = await makeDeposit(clientId, usdBank);
    const list = (await support.agent.get("/api/staff/deposits")).body;
    const item = list.items.find((i: { id: number }) => i.id === d.id);
    expect(Object.keys(item).sort()).toEqual(
      [
        "id", "reference", "clientId", "clientName", "clientEmail", "clientStatus", "kycStatus", "methodId", "methodName", "methodKind", "currency", "amountMinor", "amountCents",
        "creditedCents", "status", "needsSecondApproval", "sentBack", "firstReviewedBy", "decidedBy", "createdAt", "decidedAt", "claimedBy", "warningCount",
      ].sort(),
    );
    expect(item).toMatchObject({ reference: d.reference, clientId, clientName: "Ali Khan", methodId: usdBank, methodKind: "bank", currency: "USD", amountMinor: 10_000, amountCents: 10_000, creditedCents: null, status: "pending", needsSecondApproval: false, firstReviewedBy: null, claimedBy: null });
    expect(item.warningCount).toBeGreaterThanOrEqual(1);
    // A sales agent sees only their own clients; this one is the finance agent's.
    expect((await sales.agent.get("/api/staff/deposits")).body.total).toBe(0);
    for (const s of [sales, support]) {
      expect((await s.agent.get(url(d.id))).status).toBe(403);
      expect((await view(s, url(d.id, "/proof"))).status).toBe(403);
      expect((await post(s, "/api/staff/deposits/next", {})).status).toBe(403);
    }
    expect((await dealing.agent.get("/api/staff/deposits")).status).toBe(403);
    expect((await dealing.agent.get("/api/staff/deposits/summary")).status).toBe(403);
    // The auditor may look at everything and decide nothing.
    expect((await auditor.agent.get(url(d.id))).status).toBe(200);
    await openProof(auditor, d.id);
    expect((await approve(auditor, d.id)).status).toBe(403);
    expect((await reject(auditor, d.id)).status).toBe(403);
    expect((await post(auditor, url(d.id, "/claim"), {})).status).toBe(403);
    const asAuditor = await detail(auditor, d.id);
    expect(asAuditor.can.approve).toEqual({ ok: false, reason: "You do not have permission to approve deposits." });
    // Staff without client.view_all see only their own clients' deposits.
    expect((await scoped.agent.get(url(d.id))).status).toBe(404);
    expect((await view(scoped, url(d.id, "/proof"))).status).toBe(404);
    expect((await scoped.agent.get(`/api/staff/deposits?clientId=${clientId}`)).body.total).toBe(0);
    const mine = await makeClient({ assignedTo: scoped.staffId });
    const own = await makeDeposit(mine, usdBank);
    expect((await scoped.agent.get("/api/staff/deposits")).body.items.map((i: { id: number }) => i.id)).toEqual([own.id]);
    expect((await scoped.agent.get(url(own.id))).status).toBe(200);
    expect((await reject(scoped, d.id)).status).toBe(404);
  });

  it("needs the proof opened in the review screen and a fresh 2FA code before approving", async () => {
    const clientId = await makeClient();
    const d = await makeDeposit(clientId, usdBank);
    const stepless = await approve(agent2, d.id);
    expect([stepless.status, stepless.body.error.code]).toEqual([403, "STEP_UP_REQUIRED"]);
    await stepUp(env, agent2);
    expect((await approve(agent2, d.id)).body.error.message).toBe("Open the payment proof before approving.");
    // A pasted link or an <img> cannot send the header, so the proof is never opened outside the review screen.
    const pasted = await agent2.agent.get(url(d.id, "/proof"));
    expect(pasted.status).toBe(403);
    expect(await audits("deposit.proof_viewed", d.id)).toHaveLength(0);
    const shown = await view(agent2, url(d.id, "/proof"));
    expect(shown.status).toBe(200);
    expect(shown.headers["content-type"]).toBe("image/png");
    expect(shown.headers["x-document-sha256"]).toBe(sha256(shown.body as Buffer));
    expect(shown.body.equals(d.proof)).toBe(true);
    expect(shown.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(shown.headers["content-disposition"]).toBe("inline");
    expect(shown.headers["x-content-type-options"]).toBe("nosniff");
    expect(shown.headers["cache-control"]).toBe("no-store");
    expect(shown.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect((await audits("deposit.proof_viewed", d.id)).map((a) => [a.actor_id, a.meta_json])).toEqual([[agent2.staffId, { depositId: d.id, reference: d.reference }]]);
    // Someone else opening it does not count for this reviewer.
    const other = await makeDeposit(clientId, usdBank);
    await openProof(agent, other.id);
    expect((await detail(agent2, other.id)).proofOpenedByMe).toBe(false);
    const shown2 = await detail(agent2, d.id);
    expect(shown2.proofOpenedByMe).toBe(true);
    // Every opening of the review screen is recorded.
    expect((await audits("deposit.viewed", d.id)).map((a) => [a.actor_id, a.meta_json])).toEqual([[agent2.staffId, { depositId: d.id, reference: d.reference }]]);
    await detail(agent2, d.id);
    expect(await audits("deposit.viewed", d.id)).toHaveLength(2);
    // Openings stay in the audit log, not in the client's activity, where they would crowd out what happened.
    const feed = await agent2.agent.get(`/api/staff/clients/${clientId}/activity`);
    expect(feed.status).toBe(200);
    expect(feed.body.items.map((a: { action: string }) => a.action)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^deposit\.(viewed|proof_viewed)$/)]));
    expect((await approve(agent2, d.id, { checklist: FIRST.slice(1) })).status).toBe(400);
    expect((await approve(agent2, d.id)).body.status).toBe("approved");
  });

  it("keeps review details in the client's activity for deposit reviewers only", async () => {
    const clientId = await makeClient();
    const d = await makeDeposit(clientId, usdBank);
    await openProof(agent, d.id);
    expect((await approve(agent, d.id, { note: "Sender confirmed by phone" })).body.status).toBe("approved");
    const entry = async (s: SignedIn) =>
      ((await s.agent.get(`/api/staff/clients/${clientId}/activity`)).body.items as { action: string; meta: Record<string, unknown> }[]).find((a) => a.action === "deposit.approved")!.meta;
    const full = await entry(agent);
    expect(full).toMatchObject({ depositId: d.id, reference: d.reference, stage: "single", internalNote: "Sender confirmed by phone", checklist: FIRST });
    // Warnings can name other clients; the review screen shows them only within the reviewer's reach.
    expect(full).not.toHaveProperty("warnings");
    expect((await one<{ meta_json: Record<string, unknown> }>(env.db, "SELECT meta_json FROM audit_log WHERE action = 'deposit.approved' AND entity_id = ? ORDER BY id DESC LIMIT 1", [String(clientId)]))!.meta_json).toHaveProperty("warnings");
    // Support may see the client and its deposits, but not how they were checked.
    expect(await entry(support)).toEqual({ depositId: d.id, reference: d.reference, stage: "single" });
  });

  it("approves a deposit up to the limit in one step and credits the wallet exactly once", async () => {
    const clientId = await makeClient();
    const d = await makeDeposit(clientId, usdBank, { amountMinor: 125_000 });
    await openProof(agent, d.id);
    const before = await detail(agent, d.id);
    expect(before).toMatchObject({
      stage: "first", expectedReference: `BIS-${clientId}`, secondApprovalAboveCents: 500_000, claimMinutes: 15, rejectReasons: DEPOSIT_REJECT_REASONS,
      checklist: { first: DEPOSIT_CHECKLIST.first, second: DEPOSIT_CHECKLIST.second }, checked: { first: null, second: null },
      proof: { mime: "image/png", sizeBytes: d.proof.length, sha256: sha256(d.proof), editor: null, fileName: "payment.png", url: `/api/staff/deposits/${d.id}/proof` },
      client: { id: clientId, name: "Ali Khan", verifiedName: "Ali Khan", status: "active", kycStatus: "approved", assignedTo: { id: agent.staffId, name: "agent" } },
      method: { id: usdBank, name: "Bank transfer (USD)", kind: "bank", currency: "USD", bankName: "Meezan Bank", accountTitle: "BIS Markets Ltd", accountNumber: "0101234567" },
      wallet: { availableCents: 0, heldCents: 0 },
      history: { approvedCount: 0, approvedTotalCents: 0, firstDeposit: true, recent: [] },
      can: { approve: { ok: true, reason: null }, secondApprove: { ok: false }, reject: { ok: true, reason: null }, returnToFirst: { ok: false } },
      proofOpenedByMe: true, usdRate: "1.000000", receivedMinor: null,
    });
    expect(before.warnings.map((w: { text: string }) => w.text)).toContain("This is the client's first deposit.");
    // The amount that arrived must be entered exactly; a different amount needs a note.
    for (const receivedAmount of ["1,250", "12.505", "-5", ""]) expect((await approve(agent, d.id, { receivedAmount })).status).toBe(400);
    expect((await approve(agent, d.id, { receivedAmount: "1200" })).body.error.message).toBe("Add a note explaining why the received amount differs.");
    expect((await approve(agent, d.id, { receivedOn: "2020-01-01" })).status).toBe(400);
    expect((await approve(agent, d.id, { receivedOn: "2999-01-01" })).status).toBe(400);
    expect((await approve(agent, d.id, { receivedOn: "2026-02-30" })).status).toBe(400);
    expect((await approve(agent, d.id, { senderName: "<script>x</script>" })).status).toBe(400);
    expect((await approve(agent, d.id, { extra: 1 })).status).toBe(400);
    const res = await approve(agent, d.id, { receivedAmount: "1250", note: "Matches the statement" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "approved", creditedCents: 125_000, receivedMinor: 125_000, senderName: "Ali Khan", receivedOn: today(), stage: null, needsSecondApproval: false });
    expect(res.body.firstReviewedBy).toEqual({ id: agent.staffId, name: "agent" });
    expect(res.body.decidedBy).toEqual({ id: agent.staffId, name: "agent" });
    expect(res.body.checked).toEqual({ first: FIRST, second: null });
    expect(res.body.notes).toEqual([expect.objectContaining({ byName: "agent", stage: "approved", text: "Matches the statement" })]);
    expect(res.body.wallet.availableCents).toBe(125_000);
    expect(await available(clientId)).toBe(125_000);
    expect(await credits(d.id)).toBe(1);
    // Approving again changes nothing.
    expect((await approve(agent, d.id)).body.error.message).toBe("This deposit was already approved by agent.");
    expect((await reject(agent, d.id)).status).toBe(400);
    expect(await available(clientId)).toBe(125_000);
    // One event, one bell and one email, with nothing about the money in the support payload.
    expect(await events(clientId)).toEqual([{ event: "deposit.approved", ref: d.reference, keys: ["environment", "event", "event_id", "occurred_at", "reference_id", "schema_version", "source", "user_id"] }]);
    expect(await bells(clientId)).toEqual([{ type: "deposit", title: "Your deposit was added to your wallet", body: "USD 1,250.00 is now in your wallet.", link: "/transactions" }]);
    const mail = await emails(clientId);
    expect(mail.map((m) => m.template)).toEqual(["deposit_approved"]);
    expect(mail[0]!.body_text).toMatch(/^Hello Ali,\n\nWe have received your payment and added USD 1,250\.00 to your wallet/);
    expect(mail[0]!.body_text).toMatch(/BIS Markets$/);
    const audit = await audits("deposit.approved", d.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.meta_json).toMatchObject({ depositId: d.id, reference: d.reference, stage: "single", creditedCents: 125_000, received: { minor: 125_000, currency: "USD" }, checklist: FIRST, internalNote: "Matches the statement" });
    expect(await verifyLedger(env.db)).toEqual([]);
  });

  it("credits once when two reviewers approve at the same moment", async () => {
    const clientId = await makeClient();
    const d = await makeDeposit(clientId, usdBank);
    await openProof(agent, d.id);
    await openProof(agent2, d.id);
    const answers = await Promise.all([approve(agent, d.id), approve(agent2, d.id)]);
    expect(answers.map((a) => a.status).sort()).toEqual([200, 400]);
    expect(await credits(d.id)).toBe(1);
    expect(await available(clientId)).toBe(10_000);
    expect((await events(clientId)).map((e) => e.event)).toEqual(["deposit.approved"]);
    expect(await bells(clientId)).toHaveLength(1);
  });

  it("needs a second approval from another person above the limit", async () => {
    const clientId = await makeClient();
    const d = await makeDeposit(clientId, usdBank, { amountMinor: 600_000 });
    expect((await detail(agent, d.id)).needsSecondApproval).toBe(true);
    await openProof(agent, d.id);
    const ref = bankRef();
    const first = await approve(agent, d.id, { receivedAmount: "6000", bankReference: ref, note: "Seen in the statement" });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: "second_approval", stage: "second", creditedCents: null, receivedMinor: 600_000, bankReference: ref, firstReviewedBy: { id: agent.staffId }, decidedBy: null });
    expect(first.body.warnings.map((w: { text: string }) => w.text)).toContain("Needs a second approval from another person.");
    // Nothing moves and nobody is told until the second approval.
    expect(await available(clientId)).toBe(0);
    expect(await credits(d.id)).toBe(0);
    expect(await events(clientId)).toEqual([]);
    expect(await bells(clientId)).toEqual([]);
    expect(await audits("deposit.first_approved", d.id)).toHaveLength(1);
    expect((await approve(agent, d.id)).status).toBe(400);
    // A finance agent cannot give the second approval at all.
    expect((await secondApprove(agent, d.id)).status).toBe(403);
    expect((await secondApprove(agent2, d.id)).status).toBe(403);
    expect((await detail(agent2, d.id)).can.secondApprove).toEqual({ ok: false, reason: "Only staff who may approve large deposits can give the second approval." });
    const summary = (await manager.agent.get("/api/staff/deposits/summary")).body;
    expect(summary.secondApprovalForMe).toBeGreaterThanOrEqual(1);
    expect((await agent.agent.get("/api/staff/deposits/summary")).body.secondApprovalForMe).toBe(0);
    expect((await secondApprove(manager, d.id)).body.error.message).toBe("Open the payment proof before approving.");
    await openProof(manager, d.id);
    expect((await secondApprove(manager, d.id, { checklist: ["statement"] })).status).toBe(400);
    const done = await secondApprove(manager, d.id, { note: "Checked it myself" });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: "approved", creditedCents: 600_000, decidedBy: { id: manager.staffId }, firstReviewedBy: { id: agent.staffId }, checked: { first: FIRST, second: SECOND }, needsSecondApproval: true });
    expect(done.body.notes.map((n: { stage: string }) => n.stage)).toEqual(["first_approval", "second_approval"]);
    expect(await available(clientId)).toBe(600_000);
    expect(await credits(d.id)).toBe(1);
    expect((await events(clientId)).map((e) => e.event)).toEqual(["deposit.approved"]);
    expect((await audits("deposit.approved", d.id))[0]!.meta_json).toMatchObject({ stage: "second", firstReviewer: { id: agent.staffId, name: "agent" }, internalNote: "Checked it myself" });
    expect((await secondApprove(manager2, d.id)).status).toBe(400);

    // The person who gave the first approval never gives the second.
    const big = await makeDeposit(clientId, usdBank, { amountMinor: 700_000 });
    await openProof(manager, big.id);
    expect((await approve(manager, big.id, { receivedAmount: "7000" })).body.status).toBe("second_approval");
    const own = await secondApprove(manager, big.id);
    expect([own.status, own.body.error.message]).toEqual([403, "You gave the first approval, so another person must give the second."]);
    expect((await detail(manager, big.id)).can.secondApprove.ok).toBe(false);
    expect((await post(manager, "/api/staff/deposits/next", { stage: "second" })).body.id).not.toBe(big.id);
    expect(await credits(big.id)).toBe(0);
    // A deposit claimed under the limit but found above it also needs the second approval.
    const under = await makeDeposit(clientId, usdBank, { amountMinor: 10_000 });
    await openProof(agent, under.id);
    expect((await approve(agent, under.id, { receivedAmount: "5000.01", note: "The client entered the wrong amount" })).body.status).toBe("second_approval");
    expect(await verifyLedger(env.db)).toEqual([]);
  });

  it("sends a deposit back to the first step, and rejects from either step", async () => {
    const clientId = await makeClient();
    const d = await makeDeposit(clientId, usdBank, { amountMinor: 800_000 });
    await openProof(agent, d.id);
    const ref = bankRef();
    expect((await approve(agent, d.id, { receivedAmount: "8000", bankReference: ref })).body.status).toBe("second_approval");
    expect((await post(manager, url(d.id, "/return"), {})).status).toBe(400);
    expect((await post(agent, url(d.id, "/return"), { note: "Wrong reference entered" })).status).toBe(403);
    const back = await post(manager, url(d.id, "/return"), { note: "The reference is from another payment" });
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({
      status: "pending", stage: "first", receivedMinor: null, senderName: null, bankReference: null, receivedOn: null, firstReviewedBy: null, checked: { first: null, second: null },
      sentBack: true, needsSecondApproval: true,
    });
    expect(back.body.warnings).toContainEqual({ tone: "info", text: "Needs a second approval from another person. It was sent back from the second approval, so this applies whatever the amount." });
    expect(back.body.notes.at(-1)).toMatchObject({ byName: "manager", stage: "returned", text: "The reference is from another payment" });
    expect((await audits("deposit.returned", d.id))[0]!.before_json).toMatchObject({ status: "second_approval", receivedMinor: 800_000, bankReference: ref });
    expect((await post(manager, url(d.id, "/return"), { note: "Again please" })).status).toBe(400);
    // The person who sent it back may give the first approval, but then someone else gives the second.
    await openProof(manager, d.id);
    expect((await approve(manager, d.id, { receivedAmount: "8000", bankReference: ref })).body.status).toBe("second_approval");
    expect((await secondApprove(manager, d.id)).status).toBe(403);
    await openProof(manager2, d.id);
    expect((await secondApprove(manager2, d.id)).body.status).toBe("approved");
    expect(await credits(d.id)).toBe(1);

    // Once sent back, it stays a two-person decision even if the amount found is under the limit.
    const again = await makeDeposit(await makeClient(), usdBank, { amountMinor: 600_000 });
    await openProof(agent, again.id);
    expect((await approve(agent, again.id, { receivedAmount: "6000" })).body.status).toBe("second_approval");
    expect((await post(manager, url(again.id, "/return"), { note: "Check the amount on the statement" })).status).toBe(200);
    // A first reviewer cannot reject it either: the client could then send it again as a fresh one-person request.
    const refused = "This deposit was sent back from the second approval, so only staff who give second approvals can reject it.";
    expect((await reject(agent, again.id)).body.error.message).toBe(refused);
    expect((await detail(agent, again.id)).can.reject).toEqual({ ok: false, reason: refused });
    await openProof(manager, again.id);
    expect((await approve(manager, again.id, { receivedAmount: "5000", note: "Statement shows 5,000" })).body.status).toBe("second_approval");
    expect(await credits(again.id)).toBe(0);
    expect((await secondApprove(manager, again.id)).status).toBe(403);
    expect((await reject(manager2, again.id)).status).toBe(200);

    // Rejecting a waiting deposit tells the client why.
    const waiting = await makeDeposit(clientId, pkrBank, { currency: "PKR", amountMinor: 2_800_000 });
    expect((await reject(agent, waiting.id, "See https://example.com")).status).toBe(400);
    expect((await reject(agent, waiting.id, "No")).status).toBe(400);
    // The app shows a reason as written only up to 240 characters and without words it takes for error text.
    const reasonError = async (reason: string) => (await reject(agent, waiting.id, reason)).body.error.details[0].message;
    expect(await reasonError(`${DEPOSIT_REJECT_REASONS[0]} ${"Please send the full statement page. ".repeat(4)}`)).toBe("Keep the reason to 240 characters; the app shows no more.");
    expect(await reasonError("We cannot make an exception for third-party payments.")).toBe('Reword the reason: the app hides reasons with words like "exception" or text like "at Bank(".');
    const rejected = await reject(agent, waiting.id, DEPOSIT_REJECT_REASONS[0]);
    expect(rejected.body).toMatchObject({ status: "rejected", rejectReason: DEPOSIT_REJECT_REASONS[0], decidedBy: { id: agent.staffId }, stage: null });
    expect((await reject(agent, waiting.id)).body.error.message).toBe("This deposit was already rejected by agent.");
    expect((await bells(clientId)).at(-1)).toEqual({ type: "deposit", title: "Your deposit request was not approved", body: DEPOSIT_REJECT_REASONS[0], link: "/transactions" });
    const mail = (await emails(clientId)).at(-1)!;
    expect(mail.template).toBe("deposit_rejected");
    expect(mail.body_text).toContain(`We could not approve your deposit request ${waiting.reference} for PKR 28,000.00.`);
    expect(mail.body_text).toContain(`Reason: ${DEPOSIT_REJECT_REASONS[0]}`);

    // Rejecting at the second step frees the bank reference for the payment's real deposit.
    const wrong = await makeDeposit(clientId, usdBank, { amountMinor: 900_000 });
    await openProof(agent, wrong.id);
    const shared = bankRef();
    expect((await approve(agent, wrong.id, { receivedAmount: "9000", bankReference: shared })).body.status).toBe("second_approval");
    const right = await makeDeposit(clientId, usdBank, { amountMinor: 9_000 });
    await openProof(agent, right.id);
    expect((await approve(agent, right.id, { receivedAmount: "90", bankReference: shared })).status).toBe(409);
    expect((await post(manager, url(wrong.id, "/reject"), { reason: DEPOSIT_REJECT_REASONS[4], note: "Belongs to another request" })).body.status).toBe("rejected");
    expect((await audits("deposit.rejected", wrong.id))[0]!.meta_json).toMatchObject({ stage: "second", reason: DEPOSIT_REJECT_REASONS[4], internalNote: "Belongs to another request" });
    expect((await approve(agent, right.id, { receivedAmount: "90", bankReference: shared })).body.status).toBe("approved");
    expect(await credits(wrong.id)).toBe(0);
    expect((await events(clientId)).map((e) => e.event)).toEqual(["deposit.approved", "deposit.rejected", "deposit.rejected", "deposit.approved"]);
    expect(await verifyLedger(env.db)).toEqual([]);
  });

  it("never credits one bank payment twice", async () => {
    const clientId = await makeClient();
    const a = await makeDeposit(clientId, usdBank);
    const b = await makeDeposit(clientId, usdBank);
    await openProof(agent, a.id);
    await openProof(agent, b.id);
    expect((await approve(agent, a.id, { bankReference: "FT-2401 9988" })).status).toBe(200);
    // Spaces, dashes and case do not make it a different reference.
    const again = await approve(agent, b.id, { bankReference: "ft24019988" });
    expect([again.status, again.body.error.message]).toEqual([409, `This bank reference was already used for deposit ${a.reference}.`]);
    expect(await status(b.id)).toBe("pending");
    // The same text on another method's account is a warning for the reviewer, not a block.
    const c = await makeDeposit(clientId, pkrBank, { currency: "PKR", amountMinor: 28_000 });
    await openProof(agent, c.id);
    const other = await approve(agent, c.id, { receivedAmount: "280", bankReference: "FT 2401-9988" });
    expect(other.status).toBe(200);
    expect(other.body.warnings).toContainEqual({ tone: "bad", text: `This bank reference was also entered on deposit ${a.reference}.`, href: `/deposits/${a.id}` });
    // Two clients' deposits approved at the same moment with one reference: the database lets only one through.
    const [x, y] = await Promise.all([makeClient(), makeClient()]);
    const dx = await makeDeposit(x, usdBank);
    const dy = await makeDeposit(y, usdBank);
    await openProof(agent, dx.id);
    await openProof(agent2, dy.id);
    const race = await Promise.all([approve(agent, dx.id, { bankReference: "RACE-77" }), approve(agent2, dy.id, { bankReference: "race 77" })]);
    expect(race.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await credits(dx.id)) + (await credits(dy.id))).toBe(1);
    expect(await verifyLedger(env.db)).toEqual([]);
  });

  it("stops money moving for frozen, closed and unverified accounts, but still allows rejecting", async () => {
    const frozen = await makeClient({ status: "frozen" });
    const d = await makeDeposit(frozen, usdBank);
    await openProof(agent, d.id);
    const shown = await detail(agent, d.id);
    expect(shown.can.approve).toEqual({ ok: false, reason: "This account is frozen, so money cannot move until it is unfrozen. You can still reject." });
    expect(shown.can.reject.ok).toBe(true);
    expect(shown.warnings[0]).toEqual({ tone: "bad", text: "This account is frozen, so money cannot move until it is unfrozen. You can still reject." });
    expect((await approve(agent, d.id)).body.error.message).toBe("This account is frozen, so money cannot move until it is unfrozen. You can still reject.");
    expect((await reject(agent, d.id)).body.status).toBe("rejected");

    const unverified = await makeClient({ kyc: "pending" });
    const u = await makeDeposit(unverified, usdBank, { amountMinor: 700_000 });
    await openProof(agent, u.id);
    expect((await approve(agent, u.id, { receivedAmount: "7000" })).body.error.message).toBe("This client's KYC is not approved, so money cannot move. You can still reject.");
    // Approved first, then the account was frozen: the second approval is blocked too.
    const later = await makeClient();
    const l = await makeDeposit(later, usdBank, { amountMinor: 700_000 });
    await openProof(agent, l.id);
    expect((await approve(agent, l.id, { receivedAmount: "7000" })).body.status).toBe("second_approval");
    await exec(env.db, "UPDATE clients SET status = 'frozen' WHERE id = ?", [later]);
    await openProof(manager, l.id);
    expect((await secondApprove(manager, l.id)).status).toBe(400);
    expect((await post(manager, url(l.id, "/reject"), { reason: DEPOSIT_REJECT_REASONS[1] })).body.status).toBe("rejected");

    // Closed accounts never come up from "Start reviewing".
    const closed = await makeClient({ status: "closed" });
    const c = await makeDeposit(closed, usdBank, { hoursOld: 500 });
    const picked: number[] = [];
    for (let i = 0; i < 30; i++) {
      const next = (await post(agent2, "/api/staff/deposits/next", { stage: "first", skip: picked })).body.id as number | null;
      if (!next) break;
      picked.push(next);
    }
    expect(picked).not.toContain(c.id);
    for (const id of picked) await post(agent2, url(id, "/release"), {});
    expect(await credits(d.id) + (await credits(u.id)) + (await credits(l.id))).toBe(0);
  });

  it("warns about shared proofs, editors, name mismatches and new clients", async () => {
    const proof = await screenshot();
    const ali = await makeClient({ first: "Ali", last: "Khan", hoursOld: 2, assignedTo: scoped.staffId });
    const sara = await makeClient({ first: "Sara", last: "Ahmed", assignedTo: manager.staffId });
    const first = await makeDeposit(sara, usdBank, { proof });
    const d = await makeDeposit(ali, usdBank, { proof, editor: "Adobe Photoshop", amountMinor: 600_000 });
    const texts = async (s: SignedIn, id: number) => ((await detail(s, id)).warnings as { tone: string; text: string; href?: string }[]);
    const seen = await texts(agent, d.id);
    expect(seen).toContainEqual({ tone: "bad", text: `The same screenshot was also sent by Sara Ahmed (client ${sara}).`, href: `/clients/${sara}` });
    expect(seen).toContainEqual({ tone: "warn", text: "The screenshot was saved by Adobe Photoshop. Check it closely for signs of editing." });
    expect(seen).toContainEqual({ tone: "warn", text: "The client registered less than 24 hours ago." });
    expect(seen).toContainEqual({ tone: "warn", text: "This is the client's first deposit." });
    expect(seen).toContainEqual({ tone: "info", text: "Needs a second approval from another person." });
    expect(seen.map((w) => w.tone)).toEqual([...seen.map((w) => w.tone)].sort((a, b) => ["bad", "warn", "info"].indexOf(a) - ["bad", "warn", "info"].indexOf(b)));
    // A reviewer who may not see the other client is not told who it is.
    const hidden = await texts(scoped, d.id);
    expect(hidden).toContainEqual({ tone: "bad", text: "The same screenshot was also sent by another client." });
    expect(JSON.stringify(hidden)).not.toContain("Sara");
    // The other client's deposit warns the other way round.
    expect((await texts(agent, first.id)).map((w) => w.text)).toContain(`The same screenshot was also sent by Ali Khan (client ${ali}).`);
    const listed = (await agent.agent.get(`/api/staff/deposits?clientId=${ali}`)).body.items[0];
    expect(listed.warningCount).toBe(4);

    // What the first reviewer entered is checked against the verified name and the claim.
    await openProof(agent, d.id);
    expect((await approve(agent, d.id, { receivedAmount: "5900", senderName: "Imran Qureshi", note: "Paid by a relative?" })).body.status).toBe("second_approval");
    const after = await texts(manager, d.id);
    expect(after).toContainEqual({ tone: "warn", text: "The sender name does not match the client's verified name." });
    expect(after).toContainEqual({ tone: "warn", text: "The amount that arrived (USD 5,900.00) differs from what the client entered (USD 6,000.00)." });
    expect((await audits("deposit.first_approved", d.id))[0]!.meta_json.warnings).toContain("The sender name does not match the client's verified name.");
    const close = await makeDeposit(sara, usdBank);
    await openProof(agent, close.id);
    expect((await approve(agent, close.id, { senderName: "Sara Begum Ahmed" })).body.warnings).toContainEqual({ tone: "info", text: "The sender name is close to the client's verified name, but not the same." });

    // The same file sent again by the same client, and a KYC document used as a payment proof.
    const again = await makeDeposit(sara, usdBank, { proof: close.proof });
    expect((await texts(agent, again.id)).map((w) => w.text)).toContain(`The client sent the same screenshot before, with deposit ${close.reference}.`);
    const kyc = await exec(env.db, "INSERT INTO kyc_submissions (client_id, category, sub_type, status) VALUES (?, 'identity', 1, 'approved')", [sara]);
    const passport = await screenshot();
    await exec(env.db, "INSERT INTO kyc_documents (submission_id, slot, mime, size_bytes, sha256, bytes_enc) VALUES (?, 1, 'image/png', ?, ?, ?)", [kyc.insertId, passport.length, sha256(passport), Buffer.alloc(40)]);
    const fake = await makeDeposit(sara, usdBank, { proof: passport });
    expect((await texts(agent, fake.id))[0]).toEqual({ tone: "bad", text: "The screenshot is the same file as one of the client's KYC documents, not a payment." });
    const borrowed = await makeDeposit(ali, usdBank, { proof: passport });
    expect((await texts(agent, borrowed.id)).map((w) => w.text)).toContain(`The screenshot is the same file as a KYC document of Sara Ahmed (client ${sara}).`);
    expect((await texts(scoped, borrowed.id)).map((w) => w.text)).toContain("The screenshot is the same file as another client's KYC document.");
    const unassigned = await makeClient({ assignedTo: null });
    const lonely = await makeDeposit(unassigned, usdBank);
    expect((await texts(agent, lonely.id)).map((w) => w.text)).toContain("The client is not assigned to anyone on the team.");
  });

  it("converts rupee deposits at the rate the client was shown", async () => {
    const clientId = await makeClient();
    const d = await makeDeposit(clientId, pkrBank, { currency: "PKR", amountMinor: 28_000_000, rate: "280.000000" });
    // A later rate change does not change what this deposit is worth.
    await exec(env.db, "UPDATE money_settings SET usd_to_pkr = 300 WHERE id = 1");
    await openProof(agent, d.id);
    expect((await detail(agent, d.id))).toMatchObject({ currency: "PKR", amountMinor: 28_000_000, amountCents: 100_000, usdRate: "280.000000", method: { currency: "PKR", iban: "PK36MEZN0001010123456702" } });
    const res = await approve(agent, d.id, { receivedAmount: "280000" });
    expect(res.body).toMatchObject({ status: "approved", receivedMinor: 28_000_000, creditedCents: 100_000 });
    expect((await bells(clientId))[0]!.body).toBe("USD 1,000.00 is now in your wallet.");
    // A different amount arrived: credited at the same rate, rounded down to the cent.
    const short = await makeDeposit(clientId, pkrBank, { currency: "PKR", amountMinor: 28_000_000, rate: "280" });
    await openProof(agent, short.id);
    const odd = await approve(agent, short.id, { receivedAmount: "279000.50", note: "Bank fee taken" });
    expect(odd.body).toMatchObject({ status: "approved", receivedMinor: 27_900_050, creditedCents: 99_643 });
    expect(await available(clientId)).toBe(199_643);
    await exec(env.db, "UPDATE money_settings SET usd_to_pkr = 280 WHERE id = 1");
    expect(await verifyLedger(env.db)).toEqual([]);
  });

  it("never lets whoever set where a deposit was paid, or its rupee rate, approve it alone", async () => {
    const setBy = async (id: number) => (await one<{ who: number | null }>(env.db, "SELECT details_set_by AS who FROM payment_methods WHERE id = ?", [id]))!.who;
    const own = (await post(manager, "/api/staff/money/methods", {
      direction: "deposit", kind: "bank", name: "Faysal Bank", bankName: "Faysal Bank", accountTitle: "BIS Markets Ltd", accountNumber: "7777 8888 99",
    })).body;
    expect(await setBy(own.id)).toBe(manager.staffId);
    const clientId = await makeClient();

    // The person who chose the account: their approval goes to a second person, whatever the amount.
    const d1 = await makeDeposit(clientId, own.id);
    await openProof(manager, d1.id);
    const mine = await detail(manager, d1.id);
    expect(mine.setByYou).toBe(true);
    expect(mine.warnings).toContainEqual({ tone: "info", text: "You set this method's account details, so another person must also approve this deposit, whatever the amount." });
    expect((await approve(manager, d1.id)).body).toMatchObject({ status: "second_approval" });
    expect((await audits("deposit.first_approved", d1.id))[0]!.meta_json).toMatchObject({ reviewerSet: { method: true, rate: false } });
    await openProof(manager2, d1.id);
    const second = await detail(manager2, d1.id);
    expect(second.setByYou).toBe(false);
    expect(second.warnings).toContainEqual({ tone: "warn", text: "The first reviewer set this method's account details. Check that the account is the company's own before approving." });
    expect((await secondApprove(manager2, d1.id)).body).toMatchObject({ status: "approved", creditedCents: 10_000 });

    // Anyone else approves it alone as usual.
    const d2 = await makeDeposit(clientId, own.id);
    await openProof(agent, d2.id);
    expect((await detail(agent, d2.id)).setByYou).toBe(false);
    expect((await approve(agent, d2.id)).body).toMatchObject({ status: "approved" });

    // A wording change keeps who set the account; a new account number moves it to whoever entered it.
    await patch(manager2, `/api/staff/money/methods/${own.id}`, { feeLabel: "Free" });
    expect(await setBy(own.id)).toBe(manager.staffId);
    await patch(manager2, `/api/staff/money/methods/${own.id}`, { accountNumber: "7777 8888 00" });
    expect(await setBy(own.id)).toBe(manager2.staffId);
    const d3 = await makeDeposit(clientId, own.id);
    await openProof(manager, d3.id);
    expect((await approve(manager, d3.id)).body).toMatchObject({ status: "approved" });

    // The same for the rupee rate a deposit was made at.
    const p1 = await makeDeposit(clientId, pkrBank, { currency: "PKR", amountMinor: 2_800_000, rateSetBy: manager2.staffId });
    await openProof(manager2, p1.id);
    expect((await detail(manager2, p1.id)).warnings).toContainEqual({
      tone: "info", text: "You set the rupee rate this deposit uses, so another person must also approve this deposit, whatever the amount.",
    });
    expect((await approve(manager2, p1.id, { receivedAmount: "28000" })).body).toMatchObject({ status: "second_approval" });
    await openProof(manager, p1.id);
    expect((await detail(manager, p1.id)).warnings).toContainEqual({ tone: "warn", text: "The first reviewer set the rupee rate this deposit uses. Check that the rate is right before approving." });
    expect((await secondApprove(manager, p1.id)).body).toMatchObject({ status: "approved", creditedCents: 10_000 });
    const p2 = await makeDeposit(clientId, pkrBank, { currency: "PKR", amountMinor: 2_800_000, rateSetBy: manager2.staffId });
    await openProof(agent, p2.id);
    expect((await approve(agent, p2.id, { receivedAmount: "28000" })).body).toMatchObject({ status: "approved" });
    // A dollar deposit does not use the rate.
    const u = await makeDeposit(clientId, usdBank, { rateSetBy: manager2.staffId });
    await openProof(manager2, u.id);
    expect((await approve(manager2, u.id)).body).toMatchObject({ status: "approved" });
    expect(await available(clientId)).toBe(60_000);
  });

  it("gives each deposit to one reviewer at a time, and audits a take-over", async () => {
    const clientId = await makeClient();
    const d = await makeDeposit(clientId, usdBank, { hoursOld: 900 });
    const claimed = await post(agent, url(d.id, "/claim"), {});
    expect(claimed.body).toMatchObject({ claimedBy: { id: agent.staffId, name: "agent" }, minutes: 15 });
    expect((await post(agent2, url(d.id, "/claim"), {})).status).toBe(409);
    await openProof(agent2, d.id);
    const blocked = await approve(agent2, d.id);
    expect([blocked.status, blocked.body.error.message]).toEqual([409, "agent is reviewing this deposit right now."]);
    expect((await reject(agent2, d.id)).status).toBe(409);
    expect((await detail(agent2, d.id)).can.approve).toEqual({ ok: false, reason: "agent is reviewing this deposit right now." });
    // "Start reviewing" skips what someone else holds.
    const next = (await post(agent2, "/api/staff/deposits/next", {})).body.id;
    expect(next).not.toBe(d.id);
    if (next) await post(agent2, url(next, "/release"), {});
    const taken = await post(agent2, url(d.id, "/claim"), { takeOver: true });
    expect(taken.body.claimedBy.id).toBe(agent2.staffId);
    expect((await audits("deposit.review_taken_over", d.id)).map((a) => [a.actor_id, a.meta_json])).toEqual([[agent2.staffId, { depositId: d.id, reference: d.reference, from: agent.staffId }]]);
    expect((await approve(agent, d.id)).status).toBe(409);
    // Releasing someone else's claim does nothing; releasing your own frees it.
    await post(agent, url(d.id, "/release"), {});
    expect((await detail(agent, d.id)).claimedBy.id).toBe(agent2.staffId);
    await post(agent2, url(d.id, "/release"), {});
    expect((await detail(agent, d.id)).claimedBy).toBeNull();
    // The oldest deposit comes first, and is claimed for the caller.
    expect((await post(agent, "/api/staff/deposits/next", {})).body.id).toBe(d.id);
    expect((await detail(agent2, d.id)).claimedBy.id).toBe(agent.staffId);
    expect((await post(agent, "/api/staff/deposits/next", { release: d.id, skip: [d.id] })).body.id).not.toBe(d.id);
    expect((await detail(agent2, d.id)).claimedBy).toBeNull();
    // A finance agent never gets second approvals; a manager can ask for those only.
    const big = await makeDeposit(clientId, usdBank, { amountMinor: 650_000, hoursOld: 950 });
    await openProof(agent2, big.id);
    expect((await approve(agent2, big.id, { receivedAmount: "6500" })).body.status).toBe("second_approval");
    expect((await post(agent, "/api/staff/deposits/next", { stage: "second" })).body.id).toBeNull();
    expect((await post(manager, "/api/staff/deposits/next", { stage: "second" })).body.id).toBe(big.id);
    await post(manager, url(big.id, "/release"), {});
    const list = (await agent.agent.get("/api/staff/deposits?status=second_approval")).body.items.map((i: { id: number }) => i.id);
    expect(list).toContain(big.id);
    expect((await agent.agent.get(`/api/staff/deposits?q=${big.reference.toLowerCase()}`)).body.items.map((i: { id: number }) => i.id)).toEqual([big.id]);
    expect((await agent.agent.get("/api/staff/deposits?status=bogus")).status).toBe(400);
  });

  it("counts the queue for the badges", async () => {
    const s = (await agent.agent.get("/api/staff/deposits/summary")).body;
    expect(Object.keys(s).sort()).toEqual(["decidedToday", "decidedTodayByMe", "oldestOpenAt", "overdue", "pending", "secondApproval", "secondApprovalForMe"]);
    const open = (await agent.agent.get("/api/staff/deposits?pageSize=100")).body;
    expect(s.pending + s.secondApproval).toBe(open.total);
    expect(s.overdue).toBeGreaterThanOrEqual(1);
    expect(s.decidedTodayByMe).toBeGreaterThanOrEqual(5);
    expect(s.decidedToday).toBeGreaterThanOrEqual(s.decidedTodayByMe);
    expect(new Date(s.oldestOpenAt).getTime()).toBe(new Date(open.items[0].createdAt).getTime());
    expect(s.secondApprovalForMe).toBe(0);
  });

  describe("money settings", () => {
    const settingsUrl = "/api/staff/money/settings";

    it("shows the limits to anyone who works with money", async () => {
      const res = await sales.agent.get(settingsUrl);
      expect(res.body).toEqual({
        minDepositCents: 5000, minWithdrawalCents: 5000, maxWithdrawalCents: null, minTransferCents: 1000, usdToPkr: "280", depositSecondApprovalCents: 500_000,
        withdrawalSecondApprovalCents: 100_000, firstWithdrawalSecondApproval: true, updatedAt: expect.any(String), updatedBy: null,
      });
      expect((await dealing.agent.get(settingsUrl)).status).toBe(403);
    });

    it("lets payment.manage change limits and only settings.manage change the approval thresholds, with 2FA", async () => {
      expect((await patch(agent, settingsUrl, { minDepositCents: 2000 })).status).toBe(403);
      await exec(env.db, "UPDATE staff_sessions SET stepup_at = NULL WHERE staff_id = ?", [manager2.staffId]);
      expect((await patch(manager2, settingsUrl, { minDepositCents: 2000 })).body.error.code).toBe("STEP_UP_REQUIRED");
      // Refused before any 2FA prompt: a finance manager may not lower the four-eyes limits.
      const threshold = await patch(manager2, settingsUrl, { depositSecondApprovalCents: 1_000_000 });
      expect([threshold.status, threshold.body.error.message]).toEqual([403, "Changing the second-approval limits needs the settings.manage permission."]);
      await stepUp(env, manager2);
      expect((await patch(manager2, settingsUrl, { firstWithdrawalSecondApproval: false })).status).toBe(403);
      // Sending a threshold unchanged (as a full form does) is fine.
      const res = await patch(manager2, settingsUrl, { minDepositCents: 2000, usdToPkr: "278.5", depositSecondApprovalCents: 500_000, maxWithdrawalCents: 2_000_000 });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ minDepositCents: 2000, usdToPkr: "278.5", maxWithdrawalCents: 2_000_000, updatedBy: { id: manager2.staffId, name: "manager2" } });
      const audit = await one<{ before_json: unknown; after_json: unknown; entity_type: string; entity_id: string }>(
        env.db,
        "SELECT before_json, after_json, entity_type, entity_id FROM audit_log WHERE action = 'money_settings.updated' ORDER BY id DESC LIMIT 1",
      );
      expect(audit).toEqual({
        entity_type: "money_settings", entity_id: "1",
        before_json: { minDepositCents: 5000, usdToPkr: "280", maxWithdrawalCents: null }, after_json: { minDepositCents: 2000, usdToPkr: "278.5", maxWithdrawalCents: 2_000_000 },
      });
      const rateBy = async () => (await one<{ who: number | null }>(env.db, "SELECT usd_to_pkr_set_by AS who FROM money_settings WHERE id = 1"))!.who;
      expect(await rateBy()).toBe(manager2.staffId);
      // Other changes keep who set the rate.
      expect((await patch(manager, settingsUrl, { minTransferCents: 1500 })).body).toMatchObject({ minTransferCents: 1500, updatedBy: { id: manager.staffId } });
      expect(await rateBy()).toBe(manager2.staffId);
      const thresholds = await patch(boss, settingsUrl, { depositSecondApprovalCents: 400_000, withdrawalSecondApprovalCents: 90_000, firstWithdrawalSecondApproval: false });
      expect(thresholds.body).toMatchObject({ depositSecondApprovalCents: 400_000, withdrawalSecondApprovalCents: 90_000, firstWithdrawalSecondApproval: false });
      expect((await patch(boss, settingsUrl, { depositSecondApprovalCents: 500_000, withdrawalSecondApprovalCents: 100_000, firstWithdrawalSecondApproval: true, usdToPkr: "280" })).status).toBe(200);
      expect(await rateBy()).toBe(boss.staffId);
    });

    it("moves the rupee rate by at most 20% at a time", async () => {
      for (const far of ["28", "2800", "336.01", "233.33"]) {
        const res = await patch(manager, settingsUrl, { usdToPkr: far });
        expect([far, res.status, res.body.error?.details]).toEqual([far, 400, [{ field: "usdToPkr", message: "Change the rate by at most 20% at a time (now 280). For a bigger change, make it in steps." }]]);
      }
      expect((await patch(manager, settingsUrl, { usdToPkr: "336" })).body).toMatchObject({ usdToPkr: "336" });
      expect((await patch(manager, settingsUrl, { usdToPkr: "280" })).body).toMatchObject({ usdToPkr: "280" });
    });

    it("validates every value", async () => {
      for (const bad of [
        { maxWithdrawalCents: 4000 }, { minWithdrawalCents: 3_000_000 }, { usdToPkr: "0" }, { usdToPkr: "280.1234567" }, { usdToPkr: "abc" }, { usdToPkr: 280 }, { usdToPkr: "-1" },
        { minDepositCents: 10.5 }, { minDepositCents: 0 }, { minDepositCents: "5000" }, { depositSecondApprovalCents: -1 }, { colour: "red" }, { firstWithdrawalSecondApproval: "yes" },
      ]) {
        const res = await patch(boss, settingsUrl, bad);
        expect([JSON.stringify(bad), res.status]).toEqual([JSON.stringify(bad), 400]);
      }
      expect((await sales.agent.get(settingsUrl)).body).toMatchObject({ minDepositCents: 2000, maxWithdrawalCents: 2_000_000, usdToPkr: "280" });
    });
  });

  describe("payment methods", () => {
    const methods = "/api/staff/money/methods";
    const bank = { direction: "deposit", kind: "bank", name: "HBL", currency: "PKR", bankName: "Habib Bank", accountTitle: "BIS Markets", accountNumber: "1234 5678 90", iban: "PK36HABB0001234567890" };
    const fields = (res: { body: { error?: { details?: { field: string }[] } } }) => (res.body.error?.details ?? []).map((d) => d.field);

    it("creates methods with the fields each kind needs, refusing names the portal would misread", async () => {
      expect((await post(agent, methods, bank)).status).toBe(403);
      await exec(env.db, "UPDATE staff_sessions SET stepup_at = NULL WHERE staff_id = ?", [manager.staffId]);
      expect((await post(manager, methods, bank)).body.error.code).toBe("STEP_UP_REQUIRED");
      await stepUp(env, manager);
      const created = await post(manager, methods, { ...bank, amountNote: "Send from your own account.", feeLabel: "Free", processingLabel: "Within 1 hour", minMinor: 500_000, walletAddress: "ignored" });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        direction: "deposit", kind: "bank", name: "HBL", currency: "PKR", network: "", bankName: "Habib Bank", accountTitle: "BIS Markets", accountNumber: "1234 5678 90",
        iban: "PK36HABB0001234567890", walletAddress: "", hasQr: false, qrUrl: null, amountNote: "Send from your own account.", feeLabel: "Free", processingLabel: "Within 1 hour",
        minMinor: 500_000, askQr: false, isEnabled: true, sortOrder: 0, usage: { open: 0, total: 0 },
      });
      const audit = await one<{ entity_type: string; after_json: Record<string, unknown> }>(env.db, "SELECT entity_type, after_json FROM audit_log WHERE action = 'payment_method.created' AND entity_id = ?", [String(created.body.id)]);
      expect(audit).toMatchObject({ entity_type: "payment_method", after_json: { accountNumber: "1234 5678 90", bankName: "Habib Bank", currency: "PKR" } });

      expect(fields(await post(manager, methods, { ...bank, accountNumber: "" }))).toEqual(["accountNumber"]);
      expect(fields(await post(manager, methods, { direction: "deposit", kind: "bank", name: "X" }))).toEqual(["name", "bankName", "accountTitle", "accountNumber"]);
      expect(fields(await post(manager, methods, { ...bank, name: "<b>Bank</b>" }))).toEqual(["name"]);
      expect(fields(await post(manager, methods, { ...bank, amountNote: "Pay at www.example.com" }))).toEqual(["amountNote"]);
      expect(fields(await post(manager, methods, { ...bank, accountNumber: "12<3456>" }))).toEqual(["accountNumber"]);
      expect((await post(manager, methods, { ...bank, direction: "both" })).status).toBe(400);
      expect((await post(manager, methods, { ...bank, secret: 1 })).status).toBe(400);
      expect(fields(await post(manager, methods, { direction: "deposit", kind: "crypto", name: "USDT", currency: "PKR", network: "trc20", walletAddress: TRC20 }))).toEqual(["currency"]);
      expect(fields(await post(manager, methods, { direction: "deposit", kind: "crypto", name: "USDT", walletAddress: TRC20 }))).toEqual(["network"]);
      expect(fields(await post(manager, methods, { direction: "deposit", kind: "crypto", name: "USDT", network: "trc20", walletAddress: "0x1234" }))).toEqual(["walletAddress"]);
      expect(fields(await post(manager, methods, { direction: "deposit", kind: "crypto", name: "USDT", network: "bep20", walletAddress: TRC20 }))).toEqual(["walletAddress"]);
      const usdt = await post(manager, methods, { direction: "deposit", kind: "crypto", name: "USDT (TRC20)", network: "trc20", walletAddress: TRC20, bankName: "dropped" });
      expect(usdt.body).toMatchObject({ kind: "crypto", network: "trc20", walletAddress: TRC20, bankName: "", currency: "USD" });

      // Payout types: the portal and app pick the form by name.
      expect(fields(await post(manager, methods, { direction: "withdrawal", kind: "bank", name: "Local payout" }))).toEqual(["name"]);
      expect((await post(manager, methods, { direction: "withdrawal", kind: "bank", name: "Bank transfer", accountNumber: "999999", minMinor: 100 })).body).toMatchObject({ name: "Bank transfer", accountNumber: "", minMinor: null, currency: "USD" });
      expect((await post(manager, methods, { direction: "withdrawal", kind: "bank", name: "International wire" })).status).toBe(201);
      expect(fields(await post(manager, methods, { direction: "withdrawal", kind: "bank", name: "Bank transfer", currency: "PKR" }))).toEqual(["currency"]);
      expect(fields(await post(manager, methods, { direction: "withdrawal", kind: "crypto", name: "USDT", network: "trc20" }))).toEqual(["name"]);
      expect(fields(await post(manager, methods, { direction: "withdrawal", kind: "crypto", name: "USDT BEP20", network: "trc20" }))).toEqual(["name"]);
      expect(fields(await post(manager, methods, { direction: "withdrawal", kind: "crypto", name: "Bank TRC20", network: "trc20" }))).toEqual(["name"]);
      // The portal matches "usdttrc20" in the name with spaces removed, so "TRC20" alone or "USDT-TRC20" would show the wrong form.
      expect(fields(await post(manager, methods, { direction: "withdrawal", kind: "crypto", name: "TRC20", network: "trc20" }))).toEqual(["name"]);
      expect(fields(await post(manager, methods, { direction: "withdrawal", kind: "crypto", name: "USDT-TRC20", network: "trc20" }))).toEqual(["name"]);
      expect(fields(await post(manager, methods, { direction: "withdrawal", kind: "crypto", name: "BEP20", network: "bep20" }))).toEqual(["name"]);
      expect(fields(await post(manager, methods, { direction: "withdrawal", kind: "crypto", name: "USDT BEP20 (not USDT TRC20)", network: "bep20" }))).toEqual(["name"]);
      expect(fields(await post(manager, methods, { direction: "withdrawal", kind: "crypto", name: "USDT TRC20" }))).toEqual(["network"]);
      expect((await post(manager, methods, { direction: "withdrawal", kind: "crypto", name: "USDT TRC20", network: "trc20", askQr: true })).body).toMatchObject({ askQr: true, network: "trc20" });
      expect((await post(manager, methods, { direction: "withdrawal", kind: "crypto", name: "Binance Pay", network: "binance_pay" })).status).toBe(201);

      const list = (await sales.agent.get(methods)).body.items as { id: number; direction: string; sortOrder: number }[];
      expect(list.map((m) => m.direction)).toEqual([...list.map((m) => m.direction)].sort());
      expect(list.find((m) => m.id === usdBank)).toMatchObject({ usage: { open: expect.any(Number), total: expect.any(Number) } });
      expect((await dealing.agent.get(methods)).status).toBe(403);
    });

    it("updates methods strictly: no change of direction or kind, and no new account while deposits wait", async () => {
      const m = (await post(manager, methods, { ...bank, name: "UBL", currency: "USD" })).body;
      expect((await patch(manager, `${methods}/${m.id}`, { direction: "withdrawal" })).status).toBe(400);
      expect((await patch(manager, `${methods}/${m.id}`, { kind: "crypto" })).status).toBe(400);
      expect(fields(await patch(manager, `${methods}/${m.id}`, { accountTitle: "" }))).toEqual(["accountTitle"]);
      const moved = await patch(manager, `${methods}/${m.id}`, { accountNumber: "5555 0000 11", sortOrder: 5 });
      expect(moved.body).toMatchObject({ accountNumber: "5555 0000 11", sortOrder: 5 });
      const audit = await one<{ before_json: unknown; after_json: unknown; meta_json: unknown }>(env.db, "SELECT before_json, after_json, meta_json FROM audit_log WHERE action = 'payment_method.updated' AND entity_id = ? ORDER BY id DESC LIMIT 1", [String(m.id)]);
      expect(audit).toEqual({ before_json: { accountNumber: "1234 5678 90", sortOrder: 0 }, after_json: { accountNumber: "5555 0000 11", sortOrder: 5 }, meta_json: expect.objectContaining({ accountChanged: true }) });
      const clientId = await makeClient();
      const d = await makeDeposit(clientId, m.id);
      expect((await manager.agent.get(methods)).body.items.find((x: { id: number }) => x.id === m.id).usage).toEqual({ open: 1, total: 1 });
      expect((await patch(manager, `${methods}/${m.id}`, { iban: "PK00HABB0009999999999" })).status).toBe(409);
      // Disabling and wording changes are fine at any time; the waiting deposit keeps its method.
      const off = await patch(manager, `${methods}/${m.id}`, { isEnabled: false, feeLabel: "Bank fees apply" });
      expect(off.body).toMatchObject({ isEnabled: false, feeLabel: "Bank fees apply" });
      expect((await detail(agent, d.id)).method.id).toBe(m.id);
      // An older row that would not pass today's checks can still be switched off, but not edited until fixed.
      const legacy = await makeMethod({ direction: "withdrawal", name: "Payout", bank_name: "", account_title: "", account_number: "" });
      expect((await patch(manager, `${methods}/${legacy}`, { isEnabled: false })).body).toMatchObject({ isEnabled: false, name: "Payout" });
      expect(fields(await patch(manager, `${methods}/${legacy}`, { feeLabel: "Free" }))).toEqual(["name"]);
      expect((await patch(manager, `${methods}/${legacy}`, { name: "Bank payout", isEnabled: true })).body).toMatchObject({ name: "Bank payout", isEnabled: true });
      expect((await patch(manager, `${methods}/999999`, { isEnabled: false })).status).toBe(404);
      expect((await patch(agent, `${methods}/${m.id}`, { isEnabled: true })).status).toBe(403);
    });

    it("draws a crypto deposit method's QR code from its own address and redraws it with the address", async () => {
      const decode = async (png: Buffer) => {
        const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        return jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), info.width, info.height)?.data;
      };
      const trc = "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE";
      const res = await post(manager, methods, { direction: "deposit", kind: "crypto", name: "USDT TRC20", network: "trc20", walletAddress: trc });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ hasQr: true, qrUrl: expect.stringMatching(new RegExp(`^/api/staff/money/methods/${res.body.id}/qr\\?v=[0-9a-f]{12}$`)) });
      const token = (await one<{ qr_token: string }>(env.db, "SELECT qr_token FROM payment_methods WHERE id = ?", [res.body.id]))!.qr_token;
      expect(token).toMatch(/^[0-9a-f]{32}$/);
      expect(JSON.stringify(res.body)).not.toContain(token);
      const shown = await sales.agent.get(res.body.qrUrl).buffer(true);
      expect(shown.status).toBe(200);
      expect(shown.headers["content-type"]).toBe("image/png");
      expect(shown.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
      expect(shown.headers["x-content-type-options"]).toBe("nosniff");
      expect(await decode(shown.body as Buffer)).toBe(trc);
      expect((await dealing.agent.get(res.body.qrUrl)).status).toBe(403);
      // Clients get the same picture, and nobody can put another one in its place.
      const forClients = await request(env.app).get(`/api/payment-qr/${token}`).buffer(true);
      expect(await decode(forClients.body as Buffer)).toBe(trc);
      const picture = await QRCode.toBuffer(`tron:TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf?note=${trc}`, { width: 300 });
      const upload = await manager.agent.post(`${methods}/${res.body.id}/qr`).set("Origin", ORIGIN).set("X-CSRF-Token", manager.csrf).set("Content-Type", "image/png").send(picture);
      expect(upload.status).toBe(404);
      expect((await del(manager, `${methods}/${res.body.id}/qr`)).status).toBe(404);

      // A new address is drawn under a new link; the old link stops working.
      const other = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";
      const moved = await patch(manager, `${methods}/${res.body.id}`, { walletAddress: other });
      expect(moved.body).toMatchObject({ walletAddress: other, hasQr: true });
      expect(moved.body.qrUrl).not.toBe(res.body.qrUrl);
      expect((await request(env.app).get(`/api/payment-qr/${token}`)).status).toBe(404);
      expect(await decode((await sales.agent.get(moved.body.qrUrl).buffer(true)).body as Buffer)).toBe(other);
      const audit = await one<{ meta_json: Record<string, unknown> }>(env.db, "SELECT meta_json FROM audit_log WHERE action = 'payment_method.updated' AND entity_id = ? ORDER BY id DESC LIMIT 1", [String(res.body.id)]);
      expect(audit!.meta_json).toMatchObject({ accountChanged: true, qrRedrawn: true });
      // Wording changes keep the picture and its link.
      expect((await patch(manager, `${methods}/${res.body.id}`, { feeLabel: "Network fee only" })).body.qrUrl).toBe(moved.body.qrUrl);

      const bep = "0x52908400098527886E0F7030069857D2E4169EE7";
      const bsc = (await post(manager, methods, { direction: "deposit", kind: "crypto", name: "USDT BEP20", network: "bep20", walletAddress: bep })).body;
      expect(await decode((await sales.agent.get(bsc.qrUrl).buffer(true)).body as Buffer)).toBe(bep);
      // A Pay ID is typed, not scanned; bank accounts have no QR code.
      expect((await post(manager, methods, { direction: "deposit", kind: "crypto", name: "Binance Pay", network: "binance_pay", walletAddress: "123456789" })).body).toMatchObject({ hasQr: false, qrUrl: null });
      expect((await post(manager, methods, { ...bank, name: "HBL QR test" })).body).toMatchObject({ hasQr: false, qrUrl: null });
    });

    it("keeps a payout type's network while clients have accounts saved under it", async () => {
      const type = (await post(manager, methods, { direction: "withdrawal", kind: "crypto", name: "USDT TRC20", network: "trc20" })).body;
      expect((await patch(manager, `${methods}/${type.id}`, { name: "USDT BEP20", network: "bep20" })).body).toMatchObject({ network: "bep20" });
      const clientId = await makeClient();
      await exec(env.db, "INSERT INTO client_payout_methods (client_id, payment_method_id, method_name, account_number_enc, fingerprint) VALUES (?, ?, 'Mine', ?, ?)", [clientId, type.id, Buffer.from("x"), "f".repeat(64)]);
      const refused = await patch(manager, `${methods}/${type.id}`, { name: "USDT TRC20", network: "trc20" });
      expect([refused.status, refused.body.error.message]).toEqual([409, "Clients have accounts saved under this payout type. Add a new type for the other network and disable this one."]);
      // Other changes are fine.
      expect((await patch(manager, `${methods}/${type.id}`, { name: "USDT BEP20 (BSC)", isEnabled: false })).body).toMatchObject({ name: "USDT BEP20 (BSC)", isEnabled: false });
    });
  });

  describe("client wallets", () => {
    it("shows a client's balances and latest entries to wallet.view, within their scope", async () => {
      const clientId = await makeClient({ assignedTo: scoped.staffId });
      const d = await makeDeposit(clientId, usdBank, { amountMinor: 4_200 });
      await openProof(agent, d.id);
      await approve(agent, d.id, { receivedAmount: "42" });
      await makeDeposit(clientId, usdBank);
      const res = await agent.agent.get(`/api/staff/money/clients/${clientId}/wallet`);
      expect(res.body).toEqual({
        walletKey: expect.stringMatching(/^w[0-9a-f]{20}$/), availableCents: 4_200, heldCents: 0, currency: "USD",
        totals: { depositedCents: 4_200, withdrawnCents: 0, pendingDeposits: 1, openWithdrawals: 0 },
        entries: [{ at: expect.any(String), kind: "deposit", account: "wallet", amountCents: 4_200, reference: d.reference, sourceType: "deposit", sourceId: d.id }],
      });
      expect((await scoped.agent.get(`/api/staff/money/clients/${clientId}/wallet`)).status).toBe(200);
      const elsewhere = await makeClient();
      expect((await scoped.agent.get(`/api/staff/money/clients/${elsewhere}/wallet`)).status).toBe(404);
      // Created on first look for a client with no money yet.
      expect((await agent.agent.get(`/api/staff/money/clients/${elsewhere}/wallet`)).body).toMatchObject({ availableCents: 0, entries: [] });
      expect((await sales.agent.get(`/api/staff/money/clients/${clientId}/wallet`)).status).toBe(403);
      expect((await agent.agent.get("/api/staff/money/clients/99999999/wallet")).status).toBe(404);
    });
  });

  it("keeps working when more decisions arrive at once than there are database connections", async () => {
    // Each decision holds one connection for its transaction and must never need a second one.
    const ids: number[] = [];
    for (let i = 0; i < 25; i++) ids.push((await makeDeposit(await makeClient(), usdBank)).id);
    await stepUp(env, agent);
    const answers = await Promise.all(ids.map((id) => reject(agent, id)));
    expect(answers.map((a) => a.status)).toEqual(ids.map(() => 200));
    for (const id of ids) expect(await status(id)).toBe("rejected");
  }, 30_000);

  it("leaves the ledger consistent", async () => {
    expect(await verifyLedger(env.db)).toEqual([]);
  });
});
