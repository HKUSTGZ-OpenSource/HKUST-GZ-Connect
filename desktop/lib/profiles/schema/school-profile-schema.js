'use strict';

const net = require('node:net');
const { domainToASCII } = require('node:url');
const { validateBuiltinResourcesRef } = require('../../resources/schema/campus-resource-contract');

const PROFILE_SCHEMA_VERSION = 1;
const CAMPUS_ACCOUNT_SCHEMA_VERSION = 1;
const WORKSPACE_SCOPE_SCHEMA_VERSION = 1;
const CAPABILITY_SNAPSHOT_VERSION = 1;
const PROTOCOL_FAMILY = 'easyconnect-password-modern-l3-v1';
const PROTOCOL_FAMILIES = Object.freeze([PROTOCOL_FAMILY]);
const EVIDENCE_CLASSES = Object.freeze(['builtin-reviewed', 'custom-local']);
const CAPABILITY_STATES = Object.freeze(['supported', 'unsupported', 'unavailable']);
const ACCOUNT_ROLES = Object.freeze(['primary']);
const ACCOUNT_STATES = Object.freeze(['enabled', 'disabled', 'deleting', 'tombstoned']);
const MAX_PROFILE_ID_LENGTH = 64;
const MAX_DISPLAY_NAME_LENGTH = 96;
const MAX_SHORT_NAME_LENGTH = 40;
const MAX_DOMAIN_COUNT = 64;
const MAX_HEALTH_TARGETS = 8;
const MAX_CAPABILITIES = 64;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const SAFE_ASSET_KEY = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
const SAFE_CAPABILITY = /^[a-z][a-z0-9_.:-]{0,95}$/u;
const SAFE_OPAQUE_KEY = /^[a-z0-9][a-z0-9_-]{20,62}[a-z0-9]$/u;
const SAFE_HANDLE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{14,94}[a-zA-Z0-9]$/u;

function plainObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${name} must be a plain object`);
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value)) deepFreeze(entry);
  return value;
}

function exactKeys(value, allowed, required, name) {
  const object = plainObject(value, name);
  const keys = Object.keys(object);
  if (keys.some((key) => !allowed.includes(key)) ||
      required.some((key) => !Object.hasOwn(object, key))) {
    throw new TypeError(`${name} has an invalid schema`);
  }
  return object;
}

function boundedText(value, maxLength, name, { optional = false } = {}) {
  if (optional && value == null) return null;
  if (typeof value !== 'string') throw new TypeError(`${name} must be text`);
  const result = value.trim();
  if (!result || result.length > maxLength || /[\u0000-\u001f\u007f<>]/u.test(result)) {
    throw new TypeError(`${name} has an invalid value`);
  }
  return result;
}

function positiveRevision(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function boundedCount(value, name) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
    throw new TypeError(`${name} must be a bounded count`);
  }
  return value;
}

function boundedTimestamp(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive millisecond timestamp`);
  }
  return value;
}

function opaqueKey(value, name = 'opaqueKey') {
  if (typeof value !== 'string' || !SAFE_OPAQUE_KEY.test(value)) {
    throw new TypeError(`${name} must be a bounded opaque key`);
  }
  return value;
}

function opaqueAccountHandle(value) {
  if (typeof value !== 'string' || !SAFE_HANDLE.test(value)) {
    throw new TypeError('accountHandle must be a bounded opaque handle');
  }
  return value;
}

function validateProfileId(value) {
  if (typeof value !== 'string' || value.length > MAX_PROFILE_ID_LENGTH || !SAFE_ID.test(value)) {
    throw new TypeError('profileId has an invalid value');
  }
  return value;
}

function validateProtocolFamily(value) {
  if (!PROTOCOL_FAMILIES.includes(value)) throw new TypeError('protocol family is unsupported');
  return value;
}

