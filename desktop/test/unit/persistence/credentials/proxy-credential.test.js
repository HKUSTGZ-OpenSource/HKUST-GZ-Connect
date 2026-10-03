'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const util = require('node:util');
const path = require('node:path');
const {
  EphemeralProxyCredential,
  ProxyAccessCoordinator,
  RANDOM_SECRET_BYTES,
  cleanupProxyAccessForEngineClose,
} = require('../../../../lib/persistence/credentials/proxy-credential');

function deterministicCredential() {
  let value = 0;
  return new EphemeralProxyCredential({
    randomBytes: (length) => Buffer.alloc(length, ++value),
  });
}

test('ephemeral proxy secrets are bounded, generation-scoped, and redacted', () => {
  const credential = deterministicCredential();
  assert.equal(credential.bindGeneration(7, 6180), true);
  assert.equal(credential.bindGeneration(8, 6180), false);
  const lines = credential.stdinSuffix(7).trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(Buffer.from(lines[0], 'base64url').length, RANDOM_SECRET_BYTES);
  assert.equal(Buffer.from(lines[1], 'base64url').length, RANDOM_SECRET_BYTES);
  assert.notEqual(lines[0], lines[1]);
  assert.doesNotMatch(util.inspect(credential), new RegExp(lines[0]));
  assert.doesNotMatch(JSON.stringify(credential), new RegExp(lines[1]));
  assert.throws(() => credential.stdinSuffix(8), /unavailable/);
});

test('only the exact current campus HTTP proxy challenge receives credentials', () => {
  const credential = deterministicCredential();
  credential.bindGeneration(12, 6180);
  const [expectedUser, expectedPassword] = credential.stdinSuffix(12).trimEnd().split('\n');
  const answers = [];
  const answer = (authInfo, generation = 12) => credential.answerProxyChallenge(
    authInfo,
    generation,
    (username, password) => answers.push([username, password]),
  );
  const exact = { isProxy: true, scheme: 'basic', host: '127.0.0.1', port: 6180 };
  assert.equal(answer(exact), true);
  assert.deepEqual(answers, [[expectedUser, expectedPassword]]);
  for (const rejected of [
    { ...exact, isProxy: false },
    { ...exact, scheme: 'digest' },
    { ...exact, host: 'localhost' },
    { ...exact, port: 1080 },
  ]) assert.equal(answer(rejected), false);
  assert.equal(answer(exact, 13), false);
  assert.equal(answers.length, 1);
});

test('destroy synchronously zeroes borrowed buffers and makes every use inert', () => {
  const credential = deterministicCredential();
  credential.bindGeneration(4, 6180);
  const borrowed = credential.socksAuthentication(4);
  assert.ok(borrowed.username.some((byte) => byte !== 0));
  assert.equal(credential.destroy(3), false);
  assert.equal(credential.destroy(4), true);
  assert.ok(borrowed.username.every((byte) => byte === 0));
  assert.ok(borrowed.password.every((byte) => byte === 0));
  assert.equal(credential.socksAuthentication(4), null);
  assert.equal(credential.answerProxyChallenge({}, 4, () => {}), false);
  assert.equal(credential.destroy(), false);
});

test('credential creation fails closed if entropy does not match the contract', () => {
  assert.throws(() => new EphemeralProxyCredential({ randomBytes: () => 'secret' }), /generation/);
  assert.throws(() => new EphemeralProxyCredential({
    randomBytes: () => Buffer.alloc(RANDOM_SECRET_BYTES - 1),
  }), /generation/);
});

test('a stable credential can be copied into a generation without sharing backing buffers', () => {
  const injected = {
    username: Buffer.from('A'.repeat(32)),
    password: Buffer.from('B'.repeat(32)),
  };
  const credential = new EphemeralProxyCredential({ credential: injected });
  assert.equal(credential.bindGeneration(20, 6180), true);
  injected.username.fill(0);
  injected.password.fill(0);
  assert.equal(
    credential.stdinSuffix(20),
    `${'A'.repeat(32)}\n${'B'.repeat(32)}\n`,
  );
  credential.destroy(20);
});

test('a stale Engine close cannot remove a newer generation proxy sidecar', () => {
  for (const current of [
    { supervisorGenerationCurrent: false, connectionGenerationCurrent: true },
    { supervisorGenerationCurrent: true, connectionGenerationCurrent: false },
  ]) {
    const cleared = [];
    let removals = 0;
    assert.equal(cleanupProxyAccessForEngineClose({
      generation: 31,
      ...current,
      clearCredential: (generation) => { cleared.push(generation); },
      removeSidecar: () => { removals += 1; },
    }), false);
    assert.deepEqual(cleared, [31]);
    assert.equal(removals, 0);
  }

  const cleared = [];
  let removals = 0;
  assert.equal(cleanupProxyAccessForEngineClose({
    generation: 32,
    supervisorGenerationCurrent: true,
    connectionGenerationCurrent: true,
    clearCredential: (generation) => { cleared.push(generation); },
    removeSidecar: () => { removals += 1; },
  }), true);
  assert.deepEqual(cleared, [32]);
  assert.equal(removals, 1);
});

function proxyAccessFixture(overrides = {}) {
  const calls = [];
  let loaded = 0;
  const stable = {
    destroyed: false,
    copyForEngine() {
      calls.push('copy');
      return { username: Buffer.from('A'.repeat(32)), password: Buffer.from('B'.repeat(32)) };
    },
    destroy() { this.destroyed = true; calls.push('destroy-stable'); return true; },
  };
  const sidecarFile = path.resolve('synthetic-proxy-sidecar');
  const dependencies = {
    store: { loadOrCreate: () => { loaded++; calls.push('load'); return stable; } },
    sidecarFile,
    fileSystem: { unlinkSync: (file) => { calls.push(['remove', file]); } },
    currentProfileId: () => 'synthetic-profile',
    writeSidecar: (options) => { calls.push(['sidecar', options]); return true; },
    ...overrides,
  };
  return { owner: new ProxyAccessCoordinator(dependencies), calls, stable, sidecarFile,
    loadCount: () => loaded, dependencies };
}

