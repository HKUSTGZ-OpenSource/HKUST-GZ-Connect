'use strict';

const path = require('path');
const { ActiveContextLease } = require('../switching/active-context/active-context-lease');
const { assertActiveContextSwitchStartupClear } = require('../switching/active-context/active-context-switch-startup');
const { DesktopPersistenceRuntime } = require('../persistence/runtime/desktop-persistence-runtime');
const { DesktopStartupRuntime, MultiSchoolStartupRuntime, customGatewayProductAvailability } = require('./startup/multi-school-startup-runtime');
const {
  createMainProfileSwitchComposition,
} = require('../switching/effects/main-profile-switch-composition');
const { selectProfileWorkspacePreReadyStorage } =
  require('../persistence/runtime/profile-workspace-pre-ready-selection');
const { ProfileWorkspaceStartupRuntime } = require('../persistence/runtime/profile-workspace-startup-runtime');
const { relaunchAfterPersistenceMigration, writePersistenceE2EMarker } =
  require('../persistence/migration/legacy-hkust/persistence-relaunch');
const { writeProfileSwitchE2EMarker } =
  require('../switching/runtime/profile-switch-relaunch');
const { createLegacyRuntimeStoragePaths } = require('../persistence/paths/runtime-storage-paths');
const {
  PageFavoriteController,
  ResourceLibraryRuntime,
} = require('../resources/runtime/resource-library-runtime');

function resolveUserDataOverride(rawValue) {
  if (rawValue == null || String(rawValue).trim() === '') return null;
  const candidate = String(rawValue).trim();
  if (!path.isAbsolute(candidate)) {
    throw new Error('HKUSTGZ_USER_DATA_DIR must be an absolute path');
  }
  return path.resolve(candidate);
}

function createMultiSchoolStartupInitializer(options) {
  const runtime = new MultiSchoolStartupRuntime(options);
  const initialize = (persistenceRuntime, activeSchoolProfile) => runtime.initialize({
    mode: persistenceRuntime.mode,
    authority: persistenceRuntime.authority,
    withProfileDocument: (callback) => activeSchoolProfile.withProfileDocument(callback),
  });
  initialize.listViews = (viewOptions) => runtime.listViews(viewOptions);
  initialize.withDirectory = (callback) => runtime.withDirectory(callback);
  return Object.freeze(initialize);
}

function createPageFavoriteController({
  activeSchoolProfile,
  loadSettings,
  saveSettings,
  activityStore,
  runTransaction,
  onChanged,
} = {}) {
  return new PageFavoriteController({
    loadSettings,
    saveSettings,
    allResources: (settings) => activeSchoolProfile.mergeResourceLibrary(
      settings.customResources, [],
    ),
    visibleResources: (settings) => activeSchoolProfile.mergeResourceLibrary(
      settings.customResources, settings.hiddenBuiltinResourceIds,
    ),
    activityStore,
    runTransaction,
    onChanged,
  });
}

const desktopRuntimeComposition = Object.freeze({
  ActiveContextLease,
  assertActiveContextSwitchStartupClear,
  createLegacyRuntimeStoragePaths,
  createMainProfileSwitchComposition,
  createMultiSchoolStartupInitializer,
  createPageFavoriteController,
  customGatewayProductAvailability,
  DesktopPersistenceRuntime,
  DesktopStartupRuntime,
  ProfileWorkspaceStartupRuntime,
  ResourceLibraryRuntime,
  resolveUserDataOverride,
  relaunchAfterPersistenceMigration,
  selectProfileWorkspacePreReadyStorage,
  writePersistenceE2EMarker,
  writeProfileSwitchE2EMarker,
});

module.exports = { desktopRuntimeComposition };
