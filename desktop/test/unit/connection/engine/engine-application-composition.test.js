'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createEngineApplicationRuntime, EngineAttemptCoordinator } = require('../../../../lib/connection/engine/engine-process');
const { EngineSupervisor } = require('../../../../lib/connection/engine/engine-supervisor');
const { AuthChallengeCoordinator, EngineControlRegistry } = require('../../../../lib/connection/engine/engine-control-suite');
const { EngineTerminationCoordinator } = require('../../../../lib/connection/engine/engine-connection-runtime');

function fixture() {
  const effects = [];
  const options = { spawnProcess: () => { effects.push('spawn'); }, authChallenge: {
    publish: () => effects.push('publish'), isContextCurrent: () => true,
    setTimeoutFn: () => effects.push('timer'), clearTimeoutFn: () => effects.push('clear-timer'),
  } };
  return { options, effects };
}

test('public Engine assembly creates the original effect-free owners, not another policy', () => {
  const f = fixture(), runtime = createEngineApplicationRuntime(f.options);
  assert.equal(Object.isFrozen(runtime), true);
  assert.equal(runtime.authChallenges instanceof AuthChallengeCoordinator, true);
  assert.equal(runtime.controlRegistry instanceof EngineControlRegistry, true);
  assert.equal(runtime.supervisor instanceof EngineSupervisor, true);
  assert.equal(runtime.controlRegistry.authChallenges, runtime.authChallenges);
  assert.equal(runtime.supervisor.spawnProcess, f.options.spawnProcess);
  assert.deepEqual(f.effects, []);
  assert.deepEqual(Object.keys(runtime).sort(), ['authChallenges', 'cleanupOrphaned',
    'controlRegistry', 'createAttempt', 'createTermination', 'supervisor']);
});

test('attempt assembly retains caller effects but cannot substitute another process/control owner', () => {
  const f = fixture(), runtime = createEngineApplicationRuntime(f.options);
  const effects = { engineSupervisor: {}, controlRegistry: {}, profile: {}, contextLease: {},
    getState: () => ({ synthetic: true }) };
  const owner = runtime.createAttempt(effects);
  assert.equal(owner instanceof EngineAttemptCoordinator, true);
  assert.equal(owner.engineSupervisor, runtime.supervisor);
  assert.equal(owner.controlRegistry, runtime.controlRegistry);
  assert.equal(owner.profile, effects.profile); assert.equal(owner.contextLease, effects.contextLease);
  assert.equal(owner.getState, effects.getState);
  assert.deepEqual(f.effects, []);
});

test('termination generation/retry/control ports use the exact shared live owners', () => {
  const f = fixture(), runtime = createEngineApplicationRuntime(f.options);
  const caller = { isGenerationCurrent: () => { throw new Error('unowned generation'); },
    scheduleRetry: () => { throw new Error('unowned timer'); },
    clearControl: () => { throw new Error('unowned control'); },
    connectionState: {}, clearCredential: () => {}, removeSidecar: () => {} };
  const owner = runtime.createTermination(caller);
  assert.equal(owner instanceof EngineTerminationCoordinator, true);
  assert.equal(owner.connectionState, caller.connectionState);
  assert.equal(owner.clearCredential, caller.clearCredential);
  assert.equal(owner.removeSidecar, caller.removeSidecar);
  assert.equal(owner.isGenerationCurrent(0), true);
  runtime.supervisor.invalidate();
  assert.equal(owner.isGenerationCurrent(0), false); assert.equal(owner.isGenerationCurrent(1), true);
  const schedules = [], callback = () => {};
  runtime.supervisor.schedule = (...args) => { schedules.push(args); return true; };
  assert.equal(owner.scheduleRetry(1, 5000, callback), true);
  assert.deepEqual(schedules, [[1, 5000, callback]]);
  let closed = 0;
  runtime.controlRegistry.active = { generation: 7, client: { close: () => { closed++; } } };
  assert.equal(owner.clearControl(6), false); assert.equal(closed, 0);
  assert.equal(owner.clearControl(7), true); assert.equal(closed, 1);
  assert.equal(owner.clearControl(7), false);
  assert.deepEqual(f.effects, []);
});

test('orphan cleanup remains the exact platform implementation with effect injection', () => {
  const runtime = createEngineApplicationRuntime(fixture().options), calls = [];
  assert.equal(runtime.cleanupOrphaned({ platform: 'darwin', executablePath: '/fixture/ec-engine',
    ownerFile: '/fixture/owner.json', execFileSync: (command, args) => {
      calls.push([command, args]);
      if (command === 'pgrep') throw Object.assign(new Error('synthetic process absent'), { status: 1 });
      return '';
    } }), true);
  assert.ok(calls.some(([command]) => command === 'pgrep'));
  assert.equal(runtime.cleanupOrphaned({ platform: 'darwin', executablePath: '/fixture/ec-engine',
    ownerFile: '/fixture/owner.json', execFileSync: () => '' }), false,
    'a surviving process still refuses replacement');
  assert.throws(() => runtime.cleanupOrphaned({ platform: 'unknown' }), TypeError);
});

test('missing spawn effect is rejected before any auth/process publication', () => {
  const f = fixture();
  assert.throws(() => createEngineApplicationRuntime({ ...f.options, spawnProcess: null }), TypeError);
  assert.deepEqual(f.effects, []);
});
