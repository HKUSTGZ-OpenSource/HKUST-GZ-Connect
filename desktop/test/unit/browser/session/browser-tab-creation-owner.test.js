'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const { BrowserTabCreationOwner } = require('../../../../lib/browser/session/browser-session-manager');

function fixture() {
  const calls = [], session = {}, window = { isDestroyed: () => false };
  const state = { current: true, window, workspace: { sendState: contents => calls.push(['state', contents]) },
    tabs: [], capacity: true, session, reporter: message => calls.push(['error', message]) };
  let owner;
  const ports = {
    blankUrl: 'about:blank', maxTabs: 24, isContextCurrent: () => state.current,
    getWindow: () => state.window, getWorkspace: () => state.workspace, getTabs: () => state.tabs,
    canAdd: () => { calls.push('capacity'); return state.capacity; },
    normalizeUrl: (raw, home, t) => { calls.push(['normalize', raw, home, t]); return raw || home; },
    getHomeUrl: () => 'https://home.example.invalid/', getTranslator: () => (key, vars) => `${key}:${vars.count}`,
    getReportError: () => state.reporter,
    sessionForRoute: route => { calls.push(['session', route]); return state.session; },
    resolveRoute: (url, inherited, route) => { calls.push(['route', url, inherited, route]); return { route, source: 'synthetic' }; },
    createPage: request => { calls.push(['page', request]); return request; },
    createWorkspace: value => { calls.push(['workspace', value]); return value; },
    createWorkspaceEntry: () => { calls.push('workspace-entry'); return owner.createWorkspaceTab(); },
    switchTab: id => calls.push(['switch', id]),
  };
  owner = new BrowserTabCreationOwner(ports);
  return { owner, ports, calls, state, session, window };
}

test('page admission preserves option, original window, route and shared Session identity', () => {
  for (const route of ['campus', 'direct']) {
    const f = fixture(), options = { displayName: 'Synthetic resource', credentialReservation: {} };
    const request = f.owner.createTab('https://site.example.invalid/', route, options);
    assert.equal(request.options, options); assert.equal(request.targetWindow, f.window);
    assert.equal(request.routeSession, f.session); assert.equal(request.route, route);
    assert.deepEqual(request.resolution, { route, source: 'synthetic' });
    assert.deepEqual(f.calls.map(value => Array.isArray(value) ? value[0] : value),
      ['capacity', 'normalize', 'session', 'route', 'page']);
    assert.deepEqual(f.calls[2], ['session', 'campus'], 'both routes retain the same owned Browser Session');
  }
});

test('capacity precedes normalization and reports exactly once without a Session read', () => {
  const f = fixture(); f.state.capacity = false;
  assert.equal(f.owner.createTab('file:///synthetic'), null);
  assert.deepEqual(f.calls, ['capacity', ['error', 'tab.limit:24']]);
  f.calls.length = 0; assert.equal(f.owner.createWorkspaceTab(), null);
  assert.deepEqual(f.calls, ['capacity', ['error', 'tab.limit:24']]);
});

test('normalization failure keeps its original message and cannot allocate a tab', () => {
  const f = fixture(); f.owner.normalizeUrl = () => { throw new Error('synthetic invalid URL'); };
  assert.equal(f.owner.createTab('file:///synthetic'), null);
  assert.deepEqual(f.calls, ['capacity', ['error', 'synthetic invalid URL']]);
});

test('missing error callback does not evaluate a limit translation or alter admission', () => {
  const f = fixture(); f.state.reporter = null; f.state.capacity = false;
  f.owner.getTranslator = () => { throw new Error('no observer must not translate limit'); };
  assert.equal(f.owner.createTab(), null); assert.equal(f.owner.createWorkspaceTab(), null);
  assert.deepEqual(f.calls, ['capacity', 'capacity']);
});

test('local blank entry follows the original Workspace facade while explicit blank page stays a page', () => {
  const f = fixture(); f.owner.createTab('about:blank');
  assert.deepEqual(f.calls.map(value => Array.isArray(value) ? value[0] : value),
    ['capacity', 'normalize', 'workspace-entry', 'capacity', 'session', 'workspace']);
  const g = fixture(); g.owner.normalizeUrl = () => { throw new Error('explicit blank must not normalize'); };
  const options = { blankPage: true }, page = g.owner.createTab('file:///ignored', 'direct', options);
  assert.equal(page.url, 'about:blank'); assert.equal(page.options, options);
  assert.equal(g.calls.some(value => value === 'workspace-entry'), false);
});

test('existing Workspace reuses its tab before capacity/session and switches before state', () => {
  const f = fixture(), existing = { id: 9, kind: 'workspace', view: { webContents: {} } };
  f.state.tabs = [existing]; f.state.capacity = false;
  assert.equal(f.owner.createWorkspaceTab(), existing);
  assert.deepEqual(f.calls, [['switch', 9], ['state', existing.view.webContents]]);
  assert.deepEqual(f.state.tabs, [existing]);
});

test('missing shared Session refuses both native page and Workspace creation', () => {
  const f = fixture(); f.state.session = null;
  assert.equal(f.owner.createTab(), null); assert.equal(f.owner.createWorkspaceTab(), null);
  assert.equal(f.calls.some(value => ['page', 'workspace', 'route'].includes(value?.[0])), false);
});

test('missing, destroyed and retired window entries are inert on repeated calls', () => {
  for (const state of ['missing', 'destroyed', 'retired']) {
    const f = fixture();
    if (state === 'missing') f.state.window = null;
    if (state === 'destroyed') f.window.isDestroyed = () => true;
    if (state === 'retired') f.state.current = false;
    for (let repeat = 0; repeat < 2; repeat++) {
      assert.equal(f.owner.createTab('https://site.example.invalid/'), null);
      assert.equal(f.owner.createWorkspaceTab(), null);
    }
    assert.deepEqual(f.calls, []);
  }
});

test('missing Workspace refuses local creation while ordinary page entry remains available', () => {
  const f = fixture(); f.state.workspace = null;
  assert.equal(f.owner.createWorkspaceTab(), null); assert.deepEqual(f.calls, []);
  assert.equal(f.owner.createTab('https://site.example.invalid/').routeSession, f.session);
});

test('invalid injected methods and scalar dependencies fail before effects; owner remains below600', () => {
  const f = fixture();
  for (const change of [{ getWindow: null }, { getReportError: null }, { createWorkspaceEntry: null },
    { maxTabs: 0 }, { maxTabs: 1.5 }, { blankUrl: '' }]) {
    assert.throws(() => new BrowserTabCreationOwner({ ...f.ports, ...change }), /dependencies/);
  }
  assert.deepEqual(f.calls, []);
  const source = fs.readFileSync(require.resolve('../../../../lib/browser/session/browser-session-manager'), 'utf8');
  const start = source.indexOf('class BrowserTabCreationOwner'), end = source.indexOf('\n// A route command', start);
  assert.ok(start >= 0 && end > start); assert.ok(source.slice(start, end).split('\n').length <= 600);
});
