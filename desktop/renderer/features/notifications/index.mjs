const CATEGORIES = new Set([
  'idle', 'ready', 'connecting', 'authentication', 'configuration', 'local-listener',
  'local-state', 'network', 'browser', 'dns', 'error',
]);
const ACTIONS = new Set(['none', 'reconnect', 'open-settings', 'open-tower']);

export function applyState(card, state = {}) {
  if (!card?.classList) return false;
  card.classList.toggle('connected', state.connected === true);
  card.classList.toggle('busy', state.connecting === true);
  card.classList.toggle('error', state.connected !== true
    && state.connecting !== true
    && typeof state.lastError === 'string'
    && state.lastError.length > 0);
  return true;
}

export function publicRecovery(state) {
  const category = CATEGORIES.has(state?.recovery?.category)
    ? state.recovery.category : state?.lastError ? 'error' : 'idle';
  const action = ACTIONS.has(state?.recovery?.action) ? state.recovery.action
    : category === 'error' ? 'reconnect' : 'none';
  return Object.freeze({ category, action });
}

export function render({ card, title, summary, action, state = {}, translate } = {}) {
  if (![card, title, summary, action].every(Boolean) || typeof translate !== 'function') {
    throw new TypeError('notification view dependencies are incomplete');
  }
  const recovery = publicRecovery(state);
  applyState(card, state);
  title.textContent = translate(`notif.status.${recovery.category}`);
  summary.textContent = state.lastError || translate(`notif.summary.${recovery.category}`);
  action.hidden = recovery.action === 'none';
  action.dataset.action = recovery.action;
  if (!action.hidden) action.textContent = translate(`notif.action.${recovery.action}`);
  return recovery;
}

export async function runAction(action, { openPage, reconnect } = {}) {
  if (typeof openPage !== 'function' || typeof reconnect !== 'function') return false;
  if (action === 'open-settings') { openPage('settings'); return true; }
  if (action === 'open-tower') { openPage('tower'); return true; }
  if (action === 'reconnect') { openPage('connect'); await reconnect(); return true; }
  return false;
}

export function create({ document: doc, translate, getLogs, openPage, reconnect,
  matchMedia, timers } = {}) {
  if (!doc || typeof doc.getElementById !== 'function' ||
      typeof doc.addEventListener !== 'function' || typeof doc.removeEventListener !== 'function' ||
      [translate, getLogs, openPage, reconnect, matchMedia,
        timers?.setTimeout, timers?.clearTimeout,
        timers?.requestAnimationFrame, timers?.cancelAnimationFrame]
        .some((value) => typeof value !== 'function')) {
    throw new TypeError('notification owner dependencies are incomplete');
  }
  const byId = (id) => doc.getElementById(id);
  const card = byId('notificationCard'), title = byId('notificationTitle');
  const summary = byId('notificationSummary'), action = byId('notificationAction');
  const drawer = byId('notificationDrawer'), backdrop = byId('notificationBackdrop');
  const trigger = byId('openNotificationDrawer'), closeButton = byId('closeNotificationDrawer');
  const refresh = byId('logRefresh'), logs = byId('logs');
  const controls = [card, title, summary, action, drawer, backdrop, trigger, closeButton, refresh, logs];
  if (controls.some((element) => !element || typeof element.addEventListener !== 'function' ||
      typeof element.removeEventListener !== 'function')) {
    throw new TypeError('notification controls are unavailable');
  }

  let started = false, disposed = false, returnFocus = null, closeTimer = null, openFrame = null;
  const unlisten = [];
  function listen(target, type, handler) {
    target.addEventListener(type, handler);
    unlisten.push(() => target.removeEventListener(type, handler));
  }
  function cancelClose() {
    if (closeTimer === null) return;
    timers.clearTimeout(closeTimer);
    closeTimer = null;
  }
  function cancelOpenFrame() {
    if (openFrame === null) return;
    timers.cancelAnimationFrame(openFrame);
    openFrame = null;
  }

  async function loadLogs() {
    try {
      const text = await getLogs();
      if (disposed) return false;
      logs.textContent = text && text.trim() ? text : translate('notif.empty');
      logs.scrollTop = logs.scrollHeight;
      return true;
    } catch { return false; }
  }

  function close() {
    if (disposed || drawer.hidden) return false;
    cancelOpenFrame();
    cancelClose();
    drawer.classList.remove('open');
    backdrop.classList.remove('open');
    closeTimer = timers.setTimeout(() => {
      closeTimer = null;
      if (disposed) return;
      drawer.hidden = true;
      backdrop.hidden = true;
      returnFocus?.focus?.();
    }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180);
    return true;
  }

  function open() {
    if (disposed) return false;
    cancelClose();
    cancelOpenFrame();
    returnFocus = doc.activeElement;
    drawer.hidden = false;
    backdrop.hidden = false;
    openFrame = timers.requestAnimationFrame(() => {
      openFrame = null;
      if (disposed || drawer.hidden) return;
      drawer.classList.add('open');
      backdrop.classList.add('open');
      closeButton.focus();
    });
    void loadLogs();
    return true;
  }

  function onAction() {
    Promise.resolve(runAction(action.dataset.action, { openPage, reconnect })).catch(() => {});
  }
  function onKeydown(event) {
    if (event.key === 'Escape' && !drawer.hidden) {
      event.preventDefault();
      close();
    }
    if (event.key !== 'Tab' || drawer.hidden) return;
    const focusable = [...drawer.querySelectorAll(
      'button, summary, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )].filter((element) => !element.disabled && !element.hidden &&
      element.getClientRects().length > 0 &&
      (!element.closest('details:not([open])') || element.tagName === 'SUMMARY'));
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  function renderStatus(state) {
    if (disposed) return null;
    return render({ card, title, summary, action, state, translate });
  }
  function start() {
    if (started || disposed) return false;
    started = true;
    listen(trigger, 'click', open);
    listen(closeButton, 'click', close);
    listen(backdrop, 'click', close);
    listen(refresh, 'click', loadLogs);
    listen(action, 'click', onAction);
    listen(doc, 'keydown', onKeydown);
    return true;
  }
  function dispose() {
    if (disposed) return false;
    disposed = true;
    started = false;
    cancelClose();
    cancelOpenFrame();
    for (const remove of unlisten.splice(0).reverse()) remove();
    drawer.classList.remove('open');
    backdrop.classList.remove('open');
    drawer.hidden = true;
    backdrop.hidden = true;
    returnFocus = null;
    return true;
  }
  return Object.freeze({ start, dispose, close, open, renderStatus });
}
