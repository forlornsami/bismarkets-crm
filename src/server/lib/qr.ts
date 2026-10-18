import QRCode from "qrcode";

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
