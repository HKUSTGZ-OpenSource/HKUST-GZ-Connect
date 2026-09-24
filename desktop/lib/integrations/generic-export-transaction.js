'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const {
  validateIntegrationBinding,
} = require('./integration-schema');
const {
  GENERIC_EXPORT_ADAPTERS,
  buildGenericExport,
} = require('./generic-export-adapters');
const {
  validateProfileNetworkRules,
} = require('./profile-network-rules');

const EXPORT_CONFIRMATION_TTL_MS = 120_000;
const ACTIONS = Object.freeze(['copy', 'save']);
const PROPAGATED_ERROR_CODES = new Set([
  'INTEGRATION_EXPORT_CONFLICT',
  'INTEGRATION_EXPORT_FAILED',
  'INTEGRATION_ROLLBACK_INCOMPLETE',
  'INTEGRATION_TARGET_CHANGED',
  'INTEGRATION_PROFILE_STALE',
]);

class GenericExportError extends Error {
  constructor(code, cause = null) {
    super(code, cause ? { cause } : undefined);
    this.name = 'GenericExportError';
    this.code = code;
  }
}

function normalizedTarget(value, action) {
  if (action === 'copy' && value == null) return null;
  if (action !== 'save' || typeof value !== 'string' || !value || value.length > 4096 ||
      /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new GenericExportError('INTEGRATION_EXPORT_TARGET_INVALID');
  }
  const windows = /^(?:[a-zA-Z]:[\\/]|\\\\)/u.test(value);
  const flavor = windows ? path.win32 : path.posix;
  if (!flavor.isAbsolute(value) || flavor.normalize(value) !== value ||
      value === flavor.parse(value).root) {
    throw new GenericExportError('INTEGRATION_EXPORT_TARGET_INVALID');
  }
  return value;
}

function handle(randomBytes) {
  let bytes = randomBytes(16);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 16) {
    bytes?.fill?.(0);
    throw new GenericExportError('INTEGRATION_EXPORT_PREPARE_FAILED');
  }
  try { return `export-${bytes.toString('hex')}`; }
  finally { bytes.fill(0); bytes = null; }
}

class GenericExportTransactionOwner {
  #record = null;

  constructor({
    randomBytes = crypto.randomBytes,
    now = Date.now,
    ttlMs = EXPORT_CONFIRMATION_TTL_MS,
    fileTransaction = null,
  } = {}) {
    if (typeof randomBytes !== 'function' || typeof now !== 'function' ||
        !Number.isSafeInteger(ttlMs) || ttlMs < 10_000 || ttlMs > 300_000) {
      throw new TypeError('generic export transaction dependencies are invalid');
    }
    this.randomBytes = randomBytes;
    this.now = now;
    this.ttlMs = ttlMs;
    this.fileTransaction = fileTransaction;
  }

