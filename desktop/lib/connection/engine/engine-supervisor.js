'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ensureOwnerOnly, readPrivateFileBounded } = require('../../platform/storage/private-file');
const { atomicWritePrivateFile } = require('../../platform/storage/atomic-private-file');
const { protectWindowsFileOwnerOnly, verifyWindowsFileOwnerOnly } =
  require('../../platform/storage/windows-private-file');
const {
  STOP_CONTROL_GRACE_MS,
  STOP_GRACE_MS,
  STOP_FORCE_WAIT_MS,
} = require('../state/stop-policy');

const MAX_ENGINE_OWNER_RECORD_BYTES = 4096;

// Keep the executable path out of the PowerShell program itself. Besides
// avoiding quoting bugs, this prevents a path containing PowerShell syntax
// from turning orphan cleanup into command execution. Win32_Process is used
// instead of Get-Process because it exposes the full executable path.
const WINDOWS_ENGINE_PATH_ENV = 'HKUSTGZ_ENGINE_CLEANUP_PATH';
const WINDOWS_ENGINE_PID_ENV = 'HKUSTGZ_ENGINE_CLEANUP_PID';
const WINDOWS_EXACT_CLEANUP_SCRIPT = [
  `$target = $env:${WINDOWS_ENGINE_PATH_ENV}`,
  `$ownerProcessId = [int]$env:${WINDOWS_ENGINE_PID_ENV}`,
  'if (-not $target -or $ownerProcessId -le 0) { exit 0 }',
  '$target = [System.IO.Path]::GetFullPath($target)',
  '$owned = Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f $ownerProcessId) -ErrorAction SilentlyContinue |',
  '  Where-Object { $_.ExecutablePath -and [string]::Equals([System.IO.Path]::GetFullPath($_.ExecutablePath), $target, [System.StringComparison]::OrdinalIgnoreCase) }',
  '$owned | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
  'Start-Sleep -Milliseconds 100',
  '$remaining = Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f $ownerProcessId) -ErrorAction SilentlyContinue |',
  '  Where-Object { $_.ExecutablePath -and [string]::Equals([System.IO.Path]::GetFullPath($_.ExecutablePath), $target, [System.StringComparison]::OrdinalIgnoreCase) }',
  'if ($remaining) { exit 1 }',
].join('\n');

function normalizeOwnerRecord(value) {
  if (!value || typeof value !== 'object' || value.version !== 1 ||
      !Number.isInteger(value.pid) || value.pid <= 0 ||
      typeof value.executablePath !== 'string' || !value.executablePath.length) return null;
  return { version: 1, pid: value.pid, executablePath: value.executablePath };
}

function loadEngineOwnerRecord(filePath) {
  try {
    const { data } = readPrivateFileBounded(filePath, {
      maxBytes: MAX_ENGINE_OWNER_RECORD_BYTES,
    });
    return normalizeOwnerRecord(JSON.parse(data.toString('utf8')));
  } catch {
    return null;
  }
}

function writeEngineOwnerRecord(filePath, record, {
  fileSystem = fs,
  platform = process.platform,
  windowsAcl = { protect: protectWindowsFileOwnerOnly, verify: verifyWindowsFileOwnerOnly },
} = {}) {
  const normalized = normalizeOwnerRecord({ ...record, version: 1 });
  if (!normalized) throw new TypeError('invalid engine owner record');
  // This is a newly created process record, not an existing user file to tighten.
  // Establish its private ACL before publication; elevated Windows may default to Administrators.
  const saved = atomicWritePrivateFile(filePath, JSON.stringify(normalized), fileSystem, {
    protectTemporary: platform === 'win32' ? file => windowsAcl.protect(file) : null,
    verifyCommitted: platform === 'win32' ? file => windowsAcl.verify(file) : ensureOwnerOnly,
    removeCommittedOnFailure: true,
  });
  if (!saved) throw new Error('engine owner record is not a private file');
  return normalized;
}

function sameWindowsExecutablePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' ||
      !path.win32.isAbsolute(left) || !path.win32.isAbsolute(right)) return false;
  return path.win32.normalize(left).toLocaleLowerCase('en-US') ===
    path.win32.normalize(right).toLocaleLowerCase('en-US');
}

function removeEngineOwnerRecord(filePath, expected = null) {
  if (expected) {
    const current = loadEngineOwnerRecord(filePath);
    if (!current || current.pid !== expected.pid ||
        !sameWindowsExecutablePath(current.executablePath, expected.executablePath)) return false;
  }
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function windowsOwnedEngineCleanupInvocation(record, baseEnv = process.env) {
  const normalized = normalizeOwnerRecord(record);
  if (!normalized || !path.win32.isAbsolute(normalized.executablePath)) return null;
  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_EXACT_CLEANUP_SCRIPT],
    env: {
      ...baseEnv,
      [WINDOWS_ENGINE_PATH_ENV]: normalized.executablePath,
      [WINDOWS_ENGINE_PID_ENV]: String(normalized.pid),
    },
  };
}

