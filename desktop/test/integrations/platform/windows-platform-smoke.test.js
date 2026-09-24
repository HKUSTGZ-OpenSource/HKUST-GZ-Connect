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
const {
  commitActiveContextSwitch,
  createPreparedActiveContextSwitch,
  markActiveContextSwitchReady,
} = require('../../../lib/switching/active-context/active-context-switch-journal');

const DESKTOP = path.resolve(__dirname, '..', '..', '..');

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

test('real Windows storage provisions and reopens one isolated custom school', {
  skip: process.platform !== 'win32',
  timeout: 120_000,
}, (t) => {
  const userData = privateRoot(t, 'hkustgz-windows-custom-school-');
  let entropy = 60;
  const result = new CustomProfileProvisioningRuntime({
    userData,
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
