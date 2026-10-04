'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {
  CustomGatewayConfirmationOwner,
} = require('../../../lib/profiles/onboarding/custom-gateway-onboarding');
const {
  CustomProfileProvisioningRuntime,
} = require('../../../lib/profiles/provisioning/custom-profile-provisioning-runtime');
const {
  ProfileCandidateDirectory,
} = require('../../../lib/profiles/registry/profile-candidate-directory');
const {
  ActiveContextSwitchJournalStore,
} = require('../../../lib/switching/active-context/active-context-switch-store');
const { createPrivateStorageEffects } = require('../../../lib/platform/storage/private-file');
const { DesktopPersistenceRuntime, ObservedCredentialOwner } = require('../../../lib/persistence/runtime/desktop-persistence-runtime');
const { DomainRoutePolicyStore } = require('../../../lib/routing/policy/domain-route-policy');
const { createStartupAutoConnectEligibility } = require('../../../lib/connection/telemetry/network-status-monitor');
const { UpdateNotificationRuntime } = require('../../../lib/platform/update/update-check');
const { createSharedPortalCredentialProvider } = require('../../../lib/profiles/runtime/school-profile-controller');
const { DiagnosticLogAccessRuntime } = require('../../../lib/diagnostics/logging/log-writer');
const { desktopRuntimeComposition: { ActiveContextLease } } = require('../../../lib/app/desktop-runtime-composition');
const {
  commitActiveContextSwitch,
  createPreparedActiveContextSwitch,
  markActiveContextSwitchReady,
} = require('../../../lib/switching/active-context/active-context-switch-journal');

const DESKTOP = path.resolve(__dirname, '..', '..', '..');
const profileStorageEffects = createPrivateStorageEffects({ fileSystem: fs, platform: process.platform });

function privateRoot(t, prefix) {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(value, { recursive: true, force: true }));
  return value;
}

function customConfirmation() {
  let seed = 1;
  const owner = new CustomGatewayConfirmationOwner({
    randomBytes: (length) => Buffer.alloc(length, seed++),
    now: () => 1_800_000_000_000,
    ttlMs: 10_000,
  });
  const activeContext = {
    profileId: 'hkustgz',
    profileRevision: 1,
    accountHandle: `account-${'a'.repeat(36)}`,
    activeContextEpoch: 7,
  };
  const view = owner.issue({
    probeResult: {
      schema_version: 1,
      normalized_origin: 'https://vpn.example.edu',
      https_identity_valid: true,
      compatibility: 'recognized_candidate',
      candidate_family: 'easyconnect-password-modern-l3-v1',
      reported_version: 'M7.6.8R2',
      http_status: 200,
    },
    activeContext,
  });
  return owner.consume({ confirmationHandle: view.confirmationHandle, activeContext });
}

test('native Main diagnostic wiring preserves live tail and rejects an invalidated real context lease', async t => {
  const root = privateRoot(t, 'hkustgz-native-diagnostic-context-');
  const file = path.join(root, 'engine.log');
  fs.writeFileSync(file, 'synthetic scoped log\n', { mode: 0o600 });
  const lease = new ActiveContextLease({ profileId: 'hkustgz', profileRevision: 1,
    accountHandle: `account-${'a'.repeat(36)}`, activeContextEpoch: 1 });
  let release, blocked = false, opened = 0, errors = 0;
  const pendingFlush = new Promise(resolve => { release = resolve; });
  const writer = { closed: false, flush: () => blocked ? pendingFlush : Promise.resolve() };
  const source = fs.readFileSync(path.join(DESKTOP, 'main.js'), 'utf8');
  const options = source.match(/new DiagnosticLogAccessRuntime\((\{[\s\S]*?\})\);/u)?.[1];
  assert.ok(options);
  const owner = vm.runInNewContext(`new DiagnosticLogAccessRuntime(${options})`, {
    DiagnosticLogAccessRuntime, LOG: file, logWriter: writer, activeContextLease: lease,
    desktopShell: { isQuitting: false }, reportLogFailure: () => { errors++; },
    shell: { openPath: async () => { opened++; } },
  });
  assert.equal(await owner.read(), 'synthetic scoped log\n');
  blocked = true;
  const pending = Promise.all([owner.read(), owner.open()]);
  lease.invalidate(); release();
  assert.deepEqual(await pending, ['', undefined]);
  assert.equal(opened, 0); assert.equal(errors, 0);
  assert.equal(await owner.read(), '');
  assert.equal(fs.readFileSync(file, 'utf8'), 'synthetic scoped log\n');
});

