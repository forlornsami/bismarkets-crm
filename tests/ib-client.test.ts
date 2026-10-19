import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClientSession } from "../src/server/clients/session";
import { exec, one, rows } from "../src/server/lib/db";
import { networkOf } from "../src/server/ib/network";
import { createStaff, hasDb, setup, type TestEnv } from "./helpers";

const DAY = 86_400_000;
const NOT_IB = "This is only available to approved IB partners.";
const VIEW_ONLY = "This is a view-only staff session. Changes are not allowed.";
const KYC = "You must complete your KYC first.";
const ON_HOLD = "Your account is on hold, so you cannot apply right now. Please contact support.";
const TERMS = "Please accept the IB Terms & Conditions.";
const IB_ONLY_READS = ["/api/ib-dashboard", "/api/ib-referrals", "/api/team", "/api/sub-ibs", "/api/ib-commissions?type=IB", "/api/direct-bonuses", "/api/team-ledger", "/api/direct-team-ledger"];
const thisMonth = () => new Date().toISOString().slice(0, 7);
const lastMonth = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)).toISOString().slice(0, 7);
};

describe.skipIf(!hasDb)("client IB program", () => {
  let env: TestEnv;
  let staffId = 0;
  let depositMethod = 0;
  let payoutType = 0;
  let seq = 0;
  const api = () => request(env.app);
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });

  // ---- Seeding by direct inserts, as the rest of the CRM would leave things ----

  async function makeClient(o: { first?: string; last?: string; kyc?: string; status?: string; referredBy?: number | null; createdAt?: Date } = {}) {
    seq++;
    const r = await exec(
      env.db,
      "INSERT INTO clients (email, first_name, last_name, referral_code, source, status, kyc_status, referred_by, created_at) VALUES (?, ?, ?, ?, 'portal', ?, ?, ?, ?)",
      [`ib${seq}@client.test`, o.first ?? "Ann", o.last ?? `Lee${seq}`, `IBC${String(seq).padStart(6, "0")}`, o.status ?? "active", o.kyc ?? "approved", o.referredBy ?? null, o.createdAt ?? new Date(Date.now() - 60 * DAY)],
    );
    return r.insertId;
  }
  const codeOf = async (clientId: number) => (await one<{ referral_code: string }>(env.db, "SELECT referral_code FROM clients WHERE id = ?", [clientId]))!.referral_code;

  async function tokenFor(clientId: number, viewOnly = false) {
    const s = await createClientSession(env.db, env.config, clientId, "198.51.100.7", "vitest", viewOnly ? { staffId, reason: "Checking the portal" } : undefined);
    return s.token;
  }

  /** An approved partnership, as the staff approval leaves it. */
  async function makeIb(clientId: number, tier = "Starter") {
    const t = (await one<{ id: number }>(env.db, "SELECT id FROM ib_tiers WHERE name = ?", [tier]))!;
    const a = await exec(env.db, "INSERT INTO ib_applications (client_id, status, terms_version, decided_at, decided_by, tier_id) VALUES (?, 'approved', '2026-10', CURRENT_TIMESTAMP(3), ?, ?)", [clientId, staffId, t.id]);
    await exec(env.db, "INSERT INTO ib_partners (client_id, status, application_id, tier_id, approved_at, approved_by) VALUES (?, 'active', ?, ?, CURRENT_TIMESTAMP(3), ?)", [clientId, a.insertId, t.id, staffId]);
    return a.insertId;
  }
  async function removeIb(clientId: number, reason = "Your IB partnership was ended at your request.") {
    await exec(env.db, "UPDATE ib_applications SET status = 'removed', removed_at = CURRENT_TIMESTAMP(3), removed_by = ?, reject_reason = ? WHERE client_id = ? AND status = 'approved'", [staffId, reason, clientId]);
    await exec(env.db, "UPDATE ib_partners SET status = 'removed', removed_at = CURRENT_TIMESTAMP(3), removed_by = ?, removed_reason = ? WHERE client_id = ?", [staffId, reason, clientId]);
  }

  async function walletId(clientId: number) {
    await exec(env.db, "INSERT IGNORE INTO wallets (client_id, wallet_key) VALUES (?, ?)", [clientId, `ibw${clientId}`]);
    return (await one<{ id: number }>(env.db, "SELECT id FROM wallets WHERE client_id = ?", [clientId]))!.id;
  }
  async function deposit(clientId: number, cents: number, decidedAt = new Date(Date.now() - DAY), status = "approved") {
    seq++;
    await exec(
      env.db,
      `INSERT INTO deposits (reference, client_id, wallet_id, payment_method_id, method_name, status, currency, amount_minor, usd_rate, amount_cents, credited_cents, decided_at)
       VALUES (?, ?, ?, ?, 'Bank transfer', ?, 'USD', ?, 1, ?, ?, ?)`,
      [`DIB${seq}`, clientId, await walletId(clientId), depositMethod, status, cents, cents, status === "approved" ? cents : null, decidedAt],
    );
  }
  async function paidWithdrawal(clientId: number, cents: number, status = "paid") {
    seq++;
    const payout = await exec(env.db, "INSERT INTO client_payout_methods (client_id, payment_method_id, method_name, account_number_enc, fingerprint) VALUES (?, ?, 'My bank', '', ?)", [clientId, payoutType, "f".repeat(64)]);
    await exec(
      env.db,
      `INSERT INTO withdrawals (reference, client_id, wallet_id, payout_method_id, payment_method_id, method_name, status, amount_cents, destination_enc, destination_fingerprint)
       VALUES (?, ?, ?, ?, ?, 'My bank', ?, ?, '', ?)`,
      [`WIB${seq}`, clientId, await walletId(clientId), payout.insertId, payoutType, status, cents, "f".repeat(64)],
    );
  }
  /** A closed trade of `volume` in 1/10000 lot on a new live (or demo) MT5 account. */
  async function trade(clientId: number, volume: number, demo = false) {
    seq++;
    const login = 700_000 + seq;
    const account = await exec(
      env.db,
      "INSERT INTO mt5_accounts (client_id, server_code, login, is_demo, package_name, mt5_group, leverage, status, create_ref) VALUES (?, ?, ?, ?, 'Standard', 'real\\\\std', 100, 'active', ?)",
      [clientId, demo ? "demo" : "live", login, demo ? 1 : 0, `ibref${seq}`],
    );
    await exec(
      env.db,
      `INSERT INTO mt5_trades (mt5_account_id, position_id, segment, client_id, server_code, login, symbol, side, volume, open_price, close_price, open_time_utc, close_time_utc,
         profit_cents, commission_cents, swap_cents, fee_cents) VALUES (?, ?, 0, ?, ?, ?, 'EURUSD', 0, ?, '1.1', '1.2', ?, ?, 0, 0, 0, 0)`,
      [account.insertId, seq, clientId, demo ? "demo" : "live", login, volume, new Date(Date.now() - 2 * DAY), new Date(Date.now() - DAY)],
    );
  }

  beforeAll(async () => {
    env = await setup();
    staffId = await createStaff(env.db, "boss@bis.test", "super_admin");
    depositMethod = (await exec(env.db, "INSERT INTO payment_methods (direction, kind, name, currency, bank_name) VALUES ('deposit', 'bank', 'Bank transfer', 'USD', 'Test Bank')")).insertId;
    payoutType = (await exec(env.db, "INSERT INTO payment_methods (direction, kind, name, currency) VALUES ('withdrawal', 'bank', 'Bank payout', 'USD')")).insertId;
    await exec(env.db, "INSERT INTO mt5_servers (code, label, is_enabled) VALUES ('live', 'Live', 1), ('demo', 'Demo', 1)");
  });
  afterAll(async () => {
    await env?.db.end();
  });

  // ---------- The application ----------

  describe("GET /api/ib-request", () => {
    it("answers 200 with status none to every signed-in client, never gated on KYC", async () => {
      const ready = await tokenFor(await makeClient());
      const res = await api().get("/api/ib-request").set(as(ready));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true, status: "none", can_submit: true, status_label: "Not applied", message: "No IB application found.",
        data: { id: null, status: "none", terms: false, created_at: null, updated_at: null, submitted_at: null, decided_at: null, rejection_reason: null, removed: false },
      });
      const unverified = await api().get("/api/ib-request").set(as(await tokenFor(await makeClient({ kyc: "pending" }))));
      expect(unverified.status).toBe(200);
      expect(unverified.body).toMatchObject({ status: "none", can_submit: false });
      const frozen = await api().get("/api/ib-request").set(as(await tokenFor(await makeClient({ status: "frozen" }))));
      expect(frozen.body).toMatchObject({ status: "none", can_submit: false });
      const viewOnly = await api().get("/api/ib-request").set(as(await tokenFor(await makeClient(), true)));
      expect(viewOnly.status).toBe(200);
      expect((await api().get("/api/ib-request")).status).toBe(401);
    });

    it("shows a rejection and an ended partnership as rejected, with the reason, and lets the client apply again", async () => {
      const id = await makeClient();
      const token = await tokenFor(id);
      await exec(env.db, "INSERT INTO ib_applications (client_id, status, terms_version, decided_at, reject_reason) VALUES (?, 'rejected', '2026-10', CURRENT_TIMESTAMP(3), 'Please apply again later.')", [id]);
      const rejected = (await api().get("/api/ib-request").set(as(token))).body;
      expect(rejected).toMatchObject({ status: "rejected", can_submit: true, status_label: "Not approved", data: { status: "rejected", rejection_reason: "Please apply again later.", removed: false } });
      expect(rejected.data.decided_at).toMatch(/Z$/);

      const ib = await makeClient();
      await makeIb(ib);
      await removeIb(ib, "We found activity that breaks the IB program terms. Please contact support.");
      const removed = (await api().get("/api/ib-request").set(as(await tokenFor(ib)))).body;
      expect(removed).toMatchObject({
        status: "rejected", can_submit: true, status_label: "Partnership ended", message: "Your IB partnership has ended.",
        data: { status: "rejected", removed: true, rejection_reason: "We found activity that breaks the IB program terms. Please contact support." },
      });
      const row = await one<{ removed_at: Date }>(env.db, "SELECT removed_at FROM ib_applications WHERE client_id = ?", [ib]);
      expect(removed.data.decided_at).toBe(row!.removed_at.toISOString());
    });
  });

  describe("POST /api/ib-request", () => {
    it("stores a pending application once and answers a repeat with the same one", async () => {
      const id = await makeClient();
      const token = await tokenFor(id);
      const first = await api().post("/api/ib-request").set(as(token)).send({ terms: true });
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({ success: true, status: "pending", can_submit: false, status_label: "Pending review", data: { status: "pending", terms: true, removed: false } });
      expect(first.body.data.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
      const again = await api().post("/api/ib-request").set(as(token)).send({ terms: true });
      expect(again.status).toBe(200);
      expect(again.body.data.id).toBe(first.body.data.id);
      const stored = await rows<{ id: number; terms_version: string; submitted_ip: string; submitted_user_agent: string }>(env.db, "SELECT id, terms_version, submitted_ip, submitted_user_agent FROM ib_applications WHERE client_id = ?", [id]);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ terms_version: "2026-10" });
      const audit = await one<{ actor_type: string; meta_json: Record<string, unknown> }>(env.db, "SELECT actor_type, meta_json FROM audit_log WHERE action = 'ib.applied' AND entity_id = ?", [String(id)]);
      expect(audit).toMatchObject({ actor_type: "client", meta_json: { applicationId: first.body.data.id, termsVersion: "2026-10" } });
      expect((await api().get("/api/ib-request").set(as(token))).body).toMatchObject({ status: "pending", can_submit: false, data: { id: first.body.data.id } });
      // An approved partner applying again gets their approved application, not an error.
      await exec(env.db, "UPDATE ib_applications SET status = 'approved' WHERE client_id = ?", [id]);
      const approved = await api().post("/api/ib-request").set(as(token)).send({ terms: true });
      expect(approved.status).toBe(200);
      expect(approved.body.status).toBe("approved");
    });

    it("opens one application when two submits race", async () => {
      const id = await makeClient();
      const token = await tokenFor(id);
      const both = await Promise.all([api().post("/api/ib-request").set(as(token)).send({ terms: true }), api().post("/api/ib-request").set(as(token)).send({ terms: true })]);
      expect(both.map((r) => r.status).sort()).toEqual([200, 201]);
      expect(both[0]!.body.data.id).toBe(both[1]!.body.data.id);
      expect(await rows(env.db, "SELECT id FROM ib_applications WHERE client_id = ?", [id])).toHaveLength(1);
    });

    it("accepts the app's form data as well as JSON", async () => {
      const multipart = await api().post("/api/ib-request").set(as(await tokenFor(await makeClient()))).field("terms", "on");
      expect(multipart.status).toBe(201);
      const form = await api().post("/api/ib-request").set(as(await tokenFor(await makeClient()))).type("form").send("terms=1");
      expect(form.status).toBe(201);
    });

    it("refuses in the documented order, never with a 401", async () => {
      const viewOnly = await api().post("/api/ib-request").set(as(await tokenFor(await makeClient(), true))).send({ terms: true });
      expect(viewOnly.status).toBe(403);
      expect(viewOnly.body.message).toBe(VIEW_ONLY);
      const token = await tokenFor(await makeClient({ kyc: "partial", status: "frozen" }));
      for (const body of [{}, { terms: false }, { terms: "no" }]) {
        const res = await api().post("/api/ib-request").set(as(token)).send(body);
        expect(res.status).toBe(422);
        expect(res.body.errors.terms).toEqual([TERMS]);
      }
      // KYC comes before the frozen check, with the exact text the app matches.
      const kyc = await api().post("/api/ib-request").set(as(token)).send({ terms: true });
      expect(kyc.status).toBe(403);
      expect(kyc.body.message).toBe(KYC);
      const frozen = await api().post("/api/ib-request").set(as(await tokenFor(await makeClient({ status: "frozen" })))).send({ terms: true });
      expect(frozen.status).toBe(422);
      expect(frozen.body).toEqual({ message: ON_HOLD, errors: { account: [ON_HOLD] } });
    });

    it("lets a rejected client apply again; the latest application decides", async () => {
      const id = await makeClient();
      const token = await tokenFor(id);
      await exec(env.db, "INSERT INTO ib_applications (client_id, status, terms_version, submitted_at, decided_at, reject_reason) VALUES (?, 'rejected', '2026-10', ?, ?, 'Not yet.')", [id, new Date(Date.now() - 5 * DAY), new Date(Date.now() - 4 * DAY)]);
      const res = await api().post("/api/ib-request").set(as(token)).send({ terms: true });
      expect(res.status).toBe(201);
      expect((await api().get("/api/ib-request").set(as(token))).body).toMatchObject({ status: "pending", data: { rejection_reason: null } });
    });

    it("limits stored applications to 5 an hour and attempts to 20, with Retry-After", async () => {
      const id = await makeClient();
      const token = await tokenFor(id);
      for (let i = 0; i < 5; i++) {
        expect((await api().post("/api/ib-request").set(as(token)).send({ terms: true })).status).toBe(201);
        await exec(env.db, "UPDATE ib_applications SET status = 'rejected', decided_at = CURRENT_TIMESTAMP(3) WHERE client_id = ? AND status = 'pending'", [id]);
      }
      const stored = await api().post("/api/ib-request").set(as(token)).send({ terms: true });
      expect(stored.status).toBe(429);
      expect(stored.body.message).toBe("Too many IB applications. Please wait before trying again.");
      expect(Number(stored.headers["retry-after"])).toBeGreaterThan(0);

      const other = await tokenFor(await makeClient());
      for (let i = 0; i < 20; i++) expect((await api().post("/api/ib-request").set(as(other)).send({})).status).toBe(422);
      const attempts = await api().post("/api/ib-request").set(as(other)).send({ terms: true });
      expect(attempts.status).toBe(429);
      expect(attempts.body.message).toBe("Too many attempts. Please wait before trying again.");
    });
  });

  // ---------- IB-only reads ----------

  describe("IB-only reads", () => {
    it("answers 403 (never 401 or 404) to anyone who is not an active IB", async () => {
      const none = await tokenFor(await makeClient());
      const pendingId = await makeClient();
      await exec(env.db, "INSERT INTO ib_applications (client_id, terms_version) VALUES (?, '2026-10')", [pendingId]);
      const removedId = await makeClient();
      await makeIb(removedId);
      await removeIb(removedId);
      for (const token of [none, await tokenFor(pendingId), await tokenFor(removedId), await tokenFor(await makeClient(), true)]) {
        for (const url of IB_ONLY_READS) {
          const res = await api().get(url).set(as(token));
          expect(res.status, url).toBe(403);
          expect(res.body.message).toBe(NOT_IB);
        }
      }
      // The transfer history stays a 200 for everyone (the portal reads it for every client).
      expect((await api().get("/api/ib-transfer-history").set(as(none))).status).toBe(200);
    });

    it("keeps an IB's reads when KYC is later withdrawn; lets a view-only session read them", async () => {
      const ib = await makeClient();
      await makeIb(ib);
      await exec(env.db, "UPDATE clients SET kyc_status = 'pending' WHERE id = ?", [ib]);
      for (const token of [await tokenFor(ib), await tokenFor(ib, true)]) {
        for (const url of IB_ONLY_READS) expect((await api().get(url).set(as(token))).status, url).toBe(200);
      }
    });

    it("limits IB reads to 120 a minute per client, with Retry-After", async () => {
      const token = await tokenFor(await makeClient());
      for (let i = 0; i < 120; i++) expect((await api().get("/api/ib-request").set(as(token))).status).toBe(200);
      const res = await api().get("/api/ib-request").set(as(token));
      expect(res.status).toBe(429);
      expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    });
  });

  describe("the IB dashboard and network", () => {
    let ib = 0;
    let token = "";
    const ids: Record<string, number> = {};

    beforeAll(async () => {
      // IB ─ A (funded last month, 1.5 live lots, a paid withdrawal) ─ D ─ F
      //    ├ B (not funded, frozen)
      //    └ C (an IB, funded this month) ─ E (funded this month)
      ib = await makeClient({ first: "Ivy", last: "Broker" });
      await makeIb(ib);
      const at = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY);
      ids.A = await makeClient({ first: "Amy", last: "Able", referredBy: ib, createdAt: at(20) });
      ids.B = await makeClient({ first: "Ben", last: "Best", referredBy: ib, createdAt: at(19), status: "frozen" });
      ids.C = await makeClient({ first: "Cai", last: "Cole", referredBy: ib, createdAt: at(18) });
      ids.D = await makeClient({ first: "Dee", last: "Dunn", referredBy: ids.A, createdAt: at(17) });
      ids.E = await makeClient({ first: "Eli", last: "East", referredBy: ids.C, createdAt: at(16) });
      ids.F = await makeClient({ first: "Fay", last: "Ford", referredBy: ids.D, createdAt: at(15) });
      await makeIb(ids.C);
      const last = new Date(`${lastMonth()}-15T12:00:00Z`);
      await deposit(ids.A, 100_000, last);
      await deposit(ids.A, 70_000, last, "rejected");
      await deposit(ids.C, 50_000, new Date(Date.now() - 60_000));
      await deposit(ids.E, 30_000, new Date(Date.now() - 60_000));
      await paidWithdrawal(ids.A, 20_000);
      await paidWithdrawal(ids.A, 5_000, "pending");
      await trade(ids.A, 15_000);
      await trade(ids.A, 50_000, true);
      // A frozen account still counts as funded: the IB is never told about a freeze.
      await exec(env.db, "UPDATE clients SET status = 'frozen' WHERE id = ?", [ids.A]);
      token = await tokenFor(ib);
    });

    it("sends the dashboard at the top level with real figures for the month", async () => {
      const res = await api().get(`/api/ib-dashboard?month=${thisMonth()}`).set(as(token));
      expect(res.status).toBe(200);
      const code = await codeOf(ib);
      expect(res.body).toEqual({
        success: true,
        month: thisMonth(),
        ib_eligible: "Starter",
        ib_tier: "Starter",
        referral_code: code,
        referral_link: `${env.config.portalUrl}/register?ref=${code}`,
        promotion_progress: { category_name: "Professional", clients: { current: 2, required: 6 }, deposit: { current: 1500, required: 15000 }, volume: { current: 1.5, required: 50 } },
        overall_statistics: {
          ib_commissions: 0, ib_direct_bonus: { amount: 0, lots: 0 }, team_count: 6, active_clients: 2, total_clients: 3, sub_ib_count: 1,
          direct_team_sales: 1500, total_team_sales: 1800, total_deposits: 1500, total_withdrawals: 200,
        },
        monthly_statistics: { team_business_bonus: 0, direct_team_sales: 500, total_team_sales: 800 },
        pending_commission: 0,
        paid_commission: 0,
        monthly_growth: [],
        referral_breakdown: [{ source: "Direct clients", count: 3 }, { source: "Sub-IB networks", count: 1 }],
      });
      const earlier = (await api().get(`/api/ib-dashboard?month=${lastMonth()}`).set(as(token))).body;
      expect(earlier.monthly_statistics).toEqual({ team_business_bonus: 0, direct_team_sales: 1000, total_team_sales: 1000 });
      expect((await api().get("/api/ib-dashboard").set(as(token))).body.month).toBe(thisMonth());
      for (const bad of ["2026-13", "26-01", "2026-1", "x"]) {
        const r = await api().get(`/api/ib-dashboard?month=${bad}`).set(as(token));
        expect(r.status).toBe(422);
        expect(r.body.errors.month).toBeDefined();
      }
    });

    it("signals the top level with every target 0", async () => {
      const pro = await makeClient();
      await makeIb(pro, "Professional");
      const res = (await api().get("/api/ib-dashboard").set(as(await tokenFor(pro)))).body;
      expect(res).toMatchObject({ ib_eligible: "Professional", ib_tier: "Professional", referral_breakdown: [] });
      expect(res.promotion_progress).toEqual({ category_name: "Professional", clients: { current: 0, required: 0 }, deposit: { current: 0, required: 0 }, volume: { current: 0, required: 0 } });
    });

    it("lists direct referrals newest first, with the referral link and no contact details", async () => {
      const res = await api().get("/api/ib-referrals").set(as(token));
      expect(res.status).toBe(200);
      const code = await codeOf(ib);
      expect(res.body).toMatchObject({ success: true, referral_code: code, referral_link: `${env.config.portalUrl}/register?ref=${code}`, custom_referral_links: [] });
      expect(res.body.clients.map((c: { id: number }) => c.id)).toEqual([ids.C, ids.B, ids.A]);
      expect(res.body.clients[2]).toEqual({
        id: ids.A, client_id: String(ids.A), name: "Amy Able", join_date: expect.stringMatching(/Z$/), created_at: expect.stringMatching(/Z$/), funded: true, trading_volume: 1.5, total_deposits: 1000,
      });
      expect(res.body.clients[1]).toMatchObject({ funded: false, trading_volume: 0, total_deposits: 0 });
    });

    it("pages the whole network exactly, level by level, without private details", async () => {
      const page1 = (await api().get("/api/team?page=1&per_page=4").set(as(token))).body;
      expect(page1.pagination).toEqual({ current_page: 1, per_page: 4, total: 6, last_page: 2 });
      expect(page1.summary).toEqual({ total_count: 6 });
      expect(page1.team_members.map((m: { id: number }) => m.id)).toEqual([ids.A, ids.B, ids.C, ids.D]);
      const page2 = (await api().get("/api/team?page=2&per_page=4").set(as(token))).body;
      expect(page2.pagination).toEqual({ current_page: 2, per_page: 4, total: 6, last_page: 2 });
      expect(page2.team_members.map((m: { id: number; level: number }) => [m.id, m.level])).toEqual([[ids.E, 2], [ids.F, 3]]);
      const [a, b, c, d] = page1.team_members;
      expect(a).toEqual({
        id: ids.A, client_id: String(ids.A), name: "Amy Able", display_name: `${ids.A}-Amy Able`, created_at: expect.any(String), joined_at: expect.any(String),
        sponsor: { id: ib, name: "Ivy Broker" }, level: 1, status: "active", is_ib: false, clients: 1, client_count: 1, deposit: 1000, total_deposits: 1000, mt5_account_id: null,
      });
      // Funded or not, never the account's own state.
      expect(b).toMatchObject({ status: "inactive", clients: 0 });
      expect(c).toMatchObject({ is_ib: true, status: "active", deposit: 500 });
      expect(d).toMatchObject({ sponsor: { id: ids.A, name: "Amy Able" }, level: 2 });
      expect(JSON.stringify(page1)).not.toContain("@client.test");
      // Page sizes: default 100, capped at 500, odd values fall back.
      expect((await api().get("/api/team").set(as(token))).body.pagination).toMatchObject({ current_page: 1, per_page: 100, last_page: 1 });
      expect((await api().get("/api/team?per_page=5000").set(as(token))).body.pagination.per_page).toBe(500);
      expect((await api().get("/api/team?per_page=0&page=x").set(as(token))).body.pagination).toMatchObject({ current_page: 1, per_page: 100 });
      const past = (await api().get("/api/team?page=9&per_page=4").set(as(token))).body;
      expect(past).toMatchObject({ team_members: [], pagination: { current_page: 9, total: 6, last_page: 2 } });
    });

    it("answers an empty network with last_page 1", async () => {
      const lone = await makeClient();
      await makeIb(lone);
      const t = await tokenFor(lone);
      expect((await api().get("/api/team").set(as(t))).body).toMatchObject({ team_members: [], summary: { total_count: 0 }, pagination: { total: 0, last_page: 1 } });
      expect((await api().get("/api/sub-ibs").set(as(t))).body).toMatchObject({ sub_ibs: [], pagination: { total: 0, last_page: 1, per_page: 500 } });
    });

    it("lists active sub-IBs only, without a type key", async () => {
      const res = (await api().get("/api/sub-ibs").set(as(token))).body;
      expect(res.pagination).toEqual({ current_page: 1, per_page: 500, total: 1, last_page: 1 });
      expect(res.sub_ibs).toEqual([
        {
          id: ids.C, sub_ib: { id: ids.C, name: "Cai Cole", display_name: `${ids.C}-Cai Cole`, client_id: String(ids.C) }, sponsor: { id: ib, name: "Ivy Broker" },
          level: 1, status: "active", joined_at: expect.any(String), created_at: expect.any(String), commissions: [],
        },
      ]);
      expect(JSON.stringify(res)).not.toContain('"type"');
    });

    it("never counts a closed or removed partner as an IB", async () => {
      const top = await makeClient();
      await makeIb(top);
      const open = await makeClient({ referredBy: top });
      const closed = await makeClient({ referredBy: top });
      const removed = await makeClient({ referredBy: top });
      for (const id of [open, closed, removed]) await makeIb(id);
      await exec(env.db, "UPDATE clients SET status = 'closed' WHERE id = ?", [closed]);
      await removeIb(removed);
      const t = await tokenFor(top);
      expect((await api().get("/api/sub-ibs").set(as(t))).body.sub_ibs.map((s: { id: number }) => s.id)).toEqual([open]);
      expect((await api().get("/api/ib-dashboard").set(as(t))).body.overall_statistics).toMatchObject({ sub_ib_count: 1, team_count: 3 });
      const team = (await api().get("/api/team").set(as(t))).body.team_members;
      expect(team.map((m: { id: number; is_ib: boolean }) => [m.id, m.is_ib])).toEqual([[open, true], [closed, false], [removed, false]]);
    });

    it("stops at 10 levels and never loops on a referral cycle", async () => {
      const root = await makeClient();
      await makeIb(root);
      let up = root;
      const chain: number[] = [];
      for (let i = 0; i < 12; i++) chain.push((up = await makeClient({ referredBy: up })));
      const deep = (await api().get("/api/team?per_page=500").set(as(await tokenFor(root)))).body;
      expect(deep.pagination.total).toBe(10);
      expect(deep.team_members.at(-1)).toMatchObject({ id: chain[9], level: 10 });

      // The IB signed up with the code of someone in their own network, and someone referred themselves.
      const loop = await makeClient();
      const child = await makeClient({ referredBy: loop });
      const grandchild = await makeClient({ referredBy: child });
      await exec(env.db, "UPDATE clients SET referred_by = ? WHERE id = ?", [grandchild, loop]);
      await makeIb(loop);
      const looped = (await api().get("/api/team").set(as(await tokenFor(loop)))).body;
      expect(looped.team_members.map((m: { id: number }) => m.id)).toEqual([child, grandchild]);
      const self = await makeClient();
      await exec(env.db, "UPDATE clients SET referred_by = id WHERE id = ?", [self]);
      await makeIb(self);
      expect((await api().get("/api/team").set(as(await tokenFor(self)))).body.pagination.total).toBe(0);
      expect((await api().get("/api/ib-referrals").set(as(await tokenFor(self)))).body.clients).toEqual([]);
      expect((await networkOf(env.db, loop)).map((m) => m.id)).toEqual([child, grandchild]);
    });

    it("cuts a network off at 20,000 members", async () => {
      const big = await makeClient();
      await makeIb(big);
      const conn = await env.db.getConnection();
      try {
        await conn.query("SET SESSION cte_max_recursion_depth = 30000");
        await conn.query(
          `INSERT INTO clients (email, first_name, last_name, referral_code, source, referred_by)
           WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20005)
           SELECT CONCAT('cap', i, '@client.test'), 'Cap', 'Member', CONCAT('CAP', LPAD(i, 8, '0')), 'portal', ? FROM n`,
          [big],
        );
      } finally {
        conn.release();
      }
      expect(await networkOf(env.db, big)).toHaveLength(20_000);
      const res = (await api().get("/api/team?per_page=500&page=40").set(as(await tokenFor(big)))).body;
      expect(res.pagination).toEqual({ current_page: 40, per_page: 500, total: 20_000, last_page: 40 });
      expect(res.team_members).toHaveLength(500);
    });

    it("sends empty commission and bonus lists with the envelopes both front ends check", async () => {
      const commissions = await api().get("/api/ib-commissions?type=IB&page=2&per_page=20").set(as(token));
      expect(commissions.body).toEqual({ success: true, commissions: [], summary: { total_count: 0, total_amount: 0, total_paid: 0 }, pagination: { current_page: 2, per_page: 20, total: 0, last_page: 1 } });
      for (const type of ["Team", "SUB_IB"]) expect((await api().get(`/api/ib-commissions?type=${type}`).set(as(token))).status).toBe(200);
      expect((await api().get("/api/ib-commissions?per_page=500").set(as(token))).body.pagination.per_page).toBe(100);
      const bad = await api().get("/api/ib-commissions?type=ib").set(as(token));
      expect(bad.status).toBe(422);
      expect(bad.body.errors.type).toBeDefined();
      expect((await api().get("/api/direct-bonuses?current_page=3&per_page=10").set(as(token))).body).toEqual({ success: true, data: [], total: 0, current_page: 3, per_page: 10, last_page: 1 });
      for (const url of ["/api/team-ledger", "/api/direct-team-ledger"]) {
        expect((await api().get(`${url}?month=${thisMonth()}`).set(as(token))).body).toEqual({ success: true, data: [] });
        expect((await api().get(`${url}?month=2026-00`).set(as(token))).status).toBe(422);
      }
    });
  });

  describe("POST /api/transfer/ib-to-wallet", () => {
    it("refuses with a definite answer and moves nothing", async () => {
      const ib = await makeClient();
      await makeIb(ib);
      const token = await tokenFor(ib);
      const ledger = async () => Number((await one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM ledger_transactions"))!.n);
      const before = await ledger();
      const res = await api().post("/api/transfer/ib-to-wallet").set(as(token)).field("amount", "25");
      expect(res.status).toBe(422);
      expect(res.body).toEqual({ message: "Your IB commission balance is USD 0.00.", errors: { amount: ["Your IB commission balance is USD 0.00, so there is nothing to transfer yet."] } });
      expect((await api().post("/api/transfer/ib-to-wallet").set(as(token)).send({ amount: 10 })).status).toBe(422);
      for (const amount of ["", "abc", "0", "1.234"]) {
        const bad = await api().post("/api/transfer/ib-to-wallet").set(as(token)).send({ amount });
        expect(bad.status).toBe(422);
        expect(bad.body.errors.amount[0]).not.toContain("IB commission balance");
      }
      expect(await ledger()).toBe(before);
    });

    it("checks view-only, the partnership, then the money gate", async () => {
      const ib = await makeClient();
      await makeIb(ib);
      const viewOnly = await api().post("/api/transfer/ib-to-wallet").set(as(await tokenFor(ib, true))).send({ amount: 10 });
      expect([viewOnly.status, viewOnly.body.message]).toEqual([403, VIEW_ONLY]);
      const notIb = await api().post("/api/transfer/ib-to-wallet").set(as(await tokenFor(await makeClient()))).send({ amount: 10 });
      expect([notIb.status, notIb.body.message]).toEqual([403, NOT_IB]);
      const frozen = await makeClient({ status: "frozen" });
      await makeIb(frozen);
      const f = await api().post("/api/transfer/ib-to-wallet").set(as(await tokenFor(frozen))).send({ amount: 10 });
      expect([f.status, f.body.message]).toEqual([403, "Your account is frozen. Deposits, withdrawals and transfers are paused."]);
      const unverified = await makeClient({ kyc: "rejected" });
      await makeIb(unverified);
      const k = await api().post("/api/transfer/ib-to-wallet").set(as(await tokenFor(unverified))).send({ amount: 10 });
      expect([k.status, k.body.message]).toEqual([403, KYC]);
    });

    it("limits transfer attempts to 30 an hour", async () => {
      const ib = await makeClient();
      await makeIb(ib);
      const token = await tokenFor(ib);
      for (let i = 0; i < 30; i++) expect((await api().post("/api/transfer/ib-to-wallet").set(as(token)).send({ amount: 10 })).status).toBe(422);
      const res = await api().post("/api/transfer/ib-to-wallet").set(as(token)).send({ amount: 10 });
      expect(res.status).toBe(429);
      expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    });
  });

  describe("GET /api/user", () => {
    it("sends the sponsor's code as referred_by, the own code apart, and the IB status", async () => {
      const sponsor = await makeClient();
      const id = await makeClient({ referredBy: sponsor });
      const token = await tokenFor(id);
      const user = async () => (await api().get("/api/user").set(as(token))).body;
      const first = await user();
      expect(first).toMatchObject({ own_referral_code: await codeOf(id), referred_by: await codeOf(sponsor), is_ib: false, ib_status: "none" });
      expect(first).not.toHaveProperty("referral_code");
      expect((await api().get("/api/user").set(as(await tokenFor(sponsor)))).body.referred_by).toBeNull();
      await api().post("/api/ib-request").set(as(token)).send({ terms: true });
      expect(await user()).toMatchObject({ is_ib: false, ib_status: "pending" });
      const t = (await one<{ id: number }>(env.db, "SELECT id FROM ib_tiers WHERE position = 1"))!;
      const app = (await one<{ id: number }>(env.db, "SELECT id FROM ib_applications WHERE client_id = ?", [id]))!;
      await exec(env.db, "UPDATE ib_applications SET status = 'approved', tier_id = ? WHERE id = ?", [t.id, app.id]);
      await exec(env.db, "INSERT INTO ib_partners (client_id, application_id, tier_id, approved_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP(3))", [id, app.id, t.id]);
      expect(await user()).toMatchObject({ is_ib: true, ib_status: "approved" });
      await removeIb(id);
      expect(await user()).toMatchObject({ is_ib: false, ib_status: "rejected" });
    });
  });
});
