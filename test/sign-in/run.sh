#!/usr/bin/env bash
# End-to-end test of sign-in: Google (against a fake Google), first-run
# setup, and email + password accounts.
#
#   npm run test:auth        (or: bash test/sign-in/run.sh)
#
# Boots a throwaway copy of the server (temp dir, own SQLite file, no .env)
# in production mode with fake-google.js preloaded, so the real
# verification paths run: PKCE, state, nonce, RS256 signature, audience,
# issuer, allowlist roles, rate limit; setup code, password login, account
# roles, lockout, cookie flags. Restarts it between phases to check that
# config changes bite mid-session, then checks the production startup
# refusals. Safe to run on the live box — it never reads the real .env or
# data/.
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$REPO/test/sign-in"
PORT="${PORT:-18099}"
TMP="$(mktemp -d)"
trap 'kill "$(cat "$TMP/pid" 2>/dev/null)" 2>/dev/null; rm -rf "$TMP"' EXIT

# Isolated copy: index.js loads ../.env relative to itself, so staging
# keeps the real .env (and its real Google client) out of the test.
cp -r "$REPO/server" "$REPO/scripts" "$REPO/package.json" "$TMP/" && ln -s "$REPO/node_modules" "$TMP/node_modules"
mkdir -p "$TMP/data"

export NODE_ENV=production PORT HOST=127.0.0.1 OTHONI_ROLE=peer OTHONI_GEOLOCATE=off
export OTHONI_JWT_SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
export OTHONI_PUBLIC_URL=https://othoni.test/
export OTHONI_GOOGLE_CLIENT_ID=test-client.apps.googleusercontent.com OTHONI_GOOGLE_CLIENT_SECRET=test-secret
export OTHONI_DB="$TMP/data/othoni.db" SESSIONS_OUT="$TMP/sessions.json"
export CODE_FILE="$TMP/data/setup-code" ACCOUNTS_FILE="$TMP/data/accounts.json"
export RESET_SCRIPT="$TMP/scripts/reset-password.js"

boot() {
  (cd "$TMP" && exec node -r "$HERE/fake-google.js" server/index.js >>"$TMP/server.log" 2>&1) &
  echo $! > "$TMP/pid"
  for _ in $(seq 1 40); do curl -fs "http://$HOST:$PORT/api/health" >/dev/null && return 0; sleep 0.25; done
  echo "server did not come up:"; tail -20 "$TMP/server.log"; return 1
}
stop() {
  kill "$(cat "$TMP/pid")" 2>/dev/null
  while curl -fs "http://$HOST:$PORT/api/health" >/dev/null 2>&1; do sleep 0.2; done
}

fail=0
echo "== Google sign-in flow"
OTHONI_ADMIN_EMAILS="Admin@Example.com" OTHONI_VIEWER_EMAILS="viewer@example.com, admin@example.com" boot \
  && node "$HERE/flow-test.js" "http://127.0.0.1:$PORT" main || fail=1
stop

echo "== Google, after restart (viewer removed, admin demoted)"
OTHONI_ADMIN_EMAILS="" OTHONI_VIEWER_EMAILS="admin@example.com" boot \
  && node "$HERE/flow-test.js" "http://127.0.0.1:$PORT" after || fail=1
stop

echo "== first-run setup + password accounts (Google also on)"
SESSIONS_OUT="$TMP/local-sessions.json" OTHONI_ADMIN_EMAILS="Admin@Example.com" boot \
  && SESSIONS_OUT="$TMP/local-sessions.json" node "$HERE/local-test.js" "http://127.0.0.1:$PORT" local || fail=1
stop

echo "== after restart with OTHONI_PASSWORD_LOGIN=off"
OTHONI_PASSWORD_LOGIN=off OTHONI_ADMIN_EMAILS="Admin@Example.com" boot \
  && SESSIONS_OUT="$TMP/local-sessions.json" node "$HERE/local-test.js" "http://127.0.0.1:$PORT" local-off || fail=1
stop

# The no-domain install: no public URL, no Google, no JWT secret in the
# environment — fresh data files of its own.
P="$TMP/plain"; mkdir -p "$P"
plain_env=(env -u OTHONI_PUBLIC_URL -u OTHONI_GOOGLE_CLIENT_ID -u OTHONI_GOOGLE_CLIENT_SECRET -u OTHONI_JWT_SECRET
  OTHONI_DB="$P/othoni.db" OTHONI_ACCOUNTS_PATH="$P/accounts.json" OTHONI_SETUP_CODE_PATH="$P/setup-code"
  OTHONI_SECRET_PATH="$P/session-secret" CODE_FILE="$P/setup-code")