test('proxy access owns one stable credential and zeroes every copied Engine input', () => {
  const f = proxyAccessFixture();
  assert.equal(f.owner.hasStable(), false);
  const stable = f.owner.ensureSidecar(6180);
  assert.equal(stable, f.stable);
  assert.equal(f.owner.ensureSidecar(6180), stable);
  assert.equal(f.loadCount(), 1);
  const sidecarCalls = f.calls.filter(value => Array.isArray(value) && value[0] === 'sidecar');
  assert.equal(sidecarCalls.length, 2);
  assert.deepEqual(sidecarCalls[0][1], {
    filePath: f.sidecarFile, port: 6180, credential: f.stable,
    profileId: 'synthetic-profile',
  });
  let copied;
  f.owner.createEphemeral = ({ credential }) => {
    copied = credential;
    return new EphemeralProxyCredential({ credential });
  };
  const generation = f.owner.generationCredential(6180);
  assert.ok(copied.username.every(byte => byte === 0));
  assert.ok(copied.password.every(byte => byte === 0));
  assert.equal(generation.bindGeneration(7, 6180), true);
  assert.equal(generation.stdinSuffix(7), `${'A'.repeat(32)}\n${'B'.repeat(32)}\n`);
  assert.doesNotMatch(util.inspect(f.owner), /A{32}|B{32}/u);
  generation.destroy(7);
});

test('a failed Engine credential constructor still zeroes both copied buffers', () => {
  const f = proxyAccessFixture();
  let copied;
  f.owner.createEphemeral = ({ credential }) => {
    copied = credential;
    throw new Error('synthetic injection failure');
  };
  assert.throws(() => f.owner.generationCredential(6180), /synthetic injection failure/u);
  assert.ok(copied.username.every(byte => byte === 0));
  assert.ok(copied.password.every(byte => byte === 0));
});

test('store or sidecar failure cannot publish an Engine credential', () => {
  const unavailable = new Error('synthetic protected store unavailable');
  let writes = 0;
  const failedStore = proxyAccessFixture({
    store: { loadOrCreate: () => { throw unavailable; } },
    writeSidecar: () => { writes++; },
  });
  assert.throws(() => failedStore.owner.generationCredential(6180), error => error === unavailable);
  assert.equal(writes, 0);
  assert.equal(failedStore.owner.hasStable(), false);

  const failedSidecar = proxyAccessFixture({
    writeSidecar: () => { writes++; throw new Error('synthetic private sidecar denied'); },
  });
  assert.throws(() => failedSidecar.owner.generationCredential(6180),
    /synthetic private sidecar denied/u);
  assert.equal(writes, 1);
  assert.ok(failedSidecar.owner.hasStable());
  assert.ok(!failedSidecar.calls.includes('copy'),
    'Engine secret copy must follow the confirmed private sidecar write');
  assert.equal(failedSidecar.owner.revoke(), true);
  assert.ok(failedSidecar.stable.destroyed);
});

test('proxy access retires only its generation and gates exact Basic challenge', () => {
  const f = proxyAccessFixture();
  const active = f.owner.generationCredential(6180);
  assert.equal(active.bindGeneration(9, 6180), true);
  f.owner.setActive(active);
  const info = { isProxy: true, scheme: 'basic', host: '127.0.0.1', port: 6180 };
  const answers = [];
  assert.equal(f.owner.matchesProxyChallenge(info, 9), true);
  assert.equal(f.owner.answerProxyChallenge(info, 9,
    (username, password) => answers.push([username, password])), true);
  assert.deepEqual(answers, [[ 'A'.repeat(32), 'B'.repeat(32) ]]);
  assert.equal(f.owner.clearActive(8), false);
  assert.equal(f.owner.matchesProxyChallenge(info, 9), true);
  assert.equal(f.owner.clearActive(9), true);
  assert.equal(f.owner.matchesProxyChallenge(info, 9), false);
  assert.equal(f.owner.socksAuthentication(9), null);
});

test('revocation zeroes both owners even when sidecar removal fails', () => {
  const denied = new Error('synthetic permission denied');
  denied.code = 'EPERM';
  const f = proxyAccessFixture({ fileSystem: { unlinkSync: () => { throw denied; } } });
  const active = f.owner.generationCredential(6180);
  assert.equal(active.bindGeneration(11, 6180), true);
  const borrowed = active.socksAuthentication(11);
  f.owner.setActive(active);
  assert.equal(f.owner.revoke(), false);
  assert.equal(f.owner.hasStable(), false);
  assert.ok(f.stable.destroyed);
  assert.ok(borrowed.username.every(byte => byte === 0));
  assert.ok(borrowed.password.every(byte => byte === 0));
  assert.equal(f.owner.socksAuthentication(11), null);
  assert.equal(f.owner.revoke(), false);
});

test('quit destroys the stable secret and treats absent sidecar as removed', () => {
  const absent = new Error('synthetic absent');
  absent.code = 'ENOENT';
  const f = proxyAccessFixture({ fileSystem: { unlinkSync: () => { throw absent; } } });
  f.owner.loadStable();
  assert.equal(f.owner.disposeForQuit(), true);
  assert.equal(f.owner.hasStable(), false);
  assert.ok(f.stable.destroyed);
});
