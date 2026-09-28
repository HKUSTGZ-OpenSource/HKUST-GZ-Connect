'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  DesktopPersistenceRuntime,
} = require('../../../../lib/persistence/runtime/desktop-persistence-runtime');
const { normalizeSettings } = require('../../../../lib/persistence/settings/settings-store');
const { beginCredentialSettingsTransaction } = require('../../../../lib/persistence/credentials/credential-settings-transaction');

function owner(username = 'synthetic-user', password = 'synthetic-password') {
  let destroyed = false;
  return {
    withUsername(callback) {
      if (destroyed) throw new Error('destroyed');
      return callback(username);
    },
    withStrings(callback) {
      if (destroyed) throw new Error('destroyed');
      return callback(username, password);
    },
    destroy() { if (destroyed) return false; destroyed = true; return true; },
  };
}

function legacy(overrides = {}) {
  let settings = normalizeSettings({ username: 'legacy-user', port: 6180 });
  let hasCredential = true;
  return {
    loadSettings: () => settings,
    saveSettings: (next) => { settings = normalizeSettings(next); return settings; },
    saveCredential: () => { hasCredential = true; return true; },
    clearCredential: () => { hasCredential = false; return true; },
    openCredential: () => hasCredential ? owner('legacy-user', 'legacy-password') : null,
    hasCredential: () => hasCredential,
    ...overrides,
  };
}

function authority({ hasCredential = true, port = 6180 } = {}) {
  return {
    globalSettings: {
      schemaVersion: 1,
      activeProfileKey: `profile-${'11'.repeat(16)}`,
      activeAccountKey: `account-${'22'.repeat(16)}`,
      port,
      strictProxyAuth: true,
      proxySecurityVersion: 3,
      proxyAuthMigrationPending: false,
      closeAction: 'ask',
      language: 'zh',
      startAtLogin: false,
    },
    globalUpdateState: { schemaVersion: 1, checkedAt: 0 },
    workspaceSettings: {
      schemaVersion: 1,
      autoReconnect: true,
      maxAttempts: 3,
      autoConnect: true,
      routeDomains: ['hkust-gz.edu.cn'],
    },
    localResources: { schemaVersion: 1, resources: [] },
    hasCredential,
  };
}

test('pre-ready credential rollback completes before owner-only file validation', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-pre-ready-credential-recovery-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const files = {
    settings: path.join(directory, 'settings.json'),
    settingsBackup: path.join(directory, 'settings.json.bak'),
    vpnCredential: path.join(directory, 'vpn.credential'),
    credentialTransaction: path.join(directory, 'credential-transaction.json'),
  };
  const originals = {
    settings: Buffer.from('{"username":"synthetic-original"}'),
    settingsBackup: Buffer.from('{"username":"synthetic-backup"}'),
    vpnCredential: Buffer.from('synthetic-encrypted-credential'),
  };
  for (const [key, bytes] of Object.entries(originals)) {
    fs.writeFileSync(files[key], bytes, { mode: 0o600 });
  }
  beginCredentialSettingsTransaction(files.credentialTransaction, {
    settings: files.settings,
    settingsBackup: files.settingsBackup,
    credential: files.vpnCredential,
  });
  fs.writeFileSync(files.settings, '{"username":"synthetic-interrupted"}', { mode: 0o600 });
  fs.writeFileSync(files.settingsBackup, '{"username":"synthetic-interrupted-backup"}', { mode: 0o600 });
  fs.writeFileSync(files.vpnCredential, 'synthetic-interrupted-credential', { mode: 0o600 });

  let initializeCalls = 0;
  const persistence = new DesktopPersistenceRuntime({
    preReadySelection: {
      mode: 'legacy-flat',
      paths: files,
    },
    initializeAfterReady: () => { initializeCalls += 1; return { mode: 'legacy-flat' }; },
    legacy: legacy(),
  });

  assert.equal(initializeCalls, 0, 'runtime initialization has not run during pre-ready recovery');
  let validations = 0;
  const recovery = persistence.prepareBeforeOwnerOnlyValidation(() => {
    validations += 1;
    for (const [key, bytes] of Object.entries(originals)) {
      assert.deepEqual(fs.readFileSync(files[key]), bytes, `${key} rollback must precede validation`);
    }
  });
  assert.deepEqual(recovery, { ok: true, status: 'recovered' });
  assert.equal(validations, 1);
  assert.equal(fs.existsSync(files.credentialTransaction), false);
  assert.equal(persistence.initialize().ready, true);
  assert.equal(initializeCalls, 1);
});

