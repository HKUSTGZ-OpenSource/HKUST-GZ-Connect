'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createProxyAuthMigration } = require('../../../renderer/proxy-auth-migration');

function fixture(initialSettings, save) {
  const elements = new Map();
  for (const id of [
    'strictProxyAuth', 'towerSave',
    'proxyAuthMigration', 'proxyAuthMigrationEnable', 'proxyAuthMigrationKeep',
  ]) {
    elements.set(id, {
      checked: false,
      disabled: false,
      hidden: false,
      listeners: new Map(),
      addEventListener(name, listener) { this.listeners.set(name, listener); },
    });
  }
  let settings = { ...initialSettings };
  const flashes = [];
  const feature = createProxyAuthMigration({
    api: { save },
    document: { getElementById: (id) => elements.get(id) },
    translate: (key) => key,
    getSettings: () => settings,
    setSettings: (next) => { settings = next; },
    isTowerBusy: () => false,
    flash: (...args) => flashes.push(args),
  });
  return { elements, feature, flashes, get settings() { return settings; } };
}

test('version-2 compatibility stays active until one explicit renderer decision', async () => {
  const calls = [];
  let current = {
    strictProxyAuth: false,
    proxyAuthMigrationPending: true,
  };
  const f = fixture(current, async (patch) => {
    calls.push(patch);
    current = {
      ...current,
      ...(patch.strictProxyAuth == null ? {} : { strictProxyAuth: patch.strictProxyAuth }),
      proxyAuthMigrationPending: false,
    };
    return { ok: true, settings: current, reconnected: patch.strictProxyAuth != null };
  });
  f.feature.start();
  assert.equal(f.elements.get('proxyAuthMigration').hidden, false);

  assert.equal((await f.feature.keepCompatibility()).ok, true);
  assert.deepEqual(calls[0], { proxyAuthMigrationAcknowledged: true });
  assert.equal(f.settings.strictProxyAuth, false);
  assert.equal(f.settings.proxyAuthMigrationPending, false);
  assert.equal(f.elements.get('proxyAuthMigration').hidden, true);
});

test('secure migration uses the narrow switch transaction and restores failures', async () => {
  const calls = [];
  const f = fixture({
    strictProxyAuth: false,
    proxyAuthMigrationPending: true,
  }, async (patch) => {
    calls.push(patch);
    return { ok: false, error: 'fixture failure' };
  });
  f.elements.get('strictProxyAuth').checked = true;
  const failed = await f.feature.applyStrict(true);
  assert.equal(failed.ok, false);
  assert.deepEqual(calls, [{ strictProxyAuth: true }]);
  assert.equal(f.elements.get('strictProxyAuth').checked, false);
  assert.deepEqual(f.flashes.at(-1), ['fixture failure', true]);
  assert.equal(f.feature.isBusy(), false);
});
