'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  PROFILE_SCHEMA_VERSION,
  PROTOCOL_FAMILY,
  createCampusAccountView,
  createCapabilitySnapshot,
  createLegacyPrimaryAccountView,
  createLegacyWorkspaceView,
  createSchoolProfileView,
  createWorkspaceView,
  normalizeGatewayOrigin,
  validateProtocolFamily,
  validateCampusAccountDocument,
  validateSchoolProfileDocument,
  validateWorkspaceScopeDocument,
} = require('../../../lib/profiles/schema/school-profile-schema');

const ACCOUNT_KEY = 'account_7p4m2x9c6v8n3k5j1q0w';
const WORKSPACE_KEY = 'workspace_4c8m2v7n5x9k3q1p6j0w';
const ACCOUNT_HANDLE = 'handle_4m7x2n9c5v8k';

function reviewedProfile(overrides = {}) {
  const base = {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    profileId: 'hkustgz',
    profileRevision: 1,
    profileCredentialBindingRevision: 1,
    evidenceClass: 'builtin-reviewed',
    branding: {
      localizedSchoolName: {
        zh: '香港科技大学（广州）',
        en: 'The Hong Kong University of Science and Technology (Guangzhou)',
      },
      shortName: 'HKUST(GZ)',
      bundledAssetKey: 'hkustgz-logo',
      theme: { accent: '#c59b32', surface: '#ffffff' },
    },
    gateway: {
      origin: 'https://REMOTE.HKUST-GZ.EDU.CN:443/',
      protocolFamily: PROTOCOL_FAMILY,
      engineConfigRef: 'hkustgz/engine-config.json',
    },
    browser: {
      homeUrl: 'https://www.hkust-gz.edu.cn/',
      officialPortalResourceId: 'official-portal',
      campusDomains: ['hkust-gz.edu.cn', 'hkust.edu.hk'],
      directPartnerDomains: ['office.com', 'instructure.com'],
      builtinResourcesRef: 'hkustgz-builtin-resources',
      healthTargets: [
        { host: 'www.hkust-gz.edu.cn', port: 443 },
        { host: 'library.hkust-gz.edu.cn', port: 443 },
      ],
    },
    policy: {
      reviewedPrivateGatewayAllowed: false,
      reviewedDnsFallback: ['10.90.63.2', '10.90.63.3'],
    },
  };
  return { ...base, ...overrides };
}

test('normalizes one reviewed profile without I/O or runtime wiring', () => {
  const profile = validateSchoolProfileDocument(reviewedProfile());
  assert.equal(profile.gateway.origin.origin, 'https://remote.hkust-gz.edu.cn');
  assert.equal(profile.gateway.origin.port, 443);
  assert.equal(profile.browser.builtinResourcesRef, 'hkustgz-builtin-resources');
  assert.equal(profile.browser.officialPortalResourceId, 'official-portal');
  assert.equal(Object.isFrozen(profile), true);
  assert.equal(Object.isFrozen(profile.browser), true);
});

test('GatewayOrigin is HTTPS, root-only, credential-free and canonical', () => {
  assert.deepEqual(normalizeGatewayOrigin('https://Example.EDU.:444/'), {
    scheme: 'https', hostname: 'example.edu', port: 444, origin: 'https://example.edu:444',
  });
  assert.deepEqual(normalizeGatewayOrigin('https://[2001:db8::1]:443/'), {
    scheme: 'https', hostname: '[2001:db8::1]', port: 443, origin: 'https://[2001:db8::1]',
  });
  for (const invalid of [
    'http://vpn.example.edu/',
    'https://user:secret@vpn.example.edu/',
    'https://vpn.example.edu/path',
    'https://vpn.example.edu/?query=1',
    'https://vpn.example.edu/#fragment',
    'https://vpn.example.edu/?',
    'not a URL',
  ]) assert.throws(() => normalizeGatewayOrigin(invalid), /Gateway/);
});

test('ProtocolFamily is a closed compiled selection', () => {
  assert.equal(validateProtocolFamily(PROTOCOL_FAMILY), PROTOCOL_FAMILY);
  assert.throws(() => validateProtocolFamily('easyconnect-auto'), /unsupported/);
  assert.throws(() => validateProtocolFamily('atrust'), /unsupported/);
});

test('profile rejects invalid ids, paths, assets, protocol and unknown fields', () => {
  assert.throws(() => validateSchoolProfileDocument(reviewedProfile({ profileId: '../school' })),
    /profileId/);
  assert.throws(() => validateSchoolProfileDocument(reviewedProfile({
    gateway: { ...reviewedProfile().gateway, engineConfigRef: '../private.json' },
  })), /packaged reference/);
  assert.throws(() => validateSchoolProfileDocument(reviewedProfile({
    branding: { ...reviewedProfile().branding, bundledAssetKey: '../logo.svg' },
  })), /bundledAssetKey/);
  assert.throws(() => validateSchoolProfileDocument(reviewedProfile({
    gateway: { ...reviewedProfile().gateway, protocolFamily: 'unknown-family' },
  })), /unsupported/);
  assert.throws(() => validateSchoolProfileDocument({ ...reviewedProfile(), token: 'private' }),
    /schema/);
  assert.throws(() => validateSchoolProfileDocument(reviewedProfile({
    branding: { ...reviewedProfile().branding, script: 'alert(1)' },
  })), /schema/);
});

