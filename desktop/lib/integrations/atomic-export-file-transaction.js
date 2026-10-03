'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { normalizedIntegrationTargetFile } = require('./integration-schema');

const MAX_EXPORT_BYTES = 1024 * 1024;

class AtomicExportFileError extends Error {
  constructor(code, cause = null) {
    super(code, cause ? { cause } : undefined);
    this.name = 'AtomicExportFileError';
    this.code = code;
  }
}

function receipt(data) {
  if (data === null) return Object.freeze({ present: false, bytes: 0, sha256: null });
  return Object.freeze({
    present: true,
    bytes: data.length,
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
  });
}

function sameReceipt(left, right) {
  return Boolean(left && right && left.present === right.present && left.bytes === right.bytes &&
    left.sha256 === right.sha256);
}

function readTarget(file, { fileSystem = fs, platform = process.platform } = {}) {
  let descriptor = null;
  try {
    let before;
    try { before = fileSystem.lstatSync(file); }
    catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_EXPORT_BYTES ||
        (platform !== 'win32' && before.nlink !== 1)) {
      throw new AtomicExportFileError('INTEGRATION_EXPORT_CONFLICT');
    }
    const constants = fileSystem.constants || fs.constants;
    descriptor = fileSystem.openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = fileSystem.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.size !== before.size || opened.size > MAX_EXPORT_BYTES ||
        (platform !== 'win32' && opened.nlink !== 1)) {
      throw new AtomicExportFileError('INTEGRATION_TARGET_CHANGED');
    }
    const data = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < data.length) {
      const count = fileSystem.readSync(descriptor, data, offset, data.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    if (offset !== data.length) {
      data.fill(0);
      throw new AtomicExportFileError('INTEGRATION_TARGET_CHANGED');
    }
    return data;
  } catch (error) {
    if (error instanceof AtomicExportFileError) throw error;
    throw new AtomicExportFileError('INTEGRATION_EXPORT_CONFLICT', error);
  } finally {
    if (descriptor !== null) try { fileSystem.closeSync(descriptor); } catch {}
  }
}

class AtomicExportFileTransaction {
  constructor({
    privateStorageEffects,
  } = {}) {
    const { fileSystem, platform, windowsAcl } = privateStorageEffects || {};
    if (!fileSystem || typeof fileSystem.openSync !== 'function' ||
        typeof privateStorageEffects.atomicWritePrivateFile !== 'function' ||
        !['darwin', 'linux', 'win32'].includes(platform) ||
        (platform === 'win32' && (typeof windowsAcl?.protect !== 'function' ||
          typeof windowsAcl?.verify !== 'function'))) {
      throw new TypeError('atomic export transaction dependencies are invalid');
    }
    Object.assign(this, { fileSystem, platform, windowsAcl, privateStorageEffects });
  }

  inspect(targetFileValue, payload) {
    const targetFile = normalizedIntegrationTargetFile(targetFileValue);
    if (!Buffer.isBuffer(payload) || !payload.length || payload.length > MAX_EXPORT_BYTES) {
      throw new TypeError('atomic export payload is invalid');
    }
    const parent = this.fileSystem.lstatSync(path.dirname(targetFile));
    if (!parent.isDirectory() || parent.isSymbolicLink()) {
      throw new AtomicExportFileError('INTEGRATION_EXPORT_CONFLICT');
    }
    let before = null;
    try {
      before = readTarget(targetFile, { fileSystem: this.fileSystem, platform: this.platform });
      const beforeReceipt = receipt(before);
      const afterReceipt = receipt(payload);
      return Object.freeze({
        targetFile,
        before: beforeReceipt,
        after: afterReceipt,
        change: sameReceipt(beforeReceipt, afterReceipt)
          ? 'unchanged' : beforeReceipt.present ? 'replace' : 'create',
      });
    } finally { before?.fill(0); }
  }

  apply(plan, payload, validatePayload = () => true) {
    if (!plan || typeof plan !== 'object' || !Buffer.isBuffer(payload) ||
        !sameReceipt(receipt(payload), plan.after) || typeof validatePayload !== 'function') {
      throw new TypeError('atomic export apply plan is invalid');
    }
    const targetFile = normalizedIntegrationTargetFile(plan.targetFile);
    let before = null;
    try {
      before = readTarget(targetFile, { fileSystem: this.fileSystem, platform: this.platform });
      if (!sameReceipt(receipt(before), plan.before)) {
        throw new AtomicExportFileError('INTEGRATION_TARGET_CHANGED');
      }
      if (plan.change === 'unchanged') return Object.freeze({ changed: false, receipt: plan.after });
      if (validatePayload(payload) !== true || !this.#write(targetFile, payload)) {
        throw new AtomicExportFileError('INTEGRATION_EXPORT_FAILED');
      }
      let verified = null;
      try {
        verified = readTarget(targetFile, { fileSystem: this.fileSystem, platform: this.platform });
        if (!sameReceipt(receipt(verified), plan.after) || validatePayload(verified) !== true) {
          throw new AtomicExportFileError('INTEGRATION_EXPORT_FAILED');
        }
      } catch (error) {
        if (!this.#restore(targetFile, before, plan.before)) {
          throw new AtomicExportFileError('INTEGRATION_ROLLBACK_INCOMPLETE', error);
        }
        throw error;
      } finally { verified?.fill(0); }
      return Object.freeze({ changed: true, receipt: plan.after });
    } finally { before?.fill(0); }
  }

  #write(file, data) {
    const options = this.platform === 'win32' ? {
      protectTemporary: (target) => this.windowsAcl.protect(target) === true,
      verifyCommitted: (target) => this.windowsAcl.verify(target) === true,
      removeCommittedOnFailure: true,
    } : {};
    return this.privateStorageEffects.atomicWritePrivateFile(file, data, options);
  }

  #restore(file, before, expected) {
    try {
      if (before === null) {
        try { this.fileSystem.unlinkSync(file); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      } else if (!this.#write(file, before)) return false;
      const restored = readTarget(file, { fileSystem: this.fileSystem, platform: this.platform });
      try { return sameReceipt(receipt(restored), expected); }
      finally { restored?.fill(0); }
    } catch { return false; }
  }
}

module.exports = {
  AtomicExportFileError,
  AtomicExportFileTransaction,
  MAX_EXPORT_BYTES,
  atomicExportReceipt: receipt,
  readAtomicExportTarget: readTarget,
};
