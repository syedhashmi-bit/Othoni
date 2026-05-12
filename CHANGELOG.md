# Changelog

All notable changes to othoni are recorded here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

_Nothing yet._

## [0.50.0] — 2026-05-12

Dashboard layout customization — **closes Phase 4 (visualization,
storage & ops)**. Each major Dashboard section now has a stable id;
operators can hide / reorder them via a small inline editor (no
modal, no library). Saved in localStorage per browser following
the existing `useLocalSetting` pattern.

### Added

- **Six named sections.** `hero` (last-hour CPU+Memory chart),
  `stats` (top stat tiles), `heatmap` (v0.45 CPU heatmap),
  `cores` (CPU-per-core + Disk-I/O paired row), `uptime`
  (Uptime / Load / Swap tiles), `info` (System / Network / CPU
  info row).
- **Dashboard layout state** in `othoni.dashboardLayout`
  localStorage key. Shape: `[{ id, visible }, ...]`.
- **`reconcileLayout(saved)`** reconciler. Drops unknown ids
  (graceful degrade across upgrades that remove a section),
  dedupes repeats, and appends any newly-added section ids
  (graceful upgrade-forward when a future release adds a
  section) with `visible: true` so the new bits show up by
  default. Validated against 7 unit-test cases (null /
  undefined / empty / unknown-dropped / reorder-respected /
  duplicate-dedup / missing-appended) all pass.
- **`<LayoutEditor>` inline panel.** Opens to the right of the
  "Layout ▾" button on the Dashboard page header. Each section
  row has a visibility checkbox + ▴/▾ buttons for move-up /
  move-down. "reset" button restores defaults. Pure JSX, ~50
  lines, no third-party DnD library.

### Changed

- `package.json` bumped to `0.50.0`.
- `client/src/pages/Dashboard.jsx` — refactored render to build
  a `sections` keyed map and dispatch over the saved layout.
  Header rewritten to host the Layout button.

### Notes

- **Per-browser, not per-account.** localStorage is the simplest
  thing that works for a single-admin dashboard. If multi-user
  / cross-device sync becomes interesting later, a
  `data/dashboard-layouts.json` keyed by username is the natural
  next step. Not done here.
- **No drag-and-drop.** Up/down buttons keep the implementation
  in-bounds with the no-icon-library, no-DnD-library
  preferences. Each move is one click; reordering 6 sections
  with the worst-case end-to-start swap costs 5 clicks. Worth
  the bundle savings.
- **Section ids stay stable across releases.** A future release
  that adds a section just appends to `SECTIONS`; existing
  users' saved layouts auto-pick it up via `reconcileLayout`.
- Closes Phase 4. Phase 4 total: v0.45 CPU heatmap, v0.46
  process tree, v0.47 per-metric retention, v0.48 nightly
  VACUUM scheduler, v0.49 bulk archive export, v0.50 dashboard
  layout customization.

## [0.49.0] — 2026-05-12

Bulk archive export. NDJSON stream of every historical table over a
time range, suitable for offsite backup or one-shot ingestion into a
"real" TSDB / log store. Bearer-token auth (separate token from the
Prometheus exporter so they can be rotated independently). Off by
default; setting `OTHONI_EXPORT_TOKEN` enables the endpoint.

### Added

- **`GET /api/export?from=<ms>&to=<ms>`** endpoint. Mounted before
  the cookie auth wall (next to `/metrics` and `/api/metrics`).
  Returns `application/x-ndjson`; one JSON object per line.
- **NDJSON format.** First line is a header
  (`{ _header: true, version, from, to, totals: { ... }, grandTotal,
  cap, truncated }`) with per-table row counts so a streaming parser
  can pre-allocate. Subsequent lines are
  `{ table, ...row-fields }`. Trailing line is
  `{ _final: true, rowCount, truncated }` so the consumer can
  confirm a complete dump.
- **Six tables.** `samples`, `process_samples`, `alert_fires`,
  `audit_log`, `webhook_deliveries`, `action_history`. All
  filtered by `t >= from AND t < to`. Ordered by `t ASC` (then
  by metric/rule for stable output).
- **Per-row cap.** `OTHONI_EXPORT_MAX_ROWS` (default 1_000_000).
  Once emitted, the rest of the export stops; the final line
  carries `truncated: true`. Defensive against a typo'd huge
  range against a dense ingest.
- **Optional `?tables=` filter.** Comma-separated whitelist. Skipped
  tables don't appear in the header `totals` either. Useful for
  syncing just the samples table to a TSDB without dragging the
  audit log along.
