'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { ConnectionOperationCoordinator, ConnectionStateMachine } =
  require('../../../../lib/connection/state/connection-state-machine');
const { stopEngineAfterBrowserSuspend } = require('../../../../lib/switching/effects/browser-engine-barrier');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const f = { quitting: false, active: false, generation: 1, trace: [], launches: 0,
    state: {}, fsm: new ConnectionStateMachine(), stopResult: { ok: true, cleanExit: true } };
  f.owner = new ConnectionOperationCoordinator({
    connectionState: f.fsm,
    engineSupervisor: {
      get hasActive() { return f.active; },
      isCurrent: generation => generation === f.generation,
      invalidate: () => { f.trace.push('invalidate'); f.generation += 1; },
    },
    isQuitting: () => f.quitting,
    cancelRecovery: () => f.trace.push('cancel-recovery'),
    clearProxyCredential: () => f.trace.push('clear-proxy'),
    clearPresentation: () => f.trace.push('clear-presentation'),
    removeSidecar: () => f.trace.push('remove-sidecar'),
    getPresentation: () => f.state, getTranslator: () => key => key,
    emit: () => f.trace.push('emit'),
    runAttempt: async (retry, intent) => {
      f.trace.push(['launch', retry, intent]); f.launches += 1;
      if (f.launchWait) await f.launchWait.promise;
      if (!f.fsm.canContinue(intent)) return { ok: false, stale: true };
      f.active = true;
      return { ok: true, generation: f.generation };
    },
    stopEngine: async () => {
      f.trace.push('stop');
      if (f.stopWait) await f.stopWait.promise;
      f.active = false;
      return f.stopResult;
    },
  });
  return f;
}

test('operation owner stays in the existing public state entrypoint below 600 lines', () => {
  const source = fs.readFileSync(require.resolve('../../../../lib/connection/state/connection-state-machine'), 'utf8');
  assert(source.trimEnd().split('\n').length <= 600);
});

test('simultaneous manual connects share one launch and intent', async () => {
  const f = fixture(); f.launchWait = deferred();
  const first = f.owner.connect(); const second = f.owner.connect();
  assert.equal(f.launches, 1);
  assert.equal(f.fsm.snapshot().intent, 1);
  f.launchWait.resolve();
  assert.deepEqual(await first, await second);
  assert.equal((await f.owner.connect()).existing, true);
  assert.equal(f.launches, 1);
});

test('manual operations cancel queued recovery before invalidating the old generation', async () => {
  const f = fixture(); await f.owner.connect(); f.trace.length = 0;
  await f.owner.disconnect();
  assert.deepEqual(f.trace.slice(0, 5), ['cancel-recovery', 'invalidate', 'clear-proxy', 'clear-presentation', 'emit']);
  assert(f.trace.indexOf('stop') > f.trace.indexOf('invalidate'));
  assert.equal(f.fsm.snapshot().desiredConnected, false);
});

test('a connect waits for pending stop drainage before creating its next intent', async () => {
  const f = fixture(); f.stopWait = deferred();
  const stopped = f.owner.disconnect(); const next = f.owner.connect();
  assert.equal(f.launches, 0);
  assert.equal(f.fsm.snapshot().intent, 1);
  f.stopWait.resolve();
  assert.equal((await stopped).ok, true);
  assert.equal((await next).ok, true);
  assert.equal(f.fsm.snapshot().intent, 2);
  assert.equal(f.launches, 1);
});

test('stopping is shared and removes the plaintext sidecar only after drainage', async () => {
  const f = fixture(); f.stopWait = deferred();
  const first = f.owner.ensureEngineStopped();
  assert.equal(f.owner.ensureEngineStopped(), first);
  assert.equal(f.trace.includes('remove-sidecar'), false);
  f.stopWait.resolve(); await first;
  assert.deepEqual(f.trace, ['stop', 'remove-sidecar']);
});

test('a failed Browser suspension closes its surface before releasing the Engine listener', async () => {
  const f = fixture();
  f.owner.stopEngine = () => stopEngineAfterBrowserSuspend({
    suspendBrowser: async () => { f.trace.push('suspend'); throw new Error('synthetic PAC failure'); },
    browserBoundaryClosed: () => false,
    closeBrowser: () => f.trace.push('close-browser'),
    stopEngine: async () => { f.trace.push('stop'); return { ok: true, cleanExit: true }; },
  });
  assert.equal((await f.owner.ensureEngineStopped()).ok, true);
  assert.deepEqual(f.trace, ['suspend', 'close-browser', 'stop', 'remove-sidecar']);
});

test('quit forbids a new connection and quit during pending stop forbids a delayed launch', async () => {
  const f = fixture(); f.quitting = true;
  assert.equal((await f.owner.connect()).quitting, true);
  assert.equal(f.launches, 0);
  f.quitting = false; f.stopWait = deferred();
  const stopped = f.owner.disconnect(); const next = f.owner.connect();
  f.quitting = true; f.stopWait.resolve(); await stopped;
  assert.equal((await next).quitting, true);
  assert.equal(f.launches, 0);
});

test('stale retry intents and health generations cannot connect or reconnect', async () => {
  const f = fixture(); const intent = f.fsm.beginConnectIntent(); f.fsm.beginStop(false);
  assert.equal((await f.owner.connect(true, intent)).stale, true);
  assert.equal((await f.owner.reconnect(999)).stale, true);
  assert.equal(f.launches, 0);
  assert.equal(f.trace.includes('stop'), false);
});

test('concurrent reconnects share stop and launch without duplicating the intent', async () => {
  const f = fixture(); await f.owner.connect(); f.stopWait = deferred();
  const first = f.owner.reconnect(); const second = f.owner.reconnect();
  assert.equal(f.fsm.snapshot().intent, 2);
  assert.equal(f.trace.filter(item => item === 'stop').length, 1);
  f.stopWait.resolve();
  assert.deepEqual(await first, await second);
  assert.equal(f.launches, 2);
});

test('quit or superseding disconnect while reconnect drains prevents a restart', async () => {
  for (const action of ['quit', 'disconnect']) {
    const f = fixture(); f.stopWait = deferred();
    const reconnect = f.owner.reconnect();
    let disconnect;
    if (action === 'quit') f.quitting = true;
    else disconnect = f.owner.disconnect();
    f.stopWait.resolve();
    assert.equal((await reconnect).ok, false);
    if (disconnect) await disconnect;
    assert.equal(f.launches, 0);
  }
});

test('failed or unconfirmed stop never restarts and publishes the distinct failure', async () => {
  for (const result of [{ ok: false }, { ok: true, cleanExit: false }]) {
    const f = fixture(); f.stopResult = result;
    assert.equal((await f.owner.reconnect()).ok, false);
    assert.equal(f.launches, 0);
    assert.equal(f.state.lastError, result.ok ? 'error.engineCleanupUnconfirmed' : 'error.engineStuck');
    assert.equal(f.fsm.snapshot().desiredConnected, false);
  }
});

test('a retired disconnect cannot overwrite the newer operation presentation', async () => {
  const f = fixture(); f.stopWait = deferred(); f.stopResult = { ok: false };
  const pending = f.owner.disconnect(); f.fsm.beginConnectIntent();
  f.state.lastError = 'new-operation-notice';
  f.stopWait.resolve(); await pending;
  assert.equal(f.state.lastError, 'new-operation-notice');
});
