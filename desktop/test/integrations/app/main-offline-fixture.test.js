'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createOfflineGuard, createMainOfflineFixture, MAIN_FIXTURE_DEADLINE_MS } = require('../../../e2e/support/main-offline-fixture');
const filter = { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] };

function ownedSession() {
  let native, nativeFilter, registrations = 0;
  const owner = { webRequest: { onBeforeRequest(value, listener) {
    nativeFilter = value; native = listener; registrations++;
  } } };
  return { owner, request: (url, callback) => native({ url }, callback),
    nativeFilter: () => nativeFilter, registrations: () => registrations };
}

test('Main guard blocks all four external protocols without invoking a production listener', () => {
  const guard = createOfflineGuard(), f = ownedSession(); guard.installSession(f.owner);
  f.owner.webRequest.onBeforeRequest(filter, () => { throw new Error('external request reached production listener'); });
  for (const scheme of ['http', 'https', 'ws', 'wss']) {
    let replies = 0;
    f.request(`${scheme}://outside.invalid/`, result => { replies++; assert.deepEqual(result, { cancel: true }); });
    assert.equal(replies, 1);
  }
  assert.deepEqual(f.nativeFilter(), filter); assert.equal(guard.snapshot().blocked, 4);
});

test('Main guard preserves the exact loopback allow/cancel decision, latest listener and removal', () => {
  const guard = createOfflineGuard(), f = ownedSession(); guard.installSession(f.owner); guard.installSession(f.owner);
  assert.equal(f.registrations(), 1);
  for (const decision of [{ cancel: false }, { cancel: true }]) {
    f.owner.webRequest.onBeforeRequest(filter, (_details, callback) => callback(decision));
    f.request('ws://127.0.0.1/fixture', result => assert.equal(result, decision));
    f.request('https://[::1]/fixture', result => assert.equal(result, decision));
  }
  f.owner.webRequest.onBeforeRequest(null);
  f.request('http://127.0.0.1/fixture', result => assert.deepEqual(result, {}));
  f.request('wss://outside.invalid/fixture', result => assert.deepEqual(result, { cancel: true }));
  assert.equal(guard.snapshot().originalAllowed, 2); assert.equal(guard.snapshot().originalCancelled, 2);
});

test('unexpected filter shapes cannot silently remove WebSocket coverage or replace the existing listener', () => {
  const guard = createOfflineGuard(), f = ownedSession(); guard.installSession(f.owner);
  f.owner.webRequest.onBeforeRequest(filter, (_details, callback) => callback({ cancel: true }));
  for (const unsupported of [{ urls: ['http://*/*', 'https://*/*'] }, { ...filter, types: ['mainFrame'] }]) {
    assert.throws(() => f.owner.webRequest.onBeforeRequest(unsupported, () => {}));
    f.request('http://127.0.0.1/fixture', result => assert.deepEqual(result, { cancel: true }));
  }
  for (const target of ['http://localhost/', 'https://127.0.0.1.outside.invalid/']) {
    f.request(target, result => assert.deepEqual(result, { cancel: true }));
  }
});

function lifecycle(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const app = new EventEmitter(), f = ownedSession(), exits = [], messages = [], dialog = {};
  app.isReady = () => false; app.exit = code => exits.push(code);
  const fixture = createMainOfflineFixture({ app, session: { defaultSession: f.owner }, dialog, report: value => messages.push(value) });
  t.after(() => app.emit('quit'));
  return { app, session: f, fixture, exits, messages, dialog };
}

test('Main watchdog covers startup and named in-flight or quit stages without extending its budget', t => {
  const f = lifecycle(t); f.fixture.stage('parked quit cleanup');
  t.mock.timers.tick(MAIN_FIXTURE_DEADLINE_MS - 1); assert.deepEqual(f.exits, []);
  t.mock.timers.tick(1); assert.deepEqual(f.exits, [1]);
  assert.deepEqual(f.messages, ['main integration timed out during parked quit cleanup']);
});

test('normal quit releases watchdog and startup failures never open an interactive error dialog', t => {
  const f = lifecycle(t);
  f.dialog.showErrorBox('Synthetic title', 'Synthetic startup failure');
  assert.deepEqual(f.exits, [1]); assert.match(f.messages[0], /Synthetic startup failure/);
  f.app.emit('quit'); t.mock.timers.tick(MAIN_FIXTURE_DEADLINE_MS);
  assert.deepEqual(f.exits, [1]);
});

test('isolation evidence distinguishes blocked origins, actual listener registration and loopback forwarding', t => {
  const f = lifecycle(t); f.app.emit('session-created', f.session.owner); f.app.emit('ready');
  assert.equal(f.fixture.snapshot().sessions, 1);
  assert.throws(() => f.fixture.assertIsolation(['https://outside.invalid']));
  f.session.owner.webRequest.onBeforeRequest(filter, (_details, callback) => callback({ cancel: false }));
  f.session.request('https://outside.invalid/', () => {});
  for (let i = 0; i < 2; i++) f.session.request('http://127.0.0.1/fixture', () => {});
  f.fixture.assertIsolation(['https://outside.invalid']);
  assert.equal(f.fixture.snapshot().delegated, 2);
});
