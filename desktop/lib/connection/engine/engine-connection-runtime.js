'use strict';

const { EngineEventParser } = require('./engine-protocol');
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

module.exports = {
  EngineConnectionRuntime,
};
