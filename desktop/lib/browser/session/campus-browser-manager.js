'use strict';

const { BLANK_CAMPUS_HOME, CampusBrowser, normalizeCampusUrl } = require('./campus-browser');
const { ROUTE_CAMPUS, ROUTE_DIRECT, routeForUrl } = require('../../routing/policy/campus-route');
const { CampusCredentialVault } = require('../credentials/campus-credential-vault');
const { CampusWorkspaceController } = require('../workspace/campus-workspace-controller');
const { BrowserRequestSecurityBoundary, CampusCertificateTrustStore } =
  require('../certificates/certificate-controller');

function normalizeOpenRequest(input, t, fallback) {
  const source = input && typeof input === 'object' ? input : { url: input };
  const url = normalizeCampusUrl(source.url, fallback, t);
  const route = url === BLANK_CAMPUS_HOME
    ? ROUTE_DIRECT
    : [ROUTE_CAMPUS, ROUTE_DIRECT].includes(source.route)
    ? source.route
    : routeForUrl(url);
  let displayName = '';
  if (source.displayName != null) {
    if (typeof source.displayName !== 'string' || !source.displayName.trim() ||
        source.displayName.trim().length > 96 || /[\u0000-\u001f\u007f<>]/u.test(source.displayName)) {
      throw new TypeError('Campus Browser display name is invalid');
    }
    displayName = source.displayName.trim();
  }
  return displayName ? { url, route, displayName } : { url, route };
}

function requiresCampusTunnel(route) {
  return route !== ROUTE_DIRECT;
}

function browserProfilePresentation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.schoolName !== 'string' || !value.schoolName.trim() ||
      value.schoolName.length > 160 || /[\u0000-\u001f\u007f<>]/u.test(value.schoolName) ||
      typeof value.unverified !== 'boolean' ||
      (value.officialPortalResourceId != null &&
       (typeof value.officialPortalResourceId !== 'string' ||
        !/^[a-z0-9-]{1,40}$/u.test(value.officialPortalResourceId)))) {
    throw new TypeError('Campus Browser Profile presentation is invalid');
  }
  return Object.freeze({
    schoolName: value.schoolName.trim(),
    unverified: value.unverified,
    officialPortalResourceId: value.officialPortalResourceId || null,
  });
}

function officialPortalHomeUrl(profile, resources) {
  const presentation = browserProfilePresentation(profile);
  if (!presentation.officialPortalResourceId) return null;
  if (!Array.isArray(resources) || resources.length > 64) {
    throw new TypeError('Campus Browser resource library is invalid');
  }
  const portal = resources.find(({ id }) => id === presentation.officialPortalResourceId);
  if (!portal || typeof portal.url !== 'string' || !portal.url) return null;
  return portal.url;
}

class CampusBrowserWindowOwner {
  constructor({
    BrowserWindow,
    toolbarFile,
    toolbarPreload,
    getProfilePresentation,
    getLocale,
    getTranslator,
    parentWindow,
    platform,
    windowChrome,
    onToolbarCommand,
    onResize,
    onBeforeCreate = () => {},
    onClosed,
    onMissingWindow,
  } = {}) {
    if (typeof BrowserWindow !== 'function' || typeof toolbarFile !== 'string' || !toolbarFile ||
        (toolbarPreload != null && typeof toolbarPreload !== 'string') ||
        typeof getProfilePresentation !== 'function' || typeof getLocale !== 'function' ||
        typeof getTranslator !== 'function' || typeof parentWindow !== 'function' ||
        typeof platform !== 'string' || typeof windowChrome !== 'function' ||
        typeof onToolbarCommand !== 'function' || typeof onResize !== 'function' ||
        typeof onBeforeCreate !== 'function' ||
        typeof onClosed !== 'function' || typeof onMissingWindow !== 'function') {
      throw new TypeError('Campus Browser window owner dependencies are incomplete');
    }
    Object.assign(this, {
      BrowserWindow, toolbarFile, toolbarPreload, getProfilePresentation, getLocale,
      getTranslator, parentWindow, platform, windowChrome,
      onToolbarCommand, onResize, onBeforeCreate, onClosed, onMissingWindow,
    });
    this.current = null;
    this.contextRetired = false;
  }

  get window() { return this.current?.window || null; }

  assertContextCurrent(value) {
    if (this.contextRetired) throw new Error('Campus Browser context is retired');
    return value;
  }

