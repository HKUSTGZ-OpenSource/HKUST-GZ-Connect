'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const test = require('node:test');
const { EngineAttemptCoordinator } = require('../../../../lib/connection/engine/engine-process');
const { ConnectionStateMachine } = require('../../../../lib/connection/state/connection-state-machine');
const { openVpnCredential } = require('../../../../lib/persistence/credentials/one-shot-vpn-credential');
const { parseCredentialField } = require('../../../../lib/persistence/settings/settings-update');

function fixture() {
  const f = { trace: [], writes: [], config: { port: 6180, strictProxyAuth: false },
    account: 'synthetic-user', password: 'synthetic-password', state: {}, blocked: false,
    bindingValid: true, destroyed: 0, generation: 7, persistent: true, proxyNeeded: false };
  const machine = new ConnectionStateMachine();
  f.intent = machine.beginConnectIntent(); f.machine = machine;
  const child = { stdin: new EventEmitter(), stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 12345 };
  child.stdin.write = value => { f.trace.push('stdin'); f.writes.push(value); return true; };
  f.supervisor = { hasActive: false, currentGeneration: 6,
    start: options => {
      f.trace.push('spawn'); f.launch = options;
      f.supervisor.currentGeneration = f.generation; f.supervisor.hasActive = true;
      return { ok: true, generation: f.generation, child };
    }, stop: async () => { f.trace.push('stop'); return { ok: true }; } };
  const credential = () => ({
    withStrings: callback => { f.trace.push('credential-strings'); callback(f.account, f.password); },
    destroy: () => { f.destroyed += 1; f.trace.push('credential-destroy'); },
  });
  f.owner = new EngineAttemptCoordinator({
    engineSupervisor: f.supervisor, connectionState: machine,
    appIsPackaged: false, baseDirectory: '/synthetic/desktop', platform: 'darwin',
    getState: () => f.state, getTranslator: () => key => key,
    getLogWriter: () => ({ reset: () => { f.trace.push('log-reset'); return f.logWait || Promise.resolve(); },
      append: () => f.trace.push('log-append') }),
    isCredentialTransactionBlocked: () => f.blocked,
    retryCredentialTransactionRecovery: () => ({ status: f.blocked ? 'blocked' : 'none' }),
    loadSettingsOrReport: () => f.config,
    loadSettings: () => { f.trace.push('settings'); return f.config; },
    reportSettingsReadFailure: () => f.trace.push('settings-error'), reportLogFailure: () => f.trace.push('log-error'),
    emit: () => f.trace.push('emit'),
    networkEnvironment: {
      refresh: async (_source, options) => { assert.equal(options.probePublicEgress, false); f.trace.push('network'); await f.networkWait; },
      engineArguments: () => [],
    },
    profile: {
      verifyEngineLaunchBinding: () => {
        f.trace.push('verify-profile');
        if (!f.bindingValid) throw new Error('synthetic profile invalid');
        queueMicrotask(() => f.trace.push('snapshot-microtask'));
        return { path: '/synthetic/profile.json', stdinFrame: 'synthetic-binding-frame' };
      }, activeContextBinding: () => ({ profileId: 'synthetic-school' }),
      clearCapabilitySnapshot: () => {}, observeCapabilityReport: () => false,
    },
    openCredential: profileId => openVpnCredential({ profileId,
      openPersistent: () => { f.trace.push('persistent-open');
        if (f.protectedUnavailable) throw Object.assign(new Error('synthetic unavailable'), { credentialStatus: 'unavailable' });
        return f.persistent ? credential() : null; },
      memoryBroker: { open: options => { f.trace.push(['memory-open', options]); return credential(); } },
    }),
    credentialLoadErrorKey: status => status, parseCredentialField,
    enginePath: () => '/synthetic/engine',
    fileSystem: { existsSync: file => file === '/synthetic/engine', realpathSync: file => file },
    resolveLaunch: () => ({ command: '/synthetic/engine', argsPrefix: [], options: {}, synthetic: true }),
    clearActiveProxyCredential: () => f.trace.push('clear-proxy'),
    generationProxyCredential: () => ({
      bindGeneration: () => f.proxyBindingValid !== false,
      stdinSuffix: () => 'synthetic-proxy-user\nsynthetic-proxy-password\n',
      destroy: () => f.trace.push('destroy-proxy'),
    }),
    removeExternalProxySidecar: () => f.trace.push('remove-sidecar'), killStrayEngines: () => true,
    hasStableProxyCredential: () => f.proxyNeeded, proxyCredentialFile: '/synthetic/proxy.json',
    setActiveProxyCredential: () => f.trace.push('bind-proxy'), engineOwnerFile: '/synthetic/owner.json',
    activeEngineContextCurrent: (generation, token) => generation === f.supervisor.currentGeneration && token?.engineGeneration === generation,
    getBrowser: () => ({ routingSuspended: false }), revokeEngineServing: () => true,
    handleEngineExitBoundary: () => f.trace.push('exit'), handleEngineClose: () => f.trace.push('close'),
    controlRegistry: { bind: () => {
      f.trace.push('control-bind');
      return { feed() {}, handshake: async () => { f.trace.push('handshake'); }, providerCapabilities: async () => ({}) };
    } },
    contextLease: { capture: options => { f.trace.push('capture-context'); return options; } },
    onFirstConnected: () => f.trace.push('first-connected'),
    writeOwnerRecord: () => f.trace.push('owner-write'), removeOwnerRecord: () => f.trace.push('owner-remove'),
  });
  f.finish = () => { f.launch?.onClose({ code: 0, generation: f.generation }); f.supervisor.hasActive = false; };
  return f;
}

