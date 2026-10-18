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

let sessionLostHandler: (() => void) | null = null;
export const onSessionLost = (fn: (() => void) | null) => {
  sessionLostHandler = fn;
};

async function send<T>(method: string, url: string, body?: unknown, retried = false): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  // Files go up as raw bytes with their own type; everything else is JSON.
  const isFile = body instanceof Blob;
  const isForm = body instanceof FormData;
  if (body !== undefined && !isForm) headers["Content-Type"] = isFile ? body.type : "application/json";
  if (method !== "GET") headers["X-CSRF-Token"] = csrfToken;
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : isFile || isForm ? body : JSON.stringify(body), credentials: "same-origin" });
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

// KYC documents are only sent to requests carrying this header, which links, images and tabs cannot send.
const VIEWER = { "X-CRM-Viewer": "1" };

/**
 * Reads a file the staff API serves as raw bytes (KYC documents), with the same
 * session cookie and error handling as `api`, so the page can draw it itself.
 */
async function bytes(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url, { credentials: "same-origin", cache: "no-store", headers: VIEWER });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({})))?.error ?? {};
    if (res.status === 401) sessionLostHandler?.();
    throw new ApiError(res.status, err.code ?? "ERROR", err.message ?? "Could not open the file.", err.details);
  }
  const data = await res.arrayBuffer();
  // The server sends each KYC document's SHA-256. A browser extension that catches files can hand the
  // page an empty or changed copy, and that copy must not look like a damaged upload.
  const expected = res.headers.get("X-Document-SHA256");
  if (expected && globalThis.crypto?.subtle) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
    if (Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("") !== expected) throw new ApiError(0, "ALTERED", ALTERED);
  }
  return data;
}

const ALTERED =
  "The file did not reach this browser as the CRM sent it. A browser extension, such as a download manager, may have caught it. Turn that extension off for this site, or use a private window, then try again.";

/**
 * Saves a file the staff API sends as a download, asking for a 2FA code first
 * when the server wants a fresh one. The name comes from the server when given.
 */
async function saveFile(url: string, fallbackName: string, retried = false): Promise<void> {
  const res = await fetch(url, { credentials: "same-origin", cache: "no-store", headers: VIEWER });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({})))?.error ?? {};
    if (err.code === "STEP_UP_REQUIRED" && !retried && stepUpHandler && (await stepUpHandler())) return saveFile(url, fallbackName, true);
    if (res.status === 401) sessionLostHandler?.();
    throw new ApiError(res.status, err.code ?? "ERROR", err.message ?? "The file could not be downloaded.", err.details);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? fallbackName;
  const href = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

/**
 * A POST that still goes out while the tab is closing (keepalive), for letting
 * go of things the page holds. sendBeacon cannot carry the CSRF header.
 */
function sendOnExit(url: string, body: unknown = {}) {
  try {
    void fetch(url, {
      method: "POST",
      keepalive: true,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-CSRF-Token": csrfToken },
      body: JSON.stringify(body),
    }).catch(() => undefined);
  } catch {
    /* the page is going away anyway */
  }
}

export const api = {
  get: <T>(url: string) => send<T>("GET", url),
  bytes,
  saveFile,
  sendOnExit,
  post: <T>(url: string, body: unknown = {}) => send<T>("POST", url, body),
  patch: <T>(url: string, body: unknown) => send<T>("PATCH", url, body),
  put: <T>(url: string, body: unknown) => send<T>("PUT", url, body),
  del: <T>(url: string) => send<T>("DELETE", url),
  upload: <T>(url: string, file: Blob) => send<T>("PUT", url, file),
  /** Multipart form, for document uploads. */
  form: <T>(url: string, form: FormData) => send<T>("POST", url, form),
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
  staff: { id: number; email: string; name: string; avatarUrl: string | null; role: { id: number; slug: string; name: string }; mustChangePassword: boolean };
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
  avatarUrl: string | null;
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
