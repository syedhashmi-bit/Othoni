'use strict';

const { execFile } = require('child_process');

function run(cmd, args, { timeout = 4000, env } = {}) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout, maxBuffer: 4 * 1024 * 1024, env: env ? { ...process.env, ...env } : process.env },
      (err, stdout, stderr) => {
        if (err) {
          resolve({
            ok: false,
            code: err.code ?? null,
            stdout: stdout || '',
            stderr: (stderr || err.message || '').toString().trim(),
          });
        } else {
          resolve({ ok: true, code: 0, stdout, stderr });
        }
      }
    );
  });
}

module.exports = { run };
