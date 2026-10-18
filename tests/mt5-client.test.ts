import pino from "pino";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app";
import { lockClient } from "../src/server/clients/kyc";
import { createClientSession } from "../src/server/clients/session";
import { exec, one, rows, transaction } from "../src/server/lib/db";
import { depositMethodAccount, lockWallet, postLedger, verifyLedger, walletAccount } from "../src/server/money/ledger";
import { newReference } from "../src/server/money/references";
import { refreshFigures, type AccountRow } from "../src/server/mt5/accounts";
import { FakeGateway, type Fault } from "./fakes/gateway";
import { createStaff, hasDb, setup, type TestEnv } from "./helpers";

const MASTER = "Trade-Me-42!";
const INVESTOR = "Look-Only-7?";
const UNAVAILABLE = "Trading accounts are temporarily unavailable. Please try again in a few minutes.";
const NOT_FOUND = { message: "Account not found." };
const VIEW_ONLY = "This is a view-only staff session. Changes are not allowed.";
const POLICY = "The password must be 8 to 16 characters with upper and lower case letters, a number and a symbol.";
const UNCONFIRMED = "We could not confirm that this change was made. Please check your account in a minute before trying again.";
const CREATE_UNCONFIRMED = "We could not confirm that your account was opened. Please check your accounts in a minute before trying again.";
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** What the app looks for before it shows its "add funds" banner. */
const APP_WALLET_MINIMUM = /must have a wallet balance of\s*(\$\s*\d+(?:,\d{3})*(?:\.\d+)?)\s*to open this account/i;

interface Client {
  id: number;
  email: string;
  token: string;
}

