#!/usr/bin/env bash
# othoni one-line installer. Usage:
#
#   # fresh install on a new VPS — runs a short GUIDED setup wizard
#   # (port, bind address, peer mode, map geo, Google sign-in, HTTPS):
#   curl -fsSL https://raw.githubusercontent.com/syedhashmi-bit/Othoni/main/install.sh | sudo bash
#
#   # unattended (CI / image build) — skips the wizard:
#   curl -fsSL .../install.sh | sudo OTHONI_PUBLIC_URL=https://othoni.example.com \
#     OTHONI_GOOGLE_CLIENT_ID=... OTHONI_GOOGLE_CLIENT_SECRET=... \
#     OTHONI_ADMIN_EMAILS=you@example.com OTHONI_SETUP_TLS=1 OTHONI_NONINTERACTIVE=1 bash
#
#   # upgrade an existing install (re-running this script is safe):
#   sudo bash /var/www/othoni/install.sh
#
#   # add nginx + HTTPS to an existing install:
#   sudo OTHONI_SETUP_TLS=1 bash /var/www/othoni/install.sh
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
#   OTHONI_SETUP_TLS   (set to 1 to put nginx + a Let's Encrypt certificate in
#                       front of OTHONI_PUBLIC_URL's hostname; the wizard asks)
#   OTHONI_TLS_EMAIL   (Let's Encrypt account email; default: the first admin email)
#
# What this does:
#   1. Verifies it's running as root.
#   2. Installs git + curl if missing, and Node.js 24 via NodeSource if `node`
#      is older than 20 or npm is missing.
#   3. Clones the repo into INSTALL_DIR (or `git pull`s if it already exists).
#   4. Runs `npm install && npm run build`.
#   5. On a FRESH install only, generates `.env` with a random JWT secret + the
#      Google sign-in settings.
#   6. Drops a systemd unit (pointing at the node it found), enables + starts it.
#   7. Smoke-tests `/api/health`.
#   8. Optionally installs nginx + certbot and gets a Let's Encrypt certificate
#      for the public hostname (opening ports 80/443 in ufw / firewalld).
#   9. Prints the next-steps banner.
#
# This script is idempotent — re-running it does an upgrade (pull + rebuild +
# restart) and won't overwrite an existing `.env` or nginx site.

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
SETUP_TLS="${OTHONI_SETUP_TLS:-0}"
TLS_EMAIL="${OTHONI_TLS_EMAIL:-}"
SERVICE_NAME="othoni"
# better-sqlite3 (the one native dependency) ships prebuilt binaries for
# Node 20+ only; older Node makes npm compile it, which fails on a box
# without a C++ toolchain. Install the current LTS when Node is missing/old.
NODE_MIN_MAJOR=20
NODE_INSTALL_MAJOR=24
# Keep apt (and Ubuntu's needrestart "restart which services?" dialog) from
# stopping to ask questions halfway through.
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a

# ---- helpers ----
log()  { printf '\033[1;36m[othoni]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[othoni]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[othoni]\033[0m %s\n' "$*" >&2; exit 1; }

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    die "must run as root (try: sudo bash install.sh)"
  fi
}

pkg_install() { # pkg_install <pkg>... — via the distro package manager
  if command -v apt-get >/dev/null 2>&1; then
    if [ -z "${APT_UPDATED:-}" ]; then apt-get update -qq && APT_UPDATED=1; fi
    apt-get install -y -qq "$@"
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q "$@"
  elif command -v yum >/dev/null 2>&1; then
    yum install -y -q "$@"
  else
    return 1
  fi
}

