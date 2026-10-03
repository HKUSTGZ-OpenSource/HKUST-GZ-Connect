import { createRendererFeatures } from './features/feature-host/index.mjs';
const rendererFeatures = createRendererFeatures({ target: window });
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Active UI language. Chinese until get-state reports the real system locale.
let t = window.I18N.createT('zh');
const { evaluateLoginProgress } = window.loginFlow;
let st = {
  connected: false,
  connecting: false,
  clientIp: null,
  dnsMode: 'unknown',
  lastError: null,
};
let settings = {};
let campusActionBusy = false;
let campusResources = [], resourceGroups = [], serviceDeskData = null, portalServiceDeskData = null;
let serviceDeskProfileId = null;
let loginPending = false;
let usabilityFeature = null, serviceWorkspace = null, groupDialogFeature = null, favoriteDialogFeature = null, campusDataFeature = null;
let proxyAuthFeature = null, browserNewTabSettings = null, addWebsiteFeature = null, connectionOverviewFeature = null;
let controlTowerFeature = null;
['auth-challenge', 'integration-center'].forEach(id => rendererFeatures.mount(id, { api: window.api, document, i18n: window.I18N, target: window }));
const updateNoticesFeature = rendererFeatures.mount('update-notices', {
  document,
  translate: (key, vars) => t(key, vars),
  escapeHtml: esc,
  checkUpdate: (manual) => window.api.checkUpdate(manual),
  openExternal: (url) => window.api.openExternal(url),
  timers: {
    setTimeout: (callback, delay) => window.setTimeout(callback, delay),
    clearTimeout: (timer) => window.clearTimeout(timer),
  },
});
const notificationsFeature = rendererFeatures.mount('notifications', {
  document,
  translate: (key, vars) => t(key, vars),
  getLogs: () => window.api.getLogs(),
  openPage: setPage,
  reconnect: () => (!st.connected && !st.connecting ? window.api.connect() : null),
  matchMedia: (query) => window.matchMedia(query),
  timers: {
    setTimeout: (callback, delay) => window.setTimeout(callback, delay),
    clearTimeout: (timer) => window.clearTimeout(timer),
    requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
    cancelAnimationFrame: (frame) => window.cancelAnimationFrame(frame),
  },
});
function activeLoginProfileId() {
  return window.schoolProfileSelectorFeature?.credentialProfileId?.() || null;
}

function show(view) { $('login').hidden = view !== 'login'; $('dash').hidden = view !== 'dash'; }

function applyLocale(rawLocale) {
  const locale = window.I18N.resolveLocale(rawLocale);
  t = window.I18N.createT(locale);
  document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
  window.I18N.applyStatic(t, document);
  // Labels whose text depends on runtime state, not just the locale.
  document.querySelectorAll('[data-toggle-section]').forEach((button) => {
    const panel = document.querySelector(`[data-collapsible="${button.dataset.toggleSection}"]`);
    const expanded = panel ? !panel.hidden : false;
    button.textContent = expanded ? t('section.collapse') : t('section.expand');
    button.setAttribute('aria-expanded', String(expanded));
  });
  document.dispatchEvent(new Event('app-locale-changed'));
}
function setPage(page) {
  document.querySelectorAll('.nav').forEach((n) => n.classList.toggle('active', n.dataset.page === page));
  document.querySelectorAll('.page').forEach((p) => { const on = p.dataset.page === page; p.classList.toggle('active', on); p.hidden = !on; });
  const content = document.querySelector('.content');
  if (content) { content.classList.toggle('tower-scroll', page === 'tower'); content.classList.remove('user-scrolling'); content.scrollTop = 0; }
  if (page === 'browser') {
    renderResources();
    void campusDataFeature?.ensureLoaded();
  }
  if (page === 'settings') updateNoticesFeature.runCheck(false);
  if (page === 'connect') connectionOverviewFeature?.refreshEnvironment(st.loggedIn === true);
}
window.api.onOpenSettings?.(() => { show('dash'); setPage('settings'); refreshState(); });

