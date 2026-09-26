'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { BrowserWorkspaceOwner } = require('../../../../lib/browser/workspace/campus-workspace-controller');
const { normalizeCampusUrl } = require('../../../../lib/browser/session/campus-browser');

function resource(id, favorite = true) {
  return { id, name: id, description: '', url: `https://${id}.example.edu/`, route: 'direct',
    category: 'custom', favorite, lastOpenedAt: null };
}

function fixture() {
  const state = { resources: [], groups: [], tabs: [], active: null, toggle: null,
    presentation: { officialPortalResourceId: null } };
  const events = [];
  const controller = {
    focus: (contents, target, query) => events.push(['focus', contents, target, query]),
    sendState: contents => events.push(['state', contents]),
  };
  const owner = new BrowserWorkspaceOwner({
    getWorkspaceResources: () => state.resources, getWorkspaceGroups: () => state.groups,
    getPresentation: () => state.presentation, getController: () => state.controller,
    getToggleFavorite: () => state.toggle, getTabs: () => state.tabs, activeTab: () => state.active,
    createTab: (url, route) => { events.push(['create', url, route]); return state.created; },
    switchTab: id => { state.active = state.tabs.find(tab => tab.id === id); events.push(['switch', id]); },
    currentUrl: tab => tab?.url || '',
    normalizeUrl: (url, t) => normalizeCampusUrl(url, 'about:blank', t),
    t: key => key, onError: message => events.push(['error', message]),
    updateToolbar: () => events.push(['toolbar']),
  });
  state.controller = controller;
  return { state, owner, events };
}

function tab(id, kind = 'workspace') {
  const messages = [];
  const contents = { isDestroyed: () => false, getTitle: () => 'Synthetic',
    send: (...args) => messages.push(args) };
  return { id, kind, loading: false, view: { webContents: contents }, messages,
    url: kind === 'workspace' ? 'about:blank' : 'https://site.example.edu/?ticket=synthetic' };
}

test('workspace module remains below the 600-line Browser ownership limit', () => {
  const source = fs.readFileSync(require.resolve('../../../../lib/browser/workspace/campus-workspace-controller'), 'utf8');
  assert(source.trimEnd().split('\n').length <= 600);
});

test('workspace owner uses live bounded providers and rejects invalid batches', () => {
  const f = fixture();
  f.state.resources = [resource('site')];
  assert.equal(f.owner.workspaceResources()[0].id, 'site');
  f.state.resources = [resource('other')];
  assert.equal(f.owner.workspaceResources()[0].id, 'other');
  f.state.resources.push(resource('other'));
  assert.deepEqual(f.owner.workspaceResources(), []);
  f.state.resources = Array.from({ length: 65 }, (_, i) => resource(`site-${i}`));
  assert.deepEqual(f.owner.workspaceResources(), []);
  f.state.groups = [{ id: 'invalid', name: 'Synthetic', resourceIds: [] }];
  assert.deepEqual(f.owner.workspaceGroups(), []);
  assert(Object.isFrozen(f.owner.workspaceGroups()));
});

test('bookmark projection retains official entry and excludes URLs and non-favorite folder members', () => {
  const f = fixture();
  f.state.resources = [resource('portal', false), resource('site'), resource('hidden', false)];
  f.state.presentation.officialPortalResourceId = 'portal';
  f.state.groups = [{ id: 'group_abcdefghijkl', name: 'Study', resourceIds: ['portal', 'site', 'hidden'] }];
  assert.deepEqual(f.owner.bookmarkBarState(), [
    { type: 'bookmark', id: 'portal', name: 'portal', official: true },
    { type: 'folder', id: 'group_abcdefghijkl', name: 'Study', children: [{ id: 'site', name: 'site' }] },
  ]);
  assert.equal(JSON.stringify(f.owner.bookmarkBarState()).includes('https://'), false);
});

test('workspace focus retains loading deferral, existing-tab selection and neutral creation', async () => {
  const f = fixture(), home = tab(1), page = tab(2, 'page');
  f.state.tabs = [home, page]; f.state.active = page; home.loading = true;
  assert.equal(f.owner.focusWorkspace('manage', 'synthetic'), true);
  assert.deepEqual(home.pendingWorkspaceFocus, { target: 'manage', query: 'synthetic' });
  assert.deepEqual(f.events, [['switch', 1]]);
  home.loading = false;
  f.owner.focusWorkspace('search', 'course');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.events.at(-1), ['focus', home.view.webContents, 'search', 'course']);
  f.state.tabs = [page]; f.state.active = page; f.state.created = tab(3); f.state.created.loading = true;
  f.owner.focusWorkspace();
  assert.deepEqual(f.events.at(-1), ['create', 'about:blank', 'direct']);
  f.state.controller = null;
  assert.equal(f.owner.focusWorkspace(), false);
});

