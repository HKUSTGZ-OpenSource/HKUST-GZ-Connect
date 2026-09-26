function create({ document, translate, escapeHtml, checkUpdate, openExternal, timers } = {}) {
  if (!document || typeof document.getElementById !== 'function' ||
      typeof translate !== 'function' || typeof escapeHtml !== 'function' ||
      typeof checkUpdate !== 'function' || typeof openExternal !== 'function' ||
      !timers || typeof timers.setTimeout !== 'function' ||
      typeof timers.clearTimeout !== 'function') {
    throw new TypeError('update notice dependencies are incomplete');
  }
  const hint = document.getElementById('updateHint');
  const checkButton = document.getElementById('checkUpdateBtn');
  if (!hint || typeof hint.addEventListener !== 'function' ||
      typeof hint.removeEventListener !== 'function' || !checkButton ||
      typeof checkButton.addEventListener !== 'function' ||
      typeof checkButton.removeEventListener !== 'function') {
    throw new TypeError('update notice elements are unavailable');
  }

  const unlisten = [];
  let started = false;
  let disposed = false;
  let updateHintTimer = null;
  let updateDownloadUrl = '';

  function listen(target, handler) {
    target.addEventListener('click', handler);
    unlisten.push(() => target.removeEventListener('click', handler));
  }

  function setUpdateHint(html, { sticky = false } = {}) {
    if (disposed) return;
    if (updateHintTimer) {
      timers.clearTimeout(updateHintTimer);
      updateHintTimer = null;
    }
    hint.innerHTML = html || '';
    hint.hidden = !html;
    if (html && !sticky) {
      updateHintTimer = timers.setTimeout(() => {
        if (!disposed) hint.hidden = true;
      }, 3500);
    }
  }

  function renderResult(result, { manual = false } = {}) {
    if (disposed) return;
    if (result && result.updateAvailable) {
      updateDownloadUrl = String(result.url || '');
      setUpdateHint(
        translate('settings.updateAvailable', {
          version: escapeHtml(result.latestVersion),
          button: translate('settings.updateDownload'),
        }),
        { sticky: true },
      );
    } else if (manual) {
      updateDownloadUrl = '';
      setUpdateHint(result ? translate('settings.updateLatest') : translate('settings.updateFailed'));
    }
  }

  async function runCheck(manual) {
    if (disposed) return;
    try {
      renderResult(await checkUpdate(manual === true), { manual });
    } catch {
      // A rejected manual check changes the hint but preserves the prior link,
      // matching the existing request-failure behavior.
      if (manual && !disposed) setUpdateHint(translate('settings.updateFailed'));
    }
  }

  function onHintClick(event) {
    if (disposed || !event.target?.closest?.('#updateDownload') || !updateDownloadUrl) return;
    openExternal(updateDownloadUrl);
  }

  async function onCheckClick() {
    if (disposed) return;
    checkButton.disabled = true;
    try {
      await runCheck(true);
    } finally {
      if (!disposed) checkButton.disabled = false;
    }
  }

  function start() {
    if (started || disposed) return false;
    started = true;
    listen(hint, onHintClick);
    listen(checkButton, onCheckClick);
    return true;
  }

  function dispose() {
    if (disposed) return false;
    disposed = true;
    started = false;
    const errors = [];
    const attempt = cleanup => { try { cleanup(); } catch (error) { errors.push(error); } };
    if (updateHintTimer) attempt(() => timers.clearTimeout(updateHintTimer));
    updateHintTimer = null;
    for (const remove of unlisten.splice(0).reverse()) attempt(remove);
    updateDownloadUrl = '';
    if (errors.length) throw new AggregateError(errors, 'update notice cleanup failed');
    return true;
  }

  return Object.freeze({ dispose, renderResult, runCheck, start });
}

export { create };
