'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const renderer = path.join(__dirname, '..', 'renderer', 'index.html');
const preload = path.join(__dirname, 'resource-manager-layout-preload.js');

async function settle(window, width, height) {
  window.setContentSize(width, height);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const ready = await window.webContents.executeJavaScript(`window.innerWidth === ${width} && window.innerHeight === ${height}`);
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await window.webContents.executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 160))))');
}

async function shellSnapshot(window, page) {
  return window.webContents.executeJavaScript(`(() => {
    document.querySelector('.nav[data-page="${page}"]').click();
    const root = document.querySelector('.content');
    const visible = document.querySelector('.page.active');
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => resolve({
      page: visible.dataset.page,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      bodyOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      contentOverflow: root.scrollWidth - root.clientWidth,
      contentScroll: root.scrollTop,
      contentScrollHeight: root.scrollHeight,
      contentClientHeight: root.clientHeight,
      navOrder: [...document.querySelectorAll('.nav')].map((node) => node.dataset.page),
      activeNavIconOffset: (() => {
        const nav = document.querySelector('.nav.active');
        const icon = nav?.querySelector('svg');
        if (!nav || !icon) return null;
        const outer = nav.getBoundingClientRect();
        const inner = icon.getBoundingClientRect();
        return Math.abs((outer.top + outer.height / 2) - (inner.top + inner.height / 2));
      })(),
      workspaceTitle: visible.querySelector('.ws-title .page-h')?.textContent || null,
      tabs: [...visible.querySelectorAll('.ws-tabs [role="tab"]')]
        .map((tab) => ({ id: tab.id, selected: tab.getAttribute('aria-selected') })),
      officialCards: visible.querySelectorAll('#officialMainDeck .official-main-card').length,
      officialFront: visible.querySelector('#officialMainDeck .official-main-card.is-front')?.dataset.officialRegion || null,
      officialBack: visible.querySelector('#officialMainDeck .official-main-card.is-back')?.dataset.officialRegion || null,
      officialColumns: (() => {
        const deck = visible.querySelector('#officialMainDeck');
        if (!deck) return 0;
        const value = getComputedStyle(deck).gridTemplateColumns;
        return value === 'none' ? 1 : value.split(' ').filter(Boolean).length;
      })(),
      backBodyVisible: (() => {
        const body = visible.querySelector('#officialMainDeck .official-main-card.is-back .official-main-card-body');
        return body ? getComputedStyle(body).display !== 'none' : false;
      })(),
      appColumns: (() => {
        const list = visible.querySelector('#appsList');
        return list ? getComputedStyle(list).gridTemplateColumns.split(' ').filter(Boolean).length : 0;
      })(),
      officialRows: visible.querySelectorAll('#appsList .orow').length,
      deskRows: visible.querySelectorAll('#deskList .orow').length,
      appsClipped: (() => {
        const card = visible.querySelector('[data-official-region="apps"]');
        const pager = visible.querySelector('#appsPager');
        return card && pager ? pager.getBoundingClientRect().bottom > card.getBoundingClientRect().bottom + 1 : true;
      })(),
      appsOverflowPx: (() => {
        const card = visible.querySelector('[data-official-region="apps"]');
        const pager = visible.querySelector('#appsPager');
        return card && pager ? pager.getBoundingClientRect().bottom - card.getBoundingClientRect().bottom : null;
      })(),
      officialHidden: visible.querySelector('#serviceOfficialView')?.hidden ?? null,
      personalHidden: visible.querySelector('#servicePersonalView')?.hidden ?? null,
      dataModules: ['moduleSchedule', 'moduleLoans', 'moduleNews']
        .map((id) => !!visible.querySelector('#' + id)),
      dataStates: ['moduleSchedule', 'moduleLoans', 'moduleNews']
        .map((id) => visible.querySelector('#' + id)?.dataset.state || null),
      notConnectedNotes: visible.querySelectorAll('.module-note').length,
      boardId: visible.querySelector('[data-card-board]')?.dataset.boardId || null,
      boardColumns: Number(visible.querySelector('[data-card-board]')?.dataset.boardColumns || 0),
      boardEditing: visible.querySelector('[data-card-board]')?.dataset.editing || null,
      decks: visible.querySelectorAll('#campusResources .cb-deck').length || 0,
      stackCounts: [...(visible.querySelectorAll('#campusResources .cb-deck') || [])]
        .map((node) => Number(node.dataset.stackCount || 0)),
      personalPagerItems: visible.querySelectorAll('#personalCategoryPager .portal-page').length,
      cardTitles: [...(visible.querySelectorAll('#campusResources .cb-card-title') || [])]
        .map((node) => node.textContent),
      cards: visible.querySelectorAll('#campusResources [data-card-placement-id]').length || 0,
      dragHandles: visible.querySelectorAll('#campusResources [data-card-drag-handle]').length || 0,
      nestedCardScrollers: [...(visible.querySelectorAll('.cb-card-body, .cb-site-list') || [])]
        .filter((node) => ['auto', 'scroll'].includes(getComputedStyle(node).overflowY)).length,
      powerInsideBoard: !!document.querySelector('[data-card-board] #power'),
      connectionControlDraggable: !!document.querySelector('#connTop [draggable="true"], #connTop [data-card-drag-handle]'),
      notificationNav: !!document.querySelector('.nav[data-page="notif"]'),
      networkTree: !!document.getElementById('networkTree'),
      networkTreeBranches: document.querySelectorAll('.network-tree-branch').length,
      underlayOptions: document.querySelectorAll('[data-underlay-address]').length,
      underlayInterfaces: document.querySelectorAll('[data-underlay-interface]').length,
      underlayOverflow: (() => { const node = document.getElementById('underlayTreeOptions'); return node ? node.scrollWidth - node.clientWidth : 0; })(),
      legacyUnderlaySelect: !!document.getElementById('underlaySourceAddress'),
      integrationRows: document.querySelectorAll('[data-integration-adapter]').length,
      routingScopes: document.querySelectorAll('.routing-consumer-scope > div').length,
      towerRoutingWidth: document.getElementById('towerRoutingSection')?.getBoundingClientRect().width || 0,
      towerGridWidth: document.querySelector('.page[data-page="tower"] .tower-grid')?.getBoundingClientRect().width || 0,
    }), 180))));
  })()`);
}

