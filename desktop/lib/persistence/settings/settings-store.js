'use strict';

const fs = require('fs');
const net = require('node:net');
const path = require('path');
const { ensureOwnerOnly, readPrivateFileBounded } = require('../../platform/storage/private-file');
const { DEFAULT_ROUTE_DOMAINS, normalizeRouteDomains } = require('../../routing/pac/pac');
const { normalizeCustomResources } = require('../../resources/schema/campus-resource-contract');

const BACKUP_SUFFIX = '.bak';
// Version 3 makes strict authentication the new-install default. Version 2
// used compatibility by default and is preserved for existing installations;
// version 1 briefly auto-enabled an incompatible strict mode and is repaired.
const PROXY_SECURITY_VERSION = 3;
const COMPATIBILITY_DEFAULT_PROXY_SECURITY_VERSION = 2;
const BROKEN_STRICT_MIGRATION_VERSION = 1;
const MAX_SETTINGS_DOCUMENT_BYTES = 512 * 1024;
const MAX_HIDDEN_BUILTIN_RESOURCES = 64;
const DEFAULT_BROWSER_NEW_TAB_URL = 'https://www.bing.com/';
const MAX_BROWSER_NEW_TAB_URL_LENGTH = 2048;
let temporarySequence = 0;

const DEFAULTS = Object.freeze({
  port: 1080,
  username: '',
  autoReconnect: true,
  maxAttempts: 3,
  startAtLogin: false,
  autoConnect: true,
  // Compatibility is the default; explicit versioned user choices survive.
  strictProxyAuth: false,
  proxySecurityVersion: PROXY_SECURITY_VERSION,
  proxyAuthMigrationPending: false,
  closeAction: 'ask',
  language: 'auto',
  browserNewTabUrl: DEFAULT_BROWSER_NEW_TAB_URL,
  underlaySourceAddress: '',
  updateCheckedAt: 0,
  routeDomains: DEFAULT_ROUTE_DOMAINS,
  customResources: [],
  hiddenBuiltinResourceIds: [],
});

function normalizeHiddenBuiltinResourceIds(input) {
  const result = [];
  for (const value of Array.isArray(input) ? input.slice(0, MAX_HIDDEN_BUILTIN_RESOURCES) : []) {
    const id = String(value || '').trim();
    if (/^[a-z0-9-]{1,40}$/u.test(id) && !result.includes(id)) result.push(id);
  }
  return result;
}

function isValidPort(port) {
  return Number.isInteger(port) && port >= 1025 && port <= 65535;
}

