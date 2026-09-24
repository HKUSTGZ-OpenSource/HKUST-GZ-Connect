'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { CampusWorkspaceController } = require('../lib/browser/workspace/campus-workspace-controller');
const {
  parseBuiltinResourceDocument,
} = require('../lib/resources/schema/campus-resource-contract');
const { createDefaultCardBoardLayout } = require('../lib/card-board/runtime/card-board-migration');
const { applyCardBoardOperations } = require('../lib/card-board/runtime/card-board-runtime');

const favoriteTimes = new Map([
  ['canvas', [true, 900]], ['library', [true, 800]], ['outlook', [true, 600]],
  ['sis', [false, 500]], ['class-schedule', [false, 400]], ['room-booking', [false, 300]],
]);
const reviewed = parseBuiltinResourceDocument(fs.readFileSync(path.join(
  __dirname, '..', 'assets', 'profiles', 'hkustgz', 'builtin-resources.json',
)));
const resources = Object.freeze([
  ...reviewed.map((resource) => {
    const [favorite = false, lastOpenedAt = null] = favoriteTimes.get(resource.id) || [];
    return Object.freeze({
      ...resource,
      name: resource.localizedName.zh,
      description: resource.localizedDescription.zh,
      favorite,
      lastOpenedAt,
    });
  }),
  Object.freeze({
    id: 'hpc', name: 'HPC 登录入口', description: 'Fixture',
    url: 'https://hpc.example.edu/', category: 'custom', route: 'campus',
    favorite: true, lastOpenedAt: 700, builtin: false, keywords: ['HPC'],
  }),
  Object.freeze({
    id: 'long-name',
    name: 'Application Form for Purchase and Reimbursement of Research Expenses',
    description: 'Long bilingual-name layout fixture',
    url: 'https://long-name.example.edu/', category: 'custom', route: 'direct',
    favorite: true, lastOpenedAt: 650, builtin: false, keywords: ['Reimbursement'],
  }),
]);

const cardBoardAuthority = Object.freeze({
  officialCategoryIds: Object.freeze([...new Set(reviewed.map(({ category }) => category))]),
  userCollectionIds: Object.freeze(['group_abcdefghijkl']),
  includeUngroupedFavorites: true,
  connectWidgetIds: Object.freeze([
    'connection-metrics', 'network-adapter', 'connection-details',
  ]),
});

async function inspect(window) {
  return window.webContents.executeJavaScript(`(() => {
    const grid = document.getElementById('serviceViewGrid');
    const board = document.querySelector('#workspaceCardBoard [data-card-board]');
    return {
      width: innerWidth,
      noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth,
      duplicateHeader: document.querySelectorAll('.workspace-header').length,
      duplicateSearch: document.querySelectorAll('#workspaceSearch').length,
      boardId: board?.dataset.boardId || null,
      boardColumns: Number(board?.dataset.boardColumns || 0),
      cards: board?.querySelectorAll('[data-card-placement-id]').length || 0,
      decks: board?.querySelectorAll('.cb-deck[data-stack-count="2"]').length || 0,
      dragHandles: board?.querySelectorAll('[data-card-drag-handle]').length || 0,
      nestedScrollers: [...(board?.querySelectorAll('.cb-card-body, .cb-site-list') || [])]
        .filter((node) => ['auto', 'scroll'].includes(getComputedStyle(node).overflowY)).length,
      primaryTabs: document.querySelectorAll('[data-primary-view]').length,
      secondaryGone: !document.getElementById('secondaryNavigation'),
      serviceGridHidden: grid.hidden,
      manageScreenGone: !document.getElementById('manageScreen'),
    };
  })()`);
}

async function capture(window, label) {
  const output = process.env.HKUSTGZ_WORKSPACE_SCREENSHOT_DIR;
  if (!output) return;
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, `${label}.png`), (await window.webContents.capturePage()).toPNG());
}

