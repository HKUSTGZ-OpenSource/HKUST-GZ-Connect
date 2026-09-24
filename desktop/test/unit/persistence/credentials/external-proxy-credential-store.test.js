'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const util = require('node:util');
const {
  ExternalProxyCredentialStore,
} = require('../../../../lib/persistence/credentials/external-proxy-credential-store');

const HOST_PRIVATE_FILE_PLATFORM = process.platform === 'win32' ? 'win32' : 'darwin';
const { protectWindowsFileOwnerOnly, verifyWindowsFileOwnerOnly } = require('../../../../lib/platform/storage/windows-private-file');

function temporaryFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-proxy-credential-'));
  return {
    directory,
    file: path.join(directory, 'proxy-credential.bin'),
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

function fakeSafeStorage({ available = true } = {}) {
  const calls = { encrypt: 0, decrypt: 0 };
  return {
    calls,
    isEncryptionAvailable: () => available,
    encryptString(value) {
      calls.encrypt += 1;
      return Buffer.from(`protected:${Buffer.from(value).toString('base64')}`);
    },
    decryptString(value) {
      calls.decrypt += 1;
      const encoded = value.toString('utf8');
      if (!encoded.startsWith('protected:')) throw new Error('decrypt failed');
      return Buffer.from(encoded.slice('protected:'.length), 'base64').toString('utf8');
    },
  };
}

function reveal(credential) {
  return credential.withStrings((username, password) => ({ username, password }));
}

test('stable credential is generated once, encrypted, and reused after restart', (t) => {
  const temporary = temporaryFile();
  t.after(temporary.cleanup);
  const safeStorage = fakeSafeStorage();
  let entropy = 0;
  const options = {
    filePath: temporary.file,
    safeStorage,
    platform: HOST_PRIVATE_FILE_PLATFORM,
    randomBytes: (length) => Buffer.alloc(length, ++entropy),
  };
  const first = new ExternalProxyCredentialStore(options).loadOrCreate();
  const firstMaterial = reveal(first);
  const firstReference = first.reference();
  assert.match(firstReference, /^credential-[a-f0-9]{32}$/u);
  first.destroy();

  assert.equal(safeStorage.calls.encrypt, 1);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(temporary.file).mode & 0o077, 0);
  }
  const encrypted = fs.readFileSync(temporary.file, 'utf8');
  assert.doesNotMatch(encrypted, new RegExp(firstMaterial.username));
  assert.doesNotMatch(encrypted, new RegExp(firstMaterial.password));

  const second = new ExternalProxyCredentialStore(options).loadOrCreate();
  assert.deepEqual(reveal(second), firstMaterial);
  assert.equal(second.reference(), firstReference);
  assert.equal(safeStorage.calls.encrypt, 1, 'reconnect/restart must not rotate or rewrite');
  assert.equal(safeStorage.calls.decrypt, 1);
  assert.doesNotMatch(util.inspect(second), new RegExp(firstMaterial.password));
  assert.doesNotMatch(JSON.stringify(second), new RegExp(firstMaterial.username));
  second.destroy();
});

test('an unreadable existing credential fails without replacement or new entropy', (t) => {
  const temporary = temporaryFile();
  t.after(temporary.cleanup);
  fs.writeFileSync(temporary.file, 'not-an-encrypted-document', { mode: 0o600 });
  if (process.platform === 'win32') {
    assert.equal(protectWindowsFileOwnerOnly(temporary.file), true);
    assert.equal(verifyWindowsFileOwnerOnly(temporary.file), true);
  }
  const before = fs.readFileSync(temporary.file);
  const safeStorage = fakeSafeStorage();
  let generated = 0;
  const store = new ExternalProxyCredentialStore({
    filePath: temporary.file,
    safeStorage,
    platform: HOST_PRIVATE_FILE_PLATFORM,
    randomBytes: (length) => {
      generated += 1;
      return Buffer.alloc(length, 9);
    },
  });
  assert.throws(() => store.loadOrCreate(), /cannot be decrypted/);
  assert.equal(generated, 0, 'load failure must never fall through to generation');
  assert.equal(safeStorage.calls.encrypt, 0);
  assert.equal(safeStorage.calls.decrypt, 1, 'the fixture must reach decryption, not fail at ACL setup');
  assert.deepEqual(fs.readFileSync(temporary.file), before);
});

test('unavailable secure storage creates no plaintext fallback', (t) => {
  const temporary = temporaryFile();
  t.after(temporary.cleanup);
  const store = new ExternalProxyCredentialStore({
    filePath: temporary.file,
    safeStorage: fakeSafeStorage({ available: false }),
    platform: HOST_PRIVATE_FILE_PLATFORM,
  });
  assert.throws(() => store.loadOrCreate(), /secure storage is unavailable/);
  assert.equal(fs.existsSync(temporary.file), false);
});

test('clear durably revokes the encrypted credential without decrypting it', (t) => {
  const temporary = temporaryFile();
  t.after(temporary.cleanup);
  const safeStorage = fakeSafeStorage();
  let entropy = 7;
  const store = new ExternalProxyCredentialStore({
    filePath: temporary.file,
    safeStorage,
    platform: HOST_PRIVATE_FILE_PLATFORM,
    randomBytes: (length) => Buffer.alloc(length, entropy++),
  });
  store.create().destroy();
  assert.equal(store.clear(), true);
  assert.equal(fs.existsSync(temporary.file), false);
  assert.equal(store.clear(), true);
  assert.equal(safeStorage.calls.decrypt, 0);
});

test('clear never follows a symbolic or hard-linked credential', {
  skip: process.platform === 'win32',
}, (t) => {
  const temporary = temporaryFile();
  t.after(temporary.cleanup);
  const unrelated = path.join(temporary.directory, 'unrelated');
  fs.writeFileSync(unrelated, 'unrelated', { mode: 0o600 });
  const store = new ExternalProxyCredentialStore({
    filePath: temporary.file,
    safeStorage: fakeSafeStorage(),
    platform: 'darwin',
  });
  fs.symlinkSync(unrelated, temporary.file);
  assert.throws(() => store.clear(), /cannot be removed safely/u);
  fs.unlinkSync(temporary.file);
  fs.linkSync(unrelated, temporary.file);
  assert.throws(() => store.clear(), /cannot be removed safely/u);
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'unrelated');
});

test('simulated Windows create protects and clear verifies the encrypted file ACL', (t) => {
  const temporary = temporaryFile();
  t.after(temporary.cleanup);
  const protectedPaths = [];
  const verifiedPaths = [];
  const windowsAcl = {
    protect(file) { protectedPaths.push(file); return true; },
    verify(file) { verifiedPaths.push(file); return fs.existsSync(file); },
  };
  let entropy = 8;
  const store = new ExternalProxyCredentialStore({
    filePath: temporary.file,
    safeStorage: fakeSafeStorage(),
    platform: 'win32',
    windowsAcl,
    randomBytes: (length) => Buffer.alloc(length, entropy++),
  });
  store.create().destroy();
  assert.equal(store.clear(), true);
  assert.equal(protectedPaths.some((file) => file.endsWith('.tmp')), true);
  assert.equal(verifiedPaths.includes(temporary.file), true);
});
