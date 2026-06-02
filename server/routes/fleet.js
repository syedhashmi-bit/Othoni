'use strict';

// Read-only reverse proxy to a federated peer othoni instance.
//
//   GET /api/fleet/:host/api/<whatever>?<query>
//        → GET <peer.url>/api/<whatever>?<query>  (Bearer <peer.token>)
//
// Mounted inside the cookie-auth wall (see routes/index.js), so only an
// authenticated dashboard user can reach it. The peer authenticates the
// forwarded request with its OTHONI_PEER_TOKEN and answers as a synthetic
// viewer — GET/HEAD only. We refuse anything but GET/HEAD here too, so the
// proxy can never be used to mutate a peer.

const express = require('express');
const peers = require('../peers');
const logger = require('../logger');

const router = express.Router();

const PROXY_TIMEOUT_MS = 10_000;

router.all('/:host/*', async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ error: 'method_not_allowed', message: 'fleet proxy is read-only' });
  }

  const peer = peers.getRaw(req.params.host);
  if (!peer) {
    return res.status(404).json({ error: 'unknown_peer', message: `no peer named "${req.params.host}"` });
  }

  // Only proxy API calls — never static assets, the SPA shell, or the
  // /metrics exporter. The client only ever asks for `api/...` paths.
  const sub = req.params[0] || '';
  if (!sub.startsWith('api/')) {
    return res.status(400).json({ error: 'invalid_path', message: 'only /api/* paths are proxied' });
  }

  const qIdx = req.originalUrl.indexOf('?');
  const qs = qIdx >= 0 ? req.originalUrl.slice(qIdx) : '';
  const target = `${peer.url}/${sub}${qs}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
  try {
    const upstream = await fetch(target, {
      method: 'GET',
      headers: { Authorization: `Bearer ${peer.token}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.status(upstream.status);
    const ct = upstream.headers.get('content-type');
    res.set('Content-Type', ct || 'application/json');
    res.send(buf);
  } catch (e) {
    const aborted = e.name === 'AbortError';
    logger.warn(`fleet proxy to ${req.params.host} failed: ${aborted ? 'timeout' : e.message}`);
    res.status(502).json({
      error: 'peer_unreachable',
      message: aborted
        ? `peer "${req.params.host}" did not respond in time`
        : `could not reach peer "${req.params.host}"`,
    });
  } finally {
    clearTimeout(timer);
  }
});

module.exports = router;