echo "== no-domain install (plain http, no Google, generated secret)"
: > "$TMP/server.log"
"${plain_env[@]}" bash -c "$(declare -f boot); TMP='$TMP' HERE='$HERE' boot" \
  && "${plain_env[@]}" node "$HERE/local-test.js" "http://127.0.0.1:$PORT" plain || fail=1
if grep -q "create the first admin at http://127.0.0.1:$PORT/setup?code=" "$TMP/server.log"; then
  echo "PASS  startup log shows the setup link"
else
  echo "FAIL  startup log shows the setup link"; fail=1
fi
if [ "$(stat -c %a "$P/session-secret" 2>/dev/null)" = 600 ] && [ "$(wc -c < "$P/session-secret")" -ge 64 ]; then
  echo "PASS  session secret generated in data/, 0600"
else
  echo "FAIL  session secret generated in data/, 0600"; fail=1
fi
stop

# Same install bound to a private, non-loopback address, so the test
# client reaches it directly rather than through a local proxy.
DIRECT_IP="$(ip -4 -o addr show 2>/dev/null | awk '{split($4, a, "/"); print a[1]}' \
  | grep -E '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' | head -n 1)"
if [ -n "$DIRECT_IP" ]; then
  echo "== direct client on $DIRECT_IP (X-Forwarded-For not trusted)"
  HOST="$DIRECT_IP" "${plain_env[@]}" bash -c "$(declare -f boot); TMP='$TMP' HERE='$HERE' boot" \
    && "${plain_env[@]}" node "$HERE/local-test.js" "http://$DIRECT_IP:$PORT" direct || fail=1
  HOST="$DIRECT_IP" stop
else
  echo "SKIP  direct-client check (no private non-loopback address to bind)"
fi

echo "== production startup checks"
refuses() { # refuses <label> <env assignments...> — server must exit with "Refusing to start"
  local label="$1"; shift
  if (cd "$TMP" && env "$@" timeout 5 node server/index.js 2>&1 | grep -q "Refusing to start"); then
    echo "PASS  refuses: $label"
  else
    echo "FAIL  should refuse: $label"; fail=1
  fi
}
refuses "half-filled Google config" OTHONI_ADMIN_EMAILS= OTHONI_GOOGLE_CLIENT_SECRET=
refuses "non-https OTHONI_PUBLIC_URL with Google" OTHONI_ADMIN_EMAILS=a@b.c OTHONI_PUBLIC_URL=http://insecure.test
refuses "default JWT secret" OTHONI_ADMIN_EMAILS=a@b.c OTHONI_JWT_SECRET=change-me-please-use-a-long-random-string
refuses "short JWT secret" OTHONI_ADMIN_EMAILS=a@b.c OTHONI_JWT_SECRET=tooshort
E="$TMP/empty"; mkdir -p "$E"
if (cd "$TMP" && env -u OTHONI_GOOGLE_CLIENT_ID -u OTHONI_GOOGLE_CLIENT_SECRET -u OTHONI_PUBLIC_URL \
      OTHONI_ACCOUNTS_PATH="$E/accounts.json" OTHONI_SETUP_CODE_PATH="$E/setup-code" \
      timeout 3 node server/index.js 2>&1 | grep -q "No accounts yet — create the first admin"); then
  echo "PASS  boots with no Google config and logs the setup link"
else
  echo "FAIL  no-Google boot"; fail=1
fi
if (cd "$TMP" && env -u OTHONI_GOOGLE_CLIENT_ID -u OTHONI_GOOGLE_CLIENT_SECRET -u OTHONI_PUBLIC_URL \
      OTHONI_PASSWORD_LOGIN=off timeout 3 node server/index.js 2>&1 | grep -q "nobody can log in"); then
  echo "PASS  password off + no Google warns that nobody can log in"
else
  echo "FAIL  password off + no Google warning"; fail=1
fi

echo
[ "$fail" = 0 ] && echo "sign-in: all passed" || echo "sign-in: FAILED"
exit "$fail"
