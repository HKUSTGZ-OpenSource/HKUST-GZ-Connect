'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const desktopRoot = path.resolve(__dirname, '..', '..', '..', '..');
const { LEGACY_COPY_SOURCE_IDS } = require('../../../../lib/persistence/migration/legacy-hkust/hkust-migration-destination-plan');
const { createLegacyCredentialRollbackStoreForAuthority } =
  require('../../../../lib/persistence/migration/legacy-hkust/legacy-credential-rollback-store');
const { ProfileWorkspaceCredentialStore } = require('../../../../lib/persistence/credentials/profile-workspace-credential-store');
const {
  loadActiveProfileAccountAuthority,
  loadActiveProfileWorkspaceAuthority,
} = require('../../../../lib/persistence/runtime/profile-workspace-runtime-authority');
const { ProfileWorkspaceSettingsStore } = require('../../../../lib/persistence/settings/profile-workspace-settings-store');
const { ProfileWorkspaceStartupRuntime } = require('../../../../lib/persistence/runtime/profile-workspace-startup-runtime');
const { createLegacyFlatSourcePaths } = require('../../../../lib/persistence/paths/profile-workspace-layout');
const { projectRuntimeSettings } = require('../../../../lib/persistence/settings/profile-workspace-settings-bundle');
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

function fixture(t) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-startup-runtime-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const legacy = createLegacyFlatSourcePaths(userData);
  const settings = Buffer.from(JSON.stringify(normalizeSettings({
    username: 'synthetic-user',
    port: 6180,
    routeDomains: ['hkust-gz.edu.cn'],
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
  const options = {
    userData,
    profile: profile(),
    safeStorage: safeStorage(),
    platform: process.platform,
    randomBytes: () => Buffer.alloc(16, entropy++),
    now: () => timestamp++,
  };
  return { userData, legacy, options };
}

function credentialStrings(store) {
  const owner = store.open();
  try { return owner?.withStrings((username, password) => ({ username, password })) || null; }
  finally { owner?.destroy(); }
}

function authorityLoaders(value) {
  return {
    account: () => loadActiveProfileAccountAuthority({
      userData: value.userData,
      profile: profile(),
    }),
    workspace: () => loadActiveProfileWorkspaceAuthority({
      userData: value.userData,
      profile: profile(),
    }),
  };
}

function rollbackRetirer(authority, reason) {
  return createLegacyCredentialRollbackStoreForAuthority({ authority }).retire({ reason });
}

test('startup migrates then exposes working settings and credential adapters', (t) => {
  const value = fixture(t);
  const startup = new ProfileWorkspaceStartupRuntime(value.options);
  let result = startup.initialize();
  assert.equal(result.mode, 'profile-workspace');
  assert.equal(result.migration.status, 'migrated');
  assert.deepEqual(credentialStrings(result.credentialStore), {
    username: 'synthetic-user',
    password: 'synthetic-password',
  });
  const nextSettings = {
    ...projectRuntimeSettings(result.authority),
    port: 6280,
  };
  assert.equal(result.settingsStore.save(nextSettings).changed, true);
  assert.equal(loadActiveProfileWorkspaceAuthority({
    userData: value.userData,
    profile: profile(),
  }).globalSettings.port, 6280);

  result.credentialStore.replace({ username: 'next-user', password: 'next-password' });
  assert.deepEqual(credentialStrings(result.credentialStore), {
    username: 'next-user',
    password: 'next-password',
  });
  assert.equal(fs.existsSync(result.authority.layout.account.legacyCredentialRollbackBlob), false);
  result.credentialStore.clear();
  assert.equal(credentialStrings(result.credentialStore), null);

  result = startup.initialize();
  assert.equal(result.migration.status, 'already_migrated');
  assert.equal(result.authority.globalSettings.port, 6280);
  assert.equal(result.authority.hasCredential, false);
});

test('startup repairs credential intermediate state before complete authority load', (t) => {
  const value = fixture(t);
  const first = new ProfileWorkspaceStartupRuntime(value.options).initialize();
  first.credentialStore.replace({ username: 'current-user', password: 'current-password' });
  const loaders = authorityLoaders(value);
  const injected = Object.create(fs);
  injected.renameSync = (from, to) => {
    if (to === first.authority.layout.account.document) throw new Error('simulated Account crash');
    return fs.renameSync(from, to);
  };
  const crashing = new ProfileWorkspaceCredentialStore({
    loadAccountAuthority: loaders.account,
    loadWorkspaceAuthority: loaders.workspace,
    retireRollback: ({ authority, reason }) => rollbackRetirer(authority, reason),
    safeStorage: safeStorage(),
    platform: process.platform,
    fileSystem: injected,
    randomBytes: () => Buffer.alloc(16, 0x77),
    now: () => 1_700_000_001_000,
  });
  assert.throws(() => crashing.replace({ username: 'recovered-user', password: 'recovered-password' }),
    /Account write failed/u);
  assert.equal(fs.existsSync(first.authority.layout.account.credentialTransaction), true);

  const recovered = new ProfileWorkspaceStartupRuntime(value.options).initialize();
  assert.deepEqual(credentialStrings(recovered.credentialStore), {
    username: 'recovered-user',
    password: 'recovered-password',
  });
  assert.equal(fs.existsSync(recovered.authority.layout.account.credentialTransaction), false);
});

test('startup finishes a pending split settings redo after credential recovery', (t) => {
  const value = fixture(t);
  const first = new ProfileWorkspaceStartupRuntime(value.options).initialize();
  const loaders = authorityLoaders(value);
  const injected = Object.create(fs);
  injected.renameSync = (from, to) => {
    if (to === first.authority.layout.workspace.settings) {
      throw new Error('simulated Workspace settings crash');
    }
    return fs.renameSync(from, to);
  };
  const crashing = new ProfileWorkspaceSettingsStore({
    loadAuthority: loaders.workspace,
    fileSystem: injected,
    platform: process.platform,
    randomBytes: () => Buffer.alloc(16, 0x78),
    now: () => 1_700_000_001_000,
  });
  assert.throws(() => crashing.save({
    ...projectRuntimeSettings(first.authority),
    port: 6380,
    autoConnect: false,
  }), /target write failed/u);
  const recovered = new ProfileWorkspaceStartupRuntime(value.options).initialize();
  assert.equal(recovered.authority.globalSettings.port, 6380);
  assert.equal(recovered.authority.workspaceSettings.autoConnect, false);
  assert.equal(fs.existsSync(recovered.authority.layout.global.settingsTransaction), false);
});
