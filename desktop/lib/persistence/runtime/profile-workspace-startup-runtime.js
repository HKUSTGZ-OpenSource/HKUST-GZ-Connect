'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  createLegacyCredentialRollbackStoreForAuthority,
} = require('../migration/legacy-hkust/legacy-credential-rollback-store');
const {
  ProfileWorkspaceCredentialStore,
} = require('../credentials/profile-workspace-credential-store');
const {
  ProfileWorkspaceMigrationRuntime,
} = require('../migration/legacy-hkust/profile-workspace-migration-runtime');
const {
  loadActiveProfileAccountAuthority,
  loadActiveProfileWorkspaceAuthority,
} = require('./profile-workspace-runtime-authority');
const {
  ProfileWorkspaceSettingsStore,
} = require('../settings/profile-workspace-settings-store');
const { validateUserDataRoot } = require('../paths/profile-workspace-layout');
const { createProfileWorkspaceRuntimeStoragePaths } = require('../paths/runtime-storage-paths');
const { validateSchoolProfileDocument } = require('../../profiles/schema/school-profile-schema');
const {
  protectWindowsFileOwnerOnly,
  tightenWindowsFileOwnerOnly,
  verifyWindowsFileOwnerOnly,
} = require('../../platform/storage/windows-private-file');

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function cloneProfile(value) {
  let cloned;
  try { cloned = JSON.parse(JSON.stringify(value)); }
  catch (error) { throw new TypeError('startup SchoolProfile could not be cloned', { cause: error }); }
  validateSchoolProfileDocument(cloned);
  return deepFreeze(cloned);
}

function exists(file, fileSystem) {
  try {
    fileSystem.lstatSync(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

class ProfileWorkspaceStartupRuntime {
  constructor({
    userData,
    profile,
    safeStorage,
    fileSystem = fs,
    platform = process.platform,
    windowsAcl = {
      protect: protectWindowsFileOwnerOnly,
      tighten: tightenWindowsFileOwnerOnly,
      verify: verifyWindowsFileOwnerOnly,
    },
    randomBytes,
    now,
  } = {}) {
    if (!safeStorage || !fileSystem || typeof fileSystem.openSync !== 'function' ||
        !['darwin', 'linux', 'win32'].includes(platform) ||
        (platform === 'win32' &&
          (typeof windowsAcl?.protect !== 'function' ||
            typeof windowsAcl?.tighten !== 'function' ||
            typeof windowsAcl?.verify !== 'function'))) {
      throw new TypeError('Profile Workspace startup dependencies are invalid');
    }
    this.userData = validateUserDataRoot(userData);
    this.profile = cloneProfile(profile);
    this.safeStorage = safeStorage;
    this.fileSystem = fileSystem;
    this.platform = platform;
    this.windowsAcl = windowsAcl;
    this.randomBytes = randomBytes;
    this.now = now;
    this.running = false;
    this.globalSettings = path.join(this.userData, 'global', 'settings.json');
    this.migrationJournal = path.join(
      this.userData,
      'global',
      'profile-account-workspace-migration.json',
    );
  }

  initialize() {
    if (this.running) throw new Error('Profile Workspace startup is already running');
    this.running = true;
    try {
      // A runtime credential transaction can intentionally make the complete
      // authority unreadable. Recover it before migration inspects an existing
      // destination, except while a migration journal still owns partial files.
      if (!exists(this.migrationJournal, this.fileSystem) &&
          exists(this.globalSettings, this.fileSystem)) {
        this.#recoverRuntimeTransactions();
      }
      const migrated = this.#migrationRuntime().run();
      if (migrated.mode !== 'profile-workspace') return migrated;
      const services = this.#recoverRuntimeTransactions();
      return Object.freeze({
        ...migrated,
        authority: services.authority,
        paths: createProfileWorkspaceRuntimeStoragePaths(services.authority),
        settingsStore: services.settingsStore,
        credentialStore: services.credentialStore,
        reloadAuthority: () => this.#workspaceAuthority(),
      });
    } finally {
      this.running = false;
    }
  }

  #migrationRuntime() {
    return new ProfileWorkspaceMigrationRuntime({
      userData: this.userData,
      profile: this.profile,
      safeStorage: this.safeStorage,
      fileSystem: this.fileSystem,
      platform: this.platform,
      windowsAcl: this.windowsAcl,
      ...(this.randomBytes ? { randomBytes: this.randomBytes } : {}),
      ...(this.now ? { now: this.now } : {}),
    });
  }

  #accountAuthority() {
    return loadActiveProfileAccountAuthority({
      userData: this.userData,
      profile: this.profile,
      fileSystem: this.fileSystem,
      platform: this.platform,
      windowsAcl: this.windowsAcl,
    });
  }

  #workspaceAuthority() {
    return loadActiveProfileWorkspaceAuthority({
      userData: this.userData,
      profile: this.profile,
      fileSystem: this.fileSystem,
      platform: this.platform,
      windowsAcl: this.windowsAcl,
    });
  }

  #rollbackStore(authority) {
    return createLegacyCredentialRollbackStoreForAuthority({
      authority,
      fileSystem: this.fileSystem,
      platform: this.platform,
      windowsAcl: this.windowsAcl,
    });
  }

  #recoverRuntimeTransactions() {
    let accountAuthority = this.#accountAuthority();
    const ownsLegacyHkustRollback = this.profile.evidenceClass === 'builtin-reviewed' &&
      this.profile.profileId === 'hkustgz';
    if (ownsLegacyHkustRollback) this.#rollbackStore(accountAuthority).reconcile();
    const credentialStore = new ProfileWorkspaceCredentialStore({
      loadAccountAuthority: () => this.#accountAuthority(),
      loadWorkspaceAuthority: () => this.#workspaceAuthority(),
      retireRollback: ({ authority, reason }) => ownsLegacyHkustRollback
        ? this.#rollbackStore(authority).retire({ reason })
        : Object.freeze({ status: 'not-applicable', changed: false }),
      safeStorage: this.safeStorage,
      fileSystem: this.fileSystem,
      platform: this.platform,
      windowsAcl: this.windowsAcl,
      ...(this.randomBytes ? { randomBytes: this.randomBytes } : {}),
      ...(this.now ? { now: this.now } : {}),
    });
    credentialStore.reconcile();
    const settingsStore = new ProfileWorkspaceSettingsStore({
      loadAuthority: () => this.#workspaceAuthority(),
      fileSystem: this.fileSystem,
      platform: this.platform,
      windowsAcl: this.windowsAcl,
      ...(this.randomBytes ? { randomBytes: this.randomBytes } : {}),
      ...(this.now ? { now: this.now } : {}),
    });
    settingsStore.reconcile();
    accountAuthority = null;
    const authority = this.#workspaceAuthority();
    return Object.freeze({ authority, settingsStore, credentialStore });
  }
}

module.exports = { ProfileWorkspaceStartupRuntime };
