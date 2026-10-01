'use strict';

const { allowedKeys, boundedString } = require('./ipc-guard');

function probeRequest(value) {
  const source = allowedKeys(value, ['origin', 'schoolLabel', 'leafSha256']);
  return Object.freeze({
    origin: boundedString(source.origin, {
      minLength: 1,
      maxLength: 2048,
      trim: true,
      message: 'Gateway 地址无效',
    }),
    schoolLabel: boundedString(source.schoolLabel ?? '', {
      maxLength: 96,
      trim: true,
      message: '学校名称无效',
    }),
    ...(source.leafSha256 == null || source.leafSha256 === '' ? {} : {
      leafSha256: boundedString(source.leafSha256, { minLength: 64, maxLength: 64,
        trim: true, message: '网关证书指纹无效' }),
    }),
  });
}

function confirmationRequest(value) {
  const source = allowedKeys(value, ['confirmationHandle']);
  return Object.freeze({
    confirmationHandle: boundedString(source.confirmationHandle, {
      minLength: 1,
      maxLength: 64,
      trim: true,
      message: 'Gateway 确认句柄无效',
    }),
  });
}

function deletionRequest(value) {
  const source = allowedKeys(value, ['profileId']);
  const profileId = boundedString(source.profileId, {
    minLength: 1, maxLength: 64, trim: true, message: '学校配置无效',
  });
  if (!/^custom-[a-z0-9-]{1,56}$/u.test(profileId)) throw new TypeError('学校配置无效');
  return Object.freeze({ profileId });
}

function registerSchoolProfileOnboardingIpc({
  register,
  onboarding,
  getLocale,
  isCustomGatewayEnabled,
  deleteProfile,
} = {}) {
  if (typeof register !== 'function' || !onboarding ||
      typeof onboarding.list !== 'function' || typeof onboarding.probe !== 'function' ||
      typeof onboarding.confirm !== 'function' || typeof onboarding.cancel !== 'function' ||
      typeof getLocale !== 'function' || typeof isCustomGatewayEnabled !== 'function' ||
      typeof deleteProfile !== 'function') {
    throw new TypeError('school Profile onboarding IPC dependencies are incomplete');
  }
  register('list-school-profiles', () => {
    try {
      return {
        ok: true,
        profiles: onboarding.list({ locale: getLocale() }),
        customGatewayEnabled: isCustomGatewayEnabled() === true,
      };
    } catch {
      return {
        ok: false,
        code: 'PROFILE_LIST_FAILED',
        profiles: [],
        customGatewayEnabled: false,
      };
    }
  });
  register('probe-custom-gateway', (_event, value) => isCustomGatewayEnabled() === true
    ? onboarding.probe(probeRequest(value))
    : { ok: false, code: 'PROFILE_ONBOARDING_DISABLED' });
  register('confirm-custom-gateway', (_event, value) => isCustomGatewayEnabled() === true
    ? onboarding.confirm(confirmationRequest(value))
    : { ok: false, code: 'PROFILE_ONBOARDING_DISABLED' });
  register('cancel-custom-gateway', () => ({ ok: true, cancelled: onboarding.cancel() }));
  register('delete-school-profile', (_event, value) => deleteProfile(deletionRequest(value)));
}

module.exports = {
  confirmationRequest,
  deletionRequest,
  probeRequest,
  registerSchoolProfileOnboardingIpc,
};
