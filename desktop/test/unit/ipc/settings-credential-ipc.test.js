'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  registerSettingsCredentialIpc,
  settingsPatchFromIpc,
} = require('../../../lib/ipc/settings-credential-ipc');

function fixture(overrides = {}) {
  const handlers = new Map();
  const calls = [];
  let blocked = false;
  const { credentialTransactions: transactionOverrides = {}, ...dependencyOverrides } = overrides;
  let current = {
    username: 'alice',
    port: 1080,
    strictProxyAuth: true,
    underlaySourceAddress: '',
    language: 'zh',
    customResources: [],
  };
  const runOperations = async (build) => {
    const operations = build();
    calls.push(['operations', operations.resumeBrowser]);
    return operations.commit();
  };
  const dependencies = {
    register: (channel, handler) => handlers.set(channel, handler),
    loadSettings: () => ({ ...current, customResources: [...current.customResources] }),
    saveSettings: (settings) => { current = settings; calls.push(['save', settings]); return settings; },
    savePassword: (password, username) => { calls.push(['password', password, username]); return true; },
    removePassword: () => { calls.push(['remove-password']); return true; },
    runPolicyTransaction: runOperations,
    runSerialTransaction: runOperations,
    assertPersistence: () => calls.push(['assert-persistence']),
    translate: (key) => key,
    onLanguageChanged: (language) => calls.push(['language', language]),
    setStartAtLogin: (enabled) => calls.push(['login-item', enabled]),
    hasActiveEngine: () => false,
    reconnect: async () => { calls.push(['reconnect']); return { ok: true }; },
    disconnect: async () => { calls.push(['disconnect']); return { ok: true }; },
    getActiveProfileId: () => 'hkustgz',
    credentialTransactions: {
      runCredentialMutation: ({ mutate }) => {
        try { return { ok: true, value: mutate() }; }
        catch (error) { return { ok: false, error, recovery: { status: 'recovered' } }; }
      },
      applyCredentialRecoveryOutcome: (recovery, options) => {
        calls.push(['recovery', recovery?.status, options]);
        blocked = recovery?.status === 'blocked';
      },
      isCredentialTransactionBlocked: () => blocked,
      retryCredentialTransactionRecovery: () => { blocked = false; return { status: 'recovered' }; },
      ...transactionOverrides,
    },
    ...dependencyOverrides,
  };
  registerSettingsCredentialIpc(dependencies);
  return {
    calls,
    dependencies,
    handlers,
    get current() { return current; },
    set current(settings) { current = settings; },
    set blocked(value) { blocked = value; },
  };
}

test('IPC patch schema is exact and bounds credentials, Profile identity, and route domains', () => {
  assert.deepEqual(settingsPatchFromIpc({
    username: 'alice', expectedProfileId: 'hkustgz', routeDomains: [' example.test '],
  }), {
    username: 'alice',
    expectedProfileId: 'hkustgz',
    routeDomains: ['example.test'],
  });
  assert.throws(() => settingsPatchFromIpc({ token: 'forbidden' }), /未知字段/);
  assert.throws(() => settingsPatchFromIpc({ password: 'x'.repeat(4097) }), /无效/);
  assert.deepEqual(settingsPatchFromIpc({ proxyAuthMigrationAcknowledged: true }), {
    proxyAuthMigrationAcknowledged: true,
  });
  assert.deepEqual(settingsPatchFromIpc({ underlaySourceAddress: '192.0.2.4' }), {
    underlaySourceAddress: '192.0.2.4',
  });
  assert.throws(
    () => settingsPatchFromIpc({ proxyAuthMigrationAcknowledged: false }),
    /must be true/,
  );
});

test('underlay selection is a policy change and reconnects an active Engine', async () => {
  const f = fixture({ hasActiveEngine: () => true });
  const result = await f.handlers.get('save')({}, { underlaySourceAddress: '192.0.2.90' });
  assert.equal(result.ok, true);
  assert.equal(result.underlayChanged, true);
  assert.equal(result.reconnected, true);
  assert.ok(f.calls.some(([name, value]) => name === 'operations' && value === false));
  assert.ok(f.calls.some(([name]) => name === 'reconnect'));
});

test('a committed policy save returns a typed warning when reconnect fails', async () => {
  const f = fixture({
    hasActiveEngine: () => true,
    reconnect: async () => ({ ok: false, error: 'synthetic reconnect failure' }),
  });
  const result = await f.handlers.get('save')({}, { port: 6180 });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'saved_reconnect_failed');
  assert.equal(result.warning, 'synthetic reconnect failure');
  assert.equal(result.settings.port, 6180, 'the committed settings remain authoritative');
  assert.equal(result.reconnected, false);
  assert.deepEqual(result.reconnect, { attempted: true, status: 'failed' });
});

