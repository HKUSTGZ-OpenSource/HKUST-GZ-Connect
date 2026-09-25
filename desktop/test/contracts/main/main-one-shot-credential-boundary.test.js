'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'main.js'), 'utf8');

test('Linux memory-only credentials stay Main-owned and profile-bound', () => {
  assert.match(source, /const oneShotVpnCredential = new OneShotVpnCredentialBroker\(\)/u);
  assert.match(source,
    /persistenceRuntime\.openCredential\(\) \|\| oneShotVpnCredential\.open\(\{[\s\S]*profileId: activeSchoolProfile\.activeContextBinding\(\)\.profileId/u,
    'persistent protected storage must win before the one-shot fallback');
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
