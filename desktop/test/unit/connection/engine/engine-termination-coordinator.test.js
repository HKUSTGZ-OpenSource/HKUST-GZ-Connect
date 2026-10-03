'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EngineTerminationCoordinator } = require('../../../../lib/connection/engine/engine-connection-runtime');
const { cleanupProxyAccessForEngineClose } = require('../../../../lib/persistence/credentials/proxy-credential');
const { CONNECTION_PHASE, ConnectionStateMachine } = require('../../../../lib/connection/state/connection-state-machine');

function fixture({ connected = false, settings = {} } = {}) {
  const machine = new ConnectionStateMachine();
  const intent = machine.beginConnectIntent();
  machine.beginConnectAttempt(intent);
  machine.bindEngineGeneration(7);
  if (connected) {
    machine.markEnginePhase(7, 'preparing_tunnel');
    machine.recordEngineConnectedCandidate(7); machine.recordListenerReady(7); machine.markConnected(7);
  }
  const calls = [], presentation = { lastError: null, browserNotice: null };
  let generation = 7, connectedAt = connected ? 1000 : null;
  const owner = new EngineTerminationCoordinator({
    connectionState: machine, isGenerationCurrent: value => value === generation,
    scheduleRetry: (...args) => calls.push(['schedule', ...args]),
    getPresentation: () => presentation, getConnectedAt: () => connectedAt,
    getTranslator: () => key => key, now: () => 31_000,
    clearControl: value => calls.push(['control', value]),
    cleanupProxyAccess: cleanupProxyAccessForEngineClose,
    clearCredential: value => calls.push(['credential', value]),
    removeSidecar: () => calls.push(['sidecar']),
    suspendBrowser: () => { calls.push(['suspend']); return Promise.resolve(); },
    clearPresentation: () => { calls.push(['clear']); connectedAt = null; },
    loadSettings: () => { calls.push(['settings']); if (settings instanceof Error) throw settings; return settings; },
    reportSettingsReadFailure: (error, options) => calls.push(['settings-error', error, options]),
    emit: () => calls.push(['emit']), connect: (...args) => calls.push(['connect', ...args]),
  });
  return { owner, machine, calls, presentation, intent, replaceGeneration: value => { generation = value; } };
}

test('stale process or context close cannot revoke the current shared proxy boundary', () => {
  for (const staleContext of [false, true]) {
    const f = fixture();
    if (!staleContext) f.replaceGeneration(8);
    f.owner.close({ code: 1, generation: 7 }, '', null, null, 6180, () => !staleContext);
    assert.deepEqual(f.calls, [['control', 7], ['credential', 7]]);
    assert.equal(f.machine.snapshot().engineGeneration, 7);
  }
});

test('a retired FSM generation also protects shared sidecars from delayed close', () => {
  const f = fixture();
  f.machine.invalidateEngineGeneration();
  f.owner.close({ code: 1, generation: 7 }, '');
  assert.deepEqual(f.calls, [['control', 7], ['credential', 7]]);
});

test('exit revokes serving before cleanup and close retains stable-session retry evidence', () => {
  const f = fixture({ connected: true });
  f.owner.exit({ generation: 7 });
  assert.deepEqual(f.calls.slice(0, 5), [['suspend'], ['clear'], ['control', 7], ['credential', 7], ['sidecar']]);
  assert.equal(f.machine.snapshot().phase, 'stopping');
  assert.equal(f.machine.snapshot().engineGeneration, 7);
  assert.equal(f.machine.snapshot().connectedUptimeBeforeStop, 30_000);
  f.calls.length = 0;
  f.owner.close({ code: 1, generation: 7 }, '', null, 'network_unhealthy', 6180);
  assert.equal(f.machine.snapshot().phase, CONNECTION_PHASE.RETRY_WAIT);
  assert.equal(f.presentation.failureKind, 'gateway-transient');
  assert.equal(f.presentation.lastError, 'error.reconnecting');
  const retry = f.calls.find(([name]) => name === 'schedule');
  assert.deepEqual(retry.slice(0, 3), ['schedule', 7, 5000]);
  retry[3]();
  assert.deepEqual(f.calls.at(-1), ['connect', true, f.intent]);
});

