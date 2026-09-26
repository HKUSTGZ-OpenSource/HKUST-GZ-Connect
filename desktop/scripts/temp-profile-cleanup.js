'use strict';

const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

function validateTemporaryProfile(target, prefix) {
  if (typeof target !== 'string' || typeof prefix !== 'string' || !prefix) {
    throw new TypeError('temporary profile cleanup target is invalid');
  }
  const resolved = path.resolve(target);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolved).startsWith(`${prefix}-`)) {
    throw new Error('temporary profile cleanup target is outside the test boundary');
  }
  return resolved;
}

// Chromium can recreate Local State after Electron's `quit` event. A detached
// Node helper removes the validated, direct child of os.tmpdir() only after the
// owning process is confirmed absent; uncertain or timed-out ownership preserves it.
function scheduleTemporaryProfileCleanup(target, prefix, {
  nodeExecutable = process.env.npm_node_execpath || 'node',
  parentPid = process.pid,
} = {}) {
  const resolved = validateTemporaryProfile(target, prefix);
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0) {
    throw new TypeError('temporary profile cleanup parent PID is invalid');
  }
  const source = String.raw`
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const parentPid = Number(process.argv[1]);
    const target = path.resolve(process.argv[2]);
    const prefix = process.argv[3];
    if (!Number.isSafeInteger(parentPid) || parentPid <= 0 ||
        path.dirname(target) !== path.resolve(os.tmpdir()) ||
        !path.basename(target).startsWith(prefix + '-')) process.exit(2);
    let attempts = 0;
    function parentState() {
      try { process.kill(parentPid, 0); return 'alive'; }
      catch (error) { return error?.code === 'ESRCH' ? 'absent' : 'unknown'; }
    }
    function poll() {
      attempts += 1;
      if (parentState() === 'absent') {
        try { fs.rmSync(target, { recursive: true, force: true }); }
        catch { process.exitCode = 1; }
        return;
      }
      if (attempts < 600) setTimeout(poll, 50);
    }
    poll();
  `;
  const child = spawn(nodeExecutable, [
    '-e', source, String(parentPid), resolved, prefix,
  ], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

module.exports = {
  scheduleTemporaryProfileCleanup,
  validateTemporaryProfile,
};
