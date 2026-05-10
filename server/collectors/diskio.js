'use strict';

const fs = require('fs').promises;

// /proc/diskstats column layout (Linux kernel):
// 1 major, 2 minor, 3 device, 4 reads_completed, 5 reads_merged,
// 6 sectors_read, 7 ms_reading, 8 writes_completed, 9 writes_merged,
// 10 sectors_written, 11 ms_writing, 12 ios_in_progress, 13 ms_doing_io,
// 14 weighted_ms_doing_io
//
// One sector is always 512 bytes regardless of physical sector size — this is
// kernel ABI, not the disk's reported sector size.
const SECTOR_BYTES = 512;

const previous = new Map(); // device -> { rs, ws, t }

// Real block devices are things like sda, nvme0n1, vda. Skip the partitions
// (sda1, nvme0n1p1) and pseudo devices (loop, ram, dm-, sr).
function isPhysicalDevice(name) {
  if (/^(loop|ram|sr|dm-|md|fd)/.test(name)) return false;
  // partitions: sd[a-z]+\d+, vd[a-z]+\d+, nvme\d+n\d+p\d+, mmcblk\d+p\d+
  if (/^(sd[a-z]+|vd[a-z]+|hd[a-z]+|xvd[a-z]+)\d+$/.test(name)) return false;
  if (/^nvme\d+n\d+p\d+$/.test(name)) return false;
  if (/^mmcblk\d+p\d+$/.test(name)) return false;
  return true;
}

function parseDiskstats(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const cols = line.split(/\s+/);
    if (cols.length < 14) continue;
    const name = cols[2];
    if (!isPhysicalDevice(name)) continue;
    out.push({
      name,
      sectorsRead: Number(cols[5]),
      sectorsWritten: Number(cols[9]),
    });
  }
  return out;
}

async function getDiskIO() {
  const text = await fs.readFile('/proc/diskstats', 'utf8');
  const stats = parseDiskstats(text);
  const now = Date.now();
  const devices = [];
  let totalRead = 0;
  let totalWrite = 0;
  for (const s of stats) {
    const rs = s.sectorsRead * SECTOR_BYTES;
    const ws = s.sectorsWritten * SECTOR_BYTES;
    const prev = previous.get(s.name);
    let readBps = 0;
    let writeBps = 0;
    if (prev) {
      const dt = (now - prev.t) / 1000;
      if (dt > 0) {
        readBps = Math.max(0, (rs - prev.rs) / dt);
        writeBps = Math.max(0, (ws - prev.ws) / dt);
      }
    }
    previous.set(s.name, { rs, ws, t: now });
    devices.push({
      name: s.name,
      readBytes: rs,
      writeBytes: ws,
      readBytesPerSec: Math.round(readBps),
      writeBytesPerSec: Math.round(writeBps),
    });
    totalRead += readBps;
    totalWrite += writeBps;
  }
  return {
    devices,
    totalReadBytesPerSec: Math.round(totalRead),
    totalWriteBytesPerSec: Math.round(totalWrite),
  };
}

// Warm the previous-counter map so the first request returns real numbers.
getDiskIO().catch(() => {});

module.exports = { getDiskIO };
