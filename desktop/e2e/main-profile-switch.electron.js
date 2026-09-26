'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const electron = require('electron');
const { ActiveContextActivationStore } = require('../lib/switching/active-context/active-context-activation-store');
const { ActiveContextSwitchBarrier } = require('../lib/switching/effects/active-context-switch-barrier');
const { ActiveContextSwitchJournalStore } = require('../lib/switching/active-context/active-context-switch-store');
const { CustomGatewayConfirmationOwner } = require('../lib/profiles/onboarding/custom-gateway-onboarding');
const { CustomProfileProvisioningRuntime } = require('../lib/profiles/provisioning/custom-profile-provisioning-runtime');
const { ProfileCandidateDirectory } = require('../lib/profiles/registry/profile-candidate-directory');
const { ProfileSwitchRuntime } = require('../lib/switching/runtime/profile-switch-runtime');
const { ProfileWorkspaceStartupRuntime } = require('../lib/persistence/runtime/profile-workspace-startup-runtime');
const { PROTOCOL_FAMILY } = require('../lib/profiles/schema/school-profile-schema');
const { saveSettings } = require('../lib/persistence/settings/settings-store');
const { createPrivateStorageEffects } = require('../lib/platform/storage/private-file');

const DESKTOP = path.join(__dirname, '..');
const MARKER = 'profile-switch-e2e-ready.json';
const WAIT_MS = 30_000;
const profileStorageEffects = createPrivateStorageEffects({ fileSystem: fs, platform: process.platform });

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function readProfile() {
  return JSON.parse(fs.readFileSync(path.join(
    DESKTOP, 'assets', 'profiles', 'hkustgz', 'school-profile.json'), 'utf8'));
}

function provisionCustom(userData) {
  let seed = 1;
  const owner = new CustomGatewayConfirmationOwner({
    randomBytes: (length) => Buffer.alloc(length, seed++),
    now: () => 1_800_000_000_000,
    ttlMs: 10_000,
  });
  const active = {
    profileId: 'hkustgz', profileRevision: 1,
    accountHandle: `account-${'a'.repeat(36)}`, activeContextEpoch: 1,
  };
  const view = owner.issue({
    probeResult: {
      schema_version: 1, normalized_origin: 'https://vpn.example.edu',
      https_identity_valid: true, compatibility: 'recognized_candidate',
      candidate_family: PROTOCOL_FAMILY, reported_version: 'M7.6.8R2', http_status: 200,
    },
    schoolLabel: 'Example University',
    activeContext: active,
  });
  const confirmation = owner.consume({
    confirmationHandle: view.confirmationHandle,
    activeContext: active,
  });
  let provisionSeed = 70;
  return new CustomProfileProvisioningRuntime({
    userData,
    profileStorageEffects,
    randomBytes: (length) => Buffer.alloc(length, ++provisionSeed),
    now: () => 1_800_000_000_100,
  }).begin(confirmation);
}

function directory(userData) {
  return new ProfileCandidateDirectory({
    userData,
    packageRoot: DESKTOP,
    desktopDir: DESKTOP,
    resourcesPath: '/unused',
    isPackaged: false,
    profileStorageEffects,
  });
}

async function leavePreparedSwitch(userData, destinationProfileId) {
  const candidates = directory(userData);
  let source;
  candidates.withCandidate('hkustgz', (record) => { source = record.context; });
  const journalStore = new ActiveContextSwitchJournalStore({
    filePath: path.join(userData, 'global', 'active-context-switch.json'),
    profileStorageEffects,
  });
  const barrier = new ActiveContextSwitchBarrier({
    invalidateContext() {}, suspendBrowser: async () => true,
    browserBoundaryClosed: () => true, cancelAuth() {}, cancelConnectivity() {},
    cancelMutations: async () => true, closeBrowser: async () => true,
    browserClosed: () => true, stopEngine: async () => ({ ok: true, cleanExit: true }),
    revokeProxyAccess: async () => false, clearServerState: async () => true,
  });
  const runtime = new ProfileSwitchRuntime({
    directory: candidates,
    journalStore,
    activationStore: new ActiveContextActivationStore({ userData, profileStorageEffects }),
    barrier,
    getActivePersistentContext: () => source,
    getEngineGeneration: () => null,
    activateRuntime: () => true,
  });
  await assert.rejects(runtime.switchTo(destinationProfileId), (error) => (
    error?.code === 'ACTIVE_CONTEXT_SWITCH_PROXY_REVOKE_FAILED'
  ));
  assert.equal(journalStore.read().state, 'prepared');
}

