'use strict';

const path = require('node:path');
const { verifyCustomEngineConfigFile } = require('../provisioning/custom-engine-config');
const { CustomProfileIndexStore } = require('./custom-profile-index');
const {
  loadProfileWorkspaceAuthorityByKeys,
} = require('../../persistence/runtime/profile-workspace-runtime-authority');
const { validateProfileSettingsDocument } = require('../../persistence/schema/profile-workspace-documents');
const {
  createSchoolProfileView,
  validateSchoolProfileDocument,
} = require('../schema/school-profile-schema');
const {
  customProfileQuarantineRoot,
  findCustomProfileDeletionTombstones,
} = require('../deletion/custom-profile-deletion-runtime');

const MAX_CUSTOM_PROFILE_DOCUMENT_BYTES = 256 * 1024;

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

class CustomSchoolProfileRegistry {
  constructor({
    userData,
    indexStore = null,
    profileStorageEffects,
    fileSystem: fileSystemOverride,
    platform: platformOverride,
    windowsAcl: windowsAclOverride,
  } = {}) {
    if (typeof profileStorageEffects?.assertCompatible !== 'function') {
      throw new TypeError('custom school Profile storage effects are required');
    }
    profileStorageEffects.assertCompatible({
      fileSystem: fileSystemOverride,
      platform: platformOverride,
      windowsAcl: windowsAclOverride,
    });
    const fileSystem = profileStorageEffects?.fileSystem;
    const platform = profileStorageEffects?.platform;
    const windowsAcl = profileStorageEffects?.windowsAcl;
    if (typeof userData !== 'string' || !path.isAbsolute(userData) || path.resolve(userData) !== userData ||
        !fileSystem || typeof fileSystem.openSync !== 'function' ||
        !profileStorageEffects ||
        typeof profileStorageEffects.verifyPrivateDirectoryChain !== 'function' ||
        typeof profileStorageEffects.readPrivateFileBounded !== 'function' ||
        !['darwin', 'linux', 'win32'].includes(platform) ||
        (platform === 'win32' && typeof windowsAcl?.verify !== 'function')) {
      throw new TypeError('custom school Profile registry dependencies are invalid');
    }
    this.userData = userData;
    this.profileStorageEffects = profileStorageEffects;
    this.fileSystem = fileSystem;
    this.platform = platform;
    this.windowsAcl = windowsAcl;
    this.indexStore = indexStore || new CustomProfileIndexStore({
      userData, profileStorageEffects,
    });
    this.records = new Map();
    this.loaded = false;
  }

  load() {
    if (this.loaded) return this;
    const records = new Map();
    for (const indexEntry of this.indexStore.read().entries) {
      const profileRoot = path.join(this.userData, 'profiles', indexEntry.profileKey);
      const quarantined = customProfileQuarantineRoot(this.userData, indexEntry.profileKey);
      if (findCustomProfileDeletionTombstones(profileRoot, this.fileSystem).length === 1 ||
          findCustomProfileDeletionTombstones(quarantined, this.fileSystem).length === 1) {
        continue;
      }
      this.profileStorageEffects.verifyPrivateDirectoryChain(this.userData, profileRoot);
      const sourceDocument = this.#readJson(
        path.join(profileRoot, 'school-profile.json'),
        validateSchoolProfileDocument,
      );
      const profile = validateSchoolProfileDocument(sourceDocument);
      if (profile.evidenceClass !== 'custom-local' || profile.profileId !== indexEntry.profileId) {
        throw new Error('custom Profile document does not match its index');
      }
      const profileSettings = this.#readJson(
        path.join(profileRoot, 'profile-settings.json'),
        validateProfileSettingsDocument,
      );
      const authority = loadProfileWorkspaceAuthorityByKeys({
        userData: this.userData,
        profile: sourceDocument,
        profileKey: indexEntry.profileKey,
        accountKey: profileSettings.primaryAccountKey,
        fileSystem: this.fileSystem,
        platform: this.platform,
        windowsAcl: this.windowsAcl,
      });
      const engineConfig = verifyCustomEngineConfigFile({
        filePath: authority.layout.profile.engineConfig,
        profile: sourceDocument,
        profileStorageEffects: this.profileStorageEffects,
      });
      records.set(profile.profileId, Object.freeze({
        profile,
        sourceDocument,
        authority,
        engineConfig,
        indexEntry,
        context: Object.freeze({
          profileId: profile.profileId,
          profileKey: indexEntry.profileKey,
          profileRevision: profile.profileRevision,
          profileCredentialBindingRevision: profile.profileCredentialBindingRevision,
          accountKey: authority.account.accountKey,
          accountRevision: authority.account.accountRevision,
          accountCredentialRevision: authority.account.accountCredentialRevision,
          workspaceKey: authority.account.workspaceKey,
          activeContextEpoch: authority.workspaceState.activeContextEpoch,
        }),
      }));
    }
    this.records = records;
    this.loaded = true;
    return this;
  }

  reload() {
    this.records = new Map();
    this.loaded = false;
    return this.load();
  }

  listViews(options = {}) {
    this.load();
    return Object.freeze([...this.records.values()].map((record) => (
      createSchoolProfileView(record.sourceDocument, { ...options, compatibility: 'candidate' })
    )));
  }

  withProfile(profileId, callback) {
    this.load();
    if (typeof callback !== 'function') throw new TypeError('custom Profile callback is required');
    const record = this.records.get(String(profileId || ''));
    if (!record) throw new Error('custom Profile is unavailable');
    const result = callback(record);
    if (result && typeof result.then === 'function') {
      throw new TypeError('custom Profile callback must be synchronous');
    }
    return result;
  }

  createEngineLaunchBinding(profileId) {
    return this.withProfile(profileId, (record) => {
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
        throw new Error('custom Engine Profile binding exceeds its private frame bound');
      }
      return Object.freeze({ path: record.engineConfig.path, stdinFrame });
    });
  }

  #readJson(file, validator) {
    this.profileStorageEffects.verifyPrivateDirectoryChain(this.userData, path.dirname(file));
    if (this.platform === 'win32' && !this.windowsAcl.verify(file)) {
      throw new Error('custom Profile private file ACL is invalid');
    }
    const { data } = this.profileStorageEffects.readPrivateFileBounded(file, {
      maxBytes: MAX_CUSTOM_PROFILE_DOCUMENT_BYTES,
      minBytes: 2,
    });
    try {
      const value = JSON.parse(data.toString('utf8'));
      validator(value);
      return deepFreeze(value);
    } catch (error) {
      throw new Error('custom Profile private document is invalid', { cause: error });
    } finally {
      data.fill(0);
    }
  }
}

module.exports = { CustomSchoolProfileRegistry, MAX_CUSTOM_PROFILE_DOCUMENT_BYTES };
