# othoni — progress

Snapshot of where the project stands, mapped to the v1 requirements you
originally listed. Update as features land.

Legend: `[x]` done · `[~]` partial · `[ ]` not started

## v1 features

### 1. Login page
- [x] Login form, JWT session cookie
- [x] Credentials read from `OTHONI_ADMIN_USER` / `OTHONI_ADMIN_PASSWORD`
- [x] All `/api/*` data routes require auth
- [x] Rate limiting on the login endpoint (10/15min/IP)

### 2. Main dashboard
- [x] CPU, RAM, disk, network, uptime, load average cards
- [x] Hostname, OS, kernel, public IP, local IPs
- [x] Auto-refresh every 5 s (configurable in Settings)
- [x] Pauses when the browser tab is hidden

### 3. Storage section
- [x] Per-mount table: mount point, filesystem, total / used / free, %
- [x] Human-readable byte formatting
- [x] Pseudo filesystems (`tmpfs`, `overlay`, etc.) hidden

### 4. Running apps section
- [x] Top 20 processes via `ps`
- [x] Columns: PID, name, CPU%, MEM%, user, command
- [x] Toggle sort by CPU or memory

### 5. Docker section
- [x] Parses `docker ps -a` JSON output
- [x] Columns: name, image, state, status, ports
- [x] Friendly "not detected" / "permission denied" messages

### 6. Services section
- [x] Default list: nginx, apache2, docker, ssh/sshd, postgresql, mysql,
      mariadb, redis, redis-server, mongodb, mongod
- [x] Status per unit: active / inactive / failed / activating / missing
- [x] Uses `systemctl show` (no `sudo` needed for read-only state)

### 7. Network section
- [x] Per-interface RX/TX bytes
- [x] Live RX/TX speed (B/s) by diffing `/proc/net/dev` between requests
- [x] Error counters surfaced in the table

### 8. API endpoints
- [x] `/api/health` (public)
- [x] `/api/system`, `/api/cpu`, `/api/memory`, `/api/disks`, `/api/network`
- [x] `/api/processes`, `/api/docker`, `/api/services`
- [x] `/api/overview` (combined snapshot for the dashboard)
- [x] `/api/settings`
- [x] All protected routes return 401 without a valid session

### 9. Linux data collection
- [x] Reads `/proc/net/dev` directly for network counters
- [x] `systeminformation` library reads `/proc/{stat,meminfo,loadavg,uptime}`
      and shells out to `df` under the hood
- [x] `ps` and `systemctl` invoked via `execFile` (no shell, no destructive
      flags)
- [x] Works as non-root for everything except Docker socket (documented)
- [x] Permission failures surfaced as friendly UI messages