async function capture(window, output, label) {
  if (!output) return;
  await new Promise((resolve) => setTimeout(resolve, 240));
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, `${label}.png`), (await window.webContents.capturePage()).toPNG());
}

async function addWebsiteSnapshot(window) {
  return window.webContents.executeJavaScript(`(() => {
    document.getElementById('addWebsite').click();
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const dialog = document.getElementById('addWebsiteDialog');
      const rect = dialog.getBoundingClientRect();
      resolve({ open: dialog.open, left: rect.left, right: rect.right, top: rect.top,
        bottom: rect.bottom, width: rect.width, viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight, bodyOverflow: dialog.scrollWidth - dialog.clientWidth,
        routeOptions: [...document.getElementById('addWebsiteRoute').options].map(({ value }) => value) });
    })));
  })()`);
}

async function exerciseCardDraw(window) {
  return window.webContents.executeJavaScript(`(async () => {
    document.querySelector('.nav[data-page="browser"]').click();
    document.getElementById('serviceTabPersonal').click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 240))));
    document.querySelector('#personalCategoryPager [data-card-page-placement]')?.click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const deck = document.querySelector('#campusResources .cb-deck[data-stack-count="2"]');
    const deckId = deck.dataset.cardDeckId;
    const cards = [...deck.querySelectorAll(':scope > [data-card-placement-id]')];
    const backCard = cards.find((card) => card.dataset.cardFront === 'false');
    const frontCard = cards.find((card) => card.dataset.cardFront === 'true');
    const sibling = document.querySelector('#campusResources .cb-deck:not([data-card-deck-id="' + deckId + '"])');
    const siblingRectBefore = sibling.getBoundingClientRect().toJSON();
    const slotRectBefore = deck.getBoundingClientRect().toJSON();
    const scrollContainer = document.querySelector('.content');
    const scrollBefore = scrollContainer.scrollTop;
    const drawn = new Promise((resolve) => {
      document.getElementById('campusResources').addEventListener('card-board-drawn', (event) => resolve(event.detail), { once: true });
    });
    const backTab = backCard.querySelector('[data-card-action="draw"]');
    const backLabelBefore = backTab.getAttribute('aria-label');
    backTab.click();
    const detail = await drawn;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const updatedDeck = document.querySelector('#campusResources [data-card-deck-id="' + deckId + '"]');
    const siblingAfter = document.querySelector('#campusResources .cb-deck:not([data-card-deck-id="' + deckId + '"])');
    const updated = [...updatedDeck.querySelectorAll(':scope > [data-card-placement-id]')];
    const drawnCard = updated.find((card) => card.dataset.cardPlacementId === backCard.dataset.cardPlacementId);
    const retiredCard = updated.find((card) => card.dataset.cardPlacementId === frontCard.dataset.cardPlacementId);
    return {
      cardCount: updated.length,
      debugDump: updated.map((card) => ({
        id: card.dataset.cardRefId,
        placementId: card.dataset.cardPlacementId,
        front: card.dataset.cardFront,
        layer: card.dataset.layer,
        aria: card.querySelector('[data-card-action="draw"]')?.getAttribute('aria-selected'),
        cls: card.className,
      })),
      slotStayedInPlace: Math.abs(slotRectBefore.left - updatedDeck.getBoundingClientRect().left) <= 1
        && Math.abs(slotRectBefore.top - updatedDeck.getBoundingClientRect().top) <= 1
        && Math.abs(slotRectBefore.height - updatedDeck.getBoundingClientRect().height) <= 1,
      siblingUnchanged: JSON.stringify(siblingRectBefore) === JSON.stringify(siblingAfter.getBoundingClientRect().toJSON()),
      scrollUnchanged: scrollContainer.scrollTop === scrollBefore,
      drawnFront: drawnCard.dataset.cardFront === 'true',
      retiredBack: retiredCard.dataset.cardFront === 'false',
      drawnSelected: drawnCard.querySelector('[data-card-action="draw"]').getAttribute('aria-selected') === 'true',
      retiredSelected: retiredCard.querySelector('[data-card-action="draw"]').getAttribute('aria-selected') === 'false',
      backLabelBefore,
      drawnLabel: drawnCard.querySelector('[data-card-action="draw"]').getAttribute('aria-label'),
      duration: detail.duration,
      sameCards: updated.map((card) => card.dataset.cardPlacementId).sort().join('|')
        === cards.map((card) => card.dataset.cardPlacementId).sort().join('|'),
    };
  })()`);
}

