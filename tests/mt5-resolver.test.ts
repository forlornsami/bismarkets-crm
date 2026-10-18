import type { Logger } from "pino";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { lockClient } from "../src/server/clients/kyc";
import { createClientSession } from "../src/server/clients/session";
import { exec, one, rows, transaction } from "../src/server/lib/db";
import { depositMethodAccount, lockWallet, postLedger, walletAccount } from "../src/server/money/ledger";
import { newReference } from "../src/server/money/references";
import { DEMO_FAILED, insertBalanceOp, settleBalanceOp } from "../src/server/mt5/operations";
import { checkAccount, checkBalanceOp, resolveMt5Once } from "../src/server/mt5/resolver";
import { FakeGateway } from "./fakes/gateway";
import { hasDb, setup, type TestEnv } from "./helpers";

const MASTER = "Trade-Me-42!";
const INVESTOR = "Look-Only-7?";

interface Client {
  id: number;
  token: string;
}

/** A logger that keeps what it was told, to check what staff would see in the logs. */
function capture() {
  const lines: { level: string; obj: Record<string, unknown>; msg: string }[] = [];
  const at = (level: string) => (obj: Record<string, unknown>, msg = "") => void lines.push({ level, obj, msg });
  const log = { info: at("info"), warn: at("warn"), error: at("error") } as unknown as Pick<Logger, "info" | "warn" | "error">;
  return { log, lines };
}