test('a reconnect exception is contained after save and reported as a typed warning', async () => {
  const f = fixture({
    hasActiveEngine: () => true,
    reconnect: async () => { throw new Error('synthetic reconnect exception'); },
  });
  const result = await f.handlers.get('save')({}, { underlaySourceAddress: '192.0.2.8' });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'saved_reconnect_failed');
  assert.equal(result.warning, 'synthetic reconnect exception');
  assert.deepEqual(result.reconnect, { attempted: true, status: 'failed' });
});

test('an inherited compatibility choice can be acknowledged without restarting the Engine', async () => {
  const f = fixture();
  f.current = {
    ...f.current,
    strictProxyAuth: false,
    proxySecurityVersion: 3,
    proxyAuthMigrationPending: true,
  };
  const result = await f.handlers.get('save')({}, { proxyAuthMigrationAcknowledged: true });
  assert.equal(result.ok, true);
  assert.equal(result.settings.strictProxyAuth, false);
  assert.equal(result.settings.proxyAuthMigrationPending, false);
  assert.equal(result.proxyAuthChanged, false);
  assert.equal(f.calls.some(([name]) => name === 'reconnect'), false);
});

test('password save uses the credential transaction and clears every request reference', async () => {
  const f = fixture();
  const payload = {
    username: 'bob', password: 'synthetic-password', expectedProfileId: 'hkustgz',
  };
  const result = await f.handlers.get('save')({}, payload);
  assert.equal(result.ok, true);
  assert.equal(result.settings.username, 'bob');
  assert.equal(payload.password, '');
  assert.deepEqual(f.calls.filter(([name]) => name === 'password'), [
    ['password', 'synthetic-password', 'bob'],
  ]);
  assert.ok(f.calls.some(([name, status]) => name === 'recovery' && status === 'committed'));
});

test('unavailable protected storage stages one Profile-bound use without plaintext persistence', async () => {
  let stagedRequest = null;
  const cleared = [];
  const f = fixture({
    credentialStorageAvailable: () => false,
    stageOneShotCredential: (request) => {
      stagedRequest = request;
      f.calls.push(['stage-one-shot', request.profileId, request.username, request.password]);
      return { ok: true, revision: 7, storage: 'memory_only' };
    },
    clearOneShotCredential: (revision) => { cleared.push(revision); return true; },
  });
  const payload = {
    username: 'bob', password: 'synthetic-password', expectedProfileId: 'hkustgz',
  };
  const result = await f.handlers.get('save')({}, payload);
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'saved_memory_only');
  assert.equal(result.credentialStorage, 'memory_only');
  assert.equal(result.warning, 'error.passwordStoreUnavailable');
  assert.equal(payload.password, '');
  assert.equal(stagedRequest.password, '', 'the transient staging request is cleared');
  assert.equal(f.calls.some(([name]) => name === 'password'), false);
  assert.deepEqual(f.calls.filter(([name]) => name === 'remove-password'), [
    ['remove-password'],
  ]);
  assert.deepEqual(cleared, []);
});

test('a failed memory-only replacement clears only its staged revision', async () => {
  const cleared = [];
  const f = fixture({
    credentialStorageAvailable: () => false,
    stageOneShotCredential: () => ({ ok: true, revision: 9, storage: 'memory_only' }),
    clearOneShotCredential: (revision) => { cleared.push(revision); return true; },
    removePassword: () => false,
  });
  const result = await f.handlers.get('save')({}, {
    username: 'bob', password: 'synthetic-password', expectedProfileId: 'hkustgz',
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'error.settingsSaveFailed');
  assert.deepEqual(cleared, [9]);
  assert.equal(f.calls.some(([name]) => name === 'save'), false);
});

test('a thrown credential transaction cannot leave a staged one-shot password live', async () => {
  const cleared = [];
  const f = fixture({
    credentialStorageAvailable: () => false,
    stageOneShotCredential: () => ({ ok: true, revision: 10, storage: 'memory_only' }),
    clearOneShotCredential: (revision) => { cleared.push(revision); return true; },
    credentialTransactions: {
      runCredentialMutation: ({ mutate }) => { mutate(); throw new Error('transaction crashed'); },
    },
  });
  const result = await f.handlers.get('save')({}, {
    username: 'bob', password: 'synthetic-password', expectedProfileId: 'hkustgz',
  });
  assert.equal(result.ok, false);
  assert.deepEqual(cleared, [10]);
});

test('queued credential save rechecks Profile identity before staging or persistence', async () => {
  let activeProfileId = 'hkustgz';
  let f;
  f = fixture({
    getActiveProfileId: () => activeProfileId,
    credentialStorageAvailable: () => false,
    stageOneShotCredential: () => {
      f.calls.push(['stage-one-shot']);
      return { ok: true, revision: 1, storage: 'memory_only' };
    },
    clearOneShotCredential: () => true,
    runSerialTransaction: async (build) => {
      activeProfileId = 'school-b';
      return build().commit();
    },
  });
  const payload = {
    username: 'bob', password: 'synthetic-password', expectedProfileId: 'hkustgz',
  };
  const result = await f.handlers.get('save')({}, payload);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'error.profileCredentialContextChanged');
  assert.equal(f.calls.some(([name]) => name === 'stage-one-shot' || name === 'password' ||
    name === 'save'), false);
  assert.equal(payload.password, '');
});

