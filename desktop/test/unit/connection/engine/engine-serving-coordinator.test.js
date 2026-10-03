'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { EngineServingCoordinator, EngineConnectionRuntime } = require('../../../../lib/connection/engine/engine-connection-runtime');
const { ConnectionStateMachine } = require('../../../../lib/connection/state/connection-state-machine');

function fixture({ suspended = false } = {}) {
  const machine = new ConnectionStateMachine();
  const intent = machine.beginConnectIntent();
  machine.beginConnectAttempt(intent);
  machine.bindEngineGeneration(7);
  machine.markEnginePhase(7, 'preparing_tunnel');
  let current = true, translate = key => `initial:${key}`, resolveActivation, rejectActivation;
  const calls = [], presentation = { lastError: null, browserNotice: null };
  const browser = {
    routingSuspended: suspended,
    resumeRoutingPolicy: port => {
      calls.push(['resume', port]);
      return new Promise((resolve, reject) => { resolveActivation = resolve; rejectActivation = reject; });
    },
  };
  const serving = new EngineServingCoordinator({
    getGeneration: () => 7, port: 6180, connectionState: machine,
    getBrowser: () => browser, getPresentation: () => presentation, getTranslator: () => translate,
    isCurrent: generation => generation === 7 && current,
    emit: () => calls.push(['emit']), appendDiagnostic: text => calls.push(['diagnostic', text]),
    revokeServing: () => { calls.push(['revoke']); return machine.markEngineStopping(7, { uptimeMs: 0 }); },
    stopEngine: () => { calls.push(['stop']); return Promise.resolve(); },
    observeCapabilities: report => { calls.push(['capabilities', report]); return true; },
    onFirstConnected: () => calls.push(['first-connected']),
  });
  return { machine, serving, presentation, calls,
    stale: () => { current = false; }, translate: value => { translate = value; },
    resolve: () => resolveActivation(), reject: () => rejectActivation(new Error('synthetic gate failure')) };
}

function ready(f, listenerFirst = false) {
  const handlers = f.serving.handlers;
  const first = listenerFirst ? 'onListenerReady' : 'onConnectionCandidate';
  const second = listenerFirst ? 'onConnectionCandidate' : 'onListenerReady';
  handlers[first]();
  assert.equal(f.machine.isConnected(), false);
  handlers[second]();
}

test('serving coordinator stays within the bounded runtime module', () => {
  const source = fs.readFileSync(require.resolve('../../../../lib/connection/engine/engine-connection-runtime'), 'utf8');
  assert(source.trimEnd().split('\n').length <= 600);
});

test('both readiness signals are required in either order and telemetry starts once', () => {
  for (const listenerFirst of [false, true]) {
    const f = fixture();
    ready(f, listenerFirst);
    assert.equal(f.machine.isConnected(), true);
    f.serving.markConnected();
    assert.equal(f.calls.filter(([name]) => name === 'first-connected').length, 1);
    assert.equal(f.calls.some(([name]) => name === 'resume'), false);
  }
});

test('browser activation is single-flight and gates connection promotion', async () => {
  const f = fixture({ suspended: true });
  ready(f);
  f.serving.markConnected();
  assert.equal(f.machine.isConnected(), false);
  assert.deepEqual(f.calls, [['resume', 6180]]);
  f.resolve();
  await new Promise(setImmediate);
  assert.equal(f.machine.isConnected(), true);
  assert.equal(f.serving.browserActivationInFlight, null);
});

test('late activation from an invalid context cannot promote or publish', async () => {
  for (const reject of [false, true]) {
    const f = fixture({ suspended: true });
    ready(f); f.stale();
    if (reject) f.reject(); else f.resolve();
    await new Promise(setImmediate);
    assert.equal(f.machine.isConnected(), false);
    assert.deepEqual(f.calls, [['resume', 6180]]);
    assert.equal(f.presentation.browserNotice, null);
  }
});

test('current browser activation failure preserves existing connected-but-browser-degraded behavior', async () => {
  const f = fixture({ suspended: true });
  ready(f); f.reject();
  await new Promise(setImmediate);
  assert.equal(f.machine.isConnected(), true);
  assert.equal(f.presentation.browserNotice, 'initial:error.browserRoutingAfterSave');
  assert.equal(f.calls.filter(([name]) => name === 'first-connected').length, 1);
});

test('activation failure cannot publish into a context retired during connected promotion', async () => {
  const f = fixture({ suspended: true });
  f.serving.onFirstConnected = () => { f.stale(); f.machine.beginStop(false); };
  ready(f);
  f.reject();
  await new Promise(setImmediate);
  assert.equal(f.presentation.browserNotice, null);
  assert.equal(f.calls.filter(([name]) => name === 'emit').length, 1);
});

test('fatal and listener failures revoke serving before requesting stop', async () => {
  for (const [handler, code, stops] of [
    ['onListenerMismatch', 'LOCAL_LISTENER_FAILED', true],
    ['onProtocolTimeout', 'EVENT_OUTPUT_FAILED', true],
    ['onFatalError', 'AUTH_FAILED', false],
  ]) {
    const f = fixture();
    f.translate(key => `new:${key}`);
    f.serving.handlers[handler]('AUTH_FAILED');
    assert.equal(f.serving.fatalCode, code);
    assert.equal(f.calls[0][0], 'revoke');
    assert.equal(f.calls.some(([name]) => name === 'stop'), stops);
    assert.match(f.presentation.lastError, /^new:/);
    await Promise.resolve();
  }
});

test('diagnostic tail remains bounded and stale diagnostics cannot update presentation', () => {
  const f = fixture();
  f.stale();
  f.serving.applyHumanDiagnostic('x'.repeat(800));
  assert.equal(f.serving.diagnosticTail.length, 512);
  assert.equal(f.presentation.lastError, null);
  assert.deepEqual(f.calls, []);
});

test('protocol admission and exit drain stay authoritative over extracted serving handlers', () => {
  const f = fixture();
  const runtime = new EngineConnectionRuntime({ generation: 7, contextToken: {}, expectedPort: 6180,
    stdin: {}, controlRegistry: { bind: () => ({ feed() {} }) },
    isCurrent: generation => generation === 7, handlers: f.serving.handlers });
  const feed = (...events) => runtime.feed(Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + '\n'));
  feed({ type: 'state_changed', state: 'connected', generation: 7 });
  assert.equal(f.machine.isConnected(), false);
  feed({ type: 'hello', apiVersion: 1, capabilities: ['password', 'l3'] },
    { type: 'state_changed', state: 'connected', generation: 8 },
    { type: 'listener_ready', port: 6180 });
  assert.equal(f.machine.isConnected(), false);
  feed({ type: 'state_changed', state: 'connected', generation: 7 });
  assert.equal(f.machine.isConnected(), true);
  runtime.beginExitDrain();
  f.calls.length = 0;
  feed({ type: 'dns_mode', mode: 'gateway' }, { type: 'fatal_error', code: 'AUTH_FAILED' });
  assert.equal(f.presentation.dnsMode, undefined);
  assert.equal(f.serving.fatalCode, 'AUTH_FAILED');
  runtime.dispose();
});
