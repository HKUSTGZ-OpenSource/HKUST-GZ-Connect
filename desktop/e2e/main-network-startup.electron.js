'use strict';

// Real Electron Main startup with a synthetic offline/online signal and the
// fixed non-routing Engine fixture. It proves that an initially-offline launch
// retains one desired connection without spawning the Engine, then starts one
// and only one generation after connectivity returns.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, safeStorage } = require('electron');
const { savePassword } = require('../lib/persistence/credentials/credential-store');
const { ProfileWorkspaceStartupRuntime } = require('../lib/persistence/runtime/profile-workspace-startup-runtime');
const { saveSettings } = require('../lib/persistence/settings/settings-store');

// Shared macOS runners can spend several seconds cold-starting Electron and
// the synthetic child process. Keep every state/attempt assertion unchanged,
// but do not turn host load into a false network-lifecycle regression.
const TEST_TIMEOUT_MS = 45_000;
const WAIT_TIMEOUT_MS = 15_000;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-network-startup-e2e-'));
const networkStateFile = path.join(profile, 'synthetic-network-state.txt');
const attemptFile = path.join(profile, 'synthetic-engine-attempt.txt');
process.env.HKUSTGZ_USER_DATA_DIR = profile;
app.setPath('userData', profile);
process.env.HKUSTGZ_SYNTHETIC_ENGINE_E2E = '1';
process.env.HKUSTGZ_SYNTHETIC_ENGINE_STABLE_E2E = '1';
process.env.HKUSTGZ_SYNTHETIC_NETWORK_E2E = '1';
app.setName('HKUST(GZ) Connect');
app.disableHardwareAcceleration();

