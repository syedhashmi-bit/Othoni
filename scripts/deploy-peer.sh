#!/usr/bin/env bash
#
# deploy-peer.sh — turn THIS box into an othoni federation peer in one command.
#
# Run this ON the remote VPS, after the othoni code is present (rsync/git) and
# its WireGuard tunnel is up (traverse issues the .conf). It installs deps,
# builds the client, writes a production .env bound to the WireGuard IP with
# freshly-generated secrets + a peer token, installs/starts the systemd unit,
# smoke-tests, and prints the url + token to register on the central othoni.
#
# Usage:
#   sudo bash scripts/deploy-peer.sh [wg-ip]
#     wg-ip   the WireGuard address to bind to (e.g. 10.8.0.6).
#             Omit to auto-detect the address on wg0.
#   PORT=8088 (env override) sets the listen port.
#
# Idempotent: re-running never rotates existing secrets — it only fills in what
# is missing and re-points HOST/PORT. If you copied an .env from another box,
# delete it first so this box gets its own secrets.

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: run as root (sudo bash scripts/deploy-peer.sh ...)" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$APP_DIR/.env"
UNIT=/etc/systemd/system/othoni.service
PORT="${PORT:-8088}"
WG_SUBNET="${WG_SUBNET:-10.8.0.0/24}"

# ---- resolve the bind IP -------------------------------------------------
WG_IP="${1:-}"
if [ -z "$WG_IP" ]; then
  WG_IP="$(ip -4 -o addr show wg0 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n1 || true)"
fi
if [ -z "$WG_IP" ]; then
  echo "ERROR: no bind IP given and none found on wg0." >&2
  echo "       Usage: sudo bash scripts/deploy-peer.sh <wg-ip>   (e.g. 10.8.0.6)" >&2
  exit 1
fi
if ! ip -4 addr show | grep -qw "$WG_IP"; then
  echo "WARNING: $WG_IP is not assigned to a local interface — othoni will fail to" >&2
  echo "         bind. Bring up the WireGuard tunnel (traverse .conf) first." >&2
fi

# ---- toolchain check -----------------------------------------------------
command -v node >/dev/null || { echo "ERROR: node not found — install Node 18+ first." >&2; exit 1; }
NODE_MAJOR="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "ERROR: Node $NODE_MAJOR found; othoni needs Node >= 18." >&2
  exit 1
fi
command -v openssl >/dev/null || { echo "ERROR: openssl not found." >&2; exit 1; }

cd "$APP_DIR"
echo "==> Installing dependencies (npm ci)"
npm ci

echo "==> Building client"
npm run client:build >/dev/null

# ---- .env --------------------------------------------------------------
[ -f "$ENV_FILE" ] || : > "$ENV_FILE"
chmod 600 "$ENV_FILE"

set_kv() {  # force-set KEY=VALUE
  if grep -qE "^$1=" "$ENV_FILE"; then
    sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"
  fi
}
get_kv()    { grep -E "^$1=" "$ENV_FILE" | head -n1 | cut -d= -f2-; }
has_kv()    { grep -qE "^$1=" "$ENV_FILE"; }

# Bind config always reflects this deploy.
set_kv NODE_ENV production
set_kv HOST "$WG_IP"
set_kv PORT "$PORT"

# Secrets: generate only when missing so re-runs don't break a working peer.
PEER_TOKEN="$(get_kv OTHONI_PEER_TOKEN)"
if [ -z "$PEER_TOKEN" ]; then
  PEER_TOKEN="$(openssl rand -hex 24)"
  printf 'OTHONI_PEER_TOKEN=%s\n' "$PEER_TOKEN" >> "$ENV_FILE"
fi
has_kv OTHONI_JWT_SECRET || printf 'OTHONI_JWT_SECRET=%s\n' "$(openssl rand -hex 32)" >> "$ENV_FILE"

ADMIN_PW=""
if ! has_kv OTHONI_ADMIN_PASSWORD && ! has_kv OTHONI_ADMIN_PASSWORD_HASH; then
  ADMIN_PW="$(openssl rand -hex 12)"
  printf 'OTHONI_ADMIN_PASSWORD=%s\n' "$ADMIN_PW" >> "$ENV_FILE"
fi
chmod 600 "$ENV_FILE"

# ---- systemd unit ------------------------------------------------------
echo "==> Installing systemd unit"
[ -f "$UNIT" ] || cp "$APP_DIR/othoni.service.example" "$UNIT"
systemctl daemon-reload
systemctl enable othoni >/dev/null 2>&1 || true
systemctl restart othoni
sleep 2

# ---- firewall (best effort) -------------------------------------------
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "^Status: active"; then
  ufw allow from "$WG_SUBNET" to any port "$PORT" proto tcp >/dev/null 2>&1 || true
  echo "==> ufw: allowed $WG_SUBNET -> $PORT/tcp"
fi

# ---- smoke test --------------------------------------------------------
if ! systemctl is-active --quiet othoni; then
  echo "ERROR: othoni failed to start. Recent logs:" >&2
  journalctl -u othoni --since "1 minute ago" --no-pager | tail -20 >&2
  exit 1
fi
HEALTH="$(curl -s --max-time 8 "http://$WG_IP:$PORT/api/health" || true)"

HOSTID="$(hostname -s 2>/dev/null || hostname)"
echo ""
echo "────────────────────────────────────────────────────────"
echo " othoni peer is live on this box."
echo "   service: active"
echo "   health : ${HEALTH:0:120}"
echo ""
echo " Register it on the CENTRAL othoni → Settings → Federated peers:"
echo "   host : $HOSTID"
echo "   url  : http://$WG_IP:$PORT"
echo "   token: $PEER_TOKEN"
if [ -n "$ADMIN_PW" ]; then
  echo ""
  echo " This box's own admin login (only needed to reach it directly): admin / $ADMIN_PW"
  echo " (Direct browser login over plain http won't set a cookie in production —"
  echo "  that's expected; you view this box THROUGH central, not directly.)"
fi
echo "────────────────────────────────────────────────────────"
