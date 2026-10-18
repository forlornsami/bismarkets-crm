import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ZodError, type ZodType, type ZodTypeDef } from "zod";
import { loggablePath } from "./logger";

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, "BAD_REQUEST", message, details);
export const unauthorized = (message = "Please sign in.") => new HttpError(401, "UNAUTHENTICATED", message);
export const forbidden = (message = "You do not have permission to do this.") => new HttpError(403, "FORBIDDEN", message);
export const notFound = (message = "Not found.") => new HttpError(404, "NOT_FOUND", message);
export const conflict = (message: string) => new HttpError(409, "CONFLICT", message);

/** Wraps an async handler so rejected promises reach the error middleware. */
export const handler =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

export function parse<Out>(schema: ZodType<Out, ZodTypeDef, unknown>, value: unknown): Out {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw badRequest(
      "Check the highlighted fields.",
      result.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })),
    );
  }
  return result.data;
}

export function errorMiddleware(log: { error: (obj: unknown, msg: string) => void }) {
  return (error: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: { code: error.code, message: error.message, details: error.details } });
      return;
    }
    if (error instanceof ZodError) {
      res.status(400).json({ error: { code: "BAD_REQUEST", message: "Invalid request." } });
      return;
    }
    const status = (error as { status?: number; type?: string }).status;
    if (status === 413 || status === 400) {
      // body-parser errors: too large or malformed JSON.
      res.status(status).json({ error: { code: status === 413 ? "TOO_LARGE" : "BAD_REQUEST", message: "Invalid request body." } });
      return;
    }
    log.error({ err: error, path: loggablePath(req.originalUrl) }, "Unhandled request error");
    res.status(500).json({ error: { code: "INTERNAL", message: "Something went wrong. Please try again." } });
  };
}