function exactExecutableProcessPattern(executablePath) {
  if (typeof executablePath !== 'string' || !path.isAbsolute(executablePath)) return '';
  const escaped = executablePath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return `^${escaped}( |$)`;
}

function cleanupOrphanedEngine({
  platform = process.platform,
  executablePath,
  ownerFile,
  execFileSync = require('node:child_process').execFileSync,
  baseEnv = process.env,
} = {}) {
  const executableIsAbsolute = platform === 'win32'
    ? path.win32.isAbsolute(executablePath || '')
    : path.isAbsolute(executablePath || '');
  if (!['darwin', 'linux', 'win32'].includes(platform) ||
      typeof executablePath !== 'string' || !executableIsAbsolute ||
      typeof ownerFile !== 'string' || !path.isAbsolute(ownerFile) ||
      typeof execFileSync !== 'function') {
    throw new TypeError('orphaned Engine cleanup inputs are invalid');
  }
  if (platform === 'win32') {
    const owner = loadEngineOwnerRecord(ownerFile);
    if (!owner) return true;
    if (!sameWindowsExecutablePath(owner.executablePath, executablePath)) return false;
    const invocation = windowsOwnedEngineCleanupInvocation(owner, baseEnv);
    if (!invocation) return false;
    try {
      execFileSync(invocation.command, invocation.args, {
        env: invocation.env,
        stdio: 'ignore',
        timeout: 4_000,
        windowsHide: true,
      });
    } catch { return false; }
    return removeEngineOwnerRecord(ownerFile, owner);
  }
  const pattern = exactExecutableProcessPattern(executablePath);
  if (!pattern) return false;
  try {
    execFileSync('pkill', ['-f', pattern], { stdio: 'ignore', timeout: 3_000 });
  } catch (error) {
    if (error?.status !== 1) return false;
  }
  try {
    execFileSync('pgrep', ['-f', pattern], { stdio: 'ignore', timeout: 3_000 });
    return false;
  } catch (error) {
    return error?.status === 1;
  }
}

function safeCall(callback, payload) {
  if (typeof callback !== 'function') return;
  try { callback(payload); } catch {}
}

function waitWithDeadline(promise, timeoutMs, setTimeoutFn, clearTimeoutFn) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeoutFn(timer);
      resolve(result);
    };
    timer = setTimeoutFn(() => finish({ timedOut: true }), Math.max(0, timeoutMs));
    Promise.resolve(promise).then(
      (value) => finish({ timedOut: false, value }),
      (error) => finish({ timedOut: false, rejected: true, error }),
    );
  });
}

function completedStop(phase, result) {
  return {
    ok: true,
    phase,
    result,
    // A nonzero process exit after an acknowledged stop means the listener is
    // gone, but the Engine could not prove remote/session cleanup. Callers may
    // allow a manual disconnect while refusing an automatic immediate retry.
    cleanExit: result?.code === 0 && !result?.spawnError,
  };
}

