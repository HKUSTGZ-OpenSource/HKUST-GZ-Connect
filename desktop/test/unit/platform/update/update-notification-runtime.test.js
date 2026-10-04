'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { UpdateNotificationRuntime, AUTO_CHECK_INTERVAL_MS } = require('../../../../lib/platform/update/update-check');
const { RoutingPolicyTransactionQueue } = require('../../../../lib/routing/rules/routing-policy-transaction');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const state = { time: 1800000000000, settings: { updateCheckedAt: 0, language: 'zh' },
    result: { updateAvailable: true, latestVersion: '99.0.0',
      url: 'https://github.com/synthetic/project/releases/tag/v99.0.0' }, calls: [], available: true,
    check: null, commitFailure: false };
  const timers = new Map();
  let id = 0;
  const timer = (kind, callback, delay) => {
    const handle = { id: ++id, unref() { this.unreferenced = true; } };
    timers.set(handle, { kind, callback, delay }); return handle;
  };
  const runtime = new UpdateNotificationRuntime({
    getVersion: () => '2.0.1',
    check: async version => { state.calls.push(['request', version]); return state.check ? state.check() : state.result; },
    readSettings: () => {
      state.calls.push(['read']);
      if (!state.available) throw new Error('synthetic unavailable settings');
      return state.settings;
    },
    saveSettings: settings => { state.calls.push(['save', settings]); state.settings = settings; },
    assertPersistence: () => { state.calls.push(['assert']); if (!state.available) throw new Error('unavailable'); },
    runTransaction: async build => {
      state.calls.push(['transaction']);
      const plan = build();
      await plan.commit();
      if (state.commitFailure) { await plan.rollback(); throw new Error('synthetic transaction failure'); }
    },
    onAvailable: () => state.calls.push(['notify']),
    openExternal: async url => { state.calls.push(['open', url]); },
    now: () => state.time,
    setTimeoutFn: (fn, delay) => timer('timeout', fn, delay),
    setIntervalFn: (fn, delay) => timer('interval', fn, delay),
    clearTimeoutFn: handle => timers.delete(handle), clearIntervalFn: handle => timers.delete(handle),
  });
  return { state, timers, runtime };
}

test('automatic checks respect persisted 24h age; manual checks bypass only the throttle', async () => {
  const { state, runtime } = fixture();
  state.settings.updateCheckedAt = state.time;
  assert.equal(await runtime.run(), null);
  assert.equal(state.calls.some(([name]) => name === 'request'), false);
  await runtime.run(true);
  assert.equal(runtime.snapshot(), state.result);
  assert.deepEqual(state.calls.slice(-5).map(([name]) => name), ['transaction', 'assert', 'read', 'save', 'notify']);
  state.time += AUTO_CHECK_INTERVAL_MS;
  await runtime.run();
  assert.equal(state.calls.filter(([name]) => name === 'request').length, 2);
});

test('successful no-update replies persist throttle without overwriting the last notification', async () => {
  const { state, runtime } = fixture();
  await runtime.run(true);
  const previous = runtime.snapshot();
  state.result = { updateAvailable: false };
  state.time++;
  state.calls.length = 0;
  assert.equal(await runtime.run(true), state.result);
  assert.equal(state.settings.updateCheckedAt, state.time);
  assert.equal(runtime.snapshot(), previous);
  assert.equal(state.calls.some(([name]) => name === 'notify'), false);
});

test('a failed request does not persist a check timestamp or replace a notification', async () => {
  const { state, runtime } = fixture();
  await runtime.run(true);
  const before = runtime.snapshot();
  const checkedAt = state.settings.updateCheckedAt;
  state.result = null;
  state.time++;
  state.calls.length = 0;
  assert.equal(await runtime.run(true), null);
  assert.equal(state.settings.updateCheckedAt, checkedAt);
  assert.equal(runtime.snapshot(), before);
  assert.deepEqual(state.calls.map(([name]) => name), ['request']);
});

test('the context transaction reads current settings only after the request completes', async () => {
  const { state, runtime } = fixture();
  let resolve;
  state.check = () => new Promise(done => { resolve = done; });
  const pending = runtime.run(true);
  assert.equal(state.calls.some(([name]) => name === 'read'), false);
  state.settings = { updateCheckedAt: 0, language: 'en', port: 6180 };
  resolve(state.result);
  await pending;
  assert.deepEqual(state.settings, { updateCheckedAt: state.time, language: 'en', port: 6180 });
});

