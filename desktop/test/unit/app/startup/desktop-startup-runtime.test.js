'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { desktopRuntimeComposition } = require('../../../../lib/app/desktop-runtime-composition');
const { DesktopStartupRuntime } = desktopRuntimeComposition;

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(overrides = {}) {
  const calls = [], signals = new Map(), presentation = { browserNotice: null };
  const mark = name => (...args) => { calls.push(name); return args; };
  const effects = {
    profileSwitching: { runtime: null, recoverBeforeServices: async () => { calls.push('switch-recovery'); } },
    assertSwitchStartupClear: mark('switch-guard'),
    persistenceRuntime: {
      initialize: () => { calls.push('persistence'); return { relaunchRequired: false }; },
      getCredentialTransactionRecovery: () => ({ status: 'none' }),
      applyCredentialRecoveryOutcome: (value, options) => {
        assert.deepEqual(options, { emitState: false }); calls.push('credential-feedback');
      },
    },
    relaunchPersistence: mark('relaunch'), initializeMultiSchoolStartup: mark('multi-school'),
    customProfileDeletion: { recover: async () => { calls.push('deletion'); return { ok: true }; } },
    initializeLogWriter: mark('logs'), getLogWriter: () => ({ append: mark('deletion-diagnostic') }),
    writeMarkers: mark('markers'), currentLocale: () => { calls.push('locale'); return 'en'; },
    fallbackLocale: () => { calls.push('locale-fallback'); return 'zh'; },
    setLocale: value => { calls.push(`locale-${value}`); },
    loadSettings: mark('settings'), reportSettingsReadFailure: (error, options) => {
      assert.deepEqual(options, { emitState: false }); calls.push('settings-failure');
    },
    getSettingsRecoveryNotice: () => null,
    setSettingsRecoveryNoticeText: mark('settings-notice'),
    getPresentation: () => presentation,
    translate: (key, vars) => vars ? `${key}:${vars.message}` : key,
    desktopShell: { installApplicationMenu: mark('menu'), createTray: mark('tray'),
      createWindow: mark('window'), showWindow: mark('show-window') },
    refreshPacFile: mark('pac'),
    powerMonitor: { on: (type, handler) => { calls.push(type); signals.set(type, handler); } },
    connectivityRecovery: { suspend: mark('suspended'), resume: mark('resumed') },
    networkStartupCoordinator: { start: async () => { calls.push('network'); } },
    updateNotifications: { startAutomatic: value => { assert.equal(value, true); calls.push('updates'); } },
    isPackaged: true, onActivate: handler => { calls.push('activate'); signals.set('activate', handler); },
    ...overrides,
  };
  return { effects, calls, signals, presentation };
}

test('startup public owner captures the existing ordered ready sequence and app lifecycle bindings', async () => {
  const f = fixture(), owner = new DesktopStartupRuntime(f.effects);
  assert.deepEqual(f.calls, []);
  await owner.run();
  assert.deepEqual(f.calls, ['switch-guard', 'switch-recovery', 'persistence', 'multi-school',
    'deletion', 'logs', 'markers', 'locale', 'locale-en', 'settings', 'credential-feedback',
    'menu', 'pac', 'tray', 'window', 'suspend', 'resume', 'network', 'updates', 'activate']);
  f.signals.get('suspend')(); f.signals.get('resume')(); f.signals.get('activate')();
  assert.deepEqual(f.calls.slice(-3), ['suspended', 'resumed', 'show-window']);
});

test('concurrent and later starts share one flight and cannot recreate ordinary services', async () => {
  const recovery = deferred(), f = fixture({ profileSwitching: { runtime: {},
    recoverBeforeServices: () => { f.calls.push('switch-recovery'); return recovery.promise; } } });
  const owner = new DesktopStartupRuntime(f.effects), first = owner.run();
  assert.equal(owner.run(), first);
  await Promise.resolve(); assert.deepEqual(f.calls, ['switch-recovery']);
  recovery.resolve(); await first;
  assert.equal(owner.run(), first);
  assert.equal(f.calls.filter(value => value === 'window').length, 1);
  assert.equal(f.calls.includes('switch-guard'), false, 'active switch runtime owns its recovery guard');
});

