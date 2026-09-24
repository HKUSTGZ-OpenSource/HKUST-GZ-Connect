'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DESTINATION_RECEIPT_IDS } = require('../../../../lib/persistence/migration/legacy-hkust/profile-workspace-migration-journal');
const { createProfileAccountWorkspaceLayout } = require('../../../../lib/persistence/paths/profile-workspace-layout');
const {
  destinationPathMap,
  materializeDestinationFiles,
  verifyDestinationFiles,
} = require('../../../../lib/persistence/paths/profile-workspace-destination-files');
const { protectWindowsFileOwnerOnly, verifyWindowsFileOwnerOnly } = require('../../../../lib/platform/storage/windows-private-file');

const ABSENT_IDS = new Set([
  'globalProxyHelperCredential',
  'globalEngineOwner',
  'globalActiveContextSwitch',
  'globalSettingsTransaction',
  'legacyCredentialRollbackRetirement',
  'credentialTransaction',
  'deletionTombstone',
]);

function fixture(t) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-destination-files-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const layout = createProfileAccountWorkspaceLayout({
    userData,
    profileKey: `profile-${'11'.repeat(16)}`,
    accountKey: `account-${'22'.repeat(16)}`,
    workspaceKey: `workspace-${'33'.repeat(16)}`,
    adoptLegacyHkustBrowserPartition: true,
  });
  const files = Object.freeze(Object.fromEntries(DESTINATION_RECEIPT_IDS.map((id) => [
    id,
    ABSENT_IDS.has(id) ? null : Buffer.from(`synthetic-${id}`, 'utf8'),
  ])));
  return { userData, layout, files };
}

test('destination path map covers every journal receipt under opaque roots', (t) => {
  const { userData, layout } = fixture(t);
  const paths = destinationPathMap(layout);
  assert.deepEqual(Object.keys(paths), [...DESTINATION_RECEIPT_IDS]);
  for (const file of Object.values(paths)) {
    assert.equal(path.relative(userData, file).startsWith('..'), false);
    assert.equal(file.includes('hkustgz'), false);
    assert.equal(file.includes('remote.hkust-gz.edu.cn'), false);
    assert.equal(file.includes('student001'), false);
  }
});

test('destination path map rejects lexical escape even when leaf names look valid', (t) => {
  const { layout } = fixture(t);
  const malicious = {
    ...layout,
    global: { ...layout.global, settings: path.resolve('/tmp/outside-settings.json') },
  };
  assert.throws(() => destinationPathMap(malicious), /escapes/u);
});

test('materializer writes every present file once and verifies exact receipts idempotently', (t) => {
  const { layout, files } = fixture(t);
  const first = materializeDestinationFiles({ layout, files });
  assert.deepEqual(verifyDestinationFiles({ layout }), first);
  for (const id of DESTINATION_RECEIPT_IDS) {
    assert.equal(first[id].present, !ABSENT_IDS.has(id));
  }
  const paths = destinationPathMap(layout);
  const before = fs.statSync(paths.globalSettings);
  assert.deepEqual(materializeDestinationFiles({ layout, files }), first);
  const after = fs.statSync(paths.globalSettings);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test('mismatched destination blocks without overwriting any existing file', (t) => {
  const { layout, files } = fixture(t);
  const paths = destinationPathMap(layout);
  fs.mkdirSync(path.dirname(paths.globalSettings), { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.globalSettings, 'unexpected', { mode: 0o600 });
  if (process.platform === 'win32') {
    assert.equal(protectWindowsFileOwnerOnly(paths.globalSettings), true);
    assert.equal(verifyWindowsFileOwnerOnly(paths.globalSettings), true);
  }
  assert.throws(() => materializeDestinationFiles({ layout, files }), /conflict/u);
  assert.equal(fs.readFileSync(paths.globalSettings, 'utf8'), 'unexpected');
  assert.equal(fs.existsSync(paths.profileState), false);
});

test('symlinked destination is rejected without touching its target', {
  skip: process.platform === 'win32',
}, (t) => {
  const { userData, layout, files } = fixture(t);
  const paths = destinationPathMap(layout);
  const target = path.join(userData, 'unrelated');
  fs.mkdirSync(path.dirname(paths.globalSettings), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, 'unrelated', { mode: 0o600 });
  fs.symlinkSync(target, paths.globalSettings);
  assert.throws(() => materializeDestinationFiles({ layout, files }), /destination file/u);
  assert.equal(fs.readFileSync(target, 'utf8'), 'unrelated');
});

test('symlinked parent directory is rejected before the first destination write', {
  skip: process.platform === 'win32',
}, (t) => {
  const { userData, layout, files } = fixture(t);
  const unrelated = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-unrelated-destination-'));
  t.after(() => fs.rmSync(unrelated, { recursive: true, force: true }));
  fs.symlinkSync(unrelated, path.join(userData, 'global'));
  assert.throws(() => materializeDestinationFiles({ layout, files }), /link-free/u);
  assert.deepEqual(fs.readdirSync(unrelated), []);
});

test('atomic rename failure leaves an existing destination untouched', (t) => {
  const { layout, files } = fixture(t);
  const injected = Object.create(fs);
  injected.renameSync = () => { throw new Error('simulated rename failure'); };
  assert.throws(() => materializeDestinationFiles({ layout, files, fileSystem: injected }),
    /write failed/u);
  const paths = destinationPathMap(layout);
  assert.equal(fs.existsSync(paths.globalSettings), false);
});

test('simulated Windows destination files are ACL-protected and verified', (t) => {
  const { layout, files } = fixture(t);
  const protectedPaths = [];
  const verifiedPaths = [];
  const windowsAcl = {
    protect(file) { protectedPaths.push(file); return true; },
    verify(file) { verifiedPaths.push(file); return fs.existsSync(file); },
  };
  materializeDestinationFiles({ layout, files, platform: 'win32', windowsAcl });
  assert.equal(protectedPaths.some((file) => file.endsWith('.tmp')), true);
  assert.equal(verifiedPaths.includes(destinationPathMap(layout).globalSettings), true);
});