test('profile enforces bounds and exact nested schemas', () => {
  assert.throws(() => validateSchoolProfileDocument(reviewedProfile({
    profileRevision: 0,
  })), /positive/);
  assert.throws(() => validateSchoolProfileDocument(reviewedProfile({
    browser: { ...reviewedProfile().browser, campusDomains: Array(65).fill('example.edu') },
  })), /bounded/);
  assert.throws(() => validateSchoolProfileDocument(reviewedProfile({
    browser: { ...reviewedProfile().browser, builtinResourcesRef: '../resources.json' },
  })), /builtinResourcesRef/u);
  assert.throws(() => validateSchoolProfileDocument(reviewedProfile({
    browser: {
      ...reviewedProfile().browser,
      builtinResources: [],
    },
  })), /schema/u);
  assert.throws(() => validateSchoolProfileDocument(reviewedProfile({
    browser: {
      ...reviewedProfile().browser,
      healthTargets: [{ host: 'www.example.edu', port: 443, secret: true }],
    },
  })), /schema/);
  assert.throws(() => validateSchoolProfileDocument(reviewedProfile({
    policy: { reviewedPrivateGatewayAllowed: false, reviewedDnsFallback: ['not-an-ip'] },
  })), /IPv4/);
});

test('custom-local profile cannot inherit reviewed assets, DNS, routes or proactive URLs', () => {
  const source = reviewedProfile({
    profileId: 'custom-a',
    evidenceClass: 'custom-local',
    branding: {
      localizedSchoolName: { zh: '自定义组织', en: 'Custom organization' },
      shortName: 'Custom', bundledAssetKey: null, theme: null,
    },
    gateway: {
      origin: 'https://vpn.example.edu/', protocolFamily: PROTOCOL_FAMILY,
      engineConfigRef: null,
    },
    browser: {
      homeUrl: null, officialPortalResourceId: null, campusDomains: [], directPartnerDomains: [],
      builtinResourcesRef: null, healthTargets: [],
    },
    policy: { reviewedPrivateGatewayAllowed: false, reviewedDnsFallback: [] },
  });
  assert.equal(validateSchoolProfileDocument(source).evidenceClass, 'custom-local');
  assert.throws(() => validateSchoolProfileDocument({
    ...source,
    browser: { ...source.browser, homeUrl: 'https://school.example.edu/' },
  }), /minimal/);
  assert.equal(validateSchoolProfileDocument({
    ...source,
    gateway: { ...source.gateway, origin: 'https://192.0.2.10/' },
  }).gateway.origin.origin, 'https://192.0.2.10');
  // Address reachability/scope is enforced by the credential-free native
  // connector before confirmation, not by this document shape validator.
});

test('SchoolProfileView redacts config, DNS, health and provider internals', () => {
  const view = createSchoolProfileView(reviewedProfile(), { locale: 'zh', compatibility: 'reviewed' });
  assert.deepEqual(Object.keys(view).sort(), [
    'bundledAssetKey', 'evidenceClass', 'normalizedGatewayOrigin', 'profileId',
    'profileRevision', 'sanitizedCompatibility', 'schemaVersion', 'schoolName', 'shortName',
    'unverified', 'officialPortalResourceId',
  ].sort());
  assert.equal(view.officialPortalResourceId, 'official-portal');
  assert.equal(view.schoolName, '香港科技大学（广州）');
  const encoded = JSON.stringify(view);
  for (const privateValue of ['10.90.63.2', 'engine-config.json', 'healthTargets', 'protocolFamily']) {
    assert.equal(encoded.includes(privateValue), false);
  }
});

test('legacy account and workspace placeholders contain no persistent key or username', () => {
  const account = createLegacyPrimaryAccountView({
    label: '当前账号', hasCredential: true, isActive: true,
  });
  const workspace = createLegacyWorkspaceView({ resourceCount: 6 });
  assert.equal(account.kind, 'legacy-primary');
  assert.equal(workspace.persistentScope, false);
  for (const value of [account, workspace]) {
    assert.equal('accountKey' in value, false);
    assert.equal('workspaceKey' in value, false);
    assert.equal('username' in value, false);
    assert.equal('password' in value, false);
  }
  assert.throws(() => createLegacyPrimaryAccountView({ accountKey: 'persistent' }), /schema/);
});

