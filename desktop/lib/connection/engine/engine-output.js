'use strict';

const { createT } = require('../../platform/i18n/i18n');

const SAFE_DIAGNOSTIC_TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/u;

function diagnosticToken(value) {
  const token = String(value ?? '');
  return SAFE_DIAGNOSTIC_TOKEN.test(token) ? token : 'unknown';
}

function diagnosticInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function formatConnectionDiagnostic({
  intent,
  generation,
  attempt,
  phase,
  event,
  outcome = null,
  retryCount = 0,
} = {}) {
  return `[connection=${diagnosticInteger(intent)}:${diagnosticInteger(generation)} ` +
    `attempt=${diagnosticInteger(attempt)} retry=${diagnosticInteger(retryCount)} ` +
    `phase=${diagnosticToken(phase)} event=${diagnosticToken(event)} ` +
    `outcome=${diagnosticToken(outcome)} underlay=system_route]\n`;
}

function formatEngineEventDiagnostic(event, context = {}) {
  const outcome = event?.code ?? event?.reason ?? event?.state ?? event?.mode ?? null;
  return formatConnectionDiagnostic({
    intent: context.intent,
    generation: context.generation,
    attempt: context.attemptNumber,
    retryCount: context.attempts,
    phase: context.phase,
    event: event?.type,
    outcome,
  });
}

function classifyEngineOutput(text, socksPort, t = createT('zh')) {
  if (/gateway authentication failed|login failed|invalid username/i.test(text)) {
    return t('engine.authFailed');
  }
  if (/not implemented auth|authentication method is unsupported/i.test(text)) {
    return t('engine.authUnsupported');
  }
  if (/cannot bind the SOCKS5 listener|address already in use|bind:/i.test(text)) {
    return t('engine.portBusy', { port: socksPort });
  }
  if (/modern address reply (?:has an unexpected status|rejected the request)/i.test(text)) {
    return t('error.gatewayRetrying');
  }
  if (/modern (?:address|send|receive) (?:TLS|request|reply):/i.test(text)) {
    return t('engine.channelClosed');
  }
  return null;
}

function engineFailureKind(text) {
  if (
    /gateway authentication failed|login failed|invalid username|not implemented auth|authentication method is unsupported/i
      .test(text)
  ) {
    return 'terminal';
  }
  if (/modern address reply (?:has an unexpected status|rejected the request)/i.test(text)) {
    return 'gateway-transient';
  }
  if (/modern (?:address|send|receive) (?:TLS|request|reply):/i.test(text)) {
    return 'gateway-transient';
  }
  return 'unknown';
}

function classifyEngineCode(code, socksPort, t = createT('zh'), secondaryCode = null) {
  let message;
  switch (code) {
    case 'AUTH_FAILED': message = t('engine.authFailed'); break;
    case 'AUTH_REJECTED': message = t('engine.authRejected'); break;
    case 'AUTH_INDETERMINATE': message = t('engine.authIndeterminate'); break;
    case 'GATEWAY_PRELOGIN_UNAVAILABLE': message = t('engine.gatewayPreloginUnavailable'); break;
    case 'AUTH_PROTOCOL_INVALID': message = t('engine.authProtocolInvalid'); break;
    case 'AUTH_EXPIRED': message = t('engine.authExpired'); break;
    case 'AUTH_LIMIT_EXCEEDED': message = t('engine.authLimitExceeded'); break;
    case 'UNSUPPORTED_AUTHENTICATION': message = t('engine.authUnsupported'); break;
    case 'CREDENTIALS_INVALID': message = t('error.needCredentials'); break;
    case 'INVALID_ARGUMENTS':
    case 'CONFIGURATION_INVALID': message = t('engine.configurationInvalid'); break;
    case 'LOCAL_LISTENER_FAILED': message = t('engine.portBusy', { port: socksPort }); break;
    case 'DATA_PLANE_SETUP_TRANSIENT':
    case 'DATA_PLANE_SETUP_FAILED':
    case 'NETWORK_DISCONNECTED': message = t('engine.channelClosed'); break;
    case 'DATA_PLANE_SHUTDOWN_FAILED': message = t('engine.dataPlaneShutdownFailed'); break;
    case 'LOGOUT_FAILED':
    case 'SHUTDOWN_SIGNAL_FAILED': message = t('error.engineStuck'); break;
    case 'EVENT_OUTPUT_FAILED': message = t('engine.eventOutputFailed'); break;
    default: message = t('error.connectFailed');
  }
  return secondaryCode === 'AUTH_CLEANUP_UNCONFIRMED'
    ? `${message} — ${t('engine.authCleanupUnconfirmed')}`
    : message;
}

function engineFailureKindFromCode(code) {
  if ([
    'AUTH_FAILED',
    'AUTH_REJECTED',
    'AUTH_INDETERMINATE',
    'AUTH_PROTOCOL_INVALID',
    'AUTH_EXPIRED',
    'AUTH_LIMIT_EXCEEDED',
    'UNSUPPORTED_AUTHENTICATION',
    'CREDENTIALS_INVALID',
    'INVALID_ARGUMENTS',
    'CONFIGURATION_INVALID',
    'LOCAL_LISTENER_FAILED',
    'DATA_PLANE_SETUP_FAILED',
    'DATA_PLANE_SHUTDOWN_FAILED',
    'EVENT_OUTPUT_FAILED',
  ]
    .includes(code)) return 'terminal';
  if (['GATEWAY_PRELOGIN_UNAVAILABLE', 'DATA_PLANE_SETUP_TRANSIENT', 'NETWORK_DISCONNECTED'].includes(code)) {
    return 'gateway-transient';
  }
  return 'unknown';
}

function classifyEngineStopReason(reason, socksPort, t = createT('zh')) {
  switch (reason) {
    case 'user_requested': return null;
    case 'local_service_failed': return t('engine.portBusy', { port: socksPort });
    case 'network_unhealthy': return t('engine.channelClosed');
    case 'logout_failed':
    case 'shutdown_failed': return t('error.engineStuck');
    case 'event_output_failed': return t('engine.eventOutputFailed');
    case 'startup_failed': return t('error.connectFailed');
    default: return null;
  }
}

function engineFailureKindFromStopReason(reason) {
  if (['local_service_failed', 'logout_failed', 'shutdown_failed', 'event_output_failed']
    .includes(reason)) return 'terminal';
  if (reason === 'network_unhealthy') return 'gateway-transient';
  return 'unknown';
}

function resolveEngineFailureKind({ code = null, stopReason = null, diagnosticText = '' } = {}) {
  const codeKind = code ? engineFailureKindFromCode(code) : 'unknown';
  if (codeKind !== 'unknown') return codeKind;
  const stopKind = engineFailureKindFromStopReason(stopReason);
  if (stopKind !== 'unknown') return stopKind;
  return engineFailureKind(diagnosticText);
}

module.exports = {
  classifyEngineCode,
  classifyEngineOutput,
  classifyEngineStopReason,
  engineFailureKind,
  engineFailureKindFromCode,
  engineFailureKindFromStopReason,
  formatConnectionDiagnostic,
  formatEngineEventDiagnostic,
  resolveEngineFailureKind,
};
