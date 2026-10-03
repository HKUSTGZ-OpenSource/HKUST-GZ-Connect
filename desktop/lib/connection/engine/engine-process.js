'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EngineConnectionRuntime, EngineServingCoordinator, EngineTerminationCoordinator } = require('./engine-connection-runtime');
const { classifyEngineCode } = require('./engine-output');
const { EngineSupervisor, cleanupOrphanedEngine, writeEngineOwnerRecord, removeEngineOwnerRecord } = require('./engine-supervisor');
const { AuthChallengeCoordinator, EngineControlRegistry } = require('./engine-control-suite');
const { STOP_FORCE_WAIT_MS } = require('../state/stop-policy');

const SYNTHETIC_ENGINE_E2E_ENV = 'HKUSTGZ_SYNTHETIC_ENGINE_E2E';
const SYNTHETIC_ENGINE_FIXTURE = 'main-engine-fixture.js';
const SYNTHETIC_GATEWAY_PROBE_E2E_ENV = 'HKUSTGZ_SYNTHETIC_GATEWAY_PROBE_E2E';
const SYNTHETIC_GATEWAY_PROBE_FIXTURE = 'main-gateway-probe-fixture.js';
const NATIVE_RESOURCE_KINDS = new Set([
  'ec-engine',
  'ec-gateway-probe',
  'ec-proxy-command',
]);

function exactExecutablePattern(executablePath) {
  if (typeof executablePath !== 'string' || !executablePath.length) return '';
  const escaped = executablePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `^${escaped}( |$)`;
}

function resolveNativeResourcePath({
  kind,
  appIsPackaged,
  baseDirectory,
  resourcesPath,
  platform = process.platform,
  architecture = process.arch,
  fileSystem = fs,
} = {}) {
  if (!NATIVE_RESOURCE_KINDS.has(kind) || typeof appIsPackaged !== 'boolean' ||
      typeof baseDirectory !== 'string' || !path.isAbsolute(baseDirectory) ||
      typeof resourcesPath !== 'string' || !path.isAbsolute(resourcesPath) ||
      !['darwin', 'linux', 'win32'].includes(platform) ||
      !['arm64', 'x64'].includes(architecture) ||
      !fileSystem || typeof fileSystem.existsSync !== 'function') {
    throw new TypeError('native resource path inputs are invalid');
  }
  const platformName = platform === 'win32' ? 'windows' : platform;
  const archName = architecture === 'arm64' ? 'arm64' : 'amd64';
  const extension = platform === 'win32' ? '.exe' : '';
  const named = `${kind}-${platformName}-${archName}${extension}`;
  const generic = `${kind}${extension}`;
  const directory = appIsPackaged
    ? path.join(resourcesPath, 'engine')
    : path.join(baseDirectory, 'engine');
  const candidates = [
    path.join(directory, named),
    path.join(directory, generic),
    path.join(baseDirectory, '..', 'independent', 'target', 'release', generic),
  ];
  return candidates.find((candidate) => fileSystem.existsSync(candidate)) || candidates[0];
}

function resolveEngineLaunch({
  appIsPackaged,
  baseDirectory,
  nativeEngine,
  execPath,
  environment = process.env,
  fileSystem = fs,
} = {}) {
  if (![baseDirectory, nativeEngine, execPath].every((value) => (
    typeof value === 'string' && path.isAbsolute(value)
  )) || !environment || typeof environment !== 'object') {
    throw new TypeError('engine launch inputs are invalid');
  }
  const native = Object.freeze({
    command: nativeEngine,
    argsPrefix: Object.freeze([]),
    options: Object.freeze({}),
    synthetic: false,
  });
  if (appIsPackaged || environment[SYNTHETIC_ENGINE_E2E_ENV] !== '1') return native;

  const fixtureDirectory = fileSystem.realpathSync(path.join(baseDirectory, 'e2e'));
  const fixture = fileSystem.realpathSync(path.join(
    baseDirectory,
    'e2e',
    SYNTHETIC_ENGINE_FIXTURE,
  ));
  if (path.dirname(fixture) !== fixtureDirectory ||
      path.basename(fixture) !== SYNTHETIC_ENGINE_FIXTURE) {
    throw new Error('synthetic engine fixture escaped its test directory');
  }
  return Object.freeze({
    command: execPath,
    argsPrefix: Object.freeze([fixture]),
    options: Object.freeze({
      env: Object.freeze({ ...environment, ELECTRON_RUN_AS_NODE: '1' }),
    }),
    synthetic: true,
  });
}