function updateLoginProgress(s) {
  if (!loginPending) return;
  const next = evaluateLoginProgress(loginPending, s, t);
  $('lgBtn').disabled = next.pending || activeLoginProfileId() === null;
  $('lgBtn').textContent = next.pending ? t('connect.connecting') : t('login.submit');
  $('lgErr').textContent = next.error;
  if (next.pending) return;
  loginPending = false;
  if (next.clearPassword) $('lgPass').value = '';
  show(next.view);
  if (next.view === 'dash') setPage('connect');
}

function renderConnect(s) {
  // Status pushes carry the effective locale so a language switch re-renders
  // live; locally constructed state has no locale and keeps the current one.
  if (typeof s.locale === 'string') applyLocale(s.locale);
  st = { ...st, ...s };
  usabilityFeature?.updateConnection(s);
  connectionOverviewFeature?.renderStatus(s, t);
  $('settingsNotice').hidden = !s.notice;
  $('settingsNotice').textContent = s.notice || '';
  notificationsFeature.renderStatus(s);
  updateLoginProgress(s);
}

function renderTelemetry(tele) {
  connectionOverviewFeature?.renderTelemetry(tele, t);
}

function renderResources() {
  window.campusCategoryStacks.render({
    resources: campusResources, groups: resourceGroups, translate: t, escapeHtml: esc,
  });
  serviceWorkspace?.render();
}

async function openDeepLink(resourceId, fallbackUrl) {
  if (resourceId && campusResources.some((resource) => resource.id === resourceId)) {
    await openCampus({ id: resourceId });
    return;
  }
  if (fallbackUrl) await openCampus(fallbackUrl);
}

async function refreshState({ preserveTower = false } = {}) {
  const s = await window.api.getState();
  applyLocale(s.locale);
  document.dispatchEvent(new CustomEvent('app-state-refreshed', { detail: { schoolProfile: s.schoolProfile, loggedIn: s.loggedIn } }));
  settings = s.settings || {};
  campusResources = Array.isArray(s.campusResources) ? s.campusResources : [];
  resourceGroups = Array.isArray(s.resourceGroups) ? s.resourceGroups : [];
  const nextProfileId = s.schoolProfile?.profileId || null;
  if (serviceDeskProfileId !== nextProfileId) portalServiceDeskData = null;
  serviceDeskProfileId = nextProfileId;
  serviceDeskData = s.serviceDesk || null;
  renderConnect(s);
  renderResources();
  controlTowerFeature?.render(settings, { preserve: preserveTower });
  $('acct').textContent = settings.username || '—';
  $('ver').textContent = s.version ? `v${s.version}` : '—';
  if (s.update) updateNoticesFeature.renderResult(s.update);
  $('closeAction').value = ['ask', 'minimize', 'quit'].includes(settings.closeAction) ? settings.closeAction : 'ask';
  $('language').value = ['auto', 'zh', 'en'].includes(settings.language) ? settings.language : 'auto';
  browserNewTabSettings?.render(settings);
  if (document.querySelector('.page.active')?.dataset.page === 'connect') connectionOverviewFeature?.refreshEnvironment(s.loggedIn === true);
  return s;
}

async function init() {
  const s = await refreshState();
  if (!s.loggedIn) {
    const account = await window.api.getLoginAccount().catch(() => null);
    $('lgUser').value = account?.ok ? account.username : '';
  }
  show(s.loggedIn ? 'dash' : 'login');
}

