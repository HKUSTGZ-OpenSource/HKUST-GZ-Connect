'use strict';

const { CustomProfileProvisioningRuntime } = require('../../profiles/provisioning/custom-profile-provisioning-runtime');
const { ProfileCandidateDirectory } = require('../../profiles/registry/profile-candidate-directory');
const { SchoolProfileRegistry } = require('../../profiles/registry/school-profile-registry');
const { validateSchoolProfileDocument } = require('../../profiles/schema/school-profile-schema');

function customGatewayProductAvailability({ environment = process.env } = {}) {
  return environment?.HKUSTGZ_DISABLE_CUSTOM_GATEWAY !== '1';
}

class MultiSchoolStartupRuntime {
  constructor({
    userData,
    packageRoot,
    isPackaged,
    resourcesPath,
    desktopDir,
    profileStorageEffects,
    ProvisioningRuntimeClass = CustomProfileProvisioningRuntime,
    CandidateDirectoryClass = ProfileCandidateDirectory,
    PackagedRegistryClass = SchoolProfileRegistry,
  } = {}) {
    if (typeof ProvisioningRuntimeClass !== 'function' ||
        typeof CandidateDirectoryClass !== 'function' ||
        typeof PackagedRegistryClass !== 'function') {
      throw new TypeError('multi-school startup runtime dependencies are invalid');
    }
    this.options = {
      userData, packageRoot, isPackaged, resourcesPath, desktopDir, profileStorageEffects,
    };
    this.ProvisioningRuntimeClass = ProvisioningRuntimeClass;
    this.CandidateDirectoryClass = CandidateDirectoryClass;
    this.PackagedRegistryClass = PackagedRegistryClass;
    this.state = null;
    this.directory = null;
    this.packagedRegistry = null;
  }

  initialize({ mode, authority, withProfileDocument } = {}) {
    if (this.state) return this.state;
    if (mode === 'legacy-flat') {
      // A fresh install has no Profile Workspace anchor yet, but the reviewed
      // packaged school is still a valid read-only candidate for onboarding.
      // Listing it independently prevents the selector from degrading to only
      // "Other school" before the first successful persistence migration.
      const profileCount = this.#packagedRegistry().listViews({
        locale: 'en', compatibility: 'reviewed',
      }).length;
      this.state = Object.freeze({
        ready: true,
        mode,
        provisioningStatus: 'not_applicable',
        profileCount,
      });
      return this.state;
    }
    if (mode !== 'profile-workspace' || !authority ||
        typeof withProfileDocument !== 'function') {
      throw new TypeError('multi-school startup authority is invalid');
    }
    const provisioning = new this.ProvisioningRuntimeClass({
      userData: this.options.userData,
      profileStorageEffects: this.options.profileStorageEffects,
    }).recover();
    let sourceDocument = null;
    const access = withProfileDocument((value) => { sourceDocument = value; });
    if (access && typeof access.then === 'function' || !sourceDocument) {
      throw new TypeError('active reviewed Profile access must be synchronous');
    }
    const profile = validateSchoolProfileDocument(sourceDocument);
    if (authority.profile?.profileId !== profile.profileId ||
        authority.profile?.profileRevision !== profile.profileRevision) {
      throw new Error('startup Profile does not match persistence authority');
    }
    const directory = new this.CandidateDirectoryClass(this.options);
    if (profile.evidenceClass === 'builtin-reviewed') {
      directory.anchorReviewedCurrent({
        profileId: profile.profileId,
        profileKey: authority.globalSettings.activeProfileKey,
        accountKey: authority.globalSettings.activeAccountKey,
      });
    } else {
      let matched = false;
      directory.withCandidate(profile.profileId, (record) => {
        matched = record.context.profileKey === authority.layout.identity.profileKey &&
          record.context.accountKey === authority.account.accountKey &&
          record.context.workspaceKey === authority.account.workspaceKey &&
          record.context.activeContextEpoch === authority.workspaceState.activeContextEpoch;
      });
      if (!matched) throw new Error('startup custom Profile candidate does not match authority');
    }
    this.directory = directory;
    this.state = Object.freeze({
      ready: true,
      mode,
      provisioningStatus: provisioning.status,
      profileCount: directory.listViews({ locale: 'en' }).length,
    });
    return this.state;
  }

  listViews(options) {
    if (this.directory) return this.directory.listViews(options);
    if (!this.packagedRegistry) return Object.freeze([]);
    return this.packagedRegistry.listViews({ ...options, compatibility: 'reviewed' });
  }

  withDirectory(callback) {
    if (!this.directory || typeof callback !== 'function') {
      throw new Error('multi-school candidate directory is unavailable');
    }
    return callback(this.directory);
  }

  #packagedRegistry() {
    if (!this.packagedRegistry) {
      this.packagedRegistry = new this.PackagedRegistryClass({
        packageRoot: this.options.packageRoot,
      }).load();
    }
    return this.packagedRegistry;
  }
}

