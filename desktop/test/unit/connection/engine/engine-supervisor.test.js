'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
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
} = require('../../../../lib/connection/engine/engine-supervisor');

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4321;
  child.killCalls = [];
  child.kill = (signal) => {
    child.killCalls.push(signal || 'SIGTERM');
    return true;
  };
  return child;
}

test('independent client owners never stop or invalidate a peer with the same PID and generation', async () => {
  // Two computers may have identical local PIDs/generation counters. This is
  // client ownership evidence, not a simulation of campus account admission.
  for (const stoppedIndex of [0, 1]) {
    const children = [fakeChild(), fakeChild()];
    const owners = children.map(child => new EngineSupervisor({ spawnProcess: () => child }));
    const first = owners[0].start({ command: '/synthetic/ec-engine' });
    const second = owners[1].start({ command: '/synthetic/ec-engine' });
    assert.equal(first.generation, second.generation);
    assert.ok(owners.every(owner => owner.hasActive));
    const peer = 1 - stoppedIndex;
    const peerGeneration = owners[peer].currentGeneration;
    children[stoppedIndex].kill = signal => {
      children[stoppedIndex].killCalls.push(signal);
      queueMicrotask(() => children[stoppedIndex].emit('close', 0, signal));
      return true;
    };
    assert.equal((await owners[stoppedIndex].stop({ graceMs: 100, forceWaitMs: 100 })).ok, true);
    assert.equal(owners[peer].hasActive, true);
    assert.equal(owners[peer].currentGeneration, peerGeneration);
    assert.deepEqual(children[peer].killCalls, []);
    assert.equal(owners[stoppedIndex].start({ command: '/synthetic/ec-engine' }).ok, true);
    assert.equal(owners[peer].currentChild, children[peer]);
    assert.equal(owners[peer].currentGeneration, peerGeneration);
    children.forEach(child => child.emit('close', 0, null));
    assert.ok(owners.every(owner => !owner.hasActive));
  }
});

test('invalidating one client cancels only its recovery timers, not its peer timers', async () => {
  const pending = new Map(); let next = 0;
  const owners = [0, 1].map(() => new EngineSupervisor({ spawnProcess: fakeChild,
    setTimeoutFn: callback => { pending.set(++next, callback); return next; },
    clearTimeoutFn: id => pending.delete(id),
  }));
  const fired = [];
  owners.forEach((owner, index) => owner.schedule(owner.currentGeneration, 1, () => fired.push(index)));
  const late = [...pending.values()][0];
  owners[0].invalidate(); late();
  assert.equal(owners[0].scheduledCount, 0);
  assert.equal(owners[1].scheduledCount, 1);
  for (const callback of pending.values()) callback();
  await Promise.resolve();
  assert.deepEqual(fired, [1]);
  owners.forEach(owner => owner.invalidate());
});

test('spawn error, exit, and close converge exactly once at close', async () => {
  const child = fakeChild();
  const events = [];
  const supervisor = new EngineSupervisor({ spawnProcess: () => child });
  const started = supervisor.start({
    command: '/app/ec-engine',
    onError: ({ error }) => events.push(['error', error.message]),
    onExit: ({ code }) => events.push(['exit', code]),
    onClose: ({ code, spawnError }) => events.push(['close', code, spawnError.message]),
  });

  assert.equal(started.ok, true);
  child.emit('error', new Error('ENOENT'));
  assert.equal(supervisor.hasActive, true, 'error must not release process ownership');
  child.emit('exit', 127, null);
  assert.equal(supervisor.hasActive, true, 'exit must wait for stdio close');
  child.emit('close', 127, null);
  child.emit('close', 127, null);

  assert.equal(supervisor.hasActive, false);
  assert.deepEqual(events, [
    ['error', 'ENOENT'],
    ['exit', 127],
    ['close', 127, 'ENOENT'],
  ]);
  assert.equal((await started.closed).code, 127);
});

test('a synchronous spawn failure never leaves a ghost active engine', () => {
  const failure = new Error('spawn failed synchronously');
  const supervisor = new EngineSupervisor({ spawnProcess: () => { throw failure; } });
  let reported = null;
  const result = supervisor.start({
    command: '/app/ec-engine',
    onError: ({ error }) => { reported = error; },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'spawn');
  assert.equal(result.error, failure);
  assert.equal(reported, failure);
  assert.equal(supervisor.hasActive, false);
  assert.equal(supervisor.currentChild, null);
});

test('the supervisor rejects a duplicate start until close', () => {
  const children = [fakeChild(), fakeChild()];
  let spawnCalls = 0;
  const supervisor = new EngineSupervisor({ spawnProcess: () => children[spawnCalls++] });

  const first = supervisor.start({ command: '/app/ec-engine' });
  const duplicate = supervisor.start({ command: '/app/ec-engine' });
  assert.equal(first.ok, true);
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.reason, 'active');
  assert.equal(spawnCalls, 1);

  children[0].emit('close', 0, null);
  assert.equal(supervisor.start({ command: '/app/ec-engine' }).ok, true);
  assert.equal(spawnCalls, 2);
});

