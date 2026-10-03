'use strict';

const path = require('node:path');
const {
  validateActiveContextSwitchJournal,
} = require('./active-context-switch-journal');

const MAX_ACTIVE_CONTEXT_SWITCH_BYTES = 256 * 1024;
let temporarySequence = 0;

function normalizedPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new TypeError('active context switch journal path must be absolute');
  }
  const normalized = path.resolve(value);
  const root = path.parse(normalized).root;
  if (normalized !== value || normalized === root || path.dirname(normalized) === root) {
    throw new TypeError('active context switch journal path must be absolute and normalized');
  }
  return normalized;
}

function fsyncDirectory(directory, fileSystem, platform) {
  let descriptor = null;
  try {
    descriptor = fileSystem.openSync(directory, 'r');
    fileSystem.fsyncSync?.(descriptor);
    return true;
  } catch {
    return platform === 'win32';
  } finally {
    if (descriptor !== null) {
      try { fileSystem.closeSync(descriptor); } catch {}
    }
  }
}

function serialized(document) {
  const normalized = validateActiveContextSwitchJournal(document);
  const data = Buffer.from(JSON.stringify(normalized), 'utf8');
  if (data.length < 2 || data.length > MAX_ACTIVE_CONTEXT_SWITCH_BYTES) {
    data.fill(0);
    throw new TypeError('active context switch journal exceeds its storage bound');
  }
  return { normalized, data };
}

function immutableBinding(value) {
  return JSON.stringify({
    schemaVersion: value.schemaVersion,
    type: value.type,
    switchId: value.switchId,
    kind: value.kind,
    from: value.from,
    to: value.to,
    nextActiveContextEpoch: value.nextActiveContextEpoch,
    engineGeneration: value.engineGeneration,
    activation: value.activation,
    createdAt: value.createdAt,
  });
}