  windowOptions() {
    const presentation = this.getProfilePresentation();
    const t = this.getTranslator();
    return {
      width: 1040,
      height: 740,
      minWidth: 660,
      minHeight: 460,
      title: t('browser.windowTitleForSchool', {
        school: presentation.schoolName,
        trust: presentation.unverified ? t('browser.unverifiedSuffix') : '',
      }),
      backgroundColor: '#f7f9fc',
      autoHideMenuBar: true,
      ...this.windowChrome(this.platform),
      parent: this.platform === 'darwin' ? undefined : this.parentWindow(),
      webPreferences: {
        preload: this.toolbarPreload,
        devTools: false,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        safeDialogs: true,
      },
    };
  }

  toolbarQuery() {
    const presentation = this.getProfilePresentation();
    return {
      lang: this.getLocale(),
      school: presentation.schoolName,
      unverified: presentation.unverified ? '1' : '0',
    };
  }

  async createWindow() {
    let record = this.current;
    if (record && !record.retired && record.window.isDestroyed()) this.retire(record);
    record = this.current;
    if (record) {
      if (record.retired && record.closeConfirmed) {
        if (record.closeObserverFailure || record.closeConfirmationFailure) {
          return Promise.reject(record.closeObserverFailure || record.closeConfirmationFailure);
        } else if (record.closeFlight) {
          return Promise.reject(new Error('Campus Browser window close is still pending'));
        } else if (record.cleanupComplete) {
          if (this.current === record) this.current = null;
        } else if (record.cleanupInProgress && record.closeReason !== 'context-switch') {
          const deferredCreation = Promise.resolve().then(() => this.createWindow());
          deferredCreation.catch(() => {});
          return deferredCreation;
        } else {
          return Promise.reject(record.cleanupFailure ||
            new Error('Campus Browser window cleanup is not confirmed'));
        }
      } else if (record.state === 'failed' || record.state === 'closing') {
        return Promise.reject(record.cleanupFailure || record.failure ||
          new Error('Campus Browser window is not ready'));
      } else {
        return record.readyPromise;
      }
    }
    if (this.contextRetired) throw new Error('Campus Browser context is retired');

    this.onBeforeCreate();
    const window = new this.BrowserWindow(this.windowOptions());
    let resolveReady;
    let rejectReady;
    const readyPromise = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    readyPromise.catch(() => {});
    record = {
      window,
      webContents: null,
      readyPromise,
      resolveReady,
      rejectReady,
      readySettled: false,
      retired: false,
      closeConfirmed: false,
      cleanupComplete: false,
      cleanupInProgress: false,
      cleanupFailure: null,
      cleanupFailures: [],
      closeFailure: null,
      closeObserverFailure: null,
      closeConfirmationFailure: null,
      closeFlight: null,
      closeReason: '',
      state: 'loading',
      failure: null,
      closedListener: null,
      resizeListener: null,
      ipcListener: null,
    };
    this.current = record;
    window.on('closed', record.closedListener = () => this.retire(record));
    try { record.webContents = window.webContents; }
    catch (error) {
      this.failLoad(record, error);
      return readyPromise;
    }
    void this.loadWindow(record);
    return readyPromise;
  }

  async loadWindow(record) {
    try {
      await record.window.loadFile(this.toolbarFile, { query: this.toolbarQuery() });
      if (this.current !== record || record.retired || record.state !== 'loading' ||
          record.window.isDestroyed()) return;
      record.ipcListener = (_event, channel, payload) => {
        if (this.current === record && !record.retired && record.state === 'ready' &&
            channel === 'campus-toolbar-command') this.onToolbarCommand(payload);
      };
      record.resizeListener = () => {
        if (this.current === record && !record.retired && record.state === 'ready') {
          this.onResize(record.window);
        }
      };
      record.webContents.on('ipc-message', record.ipcListener);
      record.window.on('resize', record.resizeListener);
      record.state = 'ready';
      this.settleReady(record, null, record.window);
    } catch (error) {
      this.failLoad(record, error);
    }
  }

  failLoad(record, error) {
    if (this.current !== record || record.retired) return;
    record.state = 'failed';
    record.failure = error;
    this.settleReady(record, error);
    if (record.window.isDestroyed()) {
      this.retire(record);
      return;
    }
    try { record.window.close(); }
    catch (closeError) { record.closeFailure = closeError; }
    if (this.current === record && record.window.isDestroyed()) this.retire(record);
  }

