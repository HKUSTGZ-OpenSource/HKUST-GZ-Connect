'use strict';

const { ROUTE_DIRECT } = require('../../routing/policy/campus-route');

const DEFAULT_MAX_TABS = 24;

class TabLimitError extends Error {
  constructor(maxTabs) {
    super(`tab limit reached: ${maxTabs}`);
    this.name = 'TabLimitError';
    this.maxTabs = maxTabs;
  }
}

class TabManager {
  constructor({ maxTabs = DEFAULT_MAX_TABS } = {}) {
    const limit = Number(maxTabs);
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError('maxTabs must be positive');
    this.maxTabs = limit;
    this.tabs = [];
    this.activeTabId = null;
    this.nextTabId = 1;
  }

  get size() {
    return this.tabs.length;
  }

  canAdd() {
    return this.tabs.length < this.maxTabs;
  }

  contains(tab) {
    return this.tabs.includes(tab);
  }

  find(id) {
    return this.tabs.find((tab) => tab.id === id) || null;
  }

  at(index) {
    return this.tabs.at(index) || null;
  }

  active() {
    return this.find(this.activeTabId);
  }

  add(tab) {
    if (!tab || typeof tab !== 'object') throw new TypeError('tab must be an object');
    if (!this.canAdd()) throw new TabLimitError(this.maxTabs);
    if (tab.id == null) {
      tab.id = this.nextTabId++;
    } else {
      const id = Number(tab.id);
      if (!Number.isSafeInteger(id) || id < 1 || this.find(id)) {
        throw new TypeError('tab id must be a unique positive integer');
      }
      tab.id = id;
      this.nextTabId = Math.max(this.nextTabId, id + 1);
    }
    this.tabs.push(tab);
    return tab;
  }

  select(id) {
    const tab = this.find(id);
    if (!tab) return null;
    this.activeTabId = tab.id;
    return tab;
  }

  replace(id, replacement) {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index === -1 || !replacement || typeof replacement !== 'object') return null;
    replacement.id = id;
    const previous = this.tabs[index];
    this.tabs[index] = replacement;
    return { previous, replacement, index, active: this.activeTabId === id };
  }

  remove(id) {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index === -1) return null;
    const wasActive = this.activeTabId === id;
    const [tab] = this.tabs.splice(index, 1);
    let replacement = null;
    if (!this.tabs.length) {
      this.activeTabId = null;
    } else if (wasActive) {
      replacement = this.tabs[Math.min(index, this.tabs.length - 1)];
      this.activeTabId = replacement.id;
    }
    return { tab, index, wasActive, replacement, empty: this.tabs.length === 0 };
  }

  replaceAll(tabs, { activeTabId = null } = {}) {
    if (!Array.isArray(tabs)) throw new TypeError('tabs must be an array');
    if (tabs.length > this.maxTabs) throw new TabLimitError(this.maxTabs);
    const ids = new Set();
    let highestId = 0;
    for (const tab of tabs) {
      if (!tab || typeof tab !== 'object') throw new TypeError('tab must be an object');
      if (tab.id == null) continue;
      const id = Number(tab.id);
      if (!Number.isSafeInteger(id) || id < 1 || ids.has(id)) {
        throw new TypeError('tab ids must be unique positive integers');
      }
      tab.id = id;
      ids.add(id);
      highestId = Math.max(highestId, id);
    }
    let allocation = this.nextTabId;
    for (const tab of tabs) {
      if (tab.id != null) continue;
      while (ids.has(allocation)) allocation++;
      tab.id = allocation++;
      ids.add(tab.id);
      highestId = Math.max(highestId, tab.id);
    }
    this.tabs = tabs;
    this.nextTabId = Math.max(allocation, highestId + 1);
    this.activeTabId = ids.has(activeTabId) ? activeTabId : null;
    return this.tabs;
  }

  clear() {
    const previous = this.tabs;
    this.tabs = [];
    this.activeTabId = null;
    return previous;
  }
}

