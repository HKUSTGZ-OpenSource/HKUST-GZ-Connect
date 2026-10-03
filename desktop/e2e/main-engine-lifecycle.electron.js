'use strict';

// Real Electron Main → synthetic child Engine lifecycle. The fixture is a
// fixed dev-only path selected by a boolean guard; it opens only a loopback
// readiness listener and performs no forwarding or external network I/O.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const TEST_TIMEOUT_MS = 25_000;
const WAIT_TIMEOUT_MS = 10_000;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-main-engine-e2e-'));
process.env.HKUSTGZ_USER_DATA_DIR = profile;
process.env.HKUSTGZ_SYNTHETIC_ENGINE_E2E = '1';
app.disableHardwareAcceleration();

require('../main');

async function waitFor(condition, description, timeoutMs = WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await condition();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function controlWindow(excludedId = null) {
  return waitFor(() => BrowserWindow.getAllWindows().find((candidate) => (
    candidate.webContents.id !== excludedId &&
    candidate.webContents.getURL().endsWith('/renderer/index.html') &&
    !candidate.webContents.isLoading()
  )), 'control window');
}

function invoke(window, expression) {
  return window.webContents.executeJavaScript(`(async () => (${expression}))()`);
}

function attemptCount() {
  try { return Number(fs.readFileSync(path.join(profile, 'synthetic-engine-attempt.txt'), 'utf8')); }
  catch { return 0; }
}

function observations() {
  try {
    return fs.readFileSync(path.join(profile, 'synthetic-engine-observations.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function allocateLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function loopbackConnects(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (connected) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(500);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function run() {
  await app.whenReady();
  let control = await controlWindow();
  const port = await allocateLoopbackPort();
  const savedCredential = await invoke(control, `window.api.save({
    username: 'synthetic-main-user',
    password: 'synthetic-main-password',
    expectedProfileId: 'hkustgz',
  })`);
  assert.equal(savedCredential.ok, true);
  const savedPolicy = await invoke(control, `window.api.save({
    port: ${port},
    strictProxyAuth: false,
    autoConnect: false,
    autoReconnect: true,
    maxAttempts: 2,
  })`);
  assert.equal(savedPolicy.ok, true);

  const opening = invoke(control, `window.api.openCampusBrowser({
    url: 'https://waiter.example.invalid/',
  })`);
  const secondOpening = invoke(control, `window.api.openCampusBrowser({
    url: 'https://second-waiter.example.invalid/',
  })`);
  const phases = new Set();
  await waitFor(async () => {
    const state = await invoke(control, 'window.api.getState()');
    phases.add(state.phase);
    return state.phase === 'retry-wait';
  }, 'retry wait', 12_000);
  assert.ok(phases.has('retry-wait'), 'the first synthetic failure must enter retry-wait');
  const thirdOpening = invoke(control, `window.api.openCampusBrowser({
    url: 'https://mid-retry-waiter.example.invalid/',
  })`);
  await waitFor(() => attemptCount() >= 2, 'automatic retry', 12_000);

  const beforeValidGeneration = Date.now() + 250;
  while (Date.now() < beforeValidGeneration) {
    const state = await invoke(control, 'window.api.getState()');
    assert.equal(state.connected, false, 'a stale generation cannot mark Main connected');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await waitFor(() => observations().some((entry) => (
    entry.attempt === 2 && entry.type === 'listener_ready_sent'
  )), 'listener readiness');
  const listenerOnlyState = await invoke(control, 'window.api.getState()');
  assert.equal(listenerOnlyState.connected, false,
    'listener_ready is insufficient before state_changed connected');

  await waitFor(() => observations().some((entry) => (
    entry.attempt === 2 && entry.type === 'connected_candidate_sent'
  )), 'connected candidate');

  const connected = await waitFor(async () => {
    const state = await invoke(control, 'window.api.getState()');
    return state.connected ? state : null;
  }, 'listener-ready connection');
  assert.equal(connected.phase, 'connected');
  assert.equal(connected.dnsMode, 'gateway');
  assert.ok(connected.clientIp);
  assert.ok(Number.isSafeInteger(connected.connectedAt) && connected.connectedAt > 0 &&
    connected.connectedAt <= Date.now(), 'accepted connection must expose its presentation timestamp');
  assert.equal(Object.hasOwn(connected, 'capabilitySnapshot'), false,
    'Engine capability diagnostics must not be projected into the Control Renderer');
  assert.equal(await loopbackConnects(port), true,
    'listener_ready must correspond to a real owned loopback listener');
  const opened = await opening;
  const secondOpened = await secondOpening;
  const thirdOpened = await thirdOpening;
  assert.equal(opened.ok, true,
    'one intent-bound Main waiter must remain pending through same-intent retry');
  assert.equal(secondOpened.ok, true,
    'concurrent opens must coalesce onto the same active connection intent');
  assert.equal(thirdOpened.ok, true,
    'a mid-retry open must retain the existing intent and retry budget');
  const activeConnect = await invoke(control, 'window.api.connect()');
  assert.equal(activeConnect.ok, true);
  assert.equal(activeConnect.existing, true,
    'an already-active desired connection must be reused without a new intent');
  assert.equal(attemptCount(), 2);

  const oldContentsId = control.webContents.id;
  control.webContents.forcefullyCrashRenderer();
  control = await controlWindow(oldContentsId);
  const recovered = await invoke(control, 'window.api.getState()');
  assert.equal(recovered.connected, true, 'renderer recovery must not stop the healthy Engine');
  assert.equal(recovered.connectedAt, connected.connectedAt,
    'renderer recreation must preserve the same Connection-owned timestamp');
  assert.equal(Object.hasOwn(recovered, 'capabilitySnapshot'), false);

  const stopped = await invoke(control, 'window.api.disconnect()');
  assert.equal(stopped.ok, true);
  const disconnected = await waitFor(async () => {
    const state = await invoke(control, 'window.api.getState()');
    return !state.connected && !state.connecting ? state : null;
  }, 'graceful disconnect');
  assert.equal(disconnected.phase, 'idle');
  assert.equal(disconnected.connectedAt, null);
  assert.equal(disconnected.clientIp, null);
  assert.equal(disconnected.dnsMode, 'unknown');
  assert.equal(Object.hasOwn(disconnected, 'capabilitySnapshot'), false);
  await waitFor(async () => !await loopbackConnects(port), 'loopback listener release');

  const events = observations();
  const attempts = events.filter((entry) => entry.type === 'credentials_received');
  const bindings = events.filter((entry) => entry.type === 'config_binding_received');
  assert.equal(attempts.length, 2);
  assert.equal(bindings.length, 2);
  for (const attempt of [1, 2]) {
    assert.ok(events.findIndex((entry) => (
      entry.attempt === attempt && entry.type === 'config_binding_received'
    )) < events.findIndex((entry) => (
      entry.attempt === attempt && entry.type === 'credentials_received'
    )));
  }
  assert.notEqual(attempts[0].generation, attempts[1].generation);
  assert.ok(events.some((entry) => entry.type === 'stale_generation_sent'));
  assert.ok(events.some((entry) => entry.type === 'listener_ready_sent'));
  assert.ok(events.some((entry) => entry.type === 'shutdown_received'));
  assert.ok(events.filter((entry) => entry.type === 'provider_capabilities_requested').length >= 2);

  // Real Main/IPC/Manager regression for a windowless close while Engine
  // readiness is pending. Only this isolated fixture partition is cleared.
  assert.equal((await invoke(control, 'window.api.clearBrowserData()')).ok, true);
  process.env.HKUSTGZ_SYNTHETIC_ENGINE_READY_HOLD_E2E = '1';
  const retiredOpening = invoke(control, `window.api.openCampusBrowser({
    url: 'https://retired-waiter.example.invalid/',
  })`);
  await waitFor(() => observations().some(entry => entry.attempt === 3 && entry.type === 'readiness_held'),
    'held synthetic readiness');
  assert.equal(BrowserWindow.getAllWindows().filter(window => window !== control).length, 0,
    'no Browser window may exist before held readiness');
  assert.equal((await invoke(control, 'window.api.clearBrowserData()')).ok, true);
  fs.writeFileSync(path.join(profile, 'synthetic-engine-readiness-release.txt'), 'release');
  assert.deepEqual(await retiredOpening, { ok: false, stale: true },
    'late readiness cannot reopen a Browser after confirmed data-close admission');
  assert.equal(BrowserWindow.getAllWindows().filter(window => window !== control).length, 0);
  const stillConnected = await invoke(control, 'window.api.getState()');
  assert.equal(stillConnected.connected, true, 'Browser retirement must not cancel Engine work');
  assert.ok(Number.isSafeInteger(stillConnected.connectedAt) &&
    stillConnected.connectedAt >= connected.connectedAt);
  assert.equal((await invoke(control, `window.api.openCampusBrowser({
    url: 'https://fresh-waiter.example.invalid/',
  })`)).ok, true, 'a new request may reuse the healthy Engine and create a Browser');
  assert.equal(attemptCount(), 3, 'fresh Browser open must not start another Engine generation');
  assert.equal((await invoke(control, 'window.api.getState()')).connectedAt, stillConnected.connectedAt,
    'fresh Browser open must not replace the serving generation timestamp');
  assert.equal((await invoke(control, 'window.api.disconnect()')).ok, true);
  assert.equal((await invoke(control, 'window.api.getState()')).connectedAt, null);
  await waitFor(async () => !await loopbackConnects(port), 'held-generation listener release');
  process.stdout.write('main synthetic Engine lifecycle: PASS\n');
}

const hardTimeout = setTimeout(() => {
  process.stderr.write('main synthetic Engine lifecycle: hard timeout\n');
  app.exit(1);
}, TEST_TIMEOUT_MS);

run().then(
  () => {
    clearTimeout(hardTimeout);
    app.quit();
  },
  (error) => {
    clearTimeout(hardTimeout);
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
    app.exit(1);
  },
);

app.on('quit', () => {
  delete process.env.HKUSTGZ_SYNTHETIC_ENGINE_E2E;
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
});
