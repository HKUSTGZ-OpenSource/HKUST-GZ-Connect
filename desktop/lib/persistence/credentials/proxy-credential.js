'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');

const RANDOM_SECRET_BYTES = 24;
const LOOPBACK_PROXY_HOST = '127.0.0.1';

function randomSecret(randomBytes) {
  const entropy = randomBytes(RANDOM_SECRET_BYTES);
  if (!Buffer.isBuffer(entropy) || entropy.length !== RANDOM_SECRET_BYTES) {
    throw new Error('secure proxy credential generation failed');
  }
  return Buffer.from(entropy.toString('base64url'), 'ascii');
}

function injectedSecret(value) {
  const secret = Buffer.isBuffer(value)
    ? Buffer.from(value)
    : (typeof value === 'string' ? Buffer.from(value, 'ascii') : null);
  if (!secret || secret.length < 16 || secret.length > 128 ||
      !/^[A-Za-z0-9_-]+$/.test(secret.toString('ascii'))) {
    secret?.fill(0);
    throw new Error('secure proxy credential injection failed');
  }
  return secret;
}

function cleanupProxyAccessForEngineClose({
  generation,
  supervisorGenerationCurrent,
  connectionGenerationCurrent,
  clearCredential,
  removeSidecar,
} = {}) {
  if (!Number.isSafeInteger(generation) || generation <= 0 ||
      typeof clearCredential !== 'function' || typeof removeSidecar !== 'function') {
    throw new TypeError('generation-bound proxy cleanup is invalid');
  }
  // The in-memory credential owns one generation, so its destroy operation is
  // safe even for a delayed close. The sidecar is shared by successive
  // generations and must survive every stale close.
  clearCredential(generation);
  if (supervisorGenerationCurrent !== true || connectionGenerationCurrent !== true) {
    return false;
  }
  removeSidecar();
  return true;
}

function removeSidecarProjection(filePath, fileSystem) {
  try {
    fileSystem.unlinkSync(filePath);
    return true;
  } catch (error) {
    return error?.code === 'ENOENT';
  }
}

class EphemeralProxyCredential {
  #username;
  #password;
  #generation = null;
  #port = null;
  #destroyed = false;

  constructor({ randomBytes = crypto.randomBytes, credential = null } = {}) {
    if (typeof randomBytes !== 'function') throw new TypeError('randomBytes is required');
    if (credential !== null) {
      if (!credential || typeof credential !== 'object') {
        throw new TypeError('credential is invalid');
      }
      this.#username = injectedSecret(credential.username);
      try {
        this.#password = injectedSecret(credential.password);
      } catch (error) {
        this.#username.fill(0);
        throw error;
      }
      return;
    }
    this.#username = randomSecret(randomBytes);
    this.#password = randomSecret(randomBytes);
  }

