'use strict';

const os = require('os');
const si = require('systeminformation');
const https = require('https');
const logger = require('../logger');

let cachedPublicIp = { ip: null, fetchedAt: 0 };
const PUBLIC_IP_TTL_MS = 5 * 60 * 1000;

function fetchPublicIp() {
  return new Promise((resolve) => {
    const req = https.get(
      { host: 'api.ipify.org', path: '/', timeout: 2500 },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return resolve(null);
        }
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(data.trim() || null));
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function getPublicIp() {
  const now = Date.now();
  if (cachedPublicIp.ip && now - cachedPublicIp.fetchedAt < PUBLIC_IP_TTL_MS) {
    return cachedPublicIp.ip;
  }
  try {
    const ip = await fetchPublicIp();
    cachedPublicIp = { ip, fetchedAt: now };
    return ip;
  } catch (e) {
    logger.debug('public ip lookup failed:', e.message);
    return cachedPublicIp.ip;
  }
}

function localIps() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      if (a.internal) continue;
      out.push({ interface: name, address: a.address, family: a.family });
    }
  }
  return out;
}

async function getSystem() {
  const [osInfo, time] = await Promise.all([si.osInfo(), si.time()]);
  const publicIp = await getPublicIp();
  return {
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    distro: osInfo.distro,
    release: osInfo.release,
    codename: osInfo.codename,
    kernel: osInfo.kernel,
    nodejs: process.version,
    uptimeSeconds: Math.round(os.uptime()),
    bootTime: new Date(Date.now() - os.uptime() * 1000).toISOString(),
    timezone: time.timezone,
    publicIp,
    localIps: localIps(),
  };
}

module.exports = { getSystem };
