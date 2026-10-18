// Deposit and withdrawal wording shared by the server and the admin panel:
// the steps of each review, what a reviewer confirms at each step, and the
// ready-made reasons sent to the client.
//
// Rejection reasons are shown to the client exactly as written (the app as is,
// the portal for plain text), so they are short, plain and say what to do next.

export type DepositStatus = "pending" | "second_approval" | "approved" | "rejected";
export type WithdrawalStatus = "pending" | "second_approval" | "approved" | "paid" | "rejected";

export const DEPOSIT_STATUS_LABELS: Record<DepositStatus, string> = {
  pending: "Waiting for review",
  second_approval: "Waiting for second approval",
  approved: "Approved",
  rejected: "Rejected",
};

export const WITHDRAWAL_STATUS_LABELS: Record<WithdrawalStatus, string> = {
  pending: "Waiting for review",
  second_approval: "Waiting for second approval",
  approved: "Approved, waiting to be paid",
  paid: "Paid",
  rejected: "Rejected",
};

export interface ChecklistItem {
  key: string;
  label: string;
}

/** Every item must be ticked before the step can be completed. */
export const DEPOSIT_CHECKLIST: Record<"first" | "second", ChecklistItem[]> = {
  first: [
    { key: "found", label: "Found this payment in the bank statement or wallet history" },
    { key: "amount", label: "Entered the received amount exactly as the statement shows it" },
    { key: "sender", label: "The payment came from the client (the sender name matches their verified name)" },
    { key: "proof", label: "The screenshot matches the payment and shows no sign of editing" },
  ],
  second: [
    { key: "statement", label: "Checked this payment in the statement myself" },
    { key: "details", label: "The amount, sender and reference entered at the first approval are correct" },
  ],
};

export const WITHDRAWAL_CHECKLIST: Record<"first" | "second" | "pay", ChecklistItem[]> = {
  first: [
    { key: "funds", label: "The wallet balance comes from real deposits (nothing unexplained)" },
    { key: "owner", label: "The destination belongs to the client (their verified name on a bank account)" },
    { key: "loop", label: "The destination fits how the client deposited (same bank or wallet where possible)" },
    { key: "activity", label: "No recent security changes or unusual activity on the account" },
  ],
  second: [
    { key: "checked", label: "Checked the client, the destination and the first reviewer's findings myself" },
    { key: "correct", label: "The amount and the destination are correct" },
  ],
  pay: [
    { key: "sent", label: "Sent exactly this amount to exactly this destination" },
    { key: "reference", label: "Entered the payout reference from the bank or the wallet" },
  ],
};

/** Ready-made reasons. The reviewer can edit them before sending. */
export const DEPOSIT_REJECT_REASONS = [
  "We could not find this payment. If you have already paid, please contact support with your payment receipt.",
  "We only accept payments from an account in your own name. Please contact support so we can return this payment.",
  "The screenshot does not show a completed payment. Please send a new request with a screenshot of the finished transfer.",
  "The screenshot could not be read. Please send a new request with a clear screenshot of the payment.",
  "This payment was already added to your wallet with another request.",
  "This payment arrived through a different method. Please send a new request with the method you used.",
  "We cancelled this request as you asked.",
];

export const WITHDRAWAL_REJECT_REASONS = [
  "The receiving account is not in your verified name. Please add an account in your own name and request again.",
  "We could not send money to this account. Please check the account details and request again.",
  "Please withdraw to the account you deposited from, then request again.",
  "We need to complete a security check first. Please contact support.",
  "We cancelled this request as you asked. The money is back in your wallet.",
];

/** A reason or note written by staff: plain text only, as the portal shows reasons as written. */
export const NOT_PLAIN = /[<>{}`\\]|https?:|\bwww\./i;

/**
 * The app shows a deposit or withdrawal reason only up to this length, and replaces one that
 * looks like error text with a generic line, so reasons are kept within both.
 */
export const MONEY_REASON_MAX = 240;
const APP_HIDES = /stack trace|sqlstate|exception|\bat \S+\(/i;

/** Why the client would not see this reason as written, or null. */
export function moneyReasonProblem(reason: string): string | null {
  const text = reason.trim();
  if (text.length > MONEY_REASON_MAX) return `Keep the reason to ${MONEY_REASON_MAX} characters; the app shows no more.`;
  if (APP_HIDES.test(text)) return 'Reword the reason: the app hides reasons with words like "exception" or text like "at Bank(".';
  return null;
}