class BrowserTabLifecycle extends TabManager {
  constructor({ maxTabs = DEFAULT_MAX_TABS, WebContentsView, campusPreload,
    getWindow, getToolbarHeight, getWorkspace, blankUrl = 'about:blank', effects } = {}) {
    super({ maxTabs });
    // View construction stays lazy, as it was in CampusBrowser. A download or
    // certificate-only host does not need a page constructor/preload yet.
    if (![getWindow, getToolbarHeight, getWorkspace].every(value => typeof value === 'function') ||
        typeof blankUrl !== 'string' || !effects || [
          'linkPopup', 'closeTabState', 'releasePopup', 'attachPageEvents', 'navigate',
          'scheduleToolbarUpdate', 'updateToolbar', 'beforeDeactivate', 'layout',
          'cancelScheduledUpdates', 'cancelCertificatePrompts', 'clearSlowTimer',
          'clearCredentialCandidate', 'openNewTab', 'reportCreateFailure',
        ].some(name => typeof effects[name] !== 'function')) {
      throw new TypeError('Browser tab lifecycle dependencies are incomplete');
    }
    Object.assign(this, { WebContentsView, campusPreload, getWindow, getToolbarHeight, getWorkspace, blankUrl });
    this.effects = Object.freeze({ ...effects });
    this.view = null;
    this.attachedView = null;
  }

  get window() { return this.getWindow(); }
  get workspaceController() { return this.getWorkspace(); }

  createPage({ url, routeSession, resolution, route, options, targetWindow }) {
    const previousActiveId = this.activeTabId;
    let view = null;
    let tab = null;
    let added = false;
    try {
      view = new this.WebContentsView({
        webPreferences: {
          session: routeSession,
          preload: this.campusPreload,
          devTools: false,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          safeDialogs: true,
          backgroundThrottling: true,
        },
      });
      view.setBackgroundColor?.('#f4f6f9');
      tab = {
        ...(options.blankPage === true ? { kind: 'blank' } : {}),
        view,
        failedUrl: '',
        loading: url !== this.blankUrl,
        loadingLabel: typeof options.displayName === 'string' && options.displayName.trim()
          ? options.displayName.trim().slice(0, 96)
          : (() => { try { return new URL(url).hostname; } catch { return ''; } })(),
        slow: false,
        slowTimer: null,
        renderingError: false,
        crashed: false,
        pendingCredential: null,
        pendingCredentialTimer: null,
        sharedCredentialAttemptedOrigin: '',
        route: resolution.route,
        routeSource: resolution.source,
        matchedRule: resolution.matchedRule,
      };
      this.effects.linkPopup(options.credentialReservation, tab);
      this.add(tab);
      added = true;
      // Keep the new renderer detached until switchTab has applied its bounds.
      // This prevents both a paint flash and an inactive page entering the
      // native accessibility tree.
      view.setVisible(false);
      if (this.window !== targetWindow || targetWindow.isDestroyed()) {
        throw new Error('campus browser window closed during tab creation');
      }
      this.effects.attachPageEvents(tab);
      if (!this.activate(tab.id) || !this.effects.navigate(url, tab, route)) {
        throw new Error('campus browser tab activation failed');
      }
      return tab;
    } catch {
      if (tab) this.effects.closeTabState(tab);
      else this.effects.releasePopup(options.credentialReservation);
      if (added) this.remove(tab.id);
      if (this.attachedView === view) {
        try { targetWindow.contentView.removeChildView(view); } catch {}
        this.attachedView = null;
      }
      try {
        if (view?.webContents && !view.webContents.isDestroyed()) view.webContents.close();
      } catch {}
      const previous = previousActiveId === null ? null : this.select(previousActiveId);
      this.view = previous?.view || null;
      if (previous && this.window === targetWindow && !targetWindow.isDestroyed()) {
        try { this.activate(previous.id); } catch {}
        this.effects.scheduleToolbarUpdate();
      }
      if (targetWindow && this.window === targetWindow && !targetWindow.isDestroyed()) this.effects.reportCreateFailure();
      return null;
    }
  }

