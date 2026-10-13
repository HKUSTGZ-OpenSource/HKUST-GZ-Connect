'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { BrowserToolbarCommandOwner } = require('../../../../lib/browser/toolbar/browser-toolbar-owner');

function fixture() {
  const calls = [];
  const state = { window: { isDestroyed: () => false,
    webContents: { send: (...args) => calls.push(['send', ...args]) } }, current: true };
  const contents = {
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    findInPage(value, options) { calls.push(['find', value, options]); },
    stopFindInPage(value) { calls.push(['stop-find', value]); },
    getZoomFactor() { return this.zoom || 1; },
    setZoomFactor(value) { this.zoom = value; calls.push(['zoom', value]); },
  };
  const tab = { id: 7, view: { webContents: contents } };
  const actions = Object.fromEntries([
    'openNewTab', 'openHome', 'focusWorkspace', 'updateToolbar', 'switchTab',
    'closeTab', 'setTabRoute', 'manageCredential', 'openSettings', 'toggleFavorite',
    'focusWorkspaceSearch', 'beginNavigationIntent', 'reloadWhenReady',
    'navigateWhenReady', 'setFindBar', 'tabAt',
  ].map((name) => [name, (...args) => { calls.push([name, ...args]); return true; }]));
  actions.tabAt = (index) => index === 0 ? tab : null;
  const owner = new BrowserToolbarCommandOwner({
    getActiveTab: () => tab,
    getTabs: () => [tab],
    getWindow: () => state.window,
    isContextCurrent: () => state.current,
    getBookmarkBarState: () => [],
    getBookmarkMenu: () => null,
    getOpenResource: () => null,
    navigationForContents: () => ({
      canGoBack: () => true, canGoForward: () => false,
      goBack: () => calls.push(['back']), goForward: () => calls.push(['forward']),
    }),
    workspaceSearchQuery: (value) => value === 'SIS' ? value : null,
    nextZoomFactor: (_current, key) => key === '+' ? 1.1 : 1,
    translate: (key) => key,
    reportError: (message) => calls.push(['error', message]),
    actions,
    platform: 'darwin',
  });
  return { owner, calls, tab, contents, state };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

for (const retirement of ['closed', 'replacement', 'context', 'reset']) {
  for (const outcome of ['success', 'failure']) {
    test(`resource ${outcome} cannot publish after toolbar ${retirement}`, async () => {
      const f = fixture(), pending = deferred();
      f.owner.getOpenResource = () => () => pending.promise;
      assert.equal(f.owner.handleCommand({ command: 'open-resource', value: 'synthetic-resource' }), true);
      if (retirement === 'closed') f.state.window = null;
      else if (retirement === 'replacement') f.state.window = { isDestroyed: () => false };
      else if (retirement === 'context') f.state.current = false;
      else f.owner.reset();
      if (outcome === 'success') pending.resolve({ ok: true });
      else pending.reject(new Error('synthetic old-window error'));
      await new Promise(setImmediate);
      assert.deepEqual(f.calls, []);
    });
  }
}

for (const [command, method, value] of [
  ['new-tab', 'openNewTab', ''], ['home', 'openHome', ''], ['set-route', 'setTabRoute', 'direct'],
  ['toggle-favorite', 'toggleFavorite', ''], ['reload', 'reloadWhenReady', ''],
  ['navigate', 'navigateWhenReady', 'https://synthetic.example.test/'],
]) {
  test(`${command} errors remain quiet after its toolbar window retires`, async () => {
    const f = fixture(), pending = deferred();
    f.owner.actions[method] = () => pending.promise;
    f.owner.handleCommand({ command, value });
    f.state.window = null; pending.reject(new Error('synthetic retired command'));
    await new Promise(setImmediate); assert.deepEqual(f.calls, []);
  });
}

for (const key of ['t', 'r']) {
  test(`keyboard ${key} errors cannot publish after context retirement`, async () => {
    const f = fixture(), pending = deferred();
    f.owner.actions[key === 't' ? 'openNewTab' : 'reloadWhenReady'] = () => pending.promise;
    f.owner.handleKeyboard(f.tab, { preventDefault() {} }, { meta: true, key, type: 'keyDown' });
    f.state.current = false; pending.reject(new Error('synthetic retired shortcut'));
    await new Promise(setImmediate); assert.deepEqual(f.calls, []);
  });
}

test('reset is repeatable and clears the previous window find query without changing current feedback', async () => {
  const f = fixture(); f.owner.handleCommand({ command: 'find', value: 'synthetic search' });
  assert.equal(f.owner.reset(), true); assert.equal(f.owner.reset(), false);
  f.calls.length = 0;
  f.owner.handleCommand({ command: 'find-next', value: '' }); assert.deepEqual(f.calls, []);
  f.owner.getOpenResource = () => async () => ({ ok: true });
  f.owner.handleCommand({ command: 'open-resource', value: 'synthetic-resource' });
  await new Promise(setImmediate); assert.deepEqual(f.calls, [['updateToolbar']]);
});

test('retired contexts reject commands and keyboard before invoking any effect', () => {
  const f = fixture(); f.state.current = false;
  assert.equal(f.owner.handleCommand({ command: 'new-tab' }), false);
  f.owner.handleKeyboard(f.tab, { preventDefault: () => assert.fail('retired shortcut') },
    { meta: true, key: 't' }); assert.deepEqual(f.calls, []);
});

test('current synchronous action failures retain their original identity', () => {
  const f = fixture(), failure = new Error('synthetic synchronous action failure');
  f.owner.actions.openNewTab = () => { throw failure; };
  assert.throws(() => f.owner.handleCommand({ command: 'new-tab' }), error => error === failure);
});

test('current windowless value-free commands retain their existing facade contract', () => {
  const f = fixture(); f.state.window = null;
  assert.equal(f.owner.handleCommand({ command: 'open-settings' }), true);
  assert.deepEqual(f.calls, [['openSettings']]);
});

test('toolbar commands reject untrusted payloads and dispatch bounded tab actions', () => {
  const f = fixture();
  assert.equal(f.owner.handleCommand('about:blank#command=new-tab'), false);
  assert.equal(f.owner.handleCommand({ command: 'switch-tab', value: 7 }), true);
  assert.deepEqual(f.calls, [['switchTab', 7]]);
});

test('toolbar search and history use the active tab without changing route policy', () => {
  const f = fixture();
  assert.equal(f.owner.handleCommand({ command: 'navigate', value: 'SIS' }), true);
  assert.equal(f.owner.handleCommand({ command: 'back', value: '' }), true);
  assert.deepEqual(f.calls, [
    ['focusWorkspace', 'search', 'SIS'],
    ['beginNavigationIntent', f.tab],
    ['back'],
  ]);
});

test('find query stays per window and clears on an empty search', () => {
  const f = fixture();
  assert.equal(f.owner.handleCommand({ command: 'find', value: 'campus' }), true);
  assert.equal(f.owner.handleCommand({ command: 'find-next', value: '' }), true);
  assert.equal(f.owner.handleCommand({ command: 'find', value: '' }), true);
  assert.equal(f.owner.handleCommand({ command: 'find-prev', value: '' }), true);
  assert.deepEqual(f.calls, [
    ['find', 'campus', undefined],
    ['find', 'campus', { forward: true, findNext: true }],
    ['stop-find', 'clearSelection'],
  ]);
});

test('native keyboard shortcuts prevent default and delegate navigation or zoom', () => {
  const f = fixture();
  let prevented = 0;
  const event = { preventDefault: () => { prevented += 1; } };
  f.owner.handleKeyboard(f.tab, event, { meta: true, key: 't', type: 'keyDown' });
  f.owner.handleKeyboard(f.tab, event, { alt: true, key: 'ArrowLeft', type: 'keyDown' });
  f.owner.handleKeyboard(f.tab, event, { meta: true, key: '+', type: 'keyDown' });
  assert.equal(prevented, 3);
  assert.deepEqual(f.calls, [['openNewTab'], ['back'], ['zoom', 1.1]]);
});

test('a rejected route switch reports an error without navigating', async () => {
  const f = fixture();
  f.owner.actions.setTabRoute = async () => { throw new Error('synthetic route failure'); };
  assert.equal(f.owner.handleCommand({ command: 'set-route', value: 'direct' }), true);
  await Promise.resolve();
  assert.deepEqual(f.calls, [['error', 'route.switchFailed']]);
});
