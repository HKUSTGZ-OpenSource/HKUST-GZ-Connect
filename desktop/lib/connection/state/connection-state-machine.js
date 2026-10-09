'use strict';

const { planReconnect } = require('./reconnect-policy');
const { ConnectionWaitRegistry } = require('./connection-wait-registry');
const { projectConnectionStatus, ConnectionStatusRuntime } = require('./connection-recovery-presentation');

const CONNECTION_PHASE = Object.freeze({
  IDLE: 'idle',
  STARTING: 'starting',
  AUTHENTICATING: 'authenticating',
  PREPARING_TUNNEL: 'preparing-tunnel',
  CONNECTED: 'connected',
  STOPPING: 'stopping',
  RETRY_WAIT: 'retry-wait',
  CONNECTIVITY_PAUSED: 'connectivity-paused',
});

const CONNECTING_PHASES = new Set([
  CONNECTION_PHASE.STARTING,
  CONNECTION_PHASE.AUTHENTICATING,
  CONNECTION_PHASE.PREPARING_TUNNEL,
  CONNECTION_PHASE.RETRY_WAIT,
]);
const READINESS_PHASES = new Set([
  CONNECTION_PHASE.PREPARING_TUNNEL,
  CONNECTION_PHASE.CONNECTED,
]);

function connectionPresentation(snapshot) {
  const phase = snapshot?.phase;
  return Object.freeze({
    phase,
    connected: phase === CONNECTION_PHASE.CONNECTED,
    connecting: CONNECTING_PHASES.has(phase),
  });
}

function validGeneration(value) {
  return Number.isSafeInteger(value) && value > 0;
}

// Pure connection-lifecycle decisions. Process ownership and all I/O remain in
// the injected operation effects/EngineSupervisor; this object owns only the user intent, desired
// state, retry budget, and the generation token accepted by lifecycle events.
class ConnectionStateMachine {
  #intent;
  #desiredConnected;
  #userDisconnected;
  #attempts;
  #phase;
  #engineGeneration;
  #engineConnectedCandidate;
  #listenerReady;
  #wasConnectedBeforeStop;
  #connectedUptimeBeforeStop;

  constructor() {
    this.#intent = 0;
    this.#desiredConnected = false;
    this.#userDisconnected = false;
    this.#attempts = 0;
    this.#phase = CONNECTION_PHASE.IDLE;
    this.#engineGeneration = null;
    this.#engineConnectedCandidate = false;
    this.#listenerReady = false;
    this.#wasConnectedBeforeStop = false;
    this.#connectedUptimeBeforeStop = 0;
  }

  snapshot() {
    return Object.freeze({
      intent: this.#intent,
      desiredConnected: this.#desiredConnected,
      userDisconnected: this.#userDisconnected,
      attempts: this.#attempts,
      attemptNumber: this.#attempts + 1,
      phase: this.#phase,
      engineGeneration: this.#engineGeneration,
      engineConnectedCandidate: this.#engineConnectedCandidate,
      listenerReady: this.#listenerReady,
      wasConnectedBeforeStop: this.#wasConnectedBeforeStop,
      connectedUptimeBeforeStop: this.#connectedUptimeBeforeStop,
    });
  }

  isCurrentIntent(intent) {
    return Number.isSafeInteger(intent) && intent === this.#intent;
  }

  canContinue(intent, { isQuitting = false } = {}) {
    return !isQuitting && this.isCurrentIntent(intent) && this.#desiredConnected;
  }

  canAttempt(intent, { isQuitting = false } = {}) {
    return this.canContinue(intent, { isQuitting }) && !this.#userDisconnected;
  }

  currentRecoveryIntent({ isQuitting = false } = {}) {
    return !isQuitting && this.#desiredConnected ? this.#intent : null;
  }

  canRecover(intent, { isQuitting = false, autoReconnect = true } = {}) {
    return autoReconnect && this.canContinue(intent, { isQuitting });
  }

  nextIntent(wantsConnected) {
    if (this.#intent === Number.MAX_SAFE_INTEGER) {
      throw new RangeError('connection lifecycle intent exhausted');
    }
    this.#intent += 1;
    this.#desiredConnected = wantsConnected === true;
    return this.#intent;
  }

  beginConnectIntent() {
    return this.nextIntent(true);
  }

