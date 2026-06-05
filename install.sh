#!/usr/bin/env bash
# othoni one-line installer. Usage:
#
#   # fresh install on a new VPS — runs a short GUIDED setup wizard
#   # (admin user, port, bind address, peer mode, map geo, password):
#   curl -fsSL https://raw.githubusercontent.com/syedhashmi-bit/Othoni/main/install.sh | sudo bash
#
#   # unattended (CI / image build) — skips the wizard:
#   curl -fsSL .../install.sh | sudo OTHONI_ADMIN_PASSWORD='strong-password' OTHONI_NONINTERACTIVE=1 bash
#
#   # upgrade an existing install (re-running this script is safe):
#   sudo bash /var/www/othoni/install.sh
#
# The guided wizard runs on a fresh install whenever a terminal is available
# (it reads from /dev/tty, so `curl | sudo bash` works). Any value supplied
# via the env vars below is used as the wizard's default; set
# OTHONI_NONINTERACTIVE=1 to skip the wizard entirely.
#
# Tunable via env vars:
#   OTHONI_INSTALL_DIR (default: /var/www/othoni)
#   OTHONI_REPO_URL    (default: https://github.com/syedhashmi-bit/Othoni.git)
#   OTHONI_BRANCH      (default: main)
#   OTHONI_PORT        (default: 8088 — bind to 127.0.0.1 by default; expose via nginx)
#   OTHONI_HOST        (default: 127.0.0.1)
#   OTHONI_ADMIN_USER  (default: admin)
#   OTHONI_ROLE        (default: full — set 'peer' for a lightweight federation peer)
#   OTHONI_GEOLOCATE   (default: on — set 'off' to skip fleet-map IP auto-location)
#   OTHONI_NONINTERACTIVE (set to 1 to skip the guided wizard)
#   OTHONI_ADMIN_PASSWORD (omit for an interactive prompt; falls back to a random
#                          password printed at the end if stdin isn't a TTY)
#
# What this does:
#   1. Verifies it's running as root.
#   2. Installs Node.js 20 via NodeSource if `node` is < 18 or missing.
#   3. Clones the repo into INSTALL_DIR (or `git pull`s if it already exists).
#   4. Runs `npm install && npm run build`.
#   5. On a FRESH install only, generates `.env` with a random JWT secret + the
#      admin password (hashed with scrypt via `npm run hash-password`).
#   6. Drops a systemd unit, enables + starts it.
#   7. Smoke-tests `/api/health` and prints the next-steps banner.
#
# This script is idempotent — re-running it does an upgrade (pull + rebuild +
# restart) and won't overwrite an existing `.env`.

set -euo pipefail

INSTALL_DIR="${OTHONI_INSTALL_DIR:-/var/www/othoni}"
REPO_URL="${OTHONI_REPO_URL:-https://github.com/syedhashmi-bit/Othoni.git}"
BRANCH="${OTHONI_BRANCH:-main}"
PORT="${OTHONI_PORT:-8088}"
HOST="${OTHONI_HOST:-127.0.0.1}"
ADMIN_USER="${OTHONI_ADMIN_USER:-admin}"
ROLE="${OTHONI_ROLE:-full}"
GEOLOCATE="${OTHONI_GEOLOCATE:-on}"
SERVICE_NAME="othoni"
NODE_MIN_MAJOR=18
NODE_INSTALL_MAJOR=20

# ---- helpers ----
log()  { printf '\033[1;36m[othoni]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[othoni]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[othoni]\033[0m %s\n' "$*" >&2; exit 1; }

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    die "must run as root (try: sudo bash install.sh)"
  fi
}

# ---- interactive guided setup ----
# Prompts read from /dev/tty (not stdin) so they work even under
# `curl ... | sudo bash`, where stdin is the script itself. Guided mode is
# skipped when there's no terminal or OTHONI_NONINTERACTIVE=1 is set, so CI
# and image builds stay fully unattended.
interactive() {
  [ -z "${OTHONI_NONINTERACTIVE:-}" ] && [ -e /dev/tty ]
}

ask() { # ask <var> <prompt> <default>
  local __var="$1" __prompt="$2" __def="$3" __ans=""
  printf '\033[1;36m[othoni]\033[0m %s [\033[1m%s\033[0m]: ' "$__prompt" "$__def" > /dev/tty
  IFS= read -r __ans < /dev/tty || true
  [ -z "$__ans" ] && __ans="$__def"
  printf -v "$__var" '%s' "$__ans"
}

