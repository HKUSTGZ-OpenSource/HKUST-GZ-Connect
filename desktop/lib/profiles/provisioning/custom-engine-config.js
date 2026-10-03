'use strict';

const crypto = require('node:crypto');
const {
  PROTOCOL_FAMILY,
  validateSchoolProfileDocument,
} = require('../schema/school-profile-schema');

const CUSTOM_ENGINE_CONFIG_VERSION = 1;
const MAX_CUSTOM_ENGINE_CONFIG_BYTES = 64 * 1024;

function createCustomEngineConfigDocument(rawProfile) {
  const profile = validateSchoolProfileDocument(rawProfile);
  if (profile.evidenceClass !== 'custom-local' ||
      profile.gateway.protocolFamily !== PROTOCOL_FAMILY ||
      profile.gateway.engineConfigRef !== null ||
      profile.policy.reviewedPrivateGatewayAllowed ||
      profile.policy.reviewedDnsFallback.length) {
    throw new TypeError('custom Engine config requires a minimal custom-local Profile');
  }
  return Object.freeze({
    schema_version: CUSTOM_ENGINE_CONFIG_VERSION,
    base_url: profile.gateway.origin.origin,
    ...(profile.gateway.tlsLeafSha256 == null ? {} : {
      gateway_tls: Object.freeze({ origin: profile.gateway.origin.origin, leaf_sha256: profile.gateway.tlsLeafSha256 }),
    }),
    endpoints: Object.freeze({
      discovery: '/por/login_auth.csp?apiversion=1',
      logout: '/por/logout.csp?apiversion=1',
      password_config: '/public/psw_config?apiversion=1',
      password_login: '/por/login_psw.csp?anti_replay=1&encrypt=1&type=csp',
      resource_list: '/por/rclist.csp?rnd=1234',
      session_config: '/por/conf.csp',
    }),
    gateway_connector: Object.freeze({ reviewed_private_gateway_allowed: false }),
    proxy: Object.freeze({
      allow_system_dns_fallback: false,
      vpn_dns_servers: Object.freeze([]),
    }),
    target: 'custom-local',
    timeout_seconds: 15,
    tunnel: Object.freeze({ mtu: 1400 }),
    user_agent: 'EasyConnect_windows',
  });
}

function serializeCustomEngineConfig(rawProfile) {
  return Buffer.from(`${JSON.stringify(createCustomEngineConfigDocument(rawProfile), null, 2)}\n`, 'utf8');
}

function verifyCustomEngineConfigFile({
  filePath,
  profile,
  profileStorageEffects,
  fileSystem,
  platform,
  verifyWindowsAcl,
} = {}) {
  if (typeof filePath !== 'string' || !filePath ||
      typeof profileStorageEffects?.assertCompatible !== 'function' ||
      typeof profileStorageEffects.readPrivateFileBounded !== 'function') {
    throw new TypeError('custom Engine config verification inputs are invalid');
  }
  profileStorageEffects.assertCompatible({ fileSystem, platform, verifyWindowsAcl });
  const storagePlatform = profileStorageEffects.platform;
  const windowsAcl = profileStorageEffects.windowsAcl;
  if (!['darwin', 'linux', 'win32'].includes(storagePlatform) ||
      (storagePlatform === 'win32' && typeof windowsAcl?.verify !== 'function')) {
    throw new TypeError('custom Engine config storage effects are invalid');
  }
  if (storagePlatform === 'win32' && !windowsAcl.verify(filePath)) {
    throw new Error('custom Engine config ACL is invalid');
  }
  const { data } = profileStorageEffects.readPrivateFileBounded(filePath, {
    maxBytes: MAX_CUSTOM_ENGINE_CONFIG_BYTES,
    minBytes: 2,
  });
  try {
    let parsed;
    try { parsed = JSON.parse(data.toString('utf8')); }
    catch (error) { throw new Error('custom Engine config is invalid JSON', { cause: error }); }
    const expected = createCustomEngineConfigDocument(profile);
    if (JSON.stringify(parsed) !== JSON.stringify(expected)) {
      throw new Error('custom Engine config does not match its compiled Profile binding');
    }
    return Object.freeze({
      path: filePath,
      sha256: crypto.createHash('sha256').update(data).digest('hex'),
      gatewayOrigin: expected.base_url,
      protocolFamily: PROTOCOL_FAMILY,
    });
  } finally {
    data.fill(0);
  }
}

module.exports = {
  CUSTOM_ENGINE_CONFIG_VERSION,
  MAX_CUSTOM_ENGINE_CONFIG_BYTES,
  createCustomEngineConfigDocument,
  serializeCustomEngineConfig,
  verifyCustomEngineConfigFile,
};
