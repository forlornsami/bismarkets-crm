import { randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { exec, rows, type Db } from "./db";

/** Networks whose deposit address clients can scan: their wallets read a bare address. */
export const QR_NETWORKS: ReadonlySet<string> = new Set(["trc20", "bep20"]);

/**
 * The QR code clients scan to pay a crypto deposit method, drawn by the CRM from the method's own
 * wallet address. Nothing a person uploads is shown to clients, so the picture cannot hold a second
 * code, a payment link to another address, or anything but the address reviewers check deposits against.
 */
export function addressQr(address: string): Promise<Buffer> {
  return QRCode.toBuffer(address, { type: "png", errorCorrectionLevel: "M", margin: 4, width: 480 });
}

/**
 * Makes every deposit method's QR code the CRM's own drawing of its current address, and removes
 * QR codes where none belongs (as left by an earlier build that took uploaded pictures). A redrawn
 * code gets a new link. Run after migrating; returns the methods it changed.
 */
export async function syncDepositQrs(db: Db): Promise<number[]> {
  const methods = await rows<{ id: number; direction: string; kind: string; network: string | null; wallet_address: string | null; qr_bytes: Buffer | null; qr_token: string | null }>(
    db,
    "SELECT id, direction, kind, network, wallet_address, qr_bytes, qr_token FROM payment_methods",
  );
  const changed: number[] = [];
  for (const m of methods) {
    const drawn = m.direction === "deposit" && m.kind === "crypto" && QR_NETWORKS.has(m.network ?? "") && m.wallet_address ? await addressQr(m.wallet_address) : null;
    if (drawn ? m.qr_token !== null && m.qr_bytes?.equals(drawn) : m.qr_bytes === null && m.qr_token === null) continue;
    await exec(db, "UPDATE payment_methods SET qr_mime = ?, qr_bytes = ?, qr_token = ? WHERE id = ? AND wallet_address <=> ?", [
      drawn ? "image/png" : null, drawn, drawn ? randomBytes(16).toString("hex") : null, m.id, m.wallet_address,
    ]);
    changed.push(m.id);
  }
  return changed;
}
