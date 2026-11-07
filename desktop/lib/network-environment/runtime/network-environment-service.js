'use strict';

const os = require('node:os');
const net = require('node:net');
const { createCommandRunner } = require('../platform/command-runner');
const { inventoryFromNode } = require('../platform/interface-inventory');
const { detectMacos } = require('../providers/macos-network-provider');
const { detectLinux } = require('../providers/linux-network-provider');
const { detectWindows } = require('../providers/windows-network-provider');
const {
  projectNetworkEnvironment,
  usableSourceAddress,
} = require('../schema/network-environment-schema');

const PROVIDERS = Object.freeze({ darwin: detectMacos, linux: detectLinux, win32: detectWindows });

class NetworkEnvironmentService {
  constructor({ platform = process.platform, networkInterfaces = os.networkInterfaces,
    run = createCommandRunner(), environment = process.env, now = Date.now, ttlMs = 10_000,
    publicEgressProbe = null, publicEgressSuccessTtlMs = 60_000,
    publicEgressFailureTtlMs = 10_000, maxPublicEgressSources = 16 } = {}) {
    if (publicEgressProbe !== null && typeof publicEgressProbe?.probe !== 'function') {
      throw new TypeError('public egress probe is invalid');
    }
    if (!Number.isFinite(publicEgressSuccessTtlMs) || publicEgressSuccessTtlMs < 10_000 ||
        !Number.isFinite(publicEgressFailureTtlMs) || publicEgressFailureTtlMs < 1_000 ||
        !Number.isInteger(maxPublicEgressSources) || maxPublicEgressSources < 1 ||
        maxPublicEgressSources > 32) {
      throw new TypeError('public egress cache bounds are invalid');
    }
    this.platform = platform; this.networkInterfaces = networkInterfaces; this.run = run;
    this.environment = environment; this.now = now; this.ttlMs = ttlMs;
    this.cachedAt = 0; this.cached = null; this.refreshInFlight = null;
    this.publicEgressProbe = publicEgressProbe;
    this.publicEgressSuccessTtlMs = publicEgressSuccessTtlMs;
    this.publicEgressFailureTtlMs = publicEgressFailureTtlMs;
    this.maxPublicEgressSources = maxPublicEgressSources;
    this.publicEgressSignature = '';
    this.publicEgressGeneration = 0;
    this.publicEgressRecords = new Map();
    this.publicEgressInFlight = new Map();
    this.publicEgressListener = null;
    this.publicEgressNotifyTimer = null;
    this.latestSelection = '';
  }

  fallbackSnapshot() {
    return { platform: this.platform, status: 'unknown',
      interfaces: inventoryFromNode(this.networkInterfaces(), this.platform),
      systemProxy: { state: 'unknown', type: 'unknown', endpoint: null, owner: {} } };
  }

  async rawSnapshot({ force = false } = {}) {
    const current = this.now();
    if (!force && this.cached && current - this.cachedAt < this.ttlMs) return this.cached;
    if (this.refreshInFlight) return this.refreshInFlight;
    const operation = (async () => {
      const fallback = this.fallbackSnapshot();
      const provider = PROVIDERS[this.platform];
      try {
        this.cached = provider
          ? await provider({ interfaces: fallback.interfaces, run: this.run, environment: this.environment })
          : fallback;
      } catch {
        this.cached = fallback;
      }
      this.cachedAt = this.now();
      return this.cached;
    })();
    this.refreshInFlight = operation;
    try { return await operation; }
    finally { if (this.refreshInFlight === operation) this.refreshInFlight = null; }
  }

  async snapshot(selection = '', options = {}) {
    const raw = await this.rawSnapshot(options);
    return this.#presentSnapshot(raw, selection, options.probePublicEgress === true);
  }
  // Accept the current selection without requesting public egress.
  presentSnapshot(selection = '') {
    const raw = this.cached || this.fallbackSnapshot();
    return this.#presentSnapshot(raw, selection, false);
  }
  #presentSnapshot(raw, selection, probePublicEgress) {
    this.latestSelection = selection;
    this.#reconcilePublicEgress(raw);
    if (probePublicEgress) this.#schedulePublicEgress(raw, selection);
    return projectNetworkEnvironment(raw, selection, this.#publicEgressSnapshot(raw));
  }
  cachedSnapshot(selection = '') {
    const raw = this.cached || this.fallbackSnapshot();
    return projectNetworkEnvironment(raw, selection, this.#publicEgressSnapshot(raw));
  }
  resolveSelection(selection = '') {
    const snapshot = this.cachedSnapshot(selection);
    if (!snapshot.selection.available || !snapshot.selection.interfaceId) return null;
    const sourceAddress = snapshot.selection.sourceAddress || snapshot.defaultRoute?.sourceAddress || '';
    if (!sourceAddress) return null;
    return Object.freeze({ interfaceId: snapshot.selection.interfaceId,
      sourceAddress });
  }
  engineArguments(selection = '') {
    const resolved = this.resolveSelection(selection);
    if (!resolved) return selection ? null : Object.freeze([]);
    return Object.freeze(['--source-interface', resolved.interfaceId,
      '--source-address', resolved.sourceAddress]);
  }
  refresh(selection = '', options = {}) {
    return this.snapshot(selection, { ...options, force: true });
  }

  dispose() {
    this.publicEgressGeneration += 1;
    this.publicEgressListener = null;
    this.publicEgressRecords.clear();
    this.publicEgressInFlight.clear();
    if (this.publicEgressNotifyTimer !== null) clearTimeout(this.publicEgressNotifyTimer);
    this.publicEgressNotifyTimer = null;
    this.publicEgressProbe?.dispose?.();
  }

  setPublicEgressListener(listener) {
    if (listener !== null && typeof listener !== 'function') {
      throw new TypeError('public egress listener is invalid');
    }
    this.publicEgressListener = listener;
  }

  #candidates(raw, selection) {
    const interfaces = Array.isArray(raw?.interfaces) ? raw.interfaces : [];
    const candidates = [];
    for (const item of interfaces) {
      if (!item?.active || item.kind === 'loopback') continue;
      for (const source of Array.isArray(item.addresses) ? item.addresses : []) {
        if (typeof source?.address !== 'string' || !usableSourceAddress(source.address)) continue;
        candidates.push({
          sourceAddress: source.address,
          family: net.isIP(source.address),
          interfaceId: item.id,
          score: source.address === selection ? 0
            : (item.default ? 10 : item.kind === 'physical' ? 20 : 30) +
              (net.isIP(source.address) === 4 ? 0 : 1),
        });
      }
    }
    return candidates.sort((left, right) => left.score - right.score ||
      left.interfaceId.localeCompare(right.interfaceId) ||
      left.sourceAddress.localeCompare(right.sourceAddress))
      .slice(0, this.maxPublicEgressSources);
  }

