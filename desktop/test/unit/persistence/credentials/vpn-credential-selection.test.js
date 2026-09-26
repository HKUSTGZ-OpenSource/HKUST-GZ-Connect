'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { OneShotVpnCredentialBroker, openVpnCredential } =
  require('../../../../lib/persistence/credentials/one-shot-vpn-credential');

function broker() {
  const value = new OneShotVpnCredentialBroker();
  value.stage({ profileId: 'hkustgz', username: 'synthetic-memory-user', password: 'synthetic-memory-value' });
  return value;
}

test('a usable persistent owner wins without touching memory state', () => {
  const persistent = {};
  const memoryBroker = { open: () => { throw new Error('memory must not be consulted'); } };
  assert.equal(openVpnCredential({ memoryBroker, profileId: 'hkustgz', openPersistent: () => persistent }), persistent);
});

test('missing or typed unavailable storage can use explicit current-profile memory', () => {
  for (const unavailable of [false, true]) {
    const memoryBroker = broker();
    const owner = openVpnCredential({ memoryBroker, profileId: 'hkustgz', openPersistent: () => {
      if (unavailable) throw Object.assign(new Error('synthetic unavailable'), { credentialStatus: 'unavailable' });
      return null;
    } });
    owner.withStrings(username => assert.equal(username, 'synthetic-memory-user'));
    owner.destroy();
    assert.equal(memoryBroker.has({ profileId: 'hkustgz' }), true,
      'a cloned owner does not destroy the process-lifetime retry entry');
    memoryBroker.clear();
  }
});

test('other protected-store failures never open a memory fallback', () => {
  for (const credentialStatus of ['corrupt', 'decrypt_failed', 'missing_context', undefined]) {
    const failure = Object.assign(new Error('synthetic failure'), { credentialStatus });
    assert.throws(() => openVpnCredential({ profileId: 'hkustgz',
      memoryBroker: { open: () => { assert.fail('invalid fallback'); } },
      openPersistent: () => { throw failure; } }), error => error === failure);
  }
});

test('unavailable storage without a matching memory owner retains the original failure', () => {
  for (const profileId of ['hkustgz', 'other-profile']) {
    const memoryBroker = profileId === 'hkustgz' ? new OneShotVpnCredentialBroker() : broker();
    const failure = Object.assign(new Error('synthetic unavailable'), { credentialStatus: 'unavailable' });
    assert.throws(() => openVpnCredential({ memoryBroker, profileId,
      openPersistent: () => { throw failure; } }), error => error === failure);
    memoryBroker.clear();
  }
});

test('a memory owner failure cannot fall through to another persistent identity', () => {
  let reads = 0;
  assert.throws(() => openVpnCredential({ profileId: 'hkustgz',
    memoryBroker: { open: () => { throw new Error('synthetic memory failure'); } },
    openPersistent: () => { reads++; return null; } }), /synthetic memory failure/u);
  assert.equal(reads, 1);
});

test('missing dependency ports fail before attempting either source', () => {
  assert.throws(() => openVpnCredential(), /dependencies/u);
});