function normalizedDomain(value, name = 'domain') {
  if (typeof value !== 'string' || value.length > 254 || /[\s\\/?#:@*\[\]%]/u.test(value)) {
    throw new TypeError(`${name} has an invalid value`);
  }
  const candidate = value.toLowerCase().replace(/\.$/u, '');
  const ascii = domainToASCII(candidate);
  if (!ascii || ascii.length > 253 || ascii.includes('..')) {
    throw new TypeError(`${name} has an invalid value`);
  }
  const labels = ascii.split('.');
  if (labels.some((label) => !label || label.length > 63 ||
      !/^[a-z0-9-]+$/u.test(label) || label.startsWith('-') || label.endsWith('-'))) {
    throw new TypeError(`${name} has an invalid value`);
  }
  return ascii;
}

function normalizeGatewayOrigin(value) {
  if (typeof value !== 'string' || value.length > 2048 || value.includes('?') || value.includes('#')) {
    throw new TypeError('GatewayOrigin has an invalid value');
  }
  let parsed;
  try { parsed = new URL(value.trim()); } catch { throw new TypeError('GatewayOrigin is invalid'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
      parsed.pathname !== '/' || parsed.search || parsed.hash || !parsed.hostname) {
    throw new TypeError('GatewayOrigin must be an HTTPS root origin');
  }

  let hostname = parsed.hostname.toLowerCase();
  const bracketedIpv6 = hostname.startsWith('[') && hostname.endsWith(']');
  const address = bracketedIpv6 ? hostname.slice(1, -1) : hostname;
  if (net.isIP(address) === 0) {
    hostname = normalizedDomain(hostname, 'Gateway hostname');
  } else if (net.isIP(address) === 6) {
    hostname = `[${address.toLowerCase()}]`;
  } else {
    hostname = address;
  }
  const port = parsed.port ? Number(parsed.port) : 443;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError('Gateway port is invalid');
  }
  const authority = port === 443 ? hostname : `${hostname}:${port}`;
  return Object.freeze({ scheme: 'https', hostname, port, origin: `https://${authority}` });
}

function safeRelativeReference(value, name) {
  const reference = boundedText(value, 160, name);
  if (reference.startsWith('/') || reference.startsWith('.') || reference.includes('\\') ||
      reference.split('/').some((part) => !part || part === '.' || part === '..' ||
        !/^[a-zA-Z0-9._-]+$/u.test(part))) {
    throw new TypeError(`${name} must be a safe packaged reference`);
  }
  return reference;
}

function normalizeHttpsUrl(value, name) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > 2048 || value.includes('#')) {
    throw new TypeError(`${name} has an invalid value`);
  }
  let parsed;
  try { parsed = new URL(value); } catch { throw new TypeError(`${name} is invalid`); }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || parsed.hash) {
    throw new TypeError(`${name} must use HTTPS without credentials or a fragment`);
  }
  return parsed.href;
}

function normalizeDomains(value, name) {
  if (!Array.isArray(value) || value.length > MAX_DOMAIN_COUNT) {
    throw new TypeError(`${name} must be a bounded array`);
  }
  const result = [];
  for (const entry of value) {
    const domain = normalizedDomain(entry, name);
    if (result.includes(domain)) throw new TypeError(`${name} contains a duplicate`);
    result.push(domain);
  }
  return Object.freeze(result);
}

function normalizeHealthTargets(value) {
  if (!Array.isArray(value) || value.length > MAX_HEALTH_TARGETS) {
    throw new TypeError('healthTargets must be a bounded array');
  }
  return Object.freeze(value.map((entry, index) => {
    const target = exactKeys(entry, ['host', 'port'], ['host', 'port'], `healthTargets[${index}]`);
    const port = Number(target.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new TypeError('health target port is invalid');
    }
    return Object.freeze({ host: normalizedDomain(target.host, 'health target host'), port });
  }));
}