class EngineSupervisor {
  constructor({
    spawnProcess,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = {}) {
    if (typeof spawnProcess !== 'function') throw new TypeError('spawnProcess is required');
    this.spawnProcess = spawnProcess;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.active = null;
    this.generation = 0;
    this.scheduled = new Set();
  }

  get hasActive() { return this.active !== null; }
  get currentChild() { return this.active ? this.active.child : null; }
  get currentGeneration() { return this.generation; }
  get scheduledCount() { return this.scheduled.size; }

  isCurrent(generation) {
    return Number.isInteger(generation) && generation === this.generation;
  }

  // Invalidation is synchronous so a user stop wins immediately over an old
  // health probe, retry timer, or recovery continuation.
  invalidate() {
    this.generation += 1;
    for (const scheduled of this.scheduled) this.clearTimeoutFn(scheduled.timer);
    this.scheduled.clear();
    return this.generation;
  }

  schedule(generation, delayMs, callback) {
    if (!this.isCurrent(generation) || typeof callback !== 'function') return false;
    const scheduled = { generation, timer: null };
    scheduled.timer = this.setTimeoutFn(() => {
      this.scheduled.delete(scheduled);
      if (!this.isCurrent(generation)) return;
      Promise.resolve().then(() => {
        if (this.isCurrent(generation)) return callback();
        return undefined;
      }).catch(() => {});
    }, Math.max(0, delayMs));
    this.scheduled.add(scheduled);
    return true;
  }

  start({ command, args = [], options = {}, onError, onExit, onClose } = {}) {
    if (this.active) {
      return {
        ok: false,
        reason: 'active',
        child: this.active.child,
        generation: this.active.generation,
      };
    }

    const generation = this.invalidate();
    let child;
    try {
      child = this.spawnProcess(command, args, options);
    } catch (error) {
      safeCall(onError, { error, generation });
      return { ok: false, reason: 'spawn', error, generation };
    }

    let resolveClosed;
    const closed = new Promise((resolve) => { resolveClosed = resolve; });
    const record = {
      child,
      generation,
      closed,
      resolveClosed,
      spawnError: null,
      exitCode: null,
      exitSignal: null,
      stopRequested: false,
      stopPromise: null,
      closedFinalized: false,
      onError,
      onExit,
      onClose,
    };
    this.active = record;

    child.once('error', (error) => {
      if (record.closedFinalized) return;
      record.spawnError = error;
      safeCall(record.onError, { error, generation });
      // Do not clear active here. Node emits close after error once stdio has
      // closed, and only close is the authoritative lifecycle boundary.
    });
    child.once('exit', (code, signal) => {
      if (record.closedFinalized) return;
      record.exitCode = code;
      record.exitSignal = signal;
      safeCall(record.onExit, { code, signal, generation });
      // Likewise, exit may precede close while stdout/stderr are still
      // readable. Keeping ownership until close prevents a second engine from
      // being started into that interval.
    });
    child.once('close', (code, signal) => {
      if (record.closedFinalized) return;
      record.closedFinalized = true;
      const result = {
        code: code ?? record.exitCode,
        signal: signal ?? record.exitSignal,
        spawnError: record.spawnError,
        generation,
        stopRequested: record.stopRequested,
      };
      if (this.active === record) this.active = null;
      record.resolveClosed(result);
      safeCall(record.onClose, result);
    });

    return { ok: true, child, generation, closed };
  }

  stop({
    requestGracefulStop,
    controlGraceMs = STOP_CONTROL_GRACE_MS,
    graceMs = STOP_GRACE_MS,
    forceWaitMs = STOP_FORCE_WAIT_MS,
  } = {}) {
    const record = this.active;
    if (!record) return Promise.resolve({ ok: true, phase: 'idle', cleanExit: true });
    if (record.stopPromise) return record.stopPromise;

    // Install the shared promise before invoking either the control callback
    // or child.kill(). A synchronous close/onClose re-entry therefore cannot
    // start a second stop sequence for the same process record.
    let resolveStop;
    let rejectStop;
    record.stopPromise = new Promise((resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    });
    this.performStop(record, {
      requestGracefulStop,
      controlGraceMs,
      graceMs,
      forceWaitMs,
    }).then(resolveStop, rejectStop);
    return record.stopPromise;
  }

  async performStop(record, {
    requestGracefulStop,
    controlGraceMs,
    graceMs,
    forceWaitMs,
  }) {
    record.stopRequested = true;

    if (typeof requestGracefulStop === 'function') {
      let requested;
      try {
        requested = requestGracefulStop({
          child: record.child,
          generation: record.generation,
        });
      } catch {
        requested = Promise.reject(new Error('control stop request was rejected'));
      }

      // The control budget covers both sending/acknowledging the request and
      // the resulting process close. Rejection (including an explicit false)
      // falls through immediately to the signal-based compatibility path.
      const controlClose = Promise.resolve(requested).then((accepted) => {
        if (accepted === false || (accepted && accepted.ok === false)) {
          throw new Error('control stop request was rejected');
        }
        return record.closed;
      });
      const controlled = await waitWithDeadline(
        controlClose,
        controlGraceMs,
        this.setTimeoutFn,
        this.clearTimeoutFn,
      );
      if (!controlled.timedOut && !controlled.rejected) {
        return completedStop('control', controlled.value);
      }
    }

    // Record identity protects a replacement engine from delayed continuations
    // belonging to the process that was asked to stop.
    if (this.active === record && !record.closedFinalized) {
      try { record.child.kill(); } catch {}
    }

    const graceful = await waitWithDeadline(
      record.closed,
      graceMs,
      this.setTimeoutFn,
      this.clearTimeoutFn,
    );
    if (!graceful.timedOut) return completedStop('grace', graceful.value);

    // A close from an earlier child must not force-kill a later one. `record`
    // identity is stronger than checking a pid that the OS may already reuse.
    if (this.active === record) {
      try { record.child.kill('SIGKILL'); } catch {}
    }
    const forced = await waitWithDeadline(
      record.closed,
      forceWaitMs,
      this.setTimeoutFn,
      this.clearTimeoutFn,
    );
    if (!forced.timedOut) return completedStop('force', forced.value);
    return { ok: false, phase: 'failed', cleanExit: false };
  }
}

module.exports = {
  EngineSupervisor,
  MAX_ENGINE_OWNER_RECORD_BYTES,
  WINDOWS_ENGINE_PATH_ENV,
  WINDOWS_ENGINE_PID_ENV,
  WINDOWS_EXACT_CLEANUP_SCRIPT,
  cleanupOrphanedEngine,
  exactExecutableProcessPattern,
  loadEngineOwnerRecord,
  removeEngineOwnerRecord,
  sameWindowsExecutablePath,
  windowsOwnedEngineCleanupInvocation,
  writeEngineOwnerRecord,
};
