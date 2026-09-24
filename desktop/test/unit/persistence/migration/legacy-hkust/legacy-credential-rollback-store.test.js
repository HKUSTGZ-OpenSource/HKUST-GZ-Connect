'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { protectWindowsFileOwnerOnly, verifyWindowsFileOwnerOnly } =
  require('../../../../../lib/platform/storage/windows-private-file');
const {
  LegacyCredentialRollbackStore,
} = require('../../../../../lib/persistence/migration/legacy-hkust/legacy-credential-rollback-store');
const {
  createLegacyCredentialRollbackState,
  retireLegacyCredentialRollbackState,
  validateLegacyCredentialRollbackState,
} = require('../../../../../lib/persistence/migration/legacy-hkust/legacy-credential-rollback-state');
const { createProfileAccountWorkspaceLayout } = require('../../../../../lib/persistence/paths/profile-workspace-layout');

function migrationJournal() {
  return {
    migrationId: `migration-${'11'.repeat(16)}`,
    profileId: 'hkustgz',
    profileCredentialBindingRevision: 1,
    gatewayOrigin: 'https://remote.hkust-gz.edu.cn',
    protocolFamily: 'easyconnect-password-modern-l3-v1',
    identity: { accountKey: `account-${'22'.repeat(16)}` },
    accountCredentialRevision: 1,
  };
}

function writeFixture(file, data) {
  fs.writeFileSync(file, data, { mode: 0o600 });
  if (process.platform === 'win32') {
    assert.equal(protectWindowsFileOwnerOnly(file), true, 'protect only this synthetic fixture');
    assert.equal(verifyWindowsFileOwnerOnly(file), true);
  }
}

function fixture(t, { active = true } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-rollback-store-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const layout = createProfileAccountWorkspaceLayout({
    userData,
    profileKey: `profile-${'33'.repeat(16)}`,
    accountKey: migrationJournal().identity.accountKey,
    workspaceKey: `workspace-${'44'.repeat(16)}`,
  });
  fs.mkdirSync(layout.account.root, { recursive: true, mode: 0o700 });
  const blob = Buffer.from('legacy-encrypted-password');
  const sourceReceipt = active ? {
    present: true,
    bytes: blob.length,
    sha256: require('node:crypto').createHash('sha256').update(blob).digest('hex'),
  } : { present: false, bytes: 0, sha256: null };
  const state = createLegacyCredentialRollbackState({
    journal: migrationJournal(),
    sourceReceipt,
    now: () => 1_700_000_000_000,
  });
  if (active) writeFixture(layout.account.legacyCredentialRollbackBlob, blob);
  writeFixture(
    layout.account.legacyCredentialRollbackState,
    JSON.stringify(state),
  );
  const expectedBinding = {
    migrationId: state.migrationId,
    profileId: state.profileId,
    profileCredentialBindingRevision: state.profileCredentialBindingRevision,
    accountKey: state.accountKey,
    accountCredentialRevision: state.accountCredentialRevision,
    gatewayOrigin: state.gatewayOrigin,
    protocolFamily: state.protocolFamily,
  };
  return { userData, layout, blob, state, expectedBinding };
}

function store(value, options = {}) {
  return new LegacyCredentialRollbackStore({
    layout: value.layout,
    expectedBinding: value.expectedBinding,
    ...options,
  });
}

function persistedState(value) {
  return validateLegacyCredentialRollbackState(JSON.parse(
    fs.readFileSync(value.layout.account.legacyCredentialRollbackState, 'utf8'),
  ));
}

test('active rollback blob is readable only through explicit bound API', (t) => {
  const value = fixture(t);
  const rollback = store(value);
  assert.deepEqual(rollback.inspect(), { status: 'active' });
  const blob = rollback.readActiveRollbackBlob();
  assert.deepEqual(blob, value.blob);
  blob.fill(0);
  assert.deepEqual(rollback.inspect(), { status: 'active' });
});

test('retirement deletes blob before committing retired state and clears intent', (t) => {
  const value = fixture(t);
  const rollback = store(value);
  assert.deepEqual(rollback.retire({
    reason: 'credential_replaced',
    now: () => 1_700_000_000_100,
  }), { status: 'retired', changed: true });
  assert.equal(fs.existsSync(value.layout.account.legacyCredentialRollbackBlob), false);
  assert.equal(fs.existsSync(value.layout.account.legacyCredentialRollbackRetirement), false);
  assert.equal(persistedState(value).retirementReason, 'credential_replaced');
  assert.deepEqual(rollback.retire({
    reason: 'credential_cleared',
    now: () => 1_700_000_000_200,
  }), { status: 'retired', changed: false });
});

test('credential mutation cannot run until rollback retirement is proven', (t) => {
  const value = fixture(t);
  let mutated = false;
  const injected = Object.create(fs);
  injected.unlinkSync = (file) => {
    if (file === value.layout.account.legacyCredentialRollbackBlob) {
      throw new Error('simulated busy blob');
    }
    return fs.unlinkSync(file);
  };
  assert.throws(() => store(value, { fileSystem: injected }).retireBeforeMutation({
    reason: 'credential_cleared',
    mutation: () => { mutated = true; },
  }), /blob removal failed/u);
  assert.equal(mutated, false);
  assert.equal(store(value).reconcile().status, 'retired');
});

test('crash after blob deletion resumes state commit from retirement intent', (t) => {
  const value = fixture(t);
  const injected = Object.create(fs);
  injected.renameSync = (from, to) => {
    if (to === value.layout.account.legacyCredentialRollbackState) {
      throw new Error('simulated state commit crash');
    }
    return fs.renameSync(from, to);
  };
  assert.throws(() => store(value, { fileSystem: injected }).retire({
    reason: 'credential_replaced',
    now: () => 1_700_000_000_100,
  }), /state commit failed/u);
  assert.equal(fs.existsSync(value.layout.account.legacyCredentialRollbackBlob), false);
  assert.equal(fs.existsSync(value.layout.account.legacyCredentialRollbackRetirement), true);
  assert.equal(persistedState(value).state, 'active');
  assert.deepEqual(store(value).reconcile(), { status: 'retired', changed: true });
});

