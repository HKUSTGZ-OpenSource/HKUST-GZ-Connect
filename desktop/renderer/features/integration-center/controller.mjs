import { ADAPTERS, adapterView, previewView, validHandle } from './model.mjs';
import { createLifetime } from './lifetime.mjs';

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
  const life = createLifetime({ setTimeoutFn, clearTimeoutFn });
  let busy = false;
  let bound = false;
  let retired = false;
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
  async function discard(value) {
    if (!validHandle(value?.confirmationHandle)) return;
    try { await api.cancelIntegration({ confirmationHandle: value.confirmationHandle }); } catch {}
  }
  function expire() {
    void cancel(); elements.integrationError.textContent = errorMessage('INTEGRATION_TARGET_CHANGED');
  }
  function closeDialog() {
    life.clearTimer();
    preview = null;
    elements.integrationPreviewName.textContent = '';
    elements.integrationPreviewSummary.replaceChildren();
    elements.integrationPreviewWarnings.replaceChildren();
    elements.integrationDialogError.textContent = '';
    if (elements.integrationDialog.open) elements.integrationDialog.close();
    restoreTriggerFocus();
  }
  function restoreTriggerFocus() {
    if (!lastTrigger || !life.alive()) return;
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
    if (!life.alive()) return false;
    const ticket = life.request(); let result;
    try { result = await api.listIntegrations(); } catch { result = { ok: false }; }
    if (!life.current(ticket)) return false;
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
    if (!life.alive() || busy || !ADAPTERS.has(adapterId) || !['copy', 'save'].includes(action) ||
        (adapterId === 'vscode_remote_ssh' && action !== 'copy')) return;
    const previous = preview, ticket = life.begin(); busy = true; void discard(previous);
    if (!life.current(ticket)) return;
    closeDialog(); render(); elements.integrationError.textContent = '';
    let result;
    try { result = await api.prepareIntegration({ adapterId, action }); }
    catch { result = { ok: false, code: 'generic' }; }
    if (!life.current(ticket)) { await discard(result?.preview); return; }
    busy = false; render();
    if (!result?.ok) {
      if (result?.code !== 'INTEGRATION_EXPORT_CANCELLED') {
        elements.integrationError.textContent = errorMessage(result?.code);
      }
      restoreTriggerFocus();
      return;
    }
    preview = previewView(result.preview, now());
    if (!preview || preview.adapterId !== adapterId || preview.action !== action) {
      preview = null; void discard(result.preview);
      elements.integrationError.textContent = errorMessage('generic');
      return;
    }
    renderPreview();
    try { elements.integrationDialog.showModal(); }
    catch { void cancel(); elements.integrationError.textContent = errorMessage('generic'); return; }
    life.schedule(expire, Math.max(0, preview.expiresAt - now()));
  }
  async function confirm() {
    if (!life.alive() || !preview || busy) return;
    if (preview.expiresAt <= now()) { void cancel(); return; }
    const ticket = life.begin(); life.schedule(expire, Math.max(0, preview.expiresAt - now()));
    const handle = preview.confirmationHandle;
    const action = preview.action;
    busy = true; elements.confirmIntegration.disabled = true;
    let result;
    try { result = await api.confirmIntegration({ confirmationHandle: handle }); }
    catch { result = { ok: false, code: 'generic' }; }
    if (!life.current(ticket)) return;
    busy = false; elements.confirmIntegration.disabled = false;
    if (!result?.ok) {
      const message = errorMessage(result?.code);
      closeDialog();
      elements.integrationError.textContent = message;
      return;
    }
    closeDialog();
    if (await refresh() && life.current(ticket)) {
      elements.integrationStatus.textContent = t(`integration.success.${action}`);
    }
  }
  async function cancel() {
    if (!life.alive()) return;
    const previous = preview; life.begin(); busy = false; elements.confirmIntegration.disabled = false;
    closeDialog(); render(); await discard(previous);
  }
  function bind() {
    if (bound) return;
    bound = true;
    life.listen(elements.integrationList, 'click', event => {
      const target = event.target.closest?.('[data-integration-action]');
      if (!target || !elements.integrationList.contains(target)) return;
      const { integrationAction: action, integrationActionAdapter: adapterId } = target.dataset;
      lastTrigger = { adapterId, action }; void prepare(adapterId, action);
    });
    life.listen(elements.confirmIntegration, 'click', confirm);
    life.listen(elements.cancelIntegration, 'click', cancel);
    life.listen(elements.closeIntegrationDialog, 'click', cancel);
    life.listen(elements.integrationDialog, 'cancel', (event) => {
      event.preventDefault(); cancel();
    });
  }
  function setTranslator(next) {
    if (!life.alive() || typeof next !== 'function') return;
    t = next; render(); renderPreview();
  }
  function start() {
    if (!life.start()) return false;
    try { bind(); render(); return life.alive(); } catch (error) { dispose(); throw error; }
  }
  function dispose() {
    if (retired) return false;
    retired = true;
    const previous = preview;
    try { life.dispose(); } finally {
      void discard(previous);
      busy = false; lastTrigger = null; closeDialog(); views = [];
      elements.integrationList.replaceChildren(); elements.confirmIntegration.disabled = false;
    }
    return true;
  }
  return Object.freeze({ cancel, confirm, prepare, refresh, setTranslator, start, dispose });
}
