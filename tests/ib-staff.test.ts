import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClientSession } from "../src/server/clients/session";
import { exec, one, rows } from "../src/server/lib/db";
import { IB_CHECKLIST, IB_REJECT_REASONS } from "../src/server/ib/review";
import { createStaff, hasDb, post, setup, signIn, stepUp, type SignedIn, type TestEnv } from "./helpers";

const DAY = 86_400_000;
const ALL = IB_CHECKLIST.review.map((i) => i.key);
const A = (id: number) => `/api/staff/ib/applications/${id}`;
const NOT_FOUND = "That application does not exist or its client is not assigned to you.";
const FOUR_EYES = "You set up this client's account or KYC, so another person must approve their IB application.";
const REASON = IB_REJECT_REASONS[1]!;

describe.skipIf(!hasDb)("staff IB applications and partners", () => {
  let env: TestEnv;
  let boss: SignedIn;
  let admin: SignedIn;
  let admin2: SignedIn;
  let compliance: SignedIn;
  let reviewer: SignedIn;
  let scoped: SignedIn;
  let support: SignedIn;
  let noStepUp: SignedIn;
  let depositMethod = 0;
  let seq = 0;
  const api = () => request(env.app);

  // ---- Seeding by direct inserts, as the client API would leave things ----

  interface ClientOpts {
    first?: string;
    last?: string;
    status?: string;
    kyc?: string;
    assigned?: number | null;
    createdBy?: number | null;
    referredBy?: number | null;
    createdAt?: Date;
    ip?: string;
    dob?: string | null;
    verified?: boolean;
    kycUploadedBy?: number | null;
  }

  async function makeClient(o: ClientOpts = {}) {
    seq++;
    const r = await exec(
      env.db,
      `INSERT INTO clients (email, first_name, last_name, referral_code, source, status, kyc_status, assigned_staff_id, created_by_staff_id, referred_by, created_at, created_ip, last_login_ip,
         dob, email_verified_at, country) VALUES (?, ?, ?, ?, 'portal', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pakistan')`,
      [
        `ibs${seq}@client.test`, o.first ?? "Ann", o.last ?? `Lee${seq}`, `IBS${String(seq).padStart(6, "0")}`, o.status ?? "active", o.kyc ?? "approved", o.assigned ?? null, o.createdBy ?? null,
        o.referredBy ?? null, o.createdAt ?? new Date(Date.now() - 60 * DAY), o.ip ?? `10.0.${Math.floor(seq / 250)}.${seq % 250}`, o.ip ?? null, o.dob ?? null,
        o.verified === false ? null : new Date(Date.now() - 50 * DAY),
      ],
    );
    if ((o.kyc ?? "approved") === "approved") {
      for (const category of ["identity", "address"]) {
        await exec(
          env.db,
          "INSERT INTO kyc_submissions (client_id, category, sub_type, source, uploaded_by, status, decided_at) VALUES (?, ?, 1, ?, ?, 'approved', CURRENT_TIMESTAMP(3))",
          [r.insertId, category, o.kycUploadedBy ? "staff" : "client", o.kycUploadedBy ?? null],
        );
      }
    }
    return r.insertId;
  }

  async function apply(clientId: number, submittedAt = new Date(Date.now() - 2 * DAY)) {
    const r = await exec(env.db, "INSERT INTO ib_applications (client_id, terms_version, submitted_at, submitted_ip) VALUES (?, '2026-10', ?, '203.0.113.50')", [clientId, submittedAt]);
    return r.insertId;
  }
  async function deposit(clientId: number, cents: number) {
    seq++;
    await exec(env.db, "INSERT IGNORE INTO wallets (client_id, wallet_key) VALUES (?, ?)", [clientId, `ibsw${clientId}`]);
    const wallet = (await one<{ id: number }>(env.db, "SELECT id FROM wallets WHERE client_id = ?", [clientId]))!;
    await exec(
      env.db,
      `INSERT INTO deposits (reference, client_id, wallet_id, payment_method_id, method_name, status, currency, amount_minor, usd_rate, amount_cents, credited_cents, decided_at)
       VALUES (?, ?, ?, ?, 'Bank transfer', 'approved', 'USD', ?, 1, ?, ?, ?)`,
      [`DIBS${seq}`, clientId, wallet.id, depositMethod, cents, cents, cents, new Date(Date.now() - DAY)],
    );
  }
  const loginFrom = (clientId: number, ip: string) => createClientSession(env.db, env.config, clientId, ip, "vitest");
  const statusOf = async (id: number) => (await one<{ status: string }>(env.db, "SELECT status FROM ib_applications WHERE id = ?", [id]))!.status;
  const bells = (clientId: number) => rows<{ type: string; title: string; body: string; link: string; link_label: string }>(env.db, "SELECT type, title, body, link, link_label FROM client_notifications WHERE client_id = ? ORDER BY id", [clientId]);
  const emails = (clientId: number) => rows<{ template: string; subject: string; body_text: string }>(env.db, "SELECT template, subject, body_text FROM email_outbox WHERE client_id = ? ORDER BY id", [clientId]);
  const audits = (action: string, applicationId: number) =>
    rows<{ actor_id: number; meta_json: Record<string, unknown> }>(env.db, "SELECT actor_id, meta_json FROM audit_log WHERE action = ? AND meta_json->'$.applicationId' = ? ORDER BY id", [action, applicationId]);
  const approve = (s: SignedIn, id: number, body: Record<string, unknown> = {}) => post(s, `${A(id)}/approve`, { checklist: ALL, ...body });
  const clientGet = async (clientId: number, url: string) => {
    const s = await createClientSession(env.db, env.config, clientId, "198.51.100.1", "vitest");
    return api().get(url).set("Authorization", `Bearer ${s.token}`);
  };

  beforeAll(async () => {
    env = await setup({ CRM_STEPUP_MINUTES: "30", CRM_SUPPORT_EVENTS_URL: "https://support.test.local/", CRM_SUPPORT_EVENTS_SECRET: "s".repeat(40), CRM_SUPPORT_EVENTS_ENVIRONMENT: "staging" });
    // A reviewer without money permissions, and one who sees only the clients assigned to them.
    await exec(env.db, "INSERT INTO roles (slug, name) VALUES ('ib_reviewer', 'IB reviewer'), ('ib_scoped', 'Scoped IB reviewer')");
    await exec(
      env.db,
      `INSERT INTO role_permissions (role_id, permission) SELECT r.id, p.name FROM roles r JOIN (SELECT 'ib.view' AS name UNION SELECT 'ib.decide' UNION SELECT 'client.view'
         UNION SELECT 'client.view_all') p WHERE r.slug = 'ib_reviewer'`,
    );
    await exec(
      env.db,
      `INSERT INTO role_permissions (role_id, permission) SELECT r.id, p.name FROM roles r JOIN (SELECT 'ib.view' AS name UNION SELECT 'ib.decide' UNION SELECT 'client.view'
         UNION SELECT 'deposit.view') p WHERE r.slug = 'ib_scoped'`,
    );
    const staff = [
      ["boss@bis.test", "super_admin"], ["admin@bis.test", "admin"], ["admin2@bis.test", "admin"], ["compliance@bis.test", "compliance"], ["reviewer@bis.test", "ib_reviewer"],
      ["scoped@bis.test", "ib_scoped"], ["support@bis.test", "support_agent"], ["lazy@bis.test", "admin"],
    ];
    for (const [email, role] of staff) await createStaff(env.db, email!, role!);
    [boss, admin, admin2, compliance, reviewer, scoped, support, noStepUp] = (await Promise.all(staff.map(([email]) => signIn(env, email!)))) as [
      SignedIn, SignedIn, SignedIn, SignedIn, SignedIn, SignedIn, SignedIn, SignedIn,
    ];
    for (const s of [boss, admin, admin2, compliance, reviewer, scoped]) await stepUp(env, s);
    depositMethod = (await exec(env.db, "INSERT INTO payment_methods (direction, kind, name, currency, bank_name) VALUES ('deposit', 'bank', 'Bank transfer', 'USD', 'Test Bank')")).insertId;
    await exec(env.db, "INSERT INTO mt5_servers (code, label, is_enabled) VALUES ('live', 'Live', 1)");
  });
  afterAll(async () => {
    await env?.db.end();
  });

  // ---------- Queue ----------

  describe("the queue", () => {
    it("lists waiting applications oldest first, leaving closed accounts out unless asked", async () => {
      const older = await apply(await makeClient({ first: "Old", last: "Queue" }), new Date(Date.now() - 9 * DAY));
      const newer = await apply(await makeClient(), new Date(Date.now() - 8 * DAY));
      const closed = await apply(await makeClient({ status: "closed" }), new Date(Date.now() - 10 * DAY));
      const list = (await compliance.agent.get("/api/staff/ib/applications?pageSize=100")).body;
      const ids = list.items.map((i: { id: number }) => i.id);
      expect(ids.indexOf(older)).toBeLessThan(ids.indexOf(newer));
      expect(ids).not.toContain(closed);
      expect((await compliance.agent.get("/api/staff/ib/applications?pageSize=100&includeClosed=1")).body.items.map((i: { id: number }) => i.id)).toContain(closed);
      const row = list.items.find((i: { id: number }) => i.id === older);
      expect(Object.keys(row).sort()).toEqual(["claimedBy", "client", "decidedAt", "decidedBy", "id", "kyc", "referredClients", "removedAt", "removedBy", "status", "submittedAt", "warningCount"]);
      expect(row).toMatchObject({ status: "pending", client: { name: "Old Queue", country: "Pakistan", status: "active", avatarUrl: null }, kyc: { identity: "approved", address: "approved" }, referredClients: 0, warningCount: 0 });
      const search = (await compliance.agent.get("/api/staff/ib/applications?q=Old%20Queue")).body;
      expect(search.items.map((i: { id: number }) => i.id)).toEqual([older]);
      expect((await compliance.agent.get("/api/staff/ib/applications?status=bogus")).status).toBe(400);
      expect((await support.agent.get("/api/staff/ib/applications")).status).toBe(403);
    });

    it("counts the summary, with forMe as what next would hand this person", async () => {
      const before = (await admin.agent.get("/api/staff/ib/applications/summary")).body;
      const mine = await apply(await makeClient(), new Date(Date.now() - 3 * DAY));
      await apply(await makeClient({ createdBy: admin.staffId }));
      await apply(await makeClient({ status: "closed" }));
      const held = await apply(await makeClient());
      await exec(env.db, "UPDATE ib_applications SET claimed_by = ?, claimed_until = CURRENT_TIMESTAMP(3) + INTERVAL 10 MINUTE WHERE id = ?", [admin2.staffId, held]);
      const after = (await admin.agent.get("/api/staff/ib/applications/summary")).body;
      expect(Object.keys(after).sort()).toEqual(["decidedToday", "decidedTodayByMe", "forMe", "oldestPendingAt", "overdue", "pending"]);
      // Pending: the closed account is not counted; forMe also skips the one admin set up and the one admin2 holds.
      expect(after.pending - before.pending).toBe(3);
      expect(after.forMe - before.forMe).toBe(1);
      expect((await compliance.agent.get("/api/staff/ib/applications/summary")).body.forMe).toBe(0);
      expect(await statusOf(mine)).toBe("pending");
    });

    it("hands out the oldest application this person may decide, and claims it", async () => {
      // Clear the queue for a predictable order.
      await exec(env.db, "UPDATE ib_applications SET status = 'rejected', decided_at = CURRENT_TIMESTAMP(3) WHERE status = 'pending'");
      const setUp = await apply(await makeClient({ kycUploadedBy: admin.staffId }), new Date(Date.now() - 6 * DAY));
      const closed = await apply(await makeClient({ status: "closed" }), new Date(Date.now() - 5 * DAY));
      const first = await apply(await makeClient(), new Date(Date.now() - 4 * DAY));
      const second = await apply(await makeClient(), new Date(Date.now() - 3 * DAY));
      const next = await post(admin, "/api/staff/ib/applications/next", { skip: [], stage: "review" });
      expect(next.body).toEqual({ id: first });
      expect((await one<{ claimed_by: number }>(env.db, "SELECT claimed_by FROM ib_applications WHERE id = ?", [first]))!.claimed_by).toBe(admin.staffId);
      // admin2 does not get the one admin holds; admin2 may decide the one admin set up.
      expect((await post(admin2, "/api/staff/ib/applications/next", {})).body).toEqual({ id: setUp });
      expect((await post(admin, "/api/staff/ib/applications/next", { skip: [first], release: first })).body).toEqual({ id: second });
      expect((await one<{ claimed_by: number | null }>(env.db, "SELECT claimed_by FROM ib_applications WHERE id = ?", [first]))!.claimed_by).toBeNull();
      expect((await post(admin, "/api/staff/ib/applications/next", { skip: [first, second] })).body).toEqual({ id: null });
      expect(closed).toBeGreaterThan(0);
      // Opening the closed account's application counts it in its own position, so it never reads "2 of 1".
      expect((await admin.agent.get(A(closed))).body.queue).toEqual({ position: 2, pending: 4 });
      expect((await admin.agent.get(A(first))).body.queue).toEqual({ position: 2, pending: 3 });
      expect((await post(admin, "/api/staff/ib/applications/next", { stage: "first" })).status).toBe(400);
      expect((await post(compliance, "/api/staff/ib/applications/next", {})).status).toBe(403);
    });

    it("claims, refuses a second reviewer, audits a take-over, and releases", async () => {
      const id = await apply(await makeClient());
      expect((await post(admin, `${A(id)}/claim`)).body).toMatchObject({ claimedBy: { id: admin.staffId, name: "admin" }, minutes: 15 });
      const taken = await post(admin2, `${A(id)}/claim`);
      expect(taken.status).toBe(409);
      const blocked = await approve(admin2, id);
      expect([blocked.status, blocked.body.error.message]).toEqual([409, "admin is reviewing this right now."]);
      expect((await post(admin2, `${A(id)}/claim`, { takeOver: true })).body.claimedBy.id).toBe(admin2.staffId);
      expect((await audits("ib.review_taken_over", id))[0]).toMatchObject({ actor_id: admin2.staffId, meta_json: { applicationId: id, from: admin.staffId } });
      // What happened names the reviewer the item was taken from, as on every other queue.
      expect((await admin2.agent.get(A(id))).body.trail.at(-1)).toEqual({
        at: expect.any(String), action: "review_taken_over", label: "Took over the review from admin", staff: "admin2", reason: null, internalNote: null,
      });
      expect((await post(admin2, `${A(id)}/release`)).status).toBe(200);
      expect((await one<{ claimed_by: number | null }>(env.db, "SELECT claimed_by FROM ib_applications WHERE id = ?", [id]))!.claimed_by).toBeNull();
      expect((await post(compliance, `${A(id)}/claim`)).status).toBe(403);
    });
  });

  // ---------- Review screen ----------

  describe("the review screen", () => {
    it("audits each opening and sends the shared client card", async () => {
      const sponsor = await makeClient({ first: "Spon", last: "Sor" });
      const clientId = await makeClient({ first: "Rev", last: "Iew", referredBy: sponsor, assigned: admin2.staffId });
      const token = (await loginFrom(clientId, "203.0.113.77")).token;
      const applied = await api().post("/api/ib-request").set("Authorization", `Bearer ${token}`).send({ terms: true });
      const id = applied.body.data.id as number;
      const res = await admin.agent.get(A(id));
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.client).sort()).toEqual(["assignedTo", "avatarUrl", "country", "email", "emailVerified", "id", "joinedAt", "kycStatus", "name", "status", "verifiedName"]);
      expect(res.body).toMatchObject({
        id, status: "pending", stage: "review", termsVersion: "2026-10", submittedIp: expect.any(String), decidedBy: null, removedBy: null,
        client: { id: clientId, name: "Rev Iew", verifiedName: "Rev Iew", kycStatus: "approved", emailVerified: true, assignedTo: { id: admin2.staffId, name: "admin2" } },
        checklist: { review: IB_CHECKLIST.review }, rejectReasons: IB_REJECT_REASONS, claimMinutes: 15, partner: null, earlier: [],
        can: { approve: { ok: true, reason: null }, reject: { ok: true, reason: null }, remove: { ok: false } },
        queue: { position: expect.any(Number), pending: expect.any(Number) },
        facts: { kyc: { identity: "approved", address: "approved" }, referrals: { direct: 0, funded: 0, network: 0, depositsUsd: 0 }, sponsor: { id: sponsor, name: "Spon Sor", isIb: false } },
      });
      expect(res.body.tiers).toEqual([{ id: expect.any(Number), name: "Starter", position: 1 }, { id: expect.any(Number), name: "Professional", position: 2 }]);
      expect(res.body.defaultTierId).toBe(res.body.tiers[0].id);
      expect(res.body.trail).toEqual([{ at: expect.any(String), action: "applied", label: "Sent by the client", staff: null, reason: null, internalNote: null }]);
      await admin.agent.get(A(id));
      expect(await audits("ib.application_viewed", id)).toHaveLength(2);
      // The assigned account manager may open it but not approve it (four eyes).
      expect((await admin2.agent.get(A(id))).body.can.approve).toEqual({ ok: false, reason: FOUR_EYES });
      expect((await admin2.agent.get(A(id))).body.setUpByMe).toBe(true);
      expect(res.body.setUpByMe).toBe(false);
      expect((await compliance.agent.get(A(id))).body.can.approve).toEqual({ ok: false, reason: "You can look at this application but not decide it." });
    });

    it("shows money and trading facts only to staff who may see them", async () => {
      const clientId = await makeClient();
      const referred = await makeClient({ referredBy: clientId });
      await makeClient({ referredBy: referred });
      await deposit(clientId, 25_000);
      await deposit(referred, 10_000);
      const id = await apply(clientId);
      const full = (await admin.agent.get(A(id))).body.facts;
      expect(full).toMatchObject({
        deposits: { count: 1, totalUsd: 250, firstAt: expect.any(String) }, withdrawals: { count: 0, totalUsd: 0 }, wallet: { availableUsd: 0 }, mt5: { liveAccounts: 0, lots: 0 },
        referrals: { direct: 1, funded: 1, network: 2, depositsUsd: 100 },
      });
      const limited = (await reviewer.agent.get(A(id))).body.facts;
      expect(limited).toMatchObject({ deposits: null, withdrawals: null, wallet: null, mt5: null, referrals: { direct: 1, funded: 1, network: 2, depositsUsd: null } });
      const warnings = (await reviewer.agent.get(A(id))).body.warnings.map((w: { text: string }) => w.text);
      expect(warnings.join(" ")).not.toMatch(/deposit|traded/);
    });

    it("hides other clients' applications from a scoped reviewer", async () => {
      const theirs = await apply(await makeClient());
      for (const res of [await scoped.agent.get(A(theirs)), await post(scoped, `${A(theirs)}/claim`), await post(scoped, `${A(theirs)}/reject`, { reason: REASON }), await approve(scoped, theirs)]) {
        expect(res.status).toBe(404);
        expect(res.body.error.message).toBe(NOT_FOUND);
      }
      const mine = await apply(await makeClient({ assigned: scoped.staffId }));
      const list = (await scoped.agent.get("/api/staff/ib/applications?pageSize=100")).body.items.map((i: { id: number }) => i.id);
      expect(list).toContain(mine);
      expect(list).not.toContain(theirs);
      // Their own client: they may look and reject, but approving needs another person.
      expect((await scoped.agent.get(A(mine))).body.can.approve.reason).toBe(FOUR_EYES);
      // The four-eyes flag holds while an earlier reason (another reviewer's claim, a frozen account) is the one given.
      await post(admin, `${A(mine)}/claim`);
      expect((await scoped.agent.get(A(mine))).body).toMatchObject({ setUpByMe: true, can: { approve: { ok: false, reason: "admin is reviewing this right now." } } });
      await post(admin, `${A(mine)}/release`);
      expect((await post(scoped, "/api/staff/ib/applications/next", {})).body.id).toBeNull();
      expect((await scoped.agent.get("/api/staff/ib/applications/summary")).body.forMe).toBe(0);
    });
  });

  describe("warnings", () => {
    it("flags self-referral by IP, naming only clients the reviewer may see", async () => {
      const applicant = await makeClient({ first: "Self", last: "Ref", ip: "192.0.2.10", assigned: scoped.staffId });
      const visible = await makeClient({ first: "Same", last: "Wifi", referredBy: applicant, assigned: scoped.staffId });
      const hidden = await makeClient({ referredBy: applicant });
      const elsewhere = await makeClient({ referredBy: applicant });
      await loginFrom(visible, "192.0.2.10");
      await loginFrom(hidden, "192.0.2.10");
      await loginFrom(elsewhere, "192.0.2.99");
      // A staff view-only session from the same address is not the client's own.
      await createClientSession(env.db, env.config, elsewhere, "192.0.2.10", "vitest", { staffId: boss.staffId, reason: "Checking the portal" });
      const id = await apply(applicant);
      const full = (await admin.agent.get(A(id))).body.warnings;
      const named = full.filter((w: { text: string }) => w.text.includes("whom this client referred"));
      expect(named.map((w: { href: string }) => w.href).sort()).toEqual([`/clients/${hidden}`, `/clients/${visible}`].sort());
      expect(named[0].tone).toBe("warn");
      const limited = (await scoped.agent.get(A(id))).body.warnings;
      expect(limited).toContainEqual({ tone: "warn", text: `Same Wifi (client ${visible}), whom this client referred, signed up or signed in from this client's IP address.`, href: `/clients/${visible}`, linkLabel: "Open client" });
      expect(limited).toContainEqual({ tone: "warn", text: "1 other client signed up or signed in from this client's IP addresses." });
      expect(JSON.stringify(limited)).not.toContain(`client ${hidden}`);
      expect(JSON.stringify(full)).not.toContain(`client ${elsewhere}`);
    });

    it("flags an IB on the same connection, a likely duplicate person, history, and the rest", async () => {
      const ib = await makeClient({ ip: "192.0.2.44" });
      const ibApp = await apply(ib);
      expect((await approve(admin, ibApp)).status).toBe(200);
      const twin = await makeClient({ first: "Dup", last: "Lee", dob: "1990-02-03", assigned: admin.staffId });
      const applicant = await makeClient({ first: "Dup", last: "Lee ", dob: "1990-02-03", verified: false, createdAt: new Date(Date.now() - 2 * DAY), referredBy: ib });
      await loginFrom(applicant, "192.0.2.44");
      await exec(env.db, "INSERT INTO ib_applications (client_id, status, terms_version, submitted_at, decided_at, reject_reason) VALUES (?, 'rejected', '2026-10', ?, ?, 'No')", [applicant, new Date(Date.now() - 2 * DAY), new Date(Date.now() - 2 * DAY)]);
      const id = await apply(applicant, new Date());
      const warnings = (await admin.agent.get(A(id))).body.warnings as { tone: string; text: string; href?: string }[];
      expect(warnings.map((w) => w.tone)).toEqual([...warnings.map((w) => w.tone)].sort((a, b) => ["bad", "warn", "info"].indexOf(a) - ["bad", "warn", "info"].indexOf(b)));
      const texts = warnings.map((w) => w.text);
      expect(texts).toContain(`Ann ${(await one<{ last_name: string }>(env.db, "SELECT last_name FROM clients WHERE id = ?", [ib]))!.last_name} (client ${ib}) is an IB and shares an IP address with this client.`);
      expect(texts.some((t) => t.startsWith("The same person may have another account: Dup Lee") && t.includes(`client ${twin}`))).toBe(true);
      expect(texts).toContain("1 earlier IB application was rejected.");
      expect(texts).toContain("The client has not verified their email address.");
      expect(texts).toContain("The client has no approved deposits yet.");
      expect(texts).toContain("The client has not traded on a live MT5 account yet.");
      expect(texts).toContain("The account was opened less than 7 days ago.");
      expect(warnings.find((w) => w.text.startsWith("Approving makes this client a sub-IB"))).toMatchObject({ tone: "info", href: `/clients/${ib}` });
      // Out of scope, the other IB and the twin are not named.
      const scopedApp = await apply(await makeClient({ dob: "1990-02-03", first: "Dup", last: "Lee", assigned: scoped.staffId, ip: "192.0.2.44" }));
      const unnamed = (await scoped.agent.get(A(scopedApp))).body.warnings.map((w: { text: string }) => w.text);
      expect(unnamed).toContain("An existing IB shares an IP address with this client.");
      expect(unnamed).toContain("The same person may have another account: another client has the same name and date of birth.");
      // The list row counts cheap flags only: the earlier rejection and the unverified email.
      const row = (await admin.agent.get(`/api/staff/ib/applications?clientId=${applicant}`)).body.items[0];
      expect(row.warningCount).toBe(2);
    });
  });

  // ---------- Decisions ----------

  describe("decisions", () => {
    it("approves with 2FA and a full checklist, makes the client an IB and tells them", async () => {
      const clientId = await makeClient({ first: "Ida", last: "Approve" });
      const id = await apply(clientId);
      expect((await approve(noStepUp, id)).body.error.code).toBe("STEP_UP_REQUIRED");
      const partial = await post(admin, `${A(id)}/approve`, { checklist: ALL.slice(1) });
      expect(partial.status).toBe(400);
      expect((await approve(admin, id, { tierId: 999 })).status).toBe(400);
      expect((await approve(admin, id, { extra: 1 })).status).toBe(400);
      expect((await approve(compliance, id)).status).toBe(403);
      const res = await approve(admin, id, { note: "Known introducer from the Lahore event." });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: "approved", stage: null, decidedBy: { id: admin.staffId, name: "admin" }, checked: ALL, claimedBy: null,
        partner: { status: "active", tier: "Starter", applicationId: id }, can: { approve: { ok: false, reason: "This application was already decided." }, remove: { ok: true } },
        notes: [{ at: expect.any(String), byName: "admin", stage: "approved", text: "Known introducer from the Lahore event." }],
      });
      expect(res.body.trail.map((t: { action: string }) => t.action)).toEqual(["approved"]);
      expect(res.body.trail[0]).toMatchObject({ label: "Approved", staff: "admin", internalNote: "Known introducer from the Lahore event." });
      const [audit] = await audits("ib.approved", id);
      expect(audit!.meta_json).toMatchObject({ applicationId: id, tier: { name: "Starter" }, checklist: ALL, warnings: [], internalNote: "Known introducer from the Lahore event." });
      expect(await bells(clientId)).toEqual([
        { type: "ib", title: "Your IB application is approved", body: "You are now a BIS Markets Introducing Broker. Open your IB Dashboard to get your referral link.", link: "/ib-dashboard", link_label: "Open IB Dashboard" },
      ]);
      const [mail] = await emails(clientId);
      expect(mail).toMatchObject({ template: "ib_approved", subject: "Your IB application is approved" });
      expect(mail!.body_text).toContain(`${env.config.portalUrl}/ib-dashboard`);
      expect((await clientGet(clientId, "/api/ib-request")).body.status).toBe("approved");
      expect((await clientGet(clientId, "/api/ib-dashboard")).status).toBe(200);
      expect((await clientGet(clientId, "/api/user")).body).toMatchObject({ is_ib: true, ib_status: "approved" });
      // The support service gets no IB event (it accepts a closed set of events).
      expect(await rows(env.db, "SELECT event FROM webhook_outbox WHERE client_id = ?", [clientId])).toEqual([]);
      expect((await approve(admin2, id)).body.error.message).toBe("This application was already decided.");
    });

    it("places the partner on the level chosen, and stores the warnings shown", async () => {
      const clientId = await makeClient({ verified: false });
      const id = await apply(clientId);
      const pro = (await one<{ id: number }>(env.db, "SELECT id FROM ib_tiers WHERE name = 'Professional'"))!.id;
      expect((await approve(admin, id, { tierId: pro })).body.partner.tier).toBe("Professional");
      expect((await audits("ib.approved", id))[0]!.meta_json.warnings).toEqual(["The client has not verified their email address."]);
    });

    it("refuses to approve a frozen account, unverified KYC, or a client the reviewer set up", async () => {
      const frozen = await apply(await makeClient({ status: "frozen" }));
      expect((await approve(admin, frozen)).body.error.message).toBe("This account is frozen. Unfreeze it before approving.");
      const kyc = await apply(await makeClient({ kyc: "pending" }));
      expect((await approve(admin, kyc)).body.error.message).toBe("Identity and address must both be verified before approving.");
      for (const opts of [{ createdBy: admin.staffId }, { assigned: admin.staffId }, { kycUploadedBy: admin.staffId }]) {
        const id = await apply(await makeClient(opts));
        const res = await approve(admin, id);
        expect([res.status, res.body.error.message]).toEqual([403, FOUR_EYES]);
        expect(await statusOf(id)).toBe("pending");
        // Another person may.
        expect((await approve(admin2, id)).status).toBe(200);
      }
      const closed = await apply(await makeClient({ status: "closed" }));
      expect((await approve(admin, closed)).body.error.message).toBe("This account is closed.");
      expect((await post(admin, `${A(closed)}/reject`, { reason: REASON })).body.error.message).toBe("This account is closed.");
    });

    it("rejects with a client-facing reason, also for a frozen account", async () => {
      const clientId = await makeClient({ status: "frozen", kyc: "pending" });
      const id = await apply(clientId);
      expect((await post(admin, `${A(id)}/reject`, { reason: "no" })).status).toBe(400);
      expect((await post(admin, `${A(id)}/reject`, { reason: "See <a href=x>here</a>" })).status).toBe(400);
      const res = await post(admin, `${A(id)}/reject`, { reason: REASON, note: "Too new." });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: "rejected", rejectReason: REASON, decidedBy: { name: "admin" }, can: { reject: { ok: false } } });
      expect(res.body.trail[0]).toMatchObject({ action: "rejected", label: "Rejected", reason: REASON, internalNote: "Too new." });
      expect(await bells(clientId)).toEqual([{ type: "ib", title: "Your IB application was not approved", body: REASON, link: "/become-ib", link_label: "View application" }]);
      expect((await emails(clientId))[0]).toMatchObject({ template: "ib_rejected", subject: "Your IB application was not approved" });
      expect((await emails(clientId))[0]!.body_text).toContain(`Reason: ${REASON}`);
      await exec(env.db, "UPDATE clients SET status = 'active', kyc_status = 'approved' WHERE id = ?", [clientId]);
      expect((await clientGet(clientId, "/api/ib-request")).body).toMatchObject({ status: "rejected", can_submit: true, data: { rejection_reason: REASON } });
    });

    it("removes IB status from an approved partner, whatever the account's state, and allows a new approval later", async () => {
      const clientId = await makeClient({ first: "Rem", last: "Oved" });
      const id = await apply(clientId);
      expect((await post(admin, `${A(id)}/remove`, { reason: REASON })).body.error.message).toBe("Only an approved IB partner's status can be removed.");
      await approve(admin, id);
      await exec(env.db, "UPDATE clients SET status = 'closed' WHERE id = ?", [clientId]);
      expect((await post(noStepUp, `${A(id)}/remove`, { reason: REASON })).body.error.code).toBe("STEP_UP_REQUIRED");
      expect((await post(compliance, `${A(id)}/remove`, { reason: REASON })).status).toBe(403);
      const reason = "Your IB account no longer meets our IB program requirements. Please contact support for details.";
      const res = await post(admin2, `${A(id)}/remove`, { reason, note: "Closed after a complaint." });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: "removed", rejectReason: reason, removedBy: { id: admin2.staffId, name: "admin2" }, removedAt: expect.any(String),
        partner: { status: "removed", removedReason: reason, removedBy: { id: admin2.staffId, name: "admin2" } }, can: { remove: { ok: false, reason: "This client's IB status was already removed." } },
      });
      expect(res.body.trail.map((t: { action: string }) => t.action)).toEqual(["approved", "removed"]);
      expect((await audits("ib.removed", id))[0]!.meta_json).toMatchObject({ applicationId: id, tier: { name: "Starter" }, reason, internalNote: "Closed after a complaint." });
      expect((await bells(clientId)).at(-1)).toEqual({ type: "ib", title: "Your IB partnership has ended", body: reason, link: "/become-ib", link_label: "View details" });
      expect((await emails(clientId)).at(-1)).toMatchObject({ template: "ib_removed", subject: "Your IB partnership has ended" });

      await exec(env.db, "UPDATE clients SET status = 'active' WHERE id = ?", [clientId]);
      expect((await clientGet(clientId, "/api/ib-request")).body).toMatchObject({ status: "rejected", data: { removed: true, rejection_reason: reason } });
      expect((await clientGet(clientId, "/api/ib-dashboard")).status).toBe(403);
      // Applying again and being approved makes the same partnership row active again.
      const again = await apply(clientId, new Date());
      await approve(admin, again);
      expect(await rows(env.db, "SELECT status, application_id, removed_at FROM ib_partners WHERE client_id = ?", [clientId])).toEqual([{ status: "active", application_id: again, removed_at: null }]);
      // The old application shows the current partnership, which came from the newer one.
      const old = (await admin.agent.get(A(id))).body;
      expect(old.partner).toMatchObject({ status: "active", applicationId: again });
      expect(old.can.remove.ok).toBe(false);
      expect(old.earlier.map((e: { id: number; newer: boolean }) => [e.id, e.newer])).toEqual([[again, true]]);
      expect((await admin.agent.get(A(again))).body.earlier.map((e: { id: number; newer: boolean }) => [e.id, e.newer])).toEqual([[id, false]]);
    });
  });

  // ---------- Partners and the client profile ----------

  describe("partners and the client profile", () => {
    it("lists partners with their network, and counts them", async () => {
      const sponsor = await makeClient({ first: "Top", last: "Sponsor" });
      await approve(admin, await apply(sponsor));
      const partner = await makeClient({ first: "Pat", last: "Partner", referredBy: sponsor });
      await approve(admin, await apply(partner));
      const funded = await makeClient({ referredBy: partner });
      await deposit(funded, 5_000);
      const sub = await makeClient({ referredBy: partner });
      await approve(admin, await apply(sub));
      await makeClient({ referredBy: sub });
      const list = (await compliance.agent.get(`/api/staff/ib/partners?q=Pat%20Partner`)).body;
      expect(list.items).toHaveLength(1);
      expect(list.items[0]).toMatchObject({
        clientId: partner, name: "Pat Partner", tier: "Starter", status: "active", approvedBy: { id: admin.staffId, name: "admin" },
        directClients: 2, fundedClients: 1, network: 3, subIbs: 1, sponsor: { id: sponsor, name: "Top Sponsor", isIb: true }, referralCode: expect.any(String),
      });
      const summary = (await compliance.agent.get("/api/staff/ib/partners/summary")).body;
      expect(summary).toEqual({ active: expect.any(Number), removed: expect.any(Number), newThisMonth: expect.any(Number) });
      expect(summary.active).toBeGreaterThanOrEqual(3);
      // A closed account is no longer an IB, so it is not counted as active, though the list still shows it for removal.
      await exec(env.db, "UPDATE clients SET status = 'closed' WHERE id = ?", [sub]);
      const after = (await compliance.agent.get("/api/staff/ib/partners/summary")).body;
      expect([after.active, after.newThisMonth]).toEqual([summary.active - 1, summary.newThisMonth - 1]);
      expect((await compliance.agent.get(`/api/staff/ib/partners?q=${sub}`)).body.items).toMatchObject([{ clientId: sub, status: "active", clientStatus: "closed" }]);
      const removed = (await compliance.agent.get("/api/staff/ib/partners?status=removed")).body.items;
      expect(removed.every((p: { status: string }) => p.status === "removed")).toBe(true);
      expect((await scoped.agent.get(`/api/staff/ib/partners?q=Pat%20Partner`)).body.items).toEqual([]);
      expect((await support.agent.get("/api/staff/ib/partners")).status).toBe(403);
    });

    it("filters clients by who referred them and shows the IB block to ib.view holders only", async () => {
      const ib = await makeClient({ first: "Ib", last: "Holder" });
      const id = await apply(ib);
      await approve(admin, id);
      const a = await makeClient({ referredBy: ib });
      const b = await makeClient({ referredBy: ib });
      await makeClient({ referredBy: a });
      const list = (await boss.agent.get(`/api/staff/clients?referredBy=${ib}`)).body;
      expect(list.items.map((c: { id: number }) => c.id).sort()).toEqual([a, b].sort());
      const detail = (await admin.agent.get(`/api/staff/clients/${ib}`)).body;
      expect(detail.ib).toEqual({
        status: "approved", applicationId: id, sponsor: null,
        partner: { status: "active", tier: "Starter", approvedAt: expect.any(String), referralCode: detail.referralCode, directClients: 2, network: 3, removedAt: null },
      });
      expect((await admin.agent.get(`/api/staff/clients/${a}`)).body.ib).toEqual({ status: "none", applicationId: null, partner: null, sponsor: { id: ib, name: "Ib Holder", isIb: true } });
      expect((await support.agent.get(`/api/staff/clients/${ib}`)).body.ib).toBeNull();
    });

    it("trims IB entries in the client's activity for staff without ib.view", async () => {
      const clientId = await makeClient({ verified: false });
      const id = await apply(clientId);
      await admin.agent.get(A(id));
      await approve(admin, id, { note: "Internal only." });
      await post(admin, `${A(id)}/remove`, { reason: REASON, note: "Also internal." });
      const full = (await compliance.agent.get(`/api/staff/clients/${clientId}/activity`)).body.items;
      expect(full.map((a: { action: string }) => a.action)).not.toContain("ib.application_viewed");
      const approved = full.find((a: { action: string }) => a.action === "ib.approved");
      expect(approved.meta).toMatchObject({ applicationId: id, internalNote: "Internal only.", checklist: ALL });
      expect(approved.meta).not.toHaveProperty("warnings");
      const trimmed = (await support.agent.get(`/api/staff/clients/${clientId}/activity`)).body.items;
      expect(trimmed.find((a: { action: string }) => a.action === "ib.approved").meta).toEqual({ applicationId: id, tier: { id: expect.any(Number), name: "Starter" } });
      expect(trimmed.find((a: { action: string }) => a.action === "ib.removed").meta).toEqual({ applicationId: id, tier: { id: expect.any(Number), name: "Starter" }, reason: REASON });
    });
  });
});
