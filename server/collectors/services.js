'use strict';

const { run } = require('./exec');

const DEFAULT_SERVICES = [
  'nginx',
  'apache2',
  'docker',
  'ssh',
  'sshd',
  'postgresql',
  'mysql',
  'mariadb',
  'redis',
  'redis-server',
  'mongodb',
  'mongod',
];

async function checkOne(name) {
  // `systemctl show -p LoadState,ActiveState` is unambiguous and cheap:
  //   LoadState=loaded         → unit exists
  //   LoadState=not-found      → unit doesn't exist on this host
  //   ActiveState=active|inactive|failed|activating|deactivating
  const r = await run(
    'systemctl',
    ['show', '-p', 'LoadState', '-p', 'ActiveState', '--value', name],
    { timeout: 1500 }
  );
  if (!r.ok) {
    return { name, status: 'missing' };
  }
  // --value prints one value per line, in the order requested.
  const [loadState = '', activeState = ''] = r.stdout
    .split('\n')
    .map((s) => s.trim());
  if (loadState !== 'loaded') return { name, status: 'missing' };
  if (activeState === 'active') return { name, status: 'active' };
  if (activeState === 'failed') return { name, status: 'failed' };
  if (activeState === 'activating' || activeState === 'deactivating') {
    return { name, status: activeState };
  }
  return { name, status: 'inactive' };
}

const SERVICES_CACHE_TTL = 30_000;
let servicesCache = null;
let servicesCacheKey = '';
let servicesCacheAt = 0;

async function getServices(list = DEFAULT_SERVICES) {
  const key = list.join(',');
  const now = Date.now();
  if (servicesCache && key === servicesCacheKey && now - servicesCacheAt < SERVICES_CACHE_TTL) {
    return servicesCache;
  }
  const results = await Promise.all(list.map(checkOne));
  servicesCache = { services: results };
  servicesCacheKey = key;
  servicesCacheAt = now;
  return servicesCache;
}

module.exports = { getServices, DEFAULT_SERVICES };
