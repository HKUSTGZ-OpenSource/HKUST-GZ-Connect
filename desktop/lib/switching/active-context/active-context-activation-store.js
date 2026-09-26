'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const {
  validateActiveContextSwitchJournal,
} = require('./active-context-switch-journal');
const {
  createProfileAccountWorkspaceLayout,
  validateUserDataRoot,
} = require('../../persistence/paths/profile-workspace-layout');
const {
  validateGlobalSettingsDocument,
} = require('../../persistence/schema/profile-workspace-documents');

const MAX_TARGET_BYTES = 512 * 1024;
const WORKSPACE_KEYS = Object.freeze([
  'schemaVersion', 'profileId', 'profileRevision', 'accountKey', 'accountRevision',
  'workspaceKey', 'activeContextEpoch',
]);

function receipt(data) {
  if (!Buffer.isBuffer(data) || data.length < 2 || data.length > MAX_TARGET_BYTES) {
    throw new TypeError('active context activation target is invalid');
  }
  return Object.freeze({
    present: true,
    bytes: data.length,
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
  });
}

function sameReceipt(left, right) {
  return left.present === right.present && left.bytes === right.bytes &&
    left.sha256 === right.sha256;
}

function exactWorkspace(value, expected, epoch) {
  if (!expected || typeof expected !== 'object' || !value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...WORKSPACE_KEYS].sort()) ||
      value.schemaVersion !== 1 || value.profileId !== expected.profileId ||
      value.profileRevision !== expected.profileRevision ||
      value.accountKey !== expected.accountKey || value.accountRevision !== expected.accountRevision ||
      value.workspaceKey !== expected.workspaceKey || value.activeContextEpoch !== epoch) {
    throw new Error('destination Workspace state does not match switch authority');
  }
  return Object.freeze({ ...value });
}

function serialized(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}

function storageOptions(platform, windowsAcl) {
  return platform === 'win32' ? {
    protectTemporary: (file) => windowsAcl.protect(file) === true,
    verifyCommitted: (file) => windowsAcl.verify(file) === true,
    removeCommittedOnFailure: true,
  } : {};
}

class ActiveContextActivationStore {
  constructor({
    userData,
    profileStorageEffects,
    fileSystem: fileSystemOverride,
    platform: platformOverride,
    windowsAcl: windowsAclOverride,
  } = {}) {
    if (typeof profileStorageEffects?.assertCompatible !== 'function') {
      throw new TypeError('active context activation storage effects are required');
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
        typeof profileStorageEffects.atomicWritePrivateFile !== 'function' ||
        typeof profileStorageEffects.readPrivateFileBounded !== 'function' ||
        !['darwin', 'linux', 'win32'].includes(platform) ||
        (platform === 'win32' &&
          (typeof windowsAcl?.protect !== 'function' || typeof windowsAcl?.verify !== 'function'))) {
      throw new TypeError('active context activation store dependencies are invalid');
    }
    this.userData = validateUserDataRoot(userData);
    this.profileStorageEffects = profileStorageEffects;
    this.fileSystem = fileSystem;
    this.platform = platform;
    this.windowsAcl = windowsAcl;
    this.globalSettings = path.join(this.userData, 'global', 'settings.json');
  }

  plan({ from, to, nextActiveContextEpoch } = {}) {
    const global = this.#readDocument(this.globalSettings, 'GlobalSettings');
    const workspacePath = this.#workspaceStatePath(to);
    const workspace = this.#readDocument(workspacePath, 'destination Workspace');
    try {
      const globalDocument = validateGlobalSettingsDocument(global.value);
      if (globalDocument.activeProfileKey !== from?.profileKey ||
          globalDocument.activeAccountKey !== from?.accountKey) {
        throw new Error('GlobalSettings does not match switch source authority');
      }
      exactWorkspace(workspace.value, to, to?.activeContextEpoch);
      const nextGlobal = validateGlobalSettingsDocument({
        ...globalDocument,
        activeProfileKey: to.profileKey,
        activeAccountKey: to.accountKey,
      });
      const nextWorkspace = exactWorkspace({
        ...workspace.value,
        activeContextEpoch: nextActiveContextEpoch,
      }, to, nextActiveContextEpoch);
      const globalAfter = serialized(nextGlobal);
      const workspaceAfter = serialized(nextWorkspace);
      try {
        return Object.freeze({
          globalSettings: Object.freeze({
            before: receipt(global.data),
            after: receipt(globalAfter),
          }),
          destinationWorkspace: Object.freeze({
            before: receipt(workspace.data),
            after: receipt(workspaceAfter),
          }),
        });
      } finally {
        globalAfter.fill(0);
        workspaceAfter.fill(0);
      }
    } finally {
      global.data.fill(0);
      workspace.data.fill(0);
    }
  }

