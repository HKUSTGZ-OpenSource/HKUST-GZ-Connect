'use strict';
const {
  app, BrowserWindow, WebContentsView, ipcMain, shell, Menu, clipboard, safeStorage, session,
  Tray, nativeImage, dialog, powerMonitor, net: electronNet,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { desktopRuntimeComposition } = require('./lib/app/desktop-runtime-composition');
const { ActiveContextLease, assertActiveContextSwitchStartupClear, createLegacyRuntimeStoragePaths, createMainProfileSwitchComposition, createMultiSchoolStartupInitializer, createPageFavoriteController, customGatewayProductAvailability, DesktopPersistenceRuntime, DesktopStartupRuntime, ProfileWorkspaceStartupRuntime, relaunchAfterPersistenceMigration, ResourceLibraryRuntime, resolveUserDataOverride, selectProfileWorkspacePreReadyStorage, writePersistenceE2EMarker, writeProfileSwitchE2EMarker } = desktopRuntimeComposition;
const { DesktopShell } = require('./lib/platform/shell/desktop-shell');
const { SYNTHETIC_ENGINE_E2E_ENV, createEngineApplicationRuntime, resolveGatewayProbeLaunch, resolveNativeResourcePath } = require('./lib/connection/engine/engine-process');
const { ConnectionTelemetryCoordinator } = require('./lib/connection/telemetry/connection-telemetry-coordinator');
const { DomainRoutePolicyStore } = require('./lib/routing/policy/domain-route-policy');
const { MyPortalDataRuntime, hkustMyPortalSources, pacDataUrl } = require('./lib/browser/session/browser-session-manager');
const { CampusBrowserManager, officialPortalHomeUrl } = require('./lib/browser/session/campus-browser-manager');
const { createPreReadySchoolProfileController } = require('./lib/profiles/runtime/school-profile-controller');
const {
  createTrustedControlRegistrar,
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
const { createNetworkStartupSystem, createStartupAutoConnectEligibility } = require('./lib/connection/telemetry/network-status-monitor');
const {
  ensureProxyCredentialSidecar,
  externalProxyHelperPath,
} = require('./lib/integrations/external-proxy-config');
const { DesktopLocaleRuntime } = require('./lib/platform/i18n/i18n');
const { RoutingPolicyCoordinator, RoutingPolicyTransactionQueue } = require('./lib/routing/rules/routing-policy-transaction');
const { stopEngineAfterBrowserSuspend } = require('./lib/switching/effects/browser-engine-barrier');
const { ConnectionStateMachine, ConnectionWaitRegistry, ConnectionOperationCoordinator, ConnectionStatusRuntime } = require('./lib/connection/state/connection-state-machine');
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
DesktopPersistenceRuntime.discardStartupProxySidecar(legacyRuntimeStoragePaths.proxyHelperCredential, fs);
const activeSchoolProfile = createPreReadySchoolProfileController({
  userData: DATA,
  packageRoot: __dirname, isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath, desktopDir: __dirname,
  profileStorageEffects,
});
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
DesktopPersistenceRuntime.discardStartupProxySidecar(PROXY_HELPER_CREDENTIAL, fs);
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
    onRecovery: notice => persistenceRuntime.observeSettingsRecovery(notice),
  }),
  settingsPresentation: {
    getState: () => state,
    translate: (key) => t(key),
    emit,
    getAdditionalNotice: () => persistenceRuntime.settingsRecoveryNoticeText,
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
const vpnCredentialAccess = DesktopPersistenceRuntime.createVpnCredentialAccess({
  persistence: persistenceRuntime, safeStorage, platform: process.platform,
  getProfileId: () => activeSchoolProfile.activeContextBinding().profileId,
  getEngineActive: () => engineSupervisor.hasActive,
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
let telemetryCoordinator = null;
const connectionStatus = new ConnectionStatusRuntime({
  connectionState, waitRegistry: connectionWaitRegistry, getPacUrl: pacUrl,
  getShell: () => desktopShell, getLocale: () => desktopLocale.locale,
  getUpdate: () => updateNotifications?.snapshot(), translate: (key) => t(key),
  clearCapabilities: () => activeSchoolProfile.clearCapabilitySnapshot(),
  getTelemetry: () => telemetryCoordinator, now: () => Date.now(),
  isEngineCurrent: (generation, token) => activeEngineContextCurrent(generation, token),
});
const state = connectionStatus.state;
function statusSnapshot() { return connectionStatus.snapshot(); }
function reportLogFailure() { return connectionStatus.reportLogFailure(); }
const engineApplication = createEngineApplicationRuntime({ spawnProcess: spawn, authChallenge: {
  isContextCurrent: (token) => activeContextLease.isContextCurrent(token),
  publish: (challenge) => {
    desktopShell?.send('auth-challenge', challenge);
  },
} });
const { authChallenges: authChallengeCoordinator, controlRegistry: engineControlRegistry,
  supervisor: engineSupervisor } = engineApplication;
const activeEngineContextCurrent = (generation, token) => engineSupervisor.isCurrent(generation) &&
  activeContextLease.isCurrent(token, { connectionIntent: connectionState.snapshot().intent, engineGeneration: generation });
const routingPolicyTransactions = new RoutingPolicyTransactionQueue({ isContextCurrent: (token) => activeContextLease.isContextCurrent(token) });
function runActiveContextTransaction(options) { return routingPolicyTransactions.run(activeContextLease.captureContext(), options); }
let logWriter = null;
function initializeLogWriter() {
  logWriter = new BufferedLogWriter(LOG, { onError: reportLogFailure, onRecovered: () => connectionStatus.reportLogRecovered() });
}
const proxyAccess = DesktopPersistenceRuntime.createProxyAccess({
  credentialStore: { filePath: PROXY_CREDENTIAL, safeStorage, platform: process.platform },
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
  loadResources: ResourceLibraryRuntime.createSource({
    loadSettings: loadSettingsOrReport,
    mergeResources: (custom, hidden) => activeSchoolProfile.mergeResourceLibrary(custom, hidden),
    resolveRoute: (url) => domainRoutePolicy.resolve(url),
    onReadFailure: reportSettingsReadFailure,
  }),
  loadAliases: (settings) => activeSchoolProfile.resourceActivityAliases((settings || loadSettingsOrReport()).customResources),
  captureContext: () => activeContextLease.captureContext(),
  isContextCurrent: (context) => activeContextLease.isContextCurrent(context),
  openRequest: (request) => campusBrowserManager.open(request),
  runTransaction: runActiveContextTransaction,
  getLocale: () => desktopLocale.locale,
  translate: (key) => t(key),
});
// Last known "newer release exists" result. Failures never land here, so the
// renderer can render it without distinguishing network errors from silence.
let updateNotifications = null;
const desktopLocale = new DesktopLocaleRuntime({
  readSettings: loadSettings, getSystemLocale: () => app.getLocale(),
});
function t(key, vars) { return desktopLocale.translator(key, vars); }

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
function currentLocale() { return desktopLocale.current(); }
function assertSettingsPersistenceAvailable() {
  persistenceRuntime.assertCredentialTransactionAvailable();
}
function routingSettings() { return persistenceRuntime.routingSettings(); }
function saveSettings(settings) { return persistenceRuntime.saveSettingsWithGuard(settings); }
function savePassword(pw, username) { return persistenceRuntime.saveCredential(pw, username); }
function hasStoredCredential() { return vpnCredentialAccess.hasStored(); }
function hasCredentialForCurrentSession() { return vpnCredentialAccess.hasCredentialForCurrentSession(); }
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
function safeCampusResourceLibrary(settings = null) {
  return resourceLibraryRuntime.listLocalized(settings, desktopLocale.locale);
}
const certificateTrustStore = CampusBrowserManager.createCertificateTrustStore({
  filePath: CAMPUS_CERTIFICATE_TRUST,
});
const domainRoutePolicy = new DomainRoutePolicyStore({
  filePath: ROUTING_RULES,
  // Browser webRequest executes for every main-frame and subresource request.
  // The app is the sole settings writer, so an immutable snapshot updated by
  // saveSettings() avoids re-reading the complete Profile/Account/Workspace
  // authority (and Windows ACLs) on that hot path.
  customResources: () => routingSettings().customResources,
  schoolDomains: () => routingSettings().routeDomains,
  directPartnerDomains: () => activeSchoolProfile.directPartnerDomains,
  serverResources: activeSchoolProfile.mergeResourceLibrary([], []),
});
// ---------- engine ----------
function nativeResourcePath(kind) {
  return resolveNativeResourcePath({ kind, appIsPackaged: app.isPackaged,
    baseDirectory: __dirname, resourcesPath: process.resourcesPath });
}
function enginePath() { return nativeResourcePath('ec-engine'); }
function gatewayProbePath() { return nativeResourcePath('ec-gateway-probe'); }
function emit() { return connectionStatus.emit(); }

// The gateway permits one session per account. Stop an orphaned independent
// engine before starting the new owned child.
function killStrayEngines(resolvedEnginePath) {
  return engineApplication.cleanupOrphaned({ platform: process.platform,
    executablePath: resolvedEnginePath, ownerFile: ENGINE_OWNER });
}

function clearConnectionPresentation() { return connectionStatus.clear(); }
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
  onOnline: () => connectivityRecovery.networkOnline(), shouldAutoConnect: createStartupAutoConnectEligibility({ readSettings: loadSettingsOrReport, hasPersistentCredential: () => vpnCredentialAccess.hasPersistent() }),
  pauseOffline: () => { connectivityRecovery.cancel(); const intent = connectionState.beginConnectIntent(); return connectivityRecovery.networkOffline(intent) ? intent : null; },
  resumeInitialOffline: (intent) => connectivityRecovery.initialNetworkOnline(intent), connect: () => connect(), isQuitting: () => desktopShell?.isQuitting === true, onPublicEgress: (snapshot) => desktopShell?.send('network-environment', snapshot),
});
const connectionOperations = new ConnectionOperationCoordinator({
  connectionState, engineSupervisor, isQuitting: () => desktopShell?.isQuitting === true,
  loadSettingsOrReport,
  cancelRecovery: () => { networkStartupCoordinator?.cancel(); connectivityRecovery.cancel(); },
  clearProxyCredential: clearActiveProxyCredential, clearPresentation: clearConnectionPresentation,
  removeSidecar: removeExternalProxySidecar, getPresentation: () => state, getTranslator: () => desktopLocale.translator, emit,
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
const engineTermination = engineApplication.createTermination({
  connectionState,
  getPresentation: () => state, getConnectedAt: () => connectionStatus.connectedAt, getTranslator: () => desktopLocale.translator,
  now: () => Date.now(),
  cleanupProxyAccess: DesktopPersistenceRuntime.cleanupProxyAccessForEngineClose,
  clearCredential: clearActiveProxyCredential, removeSidecar: removeExternalProxySidecar,
  suspendBrowser: suspendOpenBrowserPolicy, clearPresentation: clearConnectionPresentation,
  loadSettings, reportSettingsReadFailure, emit, connect: (retry, intent) => connect(retry, intent),
});
function handleEngineClose(...args) { return engineTermination.close(...args); }
function revokeEngineServing(...args) { return engineTermination.revokeServing(...args); }
function handleEngineExitBoundary(...args) { return engineTermination.exit(...args); }
const engineAttempts = engineApplication.createAttempt({
  connectionState, appIsPackaged: app.isPackaged, baseDirectory: __dirname,
  getState: () => state, getTranslator: () => desktopLocale.translator, getLogWriter: () => logWriter,
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
  openCredential: profileId => vpnCredentialAccess.open(profileId),
  credentialLoadErrorKey: status => vpnCredentialAccess.errorKey(status),
  parseCredentialField: (value, label) => vpnCredentialAccess.parseField(value, label), enginePath,
  clearActiveProxyCredential, generationProxyCredential, removeExternalProxySidecar, killStrayEngines,
  hasStableProxyCredential: () => proxyAccess.hasStable(), proxyCredentialFile: PROXY_CREDENTIAL,
  setActiveProxyCredential: value => proxyAccess.setActive(value), engineOwnerFile: ENGINE_OWNER,
  activeEngineContextCurrent, getBrowser: () => campusBrowserManager, revokeEngineServing,
  handleEngineExitBoundary, handleEngineClose,
  contextLease: { capture: options => activeContextLease.capture(options) },
  onFirstConnected: (generation, token) => connectionStatus.firstConnected(generation, token),
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
  homeUrl: officialPortalHomeUrl(activeSchoolProfile.createPresentation({ locale: desktopLocale.locale }).schoolProfile, safeCampusResourceLibrary()),
  browserPartition: preReadyStorage.authority?.layout?.browserPartition || activeSchoolProfile.browserPartition,
  routingPolicy: browserRoutingPolicy,
  ensureCampusReady: () => connectionOperations.ensureBrowserReady(),
  resolveRoute: (url) => domainRoutePolicy.resolve(url),
  ensureConnected: () => connectionOperations.ensureBrowserConnected(),
  getSocksPort: socksPort, getNewTabUrl: () => loadSettingsOrReport().browserNewTabUrl,
  getLocale: () => desktopLocale.locale,
  getTranslator: () => desktopLocale.translator,
  getProfilePresentation: () => activeSchoolProfile.createPresentation({ locale: desktopLocale.locale }).schoolProfile, getWorkspaceResources: () => safeCampusResourceLibrary(), getWorkspaceGroups: () => resourceLibraryRuntime.listGroups(), getSharedPortalCredential: (origin) => origin === 'https://sso.hkust-gz.edu.cn' && activeSchoolProfile.activeContextBinding().profileId === 'hkustgz' ? persistenceRuntime.openCredential() : null,
  onTogglePageFavorite: (candidate) => pageFavoriteController.toggle(candidate).catch((error) => ({ ok: false, error: error.message })), onRecordPageOpen: (url) => (resourceLibraryRuntime.recordOpenByUrl(url) && (emit(), true)), onOpenResource: (resourceId) => resourceLibraryRuntime.openByIdSerialized({ resourceId }), onWorkspaceMutation: (command) => pageFavoriteController.handleWorkspaceCommand(command),
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
    clearServerState: () => { vpnCredentialAccess.clear(); domainRoutePolicy.clearServerResources(); state.lastError = null;
      state.browserNotice = null; clearConnectionPresentation(); return true; },
    closeLog: () => logWriter?.close().catch(reportLogFailure),
  },
});
const switchSchoolProfile = profileSwitching.switchProfile;
// ---------- update notifications (no automatic download or installation) ----------
updateNotifications = new UpdateNotificationRuntime({
  getVersion: () => app.getVersion(), check: (version, options) => checkForUpdate(version, undefined, options),
  readSettings: loadSettingsOrReport, saveSettings,
  assertPersistence: assertSettingsPersistenceAvailable,
  runTransaction: runActiveContextTransaction, onAvailable: emit,
  openExternal: url => shell.openExternal(url),
});

// ---------- IPC ----------
const CONTROL_RENDERER_FILE = path.join(__dirname, 'renderer', 'index.html'), CAMPUS_WORKSPACE_RENDERER_FILE = path.join(__dirname, 'renderer', 'campus-workspace.html');
const cardBoard = require('./lib/app/card-board-main-runtime').createCardBoardMainRuntime({ favoritesFile: RESOURCE_FAVORITES, platform: process.platform, ipcMain, allowedFiles: [CONTROL_RENDERER_FILE, CAMPUS_WORKSPACE_RENDERER_FILE], getResources: safeCampusResourceLibrary, getGroups: () => resourceLibraryRuntime.listGroups(), runTransaction: runActiveContextTransaction, onChanged: (document) => { desktopShell?.send('card-board-layout-changed', document); campusBrowserManager?.browser?.refreshCardBoardLayout(document); } });
const trustedHandle = createTrustedControlRegistrar({
  ipcMain,
  getWebContents: () => desktopShell?.webContents || null,
  allowedFiles: [CONTROL_RENDERER_FILE],
});

const controlStateSnapshot = createControlStateSnapshot({
  getStatus: statusSnapshot, loadSettings: loadSettingsOrReport,
  hasCredential: hasCredentialForCurrentSession,
  hasAccountIdentity: () => persistenceRuntime.hasAccountIdentity() ||
    vpnCredentialAccess.hasOneShot() || engineSupervisor.hasActive,
  getPacUrl: pacUrl, getLocale: () => desktopLocale.locale, platform: process.platform,
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
  schools: { onboarding: schoolProfileOnboarding, getLocale: () => desktopLocale.locale,
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
    desktopLocale.choose(language);
    desktopShell?.installApplicationMenu();
    campusBrowserManager.setLocale(desktopLocale.locale, desktopLocale.translator);
    emit();
  },
  setStartAtLogin: (enabled) => {
    try { app.setLoginItemSettings({ openAtLogin: enabled }); } catch {}
  },
  hasActiveEngine: () => engineSupervisor.hasActive,
  reconnect,
  disconnect,
  getActiveProfileId: () => activeSchoolProfile.activeContextBinding().profileId,
  credentialStorageAvailable: () => vpnCredentialAccess.storageAvailable(),
  stageOneShotCredential: (request) => vpnCredentialAccess.stage(request),
  clearOneShotCredential: (revision) => vpnCredentialAccess.clear(revision),
});
registerCoreControlIpc({
  register: trustedHandle, getState: controlStateSnapshot, getNetworkEnvironment: () => networkEnvironmentService.snapshot(loadSettingsOrReport().underlaySourceAddress, { probePublicEgress: true }),
  getLoginAccount: () => vpnCredentialAccess.loginAccount(loadSettingsOrReport),
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
  openCampusBrowser: (request) => campusBrowserManager.openWithFeedback(request), openBookmarkManager: () => campusBrowserManager.openBookmarkManager(),
  openResource: (request) => resourceLibraryRuntime.openByIdSerialized(request),
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
  openCampusBrowser: () => campusBrowserManager.openWithFeedback(),
  rememberCloseAction,
  disposeLifecycle: () => {
    updateNotifications?.dispose(); schoolProfileOnboarding.cancel(); externalIntegrationRuntime.cancel();
    vpnCredentialAccess.clear();
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
  getConnectedAt: () => connectionStatus.connectedAt,
  send: (snapshot) => desktopShell.send('telemetry', snapshot),
  getAutoReconnect: () => loadSettingsOrReport().autoReconnect,
  isDesiredConnected: () => connectionState.snapshot().desiredConnected,
  reconnect: (generation, token) => activeEngineContextCurrent(generation, token)
    ? reconnect(generation)
    : Promise.resolve({ ok: false, stale: true }),
  onRecovering: (generation, token) => connectionStatus.reportRecovering(generation, token),
});
app.on('second-instance', () => desktopShell.showWindow());
const browserRequestSecurity = CampusBrowserManager.createRequestSecurityBoundary({
  getBrowser: () => campusBrowserManager,
  getEngineGeneration: () => engineSupervisor.currentGeneration,
  proxyAccess,
});
app.on('certificate-error', browserRequestSecurity.certificateError);
app.on('login', browserRequestSecurity.proxyLogin);
const desktopStartup = new DesktopStartupRuntime({
  profileSwitching, persistenceRuntime, customProfileDeletion,
  assertSwitchStartupClear: () => assertActiveContextSwitchStartupClear({
    mode: preReadyStorage.mode, filePath: ACTIVE_CONTEXT_SWITCH, profileStorageEffects,
  }),
  relaunchPersistence: () => relaunchAfterPersistenceMigration({ application: app, argv: process.argv,
    isPackaged: app.isPackaged, developmentEntry: __dirname }),
  initializeMultiSchoolStartup: () => initializeMultiSchoolStartup(persistenceRuntime, activeSchoolProfile),
  initializeLogWriter, getLogWriter: () => logWriter,
  writeMarkers: () => {
    writePersistenceE2EMarker({ application: app, environment: process.env, userData: DATA, mode: persistenceRuntime.mode });
    writeProfileSwitchE2EMarker({ application: app, environment: process.env, userData: DATA, ...activeSchoolProfile.activeContextBinding() });
  },
  currentLocale, fallbackLocale: () => desktopLocale.fallback(),
  setLocale: value => desktopLocale.set(value),
  loadSettings, reportSettingsReadFailure,
  getSettingsRecoveryNotice: () => persistenceRuntime.settingsRecoveryNotice,
  setSettingsRecoveryNoticeText: value => persistenceRuntime.setSettingsRecoveryNoticeText(value),
  getPresentation: () => state, translate: (key, vars) => t(key, vars),
  desktopShell, refreshPacFile, powerMonitor, connectivityRecovery,
  networkStartupCoordinator, updateNotifications, isPackaged: app.isPackaged,
  onActivate: handler => app.on('activate', handler),
});
app.whenReady().then(() => desktopStartup.run()).catch((error) => {
  dialog.showErrorBox(t('error.startupTitle'), String(error && error.message ? error.message : error));
  app.exit(1);
});
app.on('window-all-closed', () => { /* Keep the tray process alive. */ });
app.on('before-quit', (event) => {
  if (desktopShell.quitAllowed) return;
  event.preventDefault();
  desktopShell.requestQuit();
});
app.on('will-quit', () => updateNotifications?.dispose());
