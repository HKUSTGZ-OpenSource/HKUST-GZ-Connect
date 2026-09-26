'use strict';

const { EngineEventParser } = require('./engine-protocol');
const { classifyEngineCode, classifyEngineOutput, classifyEngineStopReason, resolveEngineFailureKind, formatEngineEventDiagnostic } = require('./engine-output');
const MAX_ATTEMPTS = 3;
const {
  ENGINE_HELLO_TIMEOUT_MS,
  EngineProtocolSession,
} = require('./engine-protocol-session');

const NOOP = () => {};

class EngineConnectionRuntime {
  constructor({
    generation,
    contextToken,
    expectedPort,
    stdin,
    controlRegistry,
    isCurrent,
    handlers = {},
    helloTimeoutMs = ENGINE_HELLO_TIMEOUT_MS,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = {}) {
    if (!Number.isSafeInteger(generation) || generation <= 0) {
      throw new TypeError('a positive Engine generation is required');
    }
    if (!contextToken || typeof contextToken !== 'object') {
      throw new TypeError('an active context token is required');
    }
    if (!Number.isInteger(expectedPort) || expectedPort < 1025 || expectedPort > 65535) {
      throw new TypeError('a valid expected listener port is required');
    }
    if (!controlRegistry || typeof controlRegistry.bind !== 'function') {
      throw new TypeError('an Engine control registry is required');
    }
    if (typeof isCurrent !== 'function' || !Number.isFinite(helloTimeoutMs) ||
        helloTimeoutMs <= 0 || typeof setTimeoutFn !== 'function' ||
        typeof clearTimeoutFn !== 'function') {
      throw new TypeError('Engine runtime lifecycle dependencies are invalid');
    }
    this.generation = generation;
    this.contextToken = contextToken;
    this.expectedPort = expectedPort;
    this.isCurrent = isCurrent;
    this.handlers = {
      onDiagnostic: handlers.onDiagnostic || NOOP,
      onConnecting: handlers.onConnecting || NOOP,
      onStopping: handlers.onStopping || NOOP,
      onConnectionCandidate: handlers.onConnectionCandidate || NOOP,
      onListenerReady: handlers.onListenerReady || NOOP,
      onListenerMismatch: handlers.onListenerMismatch || NOOP,
      onClientIpAssigned: handlers.onClientIpAssigned || NOOP,
      onDnsMode: handlers.onDnsMode || NOOP,
      onNetworkUnhealthy: handlers.onNetworkUnhealthy || NOOP,
      onFatalError: handlers.onFatalError || NOOP,
      onStopped: handlers.onStopped || NOOP,
      onProtocolTimeout: handlers.onProtocolTimeout || NOOP,
      onProviderCapabilities: handlers.onProviderCapabilities || NOOP,
    };
    for (const handler of Object.values(this.handlers)) {
      if (typeof handler !== 'function') throw new TypeError('Engine runtime handler is invalid');
    }
    this.helloTimeoutMs = helloTimeoutMs;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.protocol = new EngineProtocolSession(generation);
    this.events = new EngineEventParser();
    this.control = controlRegistry.bind(generation, stdin, contextToken);
    this.stdout = null;
    this.stdoutListener = null;
    this.helloTimer = null;
    this.started = false;
    this.disposed = false;
    this.exitDraining = false;
  }

  get stoppedReason() { return this.protocol.stoppedReason; }

  get helloSeen() { return this.protocol.helloSeen; }

  start(stdout) {
    if (this.disposed) throw new Error('Engine runtime is disposed');
    if (this.started) return false;
    if (!stdout || typeof stdout.on !== 'function') {
      throw new TypeError('an Engine stdout stream is required');
    }
    this.started = true;
    this.stdout = stdout;
    this.stdoutListener = (data) => this.feed(data);
    stdout.on('data', this.stdoutListener);
    this.helloTimer = this.setTimeoutFn(() => {
      this.helloTimer = null;
      if (!this.protocol.helloSeen && this.isCurrent(this.generation)) {
        this.handlers.onProtocolTimeout();
      }
    }, this.helloTimeoutMs);
    this.helloTimer.unref?.();
    // Control v2 negotiation starts during authentication. It remains
    // optional for the current password-only provider and must not turn a
    // failed graceful-control handshake into a connection failure.
    this.control.handshake()
      .then(() => this.control.providerCapabilities())
      .then((report) => {
        if (!this.disposed && this.isCurrent(this.generation)) {
          this.handlers.onProviderCapabilities(report);
        }
      })
      .catch(NOOP);
    return true;
  }

  feed(data) {
    if (this.disposed) return;
    if (!this.isCurrent(this.generation)) {
      // A stop invalidates UI/serving authority before waiting for this owned child's ack.
      this.control.feedShutdown?.(data);
      return;
    }
    this.control.feed(data);
    for (const event of this.events.feed(data)) this.#apply(event);
  }

  beginExitDrain() {
    if (this.disposed || this.exitDraining) return false;
    this.exitDraining = true;
    if (this.helloTimer) this.clearTimeoutFn(this.helloTimer);
    this.helloTimer = null;
    return true;
  }

  dispose() {
    if (this.disposed) return false;
    this.disposed = true;
    if (this.helloTimer) this.clearTimeoutFn(this.helloTimer);
    this.helloTimer = null;
    if (this.stdout && this.stdoutListener) {
      this.stdout.off?.('data', this.stdoutListener);
      this.stdout.removeListener?.('data', this.stdoutListener);
    }
    this.stdout = null;
    this.stdoutListener = null;
    this.events.reset();
    return true;
  }

  #apply(event) {
    if (!this.protocol.accept(event)) return;
    // Node may emit child `exit` before the stdout pipe reaches `close`.
    // Continue parsing only the terminal outcome in that interval; buffered
    // readiness/state metadata must never reopen Browser or connection state
    // after the process has already released its listener.
    if (this.exitDraining && event.type !== 'fatal_error' && event.type !== 'stopped') return;
    this.handlers.onDiagnostic(event);
    switch (event.type) {
      case 'hello':
        if (this.helloTimer) this.clearTimeoutFn(this.helloTimer);
        this.helloTimer = null;
        break;
      case 'state_changed':
        if (event.state === 'connecting' || event.state === 'authenticating' ||
            event.state === 'preparing_tunnel') {
          this.handlers.onConnecting(event.state);
        } else if (event.state === 'connected') {
          this.handlers.onConnectionCandidate();
        } else if (event.state === 'stopping') {
          this.handlers.onStopping();
        }
        break;
      case 'listener_ready':
        if (event.port === this.expectedPort) this.handlers.onListenerReady();
        else this.handlers.onListenerMismatch(event.port, this.expectedPort);
        break;
      case 'client_ip_assigned':
        this.handlers.onClientIpAssigned(event.family, event.address);
        break;
      case 'dns_mode':
        this.handlers.onDnsMode(event.mode);
        break;
      case 'network_unhealthy':
        this.handlers.onNetworkUnhealthy(event.reason);
        break;
      case 'fatal_error':
        this.handlers.onFatalError(event.code, event.secondaryCode);
        break;
      case 'stopped':
        this.handlers.onStopped(event.reason);
        break;
      default:
        break;
    }
  }
}

