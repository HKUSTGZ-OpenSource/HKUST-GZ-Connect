'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { validateProfileId } = require('../profiles/schema/school-profile-schema');

const LOOPBACK_HOST = '127.0.0.1';
const MAX_PROXY_SIDECAR_BYTES = 1024;

function validPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1025 || port > 65535) {
    throw new TypeError('proxy port is invalid');
  }
  return port;
}

function credentialText(credential, callback) {
  if (!credential || typeof credential.withStrings !== 'function') {
    throw new TypeError('stable proxy credential is required');
  }
  return credential.withStrings((username, password) => {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(username) ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(password)) {
      throw new Error('stable proxy credential is invalid');
    }
    return callback(username, password);
  });
}

function sidecarContents(port, credential, profileId = null) {
  const endpoint = `${LOOPBACK_HOST}:${validPort(port)}`;
  return credentialText(
    credential,
    (username, password) => Buffer.from([
      ...(profileId == null ? [] : [validateProfileId(profileId)]),
      endpoint, username, password,
    ].join('\n'), 'utf8'),
  );
}

function existingSidecarMatches(filePath, expected, privateStorageEffects) {
  let existing = null;
  try {
    existing = privateStorageEffects.readPrivateFileBounded(filePath, {
      maxBytes: MAX_PROXY_SIDECAR_BYTES,
    }).data;
    return existing.length === expected.length && crypto.timingSafeEqual(existing, expected);
  } catch {
    return false;
  } finally {
    existing?.fill(0);
  }
}

function ensureProxyCredentialSidecar({
  filePath,
  port,
  credential,
  profileId = null,
  privateStorageEffects,
} = {}) {
  if (typeof filePath !== 'string' || !filePath) {
    throw new TypeError('proxy credential sidecar path is invalid');
  }
  const { fileSystem, platform, windowsAcl } = privateStorageEffects || {};
  if (!fileSystem || typeof fileSystem.unlinkSync !== 'function' ||
      !['darwin', 'linux', 'win32'].includes(platform) ||
      typeof privateStorageEffects.readPrivateFileBounded !== 'function' ||
      typeof privateStorageEffects.atomicWritePrivateFile !== 'function' ||
      typeof privateStorageEffects.ensureOwnerOnly !== 'function' ||
      (platform === 'win32' && (typeof windowsAcl?.protect !== 'function' ||
        typeof windowsAcl?.verify !== 'function'))) {
    throw new TypeError('proxy credential sidecar storage effects are invalid');
  }
  const contents = sidecarContents(port, credential, profileId);
  try {
    if (existingSidecarMatches(filePath, contents, privateStorageEffects)) {
      if (platform === 'win32' &&
          (!windowsAcl?.protect?.(filePath) || !windowsAcl?.verify?.(filePath))) {
        try { fileSystem.unlinkSync(filePath); } catch {}
        throw new Error('could not verify proxy helper credential ACL');
      }
      return { ok: true, changed: false, filePath };
    }
    const writeOptions = platform === 'win32' ? {
      protectTemporary: (temporary) => windowsAcl?.protect?.(temporary) === true,
      verifyCommitted: (committed) => windowsAcl?.verify?.(committed) === true,
      removeCommittedOnFailure: true,
    } : {};
    if (!privateStorageEffects.atomicWritePrivateFile(filePath, contents, writeOptions)) {
      try { fileSystem.unlinkSync(filePath); } catch {}
      throw new Error('could not write proxy helper credential');
    }
    if (platform !== 'win32' && !privateStorageEffects.ensureOwnerOnly(filePath)) {
      try { fileSystem.unlinkSync(filePath); } catch {}
      throw new Error('could not protect proxy helper credential');
    }
    return { ok: true, changed: true, filePath };
  } finally {
    contents.fill(0);
  }
}

function helperExecutableName(platform = process.platform, arch = process.arch) {
  const platformName = platform === 'win32'
    ? 'windows'
    : (platform === 'darwin' ? 'darwin' : 'linux');
  const architecture = arch === 'arm64' ? 'arm64' : 'amd64';
  return `ec-proxy-command-${platformName}-${architecture}${platform === 'win32' ? '.exe' : ''}`;
}

function externalProxyHelperPath({
  isPackaged,
  resourcesPath,
  desktopDir,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const root = isPackaged
    ? path.join(resourcesPath, 'engine')
    : path.join(desktopDir, 'engine');
  return path.join(root, helperExecutableName(platform, arch));
}

function quoteSshArgument(value) {
  const text = String(value);
  if (!text || /[\r\n\0]/.test(text)) throw new TypeError('SSH argument is invalid');
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function buildSshProxyCommand({ helperPath, credentialFile, profileId = null }) {
  const profile = profileId == null
    ? ''
    : ` --profile-id ${quoteSshArgument(validateProfileId(profileId))}`;
  return [
    '# Direct Host blocks only; do not combine with ProxyJump.',
    `ProxyCommand ${quoteSshArgument(helperPath)}${profile} --credential-file ` +
      `${quoteSshArgument(credentialFile)} -- %h %p`,
  ].join('\n');
}

module.exports = {
  LOOPBACK_HOST,
  MAX_PROXY_SIDECAR_BYTES,
  buildSshProxyCommand,
  ensureProxyCredentialSidecar,
  externalProxyHelperPath,
  helperExecutableName,
  quoteSshArgument,
};
