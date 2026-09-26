'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { OneShotVpnCredentialBroker, openVpnCredential } =
  require('../../../lib/persistence/credentials/one-shot-vpn-credential');

const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'main.js'), 'utf8');

test('the actual final snapshot can select explicit memory credentials when protected storage is unavailable', () => {
  const oneShotVpnCredential = new OneShotVpnCredentialBroker();
  oneShotVpnCredential.stage({ profileId: 'hkustgz', username: 'synthetic-memory-user',
    password: 'synthetic-memory-value' });
  const expression = source.match(/const credentialOwner = ([\s\S]+?);\n\s*if \(credentialOwner\)/u)?.[1];
  assert.ok(expression, 'final credential selection seam is present');
  let owner;
  assert.doesNotThrow(() => {
    owner = vm.runInNewContext(expression, { oneShotVpnCredential, openVpnCredential,
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
    /openVpnCredential\(\{[\s\S]*profileId: activeSchoolProfile\.activeContextBinding\(\)\.profileId,[\s\S]*memoryBroker: oneShotVpnCredential,[\s\S]*openPersistent: \(\) => persistenceRuntime\.openCredential\(\)/u,
    'the final snapshot injects protected storage and the profile-bound memory fallback');
  assert.match(source,
    /credentialStorageAvailable: \(\) => protectedStorageAvailable\(safeStorage, process\.platform\)/u);
  assert.match(source, /stageOneShotCredential: \(request\) => oneShotVpnCredential\.stage\(request\)/u);
  assert.match(source, /clearOneShotCredential: \(revision\) => oneShotVpnCredential\.clear\(revision\)/u);
});

test('memory-only credentials never become a cross-launch auto-connect authority', () => {
  const startup = source.slice(source.indexOf('createNetworkStartupSystem({'),
    source.indexOf('function rejectConnectionWhileQuitting('));
  assert.match(startup, /hasPersistentCredential\(\)/u);
  assert.doesNotMatch(startup, /hasStoredCredential\(\)/u);
  assert.match(source, /disposeLifecycle: \(\) => \{[\s\S]*oneShotVpnCredential\.clear\(\)/u);
  assert.match(source, /clearServerState: \(\) => \{ oneShotVpnCredential\.clear\(\)/u);
});
