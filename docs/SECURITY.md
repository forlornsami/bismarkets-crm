# Security model (Phase 1)

What protects the staff side of the CRM today. Later phases add client-side
and money controls on top of the same foundations.

## Who can reach it

- The staff panel and staff API answer only to IPs in `CRM_STAFF_ALLOWED_IPS`.
  Everyone else gets a plain 404, as if nothing were there. Production refuses
  to start without this list.
- Client IPs come from `X-Forwarded-For` only when the request arrives through
  a proxy listed in `CRM_TRUSTED_PROXIES`, so nobody can fake their address.
- State-changing requests must come from `CRM_STAFF_ORIGIN` and carry a CSRF
  token derived from the session (HMAC), on top of a `SameSite=Strict` cookie.

## Signing in

- Email and password, then a 6-digit code from an authenticator app. 2FA is
  mandatory: a new account enrolls on its first sign-in and cannot skip it.
- A code can be used only once (replay is refused), with one step of clock drift.
- Five wrong passwords lock the account for 15 minutes. Unknown emails and wrong
  passwords get the same answer and take the same time.
- Rate limits per IP and per email on sign-in, codes and password changes.
- New staff get a random temporary password shown once to the admin who created
  them, and must set their own before doing anything else.
- Passwords: Argon2id, at least 12 characters, checked against known breaches
  (Have I Been Pwned range API: only 5 characters of the hash leave the server).

## Sessions

- Random 256-bit token in an HttpOnly, Secure, `SameSite=Strict`, `__Host-` cookie.
  The database stores only its SHA-256.
- Ends after 15 minutes idle or 8 hours in total, on sign-out, on password
  change (other sessions), and whenever an admin disables the account, resets
  its 2FA or password, or signs it out everywhere.

## Permissions

- About 80 permissions in 16 groups, ten built-in roles, custom roles allowed.
- Every staff route checks its permission on the server. The panel hides what a
  role cannot do, but hiding is never the protection.
- Nobody can grant permissions they do not hold, edit their own role, change
  their own role, or touch a Super Admin unless they are one. The last active
  Super Admin cannot be disabled or demoted.
- Sensitive actions need a fresh 2FA code (valid 5 minutes): disabling staff,
  resetting 2FA or passwords, signing people out, editing roles, exporting the
  audit log.

## Audit log

- Every sign-in, failure, lockout, 2FA event and staff or role change is
  written in the same database transaction as the change itself.
- Rows record who, what, when, from which IP and device, and before/after values.
- MySQL triggers refuse any UPDATE or DELETE on the log.
- Each row's SHA-256 covers the previous row's hash, so editing, inserting or
  removing a row breaks the chain. "Verify chain" in the panel, or
  `cli verify-audit` from a cron job, re-checks it from the first entry.

## Data protection

- 2FA secrets are encrypted with AES-256-GCM under `CRM_DATA_KEY`, bound to the
  staff id so a secret cannot be moved to another account.
- Logs never contain cookies, auth headers, request bodies or query strings.
- Strict security headers: a CSP allowing only the CRM's own scripts and styles,
  no framing, HSTS, no referrer.
- API responses are never cached, except uploaded logos, whose URLs carry their
  content hash.

## Branding uploads

- Logos and the browser icon can be changed under Branding by roles with
  `settings.manage`, after a fresh 2FA code. Every change and reset is audited.
- Only PNG, JPEG and WebP up to 1 MB are accepted. The type is read from the
  file's own bytes and must match what the browser declared; SVG is refused
  because it can carry scripts.
- Files are stored in MySQL and served with `Content-Security-Policy:
  default-src 'none'; sandbox`, `nosniff` and `inline`, so a file can never run
  as a page.

## Client portal API (Phase 2)

The portal and app call the same `/api/*` paths as the old CRM, with Bearer
tokens and Laravel-style errors (`{ message, errors }`), so they work unchanged.

- Browsers may call it only from `CRM_CLIENT_ORIGINS` (CORS). There are no
  cookies, so there is nothing for another site to ride on.
- Tokens are random 256-bit values stored only as SHA-256 digests. Sessions end
  after `CRM_CLIENT_IDLE_DAYS` idle or `CRM_CLIENT_SESSION_DAYS` in total, on
  logout, on a password reset, and when staff close the account.
- Sign-up needs a 6-digit email code. Codes are stored as HMACs, expire after
  10 minutes, die after 5 wrong guesses, and a new code cancels the old one.
- Passwords: Argon2id, 8+ characters with upper, lower, digit and symbol, plus
  the breach check. Five wrong passwords lock the account; rate limits per IP
  and per email answer with `429` and `Retry-After`.
- `GET /api/user` never carries staff flags, so the support service keeps
  treating every token it sees as a customer.
- Profile pictures are checked by content (PNG, JPEG, WebP only) and served
  from an unguessable URL that includes part of the image hash.
- Set `CRM_CLIENT_ORIGINS` to every portal address (for local testing, add
  `http://localhost:5173`) and `CRM_PUBLIC_URL` to the address the portal
  reaches the CRM on, since picture links are built from it.

## Staff access to clients

- Staff without `client.view_all` see only the clients assigned to them.
- Phone, address, postcode and date of birth are masked everywhere. Showing them
  needs `client.pii.reveal` and writes an audit entry each time.
- The audit log records old and new values for names, email, country and city;
  for personal data it records only which fields changed.
- Freezing, closing or reactivating needs `client.status`, a reason and a fresh
  2FA code. Changing a client's sign-in email needs a fresh code and tells the
  old address.

## Log in as client

- Needs `client.impersonate` (Super Admin by default), a fresh 2FA code and a
  written reason. The reason, the staff member and the expiry go in the audit
  log and show on the client's page.
- It creates a separate session that lasts `CRM_IMPERSONATION_MINUTES` and is
  **view-only**: every change (profile, picture, email, codes) is refused.
- The link opens the portal's existing `/impersonate?token=` page, which shows
  who you are about to view and removes the token from the address bar.

## Email outbox

No mail provider is connected yet, so every email is held in the outbox. The
readable copy has codes and links blanked; the full text is stored encrypted.
On a non-production server the outbox shows the full text so sign-up can be
tested end to end. Production shows only the blanked copy.

## KYC documents

- Clients upload identity (ID card front and back, passport, or driving licence) and proof of address through `POST /api/kyc`, the same call the portal and app already make. Staff "view as client" sessions cannot upload, and frozen or closed accounts cannot either.
- Each file is checked by its bytes, not its name or declared type: only JPEG, PNG, WebP, HEIC and PDF, up to 10 MB each. Uploads are rate limited per client.
- Files are encrypted at rest (AES-256-GCM with the data key, bound to the submission and slot), stored with their SHA-256 hash, and never served back to the client. The client API only returns statuses and rejection reasons.
- Staff need `kyc.view` to see the queue, scoped to their assigned clients unless they also have `client.view_all`. Opening a submission and every document view are written to the audit log. Documents are served with `no-store` and a sandboxing CSP; PDFs and HEIC files download instead of rendering in the CRM.
- Approving or rejecting needs `kyc.decide` and a fresh 2FA code. A rejection needs a reason, which the client sees and is emailed. The client can resubmit only after a rejection.
- Not yet wired: the KYC webhook to bismarkets-support. It comes with the webhook work in a later phase.
