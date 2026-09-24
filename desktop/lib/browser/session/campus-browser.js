'use strict';

const BLANK_CAMPUS_HOME = 'about:blank';
const DEFAULT_CAMPUS_HOME = BLANK_CAMPUS_HOME;
const {
  CAMPUS_PARTITION,
  NEUTRAL_CAMPUS_PARTITION,
  ROUTE_CAMPUS,
  ROUTE_DIRECT,
} = require('../../routing/policy/campus-route');
const { resolveDomainRouteForUrl } = require('../../routing/policy/domain-route-policy');
const { normalizeRuleHost } = require('../../routing/rules/routing-rule-store');
const { normalizeToolbarCommand } = require('../toolbar/campus-toolbar-contract');
const { projectWorkspaceGroups } = require('../workspace/campus-workspace-controller');
const { CertificateController } = require('../certificates/certificate-controller');
const { CredentialController } = require('../credentials/credential-controller');
const {
  RESOURCE_CATEGORIES,
  normalizePageFavoriteCandidate,
} = require('../../resources/schema/campus-resource-contract');
const {
  BrowserSessionManager,
  applyCampusSessionPolicy,
  campusProxyConfig,
  createMemoryRoutingPolicy,
  pacDataUrl,
} = require('./browser-session-manager');
const { DEFAULT_MAX_TABS, TabManager } = require('../tabs/tab-manager');
const { createT } = require('../../platform/i18n/i18n');
const TOOLBAR_HEIGHT = 108;
const FIND_BAR_HEIGHT = 34;
const SLOW_LOADING_HINT_MS = 10000;
const MAX_URL_LENGTH = 2048;
const MAX_WORKSPACE_HOME_RESOURCES = 64;
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

function workspaceHomeResources(value, t = createT('zh')) {
  if (!Array.isArray(value) || value.length > MAX_WORKSPACE_HOME_RESOURCES) {
    throw new TypeError('Campus Browser workspace resources are invalid');
  }
  const seenIds = new Set();
  const seenUrls = new Set();
  return Object.freeze(value.map((resource) => {
    if (!resource || typeof resource !== 'object' || Array.isArray(resource) ||
        typeof resource.id !== 'string' || !/^[a-z0-9-]{1,40}$/u.test(resource.id) ||
        typeof resource.name !== 'string' || !resource.name.trim() || resource.name.length > 80 ||
        /[\u0000-\u001f\u007f<>]/u.test(resource.name) ||
        typeof resource.description !== 'string' || resource.description.length > 160 ||
        /[\u0000-\u001f\u007f<>]/u.test(resource.description) ||
        ![ROUTE_CAMPUS, ROUTE_DIRECT].includes(resource.route) ||
        typeof resource.favorite !== 'boolean' ||
        (resource.lastOpenedAt !== null &&
          (!Number.isSafeInteger(resource.lastOpenedAt) || resource.lastOpenedAt <= 0))) {
      throw new TypeError('Campus Browser workspace resource is invalid');
    }
    const url = normalizeCampusUrl(resource.url, BLANK_CAMPUS_HOME, t);
    if (url === BLANK_CAMPUS_HOME || seenIds.has(resource.id) || seenUrls.has(url)) {
      throw new TypeError('Campus Browser workspace resources are duplicated');
    }
    seenIds.add(resource.id);
    seenUrls.add(url);
    return Object.freeze({
      id: resource.id,
      name: resource.name.trim(),
      description: resource.description,
      url,
      route: resource.route,
      category: RESOURCE_CATEGORIES.includes(resource.category)
        ? resource.category : 'custom',
      favorite: resource.favorite,
      lastOpenedAt: resource.lastOpenedAt,
    });
  }));
}

