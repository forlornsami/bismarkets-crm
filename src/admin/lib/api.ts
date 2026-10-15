// Thin client for the staff API. The CSRF token lives only in memory; the
// session itself is an HttpOnly cookie the page can never read.

let csrfToken = "";
export const setCsrf = (token: string) => {
  csrfToken = token;
};

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: { field: string; message: string }[],
  ) {
    super(message);
  }
}

type StepUpHandler = () => Promise<boolean>;
let stepUpHandler: StepUpHandler | null = null;
/** Registered by the step-up dialog; resolves true once the user has confirmed with a code. */
export const onStepUpRequired = (fn: StepUpHandler | null) => {
  stepUpHandler = fn;
};

/** Asks for a 2FA code directly, for requests that do not go through `api` (such as file downloads). */
export const requestStepUp = async () => (stepUpHandler ? stepUpHandler() : false);

let sessionLostHandler: (() => void) | null = null;
export const onSessionLost = (fn: (() => void) | null) => {
  sessionLostHandler = fn;
};

async function send<T>(method: string, url: string, body?: unknown, retried = false): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET") headers["X-CSRF-Token"] = csrfToken;
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin" });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = data?.error ?? {};
    const error = new ApiError(res.status, err.code ?? "ERROR", err.message ?? "Something went wrong.", err.details);
    if (error.code === "STEP_UP_REQUIRED" && !retried && stepUpHandler && (await stepUpHandler())) {
      return send<T>(method, url, body, true);
    }
    if (res.status === 401 && !url.startsWith("/api/staff/auth/")) sessionLostHandler?.();
    throw error;
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => send<T>("GET", url),
  post: <T>(url: string, body: unknown = {}) => send<T>("POST", url, body),
  patch: <T>(url: string, body: unknown) => send<T>("PATCH", url, body),
  del: <T>(url: string) => send<T>("DELETE", url),
};

export const qs = (params: Record<string, string | number | undefined | null>) => {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") search.set(k, String(v));
  const s = search.toString();
  return s ? `?${s}` : "";
};

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  pages: number;
}

export interface SessionInfo {
  staff: { id: number; email: string; name: string; role: { id: number; slug: string; name: string }; mustChangePassword: boolean };
  permissions: string[];
  csrfToken: string;
  expiresAt: string;
  stepUpUntil: string | null;
}

export interface StaffMember {
  id: number;
  email: string;
  name: string;
  status: "active" | "disabled";
  role: { id: number; slug: string; name: string };
  twoFactorEnabled: boolean;
  mustChangePassword: boolean;
  lockedUntil: string | null;
  scope: { countries: string[]; desks: string[] };
  lastLoginAt: string | null;
  lastLoginIp: string | null;
  createdAt: string;
  activeSessions?: number;
}

export interface Role {
  id: number;
  slug: string;
  name: string;
  description: string;
  isSystem: boolean;
  editable: boolean;
  permissions: string[];
  staffCount: number;
}

export interface AuditItem {
  id: number;
  occurredAt: string;
  actor: { type: string; id: number | null; label: string };
  action: string;
  entity: { type: string; id: string };
  ip: string;
  userAgent: string;
  before: unknown;
  after: unknown;
  meta: unknown;
  hash: string;
}

export const formatDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Never";
