'use strict';

const util = require('node:util');

const PROFILE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

function credentialField(value, maxLength, name) {
  if (typeof value !== 'string' || !value || value.length > maxLength ||
      CONTROL_CHARACTERS.test(value)) {
    throw new TypeError(`one-shot VPN ${name} is invalid`);
  }
  return value;
}

function profileId(value) {
  if (typeof value !== 'string' || !PROFILE_ID.test(value)) {
    throw new TypeError('one-shot VPN Profile identity is invalid');
  }
  return value;
}

function revision(value, { optional = false } = {}) {
  if (optional && value == null) return null;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('one-shot VPN credential revision is invalid');
  }
  return value;
}

class OneShotVpnCredentialOwner {
  #username;
  #password;
  #destroyed = false;
  #used = false;

  constructor(username, password) {
    if (!Buffer.isBuffer(username) || !username.length ||
        !Buffer.isBuffer(password) || !password.length) {
      username?.fill?.(0);
      password?.fill?.(0);
      throw new TypeError('one-shot VPN credential buffers are invalid');
    }
    this.#username = username;
    this.#password = password;
    Object.freeze(this);
  }

  withStrings(callback) {
    if (this.#destroyed || this.#used) {
      throw new Error('one-shot VPN credential owner is unavailable');
    }
    if (typeof callback !== 'function') {
      throw new TypeError('one-shot VPN credential callback is required');
    }
    this.#used = true;
    try {
      const value = callback(
        this.#username.toString('utf8'),
        this.#password.toString('utf8'),
      );
      if (value && typeof value.then === 'function') {
        throw new TypeError('one-shot VPN credential callback must be synchronous');
      }
      return value;
    } finally {
      this.destroy();
    }
  }

  destroy() {
    if (this.#destroyed) return false;
    this.#destroyed = true;
    this.#username.fill(0);
    this.#password.fill(0);
    return true;
  }

  toJSON() { return '[redacted one-shot vpn credential]'; }

  toString() { return '[redacted one-shot vpn credential]'; }

  [util.inspect.custom]() { return '[redacted one-shot vpn credential]'; }
}

class OneShotVpnCredentialBroker {
  #entry = null;
  #nextRevision = 0;

  stage({ profileId: rawProfileId, username: rawUsername, password: rawPassword } = {}) {
    const binding = profileId(rawProfileId);
    const usernameValue = credentialField(rawUsername, 256, 'username');
    const passwordValue = credentialField(rawPassword, 4096, 'password');
    if (this.#nextRevision >= Number.MAX_SAFE_INTEGER) {
      throw new Error('one-shot VPN credential revision is exhausted');
    }
    let username = null;
    let password = null;
    try {
      username = Buffer.from(usernameValue, 'utf8');
      password = Buffer.from(passwordValue, 'utf8');
    } catch (error) {
      username?.fill(0);
      password?.fill(0);
      throw error;
    }
    const next = {
      profileId: binding,
      revision: this.#nextRevision + 1,
      username,
      password,
    };
    this.clear();
    this.#nextRevision = next.revision;
    this.#entry = next;
    return Object.freeze({ ok: true, revision: next.revision, storage: 'memory_only' });
  }

  has({ profileId: rawProfileId } = {}) {
    const binding = profileId(rawProfileId);
    return this.#entry?.profileId === binding;
  }

  open({ profileId: rawProfileId, revision: expectedRevision = null } = {}) {
    const binding = profileId(rawProfileId);
    const expected = revision(expectedRevision, { optional: true });
    const current = this.#entry;
    if (!current) return null;
    if (current.profileId !== binding) {
      this.clear(current.revision);
      return null;
    }
    // A stale lease must never read a newer password staged by a later save
    // request. Each owner receives private buffers and zeroizes them after one
    // synchronous use; the broker retains its process-lifetime copy until an
    // explicit logout, Profile switch, replacement, or application shutdown.
    if (expected !== null && current.revision !== expected) return null;
    return new OneShotVpnCredentialOwner(
      Buffer.from(current.username),
      Buffer.from(current.password),
    );
  }

  take(options = {}) {
    const owner = this.open(options);
    if (!owner) return null;
    const expectedRevision = this.#entry?.revision || null;
    if (!this.clear(expectedRevision)) {
      owner.destroy();
      return null;
    }
    return owner;
  }

  clear(expectedRevision = null) {
    const expected = revision(expectedRevision, { optional: true });
    if (!this.#entry || (expected !== null && this.#entry.revision !== expected)) return false;
    const current = this.#entry;
    this.#entry = null;
    current.username.fill(0);
    current.password.fill(0);
    return true;
  }

  snapshot() {
    return Object.freeze({
      present: this.#entry !== null,
      profileId: this.#entry?.profileId || null,
      revision: this.#entry?.revision || null,
    });
  }

  toJSON() { return '[redacted one-shot vpn credential broker]'; }

  toString() { return '[redacted one-shot vpn credential broker]'; }

  [util.inspect.custom]() { return '[redacted one-shot vpn credential broker]'; }
}

// Preserve valid protected storage precedence. Only its typed unavailable
// outcome may use an explicit, current profile-bound memory entry. Corrupt,
// stale-context and failed-decryption outcomes must still fail closed.
function openVpnCredential({ memoryBroker, profileId, openPersistent } = {}) {
  if (typeof memoryBroker?.open !== 'function' || typeof openPersistent !== 'function') {
    throw new TypeError('VPN credential selection dependencies are incomplete');
  }
  let persistent;
  try { persistent = openPersistent(); }
  catch (error) {
    if (error?.credentialStatus !== 'unavailable') throw error;
    const memory = memoryBroker.open({ profileId });
    if (!memory) throw error;
    return memory;
  }
  return persistent || memoryBroker.open({ profileId });
}

module.exports = {
  openVpnCredential,
  OneShotVpnCredentialBroker,
  OneShotVpnCredentialOwner,
};
