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
need it added under Roles.

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
saved payout account may carry a 10 MB QR image, a client's profile picture is
a 1 MB image sent as a form, and staff upload deposit-method QR images of up
to 2 MB.

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
  # QR images of the broker's crypto deposit addresses.
  location ~ ^/api/staff/money/methods/[0-9]+/qr$ {
    client_max_body_size 3m;
    proxy_pass http://127.0.0.1:3000;
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

With nginx on the same host, `CRM_TRUSTED_PROXIES=127.0.0.1`. If Cloudflare is
in front, use nginx's `real_ip` module with Cloudflare's published ranges so
`$remote_addr` is the visitor's real IP.

## 6. Keep it healthy

- Daily `mysqldump --single-transaction bismarkets_crm` copied off the server.
- Daily `node dist/cli.mjs verify-audit` from cron; alert if it exits non-zero.
- `unattended-upgrades` for security patches.
