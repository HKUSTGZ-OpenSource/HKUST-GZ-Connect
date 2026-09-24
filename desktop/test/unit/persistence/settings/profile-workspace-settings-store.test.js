'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { protectWindowsFileOwnerOnly, verifyWindowsFileOwnerOnly } =
  require('../../../../lib/platform/storage/windows-private-file');
const desktopRoot = path.resolve(__dirname, '..', '..', '..', '..');
const {
  createProfileAccountWorkspaceLayout,
} = require('../../../../lib/persistence/paths/profile-workspace-layout');
const {
  loadActiveProfileWorkspaceAuthority,
} = require('../../../../lib/persistence/runtime/profile-workspace-runtime-authority');
const {
  projectRuntimeSettings,
} = require('../../../../lib/persistence/settings/profile-workspace-settings-bundle');
const {
  ProfileWorkspaceSettingsStore,
} = require('../../../../lib/persistence/settings/profile-workspace-settings-store');

const PROFILE_KEY = `profile-${'11'.repeat(16)}`;
const ACCOUNT_KEY = `account-${'22'.repeat(16)}`;
const WORKSPACE_KEY = `workspace-${'33'.repeat(16)}`;

function profile() {
  return JSON.parse(fs.readFileSync(
    path.join(desktopRoot, 'assets', 'profiles', 'hkustgz', 'school-profile.json'),
    'utf8',
  ));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  // Only synthetic fixture files: POSIX mode does not establish a Windows private ACL.
  if (process.platform === 'win32') {
    assert.equal(protectWindowsFileOwnerOnly(file), true);
    assert.equal(verifyWindowsFileOwnerOnly(file), true);
  }
}

function fixture(t) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-settings-store-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const layout = createProfileAccountWorkspaceLayout({
    userData,
    profileKey: PROFILE_KEY,
    accountKey: ACCOUNT_KEY,
    workspaceKey: WORKSPACE_KEY,
    adoptLegacyHkustBrowserPartition: true,
  });
  writeJson(layout.global.settings, {
    schemaVersion: 1,
    activeProfileKey: PROFILE_KEY,
    activeAccountKey: ACCOUNT_KEY,
    port: 6180,
    strictProxyAuth: true,
    proxySecurityVersion: 3,
    proxyAuthMigrationPending: false,
    closeAction: 'ask',
    language: 'zh',
    startAtLogin: false,
  });
  writeJson(layout.global.updateState, { schemaVersion: 1, checkedAt: 0 });
  writeJson(layout.profile.settings, {
    schemaVersion: 1,
    profileId: 'hkustgz',
    profileRevision: 1,
    primaryAccountKey: ACCOUNT_KEY,
  });
  writeJson(layout.profile.state, {
    schemaVersion: 1,
    migrationId: `migration-${'44'.repeat(16)}`,
    profileId: 'hkustgz',
    profileRevision: 1,
    profileCredentialBindingRevision: 1,
    gatewayOrigin: 'https://remote.hkust-gz.edu.cn',
    protocolFamily: 'easyconnect-password-modern-l3-v1',
  });
  writeJson(layout.account.document, {
    schemaVersion: 1,
    accountKey: ACCOUNT_KEY,
    accountRevision: 1,
    accountCredentialRevision: 1,
    role: 'primary',
    state: 'enabled',
    profileId: 'hkustgz',
    profileRevision: 1,
    gatewayOrigin: 'https://remote.hkust-gz.edu.cn',
    protocolFamily: 'easyconnect-password-modern-l3-v1',
    workspaceKey: WORKSPACE_KEY,
    activeCredentialVersion: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  });
  writeJson(layout.workspace.settings, {
    schemaVersion: 1,
    autoReconnect: true,
    maxAttempts: 3,
    autoConnect: false,
    routeDomains: ['hkust-gz.edu.cn'],
  });
  writeJson(layout.workspace.state, {
    schemaVersion: 1,
    profileId: 'hkustgz',
    profileRevision: 1,
    accountKey: ACCOUNT_KEY,
    accountRevision: 1,
    workspaceKey: WORKSPACE_KEY,
    activeContextEpoch: 1,
  });
  writeJson(layout.workspace.localResources, { schemaVersion: 1, resources: [] });
  const loadAuthority = () => loadActiveProfileWorkspaceAuthority({ userData, profile: profile() });
  return { userData, layout, loadAuthority };
}

