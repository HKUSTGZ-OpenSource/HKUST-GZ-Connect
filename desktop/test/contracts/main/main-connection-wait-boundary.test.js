'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'main.js'), 'utf8');

test('Main connection waits are event-driven, intent-bound, and disposed on quit', () => {
  assert.match(source, /connectionWaitRegistry\.observe\(connectionState\.snapshot\(\)\)/);
  assert.match(source, /function waitForConnected\(intent,/);
  assert.match(source, /connectionWaitRegistry\.wait\(intent,/);
  assert.match(source, /waitForConnected\(result\.intent\)/);
  assert.match(source, /connect: async \(\) => \{ const \{ intent: _intent, \.\.\.result \} = await connect\(\); return result; \}/,
    'the internal wait correlation must not cross the Renderer IPC boundary');
  assert.match(source, /reconnect: async \(\) => \{ const \{ intent: _intent, \.\.\.result \} = await reconnect\(\); return result; \}/);
  assert.match(source, /networkStartupCoordinator\.dispose\(\); networkEnvironmentService\.dispose\(\); connectionWaitRegistry\.dispose\(\)/,
    'network status, public-egress work, and intent waiters must share the quit boundary');
  assert.doesNotMatch(source, /setTimeout\(poll,\s*100\)/,
    'the old detached 100ms polling loop must not return');
});

test('browser readiness outlives the bounded Engine data-plane retry window', () => {
  const match = source.match(/const BROWSER_CONNECTION_READY_TIMEOUT_MS = ([\d_]+);/u);
  assert.ok(match, 'Main must name one reviewed Browser readiness deadline');
  const timeoutMs = Number(match[1].replaceAll('_', ''));
  assert.ok(timeoutMs >= 60_000 && timeoutMs <= 120_000);
  assert.match(source,
    /function waitForConnected\(intent, timeoutMs = BROWSER_CONNECTION_READY_TIMEOUT_MS\)/u);
});

test('settings failures publish terminal intent state to pending waiters', () => {
  const recovery = source.slice(
    source.indexOf('async function recoverConnectivity('),
    source.indexOf('const connectivityRecovery ='),
  );
  const policy = source.slice(
    source.indexOf('shouldReconnect: async'),
    source.indexOf('reconnect: recoverConnectivity'),
  );
  assert.match(recovery, /catch \{\s*connectionState\.failIntent\(intent\);\s*emit\(\);/);
  assert.match(policy, /catch \{\s*connectionState\.failIntent\(intent\);\s*emit\(\);/);
});

test('connect and reconnect fail closed around quit and coalesce before creating an intent', () => {
  const quitGate = source.slice(
    source.indexOf('function rejectConnectionWhileQuitting('),
    source.indexOf('async function connect('),
  );
  const connectBody = source.slice(
    source.indexOf('async function connect('),
    source.indexOf('\nfunction handleEngineClose('),
  );
  const reconnectBody = source.slice(
    source.indexOf('async function reconnect('),
    source.indexOf('// ---------- PAC file'),
  );
  assert.match(quitGate, /desktopShell\?\.isQuitting !== true/);
  assert.match(quitGate, /connectionState\.failIntent\(intent\); emit\(\)/);
  assert.match(connectBody, /rejectConnectionWhileQuitting\(expectedIntent \?\? undefined\)/);
  assert.match(connectBody, /if \(disconnectInFlight\) await disconnectInFlight;[\s\S]*rejectConnectionWhileQuitting/);
  assert.match(connectBody, /if \(current\.desiredConnected\)[\s\S]*current\.intent/);
  assert.match(reconnectBody, /rejectConnectionWhileQuitting\(\)/);
  assert.match(reconnectBody, /const stopResult = await stopped;[\s\S]*rejectConnectionWhileQuitting\(intent\)/);
});
