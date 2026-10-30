'use strict';

const path = require('path');
const fs = require('fs');

// Load .env from project root if present
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');

const {
  auth, requireAdmin, passwordLogin, setupStatus, setupComplete, changeOwnPassword,
  googleStart, googleCallback, logout, me, assertProductionSecrets, logAuthConfig,
} = require('./auth');
const csrf = require('./csrf');
const google = require('./google-auth');
const accounts = require('./accounts');
const setup = require('./setup');
const { loginLimiter, loginApiLimiter, metricsLimiter } = require('./middleware');
const apiRouter = require('./routes');
const metricsRouter = require('./routes/metrics');
const remoteAuditRouter = require('./routes/remote-audit');
const promExport = require('./prom-export');
const exportEndpoint = require('./export');
const history = require('./history');
const sessions = require('./sessions');
const vacuum = require('./vacuum');
const processHistory = require('./process-history');
const alerts = require('./alerts');
const webhooks = require('./webhooks');
const checks = require('./checks');
const securityAudit = require('./security-audit');
const geoip = require('./geoip');
const logger = require('./logger');

// Refuse to boot in production on a placeholder JWT secret or half-filled
// Google config. Must run before anything binds a port so a misconfigured
// deploy fails loudly instead of serving a forgeable session.
assertProductionSecrets();
logAuthConfig();

const PORT = parseInt(process.env.PORT || '8088', 10);
// Default to loopback: behind nginx on the same box is the usual setup.
// The installer sets HOST=0.0.0.0 for a no-domain install that's opened
// directly by IP.
const HOST = process.env.HOST || '127.0.0.1';
const VERSION = require('../package.json').version;

// Fresh install with no accounts: make sure the one-time setup code exists
// (before listen, so the installer can read it once /api/health answers)
// and log the link.
setup.logPending({ host: HOST, port: PORT });

// Which proxies may set X-Forwarded-For / -Proto. Default: only one on this
// machine (nginx in front, the installer's HTTPS setup). Trusting "one hop"
// from anywhere would let a client that reaches othoni directly — HOST=
// 0.0.0.0, the no-domain install — forge its IP past the per-IP sign-in
// limits. OTHONI_TRUST_PROXY takes any Express "trust proxy" value (a hop
// count, or IPs / subnets) for a proxy that lives elsewhere.
function trustProxySetting() {
  const v = (process.env.OTHONI_TRUST_PROXY || '').trim();
  if (!v) return 'loopback';
  if (/^\d+$/.test(v)) return parseInt(v, 10);
  if (v === 'true' || v === 'false') return v === 'true';
  return v;
}

// Role: "full" (default) runs every subsystem. "peer" is a lightweight
// federation-peer mode (set OTHONI_ROLE=peer) — the box still samples and
// serves its own metrics for a central othoni to read read-only, but skips
// the subsystems a read-only peer doesn't need: the process-trends sampler,
// the alert engine, synthetic checks, and the security-audit auto-run. That
// drops the continuous alert/check ticks and the periodic child-process
// spawns (ps / systemctl / ufw / iptables), trimming CPU + memory on a small
// VPS. On-demand endpoints still work; only the always-on loops are gated.
const ROLE = (process.env.OTHONI_ROLE || 'full').toLowerCase();
const LITE = ROLE === 'peer';

const app = express();

app.disable('x-powered-by');
// Without this, express-rate-limit and login-lockout would see nginx's IP
// for every client. See trustProxySetting() above.
app.set('trust proxy', trustProxySetting());
app.use(
  helmet({
    contentSecurityPolicy: false, // we serve our own static UI; CSP would need tuning per build
  })
);
app.use(express.json({ limit: '64kb' }));
app.use(cookieParser());

// Tiny request log
app.use((req, _res, next) => {
  if (!req.path.startsWith('/assets')) {
    logger.debug(`${req.method} ${req.path}`);
  }
  next();
});

// The HTML defines a data: URI favicon, so /favicon.ico isn't needed.
// Return 204 instead of letting the SPA catch-all serve index.html for it.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// Public endpoints
app.get('/api/health', (_req, res) => {
  const store = history.getStorage();
  res.json({
    ok: true,
    version: VERSION,
    time: new Date().toISOString(),
    auth: {
      // What the login page offers: the email + password form, the Google
      // button, or (no accounts yet) a pointer to the setup link.
      password: accounts.passwordLoginEnabled(),
      google: google.isConfigured(),
      setup: setup.needed(),
      csrf: csrf.isEnabled(),
    },
    storage: {
      // True when the data partition is nearly full and the sampler has paused
      // writing history to avoid pushing SQLite into an error state.
      degraded: store.degraded,
      freePct: store.freePct,
    },
  });
});

app.post('/api/auth/login', loginApiLimiter, passwordLogin);
app.get('/api/setup', setupStatus);
app.post('/api/setup', loginApiLimiter, setupComplete);
app.get('/api/auth/google', loginLimiter, googleStart);
app.get('/api/auth/google/callback', loginLimiter, googleCallback);
app.post('/api/auth/logout', logout);
app.get('/api/auth/me', auth, me);
// Changing your own password is open to viewers too, so it sits outside
// the requireAdmin wall below (still behind the session + CSRF check).
app.post('/api/account/password', auth, csrf.middleware, changeOwnPassword);

