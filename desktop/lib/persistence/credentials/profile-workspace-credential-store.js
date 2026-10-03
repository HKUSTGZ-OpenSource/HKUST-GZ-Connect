'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWritePrivateFile } = require('./credential-store');
const { collectPrivateFileReceipt } = require('../migration/legacy-hkust/legacy-flat-source-receipts');
const { readPrivateFileBounded } = require('../../platform/storage/private-file');
const {
  decryptVpnCredentialEnvelope,
  encryptVpnCredentialEnvelope,
} = require('./vpn-credential-envelope');
const {
  CREDENTIAL_TRANSACTION_VERSION,
  MAX_ACCOUNT_DOCUMENT_BYTES,
  MAX_CREDENTIAL_TRANSACTION_BYTES,
  MAX_VPN_CREDENTIAL_BYTES,
  bindingFromAuthority,
  createNextAccountDocument,
  positive,
  receipt,
  sameDocument,
  sameReceipt,
  serializeAccountDocument,
  validateCredentialTransaction,
} = require('./profile-workspace-credential-transaction');
const {
  protectWindowsFileOwnerOnly,
  verifyWindowsFileOwnerOnly,
} = require('../../platform/storage/windows-private-file');

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

function storageOptions(platform, windowsAcl) {
  return platform === 'win32' ? {
    protectTemporary: (temporary) => windowsAcl.protect(temporary) === true,
    verifyCommitted: (committed) => windowsAcl.verify(committed) === true,
    removeCommittedOnFailure: true,
  } : {};
}

class ProfileWorkspaceCredentialStore {
  constructor({
    loadAccountAuthority,
    loadWorkspaceAuthority,
    retireRollback,
    safeStorage,
    fileSystem = fs,
    platform = process.platform,
    windowsAcl = {
      protect: protectWindowsFileOwnerOnly,
      verify: verifyWindowsFileOwnerOnly,
    },
    randomBytes = crypto.randomBytes,
    now = Date.now,
  } = {}) {
    if (typeof loadAccountAuthority !== 'function' ||
        typeof loadWorkspaceAuthority !== 'function' || typeof retireRollback !== 'function' ||
        !safeStorage || !fileSystem || typeof fileSystem.openSync !== 'function' ||
        !['darwin', 'linux', 'win32'].includes(platform) ||
        (platform === 'win32' &&
          (typeof windowsAcl?.protect !== 'function' || typeof windowsAcl?.verify !== 'function')) ||
        typeof randomBytes !== 'function' || typeof now !== 'function') {
      throw new TypeError('profile workspace credential store dependencies are invalid');
    }
    this.loadAccountAuthority = loadAccountAuthority;
    this.loadWorkspaceAuthority = loadWorkspaceAuthority;
    this.retireRollback = retireRollback;
    this.safeStorage = safeStorage;
    this.fileSystem = fileSystem;
    this.platform = platform;
    this.windowsAcl = windowsAcl;
    this.randomBytes = randomBytes;
    this.now = now;
    this.running = false;
  }

  replace({ username, password } = {}) {
    return this.#mutate('replace', { username, password });
  }

  clear() {
    return this.#mutate('clear', null);
  }

  open() {
    this.reconcile();
    const authority = this.#workspaceAuthority();
    if (!authority.hasCredential || authority.account.activeCredentialVersion === null) return null;
    const data = this.#readCredential(authority.layout.account.vpnCredential);
    try {
      return decryptVpnCredentialEnvelope(data, {
        expectedBinding: authority.credentialBinding,
        safeStorage: this.safeStorage,
        platform: this.platform,
      });
    } finally {
      data.fill(0);
    }
  }

