import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { api } from "../lib/api";
import { useCan, useSession } from "../lib/session";

const NAV: { href: string; label: string; permission?: string; soon?: boolean }[] = [
  { href: "/", label: "Dashboard" },
  { href: "/clients", label: "Clients", permission: "client.view", soon: true },
  { href: "/kyc", label: "KYC", permission: "kyc.view", soon: true },
  { href: "/deposits", label: "Deposits", permission: "deposit.view", soon: true },
  { href: "/withdrawals", label: "Withdrawals", permission: "withdrawal.view", soon: true },
  { href: "/mt5", label: "MT5 accounts", permission: "mt5.view", soon: true },
  { href: "/ib", label: "IB system", permission: "ib.view", soon: true },
  { href: "/staff", label: "Staff", permission: "staff.view" },
  { href: "/roles", label: "Roles", permission: "role.view" },
  { href: "/audit", label: "Audit log", permission: "audit.view" },
];

export function Layout({ children, onSignedOut }: { children: ReactNode; onSignedOut: () => void }) {
  const session = useSession();
  const can = useCan();
  const [location] = useLocation();
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">BIS Markets CRM</div>
        <nav>
          {NAV.filter((n) => !n.permission || can(n.permission)).map((n) =>
            n.soon ? (
              <span key={n.href} className="nav-link nav-soon" title="Arrives in a later phase">
                {n.label}
              </span>
            ) : (
              <Link key={n.href} href={n.href} className={location === n.href || (n.href !== "/" && location.startsWith(n.href)) ? "nav-link active" : "nav-link"}>
                {n.label}
              </Link>
            ),
          )}
        </nav>
      </aside>
      <div className="main">
        <header className="topbar">
          <span className="muted">{session.staff.role.name}</span>
          <Link href="/account" className="topbar-user">
            {session.staff.name}
          </Link>
          <button
            type="button"
            className="button button-small"
            onClick={async () => {
              await api.post("/api/staff/auth/logout").catch(() => undefined);
              onSignedOut();
            }}
          >
            Sign out
          </button>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
