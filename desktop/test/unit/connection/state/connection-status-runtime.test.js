'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ConnectionStateMachine, ConnectionStatusRuntime, projectConnectionStatus,
} = require('../../../../lib/connection/state/connection-state-machine');

function fixture() {
  const calls = [];
  const machine = new ConnectionStateMachine();
  let shell = null, telemetry = null, locale = 'zh', update = null, time = 1234;
  let currentGeneration = 7, currentToken = null;
  const runtime = new ConnectionStatusRuntime({
    connectionState: machine,
    waitRegistry: { observe: snapshot => calls.push(['observe', snapshot]) },
    getPacUrl: () => { calls.push(['pac']); return 'data:synthetic-pac'; },
    getShell: () => shell,
    getLocale: () => locale,
    getUpdate: () => update,
    translate: key => `${locale}:${key}`,
    clearCapabilities: () => calls.push(['capabilities']),
    getTelemetry: () => telemetry,
    now: () => time,
    isEngineCurrent: (generation, token) => generation === currentGeneration && token === currentToken,
  });
  return {
    calls, machine, runtime,
    shell: value => { shell = value; },
    telemetry: value => { telemetry = value; },
    locale: value => { locale = value; },
    update: value => { update = value; },
    time: value => { time = value; },
    currentEngine: (generation, token) => { currentGeneration = generation; currentToken = token; },
  };
}

test('construction creates one display record without effects or lifecycle authority', () => {
  const f = fixture();
  assert.deepEqual(f.calls, []);
  assert.equal(f.runtime.connectedAt, null);
  assert.deepEqual(f.runtime.state, {
    clientIp: null, dnsMode: 'unknown', lastError: null,
    failureCode: null, failureKind: 'none', settingsError: null,
    recoveryError: null, notice: null, browserNotice: null,
    diagnosticNotice: null, pacUrl: '',
  });
  assert.equal(f.runtime.state, f.runtime.state);
  assert.equal(Object.hasOwn(f.runtime.state, 'connected'), false);
  assert.equal(Object.hasOwn(f.runtime.state, 'connecting'), false);
  assert.deepEqual(f.runtime.snapshot(), projectConnectionStatus(
    f.runtime.state, f.machine.presentation(), null,
  ));
  const second = fixture();
  assert.notEqual(second.runtime.state, f.runtime.state);
});

test('snapshot projects fresh authoritative phases and preserves separate outcome domains', () => {
  const f = fixture();
  Object.assign(f.runtime.state, {
    lastError: 'engine', settingsError: 'settings', recoveryError: 'recovery',
    notice: 'notice', browserNotice: 'browser', diagnosticNotice: 'log',
    // A display-record writer cannot override the FSM projection.
    connected: true, connecting: true,
  });
  const first = f.runtime.snapshot();
  assert.equal(Object.isFrozen(first), true);
  assert.equal(first.connected, false);
  assert.equal(first.connecting, false);
  assert.equal(first.lastError, 'engine\nsettings\nrecovery');
  assert.equal(first.notice, 'notice\nbrowser\nlog');
  assert.equal(first.recovery.category, 'local-state');
  const intent = f.machine.beginConnectIntent();
  f.machine.beginConnectAttempt(intent);
  const second = f.runtime.snapshot();
  assert.equal(second.phase, 'starting');
  assert.equal(second.connecting, true);
  assert.equal(first.phase, 'idle');
  assert.deepEqual(f.calls, []);
});

test('emit observes current state before status and tray and reads late shell/locale/update', () => {
  const f = fixture();
  f.runtime.emit();
  assert.deepEqual(f.calls.map(call => call[0]), ['pac', 'observe']);
  assert.equal(f.runtime.state.pacUrl, 'data:synthetic-pac');
  const firstShell = {
    send: (...args) => f.calls.push(['send', ...args]),
    updateTray: () => f.calls.push(['tray']),
  };
  f.shell(firstShell);
  f.locale('en');
  const update = Object.freeze({ version: 'synthetic' });
  f.update(update);
  f.calls.length = 0;
  f.runtime.emit();
  assert.deepEqual(f.calls.map(call => call[0]), ['pac', 'observe', 'send', 'tray']);
  assert.deepEqual(f.calls[1][1], f.machine.snapshot());
  assert.equal(f.calls[2][1], 'status');
  assert.deepEqual(f.calls[2][2], { ...f.runtime.snapshot(), locale: 'en', update });
  assert.equal(f.calls[2][2].update, update);
  f.shell({
    send: (...args) => f.calls.push(['replacement', ...args]),
    updateTray: () => f.calls.push(['replacement-tray']),
  });
  f.update(null);
  f.calls.length = 0;
  f.runtime.emit();
  assert.deepEqual(f.calls.map(call => call[0]), ['pac', 'observe', 'replacement', 'replacement-tray']);
  assert.equal(f.calls[2][2].update, null);
});

