'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DesktopPersistenceRuntime,
} = require('../../../../lib/persistence/runtime/desktop-persistence-runtime');
const { normalizeSettings } = require('../../../../lib/persistence/settings/settings-store');

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
  const persistence = new DesktopPersistenceRuntime({
    preReadySelection: { mode: 'profile-workspace', paths: { root: '/scoped' } },
    initializeAfterReady: () => runtime,
    legacy: legacy({
      loadSettings: () => { throw new Error('legacy read used'); },
      saveSettings: () => { throw new Error('legacy write used'); },
    }),
  });
  assert.equal(persistence.initialize().ready, true);
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
