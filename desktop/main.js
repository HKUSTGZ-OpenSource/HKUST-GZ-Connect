'use strict';
const {
  app, BrowserWindow, WebContentsView, ipcMain, shell, Menu, clipboard, safeStorage, session,
  Tray, nativeImage, dialog, powerMonitor, net: electronNet,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { parseCredentialField } = require('./lib/persistence/settings/settings-update');
const {
  credentialLoadErrorKey,
  protectedStorageAvailable,
} = require('./lib/persistence/credentials/credential-store');
const {
  OneShotVpnCredentialBroker, openVpnCredential,
} = require('./lib/persistence/credentials/one-shot-vpn-credential');
const { desktopRuntimeComposition } = require('./lib/app/desktop-runtime-composition');
const { ActiveContextLease, assertActiveContextSwitchStartupClear, createLegacyRuntimeStoragePaths, createMainProfileSwitchComposition, createMultiSchoolStartupInitializer, createPageFavoriteController, customGatewayProductAvailability, DesktopPersistenceRuntime, ProfileWorkspaceStartupRuntime, relaunchAfterPersistenceMigration, ResourceLibraryRuntime, resolveUserDataOverride, selectProfileWorkspacePreReadyStorage, writePersistenceE2EMarker, writeProfileSwitchE2EMarker } = desktopRuntimeComposition;
const { AuthChallengeCoordinator, EngineControlRegistry } = require('./lib/connection/engine/engine-control-suite');
const { EngineTerminationCoordinator } = require('./lib/connection/engine/engine-connection-runtime');
const { DesktopShell } = require('./lib/platform/shell/desktop-shell');
const { SYNTHETIC_ENGINE_E2E_ENV, EngineAttemptCoordinator, resolveGatewayProbeLaunch, resolveNativeResourcePath } = require('./lib/connection/engine/engine-process');
const {
  EngineSupervisor,
  cleanupOrphanedEngine,
} = require('./lib/connection/engine/engine-supervisor');
const { ConnectionTelemetryCoordinator } = require('./lib/connection/telemetry/connection-telemetry-coordinator');
const { DomainRoutePolicyStore } = require('./lib/routing/policy/domain-route-policy');
const { MyPortalDataRuntime, hkustMyPortalSources, pacDataUrl } = require('./lib/browser/session/browser-session-manager');
const { CampusBrowserManager, officialPortalHomeUrl } = require('./lib/browser/session/campus-browser-manager');
const { createPreReadySchoolProfileController } = require('./lib/profiles/runtime/school-profile-controller');
const {
  createControlStateSnapshot, createCustomProfileDeletionRuntime,
  createExternalIntegrationRuntime,
  createIntegrationTargetSelector,
  createSchoolProfileOnboardingRuntime,
  registerControlDataIpc,
  registerCoreControlIpc,
  registerSettingsCredentialIpc,
} = require('./lib/ipc/control-ipc-suite');
const { ensureOwnerOnly, createPrivateStorageEffects } = require('./lib/platform/storage/private-file');
const profileStorageEffects = createPrivateStorageEffects({ fileSystem: fs, platform: process.platform });
const { BufferedLogWriter, readLogTail } = require('./lib/diagnostics/logging/log-writer');
const { UpdateNotificationRuntime, checkForUpdate } = require('./lib/platform/update/update-check');
const { ConnectivityRecovery } = require('./lib/connection/recovery/connectivity-recovery');
const { createNetworkStartupSystem } = require('./lib/connection/telemetry/network-status-monitor');
const { ProxyAccessCoordinator, cleanupProxyAccessForEngineClose } = require('./lib/persistence/credentials/proxy-credential');
const {
  ExternalProxyCredentialStore,
} = require('./lib/persistence/credentials/external-proxy-credential-store');
const {
  ensureProxyCredentialSidecar,
  externalProxyHelperPath,
} = require('./lib/integrations/external-proxy-config');
const {
  CampusCertificateTrustStore, routeCertificateError,
} = require('./lib/browser/certificates/certificate-controller');
const { createT, effectiveLocale } = require('./lib/platform/i18n/i18n');
const { registerTrustedIpcHandlers } = require('./lib/ipc/ipc-handlers');
const { RoutingPolicyCoordinator, RoutingPolicyTransactionQueue } = require('./lib/routing/rules/routing-policy-transaction');
const { stopEngineAfterBrowserSuspend } = require('./lib/switching/effects/browser-engine-barrier');
const { ConnectionStateMachine, ConnectionWaitRegistry, ConnectionOperationCoordinator, projectConnectionStatus } = require('./lib/connection/state/connection-state-machine');
// The campus browser is intentionally constrained to the application's
// proxy/PAC boundary. WebRTC data channels do not require camera or microphone
// permission and Chromium may otherwise send ICE/STUN UDP directly, bypassing
// that boundary and exposing local interfaces. This switch must be set before
// app.whenReady().
app.commandLine.appendSwitch(
  'force-webrtc-ip-handling-policy',
  'disable_non_proxied_udp',
);
// ---------- profile override & single instance ----------
// Automated package checks need to isolate every app-owned file, not merely
// Chromium's cache. The override is deliberately private to the current
// process and must be absolute, so a relative launch cannot redirect it into
// an unexpected working directory.
const userDataOverride = resolveUserDataOverride(process.env.HKUSTGZ_USER_DATA_DIR);
if (userDataOverride) app.setPath('userData', userDataOverride);
// ---------- single instance (avoid the app fighting its own session) ----------
// `app.quit()` does not stop the rest of this module from running, so return
// before a second instance touches the shared settings, credential, and log
// files that the first instance owns.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}
app.setName('HKUST(GZ) Connect');
// ---------- paths & state ----------
const DATA = app.getPath('userData');
const legacyRuntimeStoragePaths = createLegacyRuntimeStoragePaths(DATA);
try { fs.unlinkSync(legacyRuntimeStoragePaths.proxyHelperCredential); } catch (error) {
  if (error?.code !== 'ENOENT') { /* strict access fails closed if replacement is unsafe */ }
}
const activeSchoolProfile = createPreReadySchoolProfileController({
  userData: DATA,
  packageRoot: __dirname, isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath, desktopDir: __dirname,
  profileStorageEffects,
});
const oneShotVpnCredential = new OneShotVpnCredentialBroker();
const activeContextLease = new ActiveContextLease(activeSchoolProfile.activeContextBinding());
const preReadyStorage = activeSchoolProfile.withProfileDocument((profile) => (
  selectProfileWorkspacePreReadyStorage({ userData: DATA, profile })
));
const runtimeStoragePaths = preReadyStorage.paths;
const SETTINGS = runtimeStoragePaths.settings;
const CRED = runtimeStoragePaths.vpnCredential;
const LOG = runtimeStoragePaths.engineLog;
const PAC_FILE = runtimeStoragePaths.externalPac;
const CAMPUS_BROWSER_PAC_FILE = runtimeStoragePaths.browserPac;
const ROUTING_RULES = runtimeStoragePaths.routingRules;
const CAMPUS_CREDENTIALS = runtimeStoragePaths.siteCredentials;
const CAMPUS_CERTIFICATE_TRUST = runtimeStoragePaths.certificateTrust;
const RESOURCE_FAVORITES = runtimeStoragePaths.resourceFavorites;
const RESOURCE_RECENTS = runtimeStoragePaths.resourceRecents;
const ENGINE_OWNER = runtimeStoragePaths.engineOwner;
const ACTIVE_CONTEXT_SWITCH = runtimeStoragePaths.activeContextSwitch;
const PROXY_CREDENTIAL = runtimeStoragePaths.proxyCredential;
const PROXY_HELPER_CREDENTIAL = runtimeStoragePaths.proxyHelperCredential;
const syntheticEngineE2e = !app.isPackaged && process.env[SYNTHETIC_ENGINE_E2E_ENV] === '1';
// The helper sidecar is a short-lived, owner-only plaintext projection of the
// encrypted stable credential. It is valid only while this app owns (or is
// about to start) the loopback listener, so never carry it across launches.
try { fs.unlinkSync(PROXY_HELPER_CREDENTIAL); } catch (error) {
  if (error?.code !== 'ENOENT') {
    // A later strict connect/copy operation will fail closed if the path
    // cannot be safely replaced. Compatibility mode remains usable.
  }
}
const GATEWAY_HOST = syntheticEngineE2e ? '127.0.0.1' : activeSchoolProfile.gatewayHost;
const GATEWAY_PORT = activeSchoolProfile.gatewayPort;
const persistenceRuntime = new DesktopPersistenceRuntime({
  preReadySelection: preReadyStorage,
  initializeAfterReady: () => activeSchoolProfile.withProfileDocument((profile) => (
    new ProfileWorkspaceStartupRuntime({
      userData: DATA, profile, safeStorage, platform: process.platform,
    }).initialize()
  )),
  legacy: DesktopPersistenceRuntime.createLegacyAdapter({
    settingsFile: SETTINGS, credentialFile: CRED, safeStorage, platform: process.platform,
    getDefaultRouteDomains: () => activeSchoolProfile.defaultRouteDomains,
    onRecovery: (notice) => { settingsRecoveryNotice = notice; },
  }),
  settingsPresentation: {
    getState: () => state,
    translate: (key) => t(key),
    emit,
    getAdditionalNotice: () => settingsRecoveryNoticeText,
  },
});
persistenceRuntime.prepareBeforeOwnerOnlyValidation(() => {
  for (const privateFile of [
    SETTINGS, CRED, LOG, PAC_FILE, CAMPUS_BROWSER_PAC_FILE, ROUTING_RULES,
    CAMPUS_CREDENTIALS, CAMPUS_CERTIFICATE_TRUST, ENGINE_OWNER,
    RESOURCE_FAVORITES, RESOURCE_RECENTS,
    PROXY_CREDENTIAL, PROXY_HELPER_CREDENTIAL,
  ]) {
    ensureOwnerOnly(privateFile);
  }
});

let desktopShell = null;
let campusBrowserManager = null;
const connectionState = new ConnectionStateMachine();
const connectionWaitRegistry = new ConnectionWaitRegistry();
connectionWaitRegistry.observe(connectionState.snapshot());

// The reviewed Engine can spend up to roughly 52 seconds in bounded Modern
// data-plane setup retries after authentication. Browser readiness must not
// report a timeout while that same, still-current attempt can legitimately
// reach listener_ready.
const BROWSER_CONNECTION_READY_TIMEOUT_MS = 75_000;
let connectedAt = null;
let telemetryCoordinator = null;
let state = {
  clientIp: null,
  dnsMode: 'unknown',
  lastError: null, failureCode: null, failureKind: 'none',
  settingsError: null,
  recoveryError: null,
  notice: null,
  browserNotice: null,
  diagnosticNotice: null,
  pacUrl: '',
};
function statusSnapshot() { return projectConnectionStatus(state, connectionState.presentation(), connectedAt); }
function reportLogFailure() { if (!state.diagnosticNotice) { state.diagnosticNotice = t('error.logUnavailable'); emit(); } }
const authChallengeCoordinator = new AuthChallengeCoordinator({
  isContextCurrent: (token) => activeContextLease.isContextCurrent(token),
  publish: (challenge) => {
    desktopShell?.send('auth-challenge', challenge);
  },
});
const engineControlRegistry = new EngineControlRegistry({ authChallenges: authChallengeCoordinator });
const engineSupervisor = new EngineSupervisor({ spawnProcess: spawn });
const activeEngineContextCurrent = (generation, token) => engineSupervisor.isCurrent(generation) &&
  activeContextLease.isCurrent(token, { connectionIntent: connectionState.snapshot().intent, engineGeneration: generation });
const routingPolicyTransactions = new RoutingPolicyTransactionQueue({ isContextCurrent: (token) => activeContextLease.isContextCurrent(token) });
function runActiveContextTransaction(options) { return routingPolicyTransactions.run(activeContextLease.captureContext(), options); }
let logWriter = null;
function initializeLogWriter() {
  logWriter = new BufferedLogWriter(LOG, { onError: reportLogFailure, onRecovered: () => { if (state.diagnosticNotice) { state.diagnosticNotice = null; emit(); } } });
}
const externalProxyCredentialStore = new ExternalProxyCredentialStore({
  filePath: PROXY_CREDENTIAL,
  safeStorage,
  platform: process.platform,
});
const proxyAccess = new ProxyAccessCoordinator({
  store: externalProxyCredentialStore,
  sidecarFile: PROXY_HELPER_CREDENTIAL,
  fileSystem: fs,
  currentProfileId: () => activeSchoolProfile.activeContextBinding().profileId,
  writeSidecar: (options) => ensureProxyCredentialSidecar({
    ...options, privateStorageEffects: profileStorageEffects,
  }),
});
const resourceLibraryRuntime = new ResourceLibraryRuntime({
  favoritesFile: RESOURCE_FAVORITES,
  recentFile: RESOURCE_RECENTS,
  platform: process.platform,
  loadResources: (settings) => safeCampusResources(settings), loadAliases: (settings) => activeSchoolProfile.resourceActivityAliases((settings || loadSettingsOrReport()).customResources),
  captureContext: () => activeContextLease.captureContext(),
  isContextCurrent: (context) => activeContextLease.isContextCurrent(context),
  openRequest: (request) => campusBrowserManager.open(request),
});
// Last known "newer release exists" result. Failures never land here, so the
// renderer can render it without distinguishing network errors from silence.
let updateNotifications = null;
// UI locale follows the OS; Chinese stays the fallback until whenReady reads
// the real locale, so early failures still render a coherent language.
let locale = 'zh';
let t = createT(locale);
let settingsRecoveryNotice = null;
let settingsRecoveryNoticeText = null;

// ---------- settings & credentials ----------
const initializeMultiSchoolStartup = createMultiSchoolStartupInitializer({ userData: DATA, packageRoot: __dirname, isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, desktopDir: __dirname, profileStorageEffects }); const customProfileDeletion = createCustomProfileDeletionRuntime({ userData: DATA, withCandidateDirectory: (callback) => initializeMultiSchoolStartup.withDirectory(callback), electronSession: session, profileStorageEffects });
const schoolProfileOnboarding = createSchoolProfileOnboardingRuntime({ userData: DATA, probeLaunch: resolveGatewayProbeLaunch({ appIsPackaged: app.isPackaged, baseDirectory: __dirname, nativeProbe: gatewayProbePath(), execPath: process.execPath }), spawnProcess: spawn,
  getActiveContext: () => activeSchoolProfile.activeContextBinding(), listProfiles: (options) => initializeMultiSchoolStartup.listViews(options),
  onDiagnostic: (code) => logWriter?.append(`[profile-onboarding] ${code}\n`), profileStorageEffects,
});
const customGatewayOnboardingEnabled = customGatewayProductAvailability();
function loadSettings() { return persistenceRuntime.loadSettings(); }
function reportSettingsReadFailure(cause, options) {
  return persistenceRuntime.reportSettingsReadFailure(cause, options);
}
function loadSettingsOrReport(options) { return persistenceRuntime.loadSettingsOrReport(options); }
// The saved language override ('zh'/'en') wins over the OS locale; 'auto'
// follows the system, and Chinese remains the fallback when both are silent.
function currentLocale() {
  return effectiveLocale(loadSettings().language, app.getLocale());
}
function assertSettingsPersistenceAvailable() {
  persistenceRuntime.assertCredentialTransactionAvailable();
}
function routingSettings() { return persistenceRuntime.routingSettings(); }
function saveSettings(settings) { return persistenceRuntime.saveSettingsWithGuard(settings); }
function savePassword(pw, username) { return persistenceRuntime.saveCredential(pw, username); }
function hasPersistentCredential() {
  return persistenceRuntime.hasCredential();
}
function hasOneShotCredential() {
  try {
    return oneShotVpnCredential.has({
      profileId: activeSchoolProfile.activeContextBinding().profileId,
    });
  } catch {
    return false;
  }
}
function hasStoredCredential() {
  return hasPersistentCredential() || hasOneShotCredential();
}
function hasCredentialForCurrentSession() {
  return hasStoredCredential() || engineSupervisor.hasActive;
}
function socksPort() { return Number(loadSettingsOrReport().port) || 1080; }
function clearActiveProxyCredential(expectedGeneration = null) { return proxyAccess.clearActive(expectedGeneration); }
const clearActiveEngineControl = (expectedGeneration = null) => engineControlRegistry.clear(expectedGeneration);
const requestActiveEngineControlShutdown = () => engineControlRegistry.shutdown();
function loadStableProxyCredential() { return proxyAccess.loadStable(); }
function removeExternalProxySidecar() { return proxyAccess.removeSidecar(); }
function revokeExternalProxyAccess() { return proxyAccess.revoke(); }
function ensureExternalProxyAccess(port) { return proxyAccess.ensureSidecar(port); }
function generationProxyCredential(port) { return proxyAccess.generationCredential(port); }
function proxyHelperPath() {
  return externalProxyHelperPath({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    desktopDir: __dirname,
    platform: process.platform,
    arch: process.arch,
  });
}
function campusResources(settings = loadSettingsOrReport()) {
  return resourceLibraryRuntime.resolveRoutes(activeSchoolProfile.mergeResourceLibrary(
    settings.customResources, settings.hiddenBuiltinResourceIds,
  ), (url) => domainRoutePolicy.resolve(url));
}
function safeCampusResources(settings = null) {
  try { return campusResources(settings || loadSettingsOrReport()); }
  catch (error) {
    reportSettingsReadFailure(error);
    return activeSchoolProfile.mergeResourceLibrary();
  }
}
function safeCampusResourceLibrary(settings = null) {
  return resourceLibraryRuntime.listLocalized(settings, locale);
}
const certificateTrustStore = new CampusCertificateTrustStore({
  filePath: CAMPUS_CERTIFICATE_TRUST,
});
let serverCampusResources = activeSchoolProfile.mergeResourceLibrary([], []);
const domainRoutePolicy = new DomainRoutePolicyStore({
  filePath: ROUTING_RULES,
  // Browser webRequest executes for every main-frame and subresource request.
  // The app is the sole settings writer, so an immutable snapshot updated by
  // saveSettings() avoids re-reading the complete Profile/Account/Workspace
  // authority (and Windows ACLs) on that hot path.
  customResources: () => routingSettings().customResources,
  schoolDomains: () => routingSettings().routeDomains,
  directPartnerDomains: () => activeSchoolProfile.directPartnerDomains,
  serverResources: () => serverCampusResources,
});
// ---------- engine ----------
function nativeResourcePath(kind) {
  return resolveNativeResourcePath({ kind, appIsPackaged: app.isPackaged,
    baseDirectory: __dirname, resourcesPath: process.resourcesPath });
}
function enginePath() { return nativeResourcePath('ec-engine'); }
function gatewayProbePath() { return nativeResourcePath('ec-gateway-probe'); }
function emit() {
  state.pacUrl = pacUrl();
  connectionWaitRegistry.observe(connectionState.snapshot());
  // locale rides along so a language change reaches the renderer without a
  // separate channel; update rides along so an automatic check that finds a
  // new release surfaces without waiting for a full refresh. get-state stays
  // the source of truth on full refreshes.
  desktopShell?.send('status', { ...statusSnapshot(), locale, update: updateNotifications?.snapshot() || null });
  desktopShell?.updateTray();
}

// The gateway permits one session per account. Stop an orphaned independent
// engine before starting the new owned child.
function killStrayEngines(resolvedEnginePath) {
  return cleanupOrphanedEngine({ platform: process.platform,
    executablePath: resolvedEnginePath, ownerFile: ENGINE_OWNER });
}

function clearConnectionPresentation() {
  connectedAt = null;
  state.clientIp = null;
  state.dnsMode = 'unknown'; activeSchoolProfile.clearCapabilitySnapshot();
  telemetryCoordinator?.stop();
}
// ConnectivityRecovery stores these callbacks; app-ready starts the monitor
// only after the operation owner below has been constructed.
const connectivityRecovery = new ConnectivityRecovery({
  invalidate: (reason, intent) => connectionOperations.invalidateForConnectivity(reason, intent),
  getLifecycleIntent: () => connectionOperations.currentRecoveryIntent(),
  shouldReconnect: (intent, reason) => connectionOperations.shouldReconnectForConnectivity(intent, reason),
  reconnect: (intent, reason) => connectionOperations.recoverConnectivity(intent, reason),
  onRecoveryDeclined: (intent, reason) => connectionOperations.onConnectivityRecoveryDeclined(intent, reason),
});
const { monitor: networkStatusMonitor, startup: networkStartupCoordinator, environment: networkEnvironmentService } = createNetworkStartupSystem({
  appIsPackaged: app.isPackaged, environment: process.env, dataDirectory: DATA, fileSystem: fs,
  isOnline: () => electronNet.isOnline(), onOffline: () => connectivityRecovery.networkOffline(),
  onOnline: () => connectivityRecovery.networkOnline(), shouldAutoConnect: () => { const s = loadSettingsOrReport(); return s.autoConnect !== false && Boolean(s.username) && hasPersistentCredential(); },
  pauseOffline: () => { connectivityRecovery.cancel(); const intent = connectionState.beginConnectIntent(); return connectivityRecovery.networkOffline(intent) ? intent : null; },
  resumeInitialOffline: (intent) => connectivityRecovery.initialNetworkOnline(intent), connect: () => connect(), isQuitting: () => desktopShell?.isQuitting === true, onPublicEgress: (snapshot) => desktopShell?.send('network-environment', snapshot),
});
const connectionOperations = new ConnectionOperationCoordinator({
  connectionState, engineSupervisor, isQuitting: () => desktopShell?.isQuitting === true,
  loadSettingsOrReport,
  cancelRecovery: () => { networkStartupCoordinator?.cancel(); connectivityRecovery.cancel(); },
  clearProxyCredential: clearActiveProxyCredential, clearPresentation: clearConnectionPresentation,
  removeSidecar: removeExternalProxySidecar, getPresentation: () => state, getTranslator: () => t, emit,
  waitForConnected: intent => connectionWaitRegistry.wait(intent, {
    timeoutMs: BROWSER_CONNECTION_READY_TIMEOUT_MS,
  }),
  runAttempt: (retry, intent) => connectOnce(retry, intent),
  stopEngine: () => stopEngineAfterBrowserSuspend({
    suspendBrowser: suspendOpenBrowserPolicy,
    browserBoundaryClosed: () => campusBrowserManager.routingRequestsBlocked !== false,
    closeBrowser: () => campusBrowserManager.close(),
    onSuspendError: (error) => {
      state.browserNotice = t('error.browserRoutingAfterSave', { message: error.message });
      emit();
    },
    // Supervisor owns the unchanged reviewed grace/force timeout defaults.
    stopEngine: () => engineSupervisor.stop({ requestGracefulStop: requestActiveEngineControlShutdown }),
  }),
});
async function connect(isRetry = false, expectedIntent = null) {
  return connectionOperations.connect(isRetry, expectedIntent);
}
const engineTermination = new EngineTerminationCoordinator({
  isGenerationCurrent: generation => engineSupervisor.isCurrent(generation), connectionState,
  scheduleRetry: (generation, delay, callback) => engineSupervisor.schedule(generation, delay, callback),
  getPresentation: () => state, getConnectedAt: () => connectedAt, getTranslator: () => t,
  now: () => Date.now(), clearControl: clearActiveEngineControl,
  cleanupProxyAccess: cleanupProxyAccessForEngineClose,
  clearCredential: clearActiveProxyCredential, removeSidecar: removeExternalProxySidecar,
  suspendBrowser: suspendOpenBrowserPolicy, clearPresentation: clearConnectionPresentation,
  loadSettings, reportSettingsReadFailure, emit, connect: (retry, intent) => connect(retry, intent),
});
function handleEngineClose(...args) { return engineTermination.close(...args); }
function revokeEngineServing(...args) { return engineTermination.revokeServing(...args); }
function handleEngineExitBoundary(...args) { return engineTermination.exit(...args); }
const engineAttempts = new EngineAttemptCoordinator({
  engineSupervisor, connectionState, appIsPackaged: app.isPackaged, baseDirectory: __dirname,
  getState: () => state, getTranslator: () => t, getLogWriter: () => logWriter,
  isCredentialTransactionBlocked: () => persistenceRuntime.isCredentialTransactionBlocked(),
  retryCredentialTransactionRecovery: () => persistenceRuntime.retryCredentialTransactionRecovery(),
  loadSettingsOrReport, loadSettings, reportSettingsReadFailure, reportLogFailure, emit,
  networkEnvironment: {
    refresh: (...args) => networkEnvironmentService.refresh(...args),
    engineArguments: value => networkEnvironmentService.engineArguments(value),
  },
  profile: {
    verifyEngineLaunchBinding: () => activeSchoolProfile.verifyEngineLaunchBinding(),
    activeContextBinding: () => activeSchoolProfile.activeContextBinding(),
    clearCapabilitySnapshot: () => activeSchoolProfile.clearCapabilitySnapshot(),
    observeCapabilityReport: report => activeSchoolProfile.observeCapabilityReport(report),
  },
  openCredential: profileId => openVpnCredential({ profileId, memoryBroker: oneShotVpnCredential,
    openPersistent: () => persistenceRuntime.openCredential() }),
  credentialLoadErrorKey, parseCredentialField, enginePath,
  clearActiveProxyCredential, generationProxyCredential, removeExternalProxySidecar, killStrayEngines,
  hasStableProxyCredential: () => proxyAccess.hasStable(), proxyCredentialFile: PROXY_CREDENTIAL,
  setActiveProxyCredential: value => proxyAccess.setActive(value), engineOwnerFile: ENGINE_OWNER,
  activeEngineContextCurrent, getBrowser: () => campusBrowserManager, revokeEngineServing,
  handleEngineExitBoundary, handleEngineClose, controlRegistry: engineControlRegistry,
  contextLease: { capture: options => activeContextLease.capture(options) },
  onFirstConnected: (generation, token) => { connectedAt = Date.now(); telemetryCoordinator.start(generation, token); },
});
async function connectOnce(isRetry, intent) { return engineAttempts.run(isRetry, intent); }

function ensureEngineStopped() { return connectionOperations.ensureEngineStopped(); }
async function disconnect() { return connectionOperations.disconnect(); }
async function reconnect(expectedGeneration = null) {
  return connectionOperations.reconnect(expectedGeneration);
}

// ---------- PAC file (advanced app integration; no DNS probing) ----------
const routingPolicyCoordinator = new RoutingPolicyCoordinator({
  policy: domainRoutePolicy, externalPacFile: PAC_FILE, browserPacFile: CAMPUS_BROWSER_PAC_FILE,
  getSettings: loadSettingsOrReport, getSocksPort: socksPort,
  getBrowser: () => campusBrowserManager,
  canResumeBrowser: () => connectionState.isConnected() && engineSupervisor.hasActive,
  assertPersistence: assertSettingsPersistenceAvailable,
  runTransaction: runActiveContextTransaction, encodePac: pacDataUrl,
});
function refreshPacFile(settings = loadSettingsOrReport()) {
  return routingPolicyCoordinator.refreshExternal(settings);
}
function pacUrl() { return routingPolicyCoordinator.pacUrl(); }
async function suspendOpenBrowserPolicy() {
  return routingPolicyCoordinator.suspendBrowser();
}
function runDomainPolicyTransaction(buildOperations) {
  return routingPolicyCoordinator.run(buildOperations);
}
const browserRoutingPolicy = routingPolicyCoordinator.browserPolicy;
const resourcesChanged = () => { emit(); campusBrowserManager?.browser?.updateToolbar(); };
const pageFavoriteController = createPageFavoriteController({ activeSchoolProfile, loadSettings: loadSettingsOrReport, saveSettings, activityStore: resourceLibraryRuntime, runTransaction: runDomainPolicyTransaction, onChanged: resourcesChanged });
campusBrowserManager = new CampusBrowserManager({
  BrowserWindow, WebContentsView, Menu,
  session,
  dialog,
  safeStorage,
  platform: process.platform,
  credentialFile: CAMPUS_CREDENTIALS,
  certificateTrust: {
    isTrusted: (origin, fingerprint) => certificateTrustStore.isTrusted(origin, fingerprint),
    trust: (origin, fingerprint) => certificateTrustStore.trust(origin, fingerprint),
  },
  parentWindow: () => desktopShell?.window || null,
  toolbarFile: path.join(__dirname, 'renderer', 'campus-browser.html'), workspaceFile: path.join(__dirname, 'renderer', 'campus-workspace.html'),
  toolbarPreload: path.join(__dirname, 'lib', 'browser', 'toolbar', 'campus-toolbar-contract.js'), workspacePreload: path.join(__dirname, 'lib', 'browser', 'workspace', 'campus-workspace-preload.js'),
  campusPreload: path.join(__dirname, 'campus-preload.js'),
  homeUrl: officialPortalHomeUrl(activeSchoolProfile.createPresentation({ locale }).schoolProfile, safeCampusResourceLibrary()),
  browserPartition: preReadyStorage.authority?.layout?.browserPartition || activeSchoolProfile.browserPartition,
  routingPolicy: browserRoutingPolicy,
  ensureCampusReady: () => connectionOperations.ensureBrowserReady(),
  resolveRoute: (url) => domainRoutePolicy.resolve(url),
  ensureConnected: () => connectionOperations.ensureBrowserConnected(),
  getSocksPort: socksPort, getNewTabUrl: () => loadSettingsOrReport().browserNewTabUrl,
  getLocale: () => locale,
  getTranslator: () => t,
  getProfilePresentation: () => activeSchoolProfile.createPresentation({ locale }).schoolProfile, getWorkspaceResources: () => safeCampusResourceLibrary(), getWorkspaceGroups: () => resourceLibraryRuntime.listGroups(), getSharedPortalCredential: (origin) => origin === 'https://sso.hkust-gz.edu.cn' && activeSchoolProfile.activeContextBinding().profileId === 'hkustgz' ? persistenceRuntime.openCredential() : null,
  onTogglePageFavorite: (candidate) => pageFavoriteController.toggle(candidate).catch((error) => ({ ok: false, error: error.message })), onRecordPageOpen: (url) => (resourceLibraryRuntime.recordOpenByUrl(url) && (emit(), true)), onOpenResource: (resourceId) => openCampusResourceById({ resourceId }), onWorkspaceMutation: (command) => pageFavoriteController.handleWorkspaceCommand(command),
  showItemInFolder: (file) => shell.showItemInFolder(file), showSettings: () => { desktopShell?.showWindow(); desktopShell?.send('open-settings'); },
  showRoutingRules: () => {
    desktopShell?.showWindow();
    desktopShell?.send('open-routing-rules');
  },
  reportError: (message) => {
    state.browserNotice = message;
    emit();
  },
});
const integrationTargetSelector = createIntegrationTargetSelector({ dialog, getParentWindow: () => desktopShell?.window || null, homeDirectory: app.getPath('home') });
const externalIntegrationRuntime = createExternalIntegrationRuntime({
  enabled: preReadyStorage.mode === 'profile-workspace', workspaceRoot: preReadyStorage.authority?.layout?.workspace?.root,
  getAuthority: () => persistenceRuntime.currentAuthority(), withProfileDocument: activeSchoolProfile.withProfileDocument,
  getSettings: loadSettingsOrReport, getDomainPolicy: () => domainRoutePolicy.snapshot(),
  getProxyCredential: loadStableProxyCredential, getPacSource: () => domainRoutePolicy.buildPac(Number(loadSettingsOrReport().port), { defaultRoute: 'direct', campusPrivateIpv4: true }),
  ensureSidecar: () => ensureExternalProxyAccess(socksPort()), writeClipboard: (text) => (clipboard.writeText(text), true),
  helperPath: proxyHelperPath(), credentialFile: PROXY_HELPER_CREDENTIAL, selectTarget: integrationTargetSelector,
  privateStorageEffects: profileStorageEffects,
});
const profileSwitching = createMainProfileSwitchComposition({
  enabled: preReadyStorage.mode === 'profile-workspace',
  profileStorageEffects,
  directoryOptions: { userData: DATA, packageRoot: __dirname, isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath, desktopDir: __dirname },
  userData: DATA, journalFile: ACTIVE_CONTEXT_SWITCH, activeAuthority: preReadyStorage.authority,
  application: app, argv: process.argv, isPackaged: app.isPackaged, developmentEntry: __dirname,
  owners: { activeContextLease, browserManager: campusBrowserManager,
    authChallenges: authChallengeCoordinator, onboarding: { cancel: () => { schoolProfileOnboarding.cancel(); externalIntegrationRuntime.cancel(); } },
    networkStartup: networkStartupCoordinator, connectivityRecovery,
    mutationQueue: routingPolicyTransactions, engineSupervisor, connectionState },
  effects: {
    clearProxyCredential: clearActiveProxyCredential, clearConnectionPresentation,
    ensureEngineStopped, cleanupOrphanedEngine: () => killStrayEngines(enginePath()),
    revokeProxyAccess: revokeExternalProxyAccess,
    clearServerState: () => { oneShotVpnCredential.clear(); serverCampusResources = []; state.lastError = null;
      state.browserNotice = null; clearConnectionPresentation(); return true; },
    closeLog: () => logWriter?.close().catch(reportLogFailure),
  },
});
const switchSchoolProfile = profileSwitching.switchProfile;
async function connectAndOpenCampusBrowser(rawRequest) {
  state.browserNotice = null;
  emit();
  const result = await campusBrowserManager.open(rawRequest);
  if (result?.ok) {
    state.browserNotice = null;
    emit();
  }
  return result;
}
async function openCampusResourceById({ resourceId } = {}) {
  try {
    return await runActiveContextTransaction(() => ({
      commit: () => resourceLibraryRuntime.openById(resourceId, locale),
    }));
  }
  catch { return { ok: false, error: t('error.resourceUnavailable') }; }
}

// ---------- update notifications (no automatic download or installation) ----------
updateNotifications = new UpdateNotificationRuntime({
  getVersion: () => app.getVersion(), check: checkForUpdate,
  readSettings: loadSettingsOrReport, saveSettings,
  assertPersistence: assertSettingsPersistenceAvailable,
  runTransaction: runActiveContextTransaction, onAvailable: emit,
  openExternal: url => shell.openExternal(url),
});

// ---------- IPC ----------
const CONTROL_RENDERER_FILE = path.join(__dirname, 'renderer', 'index.html'), CAMPUS_WORKSPACE_RENDERER_FILE = path.join(__dirname, 'renderer', 'campus-workspace.html');
const cardBoard = require('./lib/app/card-board-main-runtime').createCardBoardMainRuntime({ favoritesFile: RESOURCE_FAVORITES, platform: process.platform, ipcMain, allowedFiles: [CONTROL_RENDERER_FILE, CAMPUS_WORKSPACE_RENDERER_FILE], getResources: safeCampusResourceLibrary, getGroups: () => resourceLibraryRuntime.listGroups(), runTransaction: runActiveContextTransaction, onChanged: (document) => { desktopShell?.send('card-board-layout-changed', document); campusBrowserManager?.browser?.refreshCardBoardLayout(document); } });
function trustedHandle(channel, handler) {
  registerTrustedIpcHandlers({
    ipcMain,
    getWebContents: () => desktopShell?.webContents || null,
    allowedFiles: [CONTROL_RENDERER_FILE],
    handlers: { [channel]: handler },
  });
}

const controlStateSnapshot = createControlStateSnapshot({
  getStatus: statusSnapshot, loadSettings: loadSettingsOrReport,
  hasCredential: hasCredentialForCurrentSession,
  hasAccountIdentity: () => persistenceRuntime.hasAccountIdentity() ||
    hasOneShotCredential() || engineSupervisor.hasActive,
  getPacUrl: pacUrl, getLocale: () => locale, platform: process.platform,
  getVersion: () => app.getVersion(), getUpdate: () => updateNotifications.snapshot(),
  getResources: safeCampusResourceLibrary, getResourceGroups: () => resourceLibraryRuntime.listGroups(), getFallbackResources: () => safeCampusResourceLibrary({ customResources: [] }),
  getProfilePresentation: (options) => activeSchoolProfile.createPresentation(options),
  getServiceDesk: () => activeSchoolProfile.serviceDesk,
  getAuthChallenge: () => authChallengeCoordinator.snapshot(),
  getNetworkEnvironment: () => networkEnvironmentService.snapshot(loadSettingsOrReport().underlaySourceAddress, { probePublicEgress: false }),
});

for (const [channel, handler] of Object.entries(authChallengeCoordinator.ipcHandlers())) {
  trustedHandle(channel, handler);
}

registerControlDataIpc({
  register: trustedHandle,
  routing: {
    policy: domainRoutePolicy,
    runTransaction: runDomainPolicyTransaction,
  },
  certificates: { store: certificateTrustStore },
  resources: {
    loadSettings: loadSettingsOrReport,
    saveSettings,
    runTransaction: runDomainPolicyTransaction,
    safeResources: safeCampusResourceLibrary,
    routingPolicy: domainRoutePolicy,
    activityStore: resourceLibraryRuntime, onChanged: resourcesChanged,
  }, cardBoard,
  schools: { onboarding: schoolProfileOnboarding, getLocale: () => locale,
    isCustomGatewayEnabled: () => customGatewayOnboardingEnabled,
    deleteProfile: (request) => customProfileDeletion.deleteProfile({ ...request, activeProfileId: activeSchoolProfile.activeContextBinding().profileId }),
    switchProfile: switchSchoolProfile },
  integrations: externalIntegrationRuntime, campusData: new MyPortalDataRuntime({ electronSession: session, getPartition: () => campusBrowserManager.browserPartition, getPortalUrl: () => activeSchoolProfile.browserHomeUrl, getSessionUrlHint: () => campusBrowserManager.portalSessionUrl(activeSchoolProfile.browserHomeUrl), getSources: () => activeSchoolProfile.activeContextBinding().profileId === 'hkustgz' ? hkustMyPortalSources : {} }), browser: { clearSiteData: () => campusBrowserManager.clearSiteData(), translate: (key) => t(key) },
});
registerSettingsCredentialIpc({
  register: trustedHandle,
  loadSettings: loadSettingsOrReport,
  saveSettings,
  savePassword,
  removePassword: () => persistenceRuntime.clearCredential(),
  credentialTransactions: persistenceRuntime,
  runPolicyTransaction: runDomainPolicyTransaction,
  runSerialTransaction: runActiveContextTransaction,
  assertPersistence: assertSettingsPersistenceAvailable,
  translate: (key) => t(key),
  onLanguageChanged: (language) => {
    locale = effectiveLocale(language, app.getLocale());
    t = createT(locale);
    desktopShell?.installApplicationMenu();
    campusBrowserManager.setLocale(locale, t);
    emit();
  },
  setStartAtLogin: (enabled) => {
    try { app.setLoginItemSettings({ openAtLogin: enabled }); } catch {}
  },
  hasActiveEngine: () => engineSupervisor.hasActive,
  reconnect,
  disconnect,
  getActiveProfileId: () => activeSchoolProfile.activeContextBinding().profileId,
  credentialStorageAvailable: () => protectedStorageAvailable(safeStorage, process.platform),
  stageOneShotCredential: (request) => oneShotVpnCredential.stage(request),
  clearOneShotCredential: (revision) => oneShotVpnCredential.clear(revision),
});
registerCoreControlIpc({
  register: trustedHandle, getState: controlStateSnapshot, getNetworkEnvironment: () => networkEnvironmentService.snapshot(loadSettingsOrReport().underlaySourceAddress, { probePublicEgress: true }),
  getLoginAccount: () => {
    try {
      if (hasCredentialForCurrentSession()) return { ok: false, username: '' };
      return { ok: true, username: loadSettingsOrReport().username };
    } catch { return { ok: false, username: '' }; }
  },
  connect: async () => { const { intent: _intent, ...result } = await connect(); return result; },
  disconnect: () => disconnect(),
  reconnect: async () => { const { intent: _intent, ...result } = await reconnect(); return result; },
  getLogs: async () => {
    await logWriter.flush().catch(reportLogFailure);
    return readLogTail(LOG);
  },
  openLog: async () => {
    await logWriter.flush().catch(reportLogFailure);
    await shell.openPath(LOG).catch(() => {});
  },
  copyText: (text) => {
    clipboard.writeText(text);
    return { ok: true };
  },
  openCampusBrowser: (request) => connectAndOpenCampusBrowser(request), openBookmarkManager: () => campusBrowserManager.openBookmarkManager(),
  openResource: (request) => openCampusResourceById(request),
  checkUpdate: force => updateNotifications.run(force),
  openExternal: url => updateNotifications.open(url),
  resize: (height) => desktopShell.resize(height),
});
// ---------- window / tray composition ----------
function rememberCloseAction(action) { return persistenceRuntime.rememberCloseAction(action, runActiveContextTransaction); }
desktopShell = new DesktopShell({
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  dialog,
  baseDirectory: __dirname,
  controlRendererFile: CONTROL_RENDERER_FILE,
  preloadFile: path.join(__dirname, 'preload.js'),
  platform: process.platform,
  translate: (key, vars) => t(key, vars),
  getConnectionState: () => statusSnapshot(),
  getCloseAction: () => loadSettingsOrReport().closeAction,
  connect: () => connect(),
  disconnect: () => disconnect(),
  openCampusBrowser: () => connectAndOpenCampusBrowser(),
  rememberCloseAction,
  disposeLifecycle: () => {
    schoolProfileOnboarding.cancel(); externalIntegrationRuntime.cancel();
    oneShotVpnCredential.clear();
    networkStartupCoordinator.dispose(); networkEnvironmentService.dispose(); connectionWaitRegistry.dispose();
    connectivityRecovery.dispose();
    networkStatusMonitor.dispose();
  },
  cleanupQuit: async () => {
    await logWriter?.close().catch(reportLogFailure);
    proxyAccess.disposeForQuit();
  },
  onControlRendererUnavailable: () => (schoolProfileOnboarding.cancel(), externalIntegrationRuntime.cancel(), authChallengeCoordinator.cancelForLifecycle()),
  onWindowError: (error) => {
    state.settingsError = error.userMessage || error.message;
    emit();
  },
});
telemetryCoordinator = new ConnectionTelemetryCoordinator({
  appPid: process.pid,
  gatewayHost: GATEWAY_HOST,
  gatewayPort: GATEWAY_PORT,
  healthTargets: activeSchoolProfile.healthTargets,
  getSocksPort: socksPort,
  getEnginePid: () => engineSupervisor.currentChild?.pid ?? -1,
  getProxyCredentials: (generation) => proxyAccess.socksAuthentication(generation),
  isConnected: () => connectionState.isConnected(),
  isEngineCurrent: activeEngineContextCurrent,
  isVisible: () => desktopShell.isVisible(),
  getConnectedAt: () => connectedAt,
  send: (snapshot) => desktopShell.send('telemetry', snapshot),
  getAutoReconnect: () => loadSettingsOrReport().autoReconnect,
  isDesiredConnected: () => connectionState.snapshot().desiredConnected,
  reconnect: (generation, token) => activeEngineContextCurrent(generation, token)
    ? reconnect(generation)
    : Promise.resolve({ ok: false, stale: true }),
  onRecovering: (generation, token) => {
    if (!activeEngineContextCurrent(generation, token)) return;
    state.lastError = t('error.tunnelRecovering');
    emit();
  },
});
app.on('second-instance', () => desktopShell.showWindow());
app.on('certificate-error', (
  event, webContents, url, error, certificate, callback, isMainFrame,
) => {
  // This exception path belongs only to untrusted pages rendered by the campus
  // browser. The control window, the toolbar, and every unrelated Electron
  // request retain Chromium's normal certificate handling.
  routeCertificateError({
    owned: campusBrowserManager.ownsWebContents(webContents),
    isMainFrame,
    event,
    callback,
    prompt: () => campusBrowserManager.handleCertificateError({
      url, error, certificate, callback,
    }),
  });
});
app.on('login', (event, webContents, _details, authInfo, callback) => {
  // Chromium cannot authenticate SOCKS5 itself, so strict mode exposes an
  // authenticated HTTP CONNECT frontend on the same loopback port. Only a
  // page owned by the isolated campus browser, the exact current engine
  // generation, and the exact Basic challenge from 127.0.0.1 may receive the
  // in-memory credential. Control UI and arbitrary WebContents are excluded.
  const generation = engineSupervisor.currentGeneration;
  if (!campusBrowserManager.ownsWebContents(webContents) ||
      !proxyAccess.matchesProxyChallenge(authInfo, generation)) return;
  event.preventDefault();
  proxyAccess.answerProxyChallenge(authInfo, generation, callback);
});
app.whenReady().then(() => {
  if (!profileSwitching.runtime) {
    assertActiveContextSwitchStartupClear({
      mode: preReadyStorage.mode, filePath: ACTIVE_CONTEXT_SWITCH, profileStorageEffects,
    });
  }
  return profileSwitching.recoverBeforeServices();
}).then((switchRecovery) => {
  if (switchRecovery?.relaunching) return;
  const persistence = persistenceRuntime.initialize();
  if (persistence.relaunchRequired) {
    relaunchAfterPersistenceMigration({ application: app, argv: process.argv,
      isPackaged: app.isPackaged, developmentEntry: __dirname });
    return;
  }
  initializeMultiSchoolStartup(persistenceRuntime, activeSchoolProfile);
  customProfileDeletion.recover().then((result) => { if (!result.ok) logWriter?.append('[profile-deletion] recovery incomplete\n'); });
  initializeLogWriter();
  writePersistenceE2EMarker({ application: app, environment: process.env, userData: DATA, mode: persistenceRuntime.mode }); writeProfileSwitchE2EMarker({ application: app, environment: process.env, userData: DATA, ...activeSchoolProfile.activeContextBinding() });
  try {
    locale = currentLocale();
  } catch {
    locale = effectiveLocale('auto', app.getLocale());
  }
  t = createT(locale);
  try {
    loadSettings();
  } catch (error) {
    reportSettingsReadFailure(error, { emitState: false });
  }
  if (settingsRecoveryNotice) {
    settingsRecoveryNoticeText = t(settingsRecoveryNotice.kind === 'restored'
      ? 'error.settingsRestored'
      : 'error.settingsDefaults');
  }
  persistenceRuntime.applyCredentialRecoveryOutcome(
    persistenceRuntime.getCredentialTransactionRecovery(),
    { emitState: false },
  );
  desktopShell.installApplicationMenu();
  // A PAC write can fail on a read-only or full user-data directory. That must
  // not leave the user with no window and no tray, so it is reported through the
  // normal error surface instead of aborting startup.
  try {
    refreshPacFile();
  } catch (error) {
    const pacError = error.userMessage || t('error.pacWriteAtBoot', { message: error.message });
    // Preserve an earlier credential-recovery or settings-read failure.  PAC
    // generation is a separate startup boundary and must not hide the reason
    // persistence/connection remains fail-closed.
    state.browserNotice = [state.browserNotice, pacError].filter(Boolean).join('\n');
  }
  desktopShell.createTray();
  desktopShell.createWindow();
  powerMonitor.on('suspend', () => connectivityRecovery.suspend());
  powerMonitor.on('resume', () => connectivityRecovery.resume());
  networkStartupCoordinator.start().catch(() => {});
  updateNotifications.startAutomatic(app.isPackaged);
  app.on('activate', () => desktopShell.showWindow());
}).catch((error) => {
  dialog.showErrorBox(t('error.startupTitle'), String(error && error.message ? error.message : error));
  app.exit(1);
});
app.on('window-all-closed', () => { /* Keep the tray process alive. */ });
app.on('before-quit', (event) => {
  if (desktopShell.quitAllowed) return;
  event.preventDefault();
  desktopShell.requestQuit();
});
app.on('will-quit', () => updateNotifications?.stopAutomatic());
