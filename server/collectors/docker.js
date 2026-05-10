'use strict';

const { run } = require('./exec');

let dockerAvailable = null; // cache the "is docker installed" result

async function checkDocker() {
  if (dockerAvailable !== null) return dockerAvailable;
  const r = await run('docker', ['--version'], { timeout: 1500 });
  dockerAvailable = r.ok;
  return dockerAvailable;
}

async function getDocker() {
  const installed = await checkDocker();
  if (!installed) {
    return {
      installed: false,
      message: 'Docker was not detected on this server.',
      containers: [],
    };
  }

  // `docker ps -a` so we surface stopped containers too.
  // Format as JSON-per-line for safe parsing.
  const r = await run(
    'docker',
    ['ps', '-a', '--format', '{{json .}}'],
    { timeout: 4000 }
  );
  if (!r.ok) {
    // Most likely cause: socket permission denied for the user running othoni.
    return {
      installed: true,
      accessible: false,
      message:
        'Docker is installed but the dashboard cannot talk to the daemon (permission denied?).',
      containers: [],
    };
  }
  const containers = r.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        const j = JSON.parse(line);
        return {
          id: j.ID,
          name: j.Names,
          image: j.Image,
          status: j.Status,
          state: j.State,
          ports: j.Ports || '',
          created: j.CreatedAt,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return { installed: true, accessible: true, containers };
}

module.exports = { getDocker };
