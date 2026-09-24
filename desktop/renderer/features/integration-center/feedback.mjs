const SPECIFIC_ERRORS = new Set([
  'INTEGRATION_ADAPTER_UNAVAILABLE', 'INTEGRATION_PROFILE_STALE',
  'INTEGRATION_AUTH_INCOMPATIBLE', 'INTEGRATION_EXPORT_CANCELLED',
  'INTEGRATION_EXPORT_TARGET_INVALID', 'INTEGRATION_EXPORT_CONFLICT',
  'INTEGRATION_TARGET_CHANGED', 'INTEGRATION_ROLLBACK_INCOMPLETE',
  'INTEGRATION_LISTENER_UNAVAILABLE',
]);

export function createFeedback({ status, error, translate }) {
  let operationError = null;
  let listError = null;
  let successAction = null;

  function render(viewCount) {
    const code = operationError || listError;
    error.textContent = code
      ? translate(`integration.error.${SPECIFIC_ERRORS.has(code) ? code : 'generic'}`) : '';
    status.textContent = successAction
      ? translate(`integration.success.${successAction}`)
      : (viewCount ? '' : translate('integration.empty'));
  }

  return Object.freeze({
    render,
    resetAction() { operationError = null; listError = null; successAction = null; },
    operation(code) { operationError = code || 'generic'; },
    list(code) { listError = code || null; },
    success(action) { successAction = action; },
    dispose() { operationError = null; listError = null; successAction = null; },
  });
}
