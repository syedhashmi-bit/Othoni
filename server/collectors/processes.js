'use strict';

const { run } = require('./exec');

// `ps` flags chosen for portability on Linux. Sort by --sort applied client-side.
const PS_ARGS = [
  '-eo',
  'pid,user:32,pcpu,pmem,comm,args',
  '--no-headers',
];

async function getProcesses({ limit = 20, sortBy = 'cpu' } = {}) {
  const result = await run('ps', PS_ARGS, { timeout: 4000 });
  if (!result.ok) {
    return { error: 'ps_failed', message: result.stderr, processes: [] };
  }
  const lines = result.stdout.split('\n').filter(Boolean);
  const procs = [];
  for (const line of lines) {
    // Split into 6 fields: pid, user, %cpu, %mem, comm, command (rest)
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    procs.push({
      pid: Number(m[1]),
      user: m[2],
      cpu: parseFloat(m[3]),
      memory: parseFloat(m[4]),
      name: m[5],
      command: m[6],
    });
  }
  procs.sort((a, b) =>
    sortBy === 'memory' ? b.memory - a.memory : b.cpu - a.cpu
  );
  return {
    total: procs.length,
    sortBy,
    processes: procs.slice(0, limit),
  };
}

module.exports = { getProcesses };