  bindGeneration(generation, port) {
    if (this.#destroyed || !Number.isSafeInteger(generation) || generation <= 0 ||
        !Number.isInteger(Number(port)) || Number(port) < 1025 || Number(port) > 65535 ||
        this.#generation !== null) return false;
    this.#generation = generation;
    this.#port = Number(port);
    return true;
  }

  isForGeneration(generation) {
    return !this.#destroyed && this.#generation === generation;
  }

  stdinSuffix(generation) {
    if (!this.isForGeneration(generation)) throw new Error('proxy credential is unavailable');
    return `${this.#username.toString('ascii')}\n${this.#password.toString('ascii')}\n`;
  }

  socksAuthentication(generation) {
    if (!this.isForGeneration(generation)) return null;
    // These are read-only borrowed views for the short-lived local health
    // handshake. destroy() zeroes the same backing buffers synchronously.
    return { username: this.#username, password: this.#password };
  }

  matchesProxyChallenge(authInfo, generation) {
    return this.isForGeneration(generation) &&
      authInfo?.isProxy === true &&
      String(authInfo.scheme || '').toLowerCase() === 'basic' &&
      authInfo.host === LOOPBACK_PROXY_HOST && Number(authInfo.port) === this.#port;
  }

  answerProxyChallenge(authInfo, generation, callback) {
    if (typeof callback !== 'function' || !this.matchesProxyChallenge(authInfo, generation)) {
      return false;
    }
    callback(this.#username.toString('ascii'), this.#password.toString('ascii'));
    return true;
  }

  destroy(expectedGeneration = null) {
    if (this.#destroyed || (expectedGeneration !== null && this.#generation !== expectedGeneration)) {
      return false;
    }
    this.#username.fill(0);
    this.#password.fill(0);
    this.#generation = null;
    this.#port = null;
    this.#destroyed = true;
    return true;
  }

  toJSON() {
    return { type: 'EphemeralProxyCredential', redacted: true, destroyed: this.#destroyed };
  }

  [util.inspect.custom]() {
    return `EphemeralProxyCredential { <redacted>, destroyed: ${this.#destroyed} }`;
  }
}

// The stable secret, per-Engine copy and helper sidecar are one process-local
// lifecycle. Main injects the existing encrypted store and private-file write
// effect; this owner does not infer Profile or Engine state from global data.
class ProxyAccessCoordinator {
  #store;
  #sidecarFile;
  #fileSystem;
  #writeSidecar;
  #currentProfileId;
  #stable = null;
  #active = null;

  static discardStartupSidecar(filePath, fileSystem = fs) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) ||
        typeof fileSystem?.unlinkSync !== 'function') {
      throw new TypeError('startup proxy projection declaration is invalid');
    }
    // Best-effort startup retirement retains the original behavior. Strict
    // publication still fails closed later if this path cannot be replaced.
    return removeSidecarProjection(filePath, fileSystem);
  }

  constructor({ store, sidecarFile, fileSystem = fs, writeSidecar,
    currentProfileId, createEphemeral = (options) => new EphemeralProxyCredential(options) } = {}) {
    if (typeof store?.loadOrCreate !== 'function' ||
        typeof sidecarFile !== 'string' || !path.isAbsolute(sidecarFile) ||
        typeof fileSystem?.unlinkSync !== 'function' ||
        typeof writeSidecar !== 'function' || typeof currentProfileId !== 'function' ||
        typeof createEphemeral !== 'function') {
      throw new TypeError('proxy access dependencies are incomplete');
    }
    this.#store = store;
    this.#sidecarFile = sidecarFile;
    this.#fileSystem = fileSystem;
    this.#writeSidecar = writeSidecar;
    this.#currentProfileId = currentProfileId;
    this.createEphemeral = createEphemeral;
  }

  hasStable() { return this.#stable !== null; }

  loadStable() {
    if (!this.#stable) this.#stable = this.#store.loadOrCreate();
    return this.#stable;
  }

  removeSidecar() {
    return removeSidecarProjection(this.#sidecarFile, this.#fileSystem);
  }

  ensureSidecar(port) {
    const credential = this.loadStable();
    this.#writeSidecar({ filePath: this.#sidecarFile, port, credential,
      profileId: this.#currentProfileId() });
    return credential;
  }

  generationCredential(port) {
    const injected = this.ensureSidecar(port).copyForEngine();
    try {
      return this.createEphemeral({ credential: injected });
    } finally {
      injected.username.fill(0);
      injected.password.fill(0);
    }
  }

  setActive(value) { this.#active = value; }

  clearActive(expectedGeneration = null) {
    if (!this.#active || !this.#active.destroy(expectedGeneration)) return false;
    this.#active = null;
    return true;
  }

  socksAuthentication(generation) {
    return this.#active?.socksAuthentication(generation) || null;
  }

  matchesProxyChallenge(authInfo, generation) {
    return this.#active?.matchesProxyChallenge(authInfo, generation) === true;
  }

  answerProxyChallenge(authInfo, generation, callback) {
    return this.#active?.answerProxyChallenge(authInfo, generation, callback) === true;
  }

  revoke() {
    this.clearActive();
    const removed = this.removeSidecar();
    this.#stable?.destroy();
    this.#stable = null;
    return removed && this.#active === null;
  }

  disposeForQuit() {
    const removed = this.removeSidecar();
    this.#stable?.destroy();
    this.#stable = null;
    return removed;
  }

  toJSON() { return { type: 'ProxyAccessCoordinator', redacted: true }; }

  [util.inspect.custom]() { return 'ProxyAccessCoordinator { <redacted> }'; }
}

module.exports = {
  EphemeralProxyCredential,
  ProxyAccessCoordinator,
  LOOPBACK_PROXY_HOST,
  RANDOM_SECRET_BYTES,
  cleanupProxyAccessForEngineClose,
};