function normalizeBranding(value) {
  const branding = exactKeys(value,
    ['localizedSchoolName', 'shortName', 'bundledAssetKey', 'theme'],
    ['localizedSchoolName', 'shortName'], 'branding');
  const names = exactKeys(branding.localizedSchoolName, ['zh', 'en'], ['zh', 'en'],
    'localizedSchoolName');
  let theme = null;
  if (branding.theme != null) {
    const source = exactKeys(branding.theme, ['accent', 'surface'], [], 'branding.theme');
    theme = Object.freeze({
      accent: source.accent == null ? null : boundedText(source.accent, 16, 'theme accent'),
      surface: source.surface == null ? null : boundedText(source.surface, 16, 'theme surface'),
    });
    for (const color of [theme.accent, theme.surface].filter(Boolean)) {
      if (!/^#[0-9a-fA-F]{6}$/u.test(color)) throw new TypeError('theme color is invalid');
    }
  }
  const bundledAssetKey = branding.bundledAssetKey == null
    ? null
    : boundedText(branding.bundledAssetKey, 64, 'bundledAssetKey');
  if (bundledAssetKey != null && !SAFE_ASSET_KEY.test(bundledAssetKey)) {
    throw new TypeError('bundledAssetKey is invalid');
  }
  return Object.freeze({
    localizedSchoolName: Object.freeze({
      zh: boundedText(names.zh, MAX_DISPLAY_NAME_LENGTH, 'Chinese school name'),
      en: boundedText(names.en, MAX_DISPLAY_NAME_LENGTH, 'English school name'),
    }),
    shortName: boundedText(branding.shortName, MAX_SHORT_NAME_LENGTH, 'school short name'),
    bundledAssetKey,
    theme,
  });
}

function normalizeGateway(value) {
  const gateway = exactKeys(value, ['origin', 'protocolFamily', 'engineConfigRef', 'tlsLeafSha256'],
    ['origin', 'protocolFamily'], 'gateway');
  const pin = normalizeGatewayLeafSha256(gateway.tlsLeafSha256);
  return Object.freeze({
    origin: normalizeGatewayOrigin(gateway.origin),
    protocolFamily: validateProtocolFamily(gateway.protocolFamily),
    engineConfigRef: gateway.engineConfigRef == null
      ? null
      : safeRelativeReference(gateway.engineConfigRef, 'engineConfigRef'),
    ...(pin == null ? {} : { tlsLeafSha256: pin }),
  });
}

function normalizeGatewayLeafSha256(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^[a-fA-F0-9]{64}$/u.test(value)) {
    throw new TypeError('Gateway leaf fingerprint is invalid');
  }
  return value.toLowerCase();
}

function normalizeBrowser(value) {
  const browser = exactKeys(value,
    ['homeUrl', 'officialPortalResourceId', 'campusDomains', 'directPartnerDomains',
      'builtinResourcesRef', 'serviceDeskRef', 'healthTargets'],
    ['campusDomains', 'directPartnerDomains', 'healthTargets'], 'browser');
  const officialPortalResourceId = browser.officialPortalResourceId == null
    ? null
    : boundedText(browser.officialPortalResourceId, 40, 'officialPortalResourceId');
  if (officialPortalResourceId !== null && !SAFE_ID.test(officialPortalResourceId)) {
    throw new TypeError('officialPortalResourceId is invalid');
  }
  return Object.freeze({
    homeUrl: normalizeHttpsUrl(browser.homeUrl, 'homeUrl'),
    officialPortalResourceId,
    campusDomains: normalizeDomains(browser.campusDomains, 'campusDomains'),
    directPartnerDomains: normalizeDomains(browser.directPartnerDomains, 'directPartnerDomains'),
    builtinResourcesRef: browser.builtinResourcesRef == null
      ? null
      : validateBuiltinResourcesRef(browser.builtinResourcesRef),
    serviceDeskRef: browser.serviceDeskRef == null
      ? null
      : validateBuiltinResourcesRef(browser.serviceDeskRef),
    healthTargets: normalizeHealthTargets(browser.healthTargets),
  });
}

