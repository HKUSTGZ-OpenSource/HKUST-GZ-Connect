'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const desktopRoot = path.resolve(__dirname, '..', '..', '..', '..');
const { LEGACY_COPY_SOURCE_IDS } = require('../../../../lib/persistence/migration/legacy-hkust/hkust-migration-destination-plan');
const {
  selectProfileWorkspacePreReadyStorage,
} = require('../../../../lib/persistence/runtime/profile-workspace-pre-ready-selection');
const { ProfileWorkspaceStartupRuntime } = require('../../../../lib/persistence/runtime/profile-workspace-startup-runtime');
const { createLegacyFlatSourcePaths } = require('../../../../lib/persistence/paths/profile-workspace-layout');
const { normalizeSettings } = require('../../../../lib/persistence/settings/settings-store');
const { protectWindowsFileOwnerOnly, verifyWindowsFileOwnerOnly } = require('../../../../lib/platform/storage/windows-private-file');

function profile() {
  return JSON.parse(fs.readFileSync(
    path.join(desktopRoot, 'assets', 'profiles', 'hkustgz', 'school-profile.json'),
    'utf8',
  ));
}

function safeStorage() {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'keychain',
    encryptString: (value) => Buffer.from(value, 'utf8').map((byte) => byte ^ 0xa5),
    decryptString: (value) => Buffer.from(value).map((byte) => byte ^ 0xa5).toString('utf8'),
  };
}

function migratedFixture(t) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-pre-ready-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const legacy = createLegacyFlatSourcePaths(userData);
  const settings = Buffer.from(JSON.stringify(normalizeSettings({
    username: 'synthetic-user',
    port: 6180,
  })), 'utf8');
  fs.writeFileSync(legacy.settings, settings, { mode: 0o600 });
  fs.writeFileSync(legacy.settingsBackup, settings, { mode: 0o600 });
  fs.writeFileSync(legacy.vpnCredential, safeStorage().encryptString('synthetic-password'), {
    mode: 0o600,
  });
  for (const id of LEGACY_COPY_SOURCE_IDS) {
    if (id === 'routingRules') {
      fs.writeFileSync(legacy[id], '{"schemaVersion":1,"rules":[]}', { mode: 0o600 });
    }
  }
  if (process.platform === 'win32') {
    for (const file of Object.values(legacy)) {
      if (!fs.existsSync(file)) continue;
      assert.equal(protectWindowsFileOwnerOnly(file), true);
      assert.equal(verifyWindowsFileOwnerOnly(file), true);
    }
  }
  let entropy = 1;
  let timestamp = 1_700_000_000_000;
  const runtime = new ProfileWorkspaceStartupRuntime({
    userData,
    profile: profile(),
    safeStorage: safeStorage(),
    platform: process.platform,
    randomBytes: () => Buffer.alloc(16, entropy++),
    now: () => timestamp++,
  }).initialize();
  return { userData, runtime };
}

test('pre-ready selection uses legacy only when no destination exists', (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-pre-ready-empty-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const selected = selectProfileWorkspacePreReadyStorage({
    userData,
    profile: profile(),
  });
  assert.equal(selected.mode, 'legacy-flat');
  assert.equal(selected.reason, 'no-destination');
  assert.equal(selected.paths.settings, path.join(userData, 'settings.json'));
});

test('verified destination selects scoped paths even during credential presence mismatch', (t) => {
  const value = migratedFixture(t);
  fs.unlinkSync(value.runtime.paths.vpnCredential);
  const selected = selectProfileWorkspacePreReadyStorage({
    userData: value.userData,
    profile: profile(),
  });
  assert.equal(selected.mode, 'profile-workspace');
  assert.equal(selected.reason, 'verified-destination');
  assert.equal(selected.paths.vpnCredential, value.runtime.paths.vpnCredential);
  assert.equal(selected.authority.account.activeCredentialVersion, 1);
});

test('migration journal keeps pre-ready services on the legacy path set', (t) => {
  const value = migratedFixture(t);
  fs.writeFileSync(
    path.join(value.userData, 'global', 'profile-account-workspace-migration.json'),
    '{}',
    { mode: 0o600 },
  );
  const selected = selectProfileWorkspacePreReadyStorage({
    userData: value.userData,
    profile: profile(),
  });
  assert.equal(selected.mode, 'legacy-flat');
  assert.equal(selected.reason, 'migration-recovery');
});
