'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { BrowserTabLifecycle } = require('../../../../lib/browser/tabs/tab-manager');

function fixture() {
  const calls = [];
  const created = [];
  const context = { height: 108, workspace: null, failFor: null, construct: null };
  const makeWindow = () => ({
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    getContentSize: () => [900, 700],
    contentView: {
      children: [],
      addChildView(view) {
        if (context.failFor === view) throw new Error('synthetic attach failure');
        if (!this.children.includes(view)) this.children.push(view);
      },
      removeChildView(view) { this.children = this.children.filter(item => item !== view); },
    },
  });
  context.window = makeWindow();
  class View {
    constructor(options) {
      this.options = options;
      this.visible = false;
      this.webContents = new EventEmitter();
      this.webContents.destroyed = false;
      this.webContents.closeCount = 0;
      this.webContents.isDestroyed = () => this.webContents.destroyed;
      this.webContents.close = () => { this.webContents.closeCount++; this.webContents.destroyed = true; };
      created.push(this);
      context.construct?.(this);
    }
    setVisible(value) { this.visible = value; }
    setBounds(value) { this.bounds = value; }
    setBackgroundColor() {}
  }
  const effects = Object.fromEntries([
    'linkPopup', 'closeTabState', 'releasePopup', 'attachPageEvents', 'navigate',
    'scheduleToolbarUpdate', 'updateToolbar', 'beforeDeactivate', 'layout',
    'cancelScheduledUpdates', 'cancelCertificatePrompts', 'clearSlowTimer',
    'clearCredentialCandidate', 'openNewTab', 'reportCreateFailure',
  ].map(name => [name, (...args) => { calls.push([name, ...args]); return name === 'navigate' ? true : undefined; }]));
  const owner = new BrowserTabLifecycle({
    WebContentsView: View, campusPreload: '/synthetic/preload.js',
    getWindow: () => context.window, getToolbarHeight: () => context.height,
    getWorkspace: () => context.workspace, effects,
  });
  const session = {};
  const page = (options = {}) => owner.createPage({
    url: 'https://campus.example.test/', routeSession: session,
    resolution: { route: 'campus', source: 'fixture', matchedRule: null },
    route: 'campus', options, targetWindow: context.window,
  });
  return { owner, context, effects, calls, created, page, session, makeWindow, View };
}

test('page creation retains session identity, hardened preferences and one attached active view', () => {
  const f = fixture();
  const first = f.page({ displayName: '  Example  ' });
  const second = f.page();
  const preferences = second.view.options.webPreferences;
  assert.equal(preferences.session, f.session);
  assert.deepEqual({ nodeIntegration: preferences.nodeIntegration, contextIsolation: preferences.contextIsolation,
    sandbox: preferences.sandbox, webSecurity: preferences.webSecurity, devTools: preferences.devTools,
    backgroundThrottling: preferences.backgroundThrottling }, {
    nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, devTools: false,
    backgroundThrottling: true,
  });
  assert.equal(first.loadingLabel, 'Example');
  assert.deepEqual(f.context.window.contentView.children, [second.view]);
  assert.equal(first.view.visible, false);
  assert.equal(first.view.webContents.isDestroyed(), false);
  f.owner.activate(first.id);
  assert.deepEqual(f.context.window.contentView.children, [first.view]);
  assert.equal(f.owner.view, first.view);
});

test('failed native attachment restores the previous active view and closes the abandoned tab', () => {
  const f = fixture();
  const previous = f.page();
  f.context.construct = view => { f.context.failFor = view; };
  assert.equal(f.page(), null);
  assert.equal(f.owner.active(), previous);
  assert.equal(f.owner.view, previous.view);
  assert.deepEqual(f.context.window.contentView.children, [previous.view]);
  assert.equal(f.created[1].webContents.closeCount, 1);
  assert.equal(f.owner.size, 1);
  assert.equal(f.owner.nextTabId, 3, 'failed creation cannot recycle a stale toolbar id');
  assert.equal(f.calls.filter(([name]) => name === 'reportCreateFailure').length, 1);
});

test('a replaced window cannot receive a view created for the previous window', () => {
  const f = fixture();
  f.context.construct = () => { f.context.window = f.makeWindow(); };
  assert.equal(f.page(), null);
  assert.equal(f.owner.size, 0);
  assert.deepEqual(f.context.window.contentView.children, []);
  assert.equal(f.created[0].webContents.closeCount, 1);
  assert.equal(f.calls.some(([name]) => name === 'navigate'), false);
  assert.equal(f.calls.some(([name]) => name === 'reportCreateFailure'), false);
});

test('closing background tabs is idempotent and preserves the selected renderer', () => {
  const f = fixture();
  const first = f.page();
  const second = f.page();
  const before = f.calls.length;
  assert.equal(f.owner.close(first.id), true);
  assert.equal(f.owner.close(first.id), false);
  assert.equal(first.view.webContents.closeCount, 1);
  assert.equal(f.owner.active(), second);
  assert.deepEqual(f.context.window.contentView.children, [second.view]);
  assert.deepEqual(f.calls.slice(before).map(([name]) => name), [
    'cancelScheduledUpdates', 'cancelCertificatePrompts', 'clearSlowTimer', 'closeTabState',
    'scheduleToolbarUpdate',
  ]);
});

test('closing the final tab requests one replacement and releases the attached view', () => {
  const f = fixture();
  const tab = f.page();
  f.owner.close(tab.id);
  f.owner.close(tab.id);
  assert.equal(f.owner.activeTabId, null);
  assert.equal(f.owner.view, null);
  assert.equal(f.owner.attachedView, null);
  assert.equal(f.calls.filter(([name]) => name === 'openNewTab').length, 1);
});

