'use strict';

const fs = require('node:fs');
const {
  copyTail,
  ensurePrivateDirectory,
  openVerifiedRegular,
  recheckOpenPath,
  replaceWithPrivateFile,
  unsafeLogPath,
  writeAll,
} = require('./private-log-file');

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TAIL_BYTES = 256 * 1024;
const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;
const DEFAULT_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_RETENTION_MARKER_BYTES = 64;
const MAX_TAIL_LINES = 10_000;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(parsed)));
}

function redactDiagnosticText(value) {
  let text = String(value ?? '');
  text = text.replace(
    /\b(authorization|proxy-authorization|cookie|set-cookie)\s*:\s*[^\r\n]*/giu,
    '$1: [REDACTED]',
  );
  text = text.replace(
    /([?&](?:token|access_token|refresh_token|code|ticket|samlrequest|samlresponse|relaystate|session|sid|otp|totp|one[-_]?time[-_]?code|verification[-_]?code|passcode|twfid|csrf(?:[-_]?rand[-_]?code|[-_]?token)?)=)[^&#\s]*/giu,
    '$1[REDACTED]',
  );
  text = text.replace(
    /\b(password|passwd|pwd|token|access_token|refresh_token|cookie|otp|totp|one[-_ ]?time[-_ ]?code|verification[-_ ]?code|passcode|twfid|csrf(?:[-_ ]?rand[-_ ]?code|[-_ ]?token)?)\b(['"]?\s*[=:]\s*)('[^']*'|"[^"]*"|[^\s,;&}]+)/giu,
    '$1$2[REDACTED]',
  );
  return text;
}

class BufferedLogWriter {
  constructor(file, {
    maxBytes = DEFAULT_MAX_BYTES,
    maxBufferBytes = DEFAULT_MAX_BUFFER_BYTES,
    flushIntervalMs = 200,
    retentionMs = DEFAULT_RETENTION_MS,
    now = Date.now,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    redact = redactDiagnosticText,
    onError = null,
    onRecovered = null,
  } = {}) {
    this.file = file;
    this.rotatedFile = `${file}.1`;
    this.retentionFile = `${file}.retention`;
    this.maxBytes = boundedInteger(maxBytes, DEFAULT_MAX_BYTES, 1024, DEFAULT_MAX_BYTES);
    this.maxBufferBytes = boundedInteger(
      maxBufferBytes,
      DEFAULT_MAX_BUFFER_BYTES,
      1024,
      DEFAULT_MAX_BUFFER_BYTES,
    );
    this.flushIntervalMs = boundedInteger(flushIntervalMs, 200, 10, 60_000);
    this.retentionMs = boundedInteger(
      retentionMs,
      DEFAULT_RETENTION_MS,
      1000,
      30 * 24 * 60 * 60 * 1000,
    );
    this.now = typeof now === 'function' ? now : Date.now;
    this.setTimeoutFn = typeof setTimeoutFn === 'function' ? setTimeoutFn : setTimeout;
    this.clearTimeoutFn = typeof clearTimeoutFn === 'function' ? clearTimeoutFn : clearTimeout;
    this.redact = typeof redact === 'function' ? redact : redactDiagnosticText;
    this.onError = typeof onError === 'function' ? onError : null;
    this.onRecovered = typeof onRecovered === 'function' ? onRecovered : null;
    this.buffer = '';
    this.timer = null;
    this.operation = Promise.resolve();
    this.closed = false;
    this.droppedBytes = 0;
    this.lastError = null;
    this.errorEpisode = false;
    this.retentionStartedAt = null;
    this.retentionTimer = null;

    // Enforce retention even when the engine remains quiet for the entire app
    // session. All later log operations are serialized behind this check.
    this.observeBackground(this.enqueue(() => this.enforceRetention()));
  }

  observeBackground(operation) {
    operation.catch((error) => {
      this.reportError(error);
    });
  }

  reportError(error) {
    this.lastError = error;
    if (this.errorEpisode) return;
    this.errorEpisode = true;
    try { this.onError?.(error); } catch {
      // Diagnostics must never turn an expected log I/O failure into another
      // uncaught exception. The original error remains in lastError.
    }
  }

  reportRecovery() {
    if (!this.errorEpisode) return;
    this.errorEpisode = false;
    this.lastError = null;
    try { this.onRecovered?.(); } catch {
      // Recovery notification is advisory and must not fail a durable write.
    }
  }

  flushInBackground() {
    // Disk-full, permission, and unsafe-path failures are recoverable for the
    // application. Keep them observable without allowing a timer-triggered
    // Promise rejection to terminate Electron under strict rejection policy.
    this.observeBackground(this.flush());
  }

  currentTime() {
    const value = Number(this.now());
    return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : Date.now();
  }

  async readRetentionStart() {
    let opened;
    try {
      opened = await openVerifiedRegular(this.retentionFile, fs.constants.O_RDONLY);
      if (opened.stat.size < 1 || opened.stat.size > MAX_RETENTION_MARKER_BYTES) {
        throw unsafeLogPath(this.retentionFile, 'invalid retention marker size');
      }
      const buffer = Buffer.alloc(opened.stat.size);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await opened.handle.read(
          buffer,
          total,
          buffer.length - total,
          total,
        );
        if (bytesRead <= 0) break;
        total += bytesRead;
      }
      await recheckOpenPath(this.retentionFile, opened.handle, opened.stat);
      const value = buffer.subarray(0, total).toString('ascii').trim();
      if (!/^\d{1,16}$/.test(value)) {
        throw unsafeLogPath(this.retentionFile, 'invalid retention marker');
      }
      const startedAt = Number(value);
      if (!Number.isSafeInteger(startedAt) || startedAt < 0) {
        throw unsafeLogPath(this.retentionFile, 'invalid retention timestamp');
      }
      return startedAt;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    } finally {
      await opened?.handle.close().catch(() => {});
    }
  }

  async writeRetentionStart(startedAt) {
    const marker = Buffer.from(`${startedAt}\n`, 'ascii');
    await replaceWithPrivateFile(this.retentionFile, async (destination) => {
      await writeAll(destination, marker);
    });
  }

  async clearRetainedLogs() {
    // Atomic replacement removes a hostile symbolic-link entry without ever
    // following it to the unrelated target.
    await replaceWithPrivateFile(this.file, async () => {});
    await replaceWithPrivateFile(this.rotatedFile, async () => {});
  }

  scheduleRetention() {
    if (this.retentionTimer) this.clearTimeoutFn(this.retentionTimer);
    this.retentionTimer = null;
    if (this.closed || this.retentionStartedAt === null) return;
    const remaining = Math.min(
      this.retentionMs,
      Math.max(1, this.retentionStartedAt + this.retentionMs - this.currentTime()),
    );
    this.retentionTimer = this.setTimeoutFn(() => {
      this.retentionTimer = null;
      this.observeBackground(this.enqueue(() => this.enforceRetention()));
    }, remaining);
    this.retentionTimer?.unref?.();
  }

  async enforceRetention() {
    const now = this.currentTime();
    let startedAt = this.retentionStartedAt;
    if (startedAt === null) {
      startedAt = await this.readRetentionStart();
    }

    if (startedAt === null) {
      // Existing installations have no marker. Start retention now without
      // touching the current log: the existing no-follow append/rotation path
      // must still reject a hostile log symlink instead of silently replacing
      // it during construction.
      await this.writeRetentionStart(now);
      startedAt = now;
    } else if (startedAt > now || now - startedAt >= this.retentionMs) {
      await this.clearRetainedLogs();
      await this.writeRetentionStart(now);
      startedAt = now;
    }
    this.retentionStartedAt = startedAt;
    this.scheduleRetention();
  }

  append(value) {
    if (this.closed) return false;
    const chunk = this.redact(value);
    if (!chunk) return true;
    this.buffer += chunk;
    const size = Buffer.byteLength(this.buffer);
    if (size > this.maxBufferBytes) {
      const retained = Buffer.from(this.buffer).subarray(size - this.maxBufferBytes).toString('utf8');
      this.droppedBytes += size - Buffer.byteLength(retained);
      this.buffer = retained;
    }
    if (Buffer.byteLength(this.buffer) >= Math.min(64 * 1024, this.maxBufferBytes)) {
      this.flushInBackground();
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flushInBackground();
      }, this.flushIntervalMs);
      this.timer.unref?.();
    }
    return true;
  }

  takeBuffer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    let chunk = this.buffer;
    this.buffer = '';
    if (this.droppedBytes) {
      chunk = `[log writer dropped ${this.droppedBytes} buffered bytes]\n${chunk}`;
      this.droppedBytes = 0;
    }
    return chunk;
  }

  enqueue(operation, { reportIo = false } = {}) {
    const queued = this.operation.then(operation, operation);
    const next = reportIo ? queued.then(
      (value) => { this.reportRecovery(); return value; },
      (error) => { this.reportError(error); throw error; },
    ) : queued;
    this.operation = next.catch(() => {});
    return next;
  }

  async rotateFor(incomingBytes) {
    let opened;
    try {
      opened = await openVerifiedRegular(this.file, fs.constants.O_RDONLY);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }

    try {
      if (opened.stat.size + incomingBytes <= this.maxBytes) return;
      await replaceWithPrivateFile(this.rotatedFile, async (destination) => {
        await copyTail(opened.handle, opened.stat.size, destination, this.maxBytes);
      });
      await recheckOpenPath(this.file, opened.handle, opened.stat);
    } finally {
      await opened.handle.close().catch(() => {});
    }

    await replaceWithPrivateFile(this.file, async () => {});
  }

  async appendChunk(chunk) {
    await this.enforceRetention();
    await ensurePrivateDirectory(this.file);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.rotateFor(chunk.length);
      const opened = await openVerifiedRegular(
        this.file,
        fs.constants.O_WRONLY | fs.constants.O_APPEND,
        { create: true },
      );
      try {
        if (opened.stat.size + chunk.length > this.maxBytes) continue;
        await writeAll(opened.handle, chunk);
        const written = await opened.handle.stat();
        if (written.size > this.maxBytes) {
          throw unsafeLogPath(this.file, 'grew beyond the fixed size limit during append');
        }
        await recheckOpenPath(this.file, opened.handle, opened.stat);
        return;
      } finally {
        await opened.handle.close().catch(() => {});
      }
    }
    throw unsafeLogPath(this.file, 'changed repeatedly while enforcing the size limit');
  }

  flush() {
    const buffered = this.takeBuffer();
    if (!buffered) return this.operation;
    return this.enqueue(async () => {
      let chunk = Buffer.from(buffered);
      if (chunk.length > this.maxBytes) chunk = chunk.subarray(chunk.length - this.maxBytes);
      await this.appendChunk(chunk);
    }, { reportIo: true });
  }

  reset() {
    this.takeBuffer();
    this.droppedBytes = 0;
    return this.enqueue(async () => {
      const now = this.currentTime();
      await this.clearRetainedLogs();
      await this.writeRetentionStart(now);
      this.retentionStartedAt = now;
      this.scheduleRetention();
    }, { reportIo: true });
  }

  async close() {
    if (this.closed) return this.operation;
    this.closed = true;
    if (this.retentionTimer) this.clearTimeoutFn(this.retentionTimer);
    this.retentionTimer = null;
    await this.flush();
    await this.operation;
  }
}

