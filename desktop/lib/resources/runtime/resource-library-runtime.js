'use strict';

const path = require('node:path');
const { resolveResourceById } = require('./campus-resources');
const { projectResourceActivity } = require('./resource-activity');
const { ResourceActivityStore } = require('./resource-activity-store');
const { localizeResources } = require('../presentation/localized-resource-view');
const { normalizePageFavoriteCandidate } = require('../schema/campus-resource-contract');
const { PageFavoriteController } = require('./page-favorite-controller');
const { FavoriteGroupStore, groupProjection } = require('./favorite-group-store');

class ResourceLibraryRuntime {
  constructor({
    favoritesFile,
    recentFile,
    platform,
    loadResources,
    captureContext,
    isContextCurrent,
    openRequest,
    loadAliases = () => [],
    ActivityStoreClass = ResourceActivityStore,
    GroupStoreClass = FavoriteGroupStore,
  } = {}) {
    for (const dependency of [
      loadResources, loadAliases, captureContext, isContextCurrent, openRequest,
    ]) {
      if (typeof dependency !== 'function') {
        throw new TypeError('resource library runtime dependencies are incomplete');
      }
    }
    this.loadResources = loadResources;
    this.loadAliases = loadAliases;
    this.captureContext = captureContext;
    this.isContextCurrent = isContextCurrent;
    this.openRequest = openRequest;
    this.activityStore = new ActivityStoreClass({ favoritesFile, recentFile, platform });
    this.activitySnapshot = null;
    this.groupSnapshot = null;
    this.groupStore = new GroupStoreClass({
      filePath: path.join(path.dirname(favoritesFile), 'favorite-groups.json'),
      platform,
    });
  }

  list(settings = null) {
    const resources = this.loadResources(settings);
    try {
      const activity = this.#reconcileActivity(settings);
      return projectResourceActivity(resources, activity.favorites, activity.recent);
    } catch {
      return projectResourceActivity(
        resources,
        { schemaVersion: 1, entries: [] },
        { schemaVersion: 1, entries: [] },
      );
    }
  }

  listLocalized(settings = null, locale = 'zh') {
    return localizeResources(this.list(settings), locale);
  }

  resolveRoutes(resources, resolveRoute) {
    if (!Array.isArray(resources) || typeof resolveRoute !== 'function') {
      throw new TypeError('resource route projection dependencies are incomplete');
    }
    return Object.freeze(resources.map((resource) => {
      const resolution = resolveRoute(resource.url);
      return Object.freeze({ ...resource,
        route: resolution?.route === 'direct' ? 'direct' : 'campus',
        routeSource: resolution?.source || 'default' });
    }));
  }

