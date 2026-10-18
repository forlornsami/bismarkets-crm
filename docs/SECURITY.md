# Security model

What protects the CRM: the staff side (Phase 1), the client API and KYC
(Phase 2), and client money (Phase 3, deposits and withdrawals).

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

## Money: deposits and withdrawals (Phase 3)

**The ledger.** Every dollar a client holds is in a double-entry ledger in US
cents. Entries are only ever added (MySQL triggers refuse UPDATE and DELETE),
each transaction balances to zero, and a deposit, hold, payout or release can
be posted once per request (unique on its source). The wallet's cached
balances are changed in the same transaction as the entries. `cli
verify-ledger`, run from cron, checks that every transaction balances, every
wallet equals its entries, and every ledger transaction matches its deposit or
withdrawal exactly (accounts, amounts, client, and one hold per withdrawal
with one payout or one return once it is decided). Every money change locks
the client row, then the wallet, then the request, in that order.

**Client requests.** Deposits, withdrawals and saved payout accounts need
approved KYC, an account that is not frozen or closed, and the client's own
session (a staff "view as client" session cannot). A withdrawal also needs a
6-digit code emailed to the client's own address; a code is bound to the client
who asked for it, used once, and five wrong guesses end it. Amounts are parsed
as text (at most two decimals, no exponent or separators). Forms are refused
before parsing when they have more parts or longer values than any money form
needs, or a Content-Type that is not a plain multipart boundary. Payment
screenshots and wallet QR pictures are checked by their bytes, re-encoded
(dropping EXIF and anything hidden in the file) and stored encrypted. Adding or
changing a payout account tells the client in the app and by email.

**Encryption.** Payout account numbers, IBANs, the destination copied onto each
withdrawal, payment screenshots and wallet QR pictures are encrypted with the
data key (AES-256-GCM). Each is bound to its own row (id, client and
reference), so a sealed value copied to another row does not open: the review
screen says the destination could not be read, and it cannot be approved or
paid.

**Reviewing.** Deposits and withdrawals share the review screen: a 15-minute
claim so two people never decide the same request, warnings, a checklist that
must be fully ticked, preset reasons, and a fresh 2FA code for every decision.
A deposit can be approved only by someone who opened its payment screenshot in
the review screen; the bank reference entered must not be on another deposit
of the same method. Reasons the client sees are plain text, at most 240
characters. Every view, proof opening, claim, take-over and decision is in the
audit log. The client's activity feed shows review details only to staff who
review that kind of request.

**Two people.**

- A deposit above the second-approval limit (USD 5,000 by default) needs a
  second approval from someone else, and so does one sent back from the second
  approval, whatever the amount the next reviewer enters. Only staff who give
  second approvals can reject a sent-back deposit. The client's other deposits
  still waiting for a first approval become two-person too, and so do their
  next deposits while it is open and for 30 days after it is refused (the same
  screenshot at any time). Those later deposits are not
  themselves "sent back": any reviewer may reject them, and refusing them does
  not extend the 30 days.
- A deposit approved first by whoever set its method's account details, or the
  rupee rate it uses, goes to a second person whatever the amount. The second
  reviewer is asked to check that the account is the company's own and the
  rate is right.
- A withdrawal above its limit (USD 1,000 by default) or a client's first
  withdrawal needs two approvals. Whoever approved a withdrawal alone cannot
  also mark it paid.
- The limits themselves need `settings.manage` (Super Admin only by default).
  Deposit methods, payout types, minimums and the rupee rate need
  `payment.manage` and 2FA. One change moves the rupee rate by at most 20%.
- Whoever manages staff accounts does not approve or pay money: the Admin role
  does not hold the deposit, withdrawal, wallet adjustment, IB payout and MT5
  balance and credit change permissions, which Finance Managers hold (a Super
  Admin can add them back). Combined with the rule that nobody grants or
  resets a role whose permissions they do not hold, an Admin cannot create or
  take over a finance account to give both approvals.