test('blocked credential recovery stays fail-closed in one runtime owner until retry succeeds', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-blocked-credential-recovery-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const files = {
    settings: path.join(directory, 'settings.json'),
    settingsBackup: path.join(directory, 'settings.json.bak'),
    vpnCredential: path.join(directory, 'vpn.credential'),
    credentialTransaction: path.join(directory, 'credential-transaction.json'),
  };
  fs.writeFileSync(files.settings, '{"username":"synthetic-user"}', { mode: 0o600 });
  fs.writeFileSync(files.vpnCredential, 'synthetic-encrypted-credential', { mode: 0o600 });
  beginCredentialSettingsTransaction(files.credentialTransaction, {
    settings: files.settings,
    settingsBackup: files.settingsBackup,
    credential: files.vpnCredential,
  });
  fs.writeFileSync(files.settings, '{"username":"synthetic-interrupted"}', { mode: 0o600 });
  fs.writeFileSync(files.vpnCredential, 'synthetic-interrupted-credential', { mode: 0o600 });
  let denyJournalRead = true;
  const fileSystem = Object.create(fs);
  fileSystem.lstatSync = (filePath, ...args) => {
    if (denyJournalRead && filePath === files.credentialTransaction) {
      const error = new Error('synthetic journal access failure');
      error.code = 'EACCES';
      throw error;
    }
    return fs.lstatSync(filePath, ...args);
  };
  const state = { recoveryError: null, notice: null };
  let emits = 0;
  const persistence = new DesktopPersistenceRuntime({
    preReadySelection: { mode: 'legacy-flat', paths: files },
    initializeAfterReady: () => ({ mode: 'legacy-flat' }),
    legacy: legacy(),
    credentialTransactionFileSystem: fileSystem,
    settingsPresentation: {
      getState: () => state,
      getAdditionalNotice: () => 'synthetic-settings-notice',
      translate: (key) => `zh:${key}`,
      emit: () => { emits += 1; },
    },
  });

  let validated = false;
  const recovery = persistence.prepareBeforeOwnerOnlyValidation(() => { validated = true; });
  assert.deepEqual(recovery, {
    ok: false,
    status: 'blocked',
  });
  assert.equal(Object.isFrozen(recovery), true);
  assert.equal(validated, true, 'the existing startup order still performs owner-only checks after a block');
  assert.equal(persistence.isCredentialTransactionBlocked(), true);
  const callerOwnedRecovery = { ok: false, status: 'blocked' };
  persistence.applyCredentialRecoveryOutcome(callerOwnedRecovery, { emitState: false });
  callerOwnedRecovery.ok = true;
  callerOwnedRecovery.status = 'recovered';
  assert.equal(persistence.isCredentialTransactionBlocked(), true, 'callers cannot mutate the recovery authority');
  assert.deepEqual(persistence.getCredentialTransactionRecovery(), { ok: false, status: 'blocked' });
  persistence.initialize();
  assert.equal(persistence.hasCredential(), false, 'blocked credentials cannot authorize persistence hints');
  assert.throws(() => persistence.assertCredentialTransactionAvailable(), (error) => (
    error.code === 'CREDENTIAL_RECOVERY_BLOCKED' && error.userMessage === 'zh:error.credentialRecoveryBlocked'
  ));
  assert.equal(persistence.isCredentialTransactionBlocked(), true);
  assert.equal(fs.existsSync(files.credentialTransaction), true, 'transient failure preserves retry proof');
  assert.equal(state.notice, 'synthetic-settings-notice');
  assert.equal(state.recoveryError, 'zh:error.credentialRecoveryBlocked');

  denyJournalRead = false;
  assert.doesNotThrow(() => persistence.assertCredentialTransactionAvailable());
  assert.equal(persistence.isCredentialTransactionBlocked(), false);
  assert.equal(persistence.hasCredential(), true);
  assert.deepEqual(persistence.getCredentialTransactionRecovery(), { ok: true, status: 'recovered' });
  assert.equal(fs.existsSync(files.credentialTransaction), false);
  assert.equal(state.notice, 'synthetic-settings-notice\nzh:error.credentialRecoveryRecovered');
  assert.equal(emits, 2);
  const mutation = persistence.runCredentialMutation({ mutate: () => {
    fs.writeFileSync(files.settings, '{"username":"synthetic-committed"}', { mode: 0o600 });
    fs.writeFileSync(files.vpnCredential, 'synthetic-committed-credential', { mode: 0o600 });
    return 'synthetic-committed';
  } });
  assert.deepEqual(mutation, { ok: true, value: 'synthetic-committed' });
  assert.equal(fs.existsSync(files.credentialTransaction), false);
  assert.equal(fs.readFileSync(files.settings, 'utf8'), '{"username":"synthetic-committed"}');
});

