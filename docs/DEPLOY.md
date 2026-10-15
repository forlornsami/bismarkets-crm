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

Point `staff.crmbismarkets.com` at the server, get a certificate
(`apt install certbot python3-certbot-nginx && certbot --nginx`), and proxy:

```nginx
server {
  server_name staff.crmbismarkets.com;
  client_max_body_size 1m;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
  }
}
```

With nginx on the same host, `CRM_TRUSTED_PROXIES=127.0.0.1`. If Cloudflare is
in front, use nginx's `real_ip` module with Cloudflare's published ranges so
`$remote_addr` is the visitor's real IP.

## 6. Keep it healthy

- Daily `mysqldump --single-transaction bismarkets_crm` copied off the server.
- Daily `node dist/cli.mjs verify-audit` from cron; alert if it exits non-zero.
- `unattended-upgrades` for security patches.