  settleReady(record, error, window = null) {
    if (record.readySettled) return false;
    record.readySettled = true;
    if (error) record.rejectReady(error);
    else record.resolveReady(window);
    return true;
  }

  detach(record) {
    let failure = null;
    const listeners = [
      [record.window, 'closed', record.closedListener],
      [record.window, 'resize', record.resizeListener],
      [record.webContents, 'ipc-message', record.ipcListener],
    ];
    for (const [target, event, listener] of listeners) {
      if (!listener) continue;
      try { target.removeListener(event, listener); }
      catch (error) { failure ||= error; }
    }
    record.closedListener = null;
    record.resizeListener = null;
    record.ipcListener = null;
    return failure;
  }

  show(window) {
    const record = this.current;
    if (this.contextRetired || !record || record.window !== window || record.retired || record.state !== 'ready' ||
        window.isDestroyed()) throw new Error('Campus Browser window is no longer ready');
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    if (this.current !== record || record.state !== 'ready' || window.isDestroyed()) {
      throw new Error('Campus Browser window is no longer current');
    }
  }

  requestClose() {
    const record = this.current;
    if (!record || record.retired || record.window.isDestroyed()) return false;
    this.beginClose(record);
    try { record.window.close(); }
    catch (error) {
      record.closeFailure = error;
      record.failure = error;
      record.state = 'failed';
      throw error;
    }
    return true;
  }

  beginClose(record, reason = 'user') {
    if (record.retired) return false;
    if (reason === 'context-switch' || !record.closeReason) record.closeReason = reason;
    record.state = 'closing';
    const failure = record.failure || new Error('Campus Browser window closed before ready');
    this.settleReady(record, failure);
    return true;
  }

  retire(record) {
    if (!record || record.retired) return false;
    record.retired = true;
    record.closeConfirmed = true;
    record.state = 'retired';
    this.settleReady(record, record.failure || new Error('Campus Browser window closed before ready'));
    if (this.current !== record) return false;
    record.cleanupInProgress = true;
    const detachFailure = this.detach(record);
    if (detachFailure) record.cleanupFailures.push(detachFailure);
    try {
      // Keep the BrowserWindow visible while Browser-owned tabs, views, and
      // popups detach. A callback failure must keep this record blocking.
      this.onClosed(record.window);
    } catch (error) {
      record.cleanupFailures.push(error);
    } finally {
      record.cleanupInProgress = false;
    }
    record.cleanupFailure = record.cleanupFailures[0] || null;
    if (record.cleanupFailure) {
      record.state = 'failed';
      return false;
    }
    record.cleanupComplete = true;
    if (record.closeObserverFailure || record.closeConfirmationFailure) {
      record.state = 'failed';
      return false;
    }
    if (record.closeFlight) return true;
    if (this.current === record) this.current = null;
    return true;
  }

  clear() {
    const record = this.current;
    if (!record) return false;
    if (record.retired || record.closeFlight || record.closeObserverFailure ||
        record.closeConfirmationFailure || !record.window.isDestroyed()) return false;
    return this.retire(record);
  }

  closeForContextSwitch({ timeoutMs = 5_000, setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000 ||
        typeof setTimeoutFn !== 'function' || typeof clearTimeoutFn !== 'function') {
      return Promise.reject(new TypeError('Campus Browser close deadline is invalid'));
    }
    this.contextRetired = true;
    const record = this.current;
    if (!record) {
      this.onMissingWindow();
      return Promise.resolve(true);
    }
    if (record.closeFlight) return record.closeFlight.promise;
    if (record.closeObserverFailure || record.closeConfirmationFailure) {
      return Promise.resolve(false);
    }
    const { window } = record;
    if (record.retired || window.isDestroyed()) {
      if (!record.retired) this.retire(record);
      return Promise.resolve(record.cleanupComplete === true &&
        !record.cleanupFailure && !record.closeObserverFailure &&
        !record.closeConfirmationFailure);
    }
    let resolveClose;
    const promise = new Promise((resolve) => { resolveClose = resolve; });
    const flight = { promise, settled: false, closeRequested: false };
    record.closeFlight = flight;
    let timer = null;
    let closedListener = null;
    const finish = (closed) => {
      if (flight.settled) return;
      flight.settled = true;
      if (timer !== null) {
        try { clearTimeoutFn(timer); } catch (error) { record.closeFailure = error; }
      }
      let observerRemoved = true;
      if (closedListener) {
        try { window.removeListener('closed', closedListener); }
        catch (error) {
          record.closeFailure = error;
          record.closeObserverFailure = error;
          record.state = 'failed';
          observerRemoved = false;
        }
      }
      if (!closed && flight.closeRequested && record.retired) {
        record.closeConfirmationFailure = record.closeFailure ||
          new Error('Campus Browser close event was not confirmed before its deadline');
        record.state = 'failed';
      }
      if (record.closeFlight === flight) record.closeFlight = null;
      const confirmed = closed && observerRemoved && record.cleanupComplete === true &&
        !record.cleanupFailure && !record.closeObserverFailure &&
        !record.closeConfirmationFailure;
      if (confirmed && this.current === record) this.current = null;
      resolveClose(confirmed);
    };
    closedListener = () => finish(record.cleanupComplete === true);
    window.on('closed', closedListener);
    try {
      timer = setTimeoutFn(() => finish(false), timeoutMs);
      timer?.unref?.();
      if (flight.settled) return promise;
      this.beginClose(record, 'context-switch');
      flight.closeRequested = true;
      window.close();
      if (this.current === record && window.isDestroyed()) this.retire(record);
    } catch (error) {
      record.closeFailure = error;
      finish(false);
    }
    return promise;
  }
}

