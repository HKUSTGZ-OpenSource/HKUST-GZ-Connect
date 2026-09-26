'use strict';

const { RESOURCE_CATEGORIES: BROWSER_RESOURCE_CATEGORIES, normalizePageFavoriteCandidate } =
  require('../../resources/schema/campus-resource-contract');
const { ROUTE_CAMPUS, ROUTE_DIRECT } = require('../../routing/policy/campus-route');
const BLANK_CAMPUS_HOME = 'about:blank';
const MAX_WORKSPACE_HOME_RESOURCES = 64;

const RESOURCE_ID = /^[a-z0-9-]{1,40}$/u;
const GROUP_ID = /^group_[a-z0-9_-]{12,64}$/u;
const REQUEST_ID = /^workspace-[a-z0-9](?:[a-z0-9-]{0,63})$/u;
const GROUP_NAME_MAX = 30;
const RESOURCE_CATEGORIES = new Set([
  'gateway', 'newcomer', 'courses', 'labs', 'student-finance', 'expenses',
  'documents', 'tools', 'staff',
  'getting-started', 'learning', 'research', 'finance', 'career', 'campus-life',
  'applications', 'services', 'common', 'academic', 'campus-service', 'custom',
]);
const COMMANDS = new Set([
  'ready',
  'focus-address',
  'open-resource',
  'toggle-favorite',
  'rename-resource',
  'delete-resource',
  'manage-rules',
  'create-group',
  'rename-group',
  'delete-group',
  'reorder-groups',
  'move-resource',
  'add-resources-to-group',
]);
const MUTATION_COMMANDS = new Set([
  'toggle-favorite',
  'rename-resource',
  'delete-resource',
  'create-group',
  'rename-group',
  'delete-group',
  'reorder-groups',
  'move-resource',
  'add-resources-to-group',
]);

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype ? value : null;
}

function normalizeWorkspaceCommand(value) {
  const source = plainObject(value);
  if (!source || !COMMANDS.has(source.command)) return null;
  const keys = Object.keys(source).sort();
  if (source.command === 'ready' || source.command === 'focus-address' || source.command === 'manage-rules') {
    return keys.length === 1 ? Object.freeze({ command: source.command }) : null;
  }
  if (source.command === 'open-resource' || source.command === 'toggle-favorite') {
    return keys.length === 2 && RESOURCE_ID.test(source.resourceId)
      ? Object.freeze({ command: source.command, resourceId: source.resourceId }) : null;
  }
  if (source.command === 'rename-resource') {
    const name = typeof source.name === 'string' ? source.name.trim() : '';
    return keys.length === 3 && RESOURCE_ID.test(source.resourceId) && name &&
      name.length <= 40 && !/[\u0000-\u001f\u007f<>]/u.test(name)
      ? Object.freeze({ command: source.command, resourceId: source.resourceId, name }) : null;
  }
  if (source.command === 'delete-resource') {
    return keys.length === 2 && RESOURCE_ID.test(source.resourceId)
      ? Object.freeze({ command: source.command, resourceId: source.resourceId }) : null;
  }
  if (source.command === 'create-group') {
    const name = typeof source.name === 'string' ? source.name.trim() : '';
    return keys.length === 2 && name && name.length <= GROUP_NAME_MAX &&
      !/[\u0000-\u001f\u007f<>]/u.test(name)
      ? Object.freeze({ command: source.command, name }) : null;
  }
  if (source.command === 'rename-group') {
    const name = typeof source.name === 'string' ? source.name.trim() : '';
    return keys.length === 3 && GROUP_ID.test(source.groupId) && name &&
      name.length <= GROUP_NAME_MAX && !/[\u0000-\u001f\u007f<>]/u.test(name)
      ? Object.freeze({ command: source.command, groupId: source.groupId, name }) : null;
  }
  if (source.command === 'delete-group') {
    return keys.length === 2 && GROUP_ID.test(source.groupId)
      ? Object.freeze({ command: source.command, groupId: source.groupId }) : null;
  }
  if (source.command === 'reorder-groups') {
    if (keys.length !== 2 || !Array.isArray(source.groupIds) || source.groupIds.length > 16 ||
        new Set(source.groupIds).size !== source.groupIds.length ||
        source.groupIds.some((id) => !GROUP_ID.test(id))) return null;
    return Object.freeze({ command: source.command, groupIds: Object.freeze([...source.groupIds]) });
  }
  if (source.command === 'move-resource') {
    const groupId = source.groupId === null ? null : source.groupId;
    return keys.length === 4 && RESOURCE_ID.test(source.resourceId) &&
      (groupId === null || GROUP_ID.test(groupId)) &&
      Number.isSafeInteger(source.index) && source.index >= 0 && source.index <= 64
      ? Object.freeze({
        command: source.command,
        resourceId: source.resourceId,
        groupId,
        index: source.index,
      }) : null;
  }
  if (source.command === 'add-resources-to-group') {
    return keys.length === 3 && GROUP_ID.test(source.groupId) &&
      Array.isArray(source.resourceIds) && source.resourceIds.length > 0 &&
      source.resourceIds.length <= 64 && new Set(source.resourceIds).size === source.resourceIds.length &&
      source.resourceIds.every((id) => RESOURCE_ID.test(id))
      ? Object.freeze({ command: source.command, groupId: source.groupId,
        resourceIds: Object.freeze([...source.resourceIds]) }) : null;
  }
  return null;
}

