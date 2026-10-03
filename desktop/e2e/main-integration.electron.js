'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, webContents } = require('electron');
const { ProfileWorkspaceStartupRuntime } = require('../lib/persistence/runtime/profile-workspace-startup-runtime');
const { projectRuntimeSettings } = require('../lib/persistence/settings/profile-workspace-settings-bundle');
const { saveSettings } = require('../lib/persistence/settings/settings-store');
const { createLegacyRuntimeStoragePaths } = require('../lib/persistence/paths/runtime-storage-paths');
const { DesktopPersistenceRuntime } = require('../lib/persistence/runtime/desktop-persistence-runtime');
const { createT } = require('../lib/platform/i18n/i18n');

// Test-process-only update transport and quit gate. Every ordinary check is
// offline; a parked result is deliberately allowed to arrive after retirement.
const updates = require('../lib/platform/update/update-check');
const shells = require('../lib/platform/shell/desktop-shell');
const OriginalUpdater = updates.UpdateNotificationRuntime, OriginalShell = shells.DesktopShell;
let updater, lateUpdate, finishUpdate, updateSignal, updatesArmed = false, retiredSettings = false;
let validateQuit;
const quitValidated = new Promise(resolve => { validateQuit = resolve; });
const updateEffects = { read: 0, write: 0, notify: 0 };
updates.UpdateNotificationRuntime = class FixtureUpdater extends OriginalUpdater {
  constructor(effects) {
    super({ ...effects,
      check: (_version, { signal } = {}) => {
        if (!updatesArmed) return Promise.resolve(null);
        updateSignal = signal;
        return new Promise(resolve => { finishUpdate = resolve; });
      },
      readSettings: () => { updateEffects.read++;
        assert.equal(retiredSettings, false, 'update read after quit resource retirement'); return effects.readSettings(); },
      saveSettings: value => { updateEffects.write++;
        assert.equal(retiredSettings, false, 'update write after quit resource retirement'); return effects.saveSettings(value); },
      onAvailable: () => { updateEffects.notify++;
        assert.equal(retiredSettings, false, 'late update publication after quit'); return effects.onAvailable(); },
    });
    updater = this;
  }
};
shells.DesktopShell = class FixtureShell extends OriginalShell {
  constructor(effects) {
    super({ ...effects, cleanupQuit: async () => {
      if (updatesArmed) await quitValidated;
      return effects.cleanupQuit();
    } });
  }
};

// Test-process-only observation through Main's actual legacy callback. It must
// be translated and merged by ordinary startup before the first state read.
const recoveryKind = process.env.HKUSTGZ_FIXTURE_RECOVERY_KIND || 'restored';
assert.ok(['restored', 'defaults'].includes(recoveryKind));
const originalLegacyAdapter = DesktopPersistenceRuntime.createLegacyAdapter;
const originalLoadSettings = DesktopPersistenceRuntime.prototype.loadSettings;
let observeRecovery = null;
DesktopPersistenceRuntime.createLegacyAdapter = function captureRecovery(options) {
  observeRecovery = options.onRecovery;
  return originalLegacyAdapter.call(this, options);
};
DesktopPersistenceRuntime.prototype.loadSettings = function observeFixtureRecovery(...args) {
  if (observeRecovery) {
    const callback = observeRecovery;
    observeRecovery = null;
    callback({ kind: recoveryKind, quarantined: true });
  }
  return originalLoadSettings.apply(this, args);
};

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-main-e2e-'));
process.env.HKUSTGZ_USER_DATA_DIR = profile;
const fixtureLanguage = process.env.HKUSTGZ_FIXTURE_LANGUAGE || 'auto';
assert.ok(['auto', 'zh', 'en'].includes(fixtureLanguage));
saveSettings(path.join(profile, 'settings.json'), { language: fixtureLanguage });

const fingerprint = 'ab'.repeat(32);
fs.writeFileSync(path.join(profile, 'campus-certificate-trust.json'), JSON.stringify({
  version: 2,
  updatedAt: 1_800_000_000_000,
  pins: [{
    origin: 'https://certificate.example:4433',
    fingerprint,
    updatedAt: 1_800_000_000_000,
  }],
}), { mode: 0o600 });

