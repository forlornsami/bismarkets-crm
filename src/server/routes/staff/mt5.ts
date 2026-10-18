import { Router, type Request } from "express";
import { z } from "zod";
import { NOT_PLAIN } from "@shared/money";
import { MT5_GROUP, SERVER_CODE, type Mt5Account, type Mt5User } from "../../../gateway/protocol";
import type { AppDeps } from "../../app";
import { lockClient } from "../../clients/kyc";
import { clientName } from "../../clients/model";
import { notifyClient } from "../../clients/notifications";
import { auditContext, writeAudit } from "../../lib/audit";
import { exec, one, rows, transaction, type Conn } from "../../lib/db";
import { badRequest, conflict, handler, HttpError, notFound, parse } from "../../lib/http";
import { likeTerm, listQuery, toPage } from "../../lib/pagination";
import { MAX_AMOUNT_MINOR } from "../../money/amounts";
import { clientScope, moneyId } from "../../money/review";
import { accountFromDb, SELECT_ACCOUNT, withAccountLock, writeSnapshot, type AccountRow } from "../../mt5/accounts";
import { callMt5, callMt5Again, staffMt5Error } from "../../mt5/errors";
import { GatewayError, type Mt5Gateway } from "../../mt5/gateway";
import { opFromDb, SELECT_OP, type BalanceOpRow } from "../../mt5/operations";
import { generateMt5Password } from "../../mt5/passwords";
import { loadMt5Settings, type Mt5Settings, type ServerRow } from "../../mt5/settings";
import { requirePermission, requireStepUp, staffActor, staffOf, type StaffContext } from "../../staff/session";
import { anyPermission } from "./money";

// MT5 for staff: the servers the gateway serves (labels and the on/off
// switch only; addresses and manager logins live in the gateway), the MT5
// rules, and clients' MT5 accounts with the changes staff may make. Every
// change needs a recent 2FA code and is audited. MT5's own error text may be
// shown here; clients never see it.

/** How long an account page waits for live MT5 figures before showing the cached ones. */
const LIVE_BUDGET_MS = 5_000;
const NOT_FOUND = "That MT5 account does not exist or its client is not assigned to you.";
const NOT_OPEN = "This account is not open in MT5.";

const PLAIN = "Use plain text, without links or symbols like < > { }";
const plain = (min: number, max: number, label: string) =>
  z
    .string({ required_error: `Enter the ${label}`, invalid_type_error: `Enter the ${label}` })
    .trim()
    .min(min, min > 1 ? `Enter the ${label} (at least ${min} characters)` : `Enter the ${label}`)
    .max(max, `Keep the ${label} under ${max + 1} characters`)
    .refine((v) => !NOT_PLAIN.test(v), PLAIN);

const serverCode = z.string({ required_error: "Enter the server code" }).trim().regex(SERVER_CODE, "Use 1 to 16 lower-case letters, digits, - or _ (the code configured in the gateway)");
const serverLabel = plain(2, 60, "label");
const createServerBody = z.object({ code: serverCode, label: serverLabel, isEnabled: z.boolean().optional() }).strict();
const updateServerBody = z.object({ label: serverLabel.optional(), isEnabled: z.boolean().optional() }).strict();