test('layout updates target only live workspace tabs with a supported document', () => {
  const f = fixture(), home = tab(1), page = tab(2, 'page'), dead = tab(3);
  dead.view.webContents.isDestroyed = () => true;
  f.state.tabs = [home, page, dead];
  assert.equal(f.owner.refreshCardBoardLayout({ schemaVersion: 2 }), false);
  const document = { schemaVersion: 1 };
  assert.equal(f.owner.refreshCardBoardLayout(document), true);
  assert.deepEqual(home.messages, [['card-board-layout-changed', document]]);
  assert.deepEqual(page.messages, []);
  assert.deepEqual(dead.messages, []);
});

test('page favorite projection and asynchronous result preserve existing effects', async () => {
  const f = fixture(), page = tab(1, 'page');
  f.state.active = page;
  f.state.resources = [resource('site')];
  assert.deepEqual(f.owner.pageFavoriteState(), { canFavorite: false, favorite: false });
  f.state.toggle = async candidate => { f.events.push(['toggle', candidate]); return { ok: true }; };
  assert.deepEqual(f.owner.pageFavoriteState(), { canFavorite: true, favorite: true });
  assert.equal(await f.owner.toggleActivePageFavorite(), true);
  assert.equal(f.events[0][1].url, page.url);
  assert.deepEqual(f.events.at(-1), ['toolbar']);
  f.state.toggle = async () => ({ ok: false });
  assert.equal(await f.owner.toggleActivePageFavorite(), false);
  assert.deepEqual(f.events.at(-1), ['error', 'browser.favoriteFailed']);
});

test('queued workspace focus is inert after tab removal, selection change or controller replacement', async () => {
  for (const invalidate of [
    f => { f.state.tabs = []; },
    f => { f.state.active = tab(2, 'page'); },
    f => { f.state.controller = { focus: () => f.events.push(['new-controller']) }; },
  ]) {
    const f = fixture(), home = tab(1);
    f.state.tabs = [home]; f.state.active = home;
    f.owner.focusWorkspace('manage');
    invalidate(f);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.events, []);
  }
});

test('workspace retirement cancels queued focus and rejects new effects idempotently', async () => {
  const f = fixture(), home = tab(1);
  f.state.tabs = [home]; f.state.active = home; f.state.resources = [resource('site')];
  f.owner.focusWorkspace('manage');
  f.owner.retire(); f.owner.retire();
  assert.equal(f.owner.focusWorkspace(), false);
  assert.equal(f.owner.refreshCardBoardLayout({ schemaVersion: 1 }), false);
  f.owner.refreshWorkspaceHomes();
  assert.deepEqual(f.owner.workspaceResources(), []);
  assert.deepEqual(f.owner.bookmarkBarState(), []);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.events, []);
  assert.deepEqual(home.messages, []);
});

test('favorite completion after retirement suppresses both success UI and failure callbacks', async () => {
  for (const failure of [false, true]) {
    const f = fixture(), page = tab(1, 'page');
    f.state.tabs = [page]; f.state.active = page;
    let finish;
    f.state.toggle = () => new Promise((resolve, reject) => { finish = () => failure
      ? reject(new Error('synthetic delayed failure')) : resolve({ ok: true }); });
    const pending = f.owner.toggleActivePageFavorite();
    f.owner.retire();
    finish();
    assert.equal(await pending, false);
    assert.deepEqual(f.events, []);
  }
});

test('retirement clears only its own loading-focus reservation', () => {
  for (const replaced of [false, true]) {
    const f = fixture(), home = tab(1);
    f.state.tabs = [home]; f.state.active = home; home.loading = true;
    f.owner.focusWorkspace('search', 'old');
    const replacement = { target: 'manage', query: 'new' };
    if (replaced) home.pendingWorkspaceFocus = replacement;
    f.owner.retire();
    assert.equal(home.pendingWorkspaceFocus, replaced ? replacement : null);
  }
});

test('live-context favorite exceptions remain visible to the caller', async () => {
  const f = fixture();
  f.state.active = tab(1, 'page');
  f.state.toggle = async () => { throw new Error('synthetic live failure'); };
  await assert.rejects(f.owner.toggleActivePageFavorite(), /synthetic live failure/);
});