### 10. UI style
- [x] Dark theme (#0b0f17 / #161d2e palette)
- [x] Sidebar with sections, top status bar
- [x] Rounded cards with subtle shadow
- [x] Green / yellow / red thresholds (75% warn, 90% crit)
- [x] Mobile breakpoint at 768 px (sidebar collapses to top scroller)

### 11. Settings page
- [x] Shows port, host, hostname, version, current user, NODE_ENV
- [x] Refresh interval picker (2 s, 5 s, 10 s, 30 s, 1 min) saved in
      `localStorage`

### 11b. History & charts (added v0.2.0)
- [x] In-process SQLite sampler — every 5 s, 24 h retention
- [x] Metrics tracked: `cpu`, `mem`, `swap`, `load1`, `net_rx`, `net_tx`,
      `disk_root`
- [x] `GET /api/history?metric=&range=` with on-the-fly bucket averaging
      (≤500 points per response)
- [x] Pure-SVG `<Sparkline>` + `<LineChart>` (no charting library)
- [x] Sparklines on Dashboard cards (CPU, RAM, Disk, Network)
- [x] Dedicated `/history` page with 15m / 1h / 6h / 24h range selector
- [x] Hover tooltip on the full charts (shows time + value of nearest sample)
- [x] DB path / sample interval / retention all configurable via env vars

### 11c. Branding (added v0.2.0)
- [x] SVG `<Logo>` (concentric rings + glowing dot in the accent color)
      used in sidebar, topbar, and login card
- [x] Inline data-URI favicon in `client/index.html` (no separate file)
- [x] `/favicon.ico` returns 204 instead of leaking the SPA shell

### 11d. Expanded data + viz (added v0.3.0)
- [x] **Disk I/O** collector reading `/proc/diskstats` directly, computing
      bytes/sec by diffing successive reads (skips partitions and pseudo
      devices). New `GET /api/diskio` route + on the overview snapshot.
- [x] **CPU breakdown** historical metrics (`cpu.user`, `cpu.system`,
      `cpu.idle`)
- [x] **Memory breakdown** historical metrics (`mem.active`, `mem.cached`,
      `mem.buffers`, `mem.free` — bytes)
- [x] **Per-core CPU** historical metrics (`cpu.core.0` … `cpu.core.N`,
      variable cardinality)
- [x] **`<MultiLineChart>`** — multi-series with synced hover tooltip
- [x] **`<StackedAreaChart>`** — proper stacking with cumulative sums and
      per-layer tooltip
- [x] **`<CoreGrid>`** — live per-core mini-bar grid
- [x] **Hero chart** on Dashboard: CPU + Memory overlay, last 1h
- [x] **Per-core CPU grid card** on Dashboard
- [x] **Disk I/O card** on Dashboard with read+write sparklines
- [x] History page reorganized into sections (Compute / Per-core / Memory /
      I/O / Network) with the new charts wired in

### 11e. UI polish (added v0.3.0)
- [x] `Icons.jsx` — monochrome SVG icon set (16px, `currentColor`)
- [x] Sidebar nav with icons + accent-tinted active state + glowing left
      strip + footer with gradient avatar + sign-out icon button
- [x] Topbar with pulsing live indicator + monospaced server clock
- [x] Card hover lift, gradient surface, gradient bars, smooth transitions
- [x] Skeleton loader on Dashboard first paint (shimmer animated)
- [x] Page fade-up transition on mount (Dashboard + History)
- [x] Global `font-variant-numeric: tabular-nums`
- [x] `@media (prefers-reduced-motion: reduce)` respected

### 11f. Density + cardinality (added v0.4.0)
- [x] **Sparkline min/avg/max overlay** — `<Sparkline>` accepts `showStats`
      and `format` props. Faint dashed bands at min/max inside the SVG, plus
      a "min · avg · max" footer row under the line. Wired on all 4 Dashboard
      stat cards and both Disk I/O sparklines.
- [x] **Per-interface network historical metrics** — `net.iface.<name>.rx`
      and `net.iface.<name>.tx`, sampled per non-loopback / non-`veth*`
      interface
- [x] **Per-disk I/O historical metrics** — `disk.dev.<name>.read` and
      `disk.dev.<name>.write`, sampled per physical block device
- [x] **History page**: new "Per-disk I/O" and "Per-interface network"
      sections, multi-line charts populated from the dynamic series
- [x] Generic `useDynamicSeries` hook on the History page for any
      variable-cardinality series

### 11j. Connective tissue + polish (added v0.8.0)
- [x] **Connection history** — `conn.established`, `conn.timewait`,
      `conn.listening`, `conn.total` sampled into the SQLite store
      every 5s. New "Connections" section on the History page.
- [x] **Cross-link alerts → logs** — popover entries have a
      "show logs →" link that deep-links to
      `/logs?since=<window>&priority=<level>`.
- [x] **URL-driven filters on the Logs page** — `priority`, `since`,
      `limit`, `unit` round-trip through query params; deep links and
      bookmarks work.
- [x] **CSV export on every History chart** — "↓ csv" button generates
      a row-per-timestamp, column-per-series CSV from the in-memory
      points (no server endpoint).
- [x] **Trust-proxy fix** — `app.set('trust proxy', 1)` in
      `server/index.js` removes the `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`
      warning that the rate limiter had been emitting since the nginx
      reverse proxy was added.

### 11i. System log feed (added v0.7.0)
- [x] **`server/collectors/logs.js`** — `journalctl --output=json`
      reader via `execFile` (no shell). Decodes both string and
      byte-array `MESSAGE` payloads.
- [x] Gated behind **`OTHONI_LOGS_ENABLED`** (off by default — entries
      can leak sensitive content).
- [x] Tight whitelist on user input: numeric priority 0–7, unit name
      regex `[A-Za-z0-9._@:\-]{1,128}`, fixed `since` choices.
- [x] **`/api/logs`** route. Returns `{enabled:false}` cleanly when
      disabled (HTTP 200) so the UI can render a "how to enable" card.
- [x] **Logs page** at `/logs` — table with priority / since / limit /
      unit filters, auto-tail toggle (5s refresh, paused when tab
      hidden), level chip per row, "Refresh" button.
- [x] **`<IconLogs>`** monochrome SVG icon, sidebar nav entry.
- [x] `.env.example` refreshed (OTHONI_DB / OTHONI_SAMPLE_MS /
      OTHONI_RETENTION_MS / OTHONI_LOGS_ENABLED documented).

### 11h. Alerting (added v0.6.0)
- [x] **Alert rule engine** at `client/src/alerts.js` — pure functions
      over rules + overview snapshots; sustained-duration evaluation
      tracks `firstBreachAt` per rule and only fires once breach has
      lasted ≥ `durationMs`.
- [x] Storage: localStorage per browser, key `othoni.alerts.rules`.
      Firing state in-memory only (resets on reload).
- [x] **Topbar notification dot** with count badge (color = highest
      severity firing); click → popover listing each firing alert with
      label, current value, threshold, severity, sustained-for duration.
      Outside-click / Esc dismiss.
- [x] **Alerts page** at `/alerts` — inline-editable table of rules
      (label, metric, comparator, threshold, sustained, severity), live
      "Now" column showing the current value (severity-colored when
      firing), "+ Add rule" / "Seed defaults" / delete buttons.
- [x] **Default rules seeded on first load** — CPU > 90% sustained 5m
      (warn), memory > 90% sustained 5m (crit), root disk > 90%
      sustained 1m (crit).
- [x] **Browser notifications (opt-in)** via the `Notification` API with
      a permission prompt; tagged so repeated fires of the same rule
      replace rather than stack.
- [x] `useAlertsEngine` hook in `App.jsx` polls `/api/overview` every
      10s while logged in (paused when tab hidden).

### 11g. Brushable zoom + connections page (added v0.5.0)
- [x] **Brushable zoom** — drag-select a window on any History chart to
      zoom in. Translucent rect during drag, "× reset zoom" pill in the
      top-right when zoomed. Shared `useBrush` hook in `Charts.jsx`,
      opt-in via `enableBrush` on `<LineChart>` / `<MultiLineChart>` /
      `<StackedAreaChart>`. All History page cards opt in.
- [x] **`/api/connections`** route + `getConnections()` collector parsing
      `/proc/net/{tcp,tcp6,udp,udp6}` directly (no shell). IPv4 and IPv6
      hex addresses decoded with the kernel's little-endian byte order;
      IPv6 emits `::`-collapsed form.
- [x] **Connections page** at `/connections`: 4 summary tiles
      (established / listening / time-wait / total sockets), TCP state
      chips, **Listening ports** table grouped by `(protocol, port)` with
      well-known service hints, **Active TCP connections** table with
      filter input + state dropdown (server-side cap of 1000 active rows
      per response, with a "first 1000 of N" notice when truncated).
- [x] **`<IconConnections>`** monochrome SVG icon, added to the sidebar.

### 12. Error handling
- [x] Per-endpoint try/catch returning `{error, message}` 500s
- [x] Top-level Express error handler scrubs stack traces
- [x] `ps` / `docker` / `systemctl` failures degrade per-section, not
      app-wide

### 13. Security basics
- [x] `helmet()` enabled
- [x] Rate limit on login
- [x] Credentials and JWT secret in `.env` (with `.env.example`)
- [x] Constant-time password compare
- [x] Session cookie is `httpOnly`, `sameSite=lax`, `secure` behind HTTPS
- [ ] HTTPS termination (left to nginx / reverse proxy — see ROADMAP)

### 14. Install / run docs
- [x] README covers install, configure, dev, build, run, systemd

### 15. systemd service example
- [x] `othoni.service.example` with hardening flags

### 16. Installer-friendly layout
- [x] Single repo, single `npm install && npm run build && npm start`
- [ ] `install.sh` one-liner (deferred — see ROADMAP)

## Operational state on the testing VPS

- Path: `/var/www/othoni`
- Public URL: `https://othoni.syedhashmi.trade` (Let's Encrypt cert, auto-renewing,
  expires 2026-08-07)
- Backend bind: `127.0.0.1:8088` — fronted by nginx with HTTP→HTTPS redirect
- Admin password: rotated from the default; `OTHONI_JWT_SECRET` is a real
  96-char random hex string (set at install time)
- Process: managed by systemd (`othoni.service`, enabled, `Restart=on-failure`)
- Docker: not installed on this host — section shows the friendly fallback
- Services tab on this host: `nginx` and `ssh` active, others reported missing

## Recent activity

- **2026-05-10** — v0.10.0 shipped: external metric ingestion via API
  keys. `POST /api/metrics` with `Authorization: Bearer othoni_...`,
  single or batch shape, `custom.<name>` prefix required so external
  agents can't shadow built-in metrics. Per-key rate limit 600 req/min.
  Settings page gets an "API keys" card (generate / list / revoke,
  plaintext shown once). History page auto-discovers `custom.*` series
  and renders one chart per under a new "Custom" section. Keys stored
  hashed in `data/api-keys.json` (0600 perms, atomic writes,
  GitHub-PAT-style).
- **2026-05-10** — v0.9.0 shipped: optional TOTP (RFC 6238) second
  factor on login. Pure-JS implementation in `server/totp.js` (no
  deps), verified against RFC 6238 Appendix B test vectors. New
  `OTHONI_TOTP_SECRET` env var (off by default). New
  `npm run totp:setup` helper that generates a secret, prints
  enrollment instructions + `otpauth://` URL, and renders an inline
  QR if `qrencode` is on PATH. `/api/health` exposes
  `auth.totp:<bool>` so the login page conditionally renders the code
  field. Failures all return a single generic `invalid_credentials`
  401 — no user / factor enumeration. Shipped with TOTP **disabled
  on live**; user enables on their own time.
- **2026-05-10** — v0.8.1 shipped: UI polish pass. New pattern classes
  in `styles.css` (`.input`, `.select` with custom chevron, `.btn.tiny`,
  `.chip` with severity variants, `.toolbar`, `.section-title`,
  `.stat-tile`, `.topbar-bell`, `code`/`kbd`, `:focus-visible` rings).
  All pages refactored to use them — the big inline-styled-form-control
  blocks on Alerts/Logs/Connections in particular are gone. Page titles
  get a small accent-bar prefix; section headers get a trailing fade
  rule. All pages now wrap in `.page-fade-in` for consistent transitions.
  No new features, no API changes.
- **2026-05-10** — v0.8.0 shipped: connective tissue + polish.
  Connection history (4 new metrics charted on History), cross-link
  from firing alerts to filtered logs, URL-driven Logs page filters
  (deep-linkable), CSV export on every History chart, and a
  `trust proxy` fix in Express that removes a long-standing rate-limiter
  warning.
- **2026-05-10** — v0.7.0 shipped: system log feed via
  `journalctl --output=json`. New collector, `/api/logs` route, Logs
  page with filters + auto-tail. Opt-in (`OTHONI_LOGS_ENABLED=true`)
  because journal entries can leak sensitive content; enabled on the
  testing VPS at user's request. `.env.example` also refreshed to
  cover several env vars that had drifted out since v0.2.0.
- **2026-05-10** — v0.6.0 shipped: alerting. Threshold rule engine with
  sustained-duration evaluation, topbar notification dot + popover,
  Alerts page for inline rule editing, default rules seeded on first
  load, optional browser notifications. All client-side — no server-side
  state, rules persist to localStorage per browser.
- **2026-05-10** — v0.5.0 shipped: brushable zoom on every History chart
  (`useBrush` hook in `Charts.jsx`, opt-in via `enableBrush` on Line /
  MultiLine / StackedArea), plus a new Connections page at `/connections`
  surfacing listening ports + active TCP connections via a new
  `/api/connections` endpoint backed by a pure-JS `/proc/net/{tcp,tcp6,
  udp,udp6}` parser.
- **2026-05-10** — v0.4.0 shipped: density + cardinality. Sparkline
  min/avg/max overlay (faint dashed min/max bands + tiny stats footer) on
  all four Dashboard stat cards and both Disk I/O sparklines. Per-interface
  network historical metrics (`net.iface.<name>.{rx,tx}`) and per-disk I/O
  historical metrics (`disk.dev.<name>.{read,write}`); `veth*` interfaces
  filtered at sample time. History page gets two new sections:
  "Per-disk I/O" and "Per-interface network", each with read/write or
  rx/tx multi-line charts. New generic `useDynamicSeries` hook on the
  History page covers any variable-cardinality series.
- **2026-05-09** — v0.3.0 shipped: big data + UI upgrade. New disk-I/O
  collector and 12 new historical metric series (CPU breakdown, memory
  breakdown, per-core CPU, disk read/write). Three new pure-SVG chart
  primitives (`<MultiLineChart>`, `<StackedAreaChart>`, `<CoreGrid>`).
  Dashboard redesigned with hero CPU+RAM chart, per-core grid, disk I/O
  card. History page sectioned. UI polish: icon set, sidebar with active
  glow + user footer, topbar pulse + server clock, card hover lift, gradient
  bars, skeleton loaders, page fade-up, tabular figures globally. Fixed a
  hooks-after-early-return crash in `MultiLineChart`.
- **2026-05-09** — v0.2.0 shipped: branding (SVG logo + favicon), in-process
  SQLite sampler with 24 h retention, `/api/history` endpoint with on-the-fly
  downsampling, pure-SVG `<Sparkline>` and `<LineChart>` components,
  sparklines on Dashboard cards, and a dedicated History page with a range
  selector. `better-sqlite3` is now a dependency. DB lives at
  `data/othoni.db`.
- **2026-05-09** — Hardening pass: rotated admin password, installed and
  enabled the systemd unit, added nginx reverse proxy with a Let's Encrypt
  cert for `othoni.syedhashmi.trade`, rebound the backend to `127.0.0.1:8088`,
  and removed the now-redundant UFW rule for port 8088.
- **2026-05-09** — v0.1.0 built from scratch. All v1 endpoints implemented and
  smoke-tested end-to-end. UFW opened for port 8088 on this VPS so the
  dashboard is reachable from outside.