const limitCents = z.number({ invalid_type_error: "Enter the amount in cents, as a whole number" }).int("Enter the amount in cents, as a whole number").positive("The amount must be more than zero").max(MAX_AMOUNT_MINOR, "This amount is too large");
const accountLimit = z.number({ invalid_type_error: "Enter a whole number" }).int("Enter a whole number").min(1, "Allow at least one account").max(1000, "Allow at most 1000 accounts");
const settingsBody = z
  .object({
    demoServerCode: z.union([serverCode, z.literal("").transform(() => null), z.null()]).optional(),
    demoGroup: z.union([z.string().trim().regex(MT5_GROUP, "Enter the MT5 group exactly as the broker named it (letters, digits, \\ _ - . and spaces)"), z.literal("").transform(() => null), z.null()]).optional(),
    leverages: z
      .array(z.number({ invalid_type_error: "Enter each leverage as a whole number, such as 2000 for 1:2000" }).int("Enter each leverage as a whole number").min(1).max(10_000, "A leverage can be at most 10000"))
      .min(1, "Offer at least one leverage")
      .max(12, "Offer at most 12 leverages")
      .optional(),
    maxLiveAccounts: accountLimit.optional(),
    maxDemoAccounts: accountLimit.optional(),
    demoMaxOpeningCents: limitCents.optional(),
    demoMaxTopupCents: limitCents.optional(),
    demoMaxBalanceCents: limitCents.optional(),
    maxTransferCents: limitCents.optional(),
  })
  .strict();
type SettingsBody = z.infer<typeof settingsBody>;
type SettingKey = keyof SettingsBody;
const SETTING_COLUMNS: Record<SettingKey, string> = {
  demoServerCode: "demo_server_code", demoGroup: "demo_group", leverages: "leverages", maxLiveAccounts: "max_live_accounts", maxDemoAccounts: "max_demo_accounts",
  demoMaxOpeningCents: "demo_max_opening_cents", demoMaxTopupCents: "demo_max_topup_cents", demoMaxBalanceCents: "demo_max_balance_cents", maxTransferCents: "max_transfer_cents",
};

const reasonField = plain(5, 300, "reason");
const leverageBody = z.object({ leverage: z.number({ required_error: "Enter the leverage", invalid_type_error: "Enter the leverage as a whole number, such as 2000 for 1:2000" }).int().min(1).max(10_000) }).strict();
const reasonBody = z.object({ reason: reasonField }).strict();
const passwordBody = z.object({ type: z.enum(["main", "investor"], { errorMap: () => ({ message: "Choose the master or the investor password" }) }) }).strict();

const STATES = {
  all: "",
  active: " AND a.status = 'active' AND a.archived_at IS NULL AND a.suspended_at IS NULL",
  archived: " AND a.status = 'active' AND a.archived_at IS NOT NULL AND a.suspended_at IS NULL",
  suspended: " AND a.status = 'active' AND a.suspended_at IS NOT NULL",
  creating: " AND a.status = 'creating'",
  unknown: " AND a.status = 'unknown'",
  failed: " AND a.status = 'failed'",
} as const;
type State = Exclude<keyof typeof STATES, "all">;

type StaffAccountRow = AccountRow & {
  first_name: string;
  last_name: string;
  email: string;
  client_status: string;
  server_label: string;
  suspended_by_name: string | null;
};

const SELECT_STAFF_ACCOUNT = SELECT_ACCOUNT.replace(
  "FROM mt5_accounts a",
  `, c.first_name, c.last_name, c.email, c.status AS client_status, sv.label AS server_label, sb.name AS suspended_by_name
   FROM mt5_accounts a JOIN clients c ON c.id = a.client_id JOIN mt5_servers sv ON sv.code = a.server_code LEFT JOIN staff_users sb ON sb.id = a.suspended_by`,
);

const stateOf = (a: AccountRow): State =>
  a.status !== "active" ? a.status : a.suspended_at ? "suspended" : a.archived_at ? "archived" : "active";

const iso = (d: Date | null) => d?.toISOString() ?? null;

