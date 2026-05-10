# othoni — context

Orientation for anyone (human or agent) picking this project up cold. Read
this first; it answers "what is this and where do I look" without forcing
you to spelunk through every file.

> If you only read one section, read **Architecture in 30 seconds** and
> **Conventions**.

---

## Architecture in 30 seconds

One Node.js process, one React SPA. No external services required.

```
                      ┌──────────────────────────┐
   browser  ◀── HTTPS ─┤  nginx (TLS)            │
                      └──────────────┬───────────┘
                                     │ HTTP, 127.0.0.1:8088
                      ┌──────────────▼───────────┐
                      │  Express (server/)       │
                      │  ├── /api/auth/*         │  JWT cookie
                      │  ├── /api/<live>         │  /proc, df, ps, ...
                      │  ├── /api/history        │  SQLite (history.js)
                      │  └── static client/dist  │  built React SPA
                      └──────────────┬───────────┘
                                     │ on disk
                                  data/othoni.db   (samples, 24 h, 5 s cadence)
```

- **Live data** is read on demand via `systeminformation`, `/proc/net/dev`,
  `/proc/diskstats`, `ps`, `systemctl`, and `docker ps`. The collectors
  live in `server/collectors/`.
- **Historical data** is sampled by `server/history.js` every 5 s and stored
  in SQLite. Queried by the History page and the Dashboard sparklines via
  `GET /api/history`.
- **The frontend** is a Vite-built React 18 SPA. In production Express
  serves `client/dist/` as static files, with a catch-all that returns
  `index.html` so client-side routing works on deep links.

---

## Where this is deployed

- **Host**: testing VPS, Ubuntu 24.04 LTS, arm64
- **Path**: `/var/www/othoni`
- **Public URL**: `https://othoni.syedhashmi.trade`
- **Listen**: `127.0.0.1:8088` (nginx terminates TLS, see
  `/etc/nginx/sites-enabled/othoni`)
- **Process**: systemd unit `othoni.service`, `Restart=on-failure`
- **Cert**: Let's Encrypt, ECDSA, auto-renewing
- **Logs**: `journalctl -u othoni`

Operational tasks:

```bash
# rebuild client and restart
npm run client:build && systemctl restart othoni

# tail logs
journalctl -u othoni -f

# inspect samples
sqlite3 /var/www/othoni/data/othoni.db \
  "SELECT metric, COUNT(*) FROM samples GROUP BY metric;"
```

---

## Repo layout

```
othoni/
├── server/
│   ├── index.js          # Express bootstrap, history.start() lives here
│   ├── auth.js           # JWT login/logout/me
│   ├── middleware.js     # rate limiter
│   ├── logger.js         # tiny stderr/stdout logger
│   ├── history.js        # SQLite sampler + /api/history query helper
│   ├── routes/index.js   # all /api/* live endpoints
│   └── collectors/       # one file per data domain (cpu, memory, ...)
├── client/
│   ├── index.html        # contains the inline-SVG favicon
│   ├── src/
│   │   ├── main.jsx      # router + provider mount
│   │   ├── App.jsx       # nav, auth guard, route table, topbar pulse + clock
│   │   ├── api.js        # tiny fetch wrapper, all endpoints in one object
│   │   ├── hooks.js      # usePoller, useLocalSetting
│   │   ├── utils.js      # formatBytes / formatRate / formatUptime / statusClass
│   │   ├── Logo.jsx      # brand mark (concentric rings + dot)
│   │   ├── Icons.jsx     # monochrome SVG icon set, one export per icon
│   │   ├── Charts.jsx    # Sparkline / LineChart / MultiLineChart /
│   │   │                 #   StackedAreaChart / CoreGrid — all pure SVG
│   │   ├── styles.css    # ~all styling, CSS variables for theme
│   │   └── pages/        # one file per top-level route
│   └── vite.config.js    # dev proxies /api to the backend on $PORT
├── data/                 # runtime; created automatically; SQLite lives here
├── CHANGELOG.md          # what shipped, by version
├── PROGRESS.md           # checklist of v1 features and current state
├── ROADMAP.md            # what's planned, what's deferred
├── README.md             # install / configure / run
├── CONTEXT.md            # this file
├── othoni.service.example
└── package.json
```

---

## Conventions

