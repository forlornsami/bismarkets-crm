import {
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowUpFromLine,
  BadgeCheck,
  ChevronsLeft,
  CreditCard,
  ChevronsRight,
  LayoutDashboard,
  LogOut,
  Menu,
  Network,
  Package,
  Palette,
  ScrollText,
  ServerCog,
  Shield,
  UserCog,
  UserRound,
  Users,
  FileText,
  Mail,
  MailCheck,
  AtSign,
  Send,
  Wallet,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { Avatar, ThemeSwitch } from "../components/ui";
import { api } from "../lib/api";
import { useLogo } from "../lib/branding";
import { useCan, useSession } from "../lib/session";
import { useDepositsForMe, useWithdrawalsForMe } from "../components/money";
import { useKycSummary } from "./Kyc";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  permission?: string;
  /** Shown when the staff member holds any one of these. */
  anyOf?: string[];
  soon?: boolean;
  badge?: "kyc" | "deposits" | "withdrawals";
}

const NAV: { title: string; items: NavItem[] }[] = [
  { title: "Overview", items: [{ href: "/", label: "Dashboard", icon: LayoutDashboard }] },
  {
    title: "Clients",
    items: [
      { href: "/clients", label: "Clients", icon: Users, permission: "client.view" },
      { href: "/kyc", label: "KYC review", icon: BadgeCheck, permission: "kyc.view", badge: "kyc" },
    ],
  },
  {
    title: "Money",
    items: [
      { href: "/deposits", label: "Deposits", icon: ArrowDownToLine, permission: "deposit.view", badge: "deposits" },
      { href: "/withdrawals", label: "Withdrawals", icon: ArrowUpFromLine, permission: "withdrawal.view", badge: "withdrawals" },
      { href: "/transfers", label: "Transfers", icon: ArrowLeftRight, permission: "wallet.view" },
    ],
  },
  {
    title: "Trading",
    items: [
      { href: "/mt5", label: "MT5 accounts", icon: Wallet, permission: "mt5.view" },
      { href: "/packages", label: "Account packages", icon: Package, permission: "package.view" },
      { href: "/ib", label: "IB partners", icon: Network, permission: "ib.view", soon: true },
    ],
  },
  {
    title: "Communication",
    items: [
      { href: "/messages/new", label: "Send email", icon: Send, permission: "comms.send" },
      { href: "/messages", label: "Sent emails", icon: MailCheck, permission: "comms.view" },
      { href: "/messages/templates", label: "Email templates", icon: FileText, permission: "comms.view" },
      { href: "/emails", label: "Email outbox", icon: Mail, permission: "comms.view" },
    ],
  },
  {
    title: "Administration",
    items: [
      { href: "/staff", label: "Staff", icon: UserCog, permission: "staff.view" },
      { href: "/roles", label: "Roles", icon: Shield, permission: "role.view" },
      { href: "/audit", label: "Audit log", icon: ScrollText, permission: "audit.view" },
      { href: "/payment-methods", label: "Payment methods", icon: CreditCard, anyOf: ["payment.manage", "deposit.view", "withdrawal.view"] },
      { href: "/settings/mt5", label: "MT5 settings", icon: ServerCog, anyOf: ["mt5.view", "mt5.servers"] },
      { href: "/settings/email", label: "Email settings", icon: AtSign, permission: "settings.view" },
      { href: "/settings/branding", label: "Branding", icon: Palette, permission: "settings.view" },
    ],
  },
];

const ALL_ITEMS = NAV.flatMap((s) => s.items);
const isActive = (href: string, location: string) => location === href || (href !== "/" && location.startsWith(`${href}/`));

function readCollapsed() {
  try {
    return localStorage.getItem("bis-crm-sidebar") === "collapsed";
  } catch {
    return false;
  }
}

