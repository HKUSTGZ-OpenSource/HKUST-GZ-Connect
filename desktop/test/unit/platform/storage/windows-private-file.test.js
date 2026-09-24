'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  PRIVATE_FILE_ENV,
  POWERSHELL_ACL_TIMEOUT_MS,
  protectWindowsFileOwnerOnly,
  tightenWindowsFileOwnerOnly,
  verifyWindowsFileOwnerOnly,
} = require('../../../../lib/platform/storage/windows-private-file');
const { ensureOwnerOnly } = require('../../../../lib/platform/storage/private-file');
const { atomicWritePrivateFile } = require('../../../../lib/platform/storage/atomic-private-file');
const {
  prepareBroadCurrentUserFile, prepareAdministratorsOwnedFile, securityDescriptor,
} = require('./support/windows-acl-fixture');

test('Windows ACL commands keep paths out of scripts and require fixed verification output', () => {
  const calls = [];
  const execute = (command, args, options) => {
    calls.push({ command, args, options });
    return 'owner_only';
  };
  const file = String.raw`C:\Users\student\private credential.txt`;
  assert.equal(protectWindowsFileOwnerOnly(file, {
    execute,
    environment: { SystemRoot: String.raw`C:\Windows` },
    platform: 'win32',
  }), true);
  assert.equal(tightenWindowsFileOwnerOnly(file, {
    execute,
    environment: {},
    platform: 'win32',
  }), true);
  assert.equal(verifyWindowsFileOwnerOnly(file, {
    execute,
    environment: {},
    platform: 'win32',
  }), true);
  assert.equal(calls.length, 3);
  for (const [index, call] of calls.entries()) {
    assert.equal(call.command, 'powershell.exe');
    assert.equal(call.args.includes(file), false, 'the path is not interpolated into PowerShell');
    const script = call.args.at(-1);
    assert.doesNotMatch(script, /\b(?:Get|Set)-Acl\b/u,
      'the ACL boundary must not depend on an autoloadable PowerShell module');
    assert.match(script, /\[System\.IO\.File\]::GetAccessControl\(\$privatePath\)/u);
    if (index <= 1) {
      assert.match(script, /\[System\.IO\.File\]::SetAccessControl\(\$privatePath, \$acl\)/u);
    }
    if (index === 1) {
      assert.match(script, /existingOwnerSid -ne \$currentSid/u,
        'ACL hardening must refuse a file owned by another SID');
      assert.ok(
        script.indexOf('existingOwnerSid -ne $currentSid') <
          script.indexOf('[System.IO.File]::SetAccessControl'),
        'ownership is checked before any ACL mutation',
      );
    }
    assert.equal(call.options.env[PRIVATE_FILE_ENV], file);
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.maxBuffer, 4096);
    assert.equal(call.options.timeout, POWERSHELL_ACL_TIMEOUT_MS);
  }

  assert.equal(verifyWindowsFileOwnerOnly(file, {
    execute: () => 'unexpected', platform: 'win32',
  }), false);
  assert.equal(protectWindowsFileOwnerOnly(file, {
    execute: () => { throw new Error('synthetic failure'); }, platform: 'win32',
  }), false);
  assert.equal(tightenWindowsFileOwnerOnly(file, {
    execute: () => { throw new Error('synthetic failure'); }, platform: 'win32',
  }), false);
  assert.equal(protectWindowsFileOwnerOnly('relative.txt', { execute, platform: 'win32' }), false);
  assert.equal(protectWindowsFileOwnerOnly(file, { execute, platform: 'darwin' }), false);
});

test('Windows ACL subprocess remains bounded but tolerates a cold PowerShell start', () => {
  assert.equal(POWERSHELL_ACL_TIMEOUT_MS, 30_000);
});

test('real Windows ACL is current-user-only and inheritance-protected', {
  skip: process.platform !== 'win32',
}, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-windows-acl-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'proxy-helper-credential.txt');
  fs.writeFileSync(file, 'synthetic-sidecar');
  assert.equal(protectWindowsFileOwnerOnly(file), true);
  assert.equal(verifyWindowsFileOwnerOnly(file), true);
});

