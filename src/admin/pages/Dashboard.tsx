import { useQuery } from "@tanstack/react-query";
import { api, type Page, type StaffMember } from "../lib/api";
import { useCan, useSession } from "../lib/session";

export function Dashboard() {
  const session = useSession();
  const can = useCan();
  const staff = useQuery({
    queryKey: ["dashboard-staff"],
    queryFn: () => api.get<Page<StaffMember>>("/api/staff/users?pageSize=1"),
    enabled: can("staff.view"),
  });
  const pending2fa = useQuery({
    queryKey: ["dashboard-2fa"],
    queryFn: () => api.get<Page<StaffMember>>("/api/staff/users?pageSize=1&twoFactor=pending&status=active"),
    enabled: can("staff.view"),
  });
  return (
    <>
      <h1>Welcome, {session.staff.name}</h1>
      <p className="muted">Client, KYC, money, MT5 and IB modules arrive in the next phases of the build.</p>
      {can("staff.view") && (
        <div className="tiles">
          <div className="tile">
            <span className="tile-label">Staff accounts</span>
            <span className="tile-value">{staff.data?.total ?? "–"}</span>
          </div>
          <div className="tile">
            <span className="tile-label">Active staff without 2FA yet</span>
            <span className="tile-value">{pending2fa.data?.total ?? "–"}</span>
          </div>
        </div>
      )}
    </>
  );
}
