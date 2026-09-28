'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { BrowserToolbarCommandOwner } = require('../../../../lib/browser/toolbar/browser-toolbar-owner');

function fixture() {
  const calls = [];
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
    getWindow: () => ({ webContents: { send: (...args) => calls.push(['send', ...args]) } }),
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
  return { owner, calls, tab, contents };
}

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
