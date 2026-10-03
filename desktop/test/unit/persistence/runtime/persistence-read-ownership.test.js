'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DesktopPersistenceRuntime } = require('../../../../lib/persistence/runtime/desktop-persistence-runtime');

test('persistence reads stay in one bounded existing runtime module', () => {
  const source = fs.readFileSync(require.resolve('../../../../lib/persistence/runtime/desktop-persistence-runtime'), 'utf8');
  assert(source.trimEnd().split('\n').length <= 600);
});

function legacyFixture() {
  const f = { trace: [], notices: [], domains: ['example.invalid'], settings: { username: 'synthetic-user' },
    credential: { status: 'missing' }, storage: {} };
  f.adapter = DesktopPersistenceRuntime.createLegacyAdapter({
    settingsFile: '/synthetic/settings.json', credentialFile: '/synthetic/credential.enc',
    safeStorage: f.storage, platform: 'linux', getDefaultRouteDomains: () => f.domains,
    onRecovery: notice => f.notices.push(notice),
    stores: {
      readSettings: (file, options) => { f.trace.push(['settings', file, options.defaultRouteDomains]);
        options.onRecovery('synthetic-recovery'); return f.settings; },
      writeSettings: (file, value, options) => { f.trace.push(['save-settings', file, options.defaultRouteDomains]); return value; },
      readPasswordResult: (file, storage, platform) => { f.trace.push(['credential', file, storage, platform]); return f.credential; },
      writePassword: (...args) => { f.trace.push(['save-password', ...args]); return true; },
      restorePasswordSnapshot: (...args) => { f.trace.push(['clear-password', ...args]); return true; },
      hasStoredPassword: (...args) => { f.trace.push(['has-password', ...args]); return false; },
    },
  });
  return f;
}

test('legacy settings retain current Profile defaults and recovery observation on every read/write', () => {
  const f = legacyFixture(); assert(Object.isFrozen(f.adapter));
  assert.equal(f.adapter.loadSettings(), f.settings);
  f.domains = ['next.invalid']; f.adapter.saveSettings(f.settings);
  assert.deepEqual(f.trace, [['settings', '/synthetic/settings.json', ['example.invalid']],
    ['save-settings', '/synthetic/settings.json', ['next.invalid']]]);
  assert.deepEqual(f.notices, ['synthetic-recovery']);
});

test('legacy credential opening reads settings before credentials and missing stays null', () => {
  const f = legacyFixture(); assert.equal(f.adapter.openCredential(), null);
  assert.deepEqual(f.trace.map(entry => entry[0]), ['settings', 'credential']);
});

test('legacy storage errors remain typed and never carry decrypted content in the message', () => {
  for (const status of ['unavailable', 'decrypt-failed', 'unsafe']) {
    const f = legacyFixture(); f.credential = { status, password: 'synthetic-private-value' };
    assert.throws(() => f.adapter.openCredential(), error => error.credentialStatus === status &&
      error.message === 'legacy credential is unavailable' && !String(error).includes(f.credential.password));
  }
});

test('legacy decrypted credentials stay in the existing disposable redacted owner', () => {
  const f = legacyFixture(); f.credential = { status: 'decrypted', password: 'synthetic-password' };
  const owner = f.adapter.openCredential();
  owner.withStrings((username, password) => { assert.equal(username, 'synthetic-user'); assert.equal(password, 'synthetic-password'); });
  assert.equal(JSON.stringify(owner).includes('synthetic-password'), false);
  owner.destroy(); assert.throws(() => owner.withStrings(() => assert.fail('destroyed owner exposed data')));
});

test('legacy save/clear/presence delegate to the same platform and files', () => {
  const f = legacyFixture();
  assert.equal(f.adapter.saveCredential('synthetic-password'), true);
  assert.equal(f.adapter.clearCredential(), true); assert.equal(f.adapter.hasCredential(), false);
  assert.deepEqual(f.trace, [['save-password', '/synthetic/credential.enc', 'synthetic-password', f.storage, 'linux'],
    ['clear-password', '/synthetic/credential.enc', { existed: false, data: null }],
    ['has-password', '/synthetic/credential.enc', 'linux']]);
});

test('default legacy adapter uses real private-file stores with synthetic encryption and clears credentials', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-legacy-read-owner-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const safeStorage = { isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`synthetic:${value}`),
    decryptString: value => value.toString('utf8').slice('synthetic:'.length) };
  const adapter = DesktopPersistenceRuntime.createLegacyAdapter({
    settingsFile: path.join(directory, 'settings.json'), credentialFile: path.join(directory, 'credential.enc'),
    safeStorage, platform: process.platform === 'win32' ? 'win32' : 'darwin',
    getDefaultRouteDomains: () => ['example.invalid'], onRecovery() {},
  });
  adapter.saveSettings({ username: 'synthetic-user', port: 6180 });
  adapter.saveCredential('synthetic-password');
  assert.equal(adapter.hasCredential(), true);
  const owner = adapter.openCredential();
  try { owner.withStrings((username, password) => {
    assert.equal(username, 'synthetic-user'); assert.equal(password, 'synthetic-password');
  }); } finally { owner.destroy(); }
  adapter.clearCredential(); assert.equal(adapter.hasCredential(), false);
  assert.equal(adapter.openCredential(), null);
});

