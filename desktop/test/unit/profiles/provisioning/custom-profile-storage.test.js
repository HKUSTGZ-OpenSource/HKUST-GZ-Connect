'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { CustomGatewayConfirmationOwner } = require('../../../../lib/profiles/onboarding/custom-gateway-onboarding');
const { CustomProfileIndexStore } = require('../../../../lib/profiles/registry/custom-profile-index');
const { CustomProfileMaterializer } = require('../../../../lib/profiles/provisioning/custom-profile-materializer');
const { CustomProfileProvisioningRuntime } = require('../../../../lib/profiles/provisioning/custom-profile-provisioning-runtime');
const { CustomProfileDeletionRuntime } = require('../../../../lib/profiles/deletion/custom-profile-deletion-runtime');
const { ProfileCandidateDirectory } = require('../../../../lib/profiles/registry/profile-candidate-directory');
const {
  CustomProfileProvisioningJournalStore,
} = require('../../../../lib/profiles/provisioning/custom-profile-provisioning-store');
const {
  createCustomProfileProvisioningIdentity,
  createCustomProfileProvisioningPlan,
} = require('../../../../lib/profiles/provisioning/custom-profile-provisioning-plan');
const { PROTOCOL_FAMILY } = require('../../../../lib/profiles/schema/school-profile-schema');
const { protectWindowsFileOwnerOnly, verifyWindowsFileOwnerOnly } = require('../../../../lib/platform/storage/windows-private-file');

function assertPrivate(file) {
  if (process.platform === 'win32') assert.equal(verifyWindowsFileOwnerOnly(file), true);
  else assert.equal(fs.lstatSync(file).mode & 0o077, 0);
}

function prepareNewFixture(file) {
  if (process.platform === 'win32') assert.equal(protectWindowsFileOwnerOnly(file), true);
  assertPrivate(file);
}

function root(t) {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-profile-storage-'));
  fs.chmodSync(value, 0o700);
  t.after(() => fs.rmSync(value, { recursive: true, force: true }));
  return value;
}

function consumedConfirmation(seed = 1) {
  let entropy = seed;
  const owner = new CustomGatewayConfirmationOwner({
    randomBytes: (length) => Buffer.alloc(length, entropy++),
    now: () => 1_800_000_000_000,
    ttlMs: 10_000,
  });
  const context = {
    profileId: 'hkustgz', profileRevision: 1,
    accountHandle: `account-${'a'.repeat(36)}`, activeContextEpoch: 7,
  };
  const view = owner.issue({
    probeResult: {
      schema_version: 1,
      normalized_origin: `https://vpn${seed}.example.edu`,
      https_identity_valid: true,
      compatibility: 'recognized_candidate',
      candidate_family: PROTOCOL_FAMILY,
      reported_version: 'M7.6.8R2',
      http_status: 200,
    },
    activeContext: context,
  });
  return owner.consume({ confirmationHandle: view.confirmationHandle, activeContext: context });
}

function plan(userData, seed = 1) {
  const confirmation = consumedConfirmation(seed);
  let entropy = seed + 20;
  const identity = createCustomProfileProvisioningIdentity({
    profileId: confirmation.draftProfileId,
    randomBytes: (length) => Buffer.alloc(length, entropy++),
  });
  return createCustomProfileProvisioningPlan({
    userData,
    confirmation,
    identity,
    now: () => 1_800_000_000_100 + seed,
  });
}

test('materializer preflights then writes and verifies one exact idempotent plan', (t) => {
  const userData = root(t);
  const value = plan(userData);
  const materializer = new CustomProfileMaterializer();
  const expected = materializer.expected(value);
  assert.equal(materializer.verify(value, expected), false);
  assert.equal(materializer.materialize(value, expected), true);
  assert.equal(materializer.verify(value, expected), true);
  assert.equal(materializer.materialize(value, expected), true);
  for (const file of Object.values(value.paths)) {
    const stat = fs.lstatSync(file);
    assert.equal(stat.isFile() && !stat.isSymbolicLink(), true);
    assertPrivate(file);
    assert.equal(stat.nlink, 1);
  }
});

test('destination conflict blocks before any other plan file is written', (t) => {
  const userData = root(t);
  const value = plan(userData);
  fs.mkdirSync(path.dirname(value.paths.profileState), { recursive: true, mode: 0o700 });
  fs.writeFileSync(value.paths.profileState, '{"conflict":true}\n', { mode: 0o600 });
  prepareNewFixture(value.paths.profileState);
  const materializer = new CustomProfileMaterializer();
  assert.throws(() => materializer.materialize(value, materializer.expected(value)), /conflict/u);
  assert.equal(fs.existsSync(value.paths.schoolProfile), false);
  assert.equal(fs.existsSync(value.paths.account), false);
});

