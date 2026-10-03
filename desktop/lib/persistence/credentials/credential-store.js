'use strict';

const fs = require('fs');
const path = require('path');
const util = require('node:util');
const { OneShotVpnCredentialBroker, openVpnCredential } = require('./one-shot-vpn-credential');
const { atomicWritePrivateFile, fsyncDirectory } = require('../../platform/storage/atomic-private-file');
const { readPrivateFileBounded } = require('../../platform/storage/private-file');

const MAX_ENCRYPTED_PASSWORD_BYTES = 64 * 1024;

function protectedStorageAvailable(safeStorage, platform) {
  if (!safeStorage.isEncryptionAvailable()) return false;
  return platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text';
}

function savePassword(file, password, safeStorage, platform, fileSystem = fs) {
  if (!password) return false;
  try {
    if (!protectedStorageAvailable(safeStorage, platform)) return false;
  } catch {
    return false;
  }
  let encrypted;
  try {
    encrypted = safeStorage.encryptString(String(password));
  } catch {
    return false;
  }
  try {
    const encryptedBytes = Buffer.byteLength(encrypted);
    if (!encrypted || !encryptedBytes || encryptedBytes > MAX_ENCRYPTED_PASSWORD_BYTES) return false;
  } catch {
    return false;
  }
  return atomicWritePrivateFile(file, encrypted, fileSystem);
}

function loadPasswordResult(file, safeStorage, platform) {
  try {
    if (!protectedStorageAvailable(safeStorage, platform)) {
      return Object.freeze({ status: 'unavailable', password: '' });
    }
  } catch {
    return Object.freeze({ status: 'unavailable', password: '' });
  }
  let data;
  try {
    ({ data } = readPrivateFileBounded(file, {
      maxBytes: MAX_ENCRYPTED_PASSWORD_BYTES,
      platform,
    }));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return Object.freeze({ status: 'missing', password: '' });
    }
    if (error?.privateFileInvalid === true) {
      return Object.freeze({ status: 'corrupt', password: '' });
    }
    return Object.freeze({ status: 'unavailable', password: '' });
  }
  try {
    const password = safeStorage.decryptString(data);
    if (typeof password !== 'string' || !password.length) {
      return Object.freeze({ status: 'corrupt', password: '' });
    }
    return Object.freeze({ status: 'decrypted', password });
  } catch {
    // Electron does not expose whether decrypt failed because the OS key store
    // was denied/unavailable or because the ciphertext is damaged. Preserve a
    // distinct actionable result instead of misreporting "no password".
    return Object.freeze({ status: 'decrypt_failed', password: '' });
  } finally {
    data.fill(0);
  }
}

function loadPassword(file, safeStorage, platform) {
  const result = loadPasswordResult(file, safeStorage, platform);
  return result.status === 'decrypted' ? result.password : '';
}

function credentialLoadErrorKey(status) {
  return {
    corrupt: 'error.credentialStoreCorrupt',
    decrypt_failed: 'error.credentialDecryptFailed',
    unavailable: 'error.credentialStoreUnavailable',
    recovery_blocked: 'error.credentialStoreUnavailable',
  }[status] || 'error.credentialStoreUnavailable';
}

class VpnCredentialAccessCoordinator {
  #memoryBroker = new OneShotVpnCredentialBroker();

  constructor({ persistence, getProfileId, getEngineActive, safeStorage, platform, parseField } = {}) {
    if (!persistence || ['hasCredential', 'openCredential'].some(name =>
      typeof persistence[name] !== 'function') ||
        [getProfileId, getEngineActive, parseField].some(value => typeof value !== 'function')) {
      throw new TypeError('VPN credential access dependencies are invalid');
    }
    this.persistence = persistence;
    this.getProfileId = getProfileId;
    this.getEngineActive = getEngineActive;
    this.safeStorage = safeStorage;
    this.platform = platform;
    this.parseFieldEffect = parseField;
  }

  hasPersistent() { return this.persistence.hasCredential(); }

  hasOneShot() {
    try { return this.#memoryBroker.has({ profileId: this.getProfileId() }); }
    catch { return false; }
  }

  hasStored() { return this.hasPersistent() || this.hasOneShot(); }

  hasCredentialForCurrentSession() { return this.hasStored() || this.getEngineActive(); }

  loginAccount(readSettings) {
    try {
      if (this.hasCredentialForCurrentSession()) return { ok: false, username: '' };
      return { ok: true, username: readSettings().username };
    } catch { return { ok: false, username: '' }; }
  }

  open(profileId) {
    return openVpnCredential({
      profileId, memoryBroker: this.#memoryBroker,
      openPersistent: () => this.persistence.openCredential(),
    });
  }

  stage(request) { return this.#memoryBroker.stage(request); }

  clear(expectedRevision) { return this.#memoryBroker.clear(expectedRevision); }

  storageAvailable() { return protectedStorageAvailable(this.safeStorage, this.platform); }

  errorKey(status) { return credentialLoadErrorKey(status); }

  parseField(value, label) { return this.parseFieldEffect(value, label); }

  toJSON() { return '[redacted VPN credential access]'; }
  toString() { return '[redacted VPN credential access]'; }
  [util.inspect.custom]() { return '[redacted VPN credential access]'; }
}

function snapshotPasswordFile(file, fileSystem = fs) {
  try {
    const { data } = readPrivateFileBounded(file, {
      maxBytes: MAX_ENCRYPTED_PASSWORD_BYTES,
      fileSystem,
    });
    return { existed: true, data };
  } catch (error) {
    if (error?.code === 'ENOENT') return { existed: false, data: null };
    return null;
  }
}

function restorePasswordSnapshot(file, snapshot, fileSystem = fs) {
  if (!snapshot || typeof snapshot.existed !== 'boolean') return false;
  if (snapshot.existed) {
    if (!Buffer.isBuffer(snapshot.data) || !snapshot.data.length ||
        snapshot.data.length > MAX_ENCRYPTED_PASSWORD_BYTES) return false;
    return atomicWritePrivateFile(file, snapshot.data, fileSystem);
  }
  try {
    fileSystem.unlinkSync(file);
    return fsyncDirectory(path.dirname(file), fileSystem);
  } catch (error) {
    return error?.code === 'ENOENT';
  }
}

function clearPasswordSnapshot(snapshot) {
  if (Buffer.isBuffer(snapshot?.data)) snapshot.data.fill(0);
}

// Status refreshes must not decrypt data: on macOS that may prompt for Keychain
// access. The caller only needs to know whether this app has a private,
// non-empty encrypted password blob. Actual decryption stays in connectOnce.
function hasStoredPassword(filePath, platform = process.platform) {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 ||
        stat.size > MAX_ENCRYPTED_PASSWORD_BYTES ||
        (platform !== 'win32' && stat.nlink !== 1)) return false;
    // Windows applies ACLs instead of POSIX permission bits. On Unix-like
    // platforms reject a blob readable by group or other users.
    return platform === 'win32' || (stat.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

module.exports = {
  VpnCredentialAccessCoordinator,
  MAX_ENCRYPTED_PASSWORD_BYTES,
  atomicWritePrivateFile,
  clearPasswordSnapshot,
  credentialLoadErrorKey,
  hasStoredPassword,
  loadPassword,
  loadPasswordResult,
  protectedStorageAvailable,
  restorePasswordSnapshot,
  savePassword,
  snapshotPasswordFile,
};