test('terminal structured failure overrides retryable diagnostics and never schedules retry', () => {
  const f = fixture();
  f.owner.close({ code: 1, generation: 7 }, 'modern receive TLS: failed', 'AUTH_FAILED', 'network_unhealthy');
  assert.equal(f.presentation.failureKind, 'terminal');
  assert.equal(f.presentation.failureCode, 'AUTH_FAILED');
  assert.equal(f.machine.snapshot().phase, 'idle');
  assert.equal(f.machine.snapshot().desiredConnected, false);
  assert.equal(f.calls.some(([name]) => name === 'schedule'), false);
});

test('unreadable retry settings settle fail-closed after revocation', () => {
  const failure = new Error('synthetic settings unavailable');
  const f = fixture({ settings: failure });
  f.owner.close({ code: 1, generation: 7 }, '');
  assert.equal(f.machine.snapshot().phase, 'idle');
  assert.equal(f.machine.snapshot().desiredConnected, false);
  assert.deepEqual(f.calls.find(([name]) => name === 'settings-error'), ['settings-error', failure, { emitState: false }]);
  assert.equal(f.calls.some(([name]) => name === 'schedule'), false);
  assert(f.calls.findIndex(([name]) => name === 'suspend') < f.calls.findIndex(([name]) => name === 'settings'));
});

test('disabled or exhausted automatic retry remains stopped', () => {
  for (const settings of [{ autoReconnect: false }, { maxAttempts: 0 }]) {
    const f = fixture({ settings });
    f.owner.close({ code: 1, generation: 7 }, '', null, 'network_unhealthy');
    assert.equal(f.machine.snapshot().desiredConnected, false);
    assert.equal(f.presentation.lastError, 'error.gatewayRejected');
    assert.equal(f.calls.some(([name]) => name === 'schedule'), false);
  }
});

test('revocation rejects stale generation and context before any side effect', () => {
  const f = fixture({ connected: true });
  assert.equal(f.owner.revokeServing(6), false);
  assert.equal(f.owner.revokeServing(7, () => false), false);
  assert.deepEqual(f.calls, []);
  assert.equal(f.machine.isConnected(), true);
});

test('late Browser suspension errors cannot publish after generation context or intent retirement', async () => {
  for (const action of ['close', 'revokeServing']) {
    for (const retirement of ['generation', 'context', 'intent']) {
      const f = fixture({ connected: true });
      let reject, current = true;
      f.owner.suspendBrowser = () => new Promise((_resolve, fail) => { reject = fail; });
      const contextCurrent = () => current;
      if (action === 'close') f.owner.close({ code: 1, generation: 7 }, '', null, 'network_unhealthy', 6180, contextCurrent);
      else f.owner.revokeServing(7, contextCurrent);
      const emissions = f.calls.filter(([name]) => name === 'emit').length;
      if (retirement === 'generation') f.replaceGeneration(8);
      else if (retirement === 'context') current = false;
      else f.machine.beginStop(false);
      reject(new Error('synthetic delayed policy failure'));
      await new Promise(setImmediate);
      assert.equal(f.presentation.browserNotice, null, `${action}/${retirement}`);
      assert.equal(f.calls.filter(([name]) => name === 'emit').length, emissions);
    }
  }
});

test('a current Browser suspension failure retains its actionable notice', async () => {
  const f = fixture({ connected: true });
  f.owner.suspendBrowser = () => Promise.reject(new Error('synthetic current policy failure'));
  f.owner.revokeServing(7);
  await new Promise(setImmediate);
  assert.equal(f.presentation.browserNotice, 'error.browserRoutingAfterSave');
});