  snapshot() { this.activitySnapshot = null; return this.#reconcileActivity(null); }

  toggleFavorite(resourceId, resources) {
    this.activitySnapshot = null;
    const next = this.activityStore.toggleFavorite(resourceId, resources);
    if (!next.entries.includes(resourceId)) this.removeResourceFromGroups(resourceId);
    return next;
  }

  replaceFavorites(document) {
    this.activitySnapshot = null;
    return this.activityStore.replaceFavorites(document);
  }

  listGroups() {
    let favorites;
    let resources;
    let document;
    try {
      favorites = new Set(this.#reconcileActivity(null).favorites.entries);
      resources = new Set(this.loadResources().map(({ id }) => id));
      document = groupProjection(this.#groupDocument());
    }
    catch { return Object.freeze([]); }
    const groups = document.map((group) => Object.freeze({
      ...group,
      resourceIds: Object.freeze(group.resourceIds.filter((id) => favorites.has(id) && resources.has(id))),
    }));
    return Object.freeze(groups);
  }

  groupsSnapshot() { this.groupSnapshot = null; return this.#groupDocument(); }

  replaceGroups(document) { this.groupSnapshot = null; return this.groupStore.replace(document); }

  createGroup(name) { this.groupSnapshot = null; return this.groupStore.create(name); }

  renameGroup(groupId, name) { this.groupSnapshot = null; return this.groupStore.rename(groupId, name); }

  deleteGroup(groupId) { this.groupSnapshot = null; return this.groupStore.remove(groupId); }

  reorderGroups(groupIds) { this.groupSnapshot = null; return this.groupStore.reorder(groupIds); }

  moveResource(resourceId, groupId, index) {
    this.groupSnapshot = null;
    this.activitySnapshot = null;
    return this.groupStore.move(
      resourceId,
      groupId,
      index,
      this.activityStore.snapshot().favorites.entries,
    );
  }

  addResourcesToGroup(resourceIds, groupId) {
    this.groupSnapshot = null;
    this.activitySnapshot = null;
    return this.groupStore.addMany(
      resourceIds,
      groupId,
      this.activityStore.snapshot().favorites.entries,
    );
  }

  removeResourceFromGroups(resourceId) { this.groupSnapshot = null; return this.groupStore.removeResource(resourceId); }

  recordOpenByUrl(rawUrl) {
    let canonical;
    try {
      canonical = normalizePageFavoriteCandidate({
        url: rawUrl, title: '', route: 'campus',
      }).url;
    } catch {
      return false;
    }
    const resources = this.loadResources();
    const resource = resources.find((entry) => {
      try {
        return normalizePageFavoriteCandidate({
          url: entry.url, title: '', route: entry.route,
        }).url === canonical;
      } catch {
        return false;
      }
    });
    if (!resource) return false;
    this.activitySnapshot = null;
    this.activityStore.recordOpen(resource.id, resources);
    return true;
  }

  async openById(resourceId, locale = 'zh') {
    const available = this.loadResources();
    const resource = resolveResourceById(available, resourceId);
    const presentation = available.find((candidate) => candidate?.id === resource.id);
    const context = this.captureContext();
    if (!this.isContextCurrent(context)) throw new Error('resource context is stale');
    const result = await this.openRequest({
      url: resource.url,
      route: resource.route,
      displayName: typeof presentation?.name === 'string' && presentation.name
        ? presentation.name : resource.id,
    });
    if (!result?.ok) return result;
    if (this.isContextCurrent(context)) {
      this.activitySnapshot = null;
      try { this.activityStore.recordOpen(resource.id, this.loadResources()); } catch {}
    }
    return Object.freeze({
      ok: true,
      route: result.route === 'direct' ? 'direct' : 'campus',
      resourceId: resource.id,
      resources: this.listLocalized(null, locale),
    });
  }

  #groupDocument() { return this.groupSnapshot ||= this.groupStore.snapshot(); }

  #reconcileActivity(settings) {
    const aliases = this.loadAliases(settings);
    if (!Array.isArray(aliases) || aliases.length > 32 || aliases.some((alias) =>
      !alias || typeof alias !== 'object' || !/^[a-z0-9-]{1,40}$/u.test(alias.from) ||
      !/^[a-z0-9-]{1,40}$/u.test(alias.to))) {
      throw new TypeError('resource activity aliases are invalid');
    }
    // Presentation reads share one validated snapshot. Explicit snapshots and
    // mutations invalidate it; the store still verifies every disk operation.
    const current = this.activitySnapshot ||= this.activityStore.snapshot();
    if (!aliases.length) return current;
    const map = new Map(aliases.map(({ from, to }) => [from, to]));
    const favoriteEntries = [...new Set(current.favorites.entries.map((id) => map.get(id) || id))];
    const recentEntries = [];
    const recentIds = new Set();
    for (const entry of current.recent.entries) {
      const resourceId = map.get(entry.resourceId) || entry.resourceId;
      if (recentIds.has(resourceId)) continue;
      recentIds.add(resourceId);
      recentEntries.push({ resourceId, openedAt: entry.openedAt });
    }
    const nextFavorites = { schemaVersion: 1, entries: favoriteEntries };
    const nextRecent = { schemaVersion: 1, entries: recentEntries };
    if (JSON.stringify(nextFavorites) !== JSON.stringify(current.favorites)) {
      this.activitySnapshot = null;
      this.activityStore.replaceFavorites(nextFavorites);
    }
    if (JSON.stringify(nextRecent) !== JSON.stringify(current.recent)) {
      if (typeof this.activityStore.replaceRecent !== 'function') {
        throw new Error('resource activity store cannot migrate recent entries');
      }
      this.activitySnapshot = null;
      this.activityStore.replaceRecent(nextRecent);
    }
    const groupDocument = this.#groupDocument();
    const pairs = new Set();
    const placements = groupDocument.placements.map((placement) => ({
      ...placement,
      resourceId: map.get(placement.resourceId) || placement.resourceId,
    })).filter((placement) => {
      const pair = `${placement.collectionId}\0${placement.resourceId}`;
      if (pairs.has(pair)) return false;
      pairs.add(pair); return true;
    });
    const nextGroups = {
      ...groupDocument,
      placements: groupDocument.collections.flatMap(({ id: collectionId }) => placements
        .filter((placement) => placement.collectionId === collectionId)
        .sort((left, right) => left.order - right.order)
        .map((placement, order) => ({ ...placement, order }))),
    };
    if (JSON.stringify(nextGroups) !== JSON.stringify(groupDocument)) {
      this.groupSnapshot = null;
      this.groupStore.replace(nextGroups);
    }
    return this.activitySnapshot ||= this.activityStore.snapshot();
  }
}

module.exports = { FavoriteGroupStore, PageFavoriteController, ResourceLibraryRuntime };
