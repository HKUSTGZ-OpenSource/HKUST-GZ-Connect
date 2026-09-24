'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, safeStorage } = require('electron');
const {
  createLegacyFlatSourcePaths,
  createProfileAccountWorkspaceLayout,
} = require('../lib/persistence/paths/profile-workspace-layout');
const v123Settings = require('./fixtures/v1.2.3-settings.json');

const WAIT_MS = 30_000;
const prepareIndex = process.argv.indexOf('--prepare-legacy-credential');
const preparingCredential = prepareIndex >= 0;
const userData = preparingCredential ? process.argv[prepareIndex + 1]
  : fs.mkdtempSync(path.join(os.tmpdir(), 'hkust-persistence-e2e-'));
const harnessData = preparingCredential ? userData
  : fs.mkdtempSync(path.join(os.tmpdir(), 'hkust-persistence-harness-'));
app.setPath('userData', harnessData);

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitForMarker(file, child, output) {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    }
    if (child.exitCode !== null && !fs.existsSync(file)) {
      // The first process exits after relaunch. Keep waiting for its successor.
    }
    await delay(100);
  }
  throw new Error(`persistence migration marker timed out: ${output.value.slice(-1000)}`);
}

async function stopOwnedProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await delay(50);
  }
  try { process.kill(pid, 'SIGKILL'); } catch {}
}

async function run() {
  app.setName('HKUST(GZ) Connect');
  await app.whenReady();
  const legacy = createLegacyFlatSourcePaths(userData);
  if (preparingCredential) {
    assert.equal(safeStorage.isEncryptionAvailable(), true);
    fs.writeFileSync(legacy.vpnCredential, safeStorage.encryptString('synthetic-v1-2-3-password'), {
      mode: 0o600,
    });
    return;
  }
  // Windows writes the OSCrypt Local State key when Electron exits. Finish the
  // legacy writer before starting migration, exactly as an application upgrade.
  await new Promise((resolve, reject) => {
    const preparer = spawn(process.execPath,
      [__filename, '--prepare-legacy-credential', userData], { stdio: 'inherit' });
    preparer.once('error', reject);
    preparer.once('exit', (code) => code === 0 ? resolve()
      : reject(new Error('legacy credential preparation failed: ' + code)));
  });
  // This checked-in document is the exact flat settings shape emitted by the
  // published v1.2.3 line. Do not generate it with current normalizers: doing
  // so would let a schema regression change both the migration and its input.
  const bytes = Buffer.from(JSON.stringify(v123Settings), 'utf8');
  fs.writeFileSync(legacy.settings, bytes, { mode: 0o600 });
  fs.writeFileSync(legacy.settingsBackup, bytes, { mode: 0o600 });
  fs.writeFileSync(legacy.routingRules, '{"schemaVersion":1,"rules":[]}', { mode: 0o600 });
  fs.writeFileSync(legacy.engineLogRotated, Buffer.alloc(0), { mode: 0o600 });
  const markerPath = path.join(userData, 'persistence-e2e-ready.json');
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  Object.assign(environment, {
    HKUSTGZ_USER_DATA_DIR: userData,
    HKUSTGZ_PERSISTENCE_E2E: '1',
    ELECTRON_ENABLE_LOGGING: '1',
  });
  const output = { value: '' };
  const child = spawn(process.execPath, [path.join(__dirname, '..')], {
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (data) => { output.value = (output.value + data).slice(-4000); });
  child.stderr.on('data', (data) => { output.value = (output.value + data).slice(-4000); });
  child.on('exit', (code, signal) => {
    output.value = `${output.value}\ninitial-exit code=${code} signal=${signal}`.slice(-4000);
  });
  let marker = null;
  try {
    marker = await waitForMarker(markerPath, child, output);
    assert.equal(marker.mode, 'profile-workspace');
    assert.equal(Number.isInteger(marker.pid) && marker.pid > 0, true);
    assert.equal(fs.existsSync(legacy.settings), false);
    assert.equal(fs.existsSync(legacy.vpnCredential), false);
    assert.equal(fs.existsSync(legacy.engineLogRotated), false);
    const globalSettingsPath = path.join(userData, 'global', 'settings.json');
    assert.equal(fs.existsSync(globalSettingsPath), true);
    const globalSettings = JSON.parse(fs.readFileSync(globalSettingsPath, 'utf8'));
    assert.equal(globalSettings.port, 6280);
    assert.equal(globalSettings.strictProxyAuth, false);
    assert.equal(globalSettings.proxyAuthMigrationPending, true);
    assert.equal(globalSettings.closeAction, 'quit');
    assert.equal(globalSettings.language, 'en');
    assert.equal(globalSettings.startAtLogin, false);
    assert.equal(Object.hasOwn(globalSettings, 'username'), false);
    const profilesRoot = path.join(userData, 'profiles');
    const profileKeys = fs.readdirSync(profilesRoot);
    assert.equal(profileKeys.length, 1);
    assert.equal(profileKeys[0], globalSettings.activeProfileKey);
    const accountRoot = path.join(
      profilesRoot,
      globalSettings.activeProfileKey,
      'accounts',
      globalSettings.activeAccountKey,
    );
    const account = JSON.parse(fs.readFileSync(path.join(accountRoot, 'account.json'), 'utf8'));
    const layout = createProfileAccountWorkspaceLayout({
      userData,
      profileKey: globalSettings.activeProfileKey,
      accountKey: globalSettings.activeAccountKey,
      workspaceKey: account.workspaceKey,
      adoptLegacyHkustBrowserPartition: true,
    });
    const workspaceSettings = JSON.parse(fs.readFileSync(layout.workspace.settings, 'utf8'));
    assert.equal(workspaceSettings.autoReconnect, false);
    assert.equal(workspaceSettings.maxAttempts, 4);
    assert.equal(workspaceSettings.autoConnect, false);
    assert.deepEqual(workspaceSettings.routeDomains, ['hkust-gz.edu.cn', 'hkust.edu.hk']);
    const localResources = JSON.parse(fs.readFileSync(layout.workspace.localResources, 'utf8'));
    assert.deepEqual(localResources.resources, [{
      ...v123Settings.customResources[0],
      category: 'custom',
      keywords: [],
    }]);
    assert.equal(fs.statSync(layout.account.vpnCredential).size > 0, true);
    assert.equal(fs.existsSync(layout.workspace.engineLogRotated), false);
    const integrations = JSON.parse(fs.readFileSync(layout.workspace.externalIntegrations, 'utf8'));
    assert.deepEqual(integrations, { schemaVersion: 1, records: [] });
  } finally {
    if (marker?.pid) await stopOwnedProcess(marker.pid);
    try { child.kill('SIGTERM'); } catch {}
    await delay(100);
    if (marker) fs.rmSync(userData, { recursive: true, force: true });
    else process.stderr.write(`persistence-e2e-user-data=${userData}\n`);
  }
}

run().then(() => { app.quit(); if (!preparingCredential) fs.rmSync(harnessData, { recursive: true, force: true }); }).catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
  app.exit(1);
});
