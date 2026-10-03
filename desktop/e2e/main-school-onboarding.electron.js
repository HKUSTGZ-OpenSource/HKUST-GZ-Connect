'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const electron = require('electron');
const { ProfileCandidateDirectory } = require('../lib/profiles/registry/profile-candidate-directory');
const { ProfileWorkspaceStartupRuntime } = require('../lib/persistence/runtime/profile-workspace-startup-runtime');
const { saveSettings } = require('../lib/persistence/settings/settings-store');
const { createPrivateStorageEffects } = require('../lib/platform/storage/private-file');

const DESKTOP = path.join(__dirname, '..');
const MARKER = 'profile-switch-e2e-ready.json';
const profileStorageEffects = createPrivateStorageEffects({ fileSystem: fs, platform: process.platform });

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function profile() {
  return JSON.parse(fs.readFileSync(path.join(
    DESKTOP, 'assets', 'profiles', 'hkustgz', 'school-profile.json'), 'utf8'));
}
function directory(userData) {
  return new ProfileCandidateDirectory({
    userData, packageRoot: DESKTOP, desktopDir: DESKTOP,
    resourcesPath: '/unused', isPackaged: false,
    profileStorageEffects,
  });
}
function launch(userData, stage) {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  Object.assign(environment, {
    HKUSTGZ_USER_DATA_DIR: userData,
    HKUSTGZ_PROFILE_SWITCH_E2E: '1',
    HKUSTGZ_SYNTHETIC_GATEWAY_PROBE_E2E: '1',
    HKUSTGZ_ONBOARDING_STAGE: stage,
    ELECTRON_ENABLE_LOGGING: '1',
  });
  const output = { value: '' };
  const child = spawn(electron, [path.join(__dirname, 'main-school-onboarding-stage.electron.js')], {
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (data) => { output.value = (output.value + data).slice(-8_000); });
  }
  return { child, output };
}
async function waitForMarker(userData, child, output) {
  const file = path.join(userData, MARKER);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      try {
        const marker = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (String(marker.profileId).startsWith('custom-')) return marker;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    if (child.exitCode !== null && !fs.existsSync(file)) {
      throw new Error(`Onboarding stage exited before relaunch: ${output.value}`);
    }
    await delay(100);
  }
  throw new Error(`Onboarding relaunch marker timed out: ${output.value}`);
}
async function waitForExit(child, output) {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Stage exit timed out: ${output.value}`)), 20_000);
    child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
}
async function stopOwnedProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await delay(50);
  }
  try { process.kill(pid, 'SIGKILL'); } catch {}
}

async function run() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'main-school-onboarding-'));
  fs.chmodSync(userData, 0o700);
  let successorPid = null;
  try {
    saveSettings(path.join(userData, 'settings.json'), {
      autoConnect: false,
      startAtLogin: false,
    });
    const reviewed = new ProfileWorkspaceStartupRuntime({
      userData, profile: profile(), safeStorage: {},
    }).initialize();
    const candidates = directory(userData);
    candidates.anchorReviewedCurrent({
      profileId: 'hkustgz',
      profileKey: reviewed.authority.globalSettings.activeProfileKey,
      accountKey: reviewed.authority.globalSettings.activeAccountKey,
    });

    const onboarding = launch(userData, 'onboard');
    const marker = await waitForMarker(userData, onboarding.child, onboarding.output);
    successorPid = marker.pid;
    assert.equal(marker.activeContextEpoch, 2);
    assert.match(onboarding.output.value, /school onboarding explicit confirmation: PASS/u);
    const views = directory(userData).listViews({ locale: 'en' });
    assert.equal(views.length, 2);
    assert.equal(views.filter((view) => view.evidenceClass === 'custom-local').length, 1);
    assert.equal(fs.existsSync(path.join(userData, 'global', 'active-context-switch.json')), false);
    await stopOwnedProcess(successorPid); successorPid = null;

    try { fs.unlinkSync(path.join(userData, MARKER)); } catch {}
    const verification = launch(userData, 'verify');
    assert.equal(await waitForExit(verification.child, verification.output), 0,
      verification.output.value);
    assert.match(verification.output.value, /school onboarding custom branding: PASS/u);
    process.stdout.write('main school selector + custom Gateway onboarding: PASS\n');
  } finally {
    if (successorPid) await stopOwnedProcess(successorPid);
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
  }
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
