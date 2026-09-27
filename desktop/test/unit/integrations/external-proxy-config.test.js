'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  buildSshProxyCommand,
  ensureProxyCredentialSidecar,
  externalProxyHelperPath,
  helperExecutableName,
} = require('../../../lib/integrations/external-proxy-config');
const {
  createPrivateStorageEffects,
  ensureOwnerOnly,
} = require('../../../lib/platform/storage/private-file');

const material = Object.freeze({
  username: 'A'.repeat(32),
  password: 'B'.repeat(32),
});
const credential = {
  withStrings(callback) {
    return callback(material.username, material.password);
  },
};

function sidecarWithStorage(options) {
  const { platform = process.platform, fileSystem = fs, windowsAcl, ...sidecar } = options;
  return ensureProxyCredentialSidecar({
    ...sidecar,
    privateStorageEffects: createPrivateStorageEffects({ fileSystem, platform, windowsAcl }),
  });
}

test('helper sidecar is owner-only, exactly three lines, and not rewritten when unchanged', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-proxy-sidecar-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'proxy-helper-credential.txt');
  const first = sidecarWithStorage({ filePath, port: 6180, credential });
  assert.equal(first.changed, true);
  const stat = fs.statSync(filePath);
  // POSIX mode bits are not the Windows authorization boundary. On Windows
  // the call above already performed and re-read the exact owner-only DACL;
  // the dedicated real-ACL test checks that platform contract directly.
  if (process.platform !== 'win32') assert.equal(stat.mode & 0o077, 0);
  assert.deepEqual(fs.readFileSync(filePath, 'utf8').split('\n'), [
    '127.0.0.1:6180',
    material.username,
    material.password,
  ]);

  const second = sidecarWithStorage({ filePath, port: 6180, credential });
  assert.equal(second.changed, false);
  assert.equal(fs.statSync(filePath).ino, stat.ino, 'unchanged sidecar keeps its inode');

  const changed = sidecarWithStorage({ filePath, port: 6280, credential });
  assert.equal(changed.changed, true);
  assert.equal(fs.readFileSync(filePath, 'utf8').split('\n')[0], '127.0.0.1:6280');
});

test('Profile-bound sidecar and SSH command carry identity but never credential values in argv', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-proxy-sidecar-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'proxy-helper-credential.txt');
  sidecarWithStorage({
    filePath, port: 6180, credential, profileId: 'school-a',
  });
  assert.deepEqual(fs.readFileSync(filePath, 'utf8').split('\n'), [
    'school-a', '127.0.0.1:6180', material.username, material.password,
  ]);
  const command = buildSshProxyCommand({
    helperPath: '/Applications/Campus Connect.app/helper',
    credentialFile: filePath,
    profileId: 'school-a',
  });
  assert.match(command, /--profile-id "school-a" --credential-file/u);
  assert.doesNotMatch(command, new RegExp(material.username, 'u'));
  assert.doesNotMatch(command, new RegExp(material.password, 'u'));
});

test('Windows sidecar is ACL-protected before commit and reverified when unchanged', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-proxy-sidecar-win-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'proxy-helper-credential.txt');
  const calls = [];
  const windowsAcl = {
    protect: (file) => { calls.push(['protect', file]); return true; },
    verify: (file) => { calls.push(['verify', file]); return true; },
  };
  const first = sidecarWithStorage({
    filePath, port: 6180, credential, platform: 'win32', windowsAcl,
  });
  assert.equal(first.changed, true);
  assert.match(path.basename(calls[0][1]), /^\.proxy-helper-credential\.txt\..+\.tmp$/u);
  assert.deepEqual(calls[1], ['verify', filePath]);

  calls.length = 0;
  const second = sidecarWithStorage({
    filePath, port: 6180, credential, platform: 'win32', windowsAcl,
  });
  assert.equal(second.changed, false);
  assert.deepEqual(calls, [['protect', filePath], ['verify', filePath]]);
});

