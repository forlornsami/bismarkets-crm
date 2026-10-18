import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import pino from "pino";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadGatewayConfig } from "../src/gateway/config";
import { createGatewayLogger } from "../src/gateway/log";
import { createGatewayServer, type GatewayServer } from "../src/gateway/server";
import { createApp } from "../src/server/app";
import { createClientSession } from "../src/server/clients/session";
import { verifyAuditChain } from "../src/server/lib/audit";
import { exec, one, rows, transaction } from "../src/server/lib/db";
import { verifyLedger } from "../src/server/money/ledger";
import { httpGateway, type Mt5Gateway } from "../src/server/mt5/gateway";
import { settleBalanceOp } from "../src/server/mt5/operations";
import { resolveMt5Once } from "../src/server/mt5/resolver";
import { startFakeMt5, type FakeMt5 } from "./fakes/mt5-webapi";
import { createStaff, hasDb, post, setup, signIn, stepUp, type SignedIn, type TestEnv } from "./helpers";

// Staff balance and credit changes along the whole path: the CRM app with
// the real httpGateway, the real gateway server, and a fake MT5 over TLS
// with the real sign-in. Checks that the two sides agree on credit (MT5
// deal action 3), on the margin check, and on finding a lost credit deal.

const SECRET = `crm-adj-${randomBytes(16).toString("hex")}`;
const MANAGER = "Live-Manager-1!";
const MASTER = "Trade-Me-42!";
const INVESTOR = "Look-Only-7?";
const STANDARD = "real\\standard";
const NOTE = "Goodwill credit agreed with the dealing desk";

