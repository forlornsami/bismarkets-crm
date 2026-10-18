import { one, rows, type Conn } from "../lib/db";

// The single row of MT5 rules (mt5_settings) and the servers the CRM knows.
// Amounts are US cents.

export interface Mt5Settings {
  demoServerCode: string | null;
  demoGroup: string | null;
  /** The leverages clients may choose, in the order staff listed them (2000 is 1:2000). */
  leverages: number[];
  maxLiveAccounts: number;
  maxDemoAccounts: number;
  demoMaxOpeningCents: number;
  demoMaxTopupCents: number;
  demoMaxBalanceCents: number;
  maxTransferCents: number;
  /** Staff balance and credit changes at or under this run at once; above it (and always when 0) they need a second person. */
  adjustSecondApprovalCents: number;
  updatedAt: Date;
  updatedBy: number | null;
}

interface SettingsRow {
  demo_server_code: string | null;
  demo_group: string | null;
  leverages: string;
  max_live_accounts: number;
  max_demo_accounts: number;
  demo_max_opening_cents: number;
  demo_max_topup_cents: number;
  demo_max_balance_cents: number;
  max_transfer_cents: number;
  adjust_second_approval_cents: number;
  updated_at: Date;
  updated_by: number | null;
}

/** "100, 500,2000" → [100, 500, 2000]; anything that is not a positive whole number is left out. */
export const parseLeverages = (text: string) =>
  [...new Set(text.split(",").map((s) => s.trim()).filter((s) => /^\d{1,5}$/.test(s)).map(Number).filter((n) => n > 0))];

/**
 * Reads the settings. `lock` "share" holds them while an account is opened
 * against them; "update" before staff change them.
 */
export async function loadMt5Settings(conn: Conn, lock?: "share" | "update"): Promise<Mt5Settings> {
  const r = await one<SettingsRow>(
    conn,
    `SELECT demo_server_code, demo_group, leverages, max_live_accounts, max_demo_accounts, demo_max_opening_cents, demo_max_topup_cents,
       demo_max_balance_cents, max_transfer_cents, adjust_second_approval_cents, updated_at, updated_by
     FROM mt5_settings WHERE id = 1${lock === "share" ? " FOR SHARE" : lock === "update" ? " FOR UPDATE" : ""}`,
  );
  if (!r) throw new Error("mt5_settings is missing its row; run the migrations.");
  return {
    demoServerCode: r.demo_server_code,
    demoGroup: r.demo_group,
    leverages: parseLeverages(r.leverages),
    maxLiveAccounts: Number(r.max_live_accounts),
    maxDemoAccounts: Number(r.max_demo_accounts),
    demoMaxOpeningCents: Number(r.demo_max_opening_cents),
    demoMaxTopupCents: Number(r.demo_max_topup_cents),
    demoMaxBalanceCents: Number(r.demo_max_balance_cents),
    maxTransferCents: Number(r.max_transfer_cents),
    adjustSecondApprovalCents: Number(r.adjust_second_approval_cents),
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

/** The leverage a package card shows: 1:2000 when offered (both clients assume it), else the highest one offered. */
export const defaultLeverage = (s: Pick<Mt5Settings, "leverages">) => (s.leverages.includes(2000) ? 2000 : Math.max(0, ...s.leverages));

/**
 * "2000", 2000 or "1:2000" as the portal and app send a leverage, or null.
 * Whether it is offered is a separate check against the settings.
 */
export function parseLeverage(value: unknown): number | null {
  const text = typeof value === "number" && Number.isInteger(value) ? String(value) : typeof value === "string" ? value.trim() : "";
  const match = /^(?:1:)?(\d{1,5})$/.exec(text);
  const n = match ? Number(match[1]) : 0;
  return n > 0 ? n : null;
}

export interface ServerRow {
  code: string;
  label: string;
  is_enabled: number;
  created_at: Date;
  updated_at: Date;
  updated_by: number | null;
}

/** Whether MT5 work may run on this server now: it exists and staff have not switched it off. */
export async function serverEnabled(conn: Conn, code: string | null | undefined): Promise<boolean> {
  if (!code) return false;
  const row = await one<{ is_enabled: number }>(conn, "SELECT is_enabled FROM mt5_servers WHERE code = ?", [code]);
  return row?.is_enabled === 1;
}

/** The codes of every enabled server. */
export const enabledServers = async (conn: Conn) =>
  new Set((await rows<{ code: string }>(conn, "SELECT code FROM mt5_servers WHERE is_enabled = 1")).map((r) => r.code));
