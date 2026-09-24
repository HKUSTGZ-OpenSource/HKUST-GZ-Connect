import { createIntegrationCenter } from './controller.mjs';

export function create({ api, document, i18n, ...options } = {}) {
  const locale = () => document.documentElement.lang?.startsWith('zh') ? 'zh' : 'en';
  const view = createIntegrationCenter({ ...options, api, document, translate: i18n.createT(locale()) });
  let started = false, disposed = false, profileId;
  const listeners = [];
  const translate = () => { if (!disposed) view.setTranslator(i18n.createT(locale())); };
  const state = event => {
    if (disposed) return;
    const next = event.detail?.schoolProfile?.profileId;
    if (event.detail?.loggedIn !== true || (profileId !== undefined && next !== profileId)) void view.cancel();
    profileId = next;
    if (event.detail?.loggedIn === true) void view.refresh();
  };
  function dispose() {
    if (disposed) return false;
    disposed = true; started = false; profileId = undefined;
    const errors = [];
    for (const [name, fn] of listeners.splice(0)) {
      try { document.removeEventListener(name, fn); } catch (error) { errors.push(error); }
    }
    try { view.dispose(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'integration owner cleanup failed');
    return true;
  }
  function start() {
    if (disposed) return false;
    if (started) return true;
    started = true;
    try {
      if (view.start() !== true) throw new Error('integration view did not start');
      for (const entry of [['app-locale-changed', translate], ['app-state-refreshed', state]]) {
        listeners.push(entry); document.addEventListener(...entry);
        if (disposed) { document.removeEventListener(...entry); throw new Error('integration owner retired during startup'); }
      }
      return true;
    } catch (error) {
      try { dispose(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'integration startup failed'); }
      throw error;
    }
  }
  return Object.freeze({ ...view, start, dispose });
}
