'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { BrowserRouteCommandOwner } = require('../../../../lib/browser/session/browser-session-manager');

function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function fixture() {
  const calls = [], contents = { isDestroyed: () => false,
    reload: () => calls.push('reload'), reloadIgnoringCache: () => calls.push('reload-cache') };
  const tab = { id: 1, view: { webContents: contents }, navigationIntent: 0 };
  const record = { tab, contents, active: true, revision: 0 }, state = { current: true, policy: null };
  const policy = { appliesLiveSession: false,
    upsert: payload => { calls.push(['upsert', payload]); },
    remove: payload => { calls.push(['remove', payload]); } };
  state.policy = policy;
  const options = { findTab: id => id === 1 ? tab : null,
    beginNavigationIntent: value => ++value.navigationIntent,
    navigationIntentCurrent: (value, intent) => value === tab && intent === tab.navigationIntent,
    captureAdmission: () => ({ record, revision: record.revision }),
    admissionCurrent: value => value.revision === record.revision,
    pageCurrent: value => !!value && value.record === record && record.active && state.current,
    getPolicy: () => state.policy, clearCredentialCandidate: () => calls.push('clear-credential'),
    currentUrl: () => 'https://route.example.invalid/path', getHomeUrl: () => 'about:blank', getPort: () => 6180,
    ensureCampusReady: async () => true,
    configure: async (...args) => { calls.push(['configure', ...args]); },
    clearSlowTimer: () => calls.push('clear-timer'), updateAllTabRoutes: () => calls.push('routes'),
    updateTabRoute: () => ({ route: 'direct' }), navigate: (...args) => calls.push(['navigate', ...args]),
    scheduleToolbarUpdate: () => calls.push('toolbar') };
  return { calls, contents, tab, record, state, policy, options, owner: new BrowserRouteCommandOwner(options) };
}

test('current route command delegates the original exact-host transaction and current page reload', async () => {
  const f = fixture(); assert.equal(await f.owner.set(1, 'direct'), true);
  assert.deepEqual(f.calls, ['clear-credential', ['upsert', { host: 'route.example.invalid', includeSubdomains: false, route: 'direct' }],
    ['configure', 6180, { force: true }], 'clear-timer', 'routes', 'reload-cache', 'toolbar']);
});

test('invalid, missing, workspace or inactive admission cannot start credentials or rule IO', async () => {
  for (const change of [f => { f.tab.kind = 'workspace'; }, f => { f.record.active = false; },
    f => { f.state.current = false; }]) {
    const f = fixture(); change(f); assert.equal(await f.owner.set(1, 'direct'), false); assert.deepEqual(f.calls, []);
  }
  const f = fixture(); assert.equal(await f.owner.set(2, 'direct'), false); assert.equal(await f.owner.set(1, 'unknown'), false);
  assert.deepEqual(f.calls, []);
  assert.throws(() => new BrowserRouteCommandOwner({ ...f.options, captureAdmission: null }), /dependencies/);
});

test('pending readiness retires on page, context, policy, tab or navigation changes before storage admission', async () => {
  for (const retire of [f => { f.record.revision++; }, f => { f.record.active = false; },
    f => { f.state.current = false; }, f => { f.state.policy = {}; }, f => { f.tab.navigationIntent++; }]) {
    const f = fixture(), readiness = deferred(); f.owner.ensureCampusReady = () => readiness.promise;
    const pending = f.owner.set(1, 'campus'); retire(f); readiness.resolve(true);
    assert.equal(await pending, false); assert.deepEqual(f.calls, ['clear-credential']);
  }
});

test('accepted writes are not rolled back, but cannot configure or present after retirement', async () => {
  for (const route of ['direct', 'auto']) {
    const f = fixture(), write = deferred();
    f.policy[route === 'auto' ? 'remove' : 'upsert'] = () => { f.calls.push('accepted-write'); return write.promise; };
    const pending = f.owner.set(1, route); f.record.active = false; write.resolve();
    assert.equal(await pending, true); assert.deepEqual(f.calls, ['clear-credential', 'accepted-write']);
  }
});

