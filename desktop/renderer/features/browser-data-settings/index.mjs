function create({ api, document, translate, onClearState = () => {} } = {}) {
  if (typeof api?.clearBrowserData !== 'function' ||
      typeof document?.getElementById !== 'function' || typeof translate !== 'function' ||
      typeof onClearState !== 'function' || typeof document.addEventListener !== 'function' ||
      typeof document.removeEventListener !== 'function') {
    throw new TypeError('browser data settings capabilities are incomplete');
  }
  const button = document.getElementById('clearBrowserData');
  const status = document.getElementById('browserDataStatus');
  if (!button || !status || typeof button.addEventListener !== 'function' ||
      typeof button.removeEventListener !== 'function') {
    throw new TypeError('browser data settings markup is incomplete');
  }
  let armed = false, busy = false, started = false, disposed = false;
  const removals = [];

  function reset({ clearStatus = true } = {}) {
    if (disposed) return;
    armed = false;
    button.disabled = false;
    button.textContent = translate('settings.clearBrowserData');
    if (clearStatus) status.textContent = '';
  }

  async function onClick() {
    if (!started || disposed || busy) return;
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
      if (disposed) return;
      const result = await api.clearBrowserData();
      // Main owns the submitted clear; retirement only fences presentation.
      if (disposed) return;
      status.textContent = result?.ok ? translate('settings.browserDataCleared')
        : (result?.error || translate('settings.browserDataClearFailed'));
    } catch {
      if (!disposed) status.textContent = translate('settings.browserDataClearFailed');
    } finally {
      if (!disposed) {
        try { onClearState(false); }
        catch { status.textContent = translate('settings.browserDataClearFailed'); }
        busy = false;
        reset({ clearStatus: false });
      }
    }
  }

  function onLocaleChanged() {
    if (!disposed && !busy) reset();
  }

  function listen(target, type, handler) {
    target.addEventListener(type, handler);
    removals.push(() => target.removeEventListener(type, handler));
  }

  function start() {
    if (started || disposed) return false;
    started = true;
    listen(button, 'click', onClick);
    listen(document, 'app-locale-changed', onLocaleChanged);
    reset();
    return true;
  }

  function dispose() {
    if (disposed) return false;
    disposed = true;
    started = false;
    const errors = [];
    for (const remove of removals.splice(0).reverse()) {
      try { remove(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'browser data settings cleanup failed');
    return true;
  }

  return Object.freeze({ start, dispose, reset });
}

export { create };