async function readLogTail(file, { maxBytes = DEFAULT_TAIL_BYTES, maxLines = 300, contextCurrent = () => true } = {}) {
  let opened;
  try {
    if (typeof contextCurrent !== 'function' || contextCurrent() !== true) return '';
    opened = await openVerifiedRegular(file, fs.constants.O_RDONLY);
    if (contextCurrent() !== true) return '';
    const boundedBytes = boundedInteger(maxBytes, DEFAULT_TAIL_BYTES, 1024, DEFAULT_MAX_BYTES);
    const boundedLines = boundedInteger(maxLines, 300, 1, MAX_TAIL_LINES);
    const length = Math.min(opened.stat.size, boundedBytes);
    const buffer = Buffer.alloc(length);
    let total = 0;
    while (total < length) {
      if (contextCurrent() !== true) return '';
      const { bytesRead } = await opened.handle.read(
        buffer,
        total,
        length - total,
        opened.stat.size - length + total,
      );
      if (contextCurrent() !== true) return '';
      if (bytesRead <= 0) break;
      total += bytesRead;
    }
    await recheckOpenPath(file, opened.handle, opened.stat);
    if (contextCurrent() !== true) return '';

    let text = buffer.subarray(0, total).toString('utf8');
    if (opened.stat.size > total) {
      const firstNewline = text.indexOf('\n');
      if (firstNewline !== -1) text = text.slice(firstNewline + 1);
    }
    const lines = text.split('\n');
    return lines.slice(-boundedLines).join('\n');
  } catch {
    return '';
  } finally {
    await opened?.handle.close().catch(() => {});
  }
}

