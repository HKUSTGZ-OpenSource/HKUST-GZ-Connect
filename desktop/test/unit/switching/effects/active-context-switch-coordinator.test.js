'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  ActiveContextSwitchCoordinator,
} = require('../../../../lib/switching/effects/active-context-switch-coordinator');
const {
  commitActiveContextSwitch,
  createPreparedActiveContextSwitch,
  markActiveContextSwitchReady,
} = require('../../../../lib/switching/active-context/active-context-switch-journal');
const {
  ActiveContextSwitchJournalStore,
} = require('../../../../lib/switching/active-context/active-context-switch-store');

function key(name, seed) { return `${name}-${String(seed).repeat(32)}`; }

function context(profileId, profileSeed, accountSeed, workspaceSeed, epoch = 1) {
  return {
    profileId,
    profileKey: key('profile', profileSeed),
    profileRevision: 1,
    profileCredentialBindingRevision: 1,
    accountKey: key('account', accountSeed),
    accountRevision: 1,
    accountCredentialRevision: 1,
    workspaceKey: key('workspace', workspaceSeed),
    activeContextEpoch: epoch,
  };
}

function receipt(seed) {
  return { present: true, bytes: seed + 100, sha256: seed.toString(16).padStart(64, '0') };
}

function activation(seed) {
  return {
    globalSettings: { before: receipt(seed), after: receipt(seed + 1) },
    destinationWorkspace: { before: receipt(seed + 2), after: receipt(seed + 3) },
  };
}

function activationState(value, state) {
  return {
    globalSettings: value.globalSettings[state],
    destinationWorkspace: value.destinationWorkspace[state],
  };
}

function activationFromStates(before, after) {
  return {
    globalSettings: { before: before.globalSettings, after: after.globalSettings },
    destinationWorkspace: {
      before: before.destinationWorkspace,
      after: after.destinationWorkspace,
    },
  };
}

function switchRequest(overrides = {}) {
  return {
    from: context('school-a', '1', '2', '3', 3),
    to: context('school-b', '4', '5', '6', 1),
    engineGeneration: 8,
    activation: activation(1),
    randomBytes: () => Buffer.alloc(16, 0xaa),
    now: () => 1_700_000_000_000,
    ...overrides,
  };
}

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'active-context-coordinator-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new ActiveContextSwitchJournalStore({
    filePath: path.join(root, 'global', 'active-context-switch.json'),
  });
  let currentReceipt = overrides.currentReceipt || activationState(activation(1), 'before');
  const calls = [];
  const outcomes = {
    gateBrowser: true,
    validateSource: true,
    cancelContinuations: true,
    closeBrowserWorkspace: true,
    stopEngine: true,
    revokeProxyAccess: true,
    clearServerState: true,
    validateDestination: true,
    activateRuntime: true,
    ...overrides.outcomes,
  };
  const operation = (name) => async (journal) => {
    calls.push([name, journal.state, journal.switchId]);
    const value = outcomes[name];
    return typeof value === 'function' ? value(journal) : value;
  };
  const coordinator = new ActiveContextSwitchCoordinator({
    journalStore: store,
    readActivationReceipt: () => currentReceipt,
    applyActivation: async (journal) => {
      calls.push(['applyActivation', journal.state, journal.switchId]);
      const value = outcomes.applyActivation;
      if (typeof value === 'function') return value(journal, (next) => { currentReceipt = next; });
      if (value === false) return false;
      currentReceipt = activationState(journal.activation, 'after');
      return true;
    },
    gateBrowser: operation('gateBrowser'),
    validateSource: operation('validateSource'),
    cancelContinuations: operation('cancelContinuations'),
    closeBrowserWorkspace: operation('closeBrowserWorkspace'),
    stopEngine: operation('stopEngine'),
    revokeProxyAccess: operation('revokeProxyAccess'),
    clearServerState: operation('clearServerState'),
    validateDestination: operation('validateDestination'),
    activateRuntime: operation('activateRuntime'),
    markReady: (journal) => markActiveContextSwitchReady(journal, {
      now: () => journal.createdAt + 100,
    }),
    commit: (journal) => commitActiveContextSwitch(journal, {
      now: () => journal.readyAt + 100,
    }),
  });
  return {
    store,
    coordinator,
    calls,
    receipt: () => currentReceipt,
    setReceipt: (value) => { currentReceipt = value; },
    outcomes,
  };
}

