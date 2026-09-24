'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'main.js'), 'utf8');

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing section ${start}`);
  return source.slice(from, to);
}

test('pre-ready selection binds every service path before recovery or construction', () => {
  const legacyCleanup = source.indexOf('fs.unlinkSync(legacyRuntimeStoragePaths.proxyHelperCredential)');
  const profile = source.indexOf('const activeSchoolProfile = createPreReadySchoolProfileController(');
  const selection = source.indexOf('selectProfileWorkspacePreReadyStorage({ userData: DATA, profile })');
  const paths = source.indexOf('const runtimeStoragePaths = preReadyStorage.paths;');
  const recovery = source.indexOf('recoverCredentialSettingsTransaction(CREDENTIAL_TRANSACTION');
  assert.ok(legacyCleanup >= 0 && profile > legacyCleanup && selection > profile &&
    paths > selection && recovery > paths);
  assert.match(source, /preReadyStorage\.mode === 'legacy-flat'[\s\S]*recoverCredentialSettingsTransaction/);
});

test('after-ready migration uses the bounded relaunch owner before services can start', () => {
  const startup = section('app.whenReady().then(() => {', "app.on('window-all-closed'");
  const switchGuard = startup.indexOf('assertActiveContextSwitchStartupClear(');
  const initialize = startup.indexOf('persistenceRuntime.initialize()');
  const relaunch = startup.indexOf('relaunchAfterPersistenceMigration(');
  const log = startup.indexOf('initializeLogWriter()');
  const tray = startup.indexOf('desktopShell.createTray()');
  const network = startup.indexOf('networkStartupCoordinator.start()');
  assert.ok(switchGuard >= 0 && initialize > switchGuard && relaunch > initialize &&
    log > relaunch && tray > log && network > tray);
  assert.match(startup, /if \(persistence\.relaunchRequired\) \{[\s\S]*relaunchAfterPersistenceMigration\(\{[\s\S]*developmentEntry: __dirname \}\);\s*return;/u);
  assert.match(source, /let logWriter = null;[\s\S]*function initializeLogWriter\(\)/u);
});

test('settings credential IPC and connect use the immutable persistence adapter', () => {
  const connect = section('async function connectOnce(', '\nfunction ensureEngineStopped()');
  assert.match(source, /function loadSettings\(\) \{ return persistenceRuntime\.loadSettings\(\); \}/u);
  assert.match(source, /persistenceRuntime\.saveCredential\(pw, username\)/u);
  assert.match(source, /removePassword: \(\) => persistenceRuntime\.clearCredential\(\)/u);
  assert.match(source, /hasAccountIdentity: \(\) => persistenceRuntime\.hasAccountIdentity\(\)/u);
  assert.match(connect, /const credentialOwner = persistenceRuntime\.openCredential\(\)/u);
  assert.match(connect, /finally \{ credentialOwner\.destroy\(\); \}/u);
  assert.match(connect, /\$\{engineConfigBinding\.stdinFrame\}\\n\$\{username\}\\n\$\{pw\}/u);
  assert.doesNotMatch(connect, /loadPasswordResult\(\)/u);
});