test('native Main shared-portal selection preserves exact rejection and disposable-owner identity', t => {
  const source = fs.readFileSync(path.join(DESKTOP, 'main.js'), 'utf8');
  const expression = source.match(/getSharedPortalCredential:\s*(createSharedPortalCredentialProvider\(\{[\s\S]*?\}\)),\s*onTogglePageFavorite:/u)?.[1];
  assert.ok(expression);
  let profileId = 'custom-fixture', profileReads = 0, opens = 0, consumed = 0, destroyed = 0;
  const owner = new ObservedCredentialOwner({
    withStrings: callback => { consumed++; return callback('synthetic-portal-user', 'synthetic-portal-input'); },
    destroy: () => { destroyed++; },
  }, () => {});
  t.after(() => owner.destroy());
  const provide = vm.runInNewContext(`(${expression})`, { createSharedPortalCredentialProvider,
    activeSchoolProfile: { activeContextBinding: () => { profileReads++; return { profileId }; } },
    persistenceRuntime: { openCredential: () => { opens++; return owner; } },
  });
  assert.equal(profileReads, 0); assert.equal(opens, 0);
  assert.equal(provide('https://unknown.example'), null);
  assert.equal(provide('https://sso.hkust-gz.edu.cn/'), null);
  assert.equal(profileReads, 0); assert.equal(opens, 0);
  assert.equal(provide('https://sso.hkust-gz.edu.cn'), null);
  profileId = 'hkustgz'; assert.equal(provide('https://sso.hkust-gz.edu.cn'), owner);
  assert.equal(opens, 1); assert.equal(consumed, 0); assert.equal(destroyed, 0);
  profileId = 'custom-fixture'; assert.equal(provide('https://sso.hkust-gz.edu.cn'), null);
  assert.equal(opens, 1);
  owner.withStrings((username, password) => { assert.equal(username, 'synthetic-portal-user');
    assert.equal(password, 'synthetic-portal-input'); });
  owner.destroy(); assert.equal(destroyed, 1);
  assert.throws(() => owner.withStrings(() => assert.fail('destroyed owner cannot expose credentials')));
});

test('native Main quit retires pending update ownership before resource disposal', async () => {
  const source = fs.readFileSync(path.join(DESKTOP, 'main.js'), 'utf8');
  const expression = source.match(/disposeLifecycle:\s*(\(\) => \{[\s\S]*?\}),\s*cleanupQuit:/u)?.[1];
  assert.ok(expression);
  let finish, signal, retired = false, io = 0;
  const calls = [];
  const owner = new UpdateNotificationRuntime({ getVersion: () => '2.0.3',
    check: (_version, options) => { signal = options.signal;
      signal.addEventListener('abort', () => calls.push('update'), { once: true });
      return new Promise(resolve => { finish = resolve; }); },
    readSettings: () => { io++; assert.equal(retired, false); return {}; },
    saveSettings: () => { io++; assert.equal(retired, false); }, assertPersistence() {},
    runTransaction: async build => build().commit(), onAvailable: () => { io++; }, openExternal: async () => { io++; },
  });
  const pending = owner.run(true);
  const resource = name => ({ dispose: () => calls.push(name), cancel: () => calls.push(name) });
  const quit = vm.runInNewContext(`(${expression})`, {
    updateNotifications: owner, schoolProfileOnboarding: resource('school'), externalIntegrationRuntime: resource('integration'),
    vpnCredentialAccess: { clear: () => calls.push('credential') }, networkStartupCoordinator: resource('startup'),
    networkEnvironmentService: resource('environment'), connectionWaitRegistry: resource('waits'),
    connectivityRecovery: resource('recovery'), networkStatusMonitor: resource('monitor'),
  });
  quit(); retired = true;
  assert.equal(calls[0], 'update', 'actual Main must retire updates before any other disposable owner');
  assert.equal(signal.aborted, true); assert.equal(owner.inFlightCount, 1);
  finish({ updateAvailable: true, url: 'https://github.com/synthetic/project/releases/tag/v99.0.0' });
  assert.equal(await pending, null); assert.equal(owner.inFlightCount, 0); assert.equal(io, 0);
  assert.deepEqual(owner.open('https://github.com/synthetic/project/releases/tag/v99.0.0'), { ok: false });
});