test('clean switch gates old context before one activation and clears its journal', async (t) => {
  const value = fixture(t);
  const result = await value.coordinator.begin(switchRequest());
  assert.deepEqual(result, {
    ok: true,
    status: 'activated',
    switchId: `switch-${'aa'.repeat(16)}`,
    kind: 'profile',
    activeContextEpoch: 4,
  });
  assert.deepEqual(value.calls.map(([name]) => name), [
    'gateBrowser',
    'validateSource',
    'cancelContinuations',
    'closeBrowserWorkspace',
    'stopEngine',
    'revokeProxyAccess',
    'clearServerState',
    'validateDestination',
    'applyActivation',
    'activateRuntime',
  ]);
  assert.deepEqual(value.receipt(), activationState(activation(1), 'after'));
  assert.equal(value.store.read(), null);
});

test('failed cleanup leaves prepared authority gated and a later recovery resumes idempotently', async (t) => {
  const value = fixture(t, { outcomes: { stopEngine: false } });
  await assert.rejects(value.coordinator.begin(switchRequest()), (error) => (
    error.code === 'ACTIVE_CONTEXT_SWITCH_ENGINE_STOP_FAILED'
  ));
  assert.equal(value.store.read().state, 'prepared');
  assert.deepEqual(value.receipt(), activationState(activation(1), 'before'));
  assert.equal(value.calls.some(([name]) => name === 'applyActivation'), false);

  value.outcomes.stopEngine = true;
  const recovered = await value.coordinator.recover();
  assert.equal(recovered.status, 'activated');
  assert.equal(value.calls.filter(([name]) => name === 'gateBrowser').length, 2);
  assert.equal(value.store.read(), null);
});

test('unconfirmed Browser close keeps Engine and Profile cleanup behind the Browser barrier', async (t) => {
  const value = fixture(t, { outcomes: { closeBrowserWorkspace: false } });
  await assert.rejects(value.coordinator.begin(switchRequest()), (error) => (
    error.code === 'ACTIVE_CONTEXT_SWITCH_BROWSER_CLOSE_FAILED'
  ));

  assert.equal(value.store.read().state, 'prepared');
  assert.deepEqual(value.receipt(), activationState(activation(1), 'before'));
  assert.deepEqual(value.calls.map(([name]) => name), [
    'gateBrowser',
    'validateSource',
    'cancelContinuations',
    'closeBrowserWorkspace',
  ]);
  assert.equal(value.calls.some(([name]) => name === 'stopEngine'), false);
  assert.equal(value.calls.some(([name]) => name === 'revokeProxyAccess'), false);
  assert.equal(value.calls.some(([name]) => name === 'clearServerState'), false);
  assert.equal(value.calls.some(([name]) => name === 'applyActivation'), false);
});

test('ready journal recovers both before-activation and after-activation crash points', async (t) => {
  for (const alreadyApplied of [false, true]) {
    const requestedActivation = activation(1);
    const value = fixture(t, {
      currentReceipt: activationState(
        requestedActivation,
        alreadyApplied ? 'after' : 'before',
      ),
    });
    const prepared = createPreparedActiveContextSwitch(switchRequest());
    const ready = markActiveContextSwitchReady(prepared, { now: () => 1_700_000_000_100 });
    value.store.prepare(prepared);
    value.store.markReady(ready);
    const result = await value.coordinator.recover();
    assert.equal(result.status, 'activated');
    assert.equal(
      value.calls.filter(([name]) => name === 'applyActivation').length,
      alreadyApplied ? 0 : 1,
    );
    assert.equal(value.calls.some(([name]) => name === 'gateBrowser'), false);
    assert.equal(value.store.read(), null);
  }
});

test('mixed two-file activation is resumed as redo instead of becoming ambiguous', async (t) => {
  const requestedActivation = activation(1);
  const value = fixture(t, {
    currentReceipt: {
      globalSettings: requestedActivation.globalSettings.after,
      destinationWorkspace: requestedActivation.destinationWorkspace.before,
    },
  });
  const prepared = createPreparedActiveContextSwitch(switchRequest());
  const ready = markActiveContextSwitchReady(prepared, { now: () => 1_700_000_000_100 });
  value.store.prepare(prepared);
  value.store.markReady(ready);
  assert.equal((await value.coordinator.recover()).status, 'activated');
  assert.equal(value.calls.filter(([name]) => name === 'applyActivation').length, 1);
  assert.deepEqual(value.receipt(), activationState(requestedActivation, 'after'));
});

