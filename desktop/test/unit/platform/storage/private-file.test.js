'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createPrivateStorageEffects,
  ensureOwnerOnly,
  readPrivateFileBounded,
} = require('../../../../lib/platform/storage/private-file');
const { prepareBroadCurrentUserFile } = require('./support/windows-acl-fixture');

test('owner-only hardening changes only an opened regular file', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-private-file-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'private.json');
  fs.writeFileSync(file, '{}', { mode: 0o644 });
  if (process.platform === 'win32') prepareBroadCurrentUserFile(file);

  assert.equal(ensureOwnerOnly(file), true);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(ensureOwnerOnly(directory), false);
  assert.equal(ensureOwnerOnly(path.join(directory, 'missing')), false);
});

test('owner-only hardening never follows a symbolic link', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-private-symlink-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'unrelated.txt');
  const link = path.join(directory, 'settings.json');
  fs.writeFileSync(target, 'unrelated', { mode: 0o644 });
  fs.symlinkSync(target, link);
  const before = fs.statSync(target).mode & 0o777;

  assert.equal(ensureOwnerOnly(link), false);
  assert.equal(fs.statSync(target).mode & 0o777, before);
});

test('simulated Windows hardening upgrades a current-user file and fails closed otherwise', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-private-windows-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'settings.json');
  fs.writeFileSync(file, '{}', { mode: 0o600 });
  const calls = [];
  assert.equal(ensureOwnerOnly(file, {
    platform: 'win32',
    windowsAcl: {
      tighten(value) { calls.push(['tighten', value]); return true; },
      verify(value) { calls.push(['verify', value]); return true; },
    },
  }), true);
  assert.deepEqual(calls, [['tighten', file], ['verify', file]]);
  assert.equal(ensureOwnerOnly(file, {
    platform: 'win32',
    windowsAcl: { tighten: () => false, verify: () => true },
  }), false);
});

test('bounded private reads use one no-follow regular-file descriptor', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-private-read-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'document.bin');
  const link = path.join(directory, 'document-link.bin');
  fs.writeFileSync(file, Buffer.from('private-data'), { mode: 0o600 });
  fs.symlinkSync(file, link);

  assert.equal(readPrivateFileBounded(file, { maxBytes: 32 }).data.toString(), 'private-data');
  assert.throws(
    () => readPrivateFileBounded(link, { maxBytes: 32 }),
    (error) => error.privateFileInvalid === true,
  );
  fs.chmodSync(file, 0o644);
  if (process.platform !== 'win32') {
    assert.throws(
      () => readPrivateFileBounded(file, { maxBytes: 32 }),
      (error) => error.privateFileInvalid === true,
    );
  }
  assert.throws(() => readPrivateFileBounded(file, { maxBytes: 0 }), /bound/);
});

test('private storage effects bind injected filesystem, platform and Windows ACL operations', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-private-effects-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const windowsAcl = {
    protect(file) { calls.push(['protect', file]); return true; },
    verify(file) { calls.push(['verify', file]); return true; },
  };
  const storage = createPrivateStorageEffects({
    fileSystem: fs,
    platform: 'win32',
    windowsAcl,
  });
  const root = path.join(directory, 'profiles');
  const targetDirectory = path.join(root, 'custom');
  const file = path.join(targetDirectory, 'profile.json');

  assert.equal(Object.isFrozen(storage), true);
  assert.equal(storage.fileSystem, fs);
  assert.equal(storage.platform, 'win32');
  assert.equal(storage.assertCompatible({ fileSystem: fs, platform: 'win32', windowsAcl }), true);
  assert.throws(() => storage.assertCompatible({ fileSystem: Object.create(fs) }), /does not match/u);
  assert.equal(storage.ensurePrivateDirectoryChain(root, targetDirectory), true);
  assert.equal(storage.atomicWritePrivateFile(file, Buffer.from('{}'), {
    protectTemporary: (temporary) => storage.windowsAcl.protect(temporary),
    verifyCommitted: (committed) => storage.windowsAcl.verify(committed),
    removeCommittedOnFailure: true,
  }), true);
  const { data } = storage.readPrivateFileBounded(file, { maxBytes: 16, minBytes: 2 });
  try { assert.equal(data.toString('utf8'), '{}'); }
  finally { data.fill(0); }
  assert.equal(storage.verifyPrivateDirectoryChain(root, targetDirectory), true);
  assert.equal(storage.fsyncPrivateDirectory(targetDirectory), true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], 'protect');
  assert.equal(path.dirname(calls[0][1]), targetDirectory);
  assert.match(path.basename(calls[0][1]), /^\.profile\.json\.\d+\.\d+\.\d+\.tmp$/u);
  assert.deepEqual(calls[1], ['verify', file]);
});

test('private storage effects reject unsupported platform and incomplete Windows ACLs', () => {
  assert.throws(() => createPrivateStorageEffects({ platform: 'unknown' }), /dependencies are invalid/u);
  assert.throws(() => createPrivateStorageEffects({
    platform: 'win32',
    windowsAcl: { verify: () => true },
  }), /dependencies are invalid/u);
});

test('private-file operations reject hard links without changing the shared inode', (t) => {
  if (process.platform === 'win32') return;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-private-hardlink-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'unrelated.txt');
  const link = path.join(directory, 'settings.json');
  fs.writeFileSync(target, 'unrelated', { mode: 0o644 });
  fs.linkSync(target, link);
  const before = fs.statSync(target).mode & 0o777;

  assert.equal(ensureOwnerOnly(link), false);
  assert.throws(
    () => readPrivateFileBounded(link, { maxBytes: 32 }),
    (error) => error.privateFileInvalid === true,
  );
  assert.equal(fs.readFileSync(target, 'utf8'), 'unrelated');
  assert.equal(fs.statSync(target).mode & 0o777, before);
});
