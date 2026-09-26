'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { CustomGatewayConfirmationOwner } = require('../../../../lib/profiles/onboarding/custom-gateway-onboarding');
const { CustomProfileProvisioningRuntime } = require('../../../../lib/profiles/provisioning/custom-profile-provisioning-runtime');
const { ProfileCandidateDirectory } = require('../../../../lib/profiles/registry/profile-candidate-directory');
const {
  SchoolProfileOnboardingCoordinator,
} = require('../../../../lib/profiles/onboarding/school-profile-onboarding');
const { PROTOCOL_FAMILY } = require('../../../../lib/profiles/schema/school-profile-schema');
const { createPrivateStorageEffects } = require('../../../../lib/platform/storage/private-file');

const profileStorageEffects = createPrivateStorageEffects({ fileSystem: fs, platform: process.platform });

function context(epoch = 7) {
  return {
    profileId: 'hkustgz',
    profileRevision: 1,
    accountHandle: `account-${'a'.repeat(36)}`,
    activeContextEpoch: epoch,
  };
}

function probeResult() {
  return {
    schema_version: 1,
    normalized_origin: 'https://vpn.example.edu',
    https_identity_valid: true,
    compatibility: 'recognized_candidate',
    candidate_family: PROTOCOL_FAMILY,
    reported_version: 'M7.6.8R2',
    http_status: 200,
  };
}

function profileView(profileId, { custom = false } = {}) {
  return {
    schemaVersion: 1,
    profileId,
    profileRevision: 1,
    evidenceClass: custom ? 'custom-local' : 'builtin-reviewed',
    schoolName: custom ? 'Example University' : 'HKUST(GZ)',
    shortName: custom ? 'Example University' : 'HKUST(GZ)',
    bundledAssetKey: custom ? null : 'hkustgz-logo',
    normalizedGatewayOrigin: custom
      ? 'https://vpn.example.edu'
      : 'https://remote.hkust-gz.edu.cn',
    sanitizedCompatibility: custom ? 'candidate' : 'reviewed',
    unverified: custom,
  };
}

function fixture(overrides = {}) {
  let active = context();
  let views = [profileView('hkustgz')];
  let seed = 1;
  const diagnostics = [];
  const provisioned = [];
  const probeRunner = overrides.probeRunner || {
    probe: async () => probeResult(),
    cancel: () => false,
  };
  const coordinator = new SchoolProfileOnboardingCoordinator({
    probeRunner,
    confirmationOwner: new CustomGatewayConfirmationOwner({
      randomBytes: (length) => Buffer.alloc(length, seed++),
      now: () => 1_800_000_000_000,
      ttlMs: 10_000,
    }),
    provisioningRuntime: {
      begin(confirmation) {
        provisioned.push(confirmation);
        views = [...views, profileView(confirmation.draftProfileId, { custom: true })];
        return { profileId: confirmation.draftProfileId };
      },
    },
    getActiveContext: () => ({ ...active }),
    listProfiles: overrides.listProfiles || (() => views.map((view) => ({ ...view }))),
    onDiagnostic: (code) => diagnostics.push(code),
  });
  return {
    coordinator,
    diagnostics,
    provisioned,
    setActive(value) { active = value; },
  };
}

test('profile list is sanitized and marks only the current Profile active', () => {
  const [view] = fixture({
    listProfiles: () => [{ ...profileView('hkustgz'), profileKey: 'must-not-cross' }],
  }).coordinator.list({ locale: 'en' });
  assert.equal(view.profileId, 'hkustgz');
  assert.equal(view.schoolName, 'HKUST(GZ)');
  assert.equal(view.active, true);
  assert.equal(Object.hasOwn(view, 'profileKey'), false);
});

test('probe confirmation provisions an unverified Profile without returning persistent keys', async () => {
  const f = fixture();
  const probed = await f.coordinator.probe({
    origin: 'https://vpn.example.edu',
    schoolLabel: 'Example University',
  });
  assert.equal(probed.ok, true);
  assert.equal(probed.confirmation.normalizedOrigin, 'https://vpn.example.edu');
  assert.equal(Object.hasOwn(probed.confirmation, 'profileKey'), false);
  assert.equal(Object.hasOwn(probed.confirmation, 'accountKey'), false);
  const confirmed = f.coordinator.confirm({
    confirmationHandle: probed.confirmation.confirmationHandle,
  });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.profileId.startsWith('custom-'), true);
  assert.equal(f.provisioned.length, 1);
  assert.equal(confirmed.profiles.length, 2);
  assert.equal(confirmed.profiles[1].active, false);
  assert.equal(confirmed.warningCode, null);
  assert.equal(Object.hasOwn(confirmed, 'context'), false);
});

