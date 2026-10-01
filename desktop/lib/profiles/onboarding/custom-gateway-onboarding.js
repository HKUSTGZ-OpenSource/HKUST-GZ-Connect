'use strict';

const crypto = require('node:crypto');
const {
  PROTOCOL_FAMILY,
  normalizeGatewayOrigin,
  normalizeGatewayLeafSha256,
  validateAccountHandle,
  validateProfileId,
  validateSchoolProfileDocument,
} = require('../schema/school-profile-schema');

const GATEWAY_CONFIRMATION_SCHEMA_VERSION = 1;
const DEFAULT_CONFIRMATION_TTL_MS = 120_000;
const MIN_CONFIRMATION_TTL_MS = 10_000;
const MAX_CONFIRMATION_TTL_MS = 300_000;
const MAX_SCHOOL_LABEL_LENGTH = 96;
const MAX_REPORTED_VERSION_LENGTH = 32;

function plainObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${name} must be a plain object`);
  }
  return value;
}

function exactKeys(value, keys, name) {
  const source = plainObject(value, name);
  const actual = Object.keys(source).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length ||
      actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${name} has an invalid schema`);
  }
  return source;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function positive(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function boundedLabel(value, fallback) {
  if (value == null || String(value).trim() === '') return fallback;
  if (typeof value !== 'string') throw new TypeError('school label must be text');
  const label = value.trim();
  if (!label || label.length > MAX_SCHOOL_LABEL_LENGTH ||
      /[\u0000-\u001f\u007f<>]/u.test(label)) {
    throw new TypeError('school label has an invalid value');
  }
  return label;
}

function boundedVersion(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !value || value.length > MAX_REPORTED_VERSION_LENGTH ||
      !/^[a-zA-Z0-9._-]+$/u.test(value)) {
    throw new TypeError('reported version has an invalid value');
  }
  return value;
}

function activeContext(value) {
  const source = exactKeys(value, [
    'profileId', 'profileRevision', 'accountHandle', 'activeContextEpoch',
  ], 'active context binding');
  return Object.freeze({
    profileId: validateProfileId(source.profileId),
    profileRevision: positive(source.profileRevision, 'profileRevision'),
    accountHandle: validateAccountHandle(source.accountHandle),
    activeContextEpoch: positive(source.activeContextEpoch, 'activeContextEpoch'),
  });
}

function sameContext(left, right) {
  return left.profileId === right.profileId &&
    left.profileRevision === right.profileRevision &&
    left.accountHandle === right.accountHandle &&
    left.activeContextEpoch === right.activeContextEpoch;
}

function entropyId(prefix, randomBytes) {
  let entropy = randomBytes(16);
  if (!Buffer.isBuffer(entropy) || entropy.length !== 16) {
    entropy?.fill?.(0);
    throw new TypeError('custom Gateway onboarding entropy is invalid');
  }
  try { return `${prefix}-${entropy.toString('hex')}`; }
  finally { entropy.fill(0); entropy = null; }
}

function customProfileDocument({ profileId, origin, schoolLabel, leafSha256 = null }) {
  const gateway = normalizeGatewayOrigin(origin);
  const pin = normalizeGatewayLeafSha256(leafSha256);
  if (!String(profileId).startsWith('custom-')) {
    throw new TypeError('custom Profile identity is invalid');
  }
  const label = boundedLabel(schoolLabel, gateway.hostname);
  const shortName = label.length <= 40 ? label : gateway.hostname.slice(0, 40);
  const document = {
    schemaVersion: 1,
    profileId,
    profileRevision: 1,
    profileCredentialBindingRevision: 1,
    evidenceClass: 'custom-local',
    branding: {
      localizedSchoolName: { zh: label, en: label },
      shortName,
      bundledAssetKey: null,
      theme: null,
    },
    gateway: {
      origin: gateway.origin,
      protocolFamily: PROTOCOL_FAMILY,
      engineConfigRef: null,
      ...(pin == null ? {} : { tlsLeafSha256: pin }),
    },
    browser: {
      homeUrl: null,
      officialPortalResourceId: null,
      campusDomains: [],
      directPartnerDomains: [],
      builtinResourcesRef: null,
      healthTargets: [],
    },
    policy: {
      reviewedPrivateGatewayAllowed: false,
      reviewedDnsFallback: [],
    },
  };
  validateSchoolProfileDocument(document);
  return deepFreeze(document);
}

