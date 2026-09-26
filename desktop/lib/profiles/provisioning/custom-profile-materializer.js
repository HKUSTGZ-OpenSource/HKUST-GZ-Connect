'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const {
  CUSTOM_PROFILE_FILE_IDS,
  CUSTOM_PROFILE_PROVISIONING_VERSION,
} = require('./custom-profile-provisioning-plan');

const MAX_CUSTOM_PROFILE_FILE_BYTES = 512 * 1024;

function receipt(data) {
  if (data === null) return Object.freeze({ present: false, bytes: 0, sha256: null });
  if (!Buffer.isBuffer(data) || data.length < 2 || data.length > MAX_CUSTOM_PROFILE_FILE_BYTES) {
    throw new TypeError('custom Profile file has an invalid size');
  }
  return Object.freeze({
    present: true,
    bytes: data.length,
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
  });
}

function sameReceipt(left, right) {
  return Boolean(left && right && left.present === right.present && left.bytes === right.bytes &&
    left.sha256 === right.sha256);
}

function exactPlan(plan) {
  if (!plan || plan.schemaVersion !== CUSTOM_PROFILE_PROVISIONING_VERSION ||
      !plan.layout || !plan.paths || !plan.files ||
      CUSTOM_PROFILE_FILE_IDS.some((id) => typeof plan.paths[id] !== 'string' ||
        !Buffer.isBuffer(plan.files[id])) ||
      Object.keys(plan.paths).length !== CUSTOM_PROFILE_FILE_IDS.length ||
      Object.keys(plan.files).length !== CUSTOM_PROFILE_FILE_IDS.length) {
    throw new TypeError('custom Profile materialization plan is invalid');
  }
  const root = plan.layout.root;
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.resolve(root) !== root ||
      new Set(Object.values(plan.paths)).size !== CUSTOM_PROFILE_FILE_IDS.length ||
      Object.values(plan.paths).some((file) => {
        if (!path.isAbsolute(file) || path.resolve(file) !== file) return true;
        const relative = path.relative(root, file);
        return !relative || relative === '..' || relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative);
      })) {
    throw new TypeError('custom Profile materialization paths are invalid');
  }
  return plan;
}

class CustomProfileMaterializer {
  constructor({
    profileStorageEffects,
    fileSystem: fileSystemOverride,
    platform: platformOverride,
    windowsAcl: windowsAclOverride,
  } = {}) {
    if (typeof profileStorageEffects?.assertCompatible !== 'function') {
      throw new TypeError('custom Profile materializer storage effects are required');
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
        (platform === 'win32' && (typeof windowsAcl?.protect !== 'function' ||
          typeof windowsAcl?.verify !== 'function'))) {
      throw new TypeError('custom Profile materializer dependencies are invalid');
    }
    this.profileStorageEffects = profileStorageEffects;
    this.fileSystem = fileSystem;
    this.platform = platform;
    this.windowsAcl = windowsAcl;
  }

  expected(planValue) {
    const plan = exactPlan(planValue);
    return Object.freeze(Object.fromEntries(CUSTOM_PROFILE_FILE_IDS.map((id) => (
      [id, receipt(plan.files[id])]
    ))));
  }

  observe(planValue) {
    const plan = exactPlan(planValue);
    return Object.freeze(Object.fromEntries(CUSTOM_PROFILE_FILE_IDS.map((id) => (
      [id, this.#fileReceipt(plan.paths[id])]
    ))));
  }

  verify(planValue, expectedValue) {
    const expected = this.#expected(expectedValue);
    const observed = this.observe(planValue);
    return CUSTOM_PROFILE_FILE_IDS.every((id) => sameReceipt(observed[id], expected[id]));
  }

  materialize(planValue, expectedValue) {
    const plan = exactPlan(planValue);
    const expected = this.#expected(expectedValue);
    const calculated = this.expected(plan);
    if (CUSTOM_PROFILE_FILE_IDS.some((id) => !sameReceipt(expected[id], calculated[id]))) {
      throw new Error('custom Profile materialization receipt plan drifted');
    }

    const before = this.observe(plan);
    for (const id of CUSTOM_PROFILE_FILE_IDS) {
      if (before[id].present && !sameReceipt(before[id], expected[id])) {
        throw new Error(`custom Profile destination conflict: ${id}`);
      }
    }
    for (const directory of new Set(Object.values(plan.paths).map(path.dirname))) {
      this.profileStorageEffects.ensurePrivateDirectoryChain(plan.layout.root, directory);
    }
    const options = this.platform === 'win32' ? {
      protectTemporary: (file) => this.windowsAcl.protect(file) === true,
      verifyCommitted: (file) => this.windowsAcl.verify(file) === true,
      removeCommittedOnFailure: true,
    } : {};
    for (const id of CUSTOM_PROFILE_FILE_IDS) {
      if (before[id].present) continue;
      if (!this.profileStorageEffects.atomicWritePrivateFile(plan.paths[id], plan.files[id], options) &&
          !sameReceipt(this.#fileReceipt(plan.paths[id]), expected[id])) {
        throw new Error(`custom Profile destination write failed: ${id}`);
      }
    }
    if (!this.verify(plan, expected)) {
      throw new Error('custom Profile destination verification failed');
    }
    return true;
  }

  #expected(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).length !== CUSTOM_PROFILE_FILE_IDS.length ||
        CUSTOM_PROFILE_FILE_IDS.some((id) => !Object.hasOwn(value, id) ||
          value[id]?.present !== true || !Number.isSafeInteger(value[id].bytes) ||
          value[id].bytes < 2 || value[id].bytes > MAX_CUSTOM_PROFILE_FILE_BYTES ||
          !/^[a-f0-9]{64}$/u.test(value[id].sha256))) {
      throw new TypeError('custom Profile expected receipts are invalid');
    }
    return value;
  }

  #fileReceipt(file) {
    try { this.fileSystem.lstatSync(file); }
    catch (error) {
      if (error?.code === 'ENOENT') return receipt(null);
      throw error;
    }
    if (this.platform === 'win32' && !this.windowsAcl.verify(file)) {
      throw new Error('custom Profile destination ACL is invalid');
    }
    const { data } = this.profileStorageEffects.readPrivateFileBounded(file, {
      maxBytes: MAX_CUSTOM_PROFILE_FILE_BYTES,
      minBytes: 2,
    });
    try { return receipt(data); }
    finally { data.fill(0); }
  }
}

module.exports = {
  CustomProfileMaterializer,
  MAX_CUSTOM_PROFILE_FILE_BYTES,
  customProfileFileReceipt: receipt,
  sameCustomProfileFileReceipt: sameReceipt,
};
