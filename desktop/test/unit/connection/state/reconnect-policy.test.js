'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { STABLE_SESSION_MS, planReconnect } = require('../../../../lib/connection/state/reconnect-policy');

test('a short-lived listener does not reset the retry budget', () => {
  assert.deepEqual(planReconnect({
    attempts: 2,
    maxAttempts: 3,
    wasConnected: true,
    uptimeMs: 1000,
    failureKind: 'gateway-transient',
  }), { attempt: 3, delayMs: 15_000 });
  assert.equal(planReconnect({
    attempts: 3,
    maxAttempts: 3,
    wasConnected: true,
    uptimeMs: 1000,
  }), null);
});

test('a genuinely stable session receives a fresh retry budget', () => {
  assert.deepEqual(planReconnect({
    attempts: 3,
    maxAttempts: 3,
    wasConnected: true,
    uptimeMs: STABLE_SESSION_MS + 1,
  }), { attempt: 1, delayMs: 2000 });
});

test('gateway transients settle longer than ordinary failures', () => {
  assert.equal(planReconnect({
    attempts: 0,
    maxAttempts: 3,
    failureKind: 'gateway-transient',
  }).delayMs, 5000);
  assert.equal(planReconnect({
    attempts: 0,
    maxAttempts: 3,
    failureKind: 'unknown',
  }).delayMs, 2000);
});

test('network outages retain recovery beyond the short retry budget with a capped delay', () => {
  for (const failureKind of ['network-transient', 'gateway-transient']) {
    let attempts = 0;
    for (let outage = 0; outage < 20; outage += 1) {
      const plan = planReconnect({ attempts, maxAttempts: 3, failureKind });
      assert.ok(plan, 'a long outage must not require a manual reconnect');
      attempts = plan.attempt;
      if (outage >= 3) assert.ok(plan.delayMs >= 5000 && plan.delayMs <= 30_000);
    }
    assert.equal(attempts, 3, 'the backoff counter saturates instead of growing without bound');
    assert.equal(planReconnect({ attempts, maxAttempts: 0, failureKind }), null);
  }
});