function validatedProbe(value) {
  const pendingTrust = value?.schema_version === 2;
  const source = exactKeys(value, [
    'schema_version', 'normalized_origin', 'https_identity_valid', 'compatibility',
    'candidate_family', 'reported_version', 'http_status',
    ...(pendingTrust ? ['certificate_requires_confirmation', 'leaf_sha256'] : []),
  ], 'public Gateway probe result');
  if ((!pendingTrust && (source.schema_version !== 1 || source.https_identity_valid !== true)) ||
      (pendingTrust && (source.https_identity_valid !== false || source.certificate_requires_confirmation !== true ||
        normalizeGatewayLeafSha256(source.leaf_sha256) == null)) ||
      source.compatibility !== 'recognized_candidate' ||
      source.candidate_family !== PROTOCOL_FAMILY ||
      !Number.isInteger(source.http_status) || source.http_status < 200 || source.http_status > 299) {
    throw new TypeError('public Gateway probe did not establish a supported candidate');
  }
  const gateway = normalizeGatewayOrigin(source.normalized_origin);
  return Object.freeze({
    normalizedOrigin: gateway.origin,
    candidateFamily: PROTOCOL_FAMILY,
    reportedVersion: boundedVersion(source.reported_version),
    httpStatus: source.http_status,
    ...(pendingTrust ? { requiresTrust: true, leafSha256: normalizeGatewayLeafSha256(source.leaf_sha256) } : {}),
  });
}

class CustomGatewayConfirmationOwner {
  #record = null;

  constructor({
    randomBytes = crypto.randomBytes,
    now = Date.now,
    ttlMs = DEFAULT_CONFIRMATION_TTL_MS,
  } = {}) {
    if (typeof randomBytes !== 'function' || typeof now !== 'function' ||
        !Number.isSafeInteger(ttlMs) || ttlMs < MIN_CONFIRMATION_TTL_MS ||
        ttlMs > MAX_CONFIRMATION_TTL_MS) {
      throw new TypeError('custom Gateway confirmation dependencies are invalid');
    }
    this.randomBytes = randomBytes;
    this.now = now;
    this.ttlMs = ttlMs;
  }

  issue({ probeResult, schoolLabel = '', leafSha256 = null, activeContext: contextValue } = {}) {
    const probe = validatedProbe(probeResult);
    if (probe.requiresTrust && leafSha256 != null) throw new TypeError('unexpected observed certificate override');
    const context = activeContext(contextValue);
    const draftProfileId = entropyId('custom', this.randomBytes);
    const confirmationHandle = entropyId('confirmation', this.randomBytes);
    const issuedAt = positive(this.now(), 'confirmation issuedAt');
    const expiresAt = issuedAt + this.ttlMs;
    if (!Number.isSafeInteger(expiresAt)) throw new TypeError('confirmation expiry is invalid');
    const profileDocument = customProfileDocument({
      profileId: draftProfileId,
      origin: probe.normalizedOrigin,
      schoolLabel,
      leafSha256: probe.requiresTrust ? probe.leafSha256 : leafSha256,
    });
    const profile = validateSchoolProfileDocument(profileDocument);
    this.#record = Object.freeze({
      confirmationHandle,
      draftProfileId,
      context,
      probe,
      profileDocument,
      profile,
      issuedAt,
      expiresAt,
    });
    return this.snapshot();
  }

  snapshot() {
    if (!this.#record) return null;
    if (this.now() >= this.#record.expiresAt) {
      this.#record = null;
      return null;
    }
    return Object.freeze({
      schemaVersion: GATEWAY_CONFIRMATION_SCHEMA_VERSION,
      confirmationHandle: this.#record.confirmationHandle,
      normalizedOrigin: this.#record.probe.normalizedOrigin,
      candidateFamily: this.#record.probe.candidateFamily,
      reportedVersion: this.#record.probe.reportedVersion,
      expiresAt: this.#record.expiresAt,
      unverified: true,
      ...(this.#record.probe.requiresTrust ? { requiresTrust: true } : {}),
      ...(this.#record.profile.gateway.tlsLeafSha256 == null ? {} : { leafSha256: this.#record.profile.gateway.tlsLeafSha256 }),
    });
  }

  consume({ confirmationHandle, activeContext: contextValue, trustCertificate = false } = {}) {
    const record = this.#record;
    this.#record = null;
    if (!record || typeof confirmationHandle !== 'string' ||
        confirmationHandle !== record.confirmationHandle || this.now() >= record.expiresAt ||
        !sameContext(activeContext(contextValue), record.context)) {
      throw new Error('custom Gateway confirmation is unavailable or stale');
    }
    if (record.probe.requiresTrust && trustCertificate !== true) {
      throw new Error('explicit certificate trust is required');
    }
    return Object.freeze({
      draftProfileId: record.draftProfileId,
      normalizedOrigin: record.probe.normalizedOrigin,
      candidateFamily: record.probe.candidateFamily,
      profileDocument: record.profileDocument,
      profile: record.profile,
    });
  }

  invalidate() {
    if (!this.#record) return false;
    this.#record = null;
    return true;
  }
}

module.exports = {
  CustomGatewayConfirmationOwner,
  DEFAULT_CONFIRMATION_TTL_MS,
  GATEWAY_CONFIRMATION_SCHEMA_VERSION,
  customProfileDocument,
};
