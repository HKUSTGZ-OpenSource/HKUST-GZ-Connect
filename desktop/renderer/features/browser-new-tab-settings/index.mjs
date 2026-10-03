const DEFAULT_URL = 'https://www.bing.com/';

function create({ api, document, translate, getSettings, setSettings } = {}) {
  if (typeof api?.save !== 'function' || typeof document?.getElementById !== 'function' ||
      [translate, getSettings, setSettings].some(value => typeof value !== 'function')) {
    throw new TypeError('new-tab settings capabilities are incomplete');
  }
  const input = document.getElementById('browserNewTabUrl');
  const button = document.getElementById('saveBrowserNewTabUrl');
  const status = document.getElementById('browserNewTabStatus');
  if (!input || !button || !status || [input, button].some(element =>
    typeof element.addEventListener !== 'function' || typeof element.removeEventListener !== 'function')) {
    throw new TypeError('new-tab settings markup is incomplete');
  }
  let started = false;
  let disposed = false;
  const removals = [];

  function render(settings) {
    if (!disposed) input.value = settings?.browserNewTabUrl || DEFAULT_URL;
  }

  async function save() {
    if (!started || disposed) return;
    button.disabled = true;
    status.textContent = '';
    try {
      const result = await api.save({ browserNewTabUrl: input.value });
      // The Main-owned write is not cancelled or undone. A retired feature
      // only stops projecting its late result into local settings/DOM.
      if (disposed) return;
      if (!result?.ok) {
        status.textContent = result?.error || translate('settings.newTabSaveFailed');
        return;
      }
      setSettings(result.settings || getSettings());
      render(getSettings());
      status.textContent = translate('settings.newTabSaved');
    } catch {
      if (!disposed) status.textContent = translate('settings.newTabSaveFailed');
    } finally {
      if (!disposed) button.disabled = false;
    }
  }

  function onKeydown(event) {
    if (disposed || event.key !== 'Enter') return;
    event.preventDefault();
    return save();
  }

  function listen(element, type, handler) {
    element.addEventListener(type, handler);
    removals.push(() => element.removeEventListener(type, handler));
  }

  function start() {
    if (started || disposed) return false;
    started = true;
    listen(button, 'click', save);
    listen(input, 'keydown', onKeydown);
    render(getSettings());
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
    if (errors.length) throw new AggregateError(errors, 'new-tab settings cleanup failed');
    return true;
  }

  return Object.freeze({ start, dispose, render });
}

export { create };
