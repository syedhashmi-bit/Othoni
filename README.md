<p align="center">
  <img src="assets/logo.svg" alt="othoni" width="128" height="128" />
</p>

<h1 align="center">othoni</h1>

<p align="center">
  Self-hosted VPS monitoring dashboard built with <strong>Node.js</strong> &amp;
  <strong>React</strong> &mdash; one process, one <strong>SQLite</strong> file.
  No agent, no Prometheus, no chart libraries.
</p>

<p align="center">
  <em>Drop it on a VPS &mdash; see live CPU / RAM / disk / network / process /
  Docker / systemd state, 24h history, threshold alerts, and externally-pushed
  custom metrics, all behind a login.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-20%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js 20+" />
  <img src="https://img.shields.io/badge/React-18-20232A?style=flat-square&logo=react&logoColor=61DAFB" alt="React 18" />
  <img src="https://img.shields.io/badge/Express-4-000000?style=flat-square&logo=express&logoColor=white" alt="Express 4" />
  <img src="https://img.shields.io/badge/Vite-5-646CFF?style=flat-square&logo=vite&logoColor=white" alt="Vite 5" />
  <img src="https://img.shields.io/badge/SQLite-better--sqlite3-003B57?style=flat-square&logo=sqlite&logoColor=white" alt="SQLite via better-sqlite3" />
  <img src="https://img.shields.io/badge/WireGuard-federated-88171A?style=flat-square&logo=wireguard&logoColor=white" alt="WireGuard federated" />
  <img src="https://img.shields.io/badge/License-MIT-3DA639?style=flat-square&logo=opensourceinitiative&logoColor=white" alt="License MIT" />
</p>

---

## 📊 Features

- **Up and running in minutes** — one command installs it; a one-time
  setup link creates your admin account. No domain needed (open it by IP),
  or give it one and the installer sets up HTTPS. Docker works too
- **Accounts** — email + password sign-in with admin and read-only viewer
  roles, managed in Settings → Access; scrypt-hashed passwords, per-IP and
  per-account lockout. Optional **Google sign-in** on top (or instead)
- Live CPU, RAM, disk usage, swap, load average
- **Per-core CPU grid** — live mini-bar widget on the Dashboard
- **Disk I/O** — read/write bytes/sec per physical device
- **Historical charts** — 24 h of CPU / memory / load / network / disk I/O
  sampled every 5 s, stored in a local SQLite file. Sparklines on dashboard
  cards, plus a dedicated History page with 15m / 1h / 6h / 24h ranges,
  CPU & memory breakdown stacked-area charts, per-core CPU multi-line, and
  multi-series disk + network I/O. **Saved views** let you build a custom
  overlay chart from a checkbox grid and persist the selection.
- Per-mount storage usage
- Top 20 processes (by CPU or memory) — plus a **process trends** card
  showing the heaviest named processes in the last 15 min / 1 h / 6 h /
  24 h with a sparkline per process
