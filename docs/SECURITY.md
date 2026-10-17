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
- `GET /api/user` never carries staff flags for a client's own session, so the
  support service treats it as a customer. A staff "view as client" session
  returns `impersonation`, `read_only` and `is_staff: true`, so the portal can
  show a view-only banner and the support service refuses it (staff cannot
  chat as the client).
- Signed-in devices: `GET /api/sessions` lists the client's own sign-ins (not
  staff views), identified by the same 32-character `session_id` support sees.
  `DELETE /api/sessions/{id}` and `DELETE /api/sessions` (all others) revoke
  them, are audited and tell support so the app signs out too.
- Notifications: `GET /api/notifications`, `POST /api/notifications/{id}/read`,
  `POST /api/notifications/mark-all-read`. Rows are written in the same
  transaction as the change (KYC decisions, password and email changes,
  account restrictions) and are scoped to the signed-in client.
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

## Support service events

KYC decisions, account close and reopen, and every client sign-out are sent to
bismarkets-support (`POST /api/client-notifications/events/crm`) so the app gets
push notifications and devices are signed out.

- Events are written to `webhook_outbox` in the same transaction as the change,
  so nothing is sent for a change that rolled back, and nothing is lost if
  support is down.
- Each request is signed `v1=` HMAC-SHA256 over timestamp, method, path, event
  id and body with `CRM_SUPPORT_EVENTS_SECRET`, which must match support's
  `CLIENT_NOTIFICATION_CRM_SECRET` and be at least 32 characters. Redirects are
  refused.
- Failures retry with backoff (30 seconds up to 6 hours, 12 tries). A 4xx other
  than 408 or 429 is a permanent failure and is logged.
- With `CRM_SUPPORT_EVENTS_URL` unset, events are queued and sent once it is set.

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
- A decision can be changed later (`POST /api/staff/kyc/:id/change`): a rejected document approved, or an approved one rejected. It needs `kyc.decide`, a fresh 2FA code and a reason, works only on the client's latest submission, and is audited as `kyc.decision_changed` with the old and new status. A rejection reason is shown to the client; an approval reason stays in the audit log.
- Staff with `kyc.upload` (Super Admin, Admin, Compliance) can upload documents for a client (`POST /api/staff/kyc/upload`), with 2FA and a note on where they came from. The files get the same checks and encryption as client uploads, the submission is marked as uploaded by that staff member, and it goes to the review queue. Four eyes: the uploader cannot approve their own upload unless they hold `kyc.override`.
- Approving without documents (`POST /api/staff/kyc/approve-without-documents`) needs `kyc.override` (Super Admin and Admin), 2FA and a reason, and is audited as `kyc.approved_without_documents`. Approving any document-less item later also needs `kyc.override`.
- "Ask for a new document" withdraws an approval (needs `kyc.decide` and 2FA, latest submission only). It is audited as `kyc.new_document_requested`, the client is emailed and notified, and their KYC goes back to rejected so they can upload again.
- Review claims: opening a pending item holds it for 15 minutes (refreshed while open), so two reviewers never decide the same item. A decision is refused while someone else holds it; taking over a review is audited as `kyc.review_taken_over`.
- Approving needs every checklist item ticked; the ticked checklist is stored with the decision and in the audit entry.
- The review screen flags under-18 dates of birth, the same file uploaded by another client, identical front and back, profile edits made after the upload, unverified email and non-active accounts.
