import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Badge, reviewTone } from "./ui";

// The KYC pieces other screens use (the sidebar badge, client pages, the other
// review queues), kept apart from the KYC review screens so those can load
// only when they are opened.

export type Category = "identity" | "address";

export interface KycSubmission {
  id: number;
  client: { id: number; name: string; email: string; country: string | null; pictureUrl: string | null; avatarUrl?: string | null; status?: string };
  category: Category;
  categoryLabel: string;
  documentType: string;
  status: "pending" | "approved" | "rejected" | "withdrawn";
  rejectReason: string | null;
  submittedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  documents: number;
  source: "client" | "staff";
  uploadedBy: string | null;
  staffNote: string | null;
  claimedBy: { id: number; name: string | null; until: string } | null;
  /** Warnings the queue can tell without opening the submission. */
  warningCount?: number;
}

export interface KycSummary {
  pending: number;
  overdue: number;
  oldestPendingAt: string | null;
  decidedToday: number;
  decidedTodayByMe: number;
  /** What Start reviewing would hand this reviewer now (leaves out their own uploads and items colleagues hold). */
  forMe?: number;
  forMeByCategory?: Record<Category, number>;
}

export const WHAT: Record<Category, string> = { identity: "proof of identity", address: "proof of address" };
export const CATEGORY_LABEL: Record<Category, string> = { identity: "Identity", address: "Proof of address" };

export const useKycSummary = (enabled = true) =>
  useQuery({ queryKey: ["kyc-summary"], queryFn: () => api.get<KycSummary>("/api/staff/kyc/summary"), enabled, refetchInterval: 60_000 });

export function KycStatusBadge({ status }: { status: KycSubmission["status"] | "none" | "partial" }) {
  if (status === "approved") return <Badge tone={reviewTone("done")}>Approved</Badge>;
  // One document of the two is approved: the other is still to do.
  if (status === "partial") return <Badge tone={reviewTone("later")}>Partly verified</Badge>;
  if (status === "rejected") return <Badge tone={reviewTone("refused")}>Rejected</Badge>;
  if (status === "pending") return <Badge tone={reviewTone("waiting")}>Waiting for review</Badge>;
  if (status === "withdrawn") return <Badge tone={reviewTone("closed")}>Taken back by client</Badge>;
  return <Badge tone="neutral">Not submitted</Badge>;
}
