'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const desktopRoot = path.resolve(__dirname, '..', '..', '..', '..');
const {
  createProfileAccountBootstrapLayout,
  createProfileAccountWorkspaceLayout,
} = require('../../../../lib/persistence/paths/profile-workspace-layout');
const {
  loadActiveProfileWorkspaceAuthority,
} = require('../../../../lib/persistence/runtime/profile-workspace-runtime-authority');
const { protectWindowsFileOwnerOnly, verifyWindowsFileOwnerOnly } = require('../../../../lib/platform/storage/windows-private-file');

function prepareNewFixture(file) {
  if (process.platform !== 'win32') return;
  assert.equal(protectWindowsFileOwnerOnly(file), true);
  assert.equal(verifyWindowsFileOwnerOnly(file), true);
}

const PROFILE_KEY = `profile-${'11'.repeat(16)}`;
const ACCOUNT_KEY = `account-${'22'.repeat(16)}`;
const WORKSPACE_KEY = `workspace-${'33'.repeat(16)}`;
const MIGRATION_ID = `migration-${'44'.repeat(16)}`;

function profile() {
  return JSON.parse(fs.readFileSync(
    path.join(desktopRoot, 'assets', 'profiles', 'hkustgz', 'school-profile.json'),
    'utf8',
  ));
}

function writeJson(file, value) {
  const existed = fs.existsSync(file);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  if (!existed) prepareNewFixture(file);
}