test('policy-owned live activation is not duplicated and auto removes only the exact personal override', async () => {
  const f = fixture(); f.policy.appliesLiveSession = true;
  assert.equal(await f.owner.set(1, 'auto'), true);
  assert.deepEqual(f.calls[1], ['remove', { host: 'route.example.invalid', includeSubdomains: false }]);
  assert.equal(f.calls.some(value => Array.isArray(value) && value[0] === 'configure'), false);
  delete f.policy.remove; f.calls.length = 0;
  assert.equal(await f.owner.set(1, 'auto'), false); assert.deepEqual(f.calls, ['clear-credential']);
});

test('store and configure failures preserve their cause only while their original scope is current', async () => {
  for (const step of ['write', 'configure', 'readiness']) for (const retire of [false, true]) {
    const f = fixture(), pendingStep = deferred(), failure = new Error('synthetic route failure');
    if (step === 'write') f.policy.upsert = () => pendingStep.promise;
    if (step === 'configure') f.owner.configure = () => pendingStep.promise;
    if (step === 'readiness') f.owner.ensureCampusReady = () => pendingStep.promise;
    const pending = f.owner.set(1, step === 'readiness' ? 'campus' : 'direct');
    const result = pending.then(value => ({ value }), error => ({ error }));
    await new Promise(setImmediate); if (retire) f.state.current = false; pendingStep.reject(failure);
    assert.deepEqual(await result, retire ? { value: false } : { error: failure });
  }
});

test('a configured Session may load the original page without invalidating its accepted rule', async () => {
  const f = fixture(); f.owner.configure = async () => { f.record.revision++; };
  assert.equal(await f.owner.set(1, 'direct'), true);
  assert.ok(f.calls.includes('reload-cache') && f.calls.includes('toolbar'));
});

test('an effective campus route waits for readiness again but never reloads a retired page', async () => {
  const f = fixture(), ready = deferred(); f.owner.updateTabRoute = () => ({ route: 'campus' });
  f.owner.ensureCampusReady = () => ready.promise;
  const pending = f.owner.set(1, 'auto'); await new Promise(setImmediate);
  f.record.active = false; ready.resolve(true); assert.equal(await pending, true);
  assert.equal(f.calls.includes('reload-cache') || f.calls.includes('toolbar'), false);
});

test('failed URLs retry in the same original page and reentrant effect retirement fences later work', async () => {
  const f = fixture(); f.tab.failedUrl = 'https://failed.example.invalid/path';
  assert.equal(await f.owner.set(1, 'direct'), true);
  assert.equal(f.calls.find(value => Array.isArray(value) && value[0] === 'navigate')[1], f.tab.failedUrl);
  const g = fixture(); g.owner.clearSlowTimer = () => { g.state.current = false; };
  assert.equal(await g.owner.set(1, 'direct'), true);
  assert.equal(g.calls.includes('routes') || g.calls.includes('reload-cache') || g.calls.includes('toolbar'), false);
});

test('reentrant candidate or route projection retirement cannot start another readiness operation', async () => {
  for (const step of ['candidate', 'projection']) {
    const f = fixture(); let readyCalls = 0;
    f.owner.ensureCampusReady = async () => { readyCalls++; return true; };
    if (step === 'candidate') f.owner.clearCredentialCandidate = () => { f.state.current = false; };
    else f.owner.updateTabRoute = () => { f.state.current = false; return { route: 'campus' }; };
    assert.equal(await f.owner.set(1, step === 'candidate' ? 'campus' : 'auto'), step !== 'candidate');
    assert.equal(readyCalls, 0);
    assert.equal(f.calls.includes('reload-cache') || f.calls.includes('toolbar'), false);
  }
});

test('route command owner stays below the M2 per-owner ceiling', () => {
  const source = fs.readFileSync(require.resolve('../../../../lib/browser/session/browser-session-manager'), 'utf8');
  const start = source.indexOf('class BrowserRouteCommandOwner {'), end = source.indexOf('\nfunction calendarWeekQuery', start);
  assert.ok(start >= 0 && end > start); assert.ok(source.slice(start, end).split('\n').length <= 600);
});
