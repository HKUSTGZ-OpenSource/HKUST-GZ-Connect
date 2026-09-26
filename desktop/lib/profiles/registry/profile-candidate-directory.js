'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { CustomSchoolProfileRegistry } = require('./custom-school-profile-registry');
const {
  loadProfileWorkspaceAuthorityByKeys,
} = require('../../persistence/runtime/profile-workspace-runtime-authority');
const { ReviewedProfileAnchorStore } = require('./reviewed-profile-anchor-store');
const { SchoolProfileRegistry } = require('./school-profile-registry');
const { verifyEngineConfigBinding } = require('../runtime/school-profile-runtime');
const {
  createSchoolProfileView,
  validateOpaqueKey,
  validateSchoolProfileDocument,
} = require('../schema/school-profile-schema');

function engineLaunchBinding(record) {
  const stdinFrame = JSON.stringify({
    type: 'engine_config_binding',
    apiVersion: 1,
    configSha256: record.engineConfig.sha256,
    gatewayOrigin: record.profile.gateway.origin.origin,
    profileId: record.profile.profileId,
    profileRevision: record.profile.profileRevision,
    protocolFamily: record.profile.gateway.protocolFamily,
  });
  if (Buffer.byteLength(stdinFrame, 'utf8') > 1024) {
    throw new Error('Profile candidate Engine binding exceeds its private frame bound');
  }
  return Object.freeze({ path: record.engineConfig.path, stdinFrame });
}

class ProfileCandidateDirectory {
  constructor({
    userData,
    packageRoot,
    isPackaged = false,
    resourcesPath = '',
    desktopDir,
    packagedRegistry = null,
    customRegistry = null,
    anchorStore = null,
    profileStorageEffects,
    fileSystem: fileSystemOverride,
    platform: platformOverride,
    windowsAcl: windowsAclOverride,
  } = {}) {
    if (profileStorageEffects) {
      if (typeof profileStorageEffects.assertCompatible !== 'function') {
        throw new TypeError('Profile candidate storage effects are invalid');
      }
      profileStorageEffects.assertCompatible({
        fileSystem: fileSystemOverride,
        platform: platformOverride,
        windowsAcl: windowsAclOverride,
      });
    }
    const fileSystem = profileStorageEffects
      ? profileStorageEffects.fileSystem
      : fileSystemOverride || fs;
    const platform = profileStorageEffects
      ? profileStorageEffects.platform
      : platformOverride || process.platform;
    const windowsAcl = profileStorageEffects?.windowsAcl || windowsAclOverride || null;
    if (!profileStorageEffects && (!customRegistry || !anchorStore)) {
      throw new TypeError('Profile candidate private storage effects are required');
    }
    if (typeof userData !== 'string' || !path.isAbsolute(userData) || path.resolve(userData) !== userData ||
        !fileSystem || typeof fileSystem.openSync !== 'function' ||
        !['darwin', 'linux', 'win32'].includes(platform) ||
        (profileStorageEffects && platform === 'win32' &&
          (typeof windowsAcl?.protect !== 'function' || typeof windowsAcl?.verify !== 'function')) ||
        typeof packageRoot !== 'string' || !path.isAbsolute(packageRoot) ||
        typeof desktopDir !== 'string' || !path.isAbsolute(desktopDir) ||
        typeof isPackaged !== 'boolean' ||
        (isPackaged && (typeof resourcesPath !== 'string' || !path.isAbsolute(resourcesPath)))) {
      throw new TypeError('Profile candidate directory paths are invalid');
    }
    this.userData = userData;
    this.isPackaged = isPackaged;
    this.resourcesPath = resourcesPath;
    this.desktopDir = desktopDir;
    this.fileSystem = fileSystem;
    this.platform = platform;
    this.windowsAcl = windowsAcl;
    this.profileStorageEffects = profileStorageEffects;
    this.packagedRegistry = packagedRegistry || new SchoolProfileRegistry({
      packageRoot, fsImpl: fileSystem, platform,
    }).load();
    this.customRegistry = customRegistry || new CustomSchoolProfileRegistry({
      userData, profileStorageEffects,
    });
    this.anchorStore = anchorStore || new ReviewedProfileAnchorStore({
      userData, profileStorageEffects,
    });
  }