test('damaged-journal credential clearance stays safe and retains the operation notice', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-cleared-credential-recovery-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const files = {
    settings: path.join(directory, 'settings.json'),
    settingsBackup: path.join(directory, 'settings.json.bak'),
    vpnCredential: path.join(directory, 'vpn.credential'),
    credentialTransaction: path.join(directory, 'credential-transaction.json'),
  };
  fs.writeFileSync(files.settings, '{"username":"synthetic-user"}', { mode: 0o600 });
  fs.writeFileSync(files.vpnCredential, 'synthetic-encrypted-credential', { mode: 0o600 });
  fs.writeFileSync(files.credentialTransaction, '{}', { mode: 0o600 });
  const state = { recoveryError: null, notice: null };
  const persistence = new DesktopPersistenceRuntime({
    preReadySelection: { mode: 'legacy-flat', paths: files },
    initializeAfterReady: () => ({ mode: 'legacy-flat' }),
    legacy: legacy(),
    settingsPresentation: {
      getState: () => state,
      getAdditionalNotice: () => 'synthetic-settings-notice',
      translate: (key) => `en:${key}`,
      emit: () => assert.fail('silent startup outcome must not emit'),
    },
  });
  const recovery = persistence.prepareBeforeOwnerOnlyValidation(() => {});
  assert.deepEqual(recovery, { ok: false, status: 'credential-cleared' });
  assert.equal(fs.existsSync(files.vpnCredential), false);
  assert.equal(persistence.isCredentialTransactionBlocked(), false);
  persistence.applyCredentialRecoveryOutcome(recovery, {
    emitState: false,
    clearedNoticeKey: 'error.logoutFailedPasswordCleared',
  });
  assert.equal(state.recoveryError, null);
  assert.equal(state.notice, 'synthetic-settings-notice\nen:error.logoutFailedPasswordCleared');
});

test('mode change after first migration requests relaunch without enabling either store', () => {
  const persistence = new DesktopPersistenceRuntime({
    preReadySelection: { mode: 'legacy-flat', paths: { root: '/legacy' } },
    initializeAfterReady: () => ({ mode: 'profile-workspace' }),
    legacy: legacy(),
  });
  assert.deepEqual(persistence.initialize(), {
    ready: false,
    relaunchRequired: true,
    previousMode: 'legacy-flat',
    mode: 'profile-workspace',
  });
  assert.throws(() => persistence.loadSettings(), /not ready/u);
});