- **One file per page**, one file per collector. Resist creating
  `server/utils/` until there are 3+ duplicated helpers.
- **Add a metric** = one line in `METRICS` (in `server/history.js`) + one
  entry on the History page. New endpoint not required.
- **No charting library** — the chart primitives in `client/src/Charts.jsx`
  (`<Sparkline>`, `<LineChart>`, `<MultiLineChart>`, `<StackedAreaChart>`,
  `<CoreGrid>`) are intentionally hand-rolled SVG. Pull requests adding
  chart.js / recharts / d3 will be reverted unless they bring capability
  we genuinely can't fake (e.g., brushing, stacked bar with negatives).
  The five primitives we have today are ~600 lines combined and match the
  dark theme exactly.
- **No icon library** either — `client/src/Icons.jsx` is a small set of
  hand-drawn monochrome SVGs. Add one when you need it; don't import
  lucide / feather / heroicons.
- **All hooks above any conditional return** — the `MultiLineChart` crash
  in v0.3.0 came from a `useMemo` placed below an early `return` on empty
  data. When the series later filled in, the hook order changed and React
  blew up. New chart components especially: declare every `useState` /
  `useMemo` / `useEffect` at the very top of the function, before any
  data-shape branching.
- **API shape**: every list endpoint returns `{ <plural>: [...] }`,
  every snapshot endpoint returns a flat object, and every error returns
  `{ error: 'snake_case_code', message: 'human readable' }` with an
  appropriate HTTP status.
- **Auth**: cookie-based JWT (`httpOnly`, `sameSite=lax`). All `/api/*`
  except `/api/health` and `/api/auth/login` go through `auth` middleware.
- **No shell strings** — every external invocation uses `execFile` from
  `server/collectors/exec.js` so we never assemble shell input.
- **Theme tokens** in `:root` (see `client/src/styles.css`). Use
  `var(--accent)`, `var(--bg-card)`, `var(--text-muted)`, etc. Don't
  hardcode hex outside that block. Notable additions in v0.3.0:
  `--bg-card-2`, `--border-strong`, `--accent-soft`, `--shadow-sm/md/lg`,
  `--radius-sm/xs`, `--transition`.
- **Tabular figures by default** — `font-variant-numeric: tabular-nums`
  is applied at the body level in `styles.css`. Don't override it; numbers
  in cards/tables/charts should always have monospaced widths so values
  don't wobble as they update.
- **Reduced motion** — every animation and transition is opted out under
  `@media (prefers-reduced-motion: reduce)` (one global rule at the bottom
  of `styles.css`). New animations should rely on this rather than
  shipping their own opt-out.
- **Comments**: explain the *why* if it's non-obvious; don't restate the
  *what*. Most files have zero comments and that's deliberate.

---

## How history works

`server/history.js`:

- Opens `data/othoni.db` (path overridable via `OTHONI_DB`), enables WAL.
- Schema: one wide table `samples(metric TEXT, t INTEGER, v REAL)` with an
  index on `(metric, t)`. Adding metrics doesn't change the schema.
- Every `OTHONI_SAMPLE_MS` (default 5 s), runs all the collectors and
  inserts one row per metric in a single transaction.
- Every 10 min, deletes rows older than `OTHONI_RETENTION_MS` (default 24 h).
- `query({ metric, range, maxPoints })` does **on-the-fly bucket
  averaging**: it computes a bucket size from `range / maxPoints` and runs
  `SELECT (t / bucket) * bucket AS t, AVG(v) AS v ... GROUP BY t`. This
  keeps any range under the wire-size cap without a precomputed
  rollup table.
- `start()` is called once from `server/index.js` after `app.listen()`.
  `stop()` is wired to `SIGTERM` / `SIGINT` for clean shutdown.

Range constants and the metrics map are at the top of the file — adding a
new metric or range is a one-line change.

---

## Common tasks

