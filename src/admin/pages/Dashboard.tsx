import { useQuery } from "@tanstack/react-query";
import { ArrowDownToLine, ArrowRight, ArrowUpFromLine, BadgeCheck, Check, Clock, Handshake, KeyRound, Mail, Network, Scale, ShieldCheck, UserPlus, Users, UserCog } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "wouter";
import { PageHeader } from "../components/ui";
import { useIbSummary } from "../components/ib";
import { useKycSummary } from "../components/kyc";
import { useDepositsForMe, useDepositSummary, useWithdrawalsForMe, useWithdrawalSummary } from "../components/money";
import { api, formatDate, type Page, type StaffMember } from "../lib/api";
import { useReconSummary, type ReconSummary } from "../lib/mt5";
import { useCan, useSession } from "../lib/session";

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
};

const UPCOMING = [{ icon: Network, label: "IB commissions and wallet", phase: "Phase 4, round B" }];

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
  const kyc = useKycSummary(can("kyc.view"));
  const deposits = useDepositSummary(can("deposit.view"));
  const withdrawals = useWithdrawalSummary(can("withdrawal.view"));
  const ib = useIbSummary(can("ib.view"));
  const depositsForMe = useDepositsForMe();
  const withdrawalsForMe = useWithdrawalsForMe();
  const d = deposits.data;
  const w = withdrawals.data;
  const queues = can("kyc.view") || can("deposit.view") || can("withdrawal.view") || can("ib.view");
  const reconciles = can("wallet.reconcile") || can("wallet.view");
  const recon = useReconSummary(reconciles);
  const critical = recon.data?.open.critical;
  const show = (n: number | undefined) => (n === undefined ? "–" : n.toLocaleString());

  return (
    <>
      <PageHeader title={`${greeting()}, ${session.staff.name.split(" ")[0]}`} description="What needs attention today, and shortcuts to the work you do most." />
      <QuickActions />
      {(can("staff.view") || can("client.view") || queues || reconciles) && (
        <div className="tiles">
          {can("kyc.view") && (
            <QueueTile
              href="/kyc"
              icon={<BadgeCheck size={20} />}
              label="KYC waiting for review"
              waiting={kyc.data?.pending}
              forMe={can("kyc.decide", "kyc.documents") ? (kyc.data?.forMe ?? kyc.data?.pending) : undefined}
              error={kyc.error}
            />
          )}
          {can("deposit.view") && (
            <QueueTile
              href="/deposits"
              icon={<ArrowDownToLine size={20} />}
              label="Deposits waiting"
              waiting={d ? d.pending + d.secondApproval : undefined}
              forMe={can("deposit.process") || can("deposit.approve_large") ? depositsForMe : undefined}
              error={deposits.error}
            />
          )}
          {can("withdrawal.view") && (
            <QueueTile
              href="/withdrawals"
              icon={<ArrowUpFromLine size={20} />}
              label="Withdrawals waiting"
              waiting={w ? w.review + w.secondApproval + w.toPay : undefined}
              forMe={can("withdrawal.process") || can("withdrawal.approve") || can("withdrawal.pay") ? withdrawalsForMe : undefined}
              error={withdrawals.error}
            />
          )}
          {can("ib.view") && (
            <QueueTile
              href="/ib"
              icon={<Handshake size={20} />}
              label="IB applications waiting"
              waiting={ib.data?.pending}
              forMe={can("ib.decide") ? ib.data?.forMe : undefined}
              error={ib.error}
            />
          )}
          {reconciles && (
            <Link href="/reconciliation?severity=critical" className="tile tile-button">
              <span className={critical === undefined ? "tile-icon" : critical ? "tile-icon bad" : "tile-icon good"}>
                <Scale size={20} />
              </span>
              <div>
                <div className="tile-label">Open critical MT5 issues</div>
                <div className="tile-value">{show(critical)}</div>
                <div className="tile-foot">{recon.error ? "Could not load" : reconFoot(recon.data)}</div>
              </div>
            </Link>
          )}
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

/** One approval queue on the dashboard: how many items wait, and how many of them are for this person. */
function QueueTile({ href, icon, label, waiting, forMe, error }: { href: string; icon: ReactNode; label: string; waiting: number | undefined; forMe: number | undefined; error: unknown }) {
  const foot = error
    ? "Could not load"
    : waiting === undefined
      ? "Checking the queue"
      : !waiting
        ? "Nothing waiting"
        : forMe === undefined
          ? "Open the queue to look"
          : forMe
            ? `${forMe.toLocaleString()} waiting for you`
            : "None waiting for you";
  return (
    <Link href={href} className="tile tile-button">
      <span className={waiting === undefined ? "tile-icon" : waiting ? "tile-icon warn" : "tile-icon good"}>{icon}</span>
      <div>
        <div className="tile-label">{label}</div>
        <div className="tile-value">{waiting === undefined ? "–" : waiting.toLocaleString()}</div>
        <div className="tile-foot">{foot}</div>
      </div>
    </Link>
  );
}

/** Under the open critical count: what to do, or when MT5 was last checked against the CRM. */
function reconFoot(s: ReconSummary | undefined) {
  if (!s) return "Checking";
  if (s.open.critical) return "MT5 and the CRM disagree: open the list";
  if (s.running) return "A reconciliation run is going now";
  if (!s.lastRun?.finishedAt) return "No reconciliation run yet";
  return s.lastRun.status === "failed" ? "The last reconciliation run failed" : `Last checked ${formatDate(s.lastRun.finishedAt)}`;
}

/** The everyday jobs, one tap away (big buttons, so they work on a phone too). */
function QuickActions() {
  const can = useCan();
  const items = [
    can("kyc.view") && { href: "/kyc", icon: BadgeCheck, label: "Review KYC" },
    can("deposit.view") && { href: "/deposits", icon: ArrowDownToLine, label: "Review deposits" },
    can("withdrawal.view") && { href: "/withdrawals", icon: ArrowUpFromLine, label: "Review withdrawals" },
    can("ib.view") && { href: "/ib", icon: Handshake, label: "Review IB applications" },
    can("client.view") && { href: "/clients", icon: Users, label: "Find a client" },
    can("client.create") && { href: "/clients?new=1", icon: UserPlus, label: "Add a client" },
    can("comms.send") && { href: "/messages/new", icon: Mail, label: "Send an email" },
  ].filter(Boolean) as { href: string; icon: typeof Users; label: string }[];
  if (!items.length) return null;
  return (
    <nav className="quick-actions" aria-label="Quick actions">
      {items.map(({ href, icon: Icon, label }) => (
        <Link key={href} href={href} className="quick-action">
          <Icon size={18} />
          <span>{label}</span>
        </Link>
      ))}
    </nav>
  );
}