function normalizePolicy(value) {
  const policy = exactKeys(value, ['reviewedPrivateGatewayAllowed', 'reviewedDnsFallback'],
    ['reviewedPrivateGatewayAllowed', 'reviewedDnsFallback'], 'policy');
  if (typeof policy.reviewedPrivateGatewayAllowed !== 'boolean' ||
      !Array.isArray(policy.reviewedDnsFallback) || policy.reviewedDnsFallback.length > 4) {
    throw new TypeError('policy has an invalid value');
  }
  const dns = policy.reviewedDnsFallback.map((entry) => {
    if (typeof entry !== 'string' || net.isIP(entry) !== 4) {
      throw new TypeError('reviewed DNS fallback must be IPv4');
    }
    return entry;
  });
  if (new Set(dns).size !== dns.length) throw new TypeError('reviewed DNS fallback is duplicated');
  return Object.freeze({
    reviewedPrivateGatewayAllowed: policy.reviewedPrivateGatewayAllowed,
    reviewedDnsFallback: Object.freeze(dns),
  });
}

function validateSchoolProfileDocument(value) {
  const profile = exactKeys(value,
    ['schemaVersion', 'profileId', 'profileRevision', 'profileCredentialBindingRevision',
      'evidenceClass', 'branding', 'gateway', 'browser', 'policy'],
    ['schemaVersion', 'profileId', 'profileRevision', 'profileCredentialBindingRevision',
      'evidenceClass', 'branding', 'gateway', 'browser', 'policy'], 'SchoolProfile');
  if (profile.schemaVersion !== PROFILE_SCHEMA_VERSION) {
    throw new TypeError('SchoolProfile schema version is unsupported');
  }
  if (!EVIDENCE_CLASSES.includes(profile.evidenceClass)) {
    throw new TypeError('SchoolProfile evidence class is invalid');
  }
  const normalized = {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    profileId: validateProfileId(profile.profileId),
    profileRevision: positiveRevision(profile.profileRevision, 'profileRevision'),
    profileCredentialBindingRevision: positiveRevision(
      profile.profileCredentialBindingRevision, 'profileCredentialBindingRevision'),
    evidenceClass: profile.evidenceClass,
    branding: normalizeBranding(profile.branding),
    gateway: normalizeGateway(profile.gateway),
    browser: normalizeBrowser(profile.browser),
    policy: normalizePolicy(profile.policy),
  };
  if (normalized.evidenceClass === 'builtin-reviewed' && !normalized.gateway.engineConfigRef) {
    throw new TypeError('reviewed profiles require a packaged engine config');
  }
  if (normalized.evidenceClass === 'builtin-reviewed' &&
      (!normalized.browser.homeUrl || !normalized.browser.builtinResourcesRef ||
       !normalized.browser.campusDomains.length ||
       normalized.browser.healthTargets.length < 2)) {
    throw new TypeError('reviewed profiles require Browser defaults and health targets');
  }
  if (normalized.evidenceClass === 'custom-local' && (
    normalized.gateway.engineConfigRef || normalized.branding.bundledAssetKey ||
    normalized.policy.reviewedPrivateGatewayAllowed || normalized.policy.reviewedDnsFallback.length ||
    normalized.browser.homeUrl || normalized.browser.officialPortalResourceId ||
    normalized.browser.campusDomains.length ||
    normalized.browser.directPartnerDomains.length || normalized.browser.builtinResourcesRef ||
    normalized.browser.serviceDeskRef ||
    normalized.browser.healthTargets.length)) {
    throw new TypeError('custom-local profiles must start with minimal unreviewed policy');
  }
  if (normalized.evidenceClass === 'builtin-reviewed' && normalized.gateway.tlsLeafSha256 != null) {
    throw new TypeError('reviewed profiles cannot acquire local Gateway trust');
  }
  return deepFreeze(normalized);
}