test('profile recovery relaunch stops before persistence and ordinary services', async () => {
  const f = fixture({ profileSwitching: { runtime: {},
    recoverBeforeServices: async () => ({ relaunching: true }) } });
  await new DesktopStartupRuntime(f.effects).run();
  assert.deepEqual(f.calls, []);
});

test('storage migration relaunch stops before multi-school, logs, tray or network', async () => {
  const f = fixture();
  f.effects.persistenceRuntime.initialize = () => { f.calls.push('persistence'); return { relaunchRequired: true }; };
  await new DesktopStartupRuntime(f.effects).run();
  assert.deepEqual(f.calls, ['switch-guard', 'switch-recovery', 'persistence', 'relaunch']);
});

test('recovery and persistence failures remain terminal without replay or service effects', async () => {
  for (const stage of ['guard', 'switch', 'persistence', 'multi-school']) {
    const failure = new Error(`synthetic ${stage}`), f = fixture();
    const fail = () => { throw failure; };
    if (stage === 'guard') f.effects.assertSwitchStartupClear = fail;
    if (stage === 'switch') f.effects.profileSwitching.recoverBeforeServices = fail;
    if (stage === 'persistence') f.effects.persistenceRuntime.initialize = fail;
    if (stage === 'multi-school') f.effects.initializeMultiSchoolStartup = fail;
    const owner = new DesktopStartupRuntime(f.effects), first = owner.run();
    await assert.rejects(first, error => error === failure);
    assert.equal(owner.run(), first); assert.equal(f.calls.includes('tray'), false);
    assert.equal(f.calls.includes('logs'), false); assert.equal(f.calls.includes('network'), false);
  }
});

test('locale and settings read failures retain fallback and recovery feedback before the window', async () => {
  const f = fixture({ currentLocale: () => { throw new Error('synthetic locale read'); },
    getSettingsRecoveryNotice: () => ({ kind: 'restored' }) });
  f.effects.loadSettings = () => { throw new Error('synthetic settings read'); };
  await new DesktopStartupRuntime(f.effects).run();
  assert.ok(f.calls.indexOf('locale-zh') < f.calls.indexOf('settings-failure'));
  assert.ok(f.calls.indexOf('settings-notice') < f.calls.indexOf('credential-feedback'));
  assert.ok(f.calls.indexOf('credential-feedback') < f.calls.indexOf('window'));
});

test('PAC failures append to earlier recovery notices without preventing tray and window', async () => {
  for (const customMessage of [null, 'synthetic user message']) {
    const f = fixture(); f.presentation.browserNotice = 'prior recovery';
    f.effects.refreshPacFile = () => { const error = new Error('synthetic disk full');
      if (customMessage) error.userMessage = customMessage; throw error; };
    await new DesktopStartupRuntime(f.effects).run();
    assert.equal(f.presentation.browserNotice, `prior recovery\n${customMessage || 'error.pacWriteAtBoot:synthetic disk full'}`);
    assert.ok(f.calls.includes('tray')); assert.ok(f.calls.includes('window'));
  }
});

test('deletion recovery remains asynchronous and only reports its bounded failure after logs exist', async () => {
  const recovery = deferred(), f = fixture({ customProfileDeletion: { recover: () => recovery.promise } });
  await new DesktopStartupRuntime(f.effects).run();
  assert.ok(f.calls.includes('window')); assert.equal(f.calls.includes('deletion-diagnostic'), false);
  recovery.resolve({ ok: false }); await Promise.resolve();
  assert.equal(f.calls.filter(value => value === 'deletion-diagnostic').length, 1);
});

test('missing startup capabilities fail preflight without executing any effects', () => {
  const f = fixture();
  for (const overrides of [{ setLocale: null }, { persistenceRuntime: {} }, { powerMonitor: {} },
    { desktopShell: {} }, { networkStartupCoordinator: {} }]) {
    assert.throws(() => new DesktopStartupRuntime({ ...f.effects, ...overrides }), TypeError);
  }
  assert.deepEqual(f.calls, []);
});