export function Layout({ children, onSignedOut }: { children: ReactNode; onSignedOut: () => void }) {
  const can = useCan();
  const kycWaiting = useKycSummary(can("kyc.view")).data?.pending ?? 0;
  // Money badges count only what this staff member can act on.
  const depositsForMe = useDepositsForMe();
  const withdrawalsForMe = useWithdrawalsForMe();
  const counts: Record<NonNullable<NavItem["badge"]>, { n: number; title: string }> = {
    kyc: { n: kycWaiting, title: "waiting for review" },
    deposits: { n: depositsForMe, title: "deposits waiting for you" },
    withdrawals: { n: withdrawalsForMe, title: "withdrawals waiting for you" },
  };
  const [location] = useLocation();
  const logo = useLogo();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => setNavOpen(false), [location]);
  // On phones the open menu covers the page: Escape closes it and the page behind does not scroll.
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setNavOpen(false);
    document.addEventListener("keydown", onKey);
    document.body.classList.add("no-scroll");
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("no-scroll");
    };
  }, [navOpen]);

  const toggleCollapsed = () => {
    setCollapsed(!collapsed);
    try {
      localStorage.setItem("bis-crm-sidebar", collapsed ? "open" : "collapsed");
    } catch {
      // Only a convenience.
    }
  };

  // The most specific match wins, so /messages/new lights up "Send email" rather than "Sent emails".
  const current = ALL_ITEMS.filter((i) => isActive(i.href, location)).sort((a, b) => b.href.length - a.href.length)[0] ?? (location.startsWith("/account") ? { label: "My account" } : null);
  const section = NAV.find((s) => s.items.some((i) => i === current));

  return (
    <div className={`shell${collapsed ? " collapsed" : ""}${navOpen ? " nav-open" : ""}`}>
      <aside className="sidebar" aria-label="Main navigation">
        <div className="sidebar-head">
          <Link href="/" aria-label="Dashboard">
            <img className="sidebar-logo" src={logo} alt="BIS CRM" />
            <img className="sidebar-mark" src="/brand/mark.png" alt="BIS CRM" />
          </Link>
          <button type="button" className="icon-button menu-close" aria-label="Close menu" onClick={() => setNavOpen(false)}>
            <X size={20} />
          </button>
        </div>
        <nav className="sidebar-nav">
          {NAV.map((s) => {
            const items = s.items.filter((n) => (!n.permission || can(n.permission)) && (!n.anyOf || n.anyOf.some((p) => can(p))));
            if (items.length === 0) return null;
            return (
              <div key={s.title} className="nav-section">
                <div className="nav-section-title">{s.title}</div>
                {items.map((n) => {
                  const Icon = n.icon;
                  return n.soon ? (
                    <span key={n.href} className="nav-link nav-soon" title={`${n.label} arrives in a later phase`}>
                      <Icon size={18} />
                      <span className="nav-label">{n.label}</span>
                      <span className="nav-pill">Soon</span>
                    </span>
                  ) : (
                    <Link key={n.href} href={n.href} className={n === current ? "nav-link active" : "nav-link"} title={collapsed ? n.label : undefined} aria-current={n === current ? "page" : undefined}>
                      <Icon size={18} />
                      <span className="nav-label">{n.label}</span>
                      {n.badge && counts[n.badge].n > 0 && (
                        <span className="nav-count" title={`${counts[n.badge].n} ${counts[n.badge].title}`}>
                          {counts[n.badge].n > 99 ? "99+" : counts[n.badge].n}
                        </span>
                      )}
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          <button type="button" className="nav-link collapse-button" onClick={toggleCollapsed}>
            {collapsed ? <ChevronsRight size={18} /> : <ChevronsLeft size={18} />}
            <span className="nav-label">Collapse menu</span>
          </button>
        </div>
      </aside>
      <div className="scrim" onClick={() => setNavOpen(false)} aria-hidden />
      <div className="main">
        <header className="topbar">
          <button type="button" className="icon-button menu-button" aria-label="Open menu" onClick={() => setNavOpen(true)}>
            <Menu size={20} />
          </button>
          <div className="topbar-title">
            {section && section.title !== "Overview" && <span className="crumb">{section.title} /</span>}
            <span>{current?.label ?? ""}</span>
          </div>
          <div className="topbar-spacer" />
          <span className="topbar-theme">
            <ThemeSwitch />
          </span>
          <UserMenu onSignedOut={onSignedOut} />
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}

function UserMenu({ onSignedOut }: { onSignedOut: () => void }) {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [location] = useLocation();
  useEffect(() => setOpen(false), [location]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  return (
    <div className="user-menu" ref={ref}>
      <button type="button" className="user-trigger" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Avatar name={session.staff.name} src={session.staff.avatarUrl} />
        <span className="user-meta">
          <span className="user-name">{session.staff.name}</span>
          <span className="user-role">{session.staff.role.name}</span>
        </span>
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-head">
            <div className="user-name">{session.staff.name}</div>
            <div className="user-role">{session.staff.email}</div>
          </div>
          <Link href="/account" className="menu-item" role="menuitem">
            <UserRound size={16} /> My account
          </Link>
          <div className="menu-theme">
            <span>Theme</span>
            <ThemeSwitch />
          </div>
          <div className="menu-sep" />
          <button
            type="button"
            className="menu-item danger"
            role="menuitem"
            onClick={async () => {
              await api.post("/api/staff/auth/logout").catch(() => undefined);
              onSignedOut();
            }}
          >
            <LogOut size={16} /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}
