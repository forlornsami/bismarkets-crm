import { z } from "zod";
import { NOT_PLAIN, type ChecklistItem } from "@shared/money";
import { exec, one, type Conn } from "../lib/db";
import { badRequest } from "../lib/http";
import type { StaffContext } from "../staff/session";

// Pieces shared by the deposit and withdrawal review routes.

export const moneyId = z.coerce.number().int().positive();

const PLAIN_MESSAGE = "Write the reason as plain text, without links or symbols like < > { }";
/** A reason the client reads exactly as written. */
export const reasonText = z
  .string({ required_error: "Write a short reason for the client" })
  .trim()
  .min(5, "Write a short reason (at least 5 characters)")
  .max(500)
  .refine((v) => !NOT_PLAIN.test(v), PLAIN_MESSAGE);

/** A note for colleagues, kept on the item and in the audit log. The client never sees it. */
export const internalNote = z
  .string()
  .trim()
  .max(500, "Keep the internal note under 500 characters")
  .refine((v) => !NOT_PLAIN.test(v), "Write the note as plain text, without links or symbols like < > { }")
  .optional()
  .transform((v) => v || null);

/** The ticked checklist keys; every item must be ticked. */
export const checklistOf = (items: ChecklistItem[]) =>
  z
    .array(z.string().max(40))
    .max(20)
    .default([])
    .refine((ticked) => items.every((i) => ticked.includes(i.key)), "Tick every item on the checklist first")
    .transform(() => items.map((i) => i.key));

/** Clients this staff member may see: everyone with client.view_all, otherwise those assigned to them. */
export const clientScope = (staff: StaffContext, alias = "c") =>
  staff.permissions.has("client.view_all") ? { sql: "", params: [] as unknown[] } : { sql: ` AND ${alias}.assigned_staff_id = ?`, params: [staff.id] as unknown[] };

/** Whether the staff member may see this client (for naming other clients in warnings). */
export const inScope = (staff: StaffContext, assignedTo: number | null) => staff.permissions.has("client.view_all") || assignedTo === staff.id;

export type NoteStage = "first_approval" | "second_approval" | "returned" | "approved" | "paid" | "rejected";

/** Adds an internal note to a deposit or withdrawal (oldest first). */
export async function appendNote(conn: Conn, table: "deposits" | "withdrawals", id: number, staff: StaffContext, stage: NoteStage, text: string | null) {
  if (!text) return;
  const note = JSON.stringify({ at: new Date().toISOString(), by: staff.id, byName: staff.name, stage, text });
  await exec(conn, `UPDATE ${table} SET notes = JSON_ARRAY_APPEND(COALESCE(notes, JSON_ARRAY()), '$', CAST(? AS JSON)) WHERE id = ?`, [note, id]);
}

export const FROZEN_FOR_CLIENT = "Your account is frozen. Deposits, withdrawals and transfers are paused.";

/**
 * Why money cannot move for this client right now, worded for staff, or null.
 * Checked again inside every approval and payment, with the client row locked.
 */
export function staffMoneyBlock(client: { status: string; kyc_status: string }): string | null {
  if (client.status === "closed") return "This account is closed, so money cannot move. You can still reject.";
  if (client.status === "frozen") return "This account is frozen, so money cannot move until it is unfrozen. You can still reject.";
  if (client.kyc_status !== "approved") return "This client's KYC is not approved, so money cannot move. You can still reject.";
  return null;
}

export async function assertMoneyCanMove(conn: Conn, clientId: number) {
  const c = await one<{ status: string; kyc_status: string }>(conn, "SELECT status, kyc_status FROM clients WHERE id = ?", [clientId]);
  const block = c ? staffMoneyBlock(c) : "This client no longer exists.";
  if (block) throw badRequest(block);
}

/** "ending 4821" for an account number or address, for client-facing text. */
export const endingOf = (account: string) => {
  const tail = account.replace(/\s+/g, "").slice(-4);
  return tail ? `ending ${tail}` : "";
};

/** Masks all but the last four characters, for staff who may not see full payout details. */
export const masked = (value: string | null | undefined) => {
  if (!value) return value ?? null;
  const compact = value.replace(/\s+/g, "");
  return compact.length <= 4 ? "••••" : `••••${compact.slice(-4)}`;
};