test('crash while clearing intent resumes without resurrecting blob', (t) => {
  const value = fixture(t);
  const injected = Object.create(fs);
  injected.unlinkSync = (file) => {
    if (file === value.layout.account.legacyCredentialRollbackRetirement) {
      throw new Error('simulated intent clear crash');
    }
    return fs.unlinkSync(file);
  };
  assert.throws(() => store(value, { fileSystem: injected }).retire({
    reason: 'credential_replaced',
    now: () => 1_700_000_000_100,
  }), /intent clear failed/u);
  assert.equal(persistedState(value).state, 'retired');
  assert.equal(fs.existsSync(value.layout.account.legacyCredentialRollbackBlob), false);
  assert.equal(fs.existsSync(value.layout.account.legacyCredentialRollbackRetirement), true);
  assert.deepEqual(store(value).reconcile(), { status: 'retired', changed: true });
});

test('active state with missing blob and no intent blocks instead of inventing retirement', (t) => {
  const value = fixture(t);
  fs.unlinkSync(value.layout.account.legacyCredentialRollbackBlob);
  assert.throws(() => store(value).reconcile(), /active rollback blob is missing/u);
  assert.equal(persistedState(value).state, 'active');
});

test('retired state with resurrected blob is reconciled by deleting dedicated blob', (t) => {
  const value = fixture(t);
  const retired = retireLegacyCredentialRollbackState(value.state, {
    reason: 'credential_cleared',
    now: () => 1_700_000_000_100,
  });
  writeFixture(value.layout.account.legacyCredentialRollbackState, JSON.stringify(retired));
  assert.deepEqual(store(value).reconcile(), { status: 'retired', changed: true });
  assert.equal(fs.existsSync(value.layout.account.legacyCredentialRollbackBlob), false);
});

test('binding mismatch, link substitution and unknown retirement intent fail closed', {
  skip: process.platform === 'win32',
}, (t) => {
  const value = fixture(t);
  assert.throws(() => new LegacyCredentialRollbackStore({
    layout: value.layout,
    expectedBinding: {
      ...value.expectedBinding,
      accountKey: `account-${'55'.repeat(16)}`,
    },
  }).inspect(), /binding/u);

  const target = path.join(value.userData, 'unrelated');
  fs.writeFileSync(target, 'unrelated', { mode: 0o600 });
  fs.unlinkSync(value.layout.account.legacyCredentialRollbackBlob);
  fs.symlinkSync(target, value.layout.account.legacyCredentialRollbackBlob);
  assert.throws(() => store(value).inspect(), /private file/u);
  assert.equal(fs.readFileSync(target, 'utf8'), 'unrelated');
});

test('malformed retirement intent is never treated as authority', (t) => {
  const value = fixture(t);
  writeFixture(
    value.layout.account.legacyCredentialRollbackRetirement,
    JSON.stringify({ schemaVersion: 1, type: 'unknown' }),
  );
  assert.throws(() => store(value).reconcile(), /schema|unsupported/u);
  assert.equal(fs.existsSync(value.layout.account.legacyCredentialRollbackBlob), true);
  assert.equal(persistedState(value).state, 'active');
});

test('mutation exceptions do not undo a proven credential retirement', (t) => {
  const value = fixture(t);
  assert.throws(() => store(value).retireBeforeMutation({
    reason: 'account_removed',
    mutation() { throw new Error('simulated account mutation failure'); },
  }), /account mutation failure/u);
  assert.equal(fs.existsSync(value.layout.account.legacyCredentialRollbackBlob), false);
  assert.equal(persistedState(value).state, 'retired');
});

test('simulated Windows retirement protects and verifies state and intent DACLs', (t) => {
  const value = fixture(t);
  const protectedPaths = [];
  const verifiedPaths = [];
  const windowsAcl = {
    protect(file) { protectedPaths.push(file); return true; },
    verify(file) { verifiedPaths.push(file); return fs.existsSync(file); },
  };
  const rollback = store(value, { platform: 'win32', windowsAcl });
  assert.equal(rollback.retire({
    reason: 'credential_replaced',
    now: () => 1_700_000_000_100,
  }).status, 'retired');
  assert.equal(protectedPaths.some((file) => file.endsWith('.tmp')), true);
  assert.equal(verifiedPaths.includes(value.layout.account.legacyCredentialRollbackState), true);
});

for (const part of ['legacyCredentialRollbackState', 'legacyCredentialRollbackBlob']) {
  test(`native Windows rejects insecure ${part} without deleting rollback material`, {
    skip: process.platform !== 'win32',
  }, (t) => {
    const value = fixture(t), file = value.layout.account[part];
    const original = fs.readFileSync(file);
    fs.unlinkSync(file);
    fs.writeFileSync(file, original, { mode: 0o600 });
    assert.equal(verifyWindowsFileOwnerOnly(file), false);
    assert.throws(() => store(value).readActiveRollbackBlob(), /invalid private file/);
    assert.deepEqual(fs.readFileSync(file), original);
    assert.equal(fs.existsSync(value.layout.account.legacyCredentialRollbackBlob), true);
    assert.equal(fs.existsSync(value.layout.account.legacyCredentialRollbackRetirement), false);
    assert.equal(persistedState(value).state, 'active');
    assert.equal(verifyWindowsFileOwnerOnly(file), false);
  });
}
