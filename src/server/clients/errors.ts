import type { NextFunction, Request, Response } from "express";
import { ZodError, type ZodType, type ZodTypeDef } from "zod";
import { HttpError } from "../lib/http";
import { loggablePath } from "../lib/logger";

// The portal and app were written against a Laravel API, so the client API
// answers errors in Laravel's shape: { message, errors: { field: [text] } }.

export class ValidationError extends HttpError {
  constructor(
    public fields: Record<string, string[]>,
    /** Extra top-level keys for the error body, next to message and errors. */
    public extra: Record<string, unknown> = {},
  ) {
    super(422, "VALIDATION", Object.values(fields)[0]?.[0] ?? "The given data was invalid.");
  }
}

export class TooManyRequests extends HttpError {
  constructor(public retryAfter: number, message = "Too many attempts. Please wait before retrying.") {
    super(429, "THROTTLED", message);
  }
}

export const fieldError = (field: string, message: string) => new ValidationError({ [field]: [message] });

/** Parses a body with Zod and reports problems per field, using the first message for each. */
export function validate<Out>(schema: ZodType<Out, ZodTypeDef, unknown>, value: unknown): Out {
  const result = schema.safeParse(value ?? {});
  if (result.success) return result.data;
  throw new ValidationError(issuesToFields(result.error));
}

function issuesToFields(error: ZodError): Record<string, string[]> {
  const fields: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? "body");
    if (!fields[field]) fields[field] = [issue.message];
  }
  return fields;
}

export function clientErrorMiddleware(log: { error: (obj: unknown, msg: string) => void }) {
  return (error: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ValidationError) {
      res.status(422).json({ ...error.extra, message: error.message, errors: error.fields });
      return;
    }
    if (error instanceof TooManyRequests) {
      res.setHeader("Retry-After", String(error.retryAfter));
      res.status(429).json({ message: error.message });
      return;
    }
    if (error instanceof HttpError) {
      res.status(error.status).json({ message: error.status === 401 ? "Unauthenticated." : error.message });
      return;
    }
    if (error instanceof ZodError) {
      res.status(422).json({ message: "The given data was invalid.", errors: issuesToFields(error) });
      return;
    }
    const status = (error as { status?: number }).status;
    if (status === 413) return void res.status(413).json({ message: "The upload is too large." });
    if (status === 400) return void res.status(400).json({ message: "Invalid request body." });
    log.error({ err: error, path: loggablePath(req.originalUrl) }, "Unhandled client API error");
    res.status(500).json({ message: "Something went wrong. Please try again." });
  };
}
