import { Router, type NextFunction, type Request, type Response } from "express";
import type { AppDeps } from "../../app";
import { fieldError, TooManyRequests, ValidationError } from "../../clients/errors";
import { lockClient } from "../../clients/kyc";
import { assertClientMayMoveMoney, formFlag, formId, formText } from "../../clients/money";
import { clientName, loadClient } from "../../clients/model";
import { clientActor, clientAuth, clientOf, noImpersonation } from "../../clients/session";
import { auditContext, auditStandalone, writeAudit } from "../../lib/audit";
import { exec, one, rows, transaction } from "../../lib/db";
import { handler } from "../../lib/http";
import { RateLimiter } from "../../lib/rateLimit";
import { AMOUNT_MESSAGES, formatMinor, parseAmount } from "../../money/amounts";
import { lockWallet } from "../../money/ledger";
import {
  activateAccount, clientAccountByLogin, clientAccounts, loadAccount, presentClientAccount, refreshFigures, withAccountLock, type AccountRow,
} from "../../mt5/accounts";
import {
  accountNotFound, callMt5, callMt5Again, CHANGE_FAILED, CREATE_UNCONFIRMED, mt5Unavailable, SUSPENDED, unconfirmed,
} from "../../mt5/errors";
import { GatewayError, type Mt5Gateway } from "../../mt5/gateway";
import { DEMO_FAILED, insertBalanceOp, runBalanceOp } from "../../mt5/operations";
import { presentClientPackage, SELECT_PACKAGE, packageFromDb, visiblePackage, type PackageRow } from "../../mt5/packages";
import { MT5_PASSWORD_MESSAGE, mt5PasswordOk } from "../../mt5/passwords";
import { withMt5Reference } from "../../mt5/references";
import { loadMt5Settings, parseLeverage, serverEnabled } from "../../mt5/settings";

// The portal and app's MT5 endpoints: account packages, leverages, the
// client's MT5 accounts (list, open, archive, restore, leverage, passwords),
// demo top-ups, and the trade-history envelope. Every change refuses staff
// view-only sessions. Definite refusals are 4xx other than 408 and 409: the
// app reads those two (and 5xx) as "it may have happened" and blocks a retry,
// which is what a 409 here means.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** How long an account opening waits for its demo funding; after that the funding finishes on its own. */
const FUNDING_WAIT_MS = 8_000;

const LEVERAGE_NOT_AVAILABLE = "This leverage is not available.";
const SAME_PASSWORDS = "The investor password must be different from the master password.";
const STILL_SETTING_UP = "Your previous account is still being set up. Please check your accounts in a minute.";
const PASSWORD_REFUSED = "MT5 did not accept this password. Choose a different one.";
const NOT_DEMO = "Choose one of your demo accounts.";
const RESTORE_FIRST = "Restore this account before changing its leverage.";
const CREATES_USED = "You have opened too many accounts today. Please try again tomorrow.";
const PASSWORDS_USED = "Too many password changes. Please wait before trying again.";
const TOP_UPS_USED = "Too many top-ups today. Please try again tomorrow.";
const TOP_UP_ATTEMPTS_USED = "Too many top-ups. Please wait before trying again.";

/** "$1,000.00": the form the app looks for in the wallet-minimum answer. */
const dollars = (cents: number) => `$${formatMinor(cents)}`;

/** A JSON body as an object of fields (PATCH /active and /inactive come with none). */
const bodyOf = (req: Request): Record<string, unknown> =>
  req.body !== null && typeof req.body === "object" && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};

/**
 * The profile's country as the gateway takes it: at most 64 characters and no
 * control characters. The profile allows 80 of any text, and a body the
 * gateway refuses comes back unsigned, which reads as "maybe opened".
 */
const mt5Country = (country: string | null) => (country ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 64);

/** A password field as sent: text only (anything else counts as empty). */
const passwordText = (value: unknown) => (typeof value === "string" ? value : "");

/**
 * The app shows its "add funds" banner only for a 403 whose message says how
 * much is needed, and the portal shows the field text: so both, at 403.
 */
const walletMinimum = (cents: number) => {
  const message = `You must have a wallet balance of ${dollars(cents)} to open this account.`;
  return new ValidationError({ account_package_id: [message] }, {}, 403);
};

