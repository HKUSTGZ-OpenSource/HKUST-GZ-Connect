'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const util = require('node:util');
const test = require('node:test');
const { DesktopPersistenceRuntime } = require('../../../../lib/persistence/runtime/desktop-persistence-runtime');
const { ProxyAccessCoordinator } = require('../../../../lib/persistence/credentials/proxy-credential');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-proxy-composition-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let profile = 'synthetic-profile-a';
  let entropy = 0;
  const observations = { reads: 0, encrypts: 0, sidecars: [] };
  const credentialFile = path.join(root, 'credential.enc');
  const sidecarFile = path.join(root, 'helper.json');
  const configuration = {
    credentialStore: {
      filePath: credentialFile, platform: process.platform,
      safeStorage: {
        isEncryptionAvailable: () => { observations.reads++; return true; },
        getSelectedStorageBackend: () => 'kwallet',
        encryptString: value => { observations.encrypts++; return Buffer.from(value); },
        decryptString: bytes => bytes.toString(),
      },
      randomBytes: length => Buffer.alloc(length, ++entropy),
      ...options.credentialStore,
    },
    sidecarFile, currentProfileId: () => profile,
    writeSidecar: request => {
      observations.sidecars.push({ filePath: request.filePath, profileId: request.profileId, port: request.port });
      fs.writeFileSync(request.filePath, 'synthetic-sidecar', { mode: 0o600 });
    },
  };
  const create = () => {
    const owner = DesktopPersistenceRuntime.createProxyAccess(configuration);
    t.after(() => { owner.clearActive(); owner.disposeForQuit(); });
    return owner;
  };
  const owner = create();
  return { owner, observations, credentialFile, sidecarFile, create, setProfile: value => { profile = value; } };
}

test('public proxy-access composition constructs the original owner without storage effects', t => {
  const f = fixture(t);
  assert.ok(f.owner instanceof ProxyAccessCoordinator);
  assert.equal(f.owner.hasStable(), false);
  assert.equal(fs.existsSync(f.credentialFile), false);
  assert.deepEqual(f.observations, { reads: 0, encrypts: 0, sidecars: [] });
  assert.throws(() => DesktopPersistenceRuntime.createProxyAccess({}), TypeError);
});

test('one stable store survives owner recreation while Engine copies keep generation and zeroization', t => {
  const f = fixture(t);
  const first = f.owner.generationCredential(6180);
  assert.equal(first.bindGeneration(8, 6180), true);
  f.owner.setActive(first);
  assert.equal(f.owner.hasStable(), true);
  assert.equal(f.observations.encrypts, 1);
  const reference = f.owner.loadStable().reference();
  const borrowed = f.owner.socksAuthentication(8);
  assert.equal(f.owner.socksAuthentication(9), null);
  assert.equal(f.owner.clearActive(9), false);
  assert.ok(borrowed.username.some(byte => byte !== 0));
  assert.equal(f.owner.clearActive(8), true);
  assert.ok(borrowed.username.every(byte => byte === 0));
  assert.ok(borrowed.password.every(byte => byte === 0));
  f.owner.disposeForQuit();
  assert.equal(fs.existsSync(f.sidecarFile), false);
  assert.equal(fs.existsSync(f.credentialFile), true, 'quit must not delete the stable encrypted store');
  assert.equal(f.create().loadStable().reference(), reference);
  assert.equal(f.observations.encrypts, 1, 'the existing encrypted credential must not be regenerated');
});

test('sidecar uses the current Profile and the existing exact loopback challenge contract', t => {
  const f = fixture(t);
  f.setProfile('synthetic-profile-b');
  const active = f.owner.generationCredential(7180);
  assert.equal(active.bindGeneration(10, 7180), true);
  f.owner.setActive(active);
  assert.deepEqual(f.observations.sidecars, [{
    filePath: f.sidecarFile, profileId: 'synthetic-profile-b', port: 7180,
  }]);
  const exact = { isProxy: true, scheme: 'basic', host: '127.0.0.1', port: 7180 };
  let answers = 0;
  assert.equal(f.owner.answerProxyChallenge(exact, 10, () => { answers++; }), true);
  for (const challenge of [{ ...exact, host: 'localhost' }, { ...exact, port: 6180 },
    { ...exact, isProxy: false }, { ...exact, scheme: 'digest' }]) {
    assert.equal(f.owner.answerProxyChallenge(challenge, 10, () => { answers++; }), false);
  }
  assert.equal(f.owner.answerProxyChallenge(exact, 11, () => { answers++; }), false);
  assert.equal(answers, 1);
  assert.equal(f.owner.revoke(), true);
  assert.equal(f.owner.hasStable(), false);
  assert.equal(f.owner.socksAuthentication(10), null);
  assert.equal(fs.existsSync(f.sidecarFile), false);
});

test('typed protected-store unavailability publishes neither sidecar nor active credential', t => {
  const f = fixture(t, { credentialStore: {
    safeStorage: { isEncryptionAvailable: () => false },
  } });
  assert.throws(() => f.owner.generationCredential(6180), error =>
    error.code === 'PROXY_CREDENTIAL_STORAGE_UNAVAILABLE');
  assert.equal(f.owner.hasStable(), false);
  assert.equal(fs.existsSync(f.credentialFile), false);
  assert.equal(fs.existsSync(f.sidecarFile), false);
});

test('the public Engine-close entrypoint keeps stale sidecars and clears only the captured generation', () => {
  for (const current of [false, true]) {
    const effects = [];
    assert.equal(DesktopPersistenceRuntime.cleanupProxyAccessForEngineClose({
      generation: 21, supervisorGenerationCurrent: current, connectionGenerationCurrent: true,
      clearCredential: generation => effects.push(['clear', generation]),
      removeSidecar: () => effects.push(['sidecar']),
    }), current);
    assert.deepEqual(effects, current ? [['clear', 21], ['sidecar']] : [['clear', 21]]);
  }
});

test('public composition diagnostics remain redacted and do not expose storage paths', t => {
  const f = fixture(t);
  f.owner.loadStable();
  for (const view of [JSON.stringify(f.owner), util.inspect(f.owner)]) {
    assert.match(view, /redacted/);
    assert.doesNotMatch(view, /credential\.enc|helper\.json|synthetic-profile/);
    assert.equal(view.includes(path.dirname(f.credentialFile)), false);
  }
});
