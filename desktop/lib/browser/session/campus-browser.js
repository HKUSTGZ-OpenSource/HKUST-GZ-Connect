'use strict';

const BLANK_CAMPUS_HOME = 'about:blank';
const DEFAULT_CAMPUS_HOME = BLANK_CAMPUS_HOME;
const {
  CAMPUS_PARTITION,
  NEUTRAL_CAMPUS_PARTITION,
  ROUTE_CAMPUS,
  ROUTE_DIRECT,
} = require('../../routing/policy/campus-route');
const { normalizeRuleHost } = require('../../routing/rules/routing-rule-store');
const { BrowserPagePresentationOwner, BrowserToolbarCommandOwner, BrowserToolbarOwner,
  BrowserViewportOwner, errorPage, redactedFailedUrl } = require('../toolbar/browser-toolbar-owner');
const { BrowserWorkspaceOwner, projectBrowserWorkspaceResources, MAX_WORKSPACE_HOME_RESOURCES } =
  require('../workspace/campus-workspace-controller');
const { CertificateController } = require('../certificates/certificate-controller');
const { BrowserDownloadController } = require('../downloads/download-controller');
const { BrowserCredentialCommandOwner, CredentialController, ManagedCredentialPopupOwner, tabCredentialOrigin } = require('../credentials/credential-controller');
const {
  BrowserRoutingActivationOwner,
  BrowserSessionManager,
  applyCampusSessionPolicy,
  campusProxyConfig,
  createMemoryRoutingPolicy,
  pacDataUrl,
} = require('./browser-session-manager');
const { DEFAULT_MAX_TABS, BrowserNavigationOwner, BrowserTabLifecycle } = require('../tabs/tab-manager');
const { createT } = require('../../platform/i18n/i18n');
const TOOLBAR_HEIGHT = 108;
const FIND_BAR_HEIGHT = 34;
const SLOW_LOADING_HINT_MS = 10000;
const MAX_URL_LENGTH = 2048;

const ZOOM_STEP = 0.1;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;
const MAX_TABS = DEFAULT_MAX_TABS;

function normalizeCampusUrl(input, fallback = DEFAULT_CAMPUS_HOME, t = createT('zh')) {
  let value = String(input || '').trim() || fallback;
  if (value === BLANK_CAMPUS_HOME) return BLANK_CAMPUS_HOME;
  if (value.length > MAX_URL_LENGTH) throw new Error(t('url.tooLong'));
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) value = `https://${value}`;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(t('url.invalid'));
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(t('url.schemeUnsupported'));
  }
  if (!parsed.hostname || parsed.username || parsed.password) {
    throw new Error(t('url.invalid'));
  }
  return parsed.href;
}

function workspaceSearchQuery(value) {
  const query = String(value || '').trim();
  if (!query || query.length > 80 || /[\u0000-\u001f\u007f]/u.test(query)) return null;
  if (/\s/u.test(query)) return query;
  if (/[./:@]/u.test(query)) return null;
  return /^[\p{L}\p{N}_-]+$/u.test(query) ? query : null;
}

function campusWindowChrome(platform) {
  if (platform === 'darwin') {
    return {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 13, y: 11 },
    };
  }
  if (platform === 'win32') {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#f1ecd6',
        symbolColor: '#0b2a5b',
        height: 34,
      },
    };
  }
  return { titleBarStyle: 'default' };
}

function safePopupUrl(value) {
  if (value === BLANK_CAMPUS_HOME) return true;
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

// key is '0' to reset, '=' or '+' to zoom in, '-' to zoom out. The product of
// float steps drifts (1.7 + 0.1 === 1.7999…), so round back to one decimal.
function nextZoomFactor(current, key) {
  const base = Number.isFinite(current) ? current : 1;
  const target = key === '0' ? 1 : key === '-' ? base - ZOOM_STEP : base + ZOOM_STEP;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(target * 10) / 10));
}

function navigationForContents(contents) {
  const modern = contents?.navigationHistory;
  const call = (method, fallback = false) => {
    const target = typeof modern?.[method] === 'function' ? modern : contents;
    if (typeof target?.[method] !== 'function') return fallback;
    try {
      const result = target[method]();
      return method.startsWith('can') ? result === true : true;
    } catch {
      return fallback;
    }
  };
  return {
    canGoBack: () => call('canGoBack'),
    canGoForward: () => call('canGoForward'),
    goBack: () => call('goBack'),
    goForward: () => call('goForward'),
  };
}


function workspaceHomeResources(value, t = createT('zh')) {
  return projectBrowserWorkspaceResources(value,
    (url, translate) => normalizeCampusUrl(url, BLANK_CAMPUS_HOME, translate), t);
}

