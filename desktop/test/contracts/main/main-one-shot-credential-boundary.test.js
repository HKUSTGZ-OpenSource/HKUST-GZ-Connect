'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { DesktopPersistenceRuntime } = require('../../../lib/persistence/runtime/desktop-persistence-runtime');
const { createControlStateSnapshot } = require('../../../lib/ipc/control-ipc-suite');

const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'main.js'), 'utf8');
const attempt = fs.readFileSync(require.resolve('../../../lib/connection/engine/engine-process'), 'utf8');
const accessSource = fs.readFileSync(require.resolve('../../../lib/persistence/credentials/credential-store'), 'utf8');

function mainIdentityCallback(context) {
  const expression = source.match(/hasAccountIdentity:\s*(\(\) =>[\s\S]*?),\s*getPacUrl:/u)?.[1];
  assert.ok(expression, 'Main identity injection must remain available');
  return vm.runInNewContext(`(${expression})`, context);
}

function identityFixture(t) {
  const state = { persistent: false, engine: false, profile: 'fixture-profile-a' };
  let opened = 0;
  const persistenceRuntime = { hasCredential: () => state.persistent,
    hasAccountIdentity: () => state.persistent,
    openCredential: () => { opened++; throw new Error('presence must not open credentials'); } };
  const vpnCredentialAccess = DesktopPersistenceRuntime.createVpnCredentialAccess({
    persistence: persistenceRuntime, getProfileId: () => state.profile,
    getEngineActive: () => state.engine,
    safeStorage: { isEncryptionAvailable: () => { throw new Error('presence must not probe storage'); } },
    platform: process.platform,
  });
  t.after(() => vpnCredentialAccess.clear());
  const snapshot = createControlStateSnapshot({
    getStatus: () => ({ connected: state.engine }), loadSettings: () => ({ username: 'fixture-label', port: 6180 }),
    hasCredential: () => vpnCredentialAccess.hasCredentialForCurrentSession(),
    hasAccountIdentity: mainIdentityCallback({ persistenceRuntime, vpnCredentialAccess,
      engineSupervisor: { get hasActive() { return state.engine; } } }),
    getPacUrl: () => '', getLocale: () => 'zh', platform: process.platform,
    getVersion: () => 'fixture', getUpdate: () => null, getResources: () => [],
    getResourceGroups: () => [], getFallbackResources: () => [], getProfilePresentation: () => ({}),
    getAuthChallenge: () => null, getNetworkEnvironment: () => null,
  });
  return { state, access: vpnCredentialAccess, snapshot, opened: () => opened };
}

test('real Control snapshot accepts matching memory identity without consuming or exposing it', async t => {
  const f = identityFixture(t);
  f.access.stage({ profileId: f.state.profile, username: 'fixture-memory-user', password: 'fixture-memory-input' });
  const value = await f.snapshot();
  assert.equal(value.hasPassword, true);
  assert.equal(value.loggedIn, true);
  assert.equal(f.access.hasOneShot(), true, 'presence must leave the staged input usable');
  assert.equal(f.opened(), 0);
  assert.doesNotMatch(JSON.stringify(value), /fixture-memory-user|fixture-memory-input/);
  assert.notEqual(value.settings.username, 'fixture-label');
});

test('real Control identity snapshot covers no identity, persistent, wrong Profile and active Engine', async t => {
  const f = identityFixture(t);
  assert.equal((await f.snapshot()).loggedIn, false);
  f.state.persistent = true;
  assert.equal((await f.snapshot()).loggedIn, true);
  f.state.persistent = false;
  f.access.stage({ profileId: f.state.profile, username: 'fixture-user', password: 'fixture-input' });
  f.state.profile = 'fixture-profile-b';
  const other = await f.snapshot();
  assert.equal(other.hasPassword, false);
  assert.equal(other.loggedIn, false);
  f.state.engine = true;
  assert.equal((await f.snapshot()).loggedIn, true);
  f.state.engine = false;
  f.state.profile = 'fixture-profile-a';
  assert.equal((await f.snapshot()).loggedIn, true);
  assert.equal(f.opened(), 0);
});