function exactDocument(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

class ActiveContextSwitchJournalStore {
  constructor({
    filePath,
    profileStorageEffects,
    fileSystem: fileSystemOverride,
    platform: platformOverride,
    windowsAcl: windowsAclOverride,
  } = {}) {
    if (typeof profileStorageEffects?.assertCompatible !== 'function') {
      throw new TypeError('active context switch storage effects are required');
    }
    profileStorageEffects.assertCompatible({
      fileSystem: fileSystemOverride,
      platform: platformOverride,
      windowsAcl: windowsAclOverride,
    });
    const fileSystem = profileStorageEffects?.fileSystem;
    const platform = profileStorageEffects?.platform;
    const windowsAcl = profileStorageEffects?.windowsAcl;
    if (!fileSystem || typeof fileSystem.openSync !== 'function' ||
        !profileStorageEffects ||
        typeof profileStorageEffects.readPrivateFileBounded !== 'function' ||
        !['darwin', 'linux', 'win32'].includes(platform) ||
        (platform === 'win32' &&
          (typeof windowsAcl?.protect !== 'function' || typeof windowsAcl?.verify !== 'function'))) {
      throw new TypeError('active context switch store dependencies are invalid');
    }
    this.filePath = normalizedPath(filePath);
    this.profileStorageEffects = profileStorageEffects;
    this.fileSystem = fileSystem;
    this.platform = platform;
    this.windowsAcl = windowsAcl;
  }

  read() {
    try {
      this.fileSystem.lstatSync(this.filePath);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    if (this.platform === 'win32' && !this.windowsAcl.verify(this.filePath)) {
      throw new Error('active context switch journal ACL is invalid');
    }
    let data;
    try {
      ({ data } = this.profileStorageEffects.readPrivateFileBounded(this.filePath, {
        maxBytes: MAX_ACTIVE_CONTEXT_SWITCH_BYTES,
        minBytes: 2,
      }));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error('active context switch journal disappeared after observation', {
          cause: error,
        });
      }
      throw error;
    }
    try {
      return validateActiveContextSwitchJournal(JSON.parse(data.toString('utf8')));
    } catch (error) {
      throw new Error('active context switch journal is invalid', { cause: error });
    } finally {
      data.fill(0);
    }
  }

  prepare(document) {
    const { normalized, data } = serialized(document);
    if (normalized.state !== 'prepared') {
      data.fill(0);
      throw new TypeError('active context switch journal must be prepared before storage');
    }
    const directory = path.dirname(this.filePath);
    let descriptor = null;
    let created = false;
    try {
      this.fileSystem.mkdirSync(directory, { recursive: true, mode: 0o700 });
      descriptor = this.fileSystem.openSync(this.filePath, 'wx', 0o600);
      created = true;
      this.fileSystem.writeFileSync(descriptor, data);
      this.fileSystem.fsyncSync?.(descriptor);
      this.fileSystem.closeSync(descriptor);
      descriptor = null;
      if (this.platform === 'win32' &&
          (!this.windowsAcl.protect(this.filePath) || !this.windowsAcl.verify(this.filePath))) {
        throw new Error('active context switch journal Windows ACL is invalid');
      }
      return {
        prepared: true,
        durabilityUnconfirmed: !fsyncDirectory(directory, this.fileSystem, this.platform),
      };
    } catch (error) {
      if (descriptor !== null) {
        try { this.fileSystem.closeSync(descriptor); } catch {}
      }
      if (created) {
        try { this.fileSystem.unlinkSync(this.filePath); } catch {}
        fsyncDirectory(directory, this.fileSystem, this.platform);
      }
      if (error?.code === 'EEXIST') {
        throw new Error('active context switch journal already exists');
      }
      throw new Error('active context switch journal prepare failed', { cause: error });
    } finally {
      data.fill(0);
    }
  }

  markReady(document) {
    return this.#transition(document, 'prepared', 'ready');
  }

  commit(document) {
    return this.#transition(document, 'ready', 'committed');
  }

  clearCommitted() {
    const current = this.read();
    if (current === null) return false;
    if (current.state !== 'committed') {
      throw new Error('uncommitted active context switch journal cannot be cleared');
    }
    const directory = path.dirname(this.filePath);
    try {
      this.fileSystem.unlinkSync(this.filePath);
    } catch (error) {
      throw new Error('active context switch journal clear failed', { cause: error });
    }
    if (!fsyncDirectory(directory, this.fileSystem, this.platform)) {
      throw new Error('active context switch journal clear was not durable');
    }
    return true;
  }

  #transition(document, expectedState, targetState) {
    const current = this.read();
    if (!current || current.state !== expectedState) {
      throw new Error(`active context switch journal is not ${expectedState}`);
    }
    const { normalized, data } = serialized(document);
    if (normalized.state !== targetState) {
      data.fill(0);
      throw new TypeError(`active context switch journal must transition to ${targetState}`);
    }
    if (immutableBinding(current) !== immutableBinding(normalized)) {
      data.fill(0);
      throw new Error('active context switch journal binding does not match');
    }
    const directory = path.dirname(this.filePath);
    const temporary = path.join(
      directory,
      `.${path.basename(this.filePath)}.${process.pid}.${Date.now()}.${temporarySequence++}.tmp`,
    );
    let descriptor = null;
    let renamed = false;
    try {
      descriptor = this.fileSystem.openSync(temporary, 'wx', 0o600);
      this.fileSystem.writeFileSync(descriptor, data);
      this.fileSystem.fsyncSync?.(descriptor);
      this.fileSystem.closeSync(descriptor);
      descriptor = null;
      if (this.platform === 'win32' &&
          (!this.windowsAcl.protect(temporary) || !this.windowsAcl.verify(temporary))) {
        throw new Error('active context switch temporary Windows ACL is invalid');
      }
      this.fileSystem.renameSync(temporary, this.filePath);
      renamed = true;
      if (this.platform === 'win32' && !this.windowsAcl.verify(this.filePath)) {
        throw new Error('active context switch committed Windows ACL is invalid');
      }
      const durable = fsyncDirectory(directory, this.fileSystem, this.platform);
      if (!durable) {
        const observed = this.read();
        if (!exactDocument(observed, normalized)) {
          throw new Error('active context switch transition durability is unconfirmed');
        }
      }
      return {
        [targetState]: true,
        durabilityUnconfirmed: !durable,
      };
    } catch (error) {
      if (descriptor !== null) {
        try { this.fileSystem.closeSync(descriptor); } catch {}
      }
      if (!renamed) {
        try { this.fileSystem.unlinkSync(temporary); } catch {}
      }
      throw new Error(`active context switch journal ${targetState} failed`, { cause: error });
    } finally {
      data.fill(0);
    }
  }
}

module.exports = {
  ActiveContextSwitchJournalStore,
  MAX_ACTIVE_CONTEXT_SWITCH_BYTES,
};