function createCampusBrowserWindowOwner(options) {
  return new CampusBrowserWindowOwner(options);
}

class CampusBrowserManager {
  static createRequestSecurityBoundary(options) {
    return new BrowserRequestSecurityBoundary(options);
  }

  static createCertificateTrustStore(options) {
    return new CampusCertificateTrustStore(options);
  }

  constructor({
    BrowserWindow,
    WebContentsView,
    Menu,
    session,
    dialog,
    safeStorage,
    platform,
    credentialFile,
    certificateTrust,
    parentWindow,
    toolbarFile,
    toolbarPreload,
    campusPreload,
    workspaceFile,
    workspacePreload,
    homeUrl = BLANK_CAMPUS_HOME,
    browserPartition,
    routingPolicy,
    ensureCampusReady,
    resolveRoute,
    ensureConnected,
    getSocksPort,
    getLocale,
    getTranslator,
    getProfilePresentation,
    getNewTabUrl = () => BLANK_CAMPUS_HOME,
    getWorkspaceResources,
    getWorkspaceGroups = () => [],
    onTogglePageFavorite,
    onOpenResource,
    onWorkspaceMutation,
    onRecordPageOpen,
    getSharedPortalCredential = null,
    showItemInFolder,
    showSettings,
    showRoutingRules,
    reportError,
    CampusBrowserClass = CampusBrowser,
    CredentialVaultClass = CampusCredentialVault,
  } = {}) {
    for (const dependency of [
      BrowserWindow, WebContentsView, parentWindow, ensureCampusReady, resolveRoute,
      ensureConnected, getSocksPort, getLocale, getTranslator, getProfilePresentation,
      getNewTabUrl, getWorkspaceResources, getWorkspaceGroups, onOpenResource, onWorkspaceMutation,
      showItemInFolder,
      showRoutingRules, showSettings,
      reportError, CampusBrowserClass, CredentialVaultClass,
    ]) {
      if (typeof dependency !== 'function') {
        throw new TypeError('Campus Browser manager dependencies are incomplete');
      }
    }
    if (!session || !dialog || !safeStorage || !certificateTrust || !routingPolicy ||
        ![credentialFile, toolbarFile, toolbarPreload, campusPreload, workspaceFile,
          workspacePreload, browserPartition]
          .every((value) => typeof value === 'string' && value)) {
      throw new TypeError('Campus Browser manager environment is incomplete');
    }
    Object.assign(this, {
      BrowserWindow, WebContentsView, Menu, session, dialog, safeStorage, platform,
      credentialFile, certificateTrust, parentWindow, toolbarFile, toolbarPreload,
      campusPreload, workspaceFile, workspacePreload, homeUrl: homeUrl || BLANK_CAMPUS_HOME,
      routingPolicy, ensureCampusReady, resolveRoute, ensureConnected,
      browserPartition,
      getSocksPort, getLocale, getTranslator, getProfilePresentation, showItemInFolder,
      getNewTabUrl, getWorkspaceResources, getWorkspaceGroups, onOpenResource, onWorkspaceMutation,
      onTogglePageFavorite: typeof onTogglePageFavorite === 'function'
        ? onTogglePageFavorite : async () => ({ ok: false }),
      onRecordPageOpen: typeof onRecordPageOpen === 'function' ? onRecordPageOpen : () => false,
      getSharedPortalCredential: typeof getSharedPortalCredential === 'function'
        ? getSharedPortalCredential : () => null,
      showRoutingRules, reportError,
      showSettings,
      CampusBrowserClass, CredentialVaultClass,
    });
    this.browser = null;
    this.lastPortalSessionUrl = '';
  }