test('password plus network policy is rejected before writes and clears the payload', async () => {
  const f = fixture();
  const payload = { password: 'synthetic-password', port: 6180, expectedProfileId: 'hkustgz' };
  const result = await f.handlers.get('save')({}, payload);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'error.credentialPolicyCombined');
  assert.equal(payload.password, '');
  assert.equal(f.calls.some(([name]) => name === 'save' || name === 'password'), false);
});

test('policy save rebases in its queue, keeps latest resources, and reconnects current Engine', async () => {
  let f;
  const runPolicyTransaction = async (build) => {
    f.current = {
      ...f.current,
      customResources: [{
        id: 'latest',
        name: 'Latest',
        url: 'https://latest.example.test/',
        description: 'fixture',
        route: 'direct',
      }],
    };
    const operations = build();
    f.calls.push(['resume-browser', operations.resumeBrowser]);
    return operations.commit();
  };
  f = fixture({
    runPolicyTransaction,
    hasActiveEngine: () => true,
  });
  const result = await f.handlers.get('save')({}, { port: 6180 });
  assert.equal(result.ok, true);
  assert.equal(result.reconnected, true);
  assert.equal(result.settings.customResources[0].id, 'latest');
  assert.ok(f.calls.some(([name, value]) => name === 'resume-browser' && value === false));
  assert.ok(f.calls.some(([name]) => name === 'reconnect'));
});

test('language and login-item effects run only after a successful settings commit', async () => {
  const f = fixture();
  const result = await f.handlers.get('save')({}, { language: 'en', startAtLogin: true });
  assert.equal(result.ok, true);
  assert.ok(f.calls.some(([name, value]) => name === 'language' && value === 'en'));
  assert.ok(f.calls.some(([name, value]) => name === 'login-item' && value === true));
});

test('username changes without a password fail and credential recovery errors stay stable', async () => {
  const f = fixture();
  const username = await f.handlers.get('save')({}, {
    username: 'bob', expectedProfileId: 'hkustgz',
  });
  assert.equal(username.ok, false);
  assert.equal(username.error, 'error.usernameNeedsPassword');

  const failed = fixture({
    credentialTransactions: {
      runCredentialMutation: () => ({
        ok: false,
        recovery: { status: 'credential-cleared' },
        error: { credentialStoreUnavailable: true },
      }),
    },
  });
  const payload = { password: 'synthetic-password', expectedProfileId: 'hkustgz' };
  const result = await failed.handlers.get('save')({}, payload);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'error.settingsSaveFailedPasswordCleared');
  assert.equal(payload.password, '');
});

test('credential save rejects an inactive or stale Profile before any write', async () => {
  const f = fixture();
  const payload = {
    username: 'bob', password: 'synthetic-password', expectedProfileId: 'school-b',
  };
  const result = await f.handlers.get('save')({}, payload);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'error.profileCredentialContextChanged');
  assert.equal(payload.password, '');
  assert.equal(f.calls.some(([name]) => name === 'save' || name === 'password'), false);
});

test('logout stops the Engine then atomically removes credential and username', async () => {
  const f = fixture();
  const result = await f.handlers.get('logout')();
  assert.equal(result.ok, true);
  assert.equal(result.settings.username, '');
  assert.deepEqual(f.calls.filter(([name]) => (
    name === 'disconnect' || name === 'remove-password'
  )), [['disconnect'], ['remove-password']]);
});

test('logout clears an unconsumed one-shot credential after the Engine stops', async () => {
  const calls = [];
  const f = fixture({
    credentialStorageAvailable: () => false,
    stageOneShotCredential: () => ({ ok: true, revision: 1, storage: 'memory_only' }),
    clearOneShotCredential: (revision) => { calls.push(['clear-one-shot', revision]); return true; },
  });
  const result = await f.handlers.get('logout')();
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [['clear-one-shot', undefined]]);
});

test('blocked logout retries recovery and never mutates while the block remains', async () => {
  const f = fixture({ credentialTransactions: {
    retryCredentialTransactionRecovery: () => ({ status: 'blocked' }),
  } });
  f.blocked = true;
  const result = await f.handlers.get('logout')();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'error.credentialRecoveryBlocked');
  assert.equal(f.calls.some(([name]) => name === 'remove-password'), false);
});