- Docker container list (graceful fallback if Docker isn't installed)
- systemd service status for common units
- Per-interface network counters and live RX/TX speed
- TCP/UDP socket list — listening ports + active TCP connections (with
  state breakdown) parsed straight from `/proc/net/{tcp,tcp6,udp,udp6}`,
  plus **top-N talkers** (by local port and by remote IP) so SSH
  brute-force / scrape patterns surface immediately
- **Brushable zoom** on every History chart — drag-select to zoom in,
  click "× reset zoom" to clear
- **Threshold alerting** — define rules ("CPU > 90% sustained 5 min")
  on the Alerts page; a notification dot in the topbar shows count and
  severity, click for the active-alerts popover. Server-side evaluator
  on a 10s tick — alerts fire even when no browser is open. Rule fires
  are persisted; the rules table shows a 24h density histogram per rule
  and there's a "Recent fires" timeline below it
- **Webhook destinations** — fire on every alert transition, even with
  no browser open. Formats: generic JSON, Slack, Discord, **Microsoft
  Teams** (Office 365 MessageCard), **email** (SMTP), and the incident
  platforms **PagerDuty** (Events API v2) and **Opsgenie** (Alert API),
  with per-rule host filtering, a per-destination test button, retry-on-
  failure, and a delivery-history strip
- **Synthetic checks** — periodic HTTP / TCP / ICMP / DNS probes recorded
  into the same history store as built-in metrics. Consecutive
  failures dispatch to your webhooks
- **Expiry & dead-man checks** — TLS certificate validity + days to
  expiry, domain registration expiry (RDAP), DNS record-change alerts,
  and heartbeats: cron jobs `curl /ping/<token>` and you're alerted when
  one goes quiet. With actions enabled, a certificate check can trigger
  `certbot renew` for its cert from the dashboard
- **System log feed** (opt-in) — Logs page reads from
  `journalctl --output=json` with priority / since / unit / limit
  filters, **cursor-paginated "load more older"**, **search +
  highlight**, **jump-to-time** anchor, **per-priority count chips**,
  and **saved filter presets**. Off by default — set
  `OTHONI_LOGS_ENABLED=true` to enable. Filters are URL-driven so
  pages are deep-linkable (and firing alerts link directly into a
  pre-filtered view)
- **CSV export** on every History chart — one click downloads the
  in-memory points as a row-per-timestamp CSV
- **External metric ingestion** — generate API keys on the Settings
  page and `POST /api/metrics` from any headless agent / cron / app
  to push `custom.<name>` series into the same store. They show up
  automatically under a "Custom" section on the History page
- Public IP + local IPs, hostname, kernel, OS, uptime
- Settings page for tuning the refresh interval per browser
- Polished dark UI: nav icons, pulsing live indicator, server clock,
  card hover lift, gradient bars, skeleton loaders, page fade-up
- **Refined polish pass** (v0.55–v0.57) — glass-blur popovers
  (alerts dropdown, layout editor, keyboard cheatsheet); gradient
  Logo + primary buttons; lighter table dividers; **top progress
  bar** above the page that sweeps while any poller is in flight;
  smooth count-up tween on dashboard hero numbers; skeleton rows /
  cards on first load so tables never empty-flash; **density quick-
  toggle** in the topbar (cozy / dense) that swaps tighter spacing
  in place; **sticky filter toolbars** on Logs / Processes / Alerts /
  Connections so the filter row stays visible while data scrolls
- **Keyboard shortcuts** — two-key chords (`g d`, `g h`, etc.) to jump
  between pages, `?` for the cheatsheet

## 🧱 Stack

- Node.js + Express
- React 18 + Vite
- `systeminformation` for /proc and `df` parsing
- `better-sqlite3` for the historical samples store (single local file,
  WAL mode, ~MB-scale)
- JWT in an httpOnly cookie for auth; scrypt password hashes
- helmet + express-rate-limit for basic hardening

## 📋 Requirements

- A Linux server with systemd (Ubuntu / Debian / RHEL family)
- Node.js 20+ and npm — the installer sets up Node 24 if Node is missing,
  older, or came without npm (Debian's and Ubuntu's own `nodejs` package
  doesn't include it)
- Optional: a domain name pointing at the server, for HTTPS — the
  installer gets the certificate for you (nginx + Let's Encrypt). Without
  one, open the dashboard by IP over plain http
- Or just Docker — see [Docker](#-docker)

## ⚡ Install — one-liner

```bash
curl -fsSL https://raw.githubusercontent.com/syedhashmi-bit/Othoni/main/install.sh | sudo bash
```

A short **guided setup** asks a few questions — mainly whether the
dashboard gets a domain name. Leave it blank and it's opened by IP
(`http://<server-ip>:8088`); give one and the installer sets up nginx with
a Let's Encrypt certificate. It then installs everything (git, Node, the
app, a systemd service) and ends with a one-time link:

```
  ➜  Create your admin account (one-time link):

        http://203.0.113.7:8088/setup?code=K7Q2-9XMP
```

Open it, pick an email and password, and you're in. Add more people (admin
or read-only viewer) in **Settings → Access → Accounts**.

```bash
# unattended (CI / image build — skips the questions), opened by IP:
curl -fsSL https://raw.githubusercontent.com/syedhashmi-bit/Othoni/main/install.sh \
  | sudo OTHONI_NONINTERACTIVE=1 bash

# …or on a domain with HTTPS:
curl -fsSL https://raw.githubusercontent.com/syedhashmi-bit/Othoni/main/install.sh \
  | sudo OTHONI_PUBLIC_URL=https://othoni.example.com OTHONI_SETUP_TLS=1 \
         OTHONI_NONINTERACTIVE=1 bash

# upgrade an existing install (re-running is idempotent):
sudo bash /var/www/othoni/install.sh
```

Lost the setup link? `sudo cat /var/www/othoni/data/setup-code` and open
`/setup`. Forgot your password? `sudo node /var/www/othoni/scripts/reset-password.js
you@example.com` prints a new one.

Defaults: install at `/var/www/othoni`; listen on `0.0.0.0:8088` without a
domain (the installer opens the port if ufw / firewalld is on), or on
`127.0.0.1:8088` behind nginx with one (see [HTTPS](#https)). Tunable via
env vars; see the comment block at the top of `install.sh`.

## 🐳 Docker

```bash
git clone https://github.com/syedhashmi-bit/Othoni.git othoni && cd othoni
docker compose up -d
docker compose logs othoni     # → "create the first admin at http://…/setup?code=…"
```

Then open `http://<server-ip>:8088` (the setup link in the log has
`<this-server-ip>` in it — put the server's address there). Settings go in
an optional `.env` next to `docker-compose.yml` (see `.env.example`); data
lives in `./data`.

othoni watches the *host*, so the compose file runs it with the host's
network and process list, the host filesystem mounted read-only, and the
Docker socket for the Docker page (root-equivalent access — drop that
volume if you'd rather not). Some features need the host itself and don't
work in the container: the Services page and its actions (systemctl), the
Logs page (journalctl), certbot renewals, and the firewall / login checks
in the security audit. Use the installer when you want those.

## 🔧 Install — manual

```bash
git clone <your-fork-or-tarball> /var/www/othoni
cd /var/www/othoni

# Installs both server and client deps and builds the UI
npm install
npm run build
```

## ⚙️ Configure

```bash
cp .env.example .env
$EDITOR .env
```

Nothing in it is required — othoni generates its session secret in
`data/session-secret` on first start. On first start it also logs a
one-time **setup link** (`/setup?code=…`; the code is in
`data/setup-code`) that creates the first admin account.

### Accounts

People sign in with an email and password. The first admin comes from the
setup link; after that, admins add, disable and remove accounts and reset
passwords in **Settings → Access → Accounts**, and everyone can change their
own under **Your password**. Viewers see every page but can't change
anything. Five wrong passwords from one IP (or twenty against one account
from anywhere) lock it for 15 minutes.

Locked out? On the server: `sudo node scripts/reset-password.js
you@example.com` (Docker: `docker compose exec othoni node
scripts/reset-password.js you@example.com`) sets and prints a new password.
Run it without an email to list the accounts.

`OTHONI_PASSWORD_LOGIN=off` turns password sign-in off — for a Google-only
instance, or a federation peer nobody signs into directly.

### Google sign-in

Optional: let people sign in with their Google account as well — or, with
`OTHONI_PASSWORD_LOGIN=off`, instead. It needs a domain with HTTPS (Google
won't send people back to a bare IP). Setting it up is free and takes
about five minutes in [Google Cloud Console](https://console.cloud.google.com/auth/overview):

1. **Pick a project** — create one (e.g. "othoni"), or reuse one you
   already have for another app.
2. **Set up the consent screen** — *Google Auth Platform → Get started*
   (*APIs & Services → OAuth consent screen* in older consoles). Give it an
   app name and your email; for the audience pick **External** (or
   **Internal** if everyone signing in is in your Google Workspace).
3. **Let your accounts through.** A new External app is in *Testing*: only
   accounts listed under **Audience → Test users** can sign in, and anyone
   else gets Google's "Access blocked" page. Add every email you'll put in
   `OTHONI_ADMIN_EMAILS` / `OTHONI_VIEWER_EMAILS` there — or click
   **Publish app**. othoni only asks for `openid` + `email`, so publishing
   needs no Google review.
4. **Create the client** — *Clients → Create client → Web application*,
   with one **Authorized redirect URI**:

   ```
   https://<your-othoni-host>/api/auth/google/callback
   ```

5. Copy the client ID and secret into `.env` (the installer asks for them
   too):

   ```bash
   OTHONI_PUBLIC_URL=https://<your-othoni-host>
   OTHONI_GOOGLE_CLIENT_ID=<client id>.apps.googleusercontent.com
   OTHONI_GOOGLE_CLIENT_SECRET=<client secret>
   OTHONI_ADMIN_EMAILS=you@example.com
   # OTHONI_VIEWER_EMAILS=teammate@example.com   # read-only accounts
   ```

Only those emails can sign in with Google; any other Google account is
turned away. (They're separate from the email + password accounts.)
The allowlist is checked on every request, so removing or demoting an
email and restarting othoni takes effect immediately, even for open
sessions. **Settings → Access → Google sign-in** shows the current list
and the exact redirect URI the server expects.

If sign-in fails at Google's end:

- **`Error 400: redirect_uri_mismatch`** — the redirect URI on the client
  doesn't exactly match `OTHONI_PUBLIC_URL` + `/api/auth/google/callback`
  (check `https`, the hostname, and no trailing slash).
- **"Access blocked" / `Error 403: access_denied`** — the app is still in
  Testing and that account isn't a test user (step 3).
- **`Error 401: invalid_client`** — the client ID or secret in `.env` is
  wrong; restart othoni after fixing it.

### HTTPS

With a domain, othoni runs behind nginx with a Let's Encrypt certificate —
so passwords never cross the internet in plain text, and Google sign-in
becomes possible. The installer sets that up when you give it a domain and
say yes (or pass `OTHONI_SETUP_TLS=1`): it installs nginx + certbot,
writes `/etc/nginx/sites-available/othoni` (`conf.d/othoni.conf` on RHEL),
opens ports 80/443 if ufw or firewalld is on, and runs `certbot --nginx`,
which also sets up automatic renewal. The Let's Encrypt account email is
the first admin email unless you set `OTHONI_TLS_EMAIL`. It never touches an
nginx site that already serves the same hostname.

To add it to an existing install, re-run the installer with the flag
(and the address, if the install doesn't have one yet):

```bash
sudo OTHONI_PUBLIC_URL=https://othoni.example.com OTHONI_SETUP_TLS=1 \
  bash /var/www/othoni/install.sh
```

Or do it by hand — `nginx-othoni.conf.example` walks through the same steps.
If certbot fails, it's almost always DNS not pointing at the server yet or
port 80 blocked by a cloud firewall / security group.

`.env` keys:

| Key                     | Default      | Notes                                       |
|-------------------------|--------------|---------------------------------------------|
| `PORT`                  | `8088`       | TCP port to listen on                       |
| `HOST`                  | `127.0.0.1`  | bind address — loopback by default; set `0.0.0.0` only to expose the port directly |
| `OTHONI_PUBLIC_URL`     | unset        | the https origin browsers use (e.g. `https://othoni.example.com`): makes the session cookie https-only and builds the Google redirect URI. Required for Google sign-in |
| `OTHONI_PASSWORD_LOGIN` | `on`         | email + password sign-in and the first-run setup link; `off` for Google-only (or a federation peer) |
| `OTHONI_LOGIN_LOCKOUT_FAILS` | `5`     | wrong passwords from one IP before it's locked out |
| `OTHONI_LOGIN_LOCKOUT_USER_FAILS` | `20` | wrong passwords against one account (from any IP) before it's locked |
| `OTHONI_LOGIN_LOCKOUT_MS` | `900000`   | lockout length (15 min) |
| `OTHONI_TRUST_PROXY`    | `loopback`   | which reverse proxies may set `X-Forwarded-For` / `-Proto` — by default only one on this machine, so clients reaching othoni directly can't fake their IP. Any Express "trust proxy" value |
| `OTHONI_GOOGLE_CLIENT_ID` | unset      | optional: Google OAuth "Web application" client ID |
| `OTHONI_GOOGLE_CLIENT_SECRET` | unset  | its client secret |
| `OTHONI_ADMIN_EMAILS`   | unset        | comma-separated Google emails allowed in as **admin** |
| `OTHONI_VIEWER_EMAILS`  | unset        | comma-separated Google emails allowed in as read-only **viewer** |
| `OTHONI_JWT_SECRET`     | generated    | session signing key; unset → generated once in `data/session-secret`. If set, 32+ random characters |
| `OTHONI_SESSION_TTL`    | `12h`        | session length (`12h`, `7d`, etc.)          |
| `OTHONI_DB`             | `data/othoni.db` | path to the historical samples SQLite file |
| `OTHONI_SAMPLE_MS`      | `5000`       | sampling interval in ms                     |
| `OTHONI_PROC_SAMPLE_MS` | `30000`      | process-trends sampling interval in ms      |
| `OTHONI_RETENTION_MS`   | `86400000`   | how long to keep samples (default 24 h)     |
| `OTHONI_DISK_MIN_FREE_PCT` | `5`       | pause history writes (and set `storage.degraded` on `/api/health`) when the data partition drops below this % free |
| `OTHONI_NET_IFACE_ALLOW` | unset       | comma list (with `eth+` prefix syntax) pinning which interfaces get per-interface history series; unset = keep all but ephemeral container/CNI interfaces |
| `OTHONI_WEBHOOK_COOLDOWN_MS` | `30000`  | per-(destination, rule) cooldown so a flapping alert can't hammer a webhook; `0` disables |
| `OTHONI_LOGS_ENABLED`   | unset        | set `true` to enable `/api/logs` + Logs page |
| `OTHONI_PROMETHEUS_TOKEN` | unset      | Bearer token for the optional `/metrics` Prometheus exporter (off when unset) |
| `OTHONI_PEER_TOKEN`     | unset        | shared secret (≥16 chars) that lets a *central* othoni read this instance over the federation proxy. When set, `Authorization: Bearer <token>` is accepted as a read-only (viewer) session. Off when unset |
| `OTHONI_ROLE`           | `full`       | set `peer` for a lightweight federation-peer mode: still samples + serves its own metrics, but skips the process-trends sampler, alert engine, synthetic checks, and security-audit auto-run. Trims CPU + the periodic `ps`/`systemctl`/`ufw`/`iptables` spawns on a small VPS |
| `OTHONI_GEOLOCATE`      | `on`         | fleet-map auto-location: each instance looks up its **own** public-IP location once (cached 7 days in `data/geo-cache.json`) so VPS appear on the map without manual placement. A manually-set location always wins. Set `off` to disable the outbound lookup. Default provider is `ip-api.com` (HTTP, no key — only your own non-sensitive public-IP location is looked up); point `OTHONI_GEO_PROVIDER` at an HTTPS endpoint to avoid the plain-HTTP call |
| `OTHONI_PAGERDUTY_URL`  | `https://events.pagerduty.com/v2/enqueue` | override the PagerDuty Events API endpoint (set the EU host for EU tenants) |
| `OTHONI_OPSGENIE_URL`   | `https://api.opsgenie.com/v2/alerts` | override the Opsgenie Alert API endpoint (use `api.eu.opsgenie.com` for the EU region) |
| `OTHONI_ACTIONS_ENABLED`| unset        | Set `true` to enable opt-in write actions (systemd restart, Docker, process signal, security remediations, `certbot renew`) |
| `OTHONI_LETSENCRYPT_RENEWAL_DIR` | `/etc/letsencrypt/renewal` | Where the `certbot.renew` action looks up renewable cert names (one `<name>.conf` per cert) |
| `NODE_ENV`              | `production` | `production` on a VPS                       |

## 🛠️ Run in development

In one terminal:

```bash
# Backend with auto-reload (just node, no nodemon — restart manually)
npm run dev
```

In another:

```bash
# Vite dev server with hot reload, proxies /api to the backend
npm --prefix client run dev
```

Open http://localhost:5173 in your browser.

## 🚀 Run in production

```bash
npm run build   # builds client/dist
npm start       # starts Express on $HOST:$PORT (127.0.0.1:8088 by default)
```

By default othoni only listens on localhost — put nginx in front (see
[HTTPS](#https)) and open `OTHONI_PUBLIC_URL`, or set `HOST=0.0.0.0` and
open `http://<server-ip>:8088`.

## 🔁 Run as a systemd service

A ready-to-edit example is included (the installer does this for you). It
runs `/usr/bin/node` — if `command -v node` says otherwise, fix `ExecStart=`
after copying it.

```bash
sudo cp /var/www/othoni/othoni.service.example /etc/systemd/system/othoni.service
sudo systemctl daemon-reload
sudo systemctl enable --now othoni
sudo systemctl status othoni
sudo journalctl -u othoni -f
```

To upgrade:

```bash
cd /var/www/othoni
git pull           # or replace files some other way
npm install
npm run build
sudo systemctl restart othoni
```

## 🔌 API

All `/api/*` routes (except `/api/health`, sign-in and first-run setup)
require an authenticated session.

| Method | Path                | Description                       |
|--------|---------------------|-----------------------------------|
| GET    | `/api/health`       | Public liveness probe             |
| GET/POST | `/ping/:token`    | Public heartbeat ping (token = credential; 404 if unknown) |
| POST   | `/api/auth/login`   | `{email, password}` → session cookie |
| GET    | `/api/setup`        | Public: `{needed}` — is the first admin still to be created? |
| POST   | `/api/setup`        | `{code, email, password}` → creates the first admin, session cookie |
| POST   | `/api/account/password` | Change your own password (`{current, password}`) |
| GET    | `/api/accounts`     | Admin: list accounts |
| POST   | `/api/accounts`     | Admin: add an account (`{email, password, role}`) |
| PATCH  | `/api/accounts/:id` | Admin: reset password (`{password}`) / disable (`{disabled}`) |
| DELETE | `/api/accounts/:id` | Admin: remove an account |
| GET    | `/api/auth/google`  | Starts Google sign-in (browser redirect) |
| GET    | `/api/auth/google/callback` | Google redirects back here → session cookie, then `/` |
| POST   | `/api/auth/logout`  | Clears session cookie             |
| GET    | `/api/auth/me`      | Current user                      |
| GET    | `/api/system`       | Hostname, OS, kernel, IPs, uptime |
| GET    | `/api/cpu`          | CPU usage, per-core, load average |
| GET    | `/api/memory`       | RAM and swap                      |
| GET    | `/api/disks`        | Mounted filesystems               |
| GET    | `/api/network`      | Per-interface counters + speed    |
| GET    | `/api/diskio`       | Per-device disk read/write bytes/sec |
| GET    | `/api/connections`  | TCP/UDP socket list + state summary |
| GET    | `/api/logs`         | journalctl JSON feed (opt-in)     |
| GET    | `/api/keys`         | List API keys (metadata only)     |
| POST   | `/api/keys`         | Generate a new API key (returns plaintext once) |
| DELETE | `/api/keys/:id`     | Revoke an API key                 |
| GET    | `/api/alerts/rules` | List alert rules                  |
| PUT    | `/api/alerts/rules` | Replace the entire rules list     |
| GET    | `/api/alerts/active` | Currently-firing alerts (pre-formatted) |
| GET    | `/api/alerts/metrics` | Available metric keys + units   |
| GET    | `/api/alerts/stats` | Per-rule fire counts + density histogram |
| GET    | `/api/alerts/history` | Recent rule-fire timeline (denormalized) |
| GET    | `/api/alerts/silences` | Active mute windows (global / per-rule) |
| POST   | `/api/alerts/silences` | Mute a rule or all rules (`{ scope, ruleId?, durationMs }`) |
| DELETE | `/api/alerts/silences/:id` | End a silence early |
| GET    | `/api/webhooks`     | List webhook destinations         |
| POST   | `/api/webhooks`     | Add a webhook (label, url, format) |
| PATCH  | `/api/webhooks/:id` | Toggle / rename                   |
| POST   | `/api/webhooks/:id/test` | Fire a synthetic test event  |
| GET    | `/api/webhooks/:id/deliveries` | Recent delivery history (`?range=`, `?limit=`) |
| DELETE | `/api/webhooks/:id` | Remove a webhook                  |
| GET    | `/api/checks`       | List synthetic checks + state     |
| POST   | `/api/checks`       | Add an HTTP / TCP / ping check    |
| PATCH  | `/api/checks/:id`   | Toggle / rename / re-tune         |
| POST   | `/api/checks/:id/run` | Run a check immediately         |
| DELETE | `/api/checks/:id`   | Remove a check                    |
| GET    | `/api/history/metrics` | Distinct metric names in the store (`?prefix=`) |
| GET    | `/api/history/processes` | Heaviest processes in a range, with sparklines |
| POST   | `/api/metrics`      | **API key auth.** Push `custom.<name>` metrics |
| POST   | `/api/security-audit/ingest` | **API key auth.** Push a remote host's `{ host, findings }` audit |
| GET    | `/api/security-audit/hosts`  | Remote hosts reporting audits, with latest summary |
| GET    | `/api/security-audit/hosts/:host` | One remote host's latest run + findings |
| GET    | `/api/peers`        | List registered federation peers (token stripped) |
| PUT    | `/api/peers/:host`  | Register / update a peer (`{ url, token, label, lat, lon, place }`) |
| DELETE | `/api/peers/:host`  | Remove a peer                     |
| GET    | `/api/fleet/:host/*`| Read-only reverse proxy to a peer (GET-only; forwards `/api/*`) |
| GET    | `/api/processes`    | Top processes (`?sortBy=cpu      memory&limit=20`) |
| GET    | `/api/docker`       | Container list, or "not installed"|
| GET    | `/api/services`     | systemd unit status               |
| GET    | `/api/overview`     | Combined snapshot (used by dashboard) |
| GET    | `/api/history`      | Time-series for one metric (`?metric=cpu&range=1h`) |
| GET    | `/api/settings`     | Server-side settings              |
| GET    | `/api/db/stats`     | SQLite store footprint + per-table + per-metric counts |
| GET    | `/api/audit`        | Audit-log events (`?range=`, `?action=`, `?limit=`) |
| GET    | `/api/audit/actions`| Whitelist of audited action names |
| GET    | `/api/hosts`        | Auto-discovered hosts pushing `custom.<host>.*` metrics (+ a `self` node for the local box) |
| GET    | `/api/actions`      | Opt-in action surface state + registered kinds (`enabled:false` when off) |
| POST   | `/api/actions/run`  | Run an action (404 when `OTHONI_ACTIONS_ENABLED` is unset) |
| GET    | `/api/actions/history` | Action invocation history with full stdout/stderr |
| GET    | `/api/actions/history/actors` | Distinct actors for the history page actor filter |

`/api/history` accepts these metrics:

- **Composite gauges**: `cpu`, `mem`, `swap`, `load1`, `disk_root`,
  `conn.established`, `conn.timewait`, `conn.listening`, `conn.total`
- **CPU breakdown** (percent): `cpu.user`, `cpu.system`, `cpu.idle`
- **Memory breakdown** (bytes): `mem.active`, `mem.cached`, `mem.buffers`,
  `mem.free`
- **Network** (bytes/sec, summed): `net_rx`, `net_tx`
- **Disk I/O** (bytes/sec, summed): `disk.read`, `disk.write`
- **Per-core CPU** (percent): `cpu.core.0`, `cpu.core.1`, … one per logical
  core
- **Per-interface network** (bytes/sec): `net.iface.<name>.rx`,
  `net.iface.<name>.tx` — one per non-loopback / non-`veth*` interface
- **Per-disk I/O** (bytes/sec): `disk.dev.<name>.read`,
  `disk.dev.<name>.write` — one per physical block device

`range ∈ {15m, 1h, 6h, 24h}`. Responses are downsampled to ≤500 points per
request (averaged within fixed-width time buckets), so the payload is small
regardless of the requested span.

## 📡 Pushing metrics from an agent

1. Go to **Settings** → **API keys** in the dashboard, enter a label,
   and click **Generate**. Copy the key immediately — only the SHA-256
   hash is stored.
2. From any process, `POST` to `/api/metrics` with the key in the
   `Authorization` header. Metric names must start with `custom.`.

```bash
# Single metric
curl -X POST https://othoni.example.com/api/metrics \
  -H "Authorization: Bearer othoni_<your-key>" \
  -H "Content-Type: application/json" \
  -d '{"name":"custom.app.requests_per_sec","value":42}'

# Batch (up to 1000 rows / 256 KB per request)
curl -X POST https://othoni.example.com/api/metrics \
  -H "Authorization: Bearer othoni_<your-key>" \
  -H "Content-Type: application/json" \
  -d '{"metrics":[
        {"name":"custom.app.requests","value":42},
        {"name":"custom.app.errors","value":3}
      ]}'
```

Optional `t` field on each metric (unix milliseconds) for backfill.
Defaults to "now" on the server.

### Multi-host attribution

If multiple machines push to the same othoni, send a `host` field. The server
splices it into the metric name so each host's series stays distinct, and the
History page groups the Custom section by host:

```bash
# top-level host (applies to every row in the batch)
curl -X POST https://othoni.example.com/api/metrics \
  -H "Authorization: Bearer othoni_<your-key>" \
  -H "Content-Type: application/json" \
  -d '{
        "host": "app-server-1",
        "metrics": [
          {"name":"custom.requests","value":42},
          {"name":"custom.errors","value":0}
        ]
      }'
# stored as custom.app-server-1.requests, custom.app-server-1.errors
```

Host names must match `[a-z0-9-]{1,40}` (DNS-style). Existing agents that
don't send `host` continue to write `custom.<leaf>` and show up under
"Custom · ungrouped" — fully backwards compatible, no migration.

Limits: 600 requests/minute per key, 1000 metrics per batch. Pushed
metrics share the same SQLite store and 24h retention as built-in
metrics, and show up automatically under a **Custom** section on the
History page.

### Bundled `agent.sh` for remote hosts

If you just want a stock CPU / mem / load / disk / network feed from
another box, ship the bundled POSIX shell agent — no Node, no binary,
no dependencies beyond `awk`, `curl`, and `/proc`:

```bash
# Copy agent.sh to the remote host:
scp agent.sh root@app-server-1:/usr/local/bin/othoni-agent

# Run it (foreground, one-shot or long-lived):
OTHONI_URL=https://othoni.example.com \
OTHONI_API_KEY=othoni_<your-key> \
OTHONI_HOST=app-server-1 \
  /usr/local/bin/othoni-agent
```

For a long-lived install, drop the bundled
`othoni-agent.service.example` into `/etc/systemd/system/` and point
its `EnvironmentFile=` at `/etc/othoni-agent.env`. The agent runs
under `DynamicUser=` (only needs to read `/proc` and talk to your
dashboard).

The agent pushes `custom.cpu`, `custom.mem`, `custom.load1`,
`custom.disk_root`, `custom.net_rx`, and `custom.net_tx` every
`OTHONI_INTERVAL` seconds (default 30, min 5). Combined with the
v0.23.0 host attribution, they land in the central store as
`custom.<host>.cpu` etc., and show up grouped by host on the
History page's Custom section.

Set `OTHONI_AUDIT=1` to also push a lightweight security audit (SSH
root/password/empty-password login, pending reboot, apt updates, ufw
state) to `POST /api/security-audit/ingest` on startup and then every
`OTHONI_AUDIT_INTERVAL` seconds (default 3600, min 300). Each host then
appears in the **Remote hosts** section of the Security page, with its
findings diffed against the previous push and new crits dispatched to
your webhooks. The checks are read-only; some (ufw) need root, the rest
work as any user.

Every reporting host appears in the **host switcher** dropdown in the
dashboard's top bar — pick one to jump to its `/hosts/:host` view.

If your dashboard sits behind a CDN/proxy (e.g. Cloudflare) whose bot
challenge blocks the key-authenticated agent, set `OTHONI_ORIGIN_IP` to
the origin server's IP. The agent then connects straight to that IP
(`curl --resolve`) while still using the `OTHONI_URL` hostname for SNI,
the `Host` header, and certificate validation — TLS stays verified
end-to-end; only DNS is bypassed. The origin must accept direct
connections (open its firewall to the agent's IP on the dashboard's port).

## 🌐 Federation — full remote dashboards

The agent above gives you a host's **metrics**. To see another VPS's
*complete* dashboard — Storage, Processes, Docker, Services, Projects,
Network, Connections, Alerts, Checks, Security, Logs, History, all of it —
run a full othoni instance on that box and register it as a **peer**.

**Quick path — `scripts/deploy-peer.sh`.** Get the othoni code onto the
remote box (rsync/git), make sure its private transport is up, then run:

```bash
sudo bash scripts/deploy-peer.sh           # auto-detects the wg0 address
sudo bash scripts/deploy-peer.sh 10.8.0.5  # or pass the bind IP explicitly
```

It checks Node ≥20, runs `npm ci` + the client build, writes a production
`.env` bound to that IP with a freshly-generated `OTHONI_PEER_TOKEN` and
`OTHONI_JWT_SECRET`, and `OTHONI_PASSWORD_LOGIN=off` (no sign-in — a peer
is read through the central),
installs and starts the `othoni`
systemd unit, opens the transport subnet through `ufw` if active,
smoke-tests `/api/health`, and prints the exact **host / url / token** to
register on the central. It's idempotent — re-runs re-point `HOST`/`PORT`
but never rotate existing secrets.

**Manual path.**

1. On the remote VPS, install othoni normally and set
   `OTHONI_PEER_TOKEN` to a long random string (≥16 chars). Bind it to an
   address the central can reach privately — e.g. its WireGuard IP
   (`HOST=10.8.0.5`). The token grants **read-only** (viewer) access: a
   holder can GET every page but can never change anything.
2. On the central othoni, open **Settings → Federated peers** and add the
   peer: a `host` label, its `url` (e.g. `http://10.8.0.5:8088`), and the
   same token. (Stored in `data/peers.json`, mode 0600; the token is never
   returned by the API.)
3. The peer now appears in the top-bar **host switcher** under "Federated
   hosts". Pick it and every data page re-fetches that host's live stats
   through the central's read-only proxy (`GET /api/fleet/:host/*`). A
   `remote · <host>` chip marks the remote view; "This server (live)"
   returns to the local box. Account and fleet management always stay on
   the central instance.

Because the central proxy is **read-only**, mutating controls (restart a
project, edit alert rules, run a remediation) are disabled for a remote
host — they'd return 405. To change a peer's configuration, log into that
peer's own UI directly.

Run the peer over a private transport (WireGuard, a VPN, or a firewalled
internal network) — the peer token is a bearer credential, so don't expose
the peer's port to the open internet. Since the transport already encrypts
the link, a plain `http://` peer URL is fine. There's a full walkthrough
(including the WireGuard setup) in [`docs/federation-peers.md`](docs/federation-peers.md).

**Fleet map.** The **Hosts** page renders a hand-drawn SVG world map with a
dot per VPS (local box, agent hosts, and federation peers), colored by
freshness. No map library, tiles, or GeoIP — locations are set per host/peer
under **Settings** by picking a region from a preset list (or entering
lat/lon). Hosts without a location show as "unplaced" beneath the map.

**Lightweight peer mode.** Set `OTHONI_ROLE=peer` on a federation peer to skip
the subsystems a read-only peer doesn't need — the process-trends sampler, the
alert engine, synthetic checks, and the security-audit auto-run. It still
samples and serves its own metrics for the central to read; it just stops
running the monitoring loops (and their periodic `ps`/`systemctl`/`ufw`/
`iptables` spawns), which trims CPU and memory on a small VPS.

## 🔒 Security notes

- The session secret is generated per install (`data/session-secret`, 0600)
  unless `OTHONI_JWT_SECRET` is set. With `NODE_ENV=production` the server
  **refuses to start** on a known-default or short JWT secret, or a
  half-filled Google sign-in config — fail-closed, so a misconfigured deploy
  can't serve a forgeable session.
- **First-run setup is code-gated.** Until the first admin exists, `/setup`
  needs the one-time code from `data/setup-code` (0600; also in the
  installer output and the service log), so whoever reaches a new instance
  first can't claim it. Wrong codes count toward the lockout.
- **Passwords** are hashed with scrypt (`data/accounts.json`, 0600). Logins
  are rate-limited per IP and locked out after 5 failures per IP or 20 per
  account; unknown emails take as long as wrong passwords. Every request
  re-checks the account, so deleting, disabling or resetting it ends that
  person's sessions immediately.
- **Google sign-in** (optional) runs the standard OIDC authorization-code
  flow with PKCE, a `state` bound to the browser by a short-lived cookie,
  and a `nonce`; the ID token's RS256 signature is checked against Google's
  published keys, along with its audience, issuer and nonce, and only a
  **verified** email on the allowlist gets a session.
- Session and CSRF cookies are `HttpOnly` (session) and `SameSite=Lax`,
  and `Secure` whenever `OTHONI_PUBLIC_URL` is https or the request came in
  over https.
- `X-Forwarded-For` is only trusted from a proxy on the same machine
  (`OTHONI_TRUST_PROXY`), so a client reaching port 8088 directly can't
  dodge the per-IP limits by faking its address.
- Plain http (the no-domain install) sends passwords unencrypted — fine on
  a private network. For anything reachable from the internet, give it a
  domain and HTTPS ([HTTPS](#https)); the login page warns when it's on
  plain http.
- Service status uses `systemctl show`, which works without root for most units.
  If you want Docker support and othoni runs as a non-root user, add that user
  to the `docker` group.

## 📁 Project layout

```
othoni/
├── server/              # Express server
│   ├── index.js         # Entry point
│   ├── auth.js          # session cookie, password + Google sign-in, setup, logout
│   ├── accounts.js      # email + password accounts (data/accounts.json)
│   ├── setup.js         # first-run setup code
│   ├── login-lockout.js # per-IP / per-account wrong-password lockout
│   ├── password-hash.js # scrypt
│   ├── google-auth.js   # Google OIDC: PKCE flow, ID-token checks, allowlist
│   ├── middleware.js    # Rate limiter etc.
│   ├── logger.js        # Tiny console logger
│   ├── history.js       # SQLite sampler + query helper
│   ├── routes/          # /api/* handlers
│   └── collectors/      # /proc, df, ps, systemctl, docker, diskio, …
├── client/              # React + Vite UI
│   ├── src/
│   │   ├── App.jsx
│   │   ├── api.js
│   │   ├── Logo.jsx     # Brand mark (SVG)
│   │   ├── Icons.jsx    # Monochrome SVG icon set
│   │   ├── Charts.jsx   # Sparkline / LineChart / MultiLineChart /
│   │   │                #   StackedAreaChart / CoreGrid (all pure SVG)
│   │   ├── alerts.js    # Threshold rule engine (pure functions, localStorage)
│   │   ├── AlertsPopover.jsx  # Topbar bell + active-alerts popover
│   │   ├── pages/       # Dashboard, History, Storage, …, Connections, Alerts
│   │   └── styles.css
│   └── dist/            # Built assets (after `npm run build`)
├── data/                # Created at runtime — SQLite samples DB
├── agent.sh             # POSIX shell metrics agent for remote hosts
├── othoni.service.example
├── othoni-agent.service.example
├── install.sh
├── nginx-othoni.conf.example
├── .env.example
├── CONTEXT.md           # Project orientation for future contributors
└── package.json
```

## 📈 Optional Prometheus exporter

Set `OTHONI_PROMETHEUS_TOKEN` in `.env` and restart the service. Then point
your Prometheus job at the dashboard:

```yaml
- job_name: othoni
  scheme: https
  static_configs:
    - targets: ['othoni.example.com']
  authorization:
    type: Bearer
    credentials_file: /etc/prometheus/othoni.token
```

The exporter is off when the env var is unset (`/metrics` returns 404 in
that state, so the endpoint isn't even advertised). Generate a random token
with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

## 🗺️ Roadmap (not built yet)

- **Alert-rule silencing / mute windows** — suppress a rule (or all
  rules) during planned maintenance while still recording the suppressed
  fire
- **On-call rotation** — time-window routing so different webhook
  destinations receive alerts on a schedule

See `ROADMAP.md` for details and `CHANGELOG.md` for what's already shipped.
