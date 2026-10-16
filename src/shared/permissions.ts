// The permission catalog. Every staff API route names one of these; the
// server checks it on every request, and the admin panel only uses it to hide
// what the server would refuse anyway.
//
// Modules that later phases build are listed now so roles are complete from
// the start and nobody has to re-grant permissions when a module ships.

export const PERMISSION_GROUPS = {
  staff: {
    label: "Staff and roles",
    permissions: {
      "staff.view": "View staff accounts",
      "staff.create": "Create staff accounts",
      "staff.edit": "Edit staff details, role and scope",
      "staff.disable": "Disable or re-enable staff accounts",
      "staff.security": "Reset staff 2FA and revoke staff sessions",
      "role.view": "View roles and permissions",
      "role.manage": "Create, edit and delete roles",
    },
  },
  audit: {
    label: "Audit log",
    permissions: {
      "audit.view": "View the audit log",
      "audit.verify": "Verify the audit log hash chain",
      "audit.export": "Export the audit log",
    },
  },
  clients: {
    label: "Clients",
    permissions: {
      "client.view": "View client profiles",
      "client.view_all": "View clients outside your own assignment",
      "client.create": "Create clients",
      "client.edit": "Edit client profiles",
      "client.status": "Freeze, unfreeze or close client accounts",
      "client.assign": "Assign clients to agents",
      "client.notes": "Add notes and tasks to clients",
      "client.pii.reveal": "Reveal masked personal data",
      "client.export": "Export client lists",
      "client.portal_password": "Send client password resets",
      "client.impersonate": "Log in to the client portal as a client (view only)",
    },
  },
  kyc: {
    label: "KYC",
    permissions: {
      "kyc.view": "View KYC submissions and documents",
      "kyc.decide": "Approve or reject KYC",
      "kyc.settings": "Manage KYC document types and tiers",
    },
  },
  compliance: {
    label: "Compliance and AML",
    permissions: {
      "aml.view": "View AML alerts and risk scores",
      "aml.decide": "Resolve AML alerts and cases",
      "aml.freeze": "Freeze funds for compliance review",
    },
  },
  deposits: {
    label: "Deposits",
    permissions: {
      "deposit.view": "View deposits",
      "deposit.process": "Approve deposits up to the limit",
      "deposit.approve_large": "Approve deposits above the limit",
      "deposit.reject": "Reject deposits",
    },
  },
  withdrawals: {
    label: "Withdrawals",
    permissions: {
      "withdrawal.view": "View withdrawals",
      "withdrawal.process": "Process withdrawals up to the limit",
      "withdrawal.approve": "Give the second approval on withdrawals",
      "withdrawal.reject": "Reject withdrawals",
      "withdrawal.pay": "Mark withdrawals as paid",
    },
  },
  wallet: {
    label: "Wallet and transfers",
    permissions: {
      "wallet.view": "View wallets, ledger and transfers",
      "wallet.adjust": "Make manual wallet adjustments",
      "wallet.reconcile": "Run and review reconciliation",
    },
  },
  mt5: {
    label: "MT5 accounts",
    permissions: {
      "mt5.view": "View MT5 accounts",
      "mt5.create": "Open MT5 accounts",
      "mt5.edit": "Change leverage, group and trading rights",
      "mt5.password": "Reset MT5 passwords",
      "mt5.balance.adjust": "Make MT5 balance and credit operations",
      "mt5.servers": "Manage MT5 server connections",
    },
  },
  packages: {
    label: "Account packages",
    permissions: {
      "package.view": "View account packages",
      "package.manage": "Create and edit account packages",
    },
  },
  ib: {
    label: "IB system",
    permissions: {
      "ib.view": "View IBs, hierarchy and commissions",
      "ib.decide": "Approve or reject IB applications",
      "ib.edit": "Edit IB hierarchy and client links",
      "ib.plan.edit": "Edit IB commission plans",
      "ib.payout": "Approve IB payouts",
    },
  },
  risk: {
    label: "Risk and dealing",
    permissions: {
      "risk.view": "View exposure and trading reports",
      "risk.manage": "Tag accounts and manage risk settings",
    },
  },
  bonuses: {
    label: "Bonuses and promotions",
    permissions: {
      "bonus.view": "View bonuses and promotions",
      "bonus.manage": "Create and grant bonuses",
    },
  },
  reports: {
    label: "Reports",
    permissions: {
      "report.view": "View reports and dashboards",
      "report.finance": "View financial reports",
      "report.export": "Export reports",
    },
  },
  communication: {
    label: "Communication",
    permissions: {
      "comms.view": "View message templates and history",
      "comms.send": "Send messages to clients",
      "comms.templates": "Edit message templates",
    },
  },
  settings: {
    label: "Settings",
    permissions: {
      "settings.view": "View system settings",
      "settings.manage": "Change system settings",
      "payment.manage": "Manage payment methods and gateways",
    },
  },
} as const;