| I want to…                                  | Touch these files                                           |
|--------------------------------------------|-------------------------------------------------------------|
| Add a new dashboard card                   | `client/src/pages/Dashboard.jsx`                            |
| Add a new live API endpoint                | `server/collectors/<x>.js`, `server/routes/index.js`, `client/src/api.js` |
| Add a new historical metric                | `server/history.js` (the `METRICS` map), then one chart entry on the History page |
| Add a new icon                             | `client/src/Icons.jsx` — copy an existing entry, paste new path data, export the function |
| Add a new chart primitive                  | `client/src/Charts.jsx` — keep all hooks above any conditional return |
| Tweak the brand mark                       | `client/src/Logo.jsx` and the data-URI in `client/index.html` |
| Change the theme                           | `:root { ... }` block in `client/src/styles.css`            |
| Add a new page                             | `client/src/pages/<X>.jsx` + entry in `App.jsx`'s `NAV` (with an icon) and `<Routes>` |
| Tune the sampler                           | env vars in `.env`: `OTHONI_SAMPLE_MS`, `OTHONI_RETENTION_MS`, `OTHONI_DB` |
| Add a new alertable metric                 | one entry in `METRICS` in `client/src/alerts.js` — `{ label, unit, extract, format }`. The Alerts page picks it up automatically. |
| Push an external metric from an agent      | generate a key on `/settings`, then `curl -H "Authorization: Bearer othoni_..." -H 'Content-Type: application/json' -d '{"name":"custom.foo","value":42}' https://.../api/metrics`. Metric must start with `custom.`. |

---

## Things that look weird but aren't

- **`/api/health` is the only unauthenticated `/api/*` route.** Keep it
  that way — anything else under `/api` should require a session
  (cookie) or an API key (Bearer header).
- **`/api/metrics` is auth'd by API key, NOT cookie.** It's mounted
  in `server/index.js` BEFORE the `app.use('/api', auth, apiRouter)`
  line; moving it under that line would break the headless-agent
  flow because Bearer-auth requests don't carry a session cookie.
- **`/api/logs` returns 200 even when disabled.** Body is
  `{enabled:false, reason:"..."}`. This is intentional — the Logs page
  uses that to render a "how to enable" card instead of showing a
  broken-loading error. Don't change to 403.
- **`network.js` warms up at import time** by calling `getNetwork()` once.
  This populates the `previous` map so the *first* HTTP request returns
  realistic RX/TX speeds instead of zeros.
- **The favicon is a `data:` URI** in the HTML, not a file. This is
  deliberate — it stops the browser from falling back to `/favicon.ico`
  (which would otherwise be answered by the SPA catch-all and return
  `index.html`).
- **`/favicon.ico` returns 204.** Same reason.
- **Chart axes can look "compressed"** when only a few minutes of samples
  exist. The `<LineChart>` x-axis spans the data, not the requested range,
  so a fresh install showing the "1h" view will look like the "5m" view
  until the buffer fills.
- **Variable-cardinality history metrics** — per-core CPU
  (`cpu.core.<n>`), per-interface network (`net.iface.<name>.{rx,tx}`)
  and per-disk I/O (`disk.dev.<name>.{read,write}`) are sampled in
  addition to the static composite/breakdown metrics. The `isValidMetric`
  helper in `server/history.js` matches them against regex patterns
  rather than the static `METRICS` map. We deliberately filter
  `veth*` out of the per-iface set at sample time, because Docker
  recreates them constantly and they would leave thousands of orphan
  series in the DB.

---

## What is *not* here

- No background queue / cron beyond the 5 s sampler and 10 min pruner.
- No external services (no Redis, no Postgres, no Prometheus, no Grafana).
- No write actions on the API surface — read-only by design. Service
  restart / process kill / container start are listed in `ROADMAP.md` and
  intentionally deferred until there's a credible auth + audit story.
- No multi-tenant — one admin user, one host.

---

## Recent direction (2026-05)

- **v0.1.0 (2026-05-09)**: live monitoring MVP, deployed behind nginx + TLS.
- **v0.2.0 (2026-05-09)**: branding (SVG logo + favicon), historical
  metrics in SQLite, sparklines on cards, dedicated History page with
  range selector. Pure-SVG charts — no library dependencies.
- **v0.3.0 (2026-05-09)**: big data + UI upgrade. Disk I/O collector and
  12 new historical metric series (CPU breakdown, memory breakdown,
  per-core CPU, disk read/write). Three new pure-SVG chart primitives
  (`<MultiLineChart>`, `<StackedAreaChart>`, `<CoreGrid>`). Dashboard
  redesigned with hero CPU+RAM chart, per-core grid, disk I/O card.
  History page sectioned. UI polish: icon set, sidebar with active glow,
  topbar pulse + clock, card hover lift, gradient bars, skeleton loaders.
