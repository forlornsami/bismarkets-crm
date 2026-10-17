import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WITHDRAWAL_CHECKLIST, WITHDRAWAL_REJECT_REASONS } from "../src/shared/money";
import { lockClient } from "../src/server/clients/kyc";
import { writeAudit } from "../src/server/lib/audit";
import { encryptBytes, encryptField, sha256 } from "../src/server/lib/crypto";
import { exec, one, rows, transaction } from "../src/server/lib/db";
import { depositMethodAccount, holdAccount, lockWallet, payoutAccount, postLedger, verifyLedger, walletAccount } from "../src/server/money/ledger";
import { destinationFingerprint, newReference } from "../src/server/money/references";
import { createStaff, hasDb, post, setup, signIn, stepUp, TEST_DB_URL, type SignedIn, type TestEnv } from "./helpers";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const FIRST = WITHDRAWAL_CHECKLIST.first.map((i) => i.key);
const SECOND = WITHDRAWAL_CHECKLIST.second.map((i) => i.key);
const PAY = WITHDRAWAL_CHECKLIST.pay.map((i) => i.key);
const W = (id: number) => `/api/staff/withdrawals/${id}`;
const FROZEN = "This account is frozen, so money cannot move until it is unfrozen. You can still reject.";
const SAME_PERSON = "You gave the first approval, so another person must give the second.";
const TWO_PERSON = "You approved this withdrawal on your own, so another person must pay it.";

