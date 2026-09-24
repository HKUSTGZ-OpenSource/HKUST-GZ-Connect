'use strict';

// Drives the real campus-browser chrome (toolbar + tabs) with a real
// CampusBrowser against loopback URLs that fail fast, without any network.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, WebContentsView, ipcMain, session } = require('electron');
const {
  BLANK_CAMPUS_HOME,
  CampusBrowser,
  FIND_BAR_HEIGHT,
  TOOLBAR_HEIGHT,
} = require('../lib/browser/session/campus-browser');
const { CampusWorkspaceController } = require('../lib/browser/workspace/campus-workspace-controller');
const { createDefaultCardBoardLayout } = require('../lib/card-board/runtime/card-board-migration');
const { applyCardBoardOperations } = require('../lib/card-board/runtime/card-board-runtime');
const { CAMPUS_PARTITION, ROUTE_CAMPUS, ROUTE_DIRECT } = require('../lib/routing/policy/campus-route');

// Chromium blocks port 1 outright (ERR_UNSAFE_PORT), so tabs settle on the
// local error page immediately instead of hanging the test.
const DEAD_URL = 'http://route-switch.example.invalid:1/x';
const CONFIGURED_HOME = 'https://configured-home.test/start';
const CONFIGURED_NEXT = 'https://configured-home.test/after-resume';
let activeStage = 'boot';