test('attempt owner remains a bounded existing Engine module', () => {
  const source = fs.readFileSync(require.resolve('../../../../lib/connection/engine/engine-process'), 'utf8');
  assert(source.trimEnd().split('\n').length <= 600);
});

test('final snapshot stays synchronous through private stdin and precedes handshake', async t => {
  const f = fixture(); t.after(f.finish);
  assert.equal((await f.owner.run(false, f.intent)).ok, true);
  const position = name => f.trace.indexOf(name);
  assert(position('verify-profile') < position('persistent-open'));
  assert(position('credential-destroy') < position('spawn'));
  assert(position('capture-context') < position('stdin'));
  assert(position('stdin') < position('handshake'));
  assert(position('stdin') < position('snapshot-microtask'), 'snapshot-to-stdin must not yield');
  assert.equal(f.destroyed, 1);
  assert.equal(f.writes[0], 'synthetic-binding-frame\nsynthetic-user\nsynthetic-password\n');
  assert.equal(f.launch.args.some(value => value.includes(f.password) || value.includes(f.account)), false);
  assert.equal(JSON.stringify(f.owner).includes(f.password), false);
});

test('changes while log reset is pending enter the final settings and credential snapshot', async t => {
  const f = fixture(); t.after(f.finish);
  let finishLog;
  f.logWait = new Promise(resolve => { finishLog = resolve; });
  const pending = f.owner.run(false, f.intent);
  await new Promise(setImmediate);
  assert.equal(f.trace.includes('persistent-open'), false);
  f.config = { port: 6181, strictProxyAuth: false };
  f.account = 'synthetic-next-user'; f.password = 'synthetic-next-password';
  finishLog();
  assert.equal((await pending).ok, true);
  assert(f.launch.args.includes('127.0.0.1:6181'));
  assert.equal(f.writes[0], 'synthetic-binding-frame\nsynthetic-next-user\nsynthetic-next-password\n');
});

test('invalid Profile binding never opens either credential source or starts a process', async () => {
  const f = fixture(); f.bindingValid = false;
  assert.equal((await f.owner.run(false, f.intent)).profileConfigInvalid, true);
  assert.equal(f.trace.includes('persistent-open'), false);
  assert.equal(f.trace.some(value => Array.isArray(value) && value[0] === 'memory-open'), false);
  assert.equal(f.launch, undefined);
});