test('legacy mode preserves existing settings and credential behavior', () => {
  const legacyStore = legacy();
  const persistence = new DesktopPersistenceRuntime({
    preReadySelection: { mode: 'legacy-flat', paths: { root: '/legacy' } },
    initializeAfterReady: () => ({ mode: 'legacy-flat' }),
    legacy: legacyStore,
  });
  assert.equal(persistence.initialize().ready, true);
  assert.equal(persistence.currentAuthority(), null);
  assert.equal(persistence.loadSettings().username, 'legacy-user');
  assert.equal(persistence.hasAccountIdentity(), true);
  const credential = persistence.openCredential();
  assert.deepEqual(credential.withStrings((username, password) => ({ username, password })), {
    username: 'legacy-user',
    password: 'legacy-password',
  });
  assert.equal(credential.destroy(), true);
  assert.equal(JSON.stringify(credential).includes('legacy-user'), false);
  assert.equal(persistence.clearCredential(), true);
  assert.equal(persistence.hasCredential(), false);
});

test('Profile Workspace mode routes settings and credentials only through scoped stores', () => {
  let current = authority();
  let replaced = null;
  let cleared = false;
  const runtime = {
    mode: 'profile-workspace',
    authority: current,
    settingsStore: {
      save(settings) {
        current = authority({ hasCredential: current.hasCredential, port: settings.port });
        return { changed: true, authority: current };
      },
    },
    credentialStore: {
      replace(value) { replaced = value; current = authority({ hasCredential: true }); return { changed: true }; },
      clear() { cleared = true; current = authority({ hasCredential: false }); return { changed: true, hasCredential: false }; },
      open() { return current.hasCredential ? owner('workspace-user', 'workspace-password') : null; },
    },
    reloadAuthority: () => current,
  };
  let legacyTransactionLookups = 0;
  const persistence = new DesktopPersistenceRuntime({
    preReadySelection: { mode: 'profile-workspace', paths: { root: '/scoped' } },
    initializeAfterReady: () => runtime,
    legacy: legacy({
      loadSettings: () => { throw new Error('legacy read used'); },
      saveSettings: () => { throw new Error('legacy write used'); },
    }),
    credentialTransactionFileSystem: {
      lstatSync: () => { legacyTransactionLookups += 1; throw new Error('legacy transaction lookup used'); },
    },
  });
  assert.deepEqual(persistence.prepareBeforeOwnerOnlyValidation(() => {}), { ok: true, status: 'none' });
  assert.equal(persistence.initialize().ready, true);
  assert.deepEqual(persistence.runCredentialMutation({ mutate: () => 'synthetic-scoped-mutation' }), {
    ok: true,
    value: 'synthetic-scoped-mutation',
  });
  assert.equal(legacyTransactionLookups, 0);
  assert.equal(persistence.currentAuthority(), current);
  assert.equal(persistence.hasAccountIdentity(), true);
  assert.equal(persistence.loadSettings().username, 'workspace-user');
  assert.equal(persistence.saveCredential('next-password', 'next-user'), true);
  assert.deepEqual(replaced, { username: 'next-user', password: 'next-password' });
  assert.equal(persistence.loadSettings().username, 'next-user');
  const credential = persistence.openCredential();
  assert.deepEqual(credential.withStrings((username, password) => ({ username, password })), {
    username: 'workspace-user',
    password: 'workspace-password',
  });
  credential.destroy();
  assert.equal(persistence.loadSettings().username, 'workspace-user');
  assert.equal(persistence.saveSettings({ ...persistence.loadSettings(), port: 6280 }).port, 6280);
  assert.equal(persistence.clearCredential(), true);
  assert.equal(cleared, true);
  assert.equal(persistence.hasAccountIdentity(), false);
});