class CampusBrowser {
  constructor({
    BrowserWindow,
    WebContentsView,
    createWindowOwner = null,
    session,
    dialog,
    certificateTrust,
    credentialVault,
    parentWindow,
    toolbarFile,
    toolbarPreload,
    campusPreload,
    profilePresentation = null,
    getWorkspaceResources = () => [],
    getWorkspaceGroups = () => [],
    onOpenResource = null,
    showBookmarkMenu = null,
    onTogglePageFavorite = null,
    onRecordPageOpen = null,
    getSharedPortalCredential = null,
    onPortalSessionUrl = null,
    workspaceController = null,
    showItemInFolder = null,
    getNewTabUrl = () => BLANK_CAMPUS_HOME,
    onOpenSettings = null,
    homeUrl = DEFAULT_CAMPUS_HOME,
    routingPolicy,
    ensureCampusReady,
    locale,
    t,
    onError,
    partition = NEUTRAL_CAMPUS_PARTITION,
  }) {
    this.BrowserWindow = BrowserWindow;
    this.WebContentsView = WebContentsView;
    this.session = session;
    this.dialog = dialog;
    this.credentialVault = credentialVault;
    this.parentWindow = parentWindow;
    this.toolbarFile = toolbarFile;
    this.toolbarPreload = toolbarPreload;
    this.campusPreload = campusPreload;
    this.routingPolicy = routingPolicy || createMemoryRoutingPolicy();
    this.ensureCampusReady = typeof ensureCampusReady === 'function'
      ? ensureCampusReady
      : async () => true;
    this.locale = locale === 'en' ? 'en' : 'zh';
    this.t = typeof t === 'function' ? t : createT(this.locale);
    this.profilePresentation = profilePresentation &&
      typeof profilePresentation.schoolName === 'string' &&
      typeof profilePresentation.unverified === 'boolean'
      ? Object.freeze({
        schoolName: profilePresentation.schoolName.slice(0, 160),
        unverified: profilePresentation.unverified,
        officialPortalResourceId: typeof profilePresentation.officialPortalResourceId === 'string'
          ? profilePresentation.officialPortalResourceId : null,
      })
      : Object.freeze({
        schoolName: this.t('browser.workspace'), unverified: false,
        officialPortalResourceId: null,
      });
    if (typeof getWorkspaceResources !== 'function' || typeof getWorkspaceGroups !== 'function') {
      throw new TypeError('Campus Browser workspace provider is invalid');
    }
    this.getWorkspaceResources = getWorkspaceResources;
    this.getWorkspaceGroups = getWorkspaceGroups;
    this.onOpenResource = typeof onOpenResource === 'function' ? onOpenResource : null;
    this.showBookmarkMenu = typeof showBookmarkMenu === 'function' ? showBookmarkMenu : null;
    this.onTogglePageFavorite = typeof onTogglePageFavorite === 'function'
      ? onTogglePageFavorite : null;
    this.onRecordPageOpen = typeof onRecordPageOpen === 'function' ? onRecordPageOpen : null;
    this.getSharedPortalCredential = typeof getSharedPortalCredential === 'function'
      ? getSharedPortalCredential : () => null;
    this.onPortalSessionUrl = typeof onPortalSessionUrl === 'function'
      ? onPortalSessionUrl : () => false;
    if (workspaceController && (typeof workspaceController.createView !== 'function' ||
        typeof workspaceController.load !== 'function' ||
        typeof workspaceController.sendState !== 'function')) {
      throw new TypeError('Campus Workspace controller is invalid');
    }
    this.workspaceController = workspaceController || null;
    this.showItemInFolder = typeof showItemInFolder === 'function' ? showItemInFolder : () => {};
    this.getNewTabUrl = typeof getNewTabUrl === 'function'
      ? getNewTabUrl : () => BLANK_CAMPUS_HOME;
    this.onOpenSettings = typeof onOpenSettings === 'function' ? onOpenSettings : () => {};
    this.homeUrl = homeUrl === BLANK_CAMPUS_HOME
      ? BLANK_CAMPUS_HOME
      : normalizeCampusUrl(homeUrl, DEFAULT_CAMPUS_HOME, this.t);
    this.onError = onError;
    this.certificateController = new CertificateController({
      trustStore: certificateTrust,
      dialog,
      windowForPrompt: () => this.window,
      locale: () => this.locale,
      t: (key, vars) => this.t(key, vars),
    });
    this.credentialController = new CredentialController({
      vault: credentialVault,
      dialog,
      originForTab: (tab) => this.tabOrigin(tab),
      windowForPrompt: () => this.window,
      isContextCurrent: () => this.windowOwner?.contextRetired !== true,
      isTabCurrent: tab => this.tabManager?.contains(tab) === true,
      t: (key, vars) => this.t(key, vars),
      onError: (message) => this.onError?.(message),
    });
    if (createWindowOwner != null && typeof createWindowOwner !== 'function') {
      throw new TypeError('Campus Browser window owner factory is invalid');
    }
    this.windowOwner = typeof createWindowOwner === 'function'
      ? createWindowOwner({
        BrowserWindow,
        toolbarFile: this.toolbarFile,
        toolbarPreload: this.toolbarPreload,
        getProfilePresentation: () => this.profilePresentation,
        getLocale: () => this.locale,
        getTranslator: () => this.t,
        parentWindow: this.parentWindow,
        platform: process.platform,
        windowChrome: campusWindowChrome,
        onToolbarCommand: payload => this.handleToolbarCommand(payload),
        onResize: () => this.scheduleLayout(),
        onBeforeCreate: () => {
          this.cancelScheduledUpdates(); this.credentialController?.reset(); this.credentialCommands?.reset();
          this.pagePresentationOwner?.reset(); this.toolbarOwner?.reset();
        },
        onClosed: () => this.handleWindowClosed(),
        onMissingWindow: () => this.close(),
      })
      : null;
    if (this.windowOwner && (typeof this.windowOwner.createWindow !== 'function' ||
        typeof this.windowOwner.show !== 'function' ||
        typeof this.windowOwner.requestClose !== 'function' ||
        typeof this.windowOwner.closeForContextSwitch !== 'function' ||
        typeof this.windowOwner.clear !== 'function' || typeof this.windowOwner.assertContextCurrent !== 'function' || !('window' in this.windowOwner))) {
      throw new TypeError('Campus Browser window owner is invalid');
    }
    // Only the active tab is attached to the native View hierarchy. Hiding a
    // WebContentsView stops painting, but Electron can still expose its page
    // through the platform accessibility tree. Detached views retain their
    // WebContents, history, cookies, and scroll state without being reachable
    // by VoiceOver/UI Automation until the tab is selected again.
    this.tabManager = new BrowserTabLifecycle({
      maxTabs: MAX_TABS, WebContentsView, campusPreload, blankUrl: BLANK_CAMPUS_HOME,
      getWindow: () => this.window,
      getToolbarHeight: () => TOOLBAR_HEIGHT + (this.findOpen ? FIND_BAR_HEIGHT : 0),
      getWorkspace: () => this.workspaceController,
      effects: {
        linkPopup: (reservation, tab) => this.credentialController.linkPopup(reservation, tab),
        closeTabState: tab => {
          try { this.pagePresentationOwner.detach(tab); }
          finally {
            try { this.credentialCommands.clearTab(tab); }
            finally { this.credentialController.closeTab(tab); }
          }
        },
        releasePopup: reservation => this.credentialController.releasePopup(reservation),
        attachPageEvents: tab => this.attachPageEvents(tab),
        navigate: (url, tab, route) => this.navigate(url, tab, route),
        scheduleToolbarUpdate: () => this.scheduleToolbarUpdate(),
        updateToolbar: () => this.updateToolbar(),
        beforeDeactivate: tab => this.beginNavigationIntent(tab),
        layout: () => this.layout(),
        cancelScheduledUpdates: () => this.cancelScheduledUpdates(),
        cancelCertificatePrompts: () => this.certificateController.cancelAll(),
        clearSlowTimer: tab => this.clearSlowTimer(tab),
        clearCredentialCandidate: tab => this.clearCredentialCandidate(tab),
        openNewTab: () => this.openNewTab(),
        reportCreateFailure: () => this.onError?.(this.t('tab.createFailed')),
      },
    });
    this.browserSessionManager = new BrowserSessionManager({
      session,
      partition,
      routingPolicy: this.routingPolicy,
      ensureRequestReady: async (url) => {
        let resolution;
        try { resolution = this.routingPolicy.resolve(url); }
        catch { return false; }
        return resolution?.route === ROUTE_DIRECT || await this.ensureCampusReady();
      },
      onSessionReady: (browserSession) => this.applyDownloadHandler(browserSession),
    });
    this.routingActivationOwner = new BrowserRoutingActivationOwner({
      getSessionState: () => this.browserSessionManager,
      ensureCampusReady: () => this.ensureCampusReady(),
      isContextCurrent: () => !this.windowOwner?.contextRetired,
      configure: port => this.configure(port),
      resume: port => this.resumeRoutingPolicy(port),
    });
    this.popupOwner = new ManagedCredentialPopupOwner({
      BrowserWindow,
      getParentWindow: () => this.window,
      getCampusSession: () => this.browserSessionManager.sessionForRoute(ROUTE_CAMPUS),
      isContextCurrent: () => this.windowOwner?.contextRetired !== true,
      campusPreload: this.campusPreload, credentialController: this.credentialController,
      safePopupUrl,
      openOrdinaryPopup: (url) => this.createTab(url, this.resolveRoute(url).route),
      reportCreateFailure: () => this.onError?.(this.t('tab.createFailed')),
      markNavigation: (popup, url, code) => this.markCredentialNavigation(popup, url, code),
      recordPortalSessionUrl: (url) => this.recordPortalSessionUrl(url),
    });
    // One-release compatibility for diagnostics/tests; ownership and mutation
    // live exclusively in CertificateController.
    this.certificateDecisions = this.certificateController.decisions;
    this.downloadController = new BrowserDownloadController({
      getDialog: () => this.dialog,
      getWindow: () => this.window,
      getOnError: () => this.onError,
      t: (...args) => this.t(...args),
      showItemInFolder: (...args) => this.showItemInFolder(...args),
      onStateChanged: () => this.scheduleToolbarUpdate(),
    });
    // Authentication windows are intentionally kept as native children instead
    // of being flattened into tabs. Some IdPs complete SMS MFA through
    // window.opener/postMessage and window.close; preserving that relationship
    // is required for the opener to observe a successful challenge.
    this.managedCredentialPopups = this.popupOwner.popups;
    this.workspaceOwner = new BrowserWorkspaceOwner({
      getWorkspaceResources: () => this.getWorkspaceResources(),
      getWorkspaceGroups: () => this.getWorkspaceGroups(),
      getPresentation: () => this.profilePresentation, getController: () => this.workspaceController,
      getToggleFavorite: () => this.onTogglePageFavorite
        ? candidate => this.onTogglePageFavorite(candidate) : null,
      getTabs: () => this.tabs, activeTab: () => this.activeTab(),
      createTab: (url, route) => this.createTab(url, route), switchTab: id => this.switchTab(id),
      currentUrl: tab => this.currentUrl(tab),
      normalizeUrl: (url, translate) => normalizeCampusUrl(url, BLANK_CAMPUS_HOME, translate),
      t: (key, vars) => this.t(key, vars), onError: message => this.onError?.(message),
      updateToolbar: () => this.updateToolbar(),
    });
    this.navigationOwner = new BrowserNavigationOwner({
      blankUrl: BLANK_CAMPUS_HOME, normalizeUrl: normalizeCampusUrl,
      getHomeUrl: () => this.homeUrl, getNewTabUrl: () => this.getNewTabUrl(),
      getTranslator: () => this.t, reportError: (message) => this.onError?.(message),
      getActiveTab: () => this.activeTab(), getTabs: () => this.tabs,
      containsTab: (tab) => this.tabManager.contains(tab),
      getConfiguredPort: () => this.configuredPort,
      resolvePolicyRoute: (url, inheritedRoute) => this.routingPolicy.resolve(url, inheritedRoute),
      ensureRoutingReady: (resolution, port) => this.ensureRoutingReady(resolution, port),
      createTab: (...args) => this.createTab(...args),
      focusWorkspaceSearch: () => this.focusWorkspaceSearch(),
      scheduleToolbarUpdate: () => this.scheduleToolbarUpdate(),
    });
    this.viewportOwner = new BrowserViewportOwner({
      getWindow: () => this.window, getActiveTab: () => this.activeTab(),
      isContextCurrent: () => this.windowOwner?.contextRetired !== true,
      updateToolbar: () => this.updateToolbar(),
      toolbarHeight: TOOLBAR_HEIGHT, findBarHeight: FIND_BAR_HEIGHT,
    });
    this.pagePresentationOwner = new BrowserPagePresentationOwner({
      getWindow: () => this.window, containsTab: tab => this.tabManager.contains(tab),
      isContextCurrent: () => this.windowOwner?.contextRetired !== true,
      currentUrl: tab => this.currentUrl(tab), getHomeUrl: () => this.homeUrl,
      getTranslator: () => this.t, safePopupUrl, blankUrl: BLANK_CAMPUS_HOME,
      slowLoadingHintMs: SLOW_LOADING_HINT_MS,
      effects: {
        scheduleToolbarUpdate: () => this.scheduleToolbarUpdate(),
        windowOpenResponse: (tab, url) => this.windowOpenResponse(tab, url),
        fillSharedPortalCredential: tab => this.fillSharedPortalCredential(tab),
        markCredentialNavigation: (tab, url, code) => this.markCredentialNavigation(tab, url, code),
        updateTabRoute: (tab, url) => this.updateTabRoute(tab, url),
        recordPortalSessionUrl: url => this.onPortalSessionUrl(url),
        recordPageOpen: url => this.onRecordPageOpen ? this.onRecordPageOpen(url) : false,
        refreshWorkspaceHomes: () => this.refreshWorkspaceHomes(),
        clearCredentialCandidate: tab => this.clearCredentialCandidate(tab),
        stageCredentialCandidate: (tab, candidate) => this.credentialController.stage(tab, candidate),
        confirmCredentialPageState: (tab, state) => this.credentialController.confirmPageState(tab, state),
        cancelCertificatePrompts: () => this.certificateController.cancelAll(),
        handleKeyboard: (tab, event, input) => this.toolbarCommands.handleKeyboard(tab, event, input),
        reportError: message => this.onError?.(message),
        retireCredentialCommands: tab => this.credentialCommands.clearTab(tab),
      },
    });
    this.credentialCommands = new BrowserCredentialCommandOwner({
      getVault: () => this.credentialVault, getDialog: () => this.dialog,
      getWindow: () => this.window, originForTab: tab => this.tabOrigin(tab),
      captureAdmission: tab => this.pagePresentationOwner.captureAdmission(tab),
      admissionCurrent: admission => this.pagePresentationOwner.admissionCurrent(admission),
      getSharedPortalCredential: origin => this.getSharedPortalCredential(origin),
      translate: (...args) => this.t(...args), reportError: message => this.onError?.(message),
    });
    this.toolbarOwner = new BrowserToolbarOwner({
      getWindow: () => this.window,
      getActiveTab: () => this.activeTab(),
      getTabs: () => this.tabs,
      getActiveTabId: () => this.activeTabId,
      getFindOpen: () => this.findOpen,
      getDownloadState: () => this.downloadState,
      currentUrl: tab => this.currentUrl(tab),
      bookmarkBarState: () => this.bookmarkBarState(),
      pageFavoriteState: tab => this.pageFavoriteState(tab),
      navigationForContents,
      translate: (key, vars) => this.t(key, vars),
      campusRoute: ROUTE_CAMPUS,
      directRoute: ROUTE_DIRECT,
    });
    this.toolbarCommands = new BrowserToolbarCommandOwner({
      getActiveTab: () => this.activeTab(), getTabs: () => this.tabs,
      getWindow: () => this.window, getBookmarkBarState: () => this.bookmarkBarState(),
      getBookmarkMenu: () => this.showBookmarkMenu,
      getOpenResource: () => this.onOpenResource,
      navigationForContents, workspaceSearchQuery, nextZoomFactor,
      translate: (key, vars) => this.t(key, vars),
      reportError: (message) => this.onError?.(message),
      actions: {
        openNewTab: () => this.openNewTab(), openHome: () => this.openHome(),
        focusWorkspace: (target, query) => this.focusWorkspace(target, query),
        updateToolbar: () => this.updateToolbar(),
        switchTab: (id) => this.switchTab(id), closeTab: (id) => this.closeTab(id),
        setTabRoute: (id, route) => this.setTabRoute(id, route),
        manageCredential: (tab) => this.manageCredential(tab),
        openSettings: () => this.onOpenSettings(),
        toggleFavorite: (tab) => this.toggleActivePageFavorite(tab),
        focusWorkspaceSearch: () => this.focusWorkspaceSearch(),
        beginNavigationIntent: (tab) => this.beginNavigationIntent(tab),
        reloadWhenReady: (tab) => this.reloadWhenReady(tab),
        navigateWhenReady: (url, tab) => this.navigateWhenReady(url, tab),
        setFindBar: (open) => this.setFindBar(open),
        tabAt: (index) => this.tabManager.at(index),
      },
    });
  }

