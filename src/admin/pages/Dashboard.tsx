import { useQuery } from "@tanstack/react-query";
import { ArrowDownToLine, ArrowRight, ArrowUpFromLine, BadgeCheck, Check, Clock, KeyRound, Network, ShieldCheck, Users, UserCog, Wallet } from "lucide-react";
import { Link } from "wouter";
import { PageHeader } from "../components/ui";
import { api, type Page, type StaffMember } from "../lib/api";
import { useCan, useSession } from "../lib/session";

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
};

const UPCOMING = [
  { icon: BadgeCheck, label: "KYC review", phase: "Phase 2" },
  { icon: ArrowDownToLine, label: "Deposits", phase: "Phase 3" },
  { icon: ArrowUpFromLine, label: "Withdrawals", phase: "Phase 3" },
  { icon: Wallet, label: "MT5 accounts", phase: "Phase 3" },
  { icon: Network, label: "IB partners", phase: "Phase 4" },
];

const useStaffCount = (filter: string, enabled: boolean) =>
  useQuery({
    queryKey: ["dashboard-staff", filter],
    queryFn: () => api.get<Page<StaffMember>>(`/api/staff/users?pageSize=1${filter}`).then((p) => p.total),
    enabled,
  });

export function Dashboard() {
  const session = useSession();
  const can = useCan();
  const total = useStaffCount("", can("staff.view"));
  const active = useStaffCount("&status=active", can("staff.view"));
  const pending2fa = useStaffCount("&twoFactor=pending&status=active", can("staff.view"));
  const audit = useQuery({
    queryKey: ["dashboard-audit"],
    queryFn: () => api.get<Page<unknown>>("/api/staff/audit?pageSize=1").then((p) => p.total),
    enabled: can("audit.view"),
  });
  const clients = useQuery({
    queryKey: ["clients-summary"],
    queryFn: () => api.get<{ total: number; newThisWeek: number; newToday: number }>("/api/staff/clients/summary"),
    enabled: can("client.view"),
  });
  const show = (n: number | undefined) => (n === undefined ? "–" : n.toLocaleString());

  return (
    <>
      <PageHeader title={`${greeting()}, ${session.staff.name.split(" ")[0]}`} description="Here is how the CRM looks today. Client, money, MT5 and IB modules switch on as each build phase ships." />
      {(can("staff.view") || can("client.view")) && (
        <div className="tiles">
          {can("client.view") && (
            <Link href="/clients" className="tile tile-button">
              <span className="tile-icon">
                <Users size={20} />
              </span>
              <div>
                <div className="tile-label">Clients</div>
                <div className="tile-value">{show(clients.data?.total)}</div>
                <div className="tile-foot">{show(clients.data?.newThisWeek)} new this week</div>
              </div>
            </Link>
          )}
          {can("staff.view") && (
            <>
          <div className="tile">
            <span className="tile-icon">
              <UserCog size={20} />
            </span>
            <div>
              <div className="tile-label">Staff accounts</div>
              <div className="tile-value">{show(total.data)}</div>
              <div className="tile-foot">{show(active.data)} active</div>
            </div>
          </div>
          <div className="tile">
            <span className={pending2fa.data ? "tile-icon warn" : "tile-icon good"}>
              <ShieldCheck size={20} />
            </span>
            <div>
              <div className="tile-label">Active staff without 2FA</div>
              <div className="tile-value">{show(pending2fa.data)}</div>
              <div className="tile-foot">{pending2fa.data ? "They set it up at first sign-in" : "Everyone is protected"}</div>
            </div>
          </div>
            </>
          )}
          {can("audit.view") && (
            <div className="tile">
              <span className="tile-icon info">
                <Clock size={20} />
              </span>
              <div>
                <div className="tile-label">Audit log entries</div>
                <div className="tile-value">{show(audit.data)}</div>
                <div className="tile-foot">Hash-chained, cannot be edited</div>
              </div>
            </div>
          )}
        </div>
      )}
      <div className="columns">
        <section className="panel">
          <div className="card-head">
            <div>
              <h2>Security checklist</h2>
              <p>What protects the back office right now.</p>
            </div>
          </div>
          <ul className="check-list">
            {[
              ["Two-factor sign-in is required", "Every staff account must use an authenticator app."],
              ["Sensitive actions ask for a fresh code", "Resets, role changes and exports need 2FA again."],
              ["Sessions expire automatically", "After 15 idle minutes or 8 hours in total."],
              ["Every action is audited", "The log is chained, so any edit would be detected."],
            ].map(([title, text]) => (
              <li key={title}>
                <span className="state ok">
                  <Check size={14} />
                </span>
                <span>
                  <strong>{title}</strong>
                  <span className="muted">{text}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
        <section className="panel">
          <div className="card-head">
            <div>
              <h2>Coming next</h2>
              <p>Modules in the next build phases.</p>
            </div>
          </div>
          <div className="module-grid">
            {UPCOMING.map(({ icon: Icon, label, phase }) => (
              <div key={label} className="module">
                <Icon size={18} />
                <span>
                  {label}
                  <small>{phase}</small>
                </span>
              </div>
            ))}
          </div>
          <div className="actions actions-split">
            <Link href="/account" className="button button-ghost">
              <KeyRound size={16} /> My account
            </Link>
            {can("staff.view") && (
              <Link href="/staff" className="button">
                Manage staff <ArrowRight size={16} />
              </Link>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
