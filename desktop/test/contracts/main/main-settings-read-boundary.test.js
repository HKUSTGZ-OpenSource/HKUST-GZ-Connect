'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const attempt = fs.readFileSync(require.resolve('../../../lib/connection/engine/engine-process'), 'utf8');
const persistence = fs.readFileSync(require.resolve('../../../lib/persistence/runtime/desktop-persistence-runtime'), 'utf8');
const startupOwner = fs.readFileSync(require.resolve('../../../lib/app/startup/multi-school-startup-runtime'), 'utf8');

const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'main.js'), 'utf8');
const shellSource = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'lib', 'platform', 'shell', 'desktop-shell.js'),
  'utf8',
);

function section(startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start + startText.length);
  assert.ok(start >= 0 && end > start, `missing source section: ${startText}`);
  return source.slice(start, end);
}

test('Main injects persistence-read presentation and legacy files instead of owning their algorithms', () => {
  assert.match(source, /legacy: DesktopPersistenceRuntime\.createLegacyAdapter\(\{/u);
  assert.match(source, /settingsFile: SETTINGS, credentialFile: CRED, safeStorage, platform: process\.platform/u);
  assert.match(source, /settingsPresentation: \{\s*getState: \(\) => state,\s*translate: \(key\) => t\(key\),\s*emit,\s*getAdditionalNotice: \(\) => settingsRecoveryNoticeText,\s*\}/u);
  assert.match(source, /return persistenceRuntime\.reportSettingsReadFailure\(cause, options\)/u);
  assert.match(source, /return persistenceRuntime\.loadSettingsOrReport\(options\)/u);
  assert.doesNotMatch(source, /function (?:loadLegacySettings|saveLegacySettings|openLegacyCredential)\(/u);
  assert.match(persistence, /const settings = loadSettings\(\);[\s\S]*io\.readPasswordResult\(credentialFile, safeStorage, platform\)/u);
  assert.match(persistence, /new LegacyMigrationCredentialOwner\(settings\.username, result\.password\)/u);
  assert.match(persistence, /state\.settingsError === this\.settingsReadErrorText/u);
});

test('engine close settles fail-closed when retry settings are temporarily unreadable', () => {
  assert.match(source, /loadSettings, reportSettingsReadFailure, emit/u);
  assert.match(source, /engineTermination\.close\(\.\.\.args\)/u);
  const body = fs.readFileSync(require.resolve('../../../lib/connection/engine/engine-connection-runtime'), 'utf8');
  assert.match(body, /try \{\s*cfg = this\.loadSettings\(\);\s*\} catch \(error\)/);
  assert.match(body, /connectionState\.engineClosed\(\{[\s\S]*terminalFailure: true/);
  assert.doesNotMatch(source, /state\.(?:connected|connecting)\s*=/,
    'UI connection flags must be projected from the authoritative FSM');
  assert.match(body, /reportSettingsReadFailure\(error/);
});

test('final connection snapshot fails the FSM and classifies credential availability', () => {
  const body = attempt;
  assert.match(source, /engineAttempts\.run\(isRetry, intent\)/u);
  const marker = body.indexOf('// FINAL_CONNECTION_SNAPSHOT:');
  const spawn = body.indexOf('const started = this.engineSupervisor.start(');
  const guardedStart = body.slice(marker, spawn);
  assert.match(guardedStart, /s = this\.loadSettings\(\);[\s\S]*this\.openCredential\(/);
  assert.match(source, /openCredential: profileId => vpnCredentialAccess\.open\(profileId\)/);
  const access = fs.readFileSync(require.resolve('../../../lib/persistence/credentials/credential-store'), 'utf8');
  assert.match(access, /openPersistent: \(\) => this\.persistence\.openCredential\(\)/);
  assert.match(guardedStart, /credentialOwner\.withStrings/);
  assert.match(guardedStart, /credentialOwner\.destroy\(\)/);
  assert.match(guardedStart, /connectionState\.failIntent\(intent\);/);
  assert.match(guardedStart, /settingsUnavailable: true/);
});

test('window close and automatic updates turn settings failures into bounded async outcomes', () => {
  const closeStart = shellSource.indexOf('async handleWindowClose(');
  const closeEnd = shellSource.indexOf('\n  createWindow()', closeStart);
  const close = shellSource.slice(closeStart, closeEnd);
  assert.match(close, /let action = 'ask';/);
  assert.match(close, /try \{ action = this\.getCloseAction\(\) \|\| 'ask'; \} catch \{\}/);
  assert.match(source, /getCloseAction: \(\) => loadSettingsOrReport\(\)\.closeAction/);
  assert.match(source, /readSettings: loadSettingsOrReport/);
  assert.match(source, /checkUpdate: force => updateNotifications\.run\(force\)/);
  const updateOwner = fs.readFileSync(path.join(__dirname, '..', '..', '..',
    'lib', 'platform', 'update', 'update-check.js'), 'utf8');
  assert.match(updateOwner, /async run\(force = false\)/);
  assert.match(updateOwner, /this\.run\(\)\.catch\(\(\) => \{\}\)/);
  assert.match(shellSource, /this\.handleWindowClose\(event\)\.catch\(this\.onWindowError\)/);
});

test('a startup PAC failure does not hide an earlier recovery error', () => {
  const startup = startupOwner.slice(startupOwner.indexOf('async #initialize()'));
  assert.match(startup, /const pacError =/);
  assert.match(startup, /state\.browserNotice = \[state\.browserNotice, pacError\]\.filter\(Boolean\)\.join\('\\n'\)/);
  assert.match(source, /getPresentation: \(\) => state, translate: \(key, vars\) => t\(key, vars\)/u);
});

test('settings, recovery, browser, and log outcomes have separate domains', () => {
  const snapshot = section('function statusSnapshot()', 'const engineApplication');
  assert.match(snapshot, /projectConnectionStatus\(state, connectionState\.presentation\(\), connectedAt\)/);
  assert.match(source, /settingsError: null/);
  assert.match(source, /recoveryError: null/);
  assert.match(source, /diagnosticNotice: null/);
  assert.match(source, /new BufferedLogWriter\(LOG, \{ onError: reportLogFailure, onRecovered:/);
  assert.match(source, /state\.diagnosticNotice = t\('error\.logUnavailable'\)/);
  assert.match(source, /onRecovered:[^\n]+state\.diagnosticNotice = null; emit\(\)/);
  assert.doesNotMatch(source, /logWriter\.(?:flush|close)\(\)\.catch\(\(\) => \{\}\)/);
  assert.match(source, /onWindowError:[\s\S]*?state\.settingsError =/);
});