describe.skipIf(!hasDb)("client MT5 API", () => {
  let env: TestEnv;
  const fake = new FakeGateway();
  const api = () => request(env.app);
  const bearer = (c: Client) => ({ Authorization: `Bearer ${c.token}` });
  const pkg = { classic: 0, raw: 0, hidden: 0, off: 0 };
  let depositMethod = 0;
  let staffId = 0;
  let seq = 0;

  async function makeClient(opts: { kyc?: string; status?: string; first?: string; last?: string } = {}): Promise<Client> {
    seq++;
    const email = `mt5.${seq}@client.test`;
    const r = await exec(
      env.db,
      "INSERT INTO clients (email, first_name, last_name, referral_code, source, kyc_status, status, country) VALUES (?, ?, ?, ?, 'portal', ?, ?, 'Pakistan')",
      [email, opts.first ?? "Ann", opts.last ?? "Lee", `MT${String(seq).padStart(8, "0")}`, opts.kyc ?? "approved", opts.status ?? "active"],
    );
    const { token } = await transaction(env.db, (conn) => createClientSession(conn, env.config, r.insertId, "127.0.0.1", "vitest"));
    return { id: r.insertId, email, token };
  }

  /** Staff looking through the client's eyes. */
  async function viewAs(c: Client): Promise<Client> {
    const { token } = await transaction(env.db, (conn) => createClientSession(conn, env.config, c.id, "127.0.0.1", "vitest", { staffId, reason: "Checking accounts" }));
    return { ...c, token };
  }

  /** Money in the wallet the way an approved deposit puts it there, so the ledger checks stay clean. */
  async function fund(clientId: number, cents: number) {
    await transaction(env.db, async (conn) => {
      await lockClient(conn, clientId);
      const wallet = await lockWallet(conn, clientId);
      const d = await exec(
        conn,
        `INSERT INTO deposits (reference, client_id, wallet_id, payment_method_id, method_name, status, currency, amount_minor, usd_rate, amount_cents, received_minor, credited_cents)
         VALUES (?, ?, ?, ?, 'Meezan Bank', 'approved', 'USD', ?, 1, ?, ?, ?)`,
        [newReference("D"), clientId, wallet.id, depositMethod, cents, cents, cents, cents],
      );
      await postLedger(conn, { kind: "deposit", sourceType: "deposit", sourceId: d.insertId, clientId, staffId: null, memo: "test deposit" }, [
        { account: walletAccount(clientId), amount: cents },
        { account: depositMethodAccount(depositMethod), amount: -cents },
      ]);
    });
  }

  const realBody = (extra: Record<string, unknown> = {}) => ({
    is_demo: false, account_package_id: pkg.classic, leverage: "2000", currency: "usd", password: MASTER, investor_password: INVESTOR, ...extra,
  });
  const demoBody = (extra: Record<string, unknown> = {}) => ({ is_demo: true, demo_amount: 10000, leverage: "2000", password: MASTER, investor_password: INVESTOR, ...extra });
  const create = (c: Client, body: Record<string, unknown>) => api().post("/api/mt5-accounts").set(bearer(c)).send(body);
  const list = (c: Client) => api().get("/api/mt5-accounts").set(bearer(c));
  const accountRow = (login: string | number) => one<Record<string, unknown>>(env.db, "SELECT * FROM mt5_accounts WHERE login = ?", [Number(login)]);

  /** A funded client with one open real account. */
  async function withAccount(cents = 100_000) {
    const c = await makeClient();
    await fund(c.id, cents);
    const res = await create(c, realBody());
    expect(res.status).toBe(200);
    return { c, login: res.body.account.login as string };
  }

  beforeAll(async () => {
    env = await setup({}, { mt5: fake });
    await exec(env.db, "INSERT INTO mt5_servers (code, label, is_enabled) VALUES ('live', 'Live', 1), ('demo', 'Demo', 1), ('off', 'Old server', 0)");
    await exec(env.db, "UPDATE mt5_settings SET demo_server_code = 'demo', demo_group = 'demo\\\\usd', leverages = '2000,500' WHERE id = 1");
    const add = async (cols: Record<string, unknown>) => {
      const keys = Object.keys(cols);
      return (await exec(env.db, `INSERT INTO account_packages (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`, Object.values(cols))).insertId;
    };
    pkg.raw = await add({ name: "Raw", description: "Raw spreads", spread_label: "0.0", commission_label: "7", min_deposit_cents: 100_000, server_code: "live", mt5_group: "real\\raw", sort_order: 2 });
    pkg.classic = await add({
      name: "Classic", description: "No commission", highlights: JSON.stringify(["Spreads from 1.2 pips", "No commission"]), spread_label: "From 1.2", commission_label: null,
      min_deposit_cents: 50_000, server_code: "live", mt5_group: "real\\standard", is_recommended: 1, sort_order: 1,
    });
    pkg.hidden = await add({ name: "Hidden", spread_label: "1", min_deposit_cents: 0, server_code: "live", mt5_group: "real\\standard", is_visible: 0 });
    pkg.off = await add({ name: "Legacy", spread_label: "2", min_deposit_cents: 0, server_code: "off", mt5_group: "real\\standard", sort_order: 3 });
    depositMethod = (
      await exec(env.db, "INSERT INTO payment_methods (direction, kind, name, currency, network, bank_name, account_title, account_number, wallet_address, ask_qr) VALUES ('deposit', 'bank', 'Meezan Bank', 'USD', '', 'Meezan Bank', 'BIS Markets', '0101', '', 0)")
    ).insertId;
    staffId = await createStaff(env.db, "viewer@crm.test", "support_agent");
  }, 120_000);
  afterAll(async () => env?.db.end());
  beforeEach(() => fake.clearFaults());

  // ---------- Packages and leverages ----------

  it("lists visible packages and leverages in the shapes both clients parse", async () => {
    const c = await makeClient();
    const res = await api().get("/api/account-packages").set(bearer(c));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: [
        {
          id: pkg.classic, name: "Classic", description: "No commission", min_deposit: 500, spread: "From 1.2", commission: null,
          highlights: ["Spreads from 1.2 pips", "No commission"], currency_type: "usd", recommended: true, leverage: "2000",
        },
        { id: pkg.raw, name: "Raw", description: "Raw spreads", min_deposit: 1000, spread: "0.0", commission: "7", highlights: [], currency_type: "usd", recommended: false, leverage: "2000" },
        { id: pkg.off, name: "Legacy", description: "", min_deposit: 0, spread: "2", commission: null, highlights: [], currency_type: "usd", recommended: false, leverage: "2000" },
      ],
    });
    // Nothing about where accounts open.
    expect(JSON.stringify(res.body)).not.toMatch(/real\\|live|group|server/);

    expect((await api().get("/api/leverages").set(bearer(c))).body).toEqual({ success: true, data: ["2000", "500"] });
    expect((await api().get("/api/account-packages")).status).toBe(401);
    expect((await api().get("/api/leverages")).status).toBe(401);
  });

  // ---------- Opening accounts ----------

  it("opens a real account and the very next list shows it, with strict types and its kept passwords", async () => {
    const c = await makeClient({ first: "Zara", last: "Khan" });
    await fund(c.id, 50_000);
    expect((await list(c)).body).toEqual({ success: true, real_accounts: [], demo_accounts: [] });

    // The portal's body, with the id and leverage spelled the other accepted ways.
    const res = await create(c, realBody({ is_demo: "false", account_package_id: String(pkg.classic), leverage: "1:2000" }));
    expect(res.status).toBe(200);
    const login = res.body.account.login as string;
    expect(login).toMatch(/^\d+$/);
    const shown = {
      id: login, account_id: login, login, is_demo: false, type: "real", status: "active", archived: false, package_name: "Classic", package_id: pkg.classic,
      currency: "USD", currency_type: "usd", leverage: "2000", balance: 0, equity: 0, credit: 0,
      mt5: { login, balance: 0, equity: 0, credit: 0, margin: 0, free_margin: 0, leverage: "2000", currency: "USD" },
      server: "BISMarkets-Trade", created_at: expect.stringMatching(ISO), password: null, investor_password: null,
    };
    // The opening answer does not send the passwords back (the portal shows what was typed); the list does.
    expect(res.body).toEqual({ success: true, message: "Your account is ready.", account: shown });

    const next = await list(c);
    expect(next.body).toEqual({ success: true, real_accounts: [{ ...shown, password: MASTER, investor_password: INVESTOR }], demo_accounts: [] });

    // In MT5: the right group, leverage, name, the CRM's reference as the comment, and the passwords as typed.
    const row = (await accountRow(login))!;
    const user = fake.user("live", Number(login))!;
    expect(user).toMatchObject({ group: "real\\standard", leverage: 2000, name: "Zara Khan", email: c.email, comment: row.create_ref, passwords: { main: MASTER, investor: INVESTOR } });
    expect(row.create_ref).toMatch(/^BIS-A[0-9A-Z]{8}$/);
    expect(row).toMatchObject({ status: "active", server_code: "live", mt5_group: "real\\standard", package_id: pkg.classic, is_demo: 0, leverage: 2000 });

    // The audit names the account, never a password; neither does the gateway call log.
    const audit = await one<{ meta_json: Record<string, unknown>; actor_type: string }>(env.db, "SELECT meta_json, actor_type FROM audit_log WHERE action = 'mt5.account.created' AND entity_id = ?", [String(c.id)]);
    expect(audit).toMatchObject({ actor_type: "client", meta_json: { login: Number(login), server: "live", isDemo: false, packageId: pkg.classic, leverage: 2000 } });
    const everything = JSON.stringify(await rows(env.db, "SELECT * FROM audit_log")) + JSON.stringify(await rows(env.db, "SELECT * FROM mt5_accounts")) + JSON.stringify(fake.calls);
    expect(everything).not.toContain(MASTER);
    expect(everything).not.toContain(INVESTOR);
    // Opening an account checks the wallet but takes nothing from it.
    expect(await verifyLedger(env.db)).toEqual([]);
  });

  it("opens a demo account with its starting balance as a demo funding operation", async () => {
    const c = await makeClient();
    const res = await create(c, demoBody({ is_demo: 1, leverage: 500 }));
    expect(res.status).toBe(200);
    const login = res.body.account.login as string;
    expect(res.body.account).toMatchObject({ is_demo: true, type: "demo", package_name: "Demo", package_id: null, leverage: "500", balance: 10000, mt5: { balance: 10000, currency: "USD" } });
    const user = fake.user("demo", Number(login))!;
    expect(user).toMatchObject({ group: "demo\\usd", balanceCents: 1_000_000 });
    const op = await one<{ purpose: string; status: string; amount_cents: number; mt5_ticket: number; reference: string }>(env.db, "SELECT * FROM mt5_balance_ops WHERE login = ?", [Number(login)]);
    expect(op).toMatchObject({ purpose: "demo_funding", status: "completed", amount_cents: 1_000_000 });
    expect(op!.reference).toMatch(/^BIS-D[0-9A-Z]{8}$/);
    expect(fake.dealsOf("demo", Number(login))).toEqual([expect.objectContaining({ action: 2, profitCents: 1_000_000, comment: op!.reference, ticket: Number(op!.mt5_ticket) })]);
    const shown = await list(c);
    expect(shown.body.real_accounts).toEqual([]);
    expect(shown.body.demo_accounts).toEqual([expect.objectContaining({ login, is_demo: true, balance: 10000 })]);
  });

  it("still opens a demo account when its starting balance does not go through", async () => {
    const c = await makeClient();
    fake.failNext("balance", { kind: "refused", code: "mt5_error" });
    const res = await create(c, demoBody());
    expect(res.status).toBe(200);
    expect(res.body.account).toMatchObject({ is_demo: true, balance: 0 });
    expect(await one(env.db, "SELECT status, failure, client_message FROM mt5_balance_ops WHERE login = ?", [Number(res.body.account.login)])).toEqual({
      status: "failed", failure: "mt5_error", client_message: "We could not add the money to your demo account. Please try again later.",
    });
  });

  it("refuses staff view-only sessions on every change but lets them look", async () => {
    const { c, login } = await withAccount();
    const staff = await viewAs(c);
    expect((await list(staff)).status).toBe(200);
    expect((await api().get("/api/account-packages").set(bearer(staff))).status).toBe(200);
    const writes = [
      api().post("/api/mt5-accounts").set(bearer(staff)).send(realBody()),
      api().patch(`/api/mt5-accounts/${login}/inactive`).set(bearer(staff)),
      api().patch(`/api/mt5-accounts/${login}/active`).set(bearer(staff)),
      api().patch(`/api/mt5-accounts/${login}/leverage`).set(bearer(staff)).send({ leverage: "500" }),
      api().patch(`/api/mt5-accounts/${login}/password`).set(bearer(staff)).send({ password: "New-Pass-12", password_confirmation: "New-Pass-12" }),
      api().post("/api/mt5-accounts/demo/top-up").set(bearer(staff)).send({ login: Number(login), amount: 100 }),
    ];
    for (const res of await Promise.all(writes)) expect(res).toMatchObject({ status: 403, body: { message: VIEW_ONLY } });
    expect(fake.callsTo("user.update")).toHaveLength(0);
  });

  it("refuses frozen, closed-off and unverified clients with their usual errors", async () => {
    const newbie = await makeClient({ kyc: "pending" });
    expect(await create(newbie, demoBody())).toMatchObject({ status: 403, body: { message: "You must complete your KYC first." } });
    const frozen = await makeClient({ status: "frozen" });
    expect(await create(frozen, realBody())).toMatchObject({ status: 403, body: { message: "Your account is frozen. Deposits, withdrawals and transfers are paused." } });
    expect(fake.callsTo("user.create").filter((x) => x.req.email === newbie.email || x.req.email === frozen.email)).toEqual([]);
  });

  it("answers 'temporarily unavailable' when MT5 is off, the server is switched off, or MT5 cannot be reached", async () => {
    const c = await makeClient();
    await fund(c.id, 200_000);
    const off = createApp({ db: env.db, config: env.config, log: pino({ level: "silent" }), fetch: (async () => new Response("", { status: 503 })) as typeof fetch, mt5: null });
    const offRes = await request(off).post("/api/mt5-accounts").set(bearer(c)).send(realBody());
    expect(offRes.status).toBe(422);
    expect(offRes.body).toEqual({ message: UNAVAILABLE, errors: { mt5: [UNAVAILABLE] } });
    // Lists still answer from the database.
    expect((await request(off).get("/api/mt5-accounts").set(bearer(c))).status).toBe(200);

    expect((await create(c, realBody({ account_package_id: pkg.off }))).body).toEqual({ message: UNAVAILABLE, errors: { mt5: [UNAVAILABLE] } });

    fake.failNext("user.create", { kind: "unavailable" });
    const down = await create(c, realBody());
    expect(down.status).toBe(422);
    expect(down.body.errors).toEqual({ mt5: [UNAVAILABLE] });
    expect(await one(env.db, "SELECT status, failure FROM mt5_accounts WHERE client_id = ? ORDER BY id DESC LIMIT 1", [c.id])).toEqual({ status: "failed", failure: "unavailable" });
    // A failed attempt does not hold up the next one.
    expect((await create(c, realBody())).status).toBe(200);
  });

  it("checks the form field by field, in the clients' words", async () => {
    const c = await makeClient();
    await fund(c.id, 200_000);
    const field = async (body: Record<string, unknown>) => {
      const res = await create(c, body);
      expect(res.status).toBe(422);
      return res.body.errors;
    };
    expect(await field(realBody({ is_demo: "maybe" }))).toEqual({ is_demo: ["Choose a live or a demo account."] });
    expect(await field(realBody({ leverage: "1000" }))).toEqual({ leverage: ["This leverage is not available."] });
    expect(await field(realBody({ leverage: "lots" }))).toEqual({ leverage: ["This leverage is not available."] });
    for (const bad of ["short1!A", "nosymbol123A", "NOLOWER1!", "noupper1!", "No-digits!", "Has space1!", "Way-Too-Long-Pass1!", 12345678, undefined]) {
      if (bad === "short1!A") continue; // 8 characters with every kind: valid
      expect(await field(realBody({ password: bad }))).toEqual({ password: [POLICY] });
    }
    expect(await field(realBody({ investor_password: "x" }))).toEqual({ investor_password: [POLICY] });
    expect(await field(realBody({ investor_password: MASTER }))).toEqual({ investor_password: ["The investor password must be different from the master password."] });
    expect(await field(realBody({ account_package_id: pkg.hidden }))).toEqual({ account_package_id: ["Choose an account type."] });
    expect(await field(realBody({ account_package_id: 999_999 }))).toEqual({ account_package_id: ["Choose an account type."] });
    expect(await field(realBody({ account_package_id: undefined }))).toEqual({ account_package_id: ["Choose an account type."] });
    expect(await field(realBody({ currency: "eur" }))).toEqual({ currency: ["This account type is only available in USD."] });
    const amount = { demo_amount: ["Choose a starting balance up to $100,000.00."] };
    for (const bad of [100_001, 0, -5, "12.345", "abc", undefined]) expect(await field(demoBody({ demo_amount: bad }))).toEqual(amount);
    // Nothing reached MT5 or the database.
    expect(await one(env.db, "SELECT COUNT(*) AS n FROM mt5_accounts WHERE client_id = ?", [c.id])).toEqual({ n: 0 });
    // Currency left out is fine.
    expect((await create(c, realBody({ currency: undefined }))).status).toBe(200);
  });

  it("refuses a real account below the package's wallet minimum with the 403 the app looks for", async () => {
    const c = await makeClient();
    await fund(c.id, 99_999);
    const res = await create(c, realBody({ account_package_id: pkg.raw }));
    const message = "You must have a wallet balance of $1,000.00 to open this account.";
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ message, errors: { account_package_id: [message] } });
    expect(APP_WALLET_MINIMUM.exec(res.body.message)?.[1]).toBe("$1,000.00");
    // A package with a lower minimum opens; demo accounts need no wallet money.
    expect((await create(c, realBody({ account_package_id: pkg.classic }))).status).toBe(200);
    const poor = await makeClient();
    expect((await create(poor, demoBody())).status).toBe(200);
  });

  it("enforces the account limits and one open request at a time", async () => {
    const c = await makeClient();
    await fund(c.id, 100_000);
    await exec(env.db, "UPDATE mt5_settings SET max_live_accounts = 1 WHERE id = 1");
    try {
      expect((await create(c, realBody())).status).toBe(200);
      expect((await create(c, realBody())).body.errors).toEqual({ is_demo: ["You have reached the limit of 1 live account."] });
      // An archived account still counts; a demo one does not.
      expect((await create(c, demoBody())).status).toBe(200);
    } finally {
      await exec(env.db, "UPDATE mt5_settings SET max_live_accounts = 10 WHERE id = 1");
    }
    await exec(env.db, "UPDATE mt5_settings SET max_demo_accounts = 1 WHERE id = 1");
    try {
      expect((await create(c, demoBody())).body.errors).toEqual({ is_demo: ["You have reached the limit of 1 demo account."] });
    } finally {
      await exec(env.db, "UPDATE mt5_settings SET max_demo_accounts = 5 WHERE id = 1");
    }

    // Two at once: the second sees the first's row while MT5 is still opening it.
    const d = await makeClient();
    await fund(d.id, 100_000);
    const hold = fake.pause("user.create");
    const first = create(d, realBody()).then((r) => r);
    await hold.reached;
    const second = await create(d, demoBody());
    expect(second.status).toBe(422);
    expect(second.body.errors).toEqual({ is_demo: ["Your previous account is still being set up. Please check your accounts in a minute."] });
    hold.release();
    expect((await first).status).toBe(200);
    expect(await one(env.db, "SELECT COUNT(*) AS n FROM mt5_accounts WHERE client_id = ?", [d.id])).toEqual({ n: 1 });
  });

  it("maps MT5's refusals and a lost answer, never showing MT5's own words", async () => {
    const c = await makeClient();
    await fund(c.id, 100_000);
    fake.failNext("user.create", { kind: "refused", code: "invalid_password", message: "3006 Invalid account password" });
    const weak = await create(c, realBody());
    expect(weak.status).toBe(422);
    expect(weak.body).toEqual({ message: "MT5 did not accept this password. Choose a different one.", errors: { password: ["MT5 did not accept this password. Choose a different one."] } });
    fake.failNext("user.create", { kind: "refused", code: "limit_reached", message: "3007 Limit reached" });
    const refused = await create(c, realBody());
    expect(refused.body).toEqual({ message: "We could not open the account. Please try again later.", errors: { mt5: ["We could not open the account. Please try again later."] } });
    expect(await rows(env.db, "SELECT status, failure FROM mt5_accounts WHERE client_id = ? ORDER BY id", [c.id])).toEqual([
      { status: "failed", failure: "invalid_password" },
      { status: "failed", failure: "limit_reached" },
    ]);
    expect(await rows(env.db, "SELECT JSON_EXTRACT(meta_json, '$.reason') AS reason FROM audit_log WHERE action = 'mt5.account.create_failed' AND entity_id = ? ORDER BY id", [String(c.id)])).toEqual([
      { reason: "invalid_password" }, { reason: "limit_reached" },
    ]);

    // A lost answer is the honest 409, and nothing is sent again.
    const sent = fake.callsTo("user.create").length;
    fake.failNext("user.create", { kind: "unknown-after" });
    const lost = await create(c, realBody());
    expect(lost.status).toBe(409);
    expect(lost.body).toEqual({ message: CREATE_UNCONFIRMED });
    expect(fake.callsTo("user.create")).toHaveLength(sent + 1);
    const row = await one<{ status: string; next_check_at: Date }>(env.db, "SELECT status, next_check_at FROM mt5_accounts WHERE client_id = ? ORDER BY id DESC LIMIT 1", [c.id]);
    expect(row!.status).toBe("unknown");
    expect(row!.next_check_at.getTime()).toBeGreaterThan(Date.now());
    // Not listed, and no second account until it is settled.
    expect((await list(c)).body.real_accounts).toEqual([]);
    expect((await create(c, realBody())).body.errors).toEqual({ is_demo: ["Your previous account is still being set up. Please check your accounts in a minute."] });
  });

  // ---------- Archive, restore, leverage ----------

  it("archives and restores, and never shows 'archived' as a status", async () => {
    const { c, login } = await withAccount();
    const user = () => fake.user("live", Number(login))!;
    fake.setAccount("live", Number(login), { positions: 2 });
    const busy = await api().patch(`/api/mt5-accounts/${login}/inactive`).set(bearer(c));
    expect(busy.status).toBe(422);
    expect(busy.body.errors).toEqual({ account: ["Close your open trades before archiving this account."] });
    expect(user().tradeDisabled).toBe(false);

    fake.setAccount("live", Number(login), { positions: 0 });
    // No body and no Content-Type, as the portal sends it.
    const archived = await api().patch(`/api/mt5-accounts/${login}/inactive`).set(bearer(c));
    expect(archived.status).toBe(200);
    expect(archived.body).toEqual({ success: true, message: "Account archived." });
    expect(user()).toMatchObject({ tradeDisabled: true, enabled: true });
    expect((await list(c)).body.real_accounts[0]).toMatchObject({ login, status: "active", archived: true });
    expect((await api().patch(`/api/mt5-accounts/${login}/inactive`).set(bearer(c))).body).toEqual({ success: true, message: "Account archived." });
    expect(fake.callsTo("user.update")).toHaveLength(1);

    const lev = await api().patch(`/api/mt5-accounts/${login}/leverage`).set(bearer(c)).send({ leverage: "500" });
    expect(lev.status).toBe(422);
    expect(lev.body.errors).toEqual({ leverage: ["Restore this account before changing its leverage."] });

    const restored = await api().patch(`/api/mt5-accounts/${login}/active`).set(bearer(c));
    expect(restored.body).toEqual({ success: true, message: "Account restored." });
    expect(user().tradeDisabled).toBe(false);
    expect((await list(c)).body.real_accounts[0]).toMatchObject({ status: "active", archived: false });
    expect((await api().patch(`/api/mt5-accounts/${login}/active`).set(bearer(c))).status).toBe(200);
    expect(await rows(env.db, "SELECT action FROM audit_log WHERE action IN ('mt5.account.archived', 'mt5.account.restored') AND entity_id = ? ORDER BY id", [String(c.id)])).toEqual([
      { action: "mt5.account.archived" }, { action: "mt5.account.restored" },
    ]);
  });

  it("shows a staff-suspended account as suspended and refuses the client's archive and restore", async () => {
    const { c, login } = await withAccount();
    await exec(env.db, "UPDATE mt5_accounts SET suspended_at = CURRENT_TIMESTAMP(3), archived_at = CURRENT_TIMESTAMP(3) WHERE login = ?", [Number(login)]);
    const shown = (await list(c)).body.real_accounts[0];
    expect(shown).toMatchObject({ status: "suspended", archived: false });
    // The status is never "archived": an archived account is "active" with archived true.
    const all = JSON.stringify((await list(c)).body);
    expect(all).not.toMatch(/"status":"(archived|inactive)"/);
    expect((await api().patch(`/api/mt5-accounts/${login}/inactive`).set(bearer(c))).body.errors).toEqual({ account: ["Account already inactive"] });
    const restore = await api().patch(`/api/mt5-accounts/${login}/active`).set(bearer(c));
    expect(restore.status).toBe(422);
    expect(restore.body.errors).toEqual({ account: ["This account has been suspended. Please contact support."] });
    expect((await api().patch(`/api/mt5-accounts/${login}/password`).set(bearer(c)).send({ password: "New-Pass-12", password_confirmation: "New-Pass-12" })).status).toBe(422);
  });

  it("answers 404 for an account that is not the caller's", async () => {
    const { login } = await withAccount();
    const other = await makeClient();
    for (const path of [`/api/mt5-accounts/${login}/inactive`, `/api/mt5-accounts/${login}/active`, "/api/mt5-accounts/999999999/inactive", "/api/mt5-accounts/abc/active"]) {
      const res = await api().patch(path).set(bearer(other));
      expect(res.status).toBe(404);
      expect(res.body).toEqual(NOT_FOUND);
    }
    expect((await api().patch(`/api/mt5-accounts/${login}/leverage`).set(bearer(other)).send({ leverage: "500" })).body).toEqual(NOT_FOUND);
    const top = await api().post("/api/mt5-accounts/demo/top-up").set(bearer(other)).send({ login: Number(login), amount: 100 });
    expect(top.body.errors).toEqual({ login: ["Choose one of your demo accounts."] });
  });

  it("asks MT5 once more after a lost answer to a repeatable change, then answers 409", async () => {
    const { c, login } = await withAccount();
    fake.failNext("user.update", { kind: "unknown-before" });
    expect((await api().patch(`/api/mt5-accounts/${login}/inactive`).set(bearer(c))).status).toBe(200);
    fake.failNext("user.update", { kind: "unknown-after" }, 2);
    const lost = await api().patch(`/api/mt5-accounts/${login}/active`).set(bearer(c));
    expect(lost.status).toBe(409);
    expect(lost.body).toEqual({ message: UNCONFIRMED });
    // The CRM keeps what it knows for sure; a retry is safe.
    expect((await accountRow(login))!.archived_at).not.toBeNull();
    expect((await api().patch(`/api/mt5-accounts/${login}/active`).set(bearer(c))).status).toBe(200);
    fake.failNext("positions.total", { kind: "unavailable" });
    expect((await api().patch(`/api/mt5-accounts/${login}/inactive`).set(bearer(c))).body.errors).toEqual({ mt5: [UNAVAILABLE] });
    fake.failNext("user.update", { kind: "refused", code: "mt5_error" });
    expect((await api().patch(`/api/mt5-accounts/${login}/inactive`).set(bearer(c))).body.errors).toEqual({ mt5: ["We could not make this change. Please try again later."] });
  });

  it("answers 409, never a definite no, when the retry after a lost answer fails another way", async () => {
    const { c, login } = await withAccount();
    const user = () => fake.user("live", Number(login))!;
    const change = (path: string, body: Record<string, unknown> = {}) => api().patch(`/api/mt5-accounts/${login}/${path}`).set(bearer(c)).send(body);
    /** MT5 makes the change but its answer is lost; the retry straight after then fails as `then` says. */
    const lostThen = (op: "user.update" | "user.password", then: Fault, when?: (r: Record<string, unknown>) => boolean) => {
      fake.failNext(op, { kind: "unknown-after" }, 1, when);
      fake.failNext(op, then, 1, when);
    };
    const unconfirmed = { status: 409, body: { message: UNCONFIRMED } };

    // Archive: trading is off in MT5 although the retry never got through.
    lostThen("user.update", { kind: "unavailable" });
    expect(await change("inactive")).toMatchObject(unconfirmed);
    expect(user().tradeDisabled).toBe(true);
    expect((await accountRow(login))!.archived_at).toBeNull();
    expect((await change("inactive")).status).toBe(200);
    // Restore: back on in MT5 although the retry was refused.
    lostThen("user.update", { kind: "refused", code: "mt5_error" });
    expect(await change("active")).toMatchObject(unconfirmed);
    expect(user().tradeDisabled).toBe(false);
    expect((await accountRow(login))!.archived_at).not.toBeNull();
    expect((await change("active")).status).toBe(200);
    // Leverage.
    lostThen("user.update", { kind: "bad_request" });
    expect(await change("leverage", { leverage: "500" })).toMatchObject(unconfirmed);
    expect(user().leverage).toBe(500);
    expect((await accountRow(login))!.leverage).toBe(2000);

    // Passwords: the master one, and the investor one. Neither is recorded as changed, since neither was confirmed.
    const pairs = (main: string, investor: string) => ({ password: main, password_confirmation: main, investor_password: investor, investor_password_confirmation: investor });
    lostThen("user.password", { kind: "unavailable" });
    expect(await change("password", pairs("Lost-Main-11!", ""))).toMatchObject(unconfirmed);
    expect(user().passwords.main).toBe("Lost-Main-11!");
    lostThen("user.password", { kind: "refused", code: "invalid_password" });
    expect(await change("password", pairs("", "Lost-Inv-12!"))).toMatchObject(unconfirmed);
    expect(user().passwords.investor).toBe("Lost-Inv-12!");
    const audits = await rows<{ meta_json: { main: boolean; investor: boolean } }>(env.db, "SELECT meta_json FROM audit_log WHERE action = 'mt5.account.password_changed' AND entity_id = ?", [String(c.id)]);
    expect(audits).toEqual([]);
  });

  it("asks MT5 on a restore or a leverage the row already shows, so what a lost answer changed can be put right", async () => {
    const { c, login } = await withAccount();
    const user = () => fake.user("live", Number(login))!;
    const change = (path: string, body: Record<string, unknown> = {}) => api().patch(`/api/mt5-accounts/${login}/${path}`).set(bearer(c)).send(body);

    // An archive MT5 made twice over, with both answers lost: trading is off, the CRM shows the account open.
    fake.failNext("user.update", { kind: "unknown-after" }, 2);
    expect((await change("inactive")).status).toBe(409);
    expect(user().tradeDisabled).toBe(true);
    expect((await list(c)).body.real_accounts[0]).toMatchObject({ login, status: "active", archived: false });
    const restored = await change("active");
    expect(restored.body).toEqual({ success: true, message: "Account restored." });
    expect(user().tradeDisabled).toBe(false);
    // Nothing changed in the CRM, so nothing is recorded as restored.
    expect(await rows(env.db, "SELECT id FROM audit_log WHERE action = 'mt5.account.restored' AND entity_id = ?", [String(c.id)])).toHaveLength(0);

    // The same for a leverage change: MT5 at 1:500, the row still at 1:2000, which the client picks again.
    fake.failNext("user.update", { kind: "unknown-after" }, 2);
    expect((await change("leverage", { leverage: "500" })).status).toBe(409);
    expect(user().leverage).toBe(500);
    expect((await list(c)).body.real_accounts[0].leverage).toBe("2000");
    expect((await change("leverage", { leverage: "2000" })).body).toEqual({ success: true, message: "Leverage changed.", leverage: "2000" });
    expect(user().leverage).toBe(2000);
    expect((await accountRow(login))!.leverage).toBe(2000);
  });

  it("changes leverage, and the very next list shows it", async () => {
    const { c, login } = await withAccount();
    const res = await api().patch(`/api/mt5-accounts/${login}/leverage`).set(bearer(c)).send({ leverage: "1:500" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true });
    expect(fake.user("live", Number(login))!.leverage).toBe(500);
    expect((await list(c)).body.real_accounts[0]).toMatchObject({ leverage: "500", mt5: { leverage: "500" } });
    const audit = await one<{ before_json: unknown; after_json: unknown }>(env.db, "SELECT before_json, after_json FROM audit_log WHERE action = 'mt5.account.leverage_changed' AND entity_id = ?", [String(c.id)]);
    expect(audit).toEqual({ before_json: { leverage: 2000 }, after_json: { leverage: 500 } });

    // The app's request: back to 1:2000.
    expect((await api().patch(`/api/mt5-accounts/${login}/leverage`).set(bearer(c)).send({ leverage: "2000" })).status).toBe(200);
    expect((await list(c)).body.real_accounts[0].leverage).toBe("2000");
    // The same leverage again is still asked of MT5 (a lost answer may have left it elsewhere), but
    // changes and records nothing; one that is not offered is refused.
    const changes = (await rows(env.db, "SELECT id FROM audit_log WHERE action = 'mt5.account.leverage_changed' AND entity_id = ?", [String(c.id)])).length;
    expect((await api().patch(`/api/mt5-accounts/${login}/leverage`).set(bearer(c)).send({ leverage: 2000 })).status).toBe(200);
    expect(fake.callsTo("user.update").at(-1)!.req).toMatchObject({ login: Number(login), leverage: 2000 });
    expect(await rows(env.db, "SELECT id FROM audit_log WHERE action = 'mt5.account.leverage_changed' AND entity_id = ?", [String(c.id)])).toHaveLength(changes);
    for (const bad of ["1000", "", null]) {
      expect((await api().patch(`/api/mt5-accounts/${login}/leverage`).set(bearer(c)).send({ leverage: bad })).body.errors).toEqual({ leverage: ["This leverage is not available."] });
    }
  });

  // ---------- Passwords ----------

  it("changes passwords with an empty pair meaning unchanged, and never records them", async () => {
    const { c, login } = await withAccount();
    const change = (body: Record<string, unknown>) => api().patch(`/api/mt5-accounts/${login}/password`).set(bearer(c)).send(body);
    const pairs = (main: string, investor: string, mainConfirm = main, investorConfirm = investor) => ({
      password: main, password_confirmation: mainConfirm, investor_password: investor, investor_password_confirmation: investorConfirm,
    });
    expect((await change(pairs("", ""))).body.errors).toEqual({ password: ["Enter a new password."] });
    expect((await change({})).body.errors).toEqual({ password: ["Enter a new password."] });
    expect((await change(pairs("New-Main-12!", "", "New-Main-13!"))).body.errors).toEqual({ password_confirmation: ["The passwords do not match."] });
    expect((await change(pairs("", "New-Inv-12!", "", ""))).body.errors).toEqual({ investor_password_confirmation: ["The passwords do not match."] });
    expect((await change(pairs("weakweak", ""))).body.errors).toEqual({ password: [POLICY] });
    expect((await change(pairs("", "weakweak"))).body.errors).toEqual({ investor_password: [POLICY] });
    expect((await change(pairs("Same-Pass-12!", "Same-Pass-12!"))).body.errors).toEqual({ investor_password: ["The investor password must be different from the master password."] });

    // The app's body when only the investor password changes.
    const inv = await change(pairs("", "New-Inv-12!"));
    expect(inv.status).toBe(200);
    expect(inv.body).toEqual({ success: true, message: "Password changed." });
    expect(fake.user("live", Number(login))!.passwords).toEqual({ main: MASTER, investor: "New-Inv-12!" });
    // The portal's body when only the master one changes: the investor one sent back as the list shows it.
    expect((await change(pairs("New-Main-12!", "New-Inv-12!"))).status).toBe(200);
    expect(fake.user("live", Number(login))!.passwords).toEqual({ main: "New-Main-12!", investor: "New-Inv-12!" });

    // Both new at once, as a page with an out-of-date list sends: refused before MT5 is asked.
    const sentBefore = fake.callsTo("user.password").length;
    const sentSince = () => fake.callsTo("user.password").slice(sentBefore).map((x) => x.req.type);
    expect((await change(pairs("Third-Main-4!", "Third-Inv-4!"))).body.errors).toEqual({
      password: ["Your account's passwords have changed since this page was opened. Reload the page and try again."],
    });
    expect(sentSince()).toEqual([]);

    // MT5 turns a password down.
    fake.failNext("user.password", { kind: "refused", code: "invalid_password" });
    expect((await change(pairs("Third-Main-4!", ""))).body.errors).toEqual({ password: ["MT5 did not accept this password. Choose a different one."] });
    fake.failNext("user.password", { kind: "refused", code: "invalid_password" });
    expect((await change(pairs("", "Third-Inv-4!"))).body.errors).toEqual({ investor_password: ["MT5 did not accept this password. Choose a different one."] });
    fake.failNext("user.password", { kind: "refused", code: "mt5_error" });
    expect((await change(pairs("Third-Main-4!", ""))).body.errors).toEqual({ mt5: ["We could not make this change. Please try again later."] });
    expect(sentSince()).toEqual(["main", "investor", "main"]);
    expect(fake.user("live", Number(login))!.passwords).toEqual({ main: "New-Main-12!", investor: "New-Inv-12!" });
    // Lost twice over: 409, after one more try.
    fake.failNext("user.password", { kind: "unknown-before" }, 2);
    const lost = await change(pairs("", "Fifth-Inv-6!"));
    expect(lost.status).toBe(409);
    expect(lost.body).toEqual({ message: UNCONFIRMED });
    expect(sentSince()).toEqual(["main", "investor", "main", "investor", "investor"]);

    const audits = await rows<{ meta_json: { main: boolean; investor: boolean } }>(env.db, "SELECT meta_json FROM audit_log WHERE action = 'mt5.account.password_changed' AND entity_id = ? ORDER BY id", [String(c.id)]);
    expect(audits.map((a) => [a.meta_json.main, a.meta_json.investor])).toEqual([[false, true], [true, false]]);
    const everything = JSON.stringify(await rows(env.db, "SELECT * FROM audit_log")) + JSON.stringify(fake.calls);
    for (const p of ["New-Inv-12!", "New-Main-12!", "Third-Main-4!", "Third-Inv-4!", "Fifth-Inv-6!"]) expect(everything).not.toContain(p);
  });

  it("limits password changes to 10 an hour", async () => {
    const { c, login } = await withAccount();
    for (let i = 0; i < 10; i++) {
      const p = `Pass-Word-${i}!x`;
      expect((await api().patch(`/api/mt5-accounts/${login}/password`).set(bearer(c)).send({ password: p, password_confirmation: p })).status).toBe(200);
    }
    const res = await api().patch(`/api/mt5-accounts/${login}/password`).set(bearer(c)).send({ password: "Pass-Word-X!x", password_confirmation: "Pass-Word-X!x" });
    expect(res.status).toBe(429);
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("counts password changes sent at once, so a burst cannot pass the hourly limit", async () => {
    const { c, login } = await withAccount();
    const sent = fake.callsTo("user.password").length;
    const burst = await Promise.all(
      Array.from({ length: 30 }, (_, i) => {
        const p = `Burst-Pass-${i}!x`;
        return api().patch(`/api/mt5-accounts/${login}/password`).set(bearer(c)).send({ password: p, password_confirmation: p });
      }),
    );
    expect(burst.filter((r) => r.status === 200)).toHaveLength(10);
    expect(burst.filter((r) => r.status === 429)).toHaveLength(20);
    expect(burst.find((r) => r.status === 429)!.body).toEqual({ message: "Too many password changes. Please wait before trying again." });
    expect(fake.callsTo("user.password").length - sent).toBe(10);
  });

  it("counts an account opening where it is decided, so one let in before the limit was used up cannot pass it", async () => {
    const c = await makeClient();
    await fund(c.id, 100_000);
    const sent = fake.callsTo("user.create").length;
    // Nine openings MT5 turned down use up nine of the ten a day.
    for (let i = 0; i < 9; i++) {
      fake.failNext("user.create", { kind: "refused", code: "mt5_error" });
      expect((await create(c, demoBody())).status).toBe(422);
    }
    // A live opening gets past the early gate and is held at its first package read, before its checks...
    let reached!: () => void;
    let release!: () => void;
    const arrived = new Promise<void>((resolve) => (reached = resolve));
    const held = new Promise<void>((resolve) => (release = resolve));
    const query = env.db.query.bind(env.db) as (...args: unknown[]) => Promise<unknown>;
    const spy = vi.spyOn(env.db, "query").mockImplementation((async (...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].includes("p.is_visible = 1") && !args[0].includes("FOR SHARE")) {
        spy.mockRestore();
        reached();
        await held;
      }
      return query(...args);
    }) as never);
    const live = create(c, realBody()).then((r) => r);
    await arrived;
    // ...while the tenth is asked of MT5.
    fake.failNext("user.create", { kind: "refused", code: "mt5_error" });
    expect((await create(c, demoBody())).status).toBe(422);
    release();
    const res = await live;
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ message: "You have opened too many accounts today. Please try again tomorrow." });
    expect(fake.callsTo("user.create").length - sent).toBe(10);
    expect(await rows(env.db, "SELECT id FROM mt5_accounts WHERE client_id = ? AND is_demo = 0", [c.id])).toHaveLength(0);
  });

  // ---------- Demo top-ups ----------

  it("tops up a demo account within the caps", async () => {
    const c = await makeClient();
    const opened = await create(c, demoBody({ demo_amount: 50_000 }));
    const login = Number(opened.body.account.login);
    const top = (body: Record<string, unknown>) => api().post("/api/mt5-accounts/demo/top-up").set(bearer(c)).send(body);

    const ok = await top({ login, amount: 500 });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ success: true, message: "Your demo account was topped up." });
    expect(fake.user("demo", login)!.balanceCents).toBe(5_050_000);
    expect((await list(c)).body.demo_accounts[0]).toMatchObject({ balance: 50_500, mt5: { balance: 50_500 } });

    expect((await top({ login, amount: 10_001 })).body.errors).toEqual({ amount: ["You can add up to $10,000.00 at a time."] });
    expect((await top({ login, amount: 0 })).body.errors).toEqual({ amount: ["The amount must be more than zero."] });
    expect((await top({ login, amount: 1.234 })).body.errors).toEqual({ amount: ["Use at most two decimal places."] });
    // The live balance counts: trading profits push it towards the cap.
    fake.setAccount("demo", login, { balanceCents: 99_500_000 });
    expect((await top({ login, amount: 5000.01 })).body.errors).toEqual({ amount: ["Demo accounts can hold up to $1,000,000.00."] });
    expect((await top({ login, amount: 5000 })).status).toBe(200);
    fake.setAccount("demo", login, { balanceCents: 5_000_000 });

    // A live account is not a demo account.
    const { c: owner, login: live } = await withAccount();
    expect((await api().post("/api/mt5-accounts/demo/top-up").set(bearer(owner)).send({ login: Number(live), amount: 100 })).body.errors).toEqual({ login: ["Choose one of your demo accounts."] });
    await exec(env.db, "UPDATE mt5_accounts SET archived_at = CURRENT_TIMESTAMP(3) WHERE login = ?", [login]);
    expect((await top({ login, amount: 10 })).body.errors).toEqual({ login: ["Restore this account before topping it up."] });
    await exec(env.db, "UPDATE mt5_accounts SET archived_at = NULL WHERE login = ?", [login]);

    fake.failNext("balance", { kind: "refused", code: "trade_disabled" });
    const failed = await top({ login, amount: 10 });
    expect(failed.status).toBe(422);
    expect(failed.body.errors).toEqual({ amount: ["We could not add the money to your demo account. Please try again later."] });
    fake.failNext("balance", { kind: "unknown-before" });
    const lost = await top({ login, amount: 10 });
    expect(lost.status).toBe(202);
    expect(lost.body).toEqual({ success: true, message: "Your top-up is being processed." });
    expect(await rows(env.db, "SELECT purpose, status, failure FROM mt5_balance_ops WHERE login = ? ORDER BY id", [login])).toEqual([
      { purpose: "demo_funding", status: "completed", failure: null },
      { purpose: "demo_topup", status: "completed", failure: null },
      { purpose: "demo_topup", status: "completed", failure: null },
      { purpose: "demo_topup", status: "failed", failure: "trade_disabled" },
      { purpose: "demo_topup", status: "unknown", failure: "timeout" },
    ]);
    expect(await rows(env.db, "SELECT JSON_EXTRACT(meta_json, '$.amountCents') AS cents FROM audit_log WHERE action = 'mt5.demo.top_up_requested' AND entity_id = ? ORDER BY id", [String(c.id)])).toHaveLength(4);
  });

  it("counts top-ups sent at once, and every attempt, since each one reads the account in MT5 first", async () => {
    const c = await makeClient();
    const login = Number((await create(c, demoBody({ demo_amount: 1000 }))).body.account.login);
    const top = (amount: number) => api().post("/api/mt5-accounts/demo/top-up").set(bearer(c)).send({ login, amount });
    const topUps = async () => (await rows(env.db, "SELECT id FROM mt5_balance_ops WHERE login = ? AND purpose = 'demo_topup'", [login])).length;

    const burst = await Promise.all(Array.from({ length: 30 }, () => top(100)));
    expect(burst.filter((r) => r.status === 200)).toHaveLength(20);
    expect(burst.filter((r) => r.status === 429)).toHaveLength(10);
    expect(await topUps()).toBe(20);
    expect(fake.callsTo("balance").filter((x) => x.req.login === login)).toHaveLength(21);

    // A client at the cap who keeps trying: every try reads MT5, so the tries are limited too.
    const d = await makeClient();
    const full = Number((await create(d, demoBody({ demo_amount: 1000 }))).body.account.login);
    fake.setAccount("demo", full, { balanceCents: 100_000_000 });
    const reads = fake.callsTo("accounts.get").length;
    for (let i = 0; i < 60; i++) {
      const res = await api().post("/api/mt5-accounts/demo/top-up").set(bearer(d)).send({ login: full, amount: 100 });
      expect(res.body.errors).toEqual({ amount: ["Demo accounts can hold up to $1,000,000.00."] });
    }
    expect(fake.callsTo("accounts.get").length - reads).toBe(60);
    const res = await api().post("/api/mt5-accounts/demo/top-up").set(bearer(d)).send({ login: full, amount: 100 });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ message: "Too many top-ups. Please wait before trying again." });
    expect(fake.callsTo("accounts.get").length - reads).toBe(60);
  });

  it("answers 'temporarily unavailable' for a top-up MT5 was never reached for", async () => {
    const c = await makeClient();
    const login = Number((await create(c, demoBody())).body.account.login);
    for (const fault of [{ kind: "unavailable" }, { kind: "bad_request" }] as Fault[]) {
      fake.failNext("balance", fault);
      const res = await api().post("/api/mt5-accounts/demo/top-up").set(bearer(c)).send({ login, amount: 10 });
      expect(res.status).toBe(422);
      expect(res.body).toEqual({ message: UNAVAILABLE, errors: { mt5: [UNAVAILABLE] } });
    }
    expect(await rows(env.db, "SELECT status, failure FROM mt5_balance_ops WHERE login = ? AND purpose = 'demo_topup' ORDER BY id", [login])).toEqual([
      { status: "failed", failure: "unavailable" },
      { status: "failed", failure: "bad_request" },
    ]);
  });

  // ---------- Live figures ----------

  it("shows live figures when the snapshot is old, the snapshot when MT5 is down, and a balance for a never-read account", async () => {
    const { c, login } = await withAccount();
    fake.setAccount("live", Number(login), { balanceCents: 123_456, creditCents: 1000, marginCents: 20_000, profitCents: -456 });
    // Read moments ago: shown as it is.
    expect((await list(c)).body.real_accounts[0]).toMatchObject({ balance: 0 });
    await exec(env.db, "UPDATE mt5_accounts SET snapshot_at = CURRENT_TIMESTAMP(3) - INTERVAL 1 MINUTE WHERE login = ?", [Number(login)]);
    expect((await list(c)).body.real_accounts[0]).toMatchObject({
      balance: 1234.56, credit: 10, equity: 1240, mt5: { balance: 1234.56, credit: 10, equity: 1240, margin: 200, free_margin: 1040, currency: "USD" },
    });
    expect(await one(env.db, "SELECT balance_cents, equity_cents FROM mt5_accounts WHERE login = ?", [Number(login)])).toEqual({ balance_cents: 123_456, equity_cents: 124_000 });

    fake.setAccount("live", Number(login), { balanceCents: 1 });
    await exec(env.db, "UPDATE mt5_accounts SET snapshot_at = CURRENT_TIMESTAMP(3) - INTERVAL 1 MINUTE WHERE login = ?", [Number(login)]);
    fake.down = true;
    try {
      expect((await list(c)).body.real_accounts[0]).toMatchObject({ balance: 1234.56, mt5: { balance: 1234.56 } });
    } finally {
      fake.down = false;
    }

    // An account MT5 has never been read for (an import): no mt5 object, a zero balance, never an error.
    await exec(env.db, "UPDATE mt5_accounts SET snapshot_at = NULL, balance_cents = NULL, equity_cents = NULL, credit_cents = NULL WHERE login = ?", [Number(login)]);
    fake.down = true;
    try {
      expect((await list(c)).body.real_accounts[0]).toMatchObject({ balance: 0, equity: 0, credit: 0, mt5: null });
    } finally {
      fake.down = false;
    }
  });

  it("reads MT5 once for a burst of list requests, and not again for 15 seconds even when that read failed", async () => {
    const { c, login } = await withAccount();
    const stale = (l: string) => exec(env.db, "UPDATE mt5_accounts SET snapshot_at = CURRENT_TIMESTAMP(3) - INTERVAL 1 MINUTE WHERE login = ?", [Number(l)]);
    const reads = () => fake.callsTo("accounts.get").length;
    fake.setAccount("live", Number(login), { balanceCents: 4_200 });
    await stale(login);
    const before = reads();
    const burst = await Promise.all(Array.from({ length: 40 }, () => list(c)));
    expect(burst.every((r) => r.status === 200)).toBe(true);
    expect(reads() - before).toBe(1);
    expect((await list(c)).body.real_accounts[0].balance).toBe(42);

    // MT5 out of reach: the read is tried once, and the list keeps answering from the snapshot meanwhile.
    const other = await withAccount();
    await stale(other.login);
    fake.down = true;
    try {
      const tried = reads();
      for (let i = 0; i < 5; i++) expect((await list(other.c)).body.real_accounts[0]).toMatchObject({ login: other.login, balance: 0 });
      expect(reads() - tried).toBe(1);
    } finally {
      fake.down = false;
    }
  });

  it("logs a batch of figures MT5 refuses, and keeps the snapshot", async () => {
    const { c, login } = await withAccount();
    const [row] = await rows<AccountRow>(env.db, "SELECT * FROM mt5_accounts WHERE login = ?", [Number(login)]);
    const warned: { obj: unknown; msg: string }[] = [];
    const log = { warn: (obj: unknown, msg: string) => void warned.push({ obj, msg }) };
    fake.failNext("accounts.get", { kind: "refused", code: "group_not_allowed" });
    const [kept] = await refreshFigures(env.db, fake, [{ ...row!, id: Number(row!.id), login: Number(login), snapshot_at: null }], { log });
    expect(kept).toMatchObject({ snapshot_at: null });
    expect(warned).toEqual([{ obj: expect.objectContaining({ server: "live", err: expect.objectContaining({ kind: "refused", code: "group_not_allowed" }) }), msg: "MT5 figures could not be read" }]);
    expect(c.id).toBeGreaterThan(0);
  });

  // ---------- Trade history ----------

  it("answers the empty trade-history envelope with its own paging", async () => {
    const c = await makeClient();
    const get = async (query: string) => (await api().get(`/api/trade-history${query}`).set(bearer(c))).body;
    expect(await get("")).toEqual({
      success: true,
      filters: { from_date: null, to_date: null, account_id: null },
      summary: { total_trades: 0, total_profit: 0, total_volume: 0, total_commission: 0 },
      pagination: { current_page: 1, per_page: 100, total: 0, last_page: 1 },
      trades: [],
    });
    expect((await get("?per_page=500")).pagination).toEqual({ current_page: 1, per_page: 500, total: 0, last_page: 1 });
    expect((await get("?per_page=1000&page=3")).pagination).toEqual({ current_page: 3, per_page: 500, total: 0, last_page: 1 });
    expect((await get("?per_page=0")).pagination.per_page).toBe(1);
    expect((await get("?per_page=lots&page=x")).pagination).toEqual({ current_page: 1, per_page: 100, total: 0, last_page: 1 });
    expect((await get("?from_date=2026-06-04&to_date=2026-09-04&account_id=2491")).filters).toEqual({ from_date: "2026-06-04", to_date: "2026-09-04", account_id: "2491" });
    expect((await api().get("/api/trade-history")).status).toBe(401);
  });
});
