'use strict';

const path = require('node:path');
const {
  validateCustomProfileProvisioningJournal,
} = require('./custom-profile-provisioning-journal');

const MAX_CUSTOM_PROFILE_PROVISIONING_JOURNAL_BYTES = 256 * 1024;

function binding(value) {
  return JSON.stringify({
    schemaVersion: value.schemaVersion,
    type: value.type,
    identity: value.identity,
    profileDocument: value.profileDocument,
    createdAt: value.createdAt,
    fileReceipts: value.fileReceipts,
    indexTransition: value.indexTransition,
  });
}

function sameDocument(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function serialize(value) {
  const normalized = validateCustomProfileProvisioningJournal(value);
  const data = Buffer.from(`${JSON.stringify(normalized)}\n`, 'utf8');
  if (data.length < 2 || data.length > MAX_CUSTOM_PROFILE_PROVISIONING_JOURNAL_BYTES) {
    data.fill(0);
    throw new TypeError('custom Profile provisioning journal exceeds its storage bound');
  }
  return { normalized, data };
}

class CustomProfileProvisioningJournalStore {
  constructor({
    userData,
    profileStorageEffects,
    fileSystem: fileSystemOverride,
    platform: platformOverride,
    windowsAcl: windowsAclOverride,
  } = {}) {
    if (typeof profileStorageEffects?.assertCompatible !== 'function') {
      throw new TypeError('custom Profile provisioning storage effects are required');
    }
    profileStorageEffects.assertCompatible({
      fileSystem: fileSystemOverride,
      platform: platformOverride,
      windowsAcl: windowsAclOverride,
    });
    const fileSystem = profileStorageEffects?.fileSystem;
    const platform = profileStorageEffects?.platform;
    const windowsAcl = profileStorageEffects?.windowsAcl;
    if (typeof userData !== 'string' || !path.isAbsolute(userData) || path.resolve(userData) !== userData ||
        !fileSystem || typeof fileSystem.openSync !== 'function' ||
        !profileStorageEffects ||
        typeof profileStorageEffects.readPrivateFileBounded !== 'function' ||
        typeof profileStorageEffects.atomicWritePrivateFile !== 'function' ||
        !['darwin', 'linux', 'win32'].includes(platform) ||
        (platform === 'win32' && (typeof windowsAcl?.protect !== 'function' ||
          typeof windowsAcl?.verify !== 'function'))) {
      throw new TypeError('custom Profile provisioning store dependencies are invalid');
    }
    this.userData = userData;
    this.profileStorageEffects = profileStorageEffects;
    this.filePath = path.join(userData, 'global', 'custom-profile-provisioning.json');
    this.fileSystem = fileSystem;
    this.platform = platform;
    this.windowsAcl = windowsAcl;
  }

  read() {
    try { this.fileSystem.lstatSync(this.filePath); }
    catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    if (this.platform === 'win32' && !this.windowsAcl.verify(this.filePath)) {
      throw new Error('custom Profile provisioning journal ACL is invalid');
    }
    const { data } = this.profileStorageEffects.readPrivateFileBounded(this.filePath, {
      maxBytes: MAX_CUSTOM_PROFILE_PROVISIONING_JOURNAL_BYTES,
      minBytes: 2,
    });
    try { return validateCustomProfileProvisioningJournal(JSON.parse(data.toString('utf8'))); }
    catch (error) { throw new Error('custom Profile provisioning journal is invalid', { cause: error }); }
    finally { data.fill(0); }
  }

  prepare(value) {
    const { normalized, data } = serialize(value);
    if (normalized.state !== 'prepared') {
      data.fill(0);
      throw new TypeError('custom Profile provisioning journal must start prepared');
    }
    const directory = path.dirname(this.filePath);
    let descriptor = null;
    let created = false;
    try {
      this.profileStorageEffects.ensurePrivateDirectoryChain(this.userData, directory);
      descriptor = this.fileSystem.openSync(this.filePath, 'wx', 0o600);
      created = true;
      this.fileSystem.writeFileSync(descriptor, data);
      this.fileSystem.fsyncSync?.(descriptor);
      this.fileSystem.closeSync(descriptor);
      descriptor = null;
      if (this.platform === 'win32' &&
          (!this.windowsAcl.protect(this.filePath) || !this.windowsAcl.verify(this.filePath))) {
        throw new Error('custom Profile provisioning journal ACL could not be established');
      }
      const durable = this.profileStorageEffects.fsyncPrivateDirectory(directory);
      if (!durable && !sameDocument(this.read(), normalized)) {
        throw new Error('custom Profile provisioning journal prepare is unconfirmed');
      }
      return { prepared: true, durabilityUnconfirmed: !durable };
    } catch (error) {
      if (descriptor !== null) {
        try { this.fileSystem.closeSync(descriptor); } catch {}
      }
      if (created) {
        try { this.fileSystem.unlinkSync(this.filePath); } catch {}
      }
      if (error?.code === 'EEXIST') {
        throw new Error('custom Profile provisioning journal already exists');
      }
      throw new Error('custom Profile provisioning journal prepare failed', { cause: error });
    } finally {
      data.fill(0);
    }
  }

  markMaterialized(value) { return this.#transition(value, 'prepared', 'materialized'); }

  markIndexed(value) { return this.#transition(value, 'materialized', 'indexed'); }

  clearIndexed() {
    const current = this.read();
    if (!current || current.state !== 'indexed') {
      throw new Error('only indexed custom Profile provisioning can be cleared');
    }
    const directory = path.dirname(this.filePath);
    this.fileSystem.unlinkSync(this.filePath);
    if (!this.profileStorageEffects.fsyncPrivateDirectory(directory)) {
      throw new Error('custom Profile provisioning journal clear was not durable');
    }
    return true;
  }

  #transition(value, expectedState, nextState) {
    const current = this.read();
    const { normalized, data } = serialize(value);
    try {
      if (!current || current.state !== expectedState || normalized.state !== nextState ||
          binding(current) !== binding(normalized)) {
        throw new Error('custom Profile provisioning transition binding does not match');
      }
      const options = this.platform === 'win32' ? {
        protectTemporary: (file) => this.windowsAcl.protect(file) === true,
        verifyCommitted: (file) => this.windowsAcl.verify(file) === true,
        removeCommittedOnFailure: true,
      } : {};
      const written = this.profileStorageEffects.atomicWritePrivateFile(this.filePath, data, options);
      const observed = this.read();
      if (!sameDocument(observed, normalized)) {
        throw new Error(`custom Profile provisioning ${nextState} is unconfirmed`);
      }
      return { [nextState]: true, durabilityUnconfirmed: !written };
    } finally {
      data.fill(0);
    }
  }
}

module.exports = {
  CustomProfileProvisioningJournalStore,
  MAX_CUSTOM_PROFILE_PROVISIONING_JOURNAL_BYTES,
};
