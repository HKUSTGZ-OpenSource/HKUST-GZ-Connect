'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { create } = require('../../../renderer/features/control-tower/index.mjs');

class Element {
  constructor() {
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = true;
    this.textContent = '';
    this.dataset = {};
    this.focused = false;
    this.listeners = new Map();
    const classes = new Set();
    this.classList = {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
      contains: name => classes.has(name),
    };
  }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter(value => value !== listener));
  }

  dispatch(type) { return (this.listeners.get(type) || []).map(listener => listener({ target: this })); }
  focus() { this.focused = true; }
}

function fixture(overrides = {}) {
  const elements = new Map([
    'towerPort', 'strictProxyAuth', 'autoReconnect', 'maxAttempts', 'startAtLogin',
    'autoConnect', 'towerActions', 'towerSaved', 'towerSave', 'socksEndpoint',
  ].map(id => [id, new Element()]));
  const copy = new Element();
  copy.dataset.copy = 'socks';
  copy.textContent = 'Copy';
  const timers = new Map();
  let timerId = 0;
  const calls = [];
  let currentSettings = {};
  const proxyAuth = { isBusy: () => false, render: () => calls.push('proxy-render') };
  const dependencies = {
    document: {
      getElementById: id => elements.get(id),
      querySelectorAll: selector => selector === '[data-copy]' ? [copy] : [],
    },
    api: {
      save: async patch => { calls.push(['save', patch]); return { ok: true, settings: patch }; },
      copy: async text => calls.push(['copy', text]),
    },
    translate: key => key,
    getSettings: () => currentSettings,
    setSettings: value => { currentSettings = value; calls.push('settings'); },
    refreshState: async () => { calls.push('refresh'); },
    getProxyAuth: () => proxyAuth,
    timers: {
      setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
      clearTimeout: id => { timers.delete(id); },
    },
    ...overrides,
  };
  return { feature: create(dependencies), elements, copy, timers, calls, dependencies,
    proxyAuth, getSettings: () => currentSettings };
}

test('Control Tower owns form projection and preserves dirty fields on background refresh', () => {
  const f = fixture();
  assert.equal(f.feature.start(), true);
  assert.equal(f.feature.start(), false);
  f.feature.render({ port: 6180, strictProxyAuth: true, autoReconnect: false,
    maxAttempts: 4, startAtLogin: true, autoConnect: false });
  assert.equal(f.elements.get('towerPort').value, 6180);
  assert.equal(f.elements.get('strictProxyAuth').checked, true);
  assert.equal(f.elements.get('autoReconnect').checked, false);
  assert.equal(f.elements.get('maxAttempts').value, 4);
  assert.equal(f.elements.get('startAtLogin').checked, true);
  assert.equal(f.elements.get('autoConnect').checked, false);
  assert.equal(f.elements.get('socksEndpoint').textContent, '127.0.0.1:6180');
  f.elements.get('towerPort').value = '7000';
  f.elements.get('towerPort').dispatch('input');
  assert.equal(f.feature.isDirty(), true);
  assert.equal(f.elements.get('towerActions').hidden, false);
  f.feature.render({ port: 6200 }, { preserve: true });
  assert.equal(f.elements.get('towerPort').value, '7000');
  assert.equal(f.elements.get('socksEndpoint').textContent, '127.0.0.1:6200');
  assert.equal(f.feature.dispose(), true);
  assert.equal(f.feature.dispose(), false);
  assert.equal(f.elements.get('towerPort').listeners.get('input').length, 0);
});

