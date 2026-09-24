'use strict';

const ENGINE_CONTROL_API_VERSION = 2;
const MAX_CONTROL_FRAME_BYTES = 2 * 1024;
const MAX_CONTROL_BUFFER_BYTES = 4 * 1024;
const DEFAULT_CONTROL_REQUEST_TIMEOUT_MS = 2_000;

const CAPABILITY_TOKEN = /^[a-z][a-z0-9_.-]{0,95}$/u;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const PROFILE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const CAPABILITY_STATES = new Set(['supported', 'unsupported', 'unavailable']);

function validRequestId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function normalizeCapabilityLayer(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) return null;
  const entries = Object.entries(value);
  if (!entries.length || entries.length > 64 || entries.some(([capability, state]) => (
    !CAPABILITY_TOKEN.test(capability) || !CAPABILITY_STATES.has(state)
  ))) return null;
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

function normalizeControlResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.apiVersion !== ENGINE_CONTROL_API_VERSION || !validRequestId(value.requestId)) {
    return null;
  }
  if (value.type === 'control_hello') {
    if (!Array.isArray(value.capabilities) || value.capabilities.length > 32 ||
        value.capabilities.some((entry) => (
          typeof entry !== 'string' || !CAPABILITY_TOKEN.test(entry)
        ))) return null;
    return {
      type: 'control_hello',
      apiVersion: ENGINE_CONTROL_API_VERSION,
      requestId: value.requestId,
      capabilities: [...new Set(value.capabilities)],
    };
  }
  if (value.type === 'control_result') {
    if (value.status !== 'accepted' && value.status !== 'cancelled') return null;
    return {
      type: 'control_result',
      apiVersion: ENGINE_CONTROL_API_VERSION,
      requestId: value.requestId,
      status: value.status,
    };
  }
  if (value.type === 'provider_capabilities') {
    const keys = Object.keys(value).sort();
    if (JSON.stringify(keys) !== JSON.stringify([
      'apiVersion', 'compiled', 'engineGeneration', 'profileId', 'profileRevision',
      'provider', 'requestId', 'type',
    ])) return null;
    if (typeof value.profileId !== 'string' || !PROFILE_ID.test(value.profileId) ||
        !Number.isSafeInteger(value.profileRevision) || value.profileRevision <= 0 ||
        !Number.isSafeInteger(value.engineGeneration) || value.engineGeneration <= 0) return null;
    const compiled = normalizeCapabilityLayer(value.compiled);
    const provider = normalizeCapabilityLayer(value.provider);
    if (!compiled || !provider ||
        JSON.stringify(Object.keys(compiled)) !== JSON.stringify(Object.keys(provider))) return null;
    return {
      type: 'provider_capabilities',
      apiVersion: ENGINE_CONTROL_API_VERSION,
      requestId: value.requestId,
      profileId: value.profileId,
      profileRevision: value.profileRevision,
      engineGeneration: value.engineGeneration,
      compiled,
      provider,
    };
  }
  if (value.type === 'control_error') {
    const error = value.error;
    if (!error || typeof error !== 'object' || Array.isArray(error) ||
        typeof error.code !== 'string' || !ERROR_CODE.test(error.code)) return null;
    const normalized = { code: error.code };
    if (typeof error.capability === 'string' && CAPABILITY_TOKEN.test(error.capability)) {
      normalized.capability = error.capability;
    }
    if (Array.isArray(error.supportedVersions) &&
        error.supportedVersions.length <= 4 &&
        error.supportedVersions.every((version) => Number.isInteger(version) && version > 0)) {
      normalized.supportedVersions = [...error.supportedVersions];
    }
    return {
      type: 'control_error',
      apiVersion: ENGINE_CONTROL_API_VERSION,
      requestId: value.requestId,
      error: normalized,
    };
  }
  return null;
}

class EngineControlResponseParser {
  constructor({
    maxFrameBytes = MAX_CONTROL_FRAME_BYTES,
    maxBufferBytes = MAX_CONTROL_BUFFER_BYTES,
  } = {}) {
    this.maxFrameBytes = maxFrameBytes;
    this.maxBufferBytes = maxBufferBytes;
    this.buffer = Buffer.alloc(0);
    this.discardUntilNewline = false;
  }

  feed(value) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ''));
    if (!chunk.length) return [];
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > this.maxBufferBytes && !this.buffer.includes(0x0a)) {
      this.buffer = Buffer.alloc(0);
      this.discardUntilNewline = true;
      return [];
    }
    const responses = [];
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline === -1) break;
      const rawLine = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (this.discardUntilNewline) {
        this.discardUntilNewline = false;
        continue;
      }
      if (!rawLine.length || rawLine.length + 1 > this.maxFrameBytes) continue;
      try {
        const response = normalizeControlResponse(JSON.parse(rawLine.toString('utf8')));
        if (response) responses.push(response);
      } catch {}
    }
    if (this.buffer.length > this.maxBufferBytes) {
      this.buffer = Buffer.alloc(0);
      this.discardUntilNewline = true;
    }
    return responses;
  }
}

