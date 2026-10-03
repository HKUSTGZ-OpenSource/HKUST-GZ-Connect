'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const scriptPath = path.join(__dirname, '..', '..', '..', 'scripts', 'temp-profile-cleanup.js');
const tempRoot = path.join(os.tmpdir(), 'temp-profile-cleanup-vm');
const prefix = 'hkustgz-temp-profile';
const target = path.join(tempRoot, `${prefix}-fixture`);

function captureHelper() {
  const source = fs.readFileSync(scriptPath, 'utf8');
  const spawns = [];
  const module = { exports: {} };
  const process = { env: {}, pid: 4321 };
  const context = {
    module,
    exports: module.exports,
    process,
    require(name) {
      if (name === 'node:child_process') {
        return { spawn(...args) {
          spawns.push(args);
          return { pid: 9876, unref() {} };
        } };
      }
      if (name === 'node:os') return { tmpdir: () => tempRoot };
      if (name === 'node:path') return path;
      throw new Error(`unexpected module request: ${name}`);
    },
  };
  vm.runInNewContext(source, context, { filename: scriptPath });
  return { cleanup: module.exports, spawns };
}

function captureChild(source, {
  parentPid = 4321,
  childTarget = target,
  childPrefix = prefix,
  probe = () => 'alive',
} = {}) {
  const scheduled = [];
  const removals = [];
  const probes = [];
  const fakeProcess = {
    argv: ['fake-node', String(parentPid), childTarget, childPrefix],
    exitCode: 0,
    kill(pid, signal) {
      probes.push({ pid, signal });
      const result = probe(probes.length);
      if (result === 'alive') return undefined;
      const error = result instanceof Error ? result : new Error('synthetic probe result');
      if (result === 'absent') error.code = 'ESRCH';
      if (result === 'permission') error.code = 'EPERM';
      throw error;
    },
    exit(code) { throw { fakeExit: true, code }; },
  };
  const fakeFs = {
    rmSync(pathname, options) {
      removals.push({ path: pathname, options });
    },
  };
  const context = {
    process: fakeProcess,
    require(name) {
      if (name === 'node:fs') return fakeFs;
      if (name === 'node:os') return { tmpdir: () => tempRoot };
      if (name === 'node:path') return path;
      throw new Error(`unexpected child module request: ${name}`);
    },
    setTimeout(callback, delay) {
      scheduled.push({ callback, delay });
      return scheduled.length;
    },
  };
  let exitCode = null;
  try { vm.runInNewContext(source, context, { filename: 'captured-temporary-profile-cleanup-child.js' }); }
  catch (error) {
    if (!error?.fakeExit) throw error;
    exitCode = error.code;
  }
  let timerCallbacks = 0;
  while (scheduled.length && timerCallbacks < 700) {
    const timer = scheduled.shift();
    assert.equal(timer.delay, 50, 'the existing polling interval must remain unchanged');
    timer.callback();
    timerCallbacks += 1;
  }
  assert.equal(scheduled.length, 0, 'the captured watcher must stop scheduling after its budget');
  return { exitCode, fakeProcess, probes, removals, timerCallbacks };
}

function spawnCapturedHelper() {
  const captured = captureHelper();
  const result = captured.cleanup.scheduleTemporaryProfileCleanup(target, prefix, {
    nodeExecutable: '/synthetic/node', parentPid: 4321,
  });
  assert.equal(result, 9876);
  assert.equal(captured.spawns.length, 1, 'only the injected spawn adapter should be called');
  const [command, args, options] = captured.spawns[0];
  assert.equal(command, '/synthetic/node');
  assert.equal(options.detached, true);
  assert.equal(options.stdio, 'ignore');
  assert.equal(options.windowsHide, true);
  assert.equal(args[0], '-e');
  return { ...captured, source: args[1] };
}

test('temporary profile helper retains a live owner after the existing polling budget', () => {
  const { source } = spawnCapturedHelper();
  const child = captureChild(source, { probe: () => 'alive' });
  assert.equal(child.probes.length, 600);
  assert.equal(child.probes.every(({ pid, signal }) => pid === 4321 && signal === 0), true);
  assert.equal(child.timerCallbacks, 599);
  assert.equal(child.removals.length, 0,
    'budget exhaustion must stop the watcher without deleting a live owner profile');
});

test('temporary profile helper deletes only after confirmed owner absence', () => {
  const { source } = spawnCapturedHelper();
  const child = captureChild(source, {
    probe: attempt => attempt < 3 ? 'alive' : 'absent',
  });
  assert.equal(child.probes.length, 3);
  assert.equal(child.probes.every(({ pid, signal }) => pid === 4321 && signal === 0), true);
  assert.equal(child.removals.length, 1);
  assert.equal(child.removals[0].path, target);
  assert.equal(child.removals[0].options.recursive, true);
  assert.equal(child.removals[0].options.force, true);
  assert.equal(child.timerCallbacks, 2);
});

test('temporary profile helper fails closed on permission and unknown process probes', async (t) => {
  for (const [name, result] of [['EPERM', 'permission'], ['unknown error', new Error('synthetic probe failure')]]) {
    await t.test(name, () => {
      const { source } = spawnCapturedHelper();
      const child = captureChild(source, { probe: () => result });
      assert.equal(child.probes.length, 600);
      assert.equal(child.removals.length, 0,
        'an inconclusive process probe must never be treated as confirmed death');
    });
  }
});

test('temporary profile helper rejects invalid PID and target boundaries before spawning', () => {
  const { cleanup, spawns } = captureHelper();
  assert.throws(() => cleanup.scheduleTemporaryProfileCleanup(
    path.join(tempRoot, 'other-fixture'), prefix, { parentPid: 4321 },
  ), /outside the test boundary/u);
  assert.throws(() => cleanup.scheduleTemporaryProfileCleanup(
    target, prefix, { parentPid: 0 },
  ), /parent PID is invalid/u);
  assert.equal(spawns.length, 0);
});

test('captured child rejects wrong PID and non-owned paths without probing or deleting', () => {
  const { source } = spawnCapturedHelper();
  for (const input of [
    { parentPid: 'not-a-pid', childTarget: target, childPrefix: prefix },
    { parentPid: 4321, childTarget: path.join(tempRoot, 'nested', `${prefix}-fixture`), childPrefix: prefix },
    { parentPid: 4321, childTarget: path.join(tempRoot, 'other-fixture'), childPrefix: prefix },
  ]) {
    const child = captureChild(source, input);
    assert.equal(child.exitCode, 2);
    assert.equal(child.probes.length, 0);
    assert.equal(child.removals.length, 0);
  }
});