ask_yesno() { # ask_yesno <prompt> <default: y|n> -> exit 0 for yes
  local __prompt="$1" __def="$2" __ans="" __hint="y/N"
  [ "$__def" = "y" ] && __hint="Y/n"
  printf '\033[1;36m[othoni]\033[0m %s [%s]: ' "$__prompt" "$__hint" > /dev/tty
  IFS= read -r __ans < /dev/tty || true
  [ -z "$__ans" ] && __ans="$__def"
  case "$__ans" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

ask_secret() { # ask_secret <var> <prompt>
  local __var="$1" __prompt="$2" __p1 __p2
  while true; do
    printf '\033[1;36m[othoni]\033[0m %s: ' "$__prompt" > /dev/tty
    IFS= read -r -s __p1 < /dev/tty; echo > /dev/tty
    printf '\033[1;36m[othoni]\033[0m confirm: ' > /dev/tty
    IFS= read -r -s __p2 < /dev/tty; echo > /dev/tty
    if [ -z "$__p1" ]; then warn "empty password — try again."; continue; fi
    if [ "$__p1" != "$__p2" ]; then warn "passwords don't match — try again."; continue; fi
    printf -v "$__var" '%s' "$__p1"; break
  done
}

guided_config() {
  interactive || return 0
  # Only walk the wizard on a FRESH install; an upgrade keeps the existing .env.
  [ -f "$INSTALL_DIR/.env" ] && return 0

  cat > /dev/tty <<'BANNER'

────────────────────────────────────────────────────────────
  othoni guided setup — press Enter to accept each [default]
────────────────────────────────────────────────────────────
BANNER

  ask ADMIN_USER "Admin username" "$ADMIN_USER"
  ask PORT "Port to listen on" "$PORT"
  ask HOST "Bind address (127.0.0.1 = behind nginx · 0.0.0.0 = direct)" "$HOST"
  if ask_yesno "Run as a lightweight federation PEER (skips alert/check/audit loops)?" "n"; then
    ROLE="peer"
  fi
  if ask_yesno "Auto-locate this server on the fleet map by its public IP?" "y"; then
    GEOLOCATE="on"
  else
    GEOLOCATE="off"
  fi
  if [ -z "${OTHONI_ADMIN_PASSWORD:-}" ]; then
    ask_secret OTHONI_ADMIN_PASSWORD "Admin password"
    export OTHONI_ADMIN_PASSWORD
  fi

  cat > /dev/tty <<EOF

  Summary
    user:        $ADMIN_USER
    listen:      $HOST:$PORT
    role:        $ROLE
    map geo:     $GEOLOCATE
    install dir: $INSTALL_DIR
EOF
  ask_yesno "Proceed with these settings?" "y" || die "aborted by user."
}

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
  [ "${major:-0}" -ge "$NODE_MIN_MAJOR" ]
}

install_node() {
  log "installing Node.js $NODE_INSTALL_MAJOR via NodeSource…"
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_INSTALL_MAJOR}.x" | bash -
    apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1; then
    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_INSTALL_MAJOR}.x" | bash -
    dnf install -y nodejs
  elif command -v yum >/dev/null 2>&1; then
    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_INSTALL_MAJOR}.x" | bash -
    yum install -y nodejs
  else
    die "no supported package manager found (apt-get / dnf / yum). Install Node $NODE_MIN_MAJOR+ manually and re-run."
  fi
}

clone_or_pull() {
  if [ -d "$INSTALL_DIR/.git" ]; then
    log "upgrading existing install at $INSTALL_DIR (git pull)"
    git -C "$INSTALL_DIR" fetch --quiet origin
    git -C "$INSTALL_DIR" checkout --quiet "$BRANCH"
    git -C "$INSTALL_DIR" pull --quiet --ff-only
  elif [ -d "$INSTALL_DIR" ] && [ "$(ls -A "$INSTALL_DIR")" ]; then
    warn "$INSTALL_DIR exists and is not a git checkout — leaving files in place."
    warn "If you meant to install fresh, move the directory aside first."
  else
    log "cloning $REPO_URL into $INSTALL_DIR"
    mkdir -p "$INSTALL_DIR"
    git clone --quiet --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
  fi
}

build() {
  log "installing dependencies + building client (this takes ~30s)"
  cd "$INSTALL_DIR"
  npm install --no-audit --no-fund
  npm run build
}