  // Keep the existing CampusBrowser diagnostics/test surface while all state
  // mutations flow through the dedicated managers.
  get window() { return this.windowOwner?.window || null; }
  get findOpen() { return this.viewportOwner.findOpen; }
  get scheduledLayout() { return this.viewportOwner.scheduledLayout; }
  get scheduledToolbarUpdate() { return this.toolbarOwner.scheduledUpdate; }
  get downloadSessions() { return this.downloadController.downloadSessions; }
  get downloadState() { return this.downloadController.downloadState; }
  get view() { return this.tabManager.view; }
  set view(value) { this.tabManager.view = value; }
  get attachedView() { return this.tabManager.attachedView; }
  set attachedView(value) { this.tabManager.attachedView = value; }
  get tabs() { return this.tabManager.tabs; }
  get activeTabId() { return this.tabManager.activeTabId; }
  get nextTabId() { return this.tabManager.nextTabId; }
  get configuredPort() { return this.browserSessionManager.configuredPort; }
  get sessions() { return this.browserSessionManager.sessions; }
  get sessionKey() { return this.browserSessionManager.sessionKey; }
  get campusSession() { return this.browserSessionManager.campusSession; }
  get routingSuspended() { return this.browserSessionManager.suspended; }
  get routingRequestsBlocked() { return this.browserSessionManager.requestsBlocked; }
  get routingActivationInFlight() { return this.routingActivationOwner.inFlight; }

