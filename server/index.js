'use strict';

const path = require('path');
const fs = require('fs');

// Load .env from project root if present
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');

const { auth, requireAdmin, login, logout, me, totpEnabled, assertProductionSecrets } = require('./auth');
const csrf = require('./csrf');
const loginLockout = require('./login-lockout');
const { loginLimiter } = require('./middleware');
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
const logger = require('./logger');

// Refuse to boot in production on placeholder JWT secret / admin password.
// Must run before anything binds a port so a misconfigured deploy fails
// loudly instead of serving a forgeable session.
assertProductionSecrets();

const PORT = parseInt(process.env.PORT || '8088', 10);
// Default to loopback so a deploy that forgets to set HOST isn't reachable
// directly (which would let clients spoof X-Forwarded-For past the per-IP
// login lockout / rate limiter). Production sits behind nginx on 127.0.0.1;
// set HOST=0.0.0.0 explicitly only if you intend to expose the port.
const HOST = process.env.HOST || '127.0.0.1';
const VERSION = require('../package.json').version;

const app = express();

app.disable('x-powered-by');
// We expect to sit behind exactly one reverse proxy (nginx on the same host)
// in production. Without this, express-rate-limit warns about untrusted
// X-Forwarded-For and the IP-based limiter falls back to the proxy's IP for
// every client. `1` = trust one hop only, which is the safe minimum.
app.set('trust proxy', 1);
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
  const lockout = loginLockout.snapshot();
  res.json({
    ok: true,
    version: VERSION,
    time: new Date().toISOString(),
    auth: {
      totp: totpEnabled(),
      csrf: csrf.isEnabled(),
      lockout: {
        enabled: lockout.enabled,
        lockedNow: lockout.lockedNow,
        // Surfaces auth-surface degradation for a future status-page integration.
        degraded: lockout.lockedNow > 0,
      },
    },
  });
});

app.post('/api/auth/login', loginLimiter, login);
app.post('/api/auth/logout', logout);
app.get('/api/auth/me', auth, me);

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