function parseBrowserNewTabUrl(value) {
  const input = typeof value === 'string' ? value.trim() : '';
  if (!input) return DEFAULT_BROWSER_NEW_TAB_URL;
  if (input === 'about:blank') return input;
  if (input.length > MAX_BROWSER_NEW_TAB_URL_LENGTH) {
    throw new TypeError('新标签页地址过长');
  }
  let parsed;
  try { parsed = new URL(/^[a-z][a-z0-9+.-]*:/iu.test(input) ? input : `https://${input}`); }
  catch { throw new TypeError('新标签页地址无效'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname ||
      parsed.username || parsed.password) {
    throw new TypeError('新标签页地址必须是 HTTP(S) 网页或 about:blank');
  }
  return parsed.href;
}

function normalizeBrowserNewTabUrl(value) {
  try { return parseBrowserNewTabUrl(value); }
  catch { return DEFAULT_BROWSER_NEW_TAB_URL; }
}

function normalizeStrictProxyAuth(saved = {}) {
  const version = Number(saved.proxySecurityVersion);
  if (version === PROXY_SECURITY_VERSION) return saved.strictProxyAuth === true;
  if (version === COMPATIBILITY_DEFAULT_PROXY_SECURITY_VERSION) {
    // Version 2 shipped compatibility as the default and then persisted the
    // normalized value on any settings save. Preserve that installed-base
    // choice instead of silently breaking existing Clash/SSH clients.
    return saved.strictProxyAuth === true;
  }
  if (version === BROKEN_STRICT_MIGRATION_VERSION) {
    // Version 1 could mark users strict without a compatible external-client
    // credential contract. Keep repairing that known automatic opt-in.
    return false;
  }
  // Missing or unknown versions follow the current installation default.
  return DEFAULTS.strictProxyAuth;
}

function normalizeProxyAuthMigrationPending(saved = {}) {
  const version = Number(saved.proxySecurityVersion);
  if (version === COMPATIBILITY_DEFAULT_PROXY_SECURITY_VERSION) {
    // Version 2 persisted compatibility as its default. Preserve service until
    // the user explicitly chooses the secure mode or acknowledges compatibility,
    // but do not let that inherited downgrade remain invisible indefinitely.
    return saved.strictProxyAuth !== true;
  }
  if (version === PROXY_SECURITY_VERSION) {
    return saved.proxyAuthMigrationPending === true && saved.strictProxyAuth !== true;
  }
  return false;
}

function normalizeSettings(saved = {}, { defaultRouteDomains = DEFAULT_ROUTE_DOMAINS } = {}) {
  const port = Number(saved.port);
  const maxAttempts = Number(saved.maxAttempts);
  return {
    username: typeof saved.username === 'string' ? saved.username : DEFAULTS.username,
    port: isValidPort(port) ? port : DEFAULTS.port,
    autoReconnect: saved.autoReconnect !== false,
    maxAttempts: Number.isInteger(maxAttempts)
      ? Math.max(0, Math.min(10, maxAttempts))
      : DEFAULTS.maxAttempts,
    startAtLogin: saved.startAtLogin === true,
    autoConnect: saved.autoConnect !== false,
    strictProxyAuth: normalizeStrictProxyAuth(saved),
    proxySecurityVersion: PROXY_SECURITY_VERSION,
    proxyAuthMigrationPending: normalizeProxyAuthMigrationPending(saved),
    closeAction: ['ask', 'minimize', 'quit'].includes(saved.closeAction)
      ? saved.closeAction
      : DEFAULTS.closeAction,
    language: ['auto', 'zh', 'en'].includes(saved.language)
      ? saved.language
      : DEFAULTS.language,
    browserNewTabUrl: normalizeBrowserNewTabUrl(saved.browserNewTabUrl),
    underlaySourceAddress: typeof saved.underlaySourceAddress === 'string' &&
      net.isIP(saved.underlaySourceAddress) ? saved.underlaySourceAddress : '',
    updateCheckedAt: Number.isFinite(Number(saved.updateCheckedAt)) && Number(saved.updateCheckedAt) > 0
      ? Number(saved.updateCheckedAt)
      : DEFAULTS.updateCheckedAt,
    routeDomains: normalizeRouteDomains(saved.routeDomains, defaultRouteDomains),
    customResources: normalizeCustomResources(saved.customResources),
    hiddenBuiltinResourceIds: normalizeHiddenBuiltinResourceIds(saved.hiddenBuiltinResourceIds),
  };
}

function parseSettingsFile(file, options) {
  let bytes;
  try {
    bytes = readPrivateFileBounded(file, {
      maxBytes: MAX_SETTINGS_DOCUMENT_BYTES,
    }).data;
  } catch (error) {
    if (error.privateFileInvalid) error.settingsDocumentCorrupt = true;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) error.settingsDocumentCorrupt = true;
    throw error;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const error = new Error('invalid settings document');
    error.settingsDocumentCorrupt = true;
    throw error;
  }
  return normalizeSettings(parsed, options);
}

