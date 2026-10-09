'use strict';

const AUTHENTICATION_CODES = new Set([
  'AUTH_FAILED', 'AUTH_REJECTED', 'AUTH_INDETERMINATE', 'AUTH_PROTOCOL_INVALID',
  'AUTH_EXPIRED', 'AUTH_LIMIT_EXCEEDED', 'UNSUPPORTED_AUTHENTICATION', 'CREDENTIALS_INVALID',
]);
const CONFIGURATION_CODES = new Set(['INVALID_ARGUMENTS', 'CONFIGURATION_INVALID']);
const LOCAL_LISTENER_CODES = new Set(['LOCAL_LISTENER_FAILED', 'local_service_failed']);
const NETWORK_CODES = new Set([
  'AUTH_NETWORK_UNAVAILABLE',
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
  } else if (NETWORK_CODES.has(state.failureCode) ||
      ['gateway-transient', 'network-transient'].includes(state.failureKind)) {
    category = 'network';
    action = 'reconnect';
  } else if (state.lastError) {
    category = 'error';
    action = 'reconnect';
  }
  return Object.freeze({ schemaVersion: 1, category, action });
}

function projectConnectionStatus(state, presentation, connectedAt) {
  const notice = [state?.notice, state?.browserNotice, state?.diagnosticNotice]
    .filter(Boolean).join('\n') || null;
  const lastError = [state?.lastError, state?.settingsError, state?.recoveryError]
    .filter(Boolean).join('\n') || null;
  return Object.freeze({
    ...state, notice, lastError, ...presentation, connectedAt,
    recovery: connectionRecoveryPresentation({ ...state, lastError }, presentation),
  });
}

// Presentation has no connection-phase authority. Existing Engine/persistence
// owners retain the same mutable display record; the FSM alone projects phases.
// Effects are late-bound because Main constructs the shell and telemetry later.
class ConnectionStatusRuntime {
  #effects;
  #state;
  #connectedAt = null;

  constructor(effects) {
    this.#effects = effects;
    this.#state = {
      clientIp: null,
      dnsMode: 'unknown',
      lastError: null, failureCode: null, failureKind: 'none',
      settingsError: null,
      recoveryError: null,
      notice: null,
      browserNotice: null,
      diagnosticNotice: null,
      pacUrl: '',
    };
  }

  get state() { return this.#state; }
  get connectedAt() { return this.#connectedAt; }

  snapshot() {
    return projectConnectionStatus(
      this.#state, this.#effects.connectionState.presentation(), this.#connectedAt,
    );
  }

  emit() {
    this.#state.pacUrl = this.#effects.getPacUrl();
    this.#effects.waitRegistry.observe(this.#effects.connectionState.snapshot());
    // get-state remains the full-refresh authority. Locale and update ride
    // along with status so their changes require no additional event channel.
    this.#effects.getShell()?.send('status', {
      ...this.snapshot(), locale: this.#effects.getLocale(),
      update: this.#effects.getUpdate() || null,
    });
    this.#effects.getShell()?.updateTray();
  }

  clear() {
    this.#connectedAt = null;
    this.#state.clientIp = null;
    this.#state.dnsMode = 'unknown';
    this.#effects.clearCapabilities();
    this.#effects.getTelemetry()?.stop();
  }

  firstConnected(generation, token) {
    this.#connectedAt = this.#effects.now();
    this.#effects.getTelemetry().start(generation, token);
  }

  reportRecovering(generation, token) {
    if (!this.#effects.isEngineCurrent(generation, token)) return;
    this.#state.lastError = this.#effects.translate('error.tunnelRecovering');
    this.emit();
  }

  reportLogFailure() {
    if (!this.#state.diagnosticNotice) {
      this.#state.diagnosticNotice = this.#effects.translate('error.logUnavailable');
      this.emit();
    }
  }

  reportLogRecovered() {
    if (this.#state.diagnosticNotice) {
      this.#state.diagnosticNotice = null;
      this.emit();
    }
  }
}

module.exports = { connectionRecoveryPresentation, projectConnectionStatus, ConnectionStatusRuntime };