# Minimal cloud images (Debian's especially) often ship without git, and
# curl is needed for the Node install + smoke test.
ensure_tools() {
  local missing=() t
  for t in git curl; do command -v "$t" >/dev/null 2>&1 || missing+=("$t"); done
  [ ${#missing[@]} -eq 0 ] && return 0
  log "installing ${missing[*]}"
  pkg_install "${missing[@]}" ca-certificates || die "couldn't install ${missing[*]} — install them and re-run."
}

# Value of KEY in an existing .env (empty if unset).
env_value() {
  sed -n "s/^$1=//p" "$INSTALL_DIR/.env" 2>/dev/null | tail -n 1
}

# The wizard accepts "othoni.example.com" or "http://…", but production
# refuses to boot unless OTHONI_PUBLIC_URL is the https:// origin.
normalize_public_url() {
  [ -n "$PUBLIC_URL" ] || return 0
  PUBLIC_URL="${PUBLIC_URL%/}"
  case "$PUBLIC_URL" in
    https://*) ;;
    http://*)
      warn "Google sign-in needs https — using https://${PUBLIC_URL#http://}"
      PUBLIC_URL="https://${PUBLIC_URL#http://}" ;;
    *) PUBLIC_URL="https://$PUBLIC_URL" ;;
  esac
}

# The hostname nginx + Let's Encrypt can serve OTHONI_PUBLIC_URL on; fails
# when there isn't one (unset, an IP address, a non-443 port or a sub-path).
tls_host() {
  local h="${PUBLIC_URL#https://}"
  [ -n "$PUBLIC_URL" ] && [ "$h" != "$PUBLIC_URL" ] || return 1
  case "$h" in ""|*/*|*:*) return 1 ;; esac
  [[ "$h" == *.* && ! "$h" =~ ^[0-9.]+$ ]] || return 1
  printf '%s\n' "$h"
}

# ---- interactive guided setup ----
# Prompts read from /dev/tty (not stdin) so they work even under
# `curl ... | sudo bash`, where stdin is the script itself. Guided mode is
# skipped when there's no terminal or OTHONI_NONINTERACTIVE=1 is set, so CI
# and image builds stay fully unattended. /dev/tty exists even without a
# controlling terminal (cloud-init, CI), so check it can actually be opened.
interactive() {
  [ -z "${OTHONI_NONINTERACTIVE:-}" ] && { : > /dev/tty; } 2>/dev/null
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

  Sign-in is Google-only, so the dashboard needs a domain name with
  https, and an OAuth client ("Web application") from Google Cloud
  Console — README → "Google sign-in" has the steps. Leave these blank
  to fill them into .env later.
GOOGLE
  ask PUBLIC_URL "Public https URL of this dashboard (e.g. https://othoni.example.com)" "$PUBLIC_URL"
  normalize_public_url
  ask GOOGLE_CLIENT_ID "Google OAuth client ID" "$GOOGLE_CLIENT_ID"
  ask_hidden GOOGLE_CLIENT_SECRET "Google OAuth client secret (hidden)"
  ask ADMIN_EMAILS "Admin Google email(s), comma-separated" "$ADMIN_EMAILS"

  local host tls_line="not set up by the installer"
  if host="$(tls_host)"; then
    cat > /dev/tty <<EOF

  HTTPS: the installer can put nginx in front of othoni and get a free
  Let's Encrypt certificate for $host (agreeing to Let's Encrypt's terms,
  and opening ports 80/443 if ufw or firewalld is on). $host's DNS
  must already point at this server.
EOF
    if ask_yesno "Set up nginx + HTTPS for $host?" "y"; then
      SETUP_TLS=1
      tls_line="nginx + Let's Encrypt for $host"
    else
      SETUP_TLS=0
    fi
  fi

  cat > /dev/tty <<EOF

  Summary
    sign-in:     ${ADMIN_EMAILS:-(Google not set up yet — finish in .env)}
    https:       $tls_line
    listen:      $HOST:$PORT
    role:        $ROLE
    map geo:     $GEOLOCATE
    install dir: $INSTALL_DIR
EOF
  ask_yesno "Proceed with these settings?" "y" || die "aborted by user."
}

node_major() {
  node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo 0
}

# npm is checked too: Debian's and Ubuntu's own `nodejs` packages don't
# include it.
node_ok() {
  command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 || return 1
  [ "$(node_major)" -ge "$NODE_MIN_MAJOR" ]
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
    die "no supported package manager found (apt-get / dnf / yum). Install Node $NODE_MIN_MAJOR+ with npm manually and re-run."
  fi
  hash -r
}

clone_or_pull() {
  if [ -d "$INSTALL_DIR/.git" ]; then
    log "upgrading existing install at $INSTALL_DIR (git pull)"
    # npm install rewrites the tracked lockfiles (version field, newer npm's
    # format). They're the repo's, not local config — drop those edits, or a
    # lockfile change upstream makes the fast-forward below refuse.
    local lock
    for lock in package-lock.json client/package-lock.json; do
      git -C "$INSTALL_DIR" checkout --quiet -- "$lock" 2>/dev/null || true
    done
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
    # Smoke test, nginx and the banner go by the existing install's settings.
    PORT="$(env_value PORT)"; PORT="${PORT:-8088}"
    HOST="$(env_value HOST)"; HOST="${HOST:-127.0.0.1}"
    ROLE="$(env_value OTHONI_ROLE)"; ROLE="${ROLE:-full}"
    [ -n "$PUBLIC_URL" ] || PUBLIC_URL="$(env_value OTHONI_PUBLIC_URL)"
    return 0
  fi

  local jwt
  jwt="$(node -e 'console.log(require("crypto").randomBytes(48).toString("hex"))')"
  normalize_public_url

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
  local node_bin
  if [ ! -f "$unit_src" ]; then
    die "$unit_src not found in repo — install aborted."
  fi
  node_bin="$(command -v node)"
  case "$node_bin" in
    /root/*|/home/*)
      warn "node is $node_bin — the unit's ProtectHome=true hides home directories,"
      warn "so the service won't start. Install Node system-wide (e.g. NodeSource) and re-run." ;;
  esac
  # Substitute the install dir and the node binary into the example unit,
  # which assumes /var/www/othoni and /usr/bin/node.
  sed -e "s|/var/www/othoni|$INSTALL_DIR|g" \
      -e "s|^ExecStart=/usr/bin/node |ExecStart=$node_bin |" \
      "$unit_src" > "$unit_dst"
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

# ---- optional: nginx + Let's Encrypt ----
tls_skip() {
  TLS_PENDING="$1"
  warn "HTTPS setup skipped: $1"
}

# True when an nginx config file's server_name lists <host>.
nginx_conf_serves() { # nginx_conf_serves <file> <host>
  awk -v h="$2" '
    /^[[:space:]]*#/ { next }
    /server_name/ { sub(/.*server_name/, ""); sub(/;.*/, "")
                    n = split($0, a, /[[:space:]]+/)
                    for (i = 1; i <= n; i++) if (a[i] == h) found = 1 }
    END { exit !found }' "$1"
}

