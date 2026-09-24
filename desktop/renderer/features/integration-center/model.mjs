export const ADAPTERS = new Set([
  'clash_mihomo_yaml', 'vscode_remote_ssh',
]);
const ACTIONS = new Set(['copy', 'save']);
const STATES = new Set(['not-installed', 'current', 'stale', 'unavailable']);
const COMPATIBILITY = new Set(['supported', 'unsupported', 'unavailable', 'conflict']);
const HANDLES = /^export-[a-f0-9]{32}$/u;

export function adapterView(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.schemaVersion !== 1 || !ADAPTERS.has(value.adapterId) ||
      !COMPATIBILITY.has(value.compatibilityState) || !STATES.has(value.bindingState) ||
      !Array.isArray(value.supportedActions) ||
      value.supportedActions.some((action) => !ACTIONS.has(action) && action !== 'preview') ||
      (value.updatedAt !== null && (!Number.isSafeInteger(value.updatedAt) || value.updatedAt <= 0))) {
    return null;
  }
  return Object.freeze({
    adapterId: value.adapterId,
    compatibilityState: value.compatibilityState,
    bindingState: value.bindingState,
    updatedAt: value.updatedAt,
    supportedActions: Object.freeze(value.supportedActions.filter((action) => ACTIONS.has(action))),
  });
}

export function previewView(value, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1 ||
      !ADAPTERS.has(value.adapterId) || !ACTIONS.has(value.action) ||
      typeof value.confirmationHandle !== 'string' || !HANDLES.test(value.confirmationHandle) ||
      !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now ||
      typeof value.containsLocalProxyCredential !== 'boolean') return null;
  const changes = value.changes && typeof value.changes === 'object'
    ? Object.fromEntries(['create', 'replace', 'remove', 'unchanged'].map((key) => [
      key, Number.isSafeInteger(value.changes[key]) && value.changes[key] >= 0
        ? value.changes[key] : 0,
    ]))
    : {
        create: value.targetChange === 'create' ? 1 : 0,
        replace: value.targetChange === 'replace' ? 1 : 0,
        remove: 0,
        unchanged: value.targetChange === 'unchanged' ? 1 : 0,
      };
  const warnings = Array.isArray(value.warningCodes)
    ? value.warningCodes
    : (typeof value.warningCode === 'string' ? [value.warningCode] : []);
  if (warnings.some((code) => !/^INTEGRATION_[A-Z_]+$/u.test(code))) return null;
  return Object.freeze({
    confirmationHandle: value.confirmationHandle,
    adapterId: value.adapterId,
    action: value.action,
    expiresAt: value.expiresAt,
    changes: Object.freeze(changes),
    byteLength: Number.isSafeInteger(value.byteLength) && value.byteLength >= 0
      ? value.byteLength : 0,
    ruleCount: Number.isSafeInteger(value.ruleCount) && value.ruleCount >= 0
      ? value.ruleCount : 0,
    containsLocalProxyCredential: value.containsLocalProxyCredential,
    warnings: Object.freeze([...warnings]),
  });
}