// The ready sequence composes the existing domain owners. It does not implement
// migration, deletion, connection, persistence or shell policies a second time.
class DesktopStartupRuntime {
  constructor(effects = {}) {
    for (const name of ['assertSwitchStartupClear', 'relaunchPersistence',
      'initializeMultiSchoolStartup', 'initializeLogWriter', 'getLogWriter', 'writeMarkers',
      'currentLocale', 'fallbackLocale', 'setLocale', 'loadSettings', 'reportSettingsReadFailure',
      'getSettingsRecoveryNotice', 'setSettingsRecoveryNoticeText', 'getPresentation', 'translate',
      'refreshPacFile', 'onActivate']) {
      if (typeof effects[name] !== 'function') throw new TypeError('startup effects are incomplete');
    }
    for (const [name, methods] of [
      ['profileSwitching', ['recoverBeforeServices']],
      ['persistenceRuntime', ['initialize', 'getCredentialTransactionRecovery', 'applyCredentialRecoveryOutcome']],
      ['customProfileDeletion', ['recover']],
      ['desktopShell', ['installApplicationMenu', 'createTray', 'createWindow', 'showWindow']],
      ['powerMonitor', ['on']], ['connectivityRecovery', ['suspend', 'resume']],
      ['networkStartupCoordinator', ['start']], ['updateNotifications', ['startAutomatic']],
    ]) {
      if (methods.some(method => typeof effects[name]?.[method] !== 'function')) {
        throw new TypeError('startup owners are incomplete');
      }
    }
    this.effects = Object.freeze({ ...effects });
    this.flight = null;
  }

  run() {
    // The flight is installed before injected effects can reenter startup. An
    // application startup failure remains terminal; Main owns its error/exit UI.
    if (!this.flight) this.flight = Promise.resolve().then(() => this.#initialize());
    return this.flight;
  }

  async #initialize() {
    const e = this.effects;
    if (!e.profileSwitching.runtime) e.assertSwitchStartupClear();
    const switchRecovery = await e.profileSwitching.recoverBeforeServices();
    if (switchRecovery?.relaunching) return;
    const persistence = e.persistenceRuntime.initialize();
    if (persistence.relaunchRequired) { e.relaunchPersistence(); return; }
    e.initializeMultiSchoolStartup();
    e.customProfileDeletion.recover().then(result => {
      if (!result.ok) e.getLogWriter()?.append('[profile-deletion] recovery incomplete\n');
    });
    e.initializeLogWriter();
    e.writeMarkers();
    let locale;
    try { locale = e.currentLocale(); }
    catch { locale = e.fallbackLocale(); }
    e.setLocale(locale);
    try { e.loadSettings(); }
    catch (error) { e.reportSettingsReadFailure(error, { emitState: false }); }
    const notice = e.getSettingsRecoveryNotice();
    if (notice) {
      e.setSettingsRecoveryNoticeText(e.translate(notice.kind === 'restored'
        ? 'error.settingsRestored' : 'error.settingsDefaults'));
    }
    e.persistenceRuntime.applyCredentialRecoveryOutcome(
      e.persistenceRuntime.getCredentialTransactionRecovery(), { emitState: false },
    );
    e.desktopShell.installApplicationMenu();
    // A PAC failure must not remove the ordinary UI or conceal an earlier
    // recovery/settings failure. The original domain notices stay separate.
    try { e.refreshPacFile(); }
    catch (error) {
      const pacError = error.userMessage || e.translate('error.pacWriteAtBoot', { message: error.message });
      const state = e.getPresentation();
      state.browserNotice = [state.browserNotice, pacError].filter(Boolean).join('\n');
    }
    e.desktopShell.createTray();
    e.desktopShell.createWindow();
    e.powerMonitor.on('suspend', () => e.connectivityRecovery.suspend());
    e.powerMonitor.on('resume', () => e.connectivityRecovery.resume());
    e.networkStartupCoordinator.start().catch(() => {});
    e.updateNotifications.startAutomatic(e.isPackaged);
    e.onActivate(() => e.desktopShell.showWindow());
  }
}

module.exports = { DesktopStartupRuntime, MultiSchoolStartupRuntime, customGatewayProductAvailability };
