'use strict';

const { normalizeToolbarCommand } = require('./campus-toolbar-contract');
const { createT } = require('../../platform/i18n/i18n');
const { ROUTE_CAMPUS, ROUTE_DIRECT } = require('../../routing/policy/campus-route');

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}

// Failure URLs frequently carry SAML assertions, OAuth codes, and other
// one-time credentials in their query or path.  Keep the exact URL on the tab
// for retry, but only render its origin into the user-visible error document so
// screenshots and copied diagnostics cannot disclose those secrets.
function redactedFailedUrl(value, fallback) {
  try {
    const parsed = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return fallback;
    return parsed.origin;
  } catch {
    return fallback;
  }
}

function errorPage(failedUrl, description, t = createT('zh'), route = ROUTE_CAMPUS) {
  const url = escapeHtml(redactedFailedUrl(failedUrl, t('errorPage.unknownUrl')));
  const reason = escapeHtml(description || t('errorPage.networkFailed'));
  const html = `<!doctype html><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
    <meta name="color-scheme" content="light">
    <title>${escapeHtml(t('errorPage.title'))}</title>
    <style>
      body{margin:0;background:#f7f9fc;color:#1b2536;font-family:-apple-system,"PingFang SC","Segoe UI",sans-serif}
      main{max-width:560px;margin:12vh auto;padding:36px;background:#fff;border:1px solid #e8edf5;border-radius:18px;box-shadow:0 12px 30px rgba(13,30,66,.08)}
      h1{margin:0 0 14px;color:#0b2a5b;font-size:23px}p{line-height:1.7;color:#667085}
      code{display:block;margin-top:16px;padding:12px;background:#f4f7fb;border-radius:10px;word-break:break-all;color:#344054}
    </style>
    <main><h1>${escapeHtml(t('errorPage.heading'))}</h1>
    <p>${escapeHtml(t(route === ROUTE_DIRECT ? 'errorPage.bodyDirect' : 'errorPage.bodyCampus'))}</p>
    <code>${url}</code><p>${reason}</p></main>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

// Native page observations project into Browser chrome. Routing, credential
// transactions and popup completion remain behind the injected domain ports.
class BrowserPagePresentationOwner {
  constructor({ getWindow, isContextCurrent, containsTab, currentUrl, getHomeUrl,
    getTranslator, safePopupUrl, blankUrl, slowLoadingHintMs, effects,
    timers = { setTimeout: (...args) => setTimeout(...args),
      clearTimeout: (...args) => clearTimeout(...args) } } = {}) {
    const ports = { getWindow, isContextCurrent, containsTab, currentUrl, getHomeUrl,
      getTranslator, safePopupUrl };
    const names = ['scheduleToolbarUpdate', 'windowOpenResponse', 'fillSharedPortalCredential',
      'markCredentialNavigation', 'updateTabRoute', 'recordPortalSessionUrl', 'recordPageOpen',
      'refreshWorkspaceHomes', 'clearCredentialCandidate', 'stageCredentialCandidate',
      'confirmCredentialPageState', 'cancelCertificatePrompts', 'handleKeyboard', 'reportError',
      'retireCredentialCommands'];
    if (Object.values(ports).some(port => typeof port !== 'function') || !effects ||
        names.some(name => typeof effects[name] !== 'function') || typeof blankUrl !== 'string' ||
        !blankUrl || !Number.isSafeInteger(slowLoadingHintMs) || slowLoadingHintMs < 1 ||
        typeof timers?.setTimeout !== 'function' || typeof timers?.clearTimeout !== 'function') {
      throw new TypeError('Browser page presentation dependencies are incomplete');
    }
    Object.assign(this, { ...ports, blankUrl, slowLoadingHintMs, effects, timers });
    this.records = new Map();
  }

  current(record) {
    return !!record && record.active && this.records.get(record.tab) === record &&
      this.isContextCurrent() && this.getWindow() === record.window &&
      !!record.window && !record.window.isDestroyed() && this.containsTab(record.tab) &&
      record.tab.view?.webContents === record.contents && !record.contents.isDestroyed();
  }

  clearSlowTimer(tab) {
    if (tab.slowTimer) {
      this.timers.clearTimeout(tab.slowTimer);
      tab.slowTimer = null;
    }
    tab.slow = false;
  }

  captureAdmission(tab) {
    const record = this.records.get(tab);
    return this.current(record) ? { record, revision: record.navigationRevision, intent: tab.navigationIntent } : null;
  }

  admissionCurrent(admission) {
    return !!admission && this.current(admission.record) &&
      admission.record.navigationRevision === admission.revision &&
      admission.record.tab.navigationIntent === admission.intent;
  }

  detach(tab) {
    const record = this.records.get(tab);
    if (!record) return false;
    record.active = false;
    const failures = [];
    const attempt = operation => { try { operation(); } catch (error) { failures.push(error); } };
    attempt(() => this.effects.retireCredentialCommands(tab));
    attempt(() => this.clearSlowTimer(tab));
    for (const [event, listener] of record.listeners) {
      attempt(() => record.contents.removeListener(event, listener));
    }
    attempt(() => {
      if (!record.contents.isDestroyed()) record.contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    });
    if (failures.length) throw new AggregateError(failures, 'Browser page cleanup is unconfirmed');
    this.records.delete(tab);
    return true;
  }

  reset() {
    const failures = [];
    for (const tab of [...this.records.keys()]) {
      try { this.detach(tab); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Browser pages cleanup is unconfirmed');
  }

  attach(tab) {
    const existing = this.records.get(tab);
    if (this.current(existing)) return true;
    if (existing) this.detach(tab);
    const contents = tab?.view?.webContents;
    const record = { tab, contents, window: this.getWindow(), active: true,
      listeners: [], navigationRevision: 0, failureRevision: 0 };
    this.records.set(tab, record);
    if (!contents || !this.current(record)) { this.records.delete(tab); return false; }
    const on = (name, callback, navigationGuard = false) => {
      const listener = (...args) => {
        if (this.current(record)) callback(...args);
        else if (navigationGuard) args[0]?.preventDefault?.();
      };
      record.listeners.push([name, listener]);
      contents.on(name, listener);
    };
    try {
      contents.setWindowOpenHandler(({ url }) => this.current(record)
        ? this.effects.windowOpenResponse(tab, url) : { action: 'deny' });
      const rejectNonWebNavigation = (event, url) => {
        if (!this.safePopupUrl(url)) event?.preventDefault?.();
      };
      on('will-navigate', rejectNonWebNavigation, true);
      on('will-redirect', rejectNonWebNavigation, true);
      on('did-start-loading', () => {
        record.navigationRevision++;
        this.effects.retireCredentialCommands(tab);
        tab.loading = true;
        if (!tab.loadingLabel) {
          try { tab.loadingLabel = new URL(this.currentUrl(tab)).hostname; } catch { tab.loadingLabel = ''; }
        }
        if (!tab.renderingError) tab.failedUrl = '';
        this.clearSlowTimer(tab);
        const handle = this.timers.setTimeout(() => {
          if (!this.current(record) || tab.slowTimer !== handle) return;
          tab.slowTimer = null;
          tab.slow = true;
          this.effects.scheduleToolbarUpdate();
        }, this.slowLoadingHintMs);
        tab.slowTimer = handle;
        handle.unref?.();
        this.effects.scheduleToolbarUpdate();
      });
      on('did-stop-loading', () => {
        tab.loading = false;
        tab.loadingLabel = '';
        tab.renderingError = false;
        this.clearSlowTimer(tab);
        this.effects.scheduleToolbarUpdate();
      });
      on('dom-ready', () => {
        Promise.resolve(this.effects.fillSharedPortalCredential(tab)).catch(() => {});
      });
      on('did-navigate', (_event, url, code = 0) => this.didNavigate(record, url, code));
      on('did-navigate-in-page', (_event, url) => {
        record.navigationRevision++;
        this.effects.retireCredentialCommands(tab);
        this.recordPortalSessionUrl(url);
        this.effects.scheduleToolbarUpdate();
      });
      on('page-title-updated', () => this.effects.scheduleToolbarUpdate());
      // Provisional failures must retain retry URLs just like committed failures.
      const failed = (_event, code, description, url, mainFrame) => {
        if (!mainFrame || code === -3 || !this.safePopupUrl(url)) return;
        this.renderFailure(record, url, description);
      };
      on('did-fail-load', failed);
      on('did-fail-provisional-load', failed);
      on('ipc-message', (_event, channel, candidate) => {
        if (channel === 'campus-credential-candidate') this.effects.stageCredentialCandidate(tab, candidate);
        else if (channel === 'campus-credential-page-state') {
          Promise.resolve(this.effects.confirmCredentialPageState(tab, candidate)).catch(() => {});
        }
      });
      on('render-process-gone', (_event, details) => this.handleRendererCrash(tab, details));
      on('before-input-event', (event, input) => this.effects.handleKeyboard(tab, event, input));
      const destroyed = () => this.detach(tab);
      record.listeners.push(['destroyed', destroyed]);
      contents.once('destroyed', destroyed);
      return true;
    } catch (error) {
      try { this.detach(tab); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Browser page attach failed'); }
      throw error;
    }
  }

  didNavigate(record, url, code) {
    const tab = record.tab;
    const revision = ++record.navigationRevision;
    this.effects.retireCredentialCommands(tab);
    if (tab.kind === 'blank' && url !== this.blankUrl) delete tab.kind;
    this.effects.markCredentialNavigation(tab, url, code);
    if (!this.current(record)) return;
    this.effects.updateTabRoute(tab, url);
    if (!this.current(record)) return;
    this.recordPortalSessionUrl(url);
    if (!this.current(record)) return;
    try {
      if (new URL(url).origin === new URL(this.getHomeUrl()).origin) tab.sharedCredentialAttemptedOrigin = '';
    } catch {}
    Promise.resolve(this.effects.recordPageOpen(url)).then(changed => {
      if (changed && this.current(record) && record.navigationRevision === revision) {
        this.effects.refreshWorkspaceHomes();
      }
    }).catch(() => {});
    if (this.current(record)) this.effects.scheduleToolbarUpdate();
  }

  recordPortalSessionUrl(rawUrl) {
    if (!this.isContextCurrent()) return false;
    try {
      const value = new URL(rawUrl);
      const portal = new URL(this.getHomeUrl());
      if (value.protocol !== 'https:' || value.origin !== portal.origin ||
          value.username || value.password || value.href.length > 2048) return false;
      return this.effects.recordPortalSessionUrl(value.href) === true;
    } catch { return false; }
  }

  renderFailure(record, url, description, crash = false, feedback = () => description) {
    if (!this.current(record)) return;
    const tab = record.tab;
    const revision = ++record.failureRevision;
    tab.loading = false;
    tab.failedUrl = url;
    tab.renderingError = true;
    if (crash) tab.crashed = true;
    this.effects.clearCredentialCandidate(tab);
    this.clearSlowTimer(tab);
    if (!this.current(record)) return;
    const rejected = () => {
      if (crash && this.current(record) && record.failureRevision === revision &&
          tab.crashed && tab.renderingError) this.effects.reportError(feedback());
    };
    try {
      Promise.resolve(record.contents.loadURL(errorPage(url, description, this.getTranslator(), tab.route)))
        .catch(rejected);
    } catch { rejected(); }
    if (this.current(record)) this.effects.scheduleToolbarUpdate();
  }

  handleRendererCrash(tab, details = {}) {
    const record = this.records.get(tab);
    if (!this.current(record) || details.reason === 'clean-exit') return;
    this.effects.cancelCertificatePrompts();
    if (!this.current(record)) return;
    const failedUrl = this.currentUrl(tab) || this.getHomeUrl();
    const reason = String(details.reason || 'crashed').slice(0, 80);
    this.renderFailure(record, this.safePopupUrl(failedUrl) ? failedUrl : this.getHomeUrl(),
      this.getTranslator()('errorPage.rendererCrash', { reason }), true,
      () => this.getTranslator()('errorPage.rendererCrash', { reason }));
  }
}

// Window-scoped chrome geometry and find state. Tabs and native windows remain
// owned by their lifecycle owners; this owner holds only one bounded resize.
class BrowserViewportOwner {
  constructor({ getWindow, getActiveTab, isContextCurrent, updateToolbar,
    toolbarHeight, findBarHeight, timers = { setImmediate, clearImmediate } } = {}) {
    if ([getWindow, getActiveTab, isContextCurrent, updateToolbar,
      timers?.setImmediate, timers?.clearImmediate].some(port => typeof port !== 'function') ||
      !Number.isSafeInteger(toolbarHeight) || toolbarHeight < 1 ||
      !Number.isSafeInteger(findBarHeight) || findBarHeight < 1) {
      throw new TypeError('Browser viewport dependencies are incomplete');
    }
    Object.assign(this, { getWindow, getActiveTab, isContextCurrent, updateToolbar,
      toolbarHeight, findBarHeight, timers });
    this.findOpen = false;
    this.scheduledLayout = null;
    this.generation = 0;
  }

  cancelScheduledLayout() {
    this.generation++;
    const handle = this.scheduledLayout;
    this.scheduledLayout = null;
    if (handle !== null) this.timers.clearImmediate(handle);
  }

  scheduleLayout() {
    const window = this.getWindow();
    if (this.scheduledLayout !== null || !this.isContextCurrent() ||
        !window || window.isDestroyed()) return;
    const generation = this.generation;
    const handle = this.timers.setImmediate(() => {
      if (generation !== this.generation || this.scheduledLayout !== handle) return;
      this.scheduledLayout = null;
      if (this.getWindow() !== window || window.isDestroyed()) return;
      this.applyLayout();
    });
    this.scheduledLayout = handle;
    handle.unref?.();
  }

  applyLayout() {
    const window = this.getWindow();
    const active = this.getActiveTab();
    if (!this.isContextCurrent() || !window || window.isDestroyed() ||
        !active || active.view.webContents.isDestroyed()) return;
    const [width, height] = window.getContentSize();
    const toolbarHeight = this.toolbarHeight + (this.findOpen ? this.findBarHeight : 0);
    active.view.setBounds({ x: 0, y: toolbarHeight,
      width: Math.max(1, width), height: Math.max(1, height - toolbarHeight) });
  }

  layout() {
    this.cancelScheduledLayout();
    this.applyLayout();
  }

  // Per-window state persists across tab switches; find matches stay per-tab.
  setFindBar(open) {
    const window = this.getWindow();
    if (!this.isContextCurrent() || !window || window.isDestroyed()) return;
    this.findOpen = !!open;
    this.layout();
    this.updateToolbar();
    if (!this.isContextCurrent() || this.getWindow() !== window || window.isDestroyed()) return;
    if (open) {
      window.webContents.send?.('campus-toolbar-focus', 'find');
      return;
    }
    const active = this.getActiveTab();
    if (active && !active.view.webContents.isDestroyed()) {
      if (typeof active.view.webContents.stopFindInPage === 'function') {
        active.view.webContents.stopFindInPage('clearSelection');
      }
      active.view.webContents.focus();
    }
  }

  reset() {
    this.cancelScheduledLayout();
    this.findOpen = false;
  }
}

class BrowserToolbarOwner {
  constructor({
    getWindow, getActiveTab, getTabs, getActiveTabId, getFindOpen, getDownloadState,
    currentUrl, bookmarkBarState, pageFavoriteState, navigationForContents,
    translate, campusRoute, directRoute, timers = { setImmediate, clearImmediate },
  } = {}) {
    for (const dependency of [
      getWindow, getActiveTab, getTabs, getActiveTabId, getFindOpen, getDownloadState,
      currentUrl, bookmarkBarState, pageFavoriteState, navigationForContents, translate,
      timers?.setImmediate, timers?.clearImmediate,
    ]) {
      if (typeof dependency !== 'function') {
        throw new TypeError('Browser toolbar owner dependencies are incomplete');
      }
    }
    if (typeof campusRoute !== 'string' || !campusRoute ||
        typeof directRoute !== 'string' || !directRoute || campusRoute === directRoute) {
      throw new TypeError('Browser toolbar route labels are invalid');
    }
    Object.assign(this, {
      getWindow, getActiveTab, getTabs, getActiveTabId, getFindOpen, getDownloadState,
      currentUrl, bookmarkBarState, pageFavoriteState, navigationForContents, translate,
      campusRoute, directRoute, timers,
    });
    this.scheduledUpdate = null;
    this.lastState = null;
    this.generation = 0;
  }

  cancel() {
    if (this.scheduledUpdate === null) return false;
    this.timers.clearImmediate(this.scheduledUpdate);
    this.scheduledUpdate = null;
    return true;
  }

  reset() {
    const hadState = this.scheduledUpdate !== null || this.lastState !== null;
    this.generation++;
    this.cancel();
    this.lastState = null;
    return hadState;
  }

  schedule() {
    const window = this.getWindow();
    if (this.scheduledUpdate !== null || !window || window.isDestroyed()) return false;
    const generation = this.generation;
    const handle = this.timers.setImmediate(() => {
      if (generation !== this.generation || this.scheduledUpdate !== handle) return;
      this.scheduledUpdate = null;
      if (this.getWindow() !== window || window.isDestroyed()) return;
      this.send();
    });
    this.scheduledUpdate = handle;
    this.scheduledUpdate.unref?.();
    return true;
  }

  send() {
    const window = this.getWindow();
    if (!window || window.isDestroyed()) return false;
    const active = this.getActiveTab();
    // A crashed or closed page renderer cannot be queried for toolbar state.
    if (active && active.view.webContents.isDestroyed()) return false;
    const title = active?.view.webContents.getTitle() || '';
    const navigation = this.navigationForContents(active?.view.webContents);
    const t = this.translate;
    const state = {
      url: this.currentUrl(active),
      title,
      loading: !!active?.loading,
      loadingLabel: active?.loading ? active.loadingLabel || '' : '',
      slow: !!active?.slow,
      findOpen: this.getFindOpen(),
      route: active?.route || this.campusRoute,
      routeSource: active?.routeSource || 'default',
      routeLabel: active?.route === this.directRoute ? t('route.direct') : t('route.campus'),
      canGoBack: !!active && navigation.canGoBack(),
      canGoForward: !!active && navigation.canGoForward(),
      activeTabId: this.getActiveTabId(),
      tabs: this.getTabs().map(tab => ({
        id: tab.id,
        title: tab.view.webContents.isDestroyed()
          ? t('tab.new') : tab.view.webContents.getTitle() || tab.loadingLabel || t('tab.new'),
        loading: tab.loading,
        route: tab.route,
      })),
      download: this.getDownloadState(),
      workspace: active?.kind === 'workspace',
      bookmarks: this.bookmarkBarState(),
      ...this.pageFavoriteState(active),
    };
    const serialized = JSON.stringify(state);
    if (serialized === this.lastState) return false;
    const send = window.webContents?.send;
    if (typeof send !== 'function') return false;
    try {
      send.call(window.webContents, 'campus-toolbar-state', state);
      this.lastState = serialized;
      return true;
    } catch {
      // A window can retire between the isDestroyed check and send.
      return false;
    }
  }

  update() {
    this.cancel();
    return this.send();
  }
}

class BrowserToolbarCommandOwner {
  constructor({
    getActiveTab, getTabs, getWindow, getBookmarkBarState,
    getBookmarkMenu, getOpenResource, navigationForContents,
    workspaceSearchQuery, nextZoomFactor, translate, reportError,
    actions, platform = process.platform,
  } = {}) {
    const ports = { getActiveTab, getTabs, getWindow, getBookmarkBarState,
      getBookmarkMenu, getOpenResource, navigationForContents, workspaceSearchQuery,
      nextZoomFactor, translate, reportError };
    const actionNames = [
      'openNewTab', 'openHome', 'focusWorkspace', 'updateToolbar', 'switchTab',
      'closeTab', 'setTabRoute', 'manageCredential', 'openSettings', 'toggleFavorite',
      'focusWorkspaceSearch', 'beginNavigationIntent', 'reloadWhenReady',
      'navigateWhenReady', 'setFindBar', 'tabAt',
    ];
    if (Object.values(ports).some((port) => typeof port !== 'function') ||
        !actions || actionNames.some((name) => typeof actions[name] !== 'function') ||
        !['darwin', 'win32', 'linux'].includes(platform)) {
      throw new TypeError('Browser toolbar command dependencies are incomplete');
    }
    Object.assign(this, { ...ports, actions, platform });
    this.lastFindQuery = '';
  }

  handleCommand(input) {
    const normalized = input && typeof input === 'object'
      ? normalizeToolbarCommand(input.command, input.value) : null;
    if (!normalized) return false;
    const { command, value } = normalized;
    const active = this.getActiveTab();
    const navigation = this.navigationForContents(active?.view.webContents);
    const action = this.actions;

    if (command === 'new-tab') {
      Promise.resolve(action.openNewTab()).catch(() => this.reportError(this.translate('tab.createFailed')));
    }
    else if (command === 'home') {
      Promise.resolve(action.openHome()).catch(() => this.reportError(this.translate('tab.createFailed')));
    }
    else if (command === 'manage-bookmarks') action.focusWorkspace('manage');
    else if (command === 'open-bookmark-menu' && this.getBookmarkMenu()) {
      this.getBookmarkMenu()(this.getBookmarkBarState());
    }
    else if (command === 'open-bookmark-folder' && this.getBookmarkMenu()) {
      const folder = this.getBookmarkBarState().find(({ type, id }) => type === 'folder' && id === value);
      if (folder) this.getBookmarkMenu()(folder.children);
    }
    else if (command === 'open-resource' && this.getOpenResource()) {
      Promise.resolve(this.getOpenResource()(value)).then(() => action.updateToolbar()).catch((error) => {
        this.reportError(error?.message || this.translate('browser.favoriteFailed'));
      });
    }
    else if (command === 'switch-tab') action.switchTab(Number(value));
    else if (command === 'close-tab') action.closeTab(Number(value));
    else if (command === 'set-route' && active) {
      action.setTabRoute(active.id, value).catch((error) => {
        this.reportError(this.translate('route.switchFailed', { message: error.message }));
      });
    }
    else if (command === 'manage-credential' && active) action.manageCredential(active);
    else if (command === 'open-settings') action.openSettings();
    else if (command === 'toggle-favorite' && active) {
      action.toggleFavorite(active).catch((error) => {
        this.reportError(error.message || this.translate('browser.favoriteFailed'));
      });
    }
    else if (command === 'focus-workspace') action.focusWorkspaceSearch();
    else if (command === 'back' && navigation.canGoBack()) {
      action.beginNavigationIntent(active);
      navigation.goBack();
    } else if (command === 'forward' && navigation.canGoForward()) {
      action.beginNavigationIntent(active);
      navigation.goForward();
    } else if (command === 'reload' && active) {
      Promise.resolve(action.reloadWhenReady(active)).catch((error) => {
        this.reportError(error?.message || this.translate('error.connectTimeout'));
      });
    } else if (command === 'navigate' && active) {
      const query = this.workspaceSearchQuery(value);
      if (query) action.focusWorkspace('search', query);
      else Promise.resolve(action.navigateWhenReady(value, active)).catch((error) => {
        this.reportError(error?.message || this.translate('error.connectTimeout'));
      });
    } else if (command === 'find-open') action.setFindBar(true);
    else if (command === 'find-close') action.setFindBar(false);
    else if (command === 'find' && active) {
      this.lastFindQuery = value;
      const contents = active.view.webContents;
      if (contents.isDestroyed()) return;
      if (value && typeof contents.findInPage === 'function') contents.findInPage(value);
      if (!value && typeof contents.stopFindInPage === 'function') {
        contents.stopFindInPage('clearSelection');
      }
    } else if ((command === 'find-next' || command === 'find-prev') &&
               active && this.lastFindQuery && !active.view.webContents.isDestroyed() &&
               typeof active.view.webContents.findInPage === 'function') {
      active.view.webContents.findInPage(this.lastFindQuery, {
        forward: command === 'find-next', findNext: true,
      });
    }
    return true;
  }

  handleKeyboard(tab, event, input) {
    const contents = tab.view.webContents;
    const commandKey = this.platform === 'darwin' ? input.meta : input.control;
    const key = String(input.key || '').toLowerCase();
    const navigation = this.navigationForContents(contents);
    const action = this.actions;
    if (commandKey && key === 't') {
      event.preventDefault();
      Promise.resolve(action.openNewTab())
        .catch(() => this.reportError(this.translate('tab.createFailed')));
    } else if (commandKey && key === 'w') {
      event.preventDefault(); action.closeTab(tab.id);
    } else if (commandKey && key === 'l') {
      event.preventDefault();
      this.getWindow()?.webContents.send?.('campus-toolbar-focus', 'address');
    } else if (commandKey && key === 'k' && input.type === 'keyDown') {
      event.preventDefault(); action.focusWorkspaceSearch();
    } else if (commandKey && key === 'r') {
      event.preventDefault();
      Promise.resolve(action.reloadWhenReady(tab)).catch((error) => {
        this.reportError(error?.message || this.translate('error.connectTimeout'));
      });
    } else if (commandKey && key === 'f' && input.type === 'keyDown') {
      event.preventDefault(); action.setFindBar(true);
    } else if (commandKey && ['=', '+', '-', '0'].includes(key) && input.type === 'keyDown') {
      event.preventDefault();
      contents.setZoomFactor(this.nextZoomFactor(contents.getZoomFactor(), key));
    } else if (input.alt && ['left', 'arrowleft'].includes(key) && navigation.canGoBack()) {
      event.preventDefault(); navigation.goBack();
    } else if (input.alt && ['right', 'arrowright'].includes(key) && navigation.canGoForward()) {
      event.preventDefault(); navigation.goForward();
    } else if (commandKey && /^[1-9]$/u.test(key)) {
      event.preventDefault();
      const index = key === '9' ? this.getTabs().length - 1 : Number(key) - 1;
      const selected = action.tabAt(index);
      if (selected) action.switchTab(selected.id);
    }
  }
}

module.exports = { BrowserPagePresentationOwner, BrowserToolbarCommandOwner, BrowserToolbarOwner,
  BrowserViewportOwner, errorPage, redactedFailedUrl };