test('graceful stop owns the child until its close event', async () => {
  const child = fakeChild();
  child.kill = (signal) => {
    child.killCalls.push(signal || 'SIGTERM');
    queueMicrotask(() => child.emit('close', 0, signal || 'SIGTERM'));
    return true;
  };
  const supervisor = new EngineSupervisor({ spawnProcess: () => child });
  supervisor.start({ command: '/app/ec-engine' });

  const stopped = await supervisor.stop({ graceMs: 100, forceWaitMs: 100 });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.phase, 'grace');
  assert.equal(stopped.cleanExit, true);
  assert.deepEqual(child.killCalls, ['SIGTERM']);
  assert.equal(supervisor.hasActive, false);
});

test('stop escalates once to SIGKILL and still finalizes only on close', async () => {
  const child = fakeChild();
  const deadlines = [];
  const supervisor = new EngineSupervisor({
    spawnProcess: () => child,
    setTimeoutFn: (callback) => {
      deadlines.push(callback);
      return deadlines.length;
    },
    clearTimeoutFn: () => {},
  });
  supervisor.start({ command: '/app/ec-engine' });

  const stopping = supervisor.stop({ graceMs: 10, forceWaitMs: 10 });
  assert.deepEqual(child.killCalls, ['SIGTERM']);
  deadlines[0]();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(child.killCalls, ['SIGTERM', 'SIGKILL']);
  assert.equal(supervisor.hasActive, true);
  child.emit('close', null, 'SIGKILL');

  const result = await stopping;
  assert.equal(result.ok, true);
  assert.equal(result.phase, 'force');
  assert.equal(result.cleanExit, false);
  assert.equal(supervisor.hasActive, false);
});

test('Control v2 stop waits for close without sending a signal', async () => {
  const child = fakeChild();
  const supervisor = new EngineSupervisor({ spawnProcess: () => child });
  const started = supervisor.start({ command: '/app/ec-engine' });
  let requestContext = null;

  const stopping = supervisor.stop({
    requestGracefulStop: (context) => {
      requestContext = context;
      queueMicrotask(() => child.emit('close', 0, null));
      return { ok: true };
    },
    controlGraceMs: 100,
    graceMs: 100,
    forceWaitMs: 100,
  });

  const result = await stopping;
  assert.equal(result.ok, true);
  assert.equal(result.phase, 'control');
  assert.equal(result.cleanExit, true);
  assert.equal(requestContext.child, child);
  assert.equal(requestContext.generation, started.generation);
  assert.deepEqual(child.killCalls, []);
});

test('concurrent Control v2 stops share one flight and one request', async () => {
  const child = fakeChild();
  const supervisor = new EngineSupervisor({ spawnProcess: () => child });
  supervisor.start({ command: '/app/ec-engine' });
  let requests = 0;
  const options = {
    requestGracefulStop: () => { requests += 1; },
    controlGraceMs: 100,
    graceMs: 100,
    forceWaitMs: 100,
  };

  const first = supervisor.stop(options);
  const second = supervisor.stop(options);
  assert.equal(first, second);
  assert.equal(requests, 1);
  child.emit('close', 0, null);

  assert.equal((await first).phase, 'control');
  assert.equal(requests, 1);
});

test('a rejected Control v2 stop falls back to SIGTERM', async () => {
  const child = fakeChild();
  child.kill = (signal) => {
    child.killCalls.push(signal || 'SIGTERM');
    queueMicrotask(() => child.emit('close', 0, signal || 'SIGTERM'));
    return true;
  };
  const supervisor = new EngineSupervisor({ spawnProcess: () => child });
  supervisor.start({ command: '/app/ec-engine' });

  const stopping = supervisor.stop({
    requestGracefulStop: () => Promise.reject(new Error('control pipe closed')),
    controlGraceMs: 100,
    graceMs: 100,
    forceWaitMs: 100,
  });
  const result = await stopping;

  assert.equal(result.ok, true);
  assert.equal(result.phase, 'grace');
  assert.deepEqual(child.killCalls, ['SIGTERM']);
});

