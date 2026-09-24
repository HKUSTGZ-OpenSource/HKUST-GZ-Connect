'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CampusBrowserManager,
  browserProfilePresentation,
  officialPortalHomeUrl,
} = require('../../../../lib/browser/session/campus-browser-manager');

class FakeVault {
  constructor(options) { this.options = options; }
}

class FakeBrowser {
  constructor(options) {
    this.options = options;
    this.routingSuspended = false;
    this.routingRequestsBlocked = true;
    this.opens = [];
  }
  async open(...args) { this.opens.push(args); }
  async openWorkspace(port) { this.opens.push(['workspace', port]); return 'about:blank'; }
  focusWorkspace(target) { this.workspaceFocus = target; return true; }
  focusAddressBar() { this.addressFocused = true; return true; }
  suspendRoutingPolicy() { this.routingSuspended = true; return 'suspended'; }
  resumeRoutingPolicy(port) { this.routingSuspended = false; return port; }
  close() { return 'closed'; }
  closeForContextSwitch() { this.contextClosed = true; return Promise.resolve(true); }
  ownsWebContents(value) { return value === 'owned'; }
  handleCertificateError(value) { return value; }
  setLocale(...args) { this.locale = args; }
}

function fixture(overrides = {}) {
  const errors = [];
  const manager = new CampusBrowserManager({
    BrowserWindow: function BrowserWindow() {},
    WebContentsView: function WebContentsView() {},
    session: {},
    dialog: {},
    safeStorage: {},
    platform: 'darwin',
    credentialFile: '/fixture/campus-credentials.json',
    certificateTrust: { isTrusted() {}, trust() {} },
    parentWindow: () => null,
    toolbarFile: '/fixture/campus-browser.html',
    toolbarPreload: '/fixture/toolbar.js',
    campusPreload: '/fixture/preload.js',
    workspaceFile: '/fixture/campus-workspace.html',
    workspacePreload: '/fixture/workspace-preload.js',
    browserPartition: 'persist:campus-workspace-test',
    routingPolicy: {},
    ensureCampusReady: async () => true,
    resolveRoute: () => ({ route: 'campus' }),
    ensureConnected: async () => ({ ok: true }),
    getSocksPort: () => 6180,
    getNewTabUrl: () => 'https://www.bing.com/',
    getLocale: () => 'zh',
    getTranslator: () => (key, vars) => vars?.message ? `${key}:${vars.message}` : key,
    getProfilePresentation: () => ({
      schoolName: 'Example University', unverified: false,
      officialPortalResourceId: 'official-portal',
    }),
    getWorkspaceResources: () => [{
      id: 'library', name: 'Library', description: 'Research resources',
      url: 'https://library.example.edu/', route: 'campus', favorite: true,
      lastOpenedAt: null, category: 'academic', builtin: true,
    }],
    getWorkspaceGroups: () => [],
    onOpenResource: async () => ({ ok: true }),
    onWorkspaceMutation: async () => ({ ok: true }),
    getSharedPortalCredential: () => null,
    showItemInFolder: () => {},
    showRoutingRules: () => {},
    showSettings: () => {},
    reportError: (message) => errors.push(message),
    CampusBrowserClass: FakeBrowser,
    CredentialVaultClass: FakeVault,
    ...overrides,
  });
  return { errors, manager };
}

test('manager creates one browser with Engine-neutral injected policies', async () => {
  const f = fixture();
  const result = await f.manager.open({ url: 'https://campus.example.test/x' });
  assert.deepEqual(result, {
    ok: true, url: 'https://campus.example.test/x', route: 'campus',
  });
  const browser = f.manager.browser;
  assert.deepEqual(browser.opens, [['https://campus.example.test/x', 6180, 'campus']]);
  assert.equal(f.manager.getOrCreate(), browser);
  assert.equal(browser.options.credentialVault.options.filePath, '/fixture/campus-credentials.json');
  assert.deepEqual(browser.options.profilePresentation, {
    schoolName: 'Example University', unverified: false,
    officialPortalResourceId: 'official-portal',
  });
  assert.equal(browser.options.getWorkspaceResources()[0].id, 'library');
  assert.equal(browser.options.getNewTabUrl(), 'https://www.bing.com/');
  assert.equal(typeof browser.options.onOpenSettings, 'function');
  assert.equal(typeof browser.options.getSharedPortalCredential, 'function');
  assert.equal(Object.hasOwn(browser.options, 'gatewayToken'), false);
  assert.deepEqual(await browser.options.workspaceController.onCommand({ command: 'focus-address' }), { ok: true });
  assert.equal(browser.addressFocused, true);
});