async function main() {
  await app.whenReady();
  const commands = [];
  const layoutCommits = [];
  let cardBoardDocument;
{
  // Stack the first two catalog categories into one deck for draw coverage.
  const base = createDefaultCardBoardLayout(cardBoardAuthority);
  const catalog = base.placements.filter(({ boardId }) => boardId === 'browser-catalog');
  cardBoardDocument = applyCardBoardOperations(base, [{
    type: 'create-deck',
    boardId: 'browser-catalog',
    placementIds: [catalog[0].placementId, catalog[1].placementId],
    activePlacementId: catalog[0].placementId,
    index: 0,
  }], cardBoardAuthority);
}
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
    layoutCommits.push(structuredClone(request.operations));
    cardBoardDocument = { ...cardBoardDocument, revision: cardBoardDocument.revision + 1 };
    return { document: cardBoardDocument, changed: request.operations.length > 0 };
  });
  ipcMain.handle('reset-card-board-layout', (_event, request) => {
    if (request.baseRevision !== cardBoardDocument.revision) {
      const error = new Error('revision conflict');
      error.code = 'CARD_BOARD_REVISION_CONFLICT';
      throw error;
    }
    const next = createDefaultCardBoardLayout(cardBoardAuthority);
    cardBoardDocument = { ...next, revision: cardBoardDocument.revision + 1 };
    return { document: cardBoardDocument, changed: true };
  });
  // These hidden fixtures measure foreground animation timing, not background throttling.
  const window = new BrowserWindow({
    width: 1040, height: 740, show: true, backgroundColor: '#f4f7fb',
    webPreferences: {
      preload: path.join(__dirname, '..', 'lib', 'browser', 'workspace', 'campus-workspace-preload.js'),
      sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });
  const controller = new CampusWorkspaceController({
    workspaceFile: path.join(__dirname, '..', 'renderer', 'campus-workspace.html'),
    workspacePreload: path.join(__dirname, '..', 'lib', 'browser', 'workspace', 'campus-workspace-preload.js'),
    getProfilePresentation: () => ({
      schoolName: '香港科技大学（广州）', unverified: false,
      officialPortalResourceId: 'official-portal',
    }),
    getResources: () => resources,
    getGroups: () => [{ id: 'group_abcdefghijkl', name: '学习', resourceIds: ['canvas', 'library'] }],
    getLocale: () => 'zh',
    onCommand: async (command) => { commands.push(command); return { ok: true }; },
  });
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error') process.stderr.write(`[renderer] ${event.message} ${event.sourceId}:${event.line}\n`);
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    process.stderr.write(`[renderer gone] ${JSON.stringify(details)}\n`);
  });
  controller.attach(window.webContents);
  await window.loadFile(path.join(__dirname, '..', 'renderer', 'campus-workspace.html'));
  controller.sendState(window.webContents);
  for (const [label, width, height, expectedColumns] of [
    ['compact', 660, 720, 1],
    ['standard', 1040, 740, 2],
    ['wide', 1400, 900, 3],
  ]) {
    window.setContentSize(width, height);
    await new Promise((resolve) => setTimeout(resolve, 220));
    await window.webContents.executeJavaScript(`(() => new Promise((resolve) => {
      document.getElementById('primaryCatalog').click();
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }))()`);
    await new Promise((resolve) => setTimeout(resolve, 220));
    const home = await inspect(window);
    assert.equal(home.width, width);
    assert.equal(home.noHorizontalOverflow, true, `${label} overflowed horizontally`);
    assert.equal(home.duplicateHeader, 0, `${label} repeats the browser Profile header`);
    assert.equal(home.duplicateSearch, 0, `${label} repeats the browser address search`);
    assert.equal(home.boardId, 'browser-catalog', `${label} projected the wrong board`);
    assert.equal(home.boardColumns, expectedColumns, `${label} card-board columns`);
    assert.equal(home.cards, 12, `${label} official task categories are incomplete`);
    assert.ok(home.decks >= 1, `${label} the seeded deck is missing`);
    assert.equal(home.dragHandles, 0, `${label} browsing exposed edit-only drag handles`);
    assert.equal(home.nestedScrollers, 0, `${label} card board added an inner scrollbar`);
    assert.equal(home.primaryTabs, 3, `${label} primary product modes are incomplete`);
    assert.equal(home.secondaryGone, true, `${label} duplicated category navigation remains in the markup`);
    assert.equal(home.serviceGridHidden, true, `${label} legacy resource grid remains visible`);
    assert.equal(home.manageScreenGone, true, `${label} the detached organizer is back in the markup`);
    await capture(window, `${label}-home`);
    await capture(window, `${label}-services`);
  }

  window.setContentSize(1040, 900);
  window.webContents.setZoomFactor(1.25);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const zoomed = await inspect(window);
  assert.equal(zoomed.noHorizontalOverflow, true, '125% zoom overflowed horizontally');
  assert.equal(zoomed.cards, 12, '125% zoom hid official categories');
  await capture(window, 'zoomed-services');
  window.webContents.setZoomFactor(2);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const zoomed200 = await inspect(window);
  assert.equal(zoomed200.noHorizontalOverflow, true, '200% zoom overflowed horizontally');
  assert.equal(zoomed200.primaryTabs, 3, '200% zoom hides a primary product mode');
  assert.equal(zoomed200.cards, 12, '200% zoom hides official category cards');
  window.webContents.setZoomFactor(1);
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(controller.focus(window.webContents, 'search', '请假'), true);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const addressSearch = await window.webContents.executeJavaScript(`({
    title: document.getElementById('searchTitle').textContent,
    ids: [...document.querySelectorAll('#searchGrid .resource-item')]
      .map((item) => item.dataset.resourceId).sort(),
  })`);
  assert.match(addressSearch.title, /请假/u);
  assert.deepEqual(addressSearch.ids, ['e-form', 'student-request-guide']);
  assert.equal(controller.focus(window.webContents, 'search', 'Reimbursement'), true);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const longNameLayout = await window.webContents.executeJavaScript(`(() => {
    const name = document.querySelector('#searchGrid .resource-name');
    const open = document.querySelector('#searchGrid .resource-open');
    const style = getComputedStyle(name);
    return {
      title: open.title,
      clamp: style.webkitLineClamp,
      height: name.getBoundingClientRect().height,
      lineHeight: parseFloat(style.lineHeight),
    };
  })()`);
  assert.equal(longNameLayout.title,
    'Application Form for Purchase and Reimbursement of Research Expenses');
  assert.equal(longNameLayout.clamp, '2');
  assert.ok(longNameLayout.height <= longNameLayout.lineHeight * 2 + 1,
    'a long website name exceeds its two-line resource block');
  assert.equal(controller.focus(window.webContents, 'search', '学习'), true);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const groupSearch = await window.webContents.executeJavaScript(`({
    title: document.querySelector('#workspacePersonalBoardHost [data-card-ref-id="group_abcdefghijkl"] .cb-card-title')?.textContent,
    front: document.querySelector('#workspacePersonalBoardHost [data-card-ref-id="group_abcdefghijkl"]')?.dataset.cardFront,
    homeVisible: !document.getElementById('homeScreen').hidden,
    activePrimary: document.querySelector('[data-primary-view].active')?.dataset.primaryView,
    createCategoryVisible: !document.getElementById('quickCreateGroup').hidden,
  })`);
  assert.deepEqual(groupSearch, {
    title: '学习', front: 'true', homeVisible: true, activePrimary: 'workspace', createCategoryVisible: true,
  });
  const recentView = await window.webContents.executeJavaScript(`(() => {
    document.getElementById('primaryRecent').click();
    return {
      count: document.querySelectorAll('#serviceViewGrid .resource-item').length,
      timestamps: [...document.querySelectorAll('#serviceViewGrid .resource-last-opened')]
        .map((item) => item.textContent),
    };
  })()`);
  assert.ok(recentView.count > 0);
  assert.equal(recentView.timestamps.length, recentView.count,
    'recent resources do not show their opened time');
  assert.equal(recentView.timestamps.every((value) => value.includes('打开于')), true);

  const courses = await window.webContents.executeJavaScript(`(async () => {
    document.getElementById('primaryCatalog').click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const card = document.querySelector(
      '#workspaceCatalogBoardHost [data-card-ref-kind="official-category"][data-card-ref-id="courses"]',
    );
    // A front title click never collapses anything; drawing is only for back layers.
    card.querySelector('[data-card-action="draw"]').click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    let updated = document.querySelector(
      '#workspaceCatalogBoardHost [data-card-ref-kind="official-category"][data-card-ref-id="courses"]',
    );
    const frontUnchanged = updated.dataset.cardFront === 'true';
    const previewCount = updated.querySelectorAll('[data-card-resource-id]').length;
    const showAll = updated.querySelector('[data-card-action="show-all"]');
    showAll?.click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const overlay = document.querySelector('#workspaceCatalogBoardHost .cb-overlay');
    const overlayIds = [...(overlay?.querySelectorAll('[data-card-resource-id]') || [])]
      .map((item) => item.dataset.cardResourceId);
    overlay?.querySelector('[data-card-resource-id="sis"] [data-resource-action="open"]').click();
    overlay?.querySelector('[data-card-resource-id="sis"] [data-resource-action="favorite"]').click();
    overlay?.querySelector('.cb-overlay-close')?.click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    updated = document.querySelector(
      '#workspaceCatalogBoardHost [data-card-ref-kind="official-category"][data-card-ref-id="courses"]',
    );
    return {
      ids: overlayIds,
      previewCount,
      frontUnchanged,
      overlayOpened: !!overlay,
      overlayClosed: !document.querySelector('#workspaceCatalogBoardHost .cb-overlay'),
      slotUnchanged: updated.dataset.cardFront === 'true',
      serviceScreenVisible: !document.getElementById('homeScreen').hidden,
      selectedCategory: updated.querySelector('.cb-card-title')?.textContent,
    };
  })()`);
  assert.equal(courses.frontUnchanged, true, 'clicking the front title must not collapse the card');
  assert.equal(courses.previewCount, 4);
  assert.equal(courses.overlayOpened, true, 'show-all did not open the bounded overlay');
  assert.equal(courses.ids.includes('sis'), true);
  assert.equal(courses.ids.includes('canvas'), true);
  assert.equal(courses.ids.includes('new-student'), false);
  assert.equal(courses.overlayClosed, true, 'the overlay did not close back into the fixed slot');
  assert.equal(courses.slotUnchanged, true, 'the overlay changed the slot content');
  assert.equal(courses.serviceScreenVisible, true);
  assert.match(courses.selectedCategory, /课程、选课与成绩/u);

  const deckDraw = await window.webContents.executeJavaScript(`(async () => {
    document.getElementById('primaryCatalog').click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const deck = document.querySelector('#workspaceCatalogBoardHost .cb-deck[data-stack-count="2"]');
    if (!deck) return { deck: false };
    const slotBefore = deck.getBoundingClientRect().toJSON();
    const back = [...deck.querySelectorAll(':scope > [data-card-placement-id]')]
      .find((card) => card.dataset.cardFront === 'false');
    const backId = back.dataset.cardRefId;
    const drawn = new Promise((resolve) => document.getElementById('workspaceCatalogBoardHost')
      .addEventListener('card-board-drawn', (event) => resolve(event.detail), { once: true }));
    back.querySelector('[data-card-action="draw"]').click();
    const detail = await drawn;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const updated = document.querySelector('#workspaceCatalogBoardHost [data-card-ref-id="' + backId + '"]');
    const updatedSlot = document.querySelector('#workspaceCatalogBoardHost .cb-deck[data-stack-count="2"]');
    return {
      deck: true,
      drawnFront: updated.dataset.cardFront === 'true',
      aria: updated.querySelector('[data-card-action="draw"]').getAttribute('aria-selected'),
      slotUnchanged: Math.abs(slotBefore.top - updatedSlot.getBoundingClientRect().top) <= 1
        && Math.abs(slotBefore.height - updatedSlot.getBoundingClientRect().height) <= 1,
      duration: detail.duration,
    };
  })()`);
  assert.equal(deckDraw.deck, true, 'the seeded deck is missing from the workspace board');
  assert.equal(deckDraw.drawnFront, true, 'the back layer did not draw to the front');
  assert.equal(deckDraw.aria, 'true', 'aria-selected did not follow the drawn card');
  assert.equal(deckDraw.slotUnchanged, true, 'drawing changed the slot geometry');
  assert.ok(deckDraw.duration >= 200 && deckDraw.duration <= 500,
    `workspace draw lasted ${deckDraw.duration}ms outside the 240ms window`);

  assert.equal(controller.focus(window.webContents, 'search', '请假'), true);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const leaveSearch = await window.webContents.executeJavaScript(`(() => {
    const ids = [...document.querySelectorAll('#searchGrid .resource-item')]
      .map((item) => item.dataset.resourceId).sort();
    document.getElementById('clearWorkspaceSearch').click();
    return ids;
  })()`);
  assert.deepEqual(leaveSearch, ['e-form', 'student-request-guide']);

  window.setContentSize(1400, 900);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const managementView = await window.webContents.executeJavaScript(`(async () => {
    document.getElementById('primaryCatalog').click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const host = document.getElementById('workspaceCatalogBoardHost');
    const initialBoard = host.querySelector('[data-card-board]');
    const ordinaryHandles = initialBoard.querySelectorAll('[data-card-drag-handle]').length;
    document.getElementById('openManage').click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    let board = host.querySelector('[data-card-board]');
    const toolbar = document.getElementById('workspaceCatalogEditToolbar');
    const actions = [...toolbar.querySelectorAll('[data-board-action]')]
      .map((button) => button.dataset.boardAction).sort();
    const editing = board.dataset.editing;
    const handle = board.querySelector('[data-card-drag-handle]');
    handle.focus();
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    board = host.querySelector('[data-card-board]');
    const picked = board.querySelector('[data-keyboard-picked="true"] [data-card-drag-handle]') ||
      board.querySelector('[data-card-drag-handle]');
    picked.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    const announcement = document.getElementById('cardBoardLiveRegion')?.textContent || '';
    board = host.querySelector('[data-card-board]');
    const firstCard = board.querySelector('[data-card-placement-id]');
    const placementId = firstCard.dataset.cardPlacementId;
    firstCard.querySelector('[data-card-edit-action="resize"]').click();
    board = host.querySelector('[data-card-board]');
    const resized = board.querySelector('[data-card-placement-id="' + placementId + '"]')
      .dataset.cardSize;
    toolbar.querySelector('[data-board-action="undo"]').click();
    board = host.querySelector('[data-card-board]');
    const undone = board.querySelector('[data-card-placement-id="' + placementId + '"]')
      .dataset.cardSize;
    toolbar.querySelector('[data-board-action="redo"]').click();
    document.getElementById('openManage').click();
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && host.querySelector('[data-card-board]').dataset.editing === 'true') {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return {
      homeVisible: !document.getElementById('homeScreen').hidden,
      detachedManagerGone: !document.getElementById('manageScreen'),
      editing,
      editingAfterSave: host.querySelector('[data-card-board]').dataset.editing,
      ordinaryHandles,
      editHandles: board.querySelectorAll('[data-card-drag-handle]').length,
      actions,
      announcement,
      resized,
      undone,
      noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth,
    };
  })()`);
  assert.equal(managementView.homeVisible, true, 'Organize navigated away from the current board');
  assert.equal(managementView.detachedManagerGone, true,
    'the detached list manager is back in the markup');
  assert.equal(managementView.editing, 'true', 'Organize did not enter inline editing');
  assert.equal(managementView.editingAfterSave, 'false', 'Done did not leave inline editing');
  assert.equal(managementView.ordinaryHandles, 0, 'ordinary browsing exposed drag handles');
  assert.equal(managementView.editHandles, 12, 'editing did not expose one handle per category');
  assert.deepEqual(managementView.actions, ['cancel', 'done', 'redo', 'reset', 'undo']);
  assert.match(managementView.announcement, /取消|移动/u,
    'keyboard arranging did not announce its result');
  assert.notEqual(managementView.resized, managementView.undone,
    'undo did not restore the previous card size');
  assert.equal(managementView.noHorizontalOverflow, true,
    'inline organizing introduced horizontal overflow');
  assert.ok(layoutCommits.flat().some(({ type }) => type === 'resize-placement'),
    'inline edit did not commit its revision-bound layout operations');
  assert.equal(commands.some(({ command }) => command === 'toggle-favorite'), true);
  assert.equal(commands.some(({ command, resourceId }) =>
    command === 'open-resource' && resourceId === 'sis'), true);
  await capture(window, 'manage');
  for (const channel of [
    'get-card-board-layout', 'commit-card-board-layout', 'reset-card-board-layout',
  ]) ipcMain.removeHandler(channel);
  window.destroy();
  process.stdout.write('campus workspace layout: PASS\n');
  app.quit();
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  app.exit(1);
});
