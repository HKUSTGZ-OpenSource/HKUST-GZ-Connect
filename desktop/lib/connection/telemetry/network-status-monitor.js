'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { NetworkEnvironmentService } = require('../../network-environment/runtime/network-environment-service');
const { PublicEgressProbe } = require('../../network-environment/egress/public-egress-probe');

const DEFAULT_NETWORK_POLL_MS = 4000;
const MIN_NETWORK_POLL_MS = 1000;
const MAX_NETWORK_POLL_MS = 60_000;
const DEFAULT_AUTO_CONNECT_DELAY_MS = 500;
const DEFAULT_INITIAL_BASELINE_WAIT_MS = 15_000;
const MAX_INITIAL_BASELINE_WAIT_MS = 60_000;
const SYNTHETIC_NETWORK_E2E_ENV = 'HKUSTGZ_SYNTHETIC_NETWORK_E2E';
const SYNTHETIC_NETWORK_STATE_FILE = 'synthetic-network-state.txt';

function createStartupAutoConnectEligibility({ readSettings, hasPersistentCredential } = {}) {
  if (typeof readSettings !== 'function' || typeof hasPersistentCredential !== 'function') {
    throw new TypeError('startup auto-connect eligibility dependencies are invalid');
  }
  return () => {
    const settings = readSettings();
    return settings.autoConnect !== false && Boolean(settings.username) && hasPersistentCredential();
  };
}

// Owns the one-time hand-off from the first network sample to startup
// auto-connect. Runtime outage recovery remains in ConnectivityRecovery; this
// coordinator only prevents an initially-offline launch from spending its
// retry budget before the machine has a usable network.
class NetworkStartupCoordinator {
  constructor({
    monitor,
    shouldAutoConnect,
    pauseOffline,
    resumeOffline,
    connect,
    isQuitting,
    setTimeout: setTimer = globalThis.setTimeout,
    clearTimeout: clearTimer = globalThis.clearTimeout,
    delayMs = DEFAULT_AUTO_CONNECT_DELAY_MS,
    baselineWaitMs = DEFAULT_INITIAL_BASELINE_WAIT_MS,
  } = {}) {
    if (!monitor || typeof monitor.start !== 'function' ||
        typeof monitor.snapshot !== 'function' ||
        typeof shouldAutoConnect !== 'function' || typeof pauseOffline !== 'function' ||
        typeof resumeOffline !== 'function' || typeof connect !== 'function' ||
        typeof isQuitting !== 'function' || typeof setTimer !== 'function' ||
        typeof clearTimer !== 'function' || !Number.isFinite(delayMs) || delayMs < 0 ||
        !Number.isFinite(baselineWaitMs) || baselineWaitMs <= 0 ||
        baselineWaitMs > MAX_INITIAL_BASELINE_WAIT_MS) {
      throw new TypeError('network startup coordinator dependencies are invalid');
    }
    Object.assign(this, {
      monitor, shouldAutoConnect, pauseOffline, resumeOffline, connect, isQuitting,
    });
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.delayMs = delayMs;
    this.baselineWaitMs = baselineWaitMs;
    this.epoch = 0;
    this.started = false;
    this.disposed = false;
    this.startPromise = null;
    this.timerRecord = null;
    this.pausedOffline = false;
    this.offlineContext = null;
    this.offlineConsumed = false;
    this.baselineWait = null;
  }

  current(epoch) {
    return !this.disposed && epoch === this.epoch && !this.isQuitting();
  }

  eligible() {
    if (this.isQuitting()) return false;
    try { return this.shouldAutoConnect() === true; }
    catch { return false; }
  }

  start() {
    if (this.disposed) return Promise.resolve(false);
    if (this.started) return this.startPromise;
    this.started = true;
    const epoch = ++this.epoch;
    this.startPromise = this.initialize(epoch);
    return this.startPromise;
  }

  async initialize(epoch) {
    let started;
    try { started = await this.monitor.start(); }
    catch { return false; }
    if (started !== true || !this.current(epoch) || !this.eligible()) return false;

    let baseline = this.monitor.snapshot().baseline;
    if (baseline == null) {
      if (typeof this.monitor.waitForBaseline !== 'function') return false;
      const waiting = this.monitor.waitForBaseline({ timeoutMs: this.baselineWaitMs });
      this.baselineWait = waiting;
      try { baseline = await waiting.promise; }
      finally {
        if (this.baselineWait === waiting) this.baselineWait = null;
        waiting.cancel();
      }
      if (!this.current(epoch) || typeof baseline !== 'boolean' || !this.eligible()) return false;
    }

    if (baseline === false) {
      let paused = null;
      try { paused = await this.pauseOffline(); } catch {}
      if (!this.current(epoch) || paused == null || paused === false) return false;
      this.pausedOffline = true;
      this.offlineContext = paused;
      return true;
    }

    const record = { epoch, timer: null };
    record.timer = this.setTimer(() => {
      if (this.timerRecord !== record) return undefined;
      this.timerRecord = null;
      if (!this.current(epoch) || !this.eligible()) return undefined;
      return Promise.resolve().then(() => this.connect()).catch(() => {});
    }, this.delayMs);
    record.timer?.unref?.();
    this.timerRecord = record;
    return true;
  }

