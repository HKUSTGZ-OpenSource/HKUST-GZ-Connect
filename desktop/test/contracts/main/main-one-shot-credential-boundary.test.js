'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { DesktopPersistenceRuntime } = require('../../../lib/persistence/runtime/desktop-persistence-runtime');

const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'main.js'), 'utf8');
const attempt = fs.readFileSync(require.resolve('../../../lib/connection/engine/engine-process'), 'utf8');
const accessSource = fs.readFileSync(require.resolve('../../../lib/persistence/credentials/credential-store'), 'utf8');

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