function store(value, options = {}) {
  return new ProfileWorkspaceSettingsStore({
    loadAuthority: value.loadAuthority,
    randomBytes: () => Buffer.alloc(16, 0x55),
    now: () => 1_700_000_000_100,
    ...options,
  });
}

function nextSettings(value) {
  return {
    ...projectRuntimeSettings(value.loadAuthority()),
    username: 'synthetic-user',
    port: 6280,
    autoReconnect: false,
    maxAttempts: 5,
    autoConnect: true,
    closeAction: 'minimize',
    language: 'en',
    updateCheckedAt: 1_700_000_000_200,
    routeDomains: ['hkust-gz.edu.cn', 'hkust.edu.hk'],
    customResources: [{
      id: 'local-synthetic',
      name: 'Synthetic',
      description: 'Local fixture',
      url: 'https://example.edu/',
      route: 'campus',
      category: 'custom',
      keywords: [],
    }],
  };
}

test('settings transaction commits every split document and clears its redo intent', (t) => {
  const value = fixture(t);
  const result = store(value).save(nextSettings(value));
  assert.equal(result.changed, true);
  assert.equal(fs.existsSync(value.layout.global.settingsTransaction), false);
  const authority = value.loadAuthority();
  assert.equal(authority.globalSettings.port, 6280);
  assert.equal(authority.workspaceSettings.autoReconnect, false);
  assert.equal(authority.globalUpdateState.checkedAt, 1_700_000_000_200);
  assert.equal(authority.localResources.resources.length, 1);
  assert.equal(store(value).save(nextSettings(value)).changed, false);
});

test('crash during split writes resumes all-new from the durable redo intent', (t) => {
  const value = fixture(t);
  const injected = Object.create(fs);
  injected.renameSync = (from, to) => {
    if (to === value.layout.workspace.settings) throw new Error('simulated target crash');
    return fs.renameSync(from, to);
  };
  assert.throws(() => store(value, { fileSystem: injected }).save(nextSettings(value)),
    /target write failed/u);
  assert.equal(fs.existsSync(value.layout.global.settingsTransaction), true);
  assert.equal(
    fs.readFileSync(value.layout.global.settingsTransaction, 'utf8').includes('synthetic-user'),
    false,
  );
  assert.equal(JSON.parse(fs.readFileSync(value.layout.global.settings, 'utf8')).port, 6280);
  assert.equal(JSON.parse(fs.readFileSync(value.layout.workspace.settings, 'utf8')).autoConnect, false);
  assert.equal(store(value).reconcile().changed, true);
  assert.equal(value.loadAuthority().workspaceSettings.autoConnect, true);
  assert.equal(fs.existsSync(value.layout.global.settingsTransaction), false);
});

test('failure before the redo intent commit leaves every split document unchanged', (t) => {
  const value = fixture(t);
  const injected = Object.create(fs);
  injected.renameSync = (from, to) => {
    if (to === value.layout.global.settingsTransaction) throw new Error('simulated intent crash');
    return fs.renameSync(from, to);
  };
  assert.throws(() => store(value, { fileSystem: injected }).save(nextSettings(value)),
    /transaction write failed/u);
  assert.equal(value.loadAuthority().globalSettings.port, 6180);
  assert.equal(value.loadAuthority().workspaceSettings.autoConnect, false);
  assert.equal(fs.existsSync(value.layout.global.settingsTransaction), false);
});