type Groups = typeof PERMISSION_GROUPS;
export type Permission = {
  [G in keyof Groups]: keyof Groups[G]["permissions"];
}[keyof Groups] & string;

export const ALL_PERMISSIONS: readonly Permission[] = Object.values(PERMISSION_GROUPS).flatMap(
  (group) => Object.keys(group.permissions) as Permission[],
);

export function isPermission(value: string): value is Permission {
  return (ALL_PERMISSIONS as readonly string[]).includes(value);
}

export interface DefaultRole {
  slug: string;
  name: string;
  description: string;
  permissions: readonly Permission[] | "all";
}

const viewOnly = ALL_PERMISSIONS.filter(
  (p) => p.endsWith(".view") || p === "audit.verify" || p === "client.view_all",
);

// System roles are seeded by `cli seed-roles`. Super Admin always holds every
// permission and cannot be edited; the others can be adjusted by a Super Admin.
export const DEFAULT_ROLES: readonly DefaultRole[] = [
  {
    slug: "super_admin",
    name: "Super Admin",
    description: "Everything, including roles, security and MT5 configuration.",
    permissions: "all",
  },
  {
    slug: "admin",
    name: "Admin",
    description: "Runs the brokerage day to day; cannot change roles or MT5 server credentials.",
    permissions: ALL_PERMISSIONS.filter((p) => !["role.manage", "mt5.servers", "settings.manage", "audit.export"].includes(p)),
  },
  {
    slug: "compliance",
    name: "Compliance Officer",
    description: "KYC and AML decisions, risk scores and account freezes.",
    permissions: [
      "client.view", "client.view_all", "client.status", "client.notes", "client.pii.reveal",
      "kyc.view", "kyc.decide", "kyc.settings", "aml.view", "aml.decide", "aml.freeze",
      "deposit.view", "withdrawal.view", "wallet.view", "mt5.view", "ib.view", "audit.view", "report.view",
    ],
  },
  {
    slug: "finance_manager",
    name: "Finance Manager",
    description: "Second approval on money movements and payment method management.",
    permissions: [
      "client.view", "client.view_all", "kyc.view",
      "deposit.view", "deposit.process", "deposit.approve_large", "deposit.reject",
      "withdrawal.view", "withdrawal.process", "withdrawal.approve", "withdrawal.reject", "withdrawal.pay",
      "wallet.view", "wallet.adjust", "wallet.reconcile", "mt5.view", "ib.view", "ib.payout",
      "report.view", "report.finance", "report.export", "payment.manage", "audit.view",
    ],
  },
  {
    slug: "finance_agent",
    name: "Finance Agent",
    description: "Processes deposits and withdrawals up to the approval limit.",
    permissions: [
      "client.view", "client.view_all", "kyc.view",
      "deposit.view", "deposit.process", "deposit.reject",
      "withdrawal.view", "withdrawal.process", "withdrawal.reject", "wallet.view", "mt5.view",
    ],
  },
  {
    slug: "dealing",
    name: "Dealing / Risk",
    description: "MT5 groups, leverage, exposure and trading reports. Cannot move client money.",
    permissions: [
      "client.view", "client.view_all", "mt5.view", "mt5.create", "mt5.edit", "mt5.password",
      "package.view", "package.manage", "risk.view", "risk.manage", "report.view", "ib.view",
    ],
  },
  {
    slug: "sales_manager",
    name: "Sales Manager",
    description: "Leads and clients for the whole sales team, and conversion reports.",
    permissions: [
      "client.view", "client.view_all", "client.create", "client.edit", "client.assign", "client.notes",
      "kyc.view", "deposit.view", "mt5.view", "ib.view", "report.view", "comms.view", "comms.send",
    ],
  },
  {
    slug: "sales_agent",
    name: "Sales Agent",
    description: "Their own assigned leads and clients only.",
    permissions: ["client.view", "client.create", "client.edit", "client.notes", "kyc.view", "deposit.view", "mt5.view"],
  },
  {
    slug: "support_agent",
    name: "Support Agent",
    description: "Client profiles and password resets; no money, KYC or MT5 changes.",
    permissions: ["client.view", "client.view_all", "client.notes", "client.portal_password", "kyc.view", "mt5.view", "deposit.view", "withdrawal.view"],
  },
  {
    slug: "auditor",
    name: "Read-only Auditor",
    description: "Sees everything, including the audit log, and changes nothing.",
    permissions: viewOnly,
  },
];

export const SUPER_ADMIN_SLUG = "super_admin";