**Where clients pay.** A deposit method's account details cannot change while
deposits paid to it wait for review (add a new method instead). A crypto
method's QR code is drawn by the CRM from the method's own wallet address
(TRC20 and BEP20; a Binance Pay ID is typed, not scanned). Staff cannot upload
a picture in its place, so the code clients scan cannot hold a second code or a
payment link to another address. A new address is drawn under a new link and
the old link stops working, and whoever changes the address cannot approve
deposits to it alone. A payout type's network cannot change once clients have saved
accounts under it, and its name must carry its own network's word only, as the
portal and app choose the form by name.

**Withdrawal warnings.** The same destination saved by another client, a name
that does not match the verified name, a first withdrawal, an account added or
changed in the last 72 hours, recent password resets, email or verified-detail
changes and payout account changes (a rename or new default does not count),
money that arrived just before it is asked out, and a withdrawal to a different
kind of account than the client deposited with.


## MT5 gateway (Phase 3)

**Who holds what.** MT5 manager logins and passwords are only in the gateway's
own environment file (`/etc/bismarkets/gateway.env`, root, mode 0600). The CRM,
its database, its logs and its audit log never see them: the CRM asks the
gateway for a fixed list of operations by server code. The gateway runs as its
own OS user (`bisgw`), from code only root can change (so a compromised CRM
cannot rewrite it), and listens on 127.0.0.1 only; it refuses to start on any
other address unless that is set on purpose. After reading its settings it
removes the shared secret and the passwords from its process environment. The
secret and password hashes print as `[hidden]` wherever they end up, and a
settings problem names the setting, never its value.

**Only the CRM can ask.** Every request is `POST /v1/<op>` signed with
HMAC-SHA256 (the secret shared with the CRM, at least 32 characters) over the
time, a one-time random nonce, the path and a hash of the body. The gateway
checks, in this order and before anything reaches MT5: body at most 16 KB,
signature (in constant time), time within 30 seconds of its own clock, nonce not
seen in the last 60 seconds, a known operation, and a body that matches the
operation exactly (an unexpected key, a wrong type or a value of the wrong
shape is refused). Whatever fails gets an unsigned 401, 400 or 413. A bad
signature is logged with the path, the caller's address and the reason, and a
bad body with the operation and the names of the wrong fields; neither log line
holds the body, its values or the headers. Nonces are remembered in a bounded memory:
when it is full of live nonces the gateway refuses new requests (unsigned 503) rather than
forget a nonce early. Every answer to an accepted request is signed over that
request's nonce, so the CRM can tell a real answer from one made up by a process
that took over the gateway's port.

**Rules the gateway keeps even if the CRM is compromised.**

- Only configured servers, and only accounts whose MT5 group is on that
  server's live or demo list. Every operation naming an account first reads its
  group (cached for 10 minutes); an account in any other group is refused, and
  so is opening or searching an account in one.
- No operation deletes an account or changes its group. An update changes only
  the leverage (from `GATEWAY_LEVERAGES`) and the ENABLED and TRADE_DISABLED
  bits of the account's 64-bit rights (read as BigInt, every other bit written
  back as it was). New accounts get fixed rights (ENABLED, PASSWORD, TRAILING,
  EXPERT, REPORTS).
- Balance operations carry a `BIS-` reference as their comment, stay under the
  per-operation limit (`GATEWAY_MAX_OP_CENTS`, `GATEWAY_DEMO_MAX_OP_CENTS` for
  demo groups), and credits to live accounts stay under a rolling 24-hour limit
  per server (`GATEWAY_DAILY_CREDIT_CENTS`, kept in memory, so a restart starts
  a new count). Money only leaves an MT5 account with MT5's margin check on.
- One write at a time per account (one account opening at a time per group),
  and at most 64 operations at once.

