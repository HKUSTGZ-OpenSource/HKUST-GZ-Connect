'use strict';

const util = require('node:util');
const { projectRuntimeSettings } = require('../settings/profile-workspace-settings-bundle');
const { loadSettings: readSettings, saveSettings: writeSettings } = require('../settings/settings-store');
const { hasStoredPassword, loadPasswordResult: readPasswordResult,
  restorePasswordSnapshot, savePassword: writePassword, VpnCredentialAccessCoordinator } = require('../credentials/credential-store');
const { parseCredentialField } = require('../settings/settings-update');
const { ProxyAccessCoordinator, cleanupProxyAccessForEngineClose } = require('../credentials/proxy-credential');
const { ExternalProxyCredentialStore } = require('../credentials/external-proxy-credential-store');
const {
  recoverCredentialSettingsTransaction,
  runCredentialSettingsMutation,
} = require('../credentials/credential-settings-transaction');
const { LegacyMigrationCredentialOwner } = require('../migration/legacy-hkust/legacy-migration-inputs');

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
  #settingsRecoveryNotice = null;
  #settingsRecoveryNoticeText = null;
  #credentialTransactionRecovery = Object.freeze({ ok: true, status: 'none' });
  #credentialRecoveryNoticeText = null;
  #credentialRecoveryErrorText = null;
  #routingSettingsSnapshot = null;

  static createVpnCredentialAccess(options) {
    return new VpnCredentialAccessCoordinator({ ...options, parseField: parseCredentialField });
  }

  static createProxyAccess({ credentialStore, ...effects } = {}) {
    return new ProxyAccessCoordinator({
      ...effects, store: new ExternalProxyCredentialStore(credentialStore),
    });
  }

  static cleanupProxyAccessForEngineClose(options) {
    return cleanupProxyAccessForEngineClose(options);
  }

  static discardStartupProxySidecar(filePath, fileSystem) {
    return ProxyAccessCoordinator.discardStartupSidecar(filePath, fileSystem);
  }

  static createLegacyAdapter({ settingsFile, credentialFile, safeStorage, platform,
    getDefaultRouteDomains, onRecovery, stores = {} }) {
    const io = { readSettings, writeSettings, readPasswordResult, writePassword,
      restorePasswordSnapshot, hasStoredPassword, ...stores };
    const loadSettings = () => io.readSettings(settingsFile, {
      onRecovery, defaultRouteDomains: getDefaultRouteDomains(),
    });
    return Object.freeze({
      loadSettings,
      saveSettings: settings => io.writeSettings(settingsFile, settings, {
        defaultRouteDomains: getDefaultRouteDomains(),
      }),
      saveCredential: password => io.writePassword(credentialFile, password, safeStorage, platform),
      clearCredential: () => io.restorePasswordSnapshot(credentialFile, { existed: false, data: null }),
      hasCredential: () => io.hasStoredPassword(credentialFile, platform),
      openCredential: () => {
        const settings = loadSettings();
        const result = io.readPasswordResult(credentialFile, safeStorage, platform);
        if (result.status === 'missing') return null;
        if (result.status !== 'decrypted') {
          const error = new Error('legacy credential is unavailable');
          error.credentialStatus = result.status;
          throw error;
        }
        return new LegacyMigrationCredentialOwner(settings.username, result.password);
      },
    });
  }

  constructor({ preReadySelection, initializeAfterReady, legacy, settingsPresentation = null,
    credentialTransactionFileSystem } = {}) {
    if (!preReadySelection || !['legacy-flat', 'profile-workspace'].includes(preReadySelection.mode) ||
        !preReadySelection.paths || typeof initializeAfterReady !== 'function' || !legacy ||
        ['loadSettings', 'saveSettings', 'saveCredential', 'clearCredential',
          'openCredential', 'hasCredential'].some((name) => typeof legacy[name] !== 'function')) {
      throw new TypeError('desktop persistence runtime dependencies are invalid');
    }
    if (settingsPresentation && ['getState', 'translate', 'emit']
      .some(name => typeof settingsPresentation[name] !== 'function')) {
      throw new TypeError('settings presentation effects are invalid');
    }
    this.preReadySelection = preReadySelection;
    this.initializeRuntime = initializeAfterReady;
    this.legacy = legacy;
    this.runtime = null;
    this.authority = null;
    this.ready = false;
    this.initializing = false;
    this.accountLabel = '';
    this.settingsPresentation = settingsPresentation;
    this.settingsReadErrorText = null;
    this.credentialTransactionFileSystem = credentialTransactionFileSystem;
  }

  get mode() { return this.preReadySelection.mode; }
  get paths() { return this.preReadySelection.paths; }

  observeSettingsRecovery(notice) { this.#settingsRecoveryNotice = notice; }
  get settingsRecoveryNotice() { return this.#settingsRecoveryNotice; }
  setSettingsRecoveryNoticeText(text) { this.#settingsRecoveryNoticeText = text; }
  get settingsRecoveryNoticeText() { return this.#settingsRecoveryNoticeText; }

  prepareBeforeOwnerOnlyValidation(validatePrivateFiles) {
    if (typeof validatePrivateFiles !== 'function') {
      throw new TypeError('private-file validation effect is required');
    }
    const recoveryResult = this.mode === 'legacy-flat'
      ? recoverCredentialSettingsTransaction(this.paths.credentialTransaction, {
        settings: this.paths.settings,
        settingsBackup: this.paths.settingsBackup,
        credential: this.paths.vpnCredential,
      }, this.credentialTransactionFileSystem)
      : { ok: true, status: 'none' };
    const recovery = this.#recordCredentialTransactionRecovery(recoveryResult);
    // The old startup sequence always continued through owner-only checks after
    // a blocked recovery; the retained block prevents writes and connection.
    validatePrivateFiles();
    return recovery;
  }

  getCredentialTransactionRecovery() {
    return this.#credentialTransactionRecovery;
  }

  isCredentialTransactionBlocked() { return !this.#credentialRecoverySafe(); }

  applyCredentialRecoveryOutcome(recovery, {
    emitState = true,
    clearedNoticeKey = 'error.credentialRecoveryCleared',
    clearNotice = false,
  } = {}) {
    recovery = this.#recordCredentialTransactionRecovery(recovery);
    const recoverySafe = this.#credentialRecoverySafe(recovery);

    const state = this.settingsPresentation.getState();
    if (this.#credentialRecoveryErrorText && state.recoveryError === this.#credentialRecoveryErrorText) {
      state.recoveryError = null;
    }
    this.#credentialRecoveryErrorText = null;
    if (!recoverySafe) {
      this.#credentialRecoveryNoticeText = null;
      this.#credentialRecoveryErrorText = this.settingsPresentation.translate('error.credentialRecoveryBlocked');
      state.recoveryError = this.#credentialRecoveryErrorText;
    } else if (recovery?.status === 'recovered') {
      this.#credentialRecoveryNoticeText = this.settingsPresentation.translate('error.credentialRecoveryRecovered');
    } else if (recovery?.status === 'credential-cleared') {
      this.#credentialRecoveryNoticeText = this.settingsPresentation.translate(clearedNoticeKey);
    } else if (clearNotice) {
      this.#credentialRecoveryNoticeText = null;
    }
    this.#syncRecoveryNotice(emitState);
    return recovery;
  }

  retryCredentialTransactionRecovery() {
    if (this.mode === 'profile-workspace') {
      return this.applyCredentialRecoveryOutcome({ ok: true, status: 'none' });
    }
    return this.applyCredentialRecoveryOutcome(recoverCredentialSettingsTransaction(
      this.paths.credentialTransaction,
      {
        settings: this.paths.settings,
        settingsBackup: this.paths.settingsBackup,
        credential: this.paths.vpnCredential,
      },
      this.credentialTransactionFileSystem,
    ));
  }

  assertCredentialTransactionAvailable() {
    if (!this.isCredentialTransactionBlocked()) return;
    const recovery = this.retryCredentialTransactionRecovery();
    if (recovery.status === 'blocked') {
      const message = this.settingsPresentation.translate('error.credentialRecoveryBlocked');
      const error = new Error(message);
      error.code = 'CREDENTIAL_RECOVERY_BLOCKED';
      error.userMessage = message;
      throw error;
    }
  }

  runCredentialMutation({ mutate, fileSystem = this.credentialTransactionFileSystem } = {}) {
    if (this.mode === 'legacy-flat') {
      return runCredentialSettingsMutation({
        journalPath: this.paths.credentialTransaction,
        paths: {
          settings: this.paths.settings,
          settingsBackup: this.paths.settingsBackup,
          credential: this.paths.vpnCredential,
        },
        mutate,
        fileSystem,
      });
    }
    try { return { ok: true, value: mutate() }; }
    catch (error) { return { ok: false, phase: 'mutation', error, recovery: { ok: true, status: 'none' } }; }
  }

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

  reportSettingsReadFailure(cause, { emitState = true } = {}) {
    if (cause?.code === 'SETTINGS_READ_FAILED') return cause;
    const message = this.settingsPresentation.translate('error.settingsReadFailed');
    const error = new Error(message, { cause });
    error.code = 'SETTINGS_READ_FAILED'; error.userMessage = message;
    this.settingsReadErrorText = message;
    const state = this.settingsPresentation.getState();
    if (state.settingsError !== message) {
      state.settingsError = message;
      if (emitState) this.settingsPresentation.emit();
    }
    return error;
  }

  loadSettingsOrReport(options) {
    try {
      const settings = this.loadSettings();
      if (this.settingsReadErrorText) {
        const state = this.settingsPresentation.getState();
        const shouldEmit = options?.emitState !== false && state.settingsError === this.settingsReadErrorText;
        if (state.settingsError === this.settingsReadErrorText) state.settingsError = null;
        this.settingsReadErrorText = null;
        if (shouldEmit) this.settingsPresentation.emit();
      }
      return settings;
    } catch (error) { throw this.reportSettingsReadFailure(error, options); }
  }

  saveSettings(settings) {
    this.#requireReady();
    if (this.mode === 'legacy-flat') return this.legacy.saveSettings(settings);
    const saved = this.runtime.settingsStore.save(settings);
    this.authority = saved.authority;
    return projectRuntimeSettings(this.authority, { accountLabel: this.accountLabel });
  }

  routingSettings() {
    if (!this.#routingSettingsSnapshot) {
      this.#routingSettingsSnapshot = this.loadSettingsOrReport();
    }
    return this.#routingSettingsSnapshot;
  }

  saveSettingsWithGuard(settings) {
    this.assertCredentialTransactionAvailable();
    const saved = this.saveSettings(settings);
    this.#routingSettingsSnapshot = saved;
    return saved;
  }

  rememberCloseAction(action, runTransaction) {
    if (typeof runTransaction !== 'function') {
      throw new TypeError('settings transaction runner is required');
    }
    return runTransaction(() => {
      this.assertCredentialTransactionAvailable();
      const previous = this.loadSettingsOrReport();
      const next = { ...previous, closeAction: action };
      return {
        commit: () => this.saveSettingsWithGuard(next),
        rollback: () => this.saveSettingsWithGuard(previous),
      };
    });
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
    if (this.isCredentialTransactionBlocked()) return false;
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

  #syncRecoveryNotice(emitState = true) {
    const additionalNotice = this.settingsPresentation.getAdditionalNotice?.() || null;
    const state = this.settingsPresentation.getState();
    state.notice = [additionalNotice, this.#credentialRecoveryNoticeText]
      .filter(Boolean)
      .join('\n') || null;
    if (emitState) this.settingsPresentation.emit();
  }

  #credentialRecoverySafe(recovery = this.#credentialTransactionRecovery) {
    return recovery?.status === 'credential-cleared' || (
      recovery?.ok === true && ['none', 'recovered', 'committed'].includes(recovery.status)
    );
  }

  #recordCredentialTransactionRecovery(recovery) {
    const record = recovery && typeof recovery === 'object' && !Array.isArray(recovery)
      ? { ...recovery }
      : {};
    this.#credentialTransactionRecovery = Object.freeze(record);
    return this.#credentialTransactionRecovery;
  }

  #requireReady() {
    if (!this.ready) throw new Error('desktop persistence runtime is not ready');
  }
}

module.exports = { DesktopPersistenceRuntime, ObservedCredentialOwner };
