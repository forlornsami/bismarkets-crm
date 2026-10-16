import type { Request, Response } from "express";
import { sha256 } from "./crypto";
import { exec, one, type Conn } from "./db";
import { badRequest, notFound } from "./http";
import { imageInfo } from "./images";

export type PictureOwner = "staff" | "client";

export const PICTURE_MAX_BYTES = 1024 * 1024;
export const PICTURE_TYPES = ["image/png", "image/jpeg", "image/webp"];

/** A versioned URL: the hash changes whenever the picture does, so browsers can cache it for good. */
export const pictureVersion = (hash: string | null | undefined) => (hash ? hash.slice(0, 16) : null);

export const staffAvatarUrl = (staffId: number, hash: string | null | undefined) =>
  hash ? `/api/staff/users/${staffId}/avatar?v=${pictureVersion(hash)}` : null;

/** Validates an uploaded picture by its bytes and stores it. Returns the new hash. */
export async function savePicture(conn: Conn, owner: PictureOwner, ownerId: number, req: Request) {
  const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (bytes.length === 0) throw badRequest("Upload a PNG, JPEG or WebP image.");
  const info = imageInfo(bytes);
  if (!info || info.type !== req.get("content-type")?.split(";")[0]?.trim()) throw badRequest("This file is not a valid PNG, JPEG or WebP image.");
  if (info.width < 32 || info.height < 32) throw badRequest("The picture must be at least 32 pixels on each side.");
  if (info.width > 4096 || info.height > 4096) throw badRequest("The picture can be at most 4096 pixels on each side.");
  const hash = sha256(bytes);
  await exec(
    conn,
    `INSERT INTO profile_pictures (owner_type, owner_id, mime, bytes, sha256, width, height) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE mime = VALUES(mime), bytes = VALUES(bytes), sha256 = VALUES(sha256), width = VALUES(width), height = VALUES(height)`,
    [owner, ownerId, info.type, bytes, hash, info.width, info.height],
  );
  return { sha256: hash, width: info.width, height: info.height, bytes: bytes.length, type: info.type };
}

export async function deletePicture(conn: Conn, owner: PictureOwner, ownerId: number) {
  const result = await exec(conn, "DELETE FROM profile_pictures WHERE owner_type = ? AND owner_id = ?", [owner, ownerId]);
  return result.affectedRows > 0;
}

/** Sends a stored picture with headers that stop it ever running as a page. */
export async function sendPicture(conn: Conn, owner: PictureOwner, ownerId: number, req: Request, res: Response) {
  const row = await one<{ mime: string; bytes: Buffer; sha256: string }>(conn, "SELECT mime, bytes, sha256 FROM profile_pictures WHERE owner_type = ? AND owner_id = ?", [owner, ownerId]);
  if (!row) throw notFound();
  const versioned = req.query.v === pictureVersion(row.sha256);
  res.setHeader("Cache-Control", versioned ? "private, max-age=31536000, immutable" : "private, no-cache");
  res.setHeader("ETag", `"${row.sha256}"`);
  res.setHeader("Content-Type", row.mime);
  res.setHeader("Content-Disposition", "inline");
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  if (req.get("if-none-match") === `"${row.sha256}"`) return void res.status(304).end();
  res.send(row.bytes);
}