const persistence = new ProfileWorkspaceStartupRuntime({
  userData: profile,
  profile: JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'assets', 'profiles', 'hkustgz', 'school-profile.json'),
    'utf8',
  )),
  // This fixture has no VPN credential. Startup still requires an explicit
  // protected-storage owner, but no encryption operation is performed.
  safeStorage: {},
}).initialize();
assert.equal(persistence.mode, 'profile-workspace');
const startupProjections = [...new Set([
  createLegacyRuntimeStoragePaths(profile).proxyHelperCredential,
  persistence.paths.proxyHelperCredential,
])];
for (const file of startupProjections) fs.writeFileSync(file, 'synthetic-startup-projection', { mode: 0o600 });

require('../main');
updates.UpdateNotificationRuntime = OriginalUpdater;
shells.DesktopShell = OriginalShell;
let quitChecked = false;
app.on('before-quit', () => {
  if (!updatesArmed || quitChecked) return;
  quitChecked = true;
  (async () => {
    assert.equal(updateSignal?.aborted, true, 'actual Main must cancel pending update before cleanup');
    const before = { ...updateEffects };
    retiredSettings = true;
    finishUpdate({ updateAvailable: true, latestVersion: '99.0.0',
      url: 'https://github.com/synthetic/project/releases/tag/v99.0.0' });
    assert.equal(await lateUpdate, null);
    assert.deepEqual(updateEffects, before);
    assert.equal(updater.inFlightCount, 0);
    assert.equal(updater.snapshot(), null);
    assert.deepEqual(updater.open('https://github.com/synthetic/project/releases/tag/v99.0.0'), { ok: false });
    process.stdout.write('main late update quit retirement: PASS\n');
    validateQuit();
  })().catch(error => { process.stderr.write(`${error.stack || error}\n`); app.exit(1); });
});
for (const file of startupProjections) assert.equal(fs.existsSync(file), false,
  'Main must retire both the legacy and selected disposable projections before services start');

async function waitForControlWindow() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const window = BrowserWindow.getAllWindows().find((candidate) => (
      candidate.webContents.getURL().endsWith('/renderer/index.html')
    ));
    if (window && !window.webContents.isLoading()) return window;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('control window did not become ready');
}

async function invoke(window, expression) {
  return window.webContents.executeJavaScript(`(async () => (${expression}))()`);
}