  #signature(raw) {
    const interfaces = (Array.isArray(raw?.interfaces) ? raw.interfaces : [])
      .filter((item) => item?.active === true)
      .map((item) => [
        item.id,
        item.kind,
        item.default === true ? 'default' : '',
        item.systemDefault === true ? 'system-default' : '',
        (Array.isArray(item.addresses) ? item.addresses : [])
          .map(({ address }) => address).filter(Boolean).sort().join(','),
      ].join('\u0000')).sort();
    const owner = raw?.systemProxy?.owner || {};
    return [...interfaces, [
      raw?.systemProxy?.state || '', raw?.systemProxy?.type || '',
      owner.provider || '', owner.mode || '', String(owner.tunEnabled),
    ].join('\u0000')].join('\u0001');
  }

  #reconcilePublicEgress(raw) {
    const signature = this.#signature(raw);
    if (signature !== this.publicEgressSignature) {
      this.publicEgressProbe?.cancel?.();
      if (this.publicEgressNotifyTimer !== null) clearTimeout(this.publicEgressNotifyTimer);
      this.publicEgressNotifyTimer = null;
      this.publicEgressSignature = signature;
      this.publicEgressGeneration += 1;
      this.publicEgressRecords.clear();
      this.publicEgressInFlight.clear();
    }
  }

  #schedulePublicEgress(raw, selection) {
    if (!this.publicEgressProbe) return;
    const generation = this.publicEgressGeneration;
    const current = this.now();
    for (const candidate of this.#candidates(raw, selection)) {
      const key = candidate.sourceAddress;
      const cached = this.publicEgressRecords.get(key);
      if (cached && cached.expiresAt > current) continue;
      if (this.publicEgressInFlight.has(key)) continue;
      this.publicEgressRecords.set(key, Object.freeze({
        status: 'probing', address: '', family: 0, binding: 'unknown',
        provider: 'ipify', observedAt: null, reason: '', expiresAt: current + 5_000,
      }));
      const operation = this.publicEgressProbe.probe(candidate).then((result) => {
        if (generation !== this.publicEgressGeneration) return;
        const observedAt = this.now();
        this.publicEgressRecords.set(key, Object.freeze({
          status: 'ready', address: result.address, family: result.family,
          binding: result.binding, provider: result.provider,
          observedAt, reason: '', expiresAt: observedAt + this.publicEgressSuccessTtlMs,
        }));
      }, (error) => {
        if (generation !== this.publicEgressGeneration) return;
        const observedAt = this.now();
        this.publicEgressRecords.set(key, Object.freeze({
          status: 'unavailable', address: '', family: 0, binding: 'unknown',
          provider: 'ipify', observedAt,
          reason: typeof error?.code === 'string' && /^PUBLIC_EGRESS_[A-Z_]+$/u.test(error.code)
            ? error.code : 'PUBLIC_EGRESS_UNAVAILABLE',
          expiresAt: observedAt + this.publicEgressFailureTtlMs,
        }));
      }).finally(() => {
        if (this.publicEgressInFlight.get(key) === operation) {
          this.publicEgressInFlight.delete(key);
        }
        if (generation === this.publicEgressGeneration) this.#queuePublicEgressNotification();
      });
      this.publicEgressInFlight.set(key, operation);
    }
  }

  #publicEgressSnapshot(raw) {
    const records = [];
    const current = this.now();
    const seen = new Set();
    for (const { sourceAddress } of this.#candidates(raw, this.latestSelection)) {
      if (seen.has(sourceAddress)) continue;
      seen.add(sourceAddress);
      const record = this.publicEgressRecords.get(sourceAddress);
      if (record?.expiresAt > current) records.push({ sourceAddress, ...record });
    }
    return records;
  }

  #notifyPublicEgress() {
    if (!this.publicEgressListener || !this.cached) return;
    try { this.publicEgressListener(this.cachedSnapshot(this.latestSelection)); } catch {}
  }

  #queuePublicEgressNotification() {
    if (this.publicEgressNotifyTimer !== null) return;
    this.publicEgressNotifyTimer = setTimeout(() => {
      this.publicEgressNotifyTimer = null;
      this.#notifyPublicEgress();
    }, 60);
    this.publicEgressNotifyTimer.unref?.();
  }
}

module.exports = { NetworkEnvironmentService };
