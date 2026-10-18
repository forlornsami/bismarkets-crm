import { one, type Conn } from "../lib/db";
import { toMajor } from "../money/amounts";
import { defaultLeverage, type Mt5Settings } from "./settings";

// Account packages: what a client chooses when opening a real account. Each
// opens accounts in one MT5 group on one server; clients never see either.

export interface PackageRow {
  id: number;
  name: string;
  description: string;
  highlights: unknown;
  spread_label: string;
  commission_label: string | null;
  min_deposit_cents: number;
  server_code: string;
  mt5_group: string;
  is_recommended: number;
  is_visible: number;
  sort_order: number;
  created_at: Date;
  updated_at: Date;
  updated_by: number | null;
}

export const SELECT_PACKAGE = `SELECT p.id, p.name, p.description, p.highlights, p.spread_label, p.commission_label, p.min_deposit_cents, p.server_code, p.mt5_group,
  p.is_recommended, p.is_visible, p.sort_order, p.created_at, p.updated_at, p.updated_by
  FROM account_packages p`;

export const packageFromDb = <T extends PackageRow>(p: T): T => ({ ...p, id: Number(p.id), min_deposit_cents: Number(p.min_deposit_cents) });

/** The highlight lines, as stored JSON (text or parsed): non-empty strings only, as the portal refuses anything else. */
export function highlightsOf(p: Pick<PackageRow, "highlights">): string[] {
  let value = p.highlights;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value.filter((h): h is string => typeof h === "string" && h.trim() !== "") : [];
}

/** A package a client may open an account with now. `lock` holds it while the account row is written. */
export async function visiblePackage(conn: Conn, id: number, lock = false): Promise<PackageRow | undefined> {
  const p = await one<PackageRow>(conn, `${SELECT_PACKAGE} WHERE p.id = ? AND p.is_visible = 1${lock ? " FOR SHARE" : ""}`, [id]);
  return p && packageFromDb(p);
}

/**
 * One row of GET /api/account-packages, as both front ends parse it. The
 * portal refuses the whole list for an empty commission or highlight, so
 * those become null and are left out. One currency field only: the two
 * clients read currency fields in different orders.
 */
export const presentClientPackage = (p: PackageRow, settings: Pick<Mt5Settings, "leverages">) => ({
  id: p.id,
  name: p.name,
  description: p.description,
  min_deposit: toMajor(p.min_deposit_cents),
  spread: p.spread_label,
  commission: p.commission_label?.trim() ? p.commission_label : null,
  highlights: highlightsOf(p),
  currency_type: "usd",
  recommended: p.is_recommended === 1,
  leverage: String(defaultLeverage(settings)),
});
