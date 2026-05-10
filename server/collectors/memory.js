'use strict';

const si = require('systeminformation');

async function getMemory() {
  const m = await si.mem();
  const usedReal = m.active; // memory actually in use, not buffers/cache
  return {
    total: m.total,
    free: m.free,
    used: m.used,
    active: m.active,
    available: m.available,
    buffers: m.buffers,
    cached: m.cached,
    swapTotal: m.swaptotal,
    swapUsed: m.swapused,
    swapFree: m.swapfree,
    usagePercent:
      m.total > 0 ? Math.round((usedReal / m.total) * 1000) / 10 : 0,
    swapPercent:
      m.swaptotal > 0 ? Math.round((m.swapused / m.swaptotal) * 1000) / 10 : 0,
  };
}

module.exports = { getMemory };
