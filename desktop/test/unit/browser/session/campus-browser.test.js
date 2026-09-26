'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const {
  CAMPUS_PARTITION,
  BLANK_CAMPUS_HOME,
  CampusBrowser,
  DEFAULT_CAMPUS_HOME,
  FIND_BAR_HEIGHT,
  NEUTRAL_CAMPUS_PARTITION,
  SLOW_LOADING_HINT_MS,
  TOOLBAR_HEIGHT,
  applyCampusSessionPolicy,
  campusProxyConfig,
  campusWindowChrome,
  nextZoomFactor,
  workspaceHomeResources,
  normalizeCampusUrl,
  errorPage,
  redactedFailedUrl,
  safePopupUrl,
  workspaceSearchQuery,
} = require('../../../../lib/browser/session/campus-browser');
const {
  DIRECT_PARTITION,
  ROUTE_CAMPUS,
  ROUTE_DIRECT,
} = require('../../../../lib/routing/policy/campus-route');
const { certificateFingerprint } = require('../../../../lib/browser/certificates/campus-certificate-trust');

const CERTIFICATE_PEM = [
  '-----BEGIN CERTIFICATE-----',
  Buffer.from('fixture-certificate-der').toString('base64'),
  '-----END CERTIFICATE-----',
].join('\n');

test('campus URLs default to a neutral local home and accept host-only input', () => {
  assert.equal(normalizeCampusUrl(''), DEFAULT_CAMPUS_HOME);
  assert.equal(normalizeCampusUrl('example.internal/path'), 'https://example.internal/path');
  assert.equal(normalizeCampusUrl('http://10.0.0.8/portal'), 'http://10.0.0.8/portal');
});

test('campus URLs reject executable schemes and embedded credentials', () => {
  assert.throws(() => normalizeCampusUrl('javascript:alert(1)'), /HTTP/);
  assert.throws(() => normalizeCampusUrl('https://user:pass@example.internal'), /格式/);
  assert.equal(safePopupUrl('https://example.internal/sso'), true);
  assert.equal(safePopupUrl('file:///etc/passwd'), false);
});

test('address input distinguishes local workspace queries from URLs', () => {
  assert.equal(workspaceSearchQuery('SIS'), 'SIS');
  assert.equal(workspaceSearchQuery('科研 与 实验'), '科研 与 实验');
  assert.equal(workspaceSearchQuery('请假'), '请假');
  assert.equal(workspaceSearchQuery('https://sis.example.edu/'), null);
  assert.equal(workspaceSearchQuery('sis.example.edu'), null);
  assert.equal(workspaceSearchQuery('10.0.0.8'), null);
  assert.equal(workspaceSearchQuery('x'.repeat(81)), null);
});

test('toolbar favorite derives current-page authority in Main and refreshes Workspace Home', async () => {
  const toggles = [];
  let callbackReceiver;
  const resources = [{
    id: 'portal', name: 'Portal', description: '',
    url: 'https://portal.example.edu/', route: ROUTE_CAMPUS, favorite: false,
    lastOpenedAt: null,
  }];
  const { browser, scripts, workspaceStates } = createFakeBrowser({
    homeUrl: BLANK_CAMPUS_HOME,
    getWorkspaceResources: () => resources,
    onTogglePageFavorite: async function(candidate) {
      callbackReceiver = this;
      toggles.push(candidate);
      resources[0] = { ...resources[0], favorite: true };
      return { ok: true, favorite: true, resourceId: 'portal' };
    },
  });
  await browser.open('https://portal.example.edu/?ticket=opaque', 1080, ROUTE_CAMPUS);
  await nextImmediate();
  assert.equal(browser.handleToolbarCommand({ command: 'toggle-favorite', value: '' }), true);
  await nextImmediate();
  assert.deepEqual(toggles, [{
    url: 'https://portal.example.edu/?ticket=opaque', title: 'Test', route: ROUTE_CAMPUS,
  }]);
  assert.equal(toolbarState(scripts).favorite, true);
  assert.equal(callbackReceiver, browser);

  browser.createTab(BLANK_CAMPUS_HOME, ROUTE_DIRECT);
  await nextImmediate();
  assert.ok(workspaceStates.length > 0);
});

test('toolbar bookmark bar exposes only IDs names and user folders and opens through Main', async () => {
  const opened = [];
  const focused = [];
  const menus = [];
  const resources = [
    { id: 'portal', name: 'Official Portal', description: '', url: 'https://portal.example.edu/',
      route: ROUTE_CAMPUS, category: 'gateway', favorite: false, lastOpenedAt: null },
    { id: 'canvas', name: 'Canvas', description: '', url: 'https://canvas.example.edu/',
      route: ROUTE_DIRECT, category: 'courses', favorite: true, lastOpenedAt: null },
    { id: 'library', name: 'Library', description: '', url: 'https://library.example.edu/',
      route: ROUTE_CAMPUS, category: 'tools', favorite: true, lastOpenedAt: null },
  ];
  const workspaceController = {
    createView: (View, browserSession) => new View({ webPreferences: { session: browserSession } }),
    load: async (view) => view.webContents.loadFile('/app/campus-workspace.html'),
    sendState: () => true,
    focus: (_contents, target) => { focused.push(target); return true; },
  };
  const { browser } = createFakeBrowser({
    profilePresentation: {
      schoolName: 'Example University', unverified: false, officialPortalResourceId: 'portal',
    },
    getWorkspaceResources: () => resources,
    getWorkspaceGroups: () => [{
      id: 'group_abcdefghijkl', name: '学习', resourceIds: ['canvas'],
    }],
    onOpenResource: async (resourceId) => { opened.push(resourceId); return { ok: true }; },
    showBookmarkMenu: (entries) => menus.push(entries),
    workspaceController,
  });
  assert.deepEqual(browser.bookmarkBarState(), [
    { type: 'bookmark', id: 'portal', name: 'Official Portal', official: true },
    { type: 'bookmark', id: 'library', name: 'Library', official: false },
    { type: 'folder', id: 'group_abcdefghijkl', name: '学习', children: [
      { id: 'canvas', name: 'Canvas' },
    ] },
  ]);
  assert.equal(browser.handleToolbarCommand({ command: 'open-resource', value: 'canvas' }), true);
  await nextImmediate();
  assert.deepEqual(opened, ['canvas']);
  assert.equal(browser.handleToolbarCommand({
    command: 'open-bookmark-folder', value: 'group_abcdefghijkl',
  }), true);
  assert.deepEqual(menus.at(-1), [{ id: 'canvas', name: 'Canvas' }]);
  assert.equal(browser.handleToolbarCommand({ command: 'open-bookmark-menu', value: '' }), true);
  assert.equal(menus.at(-1).length, 3);
  assert.equal(JSON.stringify(menus).includes('https://'), false);
  await browser.open(BLANK_CAMPUS_HOME, 1080, ROUTE_DIRECT);
  assert.equal(browser.handleToolbarCommand({ command: 'manage-bookmarks', value: '' }), true);
  await nextImmediate();
  assert.deepEqual(focused, ['manage']);
});

test('Workspace Home resource projection rejects unsafe, duplicate and unbounded input', () => {
  const valid = { id: 'site', name: 'Site', description: '',
    url: 'https://site.example.edu/', route: ROUTE_CAMPUS, favorite: false,
    lastOpenedAt: null };
  assert.equal(workspaceHomeResources([valid])[0].url, 'https://site.example.edu/');
  assert.throws(() => workspaceHomeResources([valid, { ...valid }]), /duplicated/u);
  assert.throws(() => workspaceHomeResources([{ ...valid, name: '<script>' }]), /invalid/u);
  assert.throws(() => workspaceHomeResources(Array.from({ length: 65 }, (_, index) => ({
    ...valid, id: `site-${index}`, url: `https://site-${index}.example.edu/`,
  }))), /invalid/u);
});

test('browser error pages retain only the origin of a sensitive failed URL', () => {
  const sensitive = 'https://sso.example.edu/saml/login/secret-path?SAMLRequest=very-secret&token=x#fragment';
  assert.equal(redactedFailedUrl(sensitive, 'unknown'), 'https://sso.example.edu');
  assert.equal(redactedFailedUrl('not a URL', 'unknown'), 'unknown');

  const page = errorPage(sensitive, 'ERR_TIMED_OUT');
  const html = decodeURIComponent(page.slice(page.indexOf(',') + 1));
  assert.match(html, /https:\/\/sso\.example\.edu/);
  assert.doesNotMatch(html, /secret-path|SAMLRequest|very-secret|token=x|fragment/);
  const direct = decodeURIComponent(errorPage(
    'https://public.example/', 'ERR_FAILED', (key) => key, ROUTE_DIRECT,
  ).split(',').slice(1).join(','));
  assert.match(direct, /errorPage\.bodyDirect/u);
  assert.doesNotMatch(direct, /errorPage\.bodyCampus/u);
});