  ownsWebContents(webContents) {
    return !!webContents && (this.tabs.some((tab) => tab?.view?.webContents === webContents) ||
      [...this.managedCredentialPopups]
        .some((popup) => popup?.view?.webContents === webContents));
  }

  // Live language switch: future dialogs and toolbar states use the new
  // strings immediately, and an open chrome window re-renders in place.
  setLocale(nextLocale, nextT) {
    this.locale = nextLocale === 'en' ? 'en' : 'zh';
    this.t = typeof nextT === 'function' ? nextT : createT(this.locale);
    if (!this.window || this.window.isDestroyed()) return;
    this.window.setTitle(this.t('browser.windowTitleForSchool', {
      school: this.profilePresentation.schoolName,
      trust: this.profilePresentation.unverified ? this.t('browser.unverifiedSuffix') : '',
    }));
    this.window.webContents.send?.('campus-toolbar-locale', this.locale);
    this.refreshWorkspaceHomes();
    this.updateToolbar();
  }

  workspaceResources() { return this.workspaceOwner.workspaceResources(); }
  workspaceGroups() { return this.workspaceOwner.workspaceGroups(); }
  bookmarkBarState() { return this.workspaceOwner.bookmarkBarState(); }
  refreshWorkspaceHomes() { return this.workspaceOwner.refreshWorkspaceHomes(); }
  refreshCardBoardLayout(document) { return this.workspaceOwner.refreshCardBoardLayout(document); }
  focusWorkspace(target = 'search', query = '') { return this.workspaceOwner.focusWorkspace(target, query); }