test('failed persistence rolls back the exact settings snapshot and cannot publish success', async () => {
  const { state, runtime } = fixture();
  const before = state.settings;
  state.commitFailure = true;
  await assert.rejects(runtime.run(true), /transaction failure/);
  assert.equal(state.settings, before);
  assert.equal(runtime.snapshot(), null);
  assert.equal(state.calls.some(([name]) => name === 'notify'), false);
});

test('settings read failures become rejected promises before automatic network work', async () => {
  const { state, runtime } = fixture();
  state.available = false;
  let pending;
  assert.doesNotThrow(() => { pending = runtime.run(); });
  await assert.rejects(pending, /unavailable/);
  assert.equal(state.calls.some(([name]) => name === 'request'), false);
});

test('development builds create no automatic timers; packaged scheduling is idempotent and cancellable', async () => {
  const { runtime, timers, state } = fixture();
  assert.equal(runtime.startAutomatic(false), false);
  assert.equal(timers.size, 0);
  assert.equal(runtime.startAutomatic(true), true);
  assert.equal(runtime.startAutomatic(true), false);
  assert.deepEqual([...timers.values()].map(({ delay }) => delay), [5000, AUTO_CHECK_INTERVAL_MS]);
  assert.equal([...timers.keys()][1].unreferenced, true);
  const retired = [...timers.values()].map(({ callback }) => callback);
  runtime.stopAutomatic(); runtime.stopAutomatic();
  assert.equal(timers.size, 0);
  runtime.startAutomatic(true);
  for (const callback of retired) callback();
  await new Promise(setImmediate);
  assert.equal(state.calls.length, 0, 'callbacks from retired timers cannot run against a restarted schedule');
  state.available = false;
  for (const { callback } of timers.values()) callback();
  await new Promise(setImmediate);
  assert.equal(state.calls.some(([name]) => name === 'request'), false);
  runtime.stopAutomatic();
});

test('opening remains an exact Main-issued notification check', async () => {
  const { state, runtime } = fixture();
  assert.deepEqual(runtime.open(state.result.url), { ok: false });
  await runtime.run(true);
  assert.deepEqual(runtime.open(state.result.url), { ok: true });
  assert.deepEqual(runtime.open(state.result.url + '/extra'), { ok: false });
  assert.deepEqual(state.calls.filter(([name]) => name === 'open'), [['open', state.result.url]]);
});

test('packaged startup and recurring callbacks use the same persisted throttle', async () => {
  const { runtime, timers, state } = fixture();
  runtime.startAutomatic(true);
  const initial = [...timers.values()].find(timer => timer.kind === 'timeout');
  const recurring = [...timers.values()].find(timer => timer.kind === 'interval');
  initial.callback();
  await new Promise(setImmediate);
  assert.equal(state.calls.filter(([name]) => name === 'request').length, 1);
  assert.equal(state.settings.updateCheckedAt, state.time);
  recurring.callback();
  await new Promise(setImmediate);
  assert.equal(state.calls.filter(([name]) => name === 'request').length, 1);
  state.time += AUTO_CHECK_INTERVAL_MS;
  recurring.callback();
  await new Promise(setImmediate);
  assert.equal(state.calls.filter(([name]) => name === 'request').length, 2);
  runtime.stopAutomatic();
});

test('terminal disposal aborts all pending requests and retains ownership until each settles', async () => {
  const f = fixture(), requests = [deferred(), deferred()], signals = [];
  f.runtime.check = (_version, { signal } = {}) => { signals.push(signal); return requests[signals.length - 1].promise; };
  const pending = [f.runtime.run(true), f.runtime.run(true)];
  for (const promise of pending) promise.catch(() => {});
  assert.equal(f.runtime.inFlightCount, 2);
  assert.equal(f.runtime.dispose(), true); assert.equal(f.runtime.dispose(), false);
  assert.equal(signals.every(signal => signal.aborted), true);
  assert.equal(f.runtime.inFlightCount, 2, 'ignored cancellation is still tracked, not detached');
  f.state.available = false;
  requests[0].resolve(f.state.result); requests[1].reject(new Error('synthetic late failure'));
  assert.deepEqual(await Promise.all(pending), [null, null]);
  assert.equal(f.runtime.inFlightCount, 0); assert.deepEqual(f.state.calls, []);
  assert.equal(f.runtime.snapshot(), null);
});

