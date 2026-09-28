'use strict';

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

module.exports = { BrowserToolbarOwner };
