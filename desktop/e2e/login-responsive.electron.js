'use strict';

// Issue #97: exercise the real control renderer against Main using a synthetic
// workspace. Count synchronous ACL subprocesses, not machine-specific timings.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { app, BrowserWindow } = require('electron');

let aclCalls = 0;
const execute = childProcess.execFileSync;
childProcess.execFileSync = function (file, ...args) {
  if (/^(?:powershell\.exe|ec-private-file-windows-.*\.exe)$/iu.test(path.basename(String(file)))) aclCalls += 1;
  return execute.call(this, file, ...args);
};

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-login-responsive-'));
process.env.HKUSTGZ_USER_DATA_DIR = profile;
app.setPath('userData', profile);
app.disableHardwareAcceleration();
const { saveSettings } = require('../lib/persistence/settings/settings-store');
const { ProfileWorkspaceStartupRuntime } = require('../lib/persistence/runtime/profile-workspace-startup-runtime');
saveSettings(path.join(profile, 'settings.json'), { autoConnect: false });
const schoolProfile = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'assets', 'profiles', 'hkustgz', 'school-profile.json'), 'utf8',
));
const persistence = new ProfileWorkspaceStartupRuntime({
  userData: profile, profile: schoolProfile, safeStorage: {},
}).initialize();
assert.equal(persistence.mode, 'profile-workspace');
const { FavoriteGroupStore } = require('../lib/resources/runtime/favorite-group-store');
new FavoriteGroupStore({
  filePath: path.join(path.dirname(persistence.paths.resourceFavorites), 'favorite-groups.json'),
}).create('Synthetic collection');

const started = performance.now();
require('../main');

async function run() {
  await app.whenReady();
  const deadline = Date.now() + 30_000;
  let control;
  while (Date.now() < deadline) {
    control = BrowserWindow.getAllWindows().find((window) =>
      window.webContents.getURL().endsWith('/renderer/index.html') &&
      !window.webContents.isLoading());
    if (control) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(control, 'the login control window must become ready');
  const startupMs = Math.round(performance.now() - started);
  const before = aclCalls;
  const responseStarted = performance.now();
  for (let index = 0; index < 5; index += 1) {
    const state = await control.webContents.executeJavaScript('window.api.getState()');
    assert.equal(state.connected, false);
    assert.equal(state.settings.autoConnect, false);
  }
  const responseMs = Math.round(performance.now() - responseStarted);
  const pollingAclCalls = aclCalls - before;
  const editable = await control.webContents.executeJavaScript(`(() => {
    const input = Array.from(document.querySelectorAll('input')).find((node) =>
      !node.disabled && node.type !== 'hidden' && node.getClientRects().length > 0);
    if (!input) return false;
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'synthetic-edit');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value === 'synthetic-edit';
  })()`);
  console.log(JSON.stringify({ platform: process.platform, startupMs, responseMs,
    pollingAclCalls, editable }));
  assert.equal(pollingAclCalls, 0, 'state polling must not synchronously launch ACL subprocesses');
  assert.ok(editable, 'the login page must accept input');
  console.log('login responsiveness: PASS');
}

const timeout = setTimeout(() => { console.error('login responsiveness: timeout'); app.exit(1); }, 120_000);
run().then(() => { clearTimeout(timeout); app.exit(0); }, (error) => {
  clearTimeout(timeout); console.error(error.stack || error); app.exit(1);
});
app.on('quit', () => {
  childProcess.execFileSync = execute;
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
});