- **`OTHONI_EXPORT_TOKEN` env var.** Constant-time Bearer compare,
  same pattern as the Prom exporter. Unset → endpoint returns
  404 (don't advertise its existence). Missing/wrong header →
  401.
- **`OTHONI_EXPORT_MAX_ROWS` env var.** Override the default row
  cap.

### Changed

- `package.json` bumped to `0.49.0`.
- `server/index.js` — mounts `/api/export` before the cookie wall.
- `.env.example` — documents both new env vars.

### Notes

- **No materialization in JS heap.** Streams via better-sqlite3's
  `stmt.iterate()` so a 1M-row export goes through a row-by-row
  pipeline. Verified end-to-end against the live VPS: 2009 rows
  / ~146 KB returned in well under a second with no memory
  spike.
- **`from < to` enforced** at request time. Defaults to the last
  24h when both are missing, so a bare `curl /api/export` still
  does the right thing. `to` clipped to "now" so a typo can't
  ask for the future.
- **Why streaming NDJSON, not a single JSON array.** Two reasons:
  (1) operators can `| jq` line-by-line without loading the
  whole thing into RAM. (2) The header + trailer envelope lets
  the consumer detect a truncated download (the `_final` row
  won't appear if the connection dropped mid-stream).
- **No write path.** Importers / replicators are downstream
  concerns; this is one-way egress. If/when an import path
  becomes interesting, it'd live alongside the metrics ingest.
- Smoke-tested live: 401 on missing/wrong token, 400 on inverted
  range, valid export returned a well-formed header with
  per-table counts (`samples: 1647, process_samples: 357,
  audit_log: 5`), 2009 row lines, and a final `_final` row with
  matching `rowCount: 2009`. `?tables=audit_log` filter scoped
  the output to just that table. Token unset → 404 on both
  empty and wrong-Bearer requests, confirming the endpoint
  doesn't leak its existence.

## [0.48.0] — 2026-05-12

Nightly SQLite VACUUM scheduler. SQLite never reclaims pages from
deleted rows on its own — the 24h retention cleanup deletes rows but
the freed pages stay in the WAL and the main file grows steadily.
v0.48 adds a configurable nightly job that runs `VACUUM` + a
`wal_checkpoint(TRUNCATE)` to defragment + reclaim. Surfaces last-run
+ reclaimed bytes on the Storage card, with an admin-only "Run now"
button.

### Added

- **`server/vacuum.js`** scheduler. `start()` ticks every 60s and
  fires when the local clock crosses into the configured HH:MM.
  A "fired this minute" flag prevents double-runs; reset when the
  clock leaves the scheduled minute so the next day's tick fires
  again. The run pre-flight checkpoint flushes the WAL into the
  main file; `VACUUM` defragments; a post-flight checkpoint folds
  the post-VACUUM rewrites back so the measured size reflects
  steady-state rather than the transient WAL bulge.
- **`OTHONI_VACUUM_TIME`** env var (HH:MM 24-hour local, default
  `03:30`). Accepts `off` / `false` / empty to disable. Documented
  in `.env.example`. Invalid values (bad hour/minute) → disabled
  with a logged warning.
- **`GET /api/vacuum`** — `{ enabled, scheduledLocal, lastRunAt,
  reclaimedBytes, durationMs, error, source, running }`. Cookie-
  auth, viewer-readable.
- **`POST /api/vacuum/run`** — admin-only manual trigger. Captured
  in the audit log with the post-run stats as metadata.
- **`vacuum.run` audit action.**
- **State persistence at `data/vacuum-state.json`** so the Storage
  card can show "last vacuum X hours ago" even after a service
  restart.
- **Vacuum panel on the Storage card.** Three-tile row below the
  existing config tiles: scheduled time, last run + reclaimed, and
  an admin-only Run-now button. Pulls `/api/vacuum` alongside
  `/api/db/stats` on every 30s refresh.

### Changed

- `package.json` bumped to `0.48.0`.
- `server/index.js` — boots `vacuum.start()` after history is up;
  registers stop on `SIGTERM`/`SIGINT`.
- `server/audit.js` — `vacuum.run` added.
- `server/routes/index.js` — two new routes.
- `.env.example` — documents `OTHONI_VACUUM_TIME`.
- `client/src/api.js` — `api.vacuum.{status,run}`.
- `client/src/pages/Settings.jsx` — `<StorageCard>` grows the
  vacuum panel + Run-now action.

### Notes

- **Footprint = main `.db` file only.** First pass measured `.db
  + -wal + -shm`, which made the reported "reclaimed" go strongly
  negative because every page touched by VACUUM gets logged in
  the WAL — the WAL briefly grew ~equal to the rewrites. The
  fix: a second `wal_checkpoint(TRUNCATE)` *after* VACUUM folds
  those pages back, and we report only the main file delta. WAL
  is transient and not interesting as a "reclaimed" number.
- **Single tick of 60s granularity.** A more precise scheduler
  (cron parser etc.) would add a dep or ~200 lines of hand-rolled
  parsing; the existing pattern is one cron-style time per
  deployment, the operator just picks an off-hours minute. 60s
  resolution is plenty.
- **Manual trigger doesn't pause the sampler.** better-sqlite3 is
  synchronous so VACUUM blocks; the sample tick that lands during
  VACUUM just waits its turn. Smoke-tested 326ms total run time
  on a ~34 MB database — well under the 5s sample cadence.
- Smoke-tested live: `/api/vacuum` reports `enabled:true,
  scheduledLocal:"03:30"`. Manual POST returned `ok:true,
  reclaimedBytes:184320, durationMs:324`. State file persisted
  the run. Audit log captured `vacuum.run` with the metadata.
  Env-flag handling verified for `off`, invalid `25:00`, and
  shorthand `3:30` (padded to `03:30`).

## [0.47.0] — 2026-05-12

Per-metric retention overrides. Every metric shares the global
`OTHONI_RETENTION_MS` default (24 h). Some series benefit from longer
retention — most notably `disk_root` for capacity planning, or any
`custom.<host>.disk_root` from remote agents. v0.47 adds an opt-in
override layer keyed by pattern (exact or glob) → TTL, with the
cleanup pass honoring the longest matching TTL per metric.

### Added

- **`server/retention.js`** + `data/retention-overrides.json`
  atomic-write store. Pattern syntax matches the metric name
  alphabet plus `*` for glob (e.g. `disk_root` or
  `custom.*.disk_root`). TTL bounded to `[60s, 1 year]`. Hard
  cap of 64 overrides.
- **`effectiveTtl(metricName)`** returns the longest matching
  override (or null when nothing matches → caller falls back to
  the global default). Regex compile is memoized between
  cleanup passes; invalidated on save.
- **`GET /api/retention`** — returns
  `{ defaultMs, overrides: [{ pattern, ttlMs }], bounds: { minMs, maxMs } }`.
  Cookie-auth, viewer-readable.
- **`PUT /api/retention`** — replaces the whole override list
  atomically. Admin-only via `requireAdmin`. 400s on
  `invalid_pattern` / `invalid_ttl` / `duplicate_pattern` /
  `invalid_request`.
- **`retention.update` audit action** with `{ count }` metadata.
- **Retention overrides card on Settings.** Tabular editor with
  pattern + ttlMs + a human "reads as" hint (1h/2.5d/etc).
  Save/dirty model identical to the Alerts rules editor.

### Changed

- `package.json` bumped to `0.47.0`.
- `server/history.js` — `cleanup()` now does per-metric pruning:
  groups distinct metric names by their effective TTL (longest
  matching override or global default), then issues one DELETE
  per TTL group with `WHERE metric IN (?, ?, ...)`. Falls back
  to a single bulk DELETE if the `retention` module fails to
  load (defensive, never expected in practice).
- `server/audit.js` — `retention.update` added.
- `server/routes/index.js` — two new routes.
- `client/src/api.js` — `api.retention.{get,set}`.
- `client/src/pages/Settings.jsx` — new `<RetentionCard>`,
  mounted between Hosts and Sessions. Audit label updated.

### Notes

- **Longest TTL wins per metric.** A broader pattern can never
  shorten the retention of a metric also matched by a more
  specific override — that would be a surprising-and-bad
  default (operator carefully extends `disk_root` to 30 days,
  then accidentally adds a `*` override at 6h and silently
  loses 24 days of data). Implementing this as "longest wins"
  matches the operator's mental model: "extend, don't trim."
- **No way to shorten below the global default for now.**
  Possible follow-up if anyone needs per-metric trim. The MIN
  bound of 60s exists only to make sure the override doesn't
  race the 10-min cleanup tick.
- Smoke-tested live:
  - Empty list → defaults JSON returned.
  - `PUT` two overrides (exact `disk_root` + glob
    `custom.*.disk_root`, both 7d). Roundtripped via GET +
    `data/retention-overrides.json` atomic written.
  - `effectiveTtl('disk_root')` = 7d, `effectiveTtl('custom.app.disk_root')`
    = 7d (matched by glob), `effectiveTtl('cpu')` = null.
  - 400 paths: ttlMs=1000 → `invalid_ttl`; pattern with space →
    `invalid_pattern`; duplicate pattern → `duplicate_pattern`.
  - Audit log captured two `retention.update` events with the
    correct `count` metadata.
  - Overrides cleared after smoke test.

## [0.46.0] — 2026-05-12

Process tree view. The existing Processes page Top-20 table is great
for "who's burning CPU right now," but bad at answering "which
service group is eating CPU." v0.46 adds a Tree toggle on the same
page — full parent/child graph built from `ps -o pid,ppid,...`,
with subtree-aggregated CPU + memory and heavy-branch highlighting.

### Added

- **`GET /api/processes/tree`** endpoint. Runs `ps` with an extra
  `ppid` column, builds the pid → node map, links children to
  parents, computes bottom-up subtree aggregates (`aggCpu`,
  `aggMemory`), and sorts children by descending `aggCpu` so the
  heaviest branches surface first. Defensive against `pid==ppid`
  cycles (would never happen in a real snapshot but cheap to
  guard).
- **`getProcessTree()` collector** in `server/collectors/processes.js`
  using a new `PS_TREE_ARGS` so the existing flat-list endpoint
  doesn't pay for the extra column.
- **Tree toggle on the Processes page.** New `view` state (`list`
  / `tree`); toggle buttons in the right side of the toolbar. The
  list view (TrendsCard + ps table) is unchanged; the tree view
  replaces both with a single `<ProcessTree>` card.
- **`<TreeRow>` recursive renderer.** Indent by depth, collapsible
  per node (`▸` / `▾`), shows self + aggregated CPU/MEM side-by-
  side. Heavy subtrees (aggCpu ≥ 20%) get an accent-tinted row
  background + bold name + accent-colored aggCpu cell. Roots
  default to open; descendants open automatically only when
  they're heavy *and* shallow (depth < 2) to avoid auto-
  expanding deep noisy trees.
- **`api.processTree()`** client helper.

### Changed

- `package.json` bumped to `0.46.0`.
- `server/collectors/processes.js` — adds `getProcessTree`.
- `server/routes/index.js` — mounts `/api/processes/tree`.
- `client/src/api.js` — adds `processTree`.
- `client/src/pages/Processes.jsx` — new view toggle, new
  `<ProcessTree>` + `<TreeRow>` components. By-CPU / By-memory
  sort buttons disable in tree view (tree view sorts by aggCpu
  intrinsically).

### Notes

- **Aggregation is sum-of-subtree.** `aggCpu` for a node is its
  own `%cpu` plus every descendant's `%cpu`. So a parent shell
  whose child is hammering CPU shows up as heavy even if the
  parent itself is idle — that's the whole point of the tree
  view (find the *service group* burning CPU, not the leaf).
- **One root for userland + one for kernel threads.** PID 1
  (`systemd`) and PID 2 (`kthreadd`) on Linux. The build
  detects this naturally — anything whose ppid isn't in the
  table or whose ppid is 0 becomes a root.
- Smoke-tested live: 169 processes → 2 roots
  (systemd + kthreadd), correct subtree aggregation (systemd's
  subtree CPU summed to 146.8% on a multi-core box), heavy-
  branch sorting visible (sshd parent at 113.2% rose to the
  top of systemd's children).

## [0.45.0] — 2026-05-12

Per-core CPU heatmap — opens Phase 4 (visualization, storage & ops).
The existing `<CoreGrid>` shows the *current* per-core load; this
adds a 2-D heatmap of per-core load *over time* on the Dashboard
hero area. Pure SVG, no library — fits the no-chart-library
convention. Hot/cold ramps cool blue (idle) → amber (~75%) →
red (90%+).

### Added

- **`<Heatmap>` primitive in `client/src/Charts.jsx`.** Rows =
  cores, columns = time buckets. HSL hue ramp for cell color (220→
  200→40→0 across 0→60→75→100%). Hover tooltip with bucket
  timestamp + value. Time-axis labels along the bottom edge. Pure
  SVG, ~160 lines including the color ramp.
- **`GET /api/history/cpu-cores?range=&buckets=`** endpoint.
  Discovers every `cpu.core.<n>` series with samples in the range,
  bucket-averages each over the requested range, returns
  `{ range, from, to, bucketMs, cores: [{ metric, core, points }] }`.
  Server caps buckets at 600 to keep payloads bounded.
- **CPU heatmap card on the Dashboard hero area.** Range picker
  (15m / 1h / 6h / 24h); refresh every 30s; mounted between the
  top stat tiles and the existing CoreGrid (now relabeled "CPU
  per core (now)" to disambiguate). Uses the new
  `api.cpuCores({ range, buckets })` helper.

### Changed

- `package.json` bumped to `0.45.0`.
- `server/history.js` — new `queryCpuCores()`. Inlines the
  bucket-ms literal into the SQL so SQLite does INTEGER division
  on the bucket math; better-sqlite3 binds JS Numbers as REAL by
  default, which would otherwise turn `t / 30000` into a real
  divide and one row per raw sample. (The existing `query()`
  function has the same latent issue; left alone here since fixing
  it risks subtly changing the History page; tracked for a
  separate cleanup.)
- `server/routes/index.js` — mounts the new endpoint.
- `client/src/api.js` — `api.cpuCores({ range, buckets })`.
- `client/src/Charts.jsx` — `<Heatmap>` export.
- `client/src/pages/Dashboard.jsx` — `<CpuHeatmapCard>` between
  the top stat tiles and CPU-per-core/Disk-I/O row.

### Notes

- Smoke-tested live: `GET /api/history/cpu-cores?range=15m&buckets=30`
  returned 31 points per core with exact 30-second gaps between
  bucket centers. Range fallback for invalid input
  (`range=bogus`) defaults to 1h cleanly. 2-core test box; 24h
  request returned 121 buckets per core at 12-minute width as
  expected.
- The color ramp uses `hsl()` directly rather than the theme
  tokens because the gradient needs a smooth interpolation that
  CSS variables can't express. Saturation/lightness fixed; only
  hue changes with value.

## [0.44.0] — 2026-05-12

Per-host detail page — **closes Phase 3 (per-host depth)**. Clicking
a host card on `/hosts` now drills into `/hosts/<host>` — a dashboard-
shaped view scoped to that one host. Hero chart with metric +
brushable-zoom range picker, the same 6 stat tiles as the Hosts page
(now bigger), an "Other custom metrics" section for non-standard
agent leaves, and a recent-fires-on-this-host timeline filtered to
the host.

### Added

- **`GET /api/hosts/:host`** endpoint. Returns `{ host: { host,
  lastSeenAt, live, metrics, extras, meta, fires } }`. `live` is
  true iff there's at least one sample in the last 10 min. 404
  when the host has no live samples *and* no metadata *and* no
  alert_fires rows — i.e. nothing the dashboard knows about by
  that name. Labeled-only hosts (metadata exists but no live
  samples) return 200 with `live: false` so the URL stays stable
  across agent downtime.
- **`/hosts/:host` React route + page.** Hero chart with metric
  + range picker (15m / 1h / 6h / 24h, brushable zoom),
  stat-tile grid scaled up from the Hosts page tiles (now 180px
  sparklines), extras section, host-scoped fires table.
- **Click-to-drill on the Hosts page.** Each host card's name is
  now a `<Link>` to the detail page with a `→` affordance.
- **Header chip strip on the detail page.** Freshness chip
  (live / "no samples in last 10 min"), env chip, owner line,
  tag chips, free-text notes — all sourced from the v0.43
  metadata overlay. Renders gracefully when meta is null.

### Changed

- `package.json` bumped to `0.44.0`.
- `server/hosts.js` — new `getHostDetail(host)` does the
  single-host scan + the alert-fires-by-host lookup + the
  metadata overlay. Exported alongside `getHosts`.
- `server/routes/index.js` — mounts `GET /api/hosts/:host`.
- `client/src/api.js` — `api.hostDetail(host)`.
- `client/src/App.jsx` — registers `/hosts/:host`.
- `client/src/pages/Hosts.jsx` — host card name becomes a link.

### Notes

- **Action-runs-targeting-this-host section deferred.** The
  roadmap mentioned it ("alert fires originating from it, action
  runs targeting it"), but actions in the current framework
  always run on the local box (`systemctl restart`, `docker`,
  `process.signal` against the dashboard's own host). There's
  no concept of an action that targets a *remote* host — the
  framework would need a separate "exec via the agent" path,
  which is way out of scope for v0.44. Fires-only on this page;
  actions covered by the standalone `/actions` page.
- **Brushable zoom on the hero chart** comes for free via the
  existing `<LineChart>` primitive — same component that powers
  the History page brushing.
- **Stat-tile sparkline range follows the page range picker.**
  So switching to 6h on the hero also pulls 6h of history into
  every tile sparkline. One round-trip per tile (same pattern
  as the existing Hosts page), kept light by the sampler's
  cheap (metric, t)-index lookups.
- Smoke-tested end-to-end:
  - Pushed `custom.v44host.{cpu,mem,something_else}` samples
    via a fresh API key. Labeled the host with owner / env /
    tags / notes. Installed a `cpu > 50` per-host rule on
    `v44host` that fired within the next 10s tick.
  - `GET /api/hosts/v44host` returned `live:true`, both known
    leaves (`cpu`, `mem`) in `metrics`, `something_else` in
    `extras`, the metadata overlay, and the 1 fire with
    `host="v44host"`.
  - `PUT /api/host-meta/ghosthost` for an unpushed name, then
    `GET /api/hosts/ghosthost` → 200 with `live: false`,
    `lastSeenAt: null`, no metrics, but meta intact.
  - `GET /api/hosts/ghost-host-does-not-exist` → 404.
  - Cleaned up the test API key, rule, and metadata. Final
    rules + host-meta state restored to baseline.

This release closes Phase 3 (per-host depth). Phase 3 total: v0.41
per-host alert rules, v0.42 per-host webhook subscriptions, v0.43
host metadata, v0.44 host detail page. Together they take othoni
from "discover hosts by name" to "first-class per-host scoping
across rules, webhooks, metadata, and a dedicated drill-down view."

## [0.43.0] — 2026-05-12

Host metadata overlay. Hosts have been auto-discovered from
`custom.<host>.*` since v0.30 but they're just bare names — no
"who owns this", "what env is this", "what is it for". v0.43 adds
an opt-in metadata layer (`owner`, `environment`, `tags`, `notes`)
keyed by host. Stored as a JSON file, surfaced on the Hosts page
card and via filter pills, edited from the Settings page.

### Added

- **`server/host-meta.js`** + `data/hosts.json` store. Atomic
  save (tmp + rename) following the existing
  webhooks/alert-rules pattern. Validation: host name matches
  the ingest pattern (`[a-z0-9-]{1,40}`); `owner` ≤ 80 chars;
  `environment` ≤ 40 chars; `tags` array ≤ 16 entries each
  ≤ 40 chars; `notes` ≤ 2000 chars. Empty patch (`{}` or all
  fields cleared) removes the row entirely.
- **`GET /api/host-meta`** — full `{ byHost: { ... } }` snapshot,
  cookie-auth, GET so viewers see it too.
- **`PUT /api/host-meta/:host`** — upsert; partial patches merge
  with the existing record. Admin-only (`requireAdmin`).
- **`DELETE /api/host-meta/:host`** — remove. Admin-only. 404
  when the host has no row.
- **Overlay on `GET /api/hosts`** — every host entry now
  carries a `meta` field (null when no row exists). Same
  endpoint, additive shape.
- **Host card chips + notes on the Hosts page.** Environment
  pill, tag chips, "owner: …" line, multi-line notes block
  under the freshness chip.
- **Filter pills on the Hosts page.** Per-environment +
  per-owner toggles (auto-populated from the metadata that's
  actually present). All / clear filters via the explicit "all"
  button per row.
- **Hosts card on the Settings page** with a table-of-rows
  editor (owner / environment / tags / notes per host). Save
  per row; "clear" wipes the row from disk. Viewer sessions see
  the table read-only (inputs disabled; no Save / clear
  buttons).
- **`host.meta.update` + `host.meta.delete` audit actions.**

### Changed

- `package.json` bumped to `0.43.0`.
- `server/audit.js` — two new entries in the whitelist.
- `server/hosts.js` — `getHosts()` overlays metadata onto each
  host. Imports `host-meta`.
- `server/routes/index.js` — three new routes; imports the new
  module.
- `client/src/api.js` — `api.hostMeta.{list,upsert,remove}`.
- `client/src/pages/Hosts.jsx` — host card surfaces metadata
  chips + notes; page header grows filter pill rows.
- `client/src/pages/Settings.jsx` — new `<HostsCard>` mounted
  between Actions and Sessions. Audit action labels updated.

### Notes

- **Metadata + ingest are independent.** A host can be labeled
  before it ever pushes; a labeled host whose agent goes silent
  keeps its metadata for the next time it comes back. The
  Settings → Hosts card lists the *union* of discovered hosts
  + currently-labeled hosts so an offline host's metadata stays
  editable.
- **No schema-level changes** — metadata is overlay-only, lives
  in its own JSON file, never touches the SQLite samples table.
  Removing a host's metadata doesn't touch its samples.
- **No `Won't do` for tag taxonomy** — tags are free text. The
  filter pills only show tags that some host actually has.
- Smoke-tested end-to-end on the live VPS:
  - Initial `/api/host-meta` returns `{ byHost: {} }`.
  - `PUT /api/host-meta/smoketesthost1` with
    `{owner, environment, tags[], notes}` round-trips and
    overlays on `/api/hosts`.
  - Invalid host (uppercase) → 400 `invalid_host`.
  - `tags: "not-array"` → 400 `invalid_request`.
  - Empty patch deletes the row (`meta: null`).
  - `DELETE` on a non-existent host → 404 `not_found`.
  - Viewer GET → 200; viewer PUT → 403 (requireAdmin).
  - Audit log captures `host.meta.update` with the changed
    field names and `host.meta.delete` events.
  - File persists; atomic write verified by reading
    `data/hosts.json` between operations.
  - Cleanup leaves `data/hosts.json` empty.

## [0.42.0] — 2026-05-12

Per-host webhook subscriptions. v0.41 let alert rules target a
specific host; this release lets a webhook destination opt into
*receiving* only that host's fires. Use case from the roadmap:
route `db-*` alerts to the database team's Slack channel and
`app-*` to the app team's. New optional `hostFilter` on each
webhook — empty / `*` keeps the existing "all alerts" behaviour,
exact name or glob filters by `event.rule.host`. The webhook
payload also surfaces the host attribution so downstream
consumers can route after the fact.

### Added

- **`hostFilter` field on each webhook.** Stored alongside
  `label`, `url`, `format`, `enabled`. Accepted shapes:
  - empty / `null` / `*` — match every alert (back-compat).
  - `local` — match only local-box rules (where `rule.host` is
    null).
  - `<glob>` — `*` is the only wildcard. Matched against
    `rule.host || 'local'`. So `db-*` catches `db-1`, `db-2`;
    `app-srv-*` catches `app-srv-2`; an exact name catches only
    that name.
  - Validation: `[a-z0-9*][a-z0-9*\-.]{0,79}` so a filter can
    only reference characters the host pattern itself allows.
- **`POST /api/webhooks` and `PATCH /api/webhooks/:id` accept
  `hostFilter`.** Persisted; surfaced by `GET /api/webhooks` on
  every list response.
- **`rule.host` field on the generic-format webhook payload.**
  `null` for local-box rules; the agent host for per-host rules.
  Downstream consumers can route on it without parsing the
  human-readable `text`.
- **Host annotation in `text`.** Slack/Discord/generic all now
  carry `on <host>` in the human text when the rule has a host:
  `[WARN] PH3 host CPU on db-1 — 92.0% > 90.0% (sustained 5m)`.
- **`invalid_host_filter` error code** on create / update for a
  malformed filter (400).
- **Inline host-filter editor on the Webhooks card.** Tiny mono
  input below the label; saves on blur. Read-only for viewers
  (admin-only via the existing `requireAdmin` guard). The
  create-webhook form grows the same field.

### Changed

- `package.json` bumped to `0.42.0`.
- `server/webhooks.js` — `HOST_FILTER_RE` + `isValidHostFilter` +
  `matchesHostFilter` (the actual gate). `createWebhook` /
  `updateWebhook` accept and validate `hostFilter`. `sanitize`
  surfaces it. `dispatch` filters by it before calling
  `fireOne`. `defaultText` includes `on <host>` when set. Generic
  payload exposes `rule.host`.
- `server/routes/index.js` — passes `hostFilter` through both
  create + update; surfaces the new validation error code; audits
  the field on creation.
- `client/src/api.js` — `api.webhooks.create` forwards
  `hostFilter`.
- `client/src/pages/Alerts.jsx` — `<WebhooksCard>` gains the
  filter UI; viewer sessions see a read-only chip when set.

### Notes

- **Filter syntax stays tiny on purpose** — single wildcard `*`,
  no negation, no comma-separated alternatives. The roadmap was
  clear that this is a "small ops team" feature, not a routing
  engine. If someone needs richer routing later, the natural step
  is v0.60's on-call rotation (cron-based scheduling).
- **Filter is matched against the *alert's* host, not the
  *dashboard's* host.** Per-host rule fires → `rule.host` set
  → matched against the filter. Local-box rule fires →
  `rule.host` null, treated as the literal `local` string for
  matching → `local` filter catches it, `*` filter catches it,
  any other filter doesn't.
- **No `host` filter migration needed** — the field defaults to
  empty string in `sanitize` and read-back code, so existing
  webhooks on disk (no `hostFilter` key) just behave like
  `hostFilter: ""` until they're edited.
- Smoke-tested end-to-end on the live VPS:
  - In-process unit test of `matchesHostFilter` over 13 cases
    (empty, `*`, `local`, exact, glob, glob-spans-hyphens,
    glob-doesn't-match-other-prefix, mismatch) — all pass.
  - HTTP: bad filter (uppercase) → 400 `invalid_host_filter`.
  - Created three webhooks pointing at a local Node listener on
    `:9988/{any,host1,local}` with `hostFilter` `""`,
    `smoketesthost1`, `local` respectively.
  - Pushed `custom.smoketesthost1.cpu=95` samples + installed two
    alert rules: a local-box always-fire (`cpu > -1`) and a
    per-host always-fire on `smoketesthost1` (`cpu > 50`).
  - After the next 10s tick, the listener log showed exactly
    what was expected: `/local` got only the null-host rule,
    `/host1` got only the `smoketesthost1` rule, `/any` got
    both. Generic-payload `rule.host` carried the host
    attribution. Slack-style text included `on smoketesthost1`.
  - Cleaned up all 3 webhooks + the 2 test rules + the test API
    key after.

## [0.41.0] — 2026-05-12

Per-host alert rules — opens Phase 3 (per-host depth). Until now,
every alert rule evaluated against the local box's snapshot. With
multi-host attribution (v0.23.0) and `agent.sh` (v0.25.0) pushing
samples from N machines, the natural next step is to let rules
target *those* hosts: "alert when `app-server-1`'s CPU > 90%
sustained 5 min." Rule schema grows an optional `host` field; the
evaluator branches accordingly. Local-box rules continue to work
unchanged (no `host` set = existing behaviour).

### Added

- **Optional `host` field on alert rules.** DNS-style validation
  (matches the existing ingest pattern, so a rule never references
  a host name the ingest would reject). Missing/empty = local-box
  rule, full back-compat.
- **Per-host evaluator path.** When `rule.host` is set, the
  evaluator reads `custom.<host>.<metric>` from the samples table
  instead of the local snapshot. For rate comparators
  (`rate_gt` / `rate_lt`), the rate query uses the host-attributed
  metric name too. Latest-value lookups for per-host rules have a
  10-minute freshness window so a host that stops reporting stops
  firing on its stale last value.
- **`host` column on `alert_fires`.** Idempotent migration adds
  it; pre-v0.41 rows get NULL (rendered as the local-box default
  on read). Fires triggered by a per-host rule denormalize the
  host into the row so the Recent fires card can show which host
  fired even after the rule is deleted.
- **`host` field threaded through `/api/alerts/active` and
  `/api/alerts/history`.** Per-rule active entries now carry
  `host: "..."` or `null`; recent-fires rows ditto.
- **Host picker on the Alerts rule editor.** Inline under the
  metric select: `on [this box ▾]` with options sourced from
  `/api/hosts`. Refreshed every 60 s. A previously-saved host
  that's no longer in the hosts list shows up as
  `<host> (offline)` so it stays editable even when the agent is
  down.
- **Host chip on the Recent fires timeline** + an "on <host>"
  annotation in the live rule row's "Now" column for per-host
  active rules.

### Changed

- `package.json` bumped to `0.41.0`.
- `server/history.js` — `migrate()` adds the `host` column to
  `alert_fires` idempotently.
- `server/alerts.js` — new `HOST_RE` + `isValidHost`, `host`
  validation in `isValidRule`, `sampleMetricFor(rule)` + new
  `latestForHost()` helper, `tick()` branches on `rule.host`,
  `recordFires()` writes `host`, `listFires()` selects it,
  `projectActive()` includes it.
- `client/src/pages/Alerts.jsx` — Alerts page fetches `/api/hosts`
  and threads the list into `<RuleRow>`. New host picker inline
  under the metric select. Active "Now" cell shows host, recent
  fires rows carry a host chip.

### Notes

- The intersection of "metrics agent.sh pushes" and "metrics the
  alert engine knows about" is currently {cpu, mem, load1,
  disk_root, net_rx, net_tx}. Per-host rules targeting `swap` /
  `disk_read` / `disk_write` will silently never fire unless a
  custom agent pushes those leaves under `custom.<host>.*`. That's
  fine — null value → no breach → no spurious fire.
- Smoke-tested end-to-end against the live VPS:
  - Minted an API key, pushed four `custom.smoketesthost1.cpu=95`
    samples via the Bearer-auth ingest.
  - Created a rule `{ metric: "cpu", host: "smoketesthost1",
    comparator: "gt", threshold: 50, durationMs: 0 }`.
  - After the next 10 s tick: `/api/alerts/active` returned the
    rule firing with `host: "smoketesthost1"`, `value: 95`,
    `valueFmt: "95.0%"`. `/api/alerts/history` row carried the
    same `host`.
  - Pushed a rule with a malformed host (uppercase) → server
    `dropped invalid rule` warn, rule dropped on save.
  - Pushed a rule against a host with no samples ever
    (`nonexistent`) → never fired.
  - Original rules restored after smoke test; key revoked.

## [0.40.0] — 2026-05-12

Login lockout. Fourth Phase 2 release — **closes Phase 2 (auth &
access)**. Express-rate-limit caps the request *rate* from a single
IP, but doesn't *lock* — after its window the attacker resumes. v0.40
adds the lockout half: after N consecutive failures from one IP, that
IP is rejected for M minutes regardless of how slow the attacker
trickles requests. Locked attempts skip the credential check
entirely, so no scrypt CPU is wasted on attackers and the timing
channel narrows.

### Added

- **`server/login-lockout.js`** — in-memory per-IP failure tracker.
  `check(ip)` returns `{ locked, unlockAt?, retryAfterSec? }`;
  `recordFailure(ip, { actor })` increments and optionally locks;
  `recordSuccess(ip)` clears the IP's counter. Memory-bounded by
  cleanup-on-touch (entries forgotten after 24h of inactivity) and
  a 1024-entry LRU cap.
- **`OTHONI_LOGIN_LOCKOUT_FAILS` (default 5) and
  `OTHONI_LOGIN_LOCKOUT_MS` (default 900_000 = 15 min)** env vars.
  Set either to 0 to disable.
- **`auth.lockout` on `/api/health`.** Shape:
  ```json
  { "enabled": true, "lockedNow": 0, "degraded": false }
  ```
  `degraded` is the explicit flag for a future status-page
  integration — surfaces "auth surface degraded" when at least one
  IP is currently locked.
- **HTTP 429 + `Retry-After` header** on locked-out attempts and on
  the request that triggered the lock. Body shape:
  ```json
  { "error": "locked_out", "message": "...", "retryAfterSec": 900, "unlockAt": <ms> }
  ```
- **`login.lockout` audit action.** Fires once per IP per
  lock-transition, with `{ fails, lockMs, unlockAt }` metadata.
  `login.fail` events now also carry `failsRemaining`.

### Changed

- `package.json` bumped to `0.40.0`.
- `server/auth.js` — `login()` checks lockout first (locked IPs skip
  scrypt). On credential failure, `recordFailure(req.ip, { actor })`;
  on the threshold-crossing failure, returns 429 instead of 401. On
  success, `recordSuccess(req.ip)`.
- `server/audit.js` — `login.lockout` added to the whitelist.
- `server/index.js` — `/api/health` includes the lockout snapshot.
- `.env.example` — documents the new env vars.

### Notes

- **In-memory state.** A process restart wipes the lockout map.
  Acceptable: at process-restart there are also no in-flight
  attacks (the SQLite-backed audit log still records the lockout
  events for forensics, and express-rate-limit picks up where it
  left off via its own counters). Persisting to disk would be
  more complexity than it's worth for a single-process dashboard.
- **More aggressive than express-rate-limit.** The existing
  `loginLimiter` caps any IP to 10 attempts per 15 minutes — that
  rate-limits the *flow* but doesn't *block* once an attacker
  hits the limit (they just get 429s until the window slides).
  This module *locks* the IP outright on the configured failure
  count, with a separate clock that doesn't slide.
- **Locked IPs cost zero scrypt CPU.** The lockout check is the
  first thing the login handler does — locked attempts return
  429 before any password comparison runs. This both shields the
  process from a CPU-DoS and removes the timing channel that an
  attacker could use to mine information from password-check
  duration.
- **No admin unlock endpoint** in this release. If an operator
  locks themselves out, they wait for the timer (default 15 min)
  or restart the service. Could grow into a manual unlock UI on
  Settings later if needed.
- Smoke-tested end-to-end on the live VPS with test-friendly
  values (`OTHONI_LOGIN_LOCKOUT_FAILS=4`,
  `OTHONI_LOGIN_LOCKOUT_MS=4000`):
  - Attempts 1–3 with wrong password → 401, audit metadata shows
    `failsRemaining: 3,2,1`.
  - Attempt 4 (threshold) → 429 `locked_out` with `Retry-After: 4`,
    audit `login.lockout` event with `fails=4, lockMs=4000`.
  - Attempt 5 with the *correct* password during lockout → still
    429 (no scrypt run; the IP is locked).
  - `/api/health` reports `lockedNow: 1, degraded: true`.
  - After 5 seconds → correct password → 200 OK, lockout cleared,
    `/api/health` back to `lockedNow: 0, degraded: false`.
  - Module-level unit tests covered: per-IP isolation (one IP
    locked, another unaffected), post-expiry counter reset
    (lockout expires → counter starts fresh from 1),
    `recordSuccess` clears the counter mid-stream.
- Production values restored to defaults after smoke test
  (`.env` no longer overrides; module defaults 5 fails / 15 min
  apply).

This release closes Phase 2. Phase 2 in total: v0.37 viewer role,
v0.38 active sessions + revoke, v0.39 CSRF tokens, v0.40 login
lockout. Together they take othoni from "one admin, single shared
password" to "small ops team can share view-only access, revoke
leaked cookies, fend off CSRF, and survive a brute-force without
manual intervention."

## [0.39.0] — 2026-05-12

CSRF token on state-changing routes. Closes the niche-but-real CSRF
attack surface that `sameSite=lax` already mostly handles, but doesn't
cover (subdomain attacks, browser bugs, weird embedded usage).
Double-submit cookie pattern: server sets `othoni_csrf` cookie at
login (non-httpOnly so client JS can read it); client echoes it back
in `X-Othoni-CSRF` header on every state-changing request; server
compares constant-time. Defaults on; flag-gated for rollback.

### Added

- **`server/csrf.js`** — `isEnabled()`, `generateToken()` (192 random
  bits, base64url), `attachCookie()`, `clearCookie()`,
  `ensureCookie()` for backfilling pre-v0.39 sessions, and the
  `middleware()` that 403s missing / mismatched tokens on
  PUT/POST/PATCH/DELETE.
- **`othoni_csrf` sibling cookie at login.** Same TTL as the session
  cookie, `httpOnly: false`, `sameSite: lax`, `secure` when the
  request was HTTPS.
- **`X-Othoni-CSRF` header on the client.** `api.js` reads the
  cookie via `document.cookie` regex and adds the header to any
  non-GET fetch. Pure-string compare on the server uses
  `crypto.timingSafeEqual` to dodge timing attacks.
- **`auth.csrf` field on `/api/health`.** Tiny discoverability bit
  for the UI / monitoring — mirrors the existing `auth.totp` field.
- **`OTHONI_CSRF_ENABLED` env var.** Defaults `true`. Set
  `false`/`0`/`no` to disable. Documented in `.env.example`.

### Changed

- `package.json` bumped to `0.39.0`.
- `server/auth.js` — `login()` mints + attaches the CSRF cookie
  alongside the session cookie. `auth()` middleware calls
  `csrf.ensureCookie(req, res, ttl)` so pre-v0.39 sessions get a
  cookie the next time they hit any authenticated endpoint
  (typically `/api/auth/me` on app load). `logout()` clears both
  cookies.
- `server/index.js` — `app.use('/api', auth, requireAdmin, csrf.middleware, apiRouter)`.
  The CSRF gate runs after auth + role so the response codes layer
  cleanly (401 unauthorized → 403 forbidden → 403 csrf_required).
- `client/src/api.js` — `request()` reads the CSRF cookie and adds
  the `X-Othoni-CSRF` header automatically. Existing call sites
  don't change.

### Notes

- **Headless flows unaffected.** `POST /api/metrics` is mounted
  *before* the cookie auth wall and uses Bearer-token (API key)
  auth. It never carries a session cookie so the CSRF middleware
  never runs against it. Verified end-to-end.
- **GET requests not gated.** The CSRF check only fires on
  non-GET/HEAD/OPTIONS. Read-only browsing — including the
  ubiquitous `/api/auth/me` on every page load — never sees the
  middleware.
- **Pre-v0.39 sessions stay valid.** The session JWT structure
  didn't change, so v0.38 cookies are accepted. The first
  authenticated request (the app's `/api/auth/me` poll on mount)
  receives the backfilled `othoni_csrf` cookie via
  `csrf.ensureCookie()`, so the subsequent state-changing request
  has the cookie to echo. No re-login required.
- **Login isn't itself CSRF-protected.** It's mounted before the
  cookie wall, so the middleware doesn't see it. That's fine:
  CSRF on the login endpoint would require an attacker to log
  the victim *in* — they'd need the credentials, which is its
  own attack and not what CSRF protects against.
- Smoke-tested end-to-end against the live VPS:
  - `/api/health` reports `auth.csrf: true`.
  - Login Set-Cookie carries both `othoni_session` (HttpOnly) and
    `othoni_csrf` (not HttpOnly).
  - `POST /api/keys` with valid session cookie but no CSRF header
    → 403 `csrf_required`.
  - Same `POST` with header set to the cookie value → 200.
  - `DELETE` with mismatched header → 403.
  - `GET /api/auth/me` → 200 (unaffected).
  - Session cookie alone (no CSRF cookie) → first GET response
    Set-Cookie includes a fresh `othoni_csrf`. Subsequent POST
    without header still 403; with the new header → would be 200.
  - `POST /api/metrics` with `Authorization: Bearer othoni_…` and
    no cookies at all → 200 `accepted: 1`.

## [0.38.0] — 2026-05-12

Active session list + revoke. JWT cookies were stateless before this —
the only way to invalidate a leaked session was rotating
`OTHONI_JWT_SECRET` (which logs every cookie out at once). v0.38 adds
a `sessions` table keyed on a `sid` claim baked into every new JWT;
each authenticated request checks the table and rejects revoked
cookies. The Settings page gains a Sessions card listing every
active session with a Revoke button (admin) — and viewers can see
their own session there to confirm where they're logged in.

### Added

- **`sessions` SQLite table.** Columns: `sid`, `actor`, `role`, `ip`,
  `ua`, `createdAt`, `lastSeenAt`, `expiresAt`, `revokedAt`,
  `revokedBy`. Indexed on `actor` + `expiresAt`. Lives in the
  shared `data/othoni.db` file alongside everything else.
- **`server/sessions.js`** — `create()`, `getActive(sid)`, `touch(sid)`,
  `revoke(sid, { revokedBy })`, `listAll()`, `prune()`,
  `loadRevokedFromDb()`. An in-memory `revokedCache` Set lets the
  hot path skip the DB lookup on revoked cookies. `touch()` is
  throttled to one write per session per 30 seconds.
- **`sid` claim on every JWT.** Generated as 192 random bits
  (base64url) at login. Stored in the cookie *and* the audit
  log's `login.ok` metadata so a session can be cross-referenced
  back to its login event.
- **`GET /api/sessions`.** Admin sees every row; viewer sees only
  their own rows (so they can confirm where they're logged in
  without exposing the admin's session list). Sorted active-first,
  then revoked, then by `lastSeenAt` desc. Each row carries a
  `self: true` flag for the requesting session.
- **`DELETE /api/sessions/:sid`.** Admin-only (caught at the
  router-level `requireAdmin` guard). Marks the row revoked,
  records `revokedBy`, adds it to the in-memory cache. Audit-logged
  as `session.revoke` with `metadata.self` distinguishing
  self-revoke from operator-revoke.
- **`session.revoke` audit action.** Added to the whitelist; new
  Settings → Audit log label.
- **Sessions card on the Settings page.** Lists each session with
  actor, role, IP, UA, started/last-seen relative times, a status
  chip (active/revoked + revokedBy), and a Revoke button for
  admins on active rows. Refreshes every 30s. Revoking your own
  session prompts an explicit confirm.
- **Logout = self-revoke.** `POST /api/auth/logout` now revokes
  the cookie's `sid`. Defensive decode lets it still work if the
  cookie passed through the `auth` middleware *or* if it didn't.

### Changed

- `package.json` bumped to `0.38.0`.
- `server/auth.js` — `login()` creates a session row first, then
  signs `{ sub, role, sid }`. `auth()` middleware rejects any
  token without `sid` (pre-v0.38 cookies become invalid) or
  whose `sid` isn't in the active set, and `touch()`es the
  session on every authenticated request. `logout()` defensively
  decodes the cookie + revokes the sid.
- `server/index.js` — primes the revoked-session cache from disk
  via `sessions.loadRevokedFromDb()` after `history.start()`.
- `server/history.js` — `cleanup()` now also calls `sessions.prune()`
  so the existing 10-min sweep removes expired or 7-day-stale
  revoked rows.
- `server/audit.js` — `session.revoke` added to the action whitelist.
- `server/routes/index.js` — mounts the two new endpoints.
- `client/src/api.js` — `api.sessions.{list,revoke}` helpers.
- `client/src/pages/Settings.jsx` — new `<SessionsCard>`, mounted
  between the Actions card and the API keys card.

### Notes

- **Pre-v0.38 JWT cookies are forcibly invalidated.** Tokens
  signed before this release don't carry a `sid` and the new
  middleware rejects them — every user has to log in once after
  the upgrade. Acceptable: this is a security-tightening release
  and the alternative (grandfathering old tokens) defeats the
  whole point.
- **Revoked-sid cache primed at boot.** Otherwise a process
  restart would resurrect cookies revoked just before the
  restart (until their first request triggered a DB miss).
- **Forensic retention.** Revoked + expired rows stick around
  for 7 days past their respective lifetimes (revokedAt /
  expiresAt) so the Sessions card can show "this session was
  revoked at X by Y" after the fact. After that the cleanup
  sweep drops them. The cache is reloaded from disk after a
  prune so removed sids don't occupy memory forever.
- **`lastSeenAt` write throttle.** Per-sid in-memory map gates
  the UPDATE to one write per 30s so a tight polling loop
  (the live alert-active poller fires every 10s) doesn't flood
  the SQLite writer.
- Smoke-tested end-to-end against the live VPS at v0.38.0:
  multi-session login (admin × 2 + viewer) → `/api/sessions`
  returns 3 to admin, 1 to viewer. Admin revoked admin-B → next
  GET on admin-B's cookie returned 401. Pre-v0.38 token (no
  sid) → 401. Forged sid that doesn't exist in the table → 401.
  Viewer logged out → their cookie → 401. Service restarted →
  every previously-revoked cookie remained 401 (cache primed
  from disk). Viewer's DELETE attempt → 403 (requireAdmin
  caught it).

## [0.37.0] — 2026-05-12

Read-only second user — the first release of Phase 2 (auth & access).
Brings othoni from "one admin, single shared password" to "small ops
team can hand out a view-only login without sharing the admin
credential." The viewer can navigate every page and read every API,
but every state-changing route returns 403. Off by default — no
`OTHONI_VIEWER_*` env vars set means no viewer login path.

### Added

- **`OTHONI_VIEWER_USER` + `OTHONI_VIEWER_PASSWORD_HASH` /
  `OTHONI_VIEWER_PASSWORD` env vars.** Hash variant preferred in
  production (`npm run hash-password`). Plaintext fallback for the
  same backward-compat reason the admin slot has one.
- **`role` claim baked into the JWT.** `admin` or `viewer`. Surfaced
  on `/api/auth/me` and `/api/auth/login` responses as
  `{ user: { username, role } }`.
- **`requireAdmin` middleware on the `/api` router.** Runs after
  cookie auth: GET/HEAD always pass; PUT/POST/PATCH/DELETE return
  `403 { error: 'forbidden', message: 'read-only session' }` unless
  `req.user.role === 'admin'`. Pre-router endpoints (`/api/auth/*`,
  `/api/metrics`, `/api/health`, `/metrics`) are unaffected so the
  viewer can still log in / out and the headless-agent flow keeps
  working.
- **`role` metadata on audit `login.ok` events.** Distinguishes
  viewer logins from admin logins in the audit log without changing
  the action whitelist.
- **Read-only chip in the topbar + sidebar user-chip.** Visible
  only on viewer sessions. `body[data-role="viewer"]` is set as a
  CSS hook for future styling.
- **`<AdminOnly>` wrapper component** in `App.jsx` for any UI that
  would call a state-changing endpoint.
- **Per-page UI gating** so the viewer never sees a button that
  would 403: Settings (API key create form + revoke buttons,
  Actions framework test buttons), Alerts (Add rule + Save rules
  + rule editor inputs disabled + delete hidden + Webhooks
  create/Test/delete/toggle), Checks (Add check + Run now +
  delete + toggle), Docker (container start/stop/restart strip),
  Services (`<RestartControl>` per-card), Processes
  (`<SignalControl>` per-row). All belt-and-braces on top of the
  server-side 403.

### Changed

- `package.json` bumped to `0.37.0`.
- `server/auth.js` — login compares against both admin and viewer
  slots in parallel (always runs both password checks so timing
  doesn't reveal which account exists). JWT signed with
  `{ sub, role }`. `auth()` decodes role onto `req.user`. New
  `requireAdmin` export.
- `server/index.js` — `app.use('/api', auth, requireAdmin, apiRouter)`.
- `.env.example` — documents the new vars.
- `client/src/App.jsx` — context surfaces role; `<AdminOnly>` export;
  `data-role` body attribute; topbar + sidebar viewer chip.
- Pages above gain `useApp().user.role === 'admin'` checks around
  their destructive controls.

### Notes

- Smoke-tested end-to-end on the live VPS at v0.37.0 against
  `127.0.0.1:8088`. Generated a scrypt-hashed viewer credential,
  appended to `.env`, restarted othoni. Both `admin` and `viewer`
  log in with valid TOTP and get their respective roles in the
  `me` response. Viewer sessions return 403 on PUT
  `/api/alerts/rules`, POST `/api/keys`, DELETE `/api/keys/:id`,
  POST `/api/checks`, POST `/api/actions/run`. Admin still
  PUTs/POSTs/DELETEs fine (round-tripped the rules without diff,
  generated + revoked an API key). Audit log records the role in
  `login.ok` metadata for both accounts.
- Login timing is constant w.r.t. which account exists: both
  scrypt verifies run on every attempt, gated by which
  `(username, password)` pair matched. Failure returns the same
  generic `invalid_credentials` 401 regardless of which check
  failed (existing behaviour preserved from v0.9.0).
- The viewer cannot log out other sessions — that lands in
  v0.38.0 (active session list + revoke). For today, the only
  way to invalidate a leaked viewer cookie is rotating
  `OTHONI_JWT_SECRET` (which logs everyone out).
- TOTP applies to viewers too — there's still one global
  `OTHONI_TOTP_SECRET`, no per-user TOTP.

## [0.36.0] — 2026-05-11

Alert → action wire-up. Closes Phase 1 (write surface). Alert rules
can now opt into running an action when they fire — restart a service
when CPU spikes, kill a runaway process when memory pressure
sustains, etc. Cooldown-protected and audit-logged with the firing
rule's id denormalized in the actor field.

### Added

- **Optional `onFire` field on alert rules.** Shape:
  ```
  onFire: {
    enabled:  boolean,        // separate from rule.enabled — explicit opt-in
    kind:     string,         // registered action kind (noop, systemd.restart, ...)
    target:   string,         // unit / container / pid string
    params?:  object,         // e.g. { signal: 'TERM' } for process.signal
  }
  ```
  `isValidOnFire()` checks the shape + that the kind is registered.
  Target validation runs at fire time via the action's existing
  `targetValidator` — same gate as interactive runs.
- **Per-rule cooldown.** `max(durationMs, 60s)` between two
  dispatches of the same rule's `onFire`. A flapping rule can't
  loop-restart a service.
- **Dispatch in `tick()`'s fire path.** After `recordFires` and the
  webhook dispatcher, fire-and-forget each rule's `onFire`. Logged
  on dispatch and on cooldown skip.
- **Actor encoding.** Alert-triggered runs land with
  `actor: 'alert:<ruleid>'` in audit_log and action_history,
  visible distinctly from interactive `actor: '<username>'` runs.
- **`<OnFireSummary>` + `<OnFireEditor>` on the Alerts page rule
  rows.** Each rule grows a small inline "on fire" toggle row
  below the main editor row: collapsed by default with a summary
  chip (`no action` or `↪ <kind> <target>`); click to expand to
  the full editor (kind picker, target dropdown/text, signal
  picker for `process.signal`). When actions are disabled,
  renders an "enable `OTHONI_ACTIONS_ENABLED`" hint instead.
- **Cooldown-state cleanup on rule delete.** `setRules()` drops
  stale `lastActionFiredAt` entries for rules that no longer
  exist, alongside the existing firing-state cleanup.

### Changed

- `package.json` bumped to `0.36.0`.
- `server/alerts.js` — imports `actions`, extends `isValidRule()`
  to accept `onFire`, adds `dispatchOnFire()` + cooldown map,
  wires dispatch into the `tick()` fire path.
- `client/src/pages/Alerts.jsx` — Alerts page fetches actions
  state once on mount and threads it into RuleRow; RuleRow wraps
  in a Fragment and adds a second `<tr>` for the on-fire toggle/
  editor.

### Notes

- Smoke-tested end-to-end: created a rule with `cpu > 0` threshold
  + `onFire: { kind: 'noop', target: '50ms' }`, forced a tick.
  Server logged `onFire for rule onfire-smoketest → noop 50ms →
  ok=true exit=0`; action_history row landed with
  `actor='alert:onfire-smoketest'`. Forced a re-fire immediately —
  cooldown kicked in (`skipped (cooldown — 60s remaining)`), no
  new action_history row. Original rules restored, smoke-test
  rows cleaned up.
- The wire-up is fire-and-forget so a slow action can't stall
  the 10s alert tick. The framework's per-actor concurrency lock
  keys on the actor string — `alert:foo` and `alert:bar` are
  independent slots so two rules firing the same tick don't
  block each other.
- Each rule's onFire is independent of webhook dispatch —
  webhooks still fire as configured. Actions are additive, not a
  replacement.

## [0.35.0] — 2026-05-11

Dedicated action-history page. Every action invocation (real and
dry-run) is now persisted to a new `action_history` table with the
full stdout / stderr captured (up to 8 KB per stream from the v0.31
framework cap). New `/actions` page renders the history with range
chips, kind / actor / outcome filters, per-kind aggregate count
chips, and inline-expandable detail rows.

### Added

- **`server/action-history.js`** — append-only durable record of
  every action invocation. Stores actor / kind / target / ip / ok /
  exit code / duration / dryRun / stdout / stderr / params. The
  audit_log entry stays as the slim "who/what/when" view with a
  200-byte snippet; action_history is the rich record for the
  dedicated page.
- **`action_history` SQLite table.** Bootstrapped on first open;
  pruned at the existing 24h retention sweep. Indexed on `(t)`,
  `(kind, t)`, `(actor, t)`.
- **Dual-write from `runAction`.** Both the audit_log and
  action_history rows land in the same tick — dry-runs are recorded
  with `dry_run=1`.
- **`GET /api/actions/history?range=&kind=&actor=&outcome=&limit=`** —
  returns events newest-first + per-kind aggregates `{ n, okN, failN,
  avgDurationMs }` so the UI can render a breakdown in one
  round-trip. Cookie-auth'd.
- **`GET /api/actions/history/actors?range=`** — distinct actors
  for the filter dropdown.
- **`/actions` page.** Range chips (1h / 6h / 24h), kind filter,
  actor filter, outcome filter, per-kind aggregate chips that
  double as filter toggles, and a click-to-expand detail panel
  per row showing full stdout / stderr / params in monospace
  scrollable panels (max-height 200px each).
- **Sidebar nav entry** between Checks and Logs, **`g r` chord**
  (mnemonic: "runs"), **cheatsheet entry**, and **`IconActions`**
  glyph (lightning bolt).

### Changed

- `package.json` bumped to `0.35.0`.
- `server/actions.js` — `runAction()` now writes both an audit_log
  row (slim, snippet) and an action_history row (full output) on
  every invocation, including dry-runs.
- `server/history.js` — bootstraps the new `action_history` table;
  `cleanup()` extended to prune it.
- `client/src/api.js` — adds `api.actions.history(...)` and
  `api.actions.historyActors(...)`.
- `client/src/App.jsx` — nav entry + route + chord (`g r`) +
  `IconActions` import.
- `client/src/Cheatsheet.jsx` — chord listing.

### Notes

- Smoke-tested end-to-end: ran a `noop` dry-run, a `noop` real,
  and a `process.signal` real (against a spawned `sleep 60`).
  All three persisted to `action_history`. Per-kind counts +
  avg duration aggregated correctly. Actor filter, outcome
  filter, distinct-actors lookup all returned the expected
  results. Test rows cleaned up.
- The dual-write doubles the storage cost per action (slim audit
  row + rich history row) — still trivial since the table is
  pruned at 24h and concrete actions are inherently low-volume.

## [0.34.0] — 2026-05-11

Third concrete action: signal a process by PID. Completes the three
operator-facing action kinds the original ROADMAP listed (systemd
restart, Docker control, process signal). Also extends the action
framework with a `params` field so kinds can take richer arguments
than just `target`.

### Added

- **`process.signal` action kind.** Target is the PID as a string
  (validated `^[1-9][0-9]{0,6}$`). The signal is in `params.signal`
  — one of the safe set `{TERM, INT, HUP, USR1, USR2, KILL}`,
  defaults to `TERM`. Real run is Node's `process.kill(pid,
  'SIG'+signal)`. Three self-protection layers:
  - **PID 1 refused outright** (init / systemd-as-pid1).
  - **Dashboard's own PID refused outright** (so the dashboard can
    never kill itself mid-action).
  - **`OTHONI_PROCESS_GUARD` regex** against `/proc/<pid>/comm`.
    Defaults to `^(systemd|init|sshd|nginx)$` — killing any of
    those breaks ingress to othoni or core system services.
    Operators can override or disable with `none`.
- **`params` field on `runAction()`.** Action kinds can now declare
  an optional `paramsValidator(params)` to gate-keep extras
  alongside the existing `targetValidator`. Audit-log metadata
  includes the params so the trail captures full action context
  (e.g. `signal: "KILL"`).
- **Per-row signal/kill controls on the Processes page.** Two
  buttons per row:
  - **signal** → one-click confirm strip → run, sends SIGTERM.
  - **kill** → confirm strip requires **retyping the process name**
    into a text field before the kill button enables.
    Irreversible-destructive operations should be deliberate.
- **`OTHONI_PROCESS_GUARD` env var.** Documented in `.env.example`.

### Changed

- `package.json` bumped to `0.34.0`.
- `server/actions.js` — `runAction()` accepts and threads `params`;
  audit-log metadata includes a `params` snapshot so a fire's full
  invocation context is on the audit trail.
- `server/routes/index.js` — `POST /api/actions/run` body now
  accepts `params` alongside `kind` / `target` / `dryRun`.
- `client/src/api.js` — `api.actions.run({ kind, target, params,
  dryRun })`.

### Fixed

- **Bug caught during smoke testing**: Node's `process.kill()`
  wants `'SIGTERM'`, not `'TERM'`. Translation happens at the
  boundary inside the runner — the operator-facing API keeps the
  bare names. Initial implementation passed the bare name through
  unchanged and Node threw `Unknown signal: TERM`; fixed before
  release.

### Notes

- Smoke-tested module-level end-to-end:
  - All four validation paths reject correctly: PID 1, own PID,
    bad target shape (`'abc'`, `'-1'`, `'99999999999'`, `''`,
    `null`), nonexistent PID, bad signal name with valid target.
  - Dry-run path returned standard shape.
  - Real `TERM` on a freshly-spawned `sleep 60` → child exited
    with `signal=SIGTERM`, runner reported
    `sent SIGTERM to PID <pid> (sleep)`.
  - Real `KILL` on another `sleep 60` → child died, runner
    reported `sent SIGKILL to PID <pid> (sleep)` in 1 ms.
- The "retype the process name" UX for KILL is intentional
  friction — TERM is graceful and reversible (process can ignore);
  KILL is irreversible at the kernel level.

## [0.33.0] — 2026-05-11

Second concrete action: Docker container start / stop / restart.
Same pattern as v0.32.0's `systemd.restart` — three new action kinds
registered via the v0.31.0 framework, all opt-in via
`OTHONI_ACTIONS_ENABLED`, all audit-logged.

### Added

- **`docker.start`, `docker.stop`, `docker.restart` action kinds.**
  Target is a container name or ID; validated against the docker
  daemon's allowed character set (`^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$`)
  so bad input is rejected before reaching `execFile`. No whitelist
  — Docker containers are dynamic; consent comes from the
  `OTHONI_ACTIONS_ENABLED` flag + the state-aware UI surface.
- **`OTHONI_SELF_CONTAINER` env var.** When set, refuses to act on a
  container with that name. For deployments running othoni itself
  inside Docker.
- **State-aware controls on the Docker page.** Per-container action
  cell renders only the verbs that make sense for the current state:
  - `running` → `stop`, `restart`
  - `paused` → `restart`
  - `restarting` → nothing (let it settle)
  - else (exited / dead / created) → `start`
  Two-step UX matches the systemd version: button → confirm strip
  showing the verb + target → run → result chip with duration on
  success or exit code + first line of stderr on failure.
- **Post-action refresh.** After a successful action the container
  list re-polls so the State pill flips immediately.

### Changed

- `package.json` bumped to `0.33.0`.
- `client/src/pages/Docker.jsx` — grows an "Actions" column when
  the actions surface is enabled.

### Notes

- Smoke-tested module-level:
  - All five bad-shape targets (`'evil; rm'`, `'!@#bad'`, `''`,
    `null`, `12345`) rejected with `invalid_target` before any
    exec.
  - Dry-run path returned the standard shape.
  - Real exec against a synthetic name on this host (where docker
    isn't installed) returned `ok=false exit=1 stderr="spawn docker
    ENOENT"` in 7 ms — proves the exec wiring + error propagation
    without disrupting anything.
- The host running the smoke test doesn't have Docker installed, so
  the real-start path couldn't be exercised against a live daemon.
  When testing on a host with Docker, the operator can run
  start/stop/restart on real containers — every invocation is
  audit-logged.

## [0.32.0] — 2026-05-11

First concrete action: systemd service restart. Whitelist-only,
self-protected, audit-logged on every invocation. Services page
grows an inline restart button per whitelisted unit (when the
v0.31.0 actions flag is on).

### Added

- **`systemd.restart` action kind.** Registered via the v0.31.0
  framework. `targetValidator` enforces three layers:
  - DNS-style regex `^[A-Za-z0-9._@:\-]{1,128}$` (matches the
    journalctl unit filter for consistency).
  - Whitelist match — defaults to the same list of units the
    Services page already monitors; `OTHONI_ACTION_UNIT_WHITELIST`
    env var overrides (comma-separated).
  - Self-unit guard — `OTHONI_SELF_UNIT` (default `othoni`) and its
    `.service` form are refused outright, so the dashboard can't
    kill its own response mid-action.
  Real run uses `execFile('systemctl', ['restart', <unit>], { timeout: 30s })`
  — no shell, no string interpolation. Exit code, stdout, stderr,
  and duration are all surfaced to the caller.
- **`listKindsWithDetail()`** alongside the existing `listKinds()`.
  Returns the resolved whitelist as `allowedTargets` on the
  `systemd.restart` entry so the UI can disable the button for
  non-whitelisted units rather than letting the user click and
  get a 400.
- **`<RestartControl>` on the Services page.** Per-card, two-step
  UX: click → inline confirm strip showing the exact `systemctl`
  command + "audit-logged" disclosure → run → result chip with
  duration on success or exit code + first line of stderr on
  failure. Dismissable. Only renders when the actions surface is
  enabled AND the unit is on the resolved whitelist AND status is
  not "missing".
- **`OTHONI_ACTION_UNIT_WHITELIST` env var.** Documented in
  `.env.example`.
- **`OTHONI_SELF_UNIT` env var.** Documented in `.env.example`.

### Changed

- `package.json` bumped to `0.32.0`.
- `server/routes/index.js` — `/api/actions` now returns
  `listKindsWithDetail()` so the UI gets the whitelist inline.

### Notes

- Smoke-tested at the module level with a synthetic whitelist
  (`OTHONI_ACTION_UNIT_WHITELIST=othoni-fake-test-unit-xyz`):
  - Validation rejects non-whitelisted units, shell-metachar
    targets, and `othoni` / `othoni.service` (self-protect).
  - Dry-run path returns the standard dry-run shape.
  - Real exec ran in 14 ms and captured systemd's verbatim
    "Failed to restart othoni-fake-test-unit-xyz.service: Unit ...
    not found." stderr message into the audit log.
- Deliberately did not smoke-test by restarting any real production
  unit on the live VPS — the synthetic-unit failure path proves the
  exec wiring end-to-end without disrupting anything.
- The Services page polls `/api/actions` once on mount; toggling
  `OTHONI_ACTIONS_ENABLED` requires a service restart anyway, so
  there's no point re-polling.

## [0.31.0] — 2026-05-11

Action framework + opt-in flag. Foundation for Phase 1 (write surface).
No real actions yet — just the contract + a built-in `noop` kind for
framework testing. Concrete actions land in v0.32 (systemd), v0.33
(Docker), v0.34 (process signal).

### Added

- **`OTHONI_ACTIONS_ENABLED` env var.** Off by default. Read once at
  module load — toggling requires a service restart so an operator
  can never flip actions on via a header or query param.
- **`server/actions.js`** — uniform action framework with three
  cross-cutting concerns: audit logging (every invocation, including
  dry runs, lands in `audit_log`), per-actor concurrency lock (one
  running action per actor at a time — return `409 busy` otherwise),
  and bounded output capture (8 KB per stream in the result;
  200-byte snippets in audit metadata). Result shape:
  `{ ok, exitCode, stdout, stderr, durationMs }`.
- **`register(kind, cfg)`** API for sibling modules to declare actions.
  Each kind has a description, optional `targetValidator`, async
  `run()` runner, and an optional `requiresConfirmation` UI hint.
  Kind name must match `[a-z][a-z0-9._-]{0,40}`.
- **Built-in `noop` action.** Always succeeds; optional `target` like
  `"200ms"` sleeps that long. Used to smoke-test the framework
  (concurrency, audit, dry-run, error paths) without any
  system-mutating code.
- **`GET /api/actions`** — returns `{ enabled, kinds }` when on; the
  Logs-pattern `{ enabled: false, reason }` when off (200, so the UI
  can render the enable-instructions card).
- **`POST /api/actions/run`** — body: `{ kind, target?, dryRun? }`.
  Returns `{ result }`. `400 invalid_request` / `400 unknown_kind` /
  `400 invalid_target` / `409 busy` / `404 not_found` (when actions
  disabled) / `500 action_failed`.
- **Actions card on Settings** — enabled/disabled chip, table of
  registered kinds, framework smoke-test buttons ("Run noop (dry
  run)" / "Run noop") with the captured result rendered inline.
- **Audit whitelist** pre-reserves `action.noop`,
  `action.systemd.restart`, `action.docker.{start,stop,restart}`,
  and `action.process.signal` so v0.32 – v0.34 land without
  whitelist edits.

### Changed

- `package.json` bumped to `0.31.0`.
- `.env.example` — documents `OTHONI_ACTIONS_ENABLED` with a note on
  what concrete actions arrive in each subsequent Phase 1 release.

### Notes

- **Off by default in production.** The framework is plumbed but
  doesn't change any system state until both (a) the env var is set
  and (b) the operator explicitly invokes an action.
- Smoke-tested at the module level: dry-run path, real-run path,
  concurrency lock (second call returns `busy` while first is in
  flight), `unknown_kind` error, `invalid_target` error, and the
  three audit-log rows that result from a dry-run + 2 real runs are
  all present with the expected metadata. HTTP route wiring verified
  (401 from auth wall on all paths).
- Output cap is 8 KB per stream — enough for "service restarted, X
  jobs pending" style output, not enough to OOM the response on a
  command that emits megabytes.

## [0.30.0] — 2026-05-11

Per-host dashboard view. Closes the multi-host story started in v0.10.0
(ingestion endpoint), v0.23.0 (host attribution), and v0.25.0 (bundled
`agent.sh`). Hosts now have a dashboard surface of their own, not just
a section on the History page.

### Added

- **`server/hosts.js`** — auto-discovers hosts from
  `custom.<host>.*` metric names with at least one sample in the
  last 10 minutes (stale hosts roll off naturally as the existing
  24h retention sweep prunes their samples). For each host, fetches
  the latest value of each known agent metric (cpu / mem / load1 /
  disk_root / net_rx / net_tx) plus a `lastSeenAt`. Anything else
  that came in under `custom.<host>.*` shows up in an `extras` map
  so a custom agent's metrics aren't hidden.
- **`GET /api/hosts`** — cookie-auth'd. Returns `{ hosts: [...] }`,
  newest-first.
- **`/hosts` page** — one card per host with the freshness chip
  ("live" / "Ns ago" / "Nm ago" — color graded ok / warn / crit
  past 1 min / 5 min) and a 2×3 grid of stat tiles: CPU, Memory,
  Load (1m), Root disk, Net in, Net out. Each tile has the latest
  value (color-coded by `statusClass` for percent metrics) plus a
  15-minute sparkline from `custom.<host>.<leaf>` history. An
  "Other custom metrics" sub-grid renders extras the bundled agent
  doesn't push, so custom agents stay visible.
- **"No hosts yet" empty state** — points users at Settings → API
  keys + the README's `agent.sh` walkthrough.
- **Sidebar nav entry** + **`g o` keyboard chord** + **Cheatsheet
  entry** for the new page.
- **`IconHosts`** — stacked-server SVG glyph matching the existing
  Icon set.

### Changed

- `package.json` bumped to `0.30.0`.
- `client/src/api.js` — adds `api.hosts()`.
- `client/src/App.jsx` — nav entry, route, chord (`g o`),
  `IconHosts` import.
- `client/src/Cheatsheet.jsx` — chord listing updated.

### Notes

- Smoke-tested end-to-end: two simulated agents (`agent-1`,
  `agent-2`) pushed via the bundled `agent.sh` over a 12-second
  window. Both showed up in `/api/hosts`, sorted by `lastSeenAt`
  (newest first), with all six agent metrics resolved per host
  and matching sample timestamps. Test rows + API key cleaned up.
- The sparkline tile fetches 15 m of history via the existing
  `/api/history?metric=custom.<host>.<leaf>` endpoint — no new
  history surface needed.
- Each host's 6 tiles = 6 history requests on first paint. For
  ~10 hosts that's 60 requests, which is fine on local network /
  HTTP-2 but might warrant a batch endpoint if someone deploys
  100+ agents. Defer until that's a real complaint.

## [0.29.0] — 2026-05-11

Rate-of-change alert comparators. Catches "the disk is filling at
>1%/min" before the absolute >90% rule fires — useful for runaway
log files, leaking memory, and load spikes that are still building.

### Added

- **`rate_gt` and `rate_lt` comparators** on alert rules.
  Evaluates the change-per-minute of a metric across a configurable
  window (`rateWindowMs`, default 5 min, range 1 min–1 h) by
  diffing the first and last sample in the window from the
  `samples` table. The endpoint-to-endpoint slope is comparable
  to a linear regression at the 5s sampling cadence and is
  trivially cheap (single SELECT, two rows from the
  `(metric, t)` index).
- **`comparator` column on `alert_fires`** — denormalizes the
  comparator at fire time so historical rate-fires render with
  the right `/min` suffix even after rule edits. Added via a new
  idempotent `migrate()` step in `history.js` (PRAGMA
  table_info → ADD COLUMN if missing). Rows from before v0.29.0
  get `NULL` and are formatted with the legacy instant
  formatter.
- **`formatRateValue()`** helper that adds a signed `/min`
  suffix tuned to the metric's unit: `+1.50%/min`,
  `-300 KB/s/min`, `+2.10/min` (for unitless `load1`).
- **Rule editor: comparator dropdown** gains "Δ/min > (rising
  faster than)" and "Δ/min < (falling faster than)" entries
  alongside the existing `>` / `<`.
- **Rule editor: rate window picker** appears under the
  threshold input when the comparator is a rate type. Options:
  1 min, 5 min (default), 15 min, 30 min, 1 hour. Unit hint on
  the threshold gets a `/min` suffix in rate mode.

### Changed

- `package.json` bumped to `0.29.0`.
- `server/alerts.js` — `METRICS` map gains a `historyKey` field
  for the alert key → `samples.metric` mapping (`disk_read` →
  `disk.read`, `disk_write` → `disk.write`; everything else is a
  pass-through). `isValidRule()` accepts the new comparators
  and validates `rateWindowMs` when present. `tick()` branches
  on the comparator: instant comparators use the existing live
  collector path; rate comparators call `rateAt(metric,
  windowMs, now)`. `projectActive()` + `listFires()` use the
  comparator to pick the rate-formatter or the instant
  formatter.
- `server/history.js` — bootstrap now ends with
  `migrate(db)` which adds the new `comparator` column to
  `alert_fires` if missing.

### Notes

- Smoke-tested end-to-end: a temporary `rate_gt cpu > -100/min`
  rule fired immediately with `value=-0.71%/min` (CPU rate over
  the prior 5 min), formatted as `-0.71%/min` vs threshold
  `-100.00%/min`. Rule cleaned up; alert-rules.json unchanged.
- Rate alerts can still use `durationMs` to require the rate to
  *sustain* — e.g. "disk filling > 1%/min sustained 1 min".
  Default for new rules is `durationMs: 60_000`.
- B/s metrics (net_rx, net_tx, disk_read, disk_write) accept
  rate comparators but the value is technically a second
  derivative — usually less useful than instant thresholds for
  these. We don't block it; operators who know what they want
  can opt in.

## [0.28.0] — 2026-05-11

Per-webhook delivery history. Webhooks page now shows a live success/
failure strip per row and an expand-on-click panel with the full
recent-deliveries table. Each retry is its own row on purpose —
"first attempt 503'd, retry 200'd" is exactly the case operators
want to see when tuning.

### Added

- **`server/webhook-history.js`** — append-only delivery recorder.
  Inserts happen inline in `webhooks.fireOne` for each HTTP
  attempt (so a fail-then-retry-OK appears as two rows). Records
  status code, request duration, attempt index (0 = first, 1 =
  retry), error string, and the originating event label
  (`rule.label` or `"webhook test"`). Insert never throws into
  the caller. `query()` returns newest-first deliveries + an
  aggregate `{ total, ok, fail, avgDurationMs }` block in one
  round-trip. `queryStrip()` returns oldest→newest last-N
  attempts so the UI can render a tiny strip inline in the
  webhooks table without N round-trips.
- **`webhook_deliveries` SQLite table** bootstrapped on first
  open. Indexes on `(t)` and `(webhook_id, t)`. Pruned at the
  existing 24h retention sweep.
- **`GET /api/webhooks/:id/deliveries?range=&limit=`** —
  cookie-auth'd endpoint. Returns `{ stats, deliveries }`.
- **Recent column on the Webhooks card** — 12-slot left-padded
  strip of bars per row (success = `--ok`, fail = `--crit`, no
  data = dim placeholder). Right-most slot is the most recent.
- **Click-to-expand delivery details row** — inline `<DeliveryDetails />`
  with range chips (1h / 6h / 24h), an aggregate header (total /
  ok / fail / avg duration), and a recent-deliveries table with
  per-attempt status, HTTP code, duration, attempt index, event
  label, and error.

### Changed

- `package.json` bumped to `0.28.0`.
- `server/webhooks.js` — `postWithTimeout()` now returns the
  status code (and attaches `statusCode` to the thrown error
  on non-2xx) so the history row can record it. `fireOne()`
  now wraps every attempt in start/end timestamps and records a
  history row per attempt. `sanitize()` gains an optional
  `recent: [{t, ok}]` field (last 12 attempts) so the
  Webhooks card renders the dot strip without N extra
  requests.
- `server/history.js` — bootstraps the new `webhook_deliveries`
  table; `cleanup()` extended to prune it.
- `client/src/api.js` — adds `api.webhooks.deliveries(id, opts)`.
- `client/src/pages/Alerts.jsx` — new `<DeliveryStrip>` cell +
  expand-on-click `<DeliveryDetails>` row on each webhook.

### Notes

- Smoke-tested end-to-end: a fake webhook hitting `httpbin.org/post`
  recorded one OK row (200, ~557ms, attempt 0); a fake webhook
  hitting `httpbin.org/status/500` recorded two FAIL rows
  (attempt 0 + retry attempt 1), both with status 500 and
  matching error text.
- 24h retention applies, so the strip and the expanded panel
  both reset over time. Operators looking for longer-term
  reliability stats should still rely on the alert engine's
  webhook delivery as the source of truth (every fire still
  updates `lastFiredAt` / `lastError`).

## [0.27.0] — 2026-05-11

Audit log of admin actions. Captures who did what and when for the
14 admin-facing actions (logins, API key gen/revoke, rule edits,
webhook + check edits). Investigation surface that wasn't there
before.

### Added

- **`server/audit.js`** — append-only audit module. Whitelisted
  action names (typo upstream surfaces as a `warn` rather than
  silently writing nonsense). `log({ actor, action, target, ip,
  metadata })` never throws into the caller — a broken insert
  logs and moves on so audit can't break the action being
  audited. `query({ range, action, limit })` returns
  newest-first events plus per-action counts so the UI can render
  a breakdown in one round-trip.
- **`audit_log` table** in the shared SQLite store. Indexed on
  `(t)` and `(action, t)`. Pruned at the existing 24h retention
  sweep alongside `samples` / `process_samples` / `alert_fires`.
- **`GET /api/audit?range=&action=&limit=`** + **`GET
  /api/audit/actions`** for the dropdown.
- **Audit log card on Settings** — range chips (1h / 6h / 24h),
  per-action count chips that double as filter toggles, an action
  dropdown for explicit filtering, and a newest-first event
  table with actor / target / IP / metadata columns.
- **Audit hooks wired** on: `login.ok`, `login.fail` (captures
  the username attempted and whether TOTP was in effect),
  `logout`, `apikey.create`, `apikey.revoke`, `rules.update`
  (records rule count), `webhook.create`, `webhook.update`
  (records which fields changed), `webhook.delete`,
  `webhook.test` (records success + HTTP status), `check.create`,
  `check.update`, `check.delete`, `check.run` (records up/down).

### Changed

- `package.json` bumped to `0.27.0`.
- `server/history.js` — bootstraps the `audit_log` table on first
  open; `cleanup()` extended to prune it.
- `server/auth.js` — login success/failure/logout now write an
  audit event in addition to the existing `logger.warn` for
  failed logins.

### Notes

- Failed-login auditing is rate-limit-bounded — the existing
  login limiter (10/15min/IP) responds 429 before reaching the
  route handler, so audit can't be used as an amplifier.
- We deliberately do **not** audit `POST /api/metrics` (external
  agents push every 30s — that's a data path, not an admin
  action). Same logic excludes the high-volume read endpoints.
- Metadata is JSON-encoded so we can capture per-action context
  (which rule fields changed, whether a webhook test returned
  2xx, the username attempted on a failed login) without
  re-shaping the table.

## [0.26.0] — 2026-05-11

Storage card on Settings. Operational visibility into what the
SQLite history store actually holds — total footprint, per-table
counts, top metrics by row count.

### Added

- **`server/db-stats.js`** — `getDbStats()` helper returning:
  on-disk footprint with a WAL/SHM breakdown; the sampler
  cadence + retention config (read from env vars at module load);
  per-table row counts + oldest/newest timestamps for `samples`,
  `process_samples`, and `alert_fires`; distinct metric count;
  and the top-N metric names by row count (default 20).
  Pure SELECTs — no `VACUUM` / `DELETE` here so we never race the
  sampler.
- **`GET /api/db/stats`** — cookie-auth'd; thin wrapper around
  `getDbStats()`.
- **Storage card on Settings** — total size headline (sums the
  `.db` + `-wal` + `-shm` files), 3-tile breakdown by file kind,
  3-tile config row (`sample cadence`, `process cadence`,
  `retention`), per-table summary table (rows + oldest/newest),
  and a "Top metrics by row count" table with a thin bar
  visualizing each row's share of the heaviest series. Refreshes
  every 30s in the background.

### Changed

- `package.json` bumped to `0.26.0`.
- `client/src/api.js` — adds `api.dbStats()`.
- `client/src/pages/Settings.jsx` — new `<StorageCard />` mounted
  between the existing 4-card grid and the API keys card.

### Notes

- Headline size is the sum of `othoni.db` + `othoni.db-wal` +
  `othoni.db-shm`. WAL/SHM may temporarily inflate after heavy
  writes; SQLite checkpoints them back into the main file
  automatically.
- "Top metrics" is sorted by row count, which surfaces variable-
  cardinality metrics (per-iface network, per-disk I/O, per-core
  CPU) and pushed `custom.*` series. Built-in composite gauges
  share the same row count as each other (one row per sampler
  tick), so they cluster near the top.

## [0.25.0] — 2026-05-11

Bundled remote metrics agent. Closes the agent-side half of the
multi-host story that v0.10.0 (`POST /api/metrics`) and v0.23.0
(`host` attribution) had been incrementally building toward —
remote hosts can now stream metrics without writing a shell script
themselves.

### Added

- **`agent.sh`** at the repo root — POSIX shell metrics agent (no
  bashisms; tested under dash / busybox). Reads `/proc/stat`,
  `/proc/meminfo`, `/proc/loadavg`, `/proc/net/dev`, and `df /` and
  pushes six metrics — `custom.cpu`, `custom.mem`, `custom.load1`,
  `custom.disk_root`, `custom.net_rx`, `custom.net_tx` — to a remote
  othoni via `POST /api/metrics` every `OTHONI_INTERVAL` seconds
  (default 30, min 5). Single dependencies are `awk` + `curl`.
  Required env: `OTHONI_URL`, `OTHONI_API_KEY`. Optional:
  `OTHONI_HOST` (else derived from `hostname`, lowercased, stripped
  to match the server's DNS-style regex). Supports `--once` for cron
  use; otherwise long-lived with `INT`/`TERM` trapped for clean
  shutdown. CPU and net-throughput state are kept across iterations
  so each tick is a single `/proc` read after the first.
- **`othoni-agent.service.example`** — drop-in systemd unit for the
  agent. Uses `DynamicUser=true` since the agent only needs `/proc`
  reads + outbound HTTPS, plus the standard hardening stack
  (`ProtectSystem=strict`, `NoNewPrivileges`, `LockPersonality`,
  …). `EnvironmentFile=/etc/othoni-agent.env` for the URL + key.
- **README section** documenting the agent: copy-paste install,
  one-shot vs. long-lived mode, env var reference, and how the
  output threads into the v0.23.0 host attribution.

### Changed

- `package.json` bumped to `0.25.0`.
- `ROADMAP.md` — dropped the stale "Sync alert rules across
  browsers" item from Next up (effectively shipped in v0.11.0 when
  alerts moved server-side). Moved "agent.sh" out of the Later
  bucket's still-not-built list and into the shipped list.
- `README.md` — added the agent to the project layout block and
  updated the Roadmap section to reflect what's actually still
  open.

### Notes

- The agent uses the existing `custom.*` ingestion path — no new
  server endpoints, no new metric names server-side. Metrics
  arriving from `agent.sh` running on host `app-server-1` land as
  `custom.app-server-1.cpu` etc. and group correctly under the
  History page's Custom section.
- Validated against the server's host regex up front (the same
  `[a-z0-9][a-z0-9-]{0,38}[a-z0-9]` pattern that
  `server/routes/metrics.js` enforces) so a misconfigured agent
  fails loud rather than silently pushing un-attributed metrics.
- Cadence floor of 5s matches the server's 600 req/min/key limit
  with comfortable headroom.

## [0.24.0] — 2026-05-10

One-line installer + nginx config example. Closes the "fresh VPS to live
dashboard" gap that was a deferred ROADMAP item since v0.1.0.

### Added

- **`install.sh`** at the repo root. Idempotent — fresh-installs from
  the GitHub repo OR upgrades an existing checkout (re-running is
  safe). Walks: root check, NodeSource Node 20 install if `node` < 18,
  `git clone` (or `git pull --ff-only`), `npm install && npm run build`,
  `.env` generation on first run only (random JWT secret +
  scrypt-hashed admin password via the v0.21.0 helper), systemd unit
  install + enable, smoke-test against `/api/health`, banner.
  Tunable via env vars: `OTHONI_INSTALL_DIR`, `OTHONI_REPO_URL`,
  `OTHONI_BRANCH`, `OTHONI_PORT`, `OTHONI_HOST`, `OTHONI_ADMIN_USER`,
  `OTHONI_ADMIN_PASSWORD` (omit for an interactive prompt; falls back
  to a random password printed at the end if stdin isn't a TTY).
- **`nginx-othoni.conf.example`** — drop-in nginx server block with
  HTTP→HTTPS redirect, TLS placeholders ready for `certbot --nginx`,
  `proxy_pass` to `127.0.0.1:8088`, the `X-Forwarded-*` headers that
  the existing `app.set('trust proxy', 1)` expects, and sensible
  hardening (`server_tokens off`, `Cache-Control no-store`, modern
  TLS protocols, conservative timeouts).
- **README install section split into "one-liner" and "manual"** —
  fresh-VPS path is now a single curl-pipe-bash. Roadmap section
  pruned to the items still genuinely deferred.

### Changed

- `package.json` bumped to `0.24.0`.

### Notes

- The installer's `.env` generation uses `npm run hash-password` (the
  v0.21.0 helper) under the hood — so fresh installs default to a
  hashed password, not the plaintext form. Plaintext fallback in
  `auth.js` remains for users who follow the manual install path.
- The "data is not lost on redeploy" guarantee from CONTEXT.md still
  holds: the upgrade flow doesn't touch `data/` or `.env`, so
  historical samples + alert rules + API keys all survive.

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
[0.36.0]: #0360--2026-05-11
[0.35.0]: #0350--2026-05-11
[0.34.0]: #0340--2026-05-11
[0.33.0]: #0330--2026-05-11
[0.32.0]: #0320--2026-05-11
[0.31.0]: #0310--2026-05-11
[0.30.0]: #0300--2026-05-11
[0.29.0]: #0290--2026-05-11
[0.28.0]: #0280--2026-05-11
[0.27.0]: #0270--2026-05-11
[0.26.0]: #0260--2026-05-11
[0.25.0]: #0250--2026-05-11
[0.24.0]: #0240--2026-05-10
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
