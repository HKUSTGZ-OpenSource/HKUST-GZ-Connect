'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CustomGatewayConfirmationOwner,
  customProfileDocument,
} = require('../../../../lib/profiles/onboarding/custom-gateway-onboarding');
const { PROTOCOL_FAMILY } = require('../../../../lib/profiles/schema/school-profile-schema');
const { createCustomEngineConfigDocument } = require('../../../../lib/profiles/provisioning/custom-engine-config');

test('explicit leaf trust persists only for the confirmed Gateway including IP roots', () => {
  const f = fixture();
  const leafSha256 = 'ab'.repeat(32);
  const view = f.owner.issue({ probeResult: probe({ normalized_origin: 'https://8.8.8.8:4455' }),
    leafSha256, activeContext: context() });
  assert.equal(view.leafSha256, leafSha256);
  const consumed = f.owner.consume({ confirmationHandle: view.confirmationHandle, activeContext: context() });
  assert.equal(consumed.profileDocument.gateway.tlsLeafSha256, leafSha256);
  assert.deepEqual(createCustomEngineConfigDocument(consumed.profileDocument).gateway_tls,
    { origin: 'https://8.8.8.8:4455', leaf_sha256: leafSha256 });
  const ordinary = customProfileDocument({ profileId: 'custom-plain', origin: 'https://vpn.example.edu' });
  assert.equal('tlsLeafSha256' in ordinary.gateway, false);
  assert.equal('gateway_tls' in createCustomEngineConfigDocument(ordinary), false);
});

function context(overrides = {}) {
  return {
    profileId: 'hkustgz',
    profileRevision: 1,
    accountHandle: `account-${'a'.repeat(36)}`,
    activeContextEpoch: 7,
    ...overrides,
  };
}

function probe(overrides = {}) {
  return {
    schema_version: 1,
    normalized_origin: 'https://vpn.example.edu',
    https_identity_valid: true,
    compatibility: 'recognized_candidate',
    candidate_family: PROTOCOL_FAMILY,
    reported_version: 'M7.6.8R2',
    http_status: 200,
    ...overrides,
  };
}

test('observed certificate stays pending until an explicit one-use first-trust action', () => {
  const fingerprint = 'ab'.repeat(32);
  const result = probe({ schema_version: 2, https_identity_valid: false,
    certificate_requires_confirmation: true, leaf_sha256: fingerprint });
  const f = fixture();
  const view = f.owner.issue({ probeResult: result, activeContext: context() });
  assert.equal(view.requiresTrust, true);
  assert.equal(view.leafSha256, fingerprint);
  assert.throws(() => f.owner.consume({ confirmationHandle: view.confirmationHandle,
    activeContext: context() }), /explicit certificate trust/u);
  const accepted = f.owner.issue({ probeResult: result, activeContext: context() });
  const consumed = f.owner.consume({ confirmationHandle: accepted.confirmationHandle,
    activeContext: context(), trustCertificate: true });
  assert.equal(consumed.profile.gateway.tlsLeafSha256, fingerprint);
  assert.throws(() => f.owner.consume({ confirmationHandle: accepted.confirmationHandle,
    activeContext: context(), trustCertificate: true }), /unavailable or stale/u);
  for (const bad of [{ ...result, leaf_sha256: 'bad' },
    { ...result, certificate_requires_confirmation: false }, { ...result, https_identity_valid: true }]) {
    assert.throws(() => f.owner.issue({ probeResult: bad, activeContext: context() }));
  }
});

function fixture() {
  let clock = 1_800_000_000_000;
  let counter = 0;
  const owner = new CustomGatewayConfirmationOwner({
    now: () => clock,
    ttlMs: 10_000,
    randomBytes: (length) => Buffer.alloc(length, ++counter),
  });
  return { owner, advance: (value) => { clock += value; } };
}

