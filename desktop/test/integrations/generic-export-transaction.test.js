'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  GenericExportTransactionOwner,
} = require('../../lib/integrations/generic-export-transaction');
const {
  createIntegrationBinding,
} = require('../../lib/integrations/integration-schema');
const {
  createProfileNetworkRules,
} = require('../../lib/integrations/profile-network-rules');

const reviewed = JSON.parse(fs.readFileSync(path.join(
  __dirname, '..', '..', 'assets', 'profiles', 'hkustgz', 'school-profile.json'), 'utf8'));
const rules = createProfileNetworkRules({ profileDocument: reviewed });
const material = Object.freeze({ username: 'A'.repeat(32), password: 'B'.repeat(32) });
const credential = {
  withStrings(callback) { return callback(material.username, material.password); },
};

function binding(patch = {}) {
  return createIntegrationBinding({
    adapterId: 'clash_mihomo_yaml', adapterVersion: 1,
    profileId: rules.profileId, profileRevision: rules.profileRevision,
    profileCredentialBindingRevision: rules.profileCredentialBindingRevision,
    accountKey: `account-${'a'.repeat(32)}`, accountRevision: 1,
    accountCredentialRevision: 1, workspaceKey: `workspace-${'b'.repeat(32)}`,
    activeContextEpoch: 1, listenerKind: 'socks5-authenticated',
    loopbackHost: '127.0.0.1', loopbackPort: 6180, proxySecurityRevision: 3,
    credentialRef: `credential-${'c'.repeat(32)}`,
    networkRulesDigest: rules.rulesDigest, pacDigest: 'd'.repeat(64),
    engineGeneration: 1, recordRevision: 1, ...patch,
  });
}

function owner(overrides = {}) {
  let entropy = 0;
  return new GenericExportTransactionOwner({
    randomBytes: (length) => Buffer.alloc(length, ++entropy),
    now: () => 1_800_000_000_000,
    ttlMs: 20_000,
    fileTransaction: {
      inspect(targetFile, payload) {
        return Object.freeze({
          targetFile,
          before: Object.freeze({ present: false, bytes: 0, sha256: null }),
          after: Object.freeze({ present: true, bytes: payload.length, sha256: 'e'.repeat(64) }),
          change: 'create',
        });
      },
    },
    ...overrides,
  });
}

test('gateway-default preview warns about delegation and confirms exactly prepared bytes', async () => {
  const value = owner();
  const preview = value.prepare({ adapterId: 'clash_mihomo_yaml', action: 'copy',
    binding: binding(), networkRules: rules, port: 6180, credential, routingMode: 'gateway-default' });
  assert.deepEqual(preview.warningCodes, ['INTEGRATION_LOCAL_CREDENTIAL_PRIVATE',
    'INTEGRATION_GATEWAY_DEFAULT_ROUTING']);
  assert.equal(JSON.stringify(preview).includes('MATCH,'), false);
  let borrowed;
  await value.execute({ confirmationHandle: preview.confirmationHandle, currentBinding: binding(),
    perform: async ({ payload }) => {
      borrowed = payload;
      assert.match(payload.toString(), /"MATCH,Campus Connect - hkustgz"\n$/u);
    } });
  assert.ok(borrowed.every(byte => byte === 0));
});

test('preview is redacted and explicit execute exposes payload only to one Main callback', async () => {
  const value = owner();
  const current = binding();
  const preview = value.prepare({
    adapterId: 'clash_mihomo_yaml', action: 'copy', binding: current,
    networkRules: rules, port: 6180, credential,
  });
  assert.equal(preview.targetChange, null);
  assert.equal(preview.existingBytes, 0);
  assert.equal(preview.replacementBytes, preview.byteLength);
  assert.equal(preview.containsLocalProxyCredential, true);
  assert.equal(preview.warningCode, 'INTEGRATION_LOCAL_CREDENTIAL_PRIVATE');
  const serialized = JSON.stringify(preview);
  for (const forbidden of [material.username, material.password, 'accountKey', 'workspaceKey', '/Users/']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  let borrowed;
  let observed = '';
  assert.deepEqual(await value.execute({
    confirmationHandle: preview.confirmationHandle,
    currentBinding: current,
    perform: async ({ payload, action, targetFile }) => {
      borrowed = payload;
      observed = payload.toString('utf8');
      assert.equal(action, 'copy');
      assert.equal(targetFile, null);
    },
  }), { ok: true, adapterId: 'clash_mihomo_yaml', action: 'copy' });
  assert.match(observed, new RegExp(material.password, 'u'));
  assert.equal(borrowed.every((byte) => byte === 0), true);
  assert.equal(value.snapshot(), null);
});

test('binding drift fails stale and erases the prepared secret payload', async () => {
  const value = owner();
  const preview = value.prepare({
    adapterId: 'clash_mihomo_yaml', action: 'save', binding: binding(),
    networkRules: rules, port: 6180, credential,
    targetFile: '/Users/student/Desktop/campus.yaml',
  });
  assert.equal(preview.targetChange, 'create');
  let invoked = false;
  await assert.rejects(value.execute({
    confirmationHandle: preview.confirmationHandle,
    currentBinding: binding({ activeContextEpoch: 2 }),
    perform: async () => { invoked = true; },
  }), { code: 'INTEGRATION_PROFILE_STALE' });
  assert.equal(invoked, false);
  assert.equal(value.snapshot(), null);
});

test('expiry cancellation and replacement invalidate old handles without returning payload', async () => {
  let now = 1_800_000_000_000;
  const value = owner({ now: () => now });
  const first = value.prepare({
    adapterId: 'clash_mihomo_yaml', action: 'copy', binding: binding(),
    networkRules: rules, port: 6180, credential,
  });
  const second = value.prepare({
    adapterId: 'clash_mihomo_yaml', action: 'copy', binding: binding(),
    networkRules: rules, port: 6180, credential,
  });
  await assert.rejects(value.execute({
    confirmationHandle: first.confirmationHandle,
    currentBinding: binding(), perform: async () => {},
  }), { code: 'INTEGRATION_EXPORT_STALE' });
  assert.equal(value.snapshot(), null, 'an invalid handle fails closed and invalidates newer material');

  const expiring = value.prepare({
    adapterId: 'clash_mihomo_yaml', action: 'copy', binding: binding(),
    networkRules: rules, port: 6180, credential,
  });
  now = expiring.expiresAt;
  assert.equal(value.snapshot(), null);
  await assert.rejects(value.execute({
    confirmationHandle: expiring.confirmationHandle,
    currentBinding: binding(), perform: async () => {},
  }), { code: 'INTEGRATION_EXPORT_STALE' });
  assert.notEqual(first.confirmationHandle, second.confirmationHandle);
});

test('a failed replacement prepare leaves the prior confirmed preview intact', async () => {
  const value = owner();
  const current = binding();
  const first = value.prepare({
    adapterId: 'clash_mihomo_yaml', action: 'copy', binding: current,
    networkRules: rules, port: 6180, credential,
  });
  assert.throws(() => value.prepare({
    adapterId: 'clash_mihomo_yaml', action: 'save', binding: current,
    networkRules: rules, port: 6180, credential,
    targetFile: 'relative-and-invalid.yaml',
  }), { code: 'INTEGRATION_EXPORT_TARGET_INVALID' });
  assert.equal(value.snapshot().confirmationHandle, first.confirmationHandle);
  assert.deepEqual(await value.execute({
    confirmationHandle: first.confirmationHandle,
    currentBinding: current,
    perform: async () => {},
  }), { ok: true, adapterId: 'clash_mihomo_yaml', action: 'copy' });
});
