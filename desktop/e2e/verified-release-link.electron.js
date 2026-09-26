'use strict';

// Actual Main/Preload/Renderer with a synthetic GitHub transport and captured OS
// opener. No live update request, browser launch, login or installed App changes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, shell } = require('electron');
const { ProfileWorkspaceStartupRuntime } = require('../lib/persistence/runtime/profile-workspace-startup-runtime');
const { saveSettings } = require('../lib/persistence/settings/settings-store');
const { ensureOwnerOnly } = require('../lib/platform/storage/private-file');
const { protectWindowsFileOwnerOnly } = require('../lib/platform/storage/windows-private-file');
const { scheduleTemporaryProfileCleanup } = require('../scripts/temp-profile-cleanup');
const updates = require('../lib/platform/update/update-check');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-release-link-'));
scheduleTemporaryProfileCleanup(profile, 'hkustgz-release-link');
process.env.HKUSTGZ_USER_DATA_DIR = profile;
saveSettings(path.join(profile, 'settings.json'), {});
// This file was just created by this fixture; elevated Windows may assign Administrators ownership.
for (const name of ['settings.json', 'settings.json.bak']) {
  const file = path.join(profile, name);
  assert.equal(fs.existsSync(file), true, 'fixture requires both committed settings copies');
  if (process.platform === 'win32') assert.equal(protectWindowsFileOwnerOnly(file), true);
  assert.equal(ensureOwnerOnly(file), true,
    'synthetic legacy settings must have native private permissions before migration');
}
const persistence = new ProfileWorkspaceStartupRuntime({ userData: profile,
  profile: require('../assets/profiles/hkustgz/school-profile.json'), safeStorage: {},
}).initialize();
assert.equal(persistence.mode, 'profile-workspace');

const realCheck = updates.checkForUpdate;
let owner = 'heeh02';
let requests = 0;
const opened = [];
shell.openExternal = async url => { opened.push(url); };
updates.checkForUpdate = version => realCheck(version, async url => {
  requests++;
  const api = `https://api.github.com/repos/${owner}/${updates.REPOSITORY_NAME}`;
  const web = `https://github.com/${owner}/${updates.REPOSITORY_NAME}`;
  if (url === updates.REPOSITORY_API_URL) return {
    id: updates.REPOSITORY_ID, name: updates.REPOSITORY_NAME, full_name: `${owner}/${updates.REPOSITORY_NAME}`,
    owner: { login: owner }, private: false, visibility: 'public', archived: false, disabled: false,
    url: api, html_url: web, releases_url: `${api}/releases{/id}`,
  };
  assert.equal(url, `${api}/releases/latest`);
  return { tag_name: 'v99.0.0', draft: false, html_url: `${web}/releases/tag/v99.0.0` };
});
app.on('session-created', value => value.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] },
  (_details, callback) => callback({ cancel: true })));
require('../main');

async function waitFor(condition, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = await condition();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(label);
}

async function main() {
  await app.whenReady();
  const window = await waitFor(() => BrowserWindow.getAllWindows().find(candidate =>
    candidate.webContents.getURL().endsWith('/renderer/index.html') && !candidate.webContents.isLoading()),
  'control window missing');
  const invoke = expression => window.webContents.executeJavaScript(expression);
  const target = 'https://github.com/heeh02/HKUST-GZ-Connect/releases/tag/v99.0.0';
  assert.deepEqual(await invoke(`window.api.openExternal(${JSON.stringify(target)})`), { ok: false });
  assert.equal(opened.length, 0);
  const result = await invoke('window.api.checkUpdate(true)');
  assert.equal(result.updateAvailable, true);
  assert.equal(result.url, target);
  assert.deepEqual(await invoke(`window.api.openExternal(${JSON.stringify(target)})`), { ok: true },
    'Main must open the release URL returned by its successful identity-checked update request');
  assert.deepEqual(opened, [target]);
  await waitFor(() => invoke('Boolean(document.getElementById("updateDownload"))'), 'update action did not render');
  await invoke('document.getElementById("updateDownload").click()');
  await waitFor(() => opened.length === 2, 'update button did not invoke the verified opener');
  assert.deepEqual(opened, [target, target]);
  for (const url of [target + '/extra', target + '?unverified=1', target.replace('99.0.0', '99.0.1'),
    'https://github.com/another/repo/releases', 'file:///tmp/untrusted', 'https://example.invalid/']) {
    assert.deepEqual(await invoke(`window.api.openExternal(${JSON.stringify(url)})`), { ok: false });
  }
  assert.equal(opened.length, 2);
  owner = 'HKUSTGZ-OpenSource';
  const transferred = await invoke('window.api.checkUpdate(true)');
  assert.ok(transferred.url.includes('/HKUSTGZ-OpenSource/'));
  assert.deepEqual(await invoke(`window.api.openExternal(${JSON.stringify(target)})`), { ok: false });
  assert.deepEqual(await invoke(`window.api.openExternal(${JSON.stringify(transferred.url)})`), { ok: true });
  assert.deepEqual(opened, [target, target, transferred.url]);
  assert.equal(requests, 4, 'two explicit checks, each using metadata then latest-release fixtures');
  console.log('verified release link Main/Preload roundtrip: PASS');
}

main().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