test('terminal disposal fences a factory queued behind a real mutation transaction', async () => {
  const f = fixture(), blocked = deferred(), entered = deferred();
  const queue = new RoutingPolicyTransactionQueue(), token = {};
  const blocker = queue.run(token, { commit: () => { entered.resolve(); return blocked.promise; } });
  await entered.promise;
  f.runtime.runTransaction = build => queue.run(token, build);
  const pending = f.runtime.run(true);
  await new Promise(setImmediate);
  f.runtime.dispose(); f.state.available = false; f.state.calls.length = 0;
  blocked.resolve(); await blocker;
  assert.equal(await pending, null); assert.deepEqual(f.state.calls, []);
  assert.equal(f.runtime.inFlightCount, 0);
});

test('terminal disposal fences captured commit and rollback operations without touching retired settings', async () => {
  const f = fixture(), captured = deferred(), release = deferred();
  f.runtime.runTransaction = async build => {
    const plan = build(); captured.resolve(); await release.promise;
    await plan.commit(); await plan.rollback();
  };
  const pending = f.runtime.run(true); await captured.promise;
  f.runtime.dispose(); f.state.available = false; f.state.calls.length = 0;
  release.resolve(); assert.equal(await pending, null);
  assert.deepEqual(f.state.calls, []); assert.equal(f.runtime.snapshot(), null);
});

test('retirement after a live transaction prevents late publication', async () => {
  const f = fixture(), committed = deferred(), release = deferred();
  f.runtime.runTransaction = async build => { await build().commit(); committed.resolve(); await release.promise; };
  const pending = f.runtime.run(true); await committed.promise;
  assert.equal(f.state.settings.updateCheckedAt, f.state.time, 'a prior live commit remains legitimate');
  f.runtime.dispose(); f.state.calls.length = 0; release.resolve();
  assert.equal(await pending, null); assert.deepEqual(f.state.calls, []); assert.equal(f.runtime.snapshot(), null);
});

test('disposed owners create no timers, requests, reads, or external openings', async () => {
  const f = fixture(); await f.runtime.run(true);
  f.runtime.startAutomatic(true); const callbacks = [...f.timers.values()].map(timer => timer.callback);
  f.runtime.dispose(); f.state.calls.length = 0; f.state.available = false;
  assert.equal(await f.runtime.run(), null); assert.equal(await f.runtime.run(true), null);
  assert.equal(f.runtime.startAutomatic(true), false);
  assert.deepEqual(f.runtime.open(f.state.result.url), { ok: false });
  for (const callback of callbacks) callback();
  await new Promise(setImmediate);
  assert.equal(f.timers.size, 0); assert.deepEqual(f.state.calls, []);
});

test('stopping automatic scheduling remains reversible and does not retire a manual check', async () => {
  const f = fixture(), reply = deferred(); f.state.check = () => reply.promise;
  const pending = f.runtime.run(true); f.runtime.stopAutomatic();
  reply.resolve(f.state.result); assert.equal(await pending, f.state.result);
  assert.equal(f.runtime.snapshot(), f.state.result); assert.equal(f.runtime.startAutomatic(true), true);
  f.runtime.dispose();
});

test('live request failures retain their original identity and settle tracked ownership', async () => {
  const f = fixture(), failure = new Error('synthetic live failure');
  f.state.check = async () => { throw failure; };
  await assert.rejects(f.runtime.run(true), error => error === failure);
  assert.equal(f.runtime.inFlightCount, 0); assert.equal(f.runtime.snapshot(), null);
  f.runtime.dispose();
});

test('reentrant lifecycle effects cannot start requests, read after persistence admission, or write after the clock', async () => {
  for (const stage of ['initial-read', 'version', 'persistence', 'clock']) {
    const f = fixture();
    if (stage === 'initial-read') f.runtime.readSettings = () => { f.runtime.dispose(); return f.state.settings; };
    if (stage === 'version') f.runtime.getVersion = () => { f.runtime.dispose(); return '2.0.3'; };
    if (stage === 'persistence') f.runtime.assertPersistence = () => { f.runtime.dispose(); };
    if (stage === 'clock') f.runtime.now = () => { f.runtime.dispose(); return f.state.time; };
    assert.equal(await f.runtime.run(stage !== 'initial-read'), null);
    assert.equal(f.runtime.inFlightCount, 0);
    assert.equal(f.state.calls.some(([name]) => name === 'save' || name === 'notify'), false);
    if (stage === 'initial-read' || stage === 'version') assert.deepEqual(f.state.calls, []);
    if (stage === 'persistence') assert.equal(f.state.calls.some(([name]) => name === 'read'), false);
  }
});
