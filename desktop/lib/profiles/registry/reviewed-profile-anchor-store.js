'use strict';

const path = require('node:path');
const {
  validateOpaqueKey,
  validateProfileId,
} = require('../schema/school-profile-schema');

const REVIEWED_PROFILE_ANCHOR_VERSION = 1;
const MAX_REVIEWED_PROFILE_ANCHORS = 16;
const MAX_REVIEWED_PROFILE_ANCHOR_BYTES = 256 * 1024;

function plainObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${name} must be a plain object`);
  }
  return value;
}

function exactKeys(value, keys, name) {
  const source = plainObject(value, name);
  const actual = Object.keys(source).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${name} has an invalid schema`);
  }
  return source;
}

function anchor(value) {
  const source = exactKeys(value, [
    'profileId', 'profileKey', 'accountKey', 'createdAt',
  ], 'reviewed Profile anchor');
  if (!Number.isSafeInteger(source.createdAt) || source.createdAt <= 0) {
    throw new TypeError('reviewed Profile anchor timestamp is invalid');
  }
  const result = Object.freeze({
    profileId: validateProfileId(source.profileId),
    profileKey: validateOpaqueKey(source.profileKey, 'reviewed Profile profileKey'),
    accountKey: validateOpaqueKey(source.accountKey, 'reviewed Profile accountKey'),
    createdAt: source.createdAt,
  });
  if (result.profileKey === result.accountKey) {
    throw new TypeError('reviewed Profile anchor keys must be distinct');
  }
  return result;
}

function document(value) {
  const source = exactKeys(value, ['schemaVersion', 'entries'], 'reviewed Profile anchors');
  if (source.schemaVersion !== REVIEWED_PROFILE_ANCHOR_VERSION || !Array.isArray(source.entries) ||
      source.entries.length > MAX_REVIEWED_PROFILE_ANCHORS) {
    throw new TypeError('reviewed Profile anchors have an invalid version or count');
  }
  const entries = source.entries.map(anchor);
  if (new Set(entries.map((value) => value.profileId)).size !== entries.length ||
      new Set(entries.map((value) => value.profileKey)).size !== entries.length ||
      new Set(entries.map((value) => value.accountKey)).size !== entries.length) {
    throw new TypeError('reviewed Profile anchors contain duplicate authority');
  }
  return Object.freeze({ schemaVersion: REVIEWED_PROFILE_ANCHOR_VERSION, entries: Object.freeze(entries) });
}

function serialize(value) {
  const data = Buffer.from(`${JSON.stringify(document(value))}\n`, 'utf8');
  if (data.length < 2 || data.length > MAX_REVIEWED_PROFILE_ANCHOR_BYTES) {
    data.fill(0);
    throw new TypeError('reviewed Profile anchors exceed their storage bound');
  }
  return data;
}

class ReviewedProfileAnchorStore {
  constructor({
    userData,
    profileStorageEffects,
    fileSystem: fileSystemOverride,
    platform: platformOverride,
    windowsAcl: windowsAclOverride,
  } = {}) {
    if (typeof profileStorageEffects?.assertCompatible !== 'function') {
      throw new TypeError('reviewed Profile anchor storage effects are required');
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
      throw new TypeError('reviewed Profile anchor store dependencies are invalid');
    }
    this.userData = userData;
    this.profileStorageEffects = profileStorageEffects;
    this.filePath = path.join(userData, 'global', 'reviewed-profile-anchors.json');
    this.fileSystem = fileSystem;
    this.platform = platform;
    this.windowsAcl = windowsAcl;
  }

  read() {
    try { this.fileSystem.lstatSync(this.filePath); }
    catch (error) {
      if (error?.code === 'ENOENT') {
        return document({ schemaVersion: REVIEWED_PROFILE_ANCHOR_VERSION, entries: [] });
      }
      throw error;
    }
    if (this.platform === 'win32' && !this.windowsAcl.verify(this.filePath)) {
      throw new Error('reviewed Profile anchor ACL is invalid');
    }
    const { data } = this.profileStorageEffects.readPrivateFileBounded(this.filePath, {
      maxBytes: MAX_REVIEWED_PROFILE_ANCHOR_BYTES,
      minBytes: 2,
    });
    try { return document(JSON.parse(data.toString('utf8'))); }
    catch (error) { throw new Error('reviewed Profile anchors are invalid', { cause: error }); }
    finally { data.fill(0); }
  }

  ensure(value) {
    const next = anchor(value);
    const current = this.read();
    const existing = current.entries.find((entry) => entry.profileId === next.profileId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(next)) {
        throw new Error('reviewed Profile anchor identity changed');
      }
      return false;
    }
    if (current.entries.some((entry) => entry.profileKey === next.profileKey ||
        entry.accountKey === next.accountKey) || current.entries.length >= MAX_REVIEWED_PROFILE_ANCHORS) {
      throw new Error('reviewed Profile anchor authority is already owned');
    }
    const updated = document({
      schemaVersion: REVIEWED_PROFILE_ANCHOR_VERSION,
      entries: [...current.entries, next].sort((left, right) => (
        left.createdAt - right.createdAt || left.profileId.localeCompare(right.profileId)
      )),
    });
    const data = serialize(updated);
    try {
      this.profileStorageEffects.ensurePrivateDirectoryChain(this.userData, path.dirname(this.filePath));
      const options = this.platform === 'win32' ? {
        protectTemporary: (file) => this.windowsAcl.protect(file) === true,
        verifyCommitted: (file) => this.windowsAcl.verify(file) === true,
        removeCommittedOnFailure: true,
      } : {};
      const written = this.profileStorageEffects.atomicWritePrivateFile(this.filePath, data, options);
      const observed = this.read();
      if (JSON.stringify(observed) !== JSON.stringify(updated)) {
        throw new Error('reviewed Profile anchor commit was not confirmed');
      }
      if (!written) {
        const result = new Error('reviewed Profile anchor durability is unconfirmed');
        result.commitApplied = true;
        throw result;
      }
      return true;
    } finally {
      data.fill(0);
    }
  }

  get(profileId) {
    const id = validateProfileId(profileId);
    return this.read().entries.find((entry) => entry.profileId === id) || null;
  }
}

module.exports = {
  MAX_REVIEWED_PROFILE_ANCHORS,
  REVIEWED_PROFILE_ANCHOR_VERSION,
  ReviewedProfileAnchorStore,
  validateReviewedProfileAnchorDocument: document,
};
