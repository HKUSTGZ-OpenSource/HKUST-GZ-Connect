'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { create } = require('../../../renderer/features/browser-new-tab-settings/index.mjs');

class Element {
  value = '';
  textContent = '';
  disabled = false;
  listeners = new Map();
  addEventListener(type, callback) {
    this.listeners.set(type, [...(this.listeners.get(type) || []), callback]);
  }
  removeEventListener(type, callback) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter(value => value !== callback));
  }
  dispatch(type, event = {}) { return (this.listeners.get(type) || []).map(callback => callback(event)); }
}

function fixture(overrides = {}) {
  const input = new Element(), button = new Element(), status = new Element();
  let settings = {};
  const requests = [];
  const dependencies = {
    document: { getElementById: id => ({ browserNewTabUrl: input,
      saveBrowserNewTabUrl: button, browserNewTabStatus: status })[id] || null },
    api: { save: async patch => { requests.push(patch); return { ok: true, settings: patch }; } },
    translate: key => key,
    getSettings: () => settings,
    setSettings: next => { settings = next; },
    ...overrides,
  };
  return { feature: create(dependencies), input, button, status, requests,
    settings: () => settings, dependencies };
}

test('native new-tab owner validates injected capabilities and markup before starting', () => {
  const f = fixture();
  assert.throws(() => create({ ...f.dependencies, api: {} }), TypeError);
  assert.throws(() => create({ ...f.dependencies, document: { getElementById: () => null } }), TypeError);
  assert.equal(f.input.listeners.size, 0);
});

test('default explicit rendering and one start preserve existing listeners and address', () => {
  const f = fixture();
  assert.equal(f.feature.start(), true);
  assert.equal(f.feature.start(), false);
  assert.equal(f.input.value, 'https://www.bing.com/');
  f.feature.render({ browserNewTabUrl: 'about:blank' });
  assert.equal(f.input.value, 'about:blank');
  assert.equal(f.button.listeners.get('click').length, 1);
  assert.equal(f.input.listeners.get('keydown').length, 1);
});

test('click save uses the existing bounded patch and Main canonical result', async () => {
  const f = fixture();
  f.feature.start();
  f.input.value = 'example.invalid';
  f.dependencies.api.save = async patch => {
    f.requests.push(patch); return { ok: true, settings: { browserNewTabUrl: 'https://example.invalid/' } };
  };
  await Promise.all(f.button.dispatch('click'));
  assert.deepEqual(f.requests, [{ browserNewTabUrl: 'example.invalid' }]);
  assert.deepEqual(f.settings(), { browserNewTabUrl: 'https://example.invalid/' });
  assert.equal(f.input.value, 'https://example.invalid/');
  assert.equal(f.status.textContent, 'settings.newTabSaved');
  assert.equal(f.button.disabled, false);
});

test('Enter prevents its default and saves while unrelated keys remain inert', async () => {
  const f = fixture();
  f.feature.start();
  let prevented = 0;
  f.input.value = 'about:blank';
  await Promise.all(f.input.dispatch('keydown', { key: 'Escape', preventDefault() { prevented++; } }));
  assert.equal(f.requests.length, 0);
  await Promise.all(f.input.dispatch('keydown', { key: 'Enter', preventDefault() { prevented++; } }));
  assert.equal(prevented, 1);
  assert.deepEqual(f.requests, [{ browserNewTabUrl: 'about:blank' }]);
});

test('Main refusal and thrown failures preserve settings and restore the control', async () => {
  for (const reject of [false, true]) {
    const f = fixture({ api: { save: async () => {
      if (reject) throw new Error('synthetic error not exposed');
      return { ok: false, error: 'synthetic bounded refusal' };
    } } });
    f.feature.start();
    await Promise.all(f.button.dispatch('click'));
    assert.deepEqual(f.settings(), {});
    assert.equal(f.button.disabled, false);
    assert.equal(f.status.textContent, reject ? 'settings.newTabSaveFailed' : 'synthetic bounded refusal');
  }
});

test('dispose detaches both listeners once and retained callbacks cannot save or repaint', async () => {
  const f = fixture();
  f.feature.start();
  const callback = f.button.listeners.get('click')[0];
  assert.equal(f.feature.dispose(), true);
  assert.equal(f.feature.dispose(), false);
  assert.equal(f.feature.start(), false);
  assert.equal(f.button.listeners.get('click').length, 0);
  assert.equal(f.input.listeners.get('keydown').length, 0);
  await callback();
  f.feature.render({ browserNewTabUrl: 'https://late.invalid/' });
  assert.equal(f.requests.length, 0);
  assert.equal(f.input.value, 'https://www.bing.com/');
});

test('late completion after disposal does not change local settings feedback or retired controls', async () => {
  for (const reject of [false, true]) {
    let resolve, fail;
    const pending = new Promise((yes, no) => { resolve = yes; fail = no; });
    const f = fixture({ api: { save: () => pending } });
    f.feature.start();
    const operations = f.button.dispatch('click');
    assert.equal(f.button.disabled, true);
    f.feature.dispose();
    if (reject) fail(new Error('synthetic retired response'));
    else resolve({ ok: true, settings: { browserNewTabUrl: 'https://late.invalid/' } });
    await Promise.all(operations);
    assert.deepEqual(f.settings(), {});
    assert.equal(f.status.textContent, '');
    assert.equal(f.button.disabled, true);
    assert.equal(f.input.value, 'https://www.bing.com/');
  }
});

test('cleanup attempts both listeners even when one removal fails and stays terminal', () => {
  const f = fixture();
  f.feature.start();
  f.input.removeEventListener = () => { throw new Error('synthetic removal failure'); };
  assert.throws(() => f.feature.dispose(), AggregateError);
  assert.equal(f.button.listeners.get('click').length, 0);
  assert.equal(f.feature.dispose(), false);
  assert.equal(f.feature.start(), false);
});