test('native Main startup admission requires persistent presence and never opens staged memory credentials', t => {
  let persistent = false, presenceReads = 0;
  const access = DesktopPersistenceRuntime.createVpnCredentialAccess({
    persistence: { hasCredential: () => { presenceReads++; return persistent; },
      openCredential: () => { throw new Error('startup admission must not open credentials'); } },
    getProfileId: () => 'fixture-profile', getEngineActive: () => false, platform: process.platform,
    safeStorage: { isEncryptionAvailable: () => { throw new Error('startup admission must not probe protected storage'); } },
  });
  t.after(() => access.clear());
  let settings = { autoConnect: true, username: 'fixture-visible-account',
    get password() { throw new Error('startup admission must not read a password'); } };
  const source = fs.readFileSync(path.join(DESKTOP, 'main.js'), 'utf8');
  const expression = source.match(/shouldAutoConnect:\s*(createStartupAutoConnectEligibility\(\{[\s\S]*?\}\)),\s*pauseOffline:/u)?.[1];
  assert.ok(expression, 'exercise Main public factory wiring, not another predicate');
  const eligible = vm.runInNewContext(`(${expression})`, {
    createStartupAutoConnectEligibility, loadSettingsOrReport: () => settings, vpnCredentialAccess: access,
  });
  assert.equal(presenceReads, 0, 'construction cannot read presence');
  assert.equal(eligible(), false);
  access.stage({ profileId: 'fixture-profile', username: 'fixture-memory-user', password: 'fixture-memory-input' });
  assert.equal(eligible(), false, 'memory-only input cannot authorize cross-launch auto-connect');
  assert.equal(access.hasOneShot(), true, 'eligibility must not consume staged input');
  persistent = true; assert.equal(eligible(), true);
  const reads = presenceReads;
  settings = { autoConnect: false, username: 'fixture-visible-account' }; assert.equal(eligible(), false);
  settings = { autoConnect: true, username: '' }; assert.equal(eligible(), false);
  assert.equal(presenceReads, reads, 'disabled/empty settings retain short-circuit');
});

test('native Main context cleanup retires the Routing snapshot in the original effect order', t => {
  const root = privateRoot(t, 'hkustgz-native-routing-retirement-');
  const source = fs.readFileSync(path.join(DESKTOP, 'main.js'), 'utf8');
  const prefix = 'clearServerState: ';
  const start = source.indexOf(prefix), end = source.indexOf(',\n    closeLog:', start);
  assert.ok(start >= 0 && end > start);
  const store = new DomainRoutePolicyStore({ filePath: path.join(root, 'routing-rules.json'),
    schoolDomains: ['campus.example'], directPartnerDomains: [],
    serverResources: [{ url: 'https://library.campus.example/', route: 'direct' }] });
  store.upsert({ host: 'user.campus.example', route: 'direct' }, 50);
  const fileBytes = fs.readFileSync(store.filePath), reader = store.serverResources;
  const state = { lastError: 'synthetic-error', browserNotice: 'synthetic-notice' }, calls = [];
  const clear = store.clearServerResources.bind(store);
  store.clearServerResources = () => { calls.push('resources'); return clear(); };
  const cleanup = vm.runInNewContext(`'use strict'; (${source.slice(start + prefix.length, end)})`, {
    domainRoutePolicy: store, vpnCredentialAccess: { clear: () => calls.push('credentials') }, state,
    clearConnectionPresentation: () => { assert.equal(state.lastError, null);
      assert.equal(state.browserNotice, null); calls.push('presentation'); },
  });
  assert.equal(store.resolve('https://library.campus.example/').route, 'direct');
  assert.equal(cleanup(), true);
  assert.deepEqual(calls, ['credentials', 'resources', 'presentation']);
  assert.equal(store.serverResources, reader);
  assert.deepEqual(reader(), []);
  assert.equal(store.resolve('https://library.campus.example/').route, 'campus');
  assert.equal(store.resolve('https://user.campus.example/').route, 'direct');
  assert.deepEqual(fs.readFileSync(store.filePath), fileBytes);
});

