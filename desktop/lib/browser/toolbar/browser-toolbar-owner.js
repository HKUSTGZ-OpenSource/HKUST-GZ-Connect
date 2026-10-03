'use strict';

const { normalizeToolbarCommand } = require('./campus-toolbar-contract');

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

module.exports = { BrowserToolbarCommandOwner, BrowserToolbarOwner };