class DiagnosticLogAccessRuntime {
  #effects;

  constructor({ file, getWriter, captureContext, isContextCurrent, isQuitting,
    onFlushFailure, openPath, readTail = readLogTail } = {}) {
    if (typeof file !== 'string' || !file ||
        [getWriter, captureContext, isContextCurrent, isQuitting, onFlushFailure, openPath, readTail]
          .some(effect => typeof effect !== 'function')) {
      throw new TypeError('diagnostic access dependencies are invalid');
    }
    this.#effects = Object.freeze({ file, getWriter, captureContext, isContextCurrent,
      isQuitting, onFlushFailure, openPath, readTail });
  }

  #current(snapshot) {
    try {
      return !this.#effects.isQuitting() && this.#effects.getWriter() === snapshot.writer &&
        snapshot.writer?.closed !== true && this.#effects.isContextCurrent(snapshot.context) === true;
    } catch { return false; }
  }

  async #flushed() {
    let snapshot;
    try {
      if (this.#effects.isQuitting()) return null;
      snapshot = { writer: this.#effects.getWriter(), context: this.#effects.captureContext() };
      if (!snapshot.writer || typeof snapshot.writer.flush !== 'function' || !this.#current(snapshot)) return null;
    } catch { return null; }
    await snapshot.writer.flush().catch(error => {
      if (this.#current(snapshot)) this.#effects.onFlushFailure(error);
    });
    return this.#current(snapshot) ? snapshot : null;
  }

  async read() {
    const snapshot = await this.#flushed();
    if (!snapshot || !this.#current(snapshot)) return '';
    try {
      const result = await this.#effects.readTail(this.#effects.file, {
        contextCurrent: () => this.#current(snapshot),
      });
      return this.#current(snapshot) ? result : '';
    } catch (error) {
      if (!this.#current(snapshot)) return '';
      throw error;
    }
  }

  async open() {
    const snapshot = await this.#flushed();
    if (snapshot && this.#current(snapshot)) await this.#effects.openPath(this.#effects.file).catch(() => {});
  }
}

module.exports = {
  DiagnosticLogAccessRuntime,
  BufferedLogWriter,
  DEFAULT_MAX_BYTES,
  DEFAULT_RETENTION_MS,
  DEFAULT_TAIL_BYTES,
  readLogTail,
  redactDiagnosticText,
};