  anchorReviewedCurrent({ profileId, profileKey, accountKey } = {}) {
    if (!this.profileStorageEffects) {
      throw new TypeError('Profile candidate private storage effects are required');
    }
    const sourceDocument = this.packagedRegistry.withProfileDocument(profileId, (value) => value);
    const profile = validateSchoolProfileDocument(sourceDocument);
    if (profile.evidenceClass !== 'builtin-reviewed') {
      throw new TypeError('only a packaged reviewed Profile can be anchored');
    }
    const authority = loadProfileWorkspaceAuthorityByKeys({
      userData: this.userData,
      profile: sourceDocument,
      profileKey,
      accountKey,
      adoptLegacyHkustBrowserPartition: profile.profileId === 'hkustgz',
      fileSystem: this.fileSystem,
      platform: this.platform,
      windowsAcl: this.windowsAcl,
    });
    this.anchorStore.ensure({
      profileId: profile.profileId,
      profileKey,
      accountKey,
      createdAt: authority.account.createdAt,
    });
    return this.#reviewedRecord(sourceDocument, authority);
  }

  listViews(options = {}) {
    const reviewed = this.anchorStore.read().entries.map((anchor) => (
      this.packagedRegistry.createView(anchor.profileId, { ...options, compatibility: 'reviewed' })
    ));
    const custom = this.customRegistry.reload().listViews(options);
    return Object.freeze([...reviewed, ...custom]);
  }

  resolveProfileIdByKey(profileKey) {
    const key = validateOpaqueKey(profileKey, 'active profileKey');
    const matches = [
      ...this.anchorStore.read().entries,
      ...this.customRegistry.indexStore.read().entries,
    ].filter((entry) => entry.profileKey === key);
    if (matches.length > 1) throw new Error('active profileKey has ambiguous ownership');
    return matches[0]?.profileId || null;
  }

  hasAnyCandidates() {
    return this.anchorStore.read().entries.length > 0 ||
      this.customRegistry.indexStore.read().entries.length > 0;
  }

  withCandidate(profileId, callback) {
    if (typeof callback !== 'function') throw new TypeError('Profile candidate callback is required');
    const anchor = this.anchorStore.get(profileId);
    let record;
    if (anchor) {
      record = this.packagedRegistry.withProfileDocument(profileId, (sourceDocument) => {
        const profile = validateSchoolProfileDocument(sourceDocument);
        const authority = loadProfileWorkspaceAuthorityByKeys({
          userData: this.userData,
          profile: sourceDocument,
          profileKey: anchor.profileKey,
          accountKey: anchor.accountKey,
          adoptLegacyHkustBrowserPartition: profile.profileId === 'hkustgz',
          fileSystem: this.fileSystem,
          platform: this.platform,
          windowsAcl: this.windowsAcl,
        });
        return this.#reviewedRecord(sourceDocument, authority);
      });
    } else {
      record = this.customRegistry.reload().withProfile(profileId, (custom) => Object.freeze({
        ...custom,
        kind: 'custom-local',
        builtInResources: Object.freeze([]),
        serviceDesk: null,
        view: createSchoolProfileView(custom.sourceDocument, {
          locale: 'en', compatibility: 'candidate',
        }),
        engineLaunchBinding: engineLaunchBinding(custom),
      }));
    }
    const result = callback(record);
    if (result && typeof result.then === 'function') {
      throw new TypeError('Profile candidate callback must be synchronous');
    }
    return result;
  }

  #reviewedRecord(sourceDocument, authority) {
    const profile = validateSchoolProfileDocument(sourceDocument);
    const engineConfig = verifyEngineConfigBinding({
      registry: this.packagedRegistry,
      profile,
      isPackaged: this.isPackaged,
      resourcesPath: this.resourcesPath,
      desktopDir: this.desktopDir,
      fsImpl: this.fileSystem,
    });
    const record = Object.freeze({
      kind: 'builtin-reviewed',
      profile,
      sourceDocument,
      authority,
      engineConfig,
      builtInResources: this.packagedRegistry.getBuiltinResources(profile.profileId),
      serviceDesk: typeof this.packagedRegistry.getServiceDesk === 'function'
        ? this.packagedRegistry.getServiceDesk(profile.profileId) : null,
      context: Object.freeze({
        profileId: profile.profileId,
        profileKey: authority.layout.identity.profileKey,
        profileRevision: profile.profileRevision,
        profileCredentialBindingRevision: profile.profileCredentialBindingRevision,
        accountKey: authority.account.accountKey,
        accountRevision: authority.account.accountRevision,
        accountCredentialRevision: authority.account.accountCredentialRevision,
        workspaceKey: authority.account.workspaceKey,
        activeContextEpoch: authority.workspaceState.activeContextEpoch,
      }),
      view: createSchoolProfileView(sourceDocument, { locale: 'en', compatibility: 'reviewed' }),
    });
    return Object.freeze({ ...record, engineLaunchBinding: engineLaunchBinding(record) });
  }
}

module.exports = { ProfileCandidateDirectory, engineLaunchBinding };