  get routingSuspended() { return this.browser?.routingSuspended === true; }

  get routingRequestsBlocked() { return this.browser?.routingRequestsBlocked; }

  get hasBrowser() { return this.browser !== null; }

  getOrCreate() {
    if (this.browser) return this.browser;
    let browser;
    const credentialVault = new this.CredentialVaultClass({
      filePath: this.credentialFile,
      safeStorage: this.safeStorage,
      platform: this.platform,
    });
    const workspaceController = new CampusWorkspaceController({
      workspaceFile: this.workspaceFile,
      workspacePreload: this.workspacePreload,
      getProfilePresentation: () => browserProfilePresentation(this.getProfilePresentation()),
      getResources: () => this.getWorkspaceResources(),
      getGroups: () => this.getWorkspaceGroups(),
      getLocale: this.getLocale,
      onCommand: async (command) => {
        if (!browser || this.browser !== browser) return { ok: false, stale: true };
        if (command.command === 'focus-address') return { ok: browser.focusAddressBar() === true };
        if (command.command === 'open-resource') return this.onOpenResource(command.resourceId);
        if (command.command === 'manage-rules') return this.showRoutingRules();
        const result = await this.onWorkspaceMutation(command);
        if (this.browser !== browser) return { ok: false, stale: true };
        browser.updateToolbar();
        return result;
      },
    });
    this.browser = browser = new this.CampusBrowserClass({
      BrowserWindow: this.BrowserWindow,
      WebContentsView: this.WebContentsView,
      session: this.session,
      dialog: this.dialog,
      certificateTrust: this.certificateTrust,
      credentialVault,
      parentWindow: this.parentWindow,
      toolbarFile: this.toolbarFile,
      toolbarPreload: this.toolbarPreload,
      campusPreload: this.campusPreload,
      createWindowOwner: createCampusBrowserWindowOwner,
      profilePresentation: browserProfilePresentation(this.getProfilePresentation()),
      getWorkspaceResources: () => this.getWorkspaceResources(),
      getWorkspaceGroups: () => this.getWorkspaceGroups(),
      onOpenResource: (resourceId) => this.onOpenResource(resourceId),
      showBookmarkMenu: (entries) => this.popupBookmarkMenu(entries),
      onTogglePageFavorite: (candidate) => this.onTogglePageFavorite(candidate),
      workspaceController,
      onRecordPageOpen: (url) => this.onRecordPageOpen(url),
      getSharedPortalCredential: (origin) => this.getSharedPortalCredential(origin),
      onPortalSessionUrl: (url) => this.capturePortalSessionUrl(url),
      showItemInFolder: this.showItemInFolder,
      getNewTabUrl: this.getNewTabUrl,
      onOpenSettings: this.showSettings,
      homeUrl: this.homeUrl,
      partition: this.browserPartition,
      routingPolicy: this.routingPolicy,
      ensureCampusReady: this.ensureCampusReady,
      locale: this.getLocale(),
      t: this.getTranslator(),
      onError: this.reportError,
    });
    return this.browser;
  }

  async open(rawRequest) {
    const translate = this.getTranslator();
    let request;
    try {
      request = normalizeOpenRequest(rawRequest, translate, this.homeUrl);
    } catch (error) {
      this.reportError(error.message);
      return { ok: false, error: error.message };
    }
    if (request.url !== BLANK_CAMPUS_HOME) {
      try {
        request.route = this.resolveRoute(request.url).route;
      } catch (error) {
        const message = error.userMessage || error.message;
        this.reportError(message);
        return { ok: false, error: message };
      }
    }
    // The local custom-Profile landing page has no network request and must be
    // usable before credentials exist. Direct resources also need no Engine;
    // campus pages still establish the tunnel up front so an original
    // cross-origin SSO redirect is never replayed as a GET.
    if (request.url !== BLANK_CAMPUS_HOME && request.route === ROUTE_CAMPUS) {
      const connection = await this.ensureConnected();
      if (!connection?.ok) {
        const error = connection?.error || translate('error.connectTimeout');
        this.reportError(error);
        return { ok: false, error };
      }
    }
    try {
      const browser = this.getOrCreate();
      if (request.displayName) {
        await browser.open(request.url, this.getSocksPort(), request.route, {
          displayName: request.displayName,
        });
      } else {
        await browser.open(request.url, this.getSocksPort(), request.route);
      }
      return { ok: true, url: request.url, route: request.route };
    } catch (error) {
      const message = error.code === 'SETTINGS_READ_FAILED'
        ? error.message
        : translate('error.browserStart', { message: error.message });
      this.reportError(message);
      return { ok: false, error: message };
    }
  }