test('Main identity preserves persistent then memory then Engine short-circuit ordering', () => {
  for (const [persistent, memory, engine, expected] of [
    [true, false, false, ['persistent']], [false, true, false, ['persistent', 'memory']],
    [false, false, true, ['persistent', 'memory', 'engine']],
  ]) {
    const calls = [];
    const callback = mainIdentityCallback({
      persistenceRuntime: { hasAccountIdentity: () => { calls.push('persistent'); return persistent; } },
      vpnCredentialAccess: { hasOneShot: () => { calls.push('memory'); return memory; } },
      engineSupervisor: { get hasActive() { calls.push('engine'); return engine; } },
    });
    assert.equal(callback(), true);
    assert.deepEqual(calls, expected);
  }
});

test('the Main-injected selector can use explicit memory credentials when protected storage is unavailable', () => {
  const vpnCredentialAccess = DesktopPersistenceRuntime.createVpnCredentialAccess({
    persistence: { hasCredential: () => false, openCredential: () => {
      throw Object.assign(new Error('synthetic protected storage unavailable'), { credentialStatus: 'unavailable' });
    } },
    getProfileId: () => 'hkustgz', getEngineActive: () => false,
  });
  vpnCredentialAccess.stage({ profileId: 'hkustgz', username: 'synthetic-memory-user',
    password: 'synthetic-memory-value' });
  const expression = source.match(/openCredential: profileId => (vpnCredentialAccess\.open\(profileId\))/u)?.[1];
  assert.ok(expression, 'final credential selection seam is present');
  let owner;
  assert.doesNotThrow(() => {
    owner = vm.runInNewContext(expression, { vpnCredentialAccess, profileId: 'hkustgz' });
  });
  owner.withStrings((username, password) => {
    assert.equal(username, 'synthetic-memory-user');
    assert.equal(password, 'synthetic-memory-value');
  });
  owner.destroy();
  vpnCredentialAccess.clear();
});

test('Linux memory-only credentials stay Main-owned and profile-bound', () => {
  assert.match(source, /const vpnCredentialAccess = DesktopPersistenceRuntime\.createVpnCredentialAccess\(/u);
  assert.match(source, /getProfileId: \(\) => activeSchoolProfile\.activeContextBinding\(\)\.profileId/u);
  assert.match(accessSource, /#memoryBroker = new OneShotVpnCredentialBroker\(\)/u);
  assert.match(source,
    /openCredential: profileId => vpnCredentialAccess\.open\(profileId\)/u,
    'the final snapshot injects protected storage and the profile-bound memory fallback');
  assert.match(accessSource, /profileId, memoryBroker: this\.#memoryBroker,[\s\S]*openPersistent: \(\) => this\.persistence\.openCredential\(\)/u);
  assert.match(attempt, /this\.openCredential\(this\.profile\.activeContextBinding\(\)\.profileId\)/u);
  assert.match(source,
    /credentialStorageAvailable: \(\) => vpnCredentialAccess\.storageAvailable\(\)/u);
  assert.match(source, /stageOneShotCredential: \(request\) => vpnCredentialAccess\.stage\(request\)/u);
  assert.match(source, /clearOneShotCredential: \(revision\) => vpnCredentialAccess\.clear\(revision\)/u);
});

test('memory-only credentials never become a cross-launch auto-connect authority', () => {
  const startup = source.slice(source.indexOf('createNetworkStartupSystem({'),
    source.indexOf('const connectionOperations ='));
  assert.match(startup, /hasPersistentCredential\(\)/u);
  assert.doesNotMatch(startup, /hasStoredCredential\(\)/u);
  assert.match(source, /disposeLifecycle: \(\) => \{[\s\S]*vpnCredentialAccess\.clear\(\)/u);
  assert.match(source, /clearServerState: \(\) => \{ vpnCredentialAccess\.clear\(\)/u);
});
