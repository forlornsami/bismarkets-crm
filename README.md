# BIS Markets CRM

The BIS Markets back-office CRM: staff admin panel, staff API and (from Phase 2)
the client API the Client Portal and Client App call. Node.js 22, TypeScript,
Express 5, MySQL 8 and a React admin panel.

The full plan lives in the CRM spec document. This repository is built in
phases; each one is reviewed on a staging server before the next starts.

| Phase | Contents | State |
| --- | --- | --- |
| 1. Foundation | Staff sign-in with 2FA, roles and permissions, staff management, audit log, admin panel | This branch |
| 2. Clients and KYC | Client API sign-in and profile, client management, KYC queue, compliance screening | Next |
| 3. MT5 and money | MT5 gateway, accounts, packages, wallet ledger, deposits (ZyntrixPay and manual), withdrawals | |
| 4. IB system | IB hierarchy, commission plans and runs, payouts | |
| 5. Advanced | Risk view, bonuses, reports, communication, go-live checks | |

## Run it locally

Needs Node.js 22 and MySQL 8.

```sh
npm ci
cp .env.example .env            # then edit: local values, CRM_COOKIE_SECURE=false, NODE_ENV=development
export $(grep -v '^#' .env | xargs)
npm run cli -- generate-key      # put the output in CRM_DATA_KEY
npm run migrate
npm run cli -- seed-roles
npm run cli -- create-super-admin --email you@example.com --name "Your Name"
npm run dev                      # API on :3000
npm run dev:admin                # admin panel on :5173, proxied to the API
```

Sign in with the temporary password the last command printed. You will be
asked to set up 2FA and then to choose your own password.

## Checks

```sh
npm run typecheck
CRM_TEST_DATABASE_URL=mysql://user:pass@127.0.0.1:3306/crm_test npm test   # wipes that database
npm run build
```

Integration tests run against a real MySQL database and drop every table in
it first, so point `CRM_TEST_DATABASE_URL` at a throwaway database. Without it
only the unit tests run. MySQL must allow trigger creation by the test user
(`SET GLOBAL log_bin_trust_function_creators = 1` when binary logging is on).

## Layout

```
schema/migrations/   SQL migrations, applied in order by `cli migrate`, never on start
src/shared/          Permission catalog and default roles (used by server and panel)
src/server/          Express app: config, staff session and guards, routes, audit log
src/cli/             generate-key, migrate, seed-roles, create-super-admin, verify-audit
src/admin/           React admin panel
tests/               Vitest unit and MySQL integration tests
docs/                Security model and VPS deployment guide
```

See [docs/SECURITY.md](docs/SECURITY.md) for how access is controlled and
[docs/DEPLOY.md](docs/DEPLOY.md) for setting up the server.