  focusWorkspaceSearch() { return this.focusWorkspace('search'); }

  focusAddressBar() {
    if (!this.window || this.window.isDestroyed()) return false;
    this.window.webContents.send?.('campus-toolbar-focus', 'address');
    return true;
  }

  beginNavigationIntent(tab = this.activeTab()) {
    return this.navigationOwner.beginNavigationIntent(tab);
  }

  navigationIntentCurrent(tab, intent) {
    return this.navigationOwner.navigationIntentCurrent(tab, intent);
  }

  async openHome() { return this.navigationOwner.openHome(); }

  openBlankTab() { return this.navigationOwner.openBlankTab(); }

  async openNewTab() { return this.navigationOwner.openNewTab(); }

  async ensureRoutingReady(resolution, port = this.configuredPort || 1080) {
    return this.routingActivationOwner.ensureReady(resolution, port);
  }

  async activateRoutingPolicy(port) {
    return this.routingActivationOwner.activate(port);
  }

  async navigateWhenReady(rawUrl, tab = this.activeTab()) {
    return this.navigationOwner.navigateWhenReady(rawUrl, tab);
  }

  async reloadWhenReady(tab = this.activeTab()) {
    return this.navigationOwner.reloadWhenReady(tab);
  }

  pageFavoriteState(tab = this.activeTab()) { return this.workspaceOwner.pageFavoriteState(tab); }
  async toggleActivePageFavorite(tab = this.activeTab()) { return this.workspaceOwner.toggleActivePageFavorite(tab); }

