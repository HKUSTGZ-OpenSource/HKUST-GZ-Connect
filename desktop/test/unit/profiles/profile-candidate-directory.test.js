'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { CustomGatewayConfirmationOwner } = require('../../../lib/profiles/onboarding/custom-gateway-onboarding');
const { ActiveContextActivationStore } = require('../../../lib/switching/active-context/active-context-activation-store');
const { ActiveContextSwitchBarrier } = require('../../../lib/switching/effects/active-context-switch-barrier');
const { ActiveContextSwitchJournalStore } = require('../../../lib/switching/active-context/active-context-switch-store');
const { CustomProfileProvisioningRuntime } = require('../../../lib/profiles/provisioning/custom-profile-provisioning-runtime');
const { ProfileCandidateDirectory } = require('../../../lib/profiles/registry/profile-candidate-directory');
const { ProfileSwitchRuntime } = require('../../../lib/switching/runtime/profile-switch-runtime');
const {
  createSchoolProfileControllerFromCandidate,
} = require('../../../lib/profiles/runtime/school-profile-controller');
const { createProfileAccountWorkspaceLayout } = require('../../../lib/persistence/paths/profile-workspace-layout');
const { ReviewedProfileAnchorStore } = require('../../../lib/profiles/registry/reviewed-profile-anchor-store');
const { createSchoolProfileView, PROTOCOL_FAMILY } = require('../../../lib/profiles/schema/school-profile-schema');
const { protectWindowsFileOwnerOnly, verifyWindowsFileOwnerOnly } = require('../../../lib/platform/storage/windows-private-file');

const DESKTOP = path.resolve(__dirname, '..', '..', '..');
const PROFILE_KEY = `profile-${'11'.repeat(16)}`;
const ACCOUNT_KEY = `account-${'22'.repeat(16)}`;
const WORKSPACE_KEY = `workspace-${'33'.repeat(16)}`;

function root(t) {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-candidate-directory-'));
  fs.chmodSync(value, 0o700);
  t.after(() => fs.rmSync(value, { recursive: true, force: true }));
  return value;
}

function writeJson(file, value) {
  const existed = fs.existsSync(file);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  if (process.platform === 'win32' && !existed) {
    assert.equal(protectWindowsFileOwnerOnly(file), true);
    assert.equal(verifyWindowsFileOwnerOnly(file), true);
  }
}

function reviewedAuthority(userData) {
  const layout = createProfileAccountWorkspaceLayout({
    userData,
    profileKey: PROFILE_KEY,
    accountKey: ACCOUNT_KEY,
    workspaceKey: WORKSPACE_KEY,
    adoptLegacyHkustBrowserPartition: true,
  });
  const createdAt = 1_700_000_000_000;
  writeJson(layout.profile.settings, {
    schemaVersion: 1, profileId: 'hkustgz', profileRevision: 1,
    primaryAccountKey: ACCOUNT_KEY,
  });
  writeJson(layout.profile.state, {
    schemaVersion: 1, migrationId: `migration-${'44'.repeat(16)}`,
    profileId: 'hkustgz', profileRevision: 1, profileCredentialBindingRevision: 1,
    gatewayOrigin: 'https://remote.hkust-gz.edu.cn', protocolFamily: PROTOCOL_FAMILY,
  });
  writeJson(layout.account.document, {
    schemaVersion: 1, accountKey: ACCOUNT_KEY, accountRevision: 1,
    accountCredentialRevision: 1, role: 'primary', state: 'enabled', profileId: 'hkustgz',
    profileRevision: 1, gatewayOrigin: 'https://remote.hkust-gz.edu.cn',
    protocolFamily: PROTOCOL_FAMILY, workspaceKey: WORKSPACE_KEY,
    activeCredentialVersion: null, createdAt, updatedAt: createdAt,
  });
  writeJson(layout.workspace.state, {
    schemaVersion: 1, profileId: 'hkustgz', profileRevision: 1,
    accountKey: ACCOUNT_KEY, accountRevision: 1, workspaceKey: WORKSPACE_KEY,
    activeContextEpoch: 2,
  });
  writeJson(layout.workspace.settings, {
    schemaVersion: 1, autoReconnect: true, maxAttempts: 3, autoConnect: false,
    routeDomains: ['hkust-gz.edu.cn', 'hkust.edu.hk'],
  });
  writeJson(layout.workspace.localResources, { schemaVersion: 1, resources: [] });
  return { layout, createdAt };
}

