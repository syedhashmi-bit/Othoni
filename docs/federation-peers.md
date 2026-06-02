# Federation — adding a remote VPS as a peer

othoni's **agent** (`agent.sh`) ships a host's basic metrics into a central
instance. **Federation** goes further: it runs a *full* othoni on the remote
box and lets the central one render that box's **entire** dashboard —
Dashboard, Storage, Processes, Docker, Services, Projects, Network,
Connections, Alerts, Checks, Security, Logs, History — by reverse-proxying
read-only requests to it.

This guide walks through adding a peer end to end, including the WireGuard
transport, the one-command deploy script, registration, verification, and the
problems you're most likely to hit.

---

## How it works

```
                          ┌─────────────────────────────┐
                          │  CENTRAL othoni (you log in) │
                          │  - your account/session      │
                          │  - peers registry            │
   browser ──cookie────►  │  - GET /api/fleet/<host>/*  ─┼──┐
                          └─────────────────────────────┘  │
                                                            │ Authorization:
                                                            │ Bearer <peer token>
                                                            │ (read-only)
                          ┌─────────────────────────────┐  │
                          │  PEER othoni (remote VPS)    │ ◄┘  over WireGuard
                          │  - full stack, own DB        │     (private transport)
                          │  - OTHONI_PEER_TOKEN set     │
                          │  - bound to its WG IP        │
                          └─────────────────────────────┘
```

- Each VPS runs its **own complete othoni** with its own SQLite DB.
- The peer sets `OTHONI_PEER_TOKEN`. When set, it accepts that token as
  `Authorization: Bearer <token>` and treats the caller as a **viewer** — a
  read-only role. `requireAdmin` forces GET/HEAD only, so a peer token can
  never change anything on the peer.
- The central holds the token in its peers registry (`data/peers.json`,
  mode 0600) and reverse-proxies dashboard GETs to the peer at
  `GET /api/fleet/<host>/*`. The proxy is **GET-only** (405 on anything
  else), forwards only `/api/*` paths (400 otherwise), 404s unknown peers,
  and times out at 10s (→ 502).
- In the browser, picking a peer in the top-bar host switcher rewrites the
  host-scoped API calls to `/api/fleet/<host>/...`, so the whole UI reflects
  the peer. A `remote · <host>` chip marks the state.

**Read-only by design.** Because the proxy refuses non-GET methods, mutating
controls on a remote host (restart a project, edit alert rules, run a
remediation) return 405. To change a peer's configuration, log into that
peer's own UI directly.

---

## Transport — WireGuard (via traverse)

The peer's port should **never** be on the open internet. Put it on a private
mesh. On this fleet that mesh is WireGuard, managed by the **traverse**
dashboard (`/var/www/traverse`):

- traverse owns `wg0` — server IP `10.8.0.1`, subnet `10.8.0.0/24`,
  listen port `51820`.
- Each VPS is a traverse peer with a `10.8.0.x` address. The central othoni
  reaches every peer over this encrypted mesh.

To add a VPS to the mesh: in traverse, create a peer with the **VPN Only**
tunnel mode (routes only `10.8.0.0/24` over WireGuard, leaving the box's
normal internet untouched — correct for a server peer). traverse hands you a
`.conf`; install it on the new VPS (`wg-quick up`) and confirm the tunnel:

```bash
sudo wg show wg0                       # handshake should be recent
ip -4 addr show wg0                    # the 10.8.0.x address should be listed
```

Since WireGuard already encrypts the link, the peer othoni can serve plain
`http://10.8.0.x:8088` — no TLS needed between central and peer.

---

## Prerequisites on the new VPS

- Node.js **≥ 18** (`node -v`). Install via NodeSource if missing.
- `build-essential` + `python3` (the `better-sqlite3` native module compiles
  during `npm ci`).
- `openssl` (for secret generation), `git` or `rsync` (to get the code there).
- The WireGuard tunnel **up**, with the box's `10.8.0.x` address assigned to
  `wg0`.

---

## Step 1 — get the othoni code onto the box

The public git remote may lag the running central, so the reliable path is to
rsync the working tree from the central box. **Exclude `.env`** so you never
carry the central's secrets onto the peer:

```bash
# run on the CENTRAL box
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude data \
  --exclude client/dist --exclude .env \
  /var/www/othoni/ <newbox>:/var/www/othoni/
```

(If you used `git clone` instead, make sure the checkout includes the
federation code — i.e. `server/peers.js`, `server/routes/fleet.js`, and the
`scripts/deploy-peer.sh` this guide refers to.)

---

## Step 2 — bootstrap with `deploy-peer.sh` (recommended)

Run **on the new VPS**, from the othoni directory:

```bash
cd /var/www/othoni
sudo bash scripts/deploy-peer.sh           # auto-detects the wg0 address
# or, to bind explicitly:
sudo bash scripts/deploy-peer.sh 10.8.0.6
```

What it does, in order:

1. Verifies it's running as root and that Node ≥ 18 + openssl are present.
2. Resolves the bind IP (argument, else the address on `wg0`) and warns if
   that IP isn't actually assigned locally (othoni would fail to bind).
3. `npm ci`, then `npm run client:build`.
4. Writes/updates `.env`:
   - `NODE_ENV=production`, `HOST=<wg-ip>`, `PORT=8088` — always set.
   - `OTHONI_PEER_TOKEN`, `OTHONI_JWT_SECRET`, `OTHONI_ADMIN_PASSWORD` —
     generated **only if missing**, so re-runs never rotate working secrets.