test('native settings recovery keeps Main observation and localized notice in Persistence', t => {
  const root = privateRoot(t, 'hkustgz-native-settings-recovery-');
  const source = fs.readFileSync(path.join(DESKTOP, 'main.js'), 'utf8');
  const expression = source.match(/onRecovery:\s*(notice => persistenceRuntime\.observeSettingsRecovery\(notice\))/u)?.[1];
  assert.ok(expression, 'exercise the actual Main callback, not a replacement policy');
  for (const kind of ['restored', 'defaults']) {
    const settingsFile = path.join(root, `${kind}.json`);
    const state = { notice: null };
    let runtime, emitted = 0;
    const callback = vm.runInNewContext(`(${expression})`, {
      get persistenceRuntime() { return runtime; },
    });
    const legacy = DesktopPersistenceRuntime.createLegacyAdapter({
      settingsFile, credentialFile: path.join(root, `${kind}.enc`), safeStorage: {},
      platform: process.platform, getDefaultRouteDomains: () => ['example.invalid'], onRecovery: callback,
    });
    if (kind === 'restored') legacy.saveSettings({ port: 6180 });
    fs.writeFileSync(settingsFile, '{synthetic-corrupt-document');
    runtime = new DesktopPersistenceRuntime({
      preReadySelection: { mode: 'legacy-flat', paths: {} },
      initializeAfterReady: () => ({ mode: 'legacy-flat' }), legacy,
      settingsPresentation: { getState: () => state, translate: key => key,
        emit: () => { emitted++; }, getAdditionalNotice: () => runtime.settingsRecoveryNoticeText },
    });
    runtime.initialize();
    runtime.loadSettings();
    assert.deepEqual(JSON.parse(JSON.stringify(runtime.settingsRecoveryNotice)), { kind, quarantined: true });
    runtime.setSettingsRecoveryNoticeText(`synthetic-${kind}`);
    runtime.applyCredentialRecoveryOutcome({ ok: true, status: 'recovered' }, { emitState: false });
    assert.equal(state.notice, `synthetic-${kind}\nerror.credentialRecoveryRecovered`);
    assert.equal(emitted, 0);
    assert.equal(fs.existsSync(path.join(root, `${kind}.enc`)), false);
  }
});

