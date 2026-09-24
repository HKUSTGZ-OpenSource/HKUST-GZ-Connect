'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, dialog, session, webContents } = require('electron');
const { CustomGatewayConfirmationOwner } = require('../lib/profiles/onboarding/custom-gateway-onboarding');
const { CustomProfileProvisioningRuntime } = require('../lib/profiles/provisioning/custom-profile-provisioning-runtime');
const { PROTOCOL_FAMILY } = require('../lib/profiles/schema/school-profile-schema');

const { ensureOwnerOnly } = require('../lib/platform/storage/private-file');

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
  const owner = new CustomGatewayConfirmationOwner({
    randomBytes: (length) => Buffer.alloc(length, seed++),
    now: () => 1_800_000_000_000,
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
    randomBytes: (length) => Buffer.alloc(length, ++provisionSeed),
    now: () => 1_800_000_000_100,
  }).begin(confirmation);
}

const custom = provision();
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

require('../main');

async function waitFor(predicate, message) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

async function run() {
  await app.whenReady();
  const control = await waitFor(() => BrowserWindow.getAllWindows().find((window) => (
    window.webContents.getURL().endsWith('/renderer/index.html') && !window.webContents.isLoading()
  )), 'custom Profile control window did not start');
  const state = await control.webContents.executeJavaScript('window.api.getState()');
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