  async networkOnline() {
    if (this.disposed || !this.pausedOffline || this.offlineConsumed || this.isQuitting()) {
      return false;
    }
    this.offlineConsumed = true;
    this.pausedOffline = false;
    const context = this.offlineContext;
    this.offlineContext = null;
    try { await this.resumeOffline(context); } catch {}
    return true;
  }

  cancel() {
    this.epoch += 1;
    this.baselineWait?.cancel();
    this.baselineWait = null;
    if (this.timerRecord) {
      try { this.clearTimer(this.timerRecord.timer); } catch {}
    }
    this.timerRecord = null;
    this.pausedOffline = false;
    this.offlineContext = null;
    this.offlineConsumed = true;
  }

  dispose() {
    if (this.disposed) return;
    this.cancel();
    this.disposed = true;
  }

  snapshot() {
    return {
      started: this.started,
      disposed: this.disposed,
      pausedOffline: this.pausedOffline,
      timerScheduled: this.timerRecord !== null,
    };
  }
}

function createNetworkStartupSystem({
  appIsPackaged,
  environment = process.env,
  dataDirectory,
  fileSystem = fs,
  isOnline,
  onOffline,
  onOnline,
  shouldAutoConnect,
  pauseOffline,
  resumeInitialOffline,
  connect,
  isQuitting,
  onPublicEgress = () => {},
} = {}) {
  if (typeof appIsPackaged !== 'boolean' || !environment ||
      typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory) ||
      !fileSystem || typeof isOnline !== 'function' || typeof onOffline !== 'function' ||
      typeof onOnline !== 'function' || typeof resumeInitialOffline !== 'function') {
    throw new TypeError('network startup system environment is invalid');
  }
  const synthetic = !appIsPackaged && environment[SYNTHETIC_NETWORK_E2E_ENV] === '1';
  const stateFile = path.join(dataDirectory, SYNTHETIC_NETWORK_STATE_FILE);
  let startup = null;
  const monitor = new NetworkStatusMonitor({
    isOnline: () => {
      if (!synthetic) return isOnline();
      try { return fileSystem.readFileSync(stateFile, 'utf8').trim() === 'online'; }
      catch { return false; }
    },
    onOffline,
    onOnline: async () => {
      if (await startup?.networkOnline()) return true;
      return onOnline();
    },
    intervalMs: synthetic ? 1000 : undefined,
  });
  startup = new NetworkStartupCoordinator({
    monitor, shouldAutoConnect, pauseOffline, resumeOffline: resumeInitialOffline,
    connect, isQuitting,
  });
  const environmentService = new NetworkEnvironmentService({
    platform: process.platform, environment,
    publicEgressProbe: synthetic ? null : new PublicEgressProbe(),
  });
  environmentService.setPublicEgressListener(onPublicEgress);
  return Object.freeze({ monitor, startup, environment: environmentService,
    syntheticStateFile: synthetic ? stateFile : null });
}

class NetworkStatusMonitor {
  constructor({
    isOnline,
    onOnline,
    onOffline,
    setTimeout: setTimer = globalThis.setTimeout,
    clearTimeout: clearTimer = globalThis.clearTimeout,
    intervalMs = DEFAULT_NETWORK_POLL_MS,
  } = {}) {
    if (typeof isOnline !== 'function' || typeof onOnline !== 'function' ||
        typeof onOffline !== 'function' || typeof setTimer !== 'function' ||
        typeof clearTimer !== 'function') {
      throw new TypeError('network status monitor callbacks are required');
    }
    if (!Number.isFinite(intervalMs) || intervalMs < MIN_NETWORK_POLL_MS ||
        intervalMs > MAX_NETWORK_POLL_MS) {
      throw new TypeError('network status monitor interval is out of range');
    }
    this.isOnline = isOnline;
    this.onOnline = onOnline;
    this.onOffline = onOffline;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.intervalMs = intervalMs;

    this.running = false;
    this.disposed = false;
    this.epoch = 0;
    this.baseline = null;
    this.timerRecord = null;
    this.pollRecord = null;
    this.baselineWaiters = new Set();
  }

  isCurrent(epoch) {
    return this.running && !this.disposed && epoch === this.epoch;
  }

