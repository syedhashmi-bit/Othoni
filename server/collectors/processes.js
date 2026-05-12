'use strict';

const { run } = require('./exec');

// `ps` flags chosen for portability on Linux. Sort by --sort applied client-side.
const PS_ARGS = [
  '-eo',
  'pid,user:32,pcpu,pmem,comm,args',
  '--no-headers',
];

// Tree view variant: same fields plus ppid for parent links. Separate
// args set so the flat-list endpoint doesn't pay for the extra column.
const PS_TREE_ARGS = [
  '-eo',
  'pid,ppid,user:32,pcpu,pmem,comm,args',
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

// v0.46 process tree. Pulls every process with its ppid and builds a
// parent/child graph. Each node also carries `aggCpu` / `aggMemory` —
// the sum of its subtree (self + all descendants) — so the UI can
// highlight heavy subtrees without recomputing client-side.
//
// Returns: { total, roots: [{ node, children: [...] }, ...] } where
// `roots` is the list of processes whose parents either don't exist
// in the table or have ppid 0 (kernel threads + init descendants top
// out at PID 1 / 2). Cycles can't occur in a valid ps snapshot but
// the build is defensive against pid==ppid (would otherwise infinite
// loop). We skip a process whose parent self-references.
async function getProcessTree() {
  const result = await run('ps', PS_TREE_ARGS, { timeout: 4000 });
  if (!result.ok) {
    return { error: 'ps_failed', message: result.stderr, roots: [], total: 0 };
  }

  const lines = result.stdout.split('\n').filter(Boolean);
  // First pass: parse rows into a pid → node map.
  const byPid = new Map();
  for (const line of lines) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    if (pid === ppid) continue; // defensive
    byPid.set(pid, {
      pid,
      ppid,
      user: m[3],
      cpu: parseFloat(m[4]),
      memory: parseFloat(m[5]),
      name: m[6],
      command: m[7],
      children: [],
    });
  }

  // Second pass: link children to their parents. A process whose ppid
  // is missing (or 0) becomes a root.
  const roots = [];
  for (const node of byPid.values()) {
    const parent = byPid.get(node.ppid);
    if (parent && parent !== node) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Third pass: bottom-up aggregation. Recursive but the tree is
  // shallow (typical depth < 10) so no stack risk.
  function aggregate(node) {
    let cpu = node.cpu;
    let mem = node.memory;
    for (const c of node.children) {
      aggregate(c);
      cpu += c.aggCpu;
      mem += c.aggMemory;
    }
    node.aggCpu = +cpu.toFixed(2);
    node.aggMemory = +mem.toFixed(2);
  }
  for (const r of roots) aggregate(r);

  // Stable sort: each node's children by descending aggCpu so the
  // heaviest branches surface first in the UI.
  function sortChildren(node) {
    node.children.sort((a, b) => b.aggCpu - a.aggCpu);
    for (const c of node.children) sortChildren(c);
  }
  for (const r of roots) sortChildren(r);
  roots.sort((a, b) => b.aggCpu - a.aggCpu);

  return { total: byPid.size, roots };
}

module.exports = { getProcesses, getProcessTree };
