'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { CampusBrowser } = require('../../../../lib/browser/session/campus-browser');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(transition = async () => ({})) {
  const calls = [];
  const browser = {
    routingSuspended: false,
    routingRequestsBlocked: true,
    configuredPort: null,
    campusSession: null,
    routingActivationInFlight: null,
  };
  const apply = async (kind, port) => {
    calls.push([kind, port]);
    const session = await transition(port);
    if (session !== null) Object.assign(browser, {
      routingSuspended: false, routingRequestsBlocked: false, configuredPort: port, campusSession: session,
    });
    return session;
  };
  browser.configure = port => apply('configure', port);
  browser.resumeRoutingPolicy = port => apply('resume', port);
  const activate = port => CampusBrowser.prototype.activateRoutingPolicy.call(browser, port);
  return { browser, calls, activate };
}

test('same-port followers queued behind another port share the next production transition', async t => {
  const firstGate = deferred();
  const nextGate = deferred();
  const session = {};
  t.after(() => { firstGate.resolve(session); nextGate.resolve(session); });
  const f = fixture(port => port === 6180 ? firstGate.promise : nextGate.promise);
  const first = f.activate(6180);
  const next = f.activate(7180);
  const follower = f.activate(7180);
  firstGate.resolve(session);
  await first;
  assert.deepEqual(f.calls, [['configure', 6180], ['configure', 7180]],
    'a queued follower must recheck the replacement flight rather than duplicate it');
  nextGate.resolve(session);
  assert.deepEqual(await Promise.all([next, follower]), [session, session]);
  assert.equal(f.browser.routingActivationInFlight, null);
});

test('multiple queued ports serialize and then re-evaluate the authoritative production Session', async t => {
  const firstGate = deferred();
  const nextGate = deferred();
  const session = {};
  t.after(() => { firstGate.resolve(session); nextGate.resolve(session); });
  const f = fixture(port => port === 6180 ? firstGate.promise
    : port === 7180 ? nextGate.promise : Promise.resolve(session));
  const first = f.activate(6180);
  const next = f.activate(7180);
  const last = f.activate(8180);
  firstGate.resolve(session);
  await first;
  assert.deepEqual(f.calls, [['configure', 6180], ['configure', 7180]],
    'the third port must wait for the replacement flight');
  nextGate.resolve(session);
  await Promise.all([next, last]);
  assert.deepEqual(f.calls, [['configure', 6180], ['configure', 7180], ['configure', 8180]]);
  assert.equal(f.browser.configuredPort, 8180);
  assert.equal(f.browser.routingActivationInFlight, null);
});

test('ready production Sessions reuse their port and suspended Sessions resume', async () => {
  const session = {};
  const f = fixture(async () => session);
  assert.equal(await f.activate(6180), session);
  assert.equal(await f.activate('6180'), session);
  assert.deepEqual(f.calls, [['configure', 6180]]);
  f.browser.routingSuspended = true;
  f.browser.routingRequestsBlocked = true;
  assert.equal(await f.activate(6180), session);
  assert.deepEqual(f.calls, [['configure', 6180], ['resume', 6180]]);
});

test('rejected shared production transitions propagate once and do not auto-retry', async () => {
  const pending = deferred();
  let fail = true;
  const session = {};
  const f = fixture(() => fail ? pending.promise : Promise.resolve(session));
  const waits = [f.activate(6180), f.activate(7180), f.activate(7180)];
  pending.reject(new Error('synthetic Session transition failure'));
  for (const result of await Promise.allSettled(waits)) {
    assert.equal(result.status, 'rejected');
    assert.match(result.reason.message, /synthetic Session transition/);
  }
  assert.deepEqual(f.calls, [['configure', 6180]]);
  assert.equal(f.browser.routingActivationInFlight, null);
  fail = false;
  assert.equal(await f.activate(7180), session);
});

test('a superseding fail-closed production transition does not become a ready Session', async () => {
  const f = fixture(async () => null);
  f.browser.routingSuspended = true;
  assert.equal(await f.activate(6180), null);
  assert.equal(f.browser.routingRequestsBlocked, true);
  assert.equal(f.browser.campusSession, null);
  assert.equal(f.browser.routingActivationInFlight, null);
});

test('a late production completion after repeated reset cannot erase a replacement flight', async t => {
  const old = deferred();
  const replacement = deferred();
  const session = {};
  t.after(() => { old.resolve(session); replacement.resolve(session); });
  const f = fixture(port => port === 6180 ? old.promise : replacement.promise);
  const first = f.activate(6180);
  f.browser.routingActivationInFlight = null;
  f.browser.routingActivationInFlight = null;
  const second = f.activate(7180);
  const current = f.browser.routingActivationInFlight;
  old.resolve(session);
  await first;
  assert.equal(f.browser.routingActivationInFlight, current);
  replacement.resolve(session);
  await second;
  assert.equal(f.browser.routingActivationInFlight, null);
});
