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

async function getServices(list = DEFAULT_SERVICES) {
  // Run them sequentially-ish via Promise.all but with a concurrency cap.
  const results = await Promise.all(list.map(checkOne));
  return { services: results };
}

module.exports = { getServices, DEFAULT_SERVICES };
