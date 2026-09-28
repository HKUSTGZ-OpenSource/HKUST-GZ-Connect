'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { BrowserToolbarOwner } = require('../../../../lib/browser/toolbar/browser-toolbar-owner');

function fixture() {
  const sent = [];
  const pending = new Map();
  let nextTimer = 0;
  const timers = {
    setImmediate(callback) {
      const handle = { id: ++nextTimer, unref() {} };
      pending.set(handle, callback);
      return handle;
    },
    clearImmediate(handle) { pending.delete(handle); },
  };
  const contents = {
    isDestroyed: () => false,
    getTitle: () => 'Synthetic page',
  };
  const tab = { id: 7, view: { webContents: contents }, route: 'campus', loading: false };
  const window = { isDestroyed: () => false, webContents: {
    send(channel, state) { sent.push({ channel, state }); },
  } };
  const owner = new BrowserToolbarOwner({
    getWindow: () => window,
    getActiveTab: () => tab,
    getTabs: () => [tab],
    getActiveTabId: () => 7,
    getFindOpen: () => false,
    getDownloadState: () => ({ state: 'idle' }),
    currentUrl: () => 'https://example.invalid/',
    bookmarkBarState: () => [],
    pageFavoriteState: () => ({ favorite: false }),
    navigationForContents: () => ({ canGoBack: () => true, canGoForward: () => false }),
    translate: key => key,
    campusRoute: 'campus', directRoute: 'direct',
    timers,
  });
  return { owner, sent, pending, tab, window };
}

test('toolbar owner projects and deduplicates the existing bounded state', () => {
  const { owner, sent, tab } = fixture();
  assert.equal(owner.send(), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, 'campus-toolbar-state');
  assert.equal(sent[0].state.url, 'https://example.invalid/');
  assert.equal(sent[0].state.title, 'Synthetic page');
  assert.equal(sent[0].state.route, 'campus');
  assert.equal(sent[0].state.canGoBack, true);
  assert.equal(sent[0].state.favorite, false);
  assert.equal(owner.send(), false, 'unchanged state is not sent twice');
  tab.loading = true;
  assert.equal(owner.send(), true);
  assert.equal(sent.at(-1).state.loading, true);
});

test('toolbar owner coalesces scheduling and fences callbacks retired by reset', () => {
  const { owner, sent, pending } = fixture();
  assert.equal(owner.schedule(), true);
  assert.equal(owner.schedule(), false);
  assert.equal(pending.size, 1);
  const [handle, callback] = [...pending.entries()][0];
  assert.equal(owner.scheduledUpdate, handle);
  assert.equal(owner.reset(), true);
  assert.equal(owner.reset(), false, 'teardown is idempotent');
  assert.equal(owner.scheduledUpdate, null);
  assert.equal(pending.size, 0);
  assert.equal(owner.schedule(), true, 'same Browser may open a new window after reset');
  const replacement = owner.scheduledUpdate;
  callback();
  assert.equal(sent.length, 0, 'a callback captured before teardown cannot publish');
  assert.equal(owner.scheduledUpdate, replacement,
    'an older callback cannot clear the replacement timer');
  [...pending.values()][0]();
  assert.equal(sent.length, 1);
});

test('toolbar owner ignores closed windows and renderers and retries a failed send', () => {
  const { owner, sent, tab, window } = fixture();
  tab.view.webContents.isDestroyed = () => true;
  assert.equal(owner.send(), false);
  tab.view.webContents.isDestroyed = () => false;
  window.webContents.send = () => { throw new Error('window retired'); };
  assert.equal(owner.send(), false);
  window.webContents.send = (channel, state) => sent.push({ channel, state });
  assert.equal(owner.send(), true, 'a failed send never caches a false success');
  window.isDestroyed = () => true;
  assert.equal(owner.send(), false);
});

test('toolbar projection retains route, workspace, find, download and retired-tab fields', () => {
  const { owner, sent, tab } = fixture();
  tab.route = 'direct';
  tab.routeSource = 'rule';
  tab.loading = true;
  tab.loadingLabel = 'Synthetic loading';
  tab.slow = true;
  tab.kind = 'workspace';
  owner.getFindOpen = () => true;
  owner.getDownloadState = () => ({ state: 'synthetic-transfer' });
  owner.bookmarkBarState = () => [{ id: 'synthetic-bookmark' }];
  owner.pageFavoriteState = () => ({ favorite: true, favoriteId: 'synthetic-favorite' });
  owner.getTabs = () => [tab, { id: 8, loading: false, route: 'campus',
    view: { webContents: { isDestroyed: () => true } } }];
  assert.equal(owner.send(), true);
  assert.deepEqual(sent[0].state, {
    url: 'https://example.invalid/', title: 'Synthetic page',
    loading: true, loadingLabel: 'Synthetic loading', slow: true, findOpen: true,
    route: 'direct', routeSource: 'rule', routeLabel: 'route.direct',
    canGoBack: true, canGoForward: false, activeTabId: 7,
    tabs: [
      { id: 7, title: 'Synthetic page', loading: true, route: 'direct' },
      { id: 8, title: 'tab.new', loading: false, route: 'campus' },
    ],
    download: { state: 'synthetic-transfer' }, workspace: true,
    bookmarks: [{ id: 'synthetic-bookmark' }], favorite: true,
    favoriteId: 'synthetic-favorite',
  });
});

test('a queued update never sends to a replaced window', () => {
  const { owner, sent, pending, window } = fixture();
  assert.equal(owner.schedule(), true);
  const callback = [...pending.values()][0];
  const replacement = { isDestroyed: () => false, webContents: {
    send(channel, state) { sent.push({ channel, state }); },
  } };
  owner.getWindow = () => replacement;
  callback();
  assert.equal(sent.length, 0);
  assert.equal(owner.scheduledUpdate, null);
  assert.equal(owner.schedule(), true);
  [...pending.values()].at(-1)();
  assert.equal(sent.length, 1);
  assert.notEqual(owner.getWindow(), window);
});