async function waitFor(condition, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = condition();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

async function waitForRenderer(window, expression, message) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

async function run() {
  await app.whenReady();
  const control = await waitForControlWindow();

  const initial = await invoke(control, 'window.api.getState()');
  assert.equal(initial.settings.port, 1080);
  assert.equal(initial.dnsMode, 'unknown');
  assert.equal(initial.notice, createT(initial.locale)(recoveryKind === 'restored'
    ? 'error.settingsRestored' : 'error.settingsDefaults'));
  assert.deepEqual(await invoke(control, 'window.api.getLoginAccount()'), { ok: true, username: '' });
  const initialCardBoard = await invoke(control, 'window.api.getCardBoardLayout()');
  assert.equal(initialCardBoard.document.schemaVersion, 1);
  const cataloguePlacement = initialCardBoard.document.placements.find(({ boardId, card }) => (
    boardId === 'browser-catalog' && card.kind === 'official-category'
  ));
  assert.ok(cataloguePlacement, 'reviewed categories must receive a default card placement');
  const pinnedCardBoard = await invoke(control, `window.api.commitCardBoardLayout(${JSON.stringify({
    baseRevision: 0,
    operations: [{
      type: 'pin-to-board',
      sourcePlacementId: '__SOURCE__',
      boardId: 'connect',
      index: 1,
      size: 'medium',
    }],
  }).replace('__SOURCE__', cataloguePlacement.placementId)})`);
  assert.equal(pinnedCardBoard.changed, true);
  assert.ok(pinnedCardBoard.document.placements.some(({ boardId, card }) => (
    boardId === 'browser-catalog' && card.id === cataloguePlacement.card.id
  )), 'pinning must retain the source card');
  assert.ok(pinnedCardBoard.document.placements.some(({ boardId, card }) => (
    boardId === 'connect' && card.id === cataloguePlacement.card.id
  )), 'pinning must add a connect-board reference');
  const cardBoardFile = path.join(path.dirname(persistence.paths.resourceFavorites), 'card-board-layout.json');
  const storedCardBoard = await waitFor(() => {
    try { return JSON.parse(fs.readFileSync(cardBoardFile, 'utf8')); } catch { return null; }
  }, 'card board layout was not persisted');
  assert.equal(storedCardBoard.revision, 1);
  assert.doesNotMatch(JSON.stringify(storedCardBoard), /https?:|<[^>]+>/u);

  const usernameWithoutPassword = await invoke(control, `window.api.save({
    username: 'e2e-user',
  })`);
  assert.equal(usernameWithoutPassword.ok, false);
  assert.equal(usernameWithoutPassword.settings.username, '');

  const savedSettings = await invoke(control, `window.api.save({
    port: 6180,
    strictProxyAuth: false,
  })`);
  assert.equal(savedSettings.ok, true);
  assert.equal(savedSettings.settings.port, 6180);

  const savedRule = await invoke(control, `window.api.saveRoutingRule({
    host: 'login.microsoftonline.com',
    includeSubdomains: false,
    route: 'direct',
  })`);
  assert.equal(savedRule.ok, true);
  assert.equal(savedRule.rules.length, 1);
  assert.equal(savedRule.rules[0].route, 'direct');
  const listedRules = await invoke(control, 'window.api.listRoutingRules()');
  assert.deepEqual(listedRules.rules.map((rule) => ({
    host: rule.host,
    includeSubdomains: rule.includeSubdomains,
    route: rule.route,
  })), [{
    host: 'login.microsoftonline.com',
    includeSubdomains: false,
    route: 'direct',
  }]);
  const profiles = await invoke(control, 'window.api.listSchoolProfiles()');
  assert.equal(profiles.ok, true);
  assert.equal(profiles.profiles.length, 1);
  assert.equal(profiles.profiles[0].profileId, 'hkustgz');
  assert.equal(profiles.profiles[0].active, true);
  assert.equal(Object.hasOwn(profiles.profiles[0], 'profileKey'), false);

  const savedResource = await invoke(control, `window.api.saveResource({
    name: '测试 IP 服务',
    description: '自定义端口',
    url: 'https://103.189.154.10:4433',
    route: 'campus',
  })`);
  assert.equal(savedResource.ok, true, JSON.stringify(savedResource));
  assert.equal(savedResource.resource.url, 'https://103.189.154.10:4433/');
  assert.equal(savedResource.resources.filter((resource) => (
    resource.url === 'https://103.189.154.10:4433/'
  )).length, 1);

  const listedPins = await invoke(control, 'window.api.listCertificatePins()');
  assert.equal(listedPins.ok, true);
  assert.equal(listedPins.pins.length, 1);
  assert.equal(listedPins.pins[0].fingerprint, fingerprint);
  const deletedPin = await invoke(control, `window.api.deleteCertificatePin({
    origin: 'https://certificate.example:4433',
    fingerprint: '${fingerprint}',
  })`);
  assert.deepEqual(deletedPin, { ok: true, pins: [] });

  const managerVisible = await control.webContents.executeJavaScript(`(async () => {
    document.getElementById('manageRoutingRules').click();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return document.getElementById('routingRulesDialog').open;
  })()`);
  assert.equal(managerVisible, true);

  const strictSettings = await invoke(control, `window.api.save({ strictProxyAuth: true })`);
  assert.equal(strictSettings.ok, true);
  assert.equal(strictSettings.proxyAuthChanged, true);
  assert.equal(strictSettings.settings.strictProxyAuth, true);
  const directWithoutTunnel = await invoke(control, `window.api.openCampusBrowser({
    url: 'https://outlook.office.com/owa/',
  })`);
  assert.equal(directWithoutTunnel.ok, true,
    'a Direct first page must not require the campus Engine');
  assert.equal(BrowserWindow.getAllWindows().some((candidate) => (
    candidate.webContents.getURL().includes('/renderer/campus-browser.html')
  )), true);
  const campusWindow = BrowserWindow.getAllWindows().find((candidate) => (
    candidate.webContents.getURL().includes('/renderer/campus-browser.html')
  ));
  for (const language of ['en', 'zh']) {
    assert.equal((await invoke(control, `window.api.save({ language: '${language}' })`)).ok, true);
    assert.equal((await invoke(control, 'window.api.getState()')).locale, language);
    const htmlLanguage = language === 'zh' ? 'zh-CN' : 'en';
    await waitForRenderer(control, `document.documentElement.lang === '${htmlLanguage}'`,
      'Control locale did not follow the saved language');
    await waitForRenderer(campusWindow, `document.documentElement.lang === '${htmlLanguage}'`,
      'Browser locale did not follow the same Desktop owner');
  }
  await campusWindow.webContents.executeJavaScript(
    `document.getElementById('browserSettings').click()`,
  );
  await waitForRenderer(control,
    `document.querySelector('.page[data-page="settings"]')?.hidden === false`,
    'Campus Browser settings button did not open Settings');
  const portalOpen = await invoke(control, 'window.api.openCampusBrowser({})');
  assert.equal(portalOpen.ok, true,
    'the reviewed Direct official portal must remain usable without the campus Engine');
  const workspaceOpen = await invoke(control, 'window.api.openBookmarkManager()');
  assert.deepEqual(workspaceOpen, { ok: true, url: 'about:blank', route: 'direct' });
  const workspace = await waitFor(() => webContents.getAllWebContents().find((contents) => (
    contents.getURL().endsWith('/renderer/campus-workspace.html') && !contents.isLoading()
  )), 'Campus Workspace renderer did not start');
  assert.equal(await workspace.executeJavaScript(
    `window.campusWorkspace.command('toggle-favorite', { resourceId: 'canvas' })`,
  ), true);
  assert.equal(await workspace.executeJavaScript(
    `window.campusWorkspace.command('create-group', { name: '学习' })`,
  ), true);
  const groupFile = path.join(path.dirname(persistence.paths.resourceFavorites), 'favorite-groups.json');
  const groupDocument = await waitFor(() => {
    try { return JSON.parse(fs.readFileSync(groupFile, 'utf8')); } catch { return null; }
  }, 'Campus Workspace group was not persisted');
  assert.equal(groupDocument.schemaVersion, 2);
  assert.equal(groupDocument.collections[0].name, '学习');
  assert.equal(await workspace.executeJavaScript(
    `window.campusWorkspace.command('move-resource', {
      resourceId: 'canvas', groupId: '${groupDocument.collections[0].id}', index: 0,
    })`,
  ), true);
  const movedGroup = await waitFor(() => {
    const document = JSON.parse(fs.readFileSync(groupFile, 'utf8'));
    return document.placements.some(({ collectionId, resourceId }) => (
      collectionId === document.collections[0].id && resourceId === 'canvas'
    )) ? document : null;
  }, 'Campus Workspace favorite was not moved into its group');
  assert.deepEqual(movedGroup.placements.map(({ resourceId }) => resourceId), ['canvas']);

  const settings = projectRuntimeSettings(persistence.reloadAuthority());
  assert.equal(settings.username, '');
  assert.equal(settings.port, 6180);
  assert.equal(settings.strictProxyAuth, true);
  const rules = JSON.parse(fs.readFileSync(persistence.paths.routingRules, 'utf8'));
  assert.equal(rules.version, 1);
  assert.equal(rules.rules[0].host, 'login.microsoftonline.com');
  assert.ok(fs.readFileSync(persistence.paths.externalPac, 'utf8').includes('127.0.0.1:6180'));
  process.stdout.write('main integration: PASS\n');
  updatesArmed = true;
  lateUpdate = updater.run(true);
  await waitFor(() => typeof finishUpdate === 'function', 'parked Main update request');
}

run().then(
  () => app.quit(),
  (error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
    app.exit(1);
  },
);

app.on('quit', () => {
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
});
