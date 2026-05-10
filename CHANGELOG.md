# Changelog

All notable changes to othoni are recorded here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

_Nothing yet._

## [0.23.0] — 2026-05-10

Multi-host source attribution on `custom.*` metrics. Multiple agents can now
push to the same othoni instance without stepping on each other's metric
names, and the History page groups the results by host.

### Added

- **Optional `host` field on `POST /api/metrics`** — accepted at the
  top level (default for the whole batch) or per-metric. When present
  and valid, the server splices it onto the metric name:
  `{ name: "custom.requests", host: "app-server-1" }` lands as
  `custom.app-server-1.requests` in the store.
- **DNS-style validation** on the host: `[a-z0-9-]{1,40}` with no
  leading/trailing dash. Invalid hosts return a clear `400
  invalid_host` rather than silently dropping the prefix.
- **Per-host grouping on the History page Custom section** — one
  `<Section>` per host, plus an "ungrouped" bucket for legacy agents
  that push the un-prefixed `custom.<leaf>` form. Single regex parser
  on the client (matches the server's host pattern) splits metric
  names into `{ host, leaf }`.

### Changed

- `package.json` bumped to `0.23.0`.
- `server/routes/metrics.js` — adds `applyHost()` between normalize
  and insert; rejects bad hosts up front.
- `client/src/pages/History.jsx` — replaces the single Custom section
  with a `CustomMetricsSection` that fans out one section per host.

### Notes

- **Backwards compatible.** Existing agents that don't send `host`
  continue to write `custom.<leaf>` — those land in the new
  "Custom · ungrouped" section. No data migration needed.
- The host segment is part of the metric name (not a separate column),
  so it flows through the same `samples` table, the same retention
  sweep, the same `/api/history` query path. Zero schema changes.

## [0.22.0] — 2026-05-10

Optional Prometheus exporter. Off by default — additive only, doesn't
affect existing users.

### Added

- **`server/prom-export.js`** — pure-JS exposition builder
  (text-based format, no library). Emits build info, CPU
  (aggregate + per-core + load averages), memory (regions in bytes
  + percent), swap, filesystem (per-mount usage % + bytes),
  per-device disk I/O, per-interface network throughput + counters,
  TCP socket counts by state, currently-firing alerts, and synthetic
  check up/down/latency/consecutive-failures. ~30 metric families
  total.
- **`GET /metrics`** route, mounted before the cookie-auth wall.
  Auth: `Authorization: Bearer <OTHONI_PROMETHEUS_TOKEN>`,
  constant-time compare. Returns:
  - **404** when `OTHONI_PROMETHEUS_TOKEN` is unset (the endpoint
    isn't advertised at all in that case);
  - **401** when missing or wrong;
  - **200** with the standard `text/plain; version=0.0.4` content
    type otherwise.
- **`OTHONI_PROMETHEUS_TOKEN` env var** in `.env.example` with a
  random-string-generation hint.

### Changed

- `package.json` bumped to `0.22.0`.
- `server/index.js` mounts the new `/metrics` route alongside the
  existing `/api/metrics` ingestion route — both before the
  cookie-auth wall.

### Notes

- Verified end-to-end on the live host: 401 without/with wrong
  token; 200 with full exposition (build_info, cpu, memory,
  filesystem, disk I/O, network, connections, alerts, checks) on
  the right token; 404 once the env var is removed.
- No dependency on Prometheus itself — this is just a scrape
  endpoint. The in-process SQLite store remains the primary history.

## [0.21.0] — 2026-05-10

Auth hardening — scrypt-based password hashing, no new dependencies.

### Added

- **`server/password-hash.js`** — self-contained scrypt KDF (Node's
  built-in `crypto.scryptSync`). Format
  `scrypt$N=32768,r=8,p=1$<base64-salt>$<base64-hash>` — self-
  describing so deployments don't need to track a separate salt.
  Constant-time verify; malformed stored hashes return false rather
  than throwing.
- **`OTHONI_ADMIN_PASSWORD_HASH` env var** — when set, takes
  precedence over `OTHONI_ADMIN_PASSWORD`. Both code paths run on
  every login attempt to keep the timing constant; the chosen path
  depends on whether a valid hash is present.
- **`scripts/hash-password.js` + `npm run hash-password`** — reads
  the password from stdin (silenced if attached to a TTY), prints
  the line to add to `.env`. Each invocation generates a fresh salt
  so the same password produces a different hash each time.

### Changed

- `package.json` bumped to `0.21.0`. New `hash-password` script entry.
- `server/auth.js` — `login()` selects the hash path when
  `OTHONI_ADMIN_PASSWORD_HASH` parses as a valid scrypt hash;
  otherwise falls back to the existing constant-time plaintext
  compare against `OTHONI_ADMIN_PASSWORD`. Username comparison
  unchanged.
- `.env.example` — documents the new (commented-out) hash variable.

### Notes

- No new npm dependencies — scrypt is part of Node's core `crypto`
  module. The format is intentionally simple to read by eye, so an
  operator can rotate the value without tooling.
- The plaintext fallback stays so first-time users can follow the
  README without a setup ritual; rotate to the hash form for any
  internet-facing deployment.

## [0.20.0] — 2026-05-10

Per-interface and per-device sparklines on the live pages. The History page
already had these as time-series; now Network and Storage carry the same
trend signal inline so you don't have to switch pages to spot a spike.

### Added

- **Per-interface sparklines on the Network page** — two new columns
  (RX trend / TX trend), each with a small `<Sparkline>` driven by
  the existing `net.iface.<name>.{rx,tx}` history. 15-minute window;
  trends refresh every 30s independent of the live counter poll
  (sparkline barely changes per tick anyway).
- **Per-device disk I/O section on the Storage page** — new "Per-device
  I/O" grid below the filesystem cards, one card per physical block
  device with read + write sparklines (`disk.dev.<name>.{read,write}`)
  and live rate readouts. Same 15m window / 30s trend cadence.
- **`useIfaceTrends` / `useDiskTrends` hooks** — both fan out to N
  parallel `/api/history` fetches via `Promise.all`, keying on the
  joined name list so React doesn't re-fire on shape-equal updates.

### Changed

- `package.json` bumped to `0.20.0`.
- `client/src/pages/Network.jsx` — table grows two sparkline columns;
  loopback row still shows just the rate (no trend, since loopback
  is filtered out of historical sampling).
- `client/src/pages/Storage.jsx` — adds the per-device section + a
  second `usePoller` for `/api/diskio`.

### Notes

- This is the last item from the v0.13.0–v0.20.0 ROADMAP "Next up"
  block as it stood at the start of the session. Eight releases
  shipped end-to-end this session; the public roadmap now has only
  larger / explicitly-deferred items left (one-line installer, auth
  hardening, optional Prometheus exporter, action endpoints).

## [0.19.0] — 2026-05-10

Dashboard density toggle. Tighten card padding, table rows, and section
spacing on demand — same theme, just packed denser for crowded
dashboards or smaller screens.

### Added

- **Density setting** (`localStorage` `othoni.density` =
  `"comfortable"` (default) | `"compact"`). Applied via a
  `data-density="compact"` attribute on `<body>` from `App.jsx`, so
  CSS rules can scope compact-mode without per-component changes.
- **Density card on Settings page** — Comfortable / Compact toggle
  buttons next to the existing Refresh-interval card.
- **CSS rules** at the bottom of `styles.css` reduce: `.card` padding
  18 → 12px, `.grid` gap 16 → 10px, table cell padding 10 → 7px,
  `.card-value` 28 → 23px, `.section-title` margins, `.toolbar` gap,
  page titles. Theme tokens (radii / colors / shadows) unchanged.

### Changed

- `package.json` bumped to `0.19.0`.
- `App.jsx` exposes `density` / `setDensity` on the App context;
  applies the body data attribute via a `useEffect`.
- `Settings.jsx` adds a third card to the top row.

## [0.18.0] — 2026-05-10

Saved views — pick a handful of metrics and overlay them on a single chart.
Save the selection as a named preset for one-click recall.

### Added

- **Saved views card** at the top of the History page (after the
  range toolbar). Pure-client feature; no server changes.
- **Metric picker** — checkbox grid of 20 static metrics grouped by
  category (Compute / Memory / I/O / Network), each labeled with its
  unit format. Cap of 8 metrics per view to keep the chart legible.
- **Live chart** — selected metrics render in a `<MultiLineChart>`
  with brushable zoom + CSV export. If every selected metric shares a
  format (all `percent`, all `rate`, etc.), the y-axis uses that
  format; otherwise it falls back to raw numbers (mixing units on one
  axis loses the unit anyway). `fixedMax=100` when all-percent so
  thresholds visually anchor at 100%.
- **localStorage presets** at `othoni.history.views`, up to 8 with
  FIFO eviction. Save current selection by name; click a preset to
  apply; trash icon to delete.
- **`useViewSeries` hook** — fans out to N concurrent `/api/history`
  fetches via `Promise.all` on the same cadence as the rest of the
  History page. Stable hook count per render (couldn't use the
  existing `useMetric` inside a `.map()`).

### Changed

- `package.json` bumped to `0.18.0`.
- `client/src/pages/History.jsx` adds the `<SavedViewsCard>` plus a
  `VIEW_METRICS` catalog and small color palette for series.

### Notes

- Variable-cardinality metrics (per-core CPU, per-iface network,
  per-disk I/O, `custom.*`) aren't in the picker — they'd dwarf the
  static set. Their existing dedicated cards on this page already
  group them.
- The picker is hidden by default; click "Build view" to reveal it.
  Saving a view doesn't reload the page or change other charts.

## [0.17.0] — 2026-05-10

Keyboard shortcuts. Two-key navigation chords (`g` then a letter) plus
`?` to toggle a cheatsheet overlay.

### Added

- **Two-key nav chords** — `g d` Dashboard, `g h` History, `g s` Storage,
  `g p` Processes, `g k` Docker (kontainer), `g v` Services, `g n`
  Network, `g c` Connections, `g a` Alerts, `g e` Checks, `g l` Logs,
  `g ,` Settings. 1.5s timeout on the prefix; chord state cleared if
  the next keystroke isn't a known target.
- **`?` toggles a cheatsheet overlay** — pure-JSX modal in
  `client/src/Cheatsheet.jsx` with backdrop blur, listing every chord
  + the help shortcut. Click backdrop or press Esc to dismiss.
- **`?` button in the topbar** next to the live indicator — same as
  pressing `?`, gives discoverability for non-keyboard users.
- **`Esc`** clears any pending chord and closes the cheatsheet.

### Changed

- `package.json` bumped to `0.17.0`.
- `client/src/App.jsx` — new `useKeyboardShortcuts()` hook owns the
  chord state machine + cheatsheet open/close; mounted only inside the
  authenticated `Shell` (the login screen doesn't install global key
  listeners). New `<Cheatsheet>` import + render.

### Notes

- Shortcuts are suppressed while focus is in `<input>` / `<textarea>`
  / `<select>` / contenteditable elements, so typing in filter boxes
  isn't intercepted.
- Any modifier key (ctrl/meta/alt) lets the keystroke pass through
  untouched — browser/OS shortcuts continue to work normally.
- `?` is shift+/ on most layouts; both forms are accepted.

## [0.16.0] — 2026-05-10

Logs follow-ups. Five upgrades to the Logs page so it's a usable digging
tool, not just a tail viewer.

### Added

- **Cursor pagination** ("Load more older" button) — `/api/logs` now
  accepts `until=<ms>` and the collector passes it through as
  `--until=@<unix-seconds>` to journalctl. The collector then strictly
  post-filters `t < until` so boundary entries (sharing the same second
  as the oldest visible row) aren't re-delivered. Client tracks an
  accumulating entries array; first page reset on filter change. The
  page now exposes the journal `__CURSOR` per row for stable React
  keys, even though pagination uses timestamps.
- **Search + highlight on loaded entries** — new search input below
  the toolbar. Substring match (case-insensitive) across message, unit,
  and identifier; matches rendered with an inline `<mark>` element
  using the existing accent-warn color. Pure regex-escape on the input
  so paths and regex-like strings can't crash the matcher.
- **Per-priority count chips** — derived from the *visible* (search-
  filtered) set, so toggling search updates them. Shown in priority
  order (emerg → debug). Helps spot "lots of warnings" at a glance.
- **Jump-to-time** — `<input type="datetime-local">` next to the
  search box. When set, the first fetch uses that timestamp + 1 ms as
  `until` so the page is anchored at that moment; "Load more older"
  walks backward from there. Clearing the field returns to the live
  tail. Auto-tail is disabled while a jump is set (it would
  prepend live entries above the anchor, defeating the point).
- **Saved filter presets** (localStorage) — name + save the current
  filter set; click a preset to apply. Up to 8 presets, FIFO eviction.
  Persisted to `localStorage` under `othoni.logs.presets` via the
  existing `useLocalSetting` hook.

### Changed

- `package.json` bumped to `0.16.0`.
- `server/collectors/logs.js` — `getLogs()` accepts `until`; entries
  expose `cursor`. `buildArgs` adds `--until=@<sec>` when provided.
- `server/routes/index.js` — `/api/logs` route forwards `until`.
- `client/src/api.js` — `api.logs({...,until})`.
- `client/src/pages/Logs.jsx` — substantial rewrite: pagination state,
  load-more button, search, highlight, count chips, jump-to-time
  input, presets bar.

### Notes

- Auto-tail behavior: pauses while jump-to-time is set, so live
  prepending doesn't fight the anchor. Otherwise unchanged — 5s tick,
  pauses when tab hidden.
- The `since` whitelist (`5m` / `15m` / `1h` / etc.) is unchanged.
  Jump-to-time is a separate axis (absolute `until`); the two combine
  naturally via the existing `since`/`until` semantics.
- "Load more older" intentionally drops the `since` window after the
  first page, so walking backward isn't capped by "1h ago" — it's
  capped by "before the oldest entry on screen", which is what users
  actually want when they click load-more.

## [0.15.0] — 2026-05-10

Per-port "top talkers" on the Connections page. Surfaces SSH brute-force /
scrape patterns by grouping active TCP connections two ways: by local port
(which of our services is concentrated) and by remote IP (which talker is
concentrated).

### Added

- **`server/collectors/connections.js` aggregates** — two new fields on
  the `/api/connections` response:
  - `topLocalPorts`: top 10 local ports by total connection count, with
    state breakdown per port. Useful for spotting "many connections to
    port 22" (SSH brute force) at a glance.
  - `topRemoteAddresses`: top 10 remote IPs by total connection count,
    with state breakdown AND the top 4 of-our-ports they're hitting per
    IP. Useful for spotting single-source attackers / heavy clients.
- **Generic `aggregateBy()` helper** in the collector — does the
  group-by + sort-by-total + state-rollup work for both top-N tables in
  one place. Trims state breakdown to the top 4 states per row with an
  `other` bucket so wide rows don't blow the layout.
- **Two new sections on the Connections page** — "Top local ports" and
  "Top remote addresses", each rendered as a compact table with inline
  state chips. Slot in between Listening ports and Active TCP
  connections so the page reads "what's bound → where's the load →
  raw list".
- **`<MiniStateChip>`** — denser variant of the existing `<StateChip>`
  for the talkers tables (lots of chips per row, needs to be tighter).

### Changed

- `package.json` bumped to `0.15.0`.
- The aggregates are computed from the **full** untrimmed
  active-connection list, not the 1000-row capped slice that the
  detailed table reads — so the talker counts don't get skewed when a
  host has more than 1000 active connections.

### Notes

- This is a read-only view of the running socket table; no new
  persistence and no historical view. The signal is "right now, where
  is the load concentrated?" — pair it with the existing connection
  history charts (sampled into SQLite) for trends over time.

## [0.14.0] — 2026-05-10

Alert history. Rule fires are now persisted to a new `alert_fires` table and
surfaced in two places on the Alerts page: a "Fires (24h)" column with a
density histogram per rule, and a recent-fires timeline below the rules.

### Added

- **New SQLite table** `alert_fires(t, rule_id, metric, severity, label,
  value, threshold, sustained_ms)` with indexes on `(t)` and
  `(rule_id, t)`. Created in `server/history.js`'s schema bootstrap and
  pruned at the existing 24h retention.
- **`server/alerts.js` persistence** — when a rule transitions from
  non-firing to firing, the fire is inserted into `alert_fires` in the
  same tick as the webhook dispatch. Label and severity are
  denormalized so historical rows still render correctly after rule
  edits or deletes.
- **`server/alerts.js` query helpers** — `getStats({ range, buckets })`
  returns per-rule `{ fires, lastFiredAt, lastSeverity, points }` for
  all rules that fired in the range (so deleted rules are visible).
  `listFires({ range, limit })` returns a denormalized timeline with
  pre-formatted `valueFmt` / `thresholdFmt`.
- **`GET /api/alerts/stats?range=24h`** — single round-trip, returns
  stats for every rule. Used by the Alerts page so the rules table
  doesn't fan out to one request per row.
- **`GET /api/alerts/history?range=24h&limit=100`** — recent-fires
  timeline. Limit capped server-side at 500.
- **"Fires (24h)" column on the rules table** — count + a tiny pure-SVG
  bar histogram showing fire density across the range, color-graded by
  severity.
- **Recent fires card on the Alerts page** — below the rules table,
  range chips (1h / 6h / 24h), one row per fire with relative time,
  rule label, severity chip, value · threshold, and sustained duration.

### Changed

- `package.json` bumped to `0.14.0`.
- `server/history.js` — `alert_fires` schema added to `open()` next to
  the existing `samples` and `process_samples`; `cleanup()` prunes all
  three.
- `server/alerts.js` — imports `./history` for the shared DB handle.
- `server/routes/index.js` — new `/api/alerts/stats` and
  `/api/alerts/history` routes alongside the existing alerts endpoints.
- `client/src/api.js` — new `api.alerts.stats(range)` and
  `api.alerts.history({ range, limit })` helpers.
- `client/src/pages/Alerts.jsx` — adds the Fires column, the
  `<DensityBars>` SVG primitive (inline, ~30 lines, follows the
  no-chart-library convention), and the `<RecentFiresCard>` section.

### Notes

- Existing fires accrued before this release are not reconstructible —
  the alert engine ran in-memory until v0.14.0. After upgrade, fires
  populate naturally over the first 24 hours.

## [0.13.0] — 2026-05-10

Process trends — periodically captures the heaviest processes and surfaces a
"who's been heavy in the last hour" view on the Processes page.

### Added

- **`server/process-history.js`** — slow-cadence sampler (default 30s,
  tunable via `OTHONI_PROC_SAMPLE_MS`). Each tick reads `ps` twice in
  parallel — once sorted by CPU, once by memory — dedupes by PID, and
  inserts the union into a new `process_samples` table. The mem-sorted
  read picks up RAM hogs that wouldn't make the CPU top-N. Rows where
  both cpu% and mem% are below 0.1 are dropped at sample time so the
  table stays focused on actually-loaded processes.
- **New SQLite table** `process_samples(t, name, pid, cpu, mem)` with
  indexes on `(t)` and `(name, t)`. Created by `server/history.js` next
  to the existing `samples` table; both share the same DB file and are
  pruned together at the existing 24h retention.
- **`GET /api/history/processes?range=&sortBy=&limit=`** — aggregates by
  process **name** (so a service that respawned shows as one row) over
  the requested range and returns: peak/avg CPU%, peak/avg MEM%, sample
  count, and a per-name sparkline of the chosen metric (~60 buckets).
  Sort order is by peak with avg as tie-breaker — "who spiked" is the
  question this view answers most directly.
- **`history.getDb()` export** — sibling modules can now share the same
  WAL session instead of opening a second connection.
- **Trends card on the Processes page** — sits above the live `ps`
  table, polls every 30s, range chips (15m / 1h / 6h / 24h). Each row:
  process name, sample-count caption, sparkline (color-graded green /
  amber / red at the existing 75 / 90% thresholds), peak%, avg%. Sort
  toggle (CPU / memory) is shared with the live table below — flipping
  it re-queries both.

### Changed

- `package.json` bumped to `0.13.0`.
- `server/history.js` — `process_samples` schema added to the `open()`
  bootstrap; `cleanup()` prunes both tables; `getDb` and `RETENTION_MS`
  now exported.
- `server/index.js` — `processHistory.start()` runs after `history.start()`
  on `app.listen()`; `processHistory.stop()` runs before `history.stop()`
  on SIGTERM/SIGINT (so the sampler doesn't try to write into a closed DB).
- `server/routes/index.js` — new `/api/history/processes` route alongside
  the existing `/api/history` and `/api/history/metrics`.
- `client/src/api.js` — new `api.historyProcesses({ range, sortBy, limit })`
  helper.
- `client/src/pages/Processes.jsx` — adds the Trends card and shares the
  sortBy state between trends + live table.

### Notes

- The trend sampler runs even on idle hosts; the empty-row filter
  (cpu < 0.1 AND mem < 0.1) keeps churn low. Expect ~25–30 rows per
  tick on a typical VPS — about 86k rows/day, well under SQLite's
  comfort zone.

## [0.12.0] — 2026-05-10

Synthetic checks — periodic HTTP / TCP / ICMP probes that record into the
same history store and dispatch to webhooks on consecutive failures.

### Added

- **`server/checks.js`** — per-check scheduler (one `setInterval` per
  enabled check, 10s minimum / 24h maximum interval) with three
  executors:
  - **HTTP** — Node's built-in `fetch` with AbortController timeout;
    body is drained so connections close cleanly. Up = `res.ok`.
  - **TCP** — `net.connect()` with timeout; up = connect, down =
    error / timeout (with the `ECONNREFUSED`/`EHOSTUNREACH` code
    surfaced as `lastError`).
  - **Ping** — shells out to `/usr/bin/ping -c 1 -W <s>` via
    `execFile` (no shell, no string interpolation).
- **Two metric series per check per run** — `check.<id>.up` (1 or 0)
  and `check.<id>.latency_ms` (number) inserted via the new
  `history.insertSample(name, value)` trusted-internal helper.
  Validated against a new `check.<id>.{up,latency_ms}` regex pattern.
- **Built-in alerting** — each check has `alertAfterFailures` (default
  0 = never alert) and `alertSeverity`. When `consecutiveFailures` ==
  `alertAfterFailures`, the check dispatches an `alert.fire`-shaped
  event to the same webhook destinations as threshold rules. Recovery
  silently resets the counter (no "back up" notification — too noisy
  by default).
- **`/api/checks`** CRUD + **`POST /api/checks/:id/run`** to fire a
  one-shot probe immediately ("Run now" button on the page).
- **Checks page** at `/checks` — 4 summary tiles (total / up / down /
  pending), table with enable toggle / inline state chip (with latency
  for up, failure count + error code for down) / Run-now / delete.
  Add form supports all three types with sensible defaults.
- **`<IconChecks>`** — pulse-line SVG, added to sidebar nav.

### Changed

- `package.json` bumped to `0.12.0`.
- `server/index.js` — checks engine started after alerts engine; both
  share the same `webhooks.dispatch` reference. SIGTERM stops checks
  before alerts before history.
- `server/history.js` — added `CHECK_METRIC_PATTERN`, exported
  `insertSample` helper.
- Sidebar nav order: Dashboard, History, Storage, Processes, Docker,
  Services, Network, Connections, Alerts, **Checks**, Logs, Settings.

## [0.11.0] — 2026-05-10

Server-side alert engine + webhook destinations. Alerts now fire even
when no browser is open. Slack, Discord, and generic JSON formats all
supported.

### Added

- **`server/alerts.js`** — rule storage at `data/alert-rules.json`,
  in-memory firing state, evaluator on a 10s `setInterval`. Default
  rules seeded on first start (CPU/mem/disk all > 90%). Same metric
  set as the old client engine: `cpu`, `mem`, `swap`, `load1`,
  `disk_root`, `net_rx`, `net_tx`, `disk_read`, `disk_write`. Rules
  persist atomically.
- **`server/webhooks.js`** — destination CRUD at `data/webhooks.json`,
  dispatcher with one retry after 1.5s and an 8s per-call timeout.
  Three format adapters:
  - `generic` — full JSON payload (event, rule, value, sustainedMs,
    timestamp, host, formatted text)
  - `slack`   — `{ "text": "[WARN] label — value > threshold (...)" }`
  - `discord` — `{ "content": "..." }`
- **`/api/alerts/rules`** GET / PUT (replace whole list — server
  validates each rule, drops invalid ones with a warning, preserves
  per-rule firing state across edits by id).
- **`/api/alerts/active`** GET — currently-firing alerts as a flat
  view-model with pre-formatted `valueFmt` / `thresholdFmt` so the
  client doesn't need to know the format rules.
- **`/api/alerts/metrics`** GET — list of supported metrics + units,
  used by the Alerts page to populate the dropdown without hardcoding.
- **`/api/webhooks`** CRUD + **`POST /api/webhooks/:id/test`** —
  fires a synthetic test event so the user can confirm connectivity
  without waiting for a real alert.
- **Alerts page** — rules now CRUD via the server. Edits buffer
  locally; "Save rules" button persists. New "Webhooks" card below
  with add / list / enable-toggle / test / delete. Per-row status
  chip shows last-known state (idle / ok / test ok / failed).

### Changed

- `package.json` bumped to `0.11.0`.
- `server/index.js` — alert engine + webhook dispatcher started after
  `app.listen()`; both stopped on SIGTERM / SIGINT alongside the
  history sampler.
- `client/src/alerts.js` slimmed: now just `formatDuration` plus
  browser-notification helpers. The metric map, rule storage,
  evaluator, and `activeAlerts()` projector all moved server-side.
  ~150 lines of client code deleted.
- `client/src/App.jsx` — `useAlertsEngine` replaced with
  `useServerAlerts` (polls `/api/alerts/active` every 10s, fires
  browser notifications on transitions, exposes `activeAlerts` via
  context).
- `AlertsPopover.jsx` reads pre-formatted server values; no more
  client-side metric-extraction logic.

### Migration

- Old client-side rules in localStorage are abandoned on upgrade.
  The server seeds the same defaults (CPU/mem/disk > 90%) on first
  start, so users who never customized see no behavior change.
  Anyone with custom rules will need to re-create them once.

### Fixed

- Webhook payload `text` field correctly formats `valueFmt` /
  `thresholdFmt` (the alert-engine fire event was previously missing
  these and the formatter rendered them as `undefined`).

## [0.10.0] — 2026-05-10

External metric ingestion via API keys. Headless agents can now POST
custom metrics that land in the same SQLite history store and show up
on the History page automatically.

### Added

- **`server/api-keys.js`** — key CRUD with persistence at
  `data/api-keys.json` (mode 0600, atomic writes). Keys are 32-hex-char
  random tokens prefixed `othoni_` (recognizable in logs / leaked-secret
  scanners). Stored as SHA-256 hashes; plaintext is shown to the admin
  exactly once at generation time, GitHub-PAT-style. `lookup()` runs
  constant-time across all stored keys; `touch()` debounces `lastUsedAt`
  flushes to disk to once per minute.
- **`POST /api/metrics`** ingestion endpoint, mounted **before** the
  cookie-auth wall so it auths via `Authorization: Bearer othoni_...`
  rather than the dashboard session. Accepts both single
  `{ name, value, t? }` and batch `{ metrics: [{...}, ...] }` shapes.
  Validates the metric name against the new `custom.<name>` pattern
  and the value as a finite number. Per-key rate limit: 600 req/min
  (10/sec sustained). Batch capped at 1000 rows / 256 KB.
- **`/api/keys` CRUD** under the cookie-auth wall — `GET` lists
  metadata only (label, fingerprint, createdAt, lastUsedAt — never the
  hash), `POST { label }` generates and returns the plaintext exactly
  once, `DELETE /api/keys/:id` revokes.
- **`GET /api/history/metrics?prefix=custom.`** — distinct metric names
  in the samples table. Used by the History page to auto-discover
  pushed series.
- **`custom.<name>` metric pattern** in `server/history.js`
  (`isCustomMetric`, `insertCustom`, `insertCustomBatch`). The
  ingestion route only allows this pattern, so an external agent can't
  shadow a built-in series like `cpu` or `disk_root`.
- **API keys card on Settings** — generate (with required label), list
  (label / fingerprint prefix / created-relative / last-used-relative),
  revoke. After generation the plaintext appears in an accent-bordered
  card with copy-to-clipboard + dismiss buttons + a "you won't see it
  again" warning.
- **History page "Custom" section** — auto-rendered when
  `/api/history/metrics?prefix=custom.` returns ≥1 result. One
  `<LineChart>` card per custom metric, sharing the same brushable-zoom
  / CSV-export treatment as the rest of the History page.

### Changed

- `package.json` bumped to `0.10.0`.
- `server/index.js` — metrics router mounted before the cookie-auth
  wall (`app.use('/api/metrics', metricsRouter)` before
  `app.use('/api', auth, apiRouter)`). Subtle but load-bearing — moving
  it under the wall would break the headless-agent flow.
- `server/middleware.js` — added `apiKeyAuth` (Bearer header → lookup →
  `req.apiKey = { id, label }`) and `metricsLimiter` (per-key rate
  limit, falls back to client IP if auth hasn't run).
- `server/routes/index.js` — added `/keys` CRUD + `/history/metrics`.

### Notes

- The on-disk `data/api-keys.json` is created with mode 0600. If you
  migrate the data directory, preserve those perms.
- Key generation via the dashboard mutates the running server's
  in-memory cache directly, so generated keys are usable
  immediately — no restart needed in the normal flow.

## [0.9.0] — 2026-05-10

Optional TOTP (RFC 6238) second factor on login. Pure-JS implementation
in `server/totp.js` — no new dependencies. Off by default; enable by
setting `OTHONI_TOTP_SECRET` in `.env`.

### Added

- **`server/totp.js`** — RFC 6238 TOTP and RFC 4648 base32 in ~100 lines
  using only Node's `crypto`. Verified against RFC 6238 Appendix B test
  vectors (T = 59, 1111111109, 1234567890, 2000000000 all match
  expected 6-digit codes). Verifier accepts ±1 30-second step for
  clock drift and runs constant-time across the whole window.
- **`OTHONI_TOTP_SECRET`** env var — base32 secret. When set, every
  login requires a 6-digit authenticator code in addition to
  username + password.
- **`scripts/totp-setup.js`** + `npm run totp:setup` — generates a
  fresh 160-bit base32 secret, prints the line to add to `.env`, an
  `otpauth://` URL with `issuer=othoni:<hostname>` (so it shows up
  cleanly in authenticator apps), and an inline UTF-8 QR code if
  `qrencode` is on PATH (gracefully skips with an "apt install" hint
  otherwise).
- **`/api/health`** — public response now includes
  `auth: { totp: <bool> }` so the login page knows whether to render
  the TOTP field without a probe-then-retry round trip.
- **Login page** — fetches `/api/health` on mount; conditionally
  renders an "Authenticator code" field with `inputMode="numeric"`,
  `autoComplete="one-time-code"`, 6-digit max, digit-only filter on
  paste, and auto-focus + clear on a failed attempt (so users hit
  with clock drift naturally re-enter a fresh code).

### Changed

- `package.json` bumped to `0.9.0`. New `totp:setup` script entry.
- `server/auth.js` `login()` — runs the password compare and TOTP
  verify regardless of which (if any) failed, so the response time
  doesn't reveal which factor was wrong. All failures return a single
  generic `invalid_credentials` 401, matching the rest of the existing
  auth surface (no user enumeration).
- `.env.example` documents the new (commented-out)
  `OTHONI_TOTP_SECRET`.
- README — new "Security notes" bullet plus an env-table row.

### Notes

- Shipped **with TOTP disabled** on the live VPS. Run
  `npm run totp:setup` on the host whenever you want to enable it; the
  helper prints exactly what to put in `.env` and how to enroll.
- Removing `OTHONI_TOTP_SECRET` and restarting falls back to
  password-only login — useful as a recovery path if the authenticator
  is lost.

## [0.8.1] — 2026-05-10

UI polish pass. No new features, no API changes — just consistency.

### Changed

- New CSS pattern classes in `client/src/styles.css`: `.input`, `.select`
  (with a real custom chevron), `.btn.tiny`, `.btn.compact`,
  `.btn.ghost.active`, `.chip` (with severity variants), `.toolbar`,
  `.toolbar .grow` / `.toolbar .pushright`, `.section-title` (with a
  trailing fade-to-transparent rule), `.stat-tile` (with severity
  variants), `.topbar-bell`. Inline `code` / `kbd` get proper styling.
  `:focus-visible` rings on all interactive elements.
- Page titles now have a small 3px accent bar prefix; subtitle is
  inset to align with the title body.
- All pages refactored to use the new pattern classes — Connections,
  Alerts, Logs, History, Storage, Network, Processes, Docker, Services,
  Settings. The big inline-styled-form-control blocks on Alerts / Logs /
  Connections in particular are gone — those were the most "dev-feeling"
  parts of the UI.
- All pages now wrap their content in `.page-fade-in` so the 240ms
  fade-up transition fires consistently on navigation, not just on
  Dashboard / History.
- Tables on the page-level (Connections, Alerts, Logs, Network, Docker,
  Processes) are now wrapped in `.card` so they share the same
  surface treatment as the rest of the dashboard.

## [0.8.0] — 2026-05-10

Connective tissue + polish — the previously-shipped features (alerts,
logs, history, connections) now link to each other and you can take
their data with you.

### Added

- **Connection history** — four new historical metrics sampled into the
  SQLite store every 5s: `conn.established`, `conn.timewait`,
  `conn.listening`, `conn.total`. New "Connections" section on the
  History page with a multi-line chart of established / time-wait /
  listening over the selected range.
- **Cross-link alerts → logs** — each firing alert in the topbar
  popover now has a "show logs →" link that deep-links to
  `/logs?since=<window>&priority=<level>` with sensible defaults
  (window scales with how long the alert has been firing; priority is
  3=err for crit alerts, 4=warning for warns).
- **URL-driven filters on the Logs page** — `priority`, `since`,
  `limit`, `unit` all read from `?…` on first load and write back via
  `setSearchParams(..., { replace: true })` as the user changes them.
  Page is now shareable / bookmarkable.
- **CSV export on every History chart** — small "↓ csv" button in each
  card header generates a row-per-timestamp, column-per-series CSV from
  the in-memory points and triggers a browser download. Filename is
  `othoni-<chart-slug>-<range>-<iso-stamp>.csv`. No server endpoint —
  the data is already loaded.

### Changed

- `package.json` bumped to `0.8.0`.
- `server/index.js` — added `app.set('trust proxy', 1)`. Without it,
  `express-rate-limit` was emitting `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`
  on every login attempt and the IP-based limiter was falling back to
  the nginx loopback IP for every client.
- `server/history.js` — `METRICS` map gains `conn.*` entries. `takeSample`
  now also calls `getConnections()` (the snapshot is small — count
  fields only — so the extra read is cheap).

## [0.7.0] — 2026-05-10

System log feed via `journalctl --output=json`. Opt-in (default off)
because journal entries can leak sensitive content. New `/logs` page
with priority/since/unit/limit filters and an auto-tail toggle.

### Added

- **`server/collectors/logs.js`** — pure-JS reader that shells out via
  `execFile` to `journalctl --no-pager --output=json` and parses each
  line into `{ t, priority, level, unit, identifier, pid, hostname,
  message }`. Decodes both string and byte-array `MESSAGE` fields. The
  collector is gated behind `OTHONI_LOGS_ENABLED=true` and rejects all
  user input that doesn't match a tight whitelist (unit name regex,
  numeric priority 0–7, fixed `since` choices `5m`/`15m`/`1h`/`6h`/
  `24h`/`today`/`yesterday`).
- **`GET /api/logs`** route. Returns `{ enabled: false, reason }` with
  HTTP 200 when disabled (so the UI can render the "how to enable"
  card without a 500 error). Limit capped at 1000 server-side.
- **Logs page** at `/logs` — table of recent entries with:
  - Filter row: priority dropdown (err+ / warning+ / notice+ / info+ /
    all), since dropdown, limit dropdown, unit text input
  - Auto-tail toggle (refetches every 5s when on; pages itself out
    when the tab is hidden via `usePoller`'s built-in check)
  - "Refresh" button for manual fetch
  - Per-row level chip (color: crit-red for err/crit/alert/emerg,
    warn-amber for warning, accent-blue for notice, muted for info,
    dim for debug)
  - Disabled-state card explaining how to enable + the security
    rationale (kernel iptables logs leak public IPs, error messages
    can leak tokens, etc.)
- **`<IconLogs>`** monochrome SVG icon, added to the sidebar nav.
- **`api.logs({ limit, priority, unit, since })`** client method.

### Changed

- `package.json` bumped to `0.7.0`.
- `.env.example` refreshed: now documents `OTHONI_DB`, `OTHONI_SAMPLE_MS`,
  `OTHONI_RETENTION_MS` (which had drifted out since v0.2.0) plus the
  new (commented-out) `OTHONI_LOGS_ENABLED` flag.
- Sidebar nav order: Dashboard, History, Storage, Processes, Docker,
  Services, Network, Connections, Alerts, **Logs**, Settings.

## [0.6.0] — 2026-05-10

Alerting. Threshold rules with sustained-duration evaluation, a topbar
notification dot with active-alert popover, an Alerts page for editing
rules, and optional browser notifications when rules fire.

### Added

- **Alert rule engine** — `client/src/alerts.js`. Pure functions over a
  list of rules + a sequence of `/api/overview` snapshots. Each rule
  has an enabled flag, a metric, a comparator (`gt` / `lt`), a threshold,
  a sustained-duration window (immediate / 1m / 5m / 15m / 30m), a
  severity (`warn` / `crit`), and a human label. Storage:
  `localStorage` per browser, key `othoni.alerts.rules`. Firing state
  is in-memory only.
- **Supported metrics**: cpu (%), mem (%), swap (%), load1, disk_root
  (%), net_rx / net_tx (B/s), disk_read / disk_write (B/s). All
  evaluated against the live `/api/overview` snapshot — no server-side
  state change.
- **Topbar notification dot** — `<AlertBadge>` with a count badge that
  appears only when alerts are firing. Crit-color (red) if any firing
  rule is `crit`, otherwise warn-color (amber). Clicking opens a popover
  listing each firing alert with metric label, current value, threshold,
  severity, and "sustained for N" duration. Click outside / Esc to
  dismiss.
- **Alerts page** at `/alerts` — table editor for rules. Inline-editable
  fields (label, metric, comparator, threshold, sustained, severity).
  Live "Now" column shows the current value per rule and turns severity-
  colored when firing. "+ Add rule" / "Seed defaults" / delete buttons.
- **Browser notifications (opt-in)** — toggle on the Alerts page. Uses
  the `Notification` API with permission prompt. One notification per
  rule fire, tagged so repeated fires of the same rule replace rather
  than stack.
- **Default rules seeded on first load** — CPU > 90% sustained 5m
  (warn), memory > 90% sustained 5m (crit), root disk > 90% sustained
  1m (crit). Only seeded if no rules exist.
- **`useAlertsEngine` hook** in `App.jsx` — polls `/api/overview` every
  10s when a user is logged in (paused when the tab is hidden). Re-runs
  the evaluator on each tick, fires browser notifications on rules that
  transition from non-firing to firing.
- **`<IconBell>`, `<IconAlerts>`, `<IconPlus>`, `<IconTrash>`** — new
  icons in `Icons.jsx`.

### Changed

- `package.json` bumped to `0.6.0`.
- `App.jsx` — exposes `{ rules, setRules, alertState, activeAlerts }` on
  the App context so the Alerts page can read/write rules without prop
  drilling.
- Sidebar nav order: Dashboard, History, Storage, Processes, Docker,
  Services, Network, Connections, **Alerts**, Settings.

## [0.5.0] — 2026-05-10

Brushable zoom on every History chart, plus a new Connections page surfacing
listening ports + active TCP connections from `/proc/net/{tcp,tcp6,udp,udp6}`.

### Added

- **Brushable time range** — drag-select a window on any chart in the
  History page to zoom in. While dragging, a translucent accent-tinted
  rect tracks the selection; on release, the chart re-renders filtered
  to that window with the same axes and tooltip behavior. A small
  "× reset zoom" pill in the top-right corner clears the selection.
  Shared `useBrush` hook in `Charts.jsx`; opt-in via `enableBrush` prop
  on `<LineChart>`, `<MultiLineChart>`, and `<StackedAreaChart>`. All
  History page cards opt in. Hover and brush coexist (hover suppresses
  while drag is in progress).
- **Connections page** — new top-level route `/connections`. Shows:
  - 4 summary tiles: established / listening / time-wait / total sockets
  - State-breakdown chips (one per TCP state, with counts)
  - **Listening ports** table: rows grouped by `(protocol, port)` so the
    same service bound on `0.0.0.0` and `::` shows as one row, with a
    well-known service hint column for common ports (ssh, http, postgres,
    redis, ...)
  - **Active TCP connections** table: filterable by IP / port / state
    via a search input + state dropdown, capped at 1000 rows server-side
    (a notice appears in the subtitle when truncated)
- **`server/collectors/connections.js`** — pure-JS parser for
  `/proc/net/{tcp,tcp6,udp,udp6}`. Decodes hex little-endian IPv4 and
  IPv6 addresses (with `::`-collapse for the longest run of zeros) and
  maps the TCP state hex to the kernel state names.
- **`GET /api/connections`** route + `api.connections()` client.
- **`<IconConnections>`** — new monochrome SVG icon (a plug) for the
  sidebar nav entry.

### Changed

- `package.json` bumped to `0.5.0`.
- `Charts.jsx` chart primitives accept a new `enableBrush` prop. Cursor
  changes to `crosshair` on hover and `ew-resize` while dragging.
- Sidebar nav order: Dashboard, History, Storage, Processes, Docker,
  Services, Network, **Connections**, Settings.

## [0.4.0] — 2026-05-10

Density + cardinality. Min/avg/max overlay on every dashboard sparkline, plus
per-interface and per-disk historical series with their own chart sections.

### Added

- **Sparkline stats overlay** — `<Sparkline>` accepts `showStats` and `format`
  props. When enabled, draws faint dashed bands at the observed min and max
  values inside the SVG and renders a "min · avg · max" footer row underneath
  in muted text. All four Dashboard StatCards (CPU / RAM / Disk / Network) and
  the Disk I/O read+write sparklines now use it. No extra vertical space
  beyond the small footer line.
- **Per-interface network historical metrics** — `net.iface.<name>.rx` and
  `net.iface.<name>.tx` (bytes/sec) sampled every 5s. Loopback and `veth*`
  interfaces are skipped at sample time so the DB doesn't accumulate orphans
  from short-lived Docker container halves.
- **Per-disk I/O historical metrics** — `disk.dev.<name>.read` and
  `disk.dev.<name>.write` (bytes/sec) sampled per physical block device.
- **History page**: two new sections.
  - **Per-disk I/O** — multi-line "read per device" + "write per device"
    charts, one line per physical block device.
  - **Per-interface network** — multi-line "in per interface" + "out per
    interface" charts, one line per non-loopback / non-veth interface.
- New `useDynamicSeries` hook in `History.jsx` — generic poller for
  variable-cardinality series, used by both Per-disk I/O and Per-interface
  network cards (and later usable by anything else following the same
  pattern).

### Changed

- `package.json` bumped to `0.4.0`.
- `server/history.js` — `isValidMetric()` now matches three patterns
  (`cpu.core.<n>`, `net.iface.<name>.{rx,tx}`, `disk.dev.<name>.{read,write}`)
  in addition to the static metric set.

## [0.3.0] — 2026-05-09

Big data + UI upgrade. New metric coverage, three new chart primitives, full
sidebar/topbar/card polish.

### Added

- **Disk I/O collection** — `server/collectors/diskio.js` parses
  `/proc/diskstats` directly and computes bytes/sec by diffing successive
  reads. Skips partitions and pseudo devices, returns one row per physical
  block device.
- **`GET /api/diskio`** route plus `diskio` field on `/api/overview`.
- **12 new historical metric series** sampled every 5s:
  - `cpu.user`, `cpu.system`, `cpu.idle` (CPU breakdown, percent)
  - `mem.active`, `mem.cached`, `mem.buffers`, `mem.free` (memory breakdown,
    bytes)
  - `disk.read`, `disk.write` (disk I/O, bytes/sec)
  - `cpu.core.0` … `cpu.core.N` (per-core CPU, percent — variable cardinality)
- **Three new chart primitives** in `client/src/Charts.jsx` (still pure SVG,
  no library):
  - `<MultiLineChart>` — multiple series on shared axes with synced hover
    tooltip listing all series at the hovered timestamp
  - `<StackedAreaChart>` — proper stacking with cumulative sums and
    per-layer tooltip
  - `<CoreGrid>` — small vertical-bar grid for live per-core load,
    color-coded at 75/90% thresholds
- **Dashboard redesign**:
  - Hero chart at top: CPU + Memory overlay over the last hour, refreshes
    every 30s
  - **Per-core CPU grid** card with live mini-bars per logical core
  - **Disk I/O** card showing read + write rates with separate sparklines
  - The 4 main stat cards now have monochrome icons next to their titles
- **History page reorganized** into sections:
  - **Compute** — CPU usage, CPU breakdown (stacked area), Load avg
  - **Per-core** — all logical cores overlaid with HSL-spread colors
  - **Memory** — usage line + memory breakdown (stacked area in bytes)
  - **I/O** — disk read+write multi-line + disk usage %
  - **Network** — in/out as a multi-line chart
- **`Icons.jsx`** — small monochrome SVG icon set (16px in 24-unit viewBox,
  inherits `currentColor`). Covers nav items, card categories, and topbar.
- **Sidebar polish**:
  - Icon next to every nav label
  - Active state: accent-tinted background + a glowing left strip + accent
    icon color
  - Footer pinned at bottom with gradient avatar + username + sign-out
    icon button
- **Topbar polish**:
  - Pill-shaped **live indicator** with a 1.6s pulsing green dot
  - Pill-shaped **server clock** updating every second (monospaced)
- **Card polish**:
  - Subtle vertical gradient on the card surface
  - Hover lift (1px translate + brighter border + larger shadow)
  - Bars are now gradient-filled and slightly thinner
  - 160ms cubic-bezier transitions on hover, focus, and bar fills
- **Skeleton loader** on the Dashboard's first paint (shimmer-animated) —
  replaces the plain "Loading metrics…" text.
- **Page transitions** — Dashboard and History fade-up 4px on mount (240ms).
- **Tabular figures** (`font-variant-numeric: tabular-nums`) set globally
  so all digits line up vertically across cards, charts, and tables.
- **`prefers-reduced-motion`** fully respected.
- **Login** focus rings show a soft accent halo; background gets a second
  subtle plume from below.

### Changed

- `package.json` bumped to `0.3.0`.
- `/api/overview` response now includes `diskio` alongside the existing
  fields. UI clients should not require it (it's additive).
- `client/src/api.js` exposes `api.diskio()` for the new route.
- `server/history.js` — `METRICS` map now includes the new series; the
  metric validator accepts both static names and the `cpu.core.<n>` pattern.
- The 4 main stat-card titles now accept an `icon` prop (a React component).

### Fixed

- **Hooks-after-early-return crash** in `MultiLineChart`: a `useMemo` was
  called below an early return path, so when an empty-series component
  later received data the hook order changed and React threw a "Rendered
  more hooks than during the previous render" error that crashed the whole
  page. Fixed by inlining the `domain()` call (it's cheap; memoization
  wasn't worth the footgun).

### Removed

- The `VALID_METRICS` named export from `server/history.js` (it was only
  used internally; now replaced by `isValidMetric()` which also handles
  the dynamic `cpu.core.<n>` pattern).

## [0.2.0] — 2026-05-09

Branding, historical metrics and charts.

### Added

- **Brand mark**: SVG `<Logo>` component (concentric rings + center dot in
  the existing accent color). Replaces the plain `.brand-dot` span in the
  sidebar, topbar, and login card. Inline data-URI favicon shipped in
  `client/index.html` so the browser tab no longer falls back to a cached
  icon from a sibling subdomain.
- **`GET /favicon.ico` returns 204** so the SPA catch-all no longer answers
  the favicon request with `index.html`.
- **History storage** — `server/history.js` opens a SQLite database
  (`better-sqlite3`, WAL mode) at `data/othoni.db` and samples every 5 s:
  - `cpu`, `mem`, `swap`, `load1`, `net_rx`, `net_tx`, `disk_root`
  - 24 h retention, pruned every 10 min
  - Tunable via `OTHONI_DB`, `OTHONI_SAMPLE_MS`, `OTHONI_RETENTION_MS`
- **`GET /api/history?metric=<name>&range=<15m|1h|6h|24h>`** — returns
  `[{t, v}]`. The query downsamples on the fly (averages within fixed-width
  time buckets) so the response is capped at ~500 points regardless of range.
- **Pure-SVG chart components** in `client/src/Charts.jsx`:
  - `<Sparkline>` — small inline line + gradient fill, no axes
  - `<LineChart>` — full chart with y/x axes, grid, hover tooltip showing
    nearest sample
  - No charting library; the bundle stays under 200 KB.
- **Sparklines on Dashboard cards** (CPU, RAM, Disk, Network — last 15 min).
- **History page** (`/history`) with a range selector and 6 large charts:
  CPU, Memory, Load average (1m), Network in, Network out, Disk usage.
- Graceful shutdown — `SIGINT` / `SIGTERM` close the SQLite handle.

### Changed

- `package.json` — added `better-sqlite3` dep; bumped to `0.2.0`.
- Nav order: Dashboard, **History**, Storage, Processes, Docker, Services,
  Network, Settings.

### Removed

- The `.brand-dot` CSS class (no longer referenced).

## [0.1.0] — 2026-05-09

First working release. Built end-to-end on the testing VPS at
`/var/www/othoni`, running on `0.0.0.0:8088`.

### Added

- Express backend with helmet, JSON parsing, cookie-based JWT sessions, and a
  `/api/health` liveness probe.
- Login flow:
  - `POST /api/auth/login` with constant-time credential compare
  - `POST /api/auth/logout`
  - `GET /api/auth/me`
  - 10-attempt-per-15-minute IP rate limit on the login route
- Authenticated read-only API:
  - `/api/system` — hostname, OS, kernel, uptime, public IP, local IPs
  - `/api/cpu` — current load, per-core, model, cores, temperature, load average
  - `/api/memory` — RAM and swap
  - `/api/disks` — non-pseudo mounted filesystems
  - `/api/network` — per-interface counters with live RX/TX speed (calculated
    by diffing `/proc/net/dev` snapshots between requests)
  - `/api/processes` — top N processes via `ps`, sortable by `cpu` or `memory`
  - `/api/docker` — `docker ps -a` parsed from JSON; graceful fallback when
    Docker isn't installed or the socket isn't accessible
  - `/api/services` — systemd unit state via `systemctl show`
    (`active` / `inactive` / `failed` / `activating` / `missing`)
  - `/api/overview` — combined snapshot used by the dashboard
  - `/api/settings` — port, host, hostname, version, NODE_ENV, current user
- React 18 + Vite frontend served from `client/dist` by Express in production:
  - Dark theme with sidebar nav, top status bar, rounded cards
  - Pages: Login, Dashboard, Storage, Processes, Docker, Services, Network,
    Settings
  - Live polling (default 5 s, configurable in Settings, paused when tab
    hidden)
  - Color-coded usage bars (green / yellow / red)
  - Mobile-friendly grid breakpoint at 768 px
- `.env.example`, `.gitignore`, `othoni.service.example`, and a README with
  install / dev / build / systemd instructions.

### Configuration

- Default port `8088`. Customize via `PORT` in `.env`.
- Default credentials `admin` / `admin123` for first-run testing; override via
  `OTHONI_ADMIN_USER` / `OTHONI_ADMIN_PASSWORD`.
- JWT secret read from `OTHONI_JWT_SECRET`; install script auto-generates a
  random one on first setup.

### Operational notes

- Verified on Ubuntu 24.04 LTS, arm64, Node.js 20.20.2.
- All `/api/*` routes hit and validated end-to-end against the real host.
- Docker tab cleanly reports "not detected" when `docker` isn't on PATH.
- Service tab cleanly reports `missing` for uninstalled units (apache2, mysql,
  postgresql, etc.) instead of `inactive`.

[Unreleased]: #unreleased
[0.23.0]: #0230--2026-05-10
[0.22.0]: #0220--2026-05-10
[0.21.0]: #0210--2026-05-10
[0.20.0]: #0200--2026-05-10
[0.19.0]: #0190--2026-05-10
[0.18.0]: #0180--2026-05-10
[0.17.0]: #0170--2026-05-10
[0.16.0]: #0160--2026-05-10
[0.15.0]: #0150--2026-05-10
[0.14.0]: #0140--2026-05-10
[0.13.0]: #0130--2026-05-10
[0.12.0]: #0120--2026-05-10
[0.11.0]: #0110--2026-05-10
[0.10.0]: #0100--2026-05-10
[0.9.0]: #090--2026-05-10
[0.8.1]: #081--2026-05-10
[0.8.0]: #080--2026-05-10
[0.7.0]: #070--2026-05-10
[0.6.0]: #060--2026-05-10
[0.5.0]: #050--2026-05-10
[0.4.0]: #040--2026-05-10
[0.3.0]: #030--2026-05-09
[0.2.0]: #020--2026-05-09
[0.1.0]: #010--2026-05-09
