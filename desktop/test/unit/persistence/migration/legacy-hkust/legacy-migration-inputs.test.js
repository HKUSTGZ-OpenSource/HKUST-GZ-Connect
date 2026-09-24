'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { collectLegacyFlatSourceReceipts } = require('../../../../../lib/persistence/migration/legacy-hkust/legacy-flat-source-receipts');
const {
  openLegacyMigrationCredential,
  readLegacyMigrationPayloads,
} = require('../../../../../lib/persistence/migration/legacy-hkust/legacy-migration-inputs');
const { createLegacyFlatSourcePaths } = require('../../../../../lib/persistence/paths/profile-workspace-layout');
const { normalizeSettings } = require('../../../../../lib/persistence/settings/settings-store');
const { protectWindowsFileOwnerOnly, verifyWindowsFileOwnerOnly } = require('../../../../../lib/platform/storage/windows-private-file');

function prepareNewFixture(file) {
  if (process.platform !== 'win32') return;
  assert.equal(protectWindowsFileOwnerOnly(file), true);
  assert.equal(verifyWindowsFileOwnerOnly(file), true);
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
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-migration-inputs-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const paths = createLegacyFlatSourcePaths(userData);
  const settings = Buffer.from(JSON.stringify(normalizeSettings({
    username: 'synthetic-user',
    port: 6180,
  })), 'utf8');
  fs.writeFileSync(paths.settings, settings, { mode: 0o600 });
  fs.writeFileSync(paths.settingsBackup, settings, { mode: 0o600 });
  fs.writeFileSync(paths.vpnCredential, safeStorage().encryptString('synthetic-password'), {
    mode: 0o600,
  });
  fs.writeFileSync(paths.routingRules, 'synthetic-routing', { mode: 0o600 });
  for (const id of ['settings', 'settingsBackup', 'vpnCredential', 'routingRules']) {
    prepareNewFixture(paths[id]);
  }
  return {
    userData,
    paths,
    expected: collectLegacyFlatSourceReceipts({ userData }),
  };
}

test('payload owner reads exact receipts through bounded private files and zeroizes on destroy', (t) => {
  const value = fixture(t);
  const owner = readLegacyMigrationPayloads({
    userData: value.userData,
    expectedReceipts: value.expected,
  });
  let observed;
  owner.withPayloads((payloads) => {
    observed = payloads.routingRules;
    assert.equal(payloads.settings.length > 0, true);
    assert.equal(payloads.externalPac, null);
  });
  assert.equal(observed.equals(Buffer.from('synthetic-routing')), true);
  assert.equal(owner.destroy(), true);
  assert.equal(observed.equals(Buffer.alloc(observed.length)), true);
  assert.throws(() => owner.withPayloads(() => {}), /destroyed/u);
  assert.equal(JSON.stringify(owner).includes('synthetic'), false);
});

test('empty regenerable diagnostic files remain receipt-bound migration inputs', (t) => {
  const value = fixture(t);
  fs.writeFileSync(value.paths.engineLogRotated, Buffer.alloc(0), { mode: 0o600 });
  prepareNewFixture(value.paths.engineLogRotated);
  const expectedReceipts = collectLegacyFlatSourceReceipts({ userData: value.userData });
  assert.deepEqual(expectedReceipts.engineLogRotated, {
    present: true,
    bytes: 0,
    sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  });
  const owner = readLegacyMigrationPayloads({
    userData: value.userData,
    expectedReceipts,
  });
  owner.withPayloads((payloads) => {
    assert.equal(Buffer.isBuffer(payloads.engineLogRotated), true);
    assert.equal(payloads.engineLogRotated.length, 0);
  });
  owner.destroy();
});

test('empty authoritative migration payloads remain fail-closed', (t) => {
  const value = fixture(t);
  fs.writeFileSync(value.paths.routingRules, Buffer.alloc(0), { mode: 0o600 });
  const expectedReceipts = collectLegacyFlatSourceReceipts({ userData: value.userData });
  assert.equal(expectedReceipts.routingRules.present, true);
  assert.equal(expectedReceipts.routingRules.bytes, 0);
  assert.throws(() => readLegacyMigrationPayloads({
    userData: value.userData,
    expectedReceipts,
  }), /could not be read: routingRules/u);
});

test('legacy credential decrypts only into a zeroizing callback owner', (t) => {
  const value = fixture(t);
  const settings = fs.readFileSync(value.paths.settings);
  const encrypted = fs.readFileSync(value.paths.vpnCredential);
  const owner = openLegacyMigrationCredential({
    settingsBytes: settings,
    encryptedCredential: encrypted,
    safeStorage: safeStorage(),
    platform: 'darwin',
  });
  assert.deepEqual(owner.withStrings((username, password) => ({ username, password })), {
    username: 'synthetic-user',
    password: 'synthetic-password',
  });
  owner.destroy();
  assert.throws(() => owner.withStrings(() => {}), /destroyed/u);
  assert.equal(JSON.stringify(owner).includes('synthetic'), false);
});

test('changed missing unexpected and linked migration inputs fail closed', {
  skip: process.platform === 'win32',
}, (t) => {
  const changed = fixture(t);
  fs.writeFileSync(changed.paths.routingRules, 'changed', { mode: 0o600 });
  assert.throws(() => readLegacyMigrationPayloads({
    userData: changed.userData,
    expectedReceipts: changed.expected,
  }), /receipt changed/u);

  const unexpected = fixture(t);
  fs.writeFileSync(unexpected.paths.externalPac, 'unexpected', { mode: 0o600 });
  assert.throws(() => readLegacyMigrationPayloads({
    userData: unexpected.userData,
    expectedReceipts: unexpected.expected,
  }), /unexpected/u);

  const linked = fixture(t);
  const target = path.join(linked.userData, 'unrelated');
  fs.writeFileSync(target, fs.readFileSync(linked.paths.routingRules), { mode: 0o600 });
  fs.unlinkSync(linked.paths.routingRules);
  fs.symlinkSync(target, linked.paths.routingRules);
  assert.throws(() => readLegacyMigrationPayloads({
    userData: linked.userData,
    expectedReceipts: linked.expected,
  }), /could not be read/u);
  assert.equal(fs.readFileSync(target, 'utf8'), 'synthetic-routing');
});