  async openBookmarkManager() {
    let browser;
    try {
      browser = this.getOrCreate();
      await browser.openWorkspace(this.getSocksPort());
      if (this.browser !== browser) return { ok: false, stale: true };
      browser.focusWorkspace('manage');
      return { ok: true, url: BLANK_CAMPUS_HOME, route: ROUTE_DIRECT };
    } catch (error) {
      if (browser && this.browser !== browser) return { ok: false, stale: true };
      const message = this.getTranslator()('error.browserStart', { message: error.message });
      this.reportError(message);
      return { ok: false, error: message };
    }
  }

  popupBookmarkMenu(entries) {
    if (!this.Menu?.buildFromTemplate || !Array.isArray(entries) || !entries.length) return false;
    const item = (entry) => entry.type === 'folder'
      ? { label: entry.name, submenu: entry.children.map(item) }
      : { label: entry.name, click: () => Promise.resolve(this.onOpenResource(entry.id)).catch(() => {}) };
    this.Menu.buildFromTemplate(entries.map(item)).popup({ window: this.browser?.window || undefined });
    return true;
  }

  suspendRoutingPolicy() {
    return this.browser?.suspendRoutingPolicy() ?? null;
  }

  resumeRoutingPolicy(port) {
    return this.browser?.resumeRoutingPolicy(port) ?? null;
  }

  close() {
    const browser = this.browser;
    browser?.downloadController?.retire();
    browser?.workspaceOwner?.retire();
    this.browser = null;
    this.lastPortalSessionUrl = '';
    return browser?.close() ?? null;
  }

  capturePortalSessionUrl(value) {
    try {
      const candidate = new URL(value);
      const portal = new URL(this.homeUrl);
      if (candidate.protocol !== 'https:' || candidate.origin !== portal.origin ||
          candidate.username || candidate.password || candidate.href.length > 2_048) return false;
      const currentNonce = new URL(this.lastPortalSessionUrl || portal.href).searchParams.get('tt');
      if (currentNonce && !candidate.searchParams.get('tt')) return true;
      this.lastPortalSessionUrl = candidate.href;
      return true;
    } catch { return false; }
  }

  portalSessionUrl(portalUrl = this.homeUrl) {
    try {
      const expected = new URL(portalUrl);
      const stored = new URL(this.lastPortalSessionUrl);
      return expected.protocol === 'https:' && stored.origin === expected.origin
        ? stored.href : null;
    } catch { return null; }
  }

  async closeForContextSwitch() {
    const browser = this.browser;
    if (!browser) { this.lastPortalSessionUrl = ''; return true; }
    if (typeof browser.closeForContextSwitch !== 'function') return false;
    if (await browser.closeForContextSwitch() !== true) return false;
    browser.downloadController?.retire();
    browser.workspaceOwner?.retire();
    if (this.browser === browser) {
      this.browser = null;
      this.lastPortalSessionUrl = '';
    }
    return this.browser === null;
  }

  async clearSiteData() {
    if (await this.closeForContextSwitch() !== true) return false;
    const target = this.session.fromPartition?.(this.browserPartition);
    if (!target || typeof target.clearStorageData !== 'function' ||
        typeof target.clearCache !== 'function') return false;
    await target.closeAllConnections?.();
    await target.clearStorageData();
    await target.clearCache();
    return true;
  }

  ownsWebContents(contents) {
    return this.browser?.ownsWebContents(contents) === true;
  }

  handleCertificateError(details) {
    return this.browser?.handleCertificateError(details);
  }

  setLocale(locale, translate) {
    this.browser?.setLocale(locale, translate);
  }
}

module.exports = {
  CampusBrowserManager,
  CampusBrowserWindowOwner,
  createCampusBrowserWindowOwner,
  browserProfilePresentation,
  officialPortalHomeUrl,
  normalizeOpenRequest,
  requiresCampusTunnel,
};