function createSchoolProfileView(value, { locale = 'en', compatibility = 'unknown' } = {}) {
  const profile = validateSchoolProfileDocument(value);
  if (!['zh', 'en'].includes(locale) || !['reviewed', 'candidate', 'unsupported', 'unknown'].includes(compatibility)) {
    throw new TypeError('SchoolProfile view options are invalid');
  }
  return deepFreeze({
    schemaVersion: PROFILE_SCHEMA_VERSION,
    profileId: profile.profileId,
    profileRevision: profile.profileRevision,
    evidenceClass: profile.evidenceClass,
    schoolName: profile.branding.localizedSchoolName[locale],
    shortName: profile.branding.shortName,
    bundledAssetKey: profile.branding.bundledAssetKey,
    normalizedGatewayOrigin: profile.gateway.origin.origin,
    officialPortalResourceId: profile.browser.officialPortalResourceId,
    sanitizedCompatibility: compatibility,
    unverified: profile.evidenceClass === 'custom-local',
  });
}

function validateCampusAccountDocument(value) {
  const account = exactKeys(value,
    ['schemaVersion', 'accountKey', 'accountRevision', 'accountCredentialRevision', 'role',
      'state', 'profileId', 'profileRevision', 'gatewayOrigin', 'protocolFamily', 'workspaceKey',
      'activeCredentialVersion', 'createdAt', 'updatedAt'],
    ['schemaVersion', 'accountKey', 'accountRevision', 'accountCredentialRevision', 'role',
      'state', 'profileId', 'profileRevision', 'gatewayOrigin', 'protocolFamily', 'workspaceKey',
      'createdAt', 'updatedAt'], 'CampusAccount');
  if (account.schemaVersion !== CAMPUS_ACCOUNT_SCHEMA_VERSION ||
      !ACCOUNT_ROLES.includes(account.role) || !ACCOUNT_STATES.includes(account.state)) {
    throw new TypeError('CampusAccount version, role or state is unsupported');
  }
  const createdAt = boundedTimestamp(account.createdAt, 'createdAt');
  const updatedAt = boundedTimestamp(account.updatedAt, 'updatedAt');
  if (updatedAt < createdAt) throw new TypeError('CampusAccount timestamps are inconsistent');
  return deepFreeze({
    schemaVersion: CAMPUS_ACCOUNT_SCHEMA_VERSION,
    accountKey: opaqueKey(account.accountKey, 'accountKey'),
    accountRevision: positiveRevision(account.accountRevision, 'accountRevision'),
    accountCredentialRevision: positiveRevision(
      account.accountCredentialRevision,
      'accountCredentialRevision',
    ),
    role: account.role,
    state: account.state,
    profileId: validateProfileId(account.profileId),
    profileRevision: positiveRevision(account.profileRevision, 'profileRevision'),
    gatewayOrigin: normalizeGatewayOrigin(account.gatewayOrigin),
    protocolFamily: validateProtocolFamily(account.protocolFamily),
    workspaceKey: opaqueKey(account.workspaceKey, 'workspaceKey'),
    activeCredentialVersion: account.activeCredentialVersion == null
      ? null
      : positiveRevision(account.activeCredentialVersion, 'activeCredentialVersion'),
    createdAt,
    updatedAt,
  });
}