test('real Windows credential adapters retire projections and preserve bounded login metadata', {
  skip: process.platform !== 'win32',
}, t => {
  const root = privateRoot(t, 'hkustgz-windows-credential-adapters-');
  const files = ['legacy-helper.json', 'selected-helper.json'].map(name => path.join(root, name));
  const sibling = path.join(root, 'sibling.json');
  for (const file of [...files, sibling]) fs.writeFileSync(file, 'synthetic-marker');
  for (const file of files) {
    assert.equal(DesktopPersistenceRuntime.discardStartupProxySidecar(file), true);
    assert.equal(fs.existsSync(file), false);
    assert.equal(DesktopPersistenceRuntime.discardStartupProxySidecar(file), true);
  }
  assert.equal(fs.readFileSync(sibling, 'utf8'), 'synthetic-marker');
  assert.equal(DesktopPersistenceRuntime.discardStartupProxySidecar(root), false,
    'native directory unlink refusal cannot be reported as confirmed removal');
  assert.throws(() => DesktopPersistenceRuntime.discardStartupProxySidecar('relative-helper'), TypeError);

  let persistent = false, engine = false, profile = 'fixture-profile-a', reads = 0;
  const access = DesktopPersistenceRuntime.createVpnCredentialAccess({
    persistence: { hasCredential: () => persistent,
      openCredential: () => { throw new Error('metadata must not open a credential'); } },
    getEngineActive: () => engine, getProfileId: () => profile, platform: 'win32',
    safeStorage: { isEncryptionAvailable: () => { throw new Error('metadata must not probe storage'); } },
  });
  t.after(() => access.clear());
  const mainSource = fs.readFileSync(path.join(DESKTOP, 'main.js'), 'utf8');
  const expression = mainSource.match(/hasAccountIdentity:\s*(\(\) =>[\s\S]*?),\s*getPacUrl:/u)?.[1];
  assert.ok(expression);
  const mainIdentity = vm.runInNewContext(`(${expression})`, {
    persistenceRuntime: { hasAccountIdentity: () => persistent }, vpnCredentialAccess: access,
    engineSupervisor: { get hasActive() { return engine; } },
  });
  const readSettings = () => { reads++; return { username: 'fixture-visible-account',
    get password() { throw new Error('metadata must not read a password'); } }; };
  assert.deepEqual(access.loginAccount(readSettings), { ok: true, username: 'fixture-visible-account' });
  persistent = true;
  assert.equal(mainIdentity(), true);
  assert.deepEqual(access.loginAccount(readSettings), { ok: false, username: '' });
  persistent = false;
  access.stage({ profileId: profile, username: 'fixture-memory-account', password: 'fixture-memory-input' });
  assert.equal(mainIdentity(), true, 'actual Main callback must accept current Profile memory identity');
  assert.equal(access.hasOneShot(), true, 'state projection must not consume staged memory');
  assert.deepEqual(access.loginAccount(readSettings), { ok: false, username: '' });
  profile = 'fixture-profile-b';
  engine = true;
  assert.equal(mainIdentity(), true);
  assert.deepEqual(access.loginAccount(readSettings), { ok: false, username: '' });
  engine = false;
  assert.equal(mainIdentity(), false);
  assert.deepEqual(access.loginAccount(readSettings), { ok: true, username: 'fixture-visible-account' });
  assert.equal(reads, 2);
  assert.deepEqual(access.loginAccount(() => { throw new Error('synthetic settings unavailable'); }),
    { ok: false, username: '' });
});

test('real Windows storage provisions and reopens one isolated custom school', {
  skip: process.platform !== 'win32',
  timeout: 120_000,
}, (t) => {
  const userData = privateRoot(t, 'hkustgz-windows-custom-school-');
  let entropy = 60;
  const result = new CustomProfileProvisioningRuntime({
    userData,
    profileStorageEffects,
    randomBytes: (length) => Buffer.alloc(length, ++entropy),
    now: () => 1_800_000_000_500,
  }).begin(customConfirmation());
  assert.equal(result.ok, true);
  assert.equal(result.status, 'provisioned');

  const candidates = new ProfileCandidateDirectory({
    userData,
    packageRoot: DESKTOP,
    desktopDir: DESKTOP,
    isPackaged: false,
    profileStorageEffects,
  });
  const custom = candidates.listViews({ locale: 'en' })
    .find((candidate) => candidate.profileId === result.context.profileId);
  assert.ok(custom);
  assert.equal(custom.unverified, true);
  assert.equal(custom.sanitizedCompatibility, 'candidate');
  assert.equal(custom.normalizedGatewayOrigin, 'https://vpn.example.edu');
  candidates.withCandidate(result.context.profileId, (record) => {
    assert.equal(record.kind, 'custom-local');
    assert.equal(record.authority.profileState.gatewayOrigin, 'https://vpn.example.edu');
    assert.deepEqual(record.profile.browser.campusDomains, []);
    assert.deepEqual(record.profile.browser.directPartnerDomains, []);
  });
});

