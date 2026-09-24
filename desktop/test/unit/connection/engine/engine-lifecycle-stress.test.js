'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  EngineSupervisor,
  loadEngineOwnerRecord,
  removeEngineOwnerRecord,
  windowsOwnedEngineCleanupInvocation,
  writeEngineOwnerRecord,
} = require('../../../../lib/connection/engine/engine-supervisor');

class DeterministicTimers {
  constructor() {
    this.nextId = 1;
    this.active = new Map();
    this.all = new Map();
  }

  setTimeout(callback, delayMs) {
    const id = this.nextId++;
    const record = { callback, delayMs };
    this.active.set(id, record);
    this.all.set(id, record);
    return id;
  }

  clearTimeout(id) {
    this.active.delete(id);
  }

  ids() {
    return [...this.active.keys()];
  }

  fire(id) {
    const record = this.active.get(id);
    if (!record) return undefined;
    this.active.delete(id);
    return record.callback();
  }
}

function childForRound(round) {
  const child = new EventEmitter();
  child.pid = 10_000 + round;
  child.killCalls = [];
  child.kill = (signal) => {
    child.killCalls.push(signal || 'SIGTERM');
    return true;
  };
  return child;
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test('100 deterministic start/invalidate/stop/close cycles leave no lifecycle residue', async () => {
  const timers = new DeterministicTimers();
  const children = [];
  const supervisor = new EngineSupervisor({
    spawnProcess: () => {
      const child = childForRound(children.length);
      children.push(child);
      return child;
    },
    setTimeoutFn: timers.setTimeout.bind(timers),
    clearTimeoutFn: timers.clearTimeout.bind(timers),
  });
  let staleRetryCalls = 0;
  let totalCloseCalls = 0;

  for (let round = 0; round < 100; round++) {
    let errorCalls = 0;
    let exitCalls = 0;
    let closeCalls = 0;
    let callbacksAtClose = null;
    const started = supervisor.start({
      command: '/app/ec-engine',
      onError: () => { errorCalls += 1; },
      onExit: () => { exitCalls += 1; },
      onClose: () => {
        closeCalls += 1;
        totalCloseCalls += 1;
        callbacksAtClose = { errorCalls, exitCalls };
      },
    });
    assert.equal(started.ok, true, `round ${round} must start`);
    const child = started.child;
    const generation = started.generation;

    // Fire the retry timer so its Promise microtask is queued, then invalidate
    // before that microtask can observe the generation.
    assert.equal(supervisor.schedule(generation, 1, () => { staleRetryCalls += 1; }), true);
    const [retryTimer] = timers.ids();
    timers.fire(retryTimer);

    // Exercise the legal ChildProcess event variants plus guarded late events.
    if (round % 4 === 0) {
      child.emit('error', new Error(`spawn-${round}`));
      child.emit('exit', 17, null);
    } else if (round % 4 === 1) {
      child.emit('exit', 0, null);
    } else if (round % 4 === 3) {
      child.emit('error', new Error(`runtime-${round}`));
    }

    supervisor.invalidate();
    const forced = round % 3 === 0;
    const stopping = supervisor.stop({ graceMs: 10, forceWaitMs: 10 });
    assert.deepEqual(child.killCalls, ['SIGTERM']);

    if (round % 4 === 1) child.emit('error', new Error(`after-exit-${round}`));
    if (forced) {
      const [graceDeadline] = timers.ids();
      assert.ok(graceDeadline, `round ${round} needs a grace deadline`);
      timers.fire(graceDeadline);
      await flushMicrotasks();
      assert.deepEqual(child.killCalls, ['SIGTERM', 'SIGKILL']);
    }

    child.emit('close', forced ? null : 0, forced ? 'SIGKILL' : null);
    child.emit('close', 99, null);
    // In this variant neither once-listener fired before close. Late error and
    // exit must be swallowed as stale rather than reaching lifecycle callbacks.
    if (round % 4 === 2) {
      child.emit('error', new Error(`late-${round}`));
      child.emit('exit', 99, null);
    }

    const result = await stopping;
    await flushMicrotasks();
    assert.equal(result.ok, true);
    assert.equal(result.phase, forced ? 'force' : 'grace');
    assert.equal(closeCalls, 1, `round ${round} close must finalize once`);
    if (round % 4 === 2) {
      assert.deepEqual(callbacksAtClose, { errorCalls: 0, exitCalls: 0 });
      assert.equal(errorCalls, 0, 'late error must not escape finalized record');
      assert.equal(exitCalls, 0, 'late exit must not escape finalized record');
    }
    assert.equal(supervisor.hasActive, false, `round ${round} left an active ghost`);
    assert.equal(supervisor.currentChild, null);
    assert.equal(supervisor.scheduledCount, 0, `round ${round} left retry ownership`);
    assert.deepEqual(timers.ids(), [], `round ${round} left an active timer`);
  }

  assert.equal(children.length, 100);
  assert.equal(totalCloseCalls, 100);
  assert.equal(staleRetryCalls, 0, 'no queued retry from an invalid generation may run');
  assert.equal(supervisor.hasActive, false);
  assert.equal(supervisor.scheduledCount, 0);
  assert.deepEqual(timers.ids(), []);
});

test('100 owner-record replacements never remove a wrong PID or executable path', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-owner-stress-'));
  const filePath = path.join(directory, 'engine-owner.json');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  let lastOwner = null;
  for (let round = 0; round < 100; round++) {
    const owner = {
      pid: 20_000 + round,
      executablePath: `C:\\Program Files\\HKUSTGZ\\engine-${round % 2}\\ec-engine.exe`,
    };
    writeEngineOwnerRecord(filePath, owner);
    assert.deepEqual(loadEngineOwnerRecord(filePath), { version: 1, ...owner });
    assert.equal(removeEngineOwnerRecord(filePath, { ...owner, pid: owner.pid + 1 }), false);
    assert.equal(removeEngineOwnerRecord(filePath, {
      ...owner,
      executablePath: 'C:\\Wrong\\ec-engine.exe',
    }), false);
    assert.deepEqual(loadEngineOwnerRecord(filePath), { version: 1, ...owner });
    const invocation = windowsOwnedEngineCleanupInvocation({ version: 1, ...owner }, {});
    assert.equal(invocation.env.HKUSTGZ_ENGINE_CLEANUP_PID, String(owner.pid));
    assert.equal(invocation.env.HKUSTGZ_ENGINE_CLEANUP_PATH, owner.executablePath);
    lastOwner = owner;
  }

  assert.equal(removeEngineOwnerRecord(filePath, lastOwner), true);
  assert.equal(fs.existsSync(filePath), false);
  assert.deepEqual(
    fs.readdirSync(directory).filter((name) => name.endsWith('.tmp')),
    [],
  );
});