test('a timed-out Control v2 stop escalates through SIGTERM and SIGKILL', async () => {
  const child = fakeChild();
  const deadlines = [];
  const supervisor = new EngineSupervisor({
    spawnProcess: () => child,
    setTimeoutFn: (callback) => {
      deadlines.push(callback);
      return deadlines.length;
    },
    clearTimeoutFn: () => {},
  });
  supervisor.start({ command: '/app/ec-engine' });
  const stopping = supervisor.stop({
    requestGracefulStop: () => {},
    controlGraceMs: 10,
    graceMs: 10,
    forceWaitMs: 10,
  });

  assert.deepEqual(child.killCalls, []);
  deadlines[0]();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(child.killCalls, ['SIGTERM']);
  deadlines[1]();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(child.killCalls, ['SIGTERM', 'SIGKILL']);
  child.emit('close', null, 'SIGKILL');

  const result = await stopping;
  assert.equal(result.ok, true);
  assert.equal(result.phase, 'force');
  assert.equal(result.cleanExit, false);
});

test('a nonzero controlled exit releases ownership but reports unconfirmed cleanup', async () => {
  const child = fakeChild();
  const supervisor = new EngineSupervisor({ spawnProcess: () => child });
  supervisor.start({ command: '/app/ec-engine' });
  const stopping = supervisor.stop({
    requestGracefulStop: () => {
      queueMicrotask(() => child.emit('close', 1, null));
      return { ok: true };
    },
    controlGraceMs: 100,
    graceMs: 100,
    forceWaitMs: 100,
  });
  const result = await stopping;
  assert.equal(result.ok, true, 'the local listener/process was released');
  assert.equal(result.cleanExit, false, 'remote/session cleanup was not proven');
  assert.equal(result.result.code, 1);
});

test('a stale Control v2 deadline never signals a replacement child', async () => {
  const oldChild = fakeChild();
  const newChild = fakeChild();
  const deadlines = [];
  let spawnCalls = 0;
  const supervisor = new EngineSupervisor({
    spawnProcess: () => [oldChild, newChild][spawnCalls++],
    setTimeoutFn: (callback) => {
      deadlines.push(callback);
      return deadlines.length;
    },
    clearTimeoutFn: () => {},
  });
  supervisor.start({ command: '/app/ec-engine' });
  const stopping = supervisor.stop({
    requestGracefulStop: () => {},
    controlGraceMs: 10,
    graceMs: 10,
    forceWaitMs: 10,
  });

  deadlines[0]();
  oldChild.emit('close', 0, null);
  assert.equal(supervisor.start({ command: '/app/ec-engine' }).ok, true);
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(oldChild.killCalls, []);
  assert.deepEqual(newChild.killCalls, []);
  assert.equal((await stopping).phase, 'grace');
});

