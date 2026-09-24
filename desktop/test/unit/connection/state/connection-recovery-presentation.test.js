'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  connectionRecoveryPresentation,
} = require('../../../../lib/connection/state/connection-recovery-presentation');

test('public recovery categories map stable lifecycle evidence to one action', () => {
  assert.deepEqual(connectionRecoveryPresentation(
    { dnsMode: 'gateway' }, { connected: true, connecting: false },
  ), { schemaVersion: 1, category: 'ready', action: 'none' });
  assert.deepEqual(connectionRecoveryPresentation(
    { failureCode: 'AUTH_REJECTED', lastError: 'redacted' },
    { connected: false, connecting: false },
  ), { schemaVersion: 1, category: 'authentication', action: 'reconnect' });
  assert.deepEqual(connectionRecoveryPresentation(
    { failureCode: 'GATEWAY_PRELOGIN_UNAVAILABLE', lastError: 'redacted' },
    { connected: false, connecting: false },
  ), { schemaVersion: 1, category: 'network', action: 'reconnect' });
  assert.deepEqual(connectionRecoveryPresentation(
    { failureCode: 'LOCAL_LISTENER_FAILED', lastError: 'redacted' },
    { connected: false, connecting: false },
  ), { schemaVersion: 1, category: 'local-listener', action: 'open-tower' });
  assert.deepEqual(connectionRecoveryPresentation(
    { recoveryError: 'redacted' }, { connected: false, connecting: false },
  ), { schemaVersion: 1, category: 'local-state', action: 'open-settings' });
});

test('connected DNS failure remains visible without turning into a generic reconnect loop', () => {
  assert.deepEqual(connectionRecoveryPresentation(
    { dnsMode: 'disabled' }, { connected: true, connecting: false },
  ), { schemaVersion: 1, category: 'dns', action: 'open-tower' });
});

test('unknown errors stay bounded and actionable without parsing diagnostic text', () => {
  assert.deepEqual(connectionRecoveryPresentation(
    { lastError: 'arbitrary localized detail' }, { connected: false, connecting: false },
  ), { schemaVersion: 1, category: 'error', action: 'reconnect' });
});