test('intent invalidation during underlay inspection prevents credential access and spawn', async () => {
  const f = fixture(); let finishNetwork;
  f.networkWait = new Promise(resolve => { finishNetwork = resolve; });
  const pending = f.owner.run(false, f.intent);
  f.machine.beginStop(false); finishNetwork();
  assert.equal((await pending).stale, true);
  assert.equal(f.trace.includes('persistent-open'), false);
  assert.equal(f.launch, undefined);
});

test('memory-only fallback stays Profile-bound and destroys its credential owner', async t => {
  const f = fixture(); t.after(f.finish); f.persistent = false;
  assert.equal((await f.owner.run(false, f.intent)).ok, true);
  assert.deepEqual(f.trace.find(value => Array.isArray(value)), ['memory-open', { profileId: 'synthetic-school' }]);
  assert.equal(f.destroyed, 1);
});

test('protected-store unavailable keeps the current selector memory fallback during startup', async t => {
  const f = fixture(); t.after(f.finish); f.protectedUnavailable = true;
  assert.equal((await f.owner.run(false, f.intent)).ok, true);
  assert.deepEqual(f.trace.find(value => Array.isArray(value)), ['memory-open', { profileId: 'synthetic-school' }]);
  assert.equal(f.destroyed, 1);
  assert.equal(f.writes[0], 'synthetic-binding-frame\nsynthetic-user\nsynthetic-password\n');
});

test('strict and optional proxy modes keep secrets on stdin, while compatibility stays optional', async t => {
  for (const [strict, needed, flag] of [[true, false, '--socks-auth-stdin'], [false, true, '--socks-auth-optional-stdin'], [false, false, null]]) {
    const f = fixture(); t.after(f.finish); f.config.strictProxyAuth = strict; f.proxyNeeded = needed;
    assert.equal((await f.owner.run(false, f.intent)).ok, true);
    assert.equal(f.launch.args.includes('--socks-auth-stdin'), flag === '--socks-auth-stdin');
    assert.equal(f.launch.args.includes('--socks-auth-optional-stdin'), flag === '--socks-auth-optional-stdin');
    assert.equal(f.writes[0].includes('synthetic-proxy-password'), !!flag);
  }
});

test('invalid stored credential cannot reach argv or stdin', async () => {
  const f = fixture(); f.password = 'invalid\nsynthetic';
  assert.equal((await f.owner.run(false, f.intent)).invalidCredentials, true);
  assert.equal(f.launch, undefined);
  assert.deepEqual(f.writes, []);
  assert.equal(f.destroyed, 1);
});

test('generation mismatch and failed proxy binding stop before writing credential prefix', async t => {
  for (const proxyFailure of [false, true]) {
    const f = fixture(); t.after(f.finish);
    if (proxyFailure) { f.config.strictProxyAuth = true; f.proxyBindingValid = false; }
    else f.generation = 8;
    assert.equal((await f.owner.run(false, f.intent)).ok, false);
    assert(f.trace.includes('stop'));
    assert.deepEqual(f.writes, []);
  }
});

test('unconfirmed orphan cleanup prevents replacement process launch', async () => {
  const f = fixture(); f.config.strictProxyAuth = true;
  f.owner.resolveLaunch = () => ({ command: '/synthetic/engine', argsPrefix: [], options: {}, synthetic: false });
  f.owner.killStrayEngines = () => false;
  assert.equal((await f.owner.run(false, f.intent)).cleanupUnconfirmed, true);
  assert.equal(f.launch, undefined);
  assert.deepEqual(f.writes, []);
  assert(f.trace.includes('destroy-proxy'));
  assert(f.trace.includes('remove-sidecar'));
});

test('Windows owner-record failure stops the child before credential transmission', async t => {
  const f = fixture(); t.after(f.finish); f.owner.platform = 'win32';
  f.owner.resolveLaunch = () => ({ command: '/synthetic/engine', argsPrefix: [], options: {}, synthetic: false });
  f.owner.writeOwnerRecord = () => { throw new Error('synthetic owner-record failure'); };
  assert.equal((await f.owner.run(false, f.intent)).cleanupUnconfirmed, true);
  assert(f.trace.includes('stop'));
  assert.deepEqual(f.writes, []);
});