describe.skipIf(!hasDb)("staff withdrawals", () => {
  let env: TestEnv;
  let agentA: SignedIn;
  let agentB: SignedIn;
  let managerA: SignedIn;
  let managerB: SignedIn;
  let support: SignedIn;
  let auditor: SignedIn;
  let sales: SignedIn;
  let scoped: SignedIn;
  let noStepUp: SignedIn;
  let bankType: number;
  let cryptoType: number;
  let bankDeposit: number;
  let cryptoDeposit: number;
  let seq = 0;
  let accountSeq = 0;
  let payoutRef = 0;

  // ---- Seeding by direct inserts, as the client API would leave things ----

  async function makeClient(opts: { first?: string; last?: string; status?: string; kyc?: string; assigned?: number | null } = {}) {
    seq++;
    const r = await exec(
      env.db,
      "INSERT INTO clients (email, first_name, last_name, referral_code, source, kyc_status, status, assigned_staff_id, country) VALUES (?, ?, ?, ?, 'portal', ?, ?, ?, 'Pakistan')",
      [`payout${seq}@client.test`, opts.first ?? "Ali", opts.last ?? "Khan", `WD${String(seq).padStart(8, "0")}`, opts.kyc ?? "approved", opts.status ?? "active", opts.assigned ?? null],
    );
    return r.insertId;
  }

  /** An approved deposit with its wallet credit, so verifyLedger stays clean. */
  async function fund(clientId: number, cents: number, opts: { method?: number; decidedAt?: Date } = {}) {
    const method = opts.method ?? bankDeposit;
    const at = opts.decidedAt ?? new Date(Date.now() - 10 * DAY);
    await transaction(env.db, async (conn) => {
      await lockClient(conn, clientId);
      const wallet = await lockWallet(conn, clientId);
      const d = await exec(
        conn,
        `INSERT INTO deposits (reference, client_id, wallet_id, payment_method_id, method_name, status, currency, amount_minor, usd_rate, amount_cents, received_minor, credited_cents, decided_at, created_at)
         VALUES (?, ?, ?, ?, ?, 'approved', 'USD', ?, 1, ?, ?, ?, ?, ?)`,
        [newReference("D"), clientId, wallet.id, method, method === bankDeposit ? "Meezan Bank" : "USDT TRC20", cents, cents, cents, cents, at, at],
      );
      await postLedger(conn, { kind: "deposit", sourceType: "deposit", sourceId: d.insertId, clientId, staffId: null, memo: "test deposit" }, [
        { account: walletAccount(clientId), amount: cents },
        { account: depositMethodAccount(method), amount: -cents },
      ]);
    });
  }

  interface Payout {
    id: number;
    clientId: number;
    type: number;
    kind: "bank" | "crypto";
    methodName: string;
    accountName: string;
    accountNumber: string;
    iban: string;
    token: string | null;
    qr: Buffer | null;
  }

  /** A saved payout account, encrypted like Section A item 14. */
  async function payoutMethod(
    clientId: number,
    opts: { type?: number; accountName?: string; accountNumber?: string; iban?: string; qr?: Buffer; addedAt?: Date; methodName?: string } = {},
  ): Promise<Payout> {
    const type = opts.type ?? bankType;
    const kind = type === bankType ? "bank" : "crypto";
    // Each account is different (all ending 6702), so no two clients share one unless a test says so.
    const accountNumber = opts.accountNumber ?? `PK36SCBL${String(++accountSeq).padStart(8, "0")}00006702`;
    const iban = opts.iban ?? "";
    const token = opts.qr ? randomBytes(16).toString("hex") : null;
    const at = opts.addedAt ?? new Date(Date.now() - 30 * DAY);
    const r = await exec(
      env.db,
      `INSERT INTO client_payout_methods (client_id, payment_method_id, method_name, account_name, account_number_enc, iban_enc, fingerprint, qr_mime, qr_bytes_enc, qr_token, is_default, created_at, details_changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [
        clientId, type, opts.methodName ?? (kind === "bank" ? "My HBL" : "My Tron wallet"), opts.accountName ?? (kind === "bank" ? "Ali Khan" : ""),
        encryptField(env.config.dataKey, accountNumber, `payout_method:${clientId}:account_number`),
        iban ? encryptField(env.config.dataKey, iban, `payout_method:${clientId}:iban`) : null,
        destinationFingerprint(env.config.dataKey, type, iban || accountNumber),
        opts.qr ? "image/png" : null, opts.qr && token ? encryptBytes(env.config.dataKey, opts.qr, `payout_qr:${clientId}:${token}`) : null, token, at, at,
      ],
    );
    return {
      id: r.insertId, clientId, type, kind, methodName: opts.methodName ?? (kind === "bank" ? "My HBL" : "My Tron wallet"),
      accountName: opts.accountName ?? (kind === "bank" ? "Ali Khan" : ""), accountNumber, iban, token, qr: opts.qr ?? null,
    };
  }

  /** A withdrawal with its money held and its destination snapshot encrypted (Section A item 13). */
  async function withdraw(p: Payout, cents: number, opts: { flag?: boolean; createdAt?: Date } = {}) {
    return transaction(env.db, async (conn) => {
      await lockClient(conn, p.clientId);
      const wallet = await lockWallet(conn, p.clientId);
      const reference = newReference("W");
      const snapshot = {
        methodName: p.methodName, typeName: p.kind === "bank" ? "Bank transfer" : "USDT TRC20", kind: p.kind, network: p.kind === "bank" ? "" : "trc20",
        accountName: p.accountName, accountNumber: p.accountNumber, iban: p.iban, swift: p.kind === "bank" ? "SCBLPKKA" : "", payoutMethodId: p.id, qrToken: p.token,
      };
      const w = await exec(
        conn,
        `INSERT INTO withdrawals (reference, client_id, wallet_id, payout_method_id, payment_method_id, method_name, amount_cents, needs_second_approval, destination_enc, destination_fingerprint, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          reference, p.clientId, wallet.id, p.id, p.type, p.methodName, cents, opts.flag ? 1 : 0,
          encryptField(env.config.dataKey, JSON.stringify(snapshot), `withdrawal:${reference}`), destinationFingerprint(env.config.dataKey, p.type, p.iban || p.accountNumber),
          opts.createdAt ?? new Date(),
        ],
      );
      await postLedger(conn, { kind: "withdrawal_hold", sourceType: "withdrawal", sourceId: w.insertId, clientId: p.clientId, staffId: null, memo: "test hold" }, [
        { account: walletAccount(p.clientId), amount: -cents },
        { account: holdAccount(p.clientId), amount: cents },
      ]);
      return { id: w.insertId, reference };
    });
  }

  /** An earlier withdrawal already paid out, so the next one is not the client's first. */
  async function paidEarlier(p: Payout, cents = 1000) {
    const w = await withdraw(p, cents, { createdAt: new Date(Date.now() - 20 * DAY) });
    await transaction(env.db, async (conn) => {
      await lockClient(conn, p.clientId);
      await lockWallet(conn, p.clientId);
      await postLedger(conn, { kind: "withdrawal_paid", sourceType: "withdrawal", sourceId: w.id, clientId: p.clientId, staffId: null, memo: "test paid" }, [
        { account: holdAccount(p.clientId), amount: -cents },
        { account: payoutAccount(p.type), amount: cents },
      ]);
      await exec(conn, "UPDATE withdrawals SET status = 'paid', paid_at = ?, decided_at = ? WHERE id = ?", [new Date(Date.now() - 19 * DAY), new Date(Date.now() - 19 * DAY), w.id]);
    });
    return w;
  }

  /** A funded client with a bank payout account and one earlier paid withdrawal. */
  async function regular(opts: { first?: string; last?: string; assigned?: number | null; fundCents?: number } = {}) {
    const clientId = await makeClient(opts);
    await fund(clientId, opts.fundCents ?? 1_000_000);
    const payout = await payoutMethod(clientId, { accountName: `${opts.first ?? "Ali"} ${opts.last ?? "Khan"}` });
    await paidEarlier(payout);
    return { clientId, payout };
  }

  const wallet = (clientId: number) =>
    one<{ available_cents: number; held_cents: number }>(env.db, "SELECT available_cents, held_cents FROM wallets WHERE client_id = ?", [clientId]).then((w) => ({
      available: Number(w!.available_cents), held: Number(w!.held_cents),
    }));
  const statusOf = (id: number) => one<{ status: string }>(env.db, "SELECT status FROM withdrawals WHERE id = ?", [id]).then((r) => r!.status);
  const auditOf = (action: string, withdrawalId: number) =>
    rows<{ actor_id: number; meta_json: Record<string, unknown>; before_json: unknown; after_json: unknown }>(
      env.db, "SELECT actor_id, meta_json, before_json, after_json FROM audit_log WHERE action = ? AND meta_json->'$.withdrawalId' = ? ORDER BY id", [action, withdrawalId],
    );
  const events = (reference: string) =>
    rows<{ event: string; payload: Record<string, unknown> }>(env.db, "SELECT event, payload FROM webhook_outbox WHERE JSON_UNQUOTE(payload->'$.reference_id') = ? ORDER BY id", [reference]);
  const bells = (clientId: number) =>
    rows<{ type: string; title: string; body: string; link: string; link_label: string }>(env.db, "SELECT type, title, body, link, link_label FROM client_notifications WHERE client_id = ? ORDER BY id", [clientId]);
  const emails = (clientId: number) =>
    rows<{ template: string; subject: string; body_text: string }>(env.db, "SELECT template, subject, body_text FROM email_outbox WHERE client_id = ? ORDER BY id", [clientId]);
  const ledgerOf = (id: number) =>
    rows<{ kind: string; account: string; amount_cents: number }>(
      env.db,
      "SELECT t.kind, e.account, e.amount_cents FROM ledger_transactions t JOIN ledger_entries e ON e.transaction_id = t.id WHERE t.source_type = 'withdrawal' AND t.source_id = ? ORDER BY e.id",
      [id],
    ).then((list) => list.map((e) => ({ ...e, amount_cents: Number(e.amount_cents) })));

  const approve = (s: SignedIn, id: number, body: Record<string, unknown> = {}) => post(s, `${W(id)}/approve`, { checklist: FIRST, ...body });
  const secondApprove = (s: SignedIn, id: number, body: Record<string, unknown> = {}) => post(s, `${W(id)}/second-approve`, { checklist: SECOND, ...body });
  const pay = (s: SignedIn, id: number, body: Record<string, unknown> = {}) =>
    post(s, `${W(id)}/pay`, { payoutReference: `FT-${++payoutRef}-${seq}`, paidOn: today(), checklist: PAY, ...body });
  const reject = (s: SignedIn, id: number, reason = "We could not send money to this account. Please check the account details and request again.") =>
    post(s, `${W(id)}/reject`, { reason });
  const summary = (s: SignedIn) => s.agent.get("/api/staff/withdrawals/summary").then((r) => r.body);

  beforeAll(async () => {
    env = await setup({ CRM_STEPUP_MINUTES: "30" });
    const role = await exec(env.db, "INSERT INTO roles (slug, name) VALUES ('payout_scoped', 'Scoped payouts')");
    for (const p of ["client.view", "withdrawal.view", "withdrawal.process"]) await exec(env.db, "INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)", [role.insertId, p]);
    const people: [string, string][] = [
      ["agent.a@crm.test", "finance_agent"], ["agent.b@crm.test", "finance_agent"], ["manager.a@crm.test", "finance_manager"], ["manager.b@crm.test", "finance_manager"],
      ["support@crm.test", "support_agent"], ["auditor@crm.test", "auditor"], ["sales@crm.test", "sales_agent"], ["scoped@crm.test", "payout_scoped"], ["nostep@crm.test", "finance_manager"],
    ];
    for (const [email, slug] of people) await createStaff(env.db, email, slug);
    const signed: SignedIn[] = [];
    for (const [email] of people) signed.push(await signIn(env, email));
    [agentA, agentB, managerA, managerB, support, auditor, sales, scoped, noStepUp] = signed as [SignedIn, SignedIn, SignedIn, SignedIn, SignedIn, SignedIn, SignedIn, SignedIn, SignedIn];
    for (const s of [agentA, agentB, managerA, managerB, support, auditor, scoped]) await stepUp(env, s);
    const method = (sql: string) => exec(env.db, `INSERT INTO payment_methods (direction, kind, name, currency, network, bank_name, account_title, account_number, wallet_address, ask_qr) VALUES ${sql}`);
    bankType = (await method("('withdrawal', 'bank', 'Bank transfer', 'USD', '', '', '', '', '', 0)")).insertId;
    cryptoType = (await method("('withdrawal', 'crypto', 'USDT TRC20', 'USD', 'trc20', '', '', '', '', 1)")).insertId;
    bankDeposit = (await method("('deposit', 'bank', 'Meezan Bank', 'USD', '', 'Meezan Bank', 'BIS Markets', '0101', '', 0)")).insertId;
    cryptoDeposit = (await method("('deposit', 'crypto', 'USDT TRC20', 'USD', 'trc20', '', '', '', 'TXyz', 0)")).insertId;
  }, 120_000);
  afterAll(async () => env?.db.end());

  it("lists and shows withdrawals by permission, masking payout details for view-only staff", async () => {
    const { clientId, payout } = await regular();
    const w = await withdraw(payout, 10_000);

    expect((await sales.agent.get("/api/staff/withdrawals")).status).toBe(403);
    expect((await sales.agent.get(W(w.id))).status).toBe(403);

    const list = await support.agent.get("/api/staff/withdrawals");
    expect(list.status).toBe(200);
    const item = list.body.items.find((i: { id: number }) => i.id === w.id);
    expect(item).toEqual({
      id: w.id, reference: w.reference, clientId, clientName: "Ali Khan", clientEmail: expect.stringMatching(/@client\.test$/), clientStatus: "active", kycStatus: "approved",
      methodName: "My HBL", typeName: "Bank transfer", kind: "bank", network: "", amountCents: 10_000, status: "pending", needsSecondApproval: false,
      firstReviewedBy: null, approvedBy: null, paidBy: null, createdAt: expect.any(String), approvedAt: null, paidAt: null, claimedBy: null, destinationEnding: "6702",
      firstReviewedAt: null, decidedBy: null, decidedAt: null,
    });

    // View-only staff see the request and the last four characters, never the account number itself.
    for (const viewer of [support, auditor]) {
      const res = await viewer.agent.get(W(w.id));
      expect(res.status).toBe(200);
      expect(res.body.destination).toEqual({
        methodName: "My HBL", typeName: "Bank transfer", kind: "bank", network: "", accountName: "Ali Khan", accountNumber: "••••6702", iban: "", swift: "SCBLPKKA",
        hasQr: false, qrUrl: null, full: false,
      });
      expect(JSON.stringify(res.body)).not.toContain(payout.accountNumber);
      expect(res.body.can.approve).toEqual({ ok: false, reason: expect.stringMatching(/permission/) });
      expect(res.body.can.reject.ok).toBe(false);
    }
    expect((await auditOf("withdrawal.viewed", w.id)).map((a) => a.meta_json)).toEqual([
      { withdrawalId: w.id, reference: w.reference, full: false },
      { withdrawalId: w.id, reference: w.reference, full: false },
    ]);
    // ...and cannot act on it, see its QR code, claim it or ask for the next one.
    expect((await approve(support, w.id)).status).toBe(403);
    expect((await reject(auditor, w.id)).status).toBe(403);
    expect((await post(support, `${W(w.id)}/claim`)).status).toBe(403);
    expect((await post(auditor, "/api/staff/withdrawals/next")).status).toBe(403);
    expect((await support.agent.get(`${W(w.id)}/qr`).set("X-CRM-Viewer", "1")).status).toBe(403);

    const full = await agentA.agent.get(W(w.id));
    expect(full.status).toBe(200);
    expect(full.body.destination).toMatchObject({ accountNumber: payout.accountNumber, full: true });
    expect((await auditOf("withdrawal.viewed", w.id)).at(-1)).toMatchObject({ actor_id: agentA.staffId, meta_json: { full: true } });
    expect(full.body).toMatchObject({
      stage: "review",
      checklist: WITHDRAWAL_CHECKLIST,
      rejectReasons: WITHDRAWAL_REJECT_REASONS,
      notes: [],
      payoutReference: null,
      paidOn: null,
      client: { id: clientId, name: "Ali Khan", email: expect.any(String), status: "active", kycStatus: "approved", verifiedName: "Ali Khan", country: "Pakistan", createdAt: expect.any(String) },
      wallet: { availableCents: 1_000_000 - 1000 - 10_000, heldCents: 10_000 },
      history: {
        deposits: { approvedCount: 1, approvedTotalCents: 1_000_000, byMethod: [{ methodName: "Meezan Bank", kind: "bank", totalCents: 1_000_000, lastAt: expect.any(String) }] },
        withdrawals: { paidCount: 1, paidTotalCents: 1000, recent: [expect.objectContaining({ status: "paid", amountCents: 1000 })] },
      },
      can: {
        approve: { ok: true, reason: null },
        secondApprove: { ok: false, reason: expect.any(String) },
        pay: { ok: false, reason: expect.any(String) },
        reject: { ok: true, reason: null },
        returnToReview: { ok: false, reason: expect.any(String) },
      },
    });
    // A regular client paying out to their own long-standing account in their own name raises nothing.
    expect(full.body.warnings).toEqual([]);
  });

  it("needs a fresh 2FA code for every decision", async () => {
    const { payout } = await regular();
    const w = await withdraw(payout, 10_000);
    for (const res of [await approve(noStepUp, w.id), await reject(noStepUp, w.id), await pay(noStepUp, w.id), await secondApprove(noStepUp, w.id), await post(noStepUp, `${W(w.id)}/return`, { note: "Check again" })]) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("STEP_UP_REQUIRED");
    }
    expect(await statusOf(w.id)).toBe("pending");
  });

  it("approves alone under the limit, then needs a different person to pay, and moves the held money out once", async () => {
    const { clientId, payout } = await regular();
    const w = await withdraw(payout, 20_000);
    const before = await wallet(clientId);
    const bellsBefore = (await bells(clientId)).length;

    // The checklist must be complete.
    expect((await approve(managerA, w.id, { checklist: FIRST.slice(1) })).status).toBe(400);
    const approved = await approve(managerA, w.id, { note: "Same account as last time." });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({
      status: "approved", stage: "pay", needsSecondApproval: false,
      firstReviewedBy: { id: managerA.staffId, name: "manager.a" }, approvedBy: { id: managerA.staffId, name: "manager.a" },
      notes: [{ at: expect.any(String), byName: "manager.a", stage: "approved", text: "Same account as last time." }],
      ticked: { first: FIRST, second: [], pay: [] },
      can: { pay: { ok: false, reason: TWO_PERSON } },
    });
    expect((await auditOf("withdrawal.approved", w.id)).map((a) => a.meta_json)).toEqual([
      { withdrawalId: w.id, reference: w.reference, amountCents: 20_000, stage: "single", checklist: FIRST, internalNote: "Same account as last time." },
    ]);
    // Approving says nothing to the client yet (they still see "pending"), and no money moves.
    expect((await bells(clientId)).length).toBe(bellsBefore);
    expect(await events(w.reference)).toEqual([]);
    expect(await wallet(clientId)).toEqual(before);

    const own = await pay(managerA, w.id);
    expect(own.status).toBe(403);
    expect(own.body.error.message).toBe(TWO_PERSON);
    expect((await pay(agentB, w.id)).status).toBe(403);

    const paid = await pay(managerB, w.id, { payoutReference: "FT2410 5566", paidOn: daysAgo(1) });
    expect(paid.status).toBe(200);
    expect(paid.body).toMatchObject({ status: "paid", stage: null, paidBy: { id: managerB.staffId }, payoutReference: "FT2410 5566", paidOn: daysAgo(1), ticked: { pay: PAY } });
    expect(await wallet(clientId)).toEqual({ available: before.available, held: before.held - 20_000 });
    expect(await ledgerOf(w.id)).toEqual([
      { kind: "withdrawal_hold", account: walletAccount(clientId), amount_cents: -20_000 },
      { kind: "withdrawal_hold", account: holdAccount(clientId), amount_cents: 20_000 },
      { kind: "withdrawal_paid", account: holdAccount(clientId), amount_cents: -20_000 },
      { kind: "withdrawal_paid", account: payoutAccount(bankType), amount_cents: 20_000 },
    ]);

    // Paying again is refused and moves nothing.
    const again = await pay(managerA, w.id);
    expect(again.status).toBe(409);
    expect(again.body.error.message).toBe("This withdrawal was already paid by manager.b.");
    expect((await ledgerOf(w.id)).length).toBe(4);

    // One push to the app, carrying nothing but the reference.
    const sent = await events(w.reference);
    expect(sent.map((e) => e.event)).toEqual(["withdrawal.approved"]);
    expect(Object.keys(sent[0]!.payload).sort()).toEqual(["environment", "event", "event_id", "occurred_at", "reference_id", "schema_version", "source", "user_id"]);
    expect((await bells(clientId)).slice(bellsBefore)).toEqual([
      { type: "withdrawal", title: "Your withdrawal was sent", body: "USD 200.00 was sent to your My HBL account ending 6702. Payout reference: FT2410 5566.", link: "/transactions", link_label: "View history" },
    ]);
    const mail = (await emails(clientId)).filter((e) => e.template === "withdrawal_paid");
    expect(mail).toHaveLength(1);
    expect(mail[0]!.body_text).toContain("We sent USD 200.00 to your My HBL account ending 6702");
    expect(mail[0]!.body_text).not.toContain(payout.accountNumber);
    const audit = await auditOf("withdrawal.paid", w.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_id: managerB.staffId, before_json: { status: "approved" }, after_json: { status: "paid" } });
    expect(audit[0]!.meta_json).toMatchObject({ withdrawalId: w.id, reference: w.reference, amountCents: 20_000, payoutReference: "FT2410 5566", accountEnding: "6702", approvedBy: { id: managerA.staffId } });
    expect(JSON.stringify(audit[0])).not.toContain(payout.accountNumber);
  });

  it("needs a second approval from another person above the limit; either approver may then pay", async () => {
    const { clientId, payout } = await regular();
    const w = await withdraw(payout, 150_000);

    const view = await agentA.agent.get(W(w.id));
    expect(view.body).toMatchObject({ needsSecondApproval: true, secondApprovalReasons: ["It is above the second-approval limit of USD 1,000.00."], secondApprovalAboveCents: 100_000 });
    expect(view.body.warnings).toContainEqual({ tone: "info", text: "Needs a second approval from another person." });

    const first = await approve(agentA, w.id);
    expect(first.body).toMatchObject({ status: "second_approval", stage: "second", firstReviewedBy: { id: agentA.staffId }, approvedBy: null });
    expect((await auditOf("withdrawal.first_approved", w.id))[0]!.meta_json).toMatchObject({ amountCents: 150_000, secondApprovalReasons: ["It is above the second-approval limit of USD 1,000.00."] });
    // Approving again at this step, or giving the second approval without the permission, is refused.
    expect((await approve(agentB, w.id)).status).toBe(409);
    expect((await secondApprove(agentA, w.id)).status).toBe(403);
    expect((await secondApprove(managerA, w.id, { checklist: [] })).status).toBe(400);

    const second = await secondApprove(managerA, w.id, { note: "Checked the statement." });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ status: "approved", firstReviewedBy: { id: agentA.staffId }, approvedBy: { id: managerA.staffId }, needsSecondApproval: true, can: { pay: { ok: true } } });
    expect((await auditOf("withdrawal.approved", w.id))[0]!.meta_json).toMatchObject({ stage: "second", firstReviewer: { id: agentA.staffId, name: "agent.a" } });

    // Two people have already approved it, so the second approver may pay it.
    expect((await pay(managerA, w.id)).status).toBe(200);
    expect(await statusOf(w.id)).toBe("paid");
    expect(await wallet(clientId)).toMatchObject({ held: 0 });
  });

  it("never lets the first approver give the second approval", async () => {
    const { payout } = await regular();
    const w = await withdraw(payout, 150_000);
    expect((await approve(managerA, w.id)).body.status).toBe("second_approval");
    const view = await managerA.agent.get(W(w.id));
    expect(view.body.can.secondApprove).toEqual({ ok: false, reason: SAME_PERSON });
    const same = await secondApprove(managerA, w.id);
    expect(same.status).toBe(403);
    expect(same.body.error.message).toBe(SAME_PERSON);
    expect((await secondApprove(managerB, w.id)).body.status).toBe("approved");
    // The first approver may pay once a second person has approved.
    expect((await pay(managerA, w.id)).status).toBe(200);
  });

  it("asks for a second approval on a first withdrawal, unless that rule is off", async () => {
    const clientId = await makeClient();
    await fund(clientId, 100_000);
    const payout = await payoutMethod(clientId);
    const w = await withdraw(payout, 10_000);
    const view = await agentA.agent.get(W(w.id));
    expect(view.body.secondApprovalReasons).toEqual(["It is the client's first withdrawal."]);
    expect(view.body.warnings).toContainEqual({ tone: "warn", text: "This is the client's first withdrawal." });
    expect((await approve(agentA, w.id)).body.status).toBe("second_approval");

    await exec(env.db, "UPDATE money_settings SET first_withdrawal_second_approval = 0 WHERE id = 1");
    try {
      const other = await makeClient();
      await fund(other, 100_000);
      const w2 = await withdraw(await payoutMethod(other), 10_000);
      expect((await approve(agentA, w2.id)).body.status).toBe("approved");
    } finally {
      await exec(env.db, "UPDATE money_settings SET first_withdrawal_second_approval = 1 WHERE id = 1");
    }
  });

  it("honours the second-approval flag stored at request time, and a returned withdrawal always needs it again", async () => {
    const { payout } = await regular();
    const flagged = await withdraw(payout, 10_000, { flag: true });
    expect((await approve(agentA, flagged.id)).body.status).toBe("second_approval");

    // Sending back needs a note and the second-approval permission.
    expect((await post(managerA, `${W(flagged.id)}/return`, {})).status).toBe(400);
    expect((await post(agentB, `${W(flagged.id)}/return`, { note: "Check the name" })).status).toBe(403);

    const big = await withdraw(payout, 150_000);
    expect((await approve(agentA, big.id)).body.status).toBe("second_approval");
    // The limit goes up after the first approval; once sent back, it still needs two people.
    await exec(env.db, "UPDATE money_settings SET withdrawal_second_approval_cents = 500000 WHERE id = 1");
    try {
      const back = await post(managerA, `${W(big.id)}/return`, { note: "The account name needs checking." });
      expect(back.status).toBe(200);
      expect(back.body).toMatchObject({ status: "pending", stage: "review", firstReviewedBy: null, ticked: { first: [] } });
      expect(back.body.notes).toEqual([expect.objectContaining({ byName: "manager.a", stage: "returned", text: "The account name needs checking." })]);
      expect((await one<{ n: number }>(env.db, "SELECT needs_second_approval AS n FROM withdrawals WHERE id = ?", [big.id]))!.n).toBe(1);
      expect((await auditOf("withdrawal.returned", big.id))[0]!.meta_json).toMatchObject({ firstReviewer: { id: agentA.staffId }, internalNote: "The account name needs checking." });
      // The person who sent it back may give the first approval; someone else then gives the second.
      expect((await approve(managerA, big.id)).body.status).toBe("second_approval");
      expect((await secondApprove(managerA, big.id)).status).toBe(403);
      expect((await secondApprove(managerB, big.id)).body.status).toBe("approved");
    } finally {
      await exec(env.db, "UPDATE money_settings SET withdrawal_second_approval_cents = 100000 WHERE id = 1");
    }
  });

  it("rejects from every open step, returning the held money to the wallet once", async () => {
    const { clientId, payout } = await regular();
    const pending = await withdraw(payout, 10_000);
    const inSecond = await withdraw(payout, 150_000);
    const toPay = await withdraw(payout, 20_000);
    expect((await approve(agentA, inSecond.id)).body.status).toBe("second_approval");
    expect((await approve(agentA, toPay.id)).body.status).toBe("approved");
    const start = await wallet(clientId);
    const bellsBefore = (await bells(clientId)).length;

    // The reason is shown to the client exactly as written, so it must be plain text.
    expect((await reject(agentA, pending.id, "<b>No</b> thanks")).status).toBe(400);
    expect((await reject(agentA, pending.id, "No")).status).toBe(400);

    const r1 = await reject(agentA, pending.id, "Please withdraw to the account you deposited from, then request again.");
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ status: "rejected", rejectReason: "Please withdraw to the account you deposited from, then request again.", decidedBy: { id: agentA.staffId }, stage: null });
    expect((await reject(agentA, inSecond.id, WITHDRAWAL_REJECT_REASONS[4])).status).toBe(200);
    expect((await reject(managerA, toPay.id, "We need to complete a security check first")).status).toBe(200);

    expect(await wallet(clientId)).toEqual({ available: start.available + 180_000, held: start.held - 180_000 });
    for (const w of [pending, inSecond, toPay]) {
      const kinds = (await ledgerOf(w.id)).map((e) => e.kind);
      expect(kinds.filter((k) => k === "withdrawal_release")).toHaveLength(2);
      expect((await events(w.reference)).map((e) => e.event)).toEqual(["withdrawal.rejected"]);
    }
    expect((await auditOf("withdrawal.rejected", toPay.id))[0]!.meta_json).toMatchObject({ stage: "pay", holdReleased: true, reason: "We need to complete a security check first" });
    expect((await bells(clientId)).slice(bellsBefore)).toEqual([
      expect.objectContaining({ type: "withdrawal", title: "Your withdrawal was not approved", body: "Please withdraw to the account you deposited from, then request again. USD 100.00 is back in your wallet." }),
      // A reason that already says the money is back is not repeated.
      expect.objectContaining({ body: "We cancelled this request as you asked. The money is back in your wallet." }),
      expect.objectContaining({ body: "We need to complete a security check first. USD 200.00 is back in your wallet." }),
    ]);
    expect((await emails(clientId)).filter((e) => e.template === "withdrawal_rejected")).toHaveLength(3);

    // Nothing moves twice, and a paid withdrawal cannot be rejected.
    const again = await reject(managerA, pending.id);
    expect(again.status).toBe(409);
    expect(again.body.error.message).toBe("This withdrawal was already rejected by agent.a.");
    const paid = await withdraw(payout, 5000);
    expect((await approve(agentA, paid.id)).status).toBe(200);
    expect((await pay(managerA, paid.id)).status).toBe(200);
    expect((await reject(managerA, paid.id)).status).toBe(409);
    expect(await wallet(clientId)).toEqual({ available: start.available + 180_000 - 5000, held: start.held - 180_000 });
  });

  it("stops approval and payment on a frozen or unverified account, but still allows rejection", async () => {
    const { clientId, payout } = await regular();
    const waiting = await withdraw(payout, 10_000);
    const approved = await withdraw(payout, 10_000);
    expect((await approve(managerA, approved.id)).body.status).toBe("approved");
    await exec(env.db, "UPDATE clients SET status = 'frozen' WHERE id = ?", [clientId]);

    const view = await agentA.agent.get(W(waiting.id));
    expect(view.body.can.approve).toEqual({ ok: false, reason: FROZEN });
    expect(view.body.can.reject).toEqual({ ok: true, reason: null });
    expect(view.body.warnings[0]).toEqual({ tone: "bad", text: FROZEN });
    const blocked = await approve(agentA, waiting.id);
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.message).toBe(FROZEN);
    expect((await pay(managerB, approved.id)).body.error.message).toBe(FROZEN);
    expect((await reject(agentA, waiting.id)).status).toBe(200);

    await exec(env.db, "UPDATE clients SET status = 'active', kyc_status = 'pending' WHERE id = ?", [clientId]);
    expect((await pay(managerB, approved.id)).body.error.message).toBe("This client's KYC is not approved, so money cannot move. You can still reject.");
    await exec(env.db, "UPDATE clients SET kyc_status = 'approved' WHERE id = ?", [clientId]);
    expect((await pay(managerB, approved.id)).status).toBe(200);
  });

  it("claims an item for one reviewer at a time, with audited take-overs", async () => {
    const { clientId, payout } = await regular();
    const w = await withdraw(payout, 10_000);
    const mine = await post(agentA, `${W(w.id)}/claim`);
    expect(mine.status).toBe(200);
    expect(mine.body).toEqual({ claimedBy: { id: agentA.staffId, name: "agent.a", until: expect.any(String) }, minutes: 15 });
    expect((await post(agentB, `${W(w.id)}/claim`)).status).toBe(409);
    const blocked = await approve(agentB, w.id);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toBe("agent.a is reviewing this item right now.");
    expect((await reject(agentB, w.id)).status).toBe(409);

    const taken = await post(agentB, `${W(w.id)}/claim`, { takeOver: true });
    expect(taken.body.claimedBy).toMatchObject({ id: agentB.staffId });
    const audit = await auditOf("withdrawal.review_taken_over", w.id);
    expect(audit).toEqual([expect.objectContaining({ actor_id: agentB.staffId, meta_json: { withdrawalId: w.id, reference: w.reference, from: agentA.staffId } })]);
    expect(String((await one<{ entity_id: string }>(env.db, "SELECT entity_id FROM audit_log WHERE action = 'withdrawal.review_taken_over' ORDER BY id DESC LIMIT 1"))!.entity_id)).toBe(String(clientId));

    // Releasing someone else's claim does nothing; the holder's release frees it.
    await post(agentA, `${W(w.id)}/release`);
    expect((await approve(agentA, w.id)).status).toBe(409);
    expect((await post(agentB, `${W(w.id)}/release`)).body).toEqual({ ok: true });
    const done = await approve(agentA, w.id);
    expect(done.status).toBe(200);
    expect(done.body.claimedBy).toBeNull();
  });

  it("hands out the next item each person may act on, never one they may not", async () => {
    const old = (days: number) => ({ createdAt: new Date(Date.now() - days * DAY) });
    const { payout } = await regular();
    // The oldest items of all, so earlier tests' items come after them.
    const reviewItem = await withdraw(payout, 10_000, old(60));
    const soleByManagerA = await withdraw(payout, 10_000, old(59));
    const soleByAgentA = await withdraw(payout, 10_000, old(58));
    const firstByManagerA = await withdraw(payout, 150_000, old(57));
    const firstByAgentA = await withdraw(payout, 150_000, old(56));
    const laterA = await withdraw(payout, 10_000, old(50));
    const laterB = await withdraw(payout, 10_000, old(49));
    const closed = await regular();
    const closedItem = await withdraw(closed.payout, 10_000, old(61));
    await exec(env.db, "UPDATE clients SET status = 'closed' WHERE id = ?", [closed.clientId]);
    expect((await approve(managerA, soleByManagerA.id)).body.status).toBe("approved");
    expect((await approve(agentA, soleByAgentA.id)).body.status).toBe("approved");
    expect((await approve(managerA, firstByManagerA.id)).body.status).toBe("second_approval");
    expect((await approve(agentA, firstByAgentA.id)).body.status).toBe("second_approval");

    // Paying: never what you alone approved. Second approval: never what you first approved.
    const payNext = await post(managerA, "/api/staff/withdrawals/next", { stage: "pay" });
    expect(payNext.body).toEqual({ id: soleByAgentA.id });
    expect((await post(managerB, "/api/staff/withdrawals/next", { stage: "pay" })).body).toEqual({ id: soleByManagerA.id });
    expect((await post(managerA, "/api/staff/withdrawals/next", { stage: "second", release: soleByAgentA.id })).body).toEqual({ id: firstByAgentA.id });
    expect((await one<{ claimed_by: number | null }>(env.db, "SELECT claimed_by FROM withdrawals WHERE id = ?", [soleByAgentA.id]))!.claimed_by).toBeNull();
    expect((await post(managerB, "/api/staff/withdrawals/next", { stage: "second" })).body).toEqual({ id: firstByManagerA.id });

    // A finance agent only reviews; closed accounts and claimed or skipped items are passed over.
    expect((await post(agentA, "/api/staff/withdrawals/next", { stage: "pay" })).status).toBe(403);
    expect((await post(agentA, "/api/staff/withdrawals/next", { stage: "second" })).status).toBe(403);
    expect((await post(agentA, "/api/staff/withdrawals/next", {})).body).toEqual({ id: reviewItem.id });
    // agentA holds reviewItem now, so agentB gets the next one; skipping it (and letting it go) gives the one after.
    expect((await post(agentB, "/api/staff/withdrawals/next", {})).body).toEqual({ id: laterA.id });
    expect((await post(agentB, "/api/staff/withdrawals/next", { skip: [laterA.id], release: laterA.id })).body).toEqual({ id: laterB.id });
    expect((await one<{ claimed_by: number | null }>(env.db, "SELECT claimed_by FROM withdrawals WHERE id = ?", [laterA.id]))!.claimed_by).toBeNull();

    // Leave nothing claimed for the tests that follow.
    await exec(env.db, "UPDATE withdrawals SET claimed_by = NULL, claimed_until = NULL");
    await exec(env.db, "UPDATE clients SET status = 'active' WHERE id = ?", [closed.clientId]);
    for (const w of [reviewItem, soleByManagerA, soleByAgentA, firstByManagerA, firstByAgentA, closedItem, laterA, laterB]) expect((await reject(managerA, w.id)).status).toBe(200);
  });

  it("counts the queues and what each person can act on", async () => {
    const before = { agentA: await summary(agentA), managerA: await summary(managerA), managerB: await summary(managerB), support: await summary(support) };
    expect(Object.keys(before.managerA).sort()).toEqual(["decidedToday", "decidedTodayByMe", "forMe", "oldestOpenAt", "overdue", "review", "secondApproval", "toPay"]);
    expect(before.support.forMe).toEqual({ review: 0, secondApproval: 0, toPay: 0 });
    expect(before.agentA.forMe).toMatchObject({ secondApproval: 0, toPay: 0 });

    const { payout } = await regular();
    const overdue = await withdraw(payout, 10_000, { createdAt: new Date(Date.now() - 2 * DAY) });
    const big = await withdraw(payout, 150_000);
    const small = await withdraw(payout, 10_000);
    expect((await approve(agentA, big.id)).body.status).toBe("second_approval");
    expect((await approve(managerA, small.id)).body.status).toBe("approved");
    expect((await reject(managerB, overdue.id)).status).toBe(200);
    const late = await withdraw(payout, 10_000, { createdAt: new Date(Date.now() - 3 * DAY) });

    const after = { agentA: await summary(agentA), managerA: await summary(managerA), managerB: await summary(managerB) };
    expect(after.managerA.review).toBe(before.managerA.review + 1);
    expect(after.managerA.secondApproval).toBe(before.managerA.secondApproval + 1);
    expect(after.managerA.toPay).toBe(before.managerA.toPay + 1);
    expect(after.managerA.overdue).toBe(before.managerA.overdue + 1);
    expect(new Date(after.managerA.oldestOpenAt).getTime()).toBeLessThanOrEqual(Date.now() - 3 * DAY + 1000);
    expect(after.managerB.decidedToday).toBe(before.managerB.decidedToday + 1);
    expect(after.managerB.decidedTodayByMe).toBe(before.managerB.decidedTodayByMe + 1);
    expect(after.managerA.decidedTodayByMe).toBe(before.managerA.decidedTodayByMe);
    // managerA may give the second approval (agentA gave the first) but may not pay what they alone approved.
    expect(after.managerA.forMe).toEqual({ review: before.managerA.forMe.review + 1, secondApproval: before.managerA.forMe.secondApproval + 1, toPay: before.managerA.forMe.toPay });
    expect(after.managerB.forMe.toPay).toBe(before.managerB.forMe.toPay + 1);
    expect(after.agentA.forMe).toEqual({ review: before.agentA.forMe.review + 1, secondApproval: 0, toPay: 0 });
    for (const w of [big, small, late]) expect((await reject(managerB, w.id)).status).toBe(200);
  });

  it("warns about shared destinations, names, new accounts, security changes, fresh money and the closed loop", async () => {
    const clientId = await makeClient({ first: "Sara", last: "Ahmed", assigned: scoped.staffId });
    await fund(clientId, 10_000, { method: cryptoDeposit });
    await fund(clientId, 90_000, { method: cryptoDeposit, decidedAt: new Date(Date.now() - 2 * HOUR) });
    const payout = await payoutMethod(clientId, { accountName: "John Smith", accountNumber: "0099 1234 5555", addedAt: new Date(Date.now() - HOUR) });
    const twin = await makeClient({ first: "Omar", last: "Farooq" });
    await payoutMethod(twin, { accountName: "Omar Farooq", accountNumber: "00991234-5555" });
    await transaction(env.db, (conn) =>
      writeAudit(conn, { actor: { type: "client", id: clientId, label: "sara" }, ip: "", userAgent: "" }, { action: "client.password_reset", entityType: "client", entityId: clientId }),
    );
    // A staff edit of the sign-in email counts; one that only changed the city does not.
    const staffActor = { actor: { type: "staff" as const, id: agentA.staffId, label: "agent" }, ip: "", userAgent: "" };
    await transaction(env.db, (conn) => writeAudit(conn, staffActor, { action: "client.updated", entityType: "client", entityId: clientId, meta: { fields: ["city"] } }));
    await new Promise((r) => setTimeout(r, 5));
    await transaction(env.db, (conn) => writeAudit(conn, staffActor, { action: "client.updated", entityType: "client", entityId: clientId, meta: { fields: ["email", "city"] } }));
    const w = await withdraw(payout, 50_000);

    const view = await agentA.agent.get(W(w.id));
    const day = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
    expect(view.body.warnings).toEqual([
      { tone: "bad", text: `The same destination is also saved or used by Omar Farooq (client ${twin}).`, href: `/clients/${twin}` },
      { tone: "bad", text: "The name on the account (John Smith) does not match the client's verified name (Sara Ahmed)." },
      { tone: "warn", text: "This is the client's first withdrawal." },
      { tone: "warn", text: expect.stringMatching(/^The client added this payout account on .+, less than 72 hours before asking for this withdrawal\.$/) },
      { tone: "warn", text: `Recent security changes on this account: password reset on ${day} and email address changed by staff on ${day}.` },
      { tone: "warn", text: "More than half of this client's deposits (USD 900.00 of USD 1,000.00) arrived in the 72 hours before this request." },
      { tone: "warn", text: "This client deposited by crypto, but is withdrawing to bank." },
      { tone: "info", text: "Needs a second approval from another person." },
    ]);
    expect(view.body.history.deposits).toMatchObject({ approvedCount: 2, approvedTotalCents: 100_000, byMethod: [{ methodName: "USDT TRC20", kind: "crypto", totalCents: 100_000 }] });

    // Staff who may not see the other client are not told who it is.
    const limited = await scoped.agent.get(W(w.id));
    expect(limited.status).toBe(200);
    expect(limited.body.warnings[0]).toEqual({ tone: "bad", text: "The same destination is also saved or used by another client." });
    expect(JSON.stringify(limited.body.warnings)).not.toContain("Omar");

    // A crypto wallet carries no name; a near-match name is pointed out gently.
    const crypto = await payoutMethod(clientId, { type: cryptoType, accountNumber: "TQ7exampleWalletAddress9X3k" });
    const w2 = await withdraw(crypto, 10_000);
    const cryptoView = await agentA.agent.get(W(w2.id));
    expect(cryptoView.body.network).toBe("TRC20");
    expect(cryptoView.body.warnings).toContainEqual({ tone: "info", text: "Crypto wallets carry no name; check the wallet belongs to the client." });
    // Saved before the type asked for a QR code.
    expect(cryptoView.body.warnings).toContainEqual({
      tone: "warn", text: "USDT TRC20 asks for the wallet's QR code, but this account had none when the client asked. Confirm the address with the client before paying.",
    });
    expect(cryptoView.body.warnings.some((x: { text: string }) => x.text.startsWith("This client deposited by"))).toBe(false);
    const near = await payoutMethod(clientId, { accountName: "Sara Begum Ahmed", accountNumber: "1111 2222 3333" });
    const w3 = await withdraw(near, 10_000);
    expect((await agentA.agent.get(W(w3.id))).body.warnings).toContainEqual({
      tone: "info", text: "The name on the account (Sara Begum Ahmed) is close to the client's verified name (Sara Ahmed). Check it is the same person.",
    });

    // An account changed after the request: the money still goes where the client asked.
    await exec(env.db, "UPDATE client_payout_methods SET details_changed_at = CURRENT_TIMESTAMP(3) + INTERVAL 1 SECOND WHERE id = ?", [near.id]);
    expect((await agentA.agent.get(W(w3.id))).body.warnings).toContainEqual({
      tone: "warn", text: "The client changed this payout account after asking for this withdrawal. The money goes to the details shown here, as they were when the client asked.",
    });
    for (const x of [w, w2, w3]) expect((await reject(agentA, x.id)).status).toBe(200);
  });

  it("keeps review details in the client's activity for withdrawal reviewers only", async () => {
    const { clientId, payout } = await regular();
    const w = await withdraw(payout, 10_000);
    expect((await approve(agentA, w.id, { note: "Called the client" })).body.status).toBe("approved");
    const entry = async (s: SignedIn) =>
      ((await s.agent.get(`/api/staff/clients/${clientId}/activity`)).body.items as { action: string; meta: Record<string, unknown> }[]).find((a) => a.action === "withdrawal.approved")!.meta;
    expect(await entry(agentA)).toMatchObject({ withdrawalId: w.id, reference: w.reference, amountCents: 10_000, stage: "single", internalNote: "Called the client" });
    expect(await entry(support)).toEqual({ withdrawalId: w.id, reference: w.reference, stage: "single" });
    expect((await reject(agentA, w.id)).status).toBe(200);
  });

  it("shows the client's QR code only to payout staff, from the review screen, while it is the one they asked with", async () => {
    const clientId = await makeClient();
    await fund(clientId, 100_000, { method: cryptoDeposit });
    const qr = await sharp({ create: { width: 300, height: 300, channels: 3, background: "#123456" } }).png().toBuffer();
    const payout = await payoutMethod(clientId, { type: cryptoType, accountNumber: "TQ7exampleWalletAddress9X3k", qr });
    const w = await withdraw(payout, 10_000);

    const view = await agentA.agent.get(W(w.id));
    expect(view.body.destination).toMatchObject({ kind: "crypto", network: "TRC20", accountNumber: "TQ7exampleWalletAddress9X3k", hasQr: true, qrUrl: `/api/staff/withdrawals/${w.id}/qr`, full: true });
    expect((await support.agent.get(W(w.id))).body.destination).toMatchObject({ hasQr: true, qrUrl: null, accountNumber: "••••9X3k" });
    expect(JSON.stringify(view.body.warnings)).not.toContain("QR code");

    expect((await agentA.agent.get(`${W(w.id)}/qr`)).status).toBe(403);
    const image = await agentA.agent.get(`${W(w.id)}/qr`).set("X-CRM-Viewer", "1").buffer(true);
    expect(image.status).toBe(200);
    expect(image.headers["content-type"]).toBe("image/png");
    expect(image.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(image.headers["cache-control"]).toBe("no-store");
    expect(image.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(image.headers["x-content-type-options"]).toBe("nosniff");
    expect(Buffer.compare(image.body as Buffer, qr)).toBe(0);
    expect(image.headers["x-document-sha256"]).toBe(sha256(qr));
    expect(await auditOf("withdrawal.qr_viewed", w.id)).toEqual([expect.objectContaining({ actor_id: agentA.staffId, meta_json: { withdrawalId: w.id, reference: w.reference } })]);

    // The client uploads a different QR code after asking: it is not the destination they asked for.
    await exec(env.db, "UPDATE client_payout_methods SET qr_token = ? WHERE id = ?", [randomBytes(16).toString("hex"), payout.id]);
    expect((await agentA.agent.get(`${W(w.id)}/qr`).set("X-CRM-Viewer", "1")).status).toBe(404);
    const changed = await agentA.agent.get(W(w.id));
    expect(changed.body.destination).toMatchObject({ hasQr: false, qrUrl: null });
    expect(changed.body.warnings).toContainEqual({ tone: "warn", text: "The client replaced the QR code after asking for this withdrawal, so it is not shown. Pay to the address shown." });
    expect((await reject(agentA, w.id)).status).toBe(200);
  });

  it("checks the payout reference and date, and asks before recording a reference twice", async () => {
    const { payout } = await regular();
    const a = await withdraw(payout, 10_000);
    const b = await withdraw(payout, 10_000);
    for (const w of [a, b]) expect((await approve(agentA, w.id)).body.status).toBe("approved");

    const bad = async (body: Record<string, unknown>) => {
      const res = await pay(managerA, b.id, body);
      expect(res.status).toBe(400);
      return res.body.error.details;
    };
    expect(await bad({ paidOn: daysAgo(-2) })).toEqual([{ field: "paidOn", message: "The date the money was sent cannot be in the future" }]);
    expect(await bad({ paidOn: daysAgo(31) })).toEqual([{ field: "paidOn", message: "The date the money was sent must be within the last 30 days" }]);
    expect(await bad({ paidOn: "2026-13-01" })).toEqual([{ field: "paidOn", message: "Enter the date as YYYY-MM-DD" }]);
    expect(await bad({ payoutReference: "see https://bank.example" })).toEqual([{ field: "payoutReference", message: expect.stringMatching(/plain text/) }]);
    expect(await bad({ payoutReference: "x" })).toHaveLength(1);
    expect(await bad({ checklist: PAY.slice(0, 1) })).toEqual([{ field: "checklist", message: "Tick every item on the checklist first" }]);
    expect(await bad({ amount: 5 })).toBeDefined();

    expect((await pay(managerA, a.id, { payoutReference: "TRX-777/a" })).status).toBe(200);
    const reused = await pay(managerA, b.id, { payoutReference: "trx 777 a" });
    expect(reused.status).toBe(409);
    expect(reused.body.error).toMatchObject({ code: "PAYOUT_REFERENCE_USED", details: { withdrawalId: a.id, reference: a.reference } });
    expect(await statusOf(b.id)).toBe("approved");
    const confirmed = await pay(managerA, b.id, { payoutReference: "trx 777 a", confirmReuse: true });
    expect(confirmed.status).toBe(200);
    expect((await auditOf("withdrawal.paid", b.id))[0]!.meta_json).toMatchObject({ payoutReferenceAlsoOn: a.reference });
  });

  it("keeps staff to their assigned clients unless they may see everyone", async () => {
    const mine = await regular({ assigned: scoped.staffId });
    const theirs = await regular();
    const wMine = await withdraw(mine.payout, 10_000);
    const wTheirs = await withdraw(theirs.payout, 10_000);
    const list = await scoped.agent.get("/api/staff/withdrawals?status=all&pageSize=100");
    const ids = list.body.items.map((i: { id: number }) => i.id);
    expect(ids).toContain(wMine.id);
    expect(ids).not.toContain(wTheirs.id);
    const assigned = (await rows<{ id: number }>(env.db, "SELECT id FROM clients WHERE assigned_staff_id = ?", [scoped.staffId])).map((c) => c.id);
    expect(list.body.items.length).toBeGreaterThan(0);
    expect(list.body.items.every((i: { clientId: number }) => assigned.includes(i.clientId))).toBe(true);
    expect((await scoped.agent.get(W(wTheirs.id))).status).toBe(404);
    expect((await approve(scoped, wTheirs.id)).status).toBe(404);
    expect((await post(scoped, `${W(wTheirs.id)}/claim`)).status).toBe(404);
    expect(await statusOf(wTheirs.id)).toBe("pending");
    expect((await approve(scoped, wMine.id)).body.status).toBe("approved");
    for (const w of [wMine, wTheirs]) expect((await reject(managerA, w.id)).status).toBe(200);
  });

  it("filters the list by step, client and reference", async () => {
    const { clientId, payout } = await regular();
    const pending = await withdraw(payout, 10_000);
    const second = await withdraw(payout, 150_000);
    const toPay = await withdraw(payout, 20_000);
    const paid = await withdraw(payout, 30_000);
    const rejected = await withdraw(payout, 40_000);
    await approve(agentA, second.id);
    await approve(agentA, toPay.id);
    await approve(agentA, paid.id);
    await pay(managerA, paid.id);
    await reject(agentA, rejected.id);
    const ids = async (query: string) =>
      (await agentA.agent.get(`/api/staff/withdrawals?clientId=${clientId}&pageSize=100&${query}`)).body.items.map((i: { id: number }) => i.id);
    expect(await ids("")).toEqual([pending.id, second.id, toPay.id]);
    expect(await ids("status=review")).toEqual([pending.id]);
    expect(await ids("status=second_approval")).toEqual([second.id]);
    expect(await ids("status=to_pay")).toEqual([toPay.id]);
    expect(await ids("status=paid")).toEqual([paid.id, expect.any(Number)]);
    expect(await ids("status=rejected")).toEqual([rejected.id]);
    expect((await ids("status=all")).length).toBe(6);
    expect(await ids("status=all&sort=amount_cents&dir=desc")).toEqual(expect.arrayContaining([rejected.id]));
    expect((await ids("status=all&sort=amount_cents&dir=desc"))[0]).toBe(second.id);
    expect(await ids(`status=all&q=${paid.reference.toLowerCase()}`)).toEqual([paid.id]);
    expect((await agentA.agent.get("/api/staff/withdrawals?status=nonsense")).status).toBe(400);
    const page = (await agentA.agent.get(`/api/staff/withdrawals?clientId=${clientId}&status=all&pageSize=2&page=2`)).body;
    expect(page).toMatchObject({ page: 2, pageSize: 2, total: 6, pages: 3 });
    for (const w of [pending, second, toPay]) await reject(agentA, w.id);
  });

  it("refuses to approve or pay when the destination cannot be read, but still lets staff reject", async () => {
    const { clientId, payout } = await regular();
    const w = await withdraw(payout, 10_000);
    // A snapshot sealed for another withdrawal cannot be swapped in: it no longer decrypts.
    await exec(env.db, "UPDATE withdrawals SET destination_enc = ? WHERE id = ?", [encryptField(env.config.dataKey, JSON.stringify({ accountNumber: "1234" }), "withdrawal:W-OTHER"), w.id]);
    const unreadable = "The destination of this withdrawal could not be read, so it cannot be approved or paid. You can still reject it.";
    const view = await agentA.agent.get(W(w.id));
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ destinationEnding: null, destination: { accountNumber: "", full: true }, can: { approve: { ok: false, reason: unreadable }, reject: { ok: true } } });
    expect(view.body.warnings[0]).toEqual({ tone: "bad", text: unreadable });
    expect((await approve(agentA, w.id)).body.error.message).toBe(unreadable);
    const before = await wallet(clientId);
    expect((await reject(agentA, w.id)).status).toBe(200);
    expect(await wallet(clientId)).toEqual({ available: before.available + 10_000, held: before.held - 10_000 });
  });

  it("never pays a withdrawal whose money is not on hold, and rejecting it moves nothing", async () => {
    const { clientId, payout } = await regular();
    const w = await withdraw(payout, 10_000);
    // As if the hold had never been written: a new row with the same snapshot and no ledger entry.
    const copy = await exec(
      env.db,
      `INSERT INTO withdrawals (reference, client_id, wallet_id, payout_method_id, payment_method_id, method_name, amount_cents, destination_enc, destination_fingerprint)
       SELECT ?, client_id, wallet_id, payout_method_id, payment_method_id, method_name, amount_cents, ?, destination_fingerprint FROM withdrawals WHERE id = ?`,
      ["W-NOHOLD01", encryptField(env.config.dataKey, JSON.stringify({ methodName: "My HBL", kind: "bank", accountName: "Ali Khan", accountNumber: payout.accountNumber }), "withdrawal:W-NOHOLD01"), w.id],
    );
    expect((await approve(agentA, copy.insertId)).body.status).toBe("approved");
    const before = await wallet(clientId);
    const refused = await pay(managerA, copy.insertId);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/not on hold/);
    expect((await reject(managerA, copy.insertId)).status).toBe(200);
    expect((await auditOf("withdrawal.rejected", copy.insertId))[0]!.meta_json).toMatchObject({ holdReleased: false });
    expect(await ledgerOf(copy.insertId)).toEqual([]);
    expect(await wallet(clientId)).toEqual(before);
    // verify-ledger points the row out; it is removed so the rest of this file starts from a sound ledger.
    expect(await verifyLedger(env.db)).toEqual([
      "Withdrawal W-NOHOLD01 has 0 hold transaction(s), not 1.",
      "Withdrawal W-NOHOLD01 is rejected, but the ledger has 0 payout(s) and 0 return(s) to the wallet.",
    ]);
    await exec(env.db, "DELETE FROM withdrawals WHERE id = ?", [copy.insertId]);
    expect((await reject(managerA, w.id)).status).toBe(200);
    expect((await post(agentA, `${W(999_999)}/claim`)).status).toBe(404);
    expect((await agentA.agent.get(W(999_999))).status).toBe(404);
  });

  it("moves money once when two people act on the same withdrawal at the same moment", async () => {
    const { clientId, payout } = await regular();
    const w = await withdraw(payout, 25_000);
    expect((await approve(agentA, w.id)).body.status).toBe("approved");
    const results = await Promise.all([pay(managerA, w.id), pay(managerB, w.id), reject(agentB, w.id)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    const kinds = (await ledgerOf(w.id)).map((e) => e.kind);
    expect(kinds.filter((k) => k !== "withdrawal_hold")).toHaveLength(2);
    expect(await wallet(clientId)).toMatchObject({ held: 0 });
    expect(await events(w.reference)).toHaveLength(1);
  });

  it("leaves the ledger consistent, and the verify-ledger command says so", async () => {
    expect(await verifyLedger(env.db)).toEqual([]);
    const run = promisify(execFile);
    const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
    const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
    const cwd = fileURLToPath(new URL("..", import.meta.url));
    const opts = { cwd, env: { ...process.env, CRM_DATABASE_URL: TEST_DB_URL }, timeout: 60_000 };
    const ok = await run(tsx, [cli, "verify-ledger"], opts);
    expect(ok.stdout.trim()).toBe("Ledger checks passed.");

    // A wallet cache that no longer matches its entries is reported, with exit code 1.
    const client = (await one<{ client_id: number }>(env.db, "SELECT client_id FROM wallets ORDER BY id LIMIT 1"))!.client_id;
    await exec(env.db, "UPDATE wallets SET available_cents = available_cents + 1 WHERE client_id = ?", [client]);
    try {
      const failed = await run(tsx, [cli, "verify-ledger"], opts).then(
        () => null,
        (e: { code?: number; stdout?: string }) => e,
      );
      expect(failed?.code).toBe(1);
      expect(failed?.stdout).toMatch(new RegExp(`^Client ${client}: wallet shows \\d+ cents but the ledger adds up to \\d+\\.$`, "m"));
    } finally {
      await exec(env.db, "UPDATE wallets SET available_cents = available_cents - 1 WHERE client_id = ?", [client]);
    }
    expect(await verifyLedger(env.db)).toEqual([]);
  }, 120_000);

  // Last: the ledger is append-only, so what this test posts stays wrong for the rest of the file.
  it("reports withdrawals whose ledger outcome contradicts their status, and credits with no deposit", async () => {
    const { clientId, payout } = await regular();
    const post = (kind: "withdrawal_paid" | "withdrawal_release" | "deposit", sourceId: number, entries: { account: string; amount: number }[]) =>
      transaction(env.db, async (conn) => {
        await lockWallet(conn, clientId);
        const sourceType = kind === "deposit" ? "deposit" : "withdrawal";
        return postLedger(conn, { kind, sourceType, sourceId, clientId, staffId: null, memo: "tampered" }, entries);
      });
    // Marked paid, but the held money went back to the wallet: the client would get it twice.
    const doubled = await withdraw(payout, 6_000);
    await exec(env.db, "UPDATE withdrawals SET status = 'paid' WHERE id = ?", [doubled.id]);
    await post("withdrawal_release", doubled.id, [{ account: holdAccount(clientId), amount: -6_000 }, { account: walletAccount(clientId), amount: 6_000 }]);
    // Marked rejected ("the money is back in your wallet"), but it was paid out.
    const vanished = await withdraw(payout, 7_000);
    await exec(env.db, "UPDATE withdrawals SET status = 'rejected' WHERE id = ?", [vanished.id]);
    await post("withdrawal_paid", vanished.id, [{ account: holdAccount(clientId), amount: -7_000 }, { account: payoutAccount(bankType), amount: 7_000 }]);
    // Paid out through another payout type than the one the client asked for.
    const elsewhere = await withdraw(payout, 5_000);
    await exec(env.db, "UPDATE withdrawals SET status = 'paid' WHERE id = ?", [elsewhere.id]);
    const wrongTx = await post("withdrawal_paid", elsewhere.id, [{ account: holdAccount(clientId), amount: -5_000 }, { account: payoutAccount(cryptoType), amount: 5_000 }]);
    // A credit for a deposit that does not exist.
    const ghostTx = await post("deposit", 99_999_999, [{ account: walletAccount(clientId), amount: 50_000 }, { account: depositMethodAccount(bankDeposit), amount: -50_000 }]);

    const problems = await verifyLedger(env.db);
    expect(problems).toEqual(
      expect.arrayContaining([
        `Withdrawal ${doubled.reference} is paid, but the ledger has 0 payout(s) and 1 return(s) to the wallet.`,
        `Withdrawal ${vanished.reference} is rejected, but the ledger has 1 payout(s) and 0 return(s) to the wallet.`,
        `Ledger transaction ${wrongTx} (withdrawal_paid) for ${elsewhere.reference} moves client:${clientId}:hold -5000, payout:${cryptoType} 5000, not client:${clientId}:hold -5000, payout:${bankType} 5000.`,
        `Ledger transaction ${ghostTx} (deposit) belongs to deposit 99999999, which does not exist.`,
      ]),
    );
    expect(problems).toHaveLength(4);
  });
});