test('CampusAccount and WorkspaceScope schemas bind immutable profile identity without I/O', () => {
  const account = validateCampusAccountDocument({
    schemaVersion: 1,
    accountKey: ACCOUNT_KEY,
    accountRevision: 2,
    accountCredentialRevision: 3,
    role: 'primary',
    state: 'enabled',
    profileId: 'hkustgz',
    profileRevision: 1,
    gatewayOrigin: 'https://remote.hkust-gz.edu.cn/',
    protocolFamily: PROTOCOL_FAMILY,
    workspaceKey: WORKSPACE_KEY,
    activeCredentialVersion: null,
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_100,
  });
  const workspace = validateWorkspaceScopeDocument({
    schemaVersion: 1,
    profileId: 'hkustgz',
    profileRevision: 1,
    accountKey: ACCOUNT_KEY,
    accountRevision: 2,
    workspaceKey: WORKSPACE_KEY,
    activeContextEpoch: 4,
  }, { account });
  assert.equal(account.gatewayOrigin.origin, 'https://remote.hkust-gz.edu.cn');
  assert.equal(workspace.accountKey, ACCOUNT_KEY);
  assert.equal(Object.isFrozen(account), true);
  assert.equal(Object.isFrozen(workspace), true);
});

test('account/workspace schemas reject user-derived paths, drift and unknown authority', () => {
  const base = {
    schemaVersion: 1,
    accountKey: ACCOUNT_KEY,
    accountRevision: 1,
    accountCredentialRevision: 1,
    role: 'primary',
    state: 'enabled',
    profileId: 'hkustgz',
    profileRevision: 1,
    gatewayOrigin: 'https://remote.hkust-gz.edu.cn/',
    protocolFamily: PROTOCOL_FAMILY,
    workspaceKey: WORKSPACE_KEY,
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_000,
  };
  assert.throws(() => validateCampusAccountDocument({ ...base, accountKey: '../student' }),
    /opaque key/u);
  assert.throws(() => validateCampusAccountDocument({ ...base, username: 'student' }), /schema/u);
  assert.throws(() => validateCampusAccountDocument({ ...base, role: 'secondary' }), /unsupported/u);
  assert.throws(() => validateCampusAccountDocument({
    ...base,
    gatewayOrigin: 'https://other.example.edu/',
    protocolFamily: 'unknown-family',
  }), /unsupported/u);
  assert.throws(() => validateWorkspaceScopeDocument({
    schemaVersion: 1,
    profileId: 'hkustgz',
    profileRevision: 1,
    accountKey: ACCOUNT_KEY,
    accountRevision: 99,
    workspaceKey: WORKSPACE_KEY,
    activeContextEpoch: 1,
  }, { account: base }), /does not match/u);
});

test('bounded account/workspace views expose handles but never persistent keys', () => {
  const account = createCampusAccountView({
    accountHandle: ACCOUNT_HANDLE,
    role: 'primary',
    state: 'enabled',
    label: 'Primary',
    hasCredential: true,
    isActive: true,
  });
  const workspace = createWorkspaceView({
    accountHandle: ACCOUNT_HANDLE,
    resourceCount: 6,
    favoriteCount: 2,
    recentCount: 3,
  });
  assert.equal(account.accountHandle, ACCOUNT_HANDLE);
  assert.equal(workspace.persistentScope, true);
  for (const value of [account, workspace]) {
    assert.equal('accountKey' in value, false);
    assert.equal('workspaceKey' in value, false);
    assert.equal('username' in value, false);
  }
});

test('capability intersection cannot be elevated by profile or ingress claims', () => {
  const snapshot = createCapabilitySnapshot({
    profileId: 'hkustgz',
    profileRevision: 1,
    accountHandle: 'ephemeral-account-handle',
    activeContextEpoch: 7,
    engineGeneration: 9,
    compiled: {
      'auth.password': 'supported',
      'auth.sms': 'supported',
      'transport.l3': 'supported',
    },
    provider: {
      'auth.password': 'supported',
      'auth.sms': 'unsupported',
      'transport.l3': 'supported',
    },
    profile: {
      'auth.password': 'supported',
      'auth.sms': 'supported',
      'transport.l3': 'unavailable',
    },
    ingress: {
      'auth.password': 'supported',
      'auth.sms': 'supported',
      'transport.l3': 'supported',
    },
  });
  assert.deepEqual(snapshot.effective, {
    'auth.password': 'supported',
    'auth.sms': 'unsupported',
    'transport.l3': 'unavailable',
  });
  assert.equal('accountKey' in snapshot, false);
  assert.equal(Object.isFrozen(snapshot.effective), true);
});

test('capability snapshot rejects unknown fields, shape mismatches and unbounded names', () => {
  const base = {
    profileId: 'hkustgz', profileRevision: 1,
    compiled: { 'auth.password': 'supported' },
    provider: { 'auth.password': 'supported' },
    profile: { 'auth.password': 'supported' },
    ingress: { 'auth.password': 'supported' },
  };
  assert.throws(() => createCapabilitySnapshot({ ...base, cookie: 'private' }), /schema/);
  assert.throws(() => createCapabilitySnapshot({
    ...base, profile: { 'auth.password': 'supported', 'auth.sms': 'supported' },
  }), /same capabilities/);
  assert.throws(() => createCapabilitySnapshot({
    ...base, provider: { 'bad capability': 'supported' },
  }), /invalid capability|same capabilities/);
});