test('bookmark folders use a native menu above WebContentsView and retain ID-only authority', async () => {
  const opened = [];
  const popups = [];
  let template = null;
  const f = fixture({
    Menu: {
      buildFromTemplate(value) {
        template = value;
        return { popup: (options) => popups.push(options) };
      },
    },
    onOpenResource: async (resourceId) => { opened.push(resourceId); return { ok: true }; },
  });
  const browser = f.manager.getOrCreate();
  assert.equal(browser.options.showBookmarkMenu([{
    type: 'folder', id: 'group_abcdefghijkl', name: '学习',
    children: [{ id: 'canvas', name: 'Canvas' }],
  }]), true);
  assert.equal(popups.length, 1);
  assert.equal(template[0].label, '学习');
  assert.equal(template[0].submenu[0].label, 'Canvas');
  assert.equal(JSON.stringify(template).includes('https://'), false);
  template[0].submenu[0].click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(opened, ['canvas']);
});

test('Browser presentation keeps only bounded school and trust display fields', () => {
  assert.deepEqual(browserProfilePresentation({
    schoolName: ' Example University ', unverified: true,
    officialPortalResourceId: 'official-portal', profileKey: 'must-not-cross',
  }), {
    schoolName: 'Example University', unverified: true,
    officialPortalResourceId: 'official-portal',
  });
  assert.throws(() => browserProfilePresentation({
    schoolName: '<script>', unverified: false,
  }), /presentation/u);
});

test('official portal home resolves only through the active Profile resource ID', () => {
  const profile = { schoolName: 'Example University', unverified: false,
    officialPortalResourceId: 'official-portal' };
  assert.equal(officialPortalHomeUrl(profile, [
    { id: 'other', url: 'https://other.example.edu/' },
    { id: 'official-portal', url: 'https://portal.example.edu/' },
  ]), 'https://portal.example.edu/');
  assert.equal(officialPortalHomeUrl({ ...profile, officialPortalResourceId: null }, []), null);
  assert.equal(officialPortalHomeUrl(profile, [{ id: 'other', url: 'https://other.example.edu/' }]), null);
});

test('every Profile uses its isolated partition and local Workspace Home without network fallback', async () => {
  const partition = `persist:campus-workspace-${'1'.repeat(32)}`;
  let connectionCalls = 0;
  const f = fixture({
    homeUrl: null,
    browserPartition: partition,
    ensureConnected: async () => { connectionCalls += 1; return { ok: true }; },
  });
  const result = await f.manager.open();
  assert.equal(result.url, 'about:blank');
  assert.equal(f.manager.browser.options.homeUrl, 'about:blank');
  assert.equal(f.manager.browser.options.partition, partition);
  assert.deepEqual(f.manager.browser.opens, [['about:blank', 6180, 'direct']]);
  assert.equal(connectionCalls, 0);
});

test('a reviewed Profile opens its Main-resolved official portal as the browser home', async () => {
  let connectionCalls = 0;
  const f = fixture({
    homeUrl: 'https://portal.example.edu/',
    ensureConnected: async () => { connectionCalls += 1; return { ok: true }; },
  });
  const result = await f.manager.open();
  assert.equal(result.url, 'https://portal.example.edu/');
  assert.equal(f.manager.browser.options.homeUrl, 'https://portal.example.edu/');
  assert.equal(connectionCalls, 1);
  assert.deepEqual(f.manager.browser.opens, [['https://portal.example.edu/', 6180, 'campus']]);
  assert.equal(f.manager.browser.options.getWorkspaceResources()[0].url,
    'https://library.example.edu/');
});

test('portal session routing hints stay Main-owned and are cleared at a context switch', async () => {
  const f = fixture({ homeUrl: 'https://portal.example.edu/' });
  const browser = f.manager.getOrCreate();
  assert.equal(browser.options.onPortalSessionUrl(
    'https://portal.example.edu/?tt=short-lived-routing-nonce',
  ), true);
  assert.equal(browser.options.onPortalSessionUrl('https://portal.example.edu/'), true);
  assert.equal(f.manager.portalSessionUrl('https://portal.example.edu/'),
    'https://portal.example.edu/?tt=short-lived-routing-nonce');
  assert.equal(browser.options.onPortalSessionUrl('https://evil.example/'), false);
  assert.equal(f.manager.portalSessionUrl('https://other.example.edu/'), null);
  assert.equal(await f.manager.closeForContextSwitch(), true);
  assert.equal(f.manager.portalSessionUrl('https://portal.example.edu/'), null);
});

test('bookmark organization opens the local Workspace without loading the portal first', async () => {
  let connectionCalls = 0;
  const f = fixture({
    homeUrl: 'https://portal.example.edu/',
    ensureConnected: async () => { connectionCalls += 1; return { ok: true }; },
  });
  assert.deepEqual(await f.manager.openBookmarkManager(), {
    ok: true, url: 'about:blank', route: 'direct',
  });
  assert.deepEqual(f.manager.browser.opens, [['workspace', 6180]]);
  assert.equal(f.manager.browser.workspaceFocus, 'manage');
  assert.equal(connectionCalls, 0);
});

