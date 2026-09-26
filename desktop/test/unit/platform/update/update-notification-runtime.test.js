'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { UpdateNotificationRuntime, AUTO_CHECK_INTERVAL_MS } = require('../../../../lib/platform/update/update-check');

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
