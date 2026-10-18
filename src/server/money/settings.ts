import { one, type Conn } from "../lib/db";

/** The single row of money limits and rates (money_settings). Amounts are US cents. */
export interface MoneySettings {
  min_deposit_cents: number;
  min_withdrawal_cents: number;
  max_withdrawal_cents: number | null;
  min_transfer_cents: number;
  /** DECIMAL as text, e.g. "280.000000". */
  usd_to_pkr: string;
  /** Who last set usd_to_pkr: their first approval of a deposit at that rate is not enough alone. */
  usd_to_pkr_set_by: number | null;
  deposit_second_approval_cents: number;
  withdrawal_second_approval_cents: number;
  first_withdrawal_second_approval: boolean;
  updated_at: Date;
  updated_by: number | null;
}

/** Reads the settings; `lock` takes a share lock so a decision and a settings change cannot interleave. */
export async function loadMoneySettings(conn: Conn, lock = false): Promise<MoneySettings> {
  const r = await one<Omit<MoneySettings, "first_withdrawal_second_approval" | "usd_to_pkr"> & { first_withdrawal_second_approval: number; usd_to_pkr: string | number }>(
    conn,
    `SELECT min_deposit_cents, min_withdrawal_cents, max_withdrawal_cents, min_transfer_cents, usd_to_pkr, usd_to_pkr_set_by, deposit_second_approval_cents,
       withdrawal_second_approval_cents, first_withdrawal_second_approval, updated_at, updated_by
     FROM money_settings WHERE id = 1${lock ? " FOR SHARE" : ""}`,
  );
  if (!r) throw new Error("money_settings is missing its row; run the migrations.");
  return {
    ...r,
    min_deposit_cents: Number(r.min_deposit_cents),
    min_withdrawal_cents: Number(r.min_withdrawal_cents),
    max_withdrawal_cents: r.max_withdrawal_cents === null ? null : Number(r.max_withdrawal_cents),
    min_transfer_cents: Number(r.min_transfer_cents),
    usd_to_pkr: String(r.usd_to_pkr),
    deposit_second_approval_cents: Number(r.deposit_second_approval_cents),
    withdrawal_second_approval_cents: Number(r.withdrawal_second_approval_cents),
    first_withdrawal_second_approval: r.first_withdrawal_second_approval === 1,
  };
}
