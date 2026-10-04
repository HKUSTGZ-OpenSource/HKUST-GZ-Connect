'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { createSchoolProfileController, createSharedPortalCredentialProvider } = require('../../../lib/profiles/runtime/school-profile-controller');

const desktopRoot = path.resolve(__dirname, '..', '..', '..');

function controller(options = {}) {
  return createSchoolProfileController({
    packageRoot: desktopRoot,
    desktopDir: desktopRoot,
    ...options,
  });
}

test('composes the reviewed HKUST deployment without persistent account scope', () => {
  const profile = controller();
  assert.equal(profile.gatewayHost, 'remote.hkust-gz.edu.cn');
  assert.equal(profile.gatewayPort, 443);
  assert.deepEqual(profile.defaultRouteDomains, ['hkust-gz.edu.cn', 'hkust.edu.hk']);
  assert.equal(profile.mergeResources().length, profile.builtInResourceCount);
  assert.deepEqual(profile.projectResources().receipt, {
    sourceCount: profile.builtInResourceCount,
    visibleCount: profile.builtInResourceCount,
    conflictCount: 0,
    hiddenCount: 0,
  });
  const binding = profile.verifyEngineLaunchBinding();
  assert.equal(
    binding.path,
    path.join(desktopRoot, '..', 'independent', 'config', 'hkustgz.json'),
  );
  assert.deepEqual(JSON.parse(binding.stdinFrame), {
    type: 'engine_config_binding',
    apiVersion: 1,
    configSha256: 'ed7d9d3dee309124b35f9b9921c83df4947d9c919fc009ab2b8b9b3b0457e1db',
    gatewayOrigin: 'https://remote.hkust-gz.edu.cn',
    profileId: 'hkustgz',
    profileRevision: 1,
    protocolFamily: 'easyconnect-password-modern-l3-v1',
  });

  const presentation = profile.createPresentation();
  assert.equal(presentation.schoolProfile.profileId, 'hkustgz');
  assert.equal(presentation.schoolProfile.schoolName, '香港科技大学(广州)');
  assert.equal(presentation.campusAccount.kind, 'legacy-primary');
  assert.match(presentation.campusAccount.accountHandle, /^account-/u);
  assert.equal(
    presentation.workspace.accountHandle,
    presentation.campusAccount.accountHandle,
  );
  assert.equal(presentation.workspace.persistentScope, false);
  assert.deepEqual(profile.activeContextBinding(), {
    profileId: 'hkustgz',
    profileRevision: 1,
    accountHandle: presentation.campusAccount.accountHandle,
    activeContextEpoch: 1,
  });
  for (const forbidden of ['engineConfigRef', 'reviewedDnsFallback', 'accountKey', 'workspaceKey']) {
    assert.equal(JSON.stringify(presentation).includes(forbidden), false);
  }
});

test('provider capability reports become profile-bound key-free renderer snapshots', () => {
  const profile = controller({ randomBytes: () => Buffer.alloc(18, 7) });
  const capabilities = [
    'auth.password', 'auth.captcha', 'auth.sms', 'auth.token', 'auth.certificate',
    'auth.hid', 'auth.sso', 'auth.device', 'auth.unknown_secondary',
    'resource.catalogue', 'resource.authorization_decision', 'transport.l3',
    'transport.web_vpn',
  ];
  const layer = Object.fromEntries(capabilities.map((capability) => [
    capability,
    ['auth.password', 'transport.l3'].includes(capability) ? 'supported' : 'unsupported',
  ]));
  const snapshot = profile.createCapabilitySnapshot({
    profileId: 'hkustgz',
    profileRevision: 1,
    engineGeneration: 9,
    compiled: layer,
    provider: layer,
  });
  assert.equal(snapshot.profileId, 'hkustgz');
  assert.equal(snapshot.engineGeneration, 9);
  assert.equal(snapshot.effective['auth.password'], 'supported');
  assert.equal(snapshot.effective['transport.l3'], 'supported');
  assert.equal(snapshot.effective['auth.sms'], 'unsupported');
  assert.equal(snapshot.accountHandle, profile.createPresentation().campusAccount.accountHandle);
  for (const forbidden of ['accountKey', 'workspaceKey', 'protocolFamily', 'cookie', 'token']) {
    assert.equal(Object.hasOwn(snapshot, forbidden), false);
  }
  assert.throws(() => profile.createCapabilitySnapshot({
    profileId: 'other-school',
    profileRevision: 1,
    engineGeneration: 9,
    compiled: layer,
    provider: layer,
  }), /active profile/u);
  assert.equal(profile.observeCapabilityReport({
    profileId: 'hkustgz', profileRevision: 1, engineGeneration: 9,
    compiled: layer, provider: layer,
  }), true);
  assert.equal(profile.capabilitySnapshot().engineGeneration, 9);
  assert.equal(profile.observeCapabilityReport({
    profileId: 'other-school', profileRevision: 1, engineGeneration: 10,
    compiled: layer, provider: layer,
  }), false);
  assert.equal(profile.capabilitySnapshot().engineGeneration, 9);
  assert.equal(profile.clearCapabilitySnapshot(), true);
  assert.equal(profile.clearCapabilitySnapshot(), false);
});

