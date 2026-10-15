'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MainProfileSwitchRuntime,
  createMainProfileSwitchRuntime,
  persistentContextFromAuthority,
} = require('../../../../lib/switching/runtime/profile-switch-main-runtime');

const targetProfileId = `custom-${'a'.repeat(32)}`;
const target = {
  profile: { profileId: targetProfileId },
  context: { profileId: targetProfileId },
};
const journal = {
  switchId: `switch-${'b'.repeat(32)}`,
  to: { profileId: targetProfileId },
  nextActiveContextEpoch: 8,
};

function activated() {
  return {
    ok: true,
    status: 'activated',
    switchId: journal.switchId,
    activeContextEpoch: journal.nextActiveContextEpoch,
  };
}

class FakeSwitchRuntime {
  constructor(options) {
    this.options = options;
    FakeSwitchRuntime.instances.push(this);
  }
  recover() {
    this.options.activateRuntime(target, journal);
    return Promise.resolve(activated());
  }
  switchTo(profileId) {
    assert.equal(profileId, targetProfileId);
    this.options.activateRuntime(target, journal);
    return Promise.resolve(activated());
  }
}
FakeSwitchRuntime.instances = [];

function fixture({ pending = journal } = {}) {
  FakeSwitchRuntime.instances = [];
  return new MainProfileSwitchRuntime({
    directory: { withCandidate: () => {} },
    journalStore: { read: () => pending },
    activationStore: { plan: () => ({}) },
    startupBarrier: { kind: 'startup' },
    liveBarrier: { kind: 'live' },
    getActivePersistentContext: () => ({}),
    getEngineGeneration: () => null,
    SwitchRuntimeClass: FakeSwitchRuntime,
  });
}

test('authority projection retains only exact persistent switch identity', () => {
  assert.deepEqual(persistentContextFromAuthority({
    profile: {
      profileId: 'hkustgz',
      profileRevision: 1,
      profileCredentialBindingRevision: 2,
    },
    layout: { identity: { profileKey: 'profile-key' } },
    account: {
      accountKey: 'account-key', accountRevision: 3,
      accountCredentialRevision: 4, workspaceKey: 'workspace-key',
    },
    workspaceState: { activeContextEpoch: 5 },
    credential: 'must-not-cross',
  }), {
    profileId: 'hkustgz', profileKey: 'profile-key', profileRevision: 1,
    profileCredentialBindingRevision: 2, accountKey: 'account-key',
    accountRevision: 3, accountCredentialRevision: 4,
    workspaceKey: 'workspace-key', activeContextEpoch: 5,
  });
});

test('clean startup performs no switch operation or relaunch', async () => {
  const runtime = fixture({ pending: null });
  assert.deepEqual(await runtime.recoverBeforeServices(), {
    ok: true,
    status: 'none',
    relaunch: null,
  });
  assert.equal(FakeSwitchRuntime.instances[0].options.barrier.kind, 'startup');
  assert.equal(FakeSwitchRuntime.instances[1].options.barrier.kind, 'live');
});

test('startup recovery and live switch each return one sanitized relaunch directive', async () => {
  const runtime = fixture();
  for (const result of [
    await runtime.recoverBeforeServices(),
    await runtime.switchTo(targetProfileId),
  ]) {
    assert.deepEqual(result.relaunch, {
      switchId: journal.switchId,
      profileId: targetProfileId,
      activeContextEpoch: 8,
    });
    assert.equal(Object.hasOwn(result.relaunch, 'profileKey'), false);
  }
});

test('activation mismatch fails before a relaunch can be scheduled', async () => {
  class MismatchRuntime extends FakeSwitchRuntime {
    recover() {
      this.options.activateRuntime(target, journal);
      return Promise.resolve({ ...activated(), switchId: `switch-${'c'.repeat(32)}` });
    }
  }
  const runtime = new MainProfileSwitchRuntime({
    directory: { withCandidate: () => {} },
    journalStore: { read: () => journal },
    activationStore: { plan: () => ({}) },
    startupBarrier: {}, liveBarrier: {},
    getActivePersistentContext: () => ({}), getEngineGeneration: () => null,
    SwitchRuntimeClass: MismatchRuntime,
  });
  await assert.rejects(runtime.recoverBeforeServices(), /one relaunch directive/u);
});

test('factory binds one journal activation store and separate barriers', () => {
  const constructed = [];
  class Store { constructor(options) { this.options = options; constructed.push(['journal', options]); } read() { return null; } }
  class Activation { constructor(options) { this.options = options; constructed.push(['activation', options]); } plan() {} }
  class Barrier { constructor(options) { this.options = options; constructed.push(['barrier', options]); } }
  const runtime = createMainProfileSwitchRuntime({
    directory: { withCandidate: () => {} },
    userData: '/user-data',
    journalFile: '/user-data/global/switch.json',
    activeAuthority: { profile: {}, layout: {}, account: {}, workspaceState: {} },
    startupEffects: { mode: 'startup' },
    liveEffects: { mode: 'live' },
    getEngineGeneration: () => null,
    JournalStoreClass: Store,
    ActivationStoreClass: Activation,
    BarrierClass: Barrier,
    DirectoryClass: class { constructor() { throw new Error('explicit directory must win'); } },
    SwitchRuntimeClass: FakeSwitchRuntime,
  });
  assert.equal(runtime instanceof MainProfileSwitchRuntime, true);
  assert.deepEqual(constructed, [
    ['journal', { filePath: '/user-data/global/switch.json' }],
    ['activation', { userData: '/user-data' }],
    ['barrier', { mode: 'startup' }],
    ['barrier', { mode: 'live' }],
  ]);
});

test('live switching observes credential revisions without replacing startup recovery identity', () => {
  FakeSwitchRuntime.instances = [];
  const authority = {
    profile: { profileId: 'hkustgz', profileRevision: 1, profileCredentialBindingRevision: 1 },
    layout: { identity: { profileKey: 'profile-key' } },
    account: { accountKey: 'account-key', accountRevision: 1,
      accountCredentialRevision: 1, workspaceKey: 'workspace-key' },
    workspaceState: { activeContextEpoch: 3 },
  };
  let live = authority;
  let reads = 0;
  createMainProfileSwitchRuntime({
    directory: { withCandidate() {} }, userData: '/synthetic', journalFile: '/synthetic/switch',
    activeAuthority: authority,
    getLiveAuthority: () => { reads++; return live; },
    startupEffects: {}, liveEffects: {}, getEngineGeneration: () => null,
    JournalStoreClass: class { read() { return null; } },
    ActivationStoreClass: class { plan() {} }, BarrierClass: class {},
    SwitchRuntimeClass: FakeSwitchRuntime,
  });
  const [startup, runtime] = FakeSwitchRuntime.instances;
  assert.equal(reads, 0, 'construction must not require initialized persistence');
  assert.equal(startup.options.getActivePersistentContext().accountCredentialRevision, 1);
  assert.equal(reads, 0, 'startup recovery must use pre-ready identity');
  live = { ...authority, account: { ...authority.account, accountCredentialRevision: 3 } };
  assert.equal(runtime.options.getActivePersistentContext().accountCredentialRevision, 3);
  assert.equal(reads, 1);
  live = { ...live, account: { ...live.account, accountKey: 'different-account' } };
  assert.throws(() => runtime.options.getActivePersistentContext(), /identity/u);
});
