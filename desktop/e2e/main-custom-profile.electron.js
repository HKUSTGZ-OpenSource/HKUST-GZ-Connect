'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, dialog, session, webContents } = require('electron');
const { CustomGatewayConfirmationOwner } = require('../lib/profiles/onboarding/custom-gateway-onboarding');
const { CustomProfileProvisioningRuntime } = require('../lib/profiles/provisioning/custom-profile-provisioning-runtime');
const { PROTOCOL_FAMILY } = require('../lib/profiles/schema/school-profile-schema');

const {
  createPrivateStorageEffects,
  ensureOwnerOnly,
} = require('../lib/platform/storage/private-file');

const profileStorageEffects = createPrivateStorageEffects({ fileSystem: fs, platform: process.platform });

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-custom-main-e2e-'));
fs.chmodSync(userData, 0o700);
process.env.HKUSTGZ_USER_DATA_DIR = userData;
dialog.showErrorBox = (title, message) => {
  process.stderr.write(`custom-main-startup-error: ${title}: ${message}\n`);
};

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  assert.equal(ensureOwnerOnly(file), true, 'fixture JSON must have native private permissions');
}

function provision() {
  let seed = 1;
  const fixtureTimestamp = Date.now();
  const owner = new CustomGatewayConfirmationOwner({
    randomBytes: (length) => Buffer.alloc(length, seed++),
    now: () => fixtureTimestamp,
    ttlMs: 10_000,
  });
  const active = {
    profileId: 'hkustgz', profileRevision: 1,
    accountHandle: `account-${'a'.repeat(36)}`, activeContextEpoch: 7,
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
  const confirmation = owner.consume({ confirmationHandle: view.confirmationHandle,
    activeContext: active });
  let provisionSeed = 80;
  return new CustomProfileProvisioningRuntime({
    userData,
    profileStorageEffects,
    randomBytes: (length) => Buffer.alloc(length, ++provisionSeed),
    now: () => fixtureTimestamp,
  }).begin(confirmation);
}

const custom = provision();
const syntheticMutationErrors = [];
for (const [modulePath, className, method] of [
  ['../lib/persistence/credentials/profile-workspace-credential-store', 'ProfileWorkspaceCredentialStore', 'replace'],
  ['../lib/persistence/settings/profile-workspace-settings-store', 'ProfileWorkspaceSettingsStore', 'save'],
]) {
  const Owner = require(modulePath)[className];
  const original = Owner.prototype[method];
  Owner.prototype[method] = function (...args) {
    try { return original.apply(this, args); }
    catch (error) { syntheticMutationErrors.push(`${className}: ${error.message}`); throw error; }
  };
}
writeJson(path.join(userData, 'global', 'settings.json'), {
  schemaVersion: 1,
  activeProfileKey: custom.context.profileKey,
  activeAccountKey: custom.context.accountKey,
  port: 6180,
  strictProxyAuth: true,
  proxySecurityVersion: 3,
  proxyAuthMigrationPending: false,
  closeAction: 'minimize',
  language: 'en',
  startAtLogin: false,
});
writeJson(path.join(userData, 'global', 'update-state.json'), { schemaVersion: 1, checkedAt: 0 });

process.env.HKUSTGZ_SYNTHETIC_NETWORK_E2E = '1';
const updates = require('../lib/platform/update/update-check');
const OriginalUpdater = updates.UpdateNotificationRuntime;
updates.UpdateNotificationRuntime = class extends OriginalUpdater {
  constructor(effects) { super({ ...effects, check: async () => null }); }
};

const portalRuntime = require('../lib/browser/session/browser-session-manager');
const OriginalPortalRuntime = portalRuntime.MyPortalDataRuntime;
let portalDataSources;
let dataSnapshots = 0;
const portalReads = { session: 0, hint: 0, sources: 0 };
portalRuntime.MyPortalDataRuntime = class FixturePortalRuntime extends OriginalPortalRuntime {
  constructor(effects) {
    super({ ...effects,
      electronSession: { fromPartition: (...args) => {
        portalReads.session++; return effects.electronSession.fromPartition(...args);
      } },
      getSessionUrlHint: () => { portalReads.hint++; return effects.getSessionUrlHint(); },
      getSources: () => { portalReads.sources++; return effects.getSources(); },
    });
    portalDataSources = effects.getSources;
  }
  snapshot(options) { dataSnapshots++; return super.snapshot(options); }
};
require('../main');
portalRuntime.MyPortalDataRuntime = OriginalPortalRuntime;
updates.UpdateNotificationRuntime = OriginalUpdater;

async function waitFor(predicate, message) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

async function verifyUnconfiguredCards(control) {
  control.webContents.send('open-settings');
  await waitFor(() => control.webContents.executeJavaScript("!document.getElementById('dash').hidden"),
    'Control window did not show its workspace navigation');
  for (const [language, title] of [['en', 'No data source configured'], ['zh', '尚未配置数据来源']]) {
    await control.webContents.executeJavaScript(`window.api.save({ language: '${language}' })`);
    await control.webContents.executeJavaScript(`document.querySelector('.nav[data-page="browser"]').click()`);
    await waitFor(() => control.webContents.executeJavaScript(`
      [...document.querySelectorAll('.data-grid .module-note')].length === 3 &&
      [...document.querySelectorAll('.data-grid .module-note')].every(node => node.textContent === ${JSON.stringify(title)})
    `), 'Custom school did not render the translated unconfigured state');
    const reads = dataSnapshots;
    for (const [width, height] of [[440, 560], [1024, 768], [1440, 900]]) {
      control.setContentSize(width, height);
      for (const tab of ['Official', 'Personal']) {
        const display = await control.webContents.executeJavaScript(`(async () => {
          document.getElementById('serviceTab${tab}').click();
          document.getElementById('moduleSchedule').scrollIntoView({ block: 'start' });
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const grid = document.querySelector('.data-grid');
          return {
            controls: grid.querySelectorAll('button:not([hidden]), input, [data-entry-url]').length,
            badgesHidden: [...grid.querySelectorAll('.module-source')].every(node => node.hidden && getComputedStyle(node).display === 'none'),
            refreshHidden: getComputedStyle(document.getElementById('scheduleRefresh')).display === 'none',
            refreshDisabled: document.getElementById('scheduleRefresh').disabled,
            overflow: Math.max(document.documentElement.scrollWidth - innerWidth, grid.scrollWidth - grid.clientWidth),
            titles: [...grid.querySelectorAll('.module-note')].map(node => node.textContent),
          };
        })()`);
        assert.equal(display.controls, 0);
        assert.equal(display.badgesHidden, true);
        assert.equal(display.refreshHidden, true);
        assert.equal(display.refreshDisabled, true);
        assert.ok(display.overflow <= 1);
        assert.deepEqual(display.titles, [title, title, title]);
        const output = process.env.HKUSTGZ_CUSTOM_PROFILE_SCREENSHOT_DIR;
        if (output) {
          fs.mkdirSync(output, { recursive: true });
          fs.writeFileSync(path.join(output, `${language}-${tab}-${width}.png`),
            (await control.webContents.capturePage()).toPNG());
        }
      }
    }
    await control.webContents.executeJavaScript(`(async () => {
      document.querySelector('.nav[data-page="settings"]').click();
      document.querySelector('.nav[data-page="browser"]').click();
      await new Promise(resolve => requestAnimationFrame(resolve));
    })()`);
    assert.equal(dataSnapshots, reads, 'Unconfigured cards must not reload on workspace re-entry');
  }
  assert.deepEqual(portalReads, { session: 0, hint: 0, sources: 0 });
  process.stdout.write('custom Profile unconfigured campus-data cards: PASS\n');
}

async function run() {
  await app.whenReady();
  const control = await waitFor(() => BrowserWindow.getAllWindows().find((window) => (
    window.webContents.getURL().endsWith('/renderer/index.html') && !window.webContents.isLoading()
  )), 'custom Profile control window did not start');
  const state = await control.webContents.executeJavaScript('window.api.getState()');
  const emptyPortalSources = portalDataSources();
  assert.deepEqual(emptyPortalSources, {});
  assert.notEqual(portalDataSources(), emptyPortalSources,
    'actual Main custom Profile keeps fresh unsupported source maps without reading HKUST data');
  for (const expression of [
    'window.api.getCampusData()', 'window.api.refreshCampusData()',
    'window.api.refreshCampusSchedule()', "window.api.getCampusScheduleWeek({ date: '2027-01-11' })",
  ]) {
    const data = await control.webContents.executeJavaScript(expression);
    assert.equal(data.portalUrl, null);
    assert.equal(data.sessionState, 'unknown');
    for (const module of Object.values(data.modules)) {
      assert.equal(module.state, 'source-unavailable');
      assert.deepEqual(module.items, []);
    }
    for (const key of ['applications', 'applicationGroups', 'serviceItems', 'serviceGroups']) {
      assert.deepEqual(data.catalog[key], []);
    }
  }
  assert.deepEqual(portalReads, { session: 0, hint: 0, sources: 0 });
  assert.equal(state.schoolProfile.profileId, custom.profileId);
  assert.equal(state.schoolProfile.unverified, true);
  assert.equal(state.schoolProfile.normalizedGatewayOrigin, 'https://vpn.example.edu');
  assert.equal(state.hasPassword, false);
  assert.equal(state.loggedIn, false);
  assert.equal(state.connected, false);
  assert.deepEqual(state.campusResources, []);
  assert.deepEqual(state.settings.routeDomains, []);
  const profiles = await control.webContents.executeJavaScript('window.api.listSchoolProfiles()');
  assert.equal(profiles.ok, true);
  assert.equal(profiles.profiles.length, 1);
  assert.equal(profiles.profiles[0].profileId, custom.profileId);
  assert.equal(profiles.profiles[0].active, true);
  assert.equal(Object.hasOwn(profiles.profiles[0], 'accountKey'), false);
  await verifyUnconfiguredCards(control);

  const saved = await control.webContents.executeJavaScript(`window.api.save({
    expectedProfileId: ${JSON.stringify(custom.profileId)},
    username: 'synthetic-custom-user', password: 'synthetic-custom-password',
  })`);
  assert.equal(saved.ok, true, `first custom credential save must succeed: ${syntheticMutationErrors.join('; ')}`);
  const persisted = await control.webContents.executeJavaScript('window.api.getState()');
  assert.equal(persisted.hasPassword, true);
  assert.equal(persisted.settings.username, 'syn********', 'state must retain its account redaction boundary');
  const replaced = await control.webContents.executeJavaScript(`window.api.save({
    expectedProfileId: ${JSON.stringify(custom.profileId)},
    username: 'synthetic-custom-user-next', password: 'synthetic-custom-password-next',
  })`);
  assert.equal(replaced.ok, true, 'custom credential replacement must succeed');
  assert.equal((await control.webContents.executeJavaScript('window.api.getState()')).connected, false,
    'synthetic credential saves must not authenticate a Gateway');
  const cleared = await control.webContents.executeJavaScript('window.api.logout()');
  assert.equal(cleared.ok, true, 'custom credential clearing must not require unrelated legacy retirement');
  assert.equal((await control.webContents.executeJavaScript('window.api.getState()')).hasPassword, false);

  const opened = await control.webContents.executeJavaScript('window.api.openCampusBrowser({})');
  assert.deepEqual(opened, { ok: true, url: 'about:blank', route: 'direct' });
  await waitFor(() => BrowserWindow.getAllWindows().some((window) => (
    window.webContents.getURL().includes('/renderer/campus-browser.html')
  )), 'custom Profile Campus Browser did not open');
  const expectedPartition = custom.context.workspaceKey;
  const partitionName = `persist:campus-workspace-${require('node:crypto').createHash('sha256')
    .update('campus-connect-workspace-partition-v1\0', 'utf8')
    .update(expectedPartition, 'utf8').digest('hex').slice(0, 32)}`;
  const expectedSession = session.fromPartition(partitionName);
  const page = await waitFor(() => webContents.getAllWebContents().find((contents) => (
    contents !== control.webContents && contents.getURL().endsWith('/renderer/campus-workspace.html') &&
    contents.session === expectedSession
  )), 'custom Profile page did not use its Workspace-derived Session');
  assert.equal(page.session.getStoragePath().includes('hkustgz-campus-browser'), false);
  assert.equal(BrowserWindow.getAllWindows().length >= 2, true);
  process.stdout.write('main custom Profile startup: PASS\n');
}

run().then(() => app.quit()).catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
});

app.on('quit', () => {
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
});
