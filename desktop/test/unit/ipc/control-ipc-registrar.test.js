'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const { createTrustedControlRegistrar } = require('../../../lib/ipc/control-ipc-suite');

function fixture() {
  const handlers = new Map(), effects = [];
  const allowed = path.resolve('/fixture/renderer/index.html'), url = pathToFileURL(allowed).href;
  let control = null;
  const options = { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    getWebContents: () => { effects.push('contents'); return control; }, allowedFiles: [allowed] };
  return { options, handlers, effects, url,
    setControl: next => { control = next; },
    event: sender => ({ sender, senderFrame: { url } }),
  };
}

test('public registrar validates its ports without registration or window lookup', () => {
  const f = fixture();
  const register = createTrustedControlRegistrar(f.options);
  assert.equal(typeof register, 'function');
  assert.equal(f.handlers.size, 0); assert.deepEqual(f.effects, []);
  assert.throws(() => createTrustedControlRegistrar({ ...f.options, ipcMain: {} }), TypeError);
  assert.throws(() => createTrustedControlRegistrar({ ...f.options, getWebContents: null }), TypeError);
});

test('the existing channel/handler validation rejects invalid declarations before effects', () => {
  const f = fixture(), register = createTrustedControlRegistrar(f.options);
  for (const [channel, handler] of [['bad/channel', () => {}], ['a'.repeat(65), () => {}], ['valid', null]]) {
    assert.throws(() => register(channel, handler), TypeError);
  }
  assert.equal(f.handlers.size, 0); assert.deepEqual(f.effects, []);
});

test('trusted local events retain handler arguments and reject another sender or frame', () => {
  const f = fixture(), register = createTrustedControlRegistrar(f.options);
  const control = { getURL: () => f.url }; f.setControl(control);
  let calls = 0;
  const result = Object.freeze({ ok: true }), payload = { synthetic: true }, event = f.event(control);
  assert.equal(register('synthetic-ping', (received, value, count) => {
    calls++; assert.equal(received, event); assert.equal(value, payload); assert.equal(count, 7); return result;
  }), undefined, 'the original Main registration return remains void');
  const invoke = f.handlers.get('synthetic-ping');
  assert.equal(invoke(event, payload, 7), result);
  for (const rejected of [f.event({ getURL: control.getURL }),
    { sender: control, senderFrame: { url: 'https://untrusted.example.invalid/' } },
    { sender: control, senderFrame: { url: pathToFileURL(path.resolve('/fixture/other.html')).href } }]) {
    assert.throws(() => invoke(rejected, payload, 7), /不受信任/u);
  }
  assert.equal(calls, 1);
});

test('registered handlers resolve the current window at invocation, not construction', () => {
  const f = fixture(), register = createTrustedControlRegistrar(f.options);
  let calls = 0; register('synthetic-window', () => { calls++; return 'current'; });
  const invoke = f.handlers.get('synthetic-window'), first = { getURL: () => f.url };
  assert.throws(() => invoke(f.event(first)), /窗口当前不可用/u);
  f.setControl(first); assert.equal(invoke(f.event(first)), 'current');
  const replacement = { getURL: () => f.url }; f.setControl(replacement);
  assert.throws(() => invoke(f.event(first)), /不受信任/u);
  assert.equal(invoke(f.event(replacement)), 'current');
  f.setControl(null); assert.throws(() => invoke(f.event(replacement)), /窗口当前不可用/u);
  assert.equal(calls, 2);
});

test('a trusted asynchronous handler keeps its original rejection instead of rewriting policy', async () => {
  const f = fixture(), register = createTrustedControlRegistrar(f.options);
  const control = { getURL: () => f.url }, failure = new Error('synthetic handler refusal'); f.setControl(control);
  register('synthetic-failure', async () => { throw failure; });
  await assert.rejects(f.handlers.get('synthetic-failure')(f.event(control)), error => error === failure);
});