// Per-attempt serving promotion and presentation. Protocol admission stays in
// EngineConnectionRuntime; process creation, credentials and shutdown stay with their owners.
class EngineServingCoordinator {
  constructor(ports) {
    Object.assign(this, ports);
    this.diagnosticTail = '';
    this.fatalCode = null;
    this.browserActivationInFlight = null;
    this.handlers = {
      onDiagnostic: (event) => this.appendDiagnostic(formatEngineEventDiagnostic(event, { ...this.connectionState.snapshot(), generation: this.generation })),
      onConnecting: (engineState) => {
        if (!this.connectionState.markEnginePhase(this.generation, engineState)) return;
        this.emit();
      },
      onStopping: () => { if (this.revokeServing()) this.emit(); },
      onConnectionCandidate: () => {
        this.connectionState.recordEngineConnectedCandidate(this.generation);
        this.markConnected();
      },
      onListenerReady: () => {
        this.connectionState.recordListenerReady(this.generation);
        this.markConnected();
      },
      onListenerMismatch: () => {
        this.revokeServing(); this.fatalCode = 'LOCAL_LISTENER_FAILED';
        this.presentation.lastError = classifyEngineCode(this.fatalCode, this.port, this.t); this.emit();
        this.stopEngine().catch(() => {});
      },
      onClientIpAssigned: (_family, address) => {
        this.connectionState.markEnginePhase(this.generation, 'preparing_tunnel');
        this.presentation.clientIp = address;
        this.emit();
      },
      onDnsMode: (mode) => {
        this.presentation.dnsMode = mode;
        this.emit();
      },
      onNetworkUnhealthy: () => {
        this.revokeServing(); this.presentation.lastError = this.t('error.tunnelRecovering'); this.emit();
      },
      onFatalError: (code, secondaryCode) => {
        this.revokeServing(); this.fatalCode = code;
        this.presentation.lastError = classifyEngineCode(code, this.port, this.t, secondaryCode); this.emit();
      },
      onProtocolTimeout: () => {
        this.revokeServing();
        this.fatalCode = 'EVENT_OUTPUT_FAILED';
        this.presentation.lastError = classifyEngineCode(this.fatalCode, this.port, this.t);
        this.emit();
        this.stopEngine()
          .catch(() => {});
      },
      onProviderCapabilities: (report) => this.observeCapabilities(report) && this.emit(),
    };
  }

