'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createLegacyFlatSourcePaths } = require('../../../../../lib/persistence/paths/profile-workspace-layout');
const {
  collectLegacyFlatSourceReceipts,
} = require('../../../../../lib/persistence/migration/legacy-hkust/legacy-flat-source-receipts');
const {
  protectWindowsFileOwnerOnly,
} = require('../../../../../lib/platform/storage/windows-private-file');

function fixture(t) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-legacy-receipts-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  return { userData, paths: createLegacyFlatSourcePaths(userData) };
}

function writePrivate(file, value) {
  fs.writeFileSync(file, value, { mode: 0o600 });
  if (process.platform === 'win32') {
    assert.equal(protectWindowsFileOwnerOnly(file), true);
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

test('legacy source paths are the exact current flat userData authorities', () => {
  const userData = path.resolve('/tmp/campus-connect-user-data');
  assert.deepEqual(createLegacyFlatSourcePaths(userData), {
    settings: path.join(userData, 'settings.json'),
    settingsBackup: path.join(userData, 'settings.json.bak'),
    vpnCredential: path.join(userData, 'cred.bin'),
    routingRules: path.join(userData, 'routing-rules.json'),
    externalPac: path.join(userData, 'routing.pac'),
    browserPac: path.join(userData, 'campus-browser-routing.pac'),
    siteCredentials: path.join(userData, 'campus-credentials.json'),
    certificateTrust: path.join(userData, 'campus-certificate-trust.json'),
    engineOwner: path.join(userData, 'engine-owner.json'),
    credentialTransaction: path.join(userData, 'credential-settings-transaction.json'),
    activeContextSwitch: path.join(userData, 'active-context-switch.json'),
    proxyCredential: path.join(userData, 'proxy-credential.bin'),
    proxyHelperCredential: path.join(userData, 'proxy-helper-credential.txt'),
    engineLog: path.join(userData, 'engine.log'),
    engineLogRotated: path.join(userData, 'engine.log.1'),
    engineLogRetention: path.join(userData, 'engine.log.retention'),
  });
});

test('receipt collection hashes opened descriptors without retaining file contents', (t) => {
  const { userData, paths } = fixture(t);
  const settings = Buffer.from('{"username":"legacy-user"}', 'utf8');
  writePrivate(paths.settings, settings);
  writePrivate(paths.engineLog, Buffer.alloc(0));

  const receipts = collectLegacyFlatSourceReceipts({ userData });
  assert.deepEqual(receipts.settings, {
    present: true,
    bytes: settings.length,
    sha256: sha256(settings),
  });
  assert.deepEqual(receipts.engineLog, {
    present: true,
    bytes: 0,
    sha256: sha256(Buffer.alloc(0)),
  });
  assert.deepEqual(receipts.vpnCredential, { present: false, bytes: 0, sha256: null });
  assert.equal(JSON.stringify(receipts).includes('legacy-user'), false);
  assert.equal(Object.isFrozen(receipts), true);
});

test('receipt collection rejects links, broad permissions and oversized sources', {
  skip: process.platform === 'win32',
}, (t) => {
  const { userData, paths } = fixture(t);
  const unrelated = path.join(userData, 'unrelated');
  writePrivate(unrelated, 'data');

  fs.symlinkSync(unrelated, paths.settings);
  assert.throws(() => collectLegacyFlatSourceReceipts({ userData }), /legacy source/u);
  fs.unlinkSync(paths.settings);

  fs.linkSync(unrelated, paths.settings);
  assert.throws(() => collectLegacyFlatSourceReceipts({ userData }), /legacy source/u);
  fs.unlinkSync(paths.settings);

  writePrivate(paths.settings, 'settings');
  fs.chmodSync(paths.settings, 0o644);
  assert.throws(() => collectLegacyFlatSourceReceipts({ userData }), /legacy source/u);
  fs.chmodSync(paths.settings, 0o600);

  fs.truncateSync(paths.settings, 512 * 1024 + 1);
  assert.throws(() => collectLegacyFlatSourceReceipts({ userData }), /legacy source/u);
});

test('symlinked userData root is rejected before any source inspection', {
  skip: process.platform === 'win32',
}, (t) => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-legacy-root-target-'));
  const link = `${target}-link`;
  fs.symlinkSync(target, link);
  t.after(() => {
    try { fs.unlinkSync(link); } catch {}
    fs.rmSync(target, { recursive: true, force: true });
  });
  assert.throws(() => collectLegacyFlatSourceReceipts({ userData: link }), /trusted directory/u);
});

test('replacement between lstat and opened descriptor fails closed', (t) => {
  const { userData, paths } = fixture(t);
  writePrivate(paths.settings, 'settings');
  const injected = Object.create(fs);
  let changed = false;
  injected.fstatSync = (descriptor, options) => {
    const stat = fs.fstatSync(descriptor, options);
    if (!changed) {
      changed = true;
      return {
        ...stat,
        ino: stat.ino + 1n,
        isFile: () => true,
      };
    }
    return stat;
  };
  assert.throws(() => collectLegacyFlatSourceReceipts({ userData, fileSystem: injected }),
    /changed while opening/u);
});

test('same-inode same-size modification during hashing fails closed', (t) => {
  const { userData, paths } = fixture(t);
  writePrivate(paths.settings, 'settings');
  const injected = Object.create(fs);
  let fstats = 0;
  injected.fstatSync = (descriptor, options) => {
    const stat = fs.fstatSync(descriptor, options);
    if (++fstats === 2) {
      return {
        ...stat,
        mtimeNs: stat.mtimeNs + 1_000_000n,
        isFile: () => true,
      };
    }
    return stat;
  };
  assert.throws(() => collectLegacyFlatSourceReceipts({ userData, fileSystem: injected }),
    /changed while reading/u);
});

test('short reads and disappearance after observed presence fail closed', (t) => {
  const { userData, paths } = fixture(t);
  writePrivate(paths.settings, 'settings');
  const shortRead = Object.create(fs);
  shortRead.readSync = () => 0;
  assert.throws(() => collectLegacyFlatSourceReceipts({ userData, fileSystem: shortRead }),
    /incomplete/u);

  const disappearing = Object.create(fs);
  disappearing.openSync = (file, ...args) => {
    if (file === paths.settings) {
      fs.unlinkSync(file);
      const error = new Error('disappeared');
      error.code = 'ENOENT';
      throw error;
    }
    return fs.openSync(file, ...args);
  };
  assert.throws(() => collectLegacyFlatSourceReceipts({ userData, fileSystem: disappearing }),
    /could not be opened/u);
});

test('simulated Windows collection requires current-user-only ACL verification', (t) => {
  const { userData, paths } = fixture(t);
  writePrivate(paths.settings, 'settings');
  assert.throws(() => collectLegacyFlatSourceReceipts({
    userData,
    platform: 'win32',
    windowsAcl: { verify: () => false },
  }), /Windows ACL/u);
  const verified = [];
  const receipts = collectLegacyFlatSourceReceipts({
    userData,
    platform: 'win32',
    windowsAcl: { verify(file) { verified.push(file); return true; } },
  });
  assert.equal(receipts.settings.present, true);
  assert.deepEqual(verified, [paths.settings]);
});

test('Windows migration can tighten a current-user legacy ACL before hashing', (t) => {
  const { userData, paths } = fixture(t);
  writePrivate(paths.settings, 'settings');
  let protectedFile = null;
  let protectedState = false;
  const receipts = collectLegacyFlatSourceReceipts({
    userData,
    platform: 'win32',
    repairWindowsAcl: true,
    windowsAcl: {
      tighten(file) { protectedFile = file; protectedState = true; return true; },
      verify: () => protectedState,
    },
  });
  assert.equal(protectedFile, paths.settings);
  assert.equal(receipts.settings.present, true);
  assert.equal(receipts.settings.sha256, sha256(Buffer.from('settings')));
});

test('Windows migration never proceeds when safe ACL tightening fails', (t) => {
  const { userData, paths } = fixture(t);
  writePrivate(paths.settings, 'settings');
  assert.throws(() => collectLegacyFlatSourceReceipts({
    userData,
    platform: 'win32',
    repairWindowsAcl: true,
    windowsAcl: { tighten: () => false, verify: () => false },
  }), /Windows ACL/u);
});