async function waitForMarker(userData, expectedProfileId, child, output) {
  const file = path.join(userData, MARKER);
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      try {
        const marker = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (marker.profileId === expectedProfileId) return marker;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    if (child.exitCode !== null && !fs.existsSync(file)) {
      output.value = `${output.value}\nlauncher-exit=${child.exitCode}`.slice(-4_000);
    }
    await delay(100);
  }
  throw new Error(`Profile switch marker timed out: ${output.value}`);
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

async function launch(userData, { target = null, openBrowser = false } = {}) {
  const marker = path.join(userData, MARKER);
  try { fs.unlinkSync(marker); } catch {}
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  Object.assign(environment, {
    HKUSTGZ_USER_DATA_DIR: userData,
    HKUSTGZ_PROFILE_SWITCH_E2E: '1',
    ELECTRON_ENABLE_LOGGING: '1',
  });
  const args = target
    ? [path.join(__dirname, 'main-profile-switch-stage.electron.js')]
    : [DESKTOP];
  if (target) environment.HKUSTGZ_SWITCH_TARGET = target;
  if (openBrowser) environment.HKUSTGZ_SWITCH_OPEN_BROWSER = '1';
  const output = { value: '' };
  const child = spawn(electron, args, { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (data) => { output.value = (output.value + data).slice(-4_000); });
  }
  return { child, output };
}

async function run() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'main-profile-switch-'));
  fs.chmodSync(userData, 0o700);
  let activePid = null;
  try {
    saveSettings(path.join(userData, 'settings.json'), {
      autoConnect: false,
      startAtLogin: false,
    });
    const reviewed = new ProfileWorkspaceStartupRuntime({
      userData,
      profile: readProfile(),
      safeStorage: {},
    }).initialize();
    assert.equal(reviewed.mode, 'profile-workspace');
    directory(userData).anchorReviewedCurrent({
      profileId: 'hkustgz',
      profileKey: reviewed.authority.globalSettings.activeProfileKey,
      accountKey: reviewed.authority.globalSettings.activeAccountKey,
    });
    const custom = provisionCustom(userData);

    await leavePreparedSwitch(userData, custom.profileId);
    let launched = await launch(userData);
    let marker = await waitForMarker(userData, custom.profileId, launched.child, launched.output);
    activePid = marker.pid;
    assert.equal(marker.activeContextEpoch, 2);
    assert.equal(fs.existsSync(path.join(userData, 'global', 'active-context-switch.json')), false);
    await stopOwnedProcess(activePid); activePid = null;

    launched = await launch(userData, { target: 'hkustgz', openBrowser: true });
    marker = await waitForMarker(userData, 'hkustgz', launched.child, launched.output);
    activePid = marker.pid;
    assert.equal(marker.activeContextEpoch, 3);
    assert.match(launched.output.value, /profile switch stage hkustgz: PASS/u);
    await stopOwnedProcess(activePid); activePid = null;

    launched = await launch(userData, { target: custom.profileId });
    marker = await waitForMarker(userData, custom.profileId, launched.child, launched.output);
    activePid = marker.pid;
    assert.equal(marker.activeContextEpoch, 4);
    assert.match(launched.output.value, /profile switch stage custom-/u);
    assert.equal(fs.existsSync(path.join(userData, 'global', 'active-context-switch.json')), false);
    process.stdout.write('main Profile switch recovery + relaunch: PASS\n');
  } finally {
    if (activePid) await stopOwnedProcess(activePid);
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
  }
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