  start() {
    if (this.disposed) return Promise.resolve(false);
    if (this.running) {
      return this.pollRecord ? this.pollRecord.promise : Promise.resolve(true);
    }
    this.running = true;
    this.epoch += 1;
    this.baseline = null;
    return this.poll(this.epoch);
  }

  poll(epoch) {
    if (!this.isCurrent(epoch)) return Promise.resolve(false);
    if (this.pollRecord && this.pollRecord.epoch === epoch) return this.pollRecord.promise;

    const record = { epoch, promise: null };
    record.promise = (async () => {
      let observed;
      try {
        // The Promise boundary catches both a synchronous net.isOnline throw
        // and a test/backend that exposes an asynchronous status provider.
        observed = await Promise.resolve().then(() => this.isOnline());
      } catch {
        observed = undefined;
      }
      if (!this.isCurrent(epoch)) return false;

      if (typeof observed === 'boolean') {
        if (this.baseline === null) {
          // Startup learns the current state without synthesizing an event.
          this.baseline = observed;
          this.publishBaseline(observed);
        } else if (observed !== this.baseline) {
          this.baseline = observed;
          try {
            await (observed ? this.onOnline() : this.onOffline());
          } catch {}
        }
      }
      return true;
    })().finally(() => {
      if (this.pollRecord === record) this.pollRecord = null;
      if (this.isCurrent(epoch)) this.schedule(epoch);
    });
    this.pollRecord = record;
    return record.promise;
  }

  schedule(epoch) {
    if (!this.isCurrent(epoch) || this.timerRecord) return false;
    const record = { epoch, timer: null };
    record.timer = this.setTimer(() => {
      if (this.timerRecord !== record || !this.isCurrent(epoch)) return undefined;
      this.timerRecord = null;
      return this.poll(epoch);
    }, this.intervalMs);
    if (record.timer && typeof record.timer.unref === 'function') record.timer.unref();
    this.timerRecord = record;
    return true;
  }

  waitForBaseline({ timeoutMs = DEFAULT_INITIAL_BASELINE_WAIT_MS } = {}) {
    if (this.disposed || !this.running || !Number.isFinite(timeoutMs) || timeoutMs <= 0 ||
        timeoutMs > MAX_INITIAL_BASELINE_WAIT_MS) {
      return { promise: Promise.resolve(null), cancel() {} };
    }
    if (typeof this.baseline === 'boolean') {
      return { promise: Promise.resolve(this.baseline), cancel() {} };
    }
    let resolve;
    const record = { resolve: null, timer: null, settled: false };
    const promise = new Promise((done) => { resolve = done; });
    record.resolve = resolve;
    this.baselineWaiters.add(record);
    const timer = this.setTimer(() => this.settleBaselineWaiter(record, null), timeoutMs);
    if (record.settled) {
      try { this.clearTimer(timer); } catch {}
    } else {
      record.timer = timer;
      record.timer?.unref?.();
    }
    return {
      promise,
      cancel: () => this.settleBaselineWaiter(record, null),
    };
  }

  settleBaselineWaiter(record, value) {
    if (!record || record.settled || !this.baselineWaiters.has(record)) return false;
    record.settled = true;
    this.baselineWaiters.delete(record);
    try { this.clearTimer(record.timer); } catch {}
    record.resolve(typeof value === 'boolean' ? value : null);
    return true;
  }

  publishBaseline(value) {
    for (const record of [...this.baselineWaiters]) this.settleBaselineWaiter(record, value);
  }

  stop() {
    if (!this.running) {
      this.baseline = null;
      this.publishBaseline(null);
      return;
    }
    this.running = false;
    this.epoch += 1;
    this.baseline = null;
    this.publishBaseline(null);
    if (this.timerRecord) {
      try { this.clearTimer(this.timerRecord.timer); } catch {}
      this.timerRecord = null;
    }
    // An asynchronous poll is intentionally not cancelled; its epoch check
    // makes the result inert, and its finally block cannot schedule again.
    this.pollRecord = null;
  }

  dispose() {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
  }

  snapshot() {
    return {
      running: this.running,
      disposed: this.disposed,
      baseline: this.baseline,
      pollInFlight: this.pollRecord !== null,
      timerScheduled: this.timerRecord !== null,
    };
  }
}

module.exports = {
  DEFAULT_AUTO_CONNECT_DELAY_MS,
  DEFAULT_INITIAL_BASELINE_WAIT_MS,
  DEFAULT_NETWORK_POLL_MS,
  MAX_NETWORK_POLL_MS,
  MAX_INITIAL_BASELINE_WAIT_MS,
  MIN_NETWORK_POLL_MS,
  NetworkStartupCoordinator,
  NetworkStatusMonitor,
  SYNTHETIC_NETWORK_E2E_ENV,
  SYNTHETIC_NETWORK_STATE_FILE,
  createNetworkStartupSystem,
  createStartupAutoConnectEligibility,
};
