(function initializeCampusWorkspaceCardBoard(root, factory) {
  const api = factory(root?.cardBoardController, root?.cardBoardModel);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.campusWorkspaceCardBoard = api;
})(typeof self !== 'undefined' ? self : globalThis, function campusWorkspaceCardBoardFactory(controller, cardBoardModel) {
  'use strict';

  function create({
    window,
    document,
    workspaceModel,
    getState,
    getText,
    categoryLabel,
    mutate,
    command,
  } = {}) {
    if (!window || !document || !workspaceModel || !controller || !cardBoardModel ||
        [getState, getText, categoryLabel, mutate, command].some((value) => typeof value !== 'function')) {
      throw new TypeError('Campus Workspace Card Board dependencies are incomplete');
    }
    const byId = (id) => document.getElementById(id);
    const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[character]));
    let catalogBoard = null;
    let personalBoard = null;
    let currentPrimaryView = 'workspace';

    function adapter() {
      if (![window.campusWorkspace?.getLayout, window.campusWorkspace?.commitLayout, window.campusWorkspace?.resetLayout]
        .every((method) => typeof method === 'function')) return null;
      return Object.freeze({
        get: () => window.campusWorkspace.getLayout(),
        commit: (payload) => window.campusWorkspace.commitLayout(payload),
        reset: (payload) => window.campusWorkspace.resetLayout(payload),
      });
    }

    function officialCategories() {
      const state = getState();
      if (!state) return [];
      const reviewed = state.resources.filter(({ builtin }) => builtin === true);
      const categories = workspaceModel.catalogProjection(reviewed).categories.map(({ id }) => ({
        id,
        name: categoryLabel(id),
        kind: 'official-category',
        items: workspaceModel.catalogProjection(reviewed, id).items,
      }));
      const gateways = reviewed.filter(({ category }) => category === 'gateway');
      if (gateways.length) {
        categories.unshift({ id: 'gateway', name: getText().starter, kind: 'official-category', items: gateways });
      }
      return categories;
    }

    function personalCategories() {
      const state = getState();
      if (!state) return [];
      const favorites = state.resources.filter(({ favorite }) => favorite);
      const resourceById = new Map(favorites.map((resource) => [resource.id, resource]));
      const assigned = new Set();
      const categories = state.groups.map((group) => {
        const items = group.resourceIds.map((id) => resourceById.get(id)).filter(Boolean);
        items.forEach(({ id }) => assigned.add(id));
        return { id: group.id, name: group.name, kind: 'user-collection', items };
      });
      const ungrouped = favorites.filter(({ id }) => !assigned.has(id));
      if (ungrouped.length) {
        categories.unshift({
          id: 'ungrouped-favorites',
          name: getText().ungrouped,
          kind: 'system-widget',
          items: ungrouped,
        });
      }
      return categories;
    }

    function syncDocument(nextDocument) {
      if (!nextDocument) return;
      const safe = cardBoardModel.cloneDocument(nextDocument);
      catalogBoard?.setDocument(safe);
      personalBoard?.setDocument(safe);
    }

    function syncEditState(editing) {
      const text = getText();
      byId('openManage').textContent = editing ? text.save : text.manage;
      byId('openManage').setAttribute('aria-pressed', String(editing));
      document.querySelectorAll('[data-primary-view]').forEach((button) => { button.disabled = editing; });
    }

    function ensure() {
      if (catalogBoard) return;
      const shared = {
        adapter: adapter(),
        escapeHtml,
        translate: (key) => {
          const text = getText();
          if (key === 'workspace.more') return text.more;
          if (key === 'resources.routeDirect') return text.direct;
          if (key === 'resources.routeCampus') return text.campus;
          if (key === 'resources.favorite') return text.favorite;
          if (key === 'resources.unfavorite') return text.unfavorite;
          return key;
        },
        onDocument: syncDocument,
        onEditingChange: syncEditState,
      };
      catalogBoard = controller.create({
        ...shared,
        container: byId('workspaceCatalogBoardHost'),
        toolbar: byId('workspaceCatalogEditToolbar'),
        boardId: 'browser-catalog',
      });
      personalBoard = controller.create({
        ...shared,
        container: byId('workspacePersonalBoardHost'),
        toolbar: byId('workspacePersonalEditToolbar'),
        boardId: 'browser-personal',
      });
      for (const host of [byId('workspaceCatalogBoardHost'), byId('workspacePersonalBoardHost')]) {
        host.addEventListener('click', (event) => {
          const resourceId = event.target.closest('[data-card-resource-id]')?.dataset.cardResourceId;
          const action = event.target.closest('[data-resource-action]')?.dataset.resourceAction;
          if (!resourceId || !action) return;
          if (action === 'open') command('open-resource', { resourceId });
          else if (action === 'favorite') void mutate('toggle-favorite', { resourceId });
        });
      }
      window.campusWorkspace?.onLayoutChanged?.(syncDocument);
    }

    function active(primaryView = currentPrimaryView) {
      return primaryView === 'catalog' ? catalogBoard : personalBoard;
    }

    function render(primaryView) {
      currentPrimaryView = primaryView;
      ensure();
      catalogBoard.setData({ categories: officialCategories(), query: '' });
      personalBoard.setData({ categories: personalCategories(), query: '' });
      const cardMode = primaryView !== 'recent';
      byId('workspaceCardBoard').hidden = !cardMode;
      byId('workspaceCardBoardCatalog').hidden = primaryView !== 'catalog';
      byId('workspaceCardBoardPersonal').hidden = primaryView !== 'workspace';
      if (cardMode) syncEditState(active(primaryView)?.isEditing() === true);
      return cardMode;
    }

    async function reload() {
      ensure();
      if (catalogBoard.isEditing() || personalBoard.isEditing()) return null;
      const documents = await Promise.all([catalogBoard.load(), personalBoard.load()]);
      const nextDocument = documents.find((document) => document?.schemaVersion === 1) || null;
      syncDocument(nextDocument);
      return nextDocument;
    }

    return Object.freeze({
      active,
      enterEdit() { ensure(); active()?.enterEdit(); },
      focusPersonalCollection(groupId) { ensure(); return personalBoard.focusCard('user-collection', groupId); },
      isEditing: () => catalogBoard?.isEditing() || personalBoard?.isEditing() || false,
      reload,
      render,
      toggleEdit() { ensure(); return active()?.toggleEdit(); },
    });
  }

  return Object.freeze({ create });
});