function validateWorkspaceScopeDocument(value, { account = null } = {}) {
  const workspace = exactKeys(value,
    ['schemaVersion', 'profileId', 'profileRevision', 'accountKey', 'accountRevision',
      'workspaceKey', 'activeContextEpoch'],
    ['schemaVersion', 'profileId', 'profileRevision', 'accountKey', 'accountRevision',
      'workspaceKey', 'activeContextEpoch'], 'WorkspaceScope');
  if (workspace.schemaVersion !== WORKSPACE_SCOPE_SCHEMA_VERSION) {
    throw new TypeError('WorkspaceScope schema version is unsupported');
  }
  const normalized = deepFreeze({
    schemaVersion: WORKSPACE_SCOPE_SCHEMA_VERSION,
    profileId: validateProfileId(workspace.profileId),
    profileRevision: positiveRevision(workspace.profileRevision, 'profileRevision'),
    accountKey: opaqueKey(workspace.accountKey, 'accountKey'),
    accountRevision: positiveRevision(workspace.accountRevision, 'accountRevision'),
    workspaceKey: opaqueKey(workspace.workspaceKey, 'workspaceKey'),
    activeContextEpoch: positiveRevision(workspace.activeContextEpoch, 'activeContextEpoch'),
  });
  if (account != null) {
    const owner = plainObject(account, 'CampusAccount binding');
    for (const key of ['profileId', 'profileRevision', 'accountKey', 'accountRevision', 'workspaceKey']) {
      if (normalized[key] !== owner[key]) {
        throw new TypeError(`WorkspaceScope ${key} does not match its CampusAccount`);
      }
    }
  }
  return normalized;
}

function createCampusAccountView(value) {
  const source = exactKeys(value,
    ['accountHandle', 'role', 'state', 'label', 'hasCredential', 'isActive'],
    ['accountHandle', 'role', 'state', 'hasCredential', 'isActive'], 'CampusAccountView');
  if (!ACCOUNT_ROLES.includes(source.role) || !ACCOUNT_STATES.includes(source.state) ||
      typeof source.hasCredential !== 'boolean' || typeof source.isActive !== 'boolean') {
    throw new TypeError('CampusAccountView has an invalid state');
  }
  return Object.freeze({
    accountHandle: opaqueAccountHandle(source.accountHandle),
    role: source.role,
    state: source.state,
    label: source.label == null ? null : boundedText(source.label, 40, 'account label'),
    hasCredential: source.hasCredential,
    isActive: source.isActive,
  });
}

function createWorkspaceView(value) {
  const source = exactKeys(value,
    ['accountHandle', 'resourceCount', 'favoriteCount', 'recentCount'],
    ['accountHandle'], 'WorkspaceView');
  return Object.freeze({
    accountHandle: opaqueAccountHandle(source.accountHandle),
    persistentScope: true,
    resourceCount: boundedCount(source.resourceCount ?? 0, 'resourceCount'),
    favoriteCount: boundedCount(source.favoriteCount ?? 0, 'favoriteCount'),
    recentCount: boundedCount(source.recentCount ?? 0, 'recentCount'),
  });
}

function createLegacyPrimaryAccountView(value = {}) {
  const source = exactKeys(value, ['accountHandle', 'label', 'hasCredential', 'isActive'], [],
    'legacy primary account view');
  if (source.hasCredential != null && typeof source.hasCredential !== 'boolean' ||
      source.isActive != null && typeof source.isActive !== 'boolean') {
    throw new TypeError('legacy primary account state is invalid');
  }
  const view = {
    kind: 'legacy-primary',
    role: 'primary',
    state: 'legacy',
    label: source.label == null ? null : boundedText(source.label, 40, 'account label'),
    hasCredential: source.hasCredential === true,
    isActive: source.isActive !== false,
  };
  if (source.accountHandle != null) view.accountHandle = opaqueAccountHandle(source.accountHandle);
  return Object.freeze(view);
}

function createLegacyWorkspaceView(value = {}) {
  const source = exactKeys(value,
    ['accountHandle', 'resourceCount', 'favoriteCount', 'recentCount'], [],
    'legacy workspace view');
  const view = {
    kind: 'legacy-workspace',
    accountRole: 'primary',
    persistentScope: false,
    resourceCount: boundedCount(source.resourceCount ?? 0, 'resourceCount'),
    favoriteCount: boundedCount(source.favoriteCount ?? 0, 'favoriteCount'),
    recentCount: boundedCount(source.recentCount ?? 0, 'recentCount'),
  };
  if (source.accountHandle != null) view.accountHandle = opaqueAccountHandle(source.accountHandle);
  return Object.freeze(view);
}