function fixture(t, { withCredential = true } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-runtime-authority-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const bootstrap = createProfileAccountBootstrapLayout({
    userData,
    profileKey: PROFILE_KEY,
    accountKey: ACCOUNT_KEY,
  });
  const layout = createProfileAccountWorkspaceLayout({
    userData,
    profileKey: PROFILE_KEY,
    accountKey: ACCOUNT_KEY,
    workspaceKey: WORKSPACE_KEY,
    adoptLegacyHkustBrowserPartition: true,
  });
  writeJson(bootstrap.global.settings, {
    schemaVersion: 1,
    activeProfileKey: PROFILE_KEY,
    activeAccountKey: ACCOUNT_KEY,
    port: 6180,
    strictProxyAuth: true,
    proxySecurityVersion: 3,
    proxyAuthMigrationPending: false,
    closeAction: 'minimize',
    language: 'zh',
    startAtLogin: false,
  });
  writeJson(bootstrap.global.updateState, { schemaVersion: 1, checkedAt: 1_700_000_000_000 });
  writeJson(bootstrap.profile.settings, {
    schemaVersion: 1,
    profileId: 'hkustgz',
    profileRevision: 1,
    primaryAccountKey: ACCOUNT_KEY,
  });
  writeJson(bootstrap.profile.state, {
    schemaVersion: 1,
    migrationId: MIGRATION_ID,
    profileId: 'hkustgz',
    profileRevision: 1,
    profileCredentialBindingRevision: 1,
    gatewayOrigin: 'https://remote.hkust-gz.edu.cn',
    protocolFamily: 'easyconnect-password-modern-l3-v1',
  });
  writeJson(bootstrap.account.document, {
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
    activeCredentialVersion: withCredential ? 1 : null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  });
  writeJson(layout.workspace.settings, {
    schemaVersion: 1,
    autoReconnect: true,
    maxAttempts: 3,
    autoConnect: false,
    routeDomains: ['hkust-gz.edu.cn', 'hkust.edu.hk'],
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
  if (withCredential) {
    fs.writeFileSync(layout.account.vpnCredential, Buffer.from('synthetic-encrypted-envelope'), {
      mode: 0o600,
    });
    prepareNewFixture(layout.account.vpnCredential);
  }
  return { userData, bootstrap, layout };
}

test('authority loads one exact active Profile Account Workspace without decrypting credentials', (t) => {
  const value = fixture(t);
  const authority = loadActiveProfileWorkspaceAuthority({
    userData: value.userData,
    profile: profile(),
  });
  assert.equal(authority.globalSettings.port, 6180);
  assert.equal(authority.workspaceSettings.autoConnect, false);
  assert.equal(authority.account.accountKey, ACCOUNT_KEY);
  assert.equal(authority.workspaceState.workspaceKey, WORKSPACE_KEY);
  assert.deepEqual(authority.localResources.resources, []);
  assert.equal(authority.hasCredential, true);
  assert.equal(authority.layout.browserPartition, 'persist:hkustgz-campus-browser');
  assert.deepEqual(authority.credentialBinding, {
    profileId: 'hkustgz',
    profileCredentialBindingRevision: 1,
    accountKey: ACCOUNT_KEY,
    accountCredentialRevision: 1,
    gatewayOrigin: 'https://remote.hkust-gz.edu.cn',
    protocolFamily: 'easyconnect-password-modern-l3-v1',
  });
  const keys = [];
  JSON.parse(JSON.stringify(authority), (key, value) => {
    if (key) keys.push(key.toLowerCase());
    return value;
  });
  assert.equal(keys.includes('username'), false);
  assert.equal(keys.includes('password'), false);
});

test('authority rejects cross-account and reviewed Profile binding drift', (t) => {
  const value = fixture(t);
  const global = JSON.parse(fs.readFileSync(value.bootstrap.global.settings, 'utf8'));
  writeJson(value.bootstrap.global.settings, {
    ...global,
    activeAccountKey: `account-${'55'.repeat(16)}`,
  });
  assert.throws(() => loadActiveProfileWorkspaceAuthority({
    userData: value.userData,
    profile: profile(),
  }), /could not be read|unavailable/u);

  writeJson(value.bootstrap.global.settings, global);
  const profileState = JSON.parse(fs.readFileSync(value.bootstrap.profile.state, 'utf8'));
  writeJson(value.bootstrap.profile.state, {
    ...profileState,
    gatewayOrigin: 'https://other.example.edu',
  });
  assert.throws(() => loadActiveProfileWorkspaceAuthority({
    userData: value.userData,
    profile: profile(),
  }), /Gateway origin binding/u);
});

test('authority accepts an explicitly credential-free account without probing secure storage', (t) => {
  const value = fixture(t, { withCredential: false });
  const authority = loadActiveProfileWorkspaceAuthority({
    userData: value.userData,
    profile: profile(),
  });
  assert.equal(authority.hasCredential, false);
  assert.equal(authority.account.activeCredentialVersion, null);
});

test('authority rejects credential presence drift and unsafe private paths', {
  skip: process.platform === 'win32',
}, (t) => {
  const missing = fixture(t, { withCredential: false });
  fs.writeFileSync(missing.layout.account.vpnCredential, 'unexpected', { mode: 0o600 });
  assert.throws(() => loadActiveProfileWorkspaceAuthority({
    userData: missing.userData,
    profile: profile(),
  }), /credential presence binding/u);

  const linked = fixture(t);
  const target = path.join(linked.userData, 'unrelated.json');
  fs.writeFileSync(target, fs.readFileSync(linked.layout.workspace.settings), { mode: 0o600 });
  fs.unlinkSync(linked.layout.workspace.settings);
  fs.symlinkSync(target, linked.layout.workspace.settings);
  assert.throws(() => loadActiveProfileWorkspaceAuthority({
    userData: linked.userData,
    profile: profile(),
  }), /private document/u);
  assert.equal(fs.existsSync(target), true);
});

test('simulated Windows authority verifies every persistent document and credential ACL', (t) => {
  const value = fixture(t);
  const verified = [];
  const authority = loadActiveProfileWorkspaceAuthority({
    userData: value.userData,
    profile: profile(),
    platform: 'win32',
    windowsAcl: {
      verify(file) { verified.push(file); return fs.existsSync(file); },
    },
  });
  assert.equal(authority.hasCredential, true);
  assert.equal(verified.includes(value.layout.account.vpnCredential), true);
  assert.equal(verified.includes(value.layout.workspace.state), true);
  assert.equal(verified.length >= 7, true);
});
