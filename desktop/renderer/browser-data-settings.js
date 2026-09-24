(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.browserDataSettings = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  function start({ api, document, translate, onClearState = () => {} } = {}) {
    if (typeof api?.clearBrowserData !== 'function' ||
        typeof document?.getElementById !== 'function' || typeof translate !== 'function') {
      throw new TypeError('browser data settings dependencies are incomplete');
    }
    const button = document.getElementById('clearBrowserData');
    const status = document.getElementById('browserDataStatus');
    if (!button || !status) throw new TypeError('browser data settings markup is incomplete');
    let armed = false;
    let busy = false;
    const reset = ({ clearStatus = true } = {}) => {
      armed = false;
      button.disabled = false;
      button.textContent = translate('settings.clearBrowserData');
      if (clearStatus) status.textContent = '';
    };
    button.addEventListener('click', async () => {
      if (busy) return;
      if (!armed) {
        armed = true;
        button.textContent = translate('settings.confirmClearBrowserData');
        status.textContent = translate('settings.clearBrowserDataConfirmHint');
        return;
      }
      busy = true;
      button.disabled = true;
      status.textContent = translate('settings.clearingBrowserData');
      try {
        onClearState(true);
        const result = await api.clearBrowserData();
        status.textContent = result?.ok
          ? translate('settings.browserDataCleared')
          : (result?.error || translate('settings.browserDataClearFailed'));
      } catch {
        status.textContent = translate('settings.browserDataClearFailed');
      } finally {
        try { onClearState(false); }
        catch { status.textContent = translate('settings.browserDataClearFailed'); }
        busy = false;
        reset({ clearStatus: false });
      }
    });
    document.addEventListener?.('app-locale-changed', () => { if (!busy) reset(); });
    reset();
    return Object.freeze({ reset });
  }

  return { start };
});
