'use strict';

// The control window keeps two card boards: the personal deck board on the
// Campus Workspace page ("我的分类") and the pinned copy on the Connection
// page. Official catalog cards live in the Campus Browser window; the main
// window shows the Official Service Desk instead (DESIGN.md §3–§9).
(function initializeCampusCategoryBoard(globalScope, cardBoardController, cardBoardModel) {
  if (!cardBoardController?.create || !cardBoardModel) {
    throw new TypeError('campus category board dependencies are required');
  }

  let current = null;
  let documentRef = null;
  let documentNode = null;
  let personalController = null;
  let connectController = null;
  let started = false;

  function personalCategoryProjection(resources, groups, translate) {
    const favorites = (Array.isArray(resources) ? resources : []).filter(({ favorite }) => favorite === true);
    const byId = new Map(favorites.map((resource) => [resource.id, resource]));
    const assigned = new Set();
    const projected = (Array.isArray(groups) ? groups : []).map((group) => {
      const items = (Array.isArray(group.resourceIds) ? group.resourceIds : [])
        .map((id) => byId.get(id)).filter(Boolean);
      items.forEach(({ id }) => assigned.add(id));
      return { id: group.id, name: group.name, kind: 'user-collection', items };
    }).filter(({ id, name }) => typeof id === 'string' && typeof name === 'string' && name.trim());
    const ungrouped = favorites.filter(({ id }) => !assigned.has(id));
    if (ungrouped.length) {
      projected.unshift({ id: 'ungrouped-favorites', name: translate('browser.ungrouped'), kind: 'system-widget', items: ungrouped });
    }
    return projected;
  }

  function categoryTranslationKey(labelKey) {
    const value = String(labelKey || 'custom');
    return `resources.category${value.charAt(0).toUpperCase()}${value.slice(1)}`;
  }

  // The pinned Connection copy can reference official categories, so its data
  // still projects the reviewed catalog alongside the personal collections.
  function officialCategoryProjection(resources, translate, workspaceModel) {
    const reviewed = (Array.isArray(resources) ? resources : []).filter(({ reviewed }) => reviewed === true);
    const gateways = reviewed.filter(({ category }) => category === 'gateway');
    const projection = workspaceModel.catalogProjection(reviewed);
    const categories = projection.categories.map((category) => ({
      id: category.id,
      name: translate(categoryTranslationKey(category.labelKey)),
      kind: 'official-category',
      items: workspaceModel.catalogProjection(reviewed, category.id).items,
    }));
    if (gateways.length) {
      categories.unshift({
        id: 'gateway',
        name: translate('browser.gatewayCategory'),
        kind: 'official-category',
        items: gateways,
      });
    }
    return categories;
  }

  function syncManageButton(editing) {
    const button = documentNode?.getElementById('manageResources');
    if (!button) return;
    button.setAttribute('aria-pressed', String(editing));
    button.textContent = current?.translate?.(editing ? 'workspace.organizeDone' : 'resources.manage')
      || (editing ? '完成' : '整理分类与网站');
  }

  function adapterForMainWindow() {
    const api = globalScope?.api;
    if (![api?.getCardBoardLayout, api?.commitCardBoardLayout, api?.resetCardBoardLayout]
      .every((method) => typeof method === 'function')) return null;
    return Object.freeze({
      get: () => api.getCardBoardLayout(),
      commit: (payload) => api.commitCardBoardLayout(payload),
      reset: (payload) => api.resetCardBoardLayout(payload),
    });
  }

  function syncDocument(nextDocument) {
    if (!nextDocument) return;
    documentRef = cardBoardModel.cloneDocument(nextDocument);
    personalController?.setDocument(documentRef);
    connectController?.setDocument(documentRef);
    const connectBoard = documentNode?.getElementById('connectCardBoard');
    if (connectBoard) {
      connectBoard.hidden = !documentRef.placements.some((placement) =>
        placement.boardId === 'connect' && placement.hidden !== true && placement.card.kind !== 'system-widget');
    }
  }

  function createController({ host, toolbar = null, pager = null, boardId,
    autoPlace = true, autoStack = false, pageSize = 0, pagerByCard = false }) {
    return cardBoardController.create({
      container: host,
      toolbar,
      boardId,
      autoPlace,
      autoStack,
      pager,
      pageSize,
      pagerByCard,
      switchStyle: boardId === 'browser-personal' ? 'service' : 'draw',
      renameCards: boardId === 'browser-personal',
      adapter: adapterForMainWindow(),
      escapeHtml: current?.escapeHtml || ((value) => String(value)),
      translate: (key, vars) => current?.translate?.(key, vars) || key,
      onDocument: syncDocument,
      onEditingChange: syncManageButton,
      onAddSite: () => current?.onAddSite?.(),
      onRenameCard: (payload) => current?.onRenameCard?.(payload),
      externalDropTargets: boardId === 'connect' ? [] : [{
        selector: '.nav[data-page="connect"]',
        boardId: 'connect',
      }],
      toast: (message, tone) => globalScope?.dispatchEvent?.(new CustomEvent('card-board-toast', {
        detail: { message, tone },
      })),
    });
  }

  function ensureControllers() {
    if (personalController || !documentNode) return;
    const personalWrap = documentNode.createElement('div');
    personalWrap.className = 'cb-board-view cb-personal-board';
    const toolbar = documentNode.createElement('div');
    toolbar.className = 'cb-edit-toolbar';
    toolbar.dataset.cardEditToolbar = '';
    toolbar.hidden = true;
    const host = documentNode.createElement('div');
    host.className = 'cb-board-host';
    const pager = documentNode.createElement('div');
    pager.id = 'personalCategoryPager';
    pager.className = 'portal-pager personal-category-pager';
    pager.setAttribute('role', 'navigation');
    pager.setAttribute('aria-label', current?.translate?.('workspace.personalPagination') || '我的分类分页');
    pager.hidden = true;
    personalWrap.append(toolbar, host, pager);
    const container = documentNode.getElementById('campusResources');
    container.replaceChildren(personalWrap);
    personalController = createController({
      host, toolbar, pager, boardId: 'browser-personal', autoStack: true,
      pageSize: 2, pagerByCard: true,
    });
    const connectHost = documentNode.getElementById('connectCardBoardHost');
    if (connectHost) connectController = createController({ host: connectHost, boardId: 'connect', autoPlace: false });
    Promise.all([personalController.load(), connectController?.load()])
      .then((documents) => syncDocument(documents.find((document) => document?.schemaVersion === 1)))
      .catch(() => {});
  }

  function performRender() {
    if (!current || !started) return;
    ensureControllers();
    const { resources, groups, translate } = current;
    personalController.setData({ categories: personalCategoryProjection(resources, groups, translate) });
    const official = officialCategoryProjection(
      resources, translate, current.workspaceModel || globalScope?.campusWorkspaceModel,
    );
    connectController?.setData({
      categories: [...official, ...personalCategoryProjection(resources, groups, translate)],
    });
  }

  function render(options = {}) {
    if (typeof options.translate !== 'function' || typeof options.escapeHtml !== 'function') {
      throw new TypeError('category board dependencies are incomplete');
    }
    current = { ...current, ...options };
    performRender();
  }

  function start({ document, onAddSite = null, onRenameCard = null } = {}) {
    documentNode = document;
    if (!documentNode?.getElementById('campusResources')) {
      throw new TypeError('category board container is missing');
    }
    current = { ...current, onAddSite, onRenameCard };
    started = true;
    globalScope?.api?.onCardBoardLayoutChanged?.(syncDocument);
    performRender();
  }

  const api = Object.freeze({
    activeController: () => personalController,
    cancelEdit: () => personalController?.cancelEdit(),
    focusCard: (kind, id) => personalController?.focusCard(kind, id) === true,
    isEditing: () => personalController?.isEditing() === true,
    officialCategoryProjection,
    personalCategoryProjection,
    render,
    start,
    toggleEdit: () => personalController?.toggleEdit(),
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (globalScope) globalScope.campusCategoryStacks = api;
})(typeof window !== 'undefined' ? window : null,
  typeof module !== 'undefined' && module.exports ? require('./components/card-board/card-board-controller') : globalThis.cardBoardController,
  typeof module !== 'undefined' && module.exports ? require('./components/card-board/card-board-model') : globalThis.cardBoardModel);