# First nginx config file (other than <except>) whose server_name lists <host>.
nginx_site_for() { # nginx_site_for <host> <except>
  local f
  for f in $(grep -rlsE '^[^#]*server_name' /etc/nginx); do
    [ "$f" = "$2" ] && continue
    if nginx_conf_serves "$f" "$1"; then
      printf '%s\n' "$f"
      return 0
    fi
  done
  return 1
}

# Puts nginx in front of othoni and gets a Let's Encrypt certificate for
# OTHONI_PUBLIC_URL's hostname. Every failure is a warning, not an abort:
# othoni itself is installed and running by now, and the banner says what's
# left to do by hand.
setup_tls() {
  [ "$SETUP_TLS" = 1 ] || return 0
  [ -n "$PUBLIC_URL" ] || PUBLIC_URL="$(env_value OTHONI_PUBLIC_URL)"
  [ -n "$ADMIN_EMAILS" ] || ADMIN_EMAILS="$(env_value OTHONI_ADMIN_EMAILS)"
  normalize_public_url
  local host conf link="" other upstream email wrote="" pkgs=()
  if ! host="$(tls_host)"; then
    tls_skip "OTHONI_PUBLIC_URL (${PUBLIC_URL:-unset}) has to be https://<hostname> on the default port"
    return 0
  fi
  TLS_HOST="$host"
  if [ "$PORT" = 80 ] || [ "$PORT" = 443 ]; then
    tls_skip "othoni itself is on port $PORT, which nginx needs — pick another PORT in .env"
    return 0
  fi
  if ! getent ahosts "$host" >/dev/null 2>&1; then
    tls_skip "$host doesn't resolve yet — add a DNS A/AAAA record pointing at this server, then re-run: sudo OTHONI_SETUP_TLS=1 bash $INSTALL_DIR/install.sh"
    return 0
  fi
  if ! command -v nginx >/dev/null 2>&1 && command -v ss >/dev/null 2>&1 \
     && ss -Hltn 'sport = :80' 2>/dev/null | grep -q .; then
    tls_skip "something other than nginx already listens on port 80 (Apache? Caddy?) — proxy $host to 127.0.0.1:$PORT through it by hand"
    return 0
  fi

  command -v nginx >/dev/null 2>&1 || pkgs+=(nginx)
  if ! command -v certbot >/dev/null 2>&1; then
    pkgs+=(certbot python3-certbot-nginx)
  elif ! certbot plugins 2>/dev/null | grep -qw nginx; then
    pkgs+=(python3-certbot-nginx)
  fi
  if [ ${#pkgs[@]} -gt 0 ]; then
    log "installing ${pkgs[*]}"
    # RHEL-family distros only carry certbot in EPEL.
    if ! pkg_install "${pkgs[@]}" \
       && ! { command -v dnf >/dev/null 2>&1 && dnf install -y -q epel-release && pkg_install "${pkgs[@]}"; }; then
      tls_skip "couldn't install ${pkgs[*]} from the package manager"
      return 0
    fi
  fi

  if [ -d /etc/nginx/sites-available ]; then
    conf=/etc/nginx/sites-available/othoni
    link=/etc/nginx/sites-enabled/othoni
  else
    conf=/etc/nginx/conf.d/othoni.conf
  fi
  if other="$(nginx_site_for "$host" "$conf")"; then
    tls_skip "nginx already has a site for $host ($other) — leaving nginx alone; proxy it to 127.0.0.1:$PORT there"
    return 0
  fi
  if [ -f "$conf" ] && ! nginx_conf_serves "$conf" "$host"; then
    tls_skip "$conf is already there for a different hostname — update its server_name (or remove it) and re-run"
    return 0
  fi
  if ! nginx -t >/dev/null 2>&1; then
    tls_skip "nginx's existing config doesn't pass 'nginx -t' — fix that first"
    return 0
  fi
  if [ ! -f "$conf" ]; then
    upstream="$HOST"
    case "$upstream" in ""|0.0.0.0|::|"[::]") upstream=127.0.0.1 ;; esac
    sed -e "s/othoni\.example\.com/$host/g" \
        -e "s|http://127\.0\.0\.1:8088|http://$upstream:$PORT|" \
        "$INSTALL_DIR/nginx-othoni.conf.example" > "$conf"
    if [ -n "$link" ]; then ln -sf "$conf" "$link"; fi
    wrote=1
    log "nginx site written to $conf"
  fi
  if ! nginx -t >/dev/null 2>&1; then
    if [ -n "$wrote" ]; then rm -f "$conf"; if [ -n "$link" ]; then rm -f "$link"; fi; fi
    tls_skip "nginx rejected the othoni site (see: sudo nginx -t); removed it again"
    return 0
  fi
  if systemctl is-active --quiet nginx; then
    systemctl reload nginx
  else
    systemctl enable --now nginx
  fi

  # SELinux (RHEL family) stops nginx from connecting to othoni by default.
  if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce)" = Enforcing ]; then
    setsebool -P httpd_can_network_connect 1 || warn "couldn't set httpd_can_network_connect — nginx may answer 502"
  fi
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
    log "opening ports 80 and 443 in ufw"
    ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null || warn "couldn't open ports 80/443 in ufw"
  elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    log "opening http + https in firewalld"
    { firewall-cmd --permanent --add-service=http --add-service=https >/dev/null \
        && firewall-cmd --reload >/dev/null; } || warn "couldn't open http/https in firewalld"
  fi

  if grep -q 'ssl_certificate' "$conf"; then
    log "$conf already serves https — leaving certbot alone"
  else
    email="${TLS_EMAIL:-${ADMIN_EMAILS%%,*}}"
    email="${email// /}"
    local account=(--register-unsafely-without-email)
    if [ -n "$email" ]; then account=(-m "$email"); fi
    log "requesting a Let's Encrypt certificate for $host"
    # certbot edits $conf: adds the 443 listener, the certificate and an
    # http → https redirect, and its package sets up automatic renewal.
    if ! certbot --nginx -d "$host" --non-interactive --agree-tos "${account[@]}" \
         --keep-until-expiring --redirect; then
      tls_skip "Let's Encrypt couldn't issue a certificate for $host (certbot's reason is above — usually DNS not pointing here yet, or port 80 blocked by a cloud firewall). Fix that, then run: sudo certbot --nginx -d $host --redirect"
      return 0
    fi
  fi
  TLS_READY=1
}