function temporaryPathFor(file, label = 'tmp') {
  const directory = path.dirname(file);
  return path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${Date.now()}.${temporarySequence++}.${label}`,
  );
}

function writePrivateJsonAtomic(file, value) {
  const directory = path.dirname(file);
  const temporary = temporaryPathFor(file);
  let descriptor = null;
  let commitApplied = false;
  fs.mkdirSync(directory, { recursive: true });
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2), 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, file);
    commitApplied = true;
    ensureOwnerOnly(file);
    fsyncDirectory(directory);
  } catch (error) {
    // A same-directory rename is the commit point. Callers that maintain
    // derived PAC/session state must know that a directory-fsync error happened
    // after the new JSON became visible so they can roll it back explicitly.
    if (commitApplied && error && typeof error === 'object') error.commitApplied = true;
    throw error;
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    } catch {}
  }
}

function fsyncDirectory(directory) {
  let descriptor = null;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch (error) {
    // Some Windows filesystems do not allow opening directories. The file
    // itself is still fsynced before rename; directory fsync is best-effort.
    if (process.platform !== 'win32') throw error;
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}

function removeFileDurably(file) {
  try {
    fs.unlinkSync(file);
    fsyncDirectory(path.dirname(file));
    return true;
  } catch (error) {
    return error?.code === 'ENOENT';
  }
}

function isolateCorruptSettings(file) {
  try {
    if (!fs.statSync(file).isFile()) return '';
  } catch {
    return '';
  }
  const base = `${file}.corrupt-${Date.now()}`;
  for (let index = 0; index < 100; index++) {
    const destination = index ? `${base}-${index}` : base;
    if (fs.existsSync(destination)) continue;
    try {
      fs.renameSync(file, destination);
      ensureOwnerOnly(destination);
      return destination;
    } catch {
      return '';
    }
  }
  return '';
}

function notifyRecovery(callback, detail) {
  if (typeof callback !== 'function') return;
  try { callback(detail); } catch {}
}

function loadSettings(file, { onRecovery, defaultRouteDomains = DEFAULT_ROUTE_DOMAINS } = {}) {
  const normalizationOptions = { defaultRouteDomains };
  const primaryExisted = fs.existsSync(file);
  const backupFile = `${file}${BACKUP_SUFFIX}`;
  const backupExisted = fs.existsSync(backupFile);
  let quarantined = '';
  let primaryError;
  try {
    return parseSettingsFile(file, normalizationOptions);
  } catch (error) {
    primaryError = error;
    const primaryIsRecoverable = error?.code === 'ENOENT' ||
      error?.settingsDocumentCorrupt === true;
    // A backup is only a recovery source when the primary is provably absent
    // or structurally invalid. A transient primary EIO/EACCES must not let an
    // older (or merely same-state-at-last-save) backup overwrite the still
    // authoritative primary.
    if (!primaryIsRecoverable) throw error;
    if (error.settingsDocumentCorrupt && fs.existsSync(file)) {
      quarantined = isolateCorruptSettings(file);
    }
    try {
      // parseSettingsFile already migrates a genuinely legacy document (one
      // without proxySecurityVersion) to strict authentication. Preserve an
      // explicit current-version compatibility choice, though: changing it
      // during a runtime recovery would make UI/PAC say HTTP-auth while the
      // already-running engine still exposes the selected SOCKS contract.
      const restored = parseSettingsFile(backupFile, normalizationOptions);
      try { writePrivateJsonAtomic(file, restored); } catch {}
      try { writePrivateJsonAtomic(backupFile, restored); } catch {}
      notifyRecovery(onRecovery, { kind: 'restored', quarantined: Boolean(quarantined) });
      return restored;
    } catch (backupError) {
      const backupIsKnownEmpty = backupError?.code === 'ENOENT' ||
        backupError?.settingsDocumentCorrupt === true;
      // A transient read/permission failure is not evidence that settings are
      // empty. Propagate it so no caller can save defaults over an unread but
      // authoritative account, port, routing policy, or shortcut document.
      if (!backupIsKnownEmpty) throw backupError;
      if (primaryExisted || backupExisted) {
        notifyRecovery(onRecovery, { kind: 'defaults', quarantined: Boolean(quarantined) });
      }
      return normalizeSettings(DEFAULTS, normalizationOptions);
    }
  }
}

function saveSettings(file, settings, { defaultRouteDomains = DEFAULT_ROUTE_DOMAINS } = {}) {
  const normalized = normalizeSettings(settings, { defaultRouteDomains });
  const backupFile = `${file}${BACKUP_SUFFIX}`;
  // Never leave a historical security state available for recovery. The
  // primary rename is still atomic; removing the old backup first means a
  // backup failure can at worst lose recovery metadata, not revive an older
  // proxy-auth or routing decision.
  if (!removeFileDurably(backupFile)) throw new Error('could not retire stale settings backup');
  writePrivateJsonAtomic(file, normalized);
  // The backup represents the same committed state, not the previous state.
  // Failure does not invalidate the primary and the next successful save will
  // recreate it.
  try { writePrivateJsonAtomic(backupFile, normalized); } catch {}
  return normalized;
}

module.exports = {
  BACKUP_SUFFIX,
  DEFAULT_BROWSER_NEW_TAB_URL,
  DEFAULTS,
  MAX_SETTINGS_DOCUMENT_BYTES,
  PROXY_SECURITY_VERSION,
  isolateCorruptSettings,
  isValidPort,
  loadSettings,
  normalizeBrowserNewTabUrl,
  normalizeSettings,
  normalizeProxyAuthMigrationPending,
  normalizeHiddenBuiltinResourceIds,
  normalizeStrictProxyAuth,
  parseBrowserNewTabUrl,
  saveSettings,
};
