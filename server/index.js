'use strict';

const path = require('path');
const fs = require('fs');

// Load .env from project root if present
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');

const { auth, login, logout, me, totpEnabled } = require('./auth');
const { loginLimiter } = require('./middleware');
const apiRouter = require('./routes');
const metricsRouter = require('./routes/metrics');
const history = require('./history');
const logger = require('./logger');

const PORT = parseInt(process.env.PORT || '8088', 10);
const HOST = process.env.HOST || '0.0.0.0';
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
  res.json({
    ok: true,
    version: VERSION,
    time: new Date().toISOString(),
    auth: { totp: totpEnabled() },
  });
});

app.post('/api/auth/login', loginLimiter, login);
app.post('/api/auth/logout', logout);
app.get('/api/auth/me', auth, me);

// Externally-pushed metrics. Bearer-token (API key) auth, NOT cookie auth —
// must be mounted before the `app.use('/api', auth, ...)` wall below or it
// will inherit cookie auth and the headless-agent flow won't work.
app.use('/api/metrics', metricsRouter);

// Protected API routes
app.use('/api', auth, apiRouter);

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
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, () => {
    history.stop();
    process.exit(0);
  });
}