  prepare({
    adapterId,
    action,
    binding: bindingValue,
    networkRules: rulesValue,
    port,
    credential = null,
    helperPath = null,
    credentialFile = null,
    targetFile = null,
  } = {}) {
    if (!GENERIC_EXPORT_ADAPTERS.includes(adapterId) || !ACTIONS.includes(action) ||
        bindingValue?.adapterId !== adapterId ||
        (adapterId === 'vscode_remote_ssh' && action !== 'copy')) {
      throw new GenericExportError('INTEGRATION_ADAPTER_UNAVAILABLE');
    }
    const binding = validateIntegrationBinding(bindingValue);
    const rules = validateProfileNetworkRules(rulesValue);
    if (binding.profileId !== rules.profileId ||
        binding.profileRevision !== rules.profileRevision ||
        binding.profileCredentialBindingRevision !== rules.profileCredentialBindingRevision ||
        binding.networkRulesDigest !== rules.rulesDigest) {
      throw new GenericExportError('INTEGRATION_PROFILE_STALE');
    }
    const target = normalizedTarget(targetFile, action);
    let generated;
    try {
      generated = buildGenericExport({
        adapterId,
        port,
        credential,
        networkRules: rules,
        helperPath,
        credentialFile,
      });
    } catch (cause) {
      throw new GenericExportError('INTEGRATION_EXPORT_PREPARE_FAILED', cause);
    }
    let targetPlan = null;
    if (action === 'save') {
      if (!this.fileTransaction || typeof this.fileTransaction.inspect !== 'function') {
        generated.payload.fill(0);
        throw new GenericExportError('INTEGRATION_EXPORT_PREPARE_FAILED');
      }
      try { targetPlan = this.fileTransaction.inspect(target, generated.payload); }
      catch (cause) {
        generated.payload.fill(0);
        throw new GenericExportError(cause?.code || 'INTEGRATION_EXPORT_CONFLICT', cause);
      }
    }
    let confirmationHandle;
    try { confirmationHandle = handle(this.randomBytes); }
    catch (error) {
      generated.payload.fill(0);
      throw error;
    }
    const expiresAt = this.now() + this.ttlMs;
    const nextRecord = {
      confirmationHandle,
      adapterId,
      action,
      binding,
      payload: generated.payload,
      targetFile: target,
      targetPlan,
      expiresAt,
    };
    const previous = this.#record;
    this.#record = nextRecord;
    previous?.payload?.fill(0);
    return Object.freeze({
      schemaVersion: 1,
      confirmationHandle,
      adapterId,
      action,
      expiresAt,
      targetSelected: target !== null,
      targetChange: targetPlan?.change || null,
      existingBytes: targetPlan?.before?.bytes || 0,
      replacementBytes: generated.payload.length,
      byteLength: generated.payload.length,
      ruleCount: generated.ruleCount,
      containsLocalProxyCredential: generated.containsLocalProxyCredential,
      warningCode: generated.warningCode,
    });
  }

  async execute({ confirmationHandle, currentBinding, perform } = {}) {
    const record = this.#take(confirmationHandle);
    try {
      if (typeof perform !== 'function') {
        throw new GenericExportError('INTEGRATION_EXPORT_FAILED');
      }
      let current;
      try { current = validateIntegrationBinding(currentBinding); }
      catch { throw new GenericExportError('INTEGRATION_PROFILE_STALE'); }
      if (current.bindingDigest !== record.binding.bindingDigest) {
        throw new GenericExportError('INTEGRATION_PROFILE_STALE');
      }
      await perform(Object.freeze({
        adapterId: record.adapterId,
        action: record.action,
        targetFile: record.targetFile,
        targetPlan: record.targetPlan,
        payload: record.payload,
      }));
      return Object.freeze({ ok: true, adapterId: record.adapterId, action: record.action });
    } catch (error) {
      if (error instanceof GenericExportError) throw error;
      if (PROPAGATED_ERROR_CODES.has(error?.code)) {
        throw new GenericExportError(error.code, error);
      }
      throw new GenericExportError('INTEGRATION_EXPORT_FAILED', error);
    } finally {
      record.payload.fill(0);
    }
  }

  cancel(confirmationHandle) {
    if (!this.#record) return false;
    if (confirmationHandle !== undefined && confirmationHandle !== this.#record.confirmationHandle) return false;
    this.#record.payload.fill(0);
    this.#record = null;
    return true;
  }

  snapshot() {
    if (!this.#record) return null;
    if (this.now() >= this.#record.expiresAt) {
      this.cancel();
      return null;
    }
    const {
      payload: _payload, binding: _binding, targetFile, targetPlan: _targetPlan, ...view
    } = this.#record;
    return Object.freeze({ ...view, targetSelected: targetFile !== null });
  }

  #take(value) {
    const record = this.#record;
    this.#record = null;
    if (!record || typeof value !== 'string' || value !== record.confirmationHandle ||
        this.now() >= record.expiresAt) {
      record?.payload?.fill(0);
      throw new GenericExportError('INTEGRATION_EXPORT_STALE');
    }
    return record;
  }
}

module.exports = {
  EXPORT_CONFIRMATION_TTL_MS,
  GenericExportError,
  GenericExportTransactionOwner,
};
