'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { protectWindowsFileOwnerOnly, verifyWindowsFileOwnerOnly } =
  require('../../../../lib/platform/storage/windows-private-file');
const { createProfileAccountWorkspaceLayout } = require('../../../../lib/persistence/paths/profile-workspace-layout');
const {
  loadActiveProfileAccountAuthority,
  loadActiveProfileWorkspaceAuthority,
} = require('../../../../lib/persistence/runtime/profile-workspace-runtime-authority');
const {
  ProfileWorkspaceCredentialStore,
} = require('../../../../lib/persistence/credentials/profile-workspace-credential-store');

const PROFILE_KEY = `profile-${'11'.repeat(16)}`;
const ACCOUNT_KEY = `account-${'22'.repeat(16)}`;
const WORKSPACE_KEY = `workspace-${'33'.repeat(16)}`;

function profile() {
  return JSON.parse(fs.readFileSync(
    path.join(
      __dirname,
      '..', '..', '..', '..',
      'assets', 'profiles', 'hkustgz', 'school-profile.json',
    ),
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

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  // Only synthetic fixture files: match the production creation boundary on Windows.
  if (process.platform === 'win32') {
    assert.equal(protectWindowsFileOwnerOnly(file), true);
    assert.equal(verifyWindowsFileOwnerOnly(file), true);
  }
}

function fixture(t) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-credential-store-'));
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
  const loadAccountAuthority = () => loadActiveProfileAccountAuthority({
    userData,
    profile: profile(),
  });
  const loadWorkspaceAuthority = () => loadActiveProfileWorkspaceAuthority({
    userData,
    profile: profile(),
  });
  return { userData, layout, loadAccountAuthority, loadWorkspaceAuthority };
}

function createStore(value, options = {}) {
  const retirementCalls = options.retirementCalls || [];
  let timestamp = 1_700_000_000_100;
  return new ProfileWorkspaceCredentialStore({
    loadAccountAuthority: value.loadAccountAuthority,
    loadWorkspaceAuthority: value.loadWorkspaceAuthority,
    retireRollback: ({ reason }) => {
      retirementCalls.push(reason);
      return { status: 'retired', changed: true };
    },
    safeStorage: safeStorage(),
    platform: process.platform,
    randomBytes: () => Buffer.alloc(16, 0x66),
    now: () => timestamp++,
    ...options,
  });
}

test('replace and clear commit Account plus encrypted envelope without persistent identity', (t) => {
  const value = fixture(t);
  const retirementCalls = [];
  const credentials = createStore(value, { retirementCalls });
  assert.deepEqual(credentials.replace({
    username: 'synthetic-user',
    password: 'synthetic-password',
  }), { changed: true, hasCredential: true });
  let authority = value.loadWorkspaceAuthority();
  assert.equal(authority.account.accountCredentialRevision, 2);
  assert.equal(authority.account.activeCredentialVersion, 1);
  assert.equal(authority.hasCredential, true);
  const persisted = [
    fs.readFileSync(value.layout.account.document),
    fs.readFileSync(value.layout.account.vpnCredential),
  ];
  assert.equal(persisted.some((data) => data.includes(Buffer.from('synthetic-user'))), false);
  assert.equal(persisted.some((data) => data.includes(Buffer.from('synthetic-password'))), false);
  const owner = credentials.open();
  assert.deepEqual(owner.withStrings((username, password) => ({ username, password })), {
    username: 'synthetic-user',
    password: 'synthetic-password',
  });
  owner.destroy();

  assert.deepEqual(credentials.clear(), { changed: true, hasCredential: false });
  authority = value.loadWorkspaceAuthority();
  assert.equal(authority.account.accountCredentialRevision, 3);
  assert.equal(authority.account.activeCredentialVersion, null);
  assert.equal(authority.hasCredential, false);
  assert.equal(fs.existsSync(value.layout.account.vpnCredential), false);
  assert.deepEqual(retirementCalls, ['credential_replaced', 'credential_cleared']);
});

test('crash after credential write resumes Account commit without exposing plaintext intent', (t) => {
  const value = fixture(t);
  const injected = Object.create(fs);
  injected.renameSync = (from, to) => {
    if (to === value.layout.account.document) throw new Error('simulated Account crash');
    return fs.renameSync(from, to);
  };
  assert.throws(() => createStore(value, { fileSystem: injected }).replace({
    username: 'synthetic-user',
    password: 'synthetic-password',
  }), /Account write failed/u);
  assert.equal(fs.existsSync(value.layout.account.credentialTransaction), true);
  const intent = fs.readFileSync(value.layout.account.credentialTransaction);
  assert.equal(intent.includes(Buffer.from('synthetic-user')), false);
  assert.equal(intent.includes(Buffer.from('synthetic-password')), false);
  assert.throws(() => value.loadWorkspaceAuthority(), /credential presence binding/u);
  assert.equal(createStore(value).reconcile().changed, true);
  assert.equal(value.loadWorkspaceAuthority().account.accountCredentialRevision, 2);
});

test('crash after credential removal resumes clear Account metadata', (t) => {
  const value = fixture(t);
  const credentials = createStore(value);
  credentials.replace({ username: 'synthetic-user', password: 'synthetic-password' });
  const injected = Object.create(fs);
  injected.renameSync = (from, to) => {
    if (to === value.layout.account.document) throw new Error('simulated Account crash');
    return fs.renameSync(from, to);
  };
  assert.throws(() => createStore(value, { fileSystem: injected }).clear(), /Account write failed/u);
  assert.equal(fs.existsSync(value.layout.account.vpnCredential), false);
  assert.equal(createStore(value).reconcile().changed, true);
  assert.equal(value.loadWorkspaceAuthority().account.activeCredentialVersion, null);
});

test('unproven rollback retirement blocks credential mutation before intent or target writes', (t) => {
  const value = fixture(t);
  const credentials = createStore(value, {
    retireRollback: () => { throw new Error('simulated rollback retirement failure'); },
  });
  assert.throws(() => credentials.replace({ username: 'user', password: 'password' }),
    /retirement failure/u);
  assert.equal(fs.existsSync(value.layout.account.credentialTransaction), false);
  assert.equal(fs.existsSync(value.layout.account.vpnCredential), false);
  assert.equal(value.loadWorkspaceAuthority().account.accountCredentialRevision, 1);
});

test('credential-free clear still proves rollback retirement but does not churn Account revision', (t) => {
  const value = fixture(t);
  const retirementCalls = [];
  const credentials = createStore(value, { retirementCalls });
  assert.deepEqual(credentials.clear(), { changed: false, hasCredential: false });
  assert.deepEqual(retirementCalls, ['credential_cleared']);
  assert.equal(value.loadWorkspaceAuthority().account.accountCredentialRevision, 1);
  assert.equal(fs.existsSync(value.layout.account.credentialTransaction), false);
});

test('out-of-band Account mutation blocks pending credential recovery', (t) => {
  const value = fixture(t);
  const injected = Object.create(fs);
  injected.renameSync = (from, to) => {
    if (to === value.layout.account.document) throw new Error('simulated Account crash');
    return fs.renameSync(from, to);
  };
  assert.throws(() => createStore(value, { fileSystem: injected }).replace({
    username: 'user',
    password: 'password',
  }));
  const account = JSON.parse(fs.readFileSync(value.layout.account.document, 'utf8'));
  writeJson(value.layout.account.document, { ...account, updatedAt: account.updatedAt + 5 });
  assert.throws(() => createStore(value).reconcile(), /changed outside transaction/u);
  assert.equal(fs.existsSync(value.layout.account.credentialTransaction), true);
});

test('simulated Windows credential writes are ACL protected and verified', (t) => {
  const value = fixture(t);
  const protectedFiles = [];
  const verifiedFiles = [];
  const windowsAcl = {
    protect(file) { protectedFiles.push(file); return true; },
    verify(file) { verifiedFiles.push(file); return fs.existsSync(file); },
  };
  const loadAccountAuthority = () => loadActiveProfileAccountAuthority({
    userData: value.userData, profile: profile(), platform: 'win32', windowsAcl,
  });
  const loadWorkspaceAuthority = () => loadActiveProfileWorkspaceAuthority({
    userData: value.userData, profile: profile(), platform: 'win32', windowsAcl,
  });
  const credentials = createStore({ loadAccountAuthority, loadWorkspaceAuthority }, {
    platform: 'win32',
    windowsAcl,
  });
  credentials.replace({ username: 'user', password: 'password' });
  assert.equal(protectedFiles.some((file) => file.endsWith('.tmp')), true);
  assert.equal(verifiedFiles.includes(value.layout.account.vpnCredential), true);
  assert.equal(verifiedFiles.includes(value.layout.account.document), true);
});

test('native Windows credential mutation rejects an insecure Account before retirement or writes', {
  skip: process.platform !== 'win32',
}, (t) => {
  const value = fixture(t), retirementCalls = [];
  const file = value.layout.account.document;
  const original = fs.readFileSync(file);
  fs.unlinkSync(file);
  fs.writeFileSync(file, original, { mode: 0o600 });
  assert.equal(verifyWindowsFileOwnerOnly(file), false, 'replacement must reproduce the insecure fixture');
  assert.throws(() => createStore(value, { retirementCalls }).replace({
    username: 'synthetic-user', password: 'synthetic-password',
  }), /private file ACL is invalid/);
  assert.deepEqual(retirementCalls, []);
  assert.equal(fs.existsSync(value.layout.account.credentialTransaction), false);
  assert.equal(fs.existsSync(value.layout.account.vpnCredential), false);
  assert.deepEqual(fs.readFileSync(file), original);
  assert.equal(verifyWindowsFileOwnerOnly(file), false);
});