test('Windows sidecar protection or verification failure removes untrusted plaintext', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-proxy-sidecar-fail-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'proxy-helper-credential.txt');

  assert.throws(() => sidecarWithStorage({
    filePath,
    port: 6180,
    credential,
    platform: 'win32',
    windowsAcl: { protect: () => false, verify: () => true },
  }), /could not write/u);
  assert.equal(fs.existsSync(filePath), false);

  assert.throws(() => sidecarWithStorage({
    filePath,
    port: 6180,
    credential,
    platform: 'win32',
    windowsAcl: { protect: () => true, verify: () => false },
  }), /could not write/u);
  assert.equal(fs.existsSync(filePath), false);

  fs.writeFileSync(filePath, `127.0.0.1:6180\n${material.username}\n${material.password}`);
  assert.throws(() => sidecarWithStorage({
    filePath,
    port: 6180,
    credential,
    platform: 'win32',
    windowsAcl: { protect: () => true, verify: () => false },
  }), /verify/u);
  assert.equal(fs.existsSync(filePath), false);
});

test('sidecar uses the injected private storage filesystem and ACL effects', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-proxy-sidecar-effects-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'proxy-helper-credential.txt');
  const operations = [];
  const aclCalls = [];
  const windowsAcl = {
    protect(file) { aclCalls.push(['protect', file]); return true; },
    verify(file) { aclCalls.push(['verify', file]); return true; },
  };
  const storage = createPrivateStorageEffects({
    fileSystem: fs,
    platform: 'win32',
    windowsAcl,
  });
  const privateStorageEffects = Object.freeze({
    ...storage,
    readPrivateFileBounded(file, options) {
      operations.push('read');
      return storage.readPrivateFileBounded(file, options);
    },
    atomicWritePrivateFile(file, contents, options) {
      operations.push('write');
      return storage.atomicWritePrivateFile(file, contents, options);
    },
    ensureOwnerOnly(file) {
      operations.push('owner-only');
      return ensureOwnerOnly(file, { fileSystem: fs, platform: 'darwin' });
    },
  });

  const result = ensureProxyCredentialSidecar({
    filePath,
    port: 6180,
    credential,
    privateStorageEffects,
  });

  assert.equal(result.changed, true);
  assert.deepEqual(operations, ['read', 'write']);
  assert.deepEqual(aclCalls.map(([kind]) => kind), ['protect', 'verify']);
  assert.equal(fs.readFileSync(filePath, 'utf8').split('\n').length, 3);
});

test('sidecar fails before materializing a credential without bound storage effects', () => {
  let credentialRead = false;
  assert.throws(() => ensureProxyCredentialSidecar({
    filePath: '/synthetic/sidecar', port: 6180,
    credential: { withStrings() { credentialRead = true; } },
  }), /storage effects are invalid/u);
  assert.equal(credentialRead, false);
});

test('one SSH ProxyCommand contains only stable paths and targets the packaged helper', () => {
  assert.equal(helperExecutableName('darwin', 'arm64'), 'ec-proxy-command-darwin-arm64');
  assert.equal(helperExecutableName('win32', 'x64'), 'ec-proxy-command-windows-amd64.exe');
  const helperPath = externalProxyHelperPath({
    isPackaged: true,
    resourcesPath: '/Applications/HKUST(GZ) Connect.app/Contents/Resources',
    desktopDir: '/unused',
    platform: 'darwin',
    arch: 'arm64',
  });
  const config = buildSshProxyCommand({
    helperPath,
    credentialFile: '/Users/student/Library/Application Support/HKUST/proxy-helper-credential.txt',
  });
  assert.match(config, /ec-proxy-command-darwin-arm64" --credential-file/);
  assert.match(config, /-- %h %p$/);
  assert.doesNotMatch(config, new RegExp(material.username));
  assert.doesNotMatch(config, new RegExp(material.password));
  assert.doesNotMatch(config, /\bnc\b|connect\.exe/);
});
