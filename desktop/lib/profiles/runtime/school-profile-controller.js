'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const {
  LEGACY_HKUST_BROWSER_PARTITION,
} = require('../../persistence/paths/profile-workspace-layout');
const {
  mergeCampusResources,
  mergeWebResourceLibrary,
  projectCampusResources,
  projectWebResourceLibrary,
  resourceActivityAliases,
} = require('../../resources/runtime/campus-resources');
const { createActiveSchoolProfileContext } = require('./school-profile-runtime');
const { ProfileCandidateDirectory } = require('../registry/profile-candidate-directory');
const { validateGlobalSettingsDocument } = require('../../persistence/schema/profile-workspace-documents');
const {
  createCapabilitySnapshot,
  createLegacyPrimaryAccountView,
  createLegacyWorkspaceView,
  createSchoolProfileView,
} = require('../schema/school-profile-schema');

const CURRENT_PROFILE_CAPABILITIES = new Set(['auth.password', 'transport.l3']);

function selectedCapabilityLayer(keys) {
  return Object.fromEntries(keys.map((capability) => [
    capability,
    CURRENT_PROFILE_CAPABILITIES.has(capability) ? 'supported' : 'unsupported',
  ]));
}

function createSchoolProfileController(options = {}) {
  const source = createActiveSchoolProfileContext(options);
  const context = {
    ...source,
    activeContextEpoch: 1,
    // This controller is the one-release bridge for a reviewed HKUST install
    // before GlobalSettings owns an explicit Profile/Workspace. Keep adopting
    // the existing partition here so upgrades retain cookies and site vault
    // scope; generic Browser code must never invent this deployment default.
    browserPartition: LEGACY_HKUST_BROWSER_PARTITION,
    compatibility: 'reviewed',
    withProfileDocument: (callback) => source.registry.withDefaultProfileDocument(callback),
    createProfileView: (options) => source.createProfileView(options),
  };
  return createController(context, options);
}

function createSchoolProfileControllerFromCandidate({ directory, profileId, ...options } = {}) {
  if (!directory || typeof directory.withCandidate !== 'function') {
    throw new TypeError('candidate Profile directory is invalid');
  }
  const load = () => {
    let record = null;
    directory.withCandidate(profileId, (value) => { record = value; });
    if (!record) throw new Error('candidate Profile is unavailable');
    return record;
  };
  const record = load();
  const profile = record.profile;
  const context = {
    profile,
    builtinResources: record.builtInResources || Object.freeze([]),
    serviceDesk: record.serviceDesk || null,
    gatewayHost: profile.gateway.origin.hostname.replace(/^\[|\]$/gu, ''),
    gatewayPort: profile.gateway.origin.port,
    engineConfigPath: record.engineConfig.path,
    activeContextEpoch: record.context.activeContextEpoch,
    browserPartition: record.authority.layout.browserPartition,
    compatibility: record.kind === 'builtin-reviewed' ? 'reviewed' : 'candidate',
    verifyEngineConfig: () => load().engineConfig,
    verifyEngineLaunchBinding: () => load().engineLaunchBinding,
    withProfileDocument: (callback) => {
      if (typeof callback !== 'function') throw new TypeError('Profile document callback is required');
      const result = callback(load().sourceDocument);
      if (result && typeof result.then === 'function') {
        throw new TypeError('Profile document callback must be synchronous');
      }
      return result;
    },
    createProfileView: (viewOptions) => createSchoolProfileView(
      load().sourceDocument,
      { ...viewOptions, compatibility: record.kind === 'builtin-reviewed' ? 'reviewed' : 'candidate' },
    ),
  };
  return createController(context, options);
}