function normalizeWorkspaceRequest(value) {
  const source = plainObject(value);
  if (!source || Object.keys(source).sort().join(',') !== 'command,requestId' ||
      !REQUEST_ID.test(source.requestId)) return null;
  const command = normalizeWorkspaceCommand(source.command);
  if (!command || !MUTATION_COMMANDS.has(command.command)) return null;
  return Object.freeze({ requestId: source.requestId, command });
}

function resultError(value, fallback = '') {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 300 || /[\u0000-\u001f\u007f]/u.test(text)) return fallback;
  return text;
}

function projectWorkspaceResult(requestId, value, thrown = null) {
  if (!REQUEST_ID.test(requestId)) {
    throw new TypeError('Campus Workspace request identity is invalid');
  }
  if (!thrown && value?.ok === true) {
    return Object.freeze({ requestId, ok: true });
  }
  const stale = thrown?.code === 'stale_context' || value?.stale === true;
  return Object.freeze({
    requestId,
    ok: false,
    code: stale ? 'WORKSPACE_MUTATION_STALE' : 'WORKSPACE_MUTATION_FAILED',
    // Filesystem and transaction exceptions can contain local paths. Only an
    // explicitly projected user message or a typed command result may cross
    // this sandbox boundary; the renderer owns the localized fallback.
    error: resultError(thrown?.userMessage || (!thrown && value?.error)),
  });
}

function projectWorkspaceResources(value) {
  if (!Array.isArray(value) || value.length > 64) {
    throw new TypeError('Campus Workspace resources are invalid');
  }
  return Object.freeze(value.map((resource) => {
    const keywords = resource?.keywords == null ? [] : resource.keywords;
    if (!resource || typeof resource !== 'object' ||
        !RESOURCE_ID.test(resource.id) || typeof resource.name !== 'string' ||
        !resource.name.trim() || resource.name.length > 80 ||
        /[\u0000-\u001f\u007f<>]/u.test(resource.name) ||
        !['campus', 'direct'].includes(resource.route) ||
        !RESOURCE_CATEGORIES.has(resource.category) ||
        !Array.isArray(keywords) || keywords.length > 12 ||
        keywords.some((keyword) => typeof keyword !== 'string' || keyword.length > 40 ||
          /[\u0000-\u001f\u007f<>]/u.test(keyword)) ||
        typeof resource.favorite !== 'boolean' ||
        (resource.lastOpenedAt !== null &&
         (!Number.isSafeInteger(resource.lastOpenedAt) || resource.lastOpenedAt <= 0))) {
      throw new TypeError('Campus Workspace resource is invalid');
    }
    return Object.freeze({
      id: resource.id,
      name: resource.name.trim(),
      route: resource.route,
      category: resource.category,
      favorite: resource.favorite,
      lastOpenedAt: resource.lastOpenedAt,
      builtin: resource.builtin === true,
      keywords: Object.freeze([...keywords]),
    });
  }));
}

function projectWorkspaceGroups(value) {
  if (!Array.isArray(value) || value.length > 16) {
    throw new TypeError('Campus Workspace groups are invalid');
  }
  const ids = new Set();
  return Object.freeze(value.map((group) => {
    if (!group || typeof group !== 'object' || !GROUP_ID.test(group.id) || ids.has(group.id) ||
        typeof group.name !== 'string' || !group.name.trim() || group.name.length > GROUP_NAME_MAX ||
        /[\u0000-\u001f\u007f<>]/u.test(group.name) || !Array.isArray(group.resourceIds) ||
        group.resourceIds.length > 64 || new Set(group.resourceIds).size !== group.resourceIds.length ||
        group.resourceIds.some((id) => !RESOURCE_ID.test(id))) {
      throw new TypeError('Campus Workspace group is invalid');
    }
    ids.add(group.id);
    return Object.freeze({
      id: group.id,
      name: group.name.trim(),
      resourceIds: Object.freeze([...group.resourceIds]),
    });
  }));
}

