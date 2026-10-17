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
- Nobody can take over an account with more power than their own: changing
  another person's details, role, status, password, 2FA, sessions or picture
  needs every permission of that person's role.
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
tokens and Laravel-style errors (`{ message, errors }`). The Android app works
unchanged. The web portal needs the version built for this CRM
(bismarkets-client-portal PR #2): older builds hide field errors and KYC
rejection reasons behind generic text, so it must go live before or with the
cutover.

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
  needs `client.pii.reveal` and writes an audit entry each time. The one
  exception is the KYC review screen, which needs `kyc.documents` and is
  audited per view (see "KYC documents").
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
- Exactly one event per KYC decision: `kyc.approved` when the client becomes
  fully verified, `kyc.rejected` when their overall status becomes rejected,
  otherwise the document's own `kyc.identity.*` or `kyc.address.*` event.
- The sender claims due rows with a short lease in its own transaction, sends
  outside any transaction and records each answer on its own, so no database
  lock is held while support answers and a row is never sent twice at once.
- Failures retry with backoff (30 seconds up to 6 hours, 12 tries). A 4xx other
  than 408 or 429 is a permanent failure and is logged; `401` and `422` are
  logged as configuration errors (secret, environment name or server clock).
- KYC events older than 24 hours are not sent (marked failed, `expired`), so a
  backlog never turns into stale pushes. Account and sign-out events are always
  sent.
- With `CRM_SUPPORT_EVENTS_URL` unset, events are queued and sent once it is set.

## Email

**Mail provider.** Settings > Email holds the SMTP server. Reading it needs
`settings.view`; saving, sending a test or switching sending on or off needs
`settings.manage` and a fresh 2FA code, and each is audited. The password is
encrypted with the data key, never returned by the API and never written to
the audit log. Encrypted connections need TLS 1.2 or newer and a valid certificate, and
production refuses an unencrypted server. Changing the server, login or
sender address switches sending off until a test email gets through.

**Outbox.** Everything that sends email writes an outbox row in the same
transaction as the change, so an email goes out only if the change commits.
While sending is off, rows are held. The readable copy has codes and links
blanked; the full text is stored encrypted. Outside production the outbox
shows the full text so sign-up can be tested end to end. The sender claims
due rows with a lease (safe across processes and crashes), retries with
backoff up to 8 times, and marks a message failed at once on a permanent
5xx answer. Switching sending on releases held emails only when asked, and
only those from the last 24 hours, since older codes have expired.

**Staff emails.** `comms.send` lets staff email one client; groups of
clients and staff need `comms.bulk` and a fresh 2FA code. Staff without
`client.view_all` can only reach their own clients. The send must confirm
the recipient count the preview showed, so a list that changed is never sent
blind. Subjects must be one line (no header injection), only known
placeholders are filled in, and message text is escaped when turned into
HTML. At most 20,000 recipients per email; each send is audited.

**News and offers.** Marketing emails go only to verified, open accounts that
have not unsubscribed, and carry an unsubscribe link plus one-click
`List-Unsubscribe` headers. The link is signed per client (HMAC derived from
the data key); opening it shows a button rather than unsubscribing, so mail
scanners that follow links do not opt anyone out. Unsubscribing cancels
waiting marketing emails and is audited. Account emails are unaffected.

## KYC documents

**Uploads.** Clients upload identity (ID card front and back, passport, or driving licence) and proof of address through `POST /api/kyc`, the same call the portal and app already make.

- Frozen accounts may upload (a freeze pauses money, not verification); closed accounts and staff "view as client" sessions cannot.
- Each file is checked by its bytes, not its name or declared type: only JPEG, PNG, WebP, HEIC and PDF, up to 10 MB each.
- Photos are decoded and re-encoded before they are stored. That drops EXIF and XMP (GPS location, device), applies the camera's rotation, refuses decompression bombs over 50 megapixels and photos under 400 pixels on the short side. HEIC is converted to JPEG so every reviewer's browser shows it; the conversion runs in a worker thread, two at a time, so a large photo never blocks other requests. The original photo is not kept.
- PDFs are stored as sent once pdf.js opens every page of them. One that needs a password to open, one it cannot open (damaged, or not really a PDF) and one over 20 pages are refused with a message saying what to send instead, so every stored document can be read in the review screen. Bank statements with only owner restrictions (no password to open) are accepted.
- The SHA-256 used for duplicate checks is taken from the file as sent.
- At most 10 stored uploads per client per hour, checked before the body is read; failed attempts do not use them up (a looser 30 attempts an hour stops hammering). Throttled requests get `429` with `Retry-After`. A retry that repeats a pending upload exactly (same type, same files) is answered `201` without storing it twice.
- A client can take back their own pending upload (`POST /api/kyc/withdraw`) until a reviewer opens it. The submission is kept as `withdrawn` for the record and audited as `kyc.withdrawn_by_client`. Uploads staff made for them cannot be taken back.
- Files are encrypted at rest (AES-256-GCM with the data key, bound to the submission and slot) and never served back to the client. The client API only returns statuses and rejection reasons.

**Who sees what.**

- `kyc.view` gives the queue, the counts and each client's KYC status, scoped to assigned clients unless the role also has `client.view_all`.
- `kyc.documents` is needed to open a submission, its documents and the profile details they are checked against (full name, date of birth and address; the phone number is not shown). Built-in roles with it: Super Admin, Admin, Compliance and Auditor. Sales and support roles do not have it.
- Every opened submission and every document view is audited. Documents are served with `no-store`, `nosniff` and a sandboxing CSP, and only to the review screen's own requests, which carry an `X-CRM-Viewer` header: a link, a download, an image, a frame or the address bar cannot send it, so they are refused. The review screen draws photos and PDFs on a canvas inside the page (PDFs with pdf.js served from the CRM itself, no eval, no CDN), with zoom, rotate and full screen, and no "save image" menu. HEIC photos stored before uploads were converted are sent as JPEG, after the same size checks as an upload. The browser's pdf.js has no time or memory limit, so a PDF the server's limited pdf.js cannot open is never sent to it, and the viewer gives up on a PDF that takes over 20 seconds to open and skips images over 50 megapixels. Each document is sent with its SHA-256 (`X-Document-SHA256`), and the review screen checks its copy against it: a browser extension that catches files, such as a download manager, can hand the page an empty or changed copy, and the reviewer is told that instead of seeing a good document called damaged. Reviewing never needs a download; a document that cannot be shown offers "Reject as unreadable" with a ready-made reason, but only when the file itself is the problem. A PDF that arrived intact and still does not open in the browser is the browser's problem (the server opened it with the same pdf.js), so rejecting it is not offered. Whoever may open a document can still copy what is on screen; the audit log records who opened what.
- Saving an original to a computer is its own permission, `kyc.download`. Only a Super Admin holds it unless they add it to a role. It needs a recent 2FA code, is audited as `kyc.document_downloaded`, and never counts as reviewing.
- Warnings never name a client the reviewer could not open: a match outside their scope is shown as "another client".

**Decisions.**

- Approving or rejecting needs `kyc.decide`, `kyc.documents` and a fresh 2FA code. Changing a decision and asking for a new document need the same; claiming and "next" need the two permissions. A rejection needs a plain-text reason, which the client sees and is emailed. A decision can carry an internal note (plain text, at most 500 characters) that goes to the audit log and the decision history, never to the client.
- Approving needs every checklist item ticked (the checklist depends on the document type: the back of an ID card is checked for expiry, not a recent date) and every document opened by the approving reviewer. A photo counts once fetched; a PDF counts when the review screen drew every page (each page is reported once and audited as `kyc.document_page_viewed`; the server counts the pages with pdf.js at upload, in a short-lived worker thread with a 10 second and 256 MB limit, so a crafted PDF cannot stall the server; one it cannot read in time is refused). A download never counts as opening a document. The ticked checklist is stored with the decision.
- Four eyes: whoever uploaded documents for a client can never approve them, whatever their role, and "next" never hands them their own uploads.
- `POST /api/staff/kyc/:id/change` only approves a rejected document (latest submission only, with a reason). Taking back an approval is "Ask for a new document" (`/request-new`), which tells the client what to send; it is audited as `kyc.new_document_requested`.
- Approving without documents needs `kyc.override` (Super Admin and Admin), 2FA and a reason, and is audited as `kyc.approved_without_documents`. Approving any document-less item later also needs `kyc.override`. The client is told their proof was confirmed.
- Closed accounts: their pending items leave the queue, the counts and "next" (the list shows them with `includeClosed=1`), and every decision, upload and approval on them is refused.
- Review claims: opening a pending item holds it for 15 minutes (refreshed while open), so two reviewers never decide the same item. A decision is refused while someone else holds it; taking over a review is audited as `kyc.review_taken_over`.
- Every KYC change locks the client row first and recomputes the stored status with a locking read, so two decisions for one client run one after the other and the stored KYC status is never stale.

**Verified details.** While a document is under review or approved, the details it is checked against are locked: first name, last name and date of birth for identity; country, city, address and postcode for proof of address. While a document is under review, a blank detail was never checked, so it stays open to fill in (staff can upload for a client whose profile is still empty); once it has a value it is locked like the rest. Once approved, every detail stays as the reviewer saw it, a blank postcode included.

- `PATCH /api/user` refuses a real change to a locked field with a field error. Values that only differ in case or spacing count as unchanged, since the portal and app send the whole form.
- Staff change them only with `kyc.override` and a fresh 2FA code; the change is audited as `client.verified_details_changed` with the fields. `GET /api/staff/clients/:id` lists the locked fields so the form can show them.
- Each submission keeps an encrypted copy of these details from upload, refreshed on approval, so the review screen can name exactly which ones changed since.

**Review warnings.** Under-18 dates of birth, the same person on another account (same date of birth and name), the same file sent by another client, a proof of address identical to the client's identity file, a file identical to one rejected before, identical front and back, details changed after sending, unverified email and non-active accounts.

**Client notices and events.** An upload gives the client an in-app "We received your proof of ..." notice. A decision gives one notice and email saying what comes next, and exactly one support event (see "Support service events").

**Keeping the evidence.** KYC submissions and documents cannot be deleted with their client or submission (foreign keys `ON DELETE RESTRICT`); nothing in the CRM deletes them. The retention period after an account closes is for compliance to set; a purge job will follow that decision.

**Gated client features.** Money, trading-account and IB routes, as they are built, answer clients without approved KYC with `kycRequired()`: `403 { "message": "You must complete your KYC first." }`, the exact text the app looks for.