test('window view teardown and transient cleanup are repeatable without closing a renderer twice', () => {
  const f = fixture();
  f.page(); f.page();
  f.owner.closeViews(); f.owner.closeViews();
  assert.deepEqual(f.created.map(view => view.webContents.closeCount), [1, 1]);
  f.owner.clearTransientState(); f.owner.clearTransientState();
  f.owner.clear();
  f.owner.closeViews();
  assert.equal(f.owner.size, 0);
});

test('active views receive current find-bar height and clamped bounds before becoming visible', () => {
  const f = fixture();
  const tab = f.page();
  f.context.height = 142;
  f.context.window.getContentSize = () => [-1, 40];
  assert.equal(f.owner.activate(tab.id), true);
  assert.deepEqual(tab.view.bounds, { x: 0, y: 142, width: 1, height: 1 });
});

function workspaceFixture() {
  const f = fixture();
  let resolve;
  let reject;
  const loading = new Promise((done, failed) => { resolve = done; reject = failed; });
  f.context.workspace = {
    createView: (View, session) => new View({ webPreferences: { session } }),
    load: () => loading,
    sendState: contents => f.calls.push(['workspaceState', contents]),
    focus: (contents, target, query) => f.calls.push(['workspaceFocus', contents, target, query]),
  };
  const tab = f.owner.createWorkspace(f.session);
  return { ...f, tab, resolve, reject };
}

test('workspace creation preserves session identity and delivers deferred focus after loading', async () => {
  const f = workspaceFixture();
  assert.equal(f.tab.view.options.webPreferences.session, f.session);
  assert.equal(f.tab.route, 'direct');
  assert.equal(f.tab.loading, true);
  f.tab.pendingWorkspaceFocus = { target: 'search', query: 'synthetic' };
  f.resolve();
  await new Promise(setImmediate);
  assert.equal(f.tab.loading, false);
  assert.equal(f.tab.pendingWorkspaceFocus, null);
  assert.equal(f.calls.filter(([name]) => name === 'workspaceState').length, 1);
  assert.deepEqual(f.calls.find(([name]) => name === 'workspaceFocus').slice(2), ['search', 'synthetic']);
});

test('closed Workspace tabs cannot publish a late load result or deferred focus', async () => {
  const f = workspaceFixture();
  f.tab.pendingWorkspaceFocus = { target: 'search', query: 'synthetic' };
  f.owner.close(f.tab.id);
  f.calls.length = 0;
  f.resolve();
  await new Promise(setImmediate);
  assert.deepEqual(f.calls, []);
});

test('retired Workspace load failures cannot report into the current Browser', async () => {
  const f = workspaceFixture();
  f.owner.close(f.tab.id);
  f.calls.length = 0;
  f.reject(new Error('synthetic delayed failure'));
  await new Promise(setImmediate);
  assert.deepEqual(f.calls, []);
});

test('a replacement window fences old Workspace completion even if the tab remains recorded', async () => {
  const f = workspaceFixture();
  f.context.window = f.makeWindow();
  f.calls.length = 0;
  f.resolve();
  await new Promise(setImmediate);
  assert.deepEqual(f.calls, []);
});

test('a retired but not yet destroyed Workspace renderer cannot reload after a crash event', async () => {
  const f = workspaceFixture();
  let reloads = 0;
  f.context.workspace.load = async () => { reloads++; };
  f.tab.view.webContents.close = () => {};
  f.owner.close(f.tab.id);
  f.tab.view.webContents.emit('render-process-gone');
  f.resolve();
  await new Promise(setImmediate);
  assert.equal(reloads, 0);
});

test('Workspace construction cannot attach old-session views to a replacement window', () => {
  const f = fixture();
  const previous = f.page();
  f.context.workspace = { createView: View => new View({}), load: async () => {}, sendState() {} };
  f.context.construct = () => { f.context.window = f.makeWindow(); };
  f.calls.length = 0;
  assert.equal(f.owner.createWorkspace(f.session), null);
  assert.deepEqual(f.context.window.contentView.children, []);
  assert.equal(f.owner.active(), previous);
  assert.equal(f.created[1].webContents.closeCount, 1);
  assert.equal(f.calls.some(([name]) => name === 'reportCreateFailure'), false);
});

test('background Workspace completion cannot steal deferred focus from a newly selected tab', async () => {
  const f = workspaceFixture();
  f.tab.pendingWorkspaceFocus = { target: 'search', query: 'synthetic' };
  const selected = f.page();
  f.calls.length = 0;
  f.resolve();
  await new Promise(setImmediate);
  assert.equal(f.owner.active(), selected);
  assert.equal(f.tab.loading, false, 'background data may finish loading normally');
  assert.equal(f.calls.filter(([name]) => name === 'workspaceState').length, 1);
  assert.equal(f.calls.some(([name]) => name === 'workspaceFocus'), false);
  assert.equal(f.tab.pendingWorkspaceFocus, null, 'retired focus intent must not replay later');
});

test('Workspace state publication that retires the tab cannot continue with focus or toolbar updates', async () => {
  const f = workspaceFixture();
  f.tab.pendingWorkspaceFocus = { target: 'search', query: 'synthetic' };
  f.context.workspace.sendState = () => { f.owner.close(f.tab.id); f.calls.length = 0; };
  f.resolve();
  await new Promise(setImmediate);
  assert.deepEqual(f.calls, []);
});

test('a replaced Workspace owner cannot receive a previous owner load result', async () => {
  const f = workspaceFixture();
  f.context.workspace = { sendState: () => f.calls.push(['newOwnerState']), focus() {} };
  f.calls.length = 0;
  f.resolve();
  await new Promise(setImmediate);
  assert.deepEqual(f.calls, []);
});
