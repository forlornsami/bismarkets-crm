# Deploying on a Linux VPS

The recommended setup: one Ubuntu 24.04 VPS (Hostinger KVM 2 or larger) with a
fixed IP, running MySQL, the CRM under systemd, and nginx for HTTPS. Cloudflare
can sit in front for DDoS protection and a firewall.

## 1. Server basics

```sh
adduser --disabled-password crm
apt update && apt install -y nginx mysql-server ufw
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs
ufw default deny incoming && ufw allow OpenSSH && ufw allow 'Nginx Full' && ufw enable
```

Use SSH keys only (`PasswordAuthentication no` in `/etc/ssh/sshd_config`).
MySQL stays on 127.0.0.1; never open port 3306.

## 2. Database

```sql
CREATE DATABASE bismarkets_crm CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'crm'@'127.0.0.1' IDENTIFIED BY '<long random password>';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, DROP, REFERENCES, TRIGGER ON bismarkets_crm.* TO 'crm'@'127.0.0.1';
SET PERSIST log_bin_trust_function_creators = 1;
```

The last line lets migrations create the audit-log triggers while binary
logging is on.

## 3. Install a release

```sh
sudo -u crm git clone https://github.com/forlornsami/bismarkets-crm /home/crm/app
cd /home/crm/app && sudo -u crm npm ci && sudo -u crm npm run build
sudo -u crm npm prune --omit=dev
```

Put the environment in `/etc/bismarkets-crm.env` (owner root, mode 600) using
`.env.example` as the template. Generate `CRM_DATA_KEY` with
`node dist/cli.mjs generate-key` and keep a copy in your password manager.

```sh
set -a; . /etc/bismarkets-crm.env; set +a
node dist/cli.mjs migrate
node dist/cli.mjs seed-roles
node dist/cli.mjs create-super-admin --email you@bismarkets.com --name "Your Name"
```

KYC photos are processed with `sharp`, which ships a native library for the
server's platform. Run `npm ci` on the server itself (or on the same OS and
CPU type), never copy `node_modules` from a laptop.

Upgrading: stop the service, install the new release as above, run
`node dist/cli.mjs migrate`, then start it again. Migrations also grant new
permissions to the built-in roles (0011 gives `kyc.documents` to Super Admin,
Admin, Compliance and Auditor); custom roles that should open KYC documents
need it added under Roles. `migrate` also redraws any crypto deposit QR code
that is not the CRM's own drawing of the method's address (from a build that
took uploaded pictures), under a new link, and records it in the audit log.