  readState(journalValue) {
    const journal = validateActiveContextSwitchJournal(journalValue);
    return Object.freeze({
      globalSettings: this.#readReceipt(this.globalSettings, 'GlobalSettings'),
      destinationWorkspace: this.#readReceipt(
        this.#workspaceStatePath(journal.to),
        'destination Workspace',
      ),
    });
  }

  apply(journalValue) {
    const journal = validateActiveContextSwitchJournal(journalValue);
    if (journal.state !== 'ready') {
      throw new TypeError('active context activation requires a ready switch journal');
    }
    const targets = [
      {
        name: 'destinationWorkspace',
        path: this.#workspaceStatePath(journal.to),
        build: (current) => serialized(exactWorkspace({
          ...current,
          activeContextEpoch: journal.nextActiveContextEpoch,
        }, journal.to, journal.nextActiveContextEpoch)),
      },
      {
        name: 'globalSettings',
        path: this.globalSettings,
        build: (current) => serialized(validateGlobalSettingsDocument({
          ...current,
          activeProfileKey: journal.to.profileKey,
          activeAccountKey: journal.to.accountKey,
        })),
      },
    ];
    for (const target of targets) this.#applyTarget(target, journal.activation[target.name]);
    const observed = this.readState(journal);
    if (!sameReceipt(observed.globalSettings, journal.activation.globalSettings.after) ||
        !sameReceipt(
          observed.destinationWorkspace,
          journal.activation.destinationWorkspace.after,
        )) {
      throw new Error('active context activation did not reach its after receipts');
    }
    return true;
  }

  #applyTarget(target, transition) {
    const current = this.#readDocument(target.path, target.name);
    try {
      const currentReceipt = receipt(current.data);
      if (sameReceipt(currentReceipt, transition.after)) return;
      if (!sameReceipt(currentReceipt, transition.before)) {
        throw new Error(`active context activation target changed: ${target.name}`);
      }
      const next = target.build(current.value);
      try {
        if (!sameReceipt(receipt(next), transition.after)) {
          throw new Error(`active context activation plan drifted: ${target.name}`);
        }
        if (!this.profileStorageEffects.atomicWritePrivateFile(
          target.path,
          next,
          storageOptions(this.platform, this.windowsAcl),
        )) {
          throw new Error(`active context activation write failed: ${target.name}`);
        }
      } finally {
        next.fill(0);
      }
    } finally {
      current.data.fill(0);
    }
  }

  #readReceipt(file, name) {
    const current = this.#readDocument(file, name);
    try { return receipt(current.data); }
    finally { current.data.fill(0); }
  }

  #readDocument(file, name) {
    if (this.platform === 'win32' && !this.windowsAcl.verify(file)) {
      throw new Error(`${name} ACL is invalid`);
    }
    let data;
    try {
      ({ data } = this.profileStorageEffects.readPrivateFileBounded(file, {
        maxBytes: MAX_TARGET_BYTES,
        minBytes: 2,
      }));
    } catch (error) {
      throw new Error(`${name} is unavailable`, { cause: error });
    }
    try {
      return { data, value: JSON.parse(data.toString('utf8')) };
    } catch (error) {
      data.fill(0);
      throw new Error(`${name} is invalid`, { cause: error });
    }
  }

  #workspaceStatePath(context) {
    return createProfileAccountWorkspaceLayout({
      userData: this.userData,
      profileKey: context?.profileKey,
      accountKey: context?.accountKey,
      workspaceKey: context?.workspaceKey,
    }).workspace.state;
  }
}

module.exports = { ActiveContextActivationStore };