function normalizeCapabilityLayer(value, name) {
  const layer = plainObject(value, name);
  const entries = Object.entries(layer);
  if (!entries.length || entries.length > MAX_CAPABILITIES) {
    throw new TypeError(`${name} must contain bounded capabilities`);
  }
  const result = {};
  for (const [capability, state] of entries) {
    if (!SAFE_CAPABILITY.test(capability) || !CAPABILITY_STATES.includes(state)) {
      throw new TypeError(`${name} contains an invalid capability`);
    }
    result[capability] = state;
  }
  return result;
}

function createCapabilitySnapshot(value) {
  const source = exactKeys(value,
    ['profileId', 'profileRevision', 'accountHandle', 'activeContextEpoch', 'engineGeneration',
      'compiled', 'provider', 'profile', 'ingress'],
    ['profileId', 'profileRevision', 'compiled', 'provider', 'profile', 'ingress'],
    'CapabilitySnapshot');
  const layers = {
    compiled: normalizeCapabilityLayer(source.compiled, 'compiled capabilities'),
    provider: normalizeCapabilityLayer(source.provider, 'provider capabilities'),
    profile: normalizeCapabilityLayer(source.profile, 'profile capabilities'),
    ingress: normalizeCapabilityLayer(source.ingress, 'ingress capabilities'),
  };
  const keys = Object.keys(layers.compiled).sort();
  if (['provider', 'profile', 'ingress'].some((name) => {
    const other = Object.keys(layers[name]).sort();
    return other.length !== keys.length || other.some((key, index) => key !== keys[index]);
  })) {
    throw new TypeError('CapabilitySnapshot layers must describe the same capabilities');
  }
  const effective = {};
  for (const key of keys) {
    const states = Object.values(layers).map((layer) => layer[key]);
    effective[key] = states.includes('unsupported')
      ? 'unsupported'
      : states.every((state) => state === 'supported')
        ? 'supported'
        : 'unavailable';
  }
  const accountHandle = source.accountHandle == null
    ? null
    : opaqueAccountHandle(source.accountHandle);
  return deepFreeze({
    schemaVersion: CAPABILITY_SNAPSHOT_VERSION,
    profileId: validateProfileId(source.profileId),
    profileRevision: positiveRevision(source.profileRevision, 'profileRevision'),
    accountHandle,
    activeContextEpoch: source.activeContextEpoch == null
      ? null
      : positiveRevision(source.activeContextEpoch, 'activeContextEpoch'),
    engineGeneration: source.engineGeneration == null
      ? null
      : positiveRevision(source.engineGeneration, 'engineGeneration'),
    layers,
    effective,
  });
}

module.exports = {
  normalizeGatewayLeafSha256,
  ACCOUNT_ROLES,
  ACCOUNT_STATES,
  CAMPUS_ACCOUNT_SCHEMA_VERSION,
  CAPABILITY_SNAPSHOT_VERSION,
  CAPABILITY_STATES,
  EVIDENCE_CLASSES,
  PROFILE_SCHEMA_VERSION,
  PROTOCOL_FAMILIES,
  PROTOCOL_FAMILY,
  WORKSPACE_SCOPE_SCHEMA_VERSION,
  createCampusAccountView,
  createCapabilitySnapshot,
  createLegacyPrimaryAccountView,
  createLegacyWorkspaceView,
  createSchoolProfileView,
  createWorkspaceView,
  normalizeGatewayOrigin,
  validateOpaqueKey: opaqueKey,
  validateAccountHandle: opaqueAccountHandle,
  validateProfileId,
  validateProtocolFamily,
  validateCampusAccountDocument,
  validateSchoolProfileDocument,
  validateWorkspaceScopeDocument,
};