  async decideCertificateTrust({ origin, fingerprint, error, certificate }) {
    return this.certificateController.promptAndTrust({ origin, fingerprint, error, certificate });
  }

  async handleCertificateError(request) {
    return this.certificateController.handle(request);
  }

  applyDownloadHandler(routeSession) {
    return this.downloadController.applyDownloadHandler(routeSession);
  }

  handleDownload(item) {
    return this.downloadController.handleDownload(item);
  }

  async policyProxyConfig(port) {
    return this.browserSessionManager.policyProxyConfig(port);
  }

  async configure(port, { force = false } = {}) {
    return this.browserSessionManager.configure(port, { force });
  }

  suspendRoutingPolicy() {
    return this.browserSessionManager.suspend();
  }

  resumeRoutingPolicy(port = this.configuredPort) {
    return this.browserSessionManager.resume(port);
  }

  async refreshRoutingPolicy() {
    if (this.configuredPort) await this.configure(this.configuredPort, { force: true });
    this.updateAllTabRoutes();
    this.updateToolbar();
  }

  activeTab() {
    return this.tabManager.active();
  }

  cancelScheduledLayout() {
    this.viewportOwner.cancelScheduledLayout();
  }

  scheduleLayout() {
    this.viewportOwner.scheduleLayout();
  }

  applyLayout() {
    this.viewportOwner.applyLayout();
  }

  layout() {
    this.viewportOwner.layout();
  }

  currentUrl(tab) {
    return this.navigationOwner.currentUrl(tab);
  }

  resolveRoute(rawUrl, inheritedRoute = null, requestedRoute = null) {
    return this.navigationOwner.resolveRoute(rawUrl, inheritedRoute, requestedRoute);
  }

  updateTabRoute(tab, rawUrl = this.currentUrl(tab), requestedRoute = null) {
    return this.navigationOwner.updateTabRoute(tab, rawUrl, requestedRoute);
  }

  updateAllTabRoutes() {
    return this.navigationOwner.updateAllTabRoutes();
  }

  cancelScheduledToolbarUpdate() {
    this.toolbarOwner.cancel();
  }

  scheduleToolbarUpdate() {
    this.toolbarOwner.schedule();
  }

  cancelScheduledUpdates() {
    this.cancelScheduledLayout();
    this.cancelScheduledToolbarUpdate();
  }

  sendToolbarState() {
    this.toolbarOwner.send();
  }

  updateToolbar() {
    this.toolbarOwner.update();
  }

  handleToolbarCommand(input) {
    return this.toolbarCommands.handleCommand(input);
  }

  // The find bar is per-window: it stays open across tab switches, but matches
  // are per-tab, so a switched-to tab has no active find until the next search.
  setFindBar(open) {
    this.viewportOwner.setFindBar(open);
  }

  clearSlowTimer(tab) {
    this.pagePresentationOwner.clearSlowTimer(tab);
  }