function createPreReadySchoolProfileController({
  userData,
  profileStorageEffects,
  fileSystem: fileSystemOverride,
  platform: platformOverride,
  windowsAcl: windowsAclOverride,
  ...options
} = {}) {
  if (typeof profileStorageEffects?.assertCompatible !== 'function') {
    throw new TypeError('pre-ready Profile private storage effects are invalid');
  }
  profileStorageEffects.assertCompatible({
    fileSystem: fileSystemOverride,
    platform: platformOverride,
    windowsAcl: windowsAclOverride,
  });
  const fileSystem = profileStorageEffects?.fileSystem;
  const platform = profileStorageEffects?.platform;
  const windowsAcl = profileStorageEffects?.windowsAcl;
  if (!profileStorageEffects || typeof fileSystem?.openSync !== 'function' ||
      typeof profileStorageEffects.verifyPrivateDirectoryChain !== 'function' ||
      typeof profileStorageEffects.readPrivateFileBounded !== 'function' ||
      !['darwin', 'linux', 'win32'].includes(platform) ||
      (platform === 'win32' && typeof windowsAcl?.verify !== 'function')) {
    throw new TypeError('pre-ready Profile private storage effects are invalid');
  }
  const globalSettings = path.join(userData, 'global', 'settings.json');
  try { fileSystem.lstatSync(globalSettings); }
  catch (error) {
    if (error?.code === 'ENOENT') return createSchoolProfileController({ ...options, fsImpl: fileSystem });
    throw new Error('pre-ready active Profile authority is unreadable', { cause: error });
  }
  profileStorageEffects.verifyPrivateDirectoryChain(userData, path.dirname(globalSettings));
  if (platform === 'win32' && !windowsAcl.verify(globalSettings)) {
    throw new Error('pre-ready GlobalSettings ACL is invalid');
  }
  let data;
  try {
    ({ data } = profileStorageEffects.readPrivateFileBounded(globalSettings, {
      maxBytes: 512 * 1024,
      minBytes: 2,
    }));
  } catch (error) {
    throw new Error('pre-ready active Profile authority is unreadable', { cause: error });
  }
  let settings;
  try { settings = validateGlobalSettingsDocument(JSON.parse(data.toString('utf8'))); }
  catch (error) { throw new Error('pre-ready GlobalSettings is invalid', { cause: error }); }
  finally { data.fill(0); }

  const directory = new ProfileCandidateDirectory({
    userData,
    packageRoot: options.packageRoot,
    isPackaged: options.isPackaged,
    resourcesPath: options.resourcesPath,
    desktopDir: options.desktopDir,
    profileStorageEffects,
    fileSystem,
    platform,
  });
  const profileId = directory.resolveProfileIdByKey(settings.activeProfileKey);
  if (profileId === null) {
    if (directory.hasAnyCandidates()) {
      throw new Error('pre-ready active profileKey is not owned by a candidate');
    }
    // One-time compatibility for the first P6 startup after P3 migration:
    // prior builds could only create the reviewed HKUST authority, and P6g
    // persists its anchor after this fallback succeeds.
    return createSchoolProfileController({ ...options, fsImpl: fileSystem });
  }
  return createSchoolProfileControllerFromCandidate({ directory, profileId, ...options });
}