describe.skipIf(!hasDb)("staff MT5 balance and credit changes end to end", () => {
  let env: TestEnv;
  let live: FakeMt5;
  let gateway: GatewayServer;
  let mt5: Mt5Gateway;
  let classic = 0;
  let seq = 0;
  let ann: SignedIn;
  let ben: SignedIn;
  const crmLines: string[] = [];
  const gatewayLines: string[] = [];
  const crmLog = pino({ level: "debug" }, { write: (line: string) => void crmLines.push(line) });

  const ask = (accountId: number, kind: string, amountCents: number) =>
    post(ann, `/api/staff/mt5/accounts/${accountId}/adjustments`, { kind, amountCents, reasonCode: "other", note: NOTE });
  const approve = (opId: number) => post(ben, `/api/staff/mt5/operations/${opId}/approve`);
  /** Asked for by one person and approved by the other. */
  async function made(accountId: number, kind: string, amountCents: number) {
    const asked = await ask(accountId, kind, amountCents);
    expect(asked.status).toBe(201);
    const res = await approve(asked.body.operation.id);
    return { res, opId: asked.body.operation.id as number, reference: asked.body.operation.reference as string };
  }
  const user = (login: number) => live.state.users.get(login)!;
  const dealsWith = (comment: string) => live.state.deals.filter((d) => d.comment === comment).map((d) => ({ action: d.action, profitCents: d.profitCents }));
  const kinds = async (opId: number) =>
    (await rows<{ kind: string }>(env.db, "SELECT kind FROM ledger_transactions WHERE source_type = 'mt5_op' AND source_id = ? ORDER BY id", [opId])).map((r) => r.kind);
  const sent = () => live.state.requests.filter((r) => r.path === "/api/trade/balance").length;
  const clean = async () => expect(await verifyLedger(env.db)).toEqual([]);

  async function liveAccount() {
    seq++;
    const r = await exec(
      env.db,
      "INSERT INTO clients (email, first_name, last_name, referral_code, source, kyc_status, status) VALUES (?, 'Ada', ?, ?, 'portal', 'approved', 'active')",
      [`adj.e2e.${seq}@client.test`, `Client${seq}`, `AE${String(seq).padStart(8, "0")}`],
    );
    const { token } = await transaction(env.db, (conn) => createClientSession(conn, env.config, r.insertId, "127.0.0.1", "vitest"));
    const res = await request(env.app).post("/api/mt5-accounts").set({ Authorization: `Bearer ${token}` })
      .send({ is_demo: false, account_package_id: classic, leverage: "2000", password: MASTER, investor_password: INVESTOR });
    expect(res.status).toBe(200);
    const login = Number(res.body.account.login);
    const id = Number((await one<{ id: number }>(env.db, "SELECT id FROM mt5_accounts WHERE server_code = 'live' AND login = ?", [login]))!.id);
    return { clientId: r.insertId, login, id };
  }

  beforeAll(async () => {
    live = await startFakeMt5({ managers: { 9000: MANAGER }, tzOffsetMinutes: 180 });
    gateway = createGatewayServer(
      loadGatewayConfig({
        GATEWAY_SECRET: SECRET, GATEWAY_LOG_LEVEL: "debug", GATEWAY_SERVERS: "live", GATEWAY_SERVER_LIVE_HOST: live.host, GATEWAY_SERVER_LIVE_PORT: String(live.port),
        GATEWAY_SERVER_LIVE_LOGIN: "9000", GATEWAY_SERVER_LIVE_PASSWORD: MANAGER, GATEWAY_SERVER_LIVE_CERT_SHA256: live.certSha256, GATEWAY_SERVER_LIVE_GROUPS: STANDARD,
        GATEWAY_SERVER_LIVE_TZ_OFFSET_MINUTES: "180", GATEWAY_LEVERAGES: "100,500,2000",
      }),
      { log: createGatewayLogger("debug", { write: (line: string) => void gatewayLines.push(line) }), pingIntervalMs: 0 },
    );
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    const port = (gateway.address() as AddressInfo).port;
    env = await setup({ CRM_MT5_GATEWAY_URL: `http://127.0.0.1:${port}`, CRM_MT5_GATEWAY_SECRET: SECRET });
    mt5 = httpGateway({ url: `http://127.0.0.1:${port}`, secret: SECRET, fetch, log: crmLog });
    env.app = createApp({ db: env.db, config: env.config, log: crmLog, fetch: (async () => new Response("", { status: 503 })) as typeof fetch, mt5 });
    await exec(env.db, "INSERT INTO mt5_servers (code, label, is_enabled) VALUES ('live', 'Live', 1)");
    await exec(env.db, "UPDATE mt5_settings SET leverages = '2000,500' WHERE id = 1");
    classic = (await exec(env.db, "INSERT INTO account_packages (name, spread_label, min_deposit_cents, server_code, mt5_group) VALUES ('Classic', '1.2', 0, 'live', ?)", [STANDARD])).insertId;
    // Admins are kept out of these changes (ADMIN_KEEPS_OUT_OF), so the two people are Super Admins.
    await createStaff(env.db, "ann@crm.test", "super_admin");
    await createStaff(env.db, "ben@crm.test", "super_admin");
    ann = await signIn(env, "ann@crm.test");
    ben = await signIn(env, "ben@crm.test");
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => gateway?.close(() => resolve()));
    await live?.close();
    await env?.db.end();
  });

  beforeEach(async () => {
    for (const o of await rows<{ id: number }>(env.db, "SELECT id FROM mt5_balance_ops WHERE status IN ('sending', 'unknown')")) {
      await settleBalanceOp(env.db, Number(o.id), { status: "failed", failure: "test", clientMessage: "test" });
    }
    await stepUp(env, ann);
    await stepUp(env, ben);
  });
  afterEach(() => live.faults.clear());

  it("makes each change in MT5 as one deal of the right kind, within the figures MT5 gives now", async () => {
    const { clientId, login, id } = await liveAccount();
    const creditIn = await made(id, "credit_in", 5_000);
    expect(creditIn.res.status).toBe(200);
    expect(dealsWith(creditIn.reference)).toEqual([{ action: 3, profitCents: 5_000 }]);
    expect(user(login)).toMatchObject({ balanceCents: 0, creditCents: 5_000 });

    const balanceIn = await made(id, "balance_in", 8_000);
    expect(balanceIn.res.body.operation).toMatchObject({ status: "completed" });
    expect(dealsWith(balanceIn.reference)).toEqual([{ action: 2, profitCents: 8_000 }]);

    const creditOut = await made(id, "credit_out", 2_000);
    expect(creditOut.res.body.operation).toMatchObject({ status: "completed" });
    expect(dealsWith(creditOut.reference)).toEqual([{ action: 3, profitCents: -2_000 }]);
    expect(user(login)).toMatchObject({ balanceCents: 8_000, creditCents: 3_000 });

    // Read from MT5 through the gateway: balance 80, credit 30, no margin used, so 80 can come out, and 30 of credit.
    expect((await ask(id, "balance_out", 8_001)).body.error).toMatchObject({ code: "OVER_WITHDRAWABLE", details: { withdrawableCents: 8_000 } });
    expect((await ask(id, "credit_out", 3_001)).body.error).toMatchObject({ code: "OVER_CREDIT", details: { creditCents: 3_000 } });
    const balanceOut = await made(id, "balance_out", 3_000);
    expect(balanceOut.res.body.operation).toMatchObject({ status: "completed" });
    expect(dealsWith(balanceOut.reference)).toEqual([{ action: 2, profitCents: -3_000 }]);
    expect(user(login)).toMatchObject({ balanceCents: 5_000, creditCents: 3_000 });

    expect(await kinds(balanceIn.opId)).toEqual(["mt5_adjust_in"]);
    expect(await kinds(balanceOut.opId)).toEqual(["mt5_adjust_out"]);
    expect(await kinds(creditIn.opId)).toEqual([]);
    expect(await kinds(creditOut.opId)).toEqual([]);
    expect(Number((await one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM client_notifications WHERE client_id = ?", [clientId]))!.n)).toBe(4);
    await clean();
  });

  it("lets MT5's margin check refuse credit that open trades still need, and nothing changes", async () => {
    const { login, id } = await liveAccount();
    await made(id, "credit_in", 5_000);
    // Credit 50 with 40 of it holding margin: only 10 is free.
    user(login).marginCents = 4_000;
    const out = await made(id, "credit_out", 3_000);
    expect(out.res.status).toBe(422);
    expect(out.res.body.error).toMatchObject({ code: "MT5_REFUSED", details: { failure: "no_money" } });
    expect(dealsWith(out.reference)).toEqual([]);
    expect(user(login).creditCents).toBe(5_000);
    expect(await kinds(out.opId)).toEqual([]);
    await clean();
  });

  it("when the answer to a credit change is lost, answers 202 and the resolver finds the credit deal through the gateway, once", async () => {
    const { login, id } = await liveAccount();
    const asked = await ask(id, "credit_in", 2_500);
    live.faults.next("/api/trade/balance", { drop: "after" });
    const lost = await approve(asked.body.operation.id);
    expect(lost.status).toBe(202);
    expect(lost.body.operation).toMatchObject({ status: "unknown", failure: "connection" });
    const reference = asked.body.operation.reference as string;
    expect(dealsWith(reference)).toEqual([{ action: 3, profitCents: 2_500 }]);

    const sends = sent();
    await exec(env.db, "UPDATE mt5_balance_ops SET next_check_at = NULL WHERE id = ?", [asked.body.operation.id]);
    expect(await resolveMt5Once(env.db, mt5, crmLog)).toEqual({ ops: 1, accounts: 0 });
    expect(await resolveMt5Once(env.db, mt5, crmLog)).toEqual({ ops: 0, accounts: 0 });
    const op = await one<{ status: string; mt5_ticket: number }>(env.db, "SELECT status, mt5_ticket FROM mt5_balance_ops WHERE id = ?", [asked.body.operation.id]);
    expect(op).toMatchObject({ status: "completed", mt5_ticket: live.state.deals.find((d) => d.comment === reference)!.ticket });
    // Only searched: nothing was sent again.
    expect(sent()).toBe(sends);
    expect(user(login).creditCents).toBe(2_500);
    await clean();
  });

  it("left no secret in either log, and the audit chain is whole", async () => {
    for (const secret of [SECRET, MANAGER, MASTER, INVESTOR]) {
      expect(crmLines.join("")).not.toContain(secret);
      expect(gatewayLines.join("")).not.toContain(secret);
    }
    expect((await verifyAuditChain(env.db)).ok).toBe(true);
  });
});
