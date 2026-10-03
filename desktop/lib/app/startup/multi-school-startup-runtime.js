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

module.exports = { MultiSchoolStartupRuntime, customGatewayProductAvailability };