- **v0.4.0 (2026-05-10)**: density + cardinality. Sparklines now show
  min/avg/max (faint dashed bands inside the SVG + tiny stats footer).
  New per-interface (`net.iface.<name>.{rx,tx}`) and per-disk
  (`disk.dev.<name>.{read,write}`) historical metrics, with `veth*`
  filtered out at sample time. History page gains "Per-disk I/O" and
  "Per-interface network" sections. New generic `useDynamicSeries` hook
  on the History page covers any variable-cardinality series.
- **v0.5.0 (2026-05-10)**: brushable zoom + connections page. Drag-select
  on any History chart now zooms in (shared `useBrush` hook in
  `Charts.jsx`, opt-in via `enableBrush`). New `/api/connections`
  endpoint backed by a pure-JS `/proc/net/{tcp,tcp6,udp,udp6}` parser
  (no shell), and a Connections page at `/connections` with a listening
  ports table (grouped by `(protocol, port)` to dedup v4/v6 binds) and
  a filterable active-TCP table (server-side capped at 1000 rows).
- **v0.6.0 (2026-05-10)**: alerting. Threshold rule engine
  (`client/src/alerts.js`) with sustained-duration evaluation; topbar
  notification dot + popover; `/alerts` page for inline rule editing;
  default rules seeded on first load (CPU/mem/disk > 90%); optional
  browser notifications. Entirely client-side — rules persist to
  localStorage per browser, firing state is in-memory only. Server-side
  state was deliberately not added.
- **v0.7.0 (2026-05-10)**: system log feed via
  `journalctl --output=json`. New `server/collectors/logs.js` (uses
  `execFile`, no shell), `/api/logs` route, `/logs` page with filters
  (priority, since, unit, limit) + auto-tail toggle. **Opt-in via
  `OTHONI_LOGS_ENABLED=true`** because journal entries can leak
  sensitive content (passwords, tokens, public IPs in kernel iptables
  logs). When disabled, the route returns `{enabled:false}` cleanly so
  the UI can render an explanatory card instead of erroring.
- **v0.10.0 (2026-05-10)**: external metric ingestion via API keys.
  New `server/api-keys.js` (hashed keys at `data/api-keys.json`, 0600,
  GitHub-PAT-style plaintext-once flow), new `POST /api/metrics`
  ingestion endpoint (Bearer-token, mounted before the cookie-auth
  wall), new `/api/keys` CRUD + `/api/history/metrics` (cookie-auth).
  External agents can push `custom.<name>` series only — built-in
  metrics like `cpu` can't be shadowed. Settings page gets an "API
  keys" card; History page auto-discovers `custom.*` and renders one
  chart per under a new "Custom" section.
- **v0.9.0 (2026-05-10)**: optional TOTP (RFC 6238) second factor on
  login. Pure-JS in `server/totp.js` (no deps); verified against RFC
  6238 Appendix B vectors. Off by default — set `OTHONI_TOTP_SECRET`
  to enable. `npm run totp:setup` generates a secret, prints
  enrollment URL + (if `qrencode` is on PATH) inline QR. Login page
  conditionally renders the code field based on
  `/api/health` → `auth.totp`. All login failures return the same
  generic `invalid_credentials` 401 — no enumeration of which factor
  was wrong.
- **v0.8.0 (2026-05-10)**: connective tissue + polish. Connection
  history (4 new metrics — established / time-wait / listening / total
  — sampled into the SQLite store and charted). Cross-link from each
  firing alert in the topbar popover to a pre-filtered Logs page
  (URL query params on `/logs` round-trip, so deep links work).
  CSV export button on every History chart (client-side from
  in-memory points). Trust-proxy fix on Express
  (`app.set('trust proxy', 1)`) — kills the
  `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` rate-limiter warning that had
  appeared since the nginx reverse proxy was added.

See `CHANGELOG.md` for details, `ROADMAP.md` for what's next.

---

## When making changes here

- Run `npm run client:build` after frontend edits, then
  `systemctl restart othoni`.
- Smoke test: `curl -s https://othoni.syedhashmi.trade/api/health` should
  return `{ "ok": true, ... }`.
- The DB is durable across restarts — historical data is not lost on
  redeploy.
- When adding metrics, expect a few minutes of empty charts on the new
  series until the sampler accumulates points.