async function waitFor(window, expression, description) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function waitForMain(condition, description) {
  // Cold WebContentsView creation on shared macOS runners can exceed five
  // seconds even for about:blank. This remains a bounded assertion and does
  // not weaken the expected URL or tab-kind checks.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function waitForPage(contents, expression, description) {
  // A cold Electron renderer on the shared macOS CI runner can take more than
  // five seconds to start even though the local file and projected state load
  // correctly. Keep the assertion strict, but give the app-owned page a
  // bounded startup allowance instead of turning runner load into a flake.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await contents.executeJavaScript(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const diagnostic = await contents.executeJavaScript(`(() => ({
    url: location.href,
    readyState: document.readyState,
    bridge: typeof window.campusWorkspace,
    resources: document.querySelectorAll('#workspacePersonalBoardHost .cb-site').length,
    body: document.body?.innerText?.slice(0, 500) || '',
  }))()`);
  throw new Error(`Timed out waiting for ${description}: ${JSON.stringify(diagnostic)}`);
}

async function runStage(name, operation) {
  activeStage = name;
  try { return await operation(); }
  catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  }
}

function toolbarCommand(browser, command, value = '') {
  return browser.window.webContents.executeJavaScript(
    `window.campusToolbar.command(${JSON.stringify(command)}, ${JSON.stringify(value)})`,
  );
}

function assertOnlyActiveTabAttached(browser) {
  const tabViews = browser.window.contentView.children.filter((child) => (
    browser.tabs.some((tab) => tab.view === child)
  ));
  assert.deepEqual(tabViews, [browser.activeTab().view],
    'only the selected page may remain in the native View/accessibility hierarchy');
}

async function assertDragRegions(browser) {
  const regions = await browser.window.webContents.executeJavaScript(`(() => {
    const pick = (selector) => getComputedStyle(document.querySelector(selector))
      .getPropertyValue('-webkit-app-region');
    return {
      routeSelector: pick('#routeSelector'),
      back: pick('#back'),
      address: pick('#address'),
      findBar: pick('#findBar'),
      findInput: pick('#findInput'),
      findPrev: pick('#findPrev'),
      findNext: pick('#findNext'),
      findClose: pick('#findClose'),
      bookmarkBar: pick('#bookmarkBar'),
      manageBookmarks: pick('#manageBookmarks'),
      browserSettings: pick('#browserSettings'),
    };
  })()`);
  for (const [control, region] of Object.entries(regions)) {
    assert.equal(region, 'no-drag', `${control} must not be part of the window drag region`);
  }
}

async function assertBookmarkBar(browser, openedResources, bookmarkMenus) {
  await waitFor(browser.window,
    "document.querySelectorAll('#bookmarkItems > .bookmark-entry').length === 2 && document.querySelectorAll('#bookmarkItems > .bookmark-folder').length === 1",
    'Chrome-style bookmark bar');
  const state = await browser.window.webContents.executeJavaScript(`(() => ({
    labels: [...document.querySelectorAll('#bookmarkItems > .bookmark-entry')]
      .map((button) => button.textContent.trim()),
    official: [...document.querySelectorAll('#bookmarkItems > .bookmark-entry')]
      .map((button) => button.classList.contains('official')),
    manage: document.getElementById('manageBookmarks').textContent.trim(),
    barHeight: document.getElementById('bookmarkBar').getBoundingClientRect().height,
  }))()`);
  assert.deepEqual(state.labels, ['Service', 'Favorite']);
  assert.deepEqual(state.official, [true, false]);
  assert.equal(state.manage, '整理书签');
  assert.equal(state.barHeight, 32);
  await browser.window.webContents.executeJavaScript(
    `document.querySelector('[data-bookmark-id="favorite"]').click()`,
  );
  await waitForMain(() => openedResources.includes('favorite'), 'bookmark click to reach Main');
  await browser.window.webContents.executeJavaScript(`(() => {
    const folder = document.querySelector('#bookmarkItems > .bookmark-folder');
    folder.querySelector(':scope > .bookmark-control').click();
  })()`);
  await waitForMain(() => bookmarkMenus.length > 0, 'folder bookmark native menu');
  assert.deepEqual(bookmarkMenus.at(-1), [{ id: 'grouped', name: 'Grouped Site' }]);
}

async function assertBookmarkOrganizer(browser) {
  await browser.window.webContents.executeJavaScript(
    `document.getElementById('manageBookmarks').click()`,
  );
  await waitForMain(() => browser.activeTab()?.kind === 'workspace',
    'bookmark organizer Workspace tab');
  await waitForPage(browser.activeTab().view.webContents,
    "document.querySelector('#workspacePersonalBoardHost [data-card-board]')?.dataset.editing === 'true' && document.getElementById('workspaceCardBoardPersonal').hidden === false && document.querySelector('[data-primary-view].active')?.dataset.primaryView === 'workspace'",
    'inline bookmark organizer');
}

async function assertBlankNewTab(browser) {
  const previous = browser.activeTab();
  await browser.window.webContents.executeJavaScript(
    `document.getElementById('newTab').click()`,
  );
  await waitForMain(() => browser.activeTab()?.kind === 'blank',
    'plus button to create a blank tab');
  await waitForMain(() => browser.activeTab()?.view.webContents.getURL() === BLANK_CAMPUS_HOME,
    'blank tab navigation');
  assert.equal(browser.currentUrl(browser.activeTab()), BLANK_CAMPUS_HOME);
  assert.equal(browser.activeTab().route, ROUTE_DIRECT);
  assert.notEqual(browser.activeTab().id, previous.id);
  assertOnlyActiveTabAttached(browser);
  browser.closeTab(browser.activeTab().id);
  await waitForMain(() => browser.activeTab()?.id === previous.id,
    'closing the blank tab to restore the previous tab');
  assertOnlyActiveTabAttached(browser);
}

async function assertConfiguredHomeAndSuspendedRecovery(browser, preference, committedUrls) {
  const previous = browser.activeTab();
  preference.url = CONFIGURED_HOME;
  await browser.window.webContents.executeJavaScript(
    `document.getElementById('newTab').click()`,
  );
  await waitForMain(() => committedUrls.includes(CONFIGURED_HOME),
    'configured homepage real did-navigate commit');
  const tab = browser.activeTab();
  assert.notEqual(tab.id, previous.id);
  assert.equal(tab.view.webContents.getURL(), CONFIGURED_HOME);
  assert.equal(tab.route, ROUTE_CAMPUS);
  assert.equal(tab.routeSource, 'default');
  assert.match(await browser.campusSession.resolveProxy(CONFIGURED_HOME),
    /SOCKS5 127\.0\.0\.1:11080/,
    'toolbar metadata and the live PAC must share the Campus default');
  await waitFor(browser.window,
    "document.getElementById('routeSelector').value === 'auto'",
    'configured homepage route label');
  assertOnlyActiveTabAttached(browser);

  await browser.suspendRoutingPolicy();
  assert.equal(browser.routingSuspended, true);
  assert.equal(browser.routingRequestsBlocked, true);
  await toolbarCommand(browser, 'navigate', CONFIGURED_NEXT);
  await waitForMain(() => committedUrls.includes(CONFIGURED_NEXT),
    'address navigation after Session resume');
  assert.equal(browser.routingSuspended, false);
  assert.equal(browser.routingRequestsBlocked, false);
  assert.equal(tab.view.webContents.getURL(), CONFIGURED_NEXT);

  let reloadCommits = 0;
  const onReloadCommit = (_event, url) => {
    if (url === CONFIGURED_NEXT) reloadCommits += 1;
  };
  tab.view.webContents.on('did-navigate', onReloadCommit);
  await browser.suspendRoutingPolicy();
  await toolbarCommand(browser, 'reload');
  await waitForMain(() => reloadCommits > 0, 'reload after Session resume');
  tab.view.webContents.removeListener('did-navigate', onReloadCommit);
  assert.equal(browser.routingSuspended, false);
  assert.equal(browser.routingRequestsBlocked, false);
  assertOnlyActiveTabAttached(browser);

  browser.switchTab(previous.id);
  assertOnlyActiveTabAttached(browser);
  assert.equal(tab.view.webContents.isDestroyed(), false,
    'an inactive detached tab retains its WebContents state');
  browser.closeTab(tab.id);
  preference.url = BLANK_CAMPUS_HOME;
}

async function assertSettingsButton(browser, settingsOpens) {
  await browser.window.webContents.executeJavaScript(
    `document.getElementById('browserSettings').click()`,
  );
  await waitForMain(() => settingsOpens.count === 1, 'settings toolbar action');
}

async function assertRouteSwitch(browser) {
  await waitForMain(
    () => browser.activeTab()?.failedUrl === DEAD_URL &&
      !browser.activeTab().view.webContents.isLoading(),
    'initial tab to settle on its error page',
  );
  assert.equal(browser.activeTab().route, 'campus');

  await browser.window.webContents.executeJavaScript(`(() => {
    const selector = document.getElementById('routeSelector');
    selector.value = 'direct';
    selector.dispatchEvent(new Event('change'));
  })()`);
  await waitForMain(() => browser.activeTab()?.route === 'direct', 'route switch to direct');
  assert.equal(
    browser.activeTab().view.webContents.session,
    session.fromPartition(CAMPUS_PARTITION),
    'route changes must preserve the one browser session and its SSO state',
  );
  await waitFor(
    browser.window,
    "document.getElementById('routeSelector').value === 'direct'",
    'route selector to follow the tab route',
  );
  await browser.window.webContents.executeJavaScript(`(() => {
    const selector = document.getElementById('routeSelector');
    selector.value = 'auto';
    selector.dispatchEvent(new Event('change'));
  })()`);
  await waitForMain(() => browser.activeTab()?.route === 'campus' &&
    browser.activeTab()?.routeSource !== 'user-exact', 'route switch back to policy');
  await waitFor(browser.window,
    "document.getElementById('routeSelector').value === 'auto'",
    'route selector to display the inherited policy');
}

async function assertFindBar(browser) {
  const contents = browser.activeTab().view.webContents;
  const findCalls = [];
  const stopCalls = [];
  contents.findInPage = (text, options) => {
    findCalls.push([text, options]);
    return 1;
  };
  contents.stopFindInPage = (action) => stopCalls.push(action);

  await toolbarCommand(browser, 'find-open');
  await waitFor(
    browser.window,
    "document.getElementById('findBar').hidden === false",
    'find bar to open',
  );
  assert.equal(browser.findOpen, true);
  assert.equal(
    browser.activeTab().view.getBounds().y,
    TOOLBAR_HEIGHT + FIND_BAR_HEIGHT,
    'the page must move below the open find bar',
  );

  await toolbarCommand(browser, 'find', '校园');
  await waitForMain(() => findCalls.length > 0, 'findInPage for the query');
  assert.deepEqual(findCalls.at(-1), ['校园', undefined]);

  await toolbarCommand(browser, 'find-next');
  await waitForMain(() => findCalls.length > 1, 'find-next to repeat the search');
  assert.deepEqual(findCalls.at(-1), ['校园', { forward: true, findNext: true }]);

  await toolbarCommand(browser, 'find-prev');
  await waitForMain(() => findCalls.length > 2, 'find-prev to search backwards');
  assert.deepEqual(findCalls.at(-1), ['校园', { forward: false, findNext: true }]);

  await toolbarCommand(browser, 'find-close');
  await waitFor(
    browser.window,
    "document.getElementById('findBar').hidden === true",
    'find bar to close',
  );
  assert.equal(browser.findOpen, false);
  assert.deepEqual(stopCalls, ['clearSelection']);
  assert.equal(browser.activeTab().view.getBounds().y, TOOLBAR_HEIGHT);
}

async function assertWorkspaceHome(browser) {
  const contents = browser.activeTab().view.webContents;
  await waitForPage(contents,
    "document.querySelectorAll('#workspacePersonalBoardHost .cb-site').length === 2",
    'local Workspace Home resources');
  const state = await contents.executeJavaScript(`(() => ({
    duplicateHeader: document.querySelectorAll('.workspace-header').length,
    duplicateSearch: document.querySelectorAll('#workspaceSearch').length,
    activePrimary: document.querySelector('[data-primary-view].active')?.dataset.primaryView,
    favoriteNames: [...document.querySelectorAll('#workspacePersonalBoardHost .cb-site-name')]
      .map((value) => value.textContent).sort(),
    primaryTabs: [...document.querySelectorAll('[data-primary-view]')].map((value) => value.textContent),
    organizerEntry: document.getElementById('openManage')?.textContent,
    leakedUrls: document.body.textContent.includes('example.invalid'),
  }))()`);
  assert.equal(state.duplicateHeader, 0);
  assert.equal(state.duplicateSearch, 0);
  assert.equal(state.activePrimary, 'workspace');
  assert.deepEqual(state.favoriteNames, ['Favorite', 'Grouped Site'],
    'My Workspace must open on the complete favorites view');
  assert.deepEqual(state.primaryTabs, ['我的工作区', '最近使用', '网站库']);
  assert.equal(state.organizerEntry, '整理收藏');
  assert.equal(state.leakedUrls, false, 'Workspace renderer received URL authority');
  assert.match(contents.getURL(), /\/renderer\/campus-workspace\.html$/u,
    'Workspace Home must remain an app-owned local page');
}

async function captureBrowserChrome(browser) {
  const output = process.env.HKUSTGZ_BROWSER_SCREENSHOT_DIR;
  if (!output) return;
  if (!path.isAbsolute(output)) throw new Error('browser screenshot directory must be absolute');
  fs.mkdirSync(output, { recursive: true });
  for (const [label, width, height] of [
    ['compact', 660, 520],
    ['standard', 900, 620],
    ['wide', 1200, 720],
  ]) {
    browser.window.setContentSize(width, height);
    await waitFor(browser.window, `window.innerWidth === ${width}`, `${label} browser width`);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const image = await browser.window.webContents.capturePage();
    fs.writeFileSync(path.join(output, `${label}-browser.png`), image.toPNG());
  }
}

async function main() {
  await app.whenReady();
  const errors = [];
  const openedResources = [];
  const bookmarkMenus = [];
  const settingsOpens = { count: 0 };
  const newTabPreference = { url: BLANK_CAMPUS_HOME };
  const committedUrls = [];
  const isolatedSession = session.fromPartition(CAMPUS_PARTITION);
  await isolatedSession.protocol.handle('https', (request) => {
    const url = new URL(request.url);
    if (url.hostname !== 'configured-home.test') {
      return new Response('not found', { status: 404 });
    }
    return new Response(`<!doctype html><meta charset="utf-8"><title>${url.pathname}</title>`, {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  });
  const workspaceResources = [
    { id: 'favorite', name: 'Favorite', description: 'Pinned',
      url: 'http://favorite.example.invalid:1/', route: ROUTE_CAMPUS,
      category: 'custom', keywords: [], builtin: false,
      favorite: true, lastOpenedAt: null },
    { id: 'recent', name: 'Recent', description: 'Opened',
      url: 'http://recent.example.invalid:1/', route: ROUTE_DIRECT,
      category: 'custom', keywords: [], builtin: false,
      favorite: false, lastOpenedAt: 200 },
    { id: 'service', name: 'Service', description: 'Available',
      url: 'http://service.example.invalid:1/', route: ROUTE_CAMPUS,
      category: 'gateway', keywords: [], builtin: true,
      favorite: false, lastOpenedAt: null },
    { id: 'grouped', name: 'Grouped Site', description: 'Folder bookmark',
      url: 'http://grouped.example.invalid:1/', route: ROUTE_CAMPUS,
      category: 'custom', keywords: [], builtin: false,
      favorite: true, lastOpenedAt: null },
  ];
  const cardBoardAuthority = Object.freeze({
    officialCategoryIds: Object.freeze(['gateway']),
    userCollectionIds: Object.freeze(['group_abcdefghijkl']),
    includeUngroupedFavorites: true,
    connectWidgetIds: Object.freeze([
      'connection-metrics', 'network-adapter', 'connection-details',
    ]),
  });
  let cardBoardDocument = createDefaultCardBoardLayout(cardBoardAuthority);
  ipcMain.handle('get-card-board-layout', () => ({ document: cardBoardDocument }));
  ipcMain.handle('commit-card-board-layout', (_event, request) => {
    if (request.baseRevision !== cardBoardDocument.revision) {
      const error = new Error('revision conflict');
      error.code = 'CARD_BOARD_REVISION_CONFLICT';
      throw error;
    }
    cardBoardDocument = applyCardBoardOperations(
      cardBoardDocument, request.operations, cardBoardAuthority,
    );
    cardBoardDocument = { ...cardBoardDocument, revision: cardBoardDocument.revision + 1 };
    return { document: cardBoardDocument, changed: request.operations.length > 0 };
  });
  ipcMain.handle('reset-card-board-layout', (_event, request) => {
    if (request.baseRevision !== cardBoardDocument.revision) {
      const error = new Error('revision conflict');
      error.code = 'CARD_BOARD_REVISION_CONFLICT';
      throw error;
    }
    const reset = createDefaultCardBoardLayout(cardBoardAuthority);
    cardBoardDocument = { ...reset, revision: cardBoardDocument.revision + 1 };
    return { document: cardBoardDocument, changed: true };
  });
  let browser = null;
  const workspaceController = new CampusWorkspaceController({
    workspaceFile: path.join(__dirname, '..', 'renderer', 'campus-workspace.html'),
    workspacePreload: path.join(__dirname, '..', 'lib', 'browser', 'workspace', 'campus-workspace-preload.js'),
    getProfilePresentation: () => ({
      schoolName: 'Example University', unverified: true, officialPortalResourceId: 'service',
    }),
    getResources: () => workspaceResources,
    getGroups: () => [{
      id: 'group_abcdefghijkl', name: '学习', resourceIds: ['grouped'],
    }],
    getLocale: () => 'zh',
    onCommand: async (command) => command.command === 'focus-address'
      ? { ok: browser?.focusAddressBar() === true }
      : { ok: true },
  });
  browser = new CampusBrowser({
    BrowserWindow,
    WebContentsView,
    session,
    dialog: {
      showSaveDialog: async () => ({ canceled: true }),
      showMessageBox: async () => ({ response: 1 }),
    },
    certificateTrust: { isTrusted: () => false, trust: () => {} },
    credentialVault: null,
    parentWindow: () => null,
    toolbarFile: path.join(__dirname, '..', 'renderer', 'campus-browser.html'),
    toolbarPreload: path.join(__dirname, '..', 'lib', 'browser', 'toolbar', 'campus-toolbar-contract.js'),
    campusPreload: path.join(__dirname, '..', 'campus-preload.js'),
    homeUrl: BLANK_CAMPUS_HOME,
    profilePresentation: {
      schoolName: 'Example University', unverified: true, officialPortalResourceId: 'service',
    },
    getWorkspaceResources: () => workspaceResources,
    getWorkspaceGroups: () => [{
      id: 'group_abcdefghijkl', name: '学习', resourceIds: ['grouped'],
    }],
    workspaceController,
    getNewTabUrl: () => newTabPreference.url,
    onRecordPageOpen: (url) => { committedUrls.push(url); return false; },
    onOpenResource: async (resourceId) => { openedResources.push(resourceId); return { ok: true }; },
    showBookmarkMenu: (entries) => bookmarkMenus.push(entries),
    partition: CAMPUS_PARTITION,
    onError: (message) => errors.push(message),
    onOpenSettings: () => { settingsOpens.count += 1; },
  });

  try {
    await runStage('initial browser open', () =>
      browser.open(BLANK_CAMPUS_HOME, 11080, ROUTE_DIRECT));
    browser.window.hide();
    await runStage('toolbar initialization', () =>
      waitFor(browser.window, '!!window.campusBrowserUI', 'toolbar initialization'));
    await runStage('workspace home', () => assertWorkspaceHome(browser));
    await runStage('active tab attachment', () => assertOnlyActiveTabAttached(browser));
    await runStage('blank new tab', () => assertBlankNewTab(browser));
    await runStage('configured home recovery', () =>
      assertConfiguredHomeAndSuspendedRecovery(browser, newTabPreference, committedUrls));
    await runStage('settings button', () => assertSettingsButton(browser, settingsOpens));
    await runStage('workspace Command-K', async () => {
      const workspaceContents = browser.activeTab().view.webContents;
      await workspaceContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'k', bubbles: true, ${process.platform === 'darwin' ? 'metaKey' : 'ctrlKey'}: true,
      }))`);
      await waitFor(browser.window,
        "document.activeElement === document.getElementById('address')",
        'Workspace Command-K to focus the browser address');
    });
    await runStage('bookmark bar', () => assertBookmarkBar(browser, openedResources, bookmarkMenus));
    await runStage('bookmark organizer', () => assertBookmarkOrganizer(browser));
    await runStage('dead URL tab', () => browser.open(DEAD_URL, 11080, 'campus'));

    await runStage('drag regions', () => assertDragRegions(browser));
    await runStage('route switch', () => assertRouteSwitch(browser));
    await runStage('find bar', () => assertFindBar(browser));
    await runStage('browser screenshots', () => captureBrowserChrome(browser));
    assert.deepEqual(errors, [], `unexpected campus browser errors: ${errors.join('; ')}`);
    process.stdout.write('campus browser toolbar: PASS\n');
  } finally {
    browser.close();
    await isolatedSession.protocol.unhandle('https');
    for (const channel of [
      'get-card-board-layout', 'commit-card-board-layout', 'reset-card-board-layout',
    ]) ipcMain.removeHandler(channel);
  }
}

main().then(
  () => app.quit(),
  (error) => {
    process.stderr.write(`[${activeStage}] ${error.stack || error}\n`);
    app.exit(1);
  },
);
