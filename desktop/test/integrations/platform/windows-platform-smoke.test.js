'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  CustomGatewayConfirmationOwner,
} = require('../../../lib/profiles/onboarding/custom-gateway-onboarding');
const {
  CustomProfileProvisioningRuntime,
} = require('../../../lib/profiles/provisioning/custom-profile-provisioning-runtime');
const {
  ProfileCandidateDirectory,
} = require('../../../lib/profiles/registry/profile-candidate-directory');
const {
  ActiveContextSwitchJournalStore,
} = require('../../../lib/switching/active-context/active-context-switch-store');
const { createPrivateStorageEffects } = require('../../../lib/platform/storage/private-file');
const { DesktopPersistenceRuntime } = require('../../../lib/persistence/runtime/desktop-persistence-runtime');
const {
  commitActiveContextSwitch,
  createPreparedActiveContextSwitch,
  markActiveContextSwitchReady,
} = require('../../../lib/switching/active-context/active-context-switch-journal');

const DESKTOP = path.resolve(__dirname, '..', '..', '..');
const profileStorageEffects = createPrivateStorageEffects({ fileSystem: fs, platform: process.platform });

function privateRoot(t, prefix) {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(value, { recursive: true, force: true }));
  return value;
}

function customConfirmation() {
  let seed = 1;
  const owner = new CustomGatewayConfirmationOwner({
    randomBytes: (length) => Buffer.alloc(length, seed++),
    now: () => 1_800_000_000_000,
    ttlMs: 10_000,
  });
  const activeContext = {
    profileId: 'hkustgz',
    profileRevision: 1,
    accountHandle: `account-${'a'.repeat(36)}`,
    activeContextEpoch: 7,
  };
  const view = owner.issue({
    probeResult: {
      schema_version: 1,
      normalized_origin: 'https://vpn.example.edu',
      https_identity_valid: true,
      compatibility: 'recognized_candidate',
      candidate_family: 'easyconnect-password-modern-l3-v1',
      reported_version: 'M7.6.8R2',
      http_status: 200,
    },
    activeContext,
  });
  return owner.consume({ confirmationHandle: view.confirmationHandle, activeContext });
}

test('real Windows credential adapters retire projections and preserve bounded login metadata', {
  skip: process.platform !== 'win32',
}, t => {
  const root = privateRoot(t, 'hkustgz-windows-credential-adapters-');
  const files = ['legacy-helper.json', 'selected-helper.json'].map(name => path.join(root, name));
  const sibling = path.join(root, 'sibling.json');
  for (const file of [...files, sibling]) fs.writeFileSync(file, 'synthetic-marker');
  for (const file of files) {
    assert.equal(DesktopPersistenceRuntime.discardStartupProxySidecar(file), true);
    assert.equal(fs.existsSync(file), false);
    assert.equal(DesktopPersistenceRuntime.discardStartupProxySidecar(file), true);
  }
  assert.equal(fs.readFileSync(sibling, 'utf8'), 'synthetic-marker');
  assert.equal(DesktopPersistenceRuntime.discardStartupProxySidecar(root), false,
    'native directory unlink refusal cannot be reported as confirmed removal');
  assert.throws(() => DesktopPersistenceRuntime.discardStartupProxySidecar('relative-helper'), TypeError);

  let persistent = false, engine = false, profile = 'fixture-profile-a', reads = 0;
  const access = DesktopPersistenceRuntime.createVpnCredentialAccess({
    persistence: { hasCredential: () => persistent,
      openCredential: () => { throw new Error('metadata must not open a credential'); } },
    getEngineActive: () => engine, getProfileId: () => profile, platform: 'win32',
    safeStorage: { isEncryptionAvailable: () => { throw new Error('metadata must not probe storage'); } },
  });
  t.after(() => access.clear());
  const readSettings = () => { reads++; return { username: 'fixture-visible-account',
    get password() { throw new Error('metadata must not read a password'); } }; };
  assert.deepEqual(access.loginAccount(readSettings), { ok: true, username: 'fixture-visible-account' });
  persistent = true;
  assert.deepEqual(access.loginAccount(readSettings), { ok: false, username: '' });
  persistent = false;
  access.stage({ profileId: profile, username: 'fixture-memory-account', password: 'fixture-memory-input' });
  assert.deepEqual(access.loginAccount(readSettings), { ok: false, username: '' });
  profile = 'fixture-profile-b';
  engine = true;
  assert.deepEqual(access.loginAccount(readSettings), { ok: false, username: '' });
  engine = false;
  assert.deepEqual(access.loginAccount(readSettings), { ok: true, username: 'fixture-visible-account' });
  assert.equal(reads, 2);
  assert.deepEqual(access.loginAccount(() => { throw new Error('synthetic settings unavailable'); }),
    { ok: false, username: '' });
});

