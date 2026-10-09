'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { ConnectionOperationCoordinator, ConnectionStateMachine } =
  require('../../../../lib/connection/state/connection-state-machine');
const { stopEngineAfterBrowserSuspend } = require('../../../../lib/switching/effects/browser-engine-barrier');
const { desktopRuntimeComposition: { ActiveContextLease } } = require('../../../../lib/app/desktop-runtime-composition');
const { ConnectivityRecovery } = require('../../../../lib/connection/recovery/connectivity-recovery');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const f = { quitting: false, active: false, generation: 1, trace: [], launches: 0,
    state: {}, fsm: new ConnectionStateMachine(), stopResult: { ok: true, cleanExit: true },
    settings: { autoReconnect: true }, settingsReads: 0,
    browserWaitResult: true, browserWaits: [] };
  f.owner = new ConnectionOperationCoordinator({
    connectionState: f.fsm,
    engineSupervisor: {
      get hasActive() { return f.active; },
      isCurrent: generation => generation === f.generation,
      invalidate: () => { f.trace.push('invalidate'); f.generation += 1; },
    },
    isQuitting: () => f.quitting,
    loadSettingsOrReport: () => {
      f.settingsReads += 1;
      if (f.settingsErrors?.[f.settingsReads - 1]) throw f.settingsErrors[f.settingsReads - 1];
      if (f.settingsError) throw f.settingsError;
      return f.settings;
    },
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
    waitForConnected: async intent => {
      f.browserWaits.push(intent);
      return f.browserWaitResult;
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

function contextFixture() {
  const f = fixture();
  f.lease = new ActiveContextLease({ profileId: 'hkustgz', profileRevision: 1,
    accountHandle: `account-${'a'.repeat(36)}`, activeContextEpoch: 1 });
  f.owner.contextLease = f.lease;
  f.intent = f.fsm.beginConnectIntent();
  f.fsm.bindEngineGeneration(f.generation);
  f.token = f.lease.capture({ connectionIntent: f.intent, engineGeneration: f.generation });
  return f;
}

test('owned Engine admission binds the actual opaque context intent and generation', () => {
  for (const retirement of ['live', 'generation', 'intent', 'context', 'foreign-token', 'context-only']) {
    const f = contextFixture(); let token = f.token;
    if (retirement === 'generation') f.generation++;
    if (retirement === 'intent') f.fsm.beginConnectIntent();
    if (retirement === 'context') f.lease.invalidate();
    if (retirement === 'foreign-token') token = {};
    if (retirement === 'context-only') token = f.lease.captureContext();
    assert.equal(f.owner.isCurrentEngineContext(1, token), retirement === 'live', retirement);
  }
});

test('owned Engine admission preserves generation-first short circuit and observer failures', () => {
  const calls = [], token = {};
  let current = 0, fail = false;
  const error = new Error('synthetic witness failure');
  const owner = new ConnectionOperationCoordinator({
    engineSupervisor: { isCurrent: generation => { calls.push(['generation', generation]); return current; } },
    connectionState: { snapshot: () => { calls.push('intent'); if (fail) throw error; return { intent: 7 }; } },
    contextLease: { isCurrent: (observed, lifecycle) => {
      assert.equal(observed, token); calls.push(lifecycle); return 'synthetic raw admission';
    } },
  });
  assert.equal(owner.isCurrentEngineContext(9, token), 0);
  assert.deepEqual(calls.splice(0), [['generation', 9]]);
  current = true;
  assert.equal(owner.isCurrentEngineContext(9, token), 'synthetic raw admission');
  assert.deepEqual(calls.splice(0), [['generation', 9], 'intent', { connectionIntent: 7, engineGeneration: 9 }]);
  fail = true;
  assert.throws(() => owner.isCurrentEngineContext(9, token), error);
});

test('owned Browser resume admission preserves connected-first raw observation without quit policy', () => {
  let connected = false, active = true, activeReads = 0;
  const owner = new ConnectionOperationCoordinator({
    connectionState: { isConnected: () => connected },
    engineSupervisor: { get hasActive() { activeReads++; return active; } },
    isQuitting: () => { throw new Error('resume admission must not invent a quit policy'); },
  });
  assert.equal(owner.canResumeBrowser(), false); assert.equal(activeReads, 0);
  connected = true;
  assert.equal(owner.canResumeBrowser(), true); assert.equal(activeReads, 1);
  active = 'synthetic raw active'; assert.equal(owner.canResumeBrowser(), active);
});

test('owned telemetry reconnect delegates only for its current Engine context and keeps failures', async () => {
  const f = contextFixture(); const calls = [], result = Promise.resolve({ ok: true });
  f.owner.reconnect = generation => { calls.push(generation); return result; };
  assert.equal(f.owner.reconnectCurrentEngineContext(1, f.token), result);
  assert.deepEqual(await f.owner.reconnectCurrentEngineContext(2, f.token), { ok: false, stale: true });
  assert.deepEqual(calls, [1]);
  const error = new Error('synthetic reconnect failure');
  f.owner.reconnect = () => Promise.reject(error);
  await assert.rejects(f.owner.reconnectCurrentEngineContext(1, f.token), error);
  f.lease.invalidate();
  assert.deepEqual(await f.owner.reconnectCurrentEngineContext(1, f.token), { ok: false, stale: true });
});

test('owned initial offline pause retains real recovery intent without cancelling startup itself', async () => {
  const f = fixture(); let startupCancels = 0;
  f.owner.cancelRecovery = () => { startupCancels++; };
  const recovery = new ConnectivityRecovery({
    invalidate: (reason, intent) => f.owner.invalidateForConnectivity(reason, intent),
    getLifecycleIntent: () => f.owner.currentRecoveryIntent(), shouldReconnect: () => false, reconnect() {},
  });
  f.owner.connectivityRecovery = recovery;
  try {
    const intent = f.owner.pauseInitialOffline();
    assert.equal(intent, f.fsm.snapshot().intent);
    assert.equal(f.fsm.snapshot().phase, 'connectivity-paused');
    assert.equal(f.fsm.snapshot().desiredConnected, true);
    assert.equal(recovery.snapshot().pendingIntent, intent);
    assert.equal(startupCancels, 0); assert.equal(f.launches, 0);
    await f.owner.disconnectInFlight;
  } finally { recovery.dispose(); }
});

test('owned initial offline pause preserves cancel begin pause order raw acceptance and failures', () => {
  const calls = []; let accepted = false, fail = '';
  const error = new Error('synthetic pause failure');
  const observe = name => { calls.push(name); if (fail === name) throw error; };
  const owner = new ConnectionOperationCoordinator({
    connectionState: { beginConnectIntent: () => { observe('begin'); return 7; } },
    connectivityRecovery: { cancel: () => observe('cancel'), networkOffline: intent => {
      assert.equal(intent, 7); observe('pause'); return accepted;
    } },
  });
  assert.deepEqual(calls, [], 'construction must not evaluate injected effects');
  for (accepted of [false, 0, undefined, true, 'synthetic accepted']) {
    assert.equal(owner.pauseInitialOffline(), accepted ? 7 : null);
    assert.deepEqual(calls.splice(0), ['cancel', 'begin', 'pause']);
  }
  for (fail of ['cancel', 'begin', 'pause']) {
    assert.throws(() => owner.pauseInitialOffline(), error);
    assert.deepEqual(calls.splice(0), ['cancel', 'begin', 'pause'].slice(0, ['cancel', 'begin', 'pause'].indexOf(fail) + 1));
  }
});

test('Boolean Browser readiness preserves connected and failed-connect admission', async () => {
  const f = fixture();
  let connectCalls = 0;
  f.fsm.isConnected = () => true;
  f.owner.connect = async () => { connectCalls++; return { ok: true, intent: 1 }; };
  assert.equal(await f.owner.ensureBrowserReady(), true);
  assert.equal(connectCalls, 0);
  assert.deepEqual(f.browserWaits, []);

  f.fsm.isConnected = () => false;
  f.fsm.isConnecting = () => false;
  f.owner.connect = async () => ({ ok: false, intent: 2 });
  assert.equal(await f.owner.ensureBrowserReady(), false);
  assert.deepEqual(f.browserWaits, [], 'terminal failure must not await a dead intent');

  f.fsm.isConnecting = () => true;
  f.owner.connect = async () => ({ ok: false, intent: 3 });
  assert.equal(await f.owner.ensureBrowserReady(), true);
  assert.deepEqual(f.browserWaits, [3], 'a still-connecting intent may become ready');
});

test('Browser open connection result waits for its intent and keeps the same error fallback', async () => {
  const f = fixture();
  f.fsm.isConnected = () => false;
  f.owner.connect = async () => ({ ok: false, intent: 4 });
  f.browserWaitResult = false;
  f.state.lastError = 'synthetic gateway failure';
  assert.deepEqual(await f.owner.ensureBrowserConnected(),
    { ok: false, error: 'synthetic gateway failure' });
  f.state.lastError = null;
  assert.deepEqual(await f.owner.ensureBrowserConnected(),
    { ok: false, error: 'error.connectTimeout' });
  assert.deepEqual(f.browserWaits, [4, 4]);
  f.browserWaitResult = true;
  assert.deepEqual(await f.owner.ensureBrowserConnected(), { ok: true });
  assert.deepEqual(f.browserWaits, [4, 4, 4]);
  f.fsm.isConnected = () => true;
  assert.deepEqual(await f.owner.ensureBrowserConnected(), { ok: true });
  assert.deepEqual(f.browserWaits, [4, 4, 4]);
});

test('Browser wait failures propagate rather than inventing a connected state', async () => {
  const f = fixture();
  f.fsm.isConnected = () => false;
  f.fsm.isConnecting = () => true;
  f.owner.connect = async () => ({ ok: true, intent: 5 });
  f.owner.waitForConnected = async () => { throw new Error('synthetic wait failure'); };
  await assert.rejects(f.owner.ensureBrowserReady(), /synthetic wait failure/u);
  await assert.rejects(f.owner.ensureBrowserConnected(), /synthetic wait failure/u);
});

test('operation owner stays in the existing public state entrypoint below 600 lines', () => {
  const source = fs.readFileSync(require.resolve('../../../../lib/connection/state/connection-state-machine'), 'utf8');
  assert(source.trimEnd().split('\n').length <= 600);
});

test('connectivity policy is exposed by the existing operation owner', () => {
  const f = fixture();
  assert.equal(f.owner.currentRecoveryIntent(), null);
  const intent = f.fsm.beginConnectIntent();
  assert.equal(f.owner.currentRecoveryIntent(), intent);
  f.quitting = true;
  assert.equal(f.owner.currentRecoveryIntent(), null);
});

test('connectivity admission honors saved auto-reconnect and fails closed on settings errors', () => {
  const f = fixture(); const intent = f.fsm.beginConnectIntent();
  f.settings.autoReconnect = false;
  assert.equal(f.owner.shouldReconnectForConnectivity(intent, 'network-online'), false);
  assert.equal(f.owner.shouldReconnectForConnectivity(intent, 'initial-network-online'), true);
  f.settingsError = new Error('synthetic settings read failure');
  assert.equal(f.owner.shouldReconnectForConnectivity(intent, 'network-online'), false);
  assert.equal(f.fsm.snapshot().desiredConnected, false);
  assert.equal(f.trace.at(-1), 'emit');
});

test('connectivity invalidation retains intent, invalidates old work, and shares the stop', async () => {
  const f = fixture(); const intent = f.fsm.beginConnectIntent();
  f.fsm.bindEngineGeneration(1); f.active = true; f.stopWait = deferred();
  const invalidation = f.owner.invalidateForConnectivity('network-offline', intent);
  assert.equal(f.fsm.snapshot().intent, intent);
  assert.equal(f.fsm.snapshot().phase, 'connectivity-paused');
  assert.equal(f.fsm.snapshot().desiredConnected, true);
  assert.deepEqual(f.trace.slice(0, 4), ['invalidate', 'clear-presentation', 'emit', 'stop']);
  f.stopWait.resolve(); await invalidation;
  assert.equal(f.fsm.snapshot().intent, intent);
  assert.equal(f.state.lastError, 'error.networkUnavailable');
});

test('a stale connectivity stop cannot overwrite the newer operation presentation', async () => {
  const f = fixture(); const intent = f.fsm.beginConnectIntent();
  f.stopResult = { ok: false }; f.stopWait = deferred();
  const invalidation = f.owner.invalidateForConnectivity('suspend', intent);
  f.fsm.beginConnectIntent(); f.state.lastError = 'new-operation-notice';
  f.stopWait.resolve(); await invalidation;
  assert.equal(f.state.lastError, 'new-operation-notice');
});

test('connectivity recovery resumes the same intent only after a confirmed stop', async () => {
  const f = fixture(); const intent = f.fsm.beginConnectIntent();
  f.fsm.pauseForConnectivity(intent); f.settings.autoReconnect = false;
  assert.equal(await f.owner.recoverConnectivity(intent, 'initial-network-online'), true);
  assert.equal(f.fsm.snapshot().intent, intent);
  assert.equal(f.fsm.snapshot().desiredConnected, true);
  assert.equal(f.launches, 1);
});

test('connectivity recovery waits for local process closure, but offline logout failure does not cancel intent', async () => {
  for (const stopResult of [{ ok: false }, { ok: true, cleanExit: false }]) {
    const f = fixture(); const intent = f.fsm.beginConnectIntent();
    f.fsm.pauseForConnectivity(intent); f.stopResult = stopResult;
    assert.equal(await f.owner.recoverConnectivity(intent, 'network-online'), stopResult.ok);
    assert.equal(f.launches, stopResult.ok ? 1 : 0);
    assert.equal(f.fsm.snapshot().desiredConnected, stopResult.ok);
    if (!stopResult.ok) assert.equal(f.state.lastError, 'error.engineStuck');
  }
});

test('connectivity recovery rereads settings and fails closed if that read changes to an error', async () => {
  const f = fixture(); const intent = f.fsm.beginConnectIntent();
  f.fsm.pauseForConnectivity(intent);
  f.settingsErrors = [null, new Error('synthetic second settings read failure')];
  assert.equal(f.owner.shouldReconnectForConnectivity(intent, 'network-online'), true);
  assert.equal(await f.owner.recoverConnectivity(intent, 'network-online'), false);
  assert.equal(f.trace.includes('stop'), false);
  assert.equal(f.launches, 0);
  assert.equal(f.fsm.snapshot().desiredConnected, false);
  assert.equal(f.trace.at(-1), 'emit');
});

test('quit or superseding intent while connectivity stop drains forbids restart', async () => {
  for (const transition of ['quit', 'new-intent']) {
    const f = fixture(); const intent = f.fsm.beginConnectIntent();
    f.fsm.pauseForConnectivity(intent); f.stopWait = deferred();
    const recovering = f.owner.recoverConnectivity(intent, 'network-online');
    if (transition === 'quit') f.quitting = true;
    else f.fsm.beginConnectIntent();
    f.stopWait.resolve();
    assert.equal(await recovering, false);
    assert.equal(f.launches, 0);
  }
});

test('declined initial startup recovery preserves intent but ordinary decline fails it', () => {
  const f = fixture(); const initialIntent = f.fsm.beginConnectIntent();
  f.owner.onConnectivityRecoveryDeclined(initialIntent, 'initial-network-online');
  assert.equal(f.fsm.snapshot().desiredConnected, true);
  const ordinaryIntent = f.fsm.beginConnectIntent();
  f.owner.onConnectivityRecoveryDeclined(ordinaryIntent, 'network-online');
  assert.equal(f.fsm.snapshot().desiredConnected, false);
  assert.equal(f.trace.at(-1), 'emit');
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
