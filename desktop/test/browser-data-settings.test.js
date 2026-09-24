'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { start } = require('../renderer/browser-data-settings');

function fixture(result = { ok: true }, onClearState = () => {}) {
  const listeners = new Map();
  const documentListeners = new Map();
  const button = {
    disabled: false,
    textContent: '',
    addEventListener: (name, handler) => listeners.set(name, handler),
  };
  const status = { textContent: '' };
  let calls = 0;
  start({
    api: { clearBrowserData: async () => { calls += 1; return result; } },
    document: {
      getElementById: (id) => id === 'clearBrowserData' ? button : status,
      addEventListener: (name, handler) => documentListeners.set(name, handler),
    },
    translate: (key) => key,
    onClearState,
  });
  return { button, status, listeners, documentListeners, get calls() { return calls; } };
}

test('browser data requires two clicks and reports a successful local clear', async () => {
  const f = fixture();
  await f.listeners.get('click')();
  assert.equal(f.calls, 0);
  assert.equal(f.button.textContent, 'settings.confirmClearBrowserData');
  assert.equal(f.status.textContent, 'settings.clearBrowserDataConfirmHint');
  await f.listeners.get('click')();
  assert.equal(f.calls, 1);
  assert.equal(f.button.textContent, 'settings.clearBrowserData');
  assert.equal(f.status.textContent, 'settings.browserDataCleared');
});

test('locale change disarms a pending destructive action', async () => {
  const f = fixture();
  await f.listeners.get('click')();
  f.documentListeners.get('app-locale-changed')();
  assert.equal(f.button.textContent, 'settings.clearBrowserData');
  assert.equal(f.status.textContent, '');
});

test('display cleanup failures report failure and allow a newly confirmed retry', async () => {
  for (const failingState of [true, false]) {
    let failOnce = true;
    const f = fixture({ ok: true }, pending => {
      if (pending === failingState && failOnce) { failOnce = false; throw new Error('synthetic display failure'); }
    });
    await f.listeners.get('click')();
    await f.listeners.get('click')();
    assert.equal(f.calls, failingState ? 0 : 1);
    assert.equal(f.status.textContent, 'settings.browserDataClearFailed');
    assert.equal(f.button.disabled, false);
    assert.equal(f.button.textContent, 'settings.clearBrowserData');
    const before = f.calls;
    await f.listeners.get('click')();
    assert.equal(f.calls, before);
    await f.listeners.get('click')();
    assert.equal(f.calls, before + 1);
    assert.equal(f.status.textContent, 'settings.browserDataCleared');
  }
});