test('a Direct WebResource opens without starting or requiring the campus Engine', async () => {
  let connectionCalls = 0;
  const f = fixture({
    resolveRoute: () => ({ route: 'direct' }),
    ensureConnected: async () => { connectionCalls += 1; return { ok: false, error: 'offline' }; },
  });
  const result = await f.manager.open({ url: 'https://outlook.office.com/owa/', route: 'direct' });
  assert.equal(result.ok, true);
  assert.equal(result.route, 'direct');
  assert.equal(connectionCalls, 0);
  assert.deepEqual(f.manager.browser.opens, [[
    'https://outlook.office.com/owa/', 6180, 'direct',
  ]]);
});

test('route, connection and browser failures return bounded UI results', async () => {
  const route = fixture({ resolveRoute: () => { throw new Error('route-failed'); } });
  assert.deepEqual(await route.manager.open('https://x.test'), {
    ok: false, error: 'route-failed',
  });
  const connection = fixture({ ensureConnected: async () => ({ ok: false, error: 'offline' }) });
  assert.deepEqual(await connection.manager.open('https://x.test'), {
    ok: false, error: 'offline',
  });
  class FailingBrowser extends FakeBrowser {
    async open() { throw new Error('synthetic'); }
  }
  const browser = fixture({ CampusBrowserClass: FailingBrowser });
  assert.deepEqual(await browser.manager.open('https://x.test'), {
    ok: false, error: 'error.browserStart:synthetic',
  });
});

test('lifecycle and certificate wrappers are inert before creation and delegate after', () => {
  const f = fixture();
  assert.equal(f.manager.suspendRoutingPolicy(), null);
  assert.equal(f.manager.ownsWebContents('owned'), false);
  f.manager.getOrCreate();
  assert.equal(f.manager.suspendRoutingPolicy(), 'suspended');
  assert.equal(f.manager.routingSuspended, true);
  assert.equal(f.manager.resumeRoutingPolicy(7000), 7000);
  assert.equal(f.manager.ownsWebContents('owned'), true);
  assert.deepEqual(f.manager.handleCertificateError({ origin: 'fixture' }), { origin: 'fixture' });
  f.manager.setLocale('en', () => {});
  assert.equal(f.manager.browser.locale[0], 'en');
  const retired = f.manager.browser;
  assert.equal(f.manager.close(), 'closed');
  assert.equal(f.manager.hasBrowser, false);
  assert.notEqual(f.manager.getOrCreate(), retired);
});

test('context switch close retains ownership until Browser confirms closed', async () => {
  const f = fixture();
  assert.equal(await f.manager.closeForContextSwitch(), true);
  const browser = f.manager.getOrCreate();
  assert.equal(await f.manager.closeForContextSwitch(), true);
  assert.equal(browser.contextClosed, true);
  assert.equal(f.manager.browser, null);
});

test('confirmed context closure retires downloads but a veto retains them', async () => {
  const f = fixture();
  const browser = f.manager.getOrCreate();
  let retired = 0;
  browser.downloadController = { retire: () => { retired += 1; } };
  browser.closeForContextSwitch = async () => false;
  assert.equal(await f.manager.closeForContextSwitch(), false);
  assert.equal(retired, 0);
  browser.closeForContextSwitch = async () => true;
  assert.equal(await f.manager.closeForContextSwitch(), true);
  assert.equal(retired, 1);
});

test('explicit manager disposal retires the download owner', () => {
  const f = fixture();
  const browser = f.manager.getOrCreate();
  let retired = false;
  browser.downloadController = { retire: () => { retired = true; } };
  f.manager.close();
  assert.equal(retired, true);
});

test('late old-context close preserves the replacement Browser and its portal URL', async () => {
  const f = fixture();
  const old = f.manager.getOrCreate();
  let finish, retired = false;
  old.closeForContextSwitch = () => new Promise(resolve => { finish = resolve; });
  old.downloadController = { retire: () => { retired = true; } };
  const pending = f.manager.closeForContextSwitch();
  const replacement = {};
  f.manager.browser = replacement;
  f.manager.lastPortalSessionUrl = 'https://synthetic.example/new-context';
  finish(true);
  assert.equal(await pending, false);
  assert.equal(retired, true);
  assert.equal(f.manager.browser, replacement);
  assert.equal(f.manager.lastPortalSessionUrl, 'https://synthetic.example/new-context');
});

test('clearing site data closes the active Browser and clears only its bound partition', async () => {
  const calls = [];
  const partition = {
    closeAllConnections: async () => { calls.push('connections'); },
    clearStorageData: async () => { calls.push('storage'); },
    clearCache: async () => { calls.push('cache'); },
  };
  const f = fixture({
    session: {
      fromPartition(value) {
        calls.push(['partition', value]);
        return partition;
      },
    },
  });
  const browser = f.manager.getOrCreate();
  assert.equal(await f.manager.clearSiteData(), true);
  assert.equal(browser.contextClosed, true);
  assert.equal(f.manager.browser, null);
  assert.deepEqual(calls, [
    ['partition', 'persist:campus-workspace-test'],
    'connections', 'storage', 'cache',
  ]);
});

test('site-data clearing fails closed when the bound Session cannot clear storage', async () => {
  const f = fixture({ session: { fromPartition: () => ({ clearCache() {} }) } });
  assert.equal(await f.manager.clearSiteData(), false);
});