function projectBrowserWorkspaceResources(value, normalizeUrl, t) {
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
    const url = normalizeUrl(resource.url, t);
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
      category: BROWSER_RESOURCE_CATEGORIES.includes(resource.category)
        ? resource.category : 'custom',
      favorite: resource.favorite,
      lastOpenedAt: resource.lastOpenedAt,
    });
  }));
}

// Browser-facing workspace projection and effects. No storage or routing authority.
class BrowserWorkspaceOwner {
  constructor(ports) {
    Object.assign(this, ports);
    this.retired = false;
    this.pendingFocus = new Set();
    this.loadingFocus = new WeakMap();
  }
  get workspaceController() { return this.getController(); }
  get profilePresentation() { return this.getPresentation(); }
  get tabs() { return this.getTabs(); }
  get onTogglePageFavorite() { return this.getToggleFavorite(); }

  retire() {
    if (this.retired) return;
    this.retired = true;
    for (const handle of this.pendingFocus) clearImmediate(handle);
    this.pendingFocus.clear();
    for (const tab of this.tabs) {
      if (this.loadingFocus.has(tab) && tab.pendingWorkspaceFocus === this.loadingFocus.get(tab)) {
        tab.pendingWorkspaceFocus = null;
      }
    }
  }

  workspaceResources() {
    if (this.retired) return Object.freeze([]);
    try { return projectBrowserWorkspaceResources(this.getWorkspaceResources(), this.normalizeUrl, this.t); }
    catch { return Object.freeze([]); }
  }

  workspaceGroups() {
    if (this.retired) return Object.freeze([]);
    try { return projectWorkspaceGroups(this.getWorkspaceGroups()); }
    catch { return Object.freeze([]); }
  }

  bookmarkBarState() {
    if (this.retired) return Object.freeze([]);
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
    if (this.retired || !this.workspaceController) return;
    for (const tab of this.tabs) {
      if (tab.kind === 'workspace') this.workspaceController.sendState(tab.view.webContents);
    }
  }

  refreshCardBoardLayout(document) {
    if (this.retired) return false;
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
    if (this.retired || !this.workspaceController) return false;
    const controller = this.workspaceController;
    let tab = this.activeTab();
    if (!tab || tab.kind !== 'workspace') {
      const existing = this.tabs.find((candidate) => candidate.kind === 'workspace');
      tab = existing || this.createTab(BLANK_CAMPUS_HOME, ROUTE_DIRECT);
      if (existing) this.switchTab(existing.id);
    }
    if (!tab || tab.view.webContents.isDestroyed()) return false;
    const focus = () => {
      if (this.retired || this.workspaceController !== controller ||
          !this.tabs.includes(tab) || this.activeTab() !== tab ||
          tab.view.webContents.isDestroyed()) return;
      if (typeof controller.focus === 'function') {
        controller.focus(tab.view.webContents, target, query);
      } else if (target === 'search') {
        controller.focusSearch?.(tab.view.webContents);
      }
    };
    if (tab.loading) {
      tab.pendingWorkspaceFocus = { target, query };
      this.loadingFocus.set(tab, tab.pendingWorkspaceFocus);
    }
    else {
      const handle = setImmediate(() => { this.pendingFocus.delete(handle); focus(); });
      this.pendingFocus.add(handle);
    }
    return true;
  }

  pageFavoriteState(tab = this.activeTab()) {
    if (this.retired) return { canFavorite: false, favorite: false };
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
    let result;
    try {
      result = await this.onTogglePageFavorite({
        url: this.currentUrl(tab),
        title: tab.view.webContents.getTitle?.() || '',
        route: tab.route || ROUTE_CAMPUS,
      });
    } catch (error) {
      if (this.retired) return false;
      throw error;
    }
    if (this.retired) return false;
    if (!result?.ok) {
      this.onError?.(result?.error || this.t('browser.favoriteFailed'));
      return false;
    }
    this.refreshWorkspaceHomes();
    if (!this.retired) this.updateToolbar();
    return true;
  }
}