  get generation() { return this.getGeneration(); }
  get browser() { return this.getBrowser(); }
  get presentation() { return this.getPresentation(); }
  get t() { return this.getTranslator(); }

  finishConnected() {
    const wasConnected = this.connectionState.isConnected();
    if (!this.isCurrent(this.generation) ||
        !this.connectionState.markConnected(this.generation)) return;
    this.presentation.lastError = null;
    if (!wasConnected) {
      this.onFirstConnected();
    }
    this.emit();
  }
  markConnected() {
    if (!this.isCurrent(this.generation) ||
        !this.connectionState.isReadyToConnect(this.generation)) return;
    if (!this.browser.routingSuspended) {
      this.finishConnected();
      return;
    }
    if (this.browserActivationInFlight) return;
    const activation = this.browser.resumeRoutingPolicy(Number(this.port));
    this.browserActivationInFlight = activation;
    activation.then(() => {
      if (this.browserActivationInFlight === activation) this.browserActivationInFlight = null;
      this.finishConnected();
    }).catch((error) => {
      if (this.browserActivationInFlight === activation) this.browserActivationInFlight = null;
      if (!this.isCurrent(this.generation)) return;
      // The engine is usable by authenticated external clients, while the
      // built-in browser deliberately remains behind its request gate.
      this.finishConnected();
      this.presentation.browserNotice = this.t('error.browserRoutingAfterSave', { message: error.message });
      this.emit();
    });
  }
  applyHumanDiagnostic(chunk) {
    this.diagnosticTail = (this.diagnosticTail + chunk).slice(-512);
    if (!this.isCurrent(this.generation)) return;
    const classifiedError = classifyEngineOutput(this.diagnosticTail, this.port, this.t);
    if (classifiedError) {
      this.presentation.lastError = classifiedError;
      this.emit();
    }
  }
}

// Process termination uses the same connection state authority as serving.
// Side effects stay injected; this coordinator owns neither credential files nor process handles.
class EngineTerminationCoordinator {
  constructor(ports) { Object.assign(this, ports); }
  get presentation() { return this.getPresentation(); }
  get connectedAt() { return this.getConnectedAt(); }
  get t() { return this.getTranslator(); }

