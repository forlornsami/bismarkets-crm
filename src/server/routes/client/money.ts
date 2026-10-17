import { Router } from "express";
import type { AppDeps } from "../../app";

/** The portal and app's money endpoints: wallet summary, deposit methods, deposits, withdrawals, saved payout accounts and history. */
export function clientMoneyRouter(_deps: AppDeps): Router {
  const router = Router();
  return router;
}
