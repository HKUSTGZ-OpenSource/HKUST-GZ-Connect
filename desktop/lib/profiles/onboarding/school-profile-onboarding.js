'use strict';

const {
  normalizeGatewayOrigin,
  normalizeGatewayLeafSha256,
  validateAccountHandle,
  validateProfileId,
} = require('../schema/school-profile-schema');

const ONBOARDING_ERROR_CODES = new Set([
  'GATEWAY_PROBE_ALREADY_RUNNING',
  'GATEWAY_PROBE_CANCELLED',
  'GATEWAY_PROBE_FAILED',
  'GATEWAY_PROBE_OUTPUT_INVALID',
  'GATEWAY_PROBE_START_FAILED',
  'GATEWAY_PROBE_TIMEOUT',
  'GATEWAY_PROBE_UNSUPPORTED',
  'PROFILE_CONFIRMATION_STALE',
  'PROFILE_LIST_FAILED',
  'PROFILE_ONBOARDING_NOT_READY',
  'PROFILE_PROVISIONING_FAILED',
]);

function activeContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('active onboarding context is invalid');
  }
  const keys = Object.keys(value).sort();
  const expected = [
    'profileId', 'profileRevision', 'accountHandle', 'activeContextEpoch',
  ].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]) ||
      !Number.isSafeInteger(value.profileRevision) || value.profileRevision <= 0 ||
      !Number.isSafeInteger(value.activeContextEpoch) || value.activeContextEpoch <= 0) {
    throw new TypeError('active onboarding context is invalid');
  }
  return Object.freeze({
    profileId: validateProfileId(value.profileId),
    profileRevision: value.profileRevision,
    accountHandle: validateAccountHandle(value.accountHandle),
    activeContextEpoch: value.activeContextEpoch,
  });
}

function sameContext(left, right) {
  return left.profileId === right.profileId &&
    left.profileRevision === right.profileRevision &&
    left.accountHandle === right.accountHandle &&
    left.activeContextEpoch === right.activeContextEpoch;
}

function onboardingErrorCode(error, fallback) {
  return ONBOARDING_ERROR_CODES.has(error?.code) ? error.code : fallback;
}

function boundedViewText(value, maxLength) {
  return typeof value === 'string' && value.length >= 1 && value.length <= maxLength &&
    !/[\u0000-\u001f\u007f<>]/u.test(value);
}

function profileViews(value, activeProfileId) {
  if (!Array.isArray(value) || value.length > 64) {
    throw new TypeError('Profile candidate views are invalid');
  }
  return Object.freeze(value.map((view) => {
    if (!view || typeof view !== 'object' || Array.isArray(view) ||
        view.schemaVersion !== 1 || !Number.isSafeInteger(view.profileRevision) ||
        view.profileRevision <= 0 || !['builtin-reviewed', 'custom-local'].includes(view.evidenceClass) ||
        !boundedViewText(view.schoolName, 160) || !boundedViewText(view.shortName, 80) ||
        (view.bundledAssetKey !== null && !boundedViewText(view.bundledAssetKey, 80)) ||
        !['reviewed', 'candidate', 'unsupported', 'unknown'].includes(view.sanitizedCompatibility) ||
        typeof view.unverified !== 'boolean') {
      throw new TypeError('Profile candidate view is invalid');
    }
    const profileId = validateProfileId(view.profileId);
    return Object.freeze({
      schemaVersion: 1,
      profileId,
      profileRevision: view.profileRevision,
      evidenceClass: view.evidenceClass,
      schoolName: view.schoolName,
      shortName: view.shortName,
      bundledAssetKey: view.bundledAssetKey,
      normalizedGatewayOrigin: normalizeGatewayOrigin(view.normalizedGatewayOrigin).origin,
      sanitizedCompatibility: view.sanitizedCompatibility,
      unverified: view.unverified,
      active: profileId === activeProfileId,
    });
  }));
}

class SchoolProfileOnboardingCoordinator {
  #running = false;

