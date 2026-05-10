<p align="center">
  <img src="assets/logo.svg" alt="othoni" width="128" height="128" />
</p>

<h1 align="center">othoni</h1>

<p align="center">
  Self-hosted VPS monitoring dashboard. One Node.js process, one React UI,
  one SQLite file. No agent, no Prometheus, no chart libraries.
</p>

<p align="center">
  <em>Drop it on a VPS &mdash; see live CPU / RAM / disk / network / process /
  Docker / systemd state, 24h history, threshold alerts, and externally-pushed
  custom metrics, all behind a login.</em>
</p>

---

## Features

- Login-gated dashboard (credentials from environment variables)
- Live CPU, RAM, disk usage, swap, load average
- **Per-core CPU grid** — live mini-bar widget on the Dashboard
- **Disk I/O** — read/write bytes/sec per physical device
- **Historical charts** — 24 h of CPU / memory / load / network / disk I/O
  sampled every 5 s, stored in a local SQLite file. Sparklines on dashboard
  cards, plus a dedicated History page with 15m / 1h / 6h / 24h ranges,
  CPU & memory breakdown stacked-area charts, per-core CPU multi-line, and
  multi-series disk + network I/O.
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
- **Webhook destinations** — Slack, Discord, or generic JSON POST
  on every alert fire. Per-destination test button, retry-on-failure
- **Synthetic checks** — periodic HTTP / TCP / ICMP probes recorded
  into the same history store as built-in metrics. Consecutive
  failures dispatch to your webhooks
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

## Stack

- Node.js + Express
- React 18 + Vite
- `systeminformation` for /proc and `df` parsing
- `better-sqlite3` for the historical samples store (single local file,
  WAL mode, ~MB-scale)
- JWT in an httpOnly cookie for auth
- helmet + express-rate-limit for basic hardening

## Requirements

- Linux server (Ubuntu/Debian/RHEL)
- Node.js 18+ and npm

## Install

```bash
git clone <your-fork-or-tarball> /var/www/othoni
cd /var/www/othoni

# Installs both server and client deps and builds the UI
npm install
npm run build
```

## Configure

```bash
cp .env.example .env
# generate a strong JWT secret
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
# paste it into .env as OTHONI_JWT_SECRET
$EDITOR .env
```

`.env` keys:

| Key                     | Default      | Notes                                       |
|-------------------------|--------------|---------------------------------------------|
| `PORT`                  | `8088`       | TCP port to listen on                       |
| `HOST`                  | `0.0.0.0`    | bind address                                |
| `OTHONI_ADMIN_USER`     | `admin`      | login username                              |
| `OTHONI_ADMIN_PASSWORD` | `admin123`   | login password — **change this**            |
| `OTHONI_JWT_SECRET`     | dev secret   | session signing key — **set in production** |
| `OTHONI_SESSION_TTL`    | `12h`        | session length (`12h`, `7d`, etc.)          |
| `OTHONI_DB`             | `data/othoni.db` | path to the historical samples SQLite file |
| `OTHONI_SAMPLE_MS`      | `5000`       | sampling interval in ms                     |
| `OTHONI_PROC_SAMPLE_MS` | `30000`      | process-trends sampling interval in ms      |
| `OTHONI_RETENTION_MS`   | `86400000`   | how long to keep samples (default 24 h)     |
| `OTHONI_LOGS_ENABLED`   | unset        | set `true` to enable `/api/logs` + Logs page |
| `OTHONI_TOTP_SECRET`    | unset        | base32 secret to require a TOTP code on login (see `npm run totp:setup`) |
| `NODE_ENV`              | `production` | `production` on a VPS                       |

## Run in development

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

## Run in production

```bash
npm run build   # builds client/dist
npm start       # starts Express on $PORT
```

Open `http://YOUR_SERVER_IP:8088`.

## Run as a systemd service

A ready-to-edit example is included.

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

## API

All `/api/*` routes (except `/api/health` and `/api/auth/login`) require an
authenticated session.

| Method | Path                | Description                       |
|--------|---------------------|-----------------------------------|
| GET    | `/api/health`       | Public liveness probe             |
| POST   | `/api/auth/login`   | `{username, password}` → cookie   |
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
| GET    | `/api/webhooks`     | List webhook destinations         |
| POST   | `/api/webhooks`     | Add a webhook (label, url, format) |
| PATCH  | `/api/webhooks/:id` | Toggle / rename                   |
| POST   | `/api/webhooks/:id/test` | Fire a synthetic test event  |
| DELETE | `/api/webhooks/:id` | Remove a webhook                  |
| GET    | `/api/checks`       | List synthetic checks + state     |
| POST   | `/api/checks`       | Add an HTTP / TCP / ping check    |
| PATCH  | `/api/checks/:id`   | Toggle / rename / re-tune         |
| POST   | `/api/checks/:id/run` | Run a check immediately         |
| DELETE | `/api/checks/:id`   | Remove a check                    |
| GET    | `/api/history/metrics` | Distinct metric names in the store (`?prefix=`) |
| GET    | `/api/history/processes` | Heaviest processes in a range, with sparklines |
| POST   | `/api/metrics`      | **API key auth.** Push `custom.<name>` metrics |
| GET    | `/api/processes`    | Top processes (`?sortBy=cpu      memory&limit=20`) |
| GET    | `/api/docker`       | Container list, or "not installed"|
| GET    | `/api/services`     | systemd unit status               |
| GET    | `/api/overview`     | Combined snapshot (used by dashboard) |
| GET    | `/api/history`      | Time-series for one metric (`?metric=cpu&range=1h`) |
| GET    | `/api/settings`     | Server-side settings              |

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

## Pushing metrics from an agent

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

Limits: 600 requests/minute per key, 1000 metrics per batch. Pushed
metrics share the same SQLite store and 24h retention as built-in
metrics, and show up automatically under a **Custom** section on the
History page.

## Security notes

- Always change `OTHONI_ADMIN_PASSWORD` and set a unique `OTHONI_JWT_SECRET` in
  production. The defaults exist only to make first-time testing painless.
- Login is rate-limited to 10 attempts / 15 minutes per IP.
- **Optional TOTP 2FA.** Run `npm run totp:setup`, follow the printed
  instructions to add `OTHONI_TOTP_SECRET=...` to `.env`, restart the
  service, and enroll your authenticator app with the printed
  `otpauth://` URL. Once set, every login requires the 6-digit code
  alongside the password. To disable, remove the env var and restart.
- The session cookie is `httpOnly`, `sameSite=lax`, and `secure` when behind HTTPS.
- For internet-facing deployments, put othoni behind nginx + TLS rather than
  exposing port 8088 directly.
- Service status uses `systemctl show`, which works without root for most units.
  If you want Docker support and othoni runs as a non-root user, add that user
  to the `docker` group.

## Project layout

```
othoni/
├── server/              # Express server
│   ├── index.js         # Entry point
│   ├── auth.js          # JWT login/logout
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
├── othoni.service.example
├── .env.example
├── CONTEXT.md           # Project orientation for future contributors
└── package.json
```

## Roadmap (not built yet)

- One-line installer: `curl …/install.sh | bash`
- HTTPS terminator behind a reverse proxy out of the box
- Optional Prometheus `/metrics` exporter
- Per-process kill / service restart actions (opt-in, requires elevated perms)

See `ROADMAP.md` for details and `CHANGELOG.md` for what's already shipped.
