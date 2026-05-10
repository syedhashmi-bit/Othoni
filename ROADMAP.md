# othoni — roadmap

Planned work, ordered roughly by priority. Items move to `CHANGELOG.md`
once shipped.

## Next up — UI / data ideas

Bite-sized ideas to pick from in the next session. Items move to
`CHANGELOG.md` once shipped.

- **Process trends over time** — record the top-N processes periodically
  so the Processes page can show "who's been heavy in the last hour".
- **Alert history** — record rule fires (which rule, when, value, how
  long) so the Alerts page can show "fired N times in last 24h" + a
  small spark.
- **Per-port traffic on the Connections page** — group active connections
  by remote port (top-N talkers) so SSH brute-force / scrape patterns
  show up at a glance.
- **Logs follow-ups** — pagination via `--cursor` (so "load more" works
  past the first page), highlight-on-search, jump-to-time, per-priority
  counts in the filter row, save filter presets.
- **Keyboard shortcuts** — `g` then `d`/`h`/`s` to jump to pages,
  `?` to show the cheatsheet.
- **Saved views** — checkbox-grid of metrics on the History page that
  builds a custom multi-line chart, saved to localStorage.
- **Dashboard density toggle** — compact / comfortable spacing.
- **Per-interface / per-disk on the live pages** — the History page now
  has these as time-series; the Network and Disks live pages could grow
  small inline sparklines per row.
- **Sync alert rules across browsers** — store rules server-side
  (single-user, single-host so a JSON file in `data/` would suffice) so
  the same alerts apply on phone + laptop.

_Shipped from this list in v0.8.0:_ connection history,
cross-link alerts → logs, CSV export on History charts, trust-proxy
fix for express-rate-limit.

_Shipped in v0.9.0:_ optional TOTP (RFC 6238) second factor on login.

_Shipped in v0.10.0:_ external metric ingestion via API keys
(`POST /api/metrics`, `custom.*` namespace, Settings UI, History
auto-discovery). Effectively the v1 of the "multi-host / agent" pattern
the original ROADMAP listed as out-of-scope — agents on other hosts can
now ship into a central othoni without an agent binary, just curl.

(Existing larger items below are still on the list.)

### One-line installer (`install.sh`)
The packaging goal you mentioned: `curl … | bash` to land othoni on a fresh
VPS. Should:

1. Detect Node.js ≥ 18; install via NodeSource if missing.
2. Clone (or download a release tarball) into `/opt/othoni` (or a
   user-supplied path).
3. Run `npm install && npm run build`.
4. Generate a fresh `.env` with a random `OTHONI_JWT_SECRET` and prompt for
   the admin password (or accept it via env var for unattended installs).
5. Install the systemd unit, enable + start it.
6. Print the dashboard URL and the login it set.

Open questions:
- Hosted at a fixed URL or pulled from GitHub releases?
- Detect / configure UFW or leave that to the operator?
- Optional `--nginx` flag that drops a reverse-proxy snippet into
  `/etc/nginx/conf.d/`?

### HTTPS / reverse proxy guidance
Document (and maybe ship) an nginx snippet for terminating TLS in front of
othoni so passwords aren't sent in cleartext when the dashboard is exposed
to the internet. Snippet should:
- Bind othoni to `127.0.0.1`
- Forward `Host`, `X-Forwarded-For`, `X-Forwarded-Proto`
- Optional Basic Auth in front for an extra layer

### Auth hardening
- Password hashing (bcrypt) so `OTHONI_ADMIN_PASSWORD_HASH` can be set
  instead of plaintext.
- Optional second user / read-only role.
- CSRF token on the login POST (low risk today since cookie is `sameSite=lax`,
  but worth tightening).

## Later

### Optional Prometheus exporter
`/metrics` endpoint behind a separate token so Grafana / Prom can scrape
without needing the cookie session. _Discussed and explicitly deferred_:
the design goal is a self-contained dashboard that doesn't require running
Prometheus alongside it. If a `/metrics` endpoint lands later, it should be
purely additive — for users who already run Prometheus and want to feed
othoni's samples into it.

### Action endpoints (opt-in)
Read-only by default, but with a flag in `.env` to enable:
- Restart a systemd service
- Stop / start a Docker container
- Send `SIGTERM` to a PID

These need careful auth and audit logging — do not enable by default.

### Historical graphs — _shipped in v0.2.0, expanded in v0.3.0 + v0.4.0_
SQLite ring buffer at `data/othoni.db` samples every 5 s with 24 h retention.
Sparklines on Dashboard cards, full charts on a dedicated History page.
v0.3.0 added CPU breakdown, memory breakdown, per-core CPU, and disk I/O
totals. v0.4.0 added per-interface network and per-disk I/O series, plus
sparkline min/avg/max overlays. Remaining follow-ups (brushable zoom, CSV
export, saved views, etc.) are listed at the top of this document.

### Multi-host — _v0.10.0 covers the agent-side primitive_
External agents can now POST `custom.*` metrics into the central othoni
via `/api/metrics` + an API key, no agent binary required. What's still
not built:
- Source attribution (which host sent which metric — currently the only
  signal is the API key label, e.g. `app-server-1`)
- Per-host views in the dashboard (today everything lands in one
  flat namespace)
- Bundled "agent.sh" that scrapes /proc on a remote host and pushes

## Won't do (probably)

- Built-in TLS termination — let nginx / Caddy handle it.
- Bundled Grafana — too heavy for this project's "one Node process" promise.
- Writable shell access — explicit non-goal.