test('campus page navigation and redirects cannot escape into file or custom schemes', async () => {
  const { browser } = createFakeBrowser();
  await browser.open('portal.example.internal', 1080);
  const contents = browser.activeTab().view.webContents;
  for (const eventName of ['will-navigate', 'will-redirect']) {
    let prevented = false;
    contents.emit(eventName, { preventDefault: () => { prevented = true; } }, 'file:///etc/passwd');
    assert.equal(prevented, true, eventName);
    prevented = false;
    contents.emit(eventName, { preventDefault: () => { prevented = true; } }, 'https://sso.example.edu/');
    assert.equal(prevented, false, eventName);
  }
});

test('campus browser proxy is loopback-only SOCKS5', () => {
  assert.deepEqual(campusProxyConfig(1080), {
    mode: 'fixed_servers',
    proxyRules: 'socks5://127.0.0.1:1080',
    proxyBypassRules: '<-loopback>',
  });
  assert.throws(() => campusProxyConfig(80), /端口/);
});

test('campus pages cannot reach services on this computer around the proxy', () => {
  // Chromium bypasses proxies for loopback and link-local addresses unless the
  // implicit rule is removed, which would let a campus page probe local ports.
  assert.equal(campusProxyConfig(1080).proxyBypassRules, '<-loopback>');
});

test('campus pages are denied device and capability permissions', () => {
  const decisions = [];
  const campusSession = {
    setPermissionRequestHandler: (handler) => decisions.push(['request', handler]),
    setPermissionCheckHandler: (handler) => decisions.push(['check', handler]),
    setDevicePermissionHandler: (handler) => decisions.push(['device', handler]),
  };
  assert.equal(applyCampusSessionPolicy(campusSession), campusSession);
  assert.deepEqual(decisions.map(([kind]) => kind), ['request', 'check', 'device']);

  let granted = null;
  decisions[0][1]({}, 'media', (allowed) => { granted = allowed; });
  assert.equal(granted, false);
  assert.equal(decisions[1][1]({}, 'geolocation'), false);
  assert.equal(decisions[2][1]({}), false);
});

test('a session without the newer permission APIs still configures cleanly', () => {
  const legacySession = {};
  assert.equal(applyCampusSessionPolicy(legacySession), legacySession);
});

test('Windows tabs share the native caption row without covering window controls', () => {
  assert.deepEqual(campusWindowChrome('win32'), {
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#f1ecd6',
      symbolColor: '#0b2a5b',
      height: 34,
    },
  });
});

test('a certificate exception needs confirmation and is scoped to one campus-browser origin', async () => {
  const ownedContents = {};
  const stored = new Map();
  let promptCount = 0;
  let promptOptions;
  const browser = new CampusBrowser({
    dialog: {
      showMessageBox: async (_window, options) => {
        promptCount++;
        promptOptions = options;
        return { response: 0 };
      },
    },
    certificateTrust: {
      isTrusted: (origin, fingerprint) => stored.get(origin) === fingerprint,
      trust: (origin, fingerprint) => stored.set(origin, fingerprint),
    },
  });
  browser.tabManager.add({ view: { webContents: ownedContents } });

  assert.equal(browser.ownsWebContents(ownedContents), true);
  assert.equal(browser.ownsWebContents({}), false);

  const decisions = [];
  await browser.handleCertificateError({
    url: 'https://103.189.154.10:4433/login',
    error: 'net::ERR_CERT_AUTHORITY_INVALID',
    certificate: {
      data: CERTIFICATE_PEM,
      subjectName: '103.189.154.10',
      issuerName: 'HKUST(GZ) test gateway',
      validStart: 1700000000,
      validExpiry: 1800000000,
    },
    callback: (allowed) => decisions.push(allowed),
  });

  const fingerprint = certificateFingerprint(CERTIFICATE_PEM);
  assert.deepEqual(decisions, [true]);
  assert.equal(stored.get('https://103.189.154.10:4433'), fingerprint);
  assert.equal(promptCount, 1);
  assert.match(promptOptions.detail, /SHA-256/);
  assert.match(promptOptions.detail, /ERR_CERT_AUTHORITY_INVALID/);
  assert.match(promptOptions.detail, /HKUST\(GZ\) test gateway/);
  assert.match(promptOptions.detail, /2023/);

  await browser.handleCertificateError({
    url: 'https://103.189.154.10:4433/again',
    error: 'net::ERR_CERT_AUTHORITY_INVALID',
    certificate: { data: CERTIFICATE_PEM },
    callback: (allowed) => decisions.push(allowed),
  });
  assert.deepEqual(decisions, [true, true]);
  assert.equal(promptCount, 1, 'the same exact certificate should not prompt again');

  browser.dialog.showMessageBox = async () => ({ response: 1 });
  await browser.handleCertificateError({
    url: 'https://103.189.154.10:4443/login',
    error: 'net::ERR_CERT_AUTHORITY_INVALID',
    certificate: { data: CERTIFICATE_PEM },
    callback: (allowed) => decisions.push(allowed),
  });
  assert.deepEqual(decisions, [true, true, false], 'a different port must not inherit the pin');
});

test('concurrent certificate errors for the same origin and fingerprint share one decision', async () => {
  let resolvePrompt;
  let promptCount = 0;
  let trustCount = 0;
  const prompt = new Promise((resolve) => { resolvePrompt = resolve; });
  const browser = new CampusBrowser({
    dialog: {
      showMessageBox: async () => {
        promptCount++;
        return prompt;
      },
    },
    certificateTrust: {
      isTrusted: () => false,
      trust: () => { trustCount++; },
    },
  });
  const decisions = [];
  const request = (name) => browser.handleCertificateError({
    url: 'https://103.189.154.10:4433/login',
    error: 'net::ERR_CERT_AUTHORITY_INVALID',
    certificate: { data: CERTIFICATE_PEM },
    callback: (allowed) => decisions.push([name, allowed]),
  });

  const first = request('first');
  const second = request('second');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(promptCount, 1);
  resolvePrompt({ response: 0 });
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.deepEqual(decisions.sort(), [['first', true], ['second', true]]);
  assert.equal(trustCount, 1);
  assert.equal(browser.certificateDecisions.size, 0);
});