5. Installs the systemd unit from `othoni.service.example` (if not already
   present), `daemon-reload`, `enable --now`, restart.
6. If `ufw` is active, allows the WireGuard subnet to the port.
7. Smoke-tests `http://<wg-ip>:8088/api/health`.
8. Prints the **host / url / token** to register on the central (and the
   box's own admin password, if it generated one).

Copy the printed token — you'll paste it into the central in Step 4.

> **Override the port** with `PORT=9090 sudo bash scripts/deploy-peer.sh ...`.
> The default is `8088`.

### Manual equivalent (if you'd rather not use the script)

```bash
cd /var/www/othoni
sudo apt-get install -y build-essential python3
npm ci && npm run client:build

PEER_TOKEN=$(openssl rand -hex 24)
cat > .env <<EOF
NODE_ENV=production
HOST=10.8.0.6
PORT=8088
OTHONI_JWT_SECRET=$(openssl rand -hex 32)
OTHONI_ADMIN_PASSWORD=<pick-a-strong-password>
OTHONI_PEER_TOKEN=${PEER_TOKEN}
EOF
chmod 600 .env

sudo cp othoni.service.example /etc/systemd/system/othoni.service
sudo systemctl daemon-reload && sudo systemctl enable --now othoni
echo "peer token: ${PEER_TOKEN}"
```

---

## Step 3 — verify the peer is up and reachable

On the **new VPS**:

```bash
systemctl is-active othoni                 # → active
ss -lntp | grep 8088                       # → 10.8.0.6:8088 (NOT 127.0.0.1)
curl -s http://10.8.0.6:8088/api/health    # → {"ok":true,"version":"..."}
```

From the **central box**, over the mesh:

```bash
curl -s http://10.8.0.6:8088/api/health    # reachable → same JSON
# auth wall intact — no token must be rejected:
curl -s -o /dev/null -w "%{http_code}\n" http://10.8.0.6:8088/api/system   # → 401
```

---

## Step 4 — register the peer on the central

In the central othoni UI: **Settings → Federated peers → Add peer**

| Field | Value |
|-------|-------|
| Host  | a short id, e.g. `us-vps` |
| URL   | `http://10.8.0.6:8088` |
| Token | the `OTHONI_PEER_TOKEN` printed in Step 2 |
| Label | optional, e.g. `US — Hillsboro` |

Paste the token straight into the form (keep it out of shell history / chat).
It's stored in `data/peers.json` (mode 0600) and never returned by the API.

---

## Step 5 — use it

Open the top-bar **host switcher** and pick the peer under "Federated hosts".
The whole dashboard now reflects that box; the `remote · <host>` chip confirms
it. Choose **This server (live)** to return to the central.

---

## Troubleshooting

These are the failure modes you're most likely to hit, with the symptom and
the fix.

| Symptom | Cause | Fix |
|---------|-------|-----|
| `systemctl is-active` → `activating` (loops) | service crashes on boot and systemd retries | `journalctl -u othoni --since "2 min ago"` — read the actual error |
| `Cannot find module 'dotenv'` (or any module) | `npm ci` never ran / failed | run `npm ci` in the othoni dir |
| `EADDRNOTAVAIL` on boot | `HOST` is a WG IP not assigned to the box | check `ip -4 addr show wg0`; set `HOST` to the address it actually shows |
| `Refusing to start … insecure auth config` | weak/default `OTHONI_JWT_SECRET` (<32 chars) or default admin password | set a 32+ char secret and a non-default password |
| central `curl` → "Connection refused" but ping works | peer bound to `127.0.0.1`, not the WG IP | set `HOST=<wg-ip>` in `.env`, restart; `ss -lntp \| grep 8088` should show the WG IP |
| peer `/api/system` returns 401 even via the proxy | `OTHONI_PEER_TOKEN` unset/empty on the peer, or mismatched on the central | confirm `grep OTHONI_PEER_TOKEN .env` on the peer is non-empty and matches the central registration |
| two boxes share a session unexpectedly | the peer's `.env` was copied from another box (shared `OTHONI_JWT_SECRET`) | give the peer its own `OTHONI_JWT_SECRET`; this is why Step 1 excludes `.env` |
| proxy returns 405 when you click a button | mutation through the read-only proxy | expected — log into the peer directly to change its config |
| proxy returns 502 | peer unreachable within 10s | check the tunnel (`wg show`), the peer service, and the firewall |

A copied `.env` is the subtle one: if the box already had an `.env` from a
clone of another instance, `deploy-peer.sh` preserves its existing secrets
(idempotency), which means it would keep the *wrong* box's `OTHONI_JWT_SECRET`
and admin password. If you suspect this, delete the `.env` and re-run the
script so the peer gets its own freshly-generated secrets.

---

## Removing a peer

**Settings → Federated peers → trash icon** on the peer's row removes it from
the central registry (the remote othoni keeps running; it's just no longer
proxied). The action is audit-logged on the central.

---

## Reference

| Thing | Where |
|-------|-------|
| Peer registry | `data/peers.json` (0600) on the central |
| Peer auth | `OTHONI_PEER_TOKEN` (≥16 chars) in the peer's `.env` |
| Reverse proxy | `GET /api/fleet/:host/*` (central, inside the cookie wall) |
| Peer CRUD API | `GET/PUT/DELETE /api/peers[/:host]` (admin) |
| Deploy script | `scripts/deploy-peer.sh` |
| Transport | WireGuard `wg0` / `10.8.0.0/24`, managed by traverse |
