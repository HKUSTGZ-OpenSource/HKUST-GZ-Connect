'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { OneShotVpnCredentialBroker, openVpnCredential } =
  require('../../../lib/persistence/credentials/one-shot-vpn-credential');

const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'main.js'), 'utf8');
const attempt = fs.readFileSync(require.resolve('../../../lib/connection/engine/engine-process'), 'utf8');

test('the Main-injected selector can use explicit memory credentials when protected storage is unavailable', () => {
  const oneShotVpnCredential = new OneShotVpnCredentialBroker();
  oneShotVpnCredential.stage({ profileId: 'hkustgz', username: 'synthetic-memory-user',
    password: 'synthetic-memory-value' });
  const expression = source.match(/openCredential: profileId => (openVpnCredential\([\s\S]+?\}\))/u)?.[1];
  assert.ok(expression, 'final credential selection seam is present');
  let owner;
  assert.doesNotThrow(() => {
    owner = vm.runInNewContext(expression, { oneShotVpnCredential, openVpnCredential, profileId: 'hkustgz',
      activeSchoolProfile: { activeContextBinding: () => ({ profileId: 'hkustgz' }) },
      persistenceRuntime: { openCredential: () => {
        throw Object.assign(new Error('synthetic protected storage unavailable'), { credentialStatus: 'unavailable' });
      } } });
  });
  owner.withStrings((username, password) => {
    assert.equal(username, 'synthetic-memory-user');
    assert.equal(password, 'synthetic-memory-value');
  });
  owner.destroy();
  oneShotVpnCredential.clear();
});

test('Linux memory-only credentials stay Main-owned and profile-bound', () => {
  assert.match(source, /const oneShotVpnCredential = new OneShotVpnCredentialBroker\(\)/u);
  assert.match(source,
    /openCredential: profileId => openVpnCredential\(\{ profileId, memoryBroker: oneShotVpnCredential,[\s\S]*openPersistent: \(\) => persistenceRuntime\.openCredential\(\)/u,
    'the final snapshot injects protected storage and the profile-bound memory fallback');
  assert.match(attempt, /this\.openCredential\(this\.profile\.activeContextBinding\(\)\.profileId\)/u);
  assert.match(source,
    /credentialStorageAvailable: \(\) => protectedStorageAvailable\(safeStorage, process\.platform\)/u);
  assert.match(source, /stageOneShotCredential: \(request\) => oneShotVpnCredential\.stage\(request\)/u);
  assert.match(source, /clearOneShotCredential: \(revision\) => oneShotVpnCredential\.clear\(revision\)/u);
});

test('memory-only credentials never become a cross-launch auto-connect authority', () => {
  const startup = source.slice(source.indexOf('createNetworkStartupSystem({'),
    source.indexOf('const connectionOperations ='));
  assert.match(startup, /hasPersistentCredential\(\)/u);
  assert.doesNotMatch(startup, /hasStoredCredential\(\)/u);
  assert.match(source, /disposeLifecycle: \(\) => \{[\s\S]*oneShotVpnCredential\.clear\(\)/u);
  assert.match(source, /clearServerState: \(\) => \{ oneShotVpnCredential\.clear\(\)/u);
});