test('real Windows upgrade tightens an inherited current-user legacy file', {
  skip: process.platform !== 'win32',
}, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-windows-legacy-acl-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'settings.json');
  fs.writeFileSync(file, '{"version":1}');
  prepareBroadCurrentUserFile(file);
  assert.equal(ensureOwnerOnly(file), true);
  assert.equal(verifyWindowsFileOwnerOnly(file), true);
});

test('real Windows ACL survives the atomic temporary-file commit boundary', {
  skip: process.platform !== 'win32',
}, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-windows-atomic-acl-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'workspace-state.json');
  assert.equal(atomicWritePrivateFile(file, '{"schemaVersion":1}\n', fs, {
    protectTemporary: protectWindowsFileOwnerOnly,
    verifyCommitted: verifyWindowsFileOwnerOnly,
    removeCommittedOnFailure: true,
  }), true);
  assert.equal(verifyWindowsFileOwnerOnly(file), true);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"schemaVersion":1}\n');
});

test('native Windows helper preserves private ACL policy without PowerShell startup', {
  skip: process.platform !== 'win32',
}, (t) => {
  const helper = path.resolve(__dirname, '../../../../engine/ec-private-file-windows-amd64.exe');
  assert.ok(fs.existsSync(helper), 'build the native Windows helper before this suite');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-native-acl-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "private unicode 文 ' $value.json");
  fs.writeFileSync(file, 'synthetic');
  prepareBroadCurrentUserFile(file);
  assert.equal(tightenWindowsFileOwnerOnly(file), true);
  assert.equal(verifyWindowsFileOwnerOnly(file, { nativeHelper: false }), true,
    'the independent PowerShell verifier must accept the native ACL');
  assert.equal(protectWindowsFileOwnerOnly(directory), false);
  assert.equal(verifyWindowsFileOwnerOnly(path.join(directory, 'absent')), false);
  const link = path.join(directory, 'hard-link.json');
  fs.linkSync(file, link);
  assert.equal(verifyWindowsFileOwnerOnly(file), false);
  assert.equal(tightenWindowsFileOwnerOnly(file), false);
  assert.equal(protectWindowsFileOwnerOnly(file), false, 'hardlinks cannot be mutated');
  fs.unlinkSync(link);
  assert.equal(verifyWindowsFileOwnerOnly(file), true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'synthetic');
});

test('native and PowerShell hardening refuse a foreign owner without changing its ACL', {
  skip: process.platform !== 'win32',
}, (t) => {
  const helper = path.resolve(__dirname, '../../../../engine/ec-private-file-windows-amd64.exe');
  assert.ok(fs.existsSync(helper), 'build the native Windows helper before this suite');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-foreign-owner-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'synthetic.json');
  fs.writeFileSync(file, 'synthetic');
  const fixture = prepareAdministratorsOwnedFile(file);
  if (fixture === 'requires_elevation') {
    t.skip('creating a foreign-owner fixture requires an elevated Windows token');
    return;
  }
  assert.equal(fixture, 'foreign_owner');
  const before = securityDescriptor(file);
  assert.equal(verifyWindowsFileOwnerOnly(file), false);
  assert.equal(tightenWindowsFileOwnerOnly(file), false);
  assert.equal(securityDescriptor(file), before, 'native rejection must not mutate owner or DACL');
  assert.equal(tightenWindowsFileOwnerOnly(file, { nativeHelper: false }), false);
  assert.equal(securityDescriptor(file), before, 'PowerShell rejection must not mutate owner or DACL');
  assert.equal(ensureOwnerOnly(file), false);
  assert.equal(securityDescriptor(file), before, 'descriptor wrapper must retain the same policy');
  assert.equal(fs.readFileSync(file, 'utf8'), 'synthetic');
});