**Talking to MT5.** Over TLS 1.2 or later, with the access server's certificate
pinned by its SHA-256 fingerprint; without a pin it must chain to a trusted CA
and name the host, and no setting skips both. The certificate is checked before
the socket is handed to any request. The manager signs in on that socket, and
MT5 must prove it knows the password too (each side answers the other's random
challenge), so a look-alike server is not trusted. MT5 ties the session to the
socket, so each connection is a keep-alive agent with a single socket that
opens only while signing in, and every request checks that the socket it was
given is the signed-in one before writing a byte. Idle sessions are pinged
every 20 seconds and signed in again when MT5 drops them.

**Outcomes.** The CRM is told one of: done; refused (MT5 or a gateway rule said
no, nothing changed); unavailable (MT5 was never reached, nothing changed);
unknown (a write may or may not have happened); or bad request (a broken rule,
nothing changed).

- A write becomes unknown once any byte of it may have reached MT5: a
  connection lost or an answer missing, cut off, unreadable, without a retcode
  or with an HTTP error after that point, and MT5's own "timeout" or "network
  error" retcodes. Before that point, the same failures are unavailable.
- Reads are tried once more on a fresh sign-in. A write is tried again only if
  nothing of it was sent, and never after. Nothing is sent once the CRM has hung
  up or too little of its wait is left for the answer to reach it.
- A balance operation first searches the account's deals for its reference,
  under the same lock as the send. If MT5 already has it, the original ticket
  comes back and nothing is sent again (even if a limit has been reached since);
  a deal with that reference but another amount or kind is reported as unknown
  for staff to check, and nothing is sent. A search MT5 cannot complete is
  "unavailable", never "not found". The CRM's own searches for a lost answer
  (`deal.find`, `user.find`) wait for any write still running on that account or
  group, so "not found" is never said while the write is on its way.

**Money** crosses the gateway as integer cents. MT5's decimal text is parsed
without floats (MT5's JSON numbers are kept as their exact text), rounding a
third decimal half away from zero, and cents go back to MT5 as exact
two-decimal text.

**Logs** (JSON on stdout, to the journal): every write with its operation,
server, account, amount, reference, ticket, outcome and MT5 retcode; unknown
outcomes at error level. Never a password, the secret, an MT5 URL (a password
change carries the password in one) or a request body; fields named like
passwords or secrets are hidden even if passed by mistake. MT5's own error text
goes to the CRM for staff only; the CRM shows clients its own words.

**Bounded memory.** Nonces (100,000), the group cache (10,000 accounts), the
24-hour credit count (one number per minute per server), locks (one per
operation in flight) and MT5 answers (8 MB each) all have fixed limits, so no
caller can make the gateway grow without end.

## Clients' MT5 passwords

The owner chose to keep clients' MT5 master and investor passwords so the
portal and app can show them again, as the old CRM did. Whoever has one can
sign in to that trading account (the investor one can only watch), so:

- They are kept only in `mt5_account_passwords`, a table of their own, so no
  query on `mt5_accounts` can return one. Each is sealed with AES-256-GCM under
  the data key and bound to its account, client and type: a value copied to
  another row does not open, and shows as not available.
- Only the client's own session sees them, in the account list. Staff viewing
  as the client get none (the panel says not available), and they never appear
  in the staff API, the admin, the audit log, the logs, events to Support,
  emails or exports. Answers that carry them are not cached (`no-store`).
  A stolen client session would reveal them; that is the trade-off accepted.
- Staff never read a kept password. A staff reset makes a new one, shows it to
  that staff member once and keeps it for the client; the audit names only
  which password was reset.
- A kept password is taken out while a change is on its way to MT5 and put back
  only when MT5 says no or was never reached; MT5 confirming keeps the new one,
  and a lost answer keeps none. So the panel shows what MT5 has, or nothing,
  never a password that may be wrong. Passwords for an account that failed to
  open are deleted.
- One password changes per request. The pair a client is not changing comes as
  empty or as the value kept now; an out-of-date value from a page loaded
  before another change is refused instead of being set back.
- Limit: a password the client changes in the MT5 terminal itself is not seen
  by the CRM, so the panel keeps showing the old one until the next change
  through the portal or app.
