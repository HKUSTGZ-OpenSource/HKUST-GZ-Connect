'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { privatePathStat, privateDescriptorStat } = require('../../../platform/storage/private-file');
const {
  createLegacyFlatSourcePaths,
  validateUserDataRoot,
} = require('../../paths/profile-workspace-layout');
const { LEGACY_SOURCE_IDS } = require('./profile-workspace-migration-journal');
const {
  tightenWindowsFileOwnerOnly,
  verifyWindowsFileOwnerOnly,
} = require('../../../platform/storage/windows-private-file');

const READ_CHUNK_BYTES = 64 * 1024;
const LEGACY_SOURCE_MAX_BYTES = Object.freeze({
  settings: 512 * 1024,
  settingsBackup: 512 * 1024,
  vpnCredential: 64 * 1024,
  routingRules: 512 * 1024,
  externalPac: 1024 * 1024,
  browserPac: 1024 * 1024,
  siteCredentials: 2 * 1024 * 1024,
  certificateTrust: 2 * 1024 * 1024,
  engineOwner: 64 * 1024,
  credentialTransaction: 2 * 1024 * 1024,
  activeContextSwitch: 256 * 1024,
  proxyCredential: 64 * 1024,
  proxyHelperCredential: 1024,
  engineLog: 16 * 1024 * 1024,
  engineLogRotated: 16 * 1024 * 1024,
  engineLogRetention: 64,
});

function absentReceipt() {
  return Object.freeze({ present: false, bytes: 0, sha256: null });
}

function invalidSource(message, cause = null) {
  return cause == null ? new Error(message) : new Error(message, { cause });
}

