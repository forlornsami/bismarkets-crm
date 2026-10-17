import { Router } from "express";
import type { AppDeps } from "../../app";

/** The deposit review queue: check the payment, approve (twice above the limit) or reject. */
export function staffDepositsRouter(_deps: AppDeps): Router {
  const router = Router();
  return router;
}