# True when some nginx site already proxies to othoni's port.
nginx_fronts_othoni() {
  grep -rqsE "^[^#]*proxy_pass[[:space:]]+https?://[^;/]*:$PORT([;/]|$)" /etc/nginx
}

print_banner() {
  local version url fronted=""
  version="$(node -p "require('$INSTALL_DIR/package.json').version" 2>/dev/null || echo unknown)"
  nginx_fronts_othoni && fronted=1
  url="http://$HOST:$PORT/"
  if [ -n "${TLS_READY:-}" ]; then
    url="https://$TLS_HOST/"
  elif [ -n "$fronted" ] && [ -n "$PUBLIC_URL" ]; then
    url="$PUBLIC_URL/"
  fi
  cat <<EOF

────────────────────────────────────────────────────────────
  othoni v$version is installed and running.
────────────────────────────────────────────────────────────

  dashboard: $url
  config:    $INSTALL_DIR/.env  (mode 600)
  data:      $INSTALL_DIR/data/othoni.db
  service:   sudo systemctl status $SERVICE_NAME
             sudo journalctl -u $SERVICE_NAME -f

  to upgrade later, just re-run this script:
     sudo bash $INSTALL_DIR/install.sh
EOF

  if [ -n "${TLS_PENDING:-}" ]; then
    cat <<EOF

  ⚠  HTTPS isn't set up yet: $TLS_PENDING
EOF
  elif [ -z "${TLS_READY:-}" ] && [ -z "$fronted" ] && [ "$ROLE" != peer ]; then
    cat <<EOF

  https:     othoni only listens on $HOST:$PORT. To put nginx + a
             Let's Encrypt certificate in front of it:
                sudo OTHONI_SETUP_TLS=1 bash $INSTALL_DIR/install.sh
             (or by hand: nginx-othoni.conf.example in the repo)
EOF
  fi

  if [ -n "${GOOGLE_READY:-}" ]; then
    cat <<EOF

  sign in:   $PUBLIC_URL/  with Google ($ADMIN_EMAILS)
             redirect URI on the OAuth client must be:
             $PUBLIC_URL/api/auth/google/callback

EOF
  elif [ -n "${GOOGLE_PENDING:-}" ]; then
    cat <<EOF

  ⚠  Google sign-in isn't set up yet, so nobody can log in.
     1. Google Cloud Console → Google Auth Platform: set up the
        consent screen, then add your Google account under
        Audience → Test users (or publish the app).
     2. Clients → Create client → "Web application", with the
        Authorized redirect URI  <your https URL>/api/auth/google/callback
     3. Set OTHONI_PUBLIC_URL, OTHONI_GOOGLE_CLIENT_ID,
        OTHONI_GOOGLE_CLIENT_SECRET and OTHONI_ADMIN_EMAILS in
        $INSTALL_DIR/.env
     4. sudo systemctl restart $SERVICE_NAME

EOF
  else
    echo
  fi
}

# ---- main ----
require_root
guided_config

ensure_tools
if ! node_ok; then
  install_node
  node_ok || die "still no usable Node: othoni needs Node $NODE_MIN_MAJOR+ with npm, but node is $(command -v node || echo missing) ($(node -v 2>/dev/null || echo -)) and npm is $(command -v npm || echo missing). An older Node earlier in PATH can shadow the one just installed — remove it and re-run."
fi

clone_or_pull
build
generate_env_if_missing
install_systemd
restart_if_running
smoke_test || true
setup_tls
print_banner
