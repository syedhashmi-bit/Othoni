'use strict';

const os = require('os');
const si = require('systeminformation');

async function getCpu() {
  const [load, info, temp] = await Promise.all([
    si.currentLoad(),
    si.cpu(),
    si.cpuTemperature().catch(() => ({ main: null })),
  ]);
  return {
    usage: Math.round(load.currentLoad * 10) / 10,
    user: Math.round(load.currentLoadUser * 10) / 10,
    system: Math.round(load.currentLoadSystem * 10) / 10,
    idle: Math.round(load.currentLoadIdle * 10) / 10,
    cores: load.cpus.map((c) => ({
      load: Math.round(c.load * 10) / 10,
    })),
    physicalCores: info.physicalCores,
    logicalCores: info.cores,
    model: `${info.manufacturer || ''} ${info.brand || ''}`.trim(),
    speedGHz: info.speed,
    temperatureC: temp && typeof temp.main === 'number' ? temp.main : null,
    loadAverage: os.loadavg().map((n) => Math.round(n * 100) / 100),
  };
}

module.exports = { getCpu };