test('activation callback uncertainty remains ready and recovery proves the visible receipt', async (t) => {
  const value = fixture(t, {
    outcomes: {
      applyActivation(journal, setReceipt) {
        setReceipt(activationState(journal.activation, 'after'));
        throw new Error('synthetic crash after activation rename');
      },
    },
  });
  await assert.rejects(value.coordinator.begin(switchRequest()), (error) => (
    error.code === 'ACTIVE_CONTEXT_SWITCH_ACTIVATION_FAILED'
  ));
  assert.equal(value.store.read().state, 'ready');
  assert.deepEqual(value.receipt(), activationState(activation(1), 'after'));
  assert.equal(value.calls.some(([name]) => name === 'activateRuntime'), false);
  value.outcomes.applyActivation = true;
  assert.equal((await value.coordinator.recover()).status, 'activated');
});

test('committed recovery requires new authority before clearing and runtime activation', async (t) => {
  const value = fixture(t, { currentReceipt: activationState(activation(1), 'after') });
  const prepared = createPreparedActiveContextSwitch(switchRequest());
  const ready = markActiveContextSwitchReady(prepared, { now: () => 1_700_000_000_100 });
  const committed = commitActiveContextSwitch(ready, { now: () => 1_700_000_000_200 });
  value.store.prepare(prepared);
  value.store.markReady(ready);
  value.store.commit(committed);
  assert.equal((await value.coordinator.recover()).status, 'activated');
  assert.deepEqual(value.calls.map(([name]) => name), ['activateRuntime']);
  assert.equal(value.store.read(), null);
});

test('journal clear uncertainty keeps committed authority gated until recovery', async (t) => {
  const value = fixture(t);
  const clearCommitted = value.store.clearCommitted.bind(value.store);
  value.store.clearCommitted = () => { throw new Error('synthetic clear failure'); };
  await assert.rejects(value.coordinator.begin(switchRequest()), (error) => (
    error.code === 'ACTIVE_CONTEXT_SWITCH_CLEAR_FAILED'
  ));
  assert.equal(value.store.read().state, 'committed');
  assert.equal(value.calls.some(([name]) => name === 'activateRuntime'), false);
  value.store.clearCommitted = clearCommitted;
  assert.equal((await value.coordinator.recover()).status, 'activated');
});

test('ambiguous authority gates Browser but never cleans or activates either context', async (t) => {
  const value = fixture(t, {
    currentReceipt: { globalSettings: receipt(99), destinationWorkspace: receipt(100) },
  });
  const prepared = createPreparedActiveContextSwitch(switchRequest());
  value.store.prepare(prepared);
  await assert.rejects(value.coordinator.recover(), (error) => (
    error.code === 'ACTIVE_CONTEXT_SWITCH_AUTHORITY_MISMATCH'
  ));
  assert.deepEqual(value.calls.map(([name]) => name), ['gateBrowser']);
  assert.equal(value.store.read().state, 'prepared');
});

test('single-flight rejects a concurrent switch while the old Browser gate is pending', async (t) => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const value = fixture(t, {
    outcomes: { gateBrowser: async () => { await waiting; return true; } },
  });
  const first = value.coordinator.begin(switchRequest());
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(value.coordinator.recover(), (error) => (
    error.code === 'ACTIVE_CONTEXT_SWITCH_ALREADY_RUNNING'
  ));
  release();
  assert.equal((await first).status, 'activated');
});

test('100 alternating synthetic Profile switches retain one authority and no journal residue', async (t) => {
  const value = fixture(t);
  let active = context('school-a', '1', '2', '3', 1);
  const stored = {
    'school-a': active,
    'school-b': context('school-b', '4', '5', '6', 1),
  };
  let receiptSeed = 10;
  value.setReceipt({
    globalSettings: receipt(receiptSeed++),
    destinationWorkspace: receipt(receiptSeed++),
  });
  value.outcomes.activateRuntime = (journal) => {
    active = { ...journal.to, activeContextEpoch: journal.nextActiveContextEpoch };
    stored[active.profileId] = active;
    return true;
  };
  for (let index = 0; index < 100; index++) {
    const destinationId = active.profileId === 'school-a' ? 'school-b' : 'school-a';
    const nextReceipt = {
      globalSettings: receipt(receiptSeed++),
      destinationWorkspace: receipt(receiptSeed++),
    };
    const result = await value.coordinator.begin({
      from: active,
      to: stored[destinationId],
      nextActiveContextEpoch: index + 2,
      engineGeneration: index % 2 === 0 ? index + 1 : null,
      activation: activationFromStates(value.receipt(), nextReceipt),
    });
    assert.equal(result.activeContextEpoch, index + 2);
    assert.equal(active.profileId, destinationId);
    assert.equal(value.store.read(), null);
  }
  assert.equal(active.activeContextEpoch, 101);
  assert.equal(value.calls.filter(([name]) => name === 'activateRuntime').length, 100);
  assert.equal(value.calls.filter(([name]) => name === 'applyActivation').length, 100);
});
