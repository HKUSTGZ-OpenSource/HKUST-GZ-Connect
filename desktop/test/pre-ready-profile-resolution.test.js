'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { CustomGatewayConfirmationOwner } = require('../lib/profiles/onboarding/custom-gateway-onboarding');
const { CustomProfileProvisioningRuntime } = require('../lib/profiles/provisioning/custom-profile-provisioning-runtime');
const { MultiSchoolStartupRuntime } = require('../lib/app/startup/multi-school-startup-runtime');
const { loadProfileWorkspaceAuthorityByKeys } =
  require('../lib/persistence/runtime/profile-workspace-runtime-authority');
const { selectProfileWorkspacePreReadyStorage } =
  require('../lib/persistence/runtime/profile-workspace-pre-ready-selection');
const { createPreReadySchoolProfileController } = require('../lib/profiles/runtime/school-profile-controller');
const { PROTOCOL_FAMILY } = require('../lib/profiles/schema/school-profile-schema');
const { protectWindowsFileOwnerOnly, verifyWindowsFileOwnerOnly } = require('../lib/platform/storage/windows-private-file');

const DESKTOP = path.join(__dirname, '..');

function root(t) {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-ready-profile-resolution-'));
  fs.chmodSync(value, 0o700);
  t.after(() => fs.rmSync(value, { recursive: true, force: true }));
  return value;
}

function writeJson(file, value) {
  const existed = fs.existsSync(file);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  if (process.platform === 'win32' && !existed) {
    assert.equal(protectWindowsFileOwnerOnly(file), true);
    assert.equal(verifyWindowsFileOwnerOnly(file), true);
  }
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
    accountHandle: `account-${'a'.repeat(36)}`, activeContextEpoch: 7,
  };
  const view = owner.issue({
    probeResult: {
      schema_version: 1, normalized_origin: 'https://vpn.example.edu',
      https_identity_valid: true, compatibility: 'recognized_candidate',
      candidate_family: PROTOCOL_FAMILY, reported_version: 'M7.6.8R2', http_status: 200,
    },
    activeContext: active,
  });
  const confirmation = owner.consume({ confirmationHandle: view.confirmationHandle,
    activeContext: active });
  let provisionSeed = 70;
  return new CustomProfileProvisioningRuntime({
    userData,
    randomBytes: (length) => Buffer.alloc(length, ++provisionSeed),
    now: () => 1_800_000_000_100,
  }).begin(confirmation);
}

function activateGlobal(userData, context) {
  writeJson(path.join(userData, 'global', 'settings.json'), {
    schemaVersion: 1,
    activeProfileKey: context.profileKey,
    activeAccountKey: context.accountKey,
    port: 6180,
    strictProxyAuth: true,
    proxySecurityVersion: 3,
    proxyAuthMigrationPending: false,
    closeAction: 'minimize',
    language: 'en',
    startAtLogin: false,
  });
  writeJson(path.join(userData, 'global', 'update-state.json'), {
    schemaVersion: 1, checkedAt: 0,
  });
}

function controller(userData) {
  return createPreReadySchoolProfileController({
    userData,
    packageRoot: DESKTOP,
    desktopDir: DESKTOP,
    resourcesPath: '/unused',
    isPackaged: false,
    randomBytes: (length) => Buffer.alloc(length, 9),
  });
}

test('clean custom authority resolves before path-bound services and survives startup verification', (t) => {
  const userData = root(t);
  const custom = provisionCustom(userData);
  activateGlobal(userData, custom.context);
  const active = controller(userData);
  assert.deepEqual(active.defaultRouteDomains, []);
  assert.equal(active.browserHomeUrl, null);
  assert.equal(active.browserPartition.startsWith('persist:campus-workspace-'), true);
  assert.equal(active.activeContextBinding().activeContextEpoch, 1);
  assert.equal(JSON.parse(active.verifyEngineLaunchBinding().stdinFrame).profileId, custom.profileId);

  let preReady;
  active.withProfileDocument((profile) => {
    preReady = selectProfileWorkspacePreReadyStorage({ userData, profile });
  });
  assert.equal(preReady.mode, 'profile-workspace');
  assert.equal(preReady.authority.profile.profileId, custom.profileId);
  assert.equal(preReady.authority.layout.browserPartition, active.browserPartition);
  assert.equal(preReady.authority.layout.browserPartition.startsWith('persist:campus-workspace-'), true);
  assert.equal(preReady.paths.vpnCredential, preReady.authority.layout.account.vpnCredential);
  assert.equal(preReady.authority.account.activeCredentialVersion, null);

  let fullAuthority;
  active.withProfileDocument((profile) => {
    fullAuthority = loadProfileWorkspaceAuthorityByKeys({
      userData,
      profile,
      profileKey: custom.context.profileKey,
      accountKey: custom.context.accountKey,
    });
  });

  const startup = new MultiSchoolStartupRuntime({
    userData,
    packageRoot: DESKTOP,
    desktopDir: DESKTOP,
    resourcesPath: '/unused',
    isPackaged: false,
  }).initialize({
    mode: preReady.mode,
    authority: fullAuthority,
    withProfileDocument: (callback) => active.withProfileDocument(callback),
  });
  assert.equal(startup.ready, true);
  assert.equal(startup.profileCount, 1);
});

test('unknown active profileKey cannot fall back to HKUST once candidate authority exists', (t) => {
  const userData = root(t);
  const custom = provisionCustom(userData);
  activateGlobal(userData, {
    ...custom.context,
    profileKey: `profile-${'9'.repeat(32)}`,
  });
  assert.throws(() => controller(userData), /not owned by a candidate/u);
});

test('missing GlobalSettings retains the reviewed first-run controller', (t) => {
  const active = controller(root(t));
  assert.deepEqual(active.defaultRouteDomains, ['hkust-gz.edu.cn', 'hkust.edu.hk']);
  assert.equal(active.browserPartition, 'persist:hkustgz-campus-browser');
});