test('one-use confirmation produces one minimal isolated custom Profile', () => {
  const f = fixture();
  const view = f.owner.issue({
    probeResult: probe(),
    schoolLabel: 'Example University',
    activeContext: context(),
  });
  assert.equal(view.normalizedOrigin, 'https://vpn.example.edu');
  assert.equal(view.candidateFamily, PROTOCOL_FAMILY);
  assert.equal(view.unverified, true);
  assert.equal('draftProfileId' in view, false);
  assert.equal('activeContext' in view, false);

  const consumed = f.owner.consume({
    confirmationHandle: view.confirmationHandle,
    activeContext: context(),
  });
  assert.match(consumed.draftProfileId, /^custom-[a-f0-9]{32}$/u);
  assert.equal(consumed.profile.evidenceClass, 'custom-local');
  assert.equal(consumed.profileDocument.gateway.origin, 'https://vpn.example.edu');
  assert.equal(consumed.profile.gateway.origin.origin, 'https://vpn.example.edu');
  assert.equal(consumed.profile.gateway.engineConfigRef, null);
  assert.deepEqual(consumed.profile.browser.campusDomains, []);
  assert.deepEqual(consumed.profile.browser.healthTargets, []);
  assert.deepEqual(consumed.profile.policy.reviewedDnsFallback, []);
  assert.equal(consumed.profile.policy.reviewedPrivateGatewayAllowed, false);
  assert.equal(f.owner.snapshot(), null);
  assert.throws(() => f.owner.consume({
    confirmationHandle: view.confirmationHandle,
    activeContext: context(),
  }), /unavailable or stale/u);
});

test('expiry context drift wrong handles and new probes invalidate authorization', () => {
  for (const mutate of [
    (f, view) => ({ confirmationHandle: `${view.confirmationHandle}-wrong`, activeContext: context() }),
    (_f, view) => ({ confirmationHandle: view.confirmationHandle,
      activeContext: context({ activeContextEpoch: 8 }) }),
    (f, view) => { f.advance(10_000); return {
      confirmationHandle: view.confirmationHandle, activeContext: context(),
    }; },
  ]) {
    const f = fixture();
    const view = f.owner.issue({ probeResult: probe(), activeContext: context() });
    assert.throws(() => f.owner.consume(mutate(f, view)), /unavailable or stale/u);
    assert.equal(f.owner.snapshot(), null);
  }

  const f = fixture();
  const first = f.owner.issue({ probeResult: probe(), activeContext: context() });
  const second = f.owner.issue({ probeResult: probe({
    normalized_origin: 'https://other.example.edu',
  }), activeContext: context() });
  assert.throws(() => f.owner.consume({
    confirmationHandle: first.confirmationHandle,
    activeContext: context(),
  }), /unavailable or stale/u);
  assert.equal(second.normalizedOrigin, 'https://other.example.edu');
});

test('only an exact recognized probe can issue a confirmation', () => {
  for (const invalid of [
    probe({ https_identity_valid: false }),
    probe({ compatibility: 'unknown', candidate_family: null }),
    probe({ candidate_family: 'atrust' }),
    probe({ normalized_origin: 'http://vpn.example.edu' }),
    probe({ http_status: 302 }),
    { ...probe(), rawBody: '<private>' },
  ]) {
    assert.throws(() => fixture().owner.issue({
      probeResult: invalid,
      activeContext: context(),
    }));
  }
});

test('custom Profile identity and policy never derive authority from the label', () => {
  const profile = customProfileDocument({
    profileId: `custom-${'1'.repeat(32)}`,
    origin: 'https://VPN.Example.EDU.:443/',
    schoolLabel: '',
  });
  assert.equal(profile.gateway.origin, 'https://vpn.example.edu');
  assert.equal(profile.branding.localizedSchoolName.zh, 'vpn.example.edu');
  assert.throws(() => customProfileDocument({
    profileId: `custom-${'2'.repeat(32)}`,
    origin: 'https://vpn.example.edu',
    schoolLabel: '<b>Official University</b>',
  }), /school label/u);
  assert.throws(() => customProfileDocument({
    profileId: 'label-derived-profile',
    origin: 'https://vpn.example.edu',
    schoolLabel: 'Label',
  }), /custom Profile identity/u);
});

test('renderer-visible confirmation contains no persistent key or probe internals', () => {
  const view = fixture().owner.issue({ probeResult: probe(), activeContext: context() });
  const encoded = JSON.stringify(view);
  for (const forbidden of [
    'profileKey', 'accountKey', 'workspaceKey', 'accountHandle', 'activeContextEpoch',
    'TwfID', 'cookie', 'token', 'rawBody',
  ]) assert.equal(encoded.includes(forbidden), false, forbidden);
});
