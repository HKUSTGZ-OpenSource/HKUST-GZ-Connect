'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ConnectionStateMachine } = require('../../../../lib/connection/state/connection-state-machine');
const {
  DEFAULT_NETWORK_POLL_MS,
  NetworkStartupCoordinator,
  NetworkStatusMonitor,
  createNetworkStartupSystem,
  createStartupAutoConnectEligibility,
} = require('../../../../lib/connection/telemetry/network-status-monitor');

test('startup eligibility construction validates capabilities without reading them', () => {
  let reads = 0;
  const effect = () => { reads++; throw new Error('construction must not read'); };
  assert.equal(typeof createStartupAutoConnectEligibility({ readSettings: effect, hasPersistentCredential: effect }), 'function');
  assert.equal(reads, 0);
  for (const options of [undefined, {}, { readSettings: effect }, { hasPersistentCredential: effect }]) {
    assert.throws(() => createStartupAutoConnectEligibility(options), TypeError);
  }
  assert.equal(reads, 0);
});

test('startup eligibility retains settings then username then persistent presence short-circuit order', () => {
  const calls = [];
  let autoConnect = false, username = '', persistent = false;
  const settings = { get autoConnect() { calls.push('auto'); return autoConnect; },
    get username() { calls.push('username'); return username; },
    get password() { throw new Error('eligibility must not read secrets'); } };
  const eligible = createStartupAutoConnectEligibility({ readSettings: () => { calls.push('settings'); return settings; },
    hasPersistentCredential: () => { calls.push('presence'); return persistent; } });
  assert.equal(eligible(), false); assert.deepEqual(calls.splice(0), ['settings', 'auto']);
  autoConnect = true;
  assert.equal(eligible(), false); assert.deepEqual(calls.splice(0), ['settings', 'auto', 'username']);
  username = 'synthetic-account';
  assert.equal(eligible(), false); assert.deepEqual(calls.splice(0), ['settings', 'auto', 'username', 'presence']);
  persistent = true;
  assert.equal(eligible(), true); assert.deepEqual(calls.splice(0), ['settings', 'auto', 'username', 'presence']);
});

test('startup eligibility reads current values and preserves the original exact-false test and raw presence result', () => {
  let settings = { username: 'synthetic-account' }, presence = true;
  const eligible = createStartupAutoConnectEligibility({ readSettings: () => settings, hasPersistentCredential: () => presence });
  assert.equal(eligible(), true);
  settings = { autoConnect: false, username: 'synthetic-account' }; assert.equal(eligible(), false);
  settings = { autoConnect: true, username: '' }; assert.equal(eligible(), false);
  settings = { autoConnect: true, username: 'synthetic-account' };
  presence = 'synthetic-nonboolean'; assert.equal(eligible(), presence,
    'strict true admission remains the coordinator responsibility, not a new coercion here');
});

