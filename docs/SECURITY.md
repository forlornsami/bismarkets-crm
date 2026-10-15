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
- API responses are never cached.