  constructor({
    probeRunner,
    confirmationOwner,
    provisioningRuntime,
    getActiveContext,
    listProfiles,
    onDiagnostic = () => {},
  } = {}) {
    if (!probeRunner || typeof probeRunner.probe !== 'function' ||
        typeof probeRunner.cancel !== 'function' ||
        !confirmationOwner || typeof confirmationOwner.issue !== 'function' ||
        typeof confirmationOwner.consume !== 'function' ||
        typeof confirmationOwner.invalidate !== 'function' ||
        !provisioningRuntime || typeof provisioningRuntime.begin !== 'function' ||
        typeof getActiveContext !== 'function' || typeof listProfiles !== 'function' ||
        typeof onDiagnostic !== 'function') {
      throw new TypeError('school Profile onboarding dependencies are invalid');
    }
    this.probeRunner = probeRunner;
    this.confirmationOwner = confirmationOwner;
    this.provisioningRuntime = provisioningRuntime;
    this.getActiveContext = getActiveContext;
    this.listProfilesSource = listProfiles;
    this.onDiagnostic = onDiagnostic;
  }

  list({ locale = 'en' } = {}) {
    if (!['zh', 'en'].includes(locale)) throw new TypeError('Profile locale is invalid');
    const current = activeContext(this.getActiveContext());
    return profileViews(this.listProfilesSource({ locale }), current.profileId);
  }

  async probe({ origin, schoolLabel = '', leafSha256 = null } = {}) {
    const pin = normalizeGatewayLeafSha256(leafSha256);
    return this.#singleFlight(async () => {
      this.confirmationOwner.invalidate();
      const context = activeContext(this.getActiveContext());
      let result;
      try { result = await this.probeRunner.probe(origin, { leafSha256: pin }); }
      catch (error) {
        const code = onboardingErrorCode(error, 'GATEWAY_PROBE_FAILED');
        this.onDiagnostic(code);
        return Object.freeze({ ok: false, code });
      }
      if (!sameContext(context, activeContext(this.getActiveContext()))) {
        this.confirmationOwner.invalidate();
        return Object.freeze({ ok: false, code: 'PROFILE_CONFIRMATION_STALE' });
      }
      try {
        return Object.freeze({
          ok: true,
          confirmation: this.confirmationOwner.issue({
            probeResult: result,
            schoolLabel,
            leafSha256: pin,
            activeContext: context,
          }),
        });
      } catch (error) {
        this.onDiagnostic('GATEWAY_PROBE_UNSUPPORTED');
        return Object.freeze({ ok: false, code: 'GATEWAY_PROBE_UNSUPPORTED' });
      }
    });
  }

  confirm({ confirmationHandle, trustCertificate = false } = {}) {
    if (this.#running) return Object.freeze({ ok: false, code: 'PROFILE_ONBOARDING_NOT_READY' });
    const context = activeContext(this.getActiveContext());
    let confirmation;
    try {
      confirmation = this.confirmationOwner.consume({
        confirmationHandle,
        activeContext: context,
        trustCertificate,
      });
    } catch (error) {
      return Object.freeze({ ok: false, code: 'PROFILE_CONFIRMATION_STALE' });
    }
    try {
      const provisioned = this.provisioningRuntime.begin(confirmation);
      let profiles;
      let warningCode = null;
      try { profiles = this.list(); }
      catch {
        profiles = Object.freeze([]);
        warningCode = 'PROFILE_LIST_FAILED';
        this.onDiagnostic(warningCode);
      }
      return Object.freeze({
        ok: true,
        profileId: provisioned.profileId,
        profiles,
        warningCode,
      });
    } catch (error) {
      this.onDiagnostic('PROFILE_PROVISIONING_FAILED');
      return Object.freeze({ ok: false, code: 'PROFILE_PROVISIONING_FAILED' });
    }
  }

  cancel() {
    const probe = this.probeRunner.cancel();
    const confirmation = this.confirmationOwner.invalidate();
    return probe || confirmation;
  }

  #singleFlight(operation) {
    if (this.#running) {
      return Promise.resolve(Object.freeze({
        ok: false,
        code: 'GATEWAY_PROBE_ALREADY_RUNNING',
      }));
    }
    this.#running = true;
    return Promise.resolve().then(operation).finally(() => { this.#running = false; });
  }
}

module.exports = {
  ONBOARDING_ERROR_CODES,
  SchoolProfileOnboardingCoordinator,
  onboardingErrorCode,
};
