'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { BrowserPagePresentationOwner } = require('../../../../lib/browser/toolbar/browser-toolbar-owner');

function fixture() {
  const effects = [], timers = [], tabs = new Set();
  let window = { isDestroyed: () => false }, current = true;
  const ports = Object.fromEntries(['scheduleToolbarUpdate', 'windowOpenResponse',
    'fillSharedPortalCredential', 'markCredentialNavigation', 'updateTabRoute',
    'recordPortalSessionUrl', 'recordPageOpen', 'refreshWorkspaceHomes',
    'clearCredentialCandidate', 'stageCredentialCandidate', 'confirmCredentialPageState',
    'cancelCertificatePrompts', 'handleKeyboard', 'reportError'].map(name => [name,
    (...args) => { effects.push([name, ...args]); return name === 'windowOpenResponse'
      ? { action: 'deny' } : Promise.resolve(false); }]));
  const owner = new BrowserPagePresentationOwner({
    getWindow: () => window, isContextCurrent: () => current, containsTab: tab => tabs.has(tab),
    currentUrl: tab => tab.view.webContents.url, getHomeUrl: () => 'https://portal.example.invalid/',
    getTranslator: () => (key, vars) => vars?.reason ? `${key}:${vars.reason}` : key,
    safePopupUrl: url => /^(https?:|about:blank)/u.test(url), blankUrl: 'about:blank',
    slowLoadingHintMs: 10000, effects: ports,
    timers: { setTimeout(callback, delay) {
      const handle = { callback, delay, unref() {} }; timers.push(handle); return handle;
    }, clearTimeout: handle => { handle.cancelled = true; } },
  });
  function addTab() {
    const contents = new EventEmitter();
    contents.url = 'https://page.example.invalid/';
    contents.isDestroyed = () => false;
    contents.setWindowOpenHandler = handler => { contents.openHandler = handler; };
    contents.loads = [];
    contents.loadURL = url => { contents.loads.push(url); return Promise.resolve(); };
    const tab = { view: { webContents: contents }, route: 'direct', slow: false,
      slowTimer: null, loading: false, failedUrl: '', renderingError: false, kind: 'blank' };
    tabs.add(tab); return tab;
  }
  return { owner, effects, ports, timers, tabs, addTab,
    setWindow: value => { window = value; }, retire: () => { current = false; } };
}

test('page subscriptions are idempotent and detach only their own listeners', () => {
  const f = fixture(), tab = f.addTab(), contents = tab.view.webContents;
  let otherCalls = 0;
  const external = () => { otherCalls++; };
  contents.on('page-title-updated', external);
  assert.equal(f.owner.attach(tab), true);
  assert.equal(f.owner.attach(tab), true);
  assert.equal(contents.listenerCount('did-start-loading'), 1);
  assert.equal(contents.listenerCount('page-title-updated'), 2);
  const stale = contents.listeners('did-start-loading')[0];
  const stalePopup = contents.openHandler;
  contents.emit('did-start-loading');
  assert.equal(tab.loading, true);
  assert.equal(f.timers[0].delay, 10000);
  assert.equal(f.owner.detach(tab), true);
  assert.equal(f.owner.detach(tab), false);
  assert.equal(f.owner.records.size, 0);
  assert.equal(contents.listenerCount('did-start-loading'), 0);
  assert.equal(contents.listenerCount('page-title-updated'), 1);
  assert.equal(tab.slowTimer, null);
  f.effects.length = 0; stale(); f.timers[0].callback();
  assert.deepEqual(f.effects, []);
  assert.deepEqual(stalePopup({ url: contents.url }), { action: 'deny' });
  contents.emit('page-title-updated');
  assert.equal(otherCalls, 1);
});

test('slow callbacks cannot clear or mark a replacement loading timer', () => {
  const f = fixture(), tab = f.addTab(), contents = tab.view.webContents;
  f.owner.attach(tab);
  contents.emit('did-start-loading'); const first = tab.slowTimer;
  contents.emit('did-start-loading'); const second = tab.slowTimer;
  assert.notEqual(first, second); assert.equal(first.cancelled, true);
  first.callback(); assert.equal(tab.slow, false); assert.equal(tab.slowTimer, second);
  second.callback(); assert.equal(tab.slow, true); assert.equal(tab.slowTimer, null);
  contents.emit('did-stop-loading');
  assert.equal(tab.loading, false); assert.equal(tab.slow, false); assert.equal(tab.loadingLabel, '');
  f.owner.reset(); f.owner.reset(); assert.equal(f.owner.records.size, 0);
});

test('background page events remain active but removed/window/context events are inert', () => {
  for (const retire of [f => f.retire(), f => f.setWindow({ isDestroyed: () => false }),
    (f, tab) => f.tabs.delete(tab), (_f, tab) => { tab.view.webContents.isDestroyed = () => true; }]) {
    const f = fixture(), tab = f.addTab(), contents = tab.view.webContents;
    f.owner.attach(tab); contents.emit('page-title-updated');
    assert.equal(f.effects.length, 1);
    retire(f, tab); f.effects.length = 0;
    contents.emit('page-title-updated'); contents.emit('dom-ready');
    contents.emit('ipc-message', {}, 'campus-credential-candidate', {});
    contents.emit('render-process-gone', {}, { reason: 'crashed' });
    assert.deepEqual(f.effects, []);
    assert.deepEqual(contents.openHandler({ url: contents.url }), { action: 'deny' });
    let prevented = 0;
    contents.emit('will-navigate', { preventDefault: () => { prevented++; } }, contents.url);
    assert.equal(prevented, 1, 'retired navigation cannot escape its boundary');
    f.owner.reset();
  }
});

