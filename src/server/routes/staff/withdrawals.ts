import { Router } from "express";
import type { AppDeps } from "../../app";

/** The withdrawal queue: check, approve (twice when needed), pay and record the payout, or reject. */
export function staffWithdrawalsRouter(_deps: AppDeps): Router {
  const router = Router();
  return router;
}
