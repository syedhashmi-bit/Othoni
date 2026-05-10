'use strict';

const si = require('systeminformation');

async function getDisks() {
  const fs = await si.fsSize();
  // Filter out tmpfs/devtmpfs and zero-size pseudo-filesystems for a cleaner UI
  const disks = fs
    .filter(
      (d) =>
        d.size > 0 &&
        !['tmpfs', 'devtmpfs', 'overlay', 'squashfs'].includes(d.type)
    )
    .map((d) => ({
      mount: d.mount,
      filesystem: d.type,
      device: d.fs,
      size: d.size,
      used: d.used,
      available: d.available,
      usagePercent: Math.round(d.use * 10) / 10,
    }))
    .sort((a, b) => (a.mount > b.mount ? 1 : -1));
  return { disks };
}

module.exports = { getDisks };