/** Waits for `work` up to `ms`, and lets it run on after that. */
async function within(work: Promise<unknown>, ms: number) {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([work, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
  clearTimeout(timer);
}

export function clientMt5Router(deps: AppDeps): Router {
  const { db, config, log } = deps;
  const mt5 = deps.mt5 ?? null;
  const router = Router();
  const auth = clientAuth(db, config);
  const ctx = (req: Request) => auditContext(req, clientActor(clientOf(req)));

  // Counted when MT5 is asked (a refused form does not use one up), in the same step that decides, so
  // requests sent at once cannot all pass a check made before any of them was counted. The gates
  // below only turn a request away early once the limit is used up.
  const creates = new RateLimiter(10, DAY);
  const passwordChanges = new RateLimiter(10, HOUR);
  const topUps = new RateLimiter(20, DAY);
  // Every top-up attempt, refused or not, since each one reads the account in MT5 before anything is decided.
  const topUpAttempts = new RateLimiter(60, HOUR);
  const gate = (limiter: RateLimiter, message: string) => (req: Request, _res: Response, next: NextFunction) => {
    const key = String(clientOf(req).id);
    if (limiter.isLimited(key)) return next(new TooManyRequests(limiter.retryAfter(key), message));
    next();
  };
  /** Counts every request, refused or not, and turns it away once they are used up. */
  const attempt = (limiter: RateLimiter, message: string) => (req: Request, _res: Response, next: NextFunction) => {
    const key = String(clientOf(req).id);
    if (!limiter.take(key)) return next(new TooManyRequests(limiter.retryAfter(key), message));
    next();
  };
  /** Counts one use of `limiter`, or refuses with 429 when it is used up. */
  const use = (limiter: RateLimiter, key: string, message: string) => {
    if (!limiter.take(key)) throw new TooManyRequests(limiter.retryAfter(key), message);
  };

  /** MT5 on and the account's server switched on, or the "temporarily unavailable" refusal. */
  async function gatewayFor(server: string): Promise<Mt5Gateway> {
    if (!mt5 || !(await serverEnabled(db, server))) throw mt5Unavailable();
    return mt5;
  }

  /** A failed change, as the client reads it: unconfirmed (409), MT5 said no, or MT5 not reached. */
  function changeFailed(error: unknown): never {
    if (!(error instanceof GatewayError)) throw error;
    if (error.kind === "unknown") throw unconfirmed();
    if (error.kind === "refused") throw fieldError("mt5", CHANGE_FAILED);
    throw mt5Unavailable();
  }

  /**
   * Runs a change on the caller's account named in the path, one change per
   * account at a time, with the account read again once it is this change's turn.
   */
  async function changeAccount(req: Request, work: (a: AccountRow) => Promise<void>) {
    const client = clientOf(req);
    const found = await clientAccountByLogin(db, client.id, req.params.login);
    if (!found) throw accountNotFound();
    await withAccountLock(found.id, async () => {
      const a = await loadAccount(db, found.id);
      if (!a || a.status !== "active" || a.client_id !== client.id) throw accountNotFound();
      await work(a);
    });
  }

  // ---------- Packages and leverages ----------

  router.get(
    "/account-packages",
    auth,
    handler(async (_req, res) => {
      const [list, settings] = await Promise.all([rows<PackageRow>(db, `${SELECT_PACKAGE} WHERE p.is_visible = 1 ORDER BY p.sort_order, p.id`), loadMt5Settings(db)]);
      res.json({ success: true, data: list.map(packageFromDb).map((p) => presentClientPackage(p, settings)) });
    }),
  );

  // The app will not open an account without this list, and sends one of its values back.
  router.get(
    "/leverages",
    auth,
    handler(async (_req, res) => {
      const settings = await loadMt5Settings(db);
      res.json({ success: true, data: settings.leverages.map(String) });
    }),
  );

  // ---------- Accounts ----------

  // Staff view-only sessions may look: nothing here changes the account.
  router.get(
    "/mt5-accounts",
    auth,
    handler(async (req, res) => {
      const list = await refreshFigures(db, mt5, await clientAccounts(db, clientOf(req).id), { log });
      const shown = list.map(presentClientAccount);
      res.json({ success: true, real_accounts: shown.filter((a) => !a.is_demo), demo_accounts: shown.filter((a) => a.is_demo) });
    }),
  );

  router.post(
    "/mt5-accounts",
    auth,
    noImpersonation,
    gate(creates, CREATES_USED),
    handler(async (req, res) => {
      const client = clientOf(req);
      const body = bodyOf(req);
      // Frozen, closed and unverified clients cannot open accounts (checked again with the client row locked).
      await assertClientMayMoveMoney(db, client.id);
      const demo = formFlag(body.is_demo);
      if (demo === undefined) throw fieldError("is_demo", "Choose a live or a demo account.");
      const settings = await loadMt5Settings(db);
      if (!mt5) throw mt5Unavailable();
      const packageId = demo ? null : formId(body.account_package_id);
      const pkg = packageId ? await visiblePackage(db, packageId) : undefined;
      if (demo && (!settings.demoServerCode || !settings.demoGroup)) throw mt5Unavailable();
      const target = demo ? settings.demoServerCode : pkg?.server_code;
      if (target && !(await serverEnabled(db, target))) throw mt5Unavailable();

      const leverage = parseLeverage(body.leverage);
      if (leverage === null || !settings.leverages.includes(leverage)) throw fieldError("leverage", LEVERAGE_NOT_AVAILABLE);
      const password = body.password;
      const investorPassword = body.investor_password;
      if (!mt5PasswordOk(password)) throw fieldError("password", MT5_PASSWORD_MESSAGE);
      if (!mt5PasswordOk(investorPassword)) throw fieldError("investor_password", MT5_PASSWORD_MESSAGE);
      if (password === investorPassword) throw fieldError("investor_password", SAME_PASSWORDS);
      let demoCents = 0;
      if (demo) {
        const amount = parseAmount(body.demo_amount);
        if ("problem" in amount || amount.minor > settings.demoMaxOpeningCents) throw fieldError("demo_amount", `Choose a starting balance up to ${dollars(settings.demoMaxOpeningCents)}.`);
        demoCents = amount.minor;
      } else {
        if (!pkg) throw fieldError("account_package_id", "Choose an account type.");
        const currency = formText(body.currency)?.trim().toLowerCase();
        if (currency && currency !== "usd") throw fieldError("currency", "This account type is only available in USD.");
      }

      // Limits, a create still in progress and the wallet minimum are read with the client row locked, and the
      // 'creating' row is written in the same transaction: two requests at once cannot both pass.
      const created = await transaction(db, async (conn) => {
        await lockClient(conn, client.id);
        await assertClientMayMoveMoney(conn, client.id);
        const wallet = demo ? null : await lockWallet(conn, client.id);
        const s = await loadMt5Settings(conn, "share");
        const p = demo ? null : await visiblePackage(conn, packageId!, true);
        if (!demo && !p) throw fieldError("account_package_id", "Choose an account type.");
        if (!s.leverages.includes(leverage)) throw fieldError("leverage", LEVERAGE_NOT_AVAILABLE);
        if (demo && demoCents > s.demoMaxOpeningCents) throw fieldError("demo_amount", `Choose a starting balance up to ${dollars(s.demoMaxOpeningCents)}.`);
        const server = demo ? s.demoServerCode : p!.server_code;
        const group = demo ? s.demoGroup : p!.mt5_group;
        if (!server || !group || !(await serverEnabled(conn, server))) throw mt5Unavailable();
        // A create whose account MT5 is known to have made, under a login another row holds, waits for staff
        // but cannot still be on its way: it counts toward the limit and does not hold up a new account.
        const counts = await one<{ same_kind: string | null; pending: string | null }>(
          conn,
          `SELECT SUM(is_demo = ? AND status IN ('creating', 'active', 'unknown')) AS same_kind,
             SUM(status = 'creating' OR (status = 'unknown' AND (failure IS NULL OR failure <> 'login_taken'))) AS pending
           FROM mt5_accounts WHERE client_id = ?`,
          [demo ? 1 : 0, client.id],
        );
        const max = demo ? s.maxDemoAccounts : s.maxLiveAccounts;
        if (Number(counts?.same_kind ?? 0) >= max) throw fieldError("is_demo", `You have reached the limit of ${max} ${demo ? "demo" : "live"} account${max === 1 ? "" : "s"}.`);
        // An answer that never came may still have opened an account: no second one until it is settled.
        if (Number(counts?.pending ?? 0) > 0) throw fieldError("is_demo", STILL_SETTING_UP);
        if (!demo && wallet!.available_cents < p!.min_deposit_cents) throw walletMinimum(p!.min_deposit_cents);
        // Counted with the client row locked, just before the row that asks MT5: a refusal here writes nothing.
        use(creates, String(client.id), CREATES_USED);
        const packageName = demo ? "Demo" : p!.name;
        return withMt5Reference("A", async (createRef) => {
          const r = await exec(
            conn,
            `INSERT INTO mt5_accounts (client_id, server_code, is_demo, package_id, package_name, mt5_group, currency, leverage, create_ref, created_ip)
             VALUES (?, ?, ?, ?, ?, ?, 'USD', ?, ?, ?)`,
            [client.id, server, demo ? 1 : 0, p?.id ?? null, packageName, group, leverage, createRef, req.clientIp.slice(0, 45)],
          );
          return { id: r.insertId, createRef, server, group };
        });
      });
      const meta = { accountId: created.id, server: created.server, group: created.group, isDemo: demo, packageId: pkg?.id ?? null, leverage, createRef: created.createRef };

      const profile = (await loadClient(db, client.id))!;
      let login: number;
      try {
        ({ login } = await callMt5(
          mt5,
          "user.create",
          {
            server: created.server, group: created.group, leverage, name: clientName(profile).slice(0, 64), email: profile.email, country: mt5Country(profile.country),
            comment: created.createRef, password: password as string, investorPassword: investorPassword as string,
          },
          log,
        ));
      } catch (error) {
        if (!(error instanceof GatewayError)) throw error;
        if (error.kind === "unknown") {
          // Maybe opened, maybe not: the resolver looks for it by its reference. It is never asked for again.
          await exec(db, "UPDATE mt5_accounts SET status = 'unknown', failure = ?, next_check_at = ? WHERE id = ? AND status = 'creating'", [
            error.code, new Date(Date.now() + 60_000), created.id,
          ]);
          throw unconfirmed(CREATE_UNCONFIRMED);
        }
        const failure = error.kind === "refused" ? error.code : error.kind;
        await transaction(db, async (conn) => {
          await lockClient(conn, client.id);
          const r = await exec(conn, "UPDATE mt5_accounts SET status = 'failed', failure = ? WHERE id = ? AND status = 'creating'", [failure, created.id]);
          if (r.affectedRows === 1) await writeAudit(conn, ctx(req), { action: "mt5.account.create_failed", entityType: "client", entityId: client.id, meta: { ...meta, reason: failure } });
        });
        if (error.kind === "refused" && error.code === "invalid_password") throw fieldError("password", PASSWORD_REFUSED);
        if (error.kind === "refused") throw fieldError("mt5", "We could not open the account. Please try again later.");
        throw mt5Unavailable();
      }

      let opened: boolean;
      try {
        opened = await transaction(db, async (conn) => {
          await lockClient(conn, client.id);
          if (!(await activateAccount(conn, created.id, login))) return false;
          await writeAudit(conn, ctx(req), { action: "mt5.account.created", entityType: "client", entityId: client.id, meta: { ...meta, login } });
          return true;
        });
      } catch (error) {
        // MT5 opened the account but the row could not record it (its login is already on another row):
        // leave it unknown for staff, and tell the client the honest "not confirmed".
        log.error({ err: error, accountId: created.id, login }, "MT5 opened an account the CRM could not record");
        await exec(db, "UPDATE mt5_accounts SET status = 'unknown', failure = 'not_recorded', next_check_at = ? WHERE id = ? AND status = 'creating'", [
          new Date(Date.now() + HOUR), created.id,
        ]);
        throw unconfirmed(CREATE_UNCONFIRMED);
      }
      if (!opened) log.warn({ accountId: created.id, login }, "MT5 account was settled before its own request finished");

      if (opened && demo) {
        // The starting balance is a balance operation like any other; if it fails or is unconfirmed the account
        // is still open (the resolver settles an unconfirmed one, and the client can top up).
        try {
          const op = await transaction(db, async (conn) => {
            await lockClient(conn, client.id);
            await one(conn, "SELECT id FROM mt5_accounts WHERE id = ? FOR UPDATE", [created.id]);
            return insertBalanceOp(conn, { purpose: "demo_funding", clientId: client.id, accountId: created.id, serverCode: created.server, login, amountCents: demoCents, ip: req.clientIp });
          });
          await within(
            runBalanceOp({ db, mt5, log }, op.id).catch((e) => log.error({ err: e, opId: op.id }, "Demo funding failed")),
            FUNDING_WAIT_MS,
          );
        } catch (error) {
          log.error({ err: error, accountId: created.id }, "Demo funding could not be started");
        }
      }
      const row = (await loadAccount(db, created.id))!;
      if (row.status !== "active") throw unconfirmed(CREATE_UNCONFIRMED);
      res.json({ success: true, message: "Your account is ready.", account: presentClientAccount(row) });
    }),
  );

  // Archive: the client's own "put away". Trading is switched off in MT5; sign-in stays on.
  router.patch(
    "/mt5-accounts/:login/inactive",
    auth,
    noImpersonation,
    handler(async (req, res) => {
      const client = clientOf(req);
      await changeAccount(req, async (a) => {
        if (a.suspended_at) throw fieldError("account", "Account already inactive");
        if (!a.archived_at) {
          const gateway = await gatewayFor(a.server_code);
          let open: number;
          try {
            ({ total: open } = await callMt5(gateway, "positions.total", { server: a.server_code, login: a.login! }, log));
          } catch (error) {
            changeFailed(error);
          }
          if (open > 0) throw fieldError("account", "Close your open trades before archiving this account.");
          try {
            await callMt5Again(gateway, "user.update", { server: a.server_code, login: a.login!, tradeDisabled: true }, log);
          } catch (error) {
            changeFailed(error);
          }
          await transaction(db, async (conn) => {
            await lockClient(conn, client.id);
            await exec(conn, "UPDATE mt5_accounts SET archived_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND archived_at IS NULL", [a.id]);
            await writeAudit(conn, ctx(req), { action: "mt5.account.archived", entityType: "client", entityId: client.id, meta: { accountId: a.id, login: a.login } });
          });
        }
        res.json({ success: true, message: "Account archived." });
      });
    }),
  );

  router.patch(
    "/mt5-accounts/:login/active",
    auth,
    noImpersonation,
    handler(async (req, res) => {
      const client = clientOf(req);
      await changeAccount(req, async (a) => {
        // Both clients offer "restore" on a suspended account too; only staff can switch it back on.
        if (a.suspended_at) throw fieldError("account", SUSPENDED);
        // Asked even when the row is not archived: an archive whose answer was lost may have switched trading
        // off in MT5 all the same, and this is how it comes back on (MT5 is not written when nothing differs).
        const gateway = await gatewayFor(a.server_code);
        try {
          await callMt5Again(gateway, "user.update", { server: a.server_code, login: a.login!, tradeDisabled: false }, log);
        } catch (error) {
          changeFailed(error);
        }
        if (a.archived_at) {
          await transaction(db, async (conn) => {
            await lockClient(conn, client.id);
            await exec(conn, "UPDATE mt5_accounts SET archived_at = NULL WHERE id = ?", [a.id]);
            await writeAudit(conn, ctx(req), { action: "mt5.account.restored", entityType: "client", entityId: client.id, meta: { accountId: a.id, login: a.login } });
          });
        }
        res.json({ success: true, message: "Account restored." });
      });
    }),
  );

  router.patch(
    "/mt5-accounts/:login/leverage",
    auth,
    noImpersonation,
    handler(async (req, res) => {
      const client = clientOf(req);
      const wanted = parseLeverage(bodyOf(req).leverage);
      await changeAccount(req, async (a) => {
        if (a.archived_at || a.suspended_at) throw fieldError("leverage", RESTORE_FIRST);
        const settings = await loadMt5Settings(db);
        if (wanted === null || !settings.leverages.includes(wanted)) throw fieldError("leverage", LEVERAGE_NOT_AVAILABLE);
        // Asked even when the row already shows this leverage: a change whose answer was lost may have left
        // MT5 at another one (MT5 is not written when nothing differs).
        const gateway = await gatewayFor(a.server_code);
        let now: number;
        try {
          ({ leverage: now } = await callMt5Again(gateway, "user.update", { server: a.server_code, login: a.login!, leverage: wanted }, log));
        } catch (error) {
          changeFailed(error);
        }
        // The row follows what MT5 says, so the very next list shows the account's real leverage.
        if (now !== a.leverage) {
          await transaction(db, async (conn) => {
            await lockClient(conn, client.id);
            await exec(conn, "UPDATE mt5_accounts SET leverage = ? WHERE id = ?", [now, a.id]);
            await writeAudit(conn, ctx(req), {
              action: "mt5.account.leverage_changed", entityType: "client", entityId: client.id,
              before: { leverage: a.leverage }, after: { leverage: now }, meta: { accountId: a.id, login: a.login },
            });
          });
        }
        if (now !== wanted) {
          log.warn({ accountId: a.id, wanted, now }, "MT5 kept a different leverage than the one asked for");
          throw fieldError("mt5", CHANGE_FAILED);
        }
        res.json({ success: true, message: "Leverage changed.", leverage: String(wanted) });
      });
    }),
  );

  router.patch(
    "/mt5-accounts/:login/password",
    auth,
    noImpersonation,
    gate(passwordChanges, PASSWORDS_USED),
    handler(async (req, res) => {
      const client = clientOf(req);
      const body = bodyOf(req);
      // A pair left empty is unchanged: the app sends "" for the password it is not changing.
      const main = { value: passwordText(body.password), confirmation: passwordText(body.password_confirmation) };
      const investor = { value: passwordText(body.investor_password), confirmation: passwordText(body.investor_password_confirmation) };
      const changeMain = main.value !== "" || main.confirmation !== "";
      const changeInvestor = investor.value !== "" || investor.confirmation !== "";
      if (!changeMain && !changeInvestor) throw fieldError("password", "Enter a new password.");
      if (changeMain && main.value !== main.confirmation) throw fieldError("password_confirmation", "The passwords do not match.");
      if (changeInvestor && investor.value !== investor.confirmation) throw fieldError("investor_password_confirmation", "The passwords do not match.");
      if (changeMain && !mt5PasswordOk(main.value)) throw fieldError("password", MT5_PASSWORD_MESSAGE);
      if (changeInvestor && !mt5PasswordOk(investor.value)) throw fieldError("investor_password", MT5_PASSWORD_MESSAGE);
      if (changeMain && changeInvestor && main.value === investor.value) throw fieldError("investor_password", SAME_PASSWORDS);

      await changeAccount(req, async (a) => {
        if (a.suspended_at) throw fieldError("account", SUSPENDED);
        const gateway = await gatewayFor(a.server_code);
        use(passwordChanges, String(client.id), PASSWORDS_USED);
        // Recorded without the passwords, only which ones changed.
        const record = (changed: { main: boolean; investor: boolean }) =>
          auditStandalone(db, ctx(req), { action: "mt5.account.password_changed", entityType: "client", entityId: client.id, meta: { accountId: a.id, login: a.login, ...changed } });
        const refusal = (error: unknown, field: string): never => {
          if (error instanceof GatewayError && error.kind === "refused" && error.code === "invalid_password") throw fieldError(field, PASSWORD_REFUSED);
          return changeFailed(error);
        };
        if (changeMain) {
          try {
            await callMt5Again(gateway, "user.password", { server: a.server_code, login: a.login!, type: "main", password: main.value }, log);
          } catch (error) {
            refusal(error, "password");
          }
        }
        if (changeInvestor) {
          try {
            await callMt5Again(gateway, "user.password", { server: a.server_code, login: a.login!, type: "investor", password: investor.value }, log);
          } catch (error) {
            if (!changeMain) refusal(error, "investor_password");
            await record({ main: true, investor: false });
            if (error instanceof GatewayError && error.kind !== "unknown") {
              throw fieldError("investor_password", "Your master password was changed, but the investor password was not. Please try again.");
            }
            changeFailed(error);
          }
        }
        await record({ main: changeMain, investor: changeInvestor });
        res.json({ success: true, message: "Password changed." });
      });
    }),
  );

  // ---------- Demo top-ups ----------

  router.post(
    "/mt5-accounts/demo/top-up",
    auth,
    noImpersonation,
    gate(topUps, TOP_UPS_USED),
    attempt(topUpAttempts, TOP_UP_ATTEMPTS_USED),
    handler(async (req, res) => {
      const client = clientOf(req);
      const body = bodyOf(req);
      /** The caller's demo account, open and not archived, or the field error that says why not. */
      const usable = (a: AccountRow | undefined): AccountRow => {
        if (!a || a.status !== "active" || a.client_id !== client.id || a.is_demo !== 1) throw fieldError("login", NOT_DEMO);
        if (a.suspended_at) throw fieldError("login", SUSPENDED);
        if (a.archived_at) throw fieldError("login", "Restore this account before topping it up.");
        return a;
      };
      const first = usable(await clientAccountByLogin(db, client.id, body.login, { demo: true }));
      const amount = parseAmount(body.amount);
      if ("problem" in amount) throw fieldError("amount", AMOUNT_MESSAGES[amount.problem]);
      const tooMuch = (max: number) => fieldError("amount", `You can add up to ${dollars(max)} at a time.`);
      const settings = await loadMt5Settings(db);
      if (amount.minor > settings.demoMaxTopupCents) throw tooMuch(settings.demoMaxTopupCents);
      const gateway = await gatewayFor(first.server_code);
      // The live balance when MT5 answers in time, else the cached one.
      await refreshFigures(db, gateway, [first], { maxAgeMs: 0, log });

      const op = await transaction(db, async (conn) => {
        await lockClient(conn, client.id);
        const a = usable(await loadAccount(conn, first.id, true));
        const s = await loadMt5Settings(conn, "share");
        if (amount.minor > s.demoMaxTopupCents) throw tooMuch(s.demoMaxTopupCents);
        // Money still on its way counts too, so two top-ups at once cannot pass the cap together.
        const pending = await one<{ total: string | null }>(
          conn,
          "SELECT SUM(amount_cents) AS total FROM mt5_balance_ops WHERE mt5_account_id = ? AND status IN ('sending', 'unknown') AND purpose IN ('demo_funding', 'demo_topup')",
          [a.id],
        );
        if ((a.balance_cents ?? 0) + Number(pending?.total ?? 0) + amount.minor > s.demoMaxBalanceCents) {
          throw fieldError("amount", `Demo accounts can hold up to ${dollars(s.demoMaxBalanceCents)}.`);
        }
        // Counted with the client row locked, just before the operation is written: a refusal here writes nothing.
        use(topUps, String(client.id), TOP_UPS_USED);
        const created = await insertBalanceOp(conn, { purpose: "demo_topup", clientId: client.id, accountId: a.id, serverCode: a.server_code, login: a.login!, amountCents: amount.minor, ip: req.clientIp });
        await writeAudit(conn, ctx(req), {
          action: "mt5.demo.top_up_requested", entityType: "client", entityId: client.id,
          meta: { accountId: a.id, login: a.login, amountCents: amount.minor, reference: created.reference },
        });
        return created;
      });
      const settled = await runBalanceOp({ db, mt5: gateway, log }, op.id);
      if (settled.status === "completed") return void res.json({ success: true, message: "Your demo account was topped up." });
      // MT5 was never reached (or the gateway would not send it): the common "try again later".
      if (settled.status === "failed" && (settled.failure === "unavailable" || settled.failure === "bad_request")) throw mt5Unavailable();
      if (settled.status === "failed") throw fieldError("amount", settled.client_message ?? DEMO_FAILED);
      res.status(202).json({ success: true, message: "Your top-up is being processed." });
    }),
  );

  // ---------- Trade history ----------

  // Built with the deals sync in a later round. Until then the live shape with nothing in it,
  // so no page fails. Its own paging: the shared pageQuery would cut the portal's per_page=500 to 15.
  router.get(
    "/trade-history",
    auth,
    handler(async (req, res) => {
      const q = req.query as Record<string, unknown>;
      const whole = (v: unknown) => (typeof v === "string" && /^-?\d{1,9}$/.test(v.trim()) ? Number(v) : null);
      const page = Math.max(1, whole(q.page) ?? 1);
      const perPage = Math.min(500, Math.max(1, whole(q.per_page) ?? 100));
      const day = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
      const account = typeof q.account_id === "string" && /^\d{1,15}$/.test(q.account_id) ? q.account_id : null;
      res.json({
        success: true,
        filters: { from_date: day(q.from_date), to_date: day(q.to_date), account_id: account },
        summary: { total_trades: 0, total_profit: 0, total_volume: 0, total_commission: 0 },
        pagination: { current_page: page, per_page: perPage, total: 0, last_page: 1 },
        trades: [],
      });
    }),
  );

  return router;
}