test('generation invalidation cancels delayed retries', () => {
  const timers = new Map();
  let nextTimer = 1;
  const supervisor = new EngineSupervisor({
    spawnProcess: () => fakeChild(),
    setTimeoutFn: (callback) => {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearTimeoutFn: (id) => timers.delete(id),
  });
  const generation = supervisor.currentGeneration;
  let called = false;
  assert.equal(supervisor.schedule(generation, 50, () => { called = true; }), true);
  supervisor.invalidate();
  for (const callback of timers.values()) callback();
  assert.equal(called, false);
});

test('generation invalidation also wins after a retry timer fires but before its microtask', async () => {
  let fireTimer;
  const supervisor = new EngineSupervisor({
    spawnProcess: () => fakeChild(),
    setTimeoutFn: (callback) => {
      fireTimer = callback;
      return 1;
    },
    clearTimeoutFn: () => {},
  });
  let called = false;
  supervisor.schedule(supervisor.currentGeneration, 0, () => { called = true; });
  fireTimer();
  supervisor.invalidate();
  await Promise.resolve();
  assert.equal(called, false);
});

test('engine ownership is persisted atomically and removed only by its owner', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-engine-owner-'));
  const file = path.join(directory, 'engine-owner.json');
  const owner = {
    pid: 4321,
    executablePath: 'C:\\Program Files\\HKUST(GZ) Connect\\ec-engine-windows-amd64.exe',
  };
  try {
    writeEngineOwnerRecord(file, owner);
    assert.deepEqual(loadEngineOwnerRecord(file), { version: 1, ...owner });
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(removeEngineOwnerRecord(file, { ...owner, pid: 9876 }), false);
    assert.equal(fs.existsSync(file), true);
    assert.equal(removeEngineOwnerRecord(file, {
      ...owner,
      executablePath: 'C:\\Other\\ec-engine-windows-amd64.exe',
    }), false);
    assert.equal(fs.existsSync(file), true);
    assert.equal(removeEngineOwnerRecord(file, owner), true);
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('engine ownership never follows symbolic links or reads oversized records', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-engine-owner-bounds-'));
  const target = path.join(directory, 'target.json');
  const link = path.join(directory, 'engine-owner.json');
  const oversized = path.join(directory, 'oversized.json');
  const owner = {
    version: 1,
    pid: 4321,
    executablePath: 'C:\\Program Files\\HKUST(GZ) Connect\\ec-engine-windows-amd64.exe',
  };
  try {
    fs.writeFileSync(target, JSON.stringify(owner), { mode: 0o600 });
    fs.symlinkSync(target, link);
    fs.writeFileSync(oversized, 'x'.repeat(MAX_ENGINE_OWNER_RECORD_BYTES + 1), { mode: 0o600 });

    assert.equal(loadEngineOwnerRecord(link), null);
    assert.equal(loadEngineOwnerRecord(oversized), null);
    assert.equal(fs.readFileSync(target, 'utf8'), JSON.stringify(owner));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Windows orphan cleanup requires both the recorded PID and resolved executable path', () => {
  const executable = 'C:\\Program Files\\HKUST(GZ) Connect\\ec-engine-windows-amd64.exe';
  const owner = { version: 1, pid: 4321, executablePath: executable };
  const invocation = windowsOwnedEngineCleanupInvocation(
    owner,
    { SystemRoot: 'C:\\Windows' },
  );

  assert.equal(invocation.command, 'powershell.exe');
  assert.equal(invocation.env[WINDOWS_ENGINE_PATH_ENV], executable);
  assert.equal(invocation.env[WINDOWS_ENGINE_PID_ENV], '4321');
  assert.equal(invocation.env.SystemRoot, 'C:\\Windows');
  assert.equal(invocation.args.at(-1), WINDOWS_EXACT_CLEANUP_SCRIPT);
  assert.equal(WINDOWS_EXACT_CLEANUP_SCRIPT.includes(executable), false);
  assert.match(WINDOWS_EXACT_CLEANUP_SCRIPT, /ProcessId/);
  assert.match(WINDOWS_EXACT_CLEANUP_SCRIPT, /ExecutablePath/);
  assert.match(WINDOWS_EXACT_CLEANUP_SCRIPT, /if \(\$remaining\) \{ exit 1 \}/u);
  assert.doesNotMatch(WINDOWS_EXACT_CLEANUP_SCRIPT, /Get-Process\s+-Name/);
  assert.equal(
    sameWindowsExecutablePath(executable, 'C:\\Other\\ec-engine-windows-amd64.exe'),
    false,
    'a reused PID at another executable path must never match the owner record',
  );
  assert.equal(windowsOwnedEngineCleanupInvocation({
    ...owner,
    executablePath: 'relative\\ec-engine.exe',
  }), null, 'an invalid recorded path must never be used for cleanup');
  assert.equal(windowsOwnedEngineCleanupInvocation(
    { ...owner, pid: -1 },
  ), null);
});

test('POSIX orphan cleanup kills and then proves the exact executable is absent', () => {
  const calls = [];
  const executablePath = '/Applications/Campus Connect.app/Contents/Resources/engine/ec-engine';
  const result = cleanupOrphanedEngine({
    platform: 'darwin',
    executablePath,
    ownerFile: '/private/user/global/engine-owner.json',
    execFileSync(command, args) {
      calls.push([command, args]);
      if (command === 'pgrep') { const error = new Error('absent'); error.status = 1; throw error; }
    },
  });
  assert.equal(result, true);
  const pattern = exactExecutableProcessPattern(executablePath);
  assert.deepEqual(calls, [
    ['pkill', ['-f', pattern]],
    ['pgrep', ['-f', pattern]],
  ]);
  assert.equal(new RegExp(pattern).test(`${executablePath} --config x`), true);
  assert.equal(new RegExp(pattern).test('/other/ec-engine --config x'), false);
});

test('orphan cleanup stays fail closed when a process remains or tooling fails', () => {
  const input = {
    platform: 'linux',
    executablePath: '/app/ec-engine',
    ownerFile: '/user/engine-owner.json',
  };
  assert.equal(cleanupOrphanedEngine({ ...input, execFileSync: () => {} }), false,
    'a successful pgrep means the process still exists');
  assert.equal(cleanupOrphanedEngine({
    ...input,
    execFileSync: () => { const error = new Error('missing tool'); error.code = 'ENOENT'; throw error; },
  }), false);
});

test('Windows confirmed cleanup removes only the matching owner record', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-engine-owner-'));
  const ownerFile = path.join(directory, 'engine-owner.json');
  const executablePath = 'C:\\Program Files\\Campus Connect\\ec-engine.exe';
  const owner = { pid: 4321, executablePath };
  try {
    writeEngineOwnerRecord(ownerFile, owner);
    assert.equal(cleanupOrphanedEngine({
      platform: 'win32', executablePath, ownerFile, execFileSync: () => {}, baseEnv: {},
    }), true);
    assert.equal(fs.existsSync(ownerFile), false);
    writeEngineOwnerRecord(ownerFile, owner);
    assert.equal(cleanupOrphanedEngine({
      platform: 'win32', executablePath: 'C:\\Other\\ec-engine.exe', ownerFile,
      execFileSync: () => {}, baseEnv: {},
    }), false);
    assert.equal(fs.existsSync(ownerFile), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