function presentAccount(a: StaffAccountRow) {
  return {
    id: a.id,
    clientId: a.client_id,
    clientName: clientName(a),
    clientEmail: a.email,
    clientStatus: a.client_status,
    login: a.login,
    serverCode: a.server_code,
    serverLabel: a.server_label,
    isDemo: a.is_demo === 1,
    type: a.is_demo === 1 ? "demo" : "real",
    packageId: a.package_id,
    packageName: a.package_name,
    group: a.mt5_group,
    currency: a.currency,
    leverage: a.leverage,
    status: a.status,
    state: stateOf(a),
    createRef: a.create_ref,
    failure: a.failure,
    checks: a.checks,
    nextCheckAt: iso(a.next_check_at),
    archivedAt: iso(a.archived_at),
    suspendedAt: iso(a.suspended_at),
    suspendedBy: a.suspended_by === null ? null : { id: Number(a.suspended_by), name: a.suspended_by_name ?? "" },
    suspendedReason: a.suspended_reason,
    balanceCents: a.balance_cents,
    creditCents: a.credit_cents,
    equityCents: a.equity_cents,
    marginCents: a.margin_cents,
    marginFreeCents: a.margin_free_cents,
    snapshotAt: iso(a.snapshot_at),
    registeredAt: iso(a.mt5_registered_at),
    createdAt: a.created_at.toISOString(),
    updatedAt: a.updated_at.toISOString(),
  };
}

const presentOp = (o: BalanceOpRow) => ({
  id: o.id,
  reference: o.reference,
  purpose: o.purpose,
  amountCents: o.amount_cents,
  status: o.status,
  ticket: o.mt5_ticket,
  failure: o.failure,
  clientMessage: o.client_message,
  checks: o.checks,
  nextCheckAt: iso(o.next_check_at),
  createdAt: o.created_at.toISOString(),
  completedAt: iso(o.completed_at),
});

type ServerListRow = ServerRow & { updater_name: string | null; packages: number; accounts: number };
const SELECT_SERVER = `SELECT s.code, s.label, s.is_enabled, s.created_at, s.updated_at, s.updated_by, u.name AS updater_name,
  (SELECT COUNT(*) FROM account_packages p WHERE p.server_code = s.code) AS packages,
  (SELECT COUNT(*) FROM mt5_accounts a WHERE a.server_code = s.code AND a.status = 'active') AS accounts
  FROM mt5_servers s LEFT JOIN staff_users u ON u.id = s.updated_by`;

const presentServer = (s: ServerListRow, settings: Mt5Settings) => ({
  code: s.code,
  label: s.label,
  isEnabled: s.is_enabled === 1,
  isDemoServer: settings.demoServerCode === s.code,
  usage: { packages: Number(s.packages), accounts: Number(s.accounts) },
  createdAt: s.created_at.toISOString(),
  updatedAt: s.updated_at.toISOString(),
  updatedBy: s.updated_by === null ? null : { id: Number(s.updated_by), name: s.updater_name ?? "" },
});

/** Waits for `work` up to `ms`; null when it takes longer or fails. */
async function settled<T>(work: Promise<T>, ms: number): Promise<{ value: T } | { error: unknown } | null> {
  let timer: NodeJS.Timeout | undefined;
  const outcome = work.then((value) => ({ value }), (error: unknown) => ({ error }));
  const result = await Promise.race([outcome, new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)))]);
  clearTimeout(timer);
  return result;
}

const liveError = (error: unknown) => (error instanceof GatewayError ? `${error.message} (${error.kind}/${error.code})` : "MT5 could not be read.");

