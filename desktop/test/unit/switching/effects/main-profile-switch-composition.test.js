'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createMainProfileSwitchComposition,
} = require('../../../../lib/switching/effects/main-profile-switch-composition');

const directive = {
  switchId: `switch-${'a'.repeat(32)}`,
  profileId: `custom-${'b'.repeat(32)}`,
  activeContextEpoch: 8,
};

function fixture({ recovery = { ok: true, status: 'none', relaunch: null } } = {}) {
  const calls = [];
  let runtimeOptions;
  const runtime = {
    recoverBeforeServices: async () => recovery,
    switchTo: async (profileId) => {
      calls.push(['switch', profileId]);
      return { ok: true, status: 'activated', relaunch: directive };
    },
  };
  const owners = {
    activeContextLease: { invalidate: () => calls.push('invalidate') },
    browserManager: {
      browser: null,
      routingRequestsBlocked: true,
      suspendRoutingPolicy: () => null,
      closeForContextSwitch: async () => true,
    },
    authChallenges: { cancelForLifecycle: () => calls.push('auth') },
    onboarding: { cancel: () => calls.push('onboarding') },
    networkStartup: { cancel: () => calls.push('network') },
    connectivityRecovery: { cancel: () => calls.push('connectivity') },
    mutationQueue: { cancelAndDrain: async () => true },
    engineSupervisor: {
      hasActive: true,
      currentGeneration: 7,
      isCurrent: (generation) => generation === 7,
      invalidate: () => calls.push('engine-invalidate'),
    },
    connectionState: {
      beginStop: () => { calls.push('begin-stop'); return 11; },
      stopCompleted: (intent, result) => calls.push(['stop-complete', intent, result.ok]),
    },
  };
  const effects = {
    clearProxyCredential: (generation) => calls.push(['credential', generation]),
    clearConnectionPresentation: () => calls.push('presentation'),
    ensureEngineStopped: async () => { calls.push('engine-stop'); return { ok: true, cleanExit: true }; },
    cleanupOrphanedEngine: () => { calls.push('orphan'); return true; },
    revokeProxyAccess: async () => true,
    clearServerState: async () => true,
    closeLog: async () => calls.push('log'),
  };
  const composition = createMainProfileSwitchComposition({
    enabled: true,
    directoryOptions: {},
    userData: '/user-data',
    journalFile: '/user-data/global/switch.json',
    activeAuthority: {},
    getLiveAuthority: () => ({ current: true }),
    application: {},
    argv: ['/app'],
    isPackaged: true,
    developmentEntry: '/unused',
    owners,
    effects,
    barrierEffectsFactory: (value) => value,
    runtimeFactory: (options) => { runtimeOptions = options; return runtime; },
    scheduleRelaunch: (options) => calls.push(['schedule', options.switchId]),
    relaunchNow: (options) => calls.push(['relaunch', options.switchId]),
  });
  return { calls, composition, get runtimeOptions() { return runtimeOptions; } };
}

test('disabled persistence exposes no switch runtime or side effects', async () => {
  const value = createMainProfileSwitchComposition({
    enabled: false,
    application: {}, argv: [], isPackaged: false, developmentEntry: '/app',
    owners: {}, effects: {},
  });
  assert.equal(value.runtime, null);
  assert.equal(await value.recoverBeforeServices(), null);
  assert.deepEqual(await value.switchProfile('hkustgz'), {
    ok: false,
    code: 'PROFILE_SWITCH_NOT_READY',
  });
});

test('live switch stops exact generation then schedules one sanitized relaunch', async () => {
  const f = fixture();
  assert.deepEqual(f.runtimeOptions.getLiveAuthority(), { current: true });
  const stopped = await f.runtimeOptions.liveEffects.stopEngine(7);
  assert.deepEqual(stopped, { ok: true, cleanExit: true });
  assert.deepEqual(f.calls.slice(0, 6), [
    'begin-stop', 'engine-invalidate', ['credential', 7], 'presentation',
    'engine-stop', ['stop-complete', 11, true],
  ]);
  const result = await f.composition.switchProfile(directive.profileId);
  assert.deepEqual(result, {
    ok: true,
    profileId: directive.profileId,
    activeContextEpoch: 8,
    relaunching: true,
  });
  assert.deepEqual(f.calls.slice(-2), [
    ['switch', directive.profileId],
    ['schedule', directive.switchId],
  ]);
  await assert.rejects(f.composition.switchProfile(directive.profileId), (error) => (
    error?.code === 'ACTIVE_CONTEXT_SWITCH_RELAUNCH_PENDING'
  ));
});

test('startup recovery confirms orphan cleanup and relaunches only an activated journal', async () => {
  const clean = fixture();
  assert.deepEqual(await clean.composition.recoverBeforeServices(), {
    ok: true, status: 'none', relaunch: null,
  });
  assert.equal(clean.calls.some((call) => Array.isArray(call) && call[0] === 'relaunch'), false);

  const recovered = fixture({ recovery: {
    ok: true,
    status: 'activated',
    relaunch: directive,
  } });
  assert.deepEqual(await recovered.runtimeOptions.startupEffects.stopEngine(99), {
    ok: true,
    cleanExit: true,
  });
  const result = await recovered.composition.recoverBeforeServices();
  assert.equal(result.relaunching, true);
  assert.deepEqual(recovered.calls, ['orphan', ['relaunch', directive.switchId]]);
});