# Generate a fresh .env iff one doesn't exist. Won't touch an existing file —
# upgrade flow keeps your secrets / TOTP / Prometheus token / etc.
generate_env_if_missing() {
  local env_path="$INSTALL_DIR/.env"
  if [ -f "$env_path" ]; then
    log "$env_path already exists — leaving it alone (upgrade mode)"
    return 0
  fi

  local jwt password password_source password_hash
  jwt="$(node -e 'console.log(require("crypto").randomBytes(48).toString("hex"))')"

  if [ -n "${OTHONI_ADMIN_PASSWORD:-}" ]; then
    password="$OTHONI_ADMIN_PASSWORD"
    password_source="(supplied via OTHONI_ADMIN_PASSWORD)"
  elif [ -t 0 ]; then
    # Interactive: prompt twice with hidden input.
    local p1 p2
    while true; do
      printf '\033[1;36m[othoni]\033[0m admin password: ' >&2
      read -r -s p1; echo >&2
      printf '\033[1;36m[othoni]\033[0m confirm password: ' >&2
      read -r -s p2; echo >&2
      if [ -z "$p1" ]; then warn "empty password — try again."; continue; fi
      if [ "$p1" != "$p2" ]; then warn "passwords don't match — try again."; continue; fi
      password="$p1"
      password_source="(entered interactively)"
      break
    done
  else
    # Non-interactive and no password: generate a random one. Print at end.
    password="$(node -e 'console.log(require("crypto").randomBytes(12).toString("base64").replace(/[/+=]/g,"").slice(0,16))')"
    password_source="(auto-generated; printed below)"
  fi

  log "hashing password with scrypt"
  password_hash="$(printf '%s' "$password" | node "$INSTALL_DIR/scripts/hash-password.js" 2>/dev/null \
    | grep '^     OTHONI_ADMIN_PASSWORD_HASH=' | sed 's/^     //')"

  if [ -z "$password_hash" ]; then
    die "failed to generate password hash (scripts/hash-password.js)"
  fi

  cat > "$env_path" <<EOF
# Generated by install.sh on $(date -Is)
PORT=$PORT
HOST=$HOST
OTHONI_ADMIN_USER=$ADMIN_USER
$password_hash
OTHONI_JWT_SECRET=$jwt
OTHONI_SESSION_TTL=12h
OTHONI_DB=$INSTALL_DIR/data/othoni.db
OTHONI_SAMPLE_MS=5000
OTHONI_RETENTION_MS=86400000
NODE_ENV=production
EOF
  # Optional non-default settings (guided setup or env overrides).
  [ "${ROLE:-full}" = "peer" ] && echo "OTHONI_ROLE=peer" >> "$env_path"
  [ "${GEOLOCATE:-on}" = "off" ] && echo "OTHONI_GEOLOCATE=off" >> "$env_path"
  chmod 600 "$env_path"
  log ".env created at $env_path (mode 600) $password_source"

  # Stash the password for the final banner if it was auto-generated.
  if [[ "$password_source" == *auto-generated* ]]; then
    OTHONI_AUTOGENERATED_PASSWORD="$password"
  fi
}

install_systemd() {
  local unit_src="$INSTALL_DIR/othoni.service.example"
  local unit_dst="/etc/systemd/system/$SERVICE_NAME.service"
  if [ ! -f "$unit_src" ]; then
    die "$unit_src not found in repo — install aborted."
  fi
  # Substitute the install dir into the example unit. The example uses
  # /var/www/othoni; rewrite if the user picked something else.
  sed "s|/var/www/othoni|$INSTALL_DIR|g" "$unit_src" > "$unit_dst"
  systemctl daemon-reload
  systemctl enable --now "$SERVICE_NAME"
}

restart_if_running() {
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    log "restarting $SERVICE_NAME to pick up the new build"
    systemctl restart "$SERVICE_NAME"
  fi
}

smoke_test() {
  log "smoke-testing http://$HOST:$PORT/api/health"
  for i in 1 2 3 4 5; do
    if curl -fsS "http://$HOST:$PORT/api/health" >/dev/null 2>&1; then
      log "service is up"
      return 0
    fi
    sleep 1
  done
  warn "service didn't respond on /api/health within 5s. Check: journalctl -u $SERVICE_NAME -n 50"
  return 1
}

print_banner() {
  local version url
  version="$(node -p "require('$INSTALL_DIR/package.json').version" 2>/dev/null || echo unknown)"
  url="http://$HOST:$PORT/"
  cat <<EOF

────────────────────────────────────────────────────────────
  othoni v$version is installed and running.
────────────────────────────────────────────────────────────

  dashboard: $url   (or front it with nginx + TLS — see
             nginx-othoni.conf.example in the repo)
  config:    $INSTALL_DIR/.env  (mode 600)
  data:      $INSTALL_DIR/data/othoni.db
  service:   sudo systemctl status $SERVICE_NAME
             sudo journalctl -u $SERVICE_NAME -f

  to upgrade later, just re-run this script:
     sudo bash $INSTALL_DIR/install.sh
EOF

  if [ -n "${OTHONI_AUTOGENERATED_PASSWORD:-}" ]; then
    cat <<EOF

  ⚠  An admin password was auto-generated since this was an
     unattended install with no OTHONI_ADMIN_PASSWORD set.
     Save this — it is not stored anywhere else:

         user: $ADMIN_USER
         pass: $OTHONI_AUTOGENERATED_PASSWORD

EOF
  fi
}

# ---- main ----
require_root

if ! node_ok; then
  install_node
fi

guided_config

clone_or_pull
build
generate_env_if_missing
install_systemd
restart_if_running
smoke_test || true
print_banner
