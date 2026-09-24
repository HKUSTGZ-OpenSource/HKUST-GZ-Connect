'use strict';

const util = require('node:util');
const { projectRuntimeSettings } = require('../settings/profile-workspace-settings-bundle');

class ObservedCredentialOwner {
  #owner;
  #observe;
  #destroyed = false;

  constructor(owner, observe) {
    if (!owner || typeof owner.withStrings !== 'function' || typeof owner.destroy !== 'function' ||
        typeof observe !== 'function') {
      throw new TypeError('observed credential owner dependencies are invalid');
    }
    this.#owner = owner;
    this.#observe = observe;
    Object.freeze(this);
  }

  withStrings(callback) {
    if (this.#destroyed) throw new Error('observed credential owner is destroyed');
    return this.#owner.withStrings((username, password) => {
      this.#observe(username);
      return callback(username, password);
    });
  }

  destroy() {
    if (this.#destroyed) return false;
    this.#destroyed = true;
    return this.#owner.destroy();
  }

  toJSON() { return '[redacted connection credential]'; }
  toString() { return '[redacted connection credential]'; }
  [util.inspect.custom]() { return '[redacted connection credential]'; }
}

class DesktopPersistenceRuntime {
  constructor({ preReadySelection, initializeAfterReady, legacy } = {}) {
    if (!preReadySelection || !['legacy-flat', 'profile-workspace'].includes(preReadySelection.mode) ||
        !preReadySelection.paths || typeof initializeAfterReady !== 'function' || !legacy ||
        ['loadSettings', 'saveSettings', 'saveCredential', 'clearCredential',
          'openCredential', 'hasCredential'].some((name) => typeof legacy[name] !== 'function')) {
      throw new TypeError('desktop persistence runtime dependencies are invalid');
    }
    this.preReadySelection = preReadySelection;
    this.initializeRuntime = initializeAfterReady;
    this.legacy = legacy;
    this.runtime = null;
    this.authority = null;
    this.ready = false;
    this.initializing = false;
    this.accountLabel = '';
  }

  get mode() { return this.preReadySelection.mode; }
  get paths() { return this.preReadySelection.paths; }

  initialize() {
    if (this.ready) return Object.freeze({ ready: true, relaunchRequired: false, mode: this.mode });
    if (this.initializing) throw new Error('desktop persistence runtime is already initializing');
    this.initializing = true;
    try {
      const result = this.initializeRuntime();
      if (!result || result.mode !== 'legacy-flat' && result.mode !== 'profile-workspace') {
        throw new Error('desktop persistence initialization returned an invalid mode');
      }
      if (result.mode !== this.mode) {
        return Object.freeze({
          ready: false,
          relaunchRequired: true,
          previousMode: this.mode,
          mode: result.mode,
        });
      }
      if (result.mode === 'profile-workspace' &&
          (!result.settingsStore || !result.credentialStore ||
            typeof result.reloadAuthority !== 'function')) {
        throw new Error('Profile Workspace persistence stores are unavailable');
      }
      this.runtime = result;
      this.authority = result.authority || null;
      if (result.mode === 'profile-workspace' && this.authority.hasCredential) {
        const owner = result.credentialStore.open();
        if (!owner || typeof owner.withUsername !== 'function') {
          owner?.destroy?.();
          throw new Error('Profile Workspace account credential is unavailable');
        }
        try { owner.withUsername((username) => { this.accountLabel = username; }); }
        finally { owner.destroy(); }
      }
      this.ready = true;
      return Object.freeze({ ready: true, relaunchRequired: false, mode: this.mode });
    } finally {
      this.initializing = false;
    }
  }

  loadSettings() {
    this.#requireReady();
    if (this.mode === 'legacy-flat') return this.legacy.loadSettings();
    // Startup and committed mutations own this validated snapshot. Display and
    // locale reads must not reload every document (and launch synchronous
    // Windows ACL checks). Security-sensitive consumers use currentAuthority
    // or the credential store, which still validate the files on disk.
    return projectRuntimeSettings(this.authority, { accountLabel: this.accountLabel });
  }

  saveSettings(settings) {
    this.#requireReady();
    if (this.mode === 'legacy-flat') return this.legacy.saveSettings(settings);
    const saved = this.runtime.settingsStore.save(settings);
    this.authority = saved.authority;
    return projectRuntimeSettings(this.authority, { accountLabel: this.accountLabel });
  }

  saveCredential(password, username) {
    this.#requireReady();
    if (this.mode === 'legacy-flat') return this.legacy.saveCredential(password, username);
    const result = this.runtime.credentialStore.replace({ username, password });
    this.accountLabel = String(username || '');
    this.authority = this.runtime.reloadAuthority();
    return result.changed === true;
  }

  clearCredential() {
    this.#requireReady();
    if (this.mode === 'legacy-flat') return this.legacy.clearCredential();
    const result = this.runtime.credentialStore.clear();
    this.accountLabel = '';
    this.authority = this.runtime.reloadAuthority();
    return result.changed === true || result.hasCredential === false;
  }

  openCredential() {
    this.#requireReady();
    const owner = this.mode === 'legacy-flat'
      ? this.legacy.openCredential()
      : this.runtime.credentialStore.open();
    if (!owner) return null;
    return new ObservedCredentialOwner(owner, (username) => { this.accountLabel = username; });
  }

  hasCredential() {
    this.#requireReady();
    if (this.mode === 'legacy-flat') return this.legacy.hasCredential();
    // This is a display hint; openCredential still validates current storage.
    return this.authority.hasCredential;
  }

  hasAccountIdentity() {
    if (!this.ready) return false;
    if (this.mode === 'legacy-flat') return this.legacy.hasCredential() &&
      Boolean(this.legacy.loadSettings().username);
    return this.hasCredential();
  }

  currentAuthority() {
    this.#requireReady();
    if (this.mode !== 'profile-workspace') return null;
    this.authority = this.runtime.reloadAuthority();
    return this.authority;
  }

  #requireReady() {
    if (!this.ready) throw new Error('desktop persistence runtime is not ready');
  }
}

module.exports = { DesktopPersistenceRuntime, ObservedCredentialOwner };