async function exerciseInlineOrganizeAndPin(window) {
  return window.webContents.executeJavaScript(`(async () => {
    document.querySelector('.nav[data-page="browser"]').click();
    document.getElementById('serviceTabPersonal').click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    document.getElementById('manageResources').click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const boardHost = document.querySelector('#campusResources .cb-personal-board .cb-board-host');
    let board = boardHost.querySelector('[data-card-board]');
    const toolbar = document.querySelector('[data-card-edit-toolbar], .cb-edit-toolbar');
    const editingDuring = board.dataset.editing;
    const pageDuringEdit = document.querySelector('.page.active')?.dataset.page;
    const actions = [...toolbar.querySelectorAll('[data-board-action]')]
      .map((button) => button.dataset.boardAction).sort();
    const handlesInEdit = board.querySelectorAll('[data-card-drag-handle]').length;
    const cardsInEdit = board.querySelectorAll('[data-card-placement-id]').length;
    const dragCards = [...board.querySelectorAll('[data-card-drag-handle]')];
    const pointerSource = dragCards.at(-1);
    const pointerTarget = dragCards[2];
    const wholeCardDrag = pointerSource?.matches('[data-card-placement-id]') === true &&
      pointerSource?.draggable === true && !pointerSource?.textContent.includes('⠿');
    if (pointerSource && pointerTarget && pointerSource !== pointerTarget) {
      const transfer = new DataTransfer();
      const rect = pointerTarget.getBoundingClientRect();
      pointerSource.dispatchEvent(new DragEvent('dragstart', {
        bubbles: true, cancelable: true, dataTransfer: transfer,
      }));
      pointerTarget.dispatchEvent(new DragEvent('dragover', {
        bubbles: true, cancelable: true, dataTransfer: transfer,
        clientY: rect.top + rect.height / 2,
      }));
      pointerTarget.dispatchEvent(new DragEvent('drop', {
        bubbles: true, cancelable: true, dataTransfer: transfer,
        clientY: rect.top + rect.height / 2,
      }));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      board = boardHost.querySelector('[data-card-board]');
    }
    const handle = board.querySelector('[data-card-drag-handle]');
    handle.focus();
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    board = boardHost.querySelector('[data-card-board]');
    const movedHandle = board.querySelector('[data-keyboard-picked="true"]') ||
      board.querySelector('[data-card-drag-handle]');
    movedHandle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    const keyboardAnnouncement = document.getElementById('cardBoardLiveRegion')?.textContent || '';
    board = boardHost.querySelector('[data-card-board]');
    const pin = board.querySelector('[data-card-edit-action="pin"]');
    const sourceRefId = pin.closest('[data-card-placement-id]').dataset.cardRefId;
    pin.click();
    toolbar.querySelector('[data-board-action="done"]').click();
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && board.dataset.editing === 'true') {
      await new Promise((resolve) => setTimeout(resolve, 20));
      board = boardHost.querySelector('[data-card-board]');
    }
    const commitState = window.api.testState().cardBoardRequests;
    const sourceStillVisible = !!document.querySelector(
      '#campusResources [data-card-ref-kind="user-collection"]' +
      '[data-card-ref-id="' + sourceRefId + '"]',
    );
    document.querySelector('.nav[data-page="connect"]').click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const connectBoard = document.querySelector('.page[data-page="connect"] [data-card-board]');
    const pinnedCard = connectBoard?.querySelector(
      '[data-card-ref-kind="user-collection"][data-card-ref-id="' + sourceRefId + '"]',
    );
    const pinnedResourceId = pinnedCard?.querySelector('[data-card-resource-id]')?.dataset.cardResourceId || null;
    pinnedCard?.querySelector('[data-resource-action="open"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      pageDuringEdit,
      editingDuring,
      editingAfterSave: boardHost.querySelector('[data-card-board]').dataset.editing,
      actions,
      handlesInEdit,
      cardsInEdit,
      wholeCardDrag,
      keyboardAnnouncement,
      commitCalls: commitState.commit,
      lastOperations: commitState.lastOperations,
      sourceStillVisible,
      stackedAfter: [...boardHost.querySelectorAll('.cb-deck')]
        .some((deck) => Number(deck.dataset.stackCount) > 1),
      connectBoardId: connectBoard?.dataset.boardId || null,
      pinnedVisible: !!connectBoard?.querySelector(
        '[data-card-ref-kind="user-collection"][data-card-ref-id="' + sourceRefId + '"]',
      ),
      pinnedResourceId,
      pinnedOpenRequest: window.api.testState().lastOpenRequest,
      fixedPowerOutsideBoard: !document.querySelector('[data-card-board] #power'),
      organizePressed: document.getElementById('manageResources').getAttribute('aria-pressed'),
    };
  })()`);
}

async function exerciseWorkspaceSearch(window) {
  return window.webContents.executeJavaScript(`(async () => {
    document.querySelector('.nav[data-page="browser"]').click();
    document.getElementById('serviceTabOfficial').click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const input = document.getElementById('resourceSearch');
    const moduleBefore = document.getElementById('moduleSchedule');
    input.value = '报销';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rows = [...document.querySelectorAll('#searchResults .srow')];
    const official = {
      count: rows.length,
      names: rows.map((row) => row.querySelector('.orow-name').textContent),
      regions: rows.map((row) => row.querySelector('.srow-region')?.textContent || ''),
      routes: rows.map((row) => row.querySelector('.orow-route')?.textContent || ''),
      favorites: rows.filter((row) => row.querySelector('.orow-favorite')).length,
      moduleSameNode: document.getElementById('moduleSchedule') === moduleBefore,
      searchVisible: !document.getElementById('serviceSearchView').hidden,
      officialHidden: document.getElementById('serviceOfficialView').hidden,
    };
    rows[0].click();
    await new Promise((resolve) => setTimeout(resolve, 25));
    official.openedUrl = window.api.testState().lastOpenRequest?.url || null;

    input.value = '我要申请在读证明';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    official.certificateHits = [...document.querySelectorAll('#searchResults .srow .orow-name')]
      .map((row) => row.textContent);

    input.value = 'HPC2';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const hpcRows = [...document.querySelectorAll('#searchResults .srow')];
    official.hpcNames = hpcRows.map((row) => row.querySelector('.orow-name').textContent);
    official.hpcRoutes = hpcRows.map((row) => row.querySelector('.orow-route')?.textContent || '');

    document.getElementById('serviceTabPersonal').click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    input.value = '学习';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const personalRows = [...document.querySelectorAll('#searchResults .srow')];
    const categoryRow = personalRows.find((row) => row.dataset.personalCategory);
    categoryRow?.click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 320))));
    const focused = document.querySelector(
      '#campusResources [data-card-ref-id="' + (categoryRow?.dataset.personalCategory || '') + '"]',
    );
    const personal = {
      names: personalRows.map((row) => row.querySelector('.orow-name').textContent),
      categoryHit: !!categoryRow,
      focusedFront: focused?.dataset.cardFront === 'true',
      placeholder: input.placeholder,
      searchExited: document.getElementById('serviceSearchView').hidden,
    };
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return { official, personal };
  })()`);
}

