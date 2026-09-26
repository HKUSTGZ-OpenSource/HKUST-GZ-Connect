'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { validateOpaqueKey, validateProfileId } = require('../schema/school-profile-schema');

const CUSTOM_PROFILE_INDEX_VERSION = 1;
const MAX_CUSTOM_PROFILE_INDEX_BYTES = 256 * 1024;
const MAX_CUSTOM_PROFILES = 15;

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

function entry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      JSON.stringify(Object.keys(value).sort()) !==
        JSON.stringify(['createdAt', 'profileId', 'profileKey'].sort())) {
    throw new TypeError('custom Profile index entry has an invalid schema');
  }
  const profileId = validateProfileId(value.profileId);
  if (!profileId.startsWith('custom-') || !Number.isSafeInteger(value.createdAt) ||
      value.createdAt <= 0) {
    throw new TypeError('custom Profile index entry has an invalid value');
  }
  return Object.freeze({
    profileId,
    profileKey: validateOpaqueKey(value.profileKey, 'custom Profile index profileKey'),
    createdAt: value.createdAt,
  });
}

function document(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(['entries', 'schemaVersion']) ||
      value.schemaVersion !== CUSTOM_PROFILE_INDEX_VERSION || !Array.isArray(value.entries) ||
      value.entries.length > MAX_CUSTOM_PROFILES) {
    throw new TypeError('custom Profile index has an invalid schema');
  }
  const entries = value.entries.map(entry);
  if (new Set(entries.map((value) => value.profileId)).size !== entries.length ||
      new Set(entries.map((value) => value.profileKey)).size !== entries.length) {
    throw new TypeError('custom Profile index contains duplicate authority');
  }
  return Object.freeze({ schemaVersion: CUSTOM_PROFILE_INDEX_VERSION, entries: Object.freeze(entries) });
}

function serialize(value) {
  const data = Buffer.from(`${JSON.stringify(document(value))}\n`, 'utf8');
  if (data.length > MAX_CUSTOM_PROFILE_INDEX_BYTES) {
    data.fill(0);
    throw new TypeError('custom Profile index exceeds its storage bound');
  }
  return data;
}

function append(current, nextEntry) {
  const normalized = document(current);
  const next = entry(nextEntry);
  if (normalized.entries.some((value) => value.profileId === next.profileId ||
      value.profileKey === next.profileKey) || normalized.entries.length >= MAX_CUSTOM_PROFILES) {
    throw new Error('custom Profile index cannot add this Profile');
  }
  return document({
    schemaVersion: CUSTOM_PROFILE_INDEX_VERSION,
    entries: [...normalized.entries, next].sort((left, right) => (
      left.createdAt - right.createdAt || left.profileId.localeCompare(right.profileId)
    )),
  });
}

function withoutProfile(current, profileId) {
  const normalized = document(current);
  const id = validateProfileId(profileId);
  if (!id.startsWith('custom-') || !normalized.entries.some((value) => value.profileId === id)) {
    throw new Error('custom Profile index cannot remove this Profile');
  }
  return document({
    schemaVersion: CUSTOM_PROFILE_INDEX_VERSION,
    entries: normalized.entries.filter((value) => value.profileId !== id),
  });
}

class CustomProfileIndexStore {
  constructor({
    userData,
    profileStorageEffects,
    fileSystem: fileSystemOverride,
    platform: platformOverride,
    windowsAcl: windowsAclOverride,
  } = {}) {
    if (typeof profileStorageEffects?.assertCompatible !== 'function') {
      throw new TypeError('custom Profile index storage effects are required');
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
        typeof profileStorageEffects.atomicWritePrivateFile !== 'function' ||
        typeof profileStorageEffects.readPrivateFileBounded !== 'function' ||
        !['darwin', 'linux', 'win32'].includes(platform) ||
        (platform === 'win32' && (typeof windowsAcl?.protect !== 'function' ||
          typeof windowsAcl?.verify !== 'function'))) {
      throw new TypeError('custom Profile index dependencies are invalid');
    }
    this.userData = userData;
    this.profileStorageEffects = profileStorageEffects;
    this.filePath = path.join(userData, 'global', 'custom-profile-index.json');
    this.fileSystem = fileSystem;
    this.platform = platform;
    this.windowsAcl = windowsAcl;
  }

  read() {
    const current = this.#readCurrent();
    try { return current.document; }
    finally { current.data?.fill(0); }
  }

  planAdd(value) {
    const current = this.#readCurrent();
    let after = null;
    try {
      const indexEntry = entry(value);
      const next = append(current.document, indexEntry);
      after = serialize(next);
      return Object.freeze({
        entry: indexEntry,
        before: receipt(current.data),
        after: receipt(after),
      });
    } finally {
      current.data?.fill(0);
      after?.fill(0);
    }
  }