function secondReviewedFixture(userData) {
  const projectRoot = path.join(userData, 'synthetic-reviewed-project');
  const desktopDir = path.join(projectRoot, 'desktop');
  const configDir = path.join(projectRoot, 'independent', 'config');
  fs.mkdirSync(desktopDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const sourceProfile = JSON.parse(fs.readFileSync(
    path.join(DESKTOP, 'assets', 'profiles', 'hkustgz', 'school-profile.json'),
    'utf8',
  ));
  const sourceConfig = JSON.parse(fs.readFileSync(
    path.join(DESKTOP, '..', 'independent', 'config', 'hkustgz.json'),
    'utf8',
  ));
  const exampleProfile = structuredClone(sourceProfile);
  exampleProfile.profileId = 'example-university';
  exampleProfile.branding.localizedSchoolName = { zh: '示例大学', en: 'Example University' };
  exampleProfile.branding.shortName = 'Example';
  exampleProfile.branding.bundledAssetKey = 'example-logo';
  exampleProfile.gateway.origin = 'https://vpn.example.edu';
  exampleProfile.gateway.engineConfigRef = 'example-university-engine-config';
  exampleProfile.browser.homeUrl = 'https://www.example.edu/';
  exampleProfile.browser.campusDomains = ['example.edu'];
  exampleProfile.browser.directPartnerDomains = [];
  exampleProfile.browser.builtinResourcesRef = 'example-resources';
  exampleProfile.browser.healthTargets = [
    { host: 'www.example.edu', port: 443 },
    { host: 'library.example.edu', port: 443 },
  ];
  exampleProfile.policy.reviewedDnsFallback = [];
  const exampleConfig = { ...sourceConfig, base_url: 'https://vpn.example.edu', dns_fallback: [] };
  const configs = new Map([
    ['hkustgz', Buffer.from(`${JSON.stringify(sourceConfig, null, 2)}\n`)],
    ['example-university', Buffer.from(`${JSON.stringify(exampleConfig, null, 2)}\n`)],
  ]);
  for (const [profileId, data] of configs) {
    fs.writeFileSync(path.join(configDir, `${profileId}.json`), data, { mode: 0o600 });
  }
  const profiles = new Map([
    ['hkustgz', sourceProfile],
    ['example-university', exampleProfile],
  ]);
  const packagedRegistry = {
    withProfileDocument(profileId, callback) {
      if (!profiles.has(profileId)) throw new Error('school profile is not present');
      return callback(profiles.get(profileId));
    },
    createView(profileId, options) {
      return createSchoolProfileView(profiles.get(profileId), options);
    },
    resolveAsset(profileId, key, kind) {
      const data = configs.get(profileId);
      if (!data || kind !== 'engine-config' ||
          key !== profiles.get(profileId).gateway.engineConfigRef) throw new Error('asset unavailable');
      return { key, kind, path: `synthetic/${profileId}.json`,
        sha256: crypto.createHash('sha256').update(data).digest('hex') };
    },
    readAsset(profileId) { return Buffer.from(configs.get(profileId)); },
    getBuiltinResources() { return Object.freeze([]); },
  };
  return { desktopDir, exampleProfile, packagedRegistry };
}

function secondReviewedAuthority(userData, profile) {
  const profileKey = `profile-${'66'.repeat(16)}`;
  const accountKey = `account-${'77'.repeat(16)}`;
  const workspaceKey = `workspace-${'88'.repeat(16)}`;
  const layout = createProfileAccountWorkspaceLayout({
    userData, profileKey, accountKey, workspaceKey, adoptLegacyHkustBrowserPartition: false,
  });
  const createdAt = 1_700_000_000_500;
  writeJson(layout.profile.settings, {
    schemaVersion: 1, profileId: profile.profileId, profileRevision: 1,
    primaryAccountKey: accountKey,
  });
  writeJson(layout.profile.state, {
    schemaVersion: 1, migrationId: `migration-${'99'.repeat(16)}`,
    profileId: profile.profileId, profileRevision: 1, profileCredentialBindingRevision: 1,
    gatewayOrigin: 'https://vpn.example.edu', protocolFamily: PROTOCOL_FAMILY,
  });
  writeJson(layout.account.document, {
    schemaVersion: 1, accountKey, accountRevision: 1, accountCredentialRevision: 1,
    role: 'primary', state: 'enabled', profileId: profile.profileId, profileRevision: 1,
    gatewayOrigin: 'https://vpn.example.edu', protocolFamily: PROTOCOL_FAMILY, workspaceKey,
    activeCredentialVersion: null, createdAt, updatedAt: createdAt,
  });
  writeJson(layout.workspace.state, {
    schemaVersion: 1, profileId: profile.profileId, profileRevision: 1,
    accountKey, accountRevision: 1, workspaceKey, activeContextEpoch: 1,
  });
  writeJson(layout.workspace.settings, {
    schemaVersion: 1, autoReconnect: true, maxAttempts: 3, autoConnect: false,
    routeDomains: ['example.edu'],
  });
  writeJson(layout.workspace.localResources, { schemaVersion: 1, resources: [] });
  return { accountKey, layout, profileKey };
}

function provisionCustom(userData) {
  let seed = 1;
  const owner = new CustomGatewayConfirmationOwner({
    randomBytes: (length) => Buffer.alloc(length, seed++),
    now: () => 1_800_000_000_000,
    ttlMs: 10_000,
  });
  const context = {
    profileId: 'hkustgz', profileRevision: 1,
    accountHandle: `account-${'a'.repeat(36)}`, activeContextEpoch: 2,
  };
  const view = owner.issue({
    probeResult: {
      schema_version: 1, normalized_origin: 'https://vpn.example.edu',
      https_identity_valid: true, compatibility: 'recognized_candidate',
      candidate_family: PROTOCOL_FAMILY, reported_version: 'M7.6.8R2', http_status: 200,
    },
    activeContext: context,
  });
  const confirmation = owner.consume({ confirmationHandle: view.confirmationHandle,
    activeContext: context });
  let provisionSeed = 60;
  return new CustomProfileProvisioningRuntime({
    userData,
    randomBytes: (length) => Buffer.alloc(length, ++provisionSeed),
    now: () => 1_800_000_000_100,
  }).begin(confirmation);
}

function directory(userData) {
  return new ProfileCandidateDirectory({
    userData,
    packageRoot: DESKTOP,
    desktopDir: DESKTOP,
    isPackaged: false,
  });
}

test('reviewed anchor and custom index form one restart-safe candidate directory', (t) => {
  const userData = root(t);
  const reviewed = reviewedAuthority(userData);
  const custom = provisionCustom(userData);
  const candidates = directory(userData);
  const anchored = candidates.anchorReviewedCurrent({
    profileId: 'hkustgz', profileKey: PROFILE_KEY, accountKey: ACCOUNT_KEY,
  });
  assert.equal(anchored.authority.account.createdAt, reviewed.createdAt);
  assert.equal(candidates.anchorReviewedCurrent({
    profileId: 'hkustgz', profileKey: PROFILE_KEY, accountKey: ACCOUNT_KEY,
  }).context.profileKey, PROFILE_KEY);

  const views = candidates.listViews({ locale: 'zh' });
  assert.deepEqual(views.map((view) => view.profileId), ['hkustgz', custom.profileId]);
  assert.equal(views[0].sanitizedCompatibility, 'reviewed');
  assert.equal(views[1].unverified, true);
  const encoded = JSON.stringify(views);
  for (const forbidden of [PROFILE_KEY, ACCOUNT_KEY, WORKSPACE_KEY, 'engine-config.json']) {
    assert.equal(encoded.includes(forbidden), false, forbidden);
  }

  candidates.withCandidate('hkustgz', (record) => {
    assert.equal(record.kind, 'builtin-reviewed');
    assert.equal(record.context.profileKey, PROFILE_KEY);
    assert.equal(record.authority.layout.browserPartition, 'persist:hkustgz-campus-browser');
    assert.equal(JSON.parse(record.engineLaunchBinding.stdinFrame).profileId, 'hkustgz');
  });
  candidates.withCandidate(custom.profileId, (record) => {
    assert.equal(record.kind, 'custom-local');
    assert.deepEqual(record.context, custom.context);
    assert.deepEqual(record.builtInResources, []);
    assert.equal(record.serviceDesk, null);
    assert.equal(JSON.parse(record.engineLaunchBinding.stdinFrame).profileId, custom.profileId);
  });

  const customController = createSchoolProfileControllerFromCandidate({
    directory: candidates,
    profileId: custom.profileId,
    randomBytes: (length) => Buffer.alloc(length, 7),
  });
  assert.equal(customController.browserHomeUrl, null);
  assert.deepEqual(customController.defaultRouteDomains, []);
  assert.deepEqual(customController.mergeResourceLibrary(), []);
  assert.equal(customController.serviceDesk, null);
  assert.equal(customController.builtInResourceCount, 0);
  assert.equal(customController.browserPartition.startsWith('persist:campus-workspace-'), true);
  assert.equal(customController.activeContextBinding().activeContextEpoch, 1);
  assert.equal(JSON.parse(customController.verifyEngineLaunchBinding().stdinFrame).profileId,
    custom.profileId);
  assert.equal(customController.createPresentation({ locale: 'en' }).schoolProfile.unverified, true);

  const reviewedController = createSchoolProfileControllerFromCandidate({
    directory: candidates,
    profileId: 'hkustgz',
    randomBytes: (length) => Buffer.alloc(length, 8),
  });
  assert.equal(reviewedController.browserPartition, 'persist:hkustgz-campus-browser');
  assert.equal(reviewedController.builtInResourceCount > 0, true);
  assert.equal(reviewedController.serviceDesk.applications.length >= 12, true);
  assert.equal(reviewedController.serviceDesk.serviceItems.length >= 12, true);
  assert.equal(customController.serviceDesk, null);

  const restarted = directory(userData);
  assert.deepEqual(restarted.listViews({ locale: 'en' }).map((view) => view.profileId),
    ['hkustgz', custom.profileId]);
});

test('reviewed anchor is additive immutable owner-only and link-free', {
  skip: process.platform === 'win32',
}, (t) => {
  const userData = root(t);
  const store = new ReviewedProfileAnchorStore({ userData });
  const value = {
    profileId: 'hkustgz', profileKey: PROFILE_KEY, accountKey: ACCOUNT_KEY,
    createdAt: 1_700_000_000_000,
  };
  assert.equal(store.ensure(value), true);
  assert.equal(store.ensure(value), false);
  assert.deepEqual(store.get('hkustgz'), value);
  assert.equal(fs.lstatSync(store.filePath).mode & 0o077, 0);
  assert.throws(() => store.ensure({ ...value, accountKey: `account-${'55'.repeat(16)}` }),
    /identity changed/u);

  fs.unlinkSync(store.filePath);
  const outside = path.join(userData, 'outside-anchor.json');
  fs.writeFileSync(outside, '{"schemaVersion":1,"entries":[]}\n', { mode: 0o600 });
  fs.symlinkSync(outside, store.filePath);
  assert.throws(() => store.read(), /private file/u);
});

test('candidate directory rejects wrong reviewed keys and unknown Profile IDs', (t) => {
  const userData = root(t);
  reviewedAuthority(userData);
  const candidates = directory(userData);
  assert.throws(() => candidates.anchorReviewedCurrent({
    profileId: 'hkustgz', profileKey: PROFILE_KEY, accountKey: `account-${'55'.repeat(16)}`,
  }), /unavailable|could not be read/u);
  assert.throws(() => candidates.withCandidate('custom-missing', () => true), /unavailable/u);
  assert.throws(() => candidates.withCandidate('hkustgz', () => true), /unavailable/u,
    'a packaged Profile is not switchable until its exact local authority is anchored');
});

test('second synthetic reviewed Profile switches without inheriting HKUST workspace state', async (t) => {
  const userData = root(t);
  const hkust = reviewedAuthority(userData);
  const second = secondReviewedFixture(userData);
  const example = secondReviewedAuthority(userData, second.exampleProfile);
  writeJson(path.join(userData, 'global', 'settings.json'), {
    schemaVersion: 1,
    activeProfileKey: PROFILE_KEY,
    activeAccountKey: ACCOUNT_KEY,
    port: 6180,
    strictProxyAuth: true,
    proxySecurityVersion: 3,
    proxyAuthMigrationPending: false,
    closeAction: 'minimize',
    language: 'en',
    startAtLogin: false,
  });
  const candidates = new ProfileCandidateDirectory({
    userData,
    packageRoot: DESKTOP,
    desktopDir: second.desktopDir,
    isPackaged: false,
    packagedRegistry: second.packagedRegistry,
  });
  const hkustRecord = candidates.anchorReviewedCurrent({
    profileId: 'hkustgz', profileKey: PROFILE_KEY, accountKey: ACCOUNT_KEY,
  });
  const exampleRecord = candidates.anchorReviewedCurrent({
    profileId: 'example-university',
    profileKey: example.profileKey,
    accountKey: example.accountKey,
  });
  assert.notEqual(hkustRecord.context.profileKey, exampleRecord.context.profileKey);
  assert.notEqual(hkustRecord.authority.layout.browserPartition,
    exampleRecord.authority.layout.browserPartition);
  assert.equal(hkustRecord.authority.layout.browserPartition, 'persist:hkustgz-campus-browser');
  assert.equal(exampleRecord.authority.layout.browserPartition.startsWith('persist:campus-workspace-'), true);
  assert.deepEqual(hkustRecord.authority.workspaceSettings.routeDomains,
    ['hkust-gz.edu.cn', 'hkust.edu.hk']);
  assert.deepEqual(exampleRecord.authority.workspaceSettings.routeDomains, ['example.edu']);
  assert.equal(exampleRecord.authority.workspaceSettings.routeDomains.includes('hkust-gz.edu.cn'), false);
  assert.deepEqual(candidates.listViews({ locale: 'en' }).map(({ profileId, unverified }) => (
    { profileId, unverified }
  )), [
    { profileId: 'hkustgz', unverified: false },
    { profileId: 'example-university', unverified: false },
  ]);

  let active = hkustRecord.context;
  const journalStore = new ActiveContextSwitchJournalStore({
    filePath: path.join(userData, 'global', 'active-context-switch.json'),
  });
  const switching = new ProfileSwitchRuntime({
    directory: candidates,
    journalStore,
    activationStore: new ActiveContextActivationStore({ userData }),
    barrier: new ActiveContextSwitchBarrier({
      invalidateContext: () => {},
      suspendBrowser: async () => {},
      browserBoundaryClosed: () => true,
      cancelAuth: () => {},
      cancelConnectivity: () => {},
      cancelMutations: async () => true,
      closeBrowser: async () => {},
      browserClosed: () => true,
      stopEngine: async () => ({ ok: true, cleanExit: true }),
      revokeProxyAccess: async () => true,
      clearServerState: async () => true,
    }),
    getActivePersistentContext: () => active,
    getEngineGeneration: () => null,
    activateRuntime: (record) => { active = record.context; return true; },
  });
  for (let round = 0; round < 12; round += 1) {
    const target = active.profileId === 'hkustgz' ? 'example-university' : 'hkustgz';
    assert.equal((await switching.switchTo(target)).status, 'activated');
    assert.equal(active.profileId, target);
    assert.equal(journalStore.read(), null);
  }
  assert.equal(active.profileId, 'hkustgz');
  assert.equal(new ReviewedProfileAnchorStore({ userData }).read().entries.length, 2);
  assert.notEqual(hkust.layout.profile.root, example.layout.profile.root);
});

test('real P4 authority alternates reviewed and custom Profiles without residue', async (t) => {
  const userData = root(t);
  reviewedAuthority(userData);
  const custom = provisionCustom(userData);
  writeJson(path.join(userData, 'global', 'settings.json'), {
    schemaVersion: 1,
    activeProfileKey: PROFILE_KEY,
    activeAccountKey: ACCOUNT_KEY,
    port: 6180,
    strictProxyAuth: true,
    proxySecurityVersion: 3,
    proxyAuthMigrationPending: false,
    closeAction: 'minimize',
    language: 'en',
    startAtLogin: false,
  });
  const candidates = directory(userData);
  const reviewed = candidates.anchorReviewedCurrent({
    profileId: 'hkustgz', profileKey: PROFILE_KEY, accountKey: ACCOUNT_KEY,
  });
  let active = reviewed.context;
  const journalStore = new ActiveContextSwitchJournalStore({
    filePath: path.join(userData, 'global', 'active-context-switch.json'),
  });
  const activationStore = new ActiveContextActivationStore({ userData });
  const barrier = new ActiveContextSwitchBarrier({
    invalidateContext: () => {},
    suspendBrowser: async () => {},
    browserBoundaryClosed: () => true,
    cancelAuth: () => {},
    cancelConnectivity: () => {},
    cancelMutations: async () => true,
    closeBrowser: async () => {},
    browserClosed: () => true,
    stopEngine: async () => ({ ok: true, cleanExit: true }),
    revokeProxyAccess: async () => true,
    clearServerState: async () => true,
  });
  const switching = new ProfileSwitchRuntime({
    directory: candidates,
    journalStore,
    activationStore,
    barrier,
    getActivePersistentContext: () => active,
    getEngineGeneration: () => null,
    activateRuntime: (record) => { active = record.context; return true; },
  });

  for (let round = 0; round < 20; round += 1) {
    const target = active.profileId === 'hkustgz' ? custom.profileId : 'hkustgz';
    const result = await switching.switchTo(target);
    assert.equal(result.status, 'activated');
    assert.equal(active.profileId, target);
    assert.equal(journalStore.read(), null);
    const global = JSON.parse(fs.readFileSync(path.join(userData, 'global', 'settings.json')));
    assert.equal(global.activeProfileKey, active.profileKey);
    assert.equal(global.activeAccountKey, active.accountKey);
  }
  assert.equal(active.activeContextEpoch, 22);
  assert.equal(candidates.listViews({ locale: 'en' }).length, 2);
  assert.equal(new ReviewedProfileAnchorStore({ userData }).read().entries.length, 1);
});
