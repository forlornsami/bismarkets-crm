import express, { Router } from "express";
import { z } from "zod";
import type { AppDeps } from "../../app";
import { auditContext, writeAudit } from "../../lib/audit";
import { sha256 } from "../../lib/crypto";
import { exec, one, rows, transaction } from "../../lib/db";
import { badRequest, handler, notFound, parse } from "../../lib/http";
import { imageInfo } from "../../lib/images";
import { requirePermission, requireStepUp, staffActor, staffOf, staffSession } from "../../staff/session";

export const BRANDING_SLOTS = ["logo_light", "logo_dark", "favicon"] as const;
type Slot = (typeof BRANDING_SLOTS)[number];

const MAX_BYTES = 1024 * 1024;

// Built-in defaults shipped with the admin panel (src/admin/public/brand).
const DEFAULTS: Record<Slot, string> = {
  logo_light: "/brand/logo-light.png",
  logo_dark: "/brand/logo-dark.png",
  favicon: "/brand/favicon.png",
};

const LIMITS: Record<Slot, { minWidth: number; maxSide: number; label: string }> = {
  logo_light: { minWidth: 120, maxSide: 6000, label: "Logos" },
  logo_dark: { minWidth: 120, maxSide: 6000, label: "Logos" },
  favicon: { minWidth: 16, maxSide: 1024, label: "The browser icon" },
};

const slotParam = z.enum(BRANDING_SLOTS);

interface AssetRow {
  slot: Slot;
  mime: string;
  sha256: string;
  width: number;
  height: number;
  updated_at: Date;
}

const assetUrl = (row: Pick<AssetRow, "slot" | "sha256">) => `/api/staff/branding/files/${row.slot}?v=${row.sha256.slice(0, 16)}`;

/**
 * Logos and the browser icon. Reading is open to anyone who can reach the
 * staff panel (the sign-in page shows the logo); changing them needs
 * `settings.manage` and a fresh 2FA code, and every change is audited.
 */
export function staffBrandingRouter(deps: AppDeps): Router {
  const { db, config } = deps;
  const router = Router();
  const session = staffSession(db, config);
  const stepUp = requireStepUp(config);

  router.get(
    "/",
    handler(async (_req, res) => {
      const custom = await rows<AssetRow>(db, "SELECT slot, mime, sha256, width, height, updated_at FROM branding_assets");
      const bySlot = new Map(custom.map((r) => [r.slot, r]));
      const describe = (slot: Slot) => {
        const row = bySlot.get(slot);
        return row
          ? { url: assetUrl(row), custom: true, width: row.width, height: row.height, updatedAt: row.updated_at.toISOString() }
          : { url: DEFAULTS[slot], custom: false, width: null, height: null, updatedAt: null };
      };
      res.json({ logoLight: describe("logo_light"), logoDark: describe("logo_dark"), favicon: describe("favicon") });
    }),
  );

  router.get(
    "/files/:slot",
    handler(async (req, res) => {
      const slot = parse(slotParam, req.params.slot);
      const row = await one<{ mime: string; bytes: Buffer; sha256: string }>(db, "SELECT mime, bytes, sha256 FROM branding_assets WHERE slot = ?", [slot]);
      if (!row) throw notFound();
      // The URL carries the content hash, so a matching copy never changes.
      const versioned = req.query.v === row.sha256.slice(0, 16);
      res.setHeader("Cache-Control", versioned ? "private, max-age=31536000, immutable" : "no-cache");
      res.setHeader("ETag", `"${row.sha256}"`);
      res.setHeader("Content-Type", row.mime);
      res.setHeader("Content-Disposition", "inline");
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      if (req.get("if-none-match") === `"${row.sha256}"`) return res.status(304).end();
      res.send(row.bytes);
    }),
  );

  router.put(
    "/:slot",
    session,
    requirePermission("settings.manage"),
    stepUp,
    express.raw({ type: ["image/png", "image/jpeg", "image/webp"], limit: MAX_BYTES }),
    handler(async (req, res) => {
      const actor = staffOf(req);
      const slot = parse(slotParam, req.params.slot);
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (bytes.length === 0) throw badRequest("Upload a PNG, JPEG or WebP image.");
      const info = imageInfo(bytes);
      if (!info || info.type !== req.get("content-type")?.split(";")[0]?.trim()) throw badRequest("This file is not a valid PNG, JPEG or WebP image.");
      const limit = LIMITS[slot];
      if (info.width < limit.minWidth) throw badRequest(`${limit.label} must be at least ${limit.minWidth} pixels wide.`);
      if (info.width > limit.maxSide || info.height > limit.maxSide) throw badRequest(`${limit.label} can be at most ${limit.maxSide} pixels on each side.`);
      const hash = sha256(bytes);
      await transaction(db, async (conn) => {
        const before = await one<{ sha256: string }>(conn, "SELECT sha256 FROM branding_assets WHERE slot = ? FOR UPDATE", [slot]);
        await exec(
          conn,
          `INSERT INTO branding_assets (slot, mime, bytes, sha256, width, height, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE mime = VALUES(mime), bytes = VALUES(bytes), sha256 = VALUES(sha256),
             width = VALUES(width), height = VALUES(height), updated_by = VALUES(updated_by)`,
          [slot, info.type, bytes, hash, info.width, info.height, actor.id],
        );
        await writeAudit(conn, auditContext(req, staffActor(actor)), {
          action: "branding.updated", entityType: "branding", entityId: slot,
          before: before ? { sha256: before.sha256 } : { default: true },
          after: { sha256: hash, type: info.type, width: info.width, height: info.height, bytes: bytes.length },
        });
      });
      res.json({ url: assetUrl({ slot, sha256: hash }), custom: true, width: info.width, height: info.height });
    }),
  );

  router.delete(
    "/:slot",
    session,
    requirePermission("settings.manage"),
    stepUp,
    handler(async (req, res) => {
      const actor = staffOf(req);
      const slot = parse(slotParam, req.params.slot);
      await transaction(db, async (conn) => {
        const before = await one<{ sha256: string }>(conn, "SELECT sha256 FROM branding_assets WHERE slot = ? FOR UPDATE", [slot]);
        if (!before) return;
        await exec(conn, "DELETE FROM branding_assets WHERE slot = ?", [slot]);
        await writeAudit(conn, auditContext(req, staffActor(actor)), {
          action: "branding.reset", entityType: "branding", entityId: slot, before: { sha256: before.sha256 }, after: { default: true },
        });
      });
      res.status(204).end();
    }),
  );

  return router;
}