  applyAdd(value, transition) {
    const indexEntry = entry(value);
    const current = this.#readCurrent();
    let after = null;
    try {
      const observed = receipt(current.data);
      if (sameReceipt(observed, transition.after)) {
        return current.document.entries.some((candidate) => (
          candidate.profileId === indexEntry.profileId && candidate.profileKey === indexEntry.profileKey
        ));
      }
      if (!sameReceipt(observed, transition.before)) {
        throw new Error('custom Profile index changed during provisioning');
      }
      after = serialize(append(current.document, indexEntry));
      if (!sameReceipt(receipt(after), transition.after)) {
        throw new Error('custom Profile index transition drifted');
      }
      this.profileStorageEffects.ensurePrivateDirectoryChain(this.userData, path.dirname(this.filePath));
      const options = this.platform === 'win32' ? {
        protectTemporary: (file) => this.windowsAcl.protect(file) === true,
        verifyCommitted: (file) => this.windowsAcl.verify(file) === true,
        removeCommittedOnFailure: true,
      } : {};
      if (!this.profileStorageEffects.atomicWritePrivateFile(this.filePath, after, options)) {
        throw new Error('custom Profile index write failed');
      }
      const verified = this.#readCurrent();
      try { return sameReceipt(receipt(verified.data), transition.after); }
      finally { verified.data?.fill(0); }
    } finally {
      current.data?.fill(0);
      after?.fill(0);
    }
  }

  planRemove(profileId) {
    const current = this.#readCurrent();
    let after = null;
    try {
      const next = withoutProfile(current.document, profileId);
      after = serialize(next);
      return Object.freeze({
        profileId: validateProfileId(profileId),
        before: receipt(current.data),
        after: receipt(after),
      });
    } finally {
      current.data?.fill(0);
      after?.fill(0);
    }
  }

  applyRemove(profileId, transition) {
    const id = validateProfileId(profileId);
    const current = this.#readCurrent();
    let after = null;
    try {
      const observed = receipt(current.data);
      if (sameReceipt(observed, transition.after)) {
        return !current.document.entries.some((candidate) => candidate.profileId === id);
      }
      if (!sameReceipt(observed, transition.before)) {
        throw new Error('custom Profile index changed during deletion');
      }
      after = serialize(withoutProfile(current.document, id));
      if (!sameReceipt(receipt(after), transition.after)) {
        throw new Error('custom Profile index deletion transition drifted');
      }
      this.profileStorageEffects.ensurePrivateDirectoryChain(this.userData, path.dirname(this.filePath));
      const options = this.platform === 'win32' ? {
        protectTemporary: (file) => this.windowsAcl.protect(file) === true,
        verifyCommitted: (file) => this.windowsAcl.verify(file) === true,
        removeCommittedOnFailure: true,
      } : {};
      if (!this.profileStorageEffects.atomicWritePrivateFile(this.filePath, after, options)) {
        throw new Error('custom Profile index deletion write failed');
      }
      const verified = this.#readCurrent();
      try { return sameReceipt(receipt(verified.data), transition.after); }
      finally { verified.data?.fill(0); }
    } finally {
      current.data?.fill(0);
      after?.fill(0);
    }
  }

  receipt() {
    const current = this.#readCurrent();
    try { return receipt(current.data); }
    finally { current.data?.fill(0); }
  }

  #readCurrent() {
    try { this.fileSystem.lstatSync(this.filePath); }
    catch (error) {
      if (error?.code === 'ENOENT') {
        return { data: null, document: document({ schemaVersion: 1, entries: [] }) };
      }
      throw error;
    }
    if (this.platform === 'win32' && !this.windowsAcl.verify(this.filePath)) {
      throw new Error('custom Profile index ACL is invalid');
    }
    const { data } = this.profileStorageEffects.readPrivateFileBounded(this.filePath, {
      maxBytes: MAX_CUSTOM_PROFILE_INDEX_BYTES,
      minBytes: 2,
    });
    try {
      return { data, document: document(JSON.parse(data.toString('utf8'))) };
    } catch (error) {
      data.fill(0);
      throw new Error('custom Profile index is invalid', { cause: error });
    }
  }
}

module.exports = {
  CUSTOM_PROFILE_INDEX_VERSION,
  CustomProfileIndexStore,
  MAX_CUSTOM_PROFILES,
  customProfileIndexReceipt: receipt,
  sameCustomProfileIndexReceipt: sameReceipt,
  validateCustomProfileIndexDocument: document,
};
