'use strict';

// Optional IP-based auto-geolocation for the fleet map. Each othoni instance
// looks up *its own* public-IP location from a free, no-key HTTPS API and
// caches the result on disk for a week. A central instance additionally pulls
// each federation peer's self-detected location through the peer's own
// /api/settings (bearer-authed), so the map can place peers that sit on
// private WireGuard URLs (which aren't themselves geolocatable).
//
// Deliberately lightweight: no bundled GeoIP database (MBs + licensing), no
// per-IP fan-out to a third party — every box only ever looks up itself. A
// manually-set location always wins over this. Disable entirely with
// OTHONI_GEOLOCATE=off.

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const CACHE_PATH = process.env.OTHONI_GEO_CACHE_PATH || path.join(__dirname, '..', 'data', 'geo-cache.json');
const TTL_MS = 7 * 24 * 3600 * 1000; // re-look-up a known location at most weekly
const NULL_RETRY_MS = 10 * 60 * 1000; // but retry a peer with no location every 10 min
const TIMEOUT_MS = 5000;
// ip-api.com is the most reliable free no-key lookup from a server (ipwho.is
// 403s server-side requests, ipapi.co rate-limits aggressively). It's HTTP-only
// on the free tier — acceptable here since the only data is this box's own,
// non-sensitive public-IP location. Point OTHONI_GEO_PROVIDER at an HTTPS
// endpoint if you'd rather not make a plain-HTTP call. The parser accepts both
// the ip-api shape (lat/lon/countryCode/query) and the lat-itude/longitude
// shape (ipwho.is / ipapi.co), so most providers drop in without code changes.
const PROVIDER = process.env.OTHONI_GEO_PROVIDER
  || 'http://ip-api.com/json/?fields=status,message,lat,lon,city,countryCode,query';
const ENABLED = (process.env.OTHONI_GEOLOCATE || 'on').toLowerCase() !== 'off';

let selfCache = null;         // { lat, lon, place, ip, fetchedAt }
let refreshing = false;
const peerCache = new Map();  // host -> { geo: {lat,lon,place} | null, fetchedAt }

function loadDisk() {
  if (selfCache) return selfCache;
  try {
    const raw = fs.readFileSync(CACHE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.lat === 'number') selfCache = parsed;
  } catch { /* no cache yet */ }
  return selfCache;
}

function persist() {
  try {
    const tmp = `${CACHE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(selfCache, null, 2));
    fs.renameSync(tmp, CACHE_PATH);
  } catch (e) {
    logger.warn(`geoip: cache write failed: ${e.message}`);
  }
}

function placeFrom(d) {
  const city = d.city || d.region || '';
  const cc = d.countryCode || d.country_code || d.country || '';
  return [city, cc].filter(Boolean).join(', ');
}

async function fetchSelf() {
  const res = await fetch(PROVIDER, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const d = await res.json();
  if (!d || d.success === false || d.status === 'fail') {
    throw new Error(d && d.message ? d.message : 'provider returned an error');
  }
  const lat = typeof d.lat === 'number' ? d.lat : d.latitude;
  const lon = typeof d.lon === 'number' ? d.lon : d.longitude;
  if (typeof lat !== 'number' || typeof lon !== 'number') {
    throw new Error('provider returned no coordinates');
  }
  return { lat, lon, place: placeFrom(d), ip: d.query || d.ip || null, fetchedAt: Date.now() };
}

// Cached self-location (or null). Triggers a background refresh when stale so
// the caller never blocks on the network.
function getSelf() {
  if (!ENABLED) return null;
  const c = loadDisk();
  if (!c || Date.now() - (c.fetchedAt || 0) > TTL_MS) refreshSelf();
  if (!c) return null;
  return { lat: c.lat, lon: c.lon, place: c.place, ip: c.ip, source: 'auto' };
}

async function refreshSelf() {
  if (!ENABLED || refreshing) return;
  refreshing = true;
  try {
    selfCache = await fetchSelf();
    persist();
    logger.info(`geoip: self-located at ${selfCache.place || '?'} (${selfCache.lat}, ${selfCache.lon})`);
  } catch (e) {
    logger.warn(`geoip: self lookup failed: ${e.message}`);
  } finally {
    refreshing = false;
  }
}

// A peer's self-detected location, read from its own /api/settings using the
// stored peer token (the same credential the read-only fleet proxy uses).
async function fetchPeerGeo(peer) {
  const res = await fetch(`${peer.url}/api/settings`, {
    headers: { Authorization: `Bearer ${peer.token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const d = await res.json();
  return d && d.geo && typeof d.geo.lat === 'number' ? { lat: d.geo.lat, lon: d.geo.lon, place: d.geo.place || null } : null;
}

function getPeerCached(host) {
  const c = peerCache.get(host);
  return c && c.geo ? { ...c.geo, source: 'auto' } : null;
}

// Fire-and-forget peer refresh, TTL-guarded so listing peers doesn't spam the
// mesh. `peer` is the raw registry entry (must include url + token).
async function refreshPeer(peer) {
  if (!ENABLED || !peer || !peer.token) return;
  const c = peerCache.get(peer.host);
  // A located peer is good for a week; a peer we couldn't locate yet (older
  // othoni, unreachable, or geo disabled there) is retried every 10 min so it
  // shows up once it can self-report — without hammering the mesh.
  const ttl = c && c.geo ? TTL_MS : NULL_RETRY_MS;
  if (c && Date.now() - c.fetchedAt < ttl) return;
  try {
    const geo = await fetchPeerGeo(peer);
    peerCache.set(peer.host, { geo, fetchedAt: Date.now() });
  } catch {
    // Older peers (pre-geo) or unreachable ones just stay un-auto-located.
    peerCache.set(peer.host, { geo: null, fetchedAt: Date.now() });
  }
}

module.exports = { getSelf, refreshSelf, getPeerCached, refreshPeer, ENABLED };