class CampusBrowser {
  constructor({
    BrowserWindow,
    WebContentsView,
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
      t: (key, vars) => this.t(key, vars),
      onError: (message) => this.onError?.(message),
    });
    this.window = null;
    this.view = null;
    // Only the active tab is attached to the native View hierarchy. Hiding a
    // WebContentsView stops painting, but Electron can still expose its page
    // through the platform accessibility tree. Detached views retain their
    // WebContents, history, cookies, and scroll state without being reachable
    // by VoiceOver/UI Automation until the tab is selected again.
    this.attachedView = null;
    this.tabManager = new TabManager({ maxTabs: MAX_TABS });
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
    // One-release compatibility for diagnostics/tests; ownership and mutation
    // live exclusively in CertificateController.
    this.certificateDecisions = this.certificateController.decisions;
    this.downloadSessions = new Set();
    // Authentication windows are intentionally kept as native children instead
    // of being flattened into tabs. Some IdPs complete SMS MFA through
    // window.opener/postMessage and window.close; preserving that relationship
    // is required for the opener to observe a successful challenge.
    this.managedCredentialPopups = new Set();
    this.downloadState = null;
    this.findOpen = false;
    this.lastFindQuery = '';
    this.scheduledLayout = null;
    this.scheduledToolbarUpdate = null;
    this.routingActivationInFlight = null;
    this.lastToolbarState = null;
  }

  // Keep the existing CampusBrowser diagnostics/test surface while all state
  // mutations flow through the dedicated managers.
  get tabs() { return this.tabManager.tabs; }
  get activeTabId() { return this.tabManager.activeTabId; }
  get nextTabId() { return this.tabManager.nextTabId; }
  get configuredPort() { return this.browserSessionManager.configuredPort; }
  get sessions() { return this.browserSessionManager.sessions; }
  get sessionKey() { return this.browserSessionManager.sessionKey; }
  get campusSession() { return this.browserSessionManager.campusSession; }
  get routingSuspended() { return this.browserSessionManager.suspended; }
  get routingRequestsBlocked() { return this.browserSessionManager.requestsBlocked; }

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

  workspaceResources() {
    try { return workspaceHomeResources(this.getWorkspaceResources(), this.t); }
    catch { return Object.freeze([]); }
  }

  workspaceGroups() {
    try { return projectWorkspaceGroups(this.getWorkspaceGroups()); }
    catch { return Object.freeze([]); }
  }

  bookmarkBarState() {
    const resources = this.workspaceResources();
    const favorites = resources.filter(({ favorite }) => favorite === true);
    const byId = new Map(favorites.map((resource) => [resource.id, resource]));
    const assigned = new Set();
    const officialId = this.profilePresentation.officialPortalResourceId;
    const groups = this.workspaceGroups().map((group) => {
      const children = group.resourceIds.filter((id) => id !== officialId)
        .map((id) => byId.get(id)).filter(Boolean)
        .map(({ id, name }) => Object.freeze({ id, name }));
      for (const child of children) assigned.add(child.id);
      return Object.freeze({ type: 'folder', id: group.id, name: group.name, children });
    }).filter(({ children }) => children.length > 0);
    const entries = [];
    const official = resources.find(({ id }) => id === officialId);
    if (official) {
      entries.push(Object.freeze({ type: 'bookmark', id: official.id, name: official.name, official: true }));
      assigned.add(official.id);
    }
    for (const { id, name } of favorites) {
      if (!assigned.has(id)) entries.push(Object.freeze({ type: 'bookmark', id, name, official: false }));
    }
    entries.push(...groups);
    return Object.freeze(entries);
  }

  refreshWorkspaceHomes() {
    if (!this.workspaceController) return;
    for (const tab of this.tabs) {
      if (tab.kind === 'workspace') this.workspaceController.sendState(tab.view.webContents);
    }
  }

  refreshCardBoardLayout(document) {
    if (!document || typeof document !== 'object' || document.schemaVersion !== 1) return false;
    let sent = false;
    for (const tab of this.tabs) {
      if (tab.kind !== 'workspace' || tab.view.webContents.isDestroyed?.()) continue;
      tab.view.webContents.send?.('card-board-layout-changed', document);
      sent = true;
    }
    return sent;
  }

  focusWorkspace(target = 'search', query = '') {
    if (!this.workspaceController) return false;
    let tab = this.activeTab();
    if (!tab || tab.kind !== 'workspace') {
      const existing = this.tabs.find((candidate) => candidate.kind === 'workspace');
      tab = existing || this.createTab(BLANK_CAMPUS_HOME, ROUTE_DIRECT);
      if (existing) this.switchTab(existing.id);
    }
    if (!tab || tab.view.webContents.isDestroyed()) return false;
    const focus = () => {
      if (typeof this.workspaceController.focus === 'function') {
        this.workspaceController.focus(tab.view.webContents, target, query);
      } else if (target === 'search') {
        this.workspaceController.focusSearch?.(tab.view.webContents);
      }
    };
    if (tab.loading) tab.pendingWorkspaceFocus = { target, query };
    else setImmediate(focus);
    return true;
  }

  focusWorkspaceSearch() { return this.focusWorkspace('search'); }

  focusAddressBar() {
    if (!this.window || this.window.isDestroyed()) return false;
    this.window.webContents.send?.('campus-toolbar-focus', 'address');
    return true;
  }

  beginNavigationIntent(tab = this.activeTab()) {
    if (!tab || tab.view.webContents.isDestroyed()) return null;
    tab.navigationIntent = (tab.navigationIntent || 0) + 1;
    return tab.navigationIntent;
  }

  navigationIntentCurrent(tab, intent) {
    return Number.isSafeInteger(intent) && this.tabManager.contains(tab) &&
      tab.navigationIntent === intent && !tab.view.webContents.isDestroyed();
  }

  async openHome() {
    if (this.homeUrl === BLANK_CAMPUS_HOME) {
      return this.focusWorkspaceSearch();
    }
    const active = this.activeTab();
    const intent = active ? this.beginNavigationIntent(active) : null;
    const port = this.configuredPort || 1080;
    const resolution = this.resolveRoute(this.homeUrl);
    if (!await this.ensureRoutingReady(resolution, port)) return false;
    if (active && !this.navigationIntentCurrent(active, intent)) return false;
    if (active && active.kind !== 'workspace') {
      return this.navigate(this.homeUrl, active);
    }
    return !!this.createTab(this.homeUrl);
  }

  openBlankTab() {
    return !!this.createTab(BLANK_CAMPUS_HOME, ROUTE_DIRECT, { blankPage: true });
  }

  async openNewTab() {
    let url;
    try { url = normalizeCampusUrl(this.getNewTabUrl(), BLANK_CAMPUS_HOME, this.t); }
    catch (error) {
      this.onError?.(error.message);
      return false;
    }
    if (url === BLANK_CAMPUS_HOME) return this.openBlankTab();
    const port = this.configuredPort || 1080;
    // The saved new-tab URL is a destination preference, not an implicit
    // routing override. Resolve it through the same policy that generates the
    // Session PAC so the toolbar can never claim Direct while Chromium is
    // actually using the fail-safe Campus default. Users can persist an exact
    // Direct choice through the routing-rule UI, where it becomes PAC input.
    const resolution = this.resolveRoute(url);
    if (!await this.ensureRoutingReady(resolution, port)) return false;
    return !!this.createTab(url);
  }

  async ensureRoutingReady(resolution, port = this.configuredPort || 1080) {
    if (!resolution || ![ROUTE_CAMPUS, ROUTE_DIRECT].includes(resolution.route)) return false;
    if (resolution.route === ROUTE_CAMPUS && !await this.ensureCampusReady()) return false;
    const activated = await this.activateRoutingPolicy(port);
    // A superseding suspend intent makes BrowserSessionManager activation
    // resolve null. Never start a navigation while its fail-closed gate remains
    // authoritative.
    return activated !== null && !this.routingSuspended && !this.routingRequestsBlocked;
  }

  async activateRoutingPolicy(port) {
    const value = Number(port);
    if (!this.routingSuspended && !this.routingRequestsBlocked &&
        this.configuredPort === value && this.campusSession) return this.campusSession;
    const current = this.routingActivationInFlight;
    if (current) {
      await current.promise;
      if (!this.routingSuspended && !this.routingRequestsBlocked &&
          this.configuredPort === value && this.campusSession) return this.campusSession;
    }
    const operation = this.routingSuspended
      ? this.resumeRoutingPolicy(value)
      : this.configure(value);
    const record = { port: value, promise: operation };
    this.routingActivationInFlight = record;
    try { return await operation; }
    finally {
      if (this.routingActivationInFlight === record) this.routingActivationInFlight = null;
    }
  }

  async navigateWhenReady(rawUrl, tab = this.activeTab()) {
    let url;
    try {
      url = normalizeCampusUrl(rawUrl, this.homeUrl, this.t);
    } catch (error) {
      this.onError?.(error.message);
      return false;
    }
    if (!tab || tab.view.webContents.isDestroyed()) return false;
    const intent = this.beginNavigationIntent(tab);
    const resolution = this.resolveRoute(url);
    if (!await this.ensureRoutingReady(resolution)) return false;
    if (!this.navigationIntentCurrent(tab, intent)) return false;
    if (tab.kind === 'workspace') return !!this.createTab(url);
    return this.navigate(url, tab);
  }

  async reloadWhenReady(tab = this.activeTab()) {
    if (!tab || tab.kind === 'workspace' || tab.view.webContents.isDestroyed()) return false;
    const url = tab.failedUrl || this.currentUrl(tab);
    if (!url || url === BLANK_CAMPUS_HOME) {
      tab.view.webContents.reload();
      return true;
    }
    const intent = this.beginNavigationIntent(tab);
    const resolution = this.resolveRoute(url);
    if (!await this.ensureRoutingReady(resolution)) return false;
    if (!this.navigationIntentCurrent(tab, intent)) return false;
    if (tab.failedUrl) return this.navigate(url, tab);
    tab.view.webContents.reload();
    return true;
  }

  pageFavoriteState(tab = this.activeTab()) {
    const url = this.currentUrl(tab);
    if (!tab || url === BLANK_CAMPUS_HOME || !this.onTogglePageFavorite) {
      return { canFavorite: false, favorite: false };
    }
    let canonical;
    try {
      canonical = normalizePageFavoriteCandidate({
        url,
        title: tab.view.webContents.getTitle?.() || '',
        route: tab.route || ROUTE_CAMPUS,
      }).url;
    } catch {
      return { canFavorite: false, favorite: false };
    }
    const resource = this.workspaceResources().find(({ url: resourceUrl }) => resourceUrl === canonical);
    return { canFavorite: true, favorite: resource?.favorite === true };
  }

  async toggleActivePageFavorite(tab = this.activeTab()) {
    const state = this.pageFavoriteState(tab);
    if (!state.canFavorite || !tab || !this.onTogglePageFavorite) return false;
    const result = await this.onTogglePageFavorite({
      url: this.currentUrl(tab),
      title: tab.view.webContents.getTitle?.() || '',
      route: tab.route || ROUTE_CAMPUS,
    });
    if (!result?.ok) {
      this.onError?.(result?.error || this.t('browser.favoriteFailed'));
      return false;
    }
    this.refreshWorkspaceHomes();
    this.updateToolbar();
    return true;
  }

  async decideCertificateTrust({ origin, fingerprint, error, certificate }) {
    return this.certificateController.promptAndTrust({ origin, fingerprint, error, certificate });
  }

  async handleCertificateError(request) {
    return this.certificateController.handle(request);
  }

  // Electron would otherwise silently drop downloads because the campus
  // sessions have no default download behavior wired to a dialog.
  applyDownloadHandler(routeSession) {
    if (typeof routeSession.on !== 'function' || this.downloadSessions.has(routeSession)) {
      return;
    }
    this.downloadSessions.add(routeSession);
    routeSession.on('will-download', (_event, item) => this.handleDownload(item));
  }

  handleDownload(item) {
    if (typeof item?.setSaveDialogOptions !== 'function') {
      try { item.cancel(); } catch {}
      return;
    }
    try {
      item.setSaveDialogOptions({ defaultPath: item.getFilename() });
      const filename = String(item.getFilename() || '').slice(0, 160);
      let finished = false;
      const updateProgress = () => {
        if (finished) return;
        const total = Number(item.getTotalBytes?.());
        const received = Number(item.getReceivedBytes?.());
        const percent = Number.isFinite(total) && total > 0 && Number.isFinite(received)
          ? Math.max(0, Math.min(100, Math.round(received * 100 / total))) : null;
        this.downloadState = Object.freeze({ filename, status: 'downloading', percent });
        this.scheduleToolbarUpdate();
      };
      item.on?.('updated', updateProgress);
      updateProgress();
      item.once('done', async (_event, state) => {
        if (finished) return;
        finished = true;
        item.removeListener?.('updated', updateProgress);
        if (state === 'cancelled') {
          this.downloadState = null;
          this.scheduleToolbarUpdate();
          return;
        }
        this.downloadState = Object.freeze({
          filename,
          status: state === 'completed' ? 'completed' : 'interrupted',
          percent: state === 'completed' ? 100 : null,
        });
        this.scheduleToolbarUpdate();
        if (state === 'interrupted' && this.onError) {
          this.onError(this.t('download.interrupted', { filename }));
        }
        if (state === 'completed' && typeof this.dialog?.showMessageBox === 'function') {
          try {
            const filePath = item.getSavePath?.();
            const prompt = await this.dialog.showMessageBox(this.window, {
              type: 'info',
              message: this.t('download.completed', { filename }),
              buttons: [this.t('download.showInFolder'), this.t('common.close')],
              defaultId: 0,
              cancelId: 1,
              noLink: true,
            });
            if (prompt.response === 0 && typeof filePath === 'string' && filePath) {
              this.showItemInFolder(filePath);
            }
          } catch {}
        }
      });
    } catch {
      try { item.cancel(); } catch {}
      if (this.onError) this.onError(this.t('download.noLocation'));
    }
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
    if (this.scheduledLayout === null) return;
    clearImmediate(this.scheduledLayout);
    this.scheduledLayout = null;
  }

  scheduleLayout() {
    if (this.scheduledLayout !== null || !this.window || this.window.isDestroyed()) return;
    const scheduledWindow = this.window;
    this.scheduledLayout = setImmediate(() => {
      this.scheduledLayout = null;
      if (this.window !== scheduledWindow || scheduledWindow.isDestroyed()) return;
      this.applyLayout();
    });
    this.scheduledLayout.unref?.();
  }

  applyLayout() {
    const active = this.activeTab();
    if (!this.window || this.window.isDestroyed() || !active) return;
    if (active.view.webContents.isDestroyed()) return;
    const [width, height] = this.window.getContentSize();
    const toolbarHeight = TOOLBAR_HEIGHT + (this.findOpen ? FIND_BAR_HEIGHT : 0);
    active.view.setBounds({
      x: 0,
      y: toolbarHeight,
      width: Math.max(1, width),
      height: Math.max(1, height - toolbarHeight),
    });
  }

  layout() {
    this.cancelScheduledLayout();
    this.applyLayout();
  }

  currentUrl(tab) {
    if (!tab) return '';
    if (tab.kind === 'workspace') return BLANK_CAMPUS_HOME;
    if (tab.failedUrl) return tab.failedUrl;
    if (tab.view.webContents.isDestroyed()) return '';
    try {
      const current = tab.view.webContents.getURL();
      return current.startsWith('data:') ? '' : current;
    } catch {
      return '';
    }
  }

  resolveRoute(rawUrl, inheritedRoute = null, requestedRoute = null) {
    if (rawUrl === BLANK_CAMPUS_HOME) {
      return { route: ROUTE_DIRECT, source: 'local-blank', matchedRule: null };
    }
    let resolution;
    try {
      resolution = this.routingPolicy.resolve(rawUrl, inheritedRoute);
    } catch {
      resolution = null;
    }
    if (!resolution || ![ROUTE_CAMPUS, ROUTE_DIRECT].includes(resolution.route)) {
      resolution = resolveDomainRouteForUrl(rawUrl, { inheritedRoute });
    }
    if (resolution.source === 'default' &&
        [ROUTE_CAMPUS, ROUTE_DIRECT].includes(requestedRoute)) {
      return { route: requestedRoute, source: 'requested', matchedRule: null };
    }
    return resolution;
  }

  updateTabRoute(tab, rawUrl = this.currentUrl(tab), requestedRoute = null) {
    if (!tab || !rawUrl) return null;
    const resolution = this.resolveRoute(rawUrl, null, requestedRoute);
    tab.route = resolution.route;
    tab.routeSource = resolution.source;
    tab.matchedRule = resolution.matchedRule;
    return resolution;
  }

  updateAllTabRoutes() {
    for (const tab of this.tabs) {
      const url = tab.failedUrl || this.currentUrl(tab);
      if (url) this.updateTabRoute(tab, url);
    }
  }

  cancelScheduledToolbarUpdate() {
    if (this.scheduledToolbarUpdate === null) return;
    clearImmediate(this.scheduledToolbarUpdate);
    this.scheduledToolbarUpdate = null;
  }

  scheduleToolbarUpdate() {
    if (this.scheduledToolbarUpdate !== null ||
        !this.window || this.window.isDestroyed()) return;
    const scheduledWindow = this.window;
    this.scheduledToolbarUpdate = setImmediate(() => {
      this.scheduledToolbarUpdate = null;
      if (this.window !== scheduledWindow || scheduledWindow.isDestroyed()) return;
      this.sendToolbarState();
    });
    this.scheduledToolbarUpdate.unref?.();
  }

  cancelScheduledUpdates() {
    this.cancelScheduledLayout();
    this.cancelScheduledToolbarUpdate();
  }

  sendToolbarState() {
    if (!this.window || this.window.isDestroyed()) return;
    const active = this.activeTab();
    // A crashed or closed renderer (e.g. the page died while the slow-load
    // timer was pending) must not take the main process down with it.
    if (active && active.view.webContents.isDestroyed()) return;
    const activeTitle = active?.view.webContents.getTitle() || '';
    const navigation = navigationForContents(active?.view.webContents);
    const state = {
      url: this.currentUrl(active),
      title: activeTitle,
      loading: !!active?.loading,
      loadingLabel: active?.loading ? active.loadingLabel || '' : '',
      slow: !!active?.slow,
      findOpen: this.findOpen,
      route: active?.route || ROUTE_CAMPUS,
      routeSource: active?.routeSource || 'default',
      routeLabel: active?.route === ROUTE_DIRECT ? this.t('route.direct') : this.t('route.campus'),
      canGoBack: !!active && navigation.canGoBack(),
      canGoForward: !!active && navigation.canGoForward(),
      activeTabId: this.activeTabId,
      tabs: this.tabs.map((tab) => ({
        id: tab.id,
        title: tab.view.webContents.isDestroyed()
          ? this.t('tab.new')
          : tab.view.webContents.getTitle() || tab.loadingLabel || this.t('tab.new'),
        loading: tab.loading,
        route: tab.route,
      })),
      download: this.downloadState,
      workspace: active?.kind === 'workspace',
      bookmarks: this.bookmarkBarState(),
      ...this.pageFavoriteState(active),
    };
    const serialized = JSON.stringify(state);
    if (serialized === this.lastToolbarState) return;
    const send = this.window.webContents?.send;
    if (typeof send !== 'function') return;
    try {
      send.call(this.window.webContents, 'campus-toolbar-state', state);
      this.lastToolbarState = serialized;
    } catch {
      // Window teardown can race the final page event. The closed handler also
      // cancels future updates, so there is nothing useful to surface here.
    }
  }

  updateToolbar() {
    this.cancelScheduledToolbarUpdate();
    this.sendToolbarState();
  }

  handleToolbarCommand(input) {
    const normalized = input && typeof input === 'object'
      ? normalizeToolbarCommand(input.command, input.value)
      : null;
    if (!normalized) return false;
    const { command, value } = normalized;
    const active = this.activeTab();
    const navigation = navigationForContents(active?.view.webContents);

    if (command === 'new-tab') {
      Promise.resolve(this.openNewTab()).catch(() => this.onError?.(this.t('tab.createFailed')));
    }
    else if (command === 'home') {
      Promise.resolve(this.openHome()).catch(() => this.onError?.(this.t('tab.createFailed')));
    }
    else if (command === 'manage-bookmarks') this.focusWorkspace('manage');
    else if (command === 'open-bookmark-menu' && this.showBookmarkMenu) {
      this.showBookmarkMenu(this.bookmarkBarState());
    }
    else if (command === 'open-bookmark-folder' && this.showBookmarkMenu) {
      const folder = this.bookmarkBarState().find(({ type, id }) => type === 'folder' && id === value);
      if (folder) this.showBookmarkMenu(folder.children);
    }
    else if (command === 'open-resource' && this.onOpenResource) {
      Promise.resolve(this.onOpenResource(value)).then(() => this.updateToolbar()).catch((error) => {
        this.onError?.(error?.message || this.t('browser.favoriteFailed'));
      });
    }
    else if (command === 'switch-tab') this.switchTab(Number(value));
    else if (command === 'close-tab') this.closeTab(Number(value));
    else if (command === 'set-route' && active) {
      this.setTabRoute(active.id, value).catch((error) => {
        if (this.onError) this.onError(this.t('route.switchFailed', { message: error.message }));
      });
    }
    else if (command === 'manage-credential' && active) {
      this.manageCredential(active);
    }
    else if (command === 'open-settings') this.onOpenSettings();
    else if (command === 'toggle-favorite' && active) {
      this.toggleActivePageFavorite(active).catch((error) => {
        this.onError?.(error.message || this.t('browser.favoriteFailed'));
      });
    }
    else if (command === 'focus-workspace') {
      this.focusWorkspaceSearch();
    }
    else if (command === 'back' && navigation.canGoBack()) {
      this.beginNavigationIntent(active);
      navigation.goBack();
    } else if (command === 'forward' && navigation.canGoForward()) {
      this.beginNavigationIntent(active);
      navigation.goForward();
    } else if (command === 'reload' && active) {
      Promise.resolve(this.reloadWhenReady(active)).catch((error) => {
        this.onError?.(error?.message || this.t('error.connectTimeout'));
      });
    } else if (command === 'navigate' && active) {
      const query = workspaceSearchQuery(value);
      if (query) this.focusWorkspace('search', query);
      else Promise.resolve(this.navigateWhenReady(value, active)).catch((error) => {
        this.onError?.(error?.message || this.t('error.connectTimeout'));
      });
    } else if (command === 'find-open') {
      this.setFindBar(true);
    } else if (command === 'find-close') {
      this.setFindBar(false);
    } else if (command === 'find' && active) {
      this.lastFindQuery = value;
      const contents = active.view.webContents;
      if (contents.isDestroyed()) return;
      if (value && typeof contents.findInPage === 'function') contents.findInPage(value);
      if (!value && typeof contents.stopFindInPage === 'function') {
        contents.stopFindInPage('clearSelection');
      }
    } else if ((command === 'find-next' || command === 'find-prev') &&
               active && this.lastFindQuery &&
               !active.view.webContents.isDestroyed() &&
               typeof active.view.webContents.findInPage === 'function') {
      active.view.webContents.findInPage(this.lastFindQuery, {
        forward: command === 'find-next',
        findNext: true,
      });
    }
    return true;
  }

  // The find bar is per-window: it stays open across tab switches, but matches
  // are per-tab, so a switched-to tab has no active find until the next search.
  setFindBar(open) {
    if (!this.window || this.window.isDestroyed()) return;
    this.findOpen = !!open;
    this.layout();
    this.updateToolbar();
    if (open) {
      this.window.webContents.send?.('campus-toolbar-focus', 'find');
      return;
    }
    const active = this.activeTab();
    if (active && !active.view.webContents.isDestroyed()) {
      if (typeof active.view.webContents.stopFindInPage === 'function') {
        active.view.webContents.stopFindInPage('clearSelection');
      }
      active.view.webContents.focus();
    }
  }

  clearSlowTimer(tab) {
    if (tab.slowTimer) {
      clearTimeout(tab.slowTimer);
      tab.slowTimer = null;
    }
    tab.slow = false;
  }

  windowOpenResponse(tab, url) {
    if (!safePopupUrl(url)) return { action: 'deny' };
    const credentialReservation = this.credentialController.reservePopup(tab);
    if (credentialReservation) {
      return {
        action: 'allow',
        outlivesOpener: false,
        createWindow: (options) => this.createManagedCredentialPopup(
          options,
          credentialReservation,
        ),
      };
    }
    setImmediate(() => {
      try { this.createTab(url, this.resolveRoute(url).route); }
      catch { this.onError?.(this.t('tab.createFailed')); }
    });
    return { action: 'deny' };
  }

  createManagedCredentialPopup(options, credentialReservation) {
    const targetWindow = this.window;
    const routeSession = this.browserSessionManager.sessionForRoute(ROUTE_CAMPUS);
    if (!targetWindow || targetWindow.isDestroyed() || !routeSession) {
      this.credentialController.releasePopup(credentialReservation);
      throw new Error('campus browser unavailable during authentication popup creation');
    }

    let popupWindow = null;
    let popup = null;
    try {
      popupWindow = new this.BrowserWindow({
        ...(options && typeof options === 'object' ? options : {}),
        parent: targetWindow,
        show: true,
        minWidth: 420,
        minHeight: 360,
        backgroundColor: '#f7f9fc',
        autoHideMenuBar: true,
        webPreferences: {
          ...(options?.webPreferences || {}),
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
      popup = {
        window: popupWindow,
        view: { webContents: popupWindow.webContents },
        pendingCredential: null,
        pendingCredentialTimer: null,
      };
      if (!this.credentialController.linkPopup(credentialReservation, popup)) {
        throw new Error('authentication popup lost its credential flow');
      }
      this.managedCredentialPopups.add(popup);
      this.attachManagedCredentialPopupEvents(popup);
      popupWindow.setMenuBarVisibility?.(false);
      return popupWindow.webContents;
    } catch (error) {
      if (popup) {
        this.managedCredentialPopups.delete(popup);
        this.credentialController.closeTab(popup);
      }
      else this.credentialController.releasePopup(credentialReservation);
      try {
        if (popupWindow && !popupWindow.isDestroyed()) popupWindow.close();
      } catch {}
      this.onError?.(this.t('tab.createFailed'));
      throw error;
    }
  }

  attachManagedCredentialPopupEvents(popup) {
    const popupWindow = popup.window;
    const contents = popup.view.webContents;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      this.managedCredentialPopups.delete(popup);
      this.credentialController.closeTab(popup);
    };
    const rejectNonWebNavigation = (event, url) => {
      if (!safePopupUrl(url)) event?.preventDefault?.();
    };
    contents.setWindowOpenHandler(({ url }) => this.windowOpenResponse(popup, url));
    contents.on('will-navigate', rejectNonWebNavigation);
    contents.on('will-redirect', rejectNonWebNavigation);
    contents.on('did-navigate', (_event, url, httpResponseCode = 0) => {
      this.markCredentialNavigation(popup, url, httpResponseCode);
      this.recordPortalSessionUrl(url);
    });
    contents.on('did-navigate-in-page', (_event, url) => this.recordPortalSessionUrl(url));
    contents.on('ipc-message', (_event, channel, candidate) => {
      if (channel === 'campus-credential-candidate') {
        this.credentialController.stage(popup, candidate);
      } else if (channel === 'campus-credential-page-state') {
        this.credentialController.confirmPageState(popup, candidate).catch(() => {});
      }
    });
    contents.on('render-process-gone', (_event, details = {}) => {
      if (details.reason !== 'clean-exit') this.credentialController.clear(popup);
      try { if (!popupWindow.isDestroyed()) popupWindow.close(); } catch {}
    });
    contents.once('destroyed', cleanup);
    popupWindow.once('closed', cleanup);
  }

  attachPageEvents(tab) {
    const contents = tab.view.webContents;
    contents.setWindowOpenHandler(({ url }) => this.windowOpenResponse(tab, url));
    const rejectNonWebNavigation = (event, url) => {
      if (!safePopupUrl(url)) event?.preventDefault?.();
    };
    // A compromised campus page cannot turn this isolated WebContents into a
    // file/custom-protocol reader. Cover both script/user navigations and HTTP
    // redirects; regular HTTP(S), fragment, and history navigation remain.
    contents.on('will-navigate', rejectNonWebNavigation);
    contents.on('will-redirect', rejectNonWebNavigation);
    contents.on('did-start-loading', () => {
      tab.loading = true;
      if (!tab.loadingLabel) {
        try { tab.loadingLabel = new URL(this.currentUrl(tab)).hostname; } catch { tab.loadingLabel = ''; }
      }
      if (!tab.renderingError) tab.failedUrl = '';
      this.clearSlowTimer(tab);
      tab.slowTimer = setTimeout(() => {
        tab.slowTimer = null;
        tab.slow = true;
        this.scheduleToolbarUpdate();
      }, SLOW_LOADING_HINT_MS);
      tab.slowTimer.unref?.();
      this.scheduleToolbarUpdate();
    });
    contents.on('did-stop-loading', () => {
      tab.loading = false;
      tab.loadingLabel = '';
      tab.renderingError = false;
      this.clearSlowTimer(tab);
      this.scheduleToolbarUpdate();
    });
    contents.on('dom-ready', () => {
      this.fillSharedPortalCredential(tab).catch(() => {});
    });
    contents.on('did-navigate', (_event, url, httpResponseCode = 0) => {
      if (tab.kind === 'blank' && url !== BLANK_CAMPUS_HOME) delete tab.kind;
      this.markCredentialNavigation(tab, url, httpResponseCode);
      this.updateTabRoute(tab, url);
      this.recordPortalSessionUrl(url);
      try {
        if (new URL(url).origin === new URL(this.homeUrl).origin) {
          tab.sharedCredentialAttemptedOrigin = '';
        }
      } catch {}
      if (this.onRecordPageOpen) {
        Promise.resolve(this.onRecordPageOpen(url)).then((changed) => {
          if (changed) this.refreshWorkspaceHomes();
        }).catch(() => {});
      }
      this.scheduleToolbarUpdate();
    });
    contents.on('did-navigate-in-page', (_event, url) => {
      this.recordPortalSessionUrl(url);
      this.scheduleToolbarUpdate();
    });
    contents.on('page-title-updated', () => this.scheduleToolbarUpdate());
    // Provisional failures (DNS, reset, timeout before the page commits) do not
    // fire did-fail-load; without this handler the tab stayed blank and the
    // failed URL was lost, so a route switch silently fell back to the school
    // home page instead of retrying the site the user asked for.
    const handleLoadFailure = (_event, code, description, failedUrl, isMainFrame) => {
      if (!isMainFrame || code === -3 || !safePopupUrl(failedUrl)) return;
      tab.loading = false;
      tab.failedUrl = failedUrl;
      tab.renderingError = true;
      this.clearCredentialCandidate(tab);
      this.clearSlowTimer(tab);
      contents.loadURL(errorPage(failedUrl, description, this.t, tab.route)).catch(() => {});
      this.scheduleToolbarUpdate();
    };
    contents.on('did-fail-load', handleLoadFailure);
    contents.on('did-fail-provisional-load', handleLoadFailure);
    contents.on('ipc-message', (_event, channel, candidate) => {
      if (channel === 'campus-credential-candidate') {
        this.credentialController.stage(tab, candidate);
      } else if (channel === 'campus-credential-page-state') {
        this.credentialController.confirmPageState(tab, candidate).catch(() => {});
      }
    });
    contents.on('render-process-gone', (_event, details) => {
      this.handleRendererCrash(tab, details);
    });
    contents.on('before-input-event', (event, input) => {
      const commandKey = process.platform === 'darwin' ? input.meta : input.control;
      const key = String(input.key || '').toLowerCase();
      const navigation = navigationForContents(contents);
      if (commandKey && key === 't') {
        event.preventDefault();
        Promise.resolve(this.openNewTab())
          .catch(() => this.onError?.(this.t('tab.createFailed')));
      } else if (commandKey && key === 'w') {
        event.preventDefault();
        this.closeTab(tab.id);
      } else if (commandKey && key === 'l') {
        event.preventDefault();
        this.window?.webContents.send?.('campus-toolbar-focus', 'address');
      } else if (commandKey && key === 'k' && input.type === 'keyDown') {
        event.preventDefault();
        this.focusWorkspaceSearch();
      } else if (commandKey && key === 'r') {
        event.preventDefault();
        Promise.resolve(this.reloadWhenReady(tab)).catch((error) => {
          this.onError?.(error?.message || this.t('error.connectTimeout'));
        });
      } else if (commandKey && key === 'f' && input.type === 'keyDown') {
        event.preventDefault();
        this.setFindBar(true);
      } else if (commandKey && ['=', '+', '-', '0'].includes(key) &&
                 input.type === 'keyDown') {
        event.preventDefault();
        contents.setZoomFactor(nextZoomFactor(contents.getZoomFactor(), key));
      } else if (input.alt && ['left', 'arrowleft'].includes(key) && navigation.canGoBack()) {
        event.preventDefault();
        navigation.goBack();
      } else if (input.alt && ['right', 'arrowright'].includes(key) && navigation.canGoForward()) {
        event.preventDefault();
        navigation.goForward();
      } else if (commandKey && /^[1-9]$/.test(key)) {
        event.preventDefault();
        const index = key === '9' ? this.tabs.length - 1 : Number(key) - 1;
        const selected = this.tabManager.at(index);
        if (selected) this.switchTab(selected.id);
      }
    });
  }

  tabOrigin(tab) {
    if (!tab || tab.view.webContents.isDestroyed()) return '';
    try {
      const parsed = new URL(tab.view.webContents.getURL());
      return parsed.protocol === 'https:' ? parsed.origin : '';
    } catch {
      return '';
    }
  }

  recordPortalSessionUrl(rawUrl) {
    try {
      const value = new URL(rawUrl);
      const portal = new URL(this.homeUrl);
      if (value.protocol !== 'https:' || value.origin !== portal.origin ||
          value.username || value.password || value.href.length > 2_048) return false;
      return this.onPortalSessionUrl(value.href) === true;
    } catch { return false; }
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
    if (!tab || !this.tabManager.contains(tab) || tab.view.webContents.isDestroyed() ||
        details.reason === 'clean-exit') return;
    this.certificateController.cancelAll();
    const contents = tab.view.webContents;
    const failedUrl = this.currentUrl(tab) || this.homeUrl;
    const reason = String(details.reason || 'crashed').slice(0, 80);
    tab.loading = false;
    tab.failedUrl = safePopupUrl(failedUrl) ? failedUrl : this.homeUrl;
    tab.renderingError = true;
    tab.crashed = true;
    this.clearCredentialCandidate(tab);
    this.clearSlowTimer(tab);
    contents.loadURL(errorPage(
      tab.failedUrl,
      this.t('errorPage.rendererCrash', { reason }),
      this.t,
      tab.route,
    )).catch(() => {
      if (this.onError) this.onError(this.t('errorPage.rendererCrash', { reason }));
    });
    this.scheduleToolbarUpdate();
  }

  async manageCredential(tab) {
    if (!this.credentialVault || !this.dialog) return;
    const origin = this.tabOrigin(tab);
    if (!origin) {
      if (this.onError) this.onError(this.t('cred.httpsOnly'));
      return;
    }
    try {
      const credential = await this.credentialVault.get(origin);
      if (!this.window || this.window.isDestroyed()) return;
      if (!credential) {
        await this.dialog.showMessageBox(this.window, {
          type: 'info',
          title: this.t('cred.title'),
          message: this.t('cred.noneMessage', { host: new URL(origin).hostname }),
          detail: this.t('cred.noneDetail'),
          buttons: [this.t('cred.ok')],
          noLink: true,
        });
        return;
      }
      const result = await this.dialog.showMessageBox(this.window, {
        type: 'question',
        title: this.t('cred.title'),
        message: this.t('cred.hasMessage', { host: new URL(origin).hostname }),
        detail: this.t('cred.hasDetail'),
        buttons: [this.t('cred.fill'), this.t('cred.delete'), this.t('common.cancel')],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      });
      if (result.response === 0 && !tab.view.webContents.isDestroyed()) {
        tab.view.webContents.send('campus-credential-fill', credential);
      } else if (result.response === 1) {
        await this.credentialVault.remove(origin);
      }
    } catch {
      if (this.onError) this.onError(this.t('cred.readFailed'));
    }
  }

  async fillSharedPortalCredential(tab) {
    if (!tab?.view?.webContents || tab.view.webContents.isDestroyed?.()) return false;
    const origin = this.tabOrigin(tab);
    if (!origin || tab.sharedCredentialAttemptedOrigin === origin) return false;
    let owner = null;
    try { owner = await Promise.resolve(this.getSharedPortalCredential(origin)); }
    catch { return false; }
    if (!owner || typeof owner.withStrings !== 'function' || typeof owner.destroy !== 'function') {
      owner?.destroy?.();
      return false;
    }
    tab.sharedCredentialAttemptedOrigin = origin;
    try {
      return owner.withStrings((username, password) => {
        if (tab.view.webContents.isDestroyed?.()) return false;
        tab.view.webContents.send('campus-credential-fill', {
          origin,
          username,
          password,
          source: 'connection-credential',
          autoSubmit: true,
        });
        return true;
      }) === true;
    } finally {
      owner.destroy();
    }
  }

  createTab(rawUrl = null, route = null, options = {}) {
    if (!this.window || this.window.isDestroyed()) return null;
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
    const previousActiveId = this.tabManager.activeTabId;
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
        loading: url !== BLANK_CAMPUS_HOME,
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
      this.credentialController.linkPopup(options.credentialReservation, tab);
      this.tabManager.add(tab);
      added = true;
      // Keep the new renderer detached until switchTab has applied its bounds.
      // This prevents both a paint flash and an inactive page entering the
      // native accessibility tree.
      view.setVisible(false);
      if (this.window !== targetWindow || targetWindow.isDestroyed()) {
        throw new Error('campus browser window closed during tab creation');
      }
      this.attachPageEvents(tab);
      if (!this.switchTab(tab.id) || !this.navigate(url, tab, route)) {
        throw new Error('campus browser tab activation failed');
      }
      return tab;
    } catch {
      if (tab) this.credentialController.closeTab(tab);
      else this.credentialController.releasePopup(options.credentialReservation);
      if (added) this.tabManager.remove(tab.id);
      if (this.attachedView === view) {
        try { targetWindow.contentView.removeChildView(view); } catch {}
        this.attachedView = null;
      }
      try {
        if (view?.webContents && !view.webContents.isDestroyed()) view.webContents.close();
      } catch {}
      const previous = previousActiveId === null ? null : this.tabManager.select(previousActiveId);
      this.view = previous?.view || null;
      if (previous && this.window === targetWindow && !targetWindow.isDestroyed()) {
        try { this.switchTab(previous.id); } catch {}
        this.scheduleToolbarUpdate();
      }
      if (this.onError) this.onError(this.t('tab.createFailed'));
      return null;
    }
  }

  createWorkspaceTab() {
    if (!this.workspaceController || !this.window || this.window.isDestroyed()) return null;
    const existing = this.tabs.find((tab) => tab.kind === 'workspace');
    if (existing) { this.switchTab(existing.id); this.workspaceController.sendState(existing.view.webContents); return existing; }
    if (!this.tabManager.canAdd()) {
      this.onError?.(this.t('tab.limit', { count: MAX_TABS }));
      return null;
    }
    const routeSession = this.browserSessionManager.sessionForRoute(ROUTE_CAMPUS);
    if (!routeSession) return null;
    const previousActiveId = this.tabManager.activeTabId;
    let view;
    let tab;
    try {
      view = this.workspaceController.createView(this.WebContentsView, routeSession);
      tab = {
        kind: 'workspace', view, failedUrl: '', loading: true, slow: false,
        slowTimer: null, renderingError: false, crashed: false,
        pendingCredential: null, pendingCredentialTimer: null,
        route: ROUTE_DIRECT, routeSource: 'local-workspace', matchedRule: null,
        pendingWorkspaceFocus: null,
      };
      this.tabManager.add(tab);
      view.setVisible(false);
      if (!this.switchTab(tab.id)) throw new Error('workspace activation failed');
      this.workspaceController.load(view).then(() => {
        tab.loading = false;
        this.workspaceController.sendState(view.webContents);
        if (tab.pendingWorkspaceFocus) {
          const { target, query } = tab.pendingWorkspaceFocus;
          tab.pendingWorkspaceFocus = null;
          if (typeof this.workspaceController.focus === 'function') {
            this.workspaceController.focus(view.webContents, target, query);
          } else if (target === 'search') {
            this.workspaceController.focusSearch?.(view.webContents);
          }
        }
        this.updateToolbar();
      }).catch(() => this.onError?.(this.t('tab.createFailed')));
      view.webContents.on('render-process-gone', () => {
        if (!view.webContents.isDestroyed()) this.workspaceController.load(view).catch(() => {});
      });
      return tab;
    } catch {
      if (tab) this.tabManager.remove(tab.id);
      if (this.attachedView === view) {
        try { this.window.contentView.removeChildView(view); } catch {}
        this.attachedView = null;
      }
      try { if (view?.webContents && !view.webContents.isDestroyed()) view.webContents.close(); } catch {}
      const previous = previousActiveId === null ? null : this.tabManager.select(previousActiveId);
      this.view = previous?.view || null;
      if (previous && this.window && !this.window.isDestroyed()) {
        try { this.switchTab(previous.id); } catch {}
      }
      this.onError?.(this.t('tab.createFailed'));
      return null;
    }
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

  switchTab(id) {
    const selected = this.tabManager.find(id);
    if (!selected) return false;
    const previous = this.activeTab();
    const previousView = this.attachedView;
    if (!this.window || this.window.isDestroyed() || selected.view.webContents.isDestroyed()) {
      return false;
    }
    try {
      if (previous && previous.id !== selected.id) this.beginNavigationIntent(previous);
      if (previousView && previousView !== selected.view) {
        previousView.setVisible(false);
        this.window.contentView.removeChildView(previousView);
        this.attachedView = null;
      }
      const [width, height] = this.window.getContentSize();
      const toolbarHeight = TOOLBAR_HEIGHT + (this.findOpen ? FIND_BAR_HEIGHT : 0);
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
      this.tabManager.select(selected.id);
      this.view = selected.view;
      this.scheduleToolbarUpdate();
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
          this.tabManager.select(previous.id);
          this.view = previous.view;
          this.layout();
        } catch {}
      }
      return false;
    }
  }

  closeTab(id) {
    const removal = this.tabManager.remove(id);
    if (!removal) return false;
    this.cancelScheduledUpdates();
    this.certificateController.cancelAll();
    const { tab, replacement, empty } = removal;
    this.clearSlowTimer(tab);
    this.credentialController.closeTab(tab);
    if (this.attachedView === tab.view) {
      this.window.contentView.removeChildView(tab.view);
      this.attachedView = null;
    }
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();

    if (empty) {
      this.view = null;
      Promise.resolve(this.openNewTab())
        .catch(() => this.onError?.(this.t('tab.createFailed')));
    } else if (replacement) {
      this.switchTab(replacement.id);
    } else {
      this.scheduleToolbarUpdate();
    }
    return true;
  }

  async createWindow() {
    this.cancelScheduledUpdates();
    this.lastToolbarState = null;
    this.window = new this.BrowserWindow({
      width: 1040,
      height: 740,
      minWidth: 660,
      minHeight: 460,
      title: this.t('browser.windowTitleForSchool', {
        school: this.profilePresentation.schoolName,
        trust: this.profilePresentation.unverified ? this.t('browser.unverifiedSuffix') : '',
      }),
      backgroundColor: '#f7f9fc',
      autoHideMenuBar: true,
      ...campusWindowChrome(process.platform),
      parent: process.platform === 'darwin' ? undefined : this.parentWindow(),
      webPreferences: {
        preload: this.toolbarPreload,
        devTools: false,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        safeDialogs: true,
      },
    });
    await this.window.loadFile(this.toolbarFile, { query: {
      lang: this.locale,
      school: this.profilePresentation.schoolName,
      unverified: this.profilePresentation.unverified ? '1' : '0',
    } });
    this.window.webContents.on('ipc-message', (_event, channel, payload) => {
      if (channel === 'campus-toolbar-command') this.handleToolbarCommand(payload);
    });
    this.window.on('resize', () => this.scheduleLayout());
    this.window.on('closed', () => {
      this.cancelScheduledUpdates();
      this.certificateController.cancelAll();
      for (const tab of this.tabs) {
        this.clearSlowTimer(tab);
        this.clearCredentialCandidate(tab);
        if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
      }
      for (const popup of [...this.managedCredentialPopups]) {
        this.credentialController.closeTab(popup);
        try {
          if (!popup.window.isDestroyed()) popup.window.close();
        } catch {}
      }
      this.managedCredentialPopups.clear();
      this.tabManager.clear();
      this.view = null;
      this.attachedView = null;
      this.routingActivationInFlight = null;
      this.window = null;
      this.findOpen = false;
      this.lastToolbarState = null;
    });
  }

  navigate(rawUrl, tab = this.activeTab(), requestedRoute = null) {
    let url;
    try {
      url = normalizeCampusUrl(rawUrl, this.homeUrl, this.t);
    } catch (error) {
      if (this.onError) this.onError(error.message);
      return false;
    }
    if (!tab || tab.view.webContents.isDestroyed()) return false;
    // `open()` may carry a route already resolved from the active Profile or
    // an ID-only WebResource. Keep that decision through the first load when
    // the generic policy has no matching rule; later user navigation resolves
    // afresh from the live Profile-backed policy.
    this.updateTabRoute(tab, url, requestedRoute);
    tab.failedUrl = '';
    tab.renderingError = false;
    tab.crashed = false;
    const loading = tab.view.webContents.loadURL(url);
    loading.catch(() => {
      // did-fail-load renders a local error page. A superseded navigation can
      // reject this promise even though the newer page loaded successfully.
    });
    this.scheduleToolbarUpdate();
    return true;
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
    if (!this.window || this.window.isDestroyed()) await this.createWindow();

    if (this.window.isMinimized()) this.window.restore();
    this.window.show();
    this.window.focus();
    if (url === BLANK_CAMPUS_HOME) {
      const existing = this.tabs.find((tab) => tab.kind === 'workspace');
      if (existing) {
        this.switchTab(existing.id);
        this.workspaceController.sendState(existing.view.webContents);
      } else {
        this.createTab(url, ROUTE_DIRECT);
      }
    } else {
      this.createTab(url, resolution.route, { displayName: options.displayName || '' });
    }
    return url;
  }

  async openWorkspace(port) {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
      throw new TypeError('Campus Workspace port is invalid');
    }
    if (!this.configuredPort && !this.routingSuspended) await this.configure(port);
    if (!this.window || this.window.isDestroyed()) await this.createWindow();
    if (this.window.isMinimized()) this.window.restore();
    this.window.show();
    this.window.focus();
    const existing = this.tabs.find((tab) => tab.kind === 'workspace');
    if (existing) {
      this.switchTab(existing.id);
      this.workspaceController.sendState(existing.view.webContents);
    } else {
      this.createWorkspaceTab();
    }
    return BLANK_CAMPUS_HOME;
  }

  close() {
    this.cancelScheduledUpdates();
    this.certificateController.cancelAll();
    if (this.window && !this.window.isDestroyed()) {
      this.window.close();
      return;
    }
    for (const tab of this.tabs) {
      this.clearSlowTimer(tab);
      this.clearCredentialCandidate(tab);
    }
    this.window = null;
    this.view = null;
    this.attachedView = null;
    this.routingActivationInFlight = null;
    this.tabManager.clear();
    this.findOpen = false;
    this.lastToolbarState = null;
  }

  closeForContextSwitch({ timeoutMs = 5_000, setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000 ||
        typeof setTimeoutFn !== 'function' || typeof clearTimeoutFn !== 'function') {
      return Promise.reject(new TypeError('Campus Browser close deadline is invalid'));
    }
    const window = this.window;
    if (!window || window.isDestroyed()) {
      this.close();
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = (closed) => {
        if (settled) return;
        settled = true;
        clearTimeoutFn(timer);
        resolve(closed);
      };
      window.once('closed', () => finish(true));
      timer = setTimeoutFn(() => finish(false), timeoutMs);
      timer?.unref?.();
      try { window.close(); }
      catch { finish(false); }
    });
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