  close({ code, generation }, diagnosticTail,
    structuredFatalCode = null, structuredStopReason = null, stoppedSocksPort = 1080,
    isCurrentContext = () => true) {
    // A delayed close from an already invalidated generation must not suspend a
    // newer listener that is now serving the browser.
    const supervisorGenerationCurrent = this.isGenerationCurrent(generation) && isCurrentContext(generation);
    this.clearControl(generation);
    if (!this.cleanupProxyAccess({ generation, supervisorGenerationCurrent,
      connectionGenerationCurrent: this.connectionState.isCurrentGeneration(generation),
      clearCredential: this.clearCredential, removeSidecar: this.removeSidecar,
    })) return;
    // Unexpected process death releases the configured loopback port before the
    // close event reaches JavaScript. Repoint the persistent browser Session at
    // its fail-closed PAC immediately; a later generation may restore it only
    // after reporting listener_ready.
    this.suspendBrowser().catch((error) => {
      this.presentation.browserNotice = this.t('error.browserRoutingAfterSave', { message: error.message });
      this.emit();
    });
    const closeSnapshot = this.connectionState.snapshot(); const wasConnected = closeSnapshot.phase === 'connected' || closeSnapshot.wasConnectedBeforeStop;
    const uptime = Math.max(this.connectedAt ? this.now() - this.connectedAt : 0, closeSnapshot.connectedUptimeBeforeStop);
    this.clearPresentation();
    const failureKind = resolveEngineFailureKind({
      code: structuredFatalCode,
      stopReason: structuredStopReason,
      diagnosticText: diagnosticTail,
    });
    const terminalFailure = failureKind === 'terminal'; this.presentation.failureKind = failureKind; this.presentation.failureCode = structuredFatalCode || structuredStopReason || null;
    if (!structuredFatalCode && !this.presentation.lastError) {
      this.presentation.lastError = classifyEngineStopReason(structuredStopReason, stoppedSocksPort, this.t);
    }
    let cfg;
    try {
      cfg = this.loadSettings();
    } catch (error) {
      this.connectionState.engineClosed({
        generation,
        supervisorGenerationCurrent,
        terminalFailure: true,
      });
      this.reportSettingsReadFailure(error, { emitState: false });
      this.emit();
      return;
    }
    const autoOn = cfg.autoReconnect !== false;
    const maxA = Number.isInteger(cfg.maxAttempts) ? cfg.maxAttempts : MAX_ATTEMPTS;
    const decision = this.connectionState.engineClosed({
      generation,
      supervisorGenerationCurrent,
      terminalFailure,
      autoReconnect: autoOn,
      maxAttempts: maxA,
      uptimeMs: uptime,
      failureKind,
    });
    if (decision.action === 'settled' || decision.action === 'terminal') {
      this.emit();
      return;
    }
    // Only a genuinely stable session earns a fresh retry budget. Merely
    // opening SOCKS and then losing the data plane must keep counting, or a
    // rejecting gateway can drive the app into an infinite login loop.
    if (decision.action === 'retry') {
      this.presentation.lastError = wasConnected
        ? this.t('error.reconnecting')
        : (failureKind === 'gateway-transient'
          ? this.t('error.gatewayRetrying')
          : null);
      this.emit();
      const intent = this.connectionState.snapshot().intent;
      this.scheduleRetry(generation, decision.delayMs, () => this.connect(true, intent));
      return;
    }

    if (failureKind === 'gateway-transient') {
      this.presentation.lastError = this.t('error.gatewayRejected');
    } else if (!this.presentation.lastError) {
      this.presentation.lastError = wasConnected
        ? this.t('error.reconnectFailed')
        : (code ? this.t('error.connectFailed') : null);
    }
    this.emit();
  }
  revokeServing(generation, isCurrentContext = () => true) {
    const uptimeMs = this.connectedAt ? this.now() - this.connectedAt : 0;
    if (!isCurrentContext(generation) || !this.isGenerationCurrent(generation) ||
        !this.connectionState.markEngineStopping(generation, { uptimeMs })) return false;
    // Its epoch and request gate synchronously defeat an awaiting activation.
    this.suspendBrowser().catch((error) => {
      this.presentation.browserNotice = this.t('error.browserRoutingAfterSave', { message: error.message });
      this.emit();
    });
    this.clearPresentation(); return true;
  }
  exit({ generation }, isCurrentContext = () => true) {
    // `exit` can precede stdio close; revoke serving synchronously but retain the
    // generation so the terminal-only drain can classify fatal/stopped output.
    if (!this.revokeServing(generation, isCurrentContext)) return;
    this.clearControl(generation);
    this.clearCredential(generation);
    this.removeSidecar();
    this.emit();
  }
}

module.exports = {
  EngineConnectionRuntime,
  EngineServingCoordinator,
  EngineTerminationCoordinator,
};