/** MT5 servers, MT5 rules and clients' MT5 accounts. */
export function staffMt5Router(deps: AppDeps): Router {
  const { db, config, log } = deps;
  const mt5 = deps.mt5 ?? null;
  const router = Router();
  const stepUp = requireStepUp(config);
  const ctx = (req: Request) => auditContext(req, staffActor(staffOf(req)));

  /** The gateway, when MT5 is on and the server is switched on in the CRM. */
  async function gatewayFor(conn: Conn, server: string): Promise<Mt5Gateway> {
    if (!mt5) throw new HttpError(422, "MT5_OFF", "MT5 is not connected: CRM_MT5_GATEWAY_URL is not set on this server.");
    const row = await one<{ is_enabled: number }>(conn, "SELECT is_enabled FROM mt5_servers WHERE code = ?", [server]);
    if (row?.is_enabled !== 1) throw new HttpError(422, "MT5_SERVER_OFF", "This MT5 server is switched off. Switch it on in the MT5 settings first.");
    return mt5;
  }

  // ---------- Servers ----------

  async function loadServer(conn: Conn, code: string, lock = false) {
    const s = await one<ServerListRow>(conn, `${SELECT_SERVER} WHERE s.code = ?${lock ? " FOR UPDATE OF s" : ""}`, [code]);
    if (!s) throw notFound("That MT5 server does not exist.");
    return s;
  }
  const codeParam = (req: Request) => {
    const code = String(req.params.code ?? "");
    if (!SERVER_CODE.test(code)) throw notFound("That MT5 server does not exist.");
    return code;
  };

  router.get(
    "/servers",
    anyPermission("mt5.view", "mt5.servers"),
    handler(async (_req, res) => {
      const [list, settings] = await Promise.all([rows<ServerListRow>(db, `${SELECT_SERVER} ORDER BY s.code`), loadMt5Settings(db)]);
      res.json({ items: list.map((s) => presentServer(s, settings)), gatewayConfigured: mt5 !== null });
    }),
  );

  router.post(
    "/servers",
    requirePermission("mt5.servers"),
    stepUp,
    handler(async (req, res) => {
      const body = parse(createServerBody, req.body ?? {});
      const staff = staffOf(req);
      const created = await transaction(db, async (conn) => {
        if (await one(conn, "SELECT code FROM mt5_servers WHERE code = ? FOR UPDATE", [body.code])) throw conflict("A server with this code already exists.");
        await exec(conn, "INSERT INTO mt5_servers (code, label, is_enabled, updated_by) VALUES (?, ?, ?, ?)", [body.code, body.label, body.isEnabled === false ? 0 : 1, staff.id]);
        await writeAudit(conn, ctx(req), { action: "mt5.server.created", entityType: "mt5_server", entityId: body.code, after: { label: body.label, isEnabled: body.isEnabled !== false } });
        return loadServer(conn, body.code);
      });
      res.status(201).json(presentServer(created, await loadMt5Settings(db)));
    }),
  );

  router.patch(
    "/servers/:code",
    requirePermission("mt5.servers"),
    stepUp,
    handler(async (req, res) => {
      const code = codeParam(req);
      const body = parse(updateServerBody, req.body ?? {});
      const staff = staffOf(req);
      const updated = await transaction(db, async (conn) => {
        const current = await loadServer(conn, code, true);
        const before = { label: current.label, isEnabled: current.is_enabled === 1 };
        const after = { label: body.label ?? before.label, isEnabled: body.isEnabled ?? before.isEnabled };
        const changed = (Object.keys(after) as (keyof typeof after)[]).filter((k) => after[k] !== before[k]);
        if (!changed.length) return current;
        await exec(conn, "UPDATE mt5_servers SET label = ?, is_enabled = ?, updated_by = ? WHERE code = ?", [after.label, after.isEnabled ? 1 : 0, staff.id, code]);
        await writeAudit(conn, ctx(req), {
          action: "mt5.server.updated", entityType: "mt5_server", entityId: code,
          before: Object.fromEntries(changed.map((k) => [k, before[k]])), after: Object.fromEntries(changed.map((k) => [k, after[k]])),
        });
        return loadServer(conn, code);
      });
      res.json(presentServer(updated, await loadMt5Settings(db)));
    }),
  );

  // A read: whether the gateway reaches this server's MT5. Allowed while the server is switched off, to test it first.
  router.post(
    "/servers/:code/ping",
    requirePermission("mt5.servers"),
    handler(async (req, res) => {
      const code = codeParam(req);
      await loadServer(db, code);
      if (!mt5) return void res.json({ ok: false, latencyMs: 0, error: { kind: "unavailable", code: "connection", message: "MT5 is not connected: CRM_MT5_GATEWAY_URL is not set on this server." } });
      const started = Date.now();
      try {
        const { serverTime } = await callMt5(mt5, "ping", { server: code }, log);
        res.json({ ok: true, latencyMs: Date.now() - started, serverTime });
      } catch (error) {
        const e = error as GatewayError;
        res.json({ ok: false, latencyMs: Date.now() - started, error: { kind: e.kind, code: e.code, message: e.message } });
      }
    }),
  );

  // ---------- Settings ----------

  async function settingsOut(conn: Conn) {
    const s = await loadMt5Settings(conn);
    const by = s.updatedBy ? await one<{ id: number; name: string }>(conn, "SELECT id, name FROM staff_users WHERE id = ?", [s.updatedBy]) : undefined;
    return {
      demoServerCode: s.demoServerCode,
      demoGroup: s.demoGroup,
      leverages: s.leverages,
      maxLiveAccounts: s.maxLiveAccounts,
      maxDemoAccounts: s.maxDemoAccounts,
      demoMaxOpeningCents: s.demoMaxOpeningCents,
      demoMaxTopupCents: s.demoMaxTopupCents,
      demoMaxBalanceCents: s.demoMaxBalanceCents,
      maxTransferCents: s.maxTransferCents,
      gatewayConfigured: mt5 !== null,
      updatedAt: s.updatedAt.toISOString(),
      updatedBy: by ? { id: Number(by.id), name: by.name } : null,
    };
  }

  router.get(
    "/settings",
    requirePermission("mt5.view"),
    handler(async (_req, res) => {
      res.json(await settingsOut(db));
    }),
  );

  router.patch(
    "/settings",
    requirePermission("mt5.servers"),
    stepUp,
    handler(async (req, res) => {
      const body = parse(settingsBody, req.body ?? {});
      const staff = staffOf(req);
      const updated = await transaction(db, async (conn) => {
        const s = await loadMt5Settings(conn, "update");
        const current: Required<SettingsBody> = {
          demoServerCode: s.demoServerCode, demoGroup: s.demoGroup, leverages: s.leverages, maxLiveAccounts: s.maxLiveAccounts, maxDemoAccounts: s.maxDemoAccounts,
          demoMaxOpeningCents: s.demoMaxOpeningCents, demoMaxTopupCents: s.demoMaxTopupCents, demoMaxBalanceCents: s.demoMaxBalanceCents, maxTransferCents: s.maxTransferCents,
        };
        const next = { ...current, ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) } as Required<SettingsBody>;
        next.leverages = [...new Set(next.leverages)];
        const problems: { field: string; message: string }[] = [];
        if ((next.demoServerCode === null) !== (next.demoGroup === null)) problems.push({ field: next.demoGroup === null ? "demoGroup" : "demoServerCode", message: "Set both the demo server and the demo group, or neither." });
        if (next.demoServerCode !== null && !(await one(conn, "SELECT code FROM mt5_servers WHERE code = ? FOR SHARE", [next.demoServerCode]))) {
          problems.push({ field: "demoServerCode", message: "Choose a server the CRM knows." });
        }
        if (next.demoMaxBalanceCents < next.demoMaxOpeningCents) problems.push({ field: "demoMaxBalanceCents", message: "The most a demo account may hold must be at least its largest starting balance." });
        if (next.leverages.join(",").length > 100) problems.push({ field: "leverages", message: "Offer fewer leverages." });
        if (problems.length) throw badRequest("Check the highlighted fields.", problems);
        const same = (k: SettingKey) => (k === "leverages" ? next.leverages.join(",") === current.leverages.join(",") : next[k] === current[k]);
        const changed = (Object.keys(SETTING_COLUMNS) as SettingKey[]).filter((k) => !same(k));
        if (!changed.length) return settingsOut(conn);
        const value = (k: SettingKey) => (k === "leverages" ? next.leverages.join(",") : next[k]);
        await exec(conn, `UPDATE mt5_settings SET ${changed.map((k) => `${SETTING_COLUMNS[k]} = ?`).join(", ")}, updated_by = ? WHERE id = 1`, [...changed.map(value), staff.id]);
        await writeAudit(conn, ctx(req), {
          action: "mt5.settings_updated", entityType: "mt5_settings", entityId: 1,
          before: Object.fromEntries(changed.map((k) => [k, current[k]])), after: Object.fromEntries(changed.map((k) => [k, next[k]])),
        });
        return settingsOut(conn);
      });
      res.json(updated);
    }),
  );

  // ---------- Accounts ----------

  /** An account of a client this staff member may see, or 404. */
  async function loadVisible(conn: Conn, staff: StaffContext, id: number): Promise<StaffAccountRow> {
    const s = clientScope(staff);
    const a = await one<StaffAccountRow>(conn, `${SELECT_STAFF_ACCOUNT} WHERE a.id = ?${s.sql}`, [id, ...s.params]);
    if (!a) throw notFound(NOT_FOUND);
    return accountFromDb(a);
  }

  router.get(
    "/accounts",
    requirePermission("mt5.view"),
    handler(async (req, res) => {
      const query = parse(
        listQuery(["created_at", "login", "balance_cents"], "created_at").extend({
          type: z.enum(["real", "demo"]).optional().or(z.literal("").transform(() => undefined)),
          status: z.enum(["all", "active", "archived", "suspended", "creating", "unknown", "failed"]).default("all"),
          clientId: moneyId.optional().or(z.literal("").transform(() => undefined)),
        }),
        req.query,
      );
      const s = clientScope(staffOf(req));
      let clause = ` WHERE 1 = 1${s.sql}${STATES[query.status]}`;
      const params: unknown[] = [...s.params];
      if (query.type) (clause += " AND a.is_demo = ?"), params.push(query.type === "demo" ? 1 : 0);
      if (query.clientId) (clause += " AND a.client_id = ?"), params.push(query.clientId);
      if (query.q) {
        const asNumber = /^\d{1,15}$/.test(query.q) ? Number(query.q) : 0;
        clause += " AND (a.login = ? OR c.id = ? OR c.email LIKE ? OR CONCAT(c.first_name, ' ', c.last_name) LIKE ?)";
        params.push(asNumber, asNumber, likeTerm(query.q), likeTerm(query.q));
      }
      const dir = query.dir === "asc" ? "ASC" : "DESC";
      const order = query.sort === "login" ? "a.login" : query.sort === "balance_cents" ? "a.balance_cents" : "a.created_at";
      const from = " FROM mt5_accounts a JOIN clients c ON c.id = a.client_id";
      const total = await one<{ n: number }>(db, `SELECT COUNT(*) AS n${from}${clause}`, params);
      const items = await rows<StaffAccountRow>(db, `${SELECT_STAFF_ACCOUNT}${clause} ORDER BY ${order} ${dir}, a.id ${dir} LIMIT ? OFFSET ?`, [
        ...params, query.pageSize, (query.page - 1) * query.pageSize,
      ]);
      res.json(toPage(items.map(accountFromDb).map(presentAccount), Number(total?.n ?? 0), query.page, query.pageSize));
    }),
  );

  /**
   * An account with what MT5 says about it now (best effort: the cached
   * figures show when MT5 does not answer in time) and its latest balance operations.
   */
  async function accountPage(staff: StaffContext, id: number, force: boolean) {
    let a = await loadVisible(db, staff, id);
    let live: { user: Mt5User | null; figures: Mt5Account | null; error: string | null } | null = null;
    if (a.status === "active" && a.login !== null) {
      live = { user: null, figures: null, error: null };
      let gateway: Mt5Gateway | null = null;
      try {
        gateway = await gatewayFor(db, a.server_code);
      } catch (error) {
        if (force) throw error;
        live.error = (error as Error).message;
      }
      if (gateway) {
        const [user, figures] = await Promise.all([
          settled(callMt5(gateway, "user.get", { server: a.server_code, login: a.login }, log), LIVE_BUDGET_MS),
          settled(callMt5(gateway, "accounts.get", { server: a.server_code, logins: [a.login] }, log), LIVE_BUDGET_MS),
        ]);
        if (user && "value" in user) live.user = user.value;
        if (figures && "value" in figures) live.figures = figures.value.accounts.find((f) => f.login === a.login) ?? null;
        const failed = [user, figures].find((r) => r && "error" in r) as { error: unknown } | undefined;
        if (failed) live.error = liveError(failed.error);
        else if (!user || !figures) live.error = "MT5 did not answer in time.";
        else if (!live.figures) live.error = "MT5 does not know this login.";
        if (force && !live.figures) {
          if (failed?.error instanceof GatewayError) throw staffMt5Error(failed.error);
          throw new HttpError(422, "MT5_UNAVAILABLE", live.error ?? "MT5 could not be read.");
        }
        // When MT5 says the account was registered, kept the first time it is seen (imports and resolved creates have none).
        const registered = live.user?.registeredAt ? new Date(live.user.registeredAt) : null;
        if (registered && !Number.isNaN(registered.getTime()) && !a.mt5_registered_at) {
          await exec(db, "UPDATE mt5_accounts SET mt5_registered_at = ?, updated_at = updated_at WHERE id = ? AND mt5_registered_at IS NULL", [registered, a.id]);
        }
        if (live.figures) await writeSnapshot(db, a.id, live.figures);
        if (live.figures || registered) a = await loadVisible(db, staff, id);
      }
    }
    const ops = await rows<BalanceOpRow>(db, `${SELECT_OP} WHERE o.mt5_account_id = ? ORDER BY o.id DESC LIMIT 20`, [a.id]);
    return { account: presentAccount(a), live, operations: ops.map(opFromDb).map(presentOp) };
  }

  router.get(
    "/accounts/:id",
    requirePermission("mt5.view"),
    handler(async (req, res) => {
      res.json(await accountPage(staffOf(req), parse(moneyId, req.params.id), false));
    }),
  );

  // Reads MT5 now and saves its figures; answers an error when MT5 cannot be read.
  router.post(
    "/accounts/:id/refresh",
    requirePermission("mt5.view"),
    handler(async (req, res) => {
      res.json(await accountPage(staffOf(req), parse(moneyId, req.params.id), true));
    }),
  );

  /**
   * Runs a staff change on an open account: one change per account at a time,
   * the account read again once it is this change's turn, MT5 failures as staff read them.
   */
  async function change<T>(req: Request, work: (a: StaffAccountRow & { login: number }, gateway: Mt5Gateway) => Promise<T>): Promise<T> {
    const staff = staffOf(req);
    const id = parse(moneyId, req.params.id);
    const first = await loadVisible(db, staff, id);
    return withAccountLock(first.id, async () => {
      const a = await loadVisible(db, staff, id);
      if (a.status !== "active" || a.login === null) throw conflict(NOT_OPEN);
      const gateway = await gatewayFor(db, a.server_code);
      try {
        return await work(a as StaffAccountRow & { login: number }, gateway);
      } catch (error) {
        throw error instanceof GatewayError ? staffMt5Error(error) : error;
      }
    });
  }

  const respond = async (req: Request) => ({ account: presentAccount(await loadVisible(db, staffOf(req), parse(moneyId, req.params.id))) });

  router.post(
    "/accounts/:id/leverage",
    requirePermission("mt5.edit"),
    stepUp,
    handler(async (req, res) => {
      const { leverage } = parse(leverageBody, req.body ?? {});
      const kept = await change(req, async (a, gateway) => {
        if (leverage === a.leverage) return leverage;
        // The gateway's leverage list is the last word: it refuses anything else.
        const user = await callMt5Again(gateway, "user.update", { server: a.server_code, login: a.login, leverage }, log);
        await transaction(db, async (conn) => {
          await lockClient(conn, a.client_id);
          await exec(conn, "UPDATE mt5_accounts SET leverage = ? WHERE id = ?", [user.leverage, a.id]);
          await writeAudit(conn, ctx(req), {
            action: "mt5.account.leverage_changed", entityType: "client", entityId: a.client_id,
            before: { leverage: a.leverage }, after: { leverage: user.leverage }, meta: { accountId: a.id, login: a.login },
          });
        });
        return user.leverage;
      });
      if (kept !== leverage) throw new HttpError(422, "MT5_DIFFERENT", `MT5 kept the leverage at 1:${kept}.`);
      res.json(await respond(req));
    }),
  );

  router.post(
    "/accounts/:id/suspend",
    requirePermission("mt5.edit"),
    stepUp,
    handler(async (req, res) => {
      const { reason } = parse(reasonBody, req.body ?? {});
      const staff = staffOf(req);
      await change(req, async (a, gateway) => {
        if (a.suspended_at) throw conflict("This account is already suspended.");
        // Sign-in off in MT5; the client's own archive (trading off) is a separate switch and stays as it is.
        await callMt5Again(gateway, "user.update", { server: a.server_code, login: a.login, enabled: false }, log);
        await transaction(db, async (conn) => {
          await lockClient(conn, a.client_id);
          await exec(conn, "UPDATE mt5_accounts SET suspended_at = CURRENT_TIMESTAMP(3), suspended_by = ?, suspended_reason = ? WHERE id = ?", [staff.id, reason, a.id]);
          await writeAudit(conn, ctx(req), { action: "mt5.account.suspended", entityType: "client", entityId: a.client_id, meta: { accountId: a.id, login: a.login, reason } });
        });
      });
      res.json(await respond(req));
    }),
  );

  router.post(
    "/accounts/:id/reactivate",
    requirePermission("mt5.edit"),
    stepUp,
    handler(async (req, res) => {
      const { reason } = parse(reasonBody, req.body ?? {});
      await change(req, async (a, gateway) => {
        if (!a.suspended_at) throw conflict("This account is not suspended.");
        await callMt5Again(gateway, "user.update", { server: a.server_code, login: a.login, enabled: true }, log);
        await transaction(db, async (conn) => {
          await lockClient(conn, a.client_id);
          await exec(conn, "UPDATE mt5_accounts SET suspended_at = NULL, suspended_by = NULL, suspended_reason = NULL WHERE id = ?", [a.id]);
          await writeAudit(conn, ctx(req), {
            action: "mt5.account.reactivated", entityType: "client", entityId: a.client_id,
            meta: { accountId: a.id, login: a.login, reason, suspendedReason: a.suspended_reason },
          });
        });
      });
      res.json(await respond(req));
    }),
  );

  // A new password made here, set in MT5 and shown once. It is not kept anywhere, and the audit names only which one.
  router.post(
    "/accounts/:id/password",
    requirePermission("mt5.password"),
    stepUp,
    handler(async (req, res) => {
      const { type } = parse(passwordBody, req.body ?? {});
      const password = generateMt5Password();
      const login = await change(req, async (a, gateway) => {
        await callMt5Again(gateway, "user.password", { server: a.server_code, login: a.login, type, password }, log);
        await transaction(db, async (conn) => {
          await lockClient(conn, a.client_id);
          await writeAudit(conn, ctx(req), { action: "mt5.account.password_reset", entityType: "client", entityId: a.client_id, meta: { accountId: a.id, login: a.login, type } });
          // The client hears of it in the bell, so a reset they did not ask for does not go unnoticed.
          await notifyClient(conn, a.client_id, {
            type: "security",
            title: "Your trading account password was reset",
            body: `Our team set a new ${type === "main" ? "master" : "investor"} password for MT5 account ${a.login}. If you did not ask for this, contact support straight away.`,
          });
        });
        return String(a.login);
      });
      res.json({ login, type, password });
    }),
  );

  return router;
}