  windowOpenResponse(tab, url) {
    return this.popupOwner.windowOpenResponse(tab, url);
  }

  createManagedCredentialPopup(options, credentialReservation) {
    return this.popupOwner.createManagedCredentialPopup(options, credentialReservation);
  }

  attachManagedCredentialPopupEvents(popup) {
    return this.popupOwner.attachManagedCredentialPopupEvents(popup);
  }

  attachPageEvents(tab) {
    if (!this.pagePresentationOwner.attach(tab)) throw new Error('Campus Browser page is retired');
  }

  tabOrigin(tab) {
    return tabCredentialOrigin(tab);
  }

  recordPortalSessionUrl(rawUrl) {
    return this.pagePresentationOwner.recordPortalSessionUrl(rawUrl);
  }

  clearCredentialCandidate(tab) {
    this.credentialController.clear(tab);
  }

  stageCredentialCandidate(tab, candidate) {
    return this.credentialController.stage(tab, candidate);
  }

  markCredentialNavigation(tab, rawUrl, httpResponseCode = 0) {
    return this.credentialController.markNavigation(tab, rawUrl, httpResponseCode);
  }

  async confirmCredentialAfterPageState(tab, pageState) {
    return this.credentialController.confirmPageState(tab, pageState);
  }

  async offerCredential(candidate) {
    return this.credentialController.offer(candidate);
  }

  handleRendererCrash(tab, details = {}) {
    this.pagePresentationOwner.handleRendererCrash(tab, details);
  }

  async manageCredential(tab) {
    await this.credentialCommands.manage(tab);
  }

  async fillSharedPortalCredential(tab) {
    return this.credentialCommands.fillShared(tab);
  }

  createTab(rawUrl = null, route = null, options = {}) {
    if (this.windowOwner?.contextRetired || !this.window || this.window.isDestroyed()) return null;
    const targetWindow = this.window;
    if (!this.tabManager.canAdd()) {
      if (this.onError) this.onError(this.t('tab.limit', { count: MAX_TABS }));
      return null;
    }
    let url;
    try {
      url = options.blankPage === true
        ? BLANK_CAMPUS_HOME
        : normalizeCampusUrl(rawUrl, this.homeUrl, this.t);
    } catch (error) {
      if (this.onError) this.onError(error.message);
      return null;
    }
    if (url === BLANK_CAMPUS_HOME && options.blankPage !== true) return this.createWorkspaceTab();
    const routeSession = this.browserSessionManager.sessionForRoute(ROUTE_CAMPUS);
    if (!routeSession) return null;
    const resolution = this.resolveRoute(url, null, route);
    return this.tabManager.createPage({ url, routeSession, resolution, route, options, targetWindow });
  }

  createWorkspaceTab() {
    if (this.windowOwner?.contextRetired || !this.workspaceController || !this.window || this.window.isDestroyed()) return null;
    const existing = this.tabs.find((tab) => tab.kind === 'workspace');
    if (existing) { this.switchTab(existing.id); this.workspaceController.sendState(existing.view.webContents); return existing; }
    if (!this.tabManager.canAdd()) {
      this.onError?.(this.t('tab.limit', { count: MAX_TABS }));
      return null;
    }
    const routeSession = this.browserSessionManager.sessionForRoute(ROUTE_CAMPUS);
    if (!routeSession) return null;
    return this.tabManager.createWorkspace(routeSession);
  }

  async setTabRoute(id, route) {
    if (!['auto', ROUTE_CAMPUS, ROUTE_DIRECT].includes(route)) return false;
    const tab = this.tabManager.find(id);
    if (!tab || tab.kind === 'workspace' || !this.window || this.window.isDestroyed()) return false;
    const navigationIntent = this.beginNavigationIntent(tab);
    // A route-switch request invalidates the in-flight page regardless of
    // whether reconnecting/configuring the requested route later succeeds.
    this.clearCredentialCandidate(tab);
    const url = tab.failedUrl || this.currentUrl(tab) || this.homeUrl;
    let host;
    try {
      host = normalizeRuleHost(new URL(url).hostname);
    } catch {
      return false;
    }
    if (route === ROUTE_CAMPUS && !await this.ensureCampusReady()) return false;
    if (route === 'auto') {
      if (typeof this.routingPolicy.remove !== 'function') return false;
      await this.routingPolicy.remove({ host, includeSubdomains: false });
    } else {
      await this.routingPolicy.upsert({ host, includeSubdomains: false, route });
    }
    if (this.routingPolicy.appliesLiveSession !== true) {
      await this.configure(this.configuredPort || 1080, { force: true });
    }
    if (!this.navigationIntentCurrent(tab, navigationIntent)) return true;
    this.clearSlowTimer(tab);
    this.updateAllTabRoutes();
    const resolution = this.updateTabRoute(tab, url);
    if (resolution?.route === ROUTE_CAMPUS && !await this.ensureCampusReady()) return false;
    if (!this.navigationIntentCurrent(tab, navigationIntent)) return true;
    if (tab.failedUrl || tab.renderingError) {
      this.navigate(url, tab);
    } else if (!tab.view.webContents.isDestroyed()) {
      if (typeof tab.view.webContents.reloadIgnoringCache === 'function') {
        tab.view.webContents.reloadIgnoringCache();
      } else {
        tab.view.webContents.reload();
      }
    }
    this.scheduleToolbarUpdate();
    return true;
  }