async function exerciseGroupDialog(window) {
  return window.webContents.executeJavaScript(`(async () => {
    document.querySelector('.nav[data-page="browser"]').click();
    document.getElementById('serviceTabPersonal').click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    document.getElementById('createCategory').click();
    const dialog = document.getElementById('groupDialog');
    document.getElementById('groupName').value = '科研计算';
    document.getElementById('groupForm').requestSubmit();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const groups = window.api.testState().resourceGroups;
    return {
      dialogClosed: !dialog.open,
      created: groups.some((group) => group.name === '科研计算'),
      cardVisible: [...document.querySelectorAll('#campusResources .cb-card-title')]
        .some((node) => node.textContent === '科研计算'),
      error: document.getElementById('groupError').textContent,
    };
  })()`);
}

async function exerciseOfficialFavorite(window) {
  return window.webContents.executeJavaScript(`(async () => {
    document.querySelector('.nav[data-page="browser"]').click();
    document.getElementById('serviceTabOfficial').click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    document.querySelector('[data-official-main-action="apps"]').click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    document.querySelector('[data-official-more="apps"]').click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const expanded = document.getElementById('officialCatalogDialog');
    const expandedState = {
      open: expanded.open,
      rows: document.querySelectorAll('#officialCatalogList .orow').length,
      stackedCards: document.querySelectorAll('#officialCatalogDialog .ocard').length,
    };
    expanded.close();
    const star = document.querySelector('#appsList [data-favorite-entry]');
    const entryId = star?.dataset.favoriteEntry || null;
    star?.click();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const dialog = document.getElementById('officialFavoriteDialog');
    const group = document.getElementById('officialFavoriteGroup');
    const existingOption = [...group.options].some(({ value }) => value === 'group_research12345');
    group.value = '__new_group__';
    group.dispatchEvent(new Event('change', { bubbles: true }));
    const newGroupVisible = !document.getElementById('officialFavoriteNewGroupField').hidden;
    document.getElementById('officialFavoriteNewGroup').value = '课程收藏';
    document.getElementById('officialFavoriteForm').requestSubmit();
    const deadline = Date.now() + 2000;
    while (dialog.open && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const state = window.api.testState();
    const targetGroup = state.resourceGroups.find(({ name }) => name === '课程收藏');
    const savedId = targetGroup?.resourceIds.find((id) => id.startsWith('custom-test-')) || null;
    const focusedCard = document.querySelector(
      '#campusResources [data-card-ref-id="' + (targetGroup?.id || '') + '"]',
    );
    document.getElementById('serviceTabOfficial').click();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return {
      expandedState,
      favoriteDialogOpened: !!entryId,
      existingOption,
      newGroupVisible,
      dialogClosed: !dialog.open,
      savedId,
      switchedToPersonal: focusedCard?.dataset.cardFront === 'true',
      starActive: document.querySelector('[data-favorite-entry="' + entryId + '"]')
        ?.getAttribute('aria-pressed'),
      error: document.getElementById('officialFavoriteError').textContent,
    };
  })()`);
}

async function reducedMotionSnapshot(window) {
  if (!window.webContents.debugger.isAttached()) window.webContents.debugger.attach('1.3');
  await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  return window.webContents.executeJavaScript(`(() => {
    document.querySelector('.nav[data-page="browser"]').click();
    const card = document.querySelector('#campusResources .cb-card');
    return {
      cardTransitionMs: getComputedStyle(card).transitionDuration,
      enterAnimation: (() => {
        const view = document.getElementById('serviceOfficialView');
        view.classList.add('ws-view-enter');
        const name = getComputedStyle(view).animationName;
        view.classList.remove('ws-view-enter');
        return name;
      })(),
    };
  })()`);
}

