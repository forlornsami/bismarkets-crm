import { Router, type NextFunction, type Request, type Response } from "express";
import type { AppDeps } from "../../app";
import { fieldError, TooManyRequests } from "../../clients/errors";
import { paged, pageQuery } from "../../clients/money";
import { clientActor, clientAuth, clientOf, noImpersonation } from "../../clients/session";
import { auditContext } from "../../lib/audit";
import { one, rows } from "../../lib/db";
import { handler } from "../../lib/http";
import { RateLimiter } from "../../lib/rateLimit";
import { mt5Unavailable } from "../../mt5/errors";
import { opFromDb, runBalanceOp, SELECT_OP, TO_MT5_FAILED, type BalanceOpRow } from "../../mt5/operations";
import { presentTransfer, settledOp, startTransfer, type TransferPurpose } from "../../mt5/transfers";

// The portal and app's transfers between the wallet and MT5 accounts, and
// their history. Answers: 200 when MT5 made the deal, 202 when its answer was
// lost (the resolver settles it; the row shows pending meanwhile), 422 when it
// definitely did not happen. Never 409 or 5xx for a refusal: the app reads
// those as "it may have happened" and blocks a retry.

const HOUR = 3_600_000;

/** A JSON body as an object of fields. */
const bodyOf = (req: Request): Record<string, unknown> =>
  req.body !== null && typeof req.body === "object" && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};

/** A settled (or still open) transfer as the client's answer. */
function answer(res: Response, op: BalanceOpRow) {
  const data = presentTransfer(op);
  if (op.status === "completed") return void res.json({ success: true, message: "Transfer completed.", data });
  if (op.status === "failed") {
    // MT5 was never reached (or the gateway would not send it): the common "try again later".
    if (op.failure === "unavailable" || op.failure === "bad_request") throw mt5Unavailable();
    throw fieldError("amount", op.client_message ?? TO_MT5_FAILED);
  }
  res.status(202).json({ success: true, message: "Your transfer is being processed.", data });
}

export function clientTransfersRouter(deps: AppDeps): Router {
  const { db, config, log } = deps;
  const mt5 = deps.mt5 ?? null;
  const router = Router();
  const auth = clientAuth(db, config);

  // Counted when a transfer is written: a refused form or a repeat does not use one up.
  const transfers = new RateLimiter(30, HOUR);
  // Every attempt, refused or not, since one from MT5 reads the account in MT5 before anything is decided.
  const attempts = new RateLimiter(120, HOUR);
  const TOO_MANY = "Too many transfers. Please wait before trying again.";
  const gate = (req: Request, _res: Response, next: NextFunction) => {
    const key = String(clientOf(req).id);
    if (transfers.isLimited(key)) return next(new TooManyRequests(transfers.retryAfter(key), TOO_MANY));
    if (!attempts.take(key)) return next(new TooManyRequests(attempts.retryAfter(key), TOO_MANY));
    next();
  };

  // Staff view-only sessions may look. Only the two transfer directions: demo top-ups are not wallet money.
  router.get(
    "/transfers",
    auth,
    handler(async (req, res) => {
      const clientId = clientOf(req).id;
      const { page, perPage } = pageQuery(req.query);
      const where = "WHERE o.client_id = ? AND o.purpose IN ('wallet_to_mt5', 'mt5_to_wallet')";
      const total = Number((await one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM mt5_balance_ops o ${where}`, [clientId]))?.n ?? 0);
      const list = await rows<BalanceOpRow>(db, `${SELECT_OP} ${where} ORDER BY o.created_at DESC, o.id DESC LIMIT ? OFFSET ?`, [clientId, perPage, (page - 1) * perPage]);
      res.json(paged(list.map(opFromDb).map(presentTransfer), page, perPage, total));
    }),
  );

  const transfer = (purpose: TransferPurpose) =>
    handler(async (req, res) => {
      const client = clientOf(req);
      const body = bodyOf(req);
      const started = await startTransfer(
        { db, mt5, log },
        { clientId: client.id, purpose, account: body.mt5_account_id, amount: body.amount, ip: req.clientIp, audit: auditContext(req, clientActor(client)) },
      );
      if (started.repeat) return answer(res, await settledOp(db, started.opId));
      transfers.take(String(client.id));
      answer(res, await runBalanceOp({ db, mt5, log }, started.opId));
    });

  router.post("/transfer/wallet-to-mt5", auth, noImpersonation, gate, transfer("wallet_to_mt5"));
  router.post("/transfer/mt5-to-wallet", auth, noImpersonation, gate, transfer("mt5_to_wallet"));

  return router;
}