function createController(context, options) {
  const { profile } = context;
  const builtInResources = context.builtinResources;
  const randomBytes = typeof options.randomBytes === 'function' ? options.randomBytes : crypto.randomBytes;
  const accountEntropy = randomBytes(18);
  if (!Buffer.isBuffer(accountEntropy) || accountEntropy.length !== 18) {
    throw new TypeError('account handle entropy is invalid');
  }
  // Hex has a fixed alphanumeric alphabet. Base64URL can legitimately end in
  // "-" or "_", which the bounded handle schema rejects at random.
  const accountHandle = `account-${accountEntropy.toString('hex')}`;
  accountEntropy.fill(0);
  const activeContextEpoch = context.activeContextEpoch;
  let currentCapabilitySnapshot = null;

  function capabilitySnapshotFromReport(report) {
    if (!report || report.profileId !== profile.profileId ||
        report.profileRevision !== profile.profileRevision ||
        !Number.isSafeInteger(report.engineGeneration) || report.engineGeneration <= 0) {
      throw new TypeError('provider capability report does not match the active profile');
    }
    const keys = Object.keys(report.compiled).sort();
    return createCapabilitySnapshot({
      profileId: profile.profileId,
      profileRevision: profile.profileRevision,
      accountHandle,
      activeContextEpoch,
      engineGeneration: report.engineGeneration,
      compiled: report.compiled,
      provider: report.provider,
      profile: selectedCapabilityLayer(keys),
      ingress: selectedCapabilityLayer(keys),
    });
  }

  return Object.freeze({
    gatewayHost: context.gatewayHost,
    gatewayPort: context.gatewayPort,
    engineConfigPath: context.engineConfigPath,
    defaultRouteDomains: profile.browser.campusDomains,
    directPartnerDomains: profile.browser.directPartnerDomains,
    browserHomeUrl: profile.browser.homeUrl,
    healthTargets: profile.browser.healthTargets,
    browserPartition: context.browserPartition,
    builtInResourceCount: builtInResources.length,
    serviceDesk: context.serviceDesk || null,
    activeContextBinding: () => Object.freeze({
      profileId: profile.profileId,
      profileRevision: profile.profileRevision,
      accountHandle,
      activeContextEpoch,
    }),
    withProfileDocument: context.withProfileDocument,
    verifyEngineConfig: context.verifyEngineConfig,
    verifyEngineLaunchBinding() {
      if (typeof context.verifyEngineLaunchBinding === 'function') {
        return context.verifyEngineLaunchBinding();
      }
      const verified = context.verifyEngineConfig();
      const stdinFrame = JSON.stringify({
        type: 'engine_config_binding',
        apiVersion: 1,
        configSha256: verified.sha256,
        gatewayOrigin: profile.gateway.origin.origin,
        profileId: profile.profileId,
        profileRevision: profile.profileRevision,
        protocolFamily: profile.gateway.protocolFamily,
      });
      if (Buffer.byteLength(stdinFrame, 'utf8') > 1024) {
        throw new Error('engine profile binding frame is too large');
      }
      return Object.freeze({
        path: verified.path,
        stdinFrame,
      });
    },
    mergeResources(customResources = [], hiddenBuiltinResourceIds = []) {
      return mergeCampusResources(builtInResources, customResources, hiddenBuiltinResourceIds);
    },
    mergeResourceLibrary(customResources = [], hiddenBuiltinResourceIds = []) {
      return mergeWebResourceLibrary(
        builtInResources,
        customResources,
        hiddenBuiltinResourceIds,
      );
    },
    projectResources(customResources = [], hiddenBuiltinResourceIds = []) {
      return projectCampusResources(builtInResources, customResources, hiddenBuiltinResourceIds);
    },
    projectResourceLibrary(customResources = [], hiddenBuiltinResourceIds = []) {
      return projectWebResourceLibrary(
        builtInResources,
        customResources,
        hiddenBuiltinResourceIds,
      );
    },
    resourceActivityAliases(customResources = []) {
      return resourceActivityAliases(builtInResources, customResources);
    },
    createCapabilitySnapshot: capabilitySnapshotFromReport,
    observeCapabilityReport(report) {
      try {
        currentCapabilitySnapshot = capabilitySnapshotFromReport(report);
        return true;
      } catch {
        return false;
      }
    },
    clearCapabilitySnapshot() {
      const changed = currentCapabilitySnapshot !== null;
      currentCapabilitySnapshot = null;
      return changed;
    },
    capabilitySnapshot() {
      return currentCapabilitySnapshot;
    },
    createPresentation({
      locale = 'zh',
      hasCredential = false,
      resourceCount = builtInResources.length,
    } = {}) {
      return Object.freeze({
        schoolProfile: context.createProfileView({ locale, compatibility: context.compatibility }),
        campusAccount: createLegacyPrimaryAccountView({
          accountHandle,
          hasCredential,
          isActive: true,
        }),
        workspace: createLegacyWorkspaceView({ accountHandle, resourceCount }),
      });
    },
  });
}

module.exports = {
  createPreReadySchoolProfileController,
  createSchoolProfileController,
  createSchoolProfileControllerFromCandidate,
};