test('a concurrent different certificate for one origin is denied instead of prompting twice', async () => {
  let resolvePrompt;
  let promptCount = 0;
  const prompt = new Promise((resolve) => { resolvePrompt = resolve; });
  const browser = new CampusBrowser({
    dialog: {
      showMessageBox: async () => {
        promptCount++;
        return prompt;
      },
    },
    certificateTrust: { isTrusted: () => false, trust: () => {} },
  });
  const alteredCertificate = [
    '-----BEGIN CERTIFICATE-----',
    Buffer.from('different-fixture-certificate-der').toString('base64'),
    '-----END CERTIFICATE-----',
  ].join('\n');
  const first = browser.handleCertificateError({
    url: 'https://race.example/login',
    certificate: { data: CERTIFICATE_PEM },
    callback: () => {},
  });
  const changed = browser.handleCertificateError({
    url: 'https://race.example/other',
    certificate: { data: alteredCertificate },
    callback: () => {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(promptCount, 1);
  resolvePrompt({ response: 0 });
  assert.deepEqual(await Promise.all([first, changed]), [true, false]);
  assert.equal(promptCount, 1);
});

test('campus browser keeps one persistent session and routes each domain through PAC', async () => {
  const calls = [];
  function makeSession(name) {
    return {
      name,
      setProxy: async (config) => calls.push([name, 'proxy', config]),
      forceReloadProxyConfig: async () => calls.push([name, 'reload-proxy']),
      closeAllConnections: async () => calls.push([name, 'close-connections']),
    };
  };
  const campusSession = makeSession('campus');
  const directSession = makeSession('direct');
  const sessions = new Map([
    [NEUTRAL_CAMPUS_PARTITION, campusSession],
    [DIRECT_PARTITION, directSession],
  ]);
  const fakeSession = {
    fromPartition: (partition) => {
      calls.push(['partition', partition]);
      return sessions.get(partition);
    },
  };
  class FakeWebContents extends EventEmitter {
    setWindowOpenHandler(handler) { this.popupHandler = handler; }
    executeJavaScript() { return Promise.resolve(); }
    getTitle() { return 'Test'; }
    getURL() { return this.url || ''; }
    isDestroyed() { return false; }
    canGoBack() { return false; }
    canGoForward() { return false; }
    reload() {}
    close() {}
    async loadURL(url) { this.url = url; calls.push(['load', url]); }
  }
  class FakeWebContentsView {
    constructor(options) {
      this.options = options;
      this.webContents = new FakeWebContents();
      calls.push(['view', options]);
    }
    setBounds(bounds) { calls.push(['bounds', bounds]); }
    setVisible(visible) { calls.push(['visible', visible]); }
  }
  class FakeBrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = new FakeWebContents();
      this.contentView = {
        addChildView: (view) => calls.push(['add-view', view]),
        removeChildView: (view) => calls.push(['remove-view', view]),
      };
      this.destroyed = false;
      calls.push(['window', options]);
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    getContentSize() { return [1200, 820]; }
    setTitle(value) { this.title = value; }
    show() { calls.push(['show']); }
    focus() { calls.push(['focus']); }
    async loadFile(file) { calls.push(['toolbar', file]); }
    close() { this.destroyed = true; }
  }

  const browser = new CampusBrowser({
    BrowserWindow: FakeBrowserWindow,
    WebContentsView: FakeWebContentsView,
    session: fakeSession,
    parentWindow: () => null,
    toolbarFile: '/app/campus-browser.html',
    campusPreload: '/app/campus-preload.js',
  });
  await browser.open('portal.example.internal', 1080);

  assert.deepEqual(calls[0], ['partition', NEUTRAL_CAMPUS_PARTITION]);
  assert.equal(calls[1][0], 'campus');
  assert.equal(calls[1][1], 'proxy');
  assert.equal(calls[1][2].mode, 'pac_script');
  assert.equal(calls[1][2].proxyBypassRules, '<-loopback>');
  assert.match(calls[1][2].pacScript, /^data:application\/x-ns-proxy-autoconfig;base64,/);
  assert.ok(calls.some((call) => call[0] === 'toolbar'));
  assert.ok(calls.some((call) =>
    call[0] === 'load' && call[1] === 'https://portal.example.internal/'));
  assert.equal(browser.view.options.webPreferences.session, campusSession);
  assert.equal(browser.view.options.webPreferences.preload, '/app/campus-preload.js');
  assert.equal(browser.view.options.webPreferences.nodeIntegration, false);
  assert.equal(browser.view.options.webPreferences.sandbox, true);
  assert.equal(browser.view.options.webPreferences.webSecurity, true);
  assert.equal(browser.view.options.webPreferences.backgroundThrottling, true);

  await browser.open('outlook.office.com/owa/', 1080, ROUTE_DIRECT);
  assert.equal(browser.tabs.length, 2);
  assert.equal(browser.activeTab().view.webContents.getURL(), 'https://outlook.office.com/owa/');
  assert.equal(browser.activeTab().route, ROUTE_DIRECT);
  assert.equal(browser.activeTab().view.options.webPreferences.session, campusSession,
    'direct and campus hosts retain the same cookie/session jar');
  assert.equal(browser.switchTab(browser.tabs[0].id), true);
  assert.equal(browser.activeTab().view.webContents.getURL(), 'https://portal.example.internal/');
  assert.equal(browser.closeTab(browser.activeTabId), true);
  assert.equal(browser.tabs.length, 1);

  const firstId = browser.tabs[0].id;
  const originalView = browser.tabs[0].view;
  assert.equal(await browser.setTabRoute(firstId, ROUTE_CAMPUS), true);
  assert.equal(browser.tabs[0].route, ROUTE_CAMPUS);
  assert.equal(browser.tabs[0].view.options.webPreferences.session, campusSession);
  assert.equal(browser.tabs[0].view, originalView,
    'route changes must not discard POST, cookies, history, or WebContents state');
  assert.equal(browser.tabs[0].view.webContents.getURL(), 'https://outlook.office.com/owa/');

  await browser.configure(6180);
  const latestPac = calls.filter((call) => call[0] === 'campus' && call[1] === 'proxy').at(-1)[2];
  const encoded = latestPac.pacScript.split(',').at(-1);
  assert.match(Buffer.from(encoded, 'base64').toString('utf8'), /127\.0\.0\.1:6180/);
  assert.equal(calls.some((call) => call[0] === 'direct' && call[1] === 'proxy'), false,
    'a second route-specific session must never be configured');
});

test('a transactional routing policy owns the live Session update exactly once', async () => {
  const mutations = [];
  const routingPolicy = {
    appliesLiveSession: true,
    resolve: () => ({ route: ROUTE_CAMPUS, source: 'default', matchedRule: null }),
    proxyConfig: async (port) => ({
      mode: 'pac_script',
      pacScript: `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(
        `function FindProxyForURL(){return "SOCKS5 127.0.0.1:${port}";}`,
      ).toString('base64')}`,
      proxyBypassRules: '<-loopback>',
    }),
    upsert: async (payload) => { mutations.push(payload); },
  };
  const { browser } = createFakeBrowser({ routingPolicy });
  await browser.open('portal.example.internal', 1080);
  let localConfigureCalls = 0;
  const configure = browser.configure.bind(browser);
  browser.configure = (...args) => {
    localConfigureCalls++;
    return configure(...args);
  };

  assert.equal(await browser.setTabRoute(browser.activeTabId, ROUTE_DIRECT), true);
  assert.deepEqual(mutations, [{
    host: 'portal.example.internal',
    includeSubdomains: false,
    route: ROUTE_DIRECT,
  }]);
  assert.equal(localConfigureCalls, 0,
    'the main-process transaction already activated or safely suspended the Session');
});

test('following rules removes only the exact personal override and recomputes the route', async () => {
  let fixed = null;
  const mutations = [];
  const routingPolicy = {
    appliesLiveSession: true,
    resolve: () => fixed
      ? { route: fixed, source: 'user-exact', matchedRule: {
        host: 'portal.example.internal', includeSubdomains: false,
      } }
      : { route: ROUTE_CAMPUS, source: 'builtin', matchedRule: null },
    proxyConfig: async () => ({ mode: 'pac_script',
      pacScript: `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(
        'function FindProxyForURL(){return "DIRECT";}',
      ).toString('base64')}`, proxyBypassRules: '<-loopback>' }),
    upsert: async (payload) => { fixed = payload.route; mutations.push(['upsert', payload]); },
    remove: async (payload) => { fixed = null; mutations.push(['remove', payload]); },
  };
  const { browser } = createFakeBrowser({ routingPolicy, ensureCampusReady: async () => true });
  await browser.open('portal.example.internal', 1080);
  assert.equal(await browser.setTabRoute(browser.activeTabId, ROUTE_DIRECT), true);
  assert.equal(browser.activeTab().routeSource, 'user-exact');
  assert.equal(await browser.setTabRoute(browser.activeTabId, 'auto'), true);
  assert.equal(browser.activeTab().route, ROUTE_CAMPUS);
  assert.equal(browser.activeTab().routeSource, 'builtin');
  assert.deepEqual(mutations.at(-1), ['remove', {
    host: 'portal.example.internal', includeSubdomains: false,
  }]);
});

test('a provisional load failure keeps the failed URL and shows an error page', async () => {
  function makeSession(name) {
    return {
      name,
      setProxy: async () => {},
      forceReloadProxyConfig: async () => {},
      closeAllConnections: async () => {},
    };
  }
  const sessions = new Map([
    [CAMPUS_PARTITION, makeSession('campus')],
    [DIRECT_PARTITION, makeSession('direct')],
  ]);
  class FakeWebContents extends EventEmitter {
    setWindowOpenHandler(handler) { this.popupHandler = handler; }
    executeJavaScript() { return Promise.resolve(); }
    getTitle() { return 'Test'; }
    getURL() { return this.url || ''; }
    isDestroyed() { return false; }
    canGoBack() { return false; }
    canGoForward() { return false; }
    reload() {}
    close() {}
    async loadURL(url) { this.url = url; }
  }
  class FakeWebContentsView {
    constructor(options) {
      this.options = options;
      this.webContents = new FakeWebContents();
    }
    setBounds() {}
    setVisible() {}
  }
  class FakeBrowserWindow extends EventEmitter {
    constructor() {
      super();
      this.webContents = new FakeWebContents();
      this.contentView = { addChildView: () => {}, removeChildView: () => {} };
      this.destroyed = false;
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    getContentSize() { return [1200, 820]; }
    setTitle(value) { this.title = value; }
    show() {}
    focus() {}
    async loadFile() {}
    close() { this.destroyed = true; }
  }

  const browser = new CampusBrowser({
    BrowserWindow: FakeBrowserWindow,
    WebContentsView: FakeWebContentsView,
    session: { fromPartition: (partition) => sessions.get(partition) },
    parentWindow: () => null,
    toolbarFile: '/app/campus-browser.html',
    campusPreload: '/app/campus-preload.js',
    partition: CAMPUS_PARTITION,
  });
  await browser.open('www.google.com', 1080, ROUTE_DIRECT);
  const tab = browser.activeTab();
  assert.equal(tab.view.webContents.getURL(), 'https://www.google.com/');

  tab.view.webContents.emit(
    'did-fail-provisional-load',
    null,
    -7,
    'ERR_TIMED_OUT',
    'https://www.google.com/',
    true,
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(tab.failedUrl, 'https://www.google.com/');
  assert.equal(tab.loading, false);
  assert.ok(tab.view.webContents.getURL().startsWith('data:text/html'),
    'the failed tab renders a local error page instead of staying blank');

  assert.equal(await browser.setTabRoute(tab.id, ROUTE_CAMPUS), true);
  assert.equal(tab.view.webContents.getURL(), 'https://www.google.com/',
    'switching the route retries the failed site instead of the school home');
  assert.notEqual(tab.view.webContents.getURL(), DEFAULT_CAMPUS_HOME);
});

test('zoom factors step by 0.1, reset to 1, and clamp to [0.5, 2]', () => {
  assert.equal(nextZoomFactor(1, '='), 1.1);
  assert.equal(nextZoomFactor(1, '+'), 1.1);
  assert.equal(nextZoomFactor(1, '-'), 0.9);
  assert.equal(nextZoomFactor(1.7, '+'), 1.8, 'float drift must not accumulate');
  assert.equal(nextZoomFactor(1.4, '0'), 1);
  assert.equal(nextZoomFactor(0.5, '-'), 0.5);
  assert.equal(nextZoomFactor(2, '='), 2);
  assert.equal(nextZoomFactor(NaN, '='), 1.1);
});

// A minimal in-memory harness mirroring the fakes used above, plus recording
// of toolbar state scripts and find/zoom calls on tab web contents.
function createFakeBrowser(extra = {}) {
  const calls = [];
  const scripts = [];
  const homeScripts = [];
  const workspaceStates = [];
  function makeSession(name) {
    const routeSession = new EventEmitter();
    routeSession.name = name;
    routeSession.webRequest = {
      onBeforeRequest: (_filter, handler) => { routeSession.beforeRequest = handler; },
    };
    routeSession.setProxy = async () => {};
    routeSession.forceReloadProxyConfig = async () => {};
    routeSession.closeAllConnections = async () => {};
    return routeSession;
  }
  const sessions = new Map([
    [CAMPUS_PARTITION, makeSession('campus')],
    [DIRECT_PARTITION, makeSession('direct')],
  ]);
  class FakeWebContents extends EventEmitter {
    setWindowOpenHandler(handler) { this.popupHandler = handler; }
    executeJavaScript(script) {
      if (typeof script === 'string' && script.includes('campusBrowserUI')) {
        scripts.push(script);
      }
      if (typeof script === 'string' && script.includes('document.write')) {
        homeScripts.push(script);
      }
      if (typeof script === 'string' && script.includes('workspaceSearch')) {
        this.workspaceFocused = true;
      }
      return Promise.resolve();
    }
    send(channel, payload) {
      (this.sent ||= []).push([channel, payload]);
      if (channel === 'campus-toolbar-state') {
        scripts.push(`window.campusBrowserUI&&window.campusBrowserUI.setState(${JSON.stringify(payload)})`);
      }
    }
    getTitle() { return 'Test'; }
    getURL() { return this.url || ''; }
    isDestroyed() { return false; }
    canGoBack() { return false; }
    canGoForward() { return false; }
    reload() { this.reloadCount = (this.reloadCount || 0) + 1; }
    close() {}
    focus() { this.focused = true; }
    getZoomFactor() { return this.zoom || 1; }
    setZoomFactor(value) { this.zoom = value; }
    findInPage(text, options) {
      (this.findCalls ||= []).push([text, options]);
      return 1;
    }
    stopFindInPage(action) { (this.stopFindCalls ||= []).push(action); }
    async loadURL(url) { this.url = url; }
    async loadFile(file) { this.file = file; this.url = `file://${file}`; }
  }
  class FakeWebContentsView {
    constructor(options) {
      this.options = options;
      this.webContents = new FakeWebContents();
      this.boundsCalls = [];
      this.visible = null;
    }
    setBounds(bounds) {
      this.boundsCalls.push(bounds);
      calls.push(['bounds', bounds]);
    }
    setVisible(visible) {
      this.visible = visible;
      calls.push(['visible', visible]);
    }
  }
  let browserWindowCount = 0;
  class FakeBrowserWindow extends EventEmitter {
    constructor(options = {}) {
      super();
      if (browserWindowCount > 0 && extra.failPopupWindow) {
        throw new Error('synthetic native popup failure');
      }
      browserWindowCount++;
      this.options = options;
      this.webContents = new FakeWebContents();
      this.webContents.session = options.webPreferences?.session;
      const children = [];
      this.contentView = {
        children,
        addChildView: (view) => {
          if (!children.includes(view)) children.push(view);
        },
        removeChildView: (view) => {
          const index = children.indexOf(view);
          if (index !== -1) children.splice(index, 1);
        },
      };
      this.destroyed = false;
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    getContentSize() { return [1200, 820]; }
    setTitle(value) { this.title = value; }
    setMenuBarVisibility() {}
    show() {}
    focus() {}
    async loadFile() {}
    close() { this.destroyed = true; }
  }
  const workspaceController = extra.workspaceController || {
    createView: (View, browserSession) => new View({ webPreferences: { session: browserSession } }),
    load: async (view) => view.webContents.loadFile('/app/campus-workspace.html'),
    sendState: (contents) => { workspaceStates.push({ contents }); return true; },
    focusSearch: (contents) => { contents.workspaceFocused = true; return true; },
  };
  const browser = new CampusBrowser({
    BrowserWindow: FakeBrowserWindow,
    WebContentsView: FakeWebContentsView,
    session: { fromPartition: (partition) => sessions.get(partition) },
    parentWindow: () => null,
    toolbarFile: '/app/campus-browser.html',
    campusPreload: '/app/campus-preload.js',
    workspaceController,
    partition: CAMPUS_PARTITION,
    ...extra,
  });
  return { browser, calls, scripts, homeScripts, workspaceStates, sessions };
}

test('shared connection credential is sent once to the exact ready login document and then destroyed', async () => {
  let destroyed = 0;
  let requestedOrigin = '';
  const { browser } = createFakeBrowser({
    homeUrl: 'https://myportal.hkust-gz.edu.cn/',
    getSharedPortalCredential: (origin) => {
      requestedOrigin = origin;
      return {
        withStrings: (callback) => callback('student001', 'one-time-secret'),
        destroy: () => { destroyed += 1; },
      };
    },
  });
  await browser.open('https://sso.hkust-gz.edu.cn/Account/Login', 1080, ROUTE_DIRECT);
  const tab = browser.activeTab();
  tab.view.webContents.emit('dom-ready');
  await nextImmediate();
  const fills = tab.view.webContents.sent.filter(([channel]) => channel === 'campus-credential-fill');
  assert.equal(requestedOrigin, 'https://sso.hkust-gz.edu.cn');
  assert.equal(fills.length, 1);
  assert.deepEqual(fills[0][1], {
    origin: 'https://sso.hkust-gz.edu.cn',
    username: 'student001',
    password: 'one-time-secret',
    source: 'connection-credential',
    autoSubmit: true,
  });
  assert.equal(destroyed, 1);
  tab.view.webContents.emit('dom-ready');
  await nextImmediate();
  assert.equal(tab.view.webContents.sent.filter(([channel]) => channel === 'campus-credential-fill').length, 1,
    'one login document must not receive repeated password submissions');
});

function nextImmediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

function toolbarState(scripts) {
  const last = scripts.filter((script) => script.includes('setState(')).at(-1);
  return JSON.parse(last.slice(last.indexOf('setState(') + 9, -1));
}

function loadingState(scripts) {
  const state = toolbarState(scripts);
  return { loading: state.loading, slow: state.slow };
}

test('the plus button opens a genuine blank tab on the non-network direct route', async () => {
  const { browser } = createFakeBrowser({
    homeUrl: 'about:blank',
    getNewTabUrl: () => BLANK_CAMPUS_HOME,
  });
  await browser.open('about:blank', 1080, ROUTE_DIRECT);
  assert.equal(browser.activeTab().route, ROUTE_DIRECT);
  browser.handleToolbarCommand({ command: 'new-tab', value: '' });
  assert.equal(browser.tabs.length, 2);
  assert.equal(browser.activeTab().kind, 'blank');
  assert.equal(browser.currentUrl(browser.activeTab()), BLANK_CAMPUS_HOME);
  assert.equal(browser.activeTab().route, ROUTE_DIRECT);
});

test('a reviewed portal remains Home while the plus page follows the live PAC policy', async () => {
  const portal = 'https://portal.example.edu/';
  let newTabUrl = 'www.bing.com';
  const { browser } = createFakeBrowser({
    homeUrl: portal,
    getNewTabUrl: () => newTabUrl,
  });
  await browser.open(portal, 1080, ROUTE_CAMPUS);
  assert.equal(browser.tabs.length, 1);
  browser.handleToolbarCommand({ command: 'new-tab', value: '' });
  await nextImmediate();
  assert.equal(browser.tabs.length, 2);
  assert.equal(browser.activeTab().kind, undefined);
  assert.equal(browser.currentUrl(browser.activeTab()), 'https://www.bing.com/');
  assert.equal(browser.activeTab().route, ROUTE_CAMPUS,
    'an unknown configured homepage uses the same fail-safe default as the PAC');
  assert.equal(browser.activeTab().routeSource, 'default');
  browser.activeTab().view.webContents.emit(
    'did-navigate', {}, browser.activeTab().view.webContents.getURL(), 200,
  );
  assert.equal(browser.activeTab().route, ROUTE_CAMPUS,
    'a real navigation commit cannot flip the toolbar from a requested fake route');
  browser.handleToolbarCommand({ command: 'home', value: '' });
  await nextImmediate();
  assert.equal(browser.currentUrl(browser.activeTab()), portal);
  newTabUrl = BLANK_CAMPUS_HOME;
  browser.handleToolbarCommand({ command: 'new-tab', value: '' });
  await nextImmediate();
  assert.equal(browser.activeTab().kind, 'blank', 'a saved preference applies without restart');
  assert.equal(await browser.openWorkspace(1080), BLANK_CAMPUS_HOME);
  assert.equal(browser.activeTab().kind, 'workspace');
});

test('the toolbar settings button delegates one value-free action to Main', () => {
  let opens = 0;
  const { browser } = createFakeBrowser({ onOpenSettings: () => { opens++; } });
  assert.equal(browser.handleToolbarCommand({ command: 'open-settings', value: '' }), true);
  assert.equal(opens, 1);
});

test('Command-K opens one local Workspace Home tab and focuses its search', async () => {
  const { browser } = createFakeBrowser({ homeUrl: BLANK_CAMPUS_HOME });
  await browser.open('https://portal.example.edu/', 1080, ROUTE_CAMPUS);
  const page = browser.activeTab().view.webContents;
  let prevented = false;
  const commandModifier = process.platform === 'darwin'
    ? { meta: true, control: false }
    : { meta: false, control: true };
  page.emit('before-input-event', { preventDefault: () => { prevented = true; } }, {
    key: 'k', type: 'keyDown', ...commandModifier,
  });
  await nextImmediate();
  const workspace = browser.activeTab();
  assert.equal(prevented, true);
  assert.equal(workspace.kind, 'workspace');
  assert.equal(workspace.route, ROUTE_DIRECT);
  assert.equal(workspace.view.webContents.workspaceFocused, true);
  browser.switchTab(browser.tabs[0].id);
  await browser.open(BLANK_CAMPUS_HOME, 1080, ROUTE_DIRECT);
  assert.equal(browser.tabs.filter((tab) => tab.kind === 'workspace').length, 1,
    'opening the Workspace again focuses its existing tab');
});

test('address keywords open one Workspace and retain only a bounded local query', async () => {
  let focused = null;
  const workspaceController = {
    createView: (View, browserSession) => new View({ webPreferences: { session: browserSession } }),
    load: async (view) => view.webContents.loadFile('/app/campus-workspace.html'),
    sendState: () => true,
    focus: (contents, target, query) => { focused = { contents, target, query }; return true; },
  };
  const { browser } = createFakeBrowser({ homeUrl: BLANK_CAMPUS_HOME, workspaceController });
  await browser.open('https://portal.example.edu/', 1080, ROUTE_CAMPUS);
  assert.equal(browser.handleToolbarCommand({ command: 'navigate', value: 'SIS' }), true);
  await nextImmediate();
  assert.equal(browser.activeTab().kind, 'workspace');
  assert.equal(focused.target, 'search');
  assert.equal(focused.query, 'SIS');
});

test('local Workspace Home refreshes favorites and recent resources without a network home', async () => {
  let resources = [{
    id: 'library', name: 'Library', description: 'Research',
    url: 'https://library.example.edu/', route: ROUTE_CAMPUS, favorite: true,
    lastOpenedAt: null,
  }];
  const labels = {
    'browser.workspace': 'Workspace', 'browser.neutralHomeBody': 'Choose',
    'browser.neutralHomeUnverified': 'Unverified', 'browser.homeFavorites': 'Favorites',
    'browser.homeRecent': 'Recent', 'browser.homeServices': 'Services',
    'browser.homeEmpty': 'Empty', 'route.campus': 'Campus', 'route.direct': 'Direct',
    'browser.windowTitleForSchool': 'Workspace', 'browser.unverifiedSuffix': '',
  };
  const translate = (key) => labels[key] || key;
  const workspaceStates = [];
  const { browser } = createFakeBrowser({
    homeUrl: BLANK_CAMPUS_HOME,
    profilePresentation: { schoolName: 'Example University', unverified: false },
    getWorkspaceResources: () => resources,
    workspaceController: {
      createView: (View, browserSession) => new View({ webPreferences: { session: browserSession } }),
      load: async (view) => view.webContents.loadFile('/app/campus-workspace.html'),
      sendState: () => { workspaceStates.push(resources.map(({ id }) => id)); return true; },
      focusSearch: () => true,
    },
    t: translate,
  });
  await browser.open(BLANK_CAMPUS_HOME, 1080, ROUTE_DIRECT);
  await nextImmediate();
  assert.deepEqual(workspaceStates.at(-1), ['library']);
  resources = [{
    id: 'recent', name: 'Recent Site', description: '',
    url: 'https://recent.example.edu/', route: ROUTE_DIRECT, favorite: false,
    lastOpenedAt: 300,
  }];
  browser.setLocale('en', translate);
  assert.deepEqual(workspaceStates.at(-1), ['recent']);
});

test('card board layout changes are broadcast only to open Workspace tabs', async () => {
  const { browser } = createFakeBrowser({ homeUrl: BLANK_CAMPUS_HOME });
  await browser.open(BLANK_CAMPUS_HOME, 1080, ROUTE_DIRECT);
  await nextImmediate();
  const workspace = browser.activeTab();
  const messages = [];
  workspace.view.webContents.send = (channel, payload) => messages.push({ channel, payload });
  const document = { schemaVersion: 1, revision: 4, placements: [], decks: [] };
  assert.equal(browser.refreshCardBoardLayout(document), true);
  assert.deepEqual(messages, [{ channel: 'card-board-layout-changed', payload: document }]);
  assert.equal(browser.refreshCardBoardLayout(null), false);
});

test('context switch close waits for the real BrowserWindow closed event', async () => {
  const { browser } = createFakeBrowser();
  await browser.open('portal.example.internal', 1080, ROUTE_CAMPUS);
  const window = browser.window;
  const pending = browser.closeForContextSwitch();
  assert.equal(window.destroyed, true);
  window.emit('closed');
  assert.equal(await pending, true);
  assert.equal(browser.window, null);
  assert.equal(browser.tabs.length, 0);
});

test('context switch close fails closed when BrowserWindow never confirms closure', async () => {
  const { browser } = createFakeBrowser();
  await browser.open('portal.example.internal', 1080, ROUTE_CAMPUS);
  let timeout;
  const pending = browser.closeForContextSwitch({
    timeoutMs: 100,
    setTimeoutFn: (callback) => { timeout = callback; return { unref() {} }; },
    clearTimeoutFn: () => {},
  });
  timeout();
  assert.equal(await pending, false);
});

test('a load slower than ten seconds is flagged per tab', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { browser, scripts } = createFakeBrowser();
  await browser.open('portal.example.internal', 1080, ROUTE_CAMPUS);
  const tab = browser.activeTab();
  await nextImmediate();

  tab.view.webContents.emit('did-start-loading');
  await nextImmediate();
  assert.deepEqual(loadingState(scripts), { loading: true, slow: false });
  t.mock.timers.tick(SLOW_LOADING_HINT_MS);
  await nextImmediate();
  assert.deepEqual(loadingState(scripts), { loading: true, slow: true });

  const other = browser.createTab(DEFAULT_CAMPUS_HOME, ROUTE_CAMPUS);
  assert.equal(browser.activeTab().id, other.id);
  await nextImmediate();
  assert.deepEqual(loadingState(scripts), { loading: false, slow: false },
    'switching to a fresh tab must not show the slow hint');

  browser.switchTab(tab.id);
  await nextImmediate();
  assert.deepEqual(loadingState(scripts), { loading: true, slow: true },
    'switching back must restore the slow tab state');

  tab.view.webContents.emit('did-stop-loading');
  await nextImmediate();
  assert.deepEqual(loadingState(scripts), { loading: false, slow: false });
});

test('resize work is coalesced and only the visible tab is laid out', async () => {
  const { browser } = createFakeBrowser();
  await browser.open('portal.example.internal', 1080);
  await nextImmediate();
  const first = browser.activeTab();
  const second = browser.createTab('library.example.internal');
  await nextImmediate();

  assert.equal(first.view.visible, false);
  assert.equal(second.view.visible, true);
  assert.equal(first.view.options.webPreferences.backgroundThrottling, true);
  assert.equal(second.view.options.webPreferences.backgroundThrottling, true);

  const firstLayouts = first.view.boundsCalls.length;
  const secondLayouts = second.view.boundsCalls.length;
  for (let index = 0; index < 32; index++) browser.window.emit('resize');
  assert.equal(second.view.boundsCalls.length, secondLayouts,
    'resize does not synchronously reflow a renderer for every event');
  await nextImmediate();
  assert.equal(first.view.boundsCalls.length, firstLayouts,
    'hidden tabs are not needlessly laid out');
  assert.equal(second.view.boundsCalls.length, secondLayouts + 1,
    'one event-loop burst produces exactly one active-tab layout');

  browser.switchTab(first.id);
  assert.equal(first.view.visible, true);
  assert.equal(second.view.visible, false);
  assert.equal(first.view.boundsCalls.length, firstLayouts + 1,
    'a hidden tab receives current bounds immediately before it becomes visible');
});

test('only the selected WebContentsView is attached to the native accessibility tree', async () => {
  const { browser } = createFakeBrowser();
  await browser.open('portal.example.internal', 1080, ROUTE_CAMPUS);
  const first = browser.activeTab();
  const second = browser.createTab('library.example.internal', ROUTE_CAMPUS);

  assert.deepEqual(browser.window.contentView.children, [second.view]);
  assert.equal(first.view.webContents.isDestroyed(), false,
    'detaching an inactive tab retains its renderer and browsing state');
  assert.equal(first.view.webContents.getURL(), 'https://portal.example.internal/');

  assert.equal(browser.switchTab(first.id), true);
  assert.deepEqual(browser.window.contentView.children, [first.view]);
  assert.equal(second.view.webContents.isDestroyed(), false);
  assert.equal(second.view.webContents.getURL(), 'https://library.example.internal/');

  assert.equal(browser.closeTab(first.id), true);
  assert.deepEqual(browser.window.contentView.children, [second.view]);
});

test('address navigation and reload resume a suspended fail-closed Session first', async () => {
  let readyCalls = 0;
  const { browser } = createFakeBrowser({
    ensureCampusReady: async () => { readyCalls++; return true; },
  });
  await browser.open('portal.example.internal', 1080, ROUTE_CAMPUS);
  const tab = browser.activeTab();

  await browser.suspendRoutingPolicy();
  assert.equal(browser.routingSuspended, true);
  assert.equal(browser.routingRequestsBlocked, true);
  browser.handleToolbarCommand({ command: 'navigate', value: 'library.example.internal' });
  for (let index = 0; index < 4; index++) await nextImmediate();
  assert.equal(browser.routingSuspended, false);
  assert.equal(browser.routingRequestsBlocked, false);
  assert.equal(tab.view.webContents.getURL(), 'https://library.example.internal/');

  await browser.suspendRoutingPolicy();
  const reloads = tab.view.webContents.reloadCount || 0;
  browser.handleToolbarCommand({ command: 'reload', value: '' });
  for (let index = 0; index < 4; index++) await nextImmediate();
  assert.equal(browser.routingSuspended, false);
  assert.equal(browser.routingRequestsBlocked, false);
  assert.equal(tab.view.webContents.reloadCount, reloads + 1);
  assert.ok(readyCalls >= 3, 'open, address navigation, and reload establish Campus readiness');
});

test('concurrent Browser opens single-flight one routing activation', async () => {
  const { browser, sessions } = createFakeBrowser();
  let configureCalls = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  browser.configure = async (port) => {
    configureCalls += 1;
    await pending;
    browser.browserSessionManager.configuredPort = port;
    browser.browserSessionManager.campusSession = sessions.get(CAMPUS_PARTITION);
    browser.browserSessionManager.suspended = false;
    return browser.browserSessionManager.campusSession;
  };

  const first = browser.activateRoutingPolicy(1080);
  const second = browser.activateRoutingPolicy(1080);
  await nextImmediate();
  assert.equal(configureCalls, 1);
  release();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left, right);
  assert.equal(configureCalls, 1);
});

test('a failed readiness check leaves suspended navigation fail closed', async () => {
  let ready = true;
  const { browser } = createFakeBrowser({ ensureCampusReady: async () => ready });
  await browser.open('portal.example.internal', 1080, ROUTE_CAMPUS);
  const tab = browser.activeTab();
  const originalUrl = tab.view.webContents.getURL();
  await browser.suspendRoutingPolicy();
  ready = false;

  browser.handleToolbarCommand({ command: 'navigate', value: 'library.example.internal' });
  for (let index = 0; index < 3; index++) await nextImmediate();
  assert.equal(browser.routingSuspended, true);
  assert.equal(browser.routingRequestsBlocked, true);
  assert.equal(tab.view.webContents.getURL(), originalUrl);
});

test('a newer Home action invalidates an older address navigation waiting for readiness', async () => {
  let releaseDelayedReadiness;
  let delayNextReadiness = false;
  const delayedReadiness = new Promise((resolve) => { releaseDelayedReadiness = resolve; });
  const homeUrl = 'https://home.example.internal/';
  const { browser } = createFakeBrowser({
    homeUrl,
    ensureCampusReady: async () => delayNextReadiness ? delayedReadiness : true,
  });
  await browser.open(homeUrl, 1080, ROUTE_CAMPUS);
  const tab = browser.activeTab();

  delayNextReadiness = true;
  browser.handleToolbarCommand({ command: 'navigate', value: 'older.example.internal' });
  await nextImmediate();
  delayNextReadiness = false;
  browser.handleToolbarCommand({ command: 'home', value: '' });
  for (let index = 0; index < 3; index += 1) await nextImmediate();
  assert.equal(tab.view.webContents.getURL(), homeUrl);

  releaseDelayedReadiness(true);
  for (let index = 0; index < 3; index += 1) await nextImmediate();
  assert.equal(tab.view.webContents.getURL(), homeUrl,
    'the older address navigation must not overwrite the newer Home action');
});

test('toolbar events are coalesced, deduplicated, and cancelled during teardown', async () => {
  const { browser, scripts } = createFakeBrowser();
  await browser.open('portal.example.internal', 1080);
  await nextImmediate();
  scripts.length = 0;
  const tab = browser.activeTab();
  const contents = tab.view.webContents;

  contents.url = 'https://portal.example.internal/dashboard';
  contents.emit('did-navigate', {}, contents.url);
  contents.emit('did-navigate-in-page');
  contents.emit('page-title-updated');
  assert.equal(scripts.length, 0, 'page-event bursts wait for their shared bounded update');
  await nextImmediate();
  assert.equal(scripts.length, 1, 'one event-loop burst sends one toolbar state');

  contents.emit('page-title-updated');
  await nextImmediate();
  assert.equal(scripts.length, 1, 'an unchanged state is not resent');

  scripts.length = 0;
  contents.emit('page-title-updated');
  assert.notEqual(browser.scheduledToolbarUpdate, null);
  const window = browser.window;
  window.emit('closed');
  assert.equal(browser.scheduledToolbarUpdate, null);
  assert.equal(browser.scheduledLayout, null);
  await nextImmediate();
  assert.equal(scripts.length, 0, 'closed windows cannot receive a stale toolbar update');

  const { browser: closingBrowser } = createFakeBrowser();
  await closingBrowser.open('portal.example.internal', 1080);
  await nextImmediate();
  closingBrowser.window.emit('resize');
  closingBrowser.activeTab().view.webContents.emit('page-title-updated');
  closingBrowser.close();
  assert.equal(closingBrowser.scheduledToolbarUpdate, null);
  assert.equal(closingBrowser.scheduledLayout, null,
    'the public close boundary cancels work even if a fake window emits no closed event');
});

test('closing a background tab cancels stale resize work before scheduling fresh state', async () => {
  const { browser } = createFakeBrowser();
  await browser.open('portal.example.internal', 1080);
  const first = browser.activeTab();
  const second = browser.createTab('library.example.internal');
  await nextImmediate();
  const activeLayouts = second.view.boundsCalls.length;

  browser.window.emit('resize');
  assert.notEqual(browser.scheduledLayout, null);
  assert.equal(browser.closeTab(first.id), true);
  assert.equal(browser.scheduledLayout, null,
    'the closed-tab boundary cancels a resize captured against the old tab set');
  await nextImmediate();
  assert.equal(second.view.boundsCalls.length, activeLayouts,
    'the cancelled resize cannot reflow the surviving tab later');
});

test('zoom shortcuts step once per key press and stay clamped', async () => {
  const { browser } = createFakeBrowser();
  await browser.open('portal.example.internal', 1080);
  const contents = browser.activeTab().view.webContents;
  let prevented = 0;
  const event = { preventDefault: () => { prevented++; } };
  const press = (key, type = 'keyDown') => contents.emit(
    'before-input-event',
    event,
    { meta: true, control: true, key, type },
  );

  press('=');
  assert.equal(contents.getZoomFactor(), 1.1);
  assert.equal(prevented, 1);
  press('=', 'keyUp');
  assert.equal(contents.getZoomFactor(), 1.1, 'key release must not zoom again');
  for (let index = 0; index < 20; index++) press('+');
  assert.equal(contents.getZoomFactor(), 2);
  for (let index = 0; index < 30; index++) press('-');
  assert.equal(contents.getZoomFactor(), 0.5);
  press('0');
  assert.equal(contents.getZoomFactor(), 1);
});

test('toolbar find commands drive findInPage on the active tab', async () => {
  const { browser, calls, scripts } = createFakeBrowser();
  await browser.open('portal.example.internal', 1080);
  const contents = browser.activeTab().view.webContents;
  const command = (name, value = '') => ({ command: name, value });

  browser.handleToolbarCommand(command('find-open'));
  assert.equal(browser.findOpen, true);
  assert.equal(toolbarState(scripts).findOpen, true);
  const bounds = calls.filter(([kind]) => kind === 'bounds').at(-1)[1];
  assert.equal(bounds.y, TOOLBAR_HEIGHT + FIND_BAR_HEIGHT,
    'the page must move below the open find bar');

  browser.handleToolbarCommand(command('find', '校园'));
  assert.deepEqual(contents.findCalls.at(-1), ['校园', undefined]);
  browser.handleToolbarCommand(command('find-next'));
  assert.deepEqual(contents.findCalls.at(-1), ['校园', { forward: true, findNext: true }]);
  browser.handleToolbarCommand(command('find-prev'));
  assert.deepEqual(contents.findCalls.at(-1), ['校园', { forward: false, findNext: true }]);

  browser.handleToolbarCommand(command('find', ''));
  assert.deepEqual(contents.stopFindCalls.at(-1), 'clearSelection');
  const findCallsBefore = contents.findCalls.length;
  browser.handleToolbarCommand(command('find-next'));
  assert.equal(contents.findCalls.length, findCallsBefore,
    'an empty query must not restart the search');

  browser.handleToolbarCommand(command('find-close'));
  assert.equal(browser.findOpen, false);
  assert.equal(toolbarState(scripts).findOpen, false);
  assert.deepEqual(contents.stopFindCalls.at(-1), 'clearSelection');
  assert.equal(contents.focused, true, 'closing the find bar returns focus to the page');
  const closedBounds = calls.filter(([kind]) => kind === 'bounds').at(-1)[1];
  assert.equal(closedBounds.y, TOOLBAR_HEIGHT);

  assert.equal(browser.handleToolbarCommand('about:blank#command=find-open'), false);
  assert.equal(browser.findOpen, false, 'legacy URL hashes cannot issue toolbar commands');
});

test('downloads use the native save picker and surface failures', async () => {
  const errors = [];
  const prompts = [];
  const shown = [];
  const dialog = {
    showSaveDialog: () => { throw new Error('must use native download picker'); },
    showMessageBox: async () => ({ response: 0 }),
  };
  const { browser, sessions } = createFakeBrowser({
    dialog,
    onError: (message) => errors.push(message),
    showItemInFolder: (file) => shown.push(file),
  });

  const campusSession = sessions.get(CAMPUS_PARTITION);
  await browser.configure(1080, ROUTE_CAMPUS);
  await browser.configure(1080, ROUTE_CAMPUS);
  assert.equal(campusSession.listenerCount('will-download'), 1,
    'reconfiguring the same session must not stack download handlers');
  await browser.createWindow();

  const makeItem = (filename) => {
    const item = new EventEmitter();
    item.filename = filename;
    item.getFilename = () => item.filename;
    item.cancel = () => { item.cancelled = true; };
    item.setSaveDialogOptions = options => { prompts.push(options); };
    item.getSavePath = () => `/tmp/${filename}`;
    item.getTotalBytes = () => 100;
    item.getReceivedBytes = () => item.received || 0;
    return item;
  };

  const item = makeItem('课件.pdf');
  campusSession.emit('will-download', {}, item);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(prompts, [{ defaultPath: '课件.pdf' }]);
  item.received = 40;
  item.emit('updated');
  assert.deepEqual(browser.downloadState, {
    filename: '课件.pdf', status: 'downloading', percent: 40,
  });
  item.emit('done', {}, 'interrupted');
  assert.deepEqual(errors, ['下载未完成：课件.pdf']);

  const completed = makeItem('课件.pdf');
  campusSession.emit('will-download', {}, completed);
  await new Promise((resolve) => setImmediate(resolve));
  completed.received = 100;
  completed.emit('done', {}, 'completed');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(browser.downloadState, {
    filename: '课件.pdf', status: 'completed', percent: 100,
  });
  assert.deepEqual(shown, ['/tmp/课件.pdf']);

  const cancelled = makeItem('取消.zip');
  campusSession.emit('will-download', {}, cancelled);
  cancelled.emit('done', {}, 'cancelled');
  assert.equal(browser.downloadState, null, 'native cancellation clears progress without an error');
  assert.equal(errors.length, 1);

  const bare = new CampusBrowser({});
  const headless = makeItem('no-dialog.bin');
  delete headless.setSaveDialogOptions;
  await bare.handleDownload(headless);
  assert.equal(headless.cancelled, true, 'without native save options the download cannot proceed');
});

test('fast downloads register native save options and completion synchronously', async () => {
  const dialog = {
    showSaveDialog: () => assert.fail('custom save dialog must not delay will-download setup'),
    showMessageBox: async () => ({ response: 1 }),
  };
  const { browser, sessions } = createFakeBrowser({ dialog });
  const campusSession = sessions.get(CAMPUS_PARTITION);
  await browser.configure(1080, ROUTE_CAMPUS);

  const item = new EventEmitter();
  item.getFilename = () => 'fast.pdf';
  item.getTotalBytes = () => 100;
  item.getReceivedBytes = () => 100;
  item.setSaveDialogOptions = (options) => { item.saveDialogOptions = options; };
  item.getSavePath = () => '/tmp/fast.pdf';
  item.cancel = () => { item.cancelled = true; };

  campusSession.emit('will-download', {}, item);
  assert.deepEqual(item.saveDialogOptions, { defaultPath: 'fast.pdf' },
    'native picker options must be configured before will-download returns');

  item.emit('done', {}, 'completed');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(browser.downloadState, {
    filename: 'fast.pdf', status: 'completed', percent: 100,
  });
});

test('site passwords are offered only after a successful later navigation', async () => {
  const prompts = [];
  const saved = [];
  const vault = {
    get: async () => null,
    save: async (...credential) => saved.push(credential),
  };
  const { browser } = createFakeBrowser({
    credentialVault: vault,
    dialog: {
      showMessageBox: async (_window, options) => {
        prompts.push(options);
        return { response: 0 };
      },
    },
  });
  await browser.open('sso.example.edu/login', 1080);
  const tab = browser.activeTab();
  const contents = tab.view.webContents;
  const candidate = {
    origin: 'https://sso.example.edu',
    username: 'student001',
    password: 'local-secret',
  };

  contents.emit('ipc-message', {}, 'campus-credential-candidate', candidate);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prompts.length, 0, 'submitting a form must not immediately ask to save');
  assert.equal(saved.length, 0);

  contents.url = 'https://portal.example.edu/home';
  contents.emit('did-navigate', {}, contents.url);
  contents.emit('ipc-message', {}, 'campus-credential-page-state', {
    origin: 'https://portal.example.edu',
    hasLoginForm: false,
    hasChallengeForm: false,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(prompts.length, 1);
  assert.deepEqual(saved, [[
    'https://sso.example.edu',
    'student001',
    'local-secret',
  ]], 'the saved scope stays on the exact HTTPS origin that received the password');
  assert.equal(tab.pendingCredential, null);
});

test('same-document SPA login uses the existing explicit credential prompt', async () => {
  const prompts = [];
  const saved = [];
  const { browser } = createFakeBrowser({
    credentialVault: {
      get: async () => null,
      save: async (...credential) => saved.push(credential),
    },
    dialog: {
      showMessageBox: async (_window, options) => {
        prompts.push(options);
        return { response: 0 };
      },
    },
  });
  await browser.open('sso.example.edu/login', 1080);
  const contents = browser.activeTab().view.webContents;
  contents.emit('ipc-message', {}, 'campus-credential-candidate', {
    origin: 'https://sso.example.edu',
    username: 'student001',
    password: 'local-secret',
  });
  contents.emit('ipc-message', {}, 'campus-credential-page-state', {
    origin: 'https://sso.example.edu',
    hasLoginForm: false,
    hasChallengeForm: false,
    transition: 'same-document',
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(prompts.length, 1);
  assert.deepEqual(saved, [[
    'https://sso.example.edu', 'student001', 'local-secret',
  ]]);
});

test('ordinary web popups remain isolated Campus Browser tabs', async () => {
  const { browser } = createFakeBrowser();
  await browser.open('portal.example.edu/home', 1080);
  const owner = browser.activeTab();
  const response = owner.view.webContents.popupHandler({
    url: 'https://help.example.edu/article',
  });

  assert.deepEqual(response, { action: 'deny' });
  await nextImmediate();
  assert.equal(browser.tabs.length, 2);
  assert.equal(browser.activeTab().view.webContents.url, 'https://help.example.edu/article');
  assert.equal(browser.managedCredentialPopups.size, 0);
});

test('popup MFA shares only flow ownership and blocks the originating tab', async () => {
  const prompts = [];
  const saved = [];
  const { browser } = createFakeBrowser({
    credentialVault: {
      get: async () => null,
      save: async (...credential) => saved.push(credential),
    },
    dialog: {
      showMessageBox: async (_window, options) => {
        prompts.push(options);
        return { response: 0 };
      },
    },
  });
  await browser.open('sso.example.edu/login', 1080);
  const owner = browser.activeTab();
  const ownerContents = owner.view.webContents;
  ownerContents.emit('ipc-message', {}, 'campus-credential-candidate', {
    origin: 'https://sso.example.edu',
    username: 'student001',
    password: 'local-secret',
  });
  ownerContents.url = 'https://sso.example.edu/waiting';
  ownerContents.emit('did-navigate', {}, ownerContents.url, 200);

  const response = ownerContents.popupHandler({ url: 'https://mfa.example.edu/challenge' });
  assert.equal(response.action, 'allow');
  assert.equal(response.outlivesOpener, false);
  const popupContents = response.createWindow({ webPreferences: {} });
  ownerContents.emit('ipc-message', {}, 'campus-credential-page-state', {
    origin: 'https://sso.example.edu', hasLoginForm: false, hasChallengeForm: false,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prompts.length, 0, 'the popup reservation blocks a racing opener result');

  assert.equal(browser.tabs.length, 1, 'the native challenge window does not consume a tab');
  const popup = [...browser.managedCredentialPopups][0];
  assert.equal(popup.pendingCredential, null, 'the popup never receives a password copy');
  assert.equal(
    popup.window.options.webPreferences.session,
    owner.view.options.webPreferences.session,
    'SSO and SameSite behavior use the same persistent Electron Session',
  );
  assert.equal(browser.ownsWebContents(popupContents), true,
    'proxy auth and certificate policy continue to recognize the child window');
  popupContents.url = 'https://mfa.example.edu/challenge';
  popupContents.emit('did-navigate', {}, popupContents.url, 200);
  popupContents.emit('ipc-message', {}, 'campus-credential-page-state', {
    origin: 'https://mfa.example.edu', hasLoginForm: false, hasChallengeForm: true,
  });
  ownerContents.emit('ipc-message', {}, 'campus-credential-page-state', {
    origin: 'https://sso.example.edu', hasLoginForm: false, hasChallengeForm: false,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prompts.length, 0, 'the opener remains blocked while challenge is active');

  popupContents.emit('ipc-message', {}, 'campus-credential-page-state', {
    origin: 'https://mfa.example.edu', hasLoginForm: false, hasChallengeForm: false,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prompts.length, 1);
  assert.deepEqual(saved, [[
    'https://sso.example.edu', 'student001', 'local-secret',
  ]]);
});

test('popup creation failure releases its reservation without disturbing the opener', async () => {
  const errors = [];
  const { browser } = createFakeBrowser({
    credentialVault: { get: async () => null, save: async () => {} },
    onError: (message) => errors.push(message),
    failPopupWindow: true,
  });
  await browser.open('sso.example.edu/login', 1080);
  const owner = browser.activeTab();
  const ownerContents = owner.view.webContents;
  ownerContents.emit('ipc-message', {}, 'campus-credential-candidate', {
    origin: 'https://sso.example.edu',
    username: 'student001',
    password: 'local-secret',
  });
  assert.ok(owner.pendingCredential);

  const response = ownerContents.popupHandler({ url: 'https://mfa.example.edu/challenge' });
  assert.equal(response.action, 'allow');
  assert.throws(() => response.createWindow({ webPreferences: {} }),
    /synthetic native popup failure/);

  assert.equal(browser.tabs.length, 1);
  assert.equal(browser.managedCredentialPopups.size, 0);
  assert.equal(browser.activeTab(), owner);
  assert.equal(owner.pendingCredential.password, 'local-secret');
  const flow = browser.credentialController.flowFor(owner);
  assert.equal(flow.reservations, 0);
  assert.equal(flow.popups.size, 0);
  assert.deepEqual(errors, ['新标签页创建失败，请重试']);
});

test('a post-navigation login form is treated as failure and never saved', async () => {
  let promptCount = 0;
  let saveCount = 0;
  const { browser } = createFakeBrowser({
    credentialVault: {
      get: async () => null,
      save: async () => { saveCount++; },
    },
    dialog: {
      showMessageBox: async () => {
        promptCount++;
        return { response: 0 };
      },
    },
  });
  await browser.open('sso.example.edu/login', 1080);
  const tab = browser.activeTab();
  const contents = tab.view.webContents;
  contents.emit('ipc-message', {}, 'campus-credential-candidate', {
    origin: 'https://sso.example.edu',
    username: 'student001',
    password: 'wrong-secret',
  });
  contents.emit('did-navigate', {}, 'https://sso.example.edu/login?error=1');
  contents.url = 'https://sso.example.edu/login?error=1';
  contents.emit('ipc-message', {}, 'campus-credential-page-state', {
    origin: 'https://sso.example.edu',
    hasLoginForm: true,
    hasChallengeForm: false,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(promptCount, 0);
  assert.equal(saveCount, 0);
  assert.equal(tab.pendingCredential, null);
});

test('an HTTP authentication failure never offers the submitted password', async () => {
  let prompts = 0;
  const { browser } = createFakeBrowser({
    dialog: {
      showMessageBox: async () => { prompts++; return { response: 0 }; },
    },
  });
  await browser.open('sso.example.edu/login', 1080);
  const tab = browser.activeTab();
  const contents = tab.view.webContents;
  browser.stageCredentialCandidate(tab, {
    origin: 'https://sso.example.edu',
    username: 'student',
    password: 'not-saved',
  });
  contents.url = 'https://sso.example.edu/login';
  contents.emit('did-navigate', {}, contents.url, 401, 'Unauthorized');
  contents.emit('ipc-message', {}, 'campus-credential-page-state', {
    origin: 'https://sso.example.edu',
    hasLoginForm: false,
    hasChallengeForm: false,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prompts, 0);
  assert.equal(tab.pendingCredential, null, 'a rejected response discards the candidate');
});

test('renderer crash is isolated to one tab and reload retries its last URL', async () => {
  const { browser } = createFakeBrowser();
  await browser.open('portal.example.internal/course', 1080);
  const tab = browser.activeTab();
  const contents = tab.view.webContents;
  const originalUrl = contents.getURL();

  contents.emit('render-process-gone', {}, { reason: 'crashed' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tab.failedUrl, originalUrl);
  assert.equal(tab.crashed, true);
  assert.match(contents.getURL(), /^data:text\/html/);
  assert.equal(browser.tabs.length, 1);

  browser.handleToolbarCommand({ command: 'reload', value: '' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(contents.getURL(), originalUrl);
  assert.equal(tab.crashed, false);
  assert.equal(tab.failedUrl, '');
});

test('tab, renderer, and window teardown cancel pending certificate decisions', async () => {
  const { browser } = createFakeBrowser();
  await browser.open('portal.example.internal', 1080);
  let cancellations = 0;
  browser.certificateController.cancelAll = () => { cancellations++; };

  assert.equal(browser.closeTab(browser.activeTabId), true);
  assert.equal(cancellations, 1);
  const active = browser.activeTab();
  browser.handleRendererCrash(active, { reason: 'crashed' });
  assert.equal(cancellations, 2);

  const window = browser.window;
  window.emit('closed');
  assert.equal(cancellations, 3);
  browser.close();
  assert.equal(cancellations, 4);
});