test('out-of-band mutation while an intent is pending blocks recovery', (t) => {
  const value = fixture(t);
  const injected = Object.create(fs);
  injected.renameSync = (from, to) => {
    if (to === value.layout.workspace.settings) throw new Error('simulated target crash');
    return fs.renameSync(from, to);
  };
  assert.throws(() => store(value, { fileSystem: injected }).save(nextSettings(value)));
  writeJson(value.layout.workspace.settings, {
    schemaVersion: 1,
    autoReconnect: true,
    maxAttempts: 9,
    autoConnect: false,
    routeDomains: ['hkust-gz.edu.cn'],
  });
  assert.throws(() => store(value).reconcile(), /changed outside transaction/u);
  assert.equal(fs.existsSync(value.layout.global.settingsTransaction), true);
});

test('failure to clear a completed intent resumes without rolling settings back', (t) => {
  const value = fixture(t);
  const injected = Object.create(fs);
  injected.unlinkSync = (file) => {
    if (file === value.layout.global.settingsTransaction) throw new Error('simulated clear crash');
    return fs.unlinkSync(file);
  };
  assert.throws(() => store(value, { fileSystem: injected }).save(nextSettings(value)),
    /transaction clear failed/u);
  assert.equal(value.loadAuthority().globalSettings.port, 6280);
  assert.equal(fs.existsSync(value.layout.global.settingsTransaction), true);
  assert.equal(store(value).reconcile().changed, true);
});

test('account credential revision drift blocks a pending settings intent', (t) => {
  const value = fixture(t);
  const injected = Object.create(fs);
  injected.renameSync = (from, to) => {
    if (to === value.layout.workspace.settings) throw new Error('simulated target crash');
    return fs.renameSync(from, to);
  };
  assert.throws(() => store(value, { fileSystem: injected }).save(nextSettings(value)));
  const account = JSON.parse(fs.readFileSync(value.layout.account.document, 'utf8'));
  writeJson(value.layout.account.document, {
    ...account,
    accountCredentialRevision: 2,
    updatedAt: account.updatedAt + 1,
  });
  assert.throws(() => store(value).reconcile(), /binding/u);
  assert.equal(fs.existsSync(value.layout.global.settingsTransaction), true);
});

test('simulated Windows settings transaction protects and verifies every private write', (t) => {
  const value = fixture(t);
  const protectedFiles = [];
  const verifiedFiles = [];
  const windowsAcl = {
    protect(file) { protectedFiles.push(file); return true; },
    verify(file) { verifiedFiles.push(file); return fs.existsSync(file); },
  };
  const loadAuthority = () => loadActiveProfileWorkspaceAuthority({
    userData: value.userData,
    profile: profile(),
    platform: 'win32',
    windowsAcl,
  });
  const result = new ProfileWorkspaceSettingsStore({
    loadAuthority,
    platform: 'win32',
    windowsAcl,
    randomBytes: () => Buffer.alloc(16, 0x55),
    now: () => 1_700_000_000_100,
  }).save(nextSettings({ loadAuthority }));
  assert.equal(result.changed, true);
  assert.equal(protectedFiles.some((file) => file.endsWith('.tmp')), true);
  assert.equal(verifiedFiles.includes(value.layout.global.settings), true);
});

test('native Windows settings mutation rejects an insecure replacement without creating an intent', {
  skip: process.platform !== 'win32',
}, (t) => {
  const value = fixture(t);
  const file = value.layout.global.settings;
  const original = fs.readFileSync(file);
  fs.unlinkSync(file);
  fs.writeFileSync(file, original, { mode: 0o600 });
  assert.equal(verifyWindowsFileOwnerOnly(file), false, 'replacement must reproduce the insecure fixture');
  assert.throws(() => store(value).save({ port: 6280 }), /private file ACL is invalid/);
  assert.equal(fs.existsSync(value.layout.global.settingsTransaction), false);
  assert.deepEqual(fs.readFileSync(file), original);
  assert.equal(verifyWindowsFileOwnerOnly(file), false, 'rejected input must not be silently repaired');
});