function resolveGatewayProbeLaunch({
  appIsPackaged,
  baseDirectory,
  nativeProbe,
  execPath,
  environment = process.env,
  fileSystem = fs,
} = {}) {
  if (![baseDirectory, nativeProbe, execPath].every((value) => (
    typeof value === 'string' && path.isAbsolute(value)
  )) || !environment || typeof environment !== 'object') {
    throw new TypeError('Gateway probe launch inputs are invalid');
  }
  const native = Object.freeze({
    command: nativeProbe,
    argsPrefix: Object.freeze([]),
    electronRunAsNode: false,
    synthetic: false,
  });
  if (appIsPackaged || environment[SYNTHETIC_GATEWAY_PROBE_E2E_ENV] !== '1') {
    return native;
  }

  const fixtureDirectory = fileSystem.realpathSync(path.join(baseDirectory, 'e2e'));
  const fixture = fileSystem.realpathSync(path.join(
    baseDirectory,
    'e2e',
    SYNTHETIC_GATEWAY_PROBE_FIXTURE,
  ));
  if (path.dirname(fixture) !== fixtureDirectory ||
      path.basename(fixture) !== SYNTHETIC_GATEWAY_PROBE_FIXTURE) {
    throw new Error('synthetic Gateway probe fixture escaped its test directory');
  }
  return Object.freeze({
    command: execPath,
    argsPrefix: Object.freeze([fixture]),
    electronRunAsNode: true,
    synthetic: true,
  });
}

// Process/control owners share one assembly, not another lifecycle policy.
// Main still injects Profile, storage, presentation and application effects.
function createEngineApplicationRuntime({ spawnProcess, authChallenge = {} } = {}) {
  if (typeof spawnProcess !== 'function') throw new TypeError('Engine spawn effect is required');
  const authChallenges = new AuthChallengeCoordinator(authChallenge);
  const controlRegistry = new EngineControlRegistry({ authChallenges });
  const supervisor = new EngineSupervisor({ spawnProcess });
  return Object.freeze({
    authChallenges, controlRegistry, supervisor,
    createAttempt: options => new EngineAttemptCoordinator({
      ...options, engineSupervisor: supervisor, controlRegistry,
    }),
    createTermination: options => new EngineTerminationCoordinator({
      ...options,
      isGenerationCurrent: generation => supervisor.isCurrent(generation),
      scheduleRetry: (generation, delay, callback) => supervisor.schedule(generation, delay, callback),
      clearControl: generation => controlRegistry.clear(generation),
    }),
    cleanupOrphaned: options => cleanupOrphanedEngine(options),
  });
}

// One attempt owns its transient credential strings, launch and generation callbacks.
// Persistence/Profile/network effects are injected; no new async yield precedes stdin.
class EngineAttemptCoordinator {
  constructor(ports) {
    Object.assign(this, { fileSystem: fs, platform: process.platform, execPath: process.execPath,
      resolveLaunch: resolveEngineLaunch, writeOwnerRecord: writeEngineOwnerRecord,
      removeOwnerRecord: removeEngineOwnerRecord }, ports);
  }
  get state() { return this.getState(); }
  get t() { return this.getTranslator(); }
  get logWriter() { return this.getLogWriter(); }
  get credentialTransactionBlocked() { return this.isCredentialTransactionBlocked(); }