  createWorkspace(routeSession) {
    const targetWindow = this.window;
    const workspace = this.workspaceController;
    const previousActiveId = this.activeTabId;
    let view;
    let tab;
    const isCurrent = () => Boolean(targetWindow && this.window === targetWindow && this.workspaceController === workspace &&
      !targetWindow.isDestroyed() && tab && this.contains(tab) && tab.view === view &&
      !view.webContents.isDestroyed());
    try {
      view = workspace.createView(this.WebContentsView, routeSession);
      tab = {
        kind: 'workspace', view, failedUrl: '', loading: true, slow: false,
        slowTimer: null, renderingError: false, crashed: false,
        pendingCredential: null, pendingCredentialTimer: null,
        route: ROUTE_DIRECT, routeSource: 'local-workspace', matchedRule: null,
        pendingWorkspaceFocus: null,
      };
      this.add(tab);
      view.setVisible(false);
      if (!isCurrent() || !this.activate(tab.id)) throw new Error('workspace activation failed');
      workspace.load(view).then(() => {
        if (!isCurrent()) return;
        tab.loading = false;
        workspace.sendState(view.webContents);
        if (!isCurrent()) return;
        if (tab.pendingWorkspaceFocus) {
          const { target, query } = tab.pendingWorkspaceFocus;
          tab.pendingWorkspaceFocus = null;
          if (this.active() === tab) {
            if (typeof workspace.focus === 'function') {
              workspace.focus(view.webContents, target, query);
            } else if (target === 'search') {
              workspace.focusSearch?.(view.webContents);
            }
          }
        }
        if (isCurrent()) this.effects.updateToolbar();
      }).catch(() => { if (isCurrent()) this.effects.reportCreateFailure(); });
      view.webContents.on('render-process-gone', () => {
        if (isCurrent()) workspace.load(view).catch(() => {});
      });
      return tab;
    } catch {
      if (tab) this.remove(tab.id);
      if (this.attachedView === view) {
        try { this.window.contentView.removeChildView(view); } catch {}
        this.attachedView = null;
      }
      try { if (view?.webContents && !view.webContents.isDestroyed()) view.webContents.close(); } catch {}
      const previous = previousActiveId === null ? null : this.select(previousActiveId);
      this.view = previous?.view || null;
      if (previous && this.window === targetWindow && !targetWindow.isDestroyed()) {
        try { this.activate(previous.id); } catch {}
      }
      if (targetWindow && this.window === targetWindow && !targetWindow.isDestroyed()) {
        this.effects.reportCreateFailure();
      }
      return null;
    }
  }

  activate(id) {
    const selected = this.find(id);
    if (!selected) return false;
    const previous = this.active();
    const previousView = this.attachedView;
    if (!this.window || this.window.isDestroyed() || selected.view.webContents.isDestroyed()) {
      return false;
    }
    try {
      if (previous && previous.id !== selected.id) this.effects.beforeDeactivate(previous);
      if (previousView && previousView !== selected.view) {
        previousView.setVisible(false);
        this.window.contentView.removeChildView(previousView);
        this.attachedView = null;
      }
      const [width, height] = this.window.getContentSize();
      const toolbarHeight = this.getToolbarHeight();
      selected.view.setVisible(false);
      selected.view.setBounds({
        x: 0,
        y: toolbarHeight,
        width: Math.max(1, width),
        height: Math.max(1, height - toolbarHeight),
      });
      if (this.attachedView !== selected.view) {
        this.window.contentView.addChildView(selected.view);
        this.attachedView = selected.view;
      }
      selected.view.setVisible(true);
      this.select(selected.id);
      this.view = selected.view;
      this.effects.scheduleToolbarUpdate();
      return true;
    } catch {
      if (this.attachedView === selected.view) {
        try { this.window.contentView.removeChildView(selected.view); } catch {}
        this.attachedView = null;
      }
      try { selected.view.setVisible(false); } catch {}
      if (previous && !previous.view.webContents.isDestroyed()) {
        try {
          this.window.contentView.addChildView(previous.view);
          this.attachedView = previous.view;
          previous.view.setVisible(true);
          this.select(previous.id);
          this.view = previous.view;
          this.effects.layout();
        } catch {}
      }
      return false;
    }
  }

  close(id) {
    const removal = this.remove(id);
    if (!removal) return false;
    this.effects.cancelScheduledUpdates();
    this.effects.cancelCertificatePrompts();
    const { tab, replacement, empty } = removal;
    this.effects.clearSlowTimer(tab);
    this.effects.closeTabState(tab);
    if (this.attachedView === tab.view) {
      this.window.contentView.removeChildView(tab.view);
      this.attachedView = null;
    }
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();

    if (empty) {
      this.view = null;
      Promise.resolve(this.effects.openNewTab())
        .catch(() => this.effects.reportCreateFailure());
    } else if (replacement) {
      this.activate(replacement.id);
    } else {
      this.effects.scheduleToolbarUpdate();
    }
    return true;
  }

  clearTransientState() {
    for (const tab of this.tabs) {
      this.effects.clearSlowTimer(tab);
      this.effects.clearCredentialCandidate(tab);
    }
  }

  closeViews() {
    for (const tab of this.tabs) {
      this.effects.clearSlowTimer(tab);
      this.effects.clearCredentialCandidate(tab);
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
  }
}

module.exports = {
  BrowserTabLifecycle,
  DEFAULT_MAX_TABS,
  TabLimitError,
  TabManager,
};
