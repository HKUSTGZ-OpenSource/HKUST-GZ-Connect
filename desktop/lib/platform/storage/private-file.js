'use strict';

const fs = require('fs');
const {
  tightenWindowsFileOwnerOnly,
  verifyWindowsFileOwnerOnly,
} = require('./windows-private-file');

const MAX_PRIVATE_READ_BYTES = 64 * 1024 * 1024;

function invalidStat() {
  const error = new Error('private file stat is not exact');
  error.privateFileInvalid = true;
  return error;
}
function exactInteger(value) {
  if (typeof value === 'bigint') return value;
  if (Number.isSafeInteger(value)) return BigInt(value);
  throw invalidStat();
}
function boundedStatNumber(value) {
  const number = Number(exactInteger(value));
  if (!Number.isSafeInteger(number) || number < 0) throw invalidStat();
  return number;
}
function statNanos(ns, ms) {
  if (typeof ns === 'bigint') return ns;
  // Compatibility with small injected Stats; native Node supplies exact nanoseconds.
  if (typeof ms !== 'number' || !Number.isFinite(ms) || !Number.isSafeInteger(Math.trunc(ms))) throw invalidStat();
  const whole = Math.trunc(ms);
  return BigInt(whole) * 1_000_000n + BigInt(Math.round((ms - whole) * 1_000_000));
}
function statMilliseconds(ns) {
  return Number(ns / 1_000_000n) + Number(ns % 1_000_000n) / 1_000_000;
}
function privateStatSnapshot(raw) {
  const file = raw.isFile(), symbolicLink = raw.isSymbolicLink?.() === true;
  const mtimeNs = statNanos(raw.mtimeNs, raw.mtimeMs), ctimeNs = statNanos(raw.ctimeNs, raw.ctimeMs);
  return Object.freeze({
    dev: exactInteger(raw.dev), ino: exactInteger(raw.ino), size: boundedStatNumber(raw.size),
    mode: boundedStatNumber(raw.mode), nlink: boundedStatNumber(raw.nlink), mtimeNs, ctimeNs,
    mtimeMs: statMilliseconds(mtimeNs), ctimeMs: statMilliseconds(ctimeNs),
    isFile: () => file, isSymbolicLink: () => symbolicLink,
  });
}
// One syscall per snapshot: identity never round-trips through Number.
const privatePathStat = (fileSystem, file) => privateStatSnapshot(fileSystem.lstatSync(file, { bigint: true }));
const privateDescriptorStat = (fileSystem, descriptor) => privateStatSnapshot(fileSystem.fstatSync(descriptor, { bigint: true }));

function readPrivateFileBounded(file, {
  maxBytes,
  minBytes = 1,
  platform = process.platform,
  fileSystem = fs,
} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_PRIVATE_READ_BYTES ||
      !Number.isSafeInteger(minBytes) || minBytes < 0 || minBytes > maxBytes) {
    throw new TypeError('invalid private-file read bound');
  }
  let descriptor = null;
  try {
    const before = privatePathStat(fileSystem, file);
    if (!before.isFile() || before.isSymbolicLink() || before.size < minBytes ||
        before.size > maxBytes ||
        (platform !== 'win32' && before.nlink !== 1) ||
        (platform !== 'win32' && (before.mode & 0o077) !== 0)) {
      const error = new Error('invalid private file');
      error.privateFileInvalid = true;
      throw error;
    }
    const constants = fileSystem.constants || fs.constants;
    descriptor = fileSystem.openSync(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
    );
    const opened = privateDescriptorStat(fileSystem, descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.size !== before.size || opened.size < minBytes || opened.size > maxBytes ||
        (platform !== 'win32' && opened.nlink !== 1)) {
      const error = new Error('private file changed while opening');
      error.privateFileInvalid = true;
      throw error;
    }
    const data = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < data.length) {
      const count = fileSystem.readSync(
        descriptor,
        data,
        offset,
        data.length - offset,
        offset,
      );
      if (!count) break;
      offset += count;
    }
    if (offset !== data.length) {
      const error = new Error('private file read was incomplete');
      error.code = 'EIO';
      throw error;
    }
    return { data, stat: opened };
  } finally {
    if (descriptor !== null) {
      try { fileSystem.closeSync(descriptor); } catch {}
    }
  }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs;
}

function ensureOwnerOnly(file, {
  fileSystem = fs,
  platform = process.platform,
  windowsAcl = {
    tighten: tightenWindowsFileOwnerOnly,
    verify: verifyWindowsFileOwnerOnly,
  },
} = {}) {
  let descriptor = null;
  try {
    if (!['darwin', 'linux', 'win32'].includes(platform) ||
        (platform === 'win32' && (typeof windowsAcl?.tighten !== 'function' ||
          typeof windowsAcl?.verify !== 'function'))) return false;
    const before = privatePathStat(fileSystem, file);
    if (!before.isFile() || before.isSymbolicLink() ||
        (Number.isSafeInteger(before.nlink) && before.nlink !== 1)) return false;
    const constants = fileSystem.constants || fs.constants;
    const noFollow = constants.O_NOFOLLOW || 0;
    descriptor = fileSystem.openSync(file, constants.O_RDONLY | noFollow);
    const opened = privateDescriptorStat(fileSystem, descriptor);
    // The no-follow descriptor owns the POSIX permission change. On Windows it
    // pins the observed identity while the bounded PowerShell ACL operation
    // acts on the path. The identity comparison catches replacement between
    // lstat/open where O_NOFOLLOW is unavailable.
    if (!opened.isFile() || !sameFileIdentity(opened, before) ||
        (Number.isSafeInteger(opened.nlink) && opened.nlink !== 1)) return false;
    if (platform === 'win32') {
      // Older releases created these files as the current user but could leave
      // inherited Windows access rules in place. Tightening is allowed only
      // after the PowerShell boundary proves the current SID already owns the
      // exact regular path; it never takes ownership of a foreign file.
      if (!windowsAcl.tighten(file) || !windowsAcl.verify(file)) return false;
      const after = privatePathStat(fileSystem, file);
      return after.isFile() && !after.isSymbolicLink() &&
        sameFileIdentity(after, opened) &&
        (!Number.isSafeInteger(after.nlink) || after.nlink === 1);
    }
    fileSystem.fchmodSync(descriptor, 0o600);
    return true;
  } catch {
    return false;
  } finally {
    if (descriptor !== null) {
      try { fileSystem.closeSync(descriptor); } catch {}
    }
  }
}

module.exports = {
  privatePathStat,
  privateDescriptorStat,
  MAX_PRIVATE_READ_BYTES,
  ensureOwnerOnly,
  readPrivateFileBounded,
};
