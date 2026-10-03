'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { CustomGatewayConfirmationOwner } = require('../../../lib/profiles/onboarding/custom-gateway-onboarding');
const { CustomProfileProvisioningRuntime } = require('../../../lib/profiles/provisioning/custom-profile-provisioning-runtime');
const { CustomSchoolProfileRegistry } = require('../../../lib/profiles/registry/custom-school-profile-registry');
const { PROTOCOL_FAMILY } = require('../../../lib/profiles/schema/school-profile-schema');
const { createPrivateStorageEffects } = require('../../../lib/platform/storage/private-file');

const profileStorageEffects = createPrivateStorageEffects({ fileSystem: fs, platform: process.platform });

function root(t) {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-school-registry-'));
  fs.chmodSync(value, 0o700);
  t.after(() => fs.rmSync(value, { recursive: true, force: true }));
  return value;
}

function provision(userData) {
  let seed = 1;
  const owner = new CustomGatewayConfirmationOwner({
    randomBytes: (length) => Buffer.alloc(length, seed++),
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
      normalized_origin: 'https://vpn.example.edu',
      https_identity_valid: true,
      compatibility: 'recognized_candidate',
      candidate_family: PROTOCOL_FAMILY,
      reported_version: 'M7.6.8R2',
      http_status: 200,
    },
    schoolLabel: 'Example University',
    activeContext: context,
  });
  const confirmation = owner.consume({
    confirmationHandle: view.confirmationHandle,
    activeContext: context,
  });
  let provisionSeed = 50;
  return new CustomProfileProvisioningRuntime({
    userData,
    profileStorageEffects,
    randomBytes: (length) => Buffer.alloc(length, ++provisionSeed),
    now: () => 1_800_000_000_100,
  }).begin(confirmation);
}

test('registry verifies one inactive custom Profile authority and exposes only a sanitized view', (t) => {
  const userData = root(t);
  const provisioned = provision(userData);
  const registry = new CustomSchoolProfileRegistry({ userData, profileStorageEffects }).load();
  const views = registry.listViews({ locale: 'en' });
  assert.equal(views.length, 1);
  assert.equal(views[0].profileId, provisioned.profileId);
  assert.equal(views[0].normalizedGatewayOrigin, 'https://vpn.example.edu');
  assert.equal(views[0].sanitizedCompatibility, 'candidate');
  assert.equal(views[0].unverified, true);
  const encodedView = JSON.stringify(views);
  for (const forbidden of ['profileKey', 'accountKey', 'workspaceKey', 'engine-config.json']) {
    assert.equal(encodedView.includes(forbidden), false, forbidden);
  }

  registry.withProfile(provisioned.profileId, (record) => {
    assert.deepEqual(record.context, provisioned.context);
    assert.equal(record.authority.hasCredential, false);
    assert.equal(record.authority.workspaceSettings.autoConnect, false);
    assert.deepEqual(record.authority.workspaceSettings.routeDomains, []);
    assert.equal(record.engineConfig.gatewayOrigin, 'https://vpn.example.edu');
    assert.equal(record.engineConfig.protocolFamily, PROTOCOL_FAMILY);
  });
  const launch = registry.createEngineLaunchBinding(provisioned.profileId);
  const binding = JSON.parse(launch.stdinFrame);
  assert.equal(binding.profileId, provisioned.profileId);
  assert.equal(binding.gatewayOrigin, 'https://vpn.example.edu');
  assert.match(binding.configSha256, /^[a-f0-9]{64}$/u);
  assert.equal(launch.path.endsWith('engine-config.json'), true);
  for (const forbidden of ['accountKey', 'workspaceKey', '"password":']) {
    assert.equal(launch.stdinFrame.includes(forbidden), false, forbidden);
  }
});

test('registry fails closed on Profile Engine config and index binding drift', (t) => {
  for (const target of ['profile', 'engine', 'index']) {
    const userData = path.join(root(t), target);
    fs.mkdirSync(userData, { mode: 0o700 });
    const provisioned = provision(userData);
    const profileRoot = path.join(userData, 'profiles', provisioned.context.profileKey);
    if (target === 'profile') {
      const file = path.join(profileRoot, 'school-profile.json');
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      value.gateway.origin = 'https://other.example.edu';
      fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    } else if (target === 'engine') {
      const file = path.join(profileRoot, 'engine-config.json');
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      value.endpoints.password_login = '/changed';
      fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    } else {
      const file = path.join(userData, 'global', 'custom-profile-index.json');
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      value.entries[0].profileId = `custom-${'9'.repeat(32)}`;
      fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    }
    assert.throws(() => new CustomSchoolProfileRegistry({ userData, profileStorageEffects }).load(),
      /does not match|binding|active workspace/u, target);
  }
});

test('registry callback is synchronous and nested source data is immutable', (t) => {
  const userData = root(t);
  const provisioned = provision(userData);
  const registry = new CustomSchoolProfileRegistry({ userData, profileStorageEffects }).load();
  registry.withProfile(provisioned.profileId, (record) => {
    assert.equal(Object.isFrozen(record.sourceDocument.gateway), true);
    assert.throws(() => { record.sourceDocument.gateway.origin = 'https://changed.invalid'; });
  });
  assert.throws(() => registry.withProfile(provisioned.profileId, async () => true), /synchronous/u);
  assert.throws(() => registry.withProfile('custom-missing', () => true), /unavailable/u);
});