// Externally-pushed metrics. Bearer-token (API key) auth, NOT cookie auth —
// must be mounted before the `app.use('/api', auth, ...)` wall below or it
// will inherit cookie auth and the headless-agent flow won't work.
app.use('/api/metrics', metricsRouter);

// Remote security-audit ingestion. Same Bearer-token (API key) auth as
// /api/metrics — mounted before the cookie wall so headless agents can
// push findings. Only claims `/ingest`; the dashboard's read endpoints
// (/api/security-audit/hosts*) fall through to the cookie-walled router.
app.use('/api/security-audit', remoteAuditRouter);

// Optional Prometheus exporter at /metrics. Off unless OTHONI_PROMETHEUS_TOKEN
// is set; uses its own Bearer-token check (separate from the dashboard
// session). Mounted before the cookie-auth wall for the same reason.
app.get('/metrics', (req, res) => promExport.handleRequest(req, res));

// Optional bulk archive export (v0.49). Same Bearer-token pattern as
// the Prom exporter, separate `OTHONI_EXPORT_TOKEN`. Streams NDJSON;
// mounted before the cookie wall so backup tooling can curl with just
// a token.
app.get('/api/export', (req, res) => exportEndpoint.handleRequest(req, res));

// Optional public status page (v0.55). Token-gated via
// `OTHONI_STATUS_PAGE_TOKEN`; off by default (returns 404 when unset).
// Mounted before the cookie wall so it can be reached without a
// dashboard session — that's the whole point.
const statusPage = require('./status-page');
app.get('/status', (req, res) => statusPage.handleRequest(req, res));

// Heartbeat pings (v0.74). The 32-hex token in the path IS the credential,
// so this sits before the cookie wall; cron jobs just `curl` it. Unknown
// tokens get a 404 like the other token-gated endpoints.
app.all('/ping/:token', metricsLimiter, (req, res) => {
  if (!['GET', 'POST', 'HEAD'].includes(req.method)) return res.status(405).end();
  if (!checks.recordPing(req.params.token)) return res.status(404).type('text').send('not found\n');
  res.type('text').send('ok\n');
});

// Protected API routes. `requireAdmin` runs after `auth` so the viewer
// can still GET everything but is 403'd on PUT/POST/PATCH/DELETE. CSRF
// is gated on non-GET methods after the role check.
app.use('/api', auth, requireAdmin, csrf.middleware, apiRouter);

// Static frontend
const clientDist = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist, { index: false, maxAge: '1h' }));
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => {
    res
      .status(503)
      .type('text/plain')
      .send(
        'othoni client is not built yet.\n\nRun: npm run build\nThen restart the server.'
      );
  });
}

// Error handler — never leak stack traces to the client
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  logger.error('unhandled error:', err && err.message ? err.message : err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'internal_error' });
});

app.listen(PORT, HOST, () => {
  logger.info(`othoni v${VERSION} listening on http://${HOST}:${PORT}`);
  history.start();
  // Prime the in-memory revoked-session cache from disk so cookies revoked
  // before the last restart stay revoked.
  sessions.ensureSchema();
  sessions.loadRevokedFromDb();
  // Nightly SQLite VACUUM scheduler. Disabled when OTHONI_VACUUM_TIME
  // is unset or set to "off".
  vacuum.start();
  // Prime IP-based self-geolocation for the fleet map (cached on disk; one
  // outbound lookup of this box's own public IP). No-op if OTHONI_GEOLOCATE=off.
  if (geoip.ENABLED) {
    geoip.refreshSelf();
    // Prime each federation peer's location too, so the map can plot them on
    // first load instead of waiting for the next poll.
    const peersMod = require('./peers');
    for (const p of peersMod.listSafe()) {
      const raw = peersMod.getRaw(p.host);
      if (raw) geoip.refreshPeer(raw);
    }
  }
  if (LITE) {
    logger.info('othoni role=peer (lite): process-trends, alerts, checks, and security-audit auto-run are disabled');
  } else {
    // Process trends sampler — slower cadence (default 30s), shares the same
    // SQLite handle via history.getDb() so it must start after history.start().
    processHistory.start();
    // Wire the alert engine to fire enabled webhooks on each rule transition.
    alerts.setDispatcher((event) => webhooks.dispatch(event));
    alerts.start();
    // Synthetic checks share the same webhook dispatcher — a check that goes
    // down N times in a row dispatches an "alert.fire"-shaped event.
    checks.setDispatcher((event) => webhooks.dispatch(event));
    checks.start();
    // Security audit — auto-runs every 10 min so the diff-vs-prev row
    // builds up without operator interaction; new crit findings dispatch
    // through the same webhook pipeline as alert fires.
    securityAudit.setDispatcher((event) => webhooks.dispatch(event));
    securityAudit.startAutoRun();
  }
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, () => {
    securityAudit.stopAutoRun();
    checks.stop();
    alerts.stop();
    vacuum.stop();
    processHistory.stop();
    history.stop();
    process.exit(0);
  });
}
