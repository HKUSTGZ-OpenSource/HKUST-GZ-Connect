'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const desktopRoot = path.resolve(__dirname, '..', '..', '..', '..', '..');
const { LEGACY_COPY_SOURCE_IDS } = require('../../../../../lib/persistence/migration/legacy-hkust/hkust-migration-destination-plan');
const { ProfileWorkspaceMigrationRuntime } =
  require('../../../../../lib/persistence/migration/legacy-hkust/profile-workspace-migration-runtime');
const { createLegacyFlatSourcePaths } = require('../../../../../lib/persistence/paths/profile-workspace-layout');
const { normalizeSettings } = require('../../../../../lib/persistence/settings/settings-store');
const { decryptVpnCredentialEnvelope } = require('../../../../../lib/persistence/credentials/vpn-credential-envelope');
const { protectWindowsFileOwnerOnly, verifyWindowsFileOwnerOnly } = require('../../../../../lib/platform/storage/windows-private-file');

function prepareNewFixture(file) {
  if (process.platform !== 'win32') return;
  assert.equal(protectWindowsFileOwnerOnly(file), true);
  assert.equal(verifyWindowsFileOwnerOnly(file), true);
}

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

function fixture(t, { credential = true } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-migration-runtime-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const paths = createLegacyFlatSourcePaths(userData);
  const settings = Buffer.from(JSON.stringify(normalizeSettings({
    username: credential ? 'synthetic-user' : '',
    port: 6180,
    autoConnect: false,
    routeDomains: ['hkust-gz.edu.cn'],
    customResources: [],
  })), 'utf8');
  fs.writeFileSync(paths.settings, settings, { mode: 0o600 });
  fs.writeFileSync(paths.settingsBackup, settings, { mode: 0o600 });
  if (credential) {
    fs.writeFileSync(paths.vpnCredential, safeStorage().encryptString('synthetic-password'), {
      mode: 0o600,
    });
  }
  for (const id of LEGACY_COPY_SOURCE_IDS) {
    if (id === 'routingRules') {
      fs.writeFileSync(paths[id], '{"schemaVersion":1,"rules":[]}', { mode: 0o600 });
    }
  }
  for (const file of Object.values(paths)) {
    if (fs.existsSync(file)) prepareNewFixture(file);
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
  return { userData, paths, options };
}

test('runtime migrates real flat files to one verified Profile Workspace authority', (t) => {
  const value = fixture(t);
  const runtime = new ProfileWorkspaceMigrationRuntime(value.options);
  const result = runtime.run();
  assert.equal(result.mode, 'profile-workspace');
  assert.equal(result.migration.status, 'migrated');
  assert.equal(result.authority.globalSettings.port, 6180);
  assert.equal(result.authority.workspaceSettings.autoConnect, false);
  assert.equal(result.authority.hasCredential, true);
  assert.equal(Object.values(value.paths).some((file) => fs.existsSync(file)), false);
  assert.equal(result.paths.vpnCredential, result.authority.layout.account.vpnCredential);
  assert.equal(fs.existsSync(result.authority.layout.account.legacyCredentialRollbackBlob), true);

  const encrypted = fs.readFileSync(result.paths.vpnCredential);
  const owner = decryptVpnCredentialEnvelope(encrypted, {
    expectedBinding: result.authority.credentialBinding,
    safeStorage: safeStorage(),
    platform: process.platform,
  });
  assert.deepEqual(owner.withStrings((username, password) => ({ username, password })), {
    username: 'synthetic-user',
    password: 'synthetic-password',
  });
  owner.destroy();

  const repeated = runtime.run();
  assert.equal(repeated.mode, 'profile-workspace');
  assert.equal(repeated.migration.status, 'already_migrated');
});

test('credential-free migration creates an explicit retired rollback state', (t) => {
  const value = fixture(t, { credential: false });
  const result = new ProfileWorkspaceMigrationRuntime(value.options).run();
  assert.equal(result.authority.hasCredential, false);
  assert.equal(fs.existsSync(result.paths.vpnCredential), false);
  const rollback = JSON.parse(fs.readFileSync(
    result.authority.layout.account.legacyCredentialRollbackState,
    'utf8',
  ));
  assert.equal(rollback.state, 'retired');
  assert.equal(rollback.retirementReason, 'no_legacy_credential');
});

test('empty first launch remains legacy-compatible while orphaned files block', (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-first-launch-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const base = {
    userData,
    profile: profile(),
    safeStorage: safeStorage(),
    platform: process.platform,
  };
  const first = new ProfileWorkspaceMigrationRuntime(base).run();
  assert.equal(first.mode, 'legacy-flat');
  assert.equal(first.migration.status, 'not_applicable');
  const paths = createLegacyFlatSourcePaths(userData);
  fs.writeFileSync(paths.vpnCredential, 'orphaned', { mode: 0o600 });
  prepareNewFixture(paths.vpnCredential);
  assert.throws(() => new ProfileWorkspaceMigrationRuntime(base).run(), /orphaned/u);
});

test('retirement interruption keeps committed destination and resumes safely', (t) => {
  const value = fixture(t);
  const injected = Object.create(fs);
  let failed = false;
  injected.unlinkSync = (file) => {
    if (!failed && file === value.paths.vpnCredential) {
      failed = true;
      throw new Error('simulated retirement crash');
    }
    return fs.unlinkSync(file);
  };
  assert.throws(() => new ProfileWorkspaceMigrationRuntime({
    ...value.options,
    fileSystem: injected,
  }).run(), /retirement failed/u);
  assert.equal(fs.existsSync(value.paths.settings), true);
  const recovered = new ProfileWorkspaceMigrationRuntime(value.options).run();
  assert.equal(recovered.mode, 'profile-workspace');
  assert.equal(recovered.migration.status, 'migrated');
  assert.equal(fs.existsSync(value.paths.settings), false);
});

test('simulated Windows runtime protects destinations and verifies every private source', (t) => {
  const value = fixture(t);
  const protectedFiles = [];
  const verifiedFiles = [];
  const windowsAcl = {
    protect(file) { protectedFiles.push(file); return true; },
    tighten(file) { protectedFiles.push(file); return true; },
    verify(file) { verifiedFiles.push(file); return fs.existsSync(file); },
  };
  const result = new ProfileWorkspaceMigrationRuntime({
    ...value.options,
    platform: 'win32',
    windowsAcl,
  }).run();
  assert.equal(result.mode, 'profile-workspace');
  assert.equal(protectedFiles.some((file) => file.endsWith('.tmp')), true);
  assert.equal(verifiedFiles.includes(result.paths.vpnCredential), true);
  assert.equal(verifiedFiles.length > 10, true);
});