function sameFileVersion(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function collectPrivateFileReceipt({
  file,
  maxBytes,
  fileSystem = fs,
  platform = process.platform,
  windowsAcl = {
    tighten: tightenWindowsFileOwnerOnly,
    verify: verifyWindowsFileOwnerOnly,
  },
  repairWindowsAcl = false,
  label = 'private file',
} = {}) {
  if (typeof file !== 'string' || !Number.isSafeInteger(maxBytes) || maxBytes < 1 ||
      !fileSystem || typeof fileSystem.lstatSync !== 'function' ||
      !['darwin', 'linux', 'win32'].includes(platform) ||
      (platform === 'win32' && typeof windowsAcl?.verify !== 'function') ||
      (repairWindowsAcl === true && (platform !== 'win32' ||
        typeof windowsAcl?.tighten !== 'function')) ||
      typeof repairWindowsAcl !== 'boolean' ||
      typeof label !== 'string' || !label) {
    throw new TypeError('private receipt dependencies are invalid');
  }
  let before;
  try {
    before = privatePathStat(fileSystem, file);
  } catch (error) {
    if (error?.code === 'ENOENT') return absentReceipt();
    throw invalidSource(`${label} could not be inspected`, error);
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size < 0 || before.size > maxBytes ||
      (Number.isSafeInteger(before.nlink) && before.nlink !== 1) ||
      (platform !== 'win32' && (before.mode & 0o077) !== 0)) {
    throw invalidSource(`${label} is not a bounded owner-only regular file`);
  }
  if (platform === 'win32' && !windowsAcl.verify(file)) {
    if (!repairWindowsAcl || !windowsAcl.tighten(file) || !windowsAcl.verify(file)) {
      throw invalidSource(`${label} Windows ACL is not current-user-only`);
    }
    let tightened;
    try { tightened = privatePathStat(fileSystem, file); }
    catch (error) { throw invalidSource(`${label} changed while tightening its Windows ACL`, error); }
    if (!tightened.isFile() || tightened.isSymbolicLink() ||
        tightened.dev !== before.dev || tightened.ino !== before.ino ||
        tightened.size !== before.size || tightened.mtimeNs !== before.mtimeNs ||
        (Number.isSafeInteger(tightened.nlink) && tightened.nlink !== 1)) {
      throw invalidSource(`${label} changed while tightening its Windows ACL`);
    }
    // ACL updates can legitimately change ctime, so use the post-hardening
    // snapshot as the exact version that the descriptor must open.
    before = tightened;
  }

  const constants = fileSystem.constants || fs.constants;
  let descriptor = null;
  let buffer = null;
  try {
    try {
      descriptor = fileSystem.openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    } catch (error) {
      throw invalidSource(`${label} could not be opened after observed presence`, error);
    }
    const opened = privateDescriptorStat(fileSystem, descriptor);
    if (!opened.isFile() || !sameFileVersion(opened, before) || opened.size > maxBytes ||
        (Number.isSafeInteger(opened.nlink) && opened.nlink !== 1)) {
      throw invalidSource(`${label} changed while opening`);
    }

    const hash = crypto.createHash('sha256');
    buffer = Buffer.alloc(Math.min(READ_CHUNK_BYTES, Math.max(1, opened.size)));
    let offset = 0;
    while (offset < opened.size) {
      const requested = Math.min(buffer.length, opened.size - offset);
      const count = fileSystem.readSync(descriptor, buffer, 0, requested, offset);
      if (!count) throw invalidSource(`${label} read was incomplete`);
      hash.update(buffer.subarray(0, count));
      buffer.fill(0, 0, count);
      offset += count;
    }
    const after = privateDescriptorStat(fileSystem, descriptor);
    if (!after.isFile() || !sameFileVersion(after, opened) ||
        (Number.isSafeInteger(after.nlink) && after.nlink !== 1)) {
      throw invalidSource(`${label} changed while reading`);
    }
    return Object.freeze({
      present: true,
      bytes: opened.size,
      sha256: hash.digest('hex'),
    });
  } finally {
    buffer?.fill(0);
    if (descriptor !== null) {
      try { fileSystem.closeSync(descriptor); } catch {}
    }
  }
}

function collectLegacyFlatSourceReceipts({
  userData,
  fileSystem = fs,
  platform = process.platform,
  windowsAcl = {
    tighten: tightenWindowsFileOwnerOnly,
    verify: verifyWindowsFileOwnerOnly,
  },
  repairWindowsAcl = false,
} = {}) {
  if (!fileSystem || typeof fileSystem.lstatSync !== 'function' ||
      !['darwin', 'linux', 'win32'].includes(platform) ||
      (platform === 'win32' && typeof windowsAcl?.verify !== 'function') ||
      (repairWindowsAcl === true && (platform !== 'win32' ||
        typeof windowsAcl?.tighten !== 'function')) ||
      typeof repairWindowsAcl !== 'boolean') {
    throw new TypeError('legacy receipt dependencies are invalid');
  }
  const root = validateUserDataRoot(userData);
  let rootStat;
  try {
    rootStat = fileSystem.lstatSync(root);
  } catch (error) {
    throw new Error('legacy source root is unavailable', { cause: error });
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('legacy source root is not a trusted directory');
  }
  const sources = createLegacyFlatSourcePaths(root);
  const keys = Object.keys(sources);
  if (keys.length !== LEGACY_SOURCE_IDS.length ||
      LEGACY_SOURCE_IDS.some((id) => !Object.hasOwn(sources, id))) {
    throw new Error('legacy source layout does not match the journal schema');
  }
  return Object.freeze(Object.fromEntries(LEGACY_SOURCE_IDS.map((id) => [
    id,
    collectPrivateFileReceipt({
      file: sources[id],
      maxBytes: LEGACY_SOURCE_MAX_BYTES[id],
      fileSystem,
      platform,
      windowsAcl,
      repairWindowsAcl,
      label: 'legacy source',
    }),
  ])));
}

module.exports = {
  LEGACY_SOURCE_MAX_BYTES,
  collectPrivateFileReceipt,
  collectLegacyFlatSourceReceipts,
};