class EngineControlClient {
  constructor({
    writable,
    requestTimeoutMs = DEFAULT_CONTROL_REQUEST_TIMEOUT_MS,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = {}) {
    if (!writable || typeof writable.write !== 'function') {
      throw new TypeError('a writable engine control stream is required');
    }
    this.writable = writable;
    this.requestTimeoutMs = requestTimeoutMs;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.parser = new EngineControlResponseParser();
    this.nextRequestId = 1;
    this.pending = new Map();
    this.negotiated = false;
    this.helloResponse = null;
    this.handshakePromise = null;
    this.closed = false;
  }

  handshake() {
    if (this.negotiated) return Promise.resolve(this.helloResponse);
    if (this.handshakePromise) return this.handshakePromise;
    this.handshakePromise = this.#request('control_hello', (requestId) => ({
      type: 'hello',
      requestId,
      versions: [ENGINE_CONTROL_API_VERSION],
    })).then((response) => {
      if (response.type !== 'control_hello') {
        throw new Error('engine control handshake was rejected');
      }
      this.negotiated = true;
      this.helloResponse = response;
      return response;
    });
    return this.handshakePromise;
  }

  shutdown() {
    if (!this.negotiated) return Promise.reject(new Error('engine control handshake is incomplete'));
    return this.#request('control_result', (requestId) => ({
      type: 'request',
      apiVersion: ENGINE_CONTROL_API_VERSION,
      requestId,
      command: { name: 'shutdown' },
    }), true).then((response) => {
      if (response.type !== 'control_result' || response.status !== 'accepted') {
        throw new Error('engine control shutdown was rejected');
      }
      return response;
    });
  }

  providerCapabilities() {
    if (!this.negotiated) {
      return Promise.reject(new Error('engine control handshake is incomplete'));
    }
    return this.#request('provider_capabilities', (requestId) => ({
      type: 'request',
      apiVersion: ENGINE_CONTROL_API_VERSION,
      requestId,
      command: { name: 'provider_capabilities' },
    }));
  }

  feed(value, { shutdownOnly = false } = {}) {
    if (this.closed) return;
    for (const response of this.parser.feed(value)) {
      const pending = this.pending.get(response.requestId);
      if (!pending || (shutdownOnly && pending.shutdown !== true)) continue;
      this.pending.delete(response.requestId);
      this.clearTimeoutFn(pending.timer);
      if (response.type === 'control_error') {
        const error = new Error(`engine control request failed: ${response.error.code}`);
        error.code = response.error.code;
        pending.reject(error);
      } else if (pending.kind === response.type) {
        pending.resolve(response);
      } else {
        pending.reject(new Error('engine control response type mismatch'));
      }
    }
  }

  close(error = new Error('engine control stream closed')) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      this.clearTimeoutFn(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  #request(kind, buildFrame, shutdown = false) {
    if (this.closed) return Promise.reject(new Error('engine control stream is closed'));
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    if (!validRequestId(requestId)) {
      this.close(new Error('engine control request identifiers are exhausted'));
      return Promise.reject(new Error('engine control request identifiers are exhausted'));
    }
    let encoded;
    try {
      encoded = Buffer.from(`${JSON.stringify(buildFrame(requestId))}\n`, 'utf8');
      if (encoded.length > MAX_CONTROL_FRAME_BYTES) throw new Error('engine control frame is oversized');
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const timer = this.setTimeoutFn(() => {
        this.pending.delete(requestId);
        reject(new Error('engine control request timed out'));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(requestId, { kind, shutdown, resolve, reject, timer });
      try {
        this.writable.write(encoded, (error) => {
          if (!error) return;
          const pending = this.pending.get(requestId);
          if (!pending) return;
          this.pending.delete(requestId);
          this.clearTimeoutFn(pending.timer);
          pending.reject(new Error('cannot write engine control request'));
        });
      } catch {
        const pending = this.pending.get(requestId);
        if (pending) {
          this.pending.delete(requestId);
          this.clearTimeoutFn(pending.timer);
          pending.reject(new Error('cannot write engine control request'));
        }
      }
    });
  }
}

module.exports = {
  DEFAULT_CONTROL_REQUEST_TIMEOUT_MS,
  ENGINE_CONTROL_API_VERSION,
  EngineControlClient,
  EngineControlResponseParser,
  MAX_CONTROL_BUFFER_BYTES,
  MAX_CONTROL_FRAME_BYTES,
  normalizeControlResponse,
};
