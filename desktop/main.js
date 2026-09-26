'use strict';
const {
  app, BrowserWindow, WebContentsView, ipcMain, shell, Menu, clipboard, safeStorage, session,
  Tray, nativeImage, dialog, powerMonitor, net: electronNet,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');
const { loadSettings: readSettings, saveSettings: writeSettings } = require('./lib/persistence/settings/settings-store');
const { parseCredentialField } = require('./lib/persistence/settings/settings-update');
const {
  credentialLoadErrorKey,
  hasStoredPassword,
  loadPasswordResult: readPasswordResult,
  protectedStorageAvailable,
  restorePasswordSnapshot,
  savePassword: writePassword,
} = require('./lib/persistence/credentials/credential-store');
const {
  OneShotVpnCredentialBroker,
} = require('./lib/persistence/credentials/one-shot-vpn-credential');
const {
  recoverCredentialSettingsTransaction,
  runCredentialSettingsMutation,
} = require('./lib/persistence/credentials/credential-settings-transaction');
const { desktopRuntimeComposition } = require('./lib/app/desktop-runtime-composition');
const { ActiveContextLease, assertActiveContextSwitchStartupClear, createLegacyRuntimeStoragePaths, createMainProfileSwitchComposition, createMultiSchoolStartupInitializer, createPageFavoriteController, customGatewayProductAvailability, DesktopPersistenceRuntime, LegacyMigrationCredentialOwner, ProfileWorkspaceStartupRuntime, relaunchAfterPersistenceMigration, ResourceLibraryRuntime, resolveUserDataOverride, selectProfileWorkspacePreReadyStorage, writePersistenceE2EMarker, writeProfileSwitchE2EMarker } = desktopRuntimeComposition;
const {
  classifyEngineCode,
  classifyEngineOutput,
  classifyEngineStopReason, formatEngineEventDiagnostic,
  resolveEngineFailureKind,
} = require('./lib/connection/engine/engine-output');
const { AuthChallengeCoordinator, EngineControlRegistry } = require('./lib/connection/engine/engine-control-suite');
const { EngineConnectionRuntime } = require('./lib/connection/engine/engine-connection-runtime');
const { DesktopShell } = require('./lib/platform/shell/desktop-shell');
const { SYNTHETIC_ENGINE_E2E_ENV, resolveEngineLaunch, resolveGatewayProbeLaunch, resolveNativeResourcePath } = require('./lib/connection/engine/engine-process');
const {
  EngineSupervisor,
  cleanupOrphanedEngine,
  removeEngineOwnerRecord,
  writeEngineOwnerRecord,
} = require('./lib/connection/engine/engine-supervisor');
const { ConnectionTelemetryCoordinator } = require('./lib/connection/telemetry/connection-telemetry-coordinator');
const { DomainRoutePolicyStore } = require('./lib/routing/policy/domain-route-policy');
const { savePacFile } = require('./lib/routing/pac/pac-file');
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
const { ensureOwnerOnly } = require('./lib/platform/storage/private-file');
const { BufferedLogWriter, readLogTail } = require('./lib/diagnostics/logging/log-writer');
const { STOP_GRACE_MS, STOP_FORCE_WAIT_MS } = require('./lib/connection/state/stop-policy');
const { AUTO_CHECK_INTERVAL_MS, checkForUpdate, isCurrentUpdateUrl, shouldAutoCheck } = require('./lib/platform/update/update-check');
const { ConnectivityRecovery } = require('./lib/connection/recovery/connectivity-recovery');
const { createNetworkStartupSystem } = require('./lib/connection/telemetry/network-status-monitor');
const { EphemeralProxyCredential, cleanupProxyAccessForEngineClose } = require('./lib/persistence/credentials/proxy-credential');
const {
  ExternalProxyCredentialStore,
} = require('./lib/persistence/credentials/external-proxy-credential-store');
const {
  ensureProxyCredentialSidecar,
  externalProxyHelperPath,
} = require('./lib/integrations/external-proxy-config');
const {
  CampusCertificateTrustStore,
} = require('./lib/browser/certificates/campus-certificate-trust');
const { routeCertificateError } = require('./lib/browser/certificates/certificate-error-boundary');
const { createT, effectiveLocale } = require('./lib/platform/i18n/i18n');
const { registerTrustedIpcHandlers } = require('./lib/ipc/ipc-handlers');
const { RoutingPolicyTransactionQueue } = require('./lib/routing/rules/routing-policy-transaction');
const { stopEngineAfterBrowserSuspend } = require('./lib/switching/effects/browser-engine-barrier');
const { ConnectionStateMachine, ConnectionWaitRegistry, projectConnectionStatus } = require('./lib/connection/state/connection-state-machine');
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
const CREDENTIAL_TRANSACTION = runtimeStoragePaths.credentialTransaction;
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
const credentialTransactionPaths = Object.freeze({
  settings: SETTINGS,
  settingsBackup: `${SETTINGS}.bak`,
  credential: CRED,
});
// This must run before any loadSettings(), credential read, or blanket chmod.
// In particular, chmodding an attacker-replaced broad-permission journal
// first would erase the evidence that makes recovery fail closed.
let credentialTransactionRecovery = preReadyStorage.mode === 'legacy-flat'
  ? recoverCredentialSettingsTransaction(CREDENTIAL_TRANSACTION, credentialTransactionPaths)
  : { ok: true, status: 'none' };
let credentialTransactionBlocked = credentialTransactionRecovery.status === 'blocked';
for (const privateFile of [
  SETTINGS, CRED, LOG, PAC_FILE, CAMPUS_BROWSER_PAC_FILE, ROUTING_RULES,
  CAMPUS_CREDENTIALS, CAMPUS_CERTIFICATE_TRUST, ENGINE_OWNER,
  RESOURCE_FAVORITES, RESOURCE_RECENTS,
  PROXY_CREDENTIAL, PROXY_HELPER_CREDENTIAL,
]) {
  ensureOwnerOnly(privateFile);
}

let desktopShell = null;
let campusBrowserManager = null;
let connectInFlight = null;
let disconnectInFlight = null;
let reconnectInFlight = null;
const connectionState = new ConnectionStateMachine();
const connectionWaitRegistry = new ConnectionWaitRegistry();
connectionWaitRegistry.observe(connectionState.snapshot());
const MAX_ATTEMPTS = 3;
// The reviewed Engine can spend up to roughly 52 seconds in bounded Modern
// data-plane setup retries after authentication. Browser readiness must not
// report a timeout while that same, still-current attempt can legitimately
// reach listener_ready.
const BROWSER_CONNECTION_READY_TIMEOUT_MS = 75_000;
let connectedAt = null;
let telemetryCoordinator = null;
let activeProxyCredential = null;
let stableProxyCredential = null;
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
let updateInfo = null;
// UI locale follows the OS; Chinese stays the fallback until whenReady reads
// the real locale, so early failures still render a coherent language.
let locale = 'zh';
let t = createT(locale);
let settingsRecoveryNotice = null;
let settingsRecoveryNoticeText = null;
let settingsReadErrorText = null;
let credentialRecoveryNoticeText = null;
let credentialRecoveryErrorText = null;

// ---------- settings & credentials ----------
function loadLegacySettings() {
  return readSettings(SETTINGS, {
    onRecovery: (notice) => { settingsRecoveryNotice = notice; },
    defaultRouteDomains: activeSchoolProfile.defaultRouteDomains,
  });
}
function saveLegacySettings(settings) {
  return writeSettings(SETTINGS, settings, {
    defaultRouteDomains: activeSchoolProfile.defaultRouteDomains,
  });
}
function openLegacyCredential() {
  const settings = loadLegacySettings();
  const result = readPasswordResult(CRED, safeStorage, process.platform);
  if (result.status === 'missing') return null;
  if (result.status !== 'decrypted') {
    const error = new Error('legacy credential is unavailable');
    error.credentialStatus = result.status;
    throw error;
  }
  return new LegacyMigrationCredentialOwner(settings.username, result.password);
}
const persistenceRuntime = new DesktopPersistenceRuntime({
  preReadySelection: preReadyStorage,
  initializeAfterReady: () => activeSchoolProfile.withProfileDocument((profile) => (
    new ProfileWorkspaceStartupRuntime({
      userData: DATA, profile, safeStorage, platform: process.platform,
    }).initialize()
  )),
  legacy: {
    loadSettings: loadLegacySettings,
    saveSettings: saveLegacySettings,
    saveCredential: (password) => writePassword(CRED, password, safeStorage, process.platform),
    clearCredential: () => restorePasswordSnapshot(CRED, { existed: false, data: null }),
    openCredential: openLegacyCredential,
    hasCredential: () => hasStoredPassword(CRED, process.platform),
  },
});
const initializeMultiSchoolStartup = createMultiSchoolStartupInitializer({ userData: DATA, packageRoot: __dirname, isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, desktopDir: __dirname }); const customProfileDeletion = createCustomProfileDeletionRuntime({ userData: DATA, withCandidateDirectory: (callback) => initializeMultiSchoolStartup.withDirectory(callback), electronSession: session });
const schoolProfileOnboarding = createSchoolProfileOnboardingRuntime({ userData: DATA, probeLaunch: resolveGatewayProbeLaunch({ appIsPackaged: app.isPackaged, baseDirectory: __dirname, nativeProbe: gatewayProbePath(), execPath: process.execPath }), spawnProcess: spawn,
  getActiveContext: () => activeSchoolProfile.activeContextBinding(), listProfiles: (options) => initializeMultiSchoolStartup.listViews(options),
  onDiagnostic: (code) => logWriter?.append(`[profile-onboarding] ${code}\n`),
});
const customGatewayOnboardingEnabled = customGatewayProductAvailability();
function loadSettings() { return persistenceRuntime.loadSettings(); }
function reportSettingsReadFailure(cause, { emitState = true } = {}) {
  if (cause?.code === 'SETTINGS_READ_FAILED') return cause;
  const message = t('error.settingsReadFailed');
  const error = new Error(message, { cause });
  error.code = 'SETTINGS_READ_FAILED';
  error.userMessage = message;
  settingsReadErrorText = message;
  if (state.settingsError !== message) {
    state.settingsError = message;
    if (emitState) emit();
  }
  return error;
}
function loadSettingsOrReport(options) {
  try {
    const settings = loadSettings();
    if (settingsReadErrorText) {
      const shouldEmit = options?.emitState !== false && state.settingsError === settingsReadErrorText;
      if (state.settingsError === settingsReadErrorText) state.settingsError = null;
      settingsReadErrorText = null;
      if (shouldEmit) emit();
    }
    return settings;
  }
  catch (error) { throw reportSettingsReadFailure(error, options); }
}
// The saved language override ('zh'/'en') wins over the OS locale; 'auto'
// follows the system, and Chinese remains the fallback when both are silent.
function currentLocale() {
  return effectiveLocale(loadSettings().language, app.getLocale());
}
function assertSettingsPersistenceAvailable() {
  // Never overwrite a settings snapshot that the credential transaction must
  // still restore. All settings/resource/routing writers pass this boundary,
  // so a blocked startup recovery is fail-closed for persistence as well as
  // for connection attempts.
  if (credentialTransactionBlocked) {
    const recovery = retryCredentialTransactionRecovery();
    if (recovery.status === 'blocked') {
      const message = t('error.credentialRecoveryBlocked');
      const error = new Error(message);
      error.code = 'CREDENTIAL_RECOVERY_BLOCKED';
      error.userMessage = message;
      throw error;
    }
  }
}
let routingSettingsSnapshot = null;
function routingSettings() {
  if (!routingSettingsSnapshot) routingSettingsSnapshot = loadSettingsOrReport();
  return routingSettingsSnapshot;
}
function saveSettings(settings) {
  assertSettingsPersistenceAvailable();
  const saved = persistenceRuntime.saveSettings(settings);
  routingSettingsSnapshot = saved;
  return saved;
}
function savePassword(pw, username) { return persistenceRuntime.saveCredential(pw, username); }
function hasPersistentCredential() {
  return !credentialTransactionBlocked && persistenceRuntime.hasCredential();
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
function syncRecoveryNotice(emitState = true) {
  state.notice = [settingsRecoveryNoticeText, credentialRecoveryNoticeText]
    .filter(Boolean)
    .join('\n') || null;
  if (emitState) emit();
}
function applyCredentialRecoveryOutcome(recovery, {
  emitState = true,
  clearedNoticeKey = 'error.credentialRecoveryCleared',
  clearNotice = false,
} = {}) {
  credentialTransactionRecovery = recovery;
  const recoverySafe = recovery?.status === 'credential-cleared' || (
    recovery?.ok === true && ['none', 'recovered', 'committed'].includes(recovery.status)
  );
  credentialTransactionBlocked = !recoverySafe;

  if (credentialRecoveryErrorText && state.recoveryError === credentialRecoveryErrorText) {
    state.recoveryError = null;
  }
  credentialRecoveryErrorText = null;
  if (credentialTransactionBlocked) {
    credentialRecoveryNoticeText = null;
    credentialRecoveryErrorText = t('error.credentialRecoveryBlocked');
    state.recoveryError = credentialRecoveryErrorText;
  } else if (recovery?.status === 'recovered') {
    credentialRecoveryNoticeText = t('error.credentialRecoveryRecovered');
  } else if (recovery?.status === 'credential-cleared') {
    credentialRecoveryNoticeText = t(clearedNoticeKey);
  } else if (clearNotice) {
    credentialRecoveryNoticeText = null;
  }
  syncRecoveryNotice(emitState);
  return recovery;
}
function retryCredentialTransactionRecovery() {
  if (preReadyStorage.mode === 'profile-workspace') {
    return applyCredentialRecoveryOutcome({ ok: true, status: 'none' });
  }
  return applyCredentialRecoveryOutcome(recoverCredentialSettingsTransaction(
    CREDENTIAL_TRANSACTION,
    credentialTransactionPaths,
  ));
}
function runPersistenceCredentialMutation(options) {
  if (preReadyStorage.mode === 'legacy-flat') return runCredentialSettingsMutation(options);
  try { return { ok: true, value: options.mutate() }; }
  catch (error) { return { ok: false, phase: 'mutation', error, recovery: { ok: true, status: 'none' } }; }
}
function socksPort() { return Number(loadSettingsOrReport().port) || 1080; }
function clearActiveProxyCredential(expectedGeneration = null) {
  if (!activeProxyCredential) return false;
  if (!activeProxyCredential.destroy(expectedGeneration)) return false;
  activeProxyCredential = null;
  return true;
}
const clearActiveEngineControl = (expectedGeneration = null) => engineControlRegistry.clear(expectedGeneration);
const requestActiveEngineControlShutdown = () => engineControlRegistry.shutdown();
function loadStableProxyCredential() {
  if (stableProxyCredential) return stableProxyCredential;
  stableProxyCredential = externalProxyCredentialStore.loadOrCreate();
  return stableProxyCredential;
}
function removeExternalProxySidecar() {
  try {
    fs.unlinkSync(PROXY_HELPER_CREDENTIAL);
    return true;
  } catch (error) {
    return error?.code === 'ENOENT';
  }
}
function revokeExternalProxyAccess() { clearActiveProxyCredential(); const removed = removeExternalProxySidecar(); stableProxyCredential?.destroy(); stableProxyCredential = null; return removed && activeProxyCredential === null; }
function ensureExternalProxyAccess(port) {
  const credential = loadStableProxyCredential();
  ensureProxyCredentialSidecar({
    filePath: PROXY_HELPER_CREDENTIAL,
    port,
    credential, profileId: activeSchoolProfile.activeContextBinding().profileId,
    platform: process.platform,
  });
  return credential;
}
function generationProxyCredential(port) {
  const stable = ensureExternalProxyAccess(port);
  const injected = stable.copyForEngine();
  try {
    return new EphemeralProxyCredential({ credential: injected });
  } finally {
    injected.username.fill(0);
    injected.password.fill(0);
  }
}
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
  desktopShell?.send('status', { ...statusSnapshot(), locale, update: updateInfo });
  desktopShell?.updateTray();
}

// The gateway permits one session per account. Stop an orphaned independent
// engine before starting the new owned child.
function killStrayEngines(resolvedEnginePath) {
  return cleanupOrphanedEngine({ platform: process.platform,
    executablePath: resolvedEnginePath, ownerFile: ENGINE_OWNER });
}

function beginLifecycleIntent() {
  // A manual connect/disconnect/reconnect always supersedes any recovery that
  // was queued for a previous sleep or network outage.
  networkStartupCoordinator?.cancel();
  connectivityRecovery.cancel();
  return connectionState.beginConnectIntent();
}
function clearConnectionPresentation() {
  connectedAt = null;
  state.clientIp = null;
  state.dnsMode = 'unknown'; activeSchoolProfile.clearCapabilitySnapshot();
  telemetryCoordinator?.stop();
}
function invalidateForConnectivity(reason, intent) {
  if (!connectionState.pauseForConnectivity(intent, {
    isQuitting: desktopShell?.isQuitting === true,
  })) return;
  // Keep the lifecycle intent stable: resume/online is allowed to recover
  // this exact user-requested connection, while generation invalidation makes
  // every old engine event, retry, and health probe inert immediately.
  engineSupervisor.invalidate();
  clearConnectionPresentation();
  state.lastError = t(reason === 'suspend'
    ? 'error.connectionSuspended'
    : 'error.networkUnavailable');
  emit();
  ensureEngineStopped().then((result) => {
    if (!connectionState.canContinue(intent) || result.ok) return;
    state.lastError = t('error.engineStuck');
    emit();
  }).catch(() => {});
}
async function recoverConnectivity(intent, reason) {
  let autoReconnect;
  try {
    autoReconnect = reason === 'initial-network-online' || loadSettingsOrReport().autoReconnect !== false;
  } catch {
    connectionState.failIntent(intent);
    emit();
    return false;
  }
  if (!connectionState.canRecover(intent, {
    isQuitting: desktopShell?.isQuitting === true,
    autoReconnect,
  })) return false;
  const stopped = await ensureEngineStopped();
  if (!stopped.ok || stopped.cleanExit === false || !connectionState.canContinue(intent, {
    isQuitting: desktopShell?.isQuitting === true,
  })) {
    if ((!stopped.ok || stopped.cleanExit === false) &&
        connectionState.isCurrentIntent(intent)) {
      connectionState.failIntent(intent);
      state.lastError = t(stopped.cleanExit === false
        ? 'error.engineCleanupUnconfirmed'
        : 'error.engineStuck');
      emit();
    }
    return false;
  }
  if (!connectionState.resumeConnectivity(intent, {
    isQuitting: desktopShell?.isQuitting === true,
    autoReconnect,
  })) return false;
  const result = await connect(false, intent);
  return result.ok === true;
}

const connectivityRecovery = new ConnectivityRecovery({
  invalidate: invalidateForConnectivity,
  getLifecycleIntent: () => connectionState.currentRecoveryIntent({
    isQuitting: desktopShell?.isQuitting === true,
  }),
  shouldReconnect: async (intent, reason) => {
    try {
      return connectionState.canRecover(intent, {
        isQuitting: desktopShell?.isQuitting === true,
        autoReconnect: reason === 'initial-network-online' || loadSettingsOrReport().autoReconnect !== false,
      });
    } catch {
      connectionState.failIntent(intent);
      emit();
      return false;
    }
  },
  reconnect: recoverConnectivity, onRecoveryDeclined: (intent, reason) => { if (reason !== 'initial-network-online' && connectionState.failIntent(intent)) emit(); },
});
const { monitor: networkStatusMonitor, startup: networkStartupCoordinator, environment: networkEnvironmentService } = createNetworkStartupSystem({
  appIsPackaged: app.isPackaged, environment: process.env, dataDirectory: DATA, fileSystem: fs,
  isOnline: () => electronNet.isOnline(), onOffline: () => connectivityRecovery.networkOffline(),
  onOnline: () => connectivityRecovery.networkOnline(), shouldAutoConnect: () => { const s = loadSettingsOrReport(); return s.autoConnect !== false && Boolean(s.username) && hasPersistentCredential(); },
  pauseOffline: () => { connectivityRecovery.cancel(); const intent = connectionState.beginConnectIntent(); return connectivityRecovery.networkOffline(intent) ? intent : null; },
  resumeInitialOffline: (intent) => connectivityRecovery.initialNetworkOnline(intent), connect: () => connect(), isQuitting: () => desktopShell?.isQuitting === true, onPublicEgress: (snapshot) => desktopShell?.send('network-environment', snapshot),
});
function rejectConnectionWhileQuitting(intent = connectionState.snapshot().intent) {
  if (desktopShell?.isQuitting !== true) return null;
  connectionState.failIntent(intent); emit();
  return { ok: false, stale: true, quitting: true, intent };
}
async function connect(isRetry = false, expectedIntent = null) {
  let rejected = rejectConnectionWhileQuitting(expectedIntent ?? undefined); if (rejected) return rejected;
  let intent = expectedIntent;
  if (intent === null && !isRetry) {
    if (disconnectInFlight) await disconnectInFlight;
    rejected = rejectConnectionWhileQuitting(); if (rejected) return rejected;
    const current = connectionState.snapshot();
    if (current.desiredConnected) {
      if (connectInFlight?.intent === current.intent) return connectInFlight.promise;
      return { ok: true, existing: engineSupervisor.hasActive, pending: !engineSupervisor.hasActive, intent: current.intent };
    }
    intent = beginLifecycleIntent();
  } else if (intent === null) intent = connectionState.snapshot().intent;
  if (!connectionState.canContinue(intent)) return { ok: false, stale: true, intent };
  // Wait for an earlier stop to drain; never start a process into its exit/close interval.
  if (disconnectInFlight) await disconnectInFlight;
  rejected = rejectConnectionWhileQuitting(intent); if (rejected) return rejected;
  if (!connectionState.canContinue(intent)) return { ok: false, stale: true, intent };
  if (engineSupervisor.hasActive) return { ok: true, existing: true, intent };
  if (connectInFlight) {
    await connectInFlight.promise; rejected = rejectConnectionWhileQuitting(intent);
    if (rejected) return rejected;
    if (!connectionState.canContinue(intent)) return { ok: false, stale: true, intent }; if (engineSupervisor.hasActive) return { ok: true, existing: true, intent };
  }
  const operation = (async () => ({ ...await connectOnce(isRetry, intent), intent }))();
  const record = { intent, promise: operation }; connectInFlight = record;
  try { return await operation; }
  finally { if (connectInFlight === record) connectInFlight = null; }
}
function handleEngineClose({ code, generation }, diagnosticTail,
  structuredFatalCode = null, structuredStopReason = null, stoppedSocksPort = 1080,
  isCurrentContext = () => true) {
  // A delayed close from an already invalidated generation must not suspend a
  // newer listener that is now serving the browser.
  const supervisorGenerationCurrent = engineSupervisor.isCurrent(generation) && isCurrentContext(generation);
  clearActiveEngineControl(generation);
  if (!cleanupProxyAccessForEngineClose({ generation, supervisorGenerationCurrent,
    connectionGenerationCurrent: connectionState.isCurrentGeneration(generation),
    clearCredential: clearActiveProxyCredential, removeSidecar: removeExternalProxySidecar,
  })) return;
  // Unexpected process death releases the configured loopback port before the
  // close event reaches JavaScript. Repoint the persistent browser Session at
  // its fail-closed PAC immediately; a later generation may restore it only
  // after reporting listener_ready.
  suspendOpenBrowserPolicy().catch((error) => {
    state.browserNotice = t('error.browserRoutingAfterSave', { message: error.message });
    emit();
  });
  const closeSnapshot = connectionState.snapshot(); const wasConnected = closeSnapshot.phase === 'connected' || closeSnapshot.wasConnectedBeforeStop;
  const uptime = Math.max(connectedAt ? Date.now() - connectedAt : 0, closeSnapshot.connectedUptimeBeforeStop);
  clearConnectionPresentation();
  const failureKind = resolveEngineFailureKind({
    code: structuredFatalCode,
    stopReason: structuredStopReason,
    diagnosticText: diagnosticTail,
  });
  const terminalFailure = failureKind === 'terminal'; state.failureKind = failureKind; state.failureCode = structuredFatalCode || structuredStopReason || null;
  if (!structuredFatalCode && !state.lastError) {
    state.lastError = classifyEngineStopReason(structuredStopReason, stoppedSocksPort, t);
  }
  let cfg;
  try {
    cfg = loadSettings();
  } catch (error) {
    connectionState.engineClosed({
      generation,
      supervisorGenerationCurrent,
      terminalFailure: true,
    });
    reportSettingsReadFailure(error, { emitState: false });
    emit();
    return;
  }
  const autoOn = cfg.autoReconnect !== false;
  const maxA = Number.isInteger(cfg.maxAttempts) ? cfg.maxAttempts : MAX_ATTEMPTS;
  const decision = connectionState.engineClosed({
    generation,
    supervisorGenerationCurrent,
    terminalFailure,
    autoReconnect: autoOn,
    maxAttempts: maxA,
    uptimeMs: uptime,
    failureKind,
  });
  if (decision.action === 'settled' || decision.action === 'terminal') {
    emit();
    return;
  }
  // Only a genuinely stable session earns a fresh retry budget. Merely
  // opening SOCKS and then losing the data plane must keep counting, or a
  // rejecting gateway can drive the app into an infinite login loop.
  if (decision.action === 'retry') {
    state.lastError = wasConnected
      ? t('error.reconnecting')
      : (failureKind === 'gateway-transient'
        ? t('error.gatewayRetrying')
        : null);
    emit();
    const intent = connectionState.snapshot().intent;
    engineSupervisor.schedule(generation, decision.delayMs, () => connect(true, intent));
    return;
  }

  if (failureKind === 'gateway-transient') {
    state.lastError = t('error.gatewayRejected');
  } else if (!state.lastError) {
    state.lastError = wasConnected
      ? t('error.reconnectFailed')
      : (code ? t('error.connectFailed') : null);
  }
  emit();
}
function revokeEngineServing(generation, isCurrentContext = () => true) {
  const uptimeMs = connectedAt ? Date.now() - connectedAt : 0;
  if (!isCurrentContext(generation) || !engineSupervisor.isCurrent(generation) ||
      !connectionState.markEngineStopping(generation, { uptimeMs })) return false;
  // Its epoch and request gate synchronously defeat an awaiting activation.
  suspendOpenBrowserPolicy().catch((error) => {
    state.browserNotice = t('error.browserRoutingAfterSave', { message: error.message });
    emit();
  });
  clearConnectionPresentation(); return true;
}
function handleEngineExitBoundary({ generation }, isCurrentContext = () => true) {
  // `exit` can precede stdio close; revoke serving synchronously but retain the
  // generation so the terminal-only drain can classify fatal/stopped output.
  if (!revokeEngineServing(generation, isCurrentContext)) return;
  clearActiveEngineControl(generation);
  clearActiveProxyCredential(generation);
  removeExternalProxySidecar();
  emit();
}
function failConnectionStart(intent, errorKey, result = { ok: false }) {
  connectionState.failIntent(intent); state.lastError = t(errorKey); emit(); return result;
}
async function connectOnce(isRetry, intent) {
  if (engineSupervisor.hasActive || !connectionState.canContinue(intent)) {
    return { ok: false, stale: true };
  }
  if (!connectionState.beginConnectAttempt(intent, { isRetry })) {
    return { ok: false, stale: true };
  }
  // Platform inspection launches route/proxy/process helpers. Run it
  // asynchronously before the final no-yield settings/credential snapshot so
  // Electron's Main loop stays responsive and the Engine receives a current
  // underlay binding without weakening the final spawn boundary below.
  let underlaySelection = '';
  try { underlaySelection = loadSettingsOrReport().underlaySourceAddress; } catch {}
  await networkEnvironmentService.refresh(underlaySelection, { probePublicEgress: false });
  if (!connectionState.canContinue(intent)) return { ok: false, stale: true };
  if (credentialTransactionBlocked) {
    const recovery = retryCredentialTransactionRecovery();
    if (recovery.status === 'blocked') {
      connectionState.failIntent(intent);
      state.lastError = t('error.credentialRecoveryBlocked');
      emit();
      return { ok: false, blocked: true };
    }
  }
  let s;
  let username = '';
  let pw;
  let engineConfigBinding;
  state.lastError = null; state.failureCode = null; state.failureKind = 'none';
  state.clientIp = null;
  state.dnsMode = 'unknown'; activeSchoolProfile.clearCapabilitySnapshot();
  emit();
  if (!connectionState.canAttempt(intent)) {
    emit();
    return { ok: false, stale: true };
  }
  try {
    // Keep every attempt in one diagnostic session. Clearing the file on an
    // automatic retry used to erase the failure that triggered that retry.
    if (!isRetry) await logWriter.reset();
    logWriter.append(`\n--- connection attempt ${connectionState.snapshot().attemptNumber} ---\n`);
  } catch { reportLogFailure(); }
  if (!connectionState.canAttempt(intent)) {
    emit();
    return { ok: false, stale: true };
  }
  if (credentialTransactionBlocked) {
    const recovery = retryCredentialTransactionRecovery();
    if (recovery.status === 'blocked') {
      connectionState.failIntent(intent);
      state.lastError = t('error.credentialRecoveryBlocked');
      emit();
      return { ok: false, blocked: true };
    }
  }
  // FINAL_CONNECTION_SNAPSHOT: log reset above is connectOnce's last async yield
  // before spawn. Re-read the matching settings/credential pair now, then keep
  // the path through EngineSupervisor.start() and stdin synchronous. A settings
  // save during log I/O therefore either lands in this snapshot, or runs after
  // the child is active and follows the normal reconnect path.
  try {
    // Validate the immutable reviewed profile/config binding before touching
    // the credential store. A missing or replaced package profile must never
    // cause a password to be decrypted for an unverified target.
    engineConfigBinding = activeSchoolProfile.verifyEngineLaunchBinding();
  } catch {
    return failConnectionStart(intent, 'error.engineConfigMissing', { ok: false, profileConfigInvalid: true });
  }
  const engineConfig = engineConfigBinding.path;
  try {
    s = loadSettings();
    const credentialOwner = persistenceRuntime.openCredential() || oneShotVpnCredential.open({
      profileId: activeSchoolProfile.activeContextBinding().profileId,
    });
    if (credentialOwner) {
      try {
        credentialOwner.withStrings((account, password) => {
          username = account;
          pw = password;
        });
      } finally { credentialOwner.destroy(); }
    }
  } catch (error) {
    connectionState.failIntent(intent);
    if (error?.credentialStatus) {
      state.lastError = t(credentialLoadErrorKey(error.credentialStatus));
      emit();
      return { ok: false, credentialStatus: error.credentialStatus };
    }
    reportSettingsReadFailure(error, { emitState: false });
    emit();
    return { ok: false, settingsUnavailable: true };
  }
  if (!username || !pw) {
    pw = '';
    return failConnectionStart(intent, 'error.needCredentials');
  }
  try {
    if (username.length > 256 || pw.length > 4096) throw new Error('credential too long');
    parseCredentialField(username, '账号');
    parseCredentialField(pw, '密码');
  } catch {
    pw = '';
    return failConnectionStart(intent, 'error.invalidStoredCredentials', { ok: false, invalidCredentials: true });
  }
  const launch = resolveEngineLaunch({ appIsPackaged: app.isPackaged, baseDirectory: __dirname,
    nativeEngine: enginePath(), execPath: process.execPath });
  const bin = launch.command;
  const underlayArgs = networkEnvironmentService.engineArguments(s.underlaySourceAddress);
  if (!underlayArgs) {
    pw = ''; return failConnectionStart(intent, 'error.underlayUnavailable', { ok: false, underlayUnavailable: true });
  }
  if (!fs.existsSync(bin)) return failConnectionStart(intent, 'error.engineMissing');
  clearActiveProxyCredential();
  let proxyCredential = null;
  let proxyCredentialMode = 'none';
  if (s.strictProxyAuth === true) {
    try {
      proxyCredential = generationProxyCredential(Number(s.port));
      proxyCredentialMode = 'required';
    } catch {
      return failConnectionStart(intent, 'error.proxyCredentialUnavailable');
    }
  } else if (stableProxyCredential || fs.existsSync(PROXY_CREDENTIAL)) {
    // The packaged SSH helper reads its endpoint from the sidecar and offers
    // both NO_AUTH and RFC1929, so one copied ProxyCommand keeps working when
    // the user later changes port or toggles strict mode. Do not create this
    // optional credential for ordinary compatibility-mode users who have
    // never requested an external configuration; that avoids unnecessary OS
    // secure-storage access. Failure never blocks the core tunnel itself.
    try {
      proxyCredential = generationProxyCredential(Number(s.port));
      proxyCredentialMode = 'optional';
    } catch {}
  }
  let resolvedBin;
  try { resolvedBin = fs.realpathSync(bin); } catch { resolvedBin = path.resolve(bin); }
  if (!launch.synthetic && killStrayEngines(resolvedBin) !== true) {
    proxyCredential?.destroy();
    removeExternalProxySidecar();
    pw = '';
    return failConnectionStart(intent, 'error.engineCleanupUnconfirmed', {
      ok: false,
      cleanupUnconfirmed: true,
    });
  }
  let diagnosticTail = '';
  let engineGeneration = null;
  let ownedEngine = null;
  let structuredFatalCode = null;
  let engineRuntime = null;
  let engineContextToken = null;
  const isCurrentEngineContext = (generation) => activeEngineContextCurrent(generation, engineContextToken);
  connectionState.invalidateEngineGeneration();
  const expectedEngineGeneration = engineSupervisor.currentGeneration + 1;
  const engineArgs = [
    '--config', engineConfig,
    '--profile-binding-v1-stdin',
    '--credentials-stdin',
    '--socks-bind', `127.0.0.1:${Number(s.port)}`,
    '--generation', String(expectedEngineGeneration),
    '--control-api-v2-stdin',
  ];
  if (proxyCredentialMode === 'required') engineArgs.push('--socks-auth-stdin');
  if (proxyCredentialMode === 'optional') engineArgs.push('--socks-auth-optional-stdin');
  engineArgs.push(...underlayArgs);
  const started = engineSupervisor.start({
    command: bin,
    args: [...launch.argsPrefix, ...engineArgs],
    options: { stdio: ['pipe', 'pipe', 'pipe'], ...launch.options },
    onError: ({ error, generation }) => {
      if (!isCurrentEngineContext(generation)) return;
      structuredFatalCode = 'EVENT_OUTPUT_FAILED';
      state.lastError = t('error.engineStart', { message: error.message });
      emit();
    },
    onExit: (result) => { engineRuntime?.beginExitDrain(); handleEngineExitBoundary(result, isCurrentEngineContext); },
    onClose: (result) => {
      const structuredStopReason = engineRuntime?.stoppedReason || null;
      engineRuntime?.dispose();
      if (ownedEngine) removeEngineOwnerRecord(ENGINE_OWNER, ownedEngine);
      handleEngineClose(
        result,
        diagnosticTail,
        structuredFatalCode,
        structuredStopReason,
        Number(s.port), isCurrentEngineContext,
      );
    },
  });
  if (!started.ok) {
    proxyCredential?.destroy();
    removeExternalProxySidecar();
    if (started.reason === 'spawn') {
      connectionState.failIntent(intent);
      state.lastError = t('error.engineStart', { message: started.error.message });
      emit();
    }
    return { ok: false, error: started.error };
  }
  const child = started.child;
  engineGeneration = started.generation;
  connectionState.bindEngineGeneration(engineGeneration);
  engineContextToken = activeContextLease.capture({ connectionIntent: intent, engineGeneration });
  if (engineGeneration !== expectedEngineGeneration) {
    proxyCredential?.destroy();
    removeExternalProxySidecar();
    structuredFatalCode = 'EVENT_OUTPUT_FAILED';
    state.lastError = classifyEngineCode(structuredFatalCode, s.port, t);
    emit();
    await engineSupervisor.stop({ graceMs: 0, forceWaitMs: STOP_FORCE_WAIT_MS });
    return { ok: false };
  }
  if (proxyCredential) {
    if (!proxyCredential.bindGeneration(engineGeneration, Number(s.port))) {
      proxyCredential.destroy();
      removeExternalProxySidecar();
      structuredFatalCode = 'EVENT_OUTPUT_FAILED';
      state.lastError = t('error.proxyCredentialUnavailable');
      emit();
      await engineSupervisor.stop({ graceMs: 0, forceWaitMs: STOP_FORCE_WAIT_MS });
      return { ok: false };
    }
    activeProxyCredential = proxyCredential;
  }
  if (!launch.synthetic && process.platform === 'win32' &&
      Number.isInteger(child.pid) && child.pid > 0) {
    ownedEngine = { pid: child.pid, executablePath: resolvedBin };
    try {
      writeEngineOwnerRecord(ENGINE_OWNER, ownedEngine);
    } catch {
      clearActiveProxyCredential(engineGeneration);
      removeExternalProxySidecar();
      state.lastError = t('error.engineCleanupUnconfirmed');
      emit();
      await engineSupervisor.stop({ graceMs: 0, forceWaitMs: STOP_FORCE_WAIT_MS });
      return { ok: false, cleanupUnconfirmed: true };
    }
  }
  let browserActivationInFlight = null;
  const finishConnected = () => {
    const wasConnected = connectionState.isConnected();
    if (!isCurrentEngineContext(engineGeneration) ||
        !connectionState.markConnected(engineGeneration)) return;
    state.lastError = null;
    if (!wasConnected) {
      connectedAt = Date.now();
      telemetryCoordinator.start(engineGeneration, engineContextToken);
    }
    emit();
  };
  const markConnected = () => {
    if (!isCurrentEngineContext(engineGeneration) ||
        !connectionState.isReadyToConnect(engineGeneration)) return;
    if (!campusBrowserManager.routingSuspended) {
      finishConnected();
      return;
    }
    if (browserActivationInFlight) return;
    const activation = campusBrowserManager.resumeRoutingPolicy(Number(s.port));
    browserActivationInFlight = activation;
    activation.then(() => {
      if (browserActivationInFlight === activation) browserActivationInFlight = null;
      finishConnected();
    }).catch((error) => {
      if (browserActivationInFlight === activation) browserActivationInFlight = null;
      if (!isCurrentEngineContext(engineGeneration)) return;
      // The engine is usable by authenticated external clients, while the
      // built-in browser deliberately remains behind its request gate.
      finishConnected();
      state.browserNotice = t('error.browserRoutingAfterSave', { message: error.message });
      emit();
    });
  };
  const applyHumanDiagnostic = (chunk) => {
    diagnosticTail = (diagnosticTail + chunk).slice(-512);
    if (!isCurrentEngineContext(engineGeneration)) return;
    const classifiedError = classifyEngineOutput(diagnosticTail, s.port, t);
    if (classifiedError) {
      state.lastError = classifiedError;
      emit();
    }
  };
  engineRuntime = new EngineConnectionRuntime({
    generation: engineGeneration,
    contextToken: engineContextToken,
    expectedPort: Number(s.port),
    stdin: child.stdin,
    controlRegistry: engineControlRegistry,
    isCurrent: isCurrentEngineContext,
    handlers: {
      onDiagnostic: (event) => logWriter.append(formatEngineEventDiagnostic(event, { ...connectionState.snapshot(), generation: engineGeneration })),
      onConnecting: (engineState) => {
        if (!connectionState.markEnginePhase(engineGeneration, engineState)) return;
        emit();
      },
      onStopping: () => { if (revokeEngineServing(engineGeneration, isCurrentEngineContext)) emit(); },
      onConnectionCandidate: () => {
        connectionState.recordEngineConnectedCandidate(engineGeneration);
        markConnected();
      },
      onListenerReady: () => {
        connectionState.recordListenerReady(engineGeneration);
        markConnected();
      },
      onListenerMismatch: () => {
        revokeEngineServing(engineGeneration, isCurrentEngineContext); structuredFatalCode = 'LOCAL_LISTENER_FAILED';
        state.lastError = classifyEngineCode(structuredFatalCode, s.port, t); emit();
        engineSupervisor.stop({ graceMs: 1000, forceWaitMs: STOP_FORCE_WAIT_MS }).catch(() => {});
      },
      onClientIpAssigned: (_family, address) => {
        connectionState.markEnginePhase(engineGeneration, 'preparing_tunnel');
        state.clientIp = address;
        emit();
      },
      onDnsMode: (mode) => {
        state.dnsMode = mode;
        emit();
      },
      onNetworkUnhealthy: () => {
        revokeEngineServing(engineGeneration, isCurrentEngineContext); state.lastError = t('error.tunnelRecovering'); emit();
      },
      onFatalError: (code, secondaryCode) => {
        revokeEngineServing(engineGeneration, isCurrentEngineContext); structuredFatalCode = code;
        state.lastError = classifyEngineCode(code, s.port, t, secondaryCode); emit();
      },
      onProtocolTimeout: () => {
        revokeEngineServing(engineGeneration, isCurrentEngineContext);
        structuredFatalCode = 'EVENT_OUTPUT_FAILED';
        state.lastError = classifyEngineCode(structuredFatalCode, s.port, t);
        emit();
        engineSupervisor.stop({ graceMs: 1000, forceWaitMs: STOP_FORCE_WAIT_MS })
          .catch(() => {});
      },
      onProviderCapabilities: (report) => activeSchoolProfile.observeCapabilityReport(report) && emit(),
    },
  });
  // An engine that dies before reading stdin (missing library, wrong
  // architecture) makes this write emit EPIPE. Without a listener that would
  // become an uncaught exception and take the whole application down, so the
  // failure is left to the supervisor's final close handler instead.
  child.stdin.on('error', () => {});
  let proxyCredentialLines = proxyCredential
    ? proxyCredential.stdinSuffix(engineGeneration)
    : '';
  // Keep the credential/control pipe open: EOF cancels active authentication;
  // after connection it closes only the Control v2/v3 stream.
  child.stdin.write(
    `${engineConfigBinding.stdinFrame}\n${username}\n${pw}\n${proxyCredentialLines}`,
  );
  username = '';
  pw = '';
  proxyCredentialLines = '';
  engineRuntime.start(child.stdout);
  child.stderr.on('data', (data) => {
    const chunk = data.toString();
    logWriter.append(chunk);
    applyHumanDiagnostic(chunk);
  });
  return { ok: true, generation: engineGeneration };
}

function ensureEngineStopped() {
  if (disconnectInFlight) return disconnectInFlight;
  // Establish the browser barrier before the engine releases its listener;
  // otherwise another local account/process can bind the now-free port and
  // impersonate the expected proxy. The synchronous request gate is the hard
  // boundary: PAC/drain failures are surfaced but do not strand the engine.
  const operation = stopEngineAfterBrowserSuspend({
    suspendBrowser: suspendOpenBrowserPolicy,
    browserBoundaryClosed: () => campusBrowserManager.routingRequestsBlocked !== false,
    closeBrowser: () => campusBrowserManager.close(),
    onSuspendError: (error) => {
      state.browserNotice = t('error.browserRoutingAfterSave', { message: error.message });
      emit();
    },
    stopEngine: () => engineSupervisor.stop({
      requestGracefulStop: requestActiveEngineControlShutdown,
      graceMs: STOP_GRACE_MS,
      forceWaitMs: STOP_FORCE_WAIT_MS,
    }),
  });
  disconnectInFlight = operation;
  operation.finally(() => {
    // The encrypted master remains stable, but the plaintext helper projection
    // must not outlive the listener. Reconnect/resume recreates it before the
    // next engine starts, including after a port change.
    removeExternalProxySidecar();
    if (disconnectInFlight === operation) disconnectInFlight = null;
  });
  return operation;
}

function initiateStop(wantsConnectedAfterStop) {
  networkStartupCoordinator?.cancel();
  connectivityRecovery.cancel();
  const intent = connectionState.beginStop(wantsConnectedAfterStop);
  // Generation invalidation happens before waiting for close. Old probes,
  // delayed retries, and output callbacks are stale from this exact point.
  engineSupervisor.invalidate();
  clearActiveProxyCredential();
  clearConnectionPresentation();
  emit();
  return { intent, stopped: ensureEngineStopped() };
}

async function disconnect() {
  const { intent, stopped } = initiateStop(false);
  const result = await stopped;
  removeExternalProxySidecar();
  connectionState.stopCompleted(intent, result);
  if (connectionState.isCurrentIntent(intent) && !result.ok) {
    state.lastError = t('error.engineStuck');
    emit();
  } else if (connectionState.isCurrentIntent(intent) && result.cleanExit === false) {
    state.lastError = t('error.engineCleanupUnconfirmed');
    emit();
  }
  return { ok: result.ok };
}

function waitForConnected(intent, timeoutMs = BROWSER_CONNECTION_READY_TIMEOUT_MS) {
  return connectionWaitRegistry.wait(intent, { timeoutMs });
}

async function reconnect(expectedGeneration = null) {
  let rejected = rejectConnectionWhileQuitting(); if (rejected) return rejected;
  if (expectedGeneration !== null && !engineSupervisor.isCurrent(expectedGeneration)) return { ok: false, stale: true };
  if (reconnectInFlight && connectionState.isCurrentIntent(reconnectInFlight.intent) &&
      connectionState.snapshot().desiredConnected) {
    return reconnectInFlight.promise;
  }
  if (reconnectInFlight) await reconnectInFlight.promise;
  rejected = rejectConnectionWhileQuitting(); if (rejected) return rejected;
  if (expectedGeneration !== null && !engineSupervisor.isCurrent(expectedGeneration)) return { ok: false, stale: true };

  const { intent, stopped } = initiateStop(true);
  const operation = (async () => {
    const stopResult = await stopped;
    const quitResult = rejectConnectionWhileQuitting(intent); if (quitResult) return quitResult;
    connectionState.stopCompleted(intent, stopResult);
    if (!stopResult.ok || stopResult.cleanExit === false) {
      connectionState.failIntent(intent);
      state.lastError = t(stopResult.cleanExit === false
        ? 'error.engineCleanupUnconfirmed'
        : 'error.engineStuck');
      emit();
      return { ok: false };
    }
    if (!connectionState.resumeAfterStop(intent)) return { ok: false, stale: true };
    return connect(false, intent);
  })();
  const record = { intent, promise: operation };
  reconnectInFlight = record;
  try { return await operation; }
  finally { if (reconnectInFlight === record) reconnectInFlight = null; }
}

// ---------- PAC file (advanced app integration; no DNS probing) ----------
let currentPacUrl = pathToFileURL(PAC_FILE).href;
function refreshPacFile(settings = loadSettingsOrReport()) {
  const saved = savePacFile(PAC_FILE, domainRoutePolicy.buildPac(Number(settings.port), {
    defaultRoute: 'direct', campusPrivateIpv4: true,
  }));
  currentPacUrl = saved.url;
  return saved;
}
function pacUrl() { return currentPacUrl; }

function browserPolicyProxyConfig(port) {
  const proxyKind = loadSettingsOrReport().strictProxyAuth === true ? 'http' : 'socks5';
  const source = domainRoutePolicy.buildPac(
    Number(port),
    { proxyKind, campusPrivateIpv4: true },
  );
  // Keep a durable diagnostic copy, while Chromium consumes an in-memory PAC.
  // If the derived file disappears or cannot be re-read, Chromium must never
  // silently fall back to DIRECT for a campus page.
  savePacFile(
    CAMPUS_BROWSER_PAC_FILE,
    source,
  );
  return {
    mode: 'pac_script',
    pacScript: pacDataUrl(source),
    proxyBypassRules: '<-loopback>',
  };
}
async function suspendOpenBrowserPolicy() {
  return campusBrowserManager.suspendRoutingPolicy();
}
async function resumeOpenBrowserPolicyIfLive() {
  if (!connectionState.isConnected() || !engineSupervisor.hasActive) return null;
  return campusBrowserManager.resumeRoutingPolicy(socksPort());
}
function runDomainPolicyTransaction(buildOperations) {
  return runActiveContextTransaction(() => {
    assertSettingsPersistenceAvailable();
    const { commit, rollback, resumeBrowser = true } = buildOperations();
    return {
      suspend: suspendOpenBrowserPolicy,
      commit,
      applyExternal: () => refreshPacFile(loadSettingsOrReport()),
      applyBrowser: resumeBrowser ? resumeOpenBrowserPolicyIfLive : null,
      rollback,
      restoreExternal: () => refreshPacFile(loadSettingsOrReport()),
      restoreBrowser: resumeOpenBrowserPolicyIfLive,
    };
  });
}

const browserRoutingPolicy = {
  appliesLiveSession: true,
  list: () => domainRoutePolicy.list(),
  resolve: (url, inheritedRoute) => domainRoutePolicy.resolve(url, inheritedRoute),
  upsert: (payload) => runDomainPolicyTransaction(() => {
    const previousRules = domainRoutePolicy.list();
    return {
      commit: () => domainRoutePolicy.upsert(payload),
      rollback: () => domainRoutePolicy.replace(previousRules),
    };
  }),
  remove: (payload) => runDomainPolicyTransaction(() => {
    const previousRules = domainRoutePolicy.list();
    return {
      commit: () => domainRoutePolicy.remove(payload),
      rollback: () => domainRoutePolicy.replace(previousRules),
    };
  }),
  proxyConfig: (port) => browserPolicyProxyConfig(port),
};
const resourcesChanged = () => { emit(); campusBrowserManager?.browser?.updateToolbar(); };
const pageFavoriteController = createPageFavoriteController({ activeSchoolProfile, loadSettings: loadSettingsOrReport, saveSettings, activityStore: resourceLibraryRuntime, runTransaction: runDomainPolicyTransaction, onChanged: resourcesChanged });
async function ensureCampusReady() {
  if (connectionState.isConnected()) return true;
  const result = await connect();
  if (!result?.ok && !connectionState.isConnecting()) return false;
  return waitForConnected(result.intent);
}
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
  ensureCampusReady,
  resolveRoute: (url) => domainRoutePolicy.resolve(url),
  ensureConnected: async () => {
    if (!connectionState.isConnected()) {
      const result = await connect();
      if (!await waitForConnected(result.intent)) {
        return { ok: false, error: state.lastError || t('error.connectTimeout') };
      }
    }
    return { ok: true };
  },
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
});
const profileSwitching = createMainProfileSwitchComposition({
  enabled: preReadyStorage.mode === 'profile-workspace',
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

// ---------- update check (notify only; no auto-download) ----------
// macOS builds are ad-hoc signed, so the app never downloads updates itself:
// it only learns whether a newer GitHub release exists and points the user at
// the release page. checkForUpdate resolves to null on any failure, so this
// can never throw into the main loop.
async function runUpdateCheck() {
  const result = await checkForUpdate(app.getVersion());
  if (result) {
    // The API answered, so the 24h throttle window starts here. Failures leave
    // the timestamp alone and are retried at the next launch.
    await runActiveContextTransaction(() => {
      assertSettingsPersistenceAvailable();
      const settings = loadSettingsOrReport();
      return {
        commit: () => saveSettings({ ...settings, updateCheckedAt: Date.now() }),
        rollback: () => saveSettings(settings),
      };
    });
  }
  if (result && result.updateAvailable) {
    updateInfo = result;
    emit();
  }
  return result;
}

// Automatic checks run at most once every 24h (persisted across restarts and
// long-running sessions); the settings-page button always forces a fresh check.
async function runAutomaticUpdateCheck() {
  if (!shouldAutoCheck(loadSettingsOrReport().updateCheckedAt)) return null;
  return runUpdateCheck();
}

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
  getVersion: () => app.getVersion(), getUpdate: () => updateInfo,
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
  runCredentialMutation: runPersistenceCredentialMutation,
  credentialJournalPath: CREDENTIAL_TRANSACTION,
  credentialPaths: credentialTransactionPaths,
  applyCredentialRecovery: applyCredentialRecoveryOutcome,
  isCredentialBlocked: () => credentialTransactionBlocked,
  retryCredentialRecovery: retryCredentialTransactionRecovery,
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
  checkUpdate: (force) => force ? runUpdateCheck() : runAutomaticUpdateCheck(),
  openExternal: (url) => {
    if (!isCurrentUpdateUrl(url, updateInfo)) return { ok: false };
    shell.openExternal(url).catch(() => {});
    return { ok: true };
  },
  resize: (height) => desktopShell.resize(height),
});
// ---------- window / tray composition ----------
function rememberCloseAction(action) {
  return runActiveContextTransaction(() => {
    assertSettingsPersistenceAvailable();
    const previous = loadSettingsOrReport();
    const next = { ...previous, closeAction: action };
    return {
      commit: () => saveSettings(next),
      rollback: () => saveSettings(previous),
    };
  });
}
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
    removeExternalProxySidecar();
    stableProxyCredential?.destroy();
    stableProxyCredential = null;
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
  getProxyCredentials: (generation) => (
    activeProxyCredential?.socksAuthentication(generation) || null
  ),
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
      !activeProxyCredential?.matchesProxyChallenge(authInfo, generation)) return;
  event.preventDefault();
  activeProxyCredential.answerProxyChallenge(authInfo, generation, callback);
});
app.whenReady().then(() => {
  if (!profileSwitching.runtime) {
    assertActiveContextSwitchStartupClear({ mode: preReadyStorage.mode, filePath: ACTIVE_CONTEXT_SWITCH });
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
  applyCredentialRecoveryOutcome(credentialTransactionRecovery, { emitState: false });
  syncRecoveryNotice(false);
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
  // Dev checkouts and CI would only ever hit the rate-limited API for no
  // benefit, so the automatic check is packaged-builds only. The settings
  // page can always trigger a manual one. Automatic checks are throttled to
  // once per 24h; the interval covers sessions that run for days.
  if (app.isPackaged) {
    setTimeout(() => { runAutomaticUpdateCheck().catch(() => {}); }, 5000);
    const updateTimer = setInterval(() => {
      runAutomaticUpdateCheck().catch(() => {});
    }, AUTO_CHECK_INTERVAL_MS);
    updateTimer.unref();
  }
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
