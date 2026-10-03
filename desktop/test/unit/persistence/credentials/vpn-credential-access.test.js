'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const util = require('node:util');
const { DesktopPersistenceRuntime } = require('../../../../lib/persistence/runtime/desktop-persistence-runtime');

function fixture(t, { platform = 'darwin' } = {}) {
  const state = { profile: 'profile-a', persistent: false, engine: false,
    owner: null, error: null, available: true, backend: 'kwallet' };
  const calls = { profile: 0, engine: 0, opened: 0, storage: 0 };
  const access = DesktopPersistenceRuntime.createVpnCredentialAccess({
    persistence: {
      hasCredential: () => state.persistent,
      openCredential: () => {
        calls.opened++;
        if (state.error) throw state.error;
        return state.owner;
      },
    },
    getProfileId: () => { calls.profile++; return state.profile; },
    getEngineActive: () => { calls.engine++; return state.engine; },
    safeStorage: {
      isEncryptionAvailable: () => { calls.storage++; return state.available; },
      getSelectedStorageBackend: () => state.backend,
    },
    platform,
  });
  t.after(() => access.clear());
  return { access, state, calls };
}

function stage(access) {
  return access.stage({ profileId: 'profile-a', username: 'fixture-account', password: 'fixture-password' });
}

test('public credential access construction and presence checks do not decrypt or probe storage', t => {
  const f = fixture(t);
  assert.deepEqual(f.calls, { profile: 0, engine: 0, opened: 0, storage: 0 });
  assert.equal(f.access.hasPersistent(), false);
  f.state.persistent = true;
  assert.equal(f.access.hasStored(), true);
  assert.equal(f.access.hasCredentialForCurrentSession(), true);
  assert.deepEqual(f.calls, { profile: 0, engine: 0, opened: 0, storage: 0 });
  assert.throws(() => DesktopPersistenceRuntime.createVpnCredentialAccess({}), TypeError);
});

test('memory access retains exact Profile binding and mismatched open retires the entry', t => {
  const f = fixture(t);
  stage(f.access);
  assert.equal(f.access.hasOneShot(), true);
  assert.equal(f.access.hasStored(), true);
  f.state.profile = 'profile-b';
  assert.equal(f.access.hasOneShot(), false);
  assert.equal(f.access.open('profile-b'), null);
  f.state.profile = 'profile-a';
  assert.equal(f.access.hasOneShot(), false);
});

test('valid persistent ownership wins and only typed unavailability uses staged memory', t => {
  const f = fixture(t);
  stage(f.access);
  const persistent = { withStrings() {}, destroy() {} };
  f.state.owner = persistent;
  assert.equal(f.access.open('profile-a'), persistent);
  assert.equal(f.access.hasOneShot(), true, 'persistent selection must not consume staged memory');
  f.state.error = Object.assign(new Error('synthetic protected store failure'), { credentialStatus: 'unavailable' });
  const owner = f.access.open('profile-a');
  assert.equal(f.calls.opened, 2, 'each final snapshot must ask the current persistence owner');
  assert.deepEqual(owner.withStrings((username, password) => [username, password]),
    ['fixture-account', 'fixture-password']);
  assert.throws(() => owner.withStrings(() => {}), /unavailable/);
});

test('corrupt decrypt and retired-context failures cannot fall back or change error identity', t => {
  const f = fixture(t);
  stage(f.access);
  for (const credentialStatus of ['corrupt', 'decrypt_failed', 'recovery_blocked', 'profile_stale']) {
    f.state.error = Object.assign(new Error('synthetic refusal'), { credentialStatus });
    assert.throws(() => f.access.open('profile-a'), error => error === f.state.error);
  }
  f.access.clear();
  f.state.error = Object.assign(new Error('synthetic unavailable without memory'), { credentialStatus: 'unavailable' });
  assert.throws(() => f.access.open('profile-a'), error => error === f.state.error);
});

