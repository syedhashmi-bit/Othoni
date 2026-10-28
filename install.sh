#!/usr/bin/env bash
# othoni one-line installer. Usage:
#
#   # fresh install on a new VPS — runs a short GUIDED setup wizard
#   # (port, bind address, peer mode, map geo, Google sign-in):
#   curl -fsSL https://raw.githubusercontent.com/syedhashmi-bit/Othoni/main/install.sh | sudo bash
#
#   # unattended (CI / image build) — skips the wizard:
#   curl -fsSL .../install.sh | sudo OTHONI_PUBLIC_URL=https://othoni.example.com \
#     OTHONI_GOOGLE_CLIENT_ID=... OTHONI_GOOGLE_CLIENT_SECRET=... \
#     OTHONI_ADMIN_EMAILS=you@example.com OTHONI_NONINTERACTIVE=1 bash
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
#   OTHONI_ROLE        (default: full — set 'peer' for a lightweight federation peer)
#   OTHONI_GEOLOCATE   (default: on — set 'off' to skip fleet-map IP auto-location)
#   OTHONI_NONINTERACTIVE (set to 1 to skip the guided wizard)
#   OTHONI_PUBLIC_URL, OTHONI_GOOGLE_CLIENT_ID, OTHONI_GOOGLE_CLIENT_SECRET,
#   OTHONI_ADMIN_EMAILS   Google sign-in (the only way in). Give all four, or
#                         leave them out and fill them into .env afterwards.
#
# What this does:
#   1. Verifies it's running as root.
#   2. Installs Node.js 20 via NodeSource if `node` is < 18 or missing.
#   3. Clones the repo into INSTALL_DIR (or `git pull`s if it already exists).
#   4. Runs `npm install && npm run build`.
#   5. On a FRESH install only, generates `.env` with a random JWT secret + the
#      Google sign-in settings.
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
PUBLIC_URL="${OTHONI_PUBLIC_URL:-}"
GOOGLE_CLIENT_ID="${OTHONI_GOOGLE_CLIENT_ID:-}"
GOOGLE_CLIENT_SECRET="${OTHONI_GOOGLE_CLIENT_SECRET:-}"
ADMIN_EMAILS="${OTHONI_ADMIN_EMAILS:-}"
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

ask_hidden() { # ask_hidden <var> <prompt> — no echo; Enter keeps the current value
  local __var="$1" __prompt="$2" __ans=""
  printf '\033[1;36m[othoni]\033[0m %s: ' "$__prompt" > /dev/tty
  IFS= read -r -s __ans < /dev/tty || true; echo > /dev/tty
  [ -n "$__ans" ] && printf -v "$__var" '%s' "$__ans"
  return 0
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

  cat > /dev/tty <<'GOOGLE'

  Sign-in is Google-only. You need an OAuth client ("Web application")
  from Google Cloud Console → APIs & Services → Credentials. Leave these
  blank to fill them into .env later.
GOOGLE
  ask PUBLIC_URL "Public https URL of this dashboard (e.g. https://othoni.example.com)" "$PUBLIC_URL"
  ask GOOGLE_CLIENT_ID "Google OAuth client ID" "$GOOGLE_CLIENT_ID"
  ask_hidden GOOGLE_CLIENT_SECRET "Google OAuth client secret (hidden)"
  ask ADMIN_EMAILS "Admin Google email(s), comma-separated" "$ADMIN_EMAILS"

  cat > /dev/tty <<EOF

  Summary
    sign-in:     ${ADMIN_EMAILS:-(Google not set up yet — finish in .env)}
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
# upgrade flow keeps your secrets / Google client / Prometheus token / etc.
generate_env_if_missing() {
  local env_path="$INSTALL_DIR/.env"
  if [ -f "$env_path" ]; then
    log "$env_path already exists — leaving it alone (upgrade mode)"
    # Installs from before Google sign-in have no client configured, so
    # after this upgrade nobody can log in until it's added.
    grep -q '^OTHONI_GOOGLE_CLIENT_ID=.' "$env_path" || GOOGLE_PENDING=1
    return 0
  fi

  local jwt
  jwt="$(node -e 'console.log(require("crypto").randomBytes(48).toString("hex"))')"
  PUBLIC_URL="${PUBLIC_URL%/}"

  cat > "$env_path" <<EOF
# Generated by install.sh on $(date -Is)
PORT=$PORT
HOST=$HOST
OTHONI_JWT_SECRET=$jwt
OTHONI_SESSION_TTL=12h
OTHONI_DB=$INSTALL_DIR/data/othoni.db
OTHONI_SAMPLE_MS=5000
OTHONI_RETENTION_MS=86400000
NODE_ENV=production
EOF
  # Google sign-in goes in live only when complete: a half-filled config
  # makes a production boot refuse to start, so otherwise it's written
  # commented out for the operator to finish.
  if [ -n "$PUBLIC_URL" ] && [ -n "$GOOGLE_CLIENT_ID" ] && [ -n "$GOOGLE_CLIENT_SECRET" ] && [ -n "$ADMIN_EMAILS" ]; then
    cat >> "$env_path" <<EOF
OTHONI_PUBLIC_URL=$PUBLIC_URL
OTHONI_GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID
OTHONI_GOOGLE_CLIENT_SECRET=$GOOGLE_CLIENT_SECRET
OTHONI_ADMIN_EMAILS=$ADMIN_EMAILS
EOF
    GOOGLE_READY=1
  else
    cat >> "$env_path" <<EOF
# Google sign-in — fill in all four, uncomment, then restart othoni.
# Redirect URI to register on the OAuth client: <OTHONI_PUBLIC_URL>/api/auth/google/callback
#OTHONI_PUBLIC_URL=${PUBLIC_URL:-https://othoni.example.com}
#OTHONI_GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID
#OTHONI_GOOGLE_CLIENT_SECRET=$GOOGLE_CLIENT_SECRET
#OTHONI_ADMIN_EMAILS=$ADMIN_EMAILS
EOF
    GOOGLE_PENDING=1
  fi
  # Optional non-default settings (guided setup or env overrides).
  [ "${ROLE:-full}" = "peer" ] && echo "OTHONI_ROLE=peer" >> "$env_path"
  [ "${GEOLOCATE:-on}" = "off" ] && echo "OTHONI_GEOLOCATE=off" >> "$env_path"
  chmod 600 "$env_path"
  log ".env created at $env_path (mode 600)"
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

  if [ -n "${GOOGLE_READY:-}" ]; then
    cat <<EOF

  sign in:   $PUBLIC_URL/  with Google ($ADMIN_EMAILS)
             redirect URI on the OAuth client must be:
             $PUBLIC_URL/api/auth/google/callback

EOF
  elif [ -n "${GOOGLE_PENDING:-}" ]; then
    cat <<EOF

  ⚠  Google sign-in isn't set up yet, so nobody can log in.
     1. Google Cloud Console → APIs & Services → Credentials →
        Create OAuth client ID → "Web application", with the
        Authorized redirect URI  <your https URL>/api/auth/google/callback
     2. Set OTHONI_PUBLIC_URL, OTHONI_GOOGLE_CLIENT_ID,
        OTHONI_GOOGLE_CLIENT_SECRET and OTHONI_ADMIN_EMAILS in
        $INSTALL_DIR/.env
     3. sudo systemctl restart $SERVICE_NAME

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
