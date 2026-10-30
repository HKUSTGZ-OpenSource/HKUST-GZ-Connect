'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ProfileSwitchRuntime } = require('../../../../lib/switching/runtime/profile-switch-runtime');

function context(profileId, seed, epoch) {
  return Object.freeze({
    profileId,
    profileKey: `profile-${seed.repeat(32)}`,
    profileRevision: 1,
    profileCredentialBindingRevision: 1,
    accountKey: `account-${seed.repeat(32)}`,
    accountRevision: 1,
    accountCredentialRevision: 1,
    workspaceKey: `workspace-${seed.repeat(32)}`,
    activeContextEpoch: epoch,
  });
}

class CapturingSystem {
  constructor(options) {
    this.options = options;
    this.requests = [];
    this.recoveries = 0;
    CapturingSystem.instance = this;
  }
  begin(request) { this.requests.push(request); return Promise.resolve({ ok: true, status: 'activated' }); }
  recover() { this.recoveries += 1; return Promise.resolve({ ok: true, status: 'none' }); }
}

function fixture({ recoveryOnly = false } = {}) {
  const from = context('hkustgz', '1', 7);
  const to = context(`custom-${'a'.repeat(32)}`, '2', 2);
  let active = from;
  const records = new Map([
    [from.profileId, { context: from, kind: 'builtin-reviewed' }],
    [to.profileId, { context: to, kind: 'custom-local' }],
  ]);
  const activations = [];
  const activated = [];
  const directory = {
    withCandidate(profileId, callback) {
      const record = records.get(profileId);
      if (!record) throw new Error('candidate unavailable');
      return callback(record);
    },
  };
  const runtime = new ProfileSwitchRuntime({
    recoveryOnly,
    directory,
    journalStore: {},
    activationStore: {
      plan(request) {
        activations.push(request);
        return {
          globalSettings: {
            before: { present: true, bytes: 2, sha256: '1'.repeat(64) },
            after: { present: true, bytes: 3, sha256: '2'.repeat(64) },
          },
          destinationWorkspace: {
            before: { present: true, bytes: 2, sha256: '3'.repeat(64) },
            after: { present: true, bytes: 3, sha256: '4'.repeat(64) },
          },
        };
      },
    },
    barrier: {},
    getActivePersistentContext: () => active,
    getEngineGeneration: () => 19,
    activateRuntime: (record, journal) => {
      activated.push([record, journal]);
      active = { ...record.context, activeContextEpoch: journal.nextActiveContextEpoch };
      return true;
    },
    SwitchSystemClass: CapturingSystem,
  });
  return { runtime, from, to, records, activations, activated, get active() { return active; } };
}

test('switch request binds exact candidates Engine generation epoch and activation receipts', async () => {
  const f = fixture();
  assert.deepEqual(await f.runtime.switchTo(f.to.profileId), { ok: true, status: 'activated' });
  assert.equal(f.activations.length, 1);
  assert.deepEqual(f.activations[0], {
    from: f.from,
    to: f.to,
    nextActiveContextEpoch: 8,
  });
  const request = CapturingSystem.instance.requests[0];
  assert.equal(request.from, f.from);
  assert.equal(request.to, f.to);
  assert.equal(request.nextActiveContextEpoch, 8);
  assert.equal(request.engineGeneration, 19);
  assert.deepEqual(Object.keys(request.activation).sort(), [
    'destinationWorkspace', 'globalSettings',
  ]);
  assert.deepEqual(await f.runtime.recover(), { ok: true, status: 'none' });
});

test('startup recovery accepts only a forward source credential revision in the same context', () => {
  const f = fixture({ recoveryOnly: true });
  const validate = CapturingSystem.instance.options.validateSource;
  const journal = { state: 'prepared', from: { ...f.from, accountCredentialRevision: 1 }, to: f.to };
  // Simulate the validated pre-ready authority and directory after a credential commit.
  f.runtime.getActivePersistentContext = () => ({ ...f.from, accountCredentialRevision: 3 });
  f.records.set(f.from.profileId, { context: { ...f.from, accountCredentialRevision: 3 } });
  assert.equal(validate(journal), true);
  assert.throws(() => f.runtime.switchTo(f.to.profileId), /recovery/u);
  for (const key of Object.keys(f.from).filter(key => key !== 'accountCredentialRevision')) {
    const value = typeof f.from[key] === 'number' ? f.from[key] + 1 : `${f.from[key]}-changed`;
    assert.equal(validate({ ...journal, from: { ...journal.from, [key]: value } }), false, key);
  }
  assert.equal(validate({ ...journal, from: { ...journal.from, accountCredentialRevision: 4 } }), false);
  assert.equal(validate({ ...journal, state: 'ready' }), false);
  f.records.set(f.from.profileId, { context: { ...f.from, accountCredentialRevision: 4 } });
  assert.equal(validate(journal), false, 'directory and fresh authority must agree exactly');
});

test('live switching does not accept a stale source credential revision', () => {
  const f = fixture();
  const validate = CapturingSystem.instance.options.validateSource;
  f.runtime.getActivePersistentContext = () => ({ ...f.from, accountCredentialRevision: 3 });
  f.records.set(f.from.profileId, { context: { ...f.from, accountCredentialRevision: 3 } });
  assert.equal(validate({ state: 'prepared', from: f.from, to: f.to }), false);
});

test('coordinator callbacks revalidate source destination and activate only the journal target', () => {
  const f = fixture();
  const system = CapturingSystem.instance;
  const journal = { from: f.from, to: f.to, nextActiveContextEpoch: 8 };
  assert.equal(system.options.validateSource(journal), true);
  assert.equal(system.options.validateDestination(journal), true);
  assert.equal(system.options.activateRuntime(journal), true);
  assert.equal(f.activated.length, 1);
  assert.equal(f.active.profileId, f.to.profileId);

  const stale = { ...journal, from: { ...f.from, activeContextEpoch: 6 } };
  assert.equal(system.options.validateSource(stale), false);
  const drift = { ...journal, to: { ...f.to, accountRevision: 2 } };
  assert.equal(system.options.validateDestination(drift), false);
});

test('same Profile unknown destination and invalid Engine generation fail before a journal begins', () => {
  const f = fixture();
  assert.throws(() => f.runtime.switchTo(f.from.profileId), /already active/u);
  assert.throws(() => f.runtime.switchTo('custom-missing'), /unavailable/u);
  const invalid = new ProfileSwitchRuntime({
    directory: { withCandidate: (_id, callback) => callback({ context: f.to }) },
    journalStore: {}, activationStore: { plan: () => ({}) }, barrier: {},
    getActivePersistentContext: () => f.from,
    getEngineGeneration: () => 0,
    activateRuntime: () => true,
    SwitchSystemClass: CapturingSystem,
  });
  assert.throws(() => invalid.switchTo(f.to.profileId), /Engine generation/u);
  assert.equal(CapturingSystem.instance.requests.length, 0);
});
