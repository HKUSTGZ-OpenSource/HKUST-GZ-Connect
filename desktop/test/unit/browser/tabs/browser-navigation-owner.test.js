'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { BrowserNavigationOwner } = require('../../../../lib/browser/tabs/tab-manager');

function fixture(overrides = {}) {
  const calls = [];
  const contents = {
    destroyed: false,
    url: 'https://first.example/',
    isDestroyed() { return this.destroyed; },
    getURL() { return this.url; },
    loadURL(url) { this.url = url; calls.push(['load', url]); return Promise.resolve(); },
    reload() { calls.push(['reload']); },
  };
  const tab = { kind: 'page', view: { webContents: contents }, failedUrl: '' };
  let current = tab;
  const ports = {
    blankUrl: 'about:blank',
    normalizeUrl: (value, fallback) => {
      if (value === 'bad:') throw new Error('invalid URL');
      return value || fallback;
    },
    getHomeUrl: () => 'https://home.example/',
    getNewTabUrl: () => 'https://new.example/',
    getTranslator: () => () => 'translated',
    reportError: (message) => calls.push(['error', message]),
    getActiveTab: () => current,
    containsTab: (value) => value === current,
    getConfiguredPort: () => 1080,
    resolvePolicyRoute: (url) => {
      calls.push(['route', url]);
      return { route: 'campus', source: 'default', matchedRule: null };
    },
    getTabs: () => [tab],
    ensureRoutingReady: async () => true,
    createTab: (...args) => { calls.push(['create', ...args]); return tab; },
    focusWorkspaceSearch: () => { calls.push(['focus']); return true; },
    scheduleToolbarUpdate: () => calls.push(['toolbar']),
    ...overrides,
  };
  const owner = new BrowserNavigationOwner(ports);
  return { owner, tab, contents, calls, setCurrent: (value) => { current = value; } };
}

test('navigation intent rejects a superseded or removed tab', () => {
  const f = fixture();
  const first = f.owner.beginNavigationIntent(f.tab);
  assert.equal(f.owner.navigationIntentCurrent(f.tab, first), true);
  f.owner.beginNavigationIntent(f.tab);
  assert.equal(f.owner.navigationIntentCurrent(f.tab, first), false);
  f.setCurrent(null);
  assert.equal(f.owner.navigationIntentCurrent(f.tab, first + 1), false);
});

test('late homepage readiness cannot navigate after a newer intent', async () => {
  let release;
  const readiness = new Promise((resolve) => { release = resolve; });
  const f = fixture({ ensureRoutingReady: () => readiness });
  const pending = f.owner.openHome();
  f.owner.beginNavigationIntent(f.tab);
  release(true);
  assert.equal(await pending, false);
  assert.equal(f.calls.some(([kind]) => kind === 'load' || kind === 'create'), false);
});

test('closing a tab while address readiness is pending prevents its late load', async () => {
  let release;
  const readiness = new Promise((resolve) => { release = resolve; });
  const f = fixture({ ensureRoutingReady: () => readiness });
  const pending = f.owner.navigateWhenReady('https://next.example/', f.tab);
  f.setCurrent(null);
  release(true);
  assert.equal(await pending, false);
  assert.equal(f.calls.some(([kind]) => kind === 'load' || kind === 'create'), false);
});

test('local blank Home focuses Workspace without activating a network route', async () => {
  const f = fixture({ getHomeUrl: () => 'about:blank' });
  assert.equal(await f.owner.openHome(), true);
  assert.deepEqual(f.calls, [['focus']]);
});

test('new tab resolves the effective route but does not pass a routing override', async () => {
  const f = fixture();
  assert.equal(await f.owner.openNewTab(), true);
  assert.deepEqual(f.calls, [
    ['route', 'https://new.example/'],
    ['create', 'https://new.example/'],
  ]);
});

test('reload waits for routing and failed-page retry navigates to the last URL', async () => {
  const f = fixture();
  assert.equal(await f.owner.reloadWhenReady(f.tab), true);
  assert.deepEqual(f.calls, [['route', 'https://first.example/'], ['reload']]);
  f.calls.length = 0;
  f.tab.failedUrl = 'https://failed.example/';
  assert.equal(await f.owner.reloadWhenReady(f.tab), true);
  assert.deepEqual(f.calls, [
    ['route', 'https://failed.example/'],
    ['route', 'https://failed.example/'],
    ['load', 'https://failed.example/'],
    ['toolbar'],
  ]);
  assert.equal(f.tab.failedUrl, '');
  assert.equal(f.tab.routeSource, 'default');
});

test('navigation resets only the selected tab and reports malformed URLs', () => {
  const f = fixture();
  f.tab.failedUrl = 'https://old.example/';
  f.tab.crashed = true;
  assert.equal(f.owner.navigate('https://next.example/', f.tab, 'campus'), true);
  assert.equal(f.tab.failedUrl, '');
  assert.equal(f.tab.crashed, false);
  assert.deepEqual(f.calls, [
    ['route', 'https://next.example/'],
    ['load', 'https://next.example/'],
    ['toolbar'],
  ]);
  assert.equal(f.tab.routeSource, 'requested');
  assert.equal(f.owner.navigate('bad:', f.tab), false);
  assert.deepEqual(f.calls.at(-1), ['error', 'invalid URL']);
});

test('visible URL hides local error data but preserves the failed destination for retry', () => {
  const f = fixture();
  f.contents.url = 'data:text/html,error';
  assert.equal(f.owner.currentUrl(f.tab), '');
  f.tab.failedUrl = 'https://failed.example/';
  assert.equal(f.owner.currentUrl(f.tab), 'https://failed.example/');
  f.tab.kind = 'workspace';
  assert.equal(f.owner.currentUrl(f.tab), 'about:blank');
});

test('requested first-load route applies only to an unmatched default policy', () => {
  const f = fixture();
  assert.deepEqual(f.owner.resolveRoute('https://example.invalid/', null, 'direct'), {
    route: 'direct', source: 'requested', matchedRule: null,
  });
  const exact = fixture({ resolvePolicyRoute: () => ({
    route: 'campus', source: 'user-exact', matchedRule: 'synthetic-rule',
  }) });
  assert.deepEqual(exact.owner.resolveRoute('https://example.invalid/', null, 'direct'), {
    route: 'campus', source: 'user-exact', matchedRule: 'synthetic-rule',
  });
  assert.deepEqual(exact.owner.resolveRoute('about:blank'), {
    route: 'direct', source: 'local-blank', matchedRule: null,
  });
});

test('policy failure uses the existing Routing fallback rather than retaining stale metadata', () => {
  const f = fixture({ resolvePolicyRoute: () => { throw new Error('synthetic policy failure'); } });
  const route = f.owner.resolveRoute('https://example.invalid/');
  assert.equal(route.route, 'campus');
  assert.equal(route.source, 'default');
  assert.equal(route.matchedRule, null);
});

test('tab route refresh updates every current tab from its visible URL', () => {
  const f = fixture();
  f.tab.failedUrl = 'https://failed.example/';
  f.owner.updateAllTabRoutes();
  assert.equal(f.tab.route, 'campus');
  assert.equal(f.tab.routeSource, 'default');
  assert.equal(f.tab.matchedRule, null);
});