test('Control Tower validates before saving and applies one exact settings patch', async () => {
  const f = fixture();
  f.feature.start();
  f.feature.render({ port: 6180, maxAttempts: 3 });
  f.elements.get('towerPort').value = '80';
  assert.deepEqual(await f.feature.apply(), { ok: false });
  assert.equal(f.elements.get('towerPort').focused, true);
  assert.ok(!f.calls.some(value => Array.isArray(value) && value[0] === 'save'));
  f.elements.get('towerPort').value = '6181';
  f.elements.get('maxAttempts').value = '11';
  assert.deepEqual(await f.feature.apply(), { ok: false });
  assert.equal(f.elements.get('maxAttempts').focused, true);
  f.elements.get('maxAttempts').value = '2';
  f.elements.get('strictProxyAuth').checked = true;
  f.elements.get('autoReconnect').checked = false;
  f.elements.get('startAtLogin').checked = true;
  f.elements.get('autoConnect').checked = false;
  const result = await f.feature.apply();
  assert.equal(result.ok, true);
  assert.deepEqual(f.calls.find(value => Array.isArray(value) && value[0] === 'save')[1], {
    port: 6181, strictProxyAuth: true, autoReconnect: false,
    maxAttempts: 2, startAtLogin: true, autoConnect: false,
  });
  assert.equal(f.feature.isSaving(), false);
  assert.ok(f.calls.includes('refresh'));
  f.feature.dispose();
});

test('Control Tower serializes apply with proxy-auth migration and retires feedback timers', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const f = fixture({ api: {
    save: async () => pending,
    copy: async () => {},
  } });
  f.feature.start();
  f.feature.render({ port: 6180, maxAttempts: 3 });
  f.proxyAuth.isBusy = () => true;
  assert.deepEqual(await f.feature.apply(), { ok: false, busy: true });
  f.proxyAuth.isBusy = () => false;
  const applying = f.feature.apply();
  assert.equal(f.feature.isSaving(), true);
  assert.deepEqual(await f.feature.apply(), { ok: false, busy: true });
  release({ ok: true, settings: { port: 6180 } });
  assert.equal((await applying).ok, true);
  f.feature.flash('synthetic saved');
  assert.equal(f.timers.size, 1);
  f.feature.dispose();
  assert.equal(f.timers.size, 0);
  assert.equal(f.elements.get('towerSave').listeners.get('click').length, 0);
});

test('Control Tower keeps copy action scoped to SOCKS endpoint', async () => {
  const f = fixture();
  f.feature.start();
  f.dependencies.setSettings({ port: 6180 });
  f.feature.render({ port: 6180 });
  await f.copy.dispatch('click')[0];
  assert.deepEqual(f.calls.find(value => Array.isArray(value) && value[0] === 'copy'),
    ['copy', '127.0.0.1:6180']);
  f.copy.dataset.copy = 'unsupported';
  await f.copy.dispatch('click')[0];
  assert.equal(f.copy.classList.contains('done'), true);
  assert.equal(f.elements.get('towerSaved').classList.contains('error'), true);
  f.feature.dispose();
});

test('failed reconnect remains visible without reporting that settings were applied', async () => {
  const f = fixture({ api: {
    save: async () => ({ ok: true, outcome: 'saved_reconnect_failed',
      warning: 'synthetic reconnect failed', settings: { port: 6180 } }),
    copy: async () => {},
  } });
  f.feature.start();
  f.feature.render({ port: 6180, maxAttempts: 3 });
  assert.equal((await f.feature.apply()).ok, true);
  assert.equal(f.elements.get('towerSaved').textContent,
    'tower.saved · synthetic reconnect failed');
  assert.equal(f.elements.get('towerSaved').classList.contains('error'), true);
  assert.equal([...f.timers.values()][0].delay, 3500);
  f.feature.dispose();
});

test('disposal fences a pending settings reply and removes all listeners', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const f = fixture({ api: { save: () => pending, copy: async () => {} } });
  f.feature.start();
  f.feature.render({ port: 6180, maxAttempts: 3 });
  const operation = f.feature.apply();
  assert.equal(f.elements.get('towerSave').disabled, true);
  assert.equal(f.feature.dispose(), true);
  const before = f.elements.get('towerSaved').textContent;
  resolve({ ok: true, settings: { port: 6180 } });
  assert.deepEqual(await operation, { ok: false, stale: true });
  assert.equal(f.elements.get('towerSaved').textContent, before);
  assert.equal(f.elements.get('towerSave').listeners.get('click').length, 0);
  assert.equal(f.feature.start(), false);
  assert.ok(!f.calls.includes('refresh'));
});