  switchTab(id) { return this.tabManager.activate(id); }

  closeTab(id) { return this.tabManager.close(id); }

  async createWindow() {
    if (!this.windowOwner) throw new Error('Campus Browser window owner is unavailable');
    await this.windowOwner.createWindow();
  }

  async showReadyWindow() {
    if (!this.windowOwner) throw new Error('Campus Browser window owner is unavailable');
    const window = await this.windowOwner.createWindow();
    this.windowOwner.show(window);
  }

  handleWindowClosed() {
    this.cancelScheduledUpdates();
    this.credentialController.reset();
    this.credentialCommands.reset();
    this.pagePresentationOwner.reset();
    this.certificateController.cancelAll();
    this.tabManager.closeViews();
    this.popupOwner.closeAll();
    this.tabManager.clear();
    this.view = null;
    this.attachedView = null;
    this.routingActivationOwner.reset();
    this.viewportOwner.reset();
    this.toolbarOwner.reset();
  }

  navigate(rawUrl, tab = this.activeTab(), requestedRoute = null) {
    return this.navigationOwner.navigate(rawUrl, tab, requestedRoute);
  }

  async open(rawUrl, port, route = null, options = {}) {
    const url = normalizeCampusUrl(rawUrl, this.homeUrl, this.t);
    const resolution = this.resolveRoute(url, null, route);
    // ensureCampusReady() proves the current engine generation has reached its
    // listener-ready boundary. Only then may a Session suspended during a
    // previous disconnect be pointed back at the live loopback frontend.
    if (!await this.ensureRoutingReady(resolution, port)) {
      throw new Error(this.t('error.connectTimeout'));
    }
    await this.showReadyWindow();
    if (url === BLANK_CAMPUS_HOME) {
      const existing = this.windowOwner.assertContextCurrent(this.tabs.find((tab) => tab.kind === 'workspace'));
      if (existing) {
        this.switchTab(existing.id);
        this.workspaceController.sendState(existing.view.webContents);
      } else {
        this.createTab(url, ROUTE_DIRECT);
      }
    } else {
      this.createTab(url, resolution.route, { displayName: options.displayName || '' });
    }
    return this.windowOwner?.assertContextCurrent(url) ?? url;
  }

  async openWorkspace(port) {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
      throw new TypeError('Campus Workspace port is invalid');
    }
    if (!this.configuredPort && !this.routingSuspended) await this.configure(port);
    await this.showReadyWindow();
    const existing = this.windowOwner.assertContextCurrent(this.tabs.find((tab) => tab.kind === 'workspace'));
    if (existing) {
      this.switchTab(existing.id);
      this.workspaceController.sendState(existing.view.webContents);
    } else {
      this.createWorkspaceTab();
    }
    return this.windowOwner?.assertContextCurrent(BLANK_CAMPUS_HOME) ?? BLANK_CAMPUS_HOME;
  }

  close() {
    this.cancelScheduledUpdates();
    this.credentialController.reset();
    this.credentialCommands.reset();
    this.pagePresentationOwner.reset();
    this.certificateController.cancelAll();
    if (this.windowOwner?.requestClose() === true) return;
    const retired = this.windowOwner?.clear();
    if (retired === true || this.windowOwner?.window) return;
    this.tabManager.clearTransientState();
    this.view = null;
    this.attachedView = null;
    this.routingActivationOwner.reset();
    this.tabManager.clear();
    this.viewportOwner.reset();
    this.toolbarOwner.reset();
  }

  closeForContextSwitch(options = {}) {
    if (!this.windowOwner) {
      this.close();
      return Promise.resolve(true);
    }
    return this.windowOwner.closeForContextSwitch(options);
  }
}

module.exports = {
  CAMPUS_PARTITION,
  CampusBrowser,
  DEFAULT_CAMPUS_HOME,
  NEUTRAL_CAMPUS_PARTITION,
  BLANK_CAMPUS_HOME,
  FIND_BAR_HEIGHT,
  MAX_WORKSPACE_HOME_RESOURCES,
  MAX_TABS,
  SLOW_LOADING_HINT_MS,
  TOOLBAR_HEIGHT,
  applyCampusSessionPolicy,
  campusProxyConfig,
  campusWindowChrome,
  errorPage,
  workspaceHomeResources,
  nextZoomFactor,
  navigationForContents,
  normalizeCampusUrl,
  pacDataUrl,
  redactedFailedUrl,
  safePopupUrl,
  workspaceSearchQuery,
};