  reconcile() {
    return this.#singleFlight(() => {
      const authority = this.#accountAuthority();
      const paths = this.#paths(authority);
      const intent = this.#readIntent(paths.intent, bindingFromAuthority(authority));
      if (!intent) return Object.freeze({ changed: false });
      this.#resume(intent, authority);
      this.#workspaceAuthority();
      return Object.freeze({ changed: true });
    });
  }

  #mutate(operation, credential) {
    return this.#singleFlight(() => {
      this.#reconcileOnce();
      const authority = this.#workspaceAuthority();
      const paths = this.#paths(authority);
      const beforeCredential = this.#credentialReceipt(paths.credential);
      if (beforeCredential.present !== (authority.account.activeCredentialVersion !== null)) {
        throw new Error('profile workspace credential presence does not match Account');
      }
      const retirementReason = operation === 'replace' ? 'credential_replaced' : 'credential_cleared';
      const retirement = this.retireRollback({ authority, reason: retirementReason });
      if (retirement && typeof retirement.then === 'function') {
        throw new TypeError('rollback retirement must be synchronous');
      }
      const ownsLegacyRollback = authority.profile.evidenceClass === 'builtin-reviewed' &&
        authority.profile.profileId === 'hkustgz';
      const notApplicable = !ownsLegacyRollback && retirement?.status === 'not-applicable';
      if (!retirement || (retirement.status !== 'retired' && !notApplicable)) {
        throw new Error('legacy rollback credential retirement was not proven');
      }
      if (operation === 'clear' && !beforeCredential.present &&
          authority.account.activeCredentialVersion === null) {
        return Object.freeze({ changed: false, hasCredential: false });
      }
      const timestamp = this.now();
      positive(timestamp, 'updatedAt');
      const nextCredentialRevision = authority.account.accountCredentialRevision + 1;
      if (!Number.isSafeInteger(nextCredentialRevision)) {
        throw new Error('Account credential revision is exhausted');
      }
      const nextCredentialVersion = operation === 'replace'
        ? (authority.account.activeCredentialVersion || 0) + 1
        : null;
      const nextAccount = createNextAccountDocument(authority.account, {
        accountCredentialRevision: nextCredentialRevision,
        activeCredentialVersion: nextCredentialVersion,
        updatedAt: timestamp,
      });
      const nextAccountBytes = serializeAccountDocument(nextAccount);
      let nextCredential = null;
      try {
        if (operation === 'replace') {
          nextCredential = encryptVpnCredentialEnvelope({
            binding: {
              ...authority.credentialBinding,
              accountCredentialRevision: nextCredentialRevision,
            },
            credentialVersion: nextCredentialVersion,
            username: credential?.username,
            password: credential?.password,
            updatedAt: timestamp,
            safeStorage: this.safeStorage,
            platform: this.platform,
          });
        }
        const intent = this.#createIntent({
          operation,
          authority,
          beforeAccount: this.#accountReceipt(paths.account),
          beforeCredential,
          nextAccountBytes,
          nextCredential,
          timestamp,
        });
        this.#writeIntent(paths.intent, intent);
        this.#resume(intent, authority);
        return Object.freeze({ changed: true, hasCredential: operation === 'replace' });
      } finally {
        nextAccountBytes.fill(0);
        nextCredential?.fill(0);
      }
    });
  }

  #reconcileOnce() {
    const authority = this.#accountAuthority();
    const paths = this.#paths(authority);
    const intent = this.#readIntent(paths.intent, bindingFromAuthority(authority));
    if (intent) this.#resume(intent, authority);
  }

  #createIntent({
    operation,
    authority,
    beforeAccount,
    beforeCredential,
    nextAccountBytes,
    nextCredential,
    timestamp,
  }) {
    let entropy = this.randomBytes(16);
    if (!Buffer.isBuffer(entropy) || entropy.length !== 16) {
      entropy?.fill?.(0);
      throw new Error('profile workspace credential transaction entropy is invalid');
    }
    let transactionId;
    try { transactionId = `transaction-${entropy.toString('hex')}`; }
    finally { entropy.fill(0); entropy = null; }
    return validateCredentialTransaction({
      schemaVersion: CREDENTIAL_TRANSACTION_VERSION,
      type: 'profile_workspace_credential_commit',
      transactionId,
      binding: bindingFromAuthority(authority),
      operation,
      createdAt: timestamp,
      beforeAccount,
      afterAccount: {
        receipt: receipt(nextAccountBytes, { maxBytes: MAX_ACCOUNT_DOCUMENT_BYTES }),
        data: nextAccountBytes.toString('base64'),
      },
      beforeCredential,
      afterCredential: {
        receipt: receipt(nextCredential, {
          allowAbsent: true,
          maxBytes: MAX_VPN_CREDENTIAL_BYTES,
        }),
        data: nextCredential === null ? null : nextCredential.toString('base64'),
      },
    });
  }

  #resume(intent, authority) {
    if (!sameDocument(intent.binding, bindingFromAuthority(authority))) {
      throw new Error('profile workspace credential transaction binding does not match');
    }
    const paths = this.#paths(authority);
    const currentAccount = this.#accountReceipt(paths.account);
    const currentCredential = this.#credentialReceipt(paths.credential);
    if (![intent.beforeAccount, intent.afterAccount.receipt]
      .some((candidate) => sameReceipt(currentAccount, candidate)) ||
      ![intent.beforeCredential, intent.afterCredential.receipt]
        .some((candidate) => sameReceipt(currentCredential, candidate))) {
      throw new Error('profile workspace credential target changed outside transaction');
    }

    if (!sameReceipt(currentCredential, intent.afterCredential.receipt)) {
      if (!sameReceipt(currentCredential, intent.beforeCredential)) {
        throw new Error('profile workspace credential changed outside transaction');
      }
      if (intent.afterCredential.receipt.present) {
        const data = Buffer.from(intent.afterCredential.data, 'base64');
        try { this.#writePrivate(paths.credential, data, 'credential'); }
        finally { data.fill(0); }
      } else {
        try {
          this.fileSystem.unlinkSync(paths.credential);
        } catch (error) {
          if (error?.code !== 'ENOENT') {
            throw new Error('profile workspace credential removal failed', { cause: error });
          }
        }
        if (!fsyncDirectory(path.dirname(paths.credential), this.fileSystem, this.platform)) {
          throw new Error('profile workspace credential removal was not durable');
        }
      }
    }
    if (!sameReceipt(this.#accountReceipt(paths.account), intent.afterAccount.receipt)) {
      const data = Buffer.from(intent.afterAccount.data, 'base64');
      try { this.#writePrivate(paths.account, data, 'Account'); }
      finally { data.fill(0); }
    }
    if (!sameReceipt(this.#accountReceipt(paths.account), intent.afterAccount.receipt) ||
        !sameReceipt(this.#credentialReceipt(paths.credential), intent.afterCredential.receipt)) {
      throw new Error('profile workspace credential transaction verification failed');
    }
    try {
      this.fileSystem.unlinkSync(paths.intent);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw new Error('profile workspace credential transaction clear failed', { cause: error });
      }
    }
    if (!fsyncDirectory(path.dirname(paths.intent), this.fileSystem, this.platform)) {
      throw new Error('profile workspace credential transaction clear was not durable');
    }
  }

  #singleFlight(operation) {
    if (this.running) throw new Error('profile workspace credential transaction is already running');
    this.running = true;
    try {
      const value = operation();
      if (value && typeof value.then === 'function') {
        throw new TypeError('profile workspace credential transaction must be synchronous');
      }
      return value;
    } finally {
      this.running = false;
    }
  }

  #accountAuthority() {
    const value = this.loadAccountAuthority();
    if (value && typeof value.then === 'function') {
      throw new TypeError('Profile Account authority must be synchronous');
    }
    bindingFromAuthority(value);
    return value;
  }

  #workspaceAuthority() {
    const value = this.loadWorkspaceAuthority();
    if (value && typeof value.then === 'function') {
      throw new TypeError('Profile Workspace authority must be synchronous');
    }
    bindingFromAuthority(value);
    return value;
  }

  #paths(authority) {
    const values = {
      account: authority?.layout?.account?.document,
      credential: authority?.layout?.account?.vpnCredential,
      intent: authority?.layout?.account?.credentialTransaction,
    };
    if (Object.values(values).some((file) => typeof file !== 'string' || !path.isAbsolute(file)) ||
        new Set(Object.values(values)).size !== 3) {
      throw new TypeError('profile workspace credential paths are invalid');
    }
    return values;
  }

  #accountReceipt(file) {
    return collectPrivateFileReceipt({
      file,
      maxBytes: MAX_ACCOUNT_DOCUMENT_BYTES,
      fileSystem: this.fileSystem,
      platform: this.platform,
      windowsAcl: this.windowsAcl,
      label: 'profile workspace Account document',
    });
  }

  #credentialReceipt(file) {
    return collectPrivateFileReceipt({
      file,
      maxBytes: MAX_VPN_CREDENTIAL_BYTES,
      fileSystem: this.fileSystem,
      platform: this.platform,
      windowsAcl: this.windowsAcl,
      label: 'profile workspace VPN credential',
    });
  }

  #readCredential(file) {
    if (this.platform === 'win32' && !this.windowsAcl.verify(file)) {
      throw new Error('profile workspace VPN credential ACL is invalid');
    }
    return readPrivateFileBounded(file, {
      maxBytes: MAX_VPN_CREDENTIAL_BYTES,
      platform: this.platform,
      fileSystem: this.fileSystem,
    }).data;
  }

  #readIntent(file, expectedBinding) {
    try { this.fileSystem.lstatSync(file); }
    catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    if (this.platform === 'win32' && !this.windowsAcl.verify(file)) {
      throw new Error('profile workspace credential transaction ACL is invalid');
    }
    let data;
    try {
      ({ data } = readPrivateFileBounded(file, {
        maxBytes: MAX_CREDENTIAL_TRANSACTION_BYTES,
        minBytes: 2,
        platform: this.platform,
        fileSystem: this.fileSystem,
      }));
      return validateCredentialTransaction(JSON.parse(data.toString('utf8')), expectedBinding);
    } finally {
      data?.fill(0);
    }
  }

  #writeIntent(file, intent) {
    const data = Buffer.from(`${JSON.stringify(intent)}\n`, 'utf8');
    try {
      if (data.length > MAX_CREDENTIAL_TRANSACTION_BYTES || !atomicWritePrivateFile(
        file,
        data,
        this.fileSystem,
        storageOptions(this.platform, this.windowsAcl),
      )) {
        throw new Error('profile workspace credential transaction write failed');
      }
    } finally { data.fill(0); }
  }

  #writePrivate(file, data, label) {
    if (!atomicWritePrivateFile(
      file,
      data,
      this.fileSystem,
      storageOptions(this.platform, this.windowsAcl),
    )) {
      throw new Error(`profile workspace ${label} write failed`);
    }
  }
}

module.exports = {
  CREDENTIAL_TRANSACTION_VERSION,
  MAX_CREDENTIAL_TRANSACTION_BYTES,
  ProfileWorkspaceCredentialStore,
};