async function main() {
  await app.whenReady();
  const output = process.env.HKUSTGZ_CONTROL_SCREENSHOT_DIR || '';
  const preview = process.env.HKUSTGZ_CONTROL_PREVIEW === '1';
  const realCatalog = process.env.HKUSTGZ_CONTROL_PREVIEW_REAL === '1';
  if (realCatalog) {
    process.env.HKUSTGZ_CONTROL_PREVIEW_RESOURCES_JSON = fs.readFileSync(path.join(
      __dirname, '..', 'assets', 'profiles', 'hkustgz', 'builtin-resources.json',
    ), 'utf8');
    process.env.HKUSTGZ_CONTROL_SERVICE_DESK_JSON = fs.readFileSync(path.join(
      __dirname, '..', 'assets', 'profiles', 'hkustgz', 'builtin-service-desk.json',
    ), 'utf8');
  }
  // These hidden fixtures measure foreground animation timing, not background throttling.
  const window = new BrowserWindow({
    show: true,
    width: preview ? 1024 : 480,
    height: preview ? 576 : 854,
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload, backgroundThrottling: false } });
  try {
    await window.loadFile(renderer);
    await window.webContents.executeJavaScript("new Promise((resolve) => { const done = () => document.getElementById('dash').hidden ? setTimeout(done, 20) : resolve(); done(); })");
    if (preview) {
      window.show();
      await new Promise((resolve) => window.once('closed', resolve));
      return;
    }
    for (const [label, width, height] of [
      ['narrow', 440, 540], ['minimum', 820, 540], ['default', 1024, 576], ['wide', 1280, 720],
      ['ultrawide', 1440, 900],
    ]) {
      await settle(window, width, height);
      const connect = await shellSnapshot(window, 'connect');
      assert.deepEqual(connect.navOrder, ['connect', 'browser', 'tower', 'settings']);
      assert.equal(connect.notificationNav, false);
      assert.equal(connect.powerInsideBoard, false, `${label}: fixed connection action entered the movable board`);
      assert.equal(connect.connectionControlDraggable, false,
        `${label}: the fixed connection safety region became draggable`);
      assert.equal(connect.networkTree, true);
      assert.equal(connect.networkTreeBranches, 0);
      assert.equal(connect.underlayOptions, 2);
      assert.equal(connect.underlayInterfaces, 2);
      assert.ok(connect.underlayOverflow <= 0, `${label}: adapter choices overflow horizontally`);
      assert.equal(connect.legacyUnderlaySelect, false);
      assert.ok(connect.bodyOverflow <= 0 && connect.contentOverflow <= 0, `${label}: connection shell overflows horizontally`);
      if (label === 'default' || label === 'wide' || label === 'ultrawide') {
        assert.ok(connect.contentScrollHeight <= connect.contentClientHeight + 1,
          `${label}: connection page unexpectedly requires scrolling`);
      }
      await capture(window, output, `${label}-connect`);

      const browser = await shellSnapshot(window, 'browser');
      assert.equal(browser.workspaceTitle, '校园工作台', `${label}: the workspace title changed`);
      assert.deepEqual(browser.tabs.map(({ selected }) => selected), ['true', 'false'],
        `${label}: the Official Service Desk must be the default tab`);
      assert.equal(browser.officialCards, 2, `${label}: the official deck must contain exactly two main cards`);
      assert.equal(browser.officialFront, 'apps', `${label}: My Applications must start at the front`);
      assert.equal(browser.officialBack, 'desk', `${label}: Service Desk must remain as the exposed back card`);
      assert.equal(browser.appColumns, 2, `${label}: My Applications must retain two items per row`);
      assert.equal(browser.appsClipped, false,
        `${label}: the bottom of My Applications is clipped (${browser.appsOverflowPx}px)`);
      assert.ok(browser.officialRows >= 3, `${label}: the applications card must be directly visible`);
      assert.ok(browser.deskRows >= 2, `${label}: the Service Desk lost its items`);
      if (width >= 980) {
        assert.equal(browser.officialColumns, 2, `${label}: wide layout must show both main cards side by side`);
        assert.equal(browser.backBodyVisible, true, `${label}: wide layout hid the second card body`);
      } else {
        assert.equal(browser.officialColumns, 1, `${label}: narrow layout must remain a single deck`);
        assert.equal(browser.backBodyVisible, false, `${label}: narrow back card exposed its body`);
      }
      assert.deepEqual(browser.dataModules, [true, true, true],
        `${label}: schedule/loans/news modules must stay mounted`);
      assert.deepEqual(browser.dataStates, [
        'not-authenticated', 'not-authenticated', 'source-unavailable',
      ], `${label}: each campus-data module must own its signed-out state`);
      assert.equal(browser.officialHidden, false);
      assert.equal(browser.personalHidden, true);
      assert.ok(browser.bodyOverflow <= 0 && browser.contentOverflow <= 0, `${label}: workspace overflows horizontally`);
      if (label === 'narrow') {
        assert.ok(browser.activeNavIconOffset <= 1,
          `narrow: hidden nav labels left the icon off-center by ${browser.activeNavIconOffset}px`);
      }
      await capture(window, output, `${label}-workspace-official`);

      const personal = await window.webContents.executeJavaScript(`(async () => {
        const module = document.getElementById('moduleSchedule');
        const moduleRect = document.getElementById('moduleSchedule').getBoundingClientRect().toJSON();
        document.getElementById('serviceTabPersonal').click();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return {
          moduleSameNode: document.getElementById('moduleSchedule') === module,
          moduleRectUnchanged: JSON.stringify(document.getElementById('moduleSchedule').getBoundingClientRect().toJSON()) === JSON.stringify(moduleRect)
            || document.getElementById('moduleSchedule').getBoundingClientRect().top >= 0,
          officialHidden: document.getElementById('serviceOfficialView').hidden,
          personalHidden: document.getElementById('servicePersonalView').hidden,
          placeholder: document.getElementById('resourceSearch').placeholder,
        };
      })()`);
      assert.equal(personal.moduleSameNode, true, `${label}: tab switching remounted a data module`);
      assert.equal(personal.officialHidden, true);
      assert.equal(personal.personalHidden, false);
      assert.match(personal.placeholder, /我的网站|my sites/iu);
      const personalBoard = await shellSnapshot(window, 'browser');
      assert.equal(personalBoard.boardId, 'browser-personal', `${label}: personal cards use the wrong board`);
      assert.equal(personalBoard.decks, 2, `${label}: the first category page must keep two slots`);
      // Manual decks remain stacked; automatic decks spread in wide browsing mode.
      assert.equal(personalBoard.stackCounts.reduce((sum, count) => sum + count, 0), width >= 980 ? 3 : 5,
        `${label}: the first category page lost one of its stacked cards`);
      assert.equal(personalBoard.personalPagerItems, width >= 980 ? 3 : 6,
        `${label}: every personal category must remain reachable through underline pagination`);
      assert.ok(Math.max(...personalBoard.stackCounts) <= 3, `${label}: a deck exceeds three cards`);
      assert.equal(personalBoard.boardEditing, 'false', `${label}: browsing opened in editing mode`);
      assert.equal(personalBoard.dragHandles, 0, `${label}: ordinary browsing exposed drag handles`);
      assert.equal(personalBoard.nestedCardScrollers, 0, `${label}: card content owns a permanent inner scrollbar`);
      assert.ok(personalBoard.bodyOverflow <= 0 && personalBoard.contentOverflow <= 0,
        `${label}: personal workspace overflows horizontally`);
      if (width >= 980) {
        const reached = await window.webContents.executeJavaScript(`(async () => {
          const pager = document.getElementById('personalCategoryPager');
          const controller = window.campusCategoryStacks.activeController();
          const before = JSON.stringify(controller.snapshot());
          const expected = controller.snapshot().placements.filter(p =>
            p.boardId === 'browser-personal' && !p.hidden).map(p => p.placementId).sort();
          const ids = new Set();
          const count = pager.querySelectorAll('[data-card-page-index]').length;
          for (let page = 0; page < count; page++) {
            pager.querySelector('[data-card-page-index="' + page + '"]').click();
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            document.querySelectorAll('#campusResources [data-card-placement-id]')
              .forEach(card => ids.add(card.dataset.cardPlacementId));
          }
          pager.querySelector('[data-card-page-index="0"]').click();
          return { ids: [...ids].sort(), expected,
            stable: before === JSON.stringify(controller.snapshot()) };
        })()`);
        assert.equal(reached.expected.length, 6, `${label}: fixture category identity changed`);
        assert.deepEqual(reached.ids, reached.expected, `${label}: wide pagination lost a category`);
        assert.equal(reached.stable, true, `${label}: browsing rewrote the saved layout`);
      }
      await capture(window, output, `${label}-workspace-personal`);
      await window.webContents.executeJavaScript(`document.getElementById('serviceTabOfficial').click()`);

      const addWebsite = await addWebsiteSnapshot(window);
      assert.equal(addWebsite.open, true, `${label}: Add Website dialog did not open`);
      assert.deepEqual(addWebsite.routeOptions, ['auto', 'campus', 'direct']);
      assert.ok(addWebsite.left >= 8 && addWebsite.right <= addWebsite.viewportWidth - 8,
        `${label}: Add Website dialog escapes horizontal safe area: ${JSON.stringify(addWebsite)}`);
      assert.ok(addWebsite.top >= 8 && addWebsite.bottom <= addWebsite.viewportHeight - 8,
        `${label}: Add Website dialog escapes vertical safe area`);
      assert.ok(addWebsite.width <= 520 && addWebsite.bodyOverflow <= 0,
        `${label}: Add Website dialog is too wide or overflows`);
      await capture(window, output, `${label}-add-website`);
      await window.webContents.executeJavaScript(`document.getElementById('addWebsiteDialog').close()`);
      const tower = await shellSnapshot(window, 'tower');
      assert.equal(tower.contentScroll, 0, `${label}: Control Tower did not start at the top`);
      assert.ok(tower.bodyOverflow <= 0 && tower.contentOverflow <= 0, `${label}: Control Tower overflows horizontally`);
      assert.equal(tower.integrationRows, 2, `${label}: both independent export adapters must remain visible`);
      assert.equal(tower.routingScopes, 3, `${label}: routing scope explanation is incomplete`);
      if (width >= 1180) assert.ok(tower.towerRoutingWidth >= tower.towerGridWidth - 1,
        `${label}: website routing does not use the full Control Tower width`);
      await capture(window, output, `${label}-tower`);
      await shellSnapshot(window, 'settings'); await capture(window, output, `${label}-settings`);
    }

    if (realCatalog) {
      process.stdout.write('control shell real-catalog responsive layout: PASS\n');
      return;
    }

    await settle(window, 820, 540);
    const chips = await window.webContents.executeJavaScript(`(async () => {
      document.querySelector('.nav[data-page="browser"]').click();
      const apps = () => [...document.querySelectorAll('#appsList .orow .orow-name')].map((row) => row.textContent);
      const desk = () => [...document.querySelectorAll('#deskList .orow .orow-name')].map((row) => row.textContent);
      const allApps = apps();
      const chip = [...document.querySelectorAll('#appsChips .chip')].find((node) => node.textContent === '教学科研');
      chip.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const teachApps = apps();
      const teachPressed = [...document.querySelectorAll('#appsChips .chip')]
        .find((node) => node.textContent === '教学科研')?.getAttribute('aria-pressed');
      document.querySelector('[data-official-main-action="desk"]').click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const deskChip = [...document.querySelectorAll('#deskChips .chip')].find((node) => node.textContent === '学术管理');
      deskChip.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { allApps, teachApps, teachPressed, academicItems: desk(),
        frontRegion: document.querySelector('#officialMainDeck .official-main-card.is-front')?.dataset.officialRegion,
        appsBodyHidden: getComputedStyle(document.getElementById('appsList').closest('.official-main-card-body')).display === 'none' };
    })()`);
    assert.ok(chips.allApps.length >= 3);
    assert.ok(chips.teachApps.length >= 1 && chips.teachApps.length < chips.allApps.length,
      'application chips must filter the list in place');
    assert.equal(chips.teachPressed, 'true');
    assert.ok(chips.academicItems.length >= 1, 'service-desk chips must filter the list in place');
    assert.deepEqual({ frontRegion: chips.frontRegion, appsBodyHidden: chips.appsBodyHidden }, {
      frontRegion: 'desk', appsBodyHidden: true,
    }, 'drawing Service Desk to the front did not retire the My Applications body');

    const favorite = await exerciseOfficialFavorite(window);
    assert.deepEqual(favorite.expandedState.open, true, 'View more did not open the full official list');
    assert.ok(favorite.expandedState.rows >= 1, 'the full official list is empty');
    assert.equal(favorite.expandedState.stackedCards, 0,
      'the fully expanded official list must be flat rather than stacked');
    assert.equal(favorite.favoriteDialogOpened, true, 'the favorite star did not open its category chooser');
    assert.equal(favorite.existingOption, true, 'existing categories are missing from the favorite chooser');
    assert.equal(favorite.newGroupVisible, true, 'the new-category field did not appear');
    assert.equal(favorite.dialogClosed, true, 'the favorite category chooser did not finish');
    assert.ok(favorite.savedId, 'the official entry was not saved into the selected category');
    assert.equal(favorite.switchedToPersonal, true,
      'the selected My Categories card was not drawn to the front after saving');
    assert.equal(favorite.starActive, 'true', 'the official star did not reflect the saved favorite');
    assert.equal(favorite.error, '');

    const drawn = await exerciseCardDraw(window);
    assert.equal(drawn.cardCount, 2, 'the deck fixture did not expose two cards');
    assert.equal(drawn.slotStayedInPlace, true, 'drawing moved the slot');
    assert.equal(drawn.siblingUnchanged, true, 'drawing moved a sibling deck');
    assert.equal(drawn.scrollUnchanged, true, 'drawing unexpectedly scrolled the page');
    assert.equal(drawn.drawnFront, true, 'the drawn card did not move to the front');
    assert.equal(drawn.retiredBack, true, 'the previous front card did not retreat');
    assert.equal(drawn.drawnSelected, true, 'aria-selected did not follow the drawn card');
    assert.equal(drawn.retiredSelected, true,
      `aria-selected stayed on the retired card: ${JSON.stringify(drawn.debugDump)}`);
    assert.match(drawn.backLabelBefore, /第 1 张，共 2 张/u);
    assert.match(drawn.drawnLabel, /第 2 张，共 2 张，当前在正面/u);
    assert.ok(drawn.duration >= 200 && drawn.duration <= 500,
      `the draw animation lasted ${drawn.duration}ms instead of the 240ms window`);
    assert.equal(drawn.sameCards, true, 'drawing changed the deck membership');
    await capture(window, output, 'drawn-workspace');

    const search = await exerciseWorkspaceSearch(window);
    assert.ok(search.official.count >= 1, 'official search found no reimbursement entry');
    assert.ok(search.official.names.some((name) => name.includes('报销')),
      'official search must hit the concrete reimbursement request');
    assert.ok(search.official.regions.includes('学生服务台'), 'the region badge is missing');
    assert.equal(search.official.routes.every((route) => route === ''), true,
      'official search must leave routing details to the Control Tower rule library');
    assert.equal(search.official.favorites, search.official.count,
      'every official search result must expose a favorite star');
    assert.equal(search.official.moduleSameNode, true, 'search remounted a data module');
    assert.equal(search.official.searchVisible, true);
    assert.equal(search.official.officialHidden, true);
    assert.ok(search.official.openedUrl, 'clicking a result did not open the official URL');
    assert.ok(search.official.certificateHits.some((name) => name.includes('在读证明')),
      'task phrasing must reach the enrollment certificate entry');
    assert.ok(search.official.hpcNames.some((name) => name.includes('HPC2')),
      'HPC2 must hit the concrete HPC entry');
    assert.equal(search.official.hpcRoutes.every((route) => route === ''), true,
      'HPC2 routing details must stay out of the website list');
    assert.ok(search.personal.categoryHit, 'personal search must hit the category');
    assert.equal(search.personal.focusedFront, true, 'the category hit did not draw the card to the front');
    assert.match(search.personal.placeholder, /我的网站|my sites/iu);
    assert.equal(search.personal.searchExited, true, 'search did not restore the board view');

    const group = await exerciseGroupDialog(window);
    assert.equal(group.dialogClosed, true, 'the group dialog did not close after saving');
    assert.equal(group.created, true, 'the new category was not persisted through IPC');
    assert.equal(group.cardVisible, true, 'the new category did not appear as a card');
    assert.equal(group.error, '');

    const organize = await exerciseInlineOrganizeAndPin(window);
    assert.equal(organize.pageDuringEdit, 'browser', 'Organize navigated away from the current board');
    assert.equal(organize.editingDuring, 'true', 'Organize did not enter inline editing');
    assert.equal(organize.editingAfterSave, 'false', 'Done did not leave inline editing');
    assert.deepEqual(organize.actions, ['cancel', 'done', 'redo', 'reset', 'undo']);
    assert.equal(organize.handlesInEdit, organize.cardsInEdit,
      'editing did not expose one drag handle per personal card');
    assert.equal(organize.wholeCardDrag, true,
      'editing still exposes a tiny handle instead of making the card draggable');
    assert.match(organize.keyboardAnnouncement, /取消|移动/u,
      'keyboard move did not publish a live announcement');
    assert.ok(organize.commitCalls >= 1, 'Done did not commit the inline layout draft');
    assert.ok(organize.lastOperations.some(({ type }) => type === 'pin-to-board'),
      'pinning did not reach the revision-bound layout commit');
    assert.equal(organize.stackedAfter, true,
      'personal category cards were flattened after organizing');
    assert.equal(organize.sourceStillVisible, true, 'pinning moved the source card out of the workspace');
    assert.equal(organize.connectBoardId, 'connect', 'connection cards use the wrong board');
    assert.equal(organize.pinnedVisible, true, 'the pinned category did not appear on Connection');
    assert.ok(organize.pinnedResourceId, 'the pinned category did not expose its website content');
    assert.equal(organize.pinnedOpenRequest?.resourceId, organize.pinnedResourceId,
      'a website pinned to Connection did not open through its ID-only Main action');
    assert.equal(organize.fixedPowerOutsideBoard, true, 'the connection switch entered the movable board');
    await capture(window, output, 'pinned-connect');

    const reducedMotion = await reducedMotionSnapshot(window);
    assert.equal(reducedMotion.cardTransitionMs, '0s');
    assert.equal(reducedMotion.enterAnimation, 'none');
    window.setContentSize(820, 540);
    window.webContents.setZoomFactor(2);
    await new Promise((resolve) => setTimeout(resolve, 260));
    const zoomConnect = await shellSnapshot(window, 'connect');
    assert.ok(zoomConnect.bodyOverflow <= 0 && zoomConnect.contentOverflow <= 0 &&
      zoomConnect.underlayOverflow <= 0, '200% zoom: connection controls overflow horizontally');
    const zoomWorkspace = await shellSnapshot(window, 'browser');
    assert.ok(zoomWorkspace.bodyOverflow <= 0 && zoomWorkspace.contentOverflow <= 0,
      '200% zoom: the workspace overflows horizontally');
    const zoomTower = await shellSnapshot(window, 'tower');
    assert.ok(zoomTower.bodyOverflow <= 0 && zoomTower.contentOverflow <= 0,
      '200% zoom: Control Tower overflows horizontally');
    assert.equal(zoomTower.integrationRows, 2, '200% zoom: an export adapter became inaccessible');
    window.webContents.setZoomFactor(1);
    const underlaySwitch = await window.webContents.executeJavaScript(`(() => {
      document.querySelector('.nav[data-page="connect"]').click();
      const target = document.querySelector('[data-underlay-address="198.18.0.1"]');
      target.click();
      return new Promise((resolve) => {
        const deadline = Date.now() + 2000;
        const check = () => {
          const selected = document.querySelector('[data-underlay-address="198.18.0.1"]');
          if (selected?.getAttribute('aria-checked') === 'true') {
            resolve({ selected: true, active: selected.classList.contains('active'), status: document.getElementById('underlaySelectionStatus').textContent });
          } else if (Date.now() >= deadline) resolve({ selected: false, active: false, status: '' });
          else setTimeout(check, 20);
        };
        check();
      });
    })()`);
    assert.equal(underlaySwitch.selected, true);
    assert.equal(underlaySwitch.active, true);
    assert.ok(underlaySwitch.status, 'switching a connection line must publish a status');
    const contextualApply = await window.webContents.executeJavaScript(`(async () => {
      document.querySelector('.nav[data-page="tower"]').click();
      const actions = document.getElementById('towerActions');
      const initialHidden = actions.hidden;
      const input = document.getElementById('maxAttempts');
      input.value = String(Number(input.value) === 3 ? 4 : 3);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const visibleWhenDirty = !actions.hidden;
      document.getElementById('towerSave').click();
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && (!actions.hidden || document.getElementById('towerSaved').textContent)) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return { initialHidden, visibleWhenDirty, hiddenAfterSave: actions.hidden };
    })()`);
    assert.deepEqual(contextualApply, {
      initialHidden: true, visibleWhenDirty: true, hiddenAfterSave: true,
    }, 'Control Tower apply action must exist only while settings are dirty or confirming a save');
    const shortcut = await window.webContents.executeJavaScript(`(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
      return { page: document.querySelector('.page.active').dataset.page, focused: document.activeElement.id };
    })()`);
    assert.deepEqual(shortcut, { page: 'browser', focused: 'resourceSearch' });
    // Exercise the real timetable DOM with synthetic dates, independent of a
    // portal session. The ordinary layout fixture only renders signed-out data.
    await settle(window, 440, 540);
    await shellSnapshot(window, 'browser');
    if (!window.webContents.debugger.isAttached()) window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setTimezoneOverride', {
      timezoneId: 'America/Los_Angeles',
    });
    const calendar = await window.webContents.executeJavaScript(`(async () => {
      const campusData = await import(new URL('./features/campus-data/index.mjs', document.baseURI));
      const range = campusData.weekRange(Date.now(), true);
      const start = new Date(range.days[1] + 20 * 3600000);
      const end = new Date(range.days[2] + 10 * 3600000);
      const feature = campusData.create({
        document,
        api: { getCampusData: async () => ({ sessionState: 'fixture', modules: {
          schedule: { state: 'ready', source: 'myportal-calendar', items: [{ id: 'overnight', title: 'Fixture event',
            startsAt: start.getTime(), endsAt: end.getTime() }, {
              id: 'overlap', title: 'Concurrent fixture', startsAt: start.getTime(),
              endsAt: start.getTime() + 2 * 3600000,
            }] },
        } }) },
        translate: (key, values) => key === 'workspace.scheduleWeekCount'
          ? String(values.count) : key,
        escapeHtml: (text) => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;'),
        openDeepLink: () => {},
      });
      await feature.load();
      document.getElementById('moduleSchedule').scrollIntoView();
      return {
        days: [...document.querySelectorAll('#scheduleBody .week-event')].map(el => el.dataset.day),
        times: [...document.querySelectorAll('#scheduleBody .week-event time')].map(el => el.textContent),
        count: document.querySelector('#scheduleBody .week-summary span').textContent,
        firstTime: document.querySelector('#scheduleBody .week-time').textContent,
        rows: getComputedStyle(document.querySelector('#scheduleBody .week-body')).gridTemplateRows.split(' ').length,
        eventRows: [...document.querySelectorAll('#scheduleBody .week-event')]
          .map(el => Number(el.dataset.count)),
        eventRects: [...document.querySelectorAll('#scheduleBody .week-event')].map(el => {
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, width: r.width };
        }),
        overflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    })()`);
    assert.deepEqual(calendar.days, ['1', '2']);
    assert.deepEqual(calendar.times, ['20:00', '00:00']);
    assert.equal(calendar.count, '2');
    assert.equal(calendar.firstTime, '00:00');
    assert.equal(calendar.rows, 12);
    assert.deepEqual(calendar.eventRows, [2, 1]);
    assert.ok(calendar.eventRects[0].right <= calendar.eventRects[1].left,
      'different days must occupy separate columns; concurrent events remain in the detail group');
    assert.ok(calendar.eventRects.every(rect => rect.width > 0));
    assert.ok(calendar.overflow <= 0);
    await capture(window, output, 'narrow-calendar-segments');
    process.stdout.write('control shell layout: PASS\n');
  } finally {
    if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
    if (!window.isDestroyed()) window.destroy();
  }
}

main().then(() => app.quit(), (error) => { process.stderr.write(`${error.stack || error}\n`); app.exit(1); });
