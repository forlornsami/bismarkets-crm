import express, { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { AppDeps } from "../app";
import { clientActor } from "../clients/session";
import { auditContext, writeAudit } from "../lib/audit";
import { exec, one, transaction } from "../lib/db";
import { handler } from "../lib/http";
import { checkUnsubscribeToken } from "../lib/mailer";

const page = (title: string, text: string, form = "") => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><link rel="stylesheet" href="/email/unsubscribe/style.css"></head>
<body><main><strong class="brand">BIS Markets</strong><h1>${title}</h1><p>${text}</p>${form}</main></body></html>`;

// Served from here because the page's security policy only allows same-origin styles.
const CSS = `body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#0f172a}
main{max-width:440px;margin:24px;padding:32px;background:#fff;border-radius:10px;box-shadow:0 1px 3px rgb(16 24 40/.1)}
.brand{display:block;margin-bottom:20px;font-size:18px}h1{font-size:20px;margin:0 0 10px}p{margin:0 0 20px;line-height:1.55;color:#334155}
button{padding:10px 18px;border:0;border-radius:8px;background:#e11d2e;color:#fff;font:inherit;font-weight:bold;cursor:pointer}`;

const params = z.object({ c: z.coerce.number().int().positive(), t: z.string().regex(/^[A-Za-z0-9_-]{32}$/) });

/**
 * The link at the bottom of news and offers emails. Opening it shows a
 * button (so mail scanners that follow links do not unsubscribe anyone);
 * pressing it, or a mail app's one-click unsubscribe, records the opt-out.
 * Account emails such as codes and KYC results are not affected.
 */
export function emailUnsubscribeRouter(deps: AppDeps): Router {
  const { db, config } = deps;
  const router = Router();

  const verify = (req: Request, res: Response) => {
    const p = params.safeParse(req.query);
    if (!p.success || !checkUnsubscribeToken(config, p.data.c, p.data.t)) {
      res.status(404).type("html").send(page("Link not valid", "This unsubscribe link is not valid. Use the link in your most recent email."));
      return null;
    }
    return p.data;
  };

  router.get("/style.css", (_req, res) => {
    res.type("css").setHeader("Cache-Control", "public, max-age=86400");
    res.send(CSS);
  });

  router.get("/", (req, res) => {
    const p = verify(req, res);
    if (!p) return;
    const action = `?c=${p.c}&amp;t=${p.t}`;
    res
      .type("html")
      .send(
        page(
          "Unsubscribe from news and offers",
          "You will still receive emails about your account, such as security codes and verification results.",
          `<form method="post" action="${action}"><button type="submit">Unsubscribe</button></form>`,
        ),
      );
  });

  router.post(
    "/",
    express.urlencoded({ extended: false, limit: "2kb" }),
    handler(async (req, res) => {
      const p = verify(req, res);
      if (!p) return;
      await transaction(db, async (conn) => {
        const client = await one<{ id: number; email: string; opted_out: Date | null }>(conn, "SELECT id, email, marketing_opt_out_at AS opted_out FROM clients WHERE id = ? FOR UPDATE", [p.c]);
        if (!client || client.opted_out) return;
        await exec(conn, "UPDATE clients SET marketing_opt_out_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [client.id]);
        await exec(conn, "UPDATE email_outbox SET status = 'cancelled', last_error = 'The client unsubscribed from news and offers.' WHERE client_id = ? AND category = 'marketing' AND status IN ('held', 'queued')", [client.id]);
        await writeAudit(conn, auditContext(req, clientActor(client)), { action: "client.marketing_unsubscribed", entityType: "client", entityId: client.id });
      });
      res.type("html").send(page("You are unsubscribed", "You will no longer receive news and offers. Emails about your account will still arrive."));
    }),
  );

  return router;
}