test('startup eligibility preserves failures and existing coordinator admission fails closed without connecting', async () => {
  const failure = new Error('synthetic read failure');
  let settings = { username: 'synthetic-account' }, presence = true, readsFail = true, connects = 0;
  const eligible = createStartupAutoConnectEligibility({ readSettings: () => { if (readsFail) throw failure; return settings; },
    hasPersistentCredential: () => { if (presence instanceof Error) throw presence; return presence; } });
  assert.throws(eligible, error => error === failure);
  const owner = new NetworkStartupCoordinator({ monitor: { start: async () => true, snapshot: () => ({ baseline: true }) },
    shouldAutoConnect: eligible, pauseOffline() {}, resumeOffline() {}, connect: () => { connects++; }, isQuitting: () => false });
  assert.equal(await owner.start(), false);
  assert.equal(owner.snapshot().timerScheduled, false); assert.equal(connects, 0);
  readsFail = false; presence = failure; assert.throws(eligible, error => error === failure);
  assert.equal(owner.eligible(), false);
  presence = 'truthy'; assert.equal(owner.eligible(), false);
  presence = true; assert.equal(owner.eligible(), true);
  settings = null; assert.throws(eligible, TypeError); assert.equal(owner.eligible(), false);
  owner.dispose();
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

class FakeTimer {
  constructor() {
    this.unrefCount = 0;
  }

  unref() {
    this.unrefCount += 1;
  }
}

class FakeTimers {
  constructor() {
    this.nextId = 1;
    this.active = new Map();
    this.all = new Map();
  }

  setTimeout(callback, delayMs) {
    const id = this.nextId++;
    const record = { callback, delayMs, timer: new FakeTimer() };
    this.active.set(id, record);
    this.all.set(id, record);
    return record.timer;
  }

  clearTimeout(timer) {
    for (const [id, record] of this.active) {
      if (record.timer === timer) this.active.delete(id);
    }
  }

  ids() {
    return [...this.active.keys()];
  }

  record(id) {
    return this.all.get(id);
  }

  callback(id) {
    return this.all.get(id)?.callback;
  }

  fire(id) {
    const record = this.active.get(id);
    if (!record) return undefined;
    this.active.delete(id);
    return record.callback();
  }
}

function monitorFor(statuses, overrides = {}) {
  const timers = new FakeTimers();
  const events = [];
  let reads = 0;
  const monitor = new NetworkStatusMonitor({
    isOnline: () => {
      const value = statuses[Math.min(reads, statuses.length - 1)];
      reads += 1;
      if (value instanceof Error) throw value;
      return value;
    },
    onOnline: () => events.push('online'),
    onOffline: () => events.push('offline'),
    setTimeout: timers.setTimeout.bind(timers),
    clearTimeout: timers.clearTimeout.bind(timers),
    ...overrides,
  });
  return { events, get reads() { return reads; }, monitor, timers };
}

async function fireOnlyTimer(fixture) {
  const [id] = fixture.timers.ids();
  assert.ok(id, 'expected one scheduled poll');
  await fixture.timers.fire(id);
  return id;
}

test('start establishes a silent baseline and only real transitions emit', async () => {
  const fixture = monitorFor([true, true, false, false, true]);
  assert.equal(await fixture.monitor.start(), true);
  assert.deepEqual(fixture.events, []);
  assert.equal(fixture.monitor.snapshot().baseline, true);

  await fireOnlyTimer(fixture);
  assert.deepEqual(fixture.events, []);
  await fireOnlyTimer(fixture);
  assert.deepEqual(fixture.events, ['offline']);
  await fireOnlyTimer(fixture);
  assert.deepEqual(fixture.events, ['offline']);
  await fireOnlyTimer(fixture);
  assert.deepEqual(fixture.events, ['offline', 'online']);
});

test('sync errors and non-boolean samples are ignored without changing the baseline', async () => {
  const fixture = monitorFor([new Error('net unavailable'), 'yes', false, undefined, true]);
  await fixture.monitor.start();
  assert.equal(fixture.monitor.snapshot().baseline, null);
  await fireOnlyTimer(fixture);
  assert.equal(fixture.monitor.snapshot().baseline, null);
  await fireOnlyTimer(fixture);
  assert.equal(fixture.monitor.snapshot().baseline, false);
  assert.deepEqual(fixture.events, []);
  await fireOnlyTimer(fixture);
  assert.equal(fixture.monitor.snapshot().baseline, false);
  await fireOnlyTimer(fixture);
  assert.deepEqual(fixture.events, ['online']);
});

test('baseline wait is event-driven, bounded, and cancellable', async () => {
  const fixture = monitorFor([undefined, true]);
  await fixture.monitor.start();
  const waiting = fixture.monitor.waitForBaseline({ timeoutMs: 12_000 });
  assert.equal(fixture.timers.ids().length, 2,
    'one monitor poll and one baseline deadline are owned');
  const pollTimer = fixture.timers.ids().find((id) => (
    fixture.timers.record(id).delayMs === DEFAULT_NETWORK_POLL_MS
  ));
  await fixture.timers.fire(pollTimer);
  assert.equal(await waiting.promise, true);
  assert.equal(fixture.timers.ids().length, 1,
    'the baseline deadline is cleared and only the next monitor poll remains');

  fixture.monitor.stop();
  const cancelledFixture = monitorFor([undefined]);
  await cancelledFixture.monitor.start();
  const cancelled = cancelledFixture.monitor.waitForBaseline({ timeoutMs: 12_000 });
  cancelled.cancel();
  assert.equal(await cancelled.promise, null);
  assert.equal(cancelledFixture.timers.ids().length, 1,
    'cancel removes its deadline without stopping the monitor itself');
});

test('every recursive timer uses the reviewed default interval and is unrefed', async () => {
  const fixture = monitorFor([true, true]);
  await fixture.monitor.start();
  const [first] = fixture.timers.ids();
  assert.equal(fixture.timers.record(first).delayMs, DEFAULT_NETWORK_POLL_MS);
  assert.equal(fixture.timers.record(first).timer.unrefCount, 1);
  await fixture.timers.fire(first);
  const [second] = fixture.timers.ids();
  assert.equal(fixture.timers.record(second).timer.unrefCount, 1);
});

test('stop makes an already queued timer callback inert', async () => {
  const fixture = monitorFor([true, false]);
  await fixture.monitor.start();
  const [timer] = fixture.timers.ids();
  const queued = fixture.timers.callback(timer);
  fixture.monitor.stop();

  assert.deepEqual(fixture.timers.ids(), []);
  assert.equal(await queued(), undefined);
  assert.equal(fixture.reads, 1);
  assert.deepEqual(fixture.events, []);
  assert.deepEqual(fixture.monitor.snapshot(), {
    running: false,
    disposed: false,
    baseline: null,
    pollInFlight: false,
    timerScheduled: false,
  });
});

test('stop or dispose invalidates an asynchronous result already in flight', async () => {
  for (const action of ['stop', 'dispose']) {
    const timers = new FakeTimers();
    const second = deferred();
    let reads = 0;
    const events = [];
    const monitor = new NetworkStatusMonitor({
      isOnline: () => (++reads === 1 ? true : second.promise),
      onOnline: () => events.push('online'),
      onOffline: () => events.push('offline'),
      setTimeout: timers.setTimeout.bind(timers),
      clearTimeout: timers.clearTimeout.bind(timers),
    });
    await monitor.start();
    const [timer] = timers.ids();
    const poll = timers.fire(timer);
    await Promise.resolve();
    monitor[action]();
    second.resolve(false);
    assert.equal(await poll, false);
    assert.deepEqual(events, []);
    assert.deepEqual(timers.ids(), []);
  }
});

test('an async poll never overlaps and repeated start is idempotent', async () => {
  const timers = new FakeTimers();
  const pending = deferred();
  let activeReads = 0;
  let maxActiveReads = 0;
  let reads = 0;
  const monitor = new NetworkStatusMonitor({
    isOnline: async () => {
      reads += 1;
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      try { return reads === 1 ? true : await pending.promise; }
      finally { activeReads -= 1; }
    },
    onOnline() {},
    onOffline() {},
    setTimeout: timers.setTimeout.bind(timers),
    clearTimeout: timers.clearTimeout.bind(timers),
  });
  await monitor.start();
  const [timer] = timers.ids();
  const queuedTick = timers.callback(timer);
  const inFlight = timers.fire(timer);
  await Promise.resolve();
  assert.equal(reads, 2);
  assert.equal(await queuedTick(), undefined, 'the same queued tick cannot start a second poll');
  assert.equal(monitor.snapshot().pollInFlight, true);
  assert.deepEqual(timers.ids(), [], 'next poll is scheduled only after completion');
  const repeatedStart = monitor.start();
  assert.equal(reads, 2);
  pending.resolve(false);
  assert.equal(await inFlight, true);
  assert.equal(await repeatedStart, true);
  assert.equal(maxActiveReads, 1);
  assert.equal(reads, 2);
  assert.equal(timers.ids().length, 1);
});

test('restart after stop learns a new baseline without emitting a transition', async () => {
  const fixture = monitorFor([true, false]);
  await fixture.monitor.start();
  const [oldTimer] = fixture.timers.ids();
  const staleTick = fixture.timers.callback(oldTimer);
  fixture.monitor.stop();
  await fixture.monitor.start();
  assert.deepEqual(fixture.events, []);
  assert.equal(fixture.monitor.snapshot().baseline, false);
  assert.equal(await staleTick(), undefined);
  assert.equal(fixture.reads, 2, 'an old stopped tick cannot read into the restarted monitor');
});

test('constructor bounds the polling interval and dispose prevents restart', async () => {
  assert.throws(() => new NetworkStatusMonitor(), /callbacks/);
  assert.throws(() => monitorFor([true], { intervalMs: 999 }), /interval/);
  const fixture = monitorFor([true]);
  fixture.monitor.dispose();
  assert.equal(await fixture.monitor.start(), false);
  assert.equal(fixture.reads, 0);
});

test('initial offline startup pauses one desired intent and connects exactly once after online', async () => {
  const timers = new FakeTimers();
  const monitor = {
    start: async () => true,
    snapshot: () => ({ baseline: false }),
  };
  const events = [];
  const connection = new ConnectionStateMachine();
  let startupIntent = null;
  let quitting = false;
  const startup = new NetworkStartupCoordinator({
    monitor,
    shouldAutoConnect: () => true,
    pauseOffline: () => {
      startupIntent = connection.beginConnectIntent();
      events.push('paused');
      return connection.pauseForConnectivity(startupIntent);
    },
    resumeOffline: async () => {
      assert.equal(connection.resumeConnectivity(startupIntent), true);
      events.push('connected');
    },
    connect: async () => { events.push('unexpected-direct-connect'); },
    isQuitting: () => quitting,
    setTimeout: timers.setTimeout.bind(timers),
    clearTimeout: timers.clearTimeout.bind(timers),
  });

  assert.equal(await startup.start(), true);
  assert.deepEqual(events, ['paused']);
  assert.deepEqual(timers.ids(), [], 'offline startup must not schedule an Engine start');
  assert.equal(startup.snapshot().pausedOffline, true);
  assert.equal(connection.snapshot().desiredConnected, true);
  assert.equal(connection.snapshot().phase, 'connectivity-paused');

  assert.equal(await startup.networkOnline(), true);
  assert.deepEqual(events, ['paused', 'connected']);
  assert.equal(connection.snapshot().phase, 'starting');
  assert.equal(await startup.networkOnline(), false, 'the initial outage is consumed exactly once');
  assert.deepEqual(timers.ids(), []);

  quitting = true;
  startup.dispose();
});

test('manual cancellation or quit makes an initial network continuation inert', async () => {
  for (const action of ['cancel', 'quit']) {
    const timers = new FakeTimers();
    const baseline = deferred();
    let connects = 0;
    let pauses = 0;
    let quitting = false;
    const startup = new NetworkStartupCoordinator({
      monitor: {
        start: () => baseline.promise,
        snapshot: () => ({ baseline: false }),
      },
      shouldAutoConnect: () => true,
      pauseOffline: () => { pauses += 1; return true; },
      resumeOffline: async () => { connects += 1; },
      connect: async () => { connects += 1; },
      isQuitting: () => quitting,
      setTimeout: timers.setTimeout.bind(timers),
      clearTimeout: timers.clearTimeout.bind(timers),
    });
    const started = startup.start();
    if (action === 'cancel') startup.cancel();
    else quitting = true;
    baseline.resolve(true);
    assert.equal(await started, false);
    assert.equal(pauses, 0);
    assert.equal(connects, 0);
    assert.deepEqual(timers.ids(), []);
  }
});

test('initial online startup preserves one delayed auto-connect and cancellation revokes it', async () => {
  for (const cancelBeforeFire of [false, true]) {
    const timers = new FakeTimers();
    let connects = 0;
    const startup = new NetworkStartupCoordinator({
      monitor: {
        start: async () => true,
        snapshot: () => ({ baseline: true }),
      },
      shouldAutoConnect: () => true,
      pauseOffline: () => { throw new Error('online startup cannot pause'); },
      resumeOffline: () => { throw new Error('online startup cannot resume'); },
      connect: async () => { connects += 1; },
      isQuitting: () => false,
      setTimeout: timers.setTimeout.bind(timers),
      clearTimeout: timers.clearTimeout.bind(timers),
    });
    assert.equal(await startup.start(), true);
    const [timer] = timers.ids();
    assert.ok(timer);
    const queued = timers.callback(timer);
    if (cancelBeforeFire) startup.cancel();
    await queued();
    assert.equal(connects, cancelBeforeFire ? 0 : 1);
    assert.equal(await startup.start(), true, 'startup remains single-flight');
    assert.equal(connects, cancelBeforeFire ? 0 : 1);
  }
});

test('startup-only and ordinary online transitions use distinct recovery callbacks', async () => {
  for (const initialOffline of [false, true]) {
    let initialResumes = 0;
    let runtimeResumes = 0;
    const system = createNetworkStartupSystem({
      appIsPackaged: true,
      environment: {},
      dataDirectory: '/tmp',
      isOnline: () => !initialOffline,
      onOffline() {},
      onOnline: () => { runtimeResumes += 1; return true; },
      shouldAutoConnect: () => initialOffline,
      pauseOffline: () => 19,
      resumeInitialOffline: (intent) => {
        assert.equal(intent, 19);
        initialResumes += 1;
        return true;
      },
      connect() {},
      isQuitting: () => false,
    });
    await system.startup.start();
    await system.monitor.onOnline();
    assert.equal(initialResumes, initialOffline ? 1 : 0);
    assert.equal(runtimeResumes, initialOffline ? 0 : 1);
    system.startup.dispose();
    system.monitor.dispose();
  }
});

test('unknown initial network samples wait for one bounded valid baseline', async () => {
  const baseline = deferred();
  const timers = new FakeTimers();
  let connects = 0;
  let waits = 0;
  let waitCancelled = 0;
  const startup = new NetworkStartupCoordinator({
    monitor: {
      start: async () => true,
      snapshot: () => ({ baseline: null }),
      waitForBaseline: () => {
        waits += 1;
        return { promise: baseline.promise, cancel: () => { waitCancelled += 1; } };
      },
    },
    shouldAutoConnect: () => true,
    pauseOffline: () => 1,
    resumeOffline: () => true,
    connect: async () => { connects += 1; },
    isQuitting: () => false,
    setTimeout: timers.setTimeout.bind(timers),
    clearTimeout: timers.clearTimeout.bind(timers),
  });
  const started = startup.start();
  await Promise.resolve();
  assert.equal(waits, 1);
  assert.deepEqual(timers.ids(), [], 'unknown is not treated as an online sample');
  baseline.resolve(true);
  assert.equal(await started, true);
  assert.equal(waitCancelled, 1);
  const [timer] = timers.ids();
  await timers.fire(timer);
  assert.equal(connects, 1);
});

test('auto-connect becoming ineligible during baseline wait creates no intent or timer', async () => {
  const baseline = deferred();
  const timers = new FakeTimers();
  let eligible = true;
  let pauses = 0;
  let connects = 0;
  const startup = new NetworkStartupCoordinator({
    monitor: {
      start: async () => true,
      snapshot: () => ({ baseline: null }),
      waitForBaseline: () => ({ promise: baseline.promise, cancel() {} }),
    },
    shouldAutoConnect: () => eligible,
    pauseOffline: () => { pauses += 1; return 1; },
    resumeOffline: () => true,
    connect: () => { connects += 1; },
    isQuitting: () => false,
    setTimeout: timers.setTimeout.bind(timers),
    clearTimeout: timers.clearTimeout.bind(timers),
  });
  const started = startup.start();
  await Promise.resolve();
  eligible = false;
  baseline.resolve(false);
  assert.equal(await started, false);
  assert.equal(pauses, 0);
  assert.equal(connects, 0);
  assert.deepEqual(timers.ids(), []);
});
