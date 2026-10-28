#!/usr/bin/env bash
# End-to-end test of Google sign-in against a fake Google.
#
#   npm run test:auth        (or: bash test/google-signin/run.sh)
#
# Boots a throwaway copy of the server (temp dir, own SQLite file, no .env)
# in production mode with fake-google.js preloaded, so the real
# verification path runs: PKCE, state, nonce, RS256 signature, audience,
# issuer, allowlist roles, rate limit. Then restarts it with a changed
# allowlist to check that removal/demotion bites mid-session, and checks
# the production startup refusals. Safe to run on the live box — it never
# reads the real .env or data/.
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$REPO/test/google-signin"
PORT="${PORT:-18099}"
TMP="$(mktemp -d)"
trap 'kill "$(cat "$TMP/pid" 2>/dev/null)" 2>/dev/null; rm -rf "$TMP"' EXIT

# Isolated copy: index.js loads ../.env relative to itself, so staging
# keeps the real .env (and its real Google client) out of the test.
cp -r "$REPO/server" "$REPO/package.json" "$TMP/" && ln -s "$REPO/node_modules" "$TMP/node_modules"
mkdir -p "$TMP/data"

export NODE_ENV=production PORT HOST=127.0.0.1 OTHONI_ROLE=peer OTHONI_GEOLOCATE=off
export OTHONI_JWT_SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
export OTHONI_PUBLIC_URL=https://othoni.test/
export OTHONI_GOOGLE_CLIENT_ID=test-client.apps.googleusercontent.com OTHONI_GOOGLE_CLIENT_SECRET=test-secret
export OTHONI_DB="$TMP/data/othoni.db" SESSIONS_OUT="$TMP/sessions.json"

boot() {
  (cd "$TMP" && exec node -r "$HERE/fake-google.js" server/index.js >>"$TMP/server.log" 2>&1) &
  echo $! > "$TMP/pid"
  for _ in $(seq 1 40); do curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null && return 0; sleep 0.25; done
  echo "server did not come up:"; tail -20 "$TMP/server.log"; return 1
}
stop() {
  kill "$(cat "$TMP/pid")" 2>/dev/null
  while curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; do sleep 0.2; done
}

fail=0
echo "== sign-in flow"
OTHONI_ADMIN_EMAILS="Admin@Example.com" OTHONI_VIEWER_EMAILS="viewer@example.com, admin@example.com" boot \
  && node "$HERE/flow-test.js" "http://127.0.0.1:$PORT" main || fail=1
stop

echo "== after restart (viewer removed, admin demoted)"
OTHONI_ADMIN_EMAILS="" OTHONI_VIEWER_EMAILS="admin@example.com" boot \
  && node "$HERE/flow-test.js" "http://127.0.0.1:$PORT" after || fail=1
stop

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
refuses "non-https OTHONI_PUBLIC_URL" OTHONI_ADMIN_EMAILS=a@b.c OTHONI_PUBLIC_URL=http://insecure.test
refuses "default JWT secret" OTHONI_ADMIN_EMAILS=a@b.c OTHONI_JWT_SECRET=change-me-please-use-a-long-random-string
if (cd "$TMP" && env -u OTHONI_GOOGLE_CLIENT_ID -u OTHONI_GOOGLE_CLIENT_SECRET -u OTHONI_PUBLIC_URL \
      timeout 3 node server/index.js 2>&1 | grep -q "Google sign-in is not configured"); then
  echo "PASS  boots with no Google config (peer) and warns"
else
  echo "FAIL  no-Google boot"; fail=1
fi

echo
[ "$fail" = 0 ] && echo "google sign-in: all passed" || echo "google sign-in: FAILED"
exit "$fail"