test('recent-page completion is fenced by both page navigation and lifetime', async () => {
  for (const retire of [f => f.owner.reset(), (f, tab) => f.tabs.delete(tab),
    (f, tab) => tab.view.webContents.emit('did-navigate-in-page', {}, tab.view.webContents.url)]) {
    const f = fixture(), tab = f.addTab(), contents = tab.view.webContents;
    let finish;
    f.ports.recordPageOpen = () => new Promise(resolve => { finish = resolve; });
    f.owner.attach(tab); contents.emit('did-navigate', {}, contents.url, 200);
    assert.equal(tab.kind, undefined);
    retire(f, tab); finish(true); await new Promise(setImmediate);
    assert.equal(f.effects.some(([name]) => name === 'refreshWorkspaceHomes'), false);
  }
  const f = fixture(), tab = f.addTab();
  f.ports.recordPageOpen = async () => true;
  f.owner.attach(tab); tab.view.webContents.emit('did-navigate', {}, tab.view.webContents.url, 200);
  await new Promise(setImmediate);
  assert.equal(f.effects.some(([name]) => name === 'refreshWorkspaceHomes'), true);
});

test('load failure/crash retain safe retry state and suppress stale crash feedback', async () => {
  const f = fixture(), tab = f.addTab(), contents = tab.view.webContents;
  f.owner.attach(tab);
  for (const [code, main, url] of [[-3, true, contents.url], [-105, false, contents.url],
    [-105, true, 'file:///synthetic']]) {
    contents.emit('did-fail-provisional-load', {}, code, 'synthetic', url, main);
  }
  assert.equal(contents.loads.length, 0);
  contents.emit('did-fail-provisional-load', {}, -105, 'synthetic', contents.url, true);
  assert.equal(tab.failedUrl, contents.url); assert.equal(tab.renderingError, true);
  assert.equal(f.effects.filter(([name]) => name === 'clearCredentialCandidate').length, 1);
  assert.match(contents.loads[0], /^data:text\/html/u);
  let reject;
  contents.loadURL = () => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; });
  f.owner.handleRendererCrash(tab, { reason: 'crashed' });
  assert.equal(f.effects.filter(([name]) => name === 'clearCredentialCandidate').length, 2);
  assert.equal(tab.crashed, true); f.owner.reset();
  reject(new Error('synthetic page renderer retired')); await new Promise(setImmediate);
  assert.equal(f.effects.some(([name]) => name === 'reportError'), false);
});

test('web navigation and bounded portal recording retain the existing protocol/origin policy', () => {
  const f = fixture(), tab = f.addTab(), contents = tab.view.webContents;
  f.owner.attach(tab); let prevented = 0;
  const event = { preventDefault: () => { prevented++; } };
  contents.emit('will-redirect', event, 'file:///synthetic');
  contents.emit('will-redirect', event, contents.url);
  assert.equal(prevented, 1);
  f.ports.recordPortalSessionUrl = () => true;
  assert.equal(f.owner.recordPortalSessionUrl('https://portal.example.invalid/home'), true);
  for (const url of ['http://portal.example.invalid/', 'https://other.example.invalid/',
    'https://synthetic:synthetic@portal.example.invalid/', 'https://portal.example.invalid/' + 'x'.repeat(2048)]) {
    assert.equal(f.owner.recordPortalSessionUrl(url), false);
  }
  f.retire(); assert.equal(f.owner.recordPortalSessionUrl('https://portal.example.invalid/'), false);
});

test('destruction and reset remove owned records and deny subsequent popup dispatch', () => {
  const f = fixture(), tab = f.addTab(), contents = tab.view.webContents;
  f.owner.attach(tab); contents.emit('destroyed');
  assert.equal(f.owner.records.size, 0); assert.equal(contents.eventNames().length, 0);
  assert.deepEqual(contents.openHandler({ url: contents.url }), { action: 'deny' });
  assert.throws(() => new BrowserPagePresentationOwner(), /dependencies/);
});

test('cleanup failures stay owned and inert, attempt other records, and can be retried', () => {
  const f = fixture(), first = f.addTab(), second = f.addTab();
  f.owner.attach(first); f.owner.attach(second);
  const contents = first.view.webContents;
  const original = contents.removeListener;
  let failed = false;
  contents.removeListener = function(name, listener) {
    if (!failed && name === 'did-start-loading') { failed = true; throw new Error('synthetic detach failure'); }
    return original.call(this, name, listener);
  };
  assert.throws(() => f.owner.reset(), /cleanup is unconfirmed/);
  assert.equal(f.owner.records.size, 1, 'failed cleanup remains owned for retry');
  assert.equal(f.owner.records.has(second), false, 'one failure cannot skip another record');
  f.effects.length = 0; contents.emit('did-start-loading');
  assert.deepEqual(f.effects, [], 'failed cleanup must still invalidate every old callback');
  assert.deepEqual(contents.openHandler({ url: contents.url }), { action: 'deny' });
  f.owner.reset(); assert.equal(f.owner.records.size, 0);
  assert.equal(contents.listenerCount('did-start-loading'), 0);
});