async function waitFor(condition, description, timeoutMs = WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await condition();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${description}`);
}

function attemptCount() {
  try { return Number(fs.readFileSync(attemptFile, 'utf8')); }
  catch { return 0; }
}

async function allocateLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function controlWindow() {
  return waitFor(() => BrowserWindow.getAllWindows().find((candidate) => (
    candidate.webContents.getURL().endsWith('/renderer/index.html') &&
    !candidate.webContents.isLoading()
  )), 'control window');
}

function invoke(window, expression) {
  return window.webContents.executeJavaScript(`(async () => (${expression}))()`);
}

async function prepareProfile() {
  await app.whenReady();
  const port = await allocateLoopbackPort();
  saveSettings(path.join(profile, 'settings.json'), {
    username: 'synthetic-network-user',
    port,
    autoConnect: true,
    autoReconnect: false,
    strictProxyAuth: false,
  });
  assert.equal(savePassword(
    path.join(profile, 'cred.bin'),
    'synthetic-network-password',
    safeStorage,
    process.platform,
  ), true, 'the Electron credential backend must be available for the startup fixture');
  fs.writeFileSync(networkStateFile, 'offline\n', { mode: 0o600 });
  const schoolProfile = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'assets', 'profiles', 'hkustgz', 'school-profile.json'),
    'utf8',
  ));
  const persistence = new ProfileWorkspaceStartupRuntime({
    userData: profile,
    profile: schoolProfile,
    safeStorage,
  }).initialize();
  assert.equal(persistence.mode, 'profile-workspace');
  return port;
}

async function run() {
  await prepareProfile();
  // Fixture-only capture of Main's actual public eligibility factory. Keep
  // construction effect-free and ordinary coordinator evaluation authoritative.
  const network = require('../lib/connection/telemetry/network-status-monitor');
  const connection = require('../lib/connection/state/connection-state-machine');
  const OriginalOperation = connection.ConnectionOperationCoordinator;
  const operationCalls = { pause: 0, current: 0 };
  connection.ConnectionOperationCoordinator = class FixtureOperation extends OriginalOperation {
    pauseInitialOffline() { operationCalls.pause++; return super.pauseInitialOffline(); }
    isCurrentEngineContext(...args) { operationCalls.current++; return super.isCurrentEngineContext(...args); }
  };
  const originalEligibility = network.createStartupAutoConnectEligibility;
  const originalSystem = network.createNetworkStartupSystem;
  let mainStartupEffects;
  network.createNetworkStartupSystem = (effects) => {
    mainStartupEffects = effects;
    return originalSystem(effects);
  };
  let factoryUsed = false, constructing = false, eligibilityReads = 0;
  network.createStartupAutoConnectEligibility = (effects) => {
    factoryUsed = true; constructing = true;
    const predicate = originalEligibility({
      readSettings: () => { assert.equal(constructing, false); eligibilityReads++; return effects.readSettings(); },
      hasPersistentCredential: () => { assert.equal(constructing, false); return effects.hasPersistentCredential(); },
    });
    constructing = false;
    return predicate;
  };
  require('../main');
  connection.ConnectionOperationCoordinator = OriginalOperation;
  network.createStartupAutoConnectEligibility = originalEligibility;
  network.createNetworkStartupSystem = originalSystem;
  const control = await controlWindow();
  await waitFor(async () => (await invoke(control, 'window.api.getState()')).phase ===
    'connectivity-paused', 'initial offline pause');
  assert.equal(attemptCount(), 0, 'initial offline startup must not spawn an Engine');
  assert.equal(operationCalls.pause, 1, 'initial offline intent belongs to the actual Connection owner');
  assert.equal(factoryUsed, true);
  assert.ok(eligibilityReads > 0, 'ordinary startup must evaluate the current settings');

  fs.writeFileSync(networkStateFile, 'online\n', { mode: 0o600 });
  await waitFor(async () => {
    const state = await invoke(control, 'window.api.getState()');
    return state.connected && attemptCount() === 1;
  }, 'single online Engine generation');
  assert.ok(operationCalls.current > 0, 'actual Engine serving must use the owned context admission');

  fs.writeFileSync(networkStateFile, 'offline\n', { mode: 0o600 });
  await waitFor(async () => {
    const state = await invoke(control, 'window.api.getState()');
    return state.phase === 'connectivity-paused' && attemptCount() === 1;
  }, 'ordinary offline pause');
  fs.writeFileSync(networkStateFile, 'online\n', { mode: 0o600 });
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(attemptCount(), 1,
    'ordinary online must not auto-reconnect when autoReconnect is false');
  const manual = await invoke(control, 'window.api.connect()');
  assert.equal(manual.ok, true, 'declined automatic recovery must leave manual connect usable');
  await waitFor(async () => {
    const state = await invoke(control, 'window.api.getState()');
    return state.connected && attemptCount() === 2;
  }, 'manual connection after declined ordinary recovery');
  process.stdout.write('main initial network startup: PASS\n');
  assert.equal((await invoke(control, 'window.api.disconnect()')).ok, true);
  let tick, queuedConnectCalls = 0;
  // The temporary owner uses Main's actual injected capabilities, but an
  // isolated online monitor/timer; no production hook or real network change.
  const queuedStartup = new network.NetworkStartupCoordinator({
    monitor: { start: async () => true, snapshot: () => ({ baseline: true }) },
    shouldAutoConnect: mainStartupEffects.shouldAutoConnect,
    pauseOffline: mainStartupEffects.pauseOffline,
    resumeOffline: mainStartupEffects.resumeInitialOffline,
    isQuitting: mainStartupEffects.isQuitting,
    connect: () => { queuedConnectCalls++; return mainStartupEffects.connect(); },
    setTimeout: callback => { tick = callback; return { unref() {} }; }, clearTimeout() {},
  });
  try {
    assert.equal(await queuedStartup.start(), true);
    const pending = tick();
    queuedStartup.cancel();
    await pending;
    assert.equal(queuedConnectCalls, 0, 'cancelled queued work cannot call Main connect');
    assert.equal(attemptCount(), 2, 'no further real synthetic Engine generation starts');
    assert.equal((await invoke(control, 'window.api.getState()')).phase, 'idle');
    process.stdout.write('main queued startup cancellation: PASS\n');
  } finally { queuedStartup.dispose(); }
}

const hardTimeout = setTimeout(() => {
  process.stderr.write('main initial network startup: hard timeout\n');
  app.exit(1);
}, TEST_TIMEOUT_MS);

run().then(
  () => { clearTimeout(hardTimeout); app.quit(); },
  (error) => {
    clearTimeout(hardTimeout);
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
    app.exit(1);
  },
);

app.on('quit', () => {
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
});
