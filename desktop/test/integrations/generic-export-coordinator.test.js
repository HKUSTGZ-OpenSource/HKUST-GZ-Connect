'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createGenericExportCoordinator,
} = require('../../lib/integrations/generic-export-coordinator');
const {
  createIntegrationBinding,
} = require('../../lib/integrations/integration-schema');
const {
  AtomicExportFileTransaction,
} = require('../../lib/integrations/atomic-export-file-transaction');
const {
  createProfileNetworkRules,
} = require('../../lib/integrations/profile-network-rules');

const reviewed = JSON.parse(fs.readFileSync(path.join(
  __dirname, '..', '..', 'assets', 'profiles', 'hkustgz', 'school-profile.json'), 'utf8'));
const rules = createProfileNetworkRules({ profileDocument: reviewed });
const credential = {
  withStrings(callback) { return callback('A'.repeat(32), 'B'.repeat(32)); },
};

function binding(adapterId = 'clash_mihomo_yaml', patch = {}) {
  return createIntegrationBinding({
    adapterId, adapterVersion: 1,
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

function fixture(t, { writeClipboard = null, beforePerform = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'generic-export-coordinator-'));
  fs.chmodSync(root, 0o700);
  const output = path.join(root, 'output');
  fs.mkdirSync(output, { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fileTransaction = new AtomicExportFileTransaction();
  let entropy = 0;
  const clipboard = [];
  const coordinator = createGenericExportCoordinator({
    fileTransaction,
    writeClipboard: writeClipboard || ((text) => { clipboard.push(text); return true; }),
    beforePerform: beforePerform || (() => {}),
    randomBytes: (length) => Buffer.alloc(length, ++entropy),
    now: () => 1_800_000_000_000,
    ttlMs: 20_000,
  });
  return { coordinator, clipboard, output };
}

test('copy confirms once and returns no generated payload to its caller', async (t) => {
  const f = fixture(t);
  const current = binding();
  const preview = f.coordinator.prepare({
    adapterId: 'clash_mihomo_yaml', action: 'copy', binding: current,
    networkRules: rules, port: 6180, credential,
  });
  const result = await f.coordinator.confirm({
    confirmationHandle: preview.confirmationHandle,
    assertCurrent: () => {}, currentBinding: current,
  });
  assert.deepEqual(result, { ok: true, adapterId: 'clash_mihomo_yaml', action: 'copy' });
  assert.equal(Object.hasOwn(result, 'payload'), false);
  assert.match(f.clipboard[0], /Campus Connect - hkustgz/u);
  assert.match(f.clipboard[0], new RegExp('B'.repeat(32), 'u'));
});

test('pre-export side effects run only after binding revalidation', async (t) => {
  const effects = [];
  const f = fixture(t, { beforePerform: ({ adapterId, action }) => {
    effects.push([adapterId, action]);
  } });
  const current = binding();
  let preview = f.coordinator.prepare({
    adapterId: 'clash_mihomo_yaml', action: 'copy', binding: current,
    networkRules: rules, port: 6180, credential,
  });
  await assert.rejects(f.coordinator.confirm({
    confirmationHandle: preview.confirmationHandle,
    assertCurrent: () => {}, currentBinding: binding('clash_mihomo_yaml', { activeContextEpoch: 2 }),
  }), { code: 'INTEGRATION_PROFILE_STALE' });
  assert.deepEqual(effects, []);

  preview = f.coordinator.prepare({
    adapterId: 'clash_mihomo_yaml', action: 'copy', binding: current,
    networkRules: rules, port: 6180, credential,
  });
  await f.coordinator.confirm({
    confirmationHandle: preview.confirmationHandle, assertCurrent: () => {}, currentBinding: current,
  });
  assert.deepEqual(effects, [['clash_mihomo_yaml', 'copy']]);
});

test('save applies the exact previewed file plan and commits owner-only validated output', async (t) => {
  const f = fixture(t);
  const targetFile = path.join(f.output, 'campus.yaml');
  const current = binding('clash_mihomo_yaml');
  const preview = f.coordinator.prepare({
    adapterId: 'clash_mihomo_yaml', action: 'save', binding: current,
    networkRules: rules, port: 6180, credential, targetFile,
  });
  assert.equal(preview.targetChange, 'create');
  const result = await f.coordinator.confirm({
    confirmationHandle: preview.confirmationHandle,
    assertCurrent: () => {}, currentBinding: current,
  });
  assert.deepEqual(result, { ok: true, adapterId: 'clash_mihomo_yaml', action: 'save' });
  assert.match(fs.readFileSync(targetFile, 'utf8'), /Clash \/ Mihomo export/u);
  if (process.platform !== 'win32') assert.equal(fs.statSync(targetFile).mode & 0o077, 0);
});

test('clipboard failure and binding drift surface stable codes without writing a target', async (t) => {
  const f = fixture(t, { writeClipboard: () => { throw new Error('clipboard unavailable'); } });
  const current = binding();
  let preview = f.coordinator.prepare({
    adapterId: 'clash_mihomo_yaml', action: 'copy', binding: current,
    networkRules: rules, port: 6180, credential,
  });
  await assert.rejects(f.coordinator.confirm({
    confirmationHandle: preview.confirmationHandle, assertCurrent: () => {}, currentBinding: current,
  }), { code: 'INTEGRATION_EXPORT_FAILED' });

  const targetFile = path.join(f.output, 'stale.yaml');
  preview = f.coordinator.prepare({
    adapterId: 'clash_mihomo_yaml', action: 'save', binding: current,
    networkRules: rules, port: 6180, credential, targetFile,
  });
  await assert.rejects(f.coordinator.confirm({
    confirmationHandle: preview.confirmationHandle,
    assertCurrent: () => {}, currentBinding: binding('clash_mihomo_yaml', { activeContextEpoch: 2 }),
  }), { code: 'INTEGRATION_PROFILE_STALE' });
  assert.equal(fs.existsSync(targetFile), false);
});