  beginConnectAttempt(intent, { isRetry = false } = {}) {
    if (!this.canContinue(intent)) return false;
    if (!isRetry) {
      this.#attempts = 0;
      this.#userDisconnected = false;
    }
    this.#phase = CONNECTION_PHASE.STARTING;
    return true;
  }

  beginStop(wantsConnectedAfterStop) {
    const intent = this.nextIntent(wantsConnectedAfterStop === true);
    this.#userDisconnected = true;
    this.#phase = CONNECTION_PHASE.STOPPING;
    this.invalidateEngineGeneration();
    return intent;
  }

  stopCompleted(intent, { ok } = {}) {
    if (!this.isCurrentIntent(intent)) return { action: 'stale' };
    if (!ok || !this.#desiredConnected) this.#phase = CONNECTION_PHASE.IDLE;
    return { action: ok ? 'stopped' : 'failed', desiredConnected: this.#desiredConnected };
  }

  resumeAfterStop(intent) {
    if (!this.canContinue(intent)) return false;
    this.#userDisconnected = false;
    this.#phase = CONNECTION_PHASE.STARTING;
    return true;
  }

  pauseForConnectivity(intent, { isQuitting = false } = {}) {
    if (!this.canContinue(intent, { isQuitting })) return false;
    this.#phase = CONNECTION_PHASE.CONNECTIVITY_PAUSED;
    this.invalidateEngineGeneration();
    return true;
  }

  resumeConnectivity(intent, { isQuitting = false, autoReconnect = true } = {}) {
    if (!this.canRecover(intent, { isQuitting, autoReconnect })) return false;
    this.#userDisconnected = false;
    this.#phase = CONNECTION_PHASE.STARTING;
    return true;
  }

  bindEngineGeneration(generation) {
    if (!validGeneration(generation) || !this.#desiredConnected) return false;
    this.#engineGeneration = generation;
    this.#engineConnectedCandidate = false;
    this.#listenerReady = false;
    this.#wasConnectedBeforeStop = false;
    this.#connectedUptimeBeforeStop = 0;
    return true;
  }

  invalidateEngineGeneration() {
    const previous = this.#engineGeneration;
    this.#engineGeneration = null;
    this.#engineConnectedCandidate = false;
    this.#listenerReady = false;
    this.#wasConnectedBeforeStop = false;
    this.#connectedUptimeBeforeStop = 0;
    return previous;
  }

  isCurrentGeneration(generation) {
    return validGeneration(generation) && generation === this.#engineGeneration;
  }

  markEnginePhase(generation, engineState) {
    if (!this.isCurrentGeneration(generation) || !this.#desiredConnected ||
        this.#userDisconnected) return false;
    const next = {
      connecting: CONNECTION_PHASE.STARTING,
      authenticating: CONNECTION_PHASE.AUTHENTICATING,
      preparing_tunnel: CONNECTION_PHASE.PREPARING_TUNNEL,
    }[engineState];
    if (!next) return false;
    if (next === this.#phase) return true;
    const allowed = {
      [CONNECTION_PHASE.STARTING]: new Set([
        CONNECTION_PHASE.AUTHENTICATING,
        CONNECTION_PHASE.PREPARING_TUNNEL,
      ]),
      [CONNECTION_PHASE.AUTHENTICATING]: new Set([
        CONNECTION_PHASE.PREPARING_TUNNEL,
      ]),
    };
    if (!allowed[this.#phase]?.has(next)) return false;
    this.#phase = next;
    return true;
  }

  recordEngineConnectedCandidate(generation) {
    if (!this.isCurrentGeneration(generation) || !this.#desiredConnected ||
        this.#userDisconnected || !READINESS_PHASES.has(this.#phase)) return false;
    this.#engineConnectedCandidate = true;
    return this.isReadyToConnect(generation);
  }

  recordListenerReady(generation) {
    if (!this.isCurrentGeneration(generation) || !this.#desiredConnected ||
        this.#userDisconnected || !READINESS_PHASES.has(this.#phase)) return false;
    this.#listenerReady = true;
    return this.isReadyToConnect(generation);
  }

  isReadyToConnect(generation) {
    return this.isCurrentGeneration(generation) && this.#desiredConnected &&
      !this.#userDisconnected && READINESS_PHASES.has(this.#phase) &&
      this.#engineConnectedCandidate && this.#listenerReady;
  }

  markConnected(generation) {
    if (!this.isReadyToConnect(generation)) return false;
    this.#phase = CONNECTION_PHASE.CONNECTED;
    return true;
  }

  markEngineStopping(generation, { uptimeMs = 0 } = {}) {
    if (!this.isCurrentGeneration(generation)) return false;
    if (this.#phase === CONNECTION_PHASE.CONNECTED) {
      this.#wasConnectedBeforeStop = true;
      if (Number.isFinite(uptimeMs) && uptimeMs >= 0) {
        this.#connectedUptimeBeforeStop = Math.max(
          this.#connectedUptimeBeforeStop,
          Math.trunc(uptimeMs),
        );
      }
    }
    this.#engineConnectedCandidate = false;
    this.#listenerReady = false;
    this.#phase = CONNECTION_PHASE.STOPPING;
    return true;
  }

  presentation() {
    return connectionPresentation(this.snapshot());
  }

  isConnected() {
    return this.#phase === CONNECTION_PHASE.CONNECTED;
  }

  isConnecting() {
    return CONNECTING_PHASES.has(this.#phase);
  }

  failIntent(intent = this.#intent) {
    if (!this.isCurrentIntent(intent)) return false;
    this.#desiredConnected = false;
    this.#phase = CONNECTION_PHASE.IDLE;
    return true;
  }

  engineClosed({
    generation,
    supervisorGenerationCurrent = true,
    terminalFailure = false,
    autoReconnect = true,
    maxAttempts = 0,
    uptimeMs = 0,
    failureKind = 'unknown',
  } = {}) {
    // Both tokens are required. EngineSupervisor owns process generation;
    // this mirror ensures an explicit stop/connectivity invalidation wins even
    // if an old close callback arrives after a new lifecycle intent.
    if (!supervisorGenerationCurrent || !this.isCurrentGeneration(generation)) {
      return Object.freeze({ action: 'ignored' });
    }
    const wasConnected = this.#phase === CONNECTION_PHASE.CONNECTED || this.#wasConnectedBeforeStop;
    uptimeMs = Math.max(uptimeMs, this.#connectedUptimeBeforeStop);
    this.invalidateEngineGeneration();
    this.#phase = CONNECTION_PHASE.IDLE;

    if (this.#userDisconnected || !this.#desiredConnected || terminalFailure) {
      if (terminalFailure) this.#desiredConnected = false;
      return Object.freeze({
        action: terminalFailure ? 'terminal' : 'settled',
        desiredConnected: this.#desiredConnected,
      });
    }

    const retry = autoReconnect ? planReconnect({
      attempts: this.#attempts,
      maxAttempts,
      wasConnected,
      uptimeMs,
      failureKind,
    }) : null;
    if (retry) {
      this.#attempts = retry.attempt;
      this.#phase = CONNECTION_PHASE.RETRY_WAIT;
      return Object.freeze({ action: 'retry', ...retry });
    }

    this.#desiredConnected = false;
    return Object.freeze({ action: 'exhausted' });
  }
}

// Imperative operation ownership is separate from the pure FSM above. All
// process, Browser, recovery and presentation effects are injected by Main.
class ConnectionOperationCoordinator {
  constructor(options) {
    Object.assign(this, options);
    this.connectInFlight = null;
    this.disconnectInFlight = null;
    this.reconnectInFlight = null;
  }

  isCurrentEngineContext(generation, token) {
    return this.engineSupervisor.isCurrent(generation) && this.contextLease.isCurrent(token, {
      connectionIntent: this.connectionState.snapshot().intent, engineGeneration: generation,
    });
  }

  canResumeBrowser() {
    return this.connectionState.isConnected() && this.engineSupervisor.hasActive;
  }

  reconnectCurrentEngineContext(generation, token) {
    return this.isCurrentEngineContext(generation, token)
      ? this.reconnect(generation) : Promise.resolve({ ok: false, stale: true });
  }

  pauseInitialOffline() {
    this.connectivityRecovery.cancel();
    const intent = this.connectionState.beginConnectIntent();
    return this.connectivityRecovery.networkOffline(intent) ? intent : null;
  }

  currentRecoveryIntent() {
    return this.connectionState.currentRecoveryIntent({ isQuitting: this.isQuitting() === true });
  }

  invalidateForConnectivity(reason, intent) {
    if (!this.connectionState.pauseForConnectivity(intent, {
      isQuitting: this.isQuitting() === true,
    })) return false;
    // Keep the lifecycle intent stable: resume/online is allowed to recover
    // this exact user-requested connection, while generation invalidation makes
    // every old engine event, retry, and health probe inert immediately.
    this.engineSupervisor.invalidate();
    this.clearPresentation();
    this.getPresentation().lastError = this.getTranslator()(reason === 'suspend'
      ? 'error.connectionSuspended'
      : 'error.networkUnavailable');
    this.emit();
    return this.ensureEngineStopped().then((result) => {
      if (!this.connectionState.canContinue(intent) || result.ok) return;
      this.getPresentation().lastError = this.getTranslator()('error.engineStuck');
      this.emit();
    }).catch(() => {});
  }

  shouldReconnectForConnectivity(intent, reason) {
    try {
      return this.connectionState.canRecover(intent, {
        isQuitting: this.isQuitting() === true,
        autoReconnect: reason === 'initial-network-online' ||
          (this.loadSettingsOrReport().autoReconnect !== false),
      });
    } catch {
      this.connectionState.failIntent(intent);
      this.emit();
      return false;
    }
  }

  async recoverConnectivity(intent, reason) {
    let autoReconnect;
    try {
      autoReconnect = reason === 'initial-network-online' ||
        (this.loadSettingsOrReport().autoReconnect !== false);
    } catch {
      this.connectionState.failIntent(intent);
      this.emit();
      return false;
    }
    if (!this.connectionState.canRecover(intent, {
      isQuitting: this.isQuitting() === true,
      autoReconnect,
    })) return false;
    const stopped = await this.ensureEngineStopped();
    // Offline/suspend can prevent remote logout even after the old child has
    // closed. Local closure is the restart barrier for this physical outage;
    // the new generation must authenticate independently before serving.
    if (!stopped.ok || !this.connectionState.canContinue(intent, {
      isQuitting: this.isQuitting() === true,
    })) {
      if (!stopped.ok && this.connectionState.isCurrentIntent(intent)) {
        this.connectionState.failIntent(intent);
        this.getPresentation().lastError = this.getTranslator()('error.engineStuck');
        this.emit();
      }
      return false;
    }
    if (!this.connectionState.resumeConnectivity(intent, {
      isQuitting: this.isQuitting() === true,
      autoReconnect,
    })) return false;
    const result = await this.connect(false, intent);
    return result.ok === true;
  }

  onConnectivityRecoveryDeclined(intent, reason) {
    if (reason !== 'initial-network-online' && this.connectionState.failIntent(intent)) this.emit();
  }

  rejectConnectionWhileQuitting(intent = this.connectionState.snapshot().intent) {
    if (this.isQuitting() !== true) return null;
    this.connectionState.failIntent(intent); this.emit();
    return { ok: false, stale: true, quitting: true, intent };
  }

  beginLifecycleIntent() {
    this.cancelRecovery();
    return this.connectionState.beginConnectIntent();
  }

  async connect(isRetry = false, expectedIntent = null) {
    let rejected = this.rejectConnectionWhileQuitting(expectedIntent ?? undefined);
    if (rejected) return rejected;
    let intent = expectedIntent;
    if (intent === null && !isRetry) {
      if (this.disconnectInFlight) await this.disconnectInFlight;
      rejected = this.rejectConnectionWhileQuitting(); if (rejected) return rejected;
      const current = this.connectionState.snapshot();
      if (current.desiredConnected) {
        if (this.connectInFlight?.intent === current.intent) return this.connectInFlight.promise;
        return { ok: true, existing: this.engineSupervisor.hasActive,
          pending: !this.engineSupervisor.hasActive, intent: current.intent };
      }
      intent = this.beginLifecycleIntent();
    } else if (intent === null) intent = this.connectionState.snapshot().intent;
    if (!this.connectionState.canContinue(intent)) return { ok: false, stale: true, intent };
    // Never start another process in the previous Engine's exit/close interval.
    if (this.disconnectInFlight) await this.disconnectInFlight;
    rejected = this.rejectConnectionWhileQuitting(intent); if (rejected) return rejected;
    if (!this.connectionState.canContinue(intent)) return { ok: false, stale: true, intent };
    if (this.engineSupervisor.hasActive) return { ok: true, existing: true, intent };
    if (this.connectInFlight) {
      await this.connectInFlight.promise;
      rejected = this.rejectConnectionWhileQuitting(intent); if (rejected) return rejected;
      if (!this.connectionState.canContinue(intent)) return { ok: false, stale: true, intent };
      if (this.engineSupervisor.hasActive) return { ok: true, existing: true, intent };
    }
    const operation = (async () => ({ ...await this.runAttempt(isRetry, intent), intent }))();
    const record = { intent, promise: operation }; this.connectInFlight = record;
    try { return await operation; }
    finally { if (this.connectInFlight === record) this.connectInFlight = null; }
  }

  // The Browser's boolean request gate and open-result path intentionally keep
  // their previous failure timing. Both wait on the same intent-bound registry
  // only when their own admission contract calls for it.
  async ensureBrowserReady() {
    if (this.connectionState.isConnected()) return true;
    const result = await this.connect();
    if (!result?.ok && !this.connectionState.isConnecting()) return false;
    return this.waitForConnected(result.intent);
  }

  async ensureBrowserConnected() {
    if (!this.connectionState.isConnected()) {
      const result = await this.connect();
      if (!await this.waitForConnected(result.intent)) {
        return { ok: false, error: this.getPresentation().lastError ||
          this.getTranslator()('error.connectTimeout') };
      }
    }
    return { ok: true };
  }

  ensureEngineStopped() {
    if (this.disconnectInFlight) return this.disconnectInFlight;
    // The injected effect establishes the Browser gate before freeing the
    // listener. Its policy/timeout authority remains in the existing owners.
    const operation = this.stopEngine();
    this.disconnectInFlight = operation;
    operation.finally(() => {
      this.removeSidecar();
      if (this.disconnectInFlight === operation) this.disconnectInFlight = null;
    });
    return operation;
  }

  initiateStop(wantsConnectedAfterStop) {
    this.cancelRecovery();
    const intent = this.connectionState.beginStop(wantsConnectedAfterStop);
    this.engineSupervisor.invalidate();
    this.clearProxyCredential();
    this.clearPresentation();
    this.emit();
    return { intent, stopped: this.ensureEngineStopped() };
  }

  async disconnect() {
    const { intent, stopped } = this.initiateStop(false);
    const result = await stopped;
    this.removeSidecar();
    this.connectionState.stopCompleted(intent, result);
    if (this.connectionState.isCurrentIntent(intent) && !result.ok) {
      this.getPresentation().lastError = this.getTranslator()('error.engineStuck');
      this.emit();
    } else if (this.connectionState.isCurrentIntent(intent) && result.cleanExit === false) {
      this.getPresentation().lastError = this.getTranslator()('error.engineCleanupUnconfirmed');
      this.emit();
    }
    return { ok: result.ok };
  }

  async reconnect(expectedGeneration = null) {
    let rejected = this.rejectConnectionWhileQuitting(); if (rejected) return rejected;
    if (expectedGeneration !== null && !this.engineSupervisor.isCurrent(expectedGeneration)) {
      return { ok: false, stale: true };
    }
    if (this.reconnectInFlight && this.connectionState.isCurrentIntent(this.reconnectInFlight.intent) &&
        this.connectionState.snapshot().desiredConnected) return this.reconnectInFlight.promise;
    if (this.reconnectInFlight) await this.reconnectInFlight.promise;
    rejected = this.rejectConnectionWhileQuitting(); if (rejected) return rejected;
    if (expectedGeneration !== null && !this.engineSupervisor.isCurrent(expectedGeneration)) {
      return { ok: false, stale: true };
    }
    const { intent, stopped } = this.initiateStop(true);
    const operation = (async () => {
      const stopResult = await stopped;
      const quitResult = this.rejectConnectionWhileQuitting(intent); if (quitResult) return quitResult;
      this.connectionState.stopCompleted(intent, stopResult);
      if (!stopResult.ok || stopResult.cleanExit === false) {
        this.connectionState.failIntent(intent);
        this.getPresentation().lastError = this.getTranslator()(stopResult.cleanExit === false
          ? 'error.engineCleanupUnconfirmed' : 'error.engineStuck');
        this.emit();
        return { ok: false };
      }
      if (!this.connectionState.resumeAfterStop(intent)) return { ok: false, stale: true };
      return this.connect(false, intent);
    })();
    const record = { intent, promise: operation }; this.reconnectInFlight = record;
    try { return await operation; }
    finally { if (this.reconnectInFlight === record) this.reconnectInFlight = null; }
  }
}

module.exports = {
  CONNECTION_PHASE,
  ConnectionWaitRegistry,
  ConnectionStateMachine,
  ConnectionOperationCoordinator,
  connectionPresentation,
  projectConnectionStatus,
  ConnectionStatusRuntime,
};