test('materializer never follows a destination symlink', { skip: process.platform === 'win32' }, (t) => {
  const userData = root(t);
  const value = plan(userData);
  const outside = path.join(userData, 'outside.json');
  fs.writeFileSync(outside, '{}\n', { mode: 0o600 });
  fs.mkdirSync(path.dirname(value.paths.schoolProfile), { recursive: true, mode: 0o700 });
  fs.symlinkSync(outside, value.paths.schoolProfile);
  const materializer = new CustomProfileMaterializer();
  assert.throws(() => materializer.materialize(value, materializer.expected(value)), /private file/u);
  assert.equal(fs.readFileSync(outside, 'utf8'), '{}\n');
});

test('custom Profile index is owner-only additive idempotent and bounded', (t) => {
  const userData = root(t);
  const firstPlan = plan(userData, 1);
  const store = new CustomProfileIndexStore({ userData });
  const entry = {
    profileId: firstPlan.context.profileId,
    profileKey: firstPlan.context.profileKey,
    createdAt: firstPlan.createdAt,
  };
  const transition = store.planAdd(entry);
  assert.equal(transition.before.present, false);
  assert.equal(store.applyAdd(entry, transition), true);
  assert.equal(store.applyAdd(entry, transition), true);
  assert.deepEqual(store.read().entries, [entry]);
  assertPrivate(store.filePath);
  assert.throws(() => store.planAdd(entry), /cannot add/u);

  const secondPlan = plan(userData, 2);
  const second = {
    profileId: secondPlan.context.profileId,
    profileKey: secondPlan.context.profileKey,
    createdAt: secondPlan.createdAt,
  };
  const next = store.planAdd(second);
  assert.equal(store.applyAdd(second, next), true);
  assert.equal(store.read().entries.length, 2);

  const removal = store.planRemove(entry.profileId);
  assert.equal(store.applyRemove(entry.profileId, removal), true);
  assert.equal(store.applyRemove(entry.profileId, removal), true);
  assert.deepEqual(store.read().entries, [second]);
  assert.throws(() => store.planRemove(entry.profileId), /cannot remove/u);
});

