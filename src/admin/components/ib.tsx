import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Badge, reviewTone } from "./ui";

// The IB pieces other screens use (the sidebar badge, the dashboard and the
// client page), kept apart from the IB screens so those load only when opened.

export type IbStatus = "pending" | "approved" | "rejected" | "removed";

export interface IbSummary {
  pending: number;
  overdue: number;
  oldestPendingAt: string | null;
  decidedToday: number;
  decidedTodayByMe: number;
  /** What Start reviewing would hand this person now. */
  forMe: number;
}

export const useIbSummary = (enabled = true) =>
  useQuery({ queryKey: ["ib-summary"], queryFn: () => api.get<IbSummary>("/api/staff/ib/applications/summary"), enabled, refetchInterval: 60_000 });

const IB_STATUS: Record<IbStatus, { label: string; tone: ReturnType<typeof reviewTone> }> = {
  pending: { label: "Waiting for review", tone: reviewTone("waiting") },
  approved: { label: "Approved", tone: reviewTone("done") },
  rejected: { label: "Rejected", tone: reviewTone("refused") },
  removed: { label: "IB status removed", tone: reviewTone("closed") },
};

/** Where an IB application stands. */
export const IbStatusBadge = ({ status }: { status: IbStatus }) => <Badge tone={IB_STATUS[status]?.tone ?? "neutral"}>{IB_STATUS[status]?.label ?? status}</Badge>;

/** Whether a client is an IB partner now. */
export const PartnerBadge = ({ status }: { status: "active" | "removed" }) =>
  status === "active" ? <Badge tone={reviewTone("done")}>Active IB</Badge> : <Badge tone={reviewTone("closed")}>IB status removed</Badge>;

/** USD amounts the IB endpoints send as dollars. */
export const usdText = (dollars: number | null | undefined) =>
  dollars === null || dollars === undefined ? "–" : `USD ${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(dollars)}`;