test('active-context drift invalidates the probe before a confirmation can be issued', async () => {
  let resolveProbe;
  const f = fixture({
    probeRunner: {
      probe: () => new Promise((resolve) => { resolveProbe = resolve; }),
      cancel: () => false,
    },
  });
  const pending = f.coordinator.probe({ origin: 'https://vpn.example.edu' });
  await Promise.resolve();
  f.setActive(context(8));
  resolveProbe(probeResult());
  assert.deepEqual(await pending, { ok: false, code: 'PROFILE_CONFIRMATION_STALE' });
  assert.deepEqual(f.coordinator.confirm({ confirmationHandle: 'confirmation-stale' }), {
    ok: false,
    code: 'PROFILE_CONFIRMATION_STALE',
  });
});

test('renderer lifecycle cancellation invalidates an issued confirmation', async () => {
  const f = fixture();
  const probed = await f.coordinator.probe({ origin: 'https://vpn.example.edu' });
  assert.equal(probed.ok, true);
  assert.equal(f.coordinator.cancel(), true);
  assert.deepEqual(f.coordinator.confirm({
    confirmationHandle: probed.confirmation.confirmationHandle,
  }), { ok: false, code: 'PROFILE_CONFIRMATION_STALE' });
});

test('a post-commit list failure cannot misreport durable provisioning as failed', async () => {
  const f = fixture({ listProfiles: () => { throw new Error('private path'); } });
  const probed = await f.coordinator.probe({ origin: 'https://vpn.example.edu' });
  const confirmed = f.coordinator.confirm({
    confirmationHandle: probed.confirmation.confirmationHandle,
  });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.profileId.startsWith('custom-'), true);
  assert.deepEqual(confirmed.profiles, []);
  assert.equal(confirmed.warningCode, 'PROFILE_LIST_FAILED');
  assert.deepEqual(f.diagnostics, ['PROFILE_LIST_FAILED']);
});

test('runner and unsupported results collapse to stable value-free codes', async () => {
  const failed = fixture({
    probeRunner: {
      probe: async () => { const error = new Error('private path'); error.code = 'GATEWAY_PROBE_TIMEOUT'; throw error; },
      cancel: () => false,
    },
  });
  assert.deepEqual(await failed.coordinator.probe({ origin: 'https://vpn.example.edu' }), {
    ok: false,
    code: 'GATEWAY_PROBE_TIMEOUT',
  });
  assert.deepEqual(failed.diagnostics, ['GATEWAY_PROBE_TIMEOUT']);

  const unsupported = fixture({
    probeRunner: {
      probe: async () => ({ ...probeResult(), compatibility: 'unknown' }),
      cancel: () => false,
    },
  });
  assert.deepEqual(await unsupported.coordinator.probe({ origin: 'https://vpn.example.edu' }), {
    ok: false,
    code: 'GATEWAY_PROBE_UNSUPPORTED',
  });
});

test('confirmed onboarding materializes a restart-readable custom candidate', async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'school-onboarding-real-'));
  fs.chmodSync(userData, 0o700);
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const desktop = path.resolve(__dirname, '..', '..', '..', '..');
  const directory = new ProfileCandidateDirectory({
    userData,
    packageRoot: desktop,
    desktopDir: desktop,
    resourcesPath: '/unused',
    isPackaged: false,
    profileStorageEffects,
  });
  let confirmationSeed = 10;
  let provisioningSeed = 30;
  const coordinator = new SchoolProfileOnboardingCoordinator({
    probeRunner: { probe: async () => probeResult(), cancel: () => false },
    confirmationOwner: new CustomGatewayConfirmationOwner({
      randomBytes: (length) => Buffer.alloc(length, ++confirmationSeed),
      now: () => 1_800_000_000_000,
      ttlMs: 10_000,
    }),
    provisioningRuntime: new CustomProfileProvisioningRuntime({
      userData,
      profileStorageEffects,
      randomBytes: (length) => Buffer.alloc(length, ++provisioningSeed),
      now: () => 1_800_000_000_100,
    }),
    getActiveContext: () => context(),
    listProfiles: (options) => directory.listViews(options),
  });
  const probed = await coordinator.probe({ origin: 'https://vpn.example.edu' });
  const confirmed = coordinator.confirm({
    confirmationHandle: probed.confirmation.confirmationHandle,
  });
  assert.equal(confirmed.ok, true);
  let record;
  new ProfileCandidateDirectory({
    userData,
    packageRoot: desktop,
    desktopDir: desktop,
    resourcesPath: '/unused',
    isPackaged: false,
    profileStorageEffects,
  }).withCandidate(confirmed.profileId, (value) => { record = value; });
  assert.equal(record.profile.gateway.origin.origin, 'https://vpn.example.edu');
  assert.equal(record.kind, 'custom-local');
  assert.equal(record.context.activeContextEpoch, 1);
  assert.equal(Object.hasOwn(confirmed, 'context'), false);
});