// login
$('lgBtn').addEventListener('click', async () => {
  if (loginPending) return;
  const expectedProfileId = activeLoginProfileId();
  if (!expectedProfileId) {
    $('lgErr').textContent = t('school.activateBeforeLogin');
    return;
  }
  const u = $('lgUser').value.trim(), p = $('lgPass').value;
  if (!u) { $('lgErr').textContent = t('login.needAccount'); return; }
  if (!p) { $('lgErr').textContent = t('login.needPassword'); return; }
  let saved;
  try {
    saved = await window.api.save({ username: u, password: p, expectedProfileId });
  } catch (error) {
    $('lgErr').textContent = error?.message || t('login.passwordSaveFailed');
    return;
  }
  if (!saved.ok) { $('lgErr').textContent = saved.error || t('login.passwordSaveFailed'); return; }
  if (saved.outcome === 'saved_memory_only' && saved.warning) {
    usabilityFeature?.toast(saved.warning, 'info');
  }
  loginPending = true;
  $('lgBtn').disabled = true;
  $('lgBtn').textContent = t('connect.connecting');
  $('lgErr').textContent = t('login.connecting');
  try {
    await window.api.connect();
    await refreshState();
  } catch (error) {
    loginPending = false;
    $('lgBtn').disabled = activeLoginProfileId() === null;
    $('lgBtn').textContent = t('login.submit');
    $('lgErr').textContent = error?.message || t('login.connectFailed');
  }
});
$('lgPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('lgBtn').click(); });

// nav + power
document.querySelectorAll('.nav').forEach((n) => n.addEventListener('click', () => setPage(n.dataset.page)));
$('power').addEventListener('click', async () => {
  if (st.connecting) return;
  if (st.connected) await window.api.disconnect(); else await window.api.connect();
});

document.querySelectorAll('[data-toggle-section]').forEach((button) => {
  button.addEventListener('click', () => {
    const key = button.dataset.toggleSection;
    const panel = document.querySelector(`[data-collapsible="${key}"]`);
    if (!panel) return;
    const expanded = panel.hidden;
    panel.hidden = !expanded;
    button.textContent = expanded ? t('section.collapse') : t('section.expand');
    button.setAttribute('aria-expanded', String(expanded));
  });
});

async function openCampus(selected) {
  if (campusActionBusy) return;
  campusActionBusy = true;
  try {
    const result = selected && typeof selected === 'object' && selected.id
      ? await window.api.openResource(selected.id)
      : await window.api.openCampusBrowser({ url: String(selected || '') });
    if (Array.isArray(result?.resources)) {
      campusResources = result.resources;
      renderResources();
    }
    if (!result || !result.ok) usabilityFeature?.toast(result?.error || t('quick.browserOpenFailed'), 'error');
  } finally {
    campusActionBusy = false;
  }
}
function handleCardBoardResourceAction(event) {
  const target = event.target.closest('[data-campus-id]');
  const resource = campusResources.find((item) => item.id === target?.dataset.campusId);
  if (!resource) return;
  const action = event.target.closest('[data-resource-action]')?.dataset.resourceAction;
  if (action === 'favorite') {
    window.api.toggleResourceFavorite(resource.id).then((result) => {
      if (!result?.ok) {
        usabilityFeature?.toast(result?.error || t('resources.favoriteFailed'), 'error');
        return;
      }
      campusResources = result.resources || campusResources;
      renderResources();
      usabilityFeature?.toast(t(resource.favorite ? 'resources.unfavoriteSaved' : 'resources.favoriteSaved'));
    }).catch(() => usabilityFeature?.toast(t('resources.favoriteFailed'), 'error'));
    return;
  }
  if (action === 'open') openCampus(resource);
}
$('campusResources').addEventListener('click', handleCardBoardResourceAction);
$('connectCardBoardHost').addEventListener('click', handleCardBoardResourceAction);
$('closeAction').addEventListener('change', async () => {
  await window.api.save({ closeAction: $('closeAction').value });
  settings.closeAction = $('closeAction').value;
});
$('language').addEventListener('change', async () => {
  await window.api.save({ language: $('language').value });
  settings.language = $('language').value;
  // get-state returns the effective locale, so this repaints in the new
  // language even for 'auto'; main also pushes it via the status channel.
  await refreshState();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshState({ preserveTower: true }).then(() => connectionOverviewFeature?.refreshEnvironment(st.loggedIn === true));
});
window.addEventListener('focus', () => {
  if (document.querySelector('.page.active')?.dataset.page === 'browser') {
    void campusDataFeature?.ensureLoaded();
  }
});

$('openBrowser').addEventListener('click', openCampus);
$('openLog2').addEventListener('click', () => window.api.openLog());
$('openAdvancedSettings').addEventListener('click', () => setPage('tower'));

// settings
$('logoutBtn').addEventListener('click', async () => {
  loginPending = false;
  const result = await window.api.logout();
  if (!result?.ok) {
    const message = result?.error || t('settings.logoutFailed');
    const refreshed = await refreshState({ preserveTower: true });
    if (refreshed.loggedIn === false) {
      $('lgUser').value = '';
      $('lgPass').value = '';
      $('lgErr').textContent = message;
      $('lgBtn').disabled = activeLoginProfileId() === null;
      $('lgBtn').textContent = t('login.submit');
      show('login');
    } else {
      controlTowerFeature?.flash(message, true);
    }
    return;
  }
  await refreshState();
  $('lgPass').value = '';
  $('lgBtn').disabled = activeLoginProfileId() === null;
  $('lgBtn').textContent = t('login.submit');
  show('login');
});
$('openLogLink').addEventListener('click', (e) => { e.preventDefault(); window.api.openLog(); });
window.api.onStatus((s) => {
  renderConnect(s);
  if (s.update) updateNoticesFeature.renderResult(s.update);
});
window.api.onTelemetry(renderTelemetry);
proxyAuthFeature = window.proxyAuthMigration.createProxyAuthMigration({
  api: window.api,
  document,
  translate: (key, vars) => t(key, vars),
  getSettings: () => settings,
  setSettings: (next) => { settings = next; },
  isTowerBusy: () => controlTowerFeature?.isSaving() === true,
  flash: (message, isError) => controlTowerFeature?.flash(message, isError),
});
proxyAuthFeature.start();
controlTowerFeature = rendererFeatures.mount('control-tower', {
  document,
  api: window.api,
  translate: (key, vars) => t(key, vars),
  getSettings: () => settings,
  setSettings: (next) => { settings = next; },
  refreshState: () => refreshState(),
  getProxyAuth: () => proxyAuthFeature,
  timers: {
    setTimeout: (callback, delay) => window.setTimeout(callback, delay),
    clearTimeout: (handle) => window.clearTimeout(handle),
  },
});
window.routingManager.start({
  openTower: () => { show('dash'); setPage('tower'); },
});
window.certificateManager.start();
rendererFeatures.mount('browser-data-settings', {
  api: window.api, document, translate: (key) => t(key),
  onClearState: pending => campusDataFeature?.clearDisplay(pending),
});
browserNewTabSettings = rendererFeatures.mount('browser-new-tab-settings', {
  api: window.api, document, translate: (key) => t(key),
  getSettings: () => settings, setSettings: (next) => { settings = next; },
});
window.addEventListener('card-board-toast', (event) => {
  const { message, tone } = event.detail || {};
  if (message) usabilityFeature?.toast(message, tone);
});
addWebsiteFeature = window.addWebsiteDialog.start({ api: window.api, document, translate: (key, vars) => t(key, vars), getResources: () => campusResources, setResources: (resources) => { campusResources = resources; renderResources(); }, getGroups: () => resourceGroups, setGroups: (groups) => { resourceGroups = groups; renderResources(); }, toast: (message, tone) => usabilityFeature?.toast(message, tone) });
groupDialogFeature = window.categoryGroupDialog.start({
  api: window.api, document, translate: (key, vars) => t(key, vars),
  onChanged: (groups) => { const known = new Set(resourceGroups.map(({ id }) => id)); resourceGroups = groups; renderResources(); const created = groups.find(({ id }) => !known.has(id)); if (created) requestAnimationFrame(() => window.campusCategoryStacks.focusCard('user-collection', created.id)); },
  toast: (message, tone) => usabilityFeature?.toast(message, tone),
});
favoriteDialogFeature = rendererFeatures.mount('official-favorites', {
  api: window.api, document, translate: (key, vars) => t(key, vars), getResources: () => campusResources, getGroups: () => resourceGroups,
  setResources: (resources) => { campusResources = resources; renderResources(); }, setGroups: (groups) => { resourceGroups = groups; renderResources(); },
  onSaved: ({ groupId }) => { serviceWorkspace?.setTab('personal', { focus: false }); requestAnimationFrame(() => window.campusCategoryStacks.focusCard(groupId ? 'user-collection' : 'system-widget', groupId || 'ungrouped-favorites')); },
  toast: (message, tone) => usabilityFeature?.toast(message, tone),
});
serviceWorkspace = window.campusServiceWorkspace.create({
  document,
  translate: (key, vars) => t(key, vars),
  escapeHtml: esc,
  getServiceDesk: () => portalServiceDeskData || serviceDeskData,
  getPersonalCategories: () => window.campusCategoryStacks.personalCategoryProjection(campusResources, resourceGroups, t),
  openEntryUrl: (url) => openCampus(url),
  openDeepLink,
  isEntryFavorite: (entry) => favoriteDialogFeature.isFavorite(entry),
  onFavoriteEntry: (entry) => favoriteDialogFeature.open(entry),
  onCreateCategory: () => groupDialogFeature.open(),
  onToggleOrganize: () => window.campusCategoryStacks.toggleEdit(),
  focusPersonalCard: (groupId) => window.campusCategoryStacks.focusCard('user-collection', groupId),
});
serviceWorkspace.start();
campusDataFeature = rendererFeatures.mount('campus-data', {
  document,
  api: window.api,
  translate: (key, vars) => t(key, vars),
  escapeHtml: esc,
  openDeepLink,
  onCatalog: (catalog) => {
    if (catalog?.state !== 'ready') return;
    portalServiceDeskData = {
      schemaVersion: 1,
      applicationGroups: catalog.applicationGroups,
      applications: catalog.applications,
      serviceGroups: catalog.serviceGroups,
      serviceItems: catalog.serviceItems,
    };
    serviceWorkspace?.render();
  },
});
window.campusCategoryStacks.start({
  document,
  onAddSite: () => addWebsiteFeature.open(),
  onRenameCard: ({ card }) => { if (card?.id) groupDialogFeature.open({ id: card.id, name: card.name }); },
});
connectionOverviewFeature = rendererFeatures.mount('connection-overview', {
  document,
  translate: (key, vars) => t(key, vars),
  escapeHtml: esc,
  now: () => Date.now(),
  copy: (value) => window.api.copy(value),
  save: (patch) => window.api.save(patch),
  refresh: () => refreshState({ preserveTower: true }),
  getEnvironment: () => window.api.getNetworkEnvironment(),
  subscribeEnvironment: (callback) => window.api.onNetworkEnvironment?.(callback),
  timers: {
    setTimeout: (callback, delay) => window.setTimeout(callback, delay),
    clearTimeout: (handle) => window.clearTimeout(handle),
    setInterval: (callback, delay) => window.setInterval(callback, delay),
    clearInterval: (handle) => window.clearInterval(handle),
  },
});
usabilityFeature = window.usabilityController.create({ window, document, translate: (key) => t(key), openPage: setPage, clearResourceFilter: () => {
  if (window.campusCategoryStacks.isEditing()) { window.campusCategoryStacks.cancelEdit(); return; }
  serviceWorkspace?.clearSearch();
}, openResourceManager: () => { setPage('browser'); serviceWorkspace?.setTab('personal', { focus: false }); window.campusCategoryStacks.toggleEdit(); }, openCampusWorkspace: () => window.api.openCampusBrowser() }); usabilityFeature.start();
init();