function readFixture({ recovery = null, includeOwnedNotice = false } = {}) {
  const f = { state: { settingsError: null, recoveryError: 'recovery', browserNotice: 'browser', diagnosticNotice: 'log' },
    emitted: 0, language: 'zh', error: null, settings: { port: 6180 } };
  const legacy = { loadSettings: () => { if (f.error) throw f.error;
    if (recovery) f.runtime.observeSettingsRecovery(recovery); return f.settings; },
    saveSettings: value => value, saveCredential() {}, clearCredential() {}, openCredential() {}, hasCredential() {} };
  f.runtime = new DesktopPersistenceRuntime({ preReadySelection: { mode: 'legacy-flat', paths: {} },
    initializeAfterReady: () => ({ mode: 'legacy-flat' }), legacy,
    settingsPresentation: { getState: () => f.state, translate: key => `${f.language}:${key}`, emit: () => { f.emitted += 1; },
      ...(includeOwnedNotice ? { getAdditionalNotice: () => f.runtime.settingsRecoveryNoticeText } : {}) },
  });
  f.runtime.initialize(); return f;
}

test('settings recovery observation and text belong to the runtime without constructor or observation effects', () => {
  const notice = { kind: 'restored', quarantined: true };
  const f = readFixture({ recovery: notice });
  assert.equal(f.runtime.settingsRecoveryNotice, null);
  assert.equal(f.runtime.settingsRecoveryNoticeText, null);
  assert.equal(f.runtime.loadSettings(), f.settings);
  assert.equal(f.runtime.settingsRecoveryNotice, notice, 'preserve the original observation reference');
  f.runtime.setSettingsRecoveryNoticeText('synthetic localized recovery');
  assert.equal(f.runtime.settingsRecoveryNoticeText, 'synthetic localized recovery');
  assert.equal(f.emitted, 0);
  assert.equal(f.state.notice, undefined, 'publication remains owned by the startup sequence');
});

test('owned settings recovery text preserves credential notice ordering and silent startup publication', () => {
  const f = readFixture({ includeOwnedNotice: true });
  f.runtime.observeSettingsRecovery({ kind: 'defaults', quarantined: false });
  f.runtime.setSettingsRecoveryNoticeText('synthetic settings defaults');
  f.runtime.applyCredentialRecoveryOutcome({ ok: true, status: 'recovered' }, { emitState: false });
  assert.equal(f.state.notice, 'synthetic settings defaults\nzh:error.credentialRecoveryRecovered');
  assert.equal(f.emitted, 0);
  f.runtime.applyCredentialRecoveryOutcome({ ok: true, status: 'none' }, { clearNotice: true });
  assert.equal(f.state.notice, 'synthetic settings defaults');
  assert.equal(f.emitted, 1);
  f.runtime.setSettingsRecoveryNoticeText(null);
  f.runtime.applyCredentialRecoveryOutcome({ ok: true, status: 'none' }, { emitState: false });
  assert.equal(f.state.notice, null);
  assert.equal(f.state.recoveryError, 'recovery');
  assert.equal(f.state.browserNotice, 'browser');
  assert.equal(f.state.diagnosticNotice, 'log');
});

test('settings observation remains separate from translation and does not overwrite localized text', () => {
  const f = readFixture();
  const first = { kind: 'restored' }, next = { kind: 'defaults' };
  f.runtime.observeSettingsRecovery(first);
  f.runtime.setSettingsRecoveryNoticeText('zh:synthetic restored');
  f.language = 'en';
  f.runtime.observeSettingsRecovery(next);
  assert.equal(f.runtime.settingsRecoveryNotice, next);
  assert.equal(f.runtime.settingsRecoveryNoticeText, 'zh:synthetic restored');
  assert.equal(f.emitted, 0, 'observation must not introduce translation or publication');
});

test('settings-read failure stays typed, uses the current translator and emits once per changed notice', () => {
  const f = readFixture(); f.error = new Error('synthetic filesystem failure');
  for (let i = 0; i < 2; i += 1) assert.throws(() => f.runtime.loadSettingsOrReport(),
    error => error.code === 'SETTINGS_READ_FAILED' && error.cause === f.error && error.userMessage === 'zh:error.settingsReadFailed');
  assert.equal(f.emitted, 1); f.language = 'en';
  assert.throws(() => f.runtime.loadSettingsOrReport(), /en:error.settingsReadFailed/);
  assert.equal(f.emitted, 2);
});

test('read recovery only clears its own notice and leaves unrelated domains intact', () => {
  const f = readFixture(); f.error = new Error('synthetic read');
  assert.throws(() => f.runtime.loadSettingsOrReport()); f.error = null;
  assert.equal(f.runtime.loadSettingsOrReport(), f.settings);
  assert.deepEqual(f.state, { settingsError: null, recoveryError: 'recovery', browserNotice: 'browser', diagnosticNotice: 'log' });
  assert.equal(f.emitted, 2);
});

test('a later settings-owner error is not cleared by unrelated successful reading', () => {
  const f = readFixture(); f.error = new Error('synthetic read');
  assert.throws(() => f.runtime.loadSettingsOrReport()); f.state.settingsError = 'later-owner-error'; f.error = null;
  f.runtime.loadSettingsOrReport(); assert.equal(f.state.settingsError, 'later-owner-error'); assert.equal(f.emitted, 1);
});

test('startup silent reporting and recovery mutate presentation without emitting', () => {
  const f = readFixture(); f.error = new Error('synthetic read');
  assert.throws(() => f.runtime.loadSettingsOrReport({ emitState: false })); f.error = null;
  f.runtime.loadSettingsOrReport({ emitState: false }); assert.equal(f.state.settingsError, null); assert.equal(f.emitted, 0);
});

test('already-classified settings errors are not wrapped or republished', () => {
  const f = readFixture(); const error = Object.assign(new Error('classified'), { code: 'SETTINGS_READ_FAILED' });
  assert.equal(f.runtime.reportSettingsReadFailure(error), error); assert.equal(f.emitted, 0);
});
