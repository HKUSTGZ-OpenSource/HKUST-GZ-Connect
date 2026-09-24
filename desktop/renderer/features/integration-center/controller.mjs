import { ADAPTERS, adapterView, previewView } from './model.mjs';

export function createIntegrationCenter({
  api,
  document,
  translate,
  now = Date.now,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  for (const method of [
    'listIntegrations', 'prepareIntegration', 'confirmIntegration', 'cancelIntegration',
  ]) {
    if (typeof api?.[method] !== 'function') throw new TypeError('Integration Center API is incomplete');
  }
  if (!document || typeof document.getElementById !== 'function' ||
      typeof document.createElement !== 'function' || typeof translate !== 'function') {
    throw new TypeError('Integration Center renderer environment is incomplete');
  }
  const ids = [
    'integrationList', 'integrationStatus', 'integrationError', 'integrationDialog',
    'integrationPreviewName', 'integrationPreviewSummary', 'integrationPreviewWarnings',
    'integrationDialogError', 'closeIntegrationDialog', 'cancelIntegration', 'confirmIntegration',
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
  if (Object.values(elements).some((element) => !element)) {
    throw new TypeError('Integration Center markup is incomplete');
  }
  let t = translate;
  let views = [];
  let preview = null;
  let timer = null;
  let busy = false;
  let bound = false;
  let lastTrigger = null;

  function errorMessage(code) {
    const specific = new Set([
      'INTEGRATION_ADAPTER_UNAVAILABLE', 'INTEGRATION_PROFILE_STALE',
      'INTEGRATION_AUTH_INCOMPATIBLE', 'INTEGRATION_EXPORT_CANCELLED',
      'INTEGRATION_EXPORT_TARGET_INVALID', 'INTEGRATION_EXPORT_CONFLICT',
      'INTEGRATION_TARGET_CHANGED', 'INTEGRATION_ROLLBACK_INCOMPLETE',
      'INTEGRATION_LISTENER_UNAVAILABLE',
    ]);
    return t(`integration.error.${specific.has(code) ? code : 'generic'}`);
  }
  function clearTimer() {
    if (timer !== null) clearTimeoutFn(timer);
    timer = null;
  }
  function closeDialog() {
    clearTimer();
    preview = null;
    elements.integrationDialogError.textContent = '';
    if (elements.integrationDialog.open) elements.integrationDialog.close();
    restoreTriggerFocus();
  }
  function restoreTriggerFocus() {
    if (!lastTrigger) return;
    const target = [...elements.integrationList.querySelectorAll?.('[data-integration-action]') || []]
      .find((candidate) => candidate.dataset.integrationActionAdapter === lastTrigger.adapterId &&
        candidate.dataset.integrationAction === lastTrigger.action);
    target?.focus?.({ preventScroll: true });
  }
  function button(label, action, adapterId, danger = false) {
    const value = document.createElement('button');
    value.type = 'button';
    value.className = `mini${danger ? ' danger-action' : ''}`;
    value.dataset.integrationAction = action;
    value.dataset.integrationActionAdapter = adapterId;
    value.textContent = label;
    value.disabled = busy;
    value.addEventListener('click', () => {
      lastTrigger = { adapterId, action };
      prepare(adapterId, action);
    });
    return value;
  }
  function render() {
    const rows = [];
    for (const view of views) {
      const row = document.createElement('div'); row.className = 'integration-row';
      row.dataset.integrationAdapter = view.adapterId;
      const main = document.createElement('div'); main.className = 'integration-main';
      const name = document.createElement('div'); name.className = 'integration-name';
      name.textContent = t(`integration.adapter.${view.adapterId}`);
      const description = document.createElement('div');
      description.className = 'integration-description';
      description.textContent = t(`integration.adapterDescription.${view.adapterId}`);
      const meta = document.createElement('div'); meta.className = 'integration-meta';
      const state = document.createElement('span');
      state.className = `integration-state ${view.bindingState}`;
      state.textContent = t(`integration.state.${view.compatibilityState === 'supported'
        ? view.bindingState : 'unavailable'}`);
      meta.append(state); main.append(name, description, meta);
      const actions = document.createElement('div'); actions.className = 'integration-actions';
      if (view.compatibilityState === 'supported' && view.supportedActions.includes('copy')) {
        actions.append(button(t(`integration.action.copy.${view.adapterId}`), 'copy', view.adapterId));
      }
      if (view.compatibilityState === 'supported' && view.supportedActions.includes('save')) {
        actions.append(button(t(`integration.action.save.${view.adapterId}`), 'save', view.adapterId));
      }
      row.append(main, actions); rows.push(row);
    }
    elements.integrationList.replaceChildren(...rows);
    elements.integrationStatus.textContent = rows.length ? '' : t('integration.empty');
  }
  function renderPreview() {
    if (!preview) return;
    elements.integrationPreviewName.textContent = t(`integration.adapter.${preview.adapterId}`);
    const summaries = [
      t('integration.summaryAction', { action: t(`integration.action.${preview.action}`) }),
      t('integration.summaryFiles', preview.changes),
    ];
    if (preview.byteLength) summaries.push(t('integration.summaryBytes', { bytes: preview.byteLength }));
    if (preview.ruleCount) summaries.push(t('integration.summaryRules', { rules: preview.ruleCount }));
    elements.integrationPreviewSummary.replaceChildren(...summaries.map((text) => {
      const item = document.createElement('div'); item.className = 'integration-preview-chip';
      item.textContent = text; return item;
    }));
    elements.integrationPreviewWarnings.replaceChildren(...preview.warnings.map((code) => {
      const item = document.createElement('p'); item.className = 'integration-warning';
      item.textContent = t(`integration.warning.${code}`); return item;
    }));
  }
  async function refresh() {
    const result = await api.listIntegrations();
    if (!result?.ok || !Array.isArray(result.integrations)) {
      views = [];
      elements.integrationError.textContent = errorMessage(result?.code);
      render(); return false;
    }
    const normalized = result.integrations.map(adapterView).filter(Boolean);
    views = normalized.filter((view) => ADAPTERS.has(view.adapterId));
    elements.integrationError.textContent = '';
    render(); return true;
  }
  async function prepare(adapterId, action) {
    if (busy) return;
    busy = true; render(); elements.integrationError.textContent = '';
    let result;
    try { result = await api.prepareIntegration({ adapterId, action }); }
    catch { result = { ok: false, code: 'generic' }; }
    busy = false; render();
    if (!result?.ok) {
      if (result?.code !== 'INTEGRATION_EXPORT_CANCELLED') {
        elements.integrationError.textContent = errorMessage(result?.code);
      }
      restoreTriggerFocus();
      return;
    }
    preview = previewView(result.preview, now());
    if (!preview) {
      await api.cancelIntegration().catch(() => {});
      elements.integrationError.textContent = errorMessage('generic');
      return;
    }
    renderPreview();
    elements.integrationDialog.showModal();
    timer = setTimeoutFn(() => {
      api.cancelIntegration().catch(() => {});
      closeDialog();
      elements.integrationError.textContent = errorMessage('INTEGRATION_TARGET_CHANGED');
    }, Math.max(0, preview.expiresAt - now()));
    timer?.unref?.();
  }
  async function confirm() {
    if (!preview || busy) return;
    const handle = preview.confirmationHandle;
    const action = preview.action;
    busy = true; elements.confirmIntegration.disabled = true;
    let result;
    try { result = await api.confirmIntegration({ confirmationHandle: handle }); }
    catch { result = { ok: false, code: 'generic' }; }
    busy = false; elements.confirmIntegration.disabled = false;
    if (!result?.ok) {
      const message = errorMessage(result?.code);
      closeDialog();
      elements.integrationError.textContent = message;
      return;
    }
    closeDialog();
    await refresh();
    elements.integrationStatus.textContent = t(`integration.success.${action}`);
  }
  async function cancel() {
    await api.cancelIntegration().catch(() => {});
    closeDialog();
  }
  function bind() {
    if (bound) return;
    bound = true;
    elements.confirmIntegration.addEventListener('click', confirm);
    elements.cancelIntegration.addEventListener('click', cancel);
    elements.closeIntegrationDialog.addEventListener('click', cancel);
    elements.integrationDialog.addEventListener('cancel', (event) => {
      event.preventDefault(); cancel();
    });
  }
  function setTranslator(next) {
    if (typeof next !== 'function') return;
    t = next; render(); renderPreview();
  }
  function start() { bind(); render(); }
  return Object.freeze({ cancel, confirm, prepare, refresh, setTranslator, start });
}
