'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { create } = require('../../../renderer/features/browser-data-settings/index.mjs');

test('package and bootstrap consume the native owner without the retired classic script', () => {
  const read = file => fs.readFileSync(path.resolve(__dirname, '../../../', file), 'utf8');
  assert.doesNotMatch(read('renderer/index.html'), /src="browser-data-settings\.js"/u);
  assert.doesNotMatch(read('renderer/app.js'), /window\.browserDataSettings/u);
  assert.match(read('renderer/app.js'), /rendererFeatures\.mount\('browser-data-settings'/u);
  const verifier = read('build/verify-package.js');
  assert.match(verifier, /const requiredEntries = \[[\s\S]*?'\/renderer\/features\/browser-data-settings\/index\.mjs'/u);
  assert.doesNotMatch(verifier, /'\/renderer\/browser-data-settings\.js'/u);
  assert.doesNotMatch(verifier, /'browser-data-settings',/u);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(pending = null) {
  const buttonListeners = new Map(), docListeners = new Map(), states = [];
  let requests = 0;
  const button = { disabled: false, textContent: '',
    addEventListener: (name, callback) => buttonListeners.set(name, callback),
    removeEventListener: name => buttonListeners.delete(name) };
  const status = { textContent: '' };
  const document = { getElementById: id => id === 'clearBrowserData' ? button : status,
    addEventListener: (name, callback) => docListeners.set(name, callback),
    removeEventListener: name => docListeners.delete(name) };
  const dependencies = { api: { clearBrowserData: () => { requests++; return pending || Promise.resolve({ ok: true }); } },
    document, translate: key => key, onClearState: state => states.push(state) };
  const feature = create(dependencies);
  return { feature, button, status, document, buttonListeners, docListeners, states,
    requests: () => requests, dependencies };
}

test('native clear owner validates capabilities and starts once without clearing data', () => {
  const f = fixture();
  assert.throws(() => create({ ...f.dependencies, api: {} }), TypeError);
  assert.equal(f.buttonListeners.size, 0);
  assert.equal(f.feature.start(), true);
  assert.equal(f.feature.start(), false);
  assert.equal(f.requests(), 0);
});

test('busy clear rejects repeated clicks and locale changes without losing its result', async () => {
  const pending = deferred(), f = fixture(pending.promise);
  f.feature.start();
  const click = f.buttonListeners.get('click');
  await click();
  const clearing = click();
  assert.equal(f.button.disabled, true);
  await click(); f.docListeners.get('app-locale-changed')();
  assert.equal(f.requests(), 1);
  assert.equal(f.status.textContent, 'settings.clearingBrowserData');
  pending.resolve({ ok: true }); await clearing;
  assert.deepEqual(f.states, [true, false]);
  assert.equal(f.status.textContent, 'settings.browserDataCleared');
  assert.equal(f.button.disabled, false);
});

test('terminal disposal detaches both handlers and retained callbacks cannot clear or reset', async () => {
  const f = fixture(); f.feature.start();
  const click = f.buttonListeners.get('click'), locale = f.docListeners.get('app-locale-changed');
  await click();
  const armedText = f.button.textContent;
  assert.equal(f.feature.dispose(), true);
  assert.equal(f.feature.dispose(), false);
  assert.equal(f.feature.start(), false);
  assert.equal(f.buttonListeners.size, 0); assert.equal(f.docListeners.size, 0);
  await click(); locale(); f.feature.reset();
  assert.equal(f.requests(), 0);
  assert.equal(f.button.textContent, armedText);
});

test('late resolve or rejection after retirement cannot update feedback or another feature', async () => {
  for (const reject of [false, true]) {
    const pending = deferred(), f = fixture(pending.promise); f.feature.start();
    const click = f.buttonListeners.get('click'); await click(); const clearing = click();
    f.feature.dispose();
    if (reject) pending.reject(new Error('synthetic retired clear'));
    else pending.resolve({ ok: true });
    await clearing;
    assert.deepEqual(f.states, [true]);
    assert.equal(f.status.textContent, 'settings.clearingBrowserData');
    assert.equal(f.button.disabled, true);
  }
});

test('cleanup failure attempts remaining listener and never resurrects the feature', () => {
  const f = fixture(); f.feature.start();
  f.document.removeEventListener = () => { throw new Error('synthetic removal failure'); };
  assert.throws(() => f.feature.dispose(), AggregateError);
  assert.equal(f.buttonListeners.size, 0);
  assert.equal(f.feature.dispose(), false);
  assert.equal(f.feature.start(), false);
});

test('retirement during the injected display callback cannot submit a new Main clear', async () => {
  const f = fixture();
  const feature = create({ ...f.dependencies, onClearState: () => feature.dispose() });
  feature.start();
  const click = f.buttonListeners.get('click');
  await click(); await click();
  assert.equal(f.requests(), 0);
  assert.equal(feature.start(), false);
});

test('refused or rejected clears retain failure feedback and require new confirmation', async () => {
  for (const outcome of [{ ok: false, error: 'synthetic refusal' }, null]) {
    const f = fixture();
    const feature = create({ ...f.dependencies, api: { clearBrowserData: async () => {
      if (!outcome) throw new Error('synthetic request failure');
      return outcome;
    } } });
    feature.start(); const click = f.buttonListeners.get('click');
    await click(); await click();
    assert.equal(f.status.textContent, outcome?.error || 'settings.browserDataClearFailed');
    assert.equal(f.button.disabled, false);
    assert.equal(f.button.textContent, 'settings.clearBrowserData');
    await click();
    assert.equal(f.status.textContent, 'settings.clearBrowserDataConfirmHint');
  }
});