test('real Windows switch journal remains owner-only through every durable state', {
  skip: process.platform !== 'win32',
  timeout: 120_000,
}, (t) => {
  const userData = privateRoot(t, 'hkustgz-windows-switch-journal-');
  const context = (profileId, profileSeed, accountSeed, workspaceSeed, epoch) => ({
    profileId,
    profileKey: `profile-${profileSeed.repeat(32)}`,
    profileRevision: 1,
    profileCredentialBindingRevision: 1,
    accountKey: `account-${accountSeed.repeat(32)}`,
    accountRevision: 1,
    accountCredentialRevision: 1,
    workspaceKey: `workspace-${workspaceSeed.repeat(32)}`,
    activeContextEpoch: epoch,
  });
  const receipt = (seed) => ({
    present: true,
    bytes: seed + 50,
    sha256: seed.toString(16).padStart(64, '0'),
  });
  const store = new ActiveContextSwitchJournalStore({
    filePath: path.join(userData, 'global', 'active-context-switch.json'),
    profileStorageEffects,
  });
  const prepared = createPreparedActiveContextSwitch({
    from: context('hkustgz', '1', '2', '3', 3),
    to: context('example-school', '4', '5', '6', 2),
    engineGeneration: 9,
    activation: {
      globalSettings: { before: receipt(1), after: receipt(2) },
      destinationWorkspace: { before: receipt(3), after: receipt(4) },
    },
    randomBytes: () => Buffer.alloc(16, 7),
    now: () => 1_800_000_000_000,
  });
  const ready = markActiveContextSwitchReady(prepared, {
    now: () => 1_800_000_000_100,
  });
  const committed = commitActiveContextSwitch(ready, {
    now: () => 1_800_000_000_200,
  });
  assert.deepEqual(store.prepare(prepared), {
    prepared: true,
    durabilityUnconfirmed: false,
  });
  assert.equal(store.read()?.state, 'prepared');
  assert.deepEqual(store.markReady(ready), {
    ready: true,
    durabilityUnconfirmed: false,
  });
  assert.equal(store.read()?.state, 'ready');
  assert.deepEqual(store.commit(committed), {
    committed: true,
    durabilityUnconfirmed: false,
  });
  assert.equal(store.read()?.state, 'committed');
  assert.equal(store.clearCommitted(), true);
  assert.equal(store.read(), null);
});

test('native Windows queued startup cancellation preserves the real connection user stop intent', {
  skip: process.platform !== 'win32',
}, async () => {
  const { NetworkStartupCoordinator } = require('../../../lib/connection/telemetry/network-status-monitor');
  const { ConnectionStateMachine, ConnectionOperationCoordinator } = require('../../../lib/connection/state/connection-state-machine');
  const connectionState = new ConnectionStateMachine();
  let tick, launches = 0;
  const operations = new ConnectionOperationCoordinator({ connectionState,
    engineSupervisor: { hasActive: false }, isQuitting: () => false, cancelRecovery() {},
    runAttempt: async () => { launches++; return { ok: true }; } });
  const startup = new NetworkStartupCoordinator({
    monitor: { start: async () => true, snapshot: () => ({ baseline: true }) },
    shouldAutoConnect: () => true, pauseOffline() {}, resumeOffline() {}, isQuitting: () => false,
    connect: () => operations.connect(),
    setTimeout: callback => { tick = callback; return { unref() {} }; }, clearTimeout() {},
  });
  try {
    assert.equal(await startup.start(), true);
    const pending = tick();
    startup.cancel(); const stoppedIntent = connectionState.beginStop(false);
    await pending;
    assert.equal(launches, 0);
    assert.equal(connectionState.snapshot().intent, stoppedIntent);
    assert.equal(connectionState.snapshot().desiredConnected, false);
  } finally { startup.dispose(); }
});
