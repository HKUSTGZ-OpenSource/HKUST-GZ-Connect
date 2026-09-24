'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { collectLegacyFlatSourceReceipts } = require('../../../../../lib/persistence/migration/legacy-hkust/legacy-flat-source-receipts');
const { retireLegacyFlatSources } = require('../../../../../lib/persistence/migration/legacy-hkust/legacy-flat-source-retirement');
const { createLegacyFlatSourcePaths } = require('../../../../../lib/persistence/paths/profile-workspace-layout');
const { protectWindowsFileOwnerOnly, verifyWindowsFileOwnerOnly } = require('../../../../../lib/platform/storage/windows-private-file');

function prepareNewFixture(file) {
  if (process.platform !== 'win32') return;
  assert.equal(protectWindowsFileOwnerOnly(file), true);
  assert.equal(verifyWindowsFileOwnerOnly(file), true);
}

function fixture(t) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-legacy-retirement-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const paths = createLegacyFlatSourcePaths(userData);
  for (const id of ['settings', 'settingsBackup', 'vpnCredential', 'routingRules',
    'proxyCredential', 'engineLog', 'engineLogRotated', 'engineLogRetention']) {
    fs.writeFileSync(paths[id], `synthetic-${id}`, { mode: 0o600 });
    prepareNewFixture(paths[id]);
  }
  return { userData, paths, expected: collectLegacyFlatSourceReceipts({ userData }) };
}

test('retirement removes only receipt-matched sources and settings authority last', (t) => {
  const { userData, paths, expected } = fixture(t);
  const removed = [];
  const injected = Object.create(fs);
  injected.unlinkSync = (file) => { removed.push(file); return fs.unlinkSync(file); };
  assert.equal(retireLegacyFlatSources({ userData, expectedReceipts: expected, fileSystem: injected }),
    true);
  assert.equal(removed.at(-1), paths.settings);
  assert.equal(Object.values(paths).some((file) => fs.existsSync(file)), false);
  assert.equal(retireLegacyFlatSources({ userData, expectedReceipts: expected }), true);
});

test('one mismatched source blocks before any retirement side effect', (t) => {
  const { userData, paths, expected } = fixture(t);
  fs.writeFileSync(paths.routingRules, 'changed', { mode: 0o600 });
  assert.throws(() => retireLegacyFlatSources({ userData, expectedReceipts: expected }),
    /receipt changed/u);
  assert.equal(fs.existsSync(paths.settings), true);
  assert.equal(fs.existsSync(paths.vpnCredential), true);
});

test('unexpected source appearing where receipt proved absence blocks retirement', (t) => {
  const { userData, paths, expected } = fixture(t);
  fs.writeFileSync(paths.siteCredentials, 'unexpected', { mode: 0o600 });
  prepareNewFixture(paths.siteCredentials);
  assert.throws(() => retireLegacyFlatSources({ userData, expectedReceipts: expected }),
    /unexpected legacy source/u);
  assert.equal(fs.existsSync(paths.settings), true);
});

test('partial unlink failure keeps settings authority and retry completes idempotently', (t) => {
  const { userData, paths, expected } = fixture(t);
  const injected = Object.create(fs);
  let unlinks = 0;
  injected.unlinkSync = (file) => {
    if (++unlinks === 3) throw new Error('simulated unlink failure');
    return fs.unlinkSync(file);
  };
  assert.throws(() => retireLegacyFlatSources({
    userData,
    expectedReceipts: expected,
    fileSystem: injected,
  }), /retirement failed/u);
  assert.equal(fs.existsSync(paths.settings), true);
  assert.equal(retireLegacyFlatSources({ userData, expectedReceipts: expected }), true);
  assert.equal(fs.existsSync(paths.settings), false);
});

test('directory fsync failure after unlink remains retryable under committed journal', {
  skip: process.platform === 'win32',
}, (t) => {
  const { userData, paths, expected } = fixture(t);
  const injected = Object.create(fs);
  let directoryFsyncs = 0;
  injected.fsyncSync = (descriptor) => {
    if (fs.fstatSync(descriptor).isDirectory() && ++directoryFsyncs === 1) {
      throw new Error('simulated directory fsync failure');
    }
    return fs.fsyncSync(descriptor);
  };
  assert.throws(() => retireLegacyFlatSources({
    userData,
    expectedReceipts: expected,
    fileSystem: injected,
  }), /not durable/u);
  assert.equal(fs.existsSync(paths.settings), true);
  assert.equal(retireLegacyFlatSources({ userData, expectedReceipts: expected }), true);
});

test('simulated Windows retirement verifies every present source ACL', (t) => {
  const { userData, expected } = fixture(t);
  const verified = [];
  assert.equal(retireLegacyFlatSources({
    userData,
    expectedReceipts: expected,
    platform: 'win32',
    windowsAcl: { verify(file) { verified.push(file); return true; } },
  }), true);
  assert.equal(verified.length, 2 * Object.values(expected).filter((entry) => entry.present).length);
});