  failConnectionStart(intent, errorKey, result = { ok: false }) {
    this.connectionState.failIntent(intent); this.state.lastError = this.t(errorKey); this.emit(); return result;
  }
  async run(isRetry, intent) {
    if (this.engineSupervisor.hasActive || !this.connectionState.canContinue(intent)) {
      return { ok: false, stale: true };
    }
    if (!this.connectionState.beginConnectAttempt(intent, { isRetry })) {
      return { ok: false, stale: true };
    }
    // Platform inspection launches route/proxy/process helpers. Run it
    // asynchronously before the final no-yield settings/credential snapshot so
    // Electron's Main loop stays responsive and the Engine receives a current
    // underlay binding without weakening the final spawn boundary below.
    let underlaySelection = '';
    try { underlaySelection = this.loadSettingsOrReport().underlaySourceAddress; } catch {}
    await this.networkEnvironment.refresh(underlaySelection, { probePublicEgress: false });
    if (!this.connectionState.canContinue(intent)) return { ok: false, stale: true };
    if (this.credentialTransactionBlocked) {
      const recovery = this.retryCredentialTransactionRecovery();
      if (recovery.status === 'blocked') {
        this.connectionState.failIntent(intent);
        this.state.lastError = this.t('error.credentialRecoveryBlocked');
        this.emit();
        return { ok: false, blocked: true };
      }
    }
    let s;
    let username = '';
    let pw;
    let engineConfigBinding;
    this.state.lastError = null; this.state.failureCode = null; this.state.failureKind = 'none';
    this.state.clientIp = null;
    this.state.dnsMode = 'unknown'; this.profile.clearCapabilitySnapshot();
    this.emit();
    if (!this.connectionState.canAttempt(intent)) {
      this.emit();
      return { ok: false, stale: true };
    }
    try {
      // Keep every attempt in one diagnostic session. Clearing the file on an
      // automatic retry used to erase the failure that triggered that retry.
      if (!isRetry) await this.logWriter.reset();
      this.logWriter.append(`\n--- connection attempt ${this.connectionState.snapshot().attemptNumber} ---\n`);
    } catch { this.reportLogFailure(); }
    if (!this.connectionState.canAttempt(intent)) {
      this.emit();
      return { ok: false, stale: true };
    }
    if (this.credentialTransactionBlocked) {
      const recovery = this.retryCredentialTransactionRecovery();
      if (recovery.status === 'blocked') {
        this.connectionState.failIntent(intent);
        this.state.lastError = this.t('error.credentialRecoveryBlocked');
        this.emit();
        return { ok: false, blocked: true };
      }
    }
    // FINAL_CONNECTION_SNAPSHOT: log reset above is this attempt's last async yield
    // before spawn. Re-read the matching settings/credential pair now, then keep
    // the path through EngineSupervisor.start() and stdin synchronous. A settings
    // save during log I/O therefore either lands in this snapshot, or runs after
    // the child is active and follows the normal reconnect path.
    try {
      // Validate the immutable reviewed profile/config binding before touching
      // the credential store. A missing or replaced package profile must never
      // cause a password to be decrypted for an unverified target.
      engineConfigBinding = this.profile.verifyEngineLaunchBinding();
    } catch {
      return this.failConnectionStart(intent, 'error.engineConfigMissing', { ok: false, profileConfigInvalid: true });
    }
    const engineConfig = engineConfigBinding.path;
    try {
      s = this.loadSettings();
      const credentialOwner = this.openCredential(this.profile.activeContextBinding().profileId);
      if (credentialOwner) {
        try {
          credentialOwner.withStrings((account, password) => {
            username = account;
            pw = password;
          });
        } finally { credentialOwner.destroy(); }
      }
    } catch (error) {
      this.connectionState.failIntent(intent);
      if (error?.credentialStatus) {
        this.state.lastError = this.t(this.credentialLoadErrorKey(error.credentialStatus));
        this.emit();
        return { ok: false, credentialStatus: error.credentialStatus };
      }
      this.reportSettingsReadFailure(error, { emitState: false });
      this.emit();
      return { ok: false, settingsUnavailable: true };
    }
    if (!username || !pw) {
      pw = '';
      return this.failConnectionStart(intent, 'error.needCredentials');
    }
    try {
      if (username.length > 256 || pw.length > 4096) throw new Error('credential too long');
      this.parseCredentialField(username, '账号');
      this.parseCredentialField(pw, '密码');
    } catch {
      pw = '';
      return this.failConnectionStart(intent, 'error.invalidStoredCredentials', { ok: false, invalidCredentials: true });
    }
    const launch = this.resolveLaunch({ appIsPackaged: this.appIsPackaged, baseDirectory: this.baseDirectory,
      nativeEngine: this.enginePath(), execPath: this.execPath });
    const bin = launch.command;
    const underlayArgs = this.networkEnvironment.engineArguments(s.underlaySourceAddress);
    if (!underlayArgs) {
      pw = ''; return this.failConnectionStart(intent, 'error.underlayUnavailable', { ok: false, underlayUnavailable: true });
    }
    if (!this.fileSystem.existsSync(bin)) return this.failConnectionStart(intent, 'error.engineMissing');
    this.clearActiveProxyCredential();
    let proxyCredential = null;
    let proxyCredentialMode = 'none';
    if (s.strictProxyAuth === true) {
      try {
        proxyCredential = this.generationProxyCredential(Number(s.port));
        proxyCredentialMode = 'required';
      } catch {
        return this.failConnectionStart(intent, 'error.proxyCredentialUnavailable');
      }
    } else if (this.hasStableProxyCredential() || this.fileSystem.existsSync(this.proxyCredentialFile)) {
      // The packaged SSH helper reads its endpoint from the sidecar and offers
      // both NO_AUTH and RFC1929, so one copied ProxyCommand keeps working when
      // the user later changes port or toggles strict mode. Do not create this
      // optional credential for ordinary compatibility-mode users who have
      // never requested an external configuration; that avoids unnecessary OS
      // secure-storage access. Failure never blocks the core tunnel itself.
      try {
        proxyCredential = this.generationProxyCredential(Number(s.port));
        proxyCredentialMode = 'optional';
      } catch {}
    }
    let resolvedBin;
    try { resolvedBin = this.fileSystem.realpathSync(bin); } catch { resolvedBin = path.resolve(bin); }
    if (!launch.synthetic && this.killStrayEngines(resolvedBin) !== true) {
      proxyCredential?.destroy();
      this.removeExternalProxySidecar();
      pw = '';
      return this.failConnectionStart(intent, 'error.engineCleanupUnconfirmed', {
        ok: false,
        cleanupUnconfirmed: true,
      });
    }
    let engineGeneration = null;
    let ownedEngine = null;
    let engineRuntime = null;
    let engineContextToken = null;
    const isCurrentEngineContext = (generation) => this.activeEngineContextCurrent(generation, engineContextToken);
    const serving = new EngineServingCoordinator({
      getGeneration: () => engineGeneration, port: s.port, connectionState: this.connectionState,
      getBrowser: () => this.getBrowser(), getPresentation: () => this.state, getTranslator: () => this.t,
      isCurrent: isCurrentEngineContext, emit: this.emit, appendDiagnostic: chunk => this.logWriter.append(chunk),
      revokeServing: () => this.revokeEngineServing(engineGeneration, isCurrentEngineContext),
      stopEngine: () => this.engineSupervisor.stop({ graceMs: 1000, forceWaitMs: STOP_FORCE_WAIT_MS }),
      observeCapabilities: report => this.profile.observeCapabilityReport(report),
      onFirstConnected: () => {
        this.onFirstConnected(engineGeneration, engineContextToken);
      },
    });
    this.connectionState.invalidateEngineGeneration();
    const expectedEngineGeneration = this.engineSupervisor.currentGeneration + 1;
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
    const started = this.engineSupervisor.start({
      command: bin,
      args: [...launch.argsPrefix, ...engineArgs],
      options: { stdio: ['pipe', 'pipe', 'pipe'], ...launch.options },
      onError: ({ error, generation }) => {
        if (!isCurrentEngineContext(generation)) return;
        serving.fatalCode = 'EVENT_OUTPUT_FAILED';
        this.state.lastError = this.t('error.engineStart', { message: error.message });
        this.emit();
      },
      onExit: (result) => { engineRuntime?.beginExitDrain(); this.handleEngineExitBoundary(result, isCurrentEngineContext); },
      onClose: (result) => {
        const structuredStopReason = engineRuntime?.stoppedReason || null;
        engineRuntime?.dispose();
        if (ownedEngine) this.removeOwnerRecord(this.engineOwnerFile, ownedEngine);
        this.handleEngineClose(
          result,
          serving.diagnosticTail,
          serving.fatalCode,
          structuredStopReason,
          Number(s.port), isCurrentEngineContext,
        );
      },
    });
    if (!started.ok) {
      proxyCredential?.destroy();
      this.removeExternalProxySidecar();
      if (started.reason === 'spawn') {
        this.connectionState.failIntent(intent);
        this.state.lastError = this.t('error.engineStart', { message: started.error.message });
        this.emit();
      }
      return { ok: false, error: started.error };
    }
    const child = started.child;
    engineGeneration = started.generation;
    this.connectionState.bindEngineGeneration(engineGeneration);
    engineContextToken = this.contextLease.capture({ connectionIntent: intent, engineGeneration });
    if (engineGeneration !== expectedEngineGeneration) {
      proxyCredential?.destroy();
      this.removeExternalProxySidecar();
      serving.fatalCode = 'EVENT_OUTPUT_FAILED';
      this.state.lastError = classifyEngineCode(serving.fatalCode, s.port, this.t);
      this.emit();
      await this.engineSupervisor.stop({ graceMs: 0, forceWaitMs: STOP_FORCE_WAIT_MS });
      return { ok: false };
    }
    if (proxyCredential) {
      if (!proxyCredential.bindGeneration(engineGeneration, Number(s.port))) {
        proxyCredential.destroy();
        this.removeExternalProxySidecar();
        serving.fatalCode = 'EVENT_OUTPUT_FAILED';
        this.state.lastError = this.t('error.proxyCredentialUnavailable');
        this.emit();
        await this.engineSupervisor.stop({ graceMs: 0, forceWaitMs: STOP_FORCE_WAIT_MS });
        return { ok: false };
      }
      this.setActiveProxyCredential(proxyCredential);
    }
    if (!launch.synthetic && this.platform === 'win32' &&
        Number.isInteger(child.pid) && child.pid > 0) {
      ownedEngine = { pid: child.pid, executablePath: resolvedBin };
      try {
        this.writeOwnerRecord(this.engineOwnerFile, ownedEngine);
      } catch {
        this.clearActiveProxyCredential(engineGeneration);
        this.removeExternalProxySidecar();
        this.state.lastError = this.t('error.engineCleanupUnconfirmed');
        this.emit();
        await this.engineSupervisor.stop({ graceMs: 0, forceWaitMs: STOP_FORCE_WAIT_MS });
        return { ok: false, cleanupUnconfirmed: true };
      }
    }

    engineRuntime = new EngineConnectionRuntime({
      generation: engineGeneration,
      contextToken: engineContextToken,
      expectedPort: Number(s.port),
      stdin: child.stdin,
      controlRegistry: this.controlRegistry,
      isCurrent: isCurrentEngineContext,
      handlers: serving.handlers,
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
      this.logWriter.append(chunk);
      serving.applyHumanDiagnostic(chunk);
    });
    return { ok: true, generation: engineGeneration };
  }
}

module.exports = {
  createEngineApplicationRuntime,
  EngineAttemptCoordinator,
  SYNTHETIC_ENGINE_E2E_ENV,
  SYNTHETIC_ENGINE_FIXTURE,
  SYNTHETIC_GATEWAY_PROBE_E2E_ENV,
  SYNTHETIC_GATEWAY_PROBE_FIXTURE,
  exactExecutablePattern,
  resolveGatewayProbeLaunch,
  resolveNativeResourcePath,
  resolveEngineLaunch,
};
