'use strict';

const path = require('node:path');
const { normalizeGatewayLeafSha256 } = require('../schema/school-profile-schema');

const DEFAULT_GATEWAY_PROBE_TIMEOUT_MS = 12_000;
const MAX_GATEWAY_PROBE_OUTPUT_BYTES = 64 * 1024;

// Input shape only; native public-address and TLS policy remains authoritative.
function normalizeGatewayEntry(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048 ||
      /[\u0000-\u001f\u007f\\]/u.test(value)) throw new TypeError('Gateway entry is invalid');
  const entry = value.trim();
  let url;
  try { url = new URL(entry.includes('://') ? entry : `https://${entry}`); }
  catch { throw new TypeError('Gateway entry is invalid'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username ||
      url.password || url.search || url.hash || url.port === '0') {
    throw new TypeError('Gateway entry is unsafe');
  }
  return url.pathname === '/' ? url.origin : url.href;
}

class GatewayProbeError extends Error {
  constructor(code, cause = null) {
    super(code, cause ? { cause } : undefined);
    this.name = 'GatewayProbeError';
    this.code = code;
  }
}

function privateProbeEnvironment(environment = process.env, platform = process.platform) {
  if (!environment || typeof environment !== 'object') {
    throw new TypeError('Gateway probe environment is invalid');
  }
  const result = {};
  if (platform === 'win32') {
    for (const key of ['SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']) {
      if (typeof environment[key] === 'string' && environment[key]) result[key] = environment[key];
    }
  } else if (typeof environment.TMPDIR === 'string' && environment.TMPDIR) {
    result.TMPDIR = environment.TMPDIR;
  }
  return Object.freeze(result);
}

class GatewayProbeRunner {
  #active = null;

  constructor({
    executablePath,
    argsPrefix = [],
    electronRunAsNode = false,
    spawnProcess,
    environment = process.env,
    platform = process.platform,
    timeoutMs = DEFAULT_GATEWAY_PROBE_TIMEOUT_MS,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = {}) {
    if (typeof executablePath !== 'string' || !path.isAbsolute(executablePath) ||
        !Array.isArray(argsPrefix) || argsPrefix.length > 2 ||
        !argsPrefix.every((value) => typeof value === 'string' && path.isAbsolute(value)) ||
        typeof electronRunAsNode !== 'boolean' ||
        typeof spawnProcess !== 'function' || !['darwin', 'linux', 'win32'].includes(platform) ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000 ||
        typeof setTimeoutFn !== 'function' || typeof clearTimeoutFn !== 'function') {
      throw new TypeError('Gateway probe runner dependencies are invalid');
    }
    this.executablePath = executablePath;
    this.argsPrefix = Object.freeze([...argsPrefix]);
    this.spawnProcess = spawnProcess;
    this.environment = Object.freeze({
      ...privateProbeEnvironment(environment, platform),
      ...(electronRunAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    });
    this.platform = platform;
    this.timeoutMs = timeoutMs;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
  }

  probe(rawOrigin, { leafSha256 = null } = {}) {
    if (this.#active) {
      return Promise.reject(new GatewayProbeError('GATEWAY_PROBE_ALREADY_RUNNING'));
    }
    const origin = normalizeGatewayEntry(rawOrigin);
    const pin = normalizeGatewayLeafSha256(leafSha256);
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawnProcess(this.executablePath, [
          ...this.argsPrefix, '--origin', origin,
          ...(pin == null ? [] : ['--leaf-sha256', pin]),
        ], {
          cwd: path.dirname(this.executablePath),
          env: this.environment,
          shell: false,
          detached: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (cause) {
        reject(new GatewayProbeError('GATEWAY_PROBE_START_FAILED', cause));
        return;
      }
      if (!child || typeof child.once !== 'function' ||
          typeof child.kill !== 'function' || !child.stdout || !child.stderr) {
        try { child?.kill?.(); } catch {}
        reject(new GatewayProbeError('GATEWAY_PROBE_START_FAILED'));
        return;
      }

      let stdout = Buffer.alloc(0);
      let diagnosticBytes = 0;
      let outputTooLarge = false;
      let settled = false;
      let timer = null;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        this.clearTimeoutFn(timer);
        if (this.#active?.child === child) this.#active = null;
        stdout.fill(0);
        stdout = Buffer.alloc(0);
        if (error) reject(error); else resolve(value);
      };
      const append = (chunk) => {
        if (settled || outputTooLarge) return;
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        if (stdout.length + value.length > MAX_GATEWAY_PROBE_OUTPUT_BYTES) {
          outputTooLarge = true;
          try { child.kill(); } catch {}
          finish(new GatewayProbeError('GATEWAY_PROBE_OUTPUT_INVALID'));
          return;
        }
        stdout = Buffer.concat([stdout, value]);
      };
      child.stdout.on('data', append);
      // Drain but never retain human diagnostics: paths and platform details
      // are not part of the Renderer contract. Bound the stream even though
      // it is discarded so a faulty native child cannot write indefinitely.
      child.stderr.on('data', (chunk) => {
        diagnosticBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
        if (!settled && diagnosticBytes > MAX_GATEWAY_PROBE_OUTPUT_BYTES) {
          outputTooLarge = true;
          try { child.kill(); } catch {}
          finish(new GatewayProbeError('GATEWAY_PROBE_OUTPUT_INVALID'));
        }
      });
      child.once('error', (cause) => finish(
        new GatewayProbeError('GATEWAY_PROBE_START_FAILED', cause),
      ));
      child.once('close', (code, signal) => {
        if (outputTooLarge) {
          finish(new GatewayProbeError('GATEWAY_PROBE_OUTPUT_INVALID'));
          return;
        }
        if (code !== 0 || signal) {
          finish(new GatewayProbeError('GATEWAY_PROBE_FAILED'));
          return;
        }
        try {
          const text = stdout.toString('utf8').trim();
          if (!text || text.includes('\n')) throw new Error('probe output is not one JSON line');
          const result = JSON.parse(text);
          finish(null, result);
        } catch (cause) {
          finish(new GatewayProbeError('GATEWAY_PROBE_OUTPUT_INVALID', cause));
        }
      });
      timer = this.setTimeoutFn(() => {
        try { child.kill(); } catch {}
        finish(new GatewayProbeError('GATEWAY_PROBE_TIMEOUT'));
      }, this.timeoutMs);
      timer?.unref?.();
      this.#active = { child, finish };
    });
  }

  cancel() {
    const active = this.#active;
    if (!active) return false;
    try { active.child.kill(); } catch {}
    active.finish(new GatewayProbeError('GATEWAY_PROBE_CANCELLED'));
    return true;
  }
}

module.exports = {
  DEFAULT_GATEWAY_PROBE_TIMEOUT_MS,
  GatewayProbeError,
  GatewayProbeRunner,
  MAX_GATEWAY_PROBE_OUTPUT_BYTES,
  privateProbeEnvironment,
};