test('emit preserves thrown effect boundaries rather than claiming partial success', () => {
  const f = fixture();
  const failure = new Error('synthetic send failure');
  f.shell({ send: () => { throw failure; }, updateTray: () => f.calls.push(['tray']) });
  assert.throws(() => f.runtime.emit(), error => error === failure);
  assert.deepEqual(f.calls.map(call => call[0]), ['pac', 'observe']);
});

test('connection time and clearing keep original telemetry/capability order without altering FSM', () => {
  const f = fixture();
  const token = Object.freeze({ synthetic: true });
  f.telemetry({
    start: (...args) => f.calls.push(['start', f.runtime.connectedAt, ...args]),
    stop: () => f.calls.push(['stop', f.runtime.connectedAt, f.runtime.state.clientIp,
      f.runtime.state.dnsMode]),
  });
  const before = f.machine.snapshot();
  f.runtime.firstConnected(7, token);
  assert.equal(f.runtime.connectedAt, 1234);
  assert.deepEqual(f.calls, [['start', 1234, 7, token]]);
  Object.assign(f.runtime.state, {
    clientIp: '192.0.2.10', dnsMode: 'gateway', browserNotice: 'retained',
    lastError: 'retained failure', settingsError: 'retained settings',
  });
  f.calls.length = 0;
  f.runtime.clear();
  assert.equal(f.runtime.connectedAt, null);
  assert.equal(f.runtime.state.clientIp, null);
  assert.equal(f.runtime.state.dnsMode, 'unknown');
  assert.equal(f.runtime.state.browserNotice, 'retained');
  assert.equal(f.runtime.state.lastError, 'retained failure');
  assert.equal(f.runtime.state.settingsError, 'retained settings');
  assert.deepEqual(f.calls, [['capabilities'], ['stop', null, null, 'unknown']]);
  assert.deepEqual(f.machine.snapshot(), before);
  f.telemetry(null);
  f.calls.length = 0;
  assert.equal(f.runtime.clear(), undefined);
  assert.deepEqual(f.calls, [['capabilities']]);
});

test('log failure/recovery emits only on notice changes and preserves other outcomes', () => {
  const f = fixture();
  f.runtime.state.browserNotice = 'browser';
  f.runtime.state.settingsError = 'settings';
  f.runtime.reportLogFailure();
  assert.equal(f.runtime.state.diagnosticNotice, 'zh:error.logUnavailable');
  assert.deepEqual(f.calls.map(call => call[0]), ['pac', 'observe']);
  f.calls.length = 0;
  f.locale('en');
  f.runtime.reportLogFailure();
  assert.deepEqual(f.calls, []);
  assert.equal(f.runtime.state.diagnosticNotice, 'zh:error.logUnavailable');
  f.runtime.reportLogRecovered();
  assert.equal(f.runtime.state.diagnosticNotice, null);
  assert.equal(f.runtime.state.browserNotice, 'browser');
  assert.equal(f.runtime.state.settingsError, 'settings');
  assert.deepEqual(f.calls.map(call => call[0]), ['pac', 'observe']);
  f.calls.length = 0;
  f.runtime.reportLogRecovered();
  assert.deepEqual(f.calls, []);
  f.runtime.reportLogFailure();
  assert.equal(f.runtime.state.diagnosticNotice, 'en:error.logUnavailable');
});

test('recovery feedback ignores retired Engine generations and context tokens', () => {
  const f = fixture();
  const token = Object.freeze({ synthetic: 'current' });
  f.currentEngine(7, token);
  f.runtime.state.lastError = 'previous';
  f.runtime.reportRecovering(6, token);
  f.runtime.reportRecovering(7, { synthetic: 'retired' });
  assert.equal(f.runtime.state.lastError, 'previous');
  assert.deepEqual(f.calls, []);
  const before = f.machine.snapshot();
  f.runtime.reportRecovering(7, token);
  assert.equal(f.runtime.state.lastError, 'zh:error.tunnelRecovering');
  assert.deepEqual(f.calls.map(call => call[0]), ['pac', 'observe']);
  assert.deepEqual(f.machine.snapshot(), before);
});