test('process-lifetime account handles require exact entropy and erase the source buffer', () => {
  const entropy = Buffer.alloc(18, 7);
  const profile = controller({ randomBytes: () => entropy });
  assert.equal(
    profile.createPresentation().campusAccount.accountHandle,
    `account-${'07'.repeat(18)}`,
  );
  assert.deepEqual(entropy, Buffer.alloc(18));
  assert.throws(
    () => controller({ randomBytes: () => Buffer.alloc(17) }),
    /account handle entropy is invalid/u,
  );
  assert.throws(
    () => controller({ randomBytes: () => 'not-random-bytes' }),
    /account handle entropy is invalid/u,
  );
});

test('presentation uses an explicit locale and bounded resource count', () => {
  const presentation = controller().createPresentation({
    locale: 'en',
    hasCredential: true,
    resourceCount: 7,
  });
  assert.equal(presentation.schoolProfile.shortName, 'HKUST(GZ)');
  assert.equal(presentation.campusAccount.hasCredential, true);
  assert.equal(presentation.workspace.resourceCount, 7);
});

test('controller exposes the reviewed raw Profile only through a synchronous callback', () => {
  const profile = controller();
  const result = profile.withProfileDocument((document) => ({
    profileId: document.profileId,
    gatewayOrigin: document.gateway.origin,
    frozen: Object.isFrozen(document),
  }));
  assert.deepEqual(result, {
    profileId: 'hkustgz',
    gatewayOrigin: 'https://remote.hkust-gz.edu.cn',
    frozen: true,
  });
  assert.throws(() => profile.withProfileDocument(async () => null), /synchronous/u);
});

test('shared portal provider validates effects without reading context or credentials at construction', () => {
  let calls = 0;
  const effect = () => { calls++; throw new Error('construction must not invoke effects'); };
  assert.equal(typeof createSharedPortalCredentialProvider({ getProfileId: effect, openCredential: effect }), 'function');
  for (const options of [undefined, {}, { getProfileId: effect }, { openCredential: effect }]) {
    assert.throws(() => createSharedPortalCredentialProvider(options), TypeError);
  }
  assert.equal(calls, 0);
});

test('shared credentials require the exact reviewed origin without aliases, coercion or context reads on rejection', () => {
  let reads = 0, opens = 0;
  const provide = createSharedPortalCredentialProvider({ getProfileId: () => { reads++; return 'hkustgz'; },
    openCredential: () => { opens++; return null; } });
  for (const origin of [undefined, null, '', 'http://sso.hkust-gz.edu.cn',
    'https://sso.hkust-gz.edu.cn/', 'https://sso.hkust-gz.edu.cn:443',
    'https://SSO.hkust-gz.edu.cn', 'https://sso.hkust-gz.edu.cn/path',
    'https://sso.hkust-gz.edu.cn.example', { toString() { throw new Error('must not coerce'); } }]) {
    assert.equal(provide(origin), null);
  }
  assert.equal(reads, 0); assert.equal(opens, 0);
  assert.equal(provide('https://sso.hkust-gz.edu.cn'), null);
  assert.equal(reads, 1); assert.equal(opens, 1);
});

test('only the current exact primary Profile can open credentials; unknown/custom identities remain denied', () => {
  let profileId = 'custom-fixture', opens = 0;
  const owner = { get withStrings() { throw new Error('provider must not inspect secrets'); },
    toJSON() { throw new Error('provider must not serialize a credential owner'); } };
  const provide = createSharedPortalCredentialProvider({ getProfileId: () => profileId,
    openCredential: () => { opens++; return owner; } });
  for (const id of ['custom-fixture', 'HKUSTGZ', '', null, undefined, { profileId: 'hkustgz' }]) {
    profileId = id; assert.equal(provide('https://sso.hkust-gz.edu.cn'), null);
  }
  assert.equal(opens, 0);
  profileId = 'hkustgz'; assert.equal(provide('https://sso.hkust-gz.edu.cn'), owner);
  profileId = 'custom-fixture'; assert.equal(provide('https://sso.hkust-gz.edu.cn'), null);
  assert.equal(opens, 1, 'context is read when invoked, not retained from construction');
});

test('shared portal provider preserves context/open failure identity without permissive fallback', () => {
  const failure = new Error('synthetic context failure');
  const contextFailure = createSharedPortalCredentialProvider({ getProfileId: () => { throw failure; },
    openCredential: () => assert.fail('failed context cannot open a credential') });
  assert.equal(contextFailure('https://unknown.example'), null);
  assert.throws(() => contextFailure('https://sso.hkust-gz.edu.cn'), error => error === failure);
  const openFailure = createSharedPortalCredentialProvider({ getProfileId: () => 'hkustgz',
    openCredential: () => { throw failure; } });
  assert.throws(() => openFailure('https://sso.hkust-gz.edu.cn'), error => error === failure);
});