class CampusWorkspaceController {
  constructor({
    workspaceFile,
    workspacePreload,
    getProfilePresentation,
    getResources,
    getGroups = () => [],
    getLocale,
    onCommand,
  } = {}) {
    for (const dependency of [getProfilePresentation, getResources, getGroups, getLocale, onCommand]) {
      if (typeof dependency !== 'function') {
        throw new TypeError('Campus Workspace controller dependencies are incomplete');
      }
    }
    if (![workspaceFile, workspacePreload].every((value) => typeof value === 'string' && value)) {
      throw new TypeError('Campus Workspace files are invalid');
    }
    Object.assign(this, {
      workspaceFile, workspacePreload, getProfilePresentation, getResources,
      getGroups, getLocale, onCommand,
    });
  }

  state() {
    const profile = this.getProfilePresentation();
    return Object.freeze({
      schoolName: profile.schoolName,
      unverified: profile.unverified === true,
      officialPortalResourceId: profile.officialPortalResourceId || null,
      locale: this.getLocale() === 'en' ? 'en' : 'zh',
      resources: projectWorkspaceResources(this.getResources()),
      groups: projectWorkspaceGroups(this.getGroups()),
    });
  }

  sendState(contents) {
    if (!contents || contents.isDestroyed?.()) return false;
    contents.send?.('campus-workspace-state', this.state());
    return true;
  }

  createView(WebContentsView, browserSession) {
    if (typeof WebContentsView !== 'function' || !browserSession) {
      throw new TypeError('Campus Workspace view environment is incomplete');
    }
    const view = new WebContentsView({
      webPreferences: {
        session: browserSession,
        preload: this.workspacePreload,
        devTools: false,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        safeDialogs: true,
        backgroundThrottling: true,
      },
    });
    this.attach(view.webContents);
    return view;
  }

  async load(view) {
    if (!view?.webContents || typeof view.webContents.loadFile !== 'function') {
      throw new TypeError('Campus Workspace view cannot load its local file');
    }
    await view.webContents.loadFile(this.workspaceFile);
    this.sendState(view.webContents);
    return true;
  }

  focus(contents, target = 'search', query = '') {
    if (!contents || contents.isDestroyed?.()) return false;
    if (!['search', 'manage'].includes(target)) return false;
    const normalizedQuery = String(query || '').trim();
    if (normalizedQuery.length > 80 || /[\u0000-\u001f\u007f]/u.test(normalizedQuery)) return false;
    contents.send?.('campus-workspace-focus', Object.freeze({ target, query: normalizedQuery }));
    return true;
  }

  focusSearch(contents) { return this.focus(contents, 'search'); }

  attach(contents) {
    const pending = new Set();
    const sendResult = (result) => {
      if (!contents || contents.isDestroyed?.()) return false;
      try {
        contents.send?.('campus-workspace-result', result);
        return true;
      } catch {
        return false;
      }
    };
    contents.on('ipc-message', (_event, channel, payload) => {
      if (channel !== 'campus-workspace-command') return;
      const rawRequestId = plainObject(payload) && typeof payload.requestId === 'string' &&
        REQUEST_ID.test(payload.requestId) ? payload.requestId : null;
      if (rawRequestId) {
        const request = normalizeWorkspaceRequest(payload);
        if (!request) {
          sendResult(projectWorkspaceResult(rawRequestId, {
            ok: false, error: '',
          }));
          return;
        }
        if (pending.has(request.requestId)) {
          sendResult(projectWorkspaceResult(request.requestId, {
            ok: false, error: '',
          }));
          return;
        }
        pending.add(request.requestId);
        Promise.resolve()
          .then(() => this.onCommand(request.command))
          .then((value) => {
            if (contents.isDestroyed?.()) return;
            const result = projectWorkspaceResult(request.requestId, value);
            if (result.ok) {
              try { this.sendState(contents); } catch {}
            }
            sendResult(result);
          })
          .catch((error) => {
            sendResult(projectWorkspaceResult(request.requestId, null, error));
          })
          .finally(() => pending.delete(request.requestId));
        return;
      }
      const command = normalizeWorkspaceCommand(payload);
      if (!command || MUTATION_COMMANDS.has(command.command)) return;
      if (command.command === 'ready') {
        this.sendState(contents);
        return;
      }
      Promise.resolve(this.onCommand(command)).then(() => this.sendState(contents)).catch(() => {});
    });
  }
}

module.exports = {
  BrowserWorkspaceOwner,
  projectBrowserWorkspaceResources,
  MAX_WORKSPACE_HOME_RESOURCES,
  CampusWorkspaceController,
  normalizeWorkspaceCommand,
  normalizeWorkspaceRequest,
  projectWorkspaceResult,
  projectWorkspaceGroups,
  projectWorkspaceResources,
};
