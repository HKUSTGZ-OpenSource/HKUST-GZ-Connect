function create({ document: doc, api, translate, getSettings, setSettings, refreshState,
  getProxyAuth, timers } = {}) {
  if (!doc || typeof doc.getElementById !== 'function' ||
      typeof doc.querySelectorAll !== 'function' ||
      typeof api?.save !== 'function' || typeof api?.copy !== 'function' ||
      [translate, getSettings, setSettings, refreshState, getProxyAuth,
        timers?.setTimeout, timers?.clearTimeout].some(value => typeof value !== 'function')) {
    throw new TypeError('Control Tower dependencies are incomplete');
  }
  const $ = id => doc.getElementById(id);
  const fields = ['towerPort', 'strictProxyAuth', 'autoReconnect', 'maxAttempts',
    'startAtLogin', 'autoConnect'];
  const copyButtons = [...doc.querySelectorAll('[data-copy]')];
  for (const element of [...fields.map($), $('towerSave'), ...copyButtons]) {
    if (!element || typeof element.addEventListener !== 'function' ||
        typeof element.removeEventListener !== 'function') {
      throw new TypeError('Control Tower controls are unavailable');
    }
  }

  let started = false;
  let disposed = false;
  let dirty = false;
  let saving = false;
  let flashTimer = null;
  const copyTimers = new Set();
  const unlisten = [];

  function listen(element, type, handler) {
    element.addEventListener(type, handler);
    unlisten.push(() => element.removeEventListener(type, handler));
  }

  function setDirty(value) {
    if (disposed) return;
    dirty = value === true;
    if (dirty) $('towerActions').hidden = false;
    else if (!$('towerSaved').textContent) $('towerActions').hidden = true;
  }

  function render(settings = {}, { preserve = false } = {}) {
    if (disposed) return false;
    $('socksEndpoint').textContent = '127.0.0.1:' + (Number(settings.port) || 1080);
    if (!preserve || !dirty) {
      $('towerPort').value = settings.port || 1080;
      $('strictProxyAuth').checked = settings.strictProxyAuth === true;
      $('autoReconnect').checked = settings.autoReconnect !== false;
      $('maxAttempts').value = settings.maxAttempts ?? 3;
      $('startAtLogin').checked = !!settings.startAtLogin;
      $('autoConnect').checked = settings.autoConnect !== false;
      getProxyAuth()?.render();
      if (!dirty && !$('towerSaved').textContent) $('towerActions').hidden = true;
    }
    return true;
  }

  function flash(msg, isError = false) {
    if (disposed) return false;
    if (flashTimer !== null) timers.clearTimeout(flashTimer);
    $('towerActions').hidden = false;
    $('towerSaved').textContent = msg || translate('tower.saved');
    $('towerSaved').classList.toggle('error', isError);
    flashTimer = timers.setTimeout(() => {
      flashTimer = null;
      if (disposed) return;
      $('towerSaved').textContent = '';
      $('towerSaved').classList.remove('error');
      if (!dirty && !saving) $('towerActions').hidden = true;
    }, isError ? 3500 : 1800);
    return true;
  }

  async function save() {
    if (disposed) return { ok: false, stale: true };
    if (saving || getProxyAuth()?.isBusy()) return { ok: false, busy: true };
    const port = Number($('towerPort').value);
    const maxAttempts = Number($('maxAttempts').value);
    if (!Number.isInteger(port) || port < 1025 || port > 65535) {
      flash(translate('tower.portInvalid'), true);
      $('towerPort').focus();
      return { ok: false };
    }
    if (!Number.isInteger(maxAttempts) || maxAttempts < 0 || maxAttempts > 10) {
      flash(translate('tower.attemptsInvalid'), true);
      $('maxAttempts').focus();
      return { ok: false };
    }

    saving = true;
    $('towerSave').disabled = true;
    $('strictProxyAuth').disabled = true;
    try {
      const result = await api.save({
        port,
        strictProxyAuth: $('strictProxyAuth').checked,
        autoReconnect: $('autoReconnect').checked,
        maxAttempts,
        startAtLogin: $('startAtLogin').checked,
        autoConnect: $('autoConnect').checked,
      });
      if (disposed) return { ok: false, stale: true };
      if (!result?.ok) {
        flash(result?.error || translate('tower.saveFailed'), true);
        return result || { ok: false };
      }
      setSettings(result.settings || getSettings());
      setDirty(false);
      await refreshState();
      return disposed ? { ok: false, stale: true } : result;
    } catch (error) {
      if (!disposed) flash(error?.message || translate('tower.saveFailed'), true);
      return { ok: false };
    } finally {
      saving = false;
      if (!disposed) {
        $('towerSave').disabled = false;
        $('strictProxyAuth').disabled = false;
        getProxyAuth()?.render();
      }
    }
  }

  async function apply() {
    const result = await save();
    if (disposed || !result?.ok) return result;
    const reconnectWarning = result.outcome === 'saved_reconnect_failed'
      ? `${translate('tower.saved')} · ${result.warning || ''}`.replace(/\s*·\s*$/u, '')
      : null;
    flash(reconnectWarning || result.warning ||
      (result.reconnected ? translate('tower.savedApplied') : translate('tower.saved')),
    !!result.warning);
    return result;
  }

  async function copySocks(button) {
    if (disposed) return;
    try {
      if (button.dataset.copy !== 'socks') throw new Error(translate('tower.copyFailed'));
      const text = '127.0.0.1:' + (Number(getSettings().port) || 1080);
      await api.copy(text);
      if (disposed) return;
      const old = button.textContent;
      button.textContent = translate('tower.copied');
      button.classList.add('done');
      const timer = timers.setTimeout(() => {
        copyTimers.delete(timer);
        if (disposed) return;
        button.textContent = old;
        button.classList.remove('done');
      }, 1200);
      copyTimers.add(timer);
    } catch (error) {
      flash(error?.message || translate('tower.copyFailed'), true);
    }
  }

  function start() {
    if (started || disposed) return false;
    started = true;
    listen($('towerSave'), 'click', () => { void apply(); });
    for (const id of fields) {
      listen($(id), 'input', () => setDirty(true));
      listen($(id), 'change', () => setDirty(true));
    }
    for (const button of copyButtons) listen(button, 'click', () => copySocks(button));
    return true;
  }

  function dispose() {
    if (disposed) return false;
    disposed = true;
    started = false;
    const errors = [];
    const attempt = operation => { try { operation(); } catch (error) { errors.push(error); } };
    if (flashTimer !== null) attempt(() => timers.clearTimeout(flashTimer));
    flashTimer = null;
    for (const timer of copyTimers) attempt(() => timers.clearTimeout(timer));
    copyTimers.clear();
    for (const remove of unlisten.splice(0).reverse()) attempt(remove);
    if (errors.length) throw new AggregateError(errors, 'Control Tower cleanup failed');
    return true;
  }

  return Object.freeze({ apply, dispose, flash, isDirty: () => dirty,
    isSaving: () => saving, render, start });
}

export { create };