test('primitive validation localized error keys and basic-text refusal retain existing policy', t => {
  const f = fixture(t, { platform: 'linux' });
  assert.equal(f.access.parseField(42, 'Account'), '42');
  assert.throws(() => f.access.parseField('fixture\naccount', 'Account'), /控制字符/);
  assert.equal(f.access.errorKey('corrupt'), 'error.credentialStoreCorrupt');
  assert.equal(f.access.errorKey('decrypt_failed'), 'error.credentialDecryptFailed');
  assert.equal(f.access.errorKey('unknown'), 'error.credentialStoreUnavailable');
  f.state.backend = 'basic_text';
  assert.equal(f.access.storageAvailable(), false);
  f.state.backend = 'kwallet';
  assert.equal(f.access.storageAvailable(), true);
  f.state.available = false;
  assert.equal(f.access.storageAvailable(), false);
});

test('replacement revision scoped clearing and diagnostics do not reveal memory inputs', t => {
  const f = fixture(t);
  const first = stage(f.access);
  const next = stage(f.access);
  assert.ok(next.revision > first.revision);
  assert.equal(f.access.clear(first.revision), false);
  assert.equal(f.access.hasOneShot(), true);
  for (const text of [JSON.stringify(f.access), String(f.access), util.inspect(f.access)]) {
    assert.match(text, /redacted/);
    assert.doesNotMatch(text, /fixture-account|fixture-password|profile-a/);
  }
  assert.equal(f.access.clear(next.revision), true);
  assert.equal(f.access.clear(), false);
});

test('active Engine and retired Profile checks preserve their original short-circuit behavior', t => {
  const f = fixture(t);
  f.state.engine = true;
  assert.equal(f.access.hasCredentialForCurrentSession(), true);
  assert.equal(f.calls.opened, 0);
  f.state.profile = null;
  assert.equal(f.access.hasOneShot(), false);
  assert.equal(f.access.hasCredentialForCurrentSession(), true);
});

test('login account reads fresh settings identity only when a credential/session is absent', t => {
  const f = fixture(t);
  let username = 'fixture-login-a', reads = 0;
  const readSettings = () => { reads++; return {
    username, get password() { throw new Error('login presentation must not read a secret'); },
  }; };
  assert.deepEqual(f.access.loginAccount(readSettings), { ok: true, username });
  username = 'fixture-login-b';
  assert.deepEqual(f.access.loginAccount(readSettings), { ok: true, username });
  assert.equal(reads, 2);
  assert.equal(f.calls.opened, 0);
  assert.equal(f.calls.storage, 0);
});

test('persistent memory and active-Engine login suppression retain original short-circuit order', t => {
  for (const kind of ['persistent', 'memory', 'engine']) {
    const f = fixture(t);
    if (kind === 'persistent') f.state.persistent = true;
    if (kind === 'memory') stage(f.access);
    if (kind === 'engine') f.state.engine = true;
    assert.deepEqual(f.access.loginAccount(() => { throw new Error('must not read settings'); }),
      { ok: false, username: '' });
    assert.equal(f.calls.opened, 0);
    assert.equal(f.calls.storage, 0);
    assert.equal(f.calls.engine, kind === 'engine' ? 1 : 0);
  }
  const f = fixture(t);
  stage(f.access);
  f.state.profile = 'profile-b';
  assert.deepEqual(f.access.loginAccount(() => ({ username: 'fixture-profile-b' })),
    { ok: true, username: 'fixture-profile-b' });
});

test('login presentation failures stay bounded and never open credential material', t => {
  const f = fixture(t);
  for (const readSettings of [undefined, () => null, () => { throw new Error('synthetic settings refusal'); }]) {
    assert.deepEqual(f.access.loginAccount(readSettings), { ok: false, username: '' });
  }
  f.access.hasCredentialForCurrentSession = () => { throw new Error('synthetic presence refusal'); };
  assert.deepEqual(f.access.loginAccount(() => { throw new Error('must not read'); }),
    { ok: false, username: '' });
  assert.equal(f.calls.opened, 0);
  assert.equal(f.calls.storage, 0);
});
