'use strict';

// Real Main/private-pipe recovery with synthetic network loss. The fixture
// never forwards traffic or contacts the school. Timers are accelerated and
// platform command inventory is replaced with an empty synthetic snapshot.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-network-recovery-e2e-'));
const networkFile = path.join(profile, 'synthetic-network-state.txt');
const failureFile = path.join(profile, 'synthetic-engine-network-failure.txt');
const attemptFile = path.join(profile, 'synthetic-engine-attempt.txt');
process.env.HKUSTGZ_USER_DATA_DIR = profile;
process.env.HKUSTGZ_SYNTHETIC_ENGINE_E2E = '1';
process.env.HKUSTGZ_SYNTHETIC_ENGINE_STABLE_E2E = '1';
process.env.HKUSTGZ_SYNTHETIC_NETWORK_E2E = '1';
fs.writeFileSync(networkFile, 'online\n');
app.disableHardwareAcceleration();

const engine = require('../lib/connection/engine/engine-supervisor');
const originalSchedule = engine.EngineSupervisor.prototype.schedule;
const delays = [];
engine.EngineSupervisor.prototype.schedule = function acceleratedSchedule(generation, delayMs, callback) {
  delays.push(delayMs);
  return originalSchedule.call(this, generation, Math.min(delayMs, 50), callback);
};
const { NetworkEnvironmentService } = require('../lib/network-environment/runtime/network-environment-service');
NetworkEnvironmentService.prototype.rawSnapshot = async function syntheticInventory() {
  this.cached = { platform: process.platform, status: 'unknown', interfaces: [],
    systemProxy: { state: 'unknown', type: 'unknown', endpoint: null, owner: {} } };
  return this.cached;
};
require('../main');

async function waitFor(condition, description) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${description}`);
}

function attempts() {
  try { return Number(fs.readFileSync(attemptFile, 'utf8')); }
  catch { return 0; }
}

function invoke(window, expression) {
  return window.webContents.executeJavaScript(`(async () => (${expression}))()`);
}

async function port() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const number = server.address().port;
      server.close(error => error ? reject(error) : resolve(number));
    });
  });
}

async function run() {
  await app.whenReady();
  let control;
  await waitFor(() => {
    control = BrowserWindow.getAllWindows().find(window =>
      window.webContents.getURL().endsWith('/renderer/index.html') && !window.webContents.isLoading());
    return Boolean(control);
  }, 'control window');
  const state = () => invoke(control, 'window.api.getState()');
  assert.equal((await invoke(control, `window.api.save({
    username: 'synthetic-network-user', password: 'synthetic-network-password',
    expectedProfileId: 'hkustgz',
  })`)).ok, true);
  assert.equal((await invoke(control, `window.api.save({
    port: ${await port()}, strictProxyAuth: false, autoConnect: false,
    autoReconnect: true, maxAttempts: 3,
  })`)).ok, true);
  assert.equal((await invoke(control, 'window.api.connect()')).ok, true);
  await waitFor(async () => (await state()).connected, 'initial connection');

  fs.writeFileSync(networkFile, 'offline\n');
  await waitFor(async () => (await state()).phase === 'connectivity-paused', 'offline pause');
  assert.equal(attempts(), 1);
  assert.equal((await state()).connected, false);
  fs.writeFileSync(failureFile, 'network unavailable\n');
  fs.writeFileSync(networkFile, 'online\n');
  await waitFor(() => attempts() >= 6 && delays.length >= 5, 'retries beyond the short budget');
  const recovering = await state();
  assert.equal(recovering.connected, false);
  assert.notEqual(recovering.phase, 'idle');
  assert.deepEqual(delays.slice(0, 5), [5000, 10_000, 15_000, 30_000, 30_000]);
  fs.unlinkSync(failureFile);
  await waitFor(async () => (await state()).connected, 'automatic connection after gateway recovery');
  process.stdout.write('main sustained network recovery: PASS\n');

  const beforeSecondOutage = attempts();
  fs.writeFileSync(networkFile, 'offline\n');
  await waitFor(async () => (await state()).phase === 'connectivity-paused', 'second offline pause');
  fs.writeFileSync(networkFile, 'online\n');
  await waitFor(async () => (await state()).connected, 'second automatic recovery');
  assert.equal(attempts(), beforeSecondOutage + 1);

  fs.writeFileSync(networkFile, 'offline\n');
  await waitFor(async () => (await state()).phase === 'connectivity-paused', 'disconnect outage');
  assert.equal((await invoke(control, 'window.api.disconnect()')).ok, true);
  const stoppedAttempts = attempts();
  fs.writeFileSync(networkFile, 'online\n');
  await new Promise(resolve => setTimeout(resolve, 3000));
  assert.equal(attempts(), stoppedAttempts);
  assert.equal((await state()).phase, 'idle');
  process.stdout.write('main repeated outage and manual disconnect: PASS\n');
}

const timeout = setTimeout(() => {
  process.stderr.write('main network recovery: hard timeout\n');
  app.exit(1);
}, 45_000);
run().then(() => {
  clearTimeout(timeout);
  app.exit(0);
}, error => {
  clearTimeout(timeout);
  process.stderr.write(`${error.stack || error.message}\n`);
  process.stderr.write(`synthetic attempts=${attempts()} delays=${JSON.stringify(delays)}\n`);
  app.exit(1);
});