describe.skipIf(!hasDb)("MT5 resolver", () => {
  let env: TestEnv;
  const fake = new FakeGateway();
  let { log, lines } = capture();
  const api = () => request(env.app);
  const bearer = (c: Client) => ({ Authorization: `Bearer ${c.token}` });
  let classic = 0;
  let depositMethod = 0;
  let seq = 0;

  async function makeClient(): Promise<Client> {
    seq++;
    const r = await exec(
      env.db,
      "INSERT INTO clients (email, first_name, last_name, referral_code, source, kyc_status, status) VALUES (?, 'Ann', 'Lee', ?, 'portal', 'approved', 'active')",
      [`resolver.${seq}@client.test`, `RS${String(seq).padStart(8, "0")}`],
    );
    const { token } = await transaction(env.db, (conn) => createClientSession(conn, env.config, r.insertId, "127.0.0.1", "vitest"));
    return { id: r.insertId, token };
  }

  async function fund(clientId: number, cents: number) {
    await transaction(env.db, async (conn) => {
      await lockClient(conn, clientId);
      const wallet = await lockWallet(conn, clientId);
      const d = await exec(
        conn,
        `INSERT INTO deposits (reference, client_id, wallet_id, payment_method_id, method_name, status, currency, amount_minor, usd_rate, amount_cents, received_minor, credited_cents)
         VALUES (?, ?, ?, ?, 'Bank', 'approved', 'USD', ?, 1, ?, ?, ?)`,
        [newReference("D"), clientId, wallet.id, depositMethod, cents, cents, cents, cents],
      );
      await postLedger(conn, { kind: "deposit", sourceType: "deposit", sourceId: d.insertId, clientId, staffId: null, memo: "test deposit" }, [
        { account: walletAccount(clientId), amount: cents },
        { account: depositMethodAccount(depositMethod), amount: -cents },
      ]);
    });
  }

  const realBody = { is_demo: false, account_package_id: 0, leverage: "2000", password: MASTER, investor_password: INVESTOR };
  const create = (c: Client, body: Record<string, unknown>) => api().post("/api/mt5-accounts").set(bearer(c)).send(body);
  const resolve = () => resolveMt5Once(env.db, fake, log);
  /** Makes rows due now, as if their wait had passed. */
  const due = (table: "mt5_accounts" | "mt5_balance_ops", id: number) => exec(env.db, `UPDATE ${table} SET next_check_at = NULL WHERE id = ?`, [id]);
  /** Ages a row so the resolver may give up on it (ten minutes after the request). */
  const age = (table: "mt5_accounts" | "mt5_balance_ops", id: number, minutes = 11) =>
    exec(env.db, `UPDATE ${table} SET created_at = created_at - INTERVAL ${minutes} MINUTE, next_check_at = NULL WHERE id = ?`, [id]);
  const accountOf = (id: number) => one<Record<string, unknown>>(env.db, "SELECT status, login, failure, checks, next_check_at FROM mt5_accounts WHERE id = ?", [id]);
  const opOf = (id: number) => one<Record<string, unknown>>(env.db, "SELECT status, failure, checks, next_check_at, mt5_ticket, client_message FROM mt5_balance_ops WHERE id = ?", [id]);
  const lastAccount = async (clientId: number) => Number((await one<{ id: number }>(env.db, "SELECT id FROM mt5_accounts WHERE client_id = ? ORDER BY id DESC LIMIT 1", [clientId]))!.id);
  const soon = (d: unknown, ms: number) => {
    const at = (d as Date).getTime() - Date.now();
    expect(at).toBeGreaterThan(ms - 5_000);
    expect(at).toBeLessThanOrEqual(ms + 1_000);
  };

  /** A demo account opened and funded through the API. */
  async function demoAccount() {
    const c = await makeClient();
    const res = await create(c, { is_demo: true, demo_amount: 1000, leverage: "2000", password: MASTER, investor_password: INVESTOR });
    expect(res.status).toBe(200);
    const login = Number(res.body.account.login);
    const accountId = Number((await one<{ id: number }>(env.db, "SELECT id FROM mt5_accounts WHERE login = ? AND server_code = 'demo'", [login]))!.id);
    return { c, login, accountId };
  }

  /** A demo top-up written the way the route writes it, not yet sent. */
  async function pendingTopUp(clientId: number, accountId: number, login: number, cents = 50_000) {
    return transaction(env.db, async (conn) => {
      await lockClient(conn, clientId);
      return insertBalanceOp(conn, { purpose: "demo_topup", clientId, accountId, serverCode: "demo", login, amountCents: cents, ip: "127.0.0.1" });
    });
  }

  beforeAll(async () => {
    env = await setup({}, { mt5: fake });
    await exec(env.db, "INSERT INTO mt5_servers (code, label, is_enabled) VALUES ('live', 'Live', 1), ('demo', 'Demo', 1)");
    await exec(env.db, "UPDATE mt5_settings SET demo_server_code = 'demo', demo_group = 'demo\\\\usd', leverages = '2000,500' WHERE id = 1");
    classic = (
      await exec(env.db, "INSERT INTO account_packages (name, spread_label, min_deposit_cents, server_code, mt5_group) VALUES ('Classic', '1.2', 0, 'live', 'real\\\\standard')")
    ).insertId;
    realBody.account_package_id = classic;
    depositMethod = (
      await exec(env.db, "INSERT INTO payment_methods (direction, kind, name, currency, network, bank_name, account_title, account_number, wallet_address, ask_qr) VALUES ('deposit', 'bank', 'Bank', 'USD', '', 'Bank', 'BIS Markets', '0101', '', 0)")
    ).insertId;
  }, 120_000);
  afterAll(async () => env?.db.end());
  beforeEach(async () => {
    fake.clearFaults();
    fake.down = false;
    ({ log, lines } = capture());
    // Each test starts with nothing left for the resolver.
    await exec(env.db, "UPDATE mt5_balance_ops SET status = 'failed', failure = 'test' WHERE status IN ('sending', 'unknown')");
    await exec(env.db, "UPDATE mt5_accounts SET status = 'failed', failure = 'test' WHERE status IN ('creating', 'unknown')");
  });

  // ---------- Accounts ----------

  it("activates an account whose create answer was lost, without creating it again", async () => {
    const c = await makeClient();
    fake.failNext("user.create", { kind: "unknown-after" });
    const lost = await create(c, realBody);
    expect(lost.status).toBe(409);
    const id = await lastAccount(c.id);
    const row = (await accountOf(id))!;
    expect(row).toMatchObject({ status: "unknown", login: null, failure: "timeout" });
    soon(row.next_check_at, 60_000);

    // Not due yet: nothing is looked at.
    expect(await resolve()).toEqual({ ops: 0, accounts: 0 });
    expect(fake.callsTo("user.find")).toHaveLength(0);

    await due("mt5_accounts", id);
    const creates = fake.callsTo("user.create").length;
    expect(await resolve()).toEqual({ ops: 0, accounts: 1 });
    const { create_ref: ref } = (await one<{ create_ref: string }>(env.db, "SELECT create_ref FROM mt5_accounts WHERE id = ?", [id]))!;
    const made = [...fake.users.values()].find((u) => u.comment === ref)!;
    expect(made).toBeDefined();
    expect(await accountOf(id)).toMatchObject({ status: "active", login: made.login, next_check_at: null });
    expect(fake.callsTo("user.create")).toHaveLength(creates);
    expect(fake.callsTo("user.find").at(-1)!.req).toMatchObject({ server: "live", group: "real\\standard" });

    const audit = await one<{ actor_type: string; actor_label: string; meta_json: Record<string, unknown> }>(
      env.db, "SELECT actor_type, actor_label, meta_json FROM audit_log WHERE action = 'mt5.account.created' AND entity_id = ?", [String(c.id)],
    );
    expect(audit).toMatchObject({ actor_type: "system", actor_label: "MT5 resolver", meta_json: { login: made.login, foundBy: "resolver", server: "live" } });

    // The client now sees it, and may open another.
    const list = await api().get("/api/mt5-accounts").set(bearer(c));
    expect(list.body.real_accounts).toEqual([expect.objectContaining({ login: String(made.login), status: "active", archived: false })]);
    expect((await create(c, realBody)).status).toBe(200);
    // Settled once: a second pass finds nothing to do.
    expect(await resolve()).toEqual({ ops: 0, accounts: 0 });
  });

  it("fails an account MT5 never made after three searches and ten minutes, backing off between them", async () => {
    const c = await makeClient();
    fake.failNext("user.create", { kind: "unknown-before" });
    expect((await create(c, realBody)).status).toBe(409);
    const id = await lastAccount(c.id);
    const creates = fake.callsTo("user.create").length;

    for (const [checks, wait] of [[1, 2], [2, 4], [3, 8]] as const) {
      await due("mt5_accounts", id);
      expect(await resolve()).toEqual({ ops: 0, accounts: 1 });
      const row = (await accountOf(id))!;
      // Three searches are not enough while the request is younger than ten minutes.
      expect(row).toMatchObject({ status: "unknown", failure: "not_found", checks });
      soon(row.next_check_at, wait * 60_000);
    }
    await age("mt5_accounts", id);
    expect(await resolve()).toEqual({ ops: 0, accounts: 1 });
    expect(await accountOf(id)).toMatchObject({ status: "failed", failure: "not_found", checks: 4, next_check_at: null, login: null });
    expect(fake.callsTo("user.create")).toHaveLength(creates);
    expect(await one(env.db, "SELECT actor_type, JSON_EXTRACT(meta_json, '$.reason') AS reason FROM audit_log WHERE action = 'mt5.account.create_failed' AND entity_id = ?", [String(c.id)])).toEqual({
      actor_type: "system", reason: "not_found",
    });
    expect(lines.filter((l) => l.level === "warn").map((l) => l.msg)).toContain("MT5 account was never created; settled as failed");
    // Not shown, and no longer holding up a new account.
    expect((await api().get("/api/mt5-accounts").set(bearer(c))).body.real_accounts).toEqual([]);
    expect((await create(c, realBody)).status).toBe(200);
  });

  it("does not count a search MT5 could not answer, and waits an hour on a refused one", async () => {
    const c = await makeClient();
    fake.failNext("user.create", { kind: "unknown-before" });
    await create(c, realBody);
    const id = await lastAccount(c.id);

    await due("mt5_accounts", id);
    fake.down = true;
    await resolve();
    fake.down = false;
    let row = (await accountOf(id))!;
    expect(row).toMatchObject({ status: "unknown", checks: 0 });
    soon(row.next_check_at, 60_000);

    // MT5 switched off in the CRM: same.
    await due("mt5_accounts", id);
    await resolveMt5Once(env.db, null, log);
    row = (await accountOf(id))!;
    expect(row).toMatchObject({ status: "unknown", checks: 0 });

    await due("mt5_accounts", id);
    fake.failNext("user.find", { kind: "refused", code: "group_not_allowed" });
    await resolve();
    row = (await accountOf(id))!;
    expect(row).toMatchObject({ status: "unknown", checks: 0, failure: "group_not_allowed" });
    soon(row.next_check_at, 3_600_000);
    expect(lines.find((l) => l.level === "error")).toMatchObject({ obj: { accountId: id, kind: "refused", code: "group_not_allowed" } });
  });

  it("picks up a create a stopped process left 'creating', but not one still in flight", async () => {
    const c = await makeClient();
    const insert = async (ref: string) =>
      (
        await exec(
          env.db,
          "INSERT INTO mt5_accounts (client_id, server_code, is_demo, package_id, package_name, mt5_group, leverage, status, create_ref) VALUES (?, 'live', 0, ?, 'Classic', 'real\\\\standard', 2000, 'creating', ?)",
          [c.id, classic, ref],
        )
      ).insertId;
    const stuck = await insert("BIS-ASTUCK001");
    const fresh = await insert("BIS-AFRESH001");
    await exec(env.db, "UPDATE mt5_accounts SET updated_at = CURRENT_TIMESTAMP(3) - INTERVAL 3 MINUTE WHERE id = ?", [stuck]);
    const made = fake.addUser("live", { group: "real\\standard", comment: "BIS-ASTUCK001" });

    expect(await resolve()).toEqual({ ops: 0, accounts: 1 });
    expect(await accountOf(stuck)).toMatchObject({ status: "active", login: made.login });
    expect(await accountOf(fresh)).toMatchObject({ status: "creating", checks: 0 });
  });

  it("holds a found account for staff when its login is already linked to another row", async () => {
    const c = await makeClient();
    const taken = await create(c, realBody);
    const login = Number(taken.body.account.login);
    const id = (
      await exec(
        env.db,
        "INSERT INTO mt5_accounts (client_id, server_code, is_demo, package_id, package_name, mt5_group, leverage, status, create_ref) VALUES (?, 'live', 0, ?, 'Classic', 'real\\\\standard', 2000, 'unknown', 'BIS-ATAKEN001')",
        [c.id, classic],
      )
    ).insertId;
    // MT5 shows the same login under this create's reference (a broker-side mix-up).
    fake.users.get(`live:${login}`)!.comment = "BIS-ATAKEN001";
    expect(await resolve()).toEqual({ ops: 0, accounts: 1 });
    const row = (await accountOf(id))!;
    expect(row).toMatchObject({ status: "unknown", failure: "login_taken", login: null, checks: 0 });
    soon(row.next_check_at, 3_600_000);
    expect(lines.find((l) => l.level === "error")).toMatchObject({ obj: { accountId: id, login } });
  });

  it("leaves an account another check already settled alone", async () => {
    const c = await makeClient();
    fake.failNext("user.create", { kind: "unknown-after" });
    await create(c, realBody);
    const id = await lastAccount(c.id);
    expect(await checkAccount(env.db, fake, id, log)).toBe("completed");
    expect(await checkAccount(env.db, fake, id, log)).toBe("skipped");
    expect(await one(env.db, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'mt5.account.created' AND entity_id = ?", [String(c.id)])).toEqual({ n: 1 });
  });

  // ---------- Balance operations ----------

  it("completes a demo funding whose answer was lost, exactly once and without sending it again", async () => {
    const c = await makeClient();
    fake.failNext("balance", { kind: "unknown-after" });
    const res = await create(c, { is_demo: true, demo_amount: 2500, leverage: "500", password: MASTER, investor_password: INVESTOR });
    expect(res.status).toBe(200);
    // The account is open; the starting balance is not confirmed yet, so it is not shown.
    expect(res.body.account).toMatchObject({ is_demo: true, balance: 0 });
    const login = Number(res.body.account.login);
    const op = (await one<{ id: number; reference: string }>(env.db, "SELECT id, reference FROM mt5_balance_ops WHERE login = ?", [login]))!;
    expect(await opOf(op.id)).toMatchObject({ status: "unknown", failure: "timeout", checks: 0 });

    await due("mt5_balance_ops", op.id);
    expect(await resolve()).toEqual({ ops: 1, accounts: 0 });
    const [deal] = fake.dealsOf("demo", login);
    expect(await opOf(op.id)).toMatchObject({ status: "completed", failure: null, mt5_ticket: deal!.ticket, next_check_at: null });
    expect(fake.callsTo("balance").filter((x) => x.req.login === login)).toHaveLength(1);
    expect(fake.callsTo("deal.find").at(-1)!.req).toMatchObject({ server: "demo", login, comment: op.reference });
    // The settled amount shows in the snapshot straight away.
    expect(await one(env.db, "SELECT balance_cents FROM mt5_accounts WHERE login = ? AND server_code = 'demo'", [login])).toEqual({ balance_cents: 250_000 });

    // A late answer to the original send, or another check, changes nothing.
    expect(await settleBalanceOp(env.db, op.id, { status: "completed", ticket: deal!.ticket }, ["sending"])).toMatchObject({ settled: false });
    expect(await checkBalanceOp(env.db, fake, op.id, log)).toBe("skipped");
    expect(await one(env.db, "SELECT balance_cents FROM mt5_accounts WHERE login = ? AND server_code = 'demo'", [login])).toEqual({ balance_cents: 250_000 });
    expect(await resolve()).toEqual({ ops: 0, accounts: 0 });
  });

  it("completes a top-up that answered 202 once the deal is found", async () => {
    const { c, login } = await demoAccount();
    fake.failNext("balance", { kind: "unknown-before" }, 1);
    // MT5 did make it, though the gateway said it timed out first: the deal is there.
    const top = await api().post("/api/mt5-accounts/demo/top-up").set(bearer(c)).send({ login, amount: 300 });
    expect(top.status).toBe(202);
    const op = (await one<{ id: number; reference: string; amount_cents: number }>(env.db, "SELECT id, reference, amount_cents FROM mt5_balance_ops WHERE login = ? AND purpose = 'demo_topup'", [login]))!;
    fake.addDeal("demo", { login, comment: op.reference, profitCents: 30_000 });
    await due("mt5_balance_ops", op.id);
    expect(await resolve()).toEqual({ ops: 1, accounts: 0 });
    expect(await opOf(op.id)).toMatchObject({ status: "completed" });
  });

  it("fails a demo operation MT5 never made after three searches and ten minutes", async () => {
    const { login, accountId, c } = await demoAccount();
    fake.failNext("balance", { kind: "unknown-before" });
    const top = await api().post("/api/mt5-accounts/demo/top-up").set(bearer(c)).send({ login, amount: 300 });
    expect(top.status).toBe(202);
    const op = (await one<{ id: number }>(env.db, "SELECT id FROM mt5_balance_ops WHERE mt5_account_id = ? AND purpose = 'demo_topup'", [accountId]))!;
    const sent = fake.callsTo("balance").length;
    for (const checks of [1, 2, 3]) {
      await due("mt5_balance_ops", op.id);
      await resolve();
      expect(await opOf(op.id)).toMatchObject({ status: "unknown", failure: "not_found", checks });
    }
    await age("mt5_balance_ops", op.id);
    await resolve();
    expect(await opOf(op.id)).toMatchObject({ status: "failed", failure: "not_found", client_message: DEMO_FAILED, checks: 3, next_check_at: null });
    expect(fake.callsTo("balance")).toHaveLength(sent);
    // The demo balance was never moved.
    expect(fake.user("demo", login)!.balanceCents).toBe(100_000);
  });

  it("holds a deal that carries the reference but not the amount for staff, and logs it", async () => {
    const { c, login, accountId } = await demoAccount();
    const op = await pendingTopUp(c.id, accountId, login, 50_000);
    await exec(env.db, "UPDATE mt5_balance_ops SET status = 'unknown', next_check_at = NULL WHERE id = ?", [op.id]);
    fake.addDeal("demo", { login, comment: op.reference, profitCents: 5_000 });
    expect(await resolve()).toEqual({ ops: 1, accounts: 0 });
    const row = (await opOf(op.id))!;
    expect(row).toMatchObject({ status: "unknown", failure: "mismatch", checks: 0 });
    soon(row.next_check_at, 3_600_000);
    expect(lines.find((l) => l.level === "error")).toMatchObject({ obj: { opId: op.id, reference: op.reference, amountCents: 5_000, expected: 50_000 } });
    // A balance deal on another account with the reference is not this operation's either.
    expect(fake.callsTo("balance").filter((x) => x.req.comment === op.reference)).toHaveLength(0);
  });

  it("does not count unreachable searches for operations, and waits an hour on refused ones", async () => {
    const { c, login, accountId } = await demoAccount();
    const op = await pendingTopUp(c.id, accountId, login);
    await exec(env.db, "UPDATE mt5_balance_ops SET status = 'unknown', next_check_at = NULL WHERE id = ?", [op.id]);
    fake.failNext("deal.find", { kind: "unavailable" });
    await resolve();
    let row = (await opOf(op.id))!;
    expect(row).toMatchObject({ status: "unknown", checks: 0 });
    soon(row.next_check_at, 60_000);

    await due("mt5_balance_ops", op.id);
    fake.failNext("deal.find", { kind: "refused", code: "not_found" });
    await resolve();
    row = (await opOf(op.id))!;
    expect(row).toMatchObject({ status: "unknown", checks: 0, failure: "not_found" });
    soon(row.next_check_at, 3_600_000);
  });

  it("picks up an operation a stopped process left 'sending', but not one still in flight", async () => {
    const { c, login, accountId } = await demoAccount();
    const stuck = await pendingTopUp(c.id, accountId, login, 10_000);
    const fresh = await pendingTopUp(c.id, accountId, login, 20_000);
    await exec(env.db, "UPDATE mt5_balance_ops SET updated_at = CURRENT_TIMESTAMP(3) - INTERVAL 3 MINUTE WHERE id = ?", [stuck.id]);
    expect(await resolve()).toEqual({ ops: 1, accounts: 0 });
    expect(await opOf(stuck.id)).toMatchObject({ status: "unknown", failure: "not_found", checks: 1 });
    expect(await opOf(fresh.id)).toMatchObject({ status: "sending", checks: 0 });
    expect(fake.callsTo("balance").filter((x) => x.req.comment === stuck.reference || x.req.comment === fresh.reference)).toHaveLength(0);
  });

  it("never lets two passes check the same row", async () => {
    const { c, login, accountId } = await demoAccount();
    const op = await pendingTopUp(c.id, accountId, login);
    await exec(env.db, "UPDATE mt5_balance_ops SET status = 'unknown', next_check_at = NULL WHERE id = ?", [op.id]);
    const hold = fake.pause("deal.find");
    const first = resolve();
    await hold.reached;
    expect(await resolve()).toEqual({ ops: 0, accounts: 0 });
    hold.release();
    expect(await first).toEqual({ ops: 1, accounts: 0 });
    expect(fake.callsTo("deal.find").filter((x) => x.req.comment === op.reference)).toHaveLength(1);
  });

  it("carries on with the other rows when one cannot be checked", async () => {
    const { c, login, accountId } = await demoAccount();
    const a = await pendingTopUp(c.id, accountId, login, 10_000);
    const b = await pendingTopUp(c.id, accountId, login, 20_000);
    await exec(env.db, "UPDATE mt5_balance_ops SET status = 'unknown', next_check_at = NULL WHERE id IN (?, ?)", [a.id, b.id]);
    // MT5 will not search for the first one; the second is still found and settled.
    fake.addDeal("demo", { login, comment: b.reference, profitCents: 20_000 });
    fake.failNext("deal.find", { kind: "bad_request" }, 1, (r) => r.comment === a.reference);
    await resolve();
    expect(await opOf(a.id)).toMatchObject({ status: "unknown", failure: "bad_request" });
    expect(await opOf(b.id)).toMatchObject({ status: "completed" });
  });
});