test('real Windows storage provisions and reopens one isolated custom school', {
  skip: process.platform !== 'win32',
  timeout: 120_000,
}, (t) => {
  const userData = privateRoot(t, 'hkustgz-windows-custom-school-');
  let entropy = 60;
  const result = new CustomProfileProvisioningRuntime({
    userData,
    profileStorageEffects,
    randomBytes: (length) => Buffer.alloc(length, ++entropy),
    now: () => 1_800_000_000_500,
  }).begin(customConfirmation());
  assert.equal(result.ok, true);
  assert.equal(result.status, 'provisioned');

  const candidates = new ProfileCandidateDirectory({
    userData,
    packageRoot: DESKTOP,
    desktopDir: DESKTOP,
    isPackaged: false,
    profileStorageEffects,
  });
  const custom = candidates.listViews({ locale: 'en' })
    .find((candidate) => candidate.profileId === result.context.profileId);
  assert.ok(custom);
  assert.equal(custom.unverified, true);
  assert.equal(custom.sanitizedCompatibility, 'candidate');
  assert.equal(custom.normalizedGatewayOrigin, 'https://vpn.example.edu');
  candidates.withCandidate(result.context.profileId, (record) => {
    assert.equal(record.kind, 'custom-local');
    assert.equal(record.authority.profileState.gatewayOrigin, 'https://vpn.example.edu');
    assert.deepEqual(record.profile.browser.campusDomains, []);
    assert.deepEqual(record.profile.browser.directPartnerDomains, []);
  });
});

test('real Windows switch journal remains owner-only through every durable state', {
  skip: process.platform !== 'win32',
  timeout: 120_000,
}, (t) => {
  const userData = privateRoot(t, 'hkustgz-windows-switch-journal-');
  const context = (profileId, profileSeed, accountSeed, workspaceSeed, epoch) => ({
    profileId,
    profileKey: `profile-${profileSeed.repeat(32)}`,
    profileRevision: 1,
    profileCredentialBindingRevision: 1,
    accountKey: `account-${accountSeed.repeat(32)}`,
    accountRevision: 1,
    accountCredentialRevision: 1,
    workspaceKey: `workspace-${workspaceSeed.repeat(32)}`,
    activeContextEpoch: epoch,
  });
  const receipt = (seed) => ({
    present: true,
    bytes: seed + 50,
    sha256: seed.toString(16).padStart(64, '0'),
  });
  const store = new ActiveContextSwitchJournalStore({
    filePath: path.join(userData, 'global', 'active-context-switch.json'),
    profileStorageEffects,
  });
  const prepared = createPreparedActiveContextSwitch({
    from: context('hkustgz', '1', '2', '3', 3),
    to: context('example-school', '4', '5', '6', 2),
    engineGeneration: 9,
    activation: {
      globalSettings: { before: receipt(1), after: receipt(2) },
      destinationWorkspace: { before: receipt(3), after: receipt(4) },
    },
    randomBytes: () => Buffer.alloc(16, 7),
    now: () => 1_800_000_000_000,
  });
  const ready = markActiveContextSwitchReady(prepared, {
    now: () => 1_800_000_000_100,
  });
  const committed = commitActiveContextSwitch(ready, {
    now: () => 1_800_000_000_200,
  });
  assert.deepEqual(store.prepare(prepared), {
    prepared: true,
    durabilityUnconfirmed: false,
  });
  assert.equal(store.read()?.state, 'prepared');
  assert.deepEqual(store.markReady(ready), {
    ready: true,
    durabilityUnconfirmed: false,
  });
  assert.equal(store.read()?.state, 'ready');
  assert.deepEqual(store.commit(committed), {
    committed: true,
    durabilityUnconfirmed: false,
  });
  assert.equal(store.read()?.state, 'committed');
  assert.equal(store.clearCommitted(), true);
  assert.equal(store.read(), null);
});
