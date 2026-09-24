'use strict';

const { allowedKeys, boundedString, enumValue } = require('./ipc-guard');
const {
  ACTIVE_INTEGRATION_ADAPTER_IDS,
  INTEGRATION_ACTIONS,
} = require('../integrations/integration-schema');

const PUBLIC_CODES = new Set([
  'INTEGRATION_ADAPTER_UNAVAILABLE',
  'INTEGRATION_PROFILE_STALE',
  'INTEGRATION_ACCOUNT_STALE',
  'INTEGRATION_LISTENER_UNAVAILABLE',
  'INTEGRATION_AUTH_INCOMPATIBLE',
  'INTEGRATION_CREDENTIAL_UNAVAILABLE',
  'INTEGRATION_POLICY_STALE',
  'INTEGRATION_EXPORT_CANCELLED',
  'INTEGRATION_EXPORT_TARGET_INVALID',
  'INTEGRATION_EXPORT_CONFLICT',
  'INTEGRATION_EXPORT_FAILED',
  'INTEGRATION_TARGET_CHANGED',
  'INTEGRATION_ROLLBACK_INCOMPLETE',
]);

function prepareRequest(value) {
  const source = allowedKeys(value, ['adapterId', 'action']);
  return Object.freeze({
    adapterId: enumValue(source.adapterId, ACTIVE_INTEGRATION_ADAPTER_IDS, '集成类型无效'),
    action: enumValue(source.action, INTEGRATION_ACTIONS, '集成操作无效'),
  });
}

function confirmRequest(value) {
  const source = allowedKeys(value, ['confirmationHandle']);
  return Object.freeze({
    confirmationHandle: boundedString(source.confirmationHandle, {
      minLength: 1, maxLength: 64, trim: true, message: '集成确认无效',
    }),
  });
}

function publicCode(error, fallback) {
  return PUBLIC_CODES.has(error?.code) ? error.code : fallback;
}

function registerIntegrationCenterIpc({ register, runtime } = {}) {
  if (typeof register !== 'function' || !runtime || typeof runtime.list !== 'function' ||
      typeof runtime.prepare !== 'function' || typeof runtime.confirm !== 'function' ||
      typeof runtime.cancel !== 'function') {
    throw new TypeError('Integration Center IPC dependencies are invalid');
  }
  register('list-integrations', () => {
    try { return { ok: true, integrations: runtime.list() }; }
    catch (error) { return { ok: false, code: publicCode(error, 'INTEGRATION_ADAPTER_UNAVAILABLE'), integrations: [] }; }
  });
  register('prepare-integration', async (_event, value) => {
    try { return { ok: true, preview: await runtime.prepare(prepareRequest(value)) }; }
    catch (error) { return { ok: false, code: publicCode(error, 'INTEGRATION_EXPORT_FAILED') }; }
  });
  register('confirm-integration', async (_event, value) => {
    try { return await runtime.confirm(confirmRequest(value)); }
    catch (error) { return { ok: false, code: publicCode(error, 'INTEGRATION_EXPORT_FAILED') }; }
  });
  register('cancel-integration', (_event, value) => {
    try {
      const cancelled = value === undefined
        ? runtime.cancel()
        : runtime.cancel(confirmRequest(value).confirmationHandle);
      return { ok: true, cancelled };
    } catch (error) {
      return { ok: false, code: publicCode(error, 'INTEGRATION_EXPORT_FAILED') };
    }
  });
}

module.exports = {
  confirmIntegrationRequest: confirmRequest,
  integrationPublicCode: publicCode,
  prepareIntegrationRequest: prepareRequest,
  registerIntegrationCenterIpc,
};