test('frequent settings and account display reads reuse the validated runtime snapshot', () => {
  let current = authority();
  let reloads = 0;
  const runtime = {
    mode: 'profile-workspace',
    authority: current,
    settingsStore: { save() { return { authority: current }; } },
    credentialStore: { open: () => owner() },
    reloadAuthority() { reloads += 1; return current; },
  };
  const persistence = new DesktopPersistenceRuntime({
    preReadySelection: { mode: 'profile-workspace', paths: { root: '/scoped' } },
    initializeAfterReady: () => runtime,
    legacy: legacy(),
  });
  persistence.initialize();
  for (let i = 0; i < 20; i += 1) {
    assert.equal(persistence.loadSettings().port, 6180);
    assert.equal(persistence.hasCredential(), true);
    assert.equal(persistence.hasAccountIdentity(), true);
  }
  assert.equal(reloads, 0, 'display reads must not synchronously reload disk/Windows ACLs');
  current = authority({ port: 6280, hasCredential: false });
  assert.equal(persistence.currentAuthority(), current, 'explicit authority reads still validate disk');
  assert.equal(reloads, 1);
  assert.equal(persistence.loadSettings().port, 6280);
  assert.equal(persistence.hasAccountIdentity(), false);
  runtime.reloadAuthority = () => { throw new Error('invalid ACL'); };
  assert.throws(() => persistence.currentAuthority(), /invalid ACL/);
});

test('Persistence owns the routing settings snapshot and rebases only after a committed save', () => {
  let current = normalizeSettings({ username: 'synthetic-user', port: 6180,
    routeDomains: ['first.invalid'] });
  let reads = 0;
  let writes = 0;
  const persistence = new DesktopPersistenceRuntime({
    preReadySelection: { mode: 'legacy-flat', paths: {} },
    initializeAfterReady: () => ({ mode: 'legacy-flat' }),
    legacy: legacy({
      loadSettings: () => { reads++; return current; },
      saveSettings: next => { writes++; current = normalizeSettings(next); return current; },
    }),
  });
  persistence.initialize();
  const first = persistence.routingSettings();
  assert.equal(persistence.routingSettings(), first);
  assert.equal(reads, 1, 'route projection should not reload settings on each field');
  const saved = persistence.saveSettingsWithGuard({ ...first, routeDomains: ['second.invalid'] });
  assert.equal(writes, 1);
  assert.equal(persistence.routingSettings(), saved);
  assert.deepEqual(saved.routeDomains, ['second.invalid']);
  assert.equal(reads, 1);
});

test('a failed settings write preserves the prior routing snapshot', () => {
  const oldSettings = normalizeSettings({ username: 'synthetic-user', port: 6180 });
  let writes = 0;
  const persistence = new DesktopPersistenceRuntime({
    preReadySelection: { mode: 'legacy-flat', paths: {} },
    initializeAfterReady: () => ({ mode: 'legacy-flat' }),
    legacy: legacy({
      loadSettings: () => oldSettings,
      saveSettings: () => { writes++; throw new Error('synthetic write failure'); },
    }),
  });
  persistence.initialize();
  assert.equal(persistence.routingSettings(), oldSettings);
  assert.throws(() => persistence.saveSettingsWithGuard({ ...oldSettings, port: 6280 }),
    /synthetic write failure/u);
  assert.equal(writes, 1);
  assert.equal(persistence.routingSettings(), oldSettings);
});

test('close-action settings transaction snapshots inside the queued factory and restores on rollback', () => {
  let current = normalizeSettings({ username: 'synthetic-user', closeAction: 'ask', port: 6180 });
  const calls = [];
  const persistence = new DesktopPersistenceRuntime({
    preReadySelection: { mode: 'legacy-flat', paths: {} },
    initializeAfterReady: () => ({ mode: 'legacy-flat' }),
    legacy: legacy({
      loadSettings: () => { calls.push('read'); return current; },
      saveSettings: next => { calls.push('write'); current = normalizeSettings(next); return current; },
    }),
  });
  persistence.initialize();
  let queuedFactory;
  assert.equal(persistence.rememberCloseAction('quit', factory => {
    queuedFactory = factory;
    return 'queued';
  }), 'queued');
  assert.deepEqual(calls, [], 'the old settings must not be read before queue admission');
  const operations = queuedFactory();
  assert.deepEqual(calls, ['read']);
  assert.equal(operations.commit().closeAction, 'quit');
  assert.equal(persistence.routingSettings().closeAction, 'quit');
  assert.equal(operations.rollback().closeAction, 'ask');
  assert.equal(persistence.routingSettings().closeAction, 'ask');
  assert.deepEqual(calls, ['read', 'write', 'write']);
});
