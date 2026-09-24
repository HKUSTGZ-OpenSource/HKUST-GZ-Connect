'use strict';

const AUTHENTICATION_CODES = new Set([
  'AUTH_FAILED', 'AUTH_REJECTED', 'AUTH_INDETERMINATE', 'AUTH_PROTOCOL_INVALID',
  'AUTH_EXPIRED', 'AUTH_LIMIT_EXCEEDED', 'UNSUPPORTED_AUTHENTICATION', 'CREDENTIALS_INVALID',
]);
const CONFIGURATION_CODES = new Set(['INVALID_ARGUMENTS', 'CONFIGURATION_INVALID']);
const LOCAL_LISTENER_CODES = new Set(['LOCAL_LISTENER_FAILED', 'local_service_failed']);
const NETWORK_CODES = new Set([
  'GATEWAY_PRELOGIN_UNAVAILABLE', 'DATA_PLANE_SETUP_TRANSIENT', 'DATA_PLANE_SETUP_FAILED', 'NETWORK_DISCONNECTED',
  'network_unhealthy', 'startup_failed',
]);

function connectionRecoveryPresentation(state = {}, presentation = {}) {
  let category = 'idle';
  let action = 'none';
  if (presentation.connected === true) {
    category = state.dnsMode === 'disabled' ? 'dns' : 'ready';
    action = state.dnsMode === 'disabled' ? 'open-tower' : 'none';
  } else if (presentation.connecting === true) {
    category = 'connecting';
  } else if (state.settingsError || state.recoveryError) {
    category = 'local-state';
    action = 'open-settings';
  } else if (state.browserNotice && !state.lastError) {
    category = 'browser';
    action = 'open-tower';
  } else if (AUTHENTICATION_CODES.has(state.failureCode)) {
    category = 'authentication';
    action = 'reconnect';
  } else if (CONFIGURATION_CODES.has(state.failureCode)) {
    category = 'configuration';
    action = 'open-tower';
  } else if (LOCAL_LISTENER_CODES.has(state.failureCode)) {
    category = 'local-listener';
    action = 'open-tower';
  } else if (NETWORK_CODES.has(state.failureCode) || state.failureKind === 'gateway-transient') {
    category = 'network';
    action = 'reconnect';
  } else if (state.lastError) {
    category = 'error';
    action = 'reconnect';
  }
  return Object.freeze({ schemaVersion: 1, category, action });
}

module.exports = { connectionRecoveryPresentation };