**Cutover order.** The client portal must run the version built for this CRM
(bismarkets-client-portal PR #2) before or at the same moment
`crmbismarkets.com` is pointed at this server. The older portal hides the
CRM's field errors and KYC rejection reasons behind generic text. The Android
app already shows the CRM's messages as written.

## 4. Run it

`/etc/systemd/system/bismarkets-crm.service`:

```ini
[Unit]
Description=BIS Markets CRM
After=network.target mysql.service

[Service]
User=crm
WorkingDirectory=/home/crm/app
EnvironmentFile=/etc/bismarkets-crm.env
ExecStart=/usr/bin/node --enable-source-maps dist/server.mjs
Restart=always
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```sh
systemctl daemon-reload && systemctl enable --now bismarkets-crm
curl -s localhost:3000/api/readyz
```

## 5. HTTPS with nginx

Point `staff.crmbismarkets.com` (staff panel) and `crmbismarkets.com` (the API
the client portal and app call) at the server, get certificates
(`apt install certbot python3-certbot-nginx && certbot --nginx`), and proxy.
Bodies stay small everywhere except the uploads that need more: KYC uploads
carry up to two 10 MB files, a deposit carries a 10 MB payment screenshot, a
saved payout account may carry a 10 MB QR image, and a client's profile
picture is a 1 MB image sent as a form. (Deposit-method QR codes are drawn by
the CRM from the saved address, so nothing is uploaded for them.)

```nginx
# At http level (outside the server blocks): the origins that may call the
# client API, the same list as CRM_CLIENT_ORIGINS.
map $http_origin $client_cors {
  default "";
  "https://bismarkets.global" $http_origin;
}

# Staff panel and staff API.
server {
  server_name staff.crmbismarkets.com;
  client_max_body_size 1m;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $remote_addr;
  proxy_set_header X-Forwarded-Proto https;

  location / {
    proxy_pass http://127.0.0.1:3000;
  }
  # KYC documents uploaded on a client's behalf.
  location = /api/staff/kyc/upload {
    client_max_body_size 21m;
    proxy_read_timeout 150s;
    proxy_pass http://127.0.0.1:3000;
  }
  # QR code links belong to the client host only (see below).
  location ~* ^/+api/+(payout|payment)-qr/ {
    access_log off;
    return 404;
  }
}

# Client API for the portal and the app.
server {
  server_name crmbismarkets.com;
  client_max_body_size 1m;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $remote_addr;
  proxy_set_header X-Forwarded-Proto https;

  # A body over the limit is refused here, before the CRM sees it. Answer with
  # JSON and the CORS header, or the portal's browser hides the 413. Deposits
  # and payout accounts answer with the field error the CRM itself would give,
  # which the portal shows under the file.
  error_page 413 = @too_large;
  location @too_large {
    default_type application/json;
    add_header Access-Control-Allow-Origin $client_cors always;
    add_header Vary Origin always;
    return 413 '{"message":"The upload is too large."}';
  }
  location @proof_too_large {
    default_type application/json;
    add_header Access-Control-Allow-Origin $client_cors always;
    add_header Vary Origin always;
    return 422 '{"message":"Upload a screenshot or photo of your payment: JPG, PNG, WebP, HEIC or GIF, up to 10 MB.","errors":{"file_name":["Upload a screenshot or photo of your payment: JPG, PNG, WebP, HEIC or GIF, up to 10 MB."]}}';
  }
  location @qr_too_large {
    default_type application/json;
    add_header Access-Control-Allow-Origin $client_cors always;
    add_header Vary Origin always;
    return 422 '{"message":"Upload a picture of the QR code: JPG, PNG, WebP, HEIC or GIF, up to 10 MB.","errors":{"file_name":["Upload a picture of the QR code: JPG, PNG, WebP, HEIC or GIF, up to 10 MB."]}}';
  }

  location / {
    proxy_pass http://127.0.0.1:3000;
  }
  location = /api/kyc {
    client_max_body_size 21m;
    proxy_read_timeout 150s;
    proxy_pass http://127.0.0.1:3000;
  }
  location = /api/user/profile-picture {
    client_max_body_size 3m;
    proxy_pass http://127.0.0.1:3000;
  }
  # Deposit requests carry the payment screenshot (HEIC photos are converted).
  location = /api/deposits {
    client_max_body_size 11m;
    error_page 413 = @proof_too_large;
    proxy_read_timeout 90s;
    proxy_pass http://127.0.0.1:3000;
  }
  # Saved payout accounts may carry the client's wallet QR image.
  location ~ ^/api/user-payment-methods(/[0-9]+)?$ {
    client_max_body_size 11m;
    error_page 413 = @qr_too_large;
    proxy_read_timeout 90s;
    proxy_pass http://127.0.0.1:3000;
  }
  # QR code pictures: the link itself is the secret, so it stays out of the
  # access log, and out of the error log when the CRM is restarting.
  location ~* ^/+api/+(payout|payment)-qr/ {
    access_log off;
    error_log /var/log/nginx/error.log crit;
    proxy_pass http://127.0.0.1:3000;
  }
}
```

nginx answers a larger body before the CRM sees it. On the client API host the
answer is JSON with the CORS header, so the portal can read it. For deposits
and payout accounts it is the same `422` field error the CRM gives for a file
over 10 MB, which the portal shows as written. Elsewhere it is
`413` with a short message: the portal shows its own "file too large" message
for KYC uploads, and the app reads the status. The staff panel is on its own
origin and reads nginx's plain `413` directly.

KYC uploads get a longer `proxy_read_timeout`: photos are converted before they
are stored, and a two-sided HEIC upload can take up to two minutes when the
server is busy. With nginx's default of 60 s the client would see a `504` while
the CRM still stores the document.

A QR code picture's link (`/api/payout-qr/…`, `/api/payment-qr/…`) is all that
protects it. nginx serves those links on the client host only, keeps them out
of its access log, and logs only critical errors for them (a failed connection
to the CRM is not logged, as that line would carry the link). The CRM logs them
with the token replaced by `:token`. Treat nginx's error log as private all the
same.

With nginx on the same host, `CRM_TRUSTED_PROXIES=127.0.0.1`. If Cloudflare is
in front, use nginx's `real_ip` module with Cloudflare's published ranges so
`$remote_addr` is the visitor's real IP.

## 6. Keep it healthy

- Daily `mysqldump --single-transaction bismarkets_crm` copied off the server.
- Daily `node dist/cli.mjs verify-audit` from cron; alert if it exits non-zero.
- Hourly `node dist/cli.mjs verify-ledger` from cron; alert if it exits
  non-zero (a wallet, deposit or withdrawal that does not match the ledger).
- `unattended-upgrades` for security patches.

## 7. The MT5 gateway

The CRM never holds MT5 credentials. A separate service, the MT5 gateway
(`dist/gateway.mjs`), holds the manager logins and is the only thing that talks
to MT5. It runs as its own user from code only root can change, listens on
127.0.0.1 only, and answers only requests signed with the secret it shares with
the CRM (see `docs/SECURITY.md`, "MT5 gateway"). With `CRM_MT5_GATEWAY_URL`
unset the CRM runs without MT5: lists answer from the database and every MT5
change is refused as "temporarily unavailable".

**Ask the broker for:**

- The Web API access server's host and port (HTTPS), and the SHA-256
  fingerprint of its certificate, given to you over a second channel (phone,
  signed email) so you can check the one you see.
- A manager login for the CRM alone, with Web API access allowed on that access
  server (`ACCESS_ALLOW_WEB_API`), this VPS's IP on the manager's allowed IP
  list, and only the rights it needs: read and edit accounts, balance operations
  (dealer), read trades. No administrator rights.
- The exact group names: the live group behind each account package, and the
  demo groups. Demo groups should be on the same platform as live, since the
  portal and app always show the server as `BISMarkets-Trade`. Also each group's
  minimum password length and login range.
- The trade server's offset from UTC, and whether it changes for daylight
  saving.
- The client build number the access server accepts (`version`, default 3211),
  its idle-session timeout, and any connection limit.
- A test server (or test groups) for the checklist below before going live.

**Install.** Run the gateway from its own copy of the release, owned by root.
The CRM's user owns `/home/crm/app`, so if the gateway ran from there a
compromised CRM could rewrite the gateway's code and wait for a restart. Copy it
right after building a release (section 3):

```sh
adduser --system --group --no-create-home bisgw
install -d -m 0755 -o root -g root /opt/bismarkets-gateway/dist
cp /home/crm/app/dist/gateway.mjs /home/crm/app/dist/gateway.mjs.map /opt/bismarkets-gateway/dist/
cp /home/crm/app/package.json /home/crm/app/package-lock.json /opt/bismarkets-gateway/
cd /opt/bismarkets-gateway && npm ci --omit=dev --ignore-scripts
chown -R root:root /opt/bismarkets-gateway
```

**Settings** go in `/etc/bismarkets/gateway.env`, owner root, mode 0600
(systemd reads it as root; the `bisgw` user itself cannot):

```sh
install -d -m 0750 -o root -g root /etc/bismarkets
install -m 0600 -o root -g root /dev/null /etc/bismarkets/gateway.env
openssl rand -hex 32   # the shared secret, for GATEWAY_SECRET here and CRM_MT5_GATEWAY_SECRET in the CRM
```

```sh
GATEWAY_HOST=127.0.0.1
GATEWAY_PORT=3100
GATEWAY_SECRET=<64 hex characters, the same as CRM_MT5_GATEWAY_SECRET>
GATEWAY_LOG_LEVEL=info
# Leverages accounts may have (2000 is 1:2000), and the money limits in US cents.
GATEWAY_LEVERAGES=2000
GATEWAY_MAX_OP_CENTS=10000000
GATEWAY_DAILY_CREDIT_CENTS=50000000
GATEWAY_DEMO_MAX_OP_CENTS=10000000

# One block per server code; the CRM's MT5 servers use the same codes.
GATEWAY_SERVERS=live
GATEWAY_SERVER_LIVE_HOST=mt5-webapi.broker.example
GATEWAY_SERVER_LIVE_PORT=443
GATEWAY_SERVER_LIVE_LOGIN=1005
GATEWAY_SERVER_LIVE_PASSWORD='<manager password>'
GATEWAY_SERVER_LIVE_CERT_SHA256=<SHA-256 fingerprint, with or without colons>
# Single quotes keep the backslashes in group names.
GATEWAY_SERVER_LIVE_GROUPS='real\standard,real\pro'
GATEWAY_SERVER_LIVE_DEMO_GROUPS='demo\standard'
GATEWAY_SERVER_LIVE_TZ_OFFSET_MINUTES=120
GATEWAY_SERVER_LIVE_CONNECTIONS=2
```

A server code `live-2` uses variables named `GATEWAY_SERVER_LIVE_2_*`. The
gateway refuses to start on any `GATEWAY_*` name it does not know (so a
mistyped pin is not silently ignored) and on a listen address other than
loopback (unless `GATEWAY_ALLOW_REMOTE=true`, which this setup never needs).
Its first log line lists each server's groups as it read them: check that the
backslashes are there.

To see the certificate you are about to pin, and compare it with what the
broker gave you:

```sh
openssl s_client -connect mt5-webapi.broker.example:443 -servername mt5-webapi.broker.example </dev/null 2>/dev/null \
  | openssl x509 -noout -fingerprint -sha256
```

Without a pin the certificate must be signed by a CA the server trusts and name
the host; there is no setting that skips both checks. When the broker renews
its certificate the gateway reports MT5 as unavailable until the new
fingerprint is set.

`/etc/systemd/system/bismarkets-gateway.service`:

```ini
[Unit]
Description=BIS Markets MT5 gateway
After=network-online.target
Wants=network-online.target
Before=bismarkets-crm.service

[Service]
User=bisgw
Group=bisgw
WorkingDirectory=/opt/bismarkets-gateway
EnvironmentFile=/etc/bismarkets/gateway.env
ExecStart=/usr/bin/node --enable-source-maps dist/gateway.mjs
Restart=always
# It waits up to 25 s for operations already sent to MT5 before stopping.
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictSUIDSGID=true
LockPersonality=true
CapabilityBoundingSet=

[Install]
WantedBy=multi-user.target
```

```sh
systemctl daemon-reload && systemctl enable --now bismarkets-gateway
curl -s 127.0.0.1:3100/healthz      # {"ok":true}
journalctl -u bismarkets-gateway -n 20
```

Then add to `/etc/bismarkets-crm.env` and restart the CRM:

```sh
CRM_MT5_GATEWAY_URL=http://127.0.0.1:3100
CRM_MT5_GATEWAY_SECRET=<the same value as GATEWAY_SECRET>
```

**Network.** Nothing new listens publicly: the gateway is on 127.0.0.1 and
ufw's default deny stays as it is. Never proxy it through nginx. If you filter
outgoing traffic, allow the MT5 host and port only.

**Before going live: the write checklist.** Several MT5 Web API paths and
formats could not be checked against MetaQuotes' documentation and are marked
`UNCONFIRMED` in `src/gateway/mt5/webapi.ts` (the only file to change if one is
wrong). On the broker's test server, with a test client in the CRM, check each
in the MT5 Manager terminal:

1. Open a live and a demo account: each is in the package's group with the
   leverage chosen, the comment `BIS-A…`, the main and investor passwords the
   client typed, and the rights ENABLED, PASSWORD, TRAILING, EXPERT and REPORTS
   (`user/add`: path, passwords as `pass_main` / `pass_investor` query
   parameters or in the body, the answer's `Login`).
2. Archive and restore it (TRADE_DISABLED set, then cleared), change its
   leverage, and suspend and reactivate it from the staff panel (ENABLED
   cleared, then set): nothing else about the account changes, in particular
   its group, balance and credit (`user/update` with the whole record).
3. Change the main and the investor password, then sign in to the MT5 terminal
   with each (`user/change_password`, or `user/pass_change`; the `type`
   spelling).
4. Transfer wallet → MT5 and MT5 → wallet: one balance deal each with comment
   `BIS-T…` and the right sign; an MT5 → wallet transfer larger than the free
   margin is refused with retcode 10019 (`trade/balance`: method, parameters,
   `check_margin`, the answer's ticket).
5. The CRM's account list shows the same balance, equity, credit and margin as
   the terminal (`user/account/get`).
6. A deal's time in the CRM matches the terminal once the UTC offset is applied
   (`GATEWAY_SERVER_X_TZ_OFFSET_MINUTES`).
7. `user/logins?group=` lists the group's accounts (the CRM uses it to find an
   account whose creation answer was lost, and the nightly check uses it to
   find MT5 accounts in a package group that no client is linked to).
8. A staff credit change in and out, approved by a second person: one credit
   deal each (action 3) with comment `BIS-S…`, the credit shown in the terminal,
   and a credit removal larger than the free margin refused (`trade/balance`
   with `type=3`, a negative amount, `check_margin`; the deal's amount in
   `Profit`). A staff balance change gives a balance deal (action 2) the same way.
9. Closed trades in the CRM (staff account page, and the portal's trade
   history) match the terminal's history for a full close, a partial close and,
   on a netting group, a reversal (`deal/get_page`: how many deals one page
   returns, `Entry`, `PositionID`, `TimeMsc`). The CRM shows a reversal as two
   trades under the same position id: the part it closed, ending at the INOUT
   deal, and, once it is closed in turn, the remainder it opened the other way,
   from the INOUT deal's price and time. All of the INOUT deal's commission and
   fee are on the part it closed; check that the terminal and the broker's
   statements show them the same way.
10. The Passwords panel in the portal and app shows the passwords the client
   chose and, after a change or a staff reset, the new one; each signs in to the
   MT5 terminal.

**Running it.**

- Every MT5 change is a `"msg":"MT5 write"` log line with its operation,
  server, login, amount, comment, ticket and outcome. `outcome:"unknown"`
  (level 50) means MT5 may or may not have done it: the CRM settles it by
  searching MT5, never by sending it again, and staff see it under MT5
  operations.
- `Refused a request that is not properly signed` means something other than
  the CRM is calling the gateway, or the two secrets or clocks differ. Keep both
  servers' clocks on NTP (`timedatectl`).
- `MT5 connection lost and could not sign in again` means MT5 is down, the
  manager's password or IP access changed, or the certificate no longer matches
  its pin.
- The 24-hour credit limit is kept in memory: a restart starts a new count.
- To change the shared secret: stop the CRM, set the new value in both env
  files, restart the gateway, then start the CRM. (While the two differ, the
  gateway refuses every request and the CRM cannot verify any answer, so a
  transfer started then would wait as unknown until the resolver settles it.)
- Upgrading: copy the new `gateway.mjs` as above and restart the gateway. It
  finishes the operations already sent to MT5 first; an answer lost anyway shows
  in the CRM as an unknown outcome that the resolver settles.
  Upgrade the gateway before (or with) the CRM: an older gateway refuses fields
  a newer CRM sends (such as a credit change's type), and those changes would
  wait as unknown until the resolver marks them failed.
- The nightly check (`CRM_MT5_RECONCILE_HOUR_UTC`, default 2) only reads MT5.
  Its findings are on the staff panel's Reconciliation page, with open critical
  ones counted on the dashboard. The first run on accounts that traded before
  the CRM may raise many warnings (older balance deals without a `BIS-`
  reference, MT5 accounts not linked to a client); review and resolve them once.
- The panel's passwords come from what clients set through the portal, the app
  or a staff reset. A password a client changes in the MT5 terminal itself is
  not seen by the CRM.