test('custom Profile index rejects broad permissions and links', {
  skip: process.platform === 'win32',
}, (t) => {
  const userData = root(t);
  const store = new CustomProfileIndexStore({ userData });
  fs.mkdirSync(path.dirname(store.filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(store.filePath, '{"schemaVersion":1,"entries":[]}\n', { mode: 0o644 });
  assert.throws(() => store.read(), /private file/u);
  fs.unlinkSync(store.filePath);
  const outside = path.join(userData, 'outside-index.json');
  fs.writeFileSync(outside, '{"schemaVersion":1,"entries":[]}\n', { mode: 0o600 });
  fs.symlinkSync(outside, store.filePath);
  assert.throws(() => store.read(), /private file/u);
});

function faultOnce(store, method) {
  let armed = true;
  return new Proxy(store, {
    get(target, property) {
      if (property === method) {
        return (...arguments_) => {
          if (armed) {
            armed = false;
            throw new Error(`synthetic ${method} crash`);
          }
          return target[property](...arguments_);
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function runtime(userData, overrides = {}) {
  let entropy = 80;
  return new CustomProfileProvisioningRuntime({
    userData,
    randomBytes: (length) => Buffer.alloc(length, ++entropy),
    now: () => 1_800_000_000_500,
    ...overrides,
  });
}

test('runtime commits files and index then clears its journal without activating GlobalSettings', (t) => {
  const userData = root(t);
  const global = path.join(userData, 'global');
  fs.mkdirSync(global, { mode: 0o700 });
  const settings = path.join(global, 'settings.json');
  fs.writeFileSync(settings, '{"unrelated":"authority"}\n', { mode: 0o600 });
  const before = fs.readFileSync(settings);
  const result = runtime(userData).begin(consumedConfirmation(7));
  assert.equal(result.ok, true);
  assert.equal(result.status, 'provisioned');
  assert.equal(fs.readFileSync(settings).equals(before), true);
  assert.equal(new CustomProfileIndexStore({ userData }).read().entries.length, 1);
  assert.equal(new CustomProfileProvisioningJournalStore({ userData }).read(), null);
  assert.equal(fs.existsSync(path.join(
    userData, 'profiles', result.context.profileKey, 'school-profile.json',
  )), true);
});

test('inactive custom Profile deletion clears Browser data, retires index last, and removes its namespace', async (t) => {
  const userData = root(t);
  const provisioned = runtime(userData).begin(consumedConfirmation(12));
  const desktopRoot = path.resolve(__dirname, '..', '..', '..', '..');
  const directory = new ProfileCandidateDirectory({
    userData,
    packageRoot: desktopRoot,
    desktopDir: desktopRoot,
  });
  const calls = [];
  const deletion = new CustomProfileDeletionRuntime({
    userData,
    withCandidateDirectory: (callback) => callback(directory),
    electronSession: { fromPartition: (partition) => ({
      closeAllConnections: async () => calls.push(['close', partition]),
      clearStorageData: async () => calls.push(['storage', partition]),
      clearCache: async () => calls.push(['cache', partition]),
    }) },
  });
  const profileRoot = path.join(userData, 'profiles', provisioned.context.profileKey);
  assert.equal((await deletion.deleteProfile({
    profileId: provisioned.context.profileId,
    activeProfileId: 'hkustgz',
  })).ok, true);
  assert.equal(fs.existsSync(profileRoot), false);
  assert.deepEqual(new CustomProfileIndexStore({ userData }).read().entries, []);
  assert.deepEqual(calls.map(([name]) => name), ['close', 'storage', 'cache']);
});

test('failed Browser cleanup tombstones the custom Profile and restart recovery completes it', async (t) => {
  const userData = root(t);
  const provisioned = runtime(userData).begin(consumedConfirmation(13));
  const desktopRoot = path.resolve(__dirname, '..', '..', '..', '..');
  const directory = new ProfileCandidateDirectory({
    userData, packageRoot: desktopRoot, desktopDir: desktopRoot,
  });
  let fail = true;
  const deletion = new CustomProfileDeletionRuntime({
    userData,
    withCandidateDirectory: (callback) => callback(directory),
    electronSession: { fromPartition: () => ({
      closeAllConnections: async () => {},
      clearStorageData: async () => { if (fail) throw new Error('synthetic clear failure'); },
      clearCache: async () => {},
    }) },
  });
  const first = await deletion.deleteProfile({
    profileId: provisioned.context.profileId,
    activeProfileId: 'hkustgz',
  });
  assert.deepEqual(first, { ok: false, code: 'PROFILE_DELETE_INCOMPLETE' });
  assert.equal(directory.customRegistry.reload().listViews().length, 0,
    'a tombstoned Profile cannot be selected again');
  fail = false;
  assert.deepEqual(await deletion.recover(), { ok: true, recovered: 1 });
  assert.deepEqual(new CustomProfileIndexStore({ userData }).read().entries, []);
});

test('prepared materialized and indexed crash points recover idempotently', (t) => {
  for (const fault of ['markMaterialized', 'markIndexed', 'clearIndexed']) {
    const userData = path.join(root(t), fault);
    fs.mkdirSync(userData, { mode: 0o700 });
    const store = new CustomProfileProvisioningJournalStore({ userData });
    const first = runtime(userData, { journalStore: faultOnce(store, fault) });
    assert.throws(() => first.begin(consumedConfirmation(fault.length)),
      new RegExp(`synthetic ${fault}`));
    const pending = store.read();
    assert.ok(pending, fault);
    const result = runtime(userData, { journalStore: store }).recover();
    assert.equal(result.status, 'provisioned', fault);
    assert.equal(store.read(), null, fault);
    assert.equal(new CustomProfileIndexStore({ userData }).read().entries.length, 1, fault);
  }
});

test('a destination conflict leaves a prepared journal and never indexes or activates it', (t) => {
  const userData = root(t);
  const confirmation = consumedConfirmation(9);
  let entropy = 80;
  const deterministic = () => runtime(userData, {
    randomBytes: (length) => Buffer.alloc(length, ++entropy),
  });
  // Build the same first identity separately so a hostile conflicting target
  // can be placed before the runtime reaches its materialization phase.
  let identityEntropy = 80;
  const identity = createCustomProfileProvisioningIdentity({
    profileId: confirmation.draftProfileId,
    randomBytes: (length) => Buffer.alloc(length, ++identityEntropy),
  });
  const planned = createCustomProfileProvisioningPlan({
    userData,
    confirmation,
    identity,
    now: () => 1_800_000_000_500,
  });
  fs.mkdirSync(path.dirname(planned.paths.account), { recursive: true, mode: 0o700 });
  fs.writeFileSync(planned.paths.account, '{"conflict":true}\n', { mode: 0o600 });
  prepareNewFixture(planned.paths.account);
  assert.throws(() => deterministic().begin(confirmation), /destination conflict/u);
  assert.equal(new CustomProfileIndexStore({ userData }).read().entries.length, 0);
  assert.equal(new CustomProfileProvisioningJournalStore({ userData }).read()?.state, 'prepared');
});

test('provisioning journal rejects broad permissions and links', {
  skip: process.platform === 'win32',
}, (t) => {
  const userData = root(t);
  const store = new CustomProfileProvisioningJournalStore({ userData });
  fs.mkdirSync(path.dirname(store.filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(store.filePath, '{}\n', { mode: 0o644 });
  assert.throws(() => store.read(), /private file/u);
  fs.unlinkSync(store.filePath);
  const outside = path.join(userData, 'outside-journal.json');
  fs.writeFileSync(outside, '{}\n', { mode: 0o600 });
  fs.symlinkSync(outside, store.filePath);
  assert.throws(() => store.read(), /private file/u);
});
