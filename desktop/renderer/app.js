import { createRendererFeatures } from './features/feature-host/index.mjs';
import { create as createOfficialFavorites } from './features/official-favorites/index.mjs';
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
let connectedAt = null;
let durTimer = null;
let campusActionBusy = false;
let campusResources = [], resourceGroups = [], serviceDeskData = null, portalServiceDeskData = null;
let serviceDeskProfileId = null;
let towerDirty = false;
let towerSaving = false;
let loginPending = false;
let usabilityFeature = null, serviceWorkspace = null, groupDialogFeature = null, favoriteDialogFeature = null, campusDataFeature = null;
let proxyAuthFeature = null, browserNewTabSettings = null;
let addWebsiteFeature = null;

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
  if (page === 'settings') runUpdateCheck(false);
  if (page === 'connect') window.connectionOverview.refreshEnvironment(st.loggedIn === true);
}
window.api.onOpenSettings?.(() => { show('dash'); setPage('settings'); refreshState(); });
function fmtDur(ms) { const s = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); }
function startDur() { stopDur(); durTimer = setInterval(() => { if (connectedAt) $('stDur').textContent = fmtDur(Date.now() - connectedAt); }, 1000); }
function stopDur() { if (durTimer) clearInterval(durTimer); durTimer = null; }

function dnsModeLabel(mode) {
  if (mode === 'gateway') return t('stats.dnsGateway');
  if (mode === 'vpn_profile') return t('stats.dnsVpnProfile');
  if (mode === 'gateway_profile') return t('stats.dnsGatewayProfile');
  if (mode === 'system_fallback') return t('stats.dnsFallback');
  if (mode === 'disabled') return t('stats.dnsDisabled');
  return t('stats.dnsUnknown');
}

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
  connectedAt = s.connected ? (s.connectedAt || connectedAt) : null;
  $('power').classList.toggle('on', s.connected);
  $('power').classList.toggle('busy', s.connecting);
  const powerText = t(s.connecting ? 'connect.actionConnecting' : s.connected ? 'connect.actionDisconnect' : 'connect.actionConnect');
  $('power').disabled = s.connecting; $('powerLabel').textContent = powerText; $('power').setAttribute('aria-label', powerText); $('power').setAttribute('aria-checked', String(s.connected));
  const wrap = document.querySelector('.conn-status');
  wrap.classList.toggle('on', s.connected); wrap.classList.toggle('busy', s.connecting);
  $('connStatus').textContent = s.connecting
    ? t('connect.connecting')
    : s.connected ? t('connect.connected') : t('connect.disconnected');
  $('connIp').textContent = s.connected && s.clientIp ? s.clientIp : '—';
  $('connTop').classList.toggle('connected', s.connected);
  $('connErr').textContent = (!s.connected && !s.connecting && s.lastError) ? s.lastError : '';
  $('settingsNotice').hidden = !s.notice;
  $('settingsNotice').textContent = s.notice || ''; window.notificationView.render({ card: $('notificationCard'), title: $('notificationTitle'), summary: $('notificationSummary'), action: $('notificationAction'), state: s, translate: t });
  window.connectionOverview.renderStatus(s, t);
  $('statGrid').hidden = false;
  $('appsCard').hidden = !s.connected;
  $('stIp').textContent = s.clientIp || '—';
  $('latencyMetric').classList.toggle('is-empty', !s.connected);
  $('latencyHint').hidden = s.connected || s.connecting;
  $('stDns').textContent = dnsModeLabel(s.dnsMode);
  if (s.connected && connectedAt) { startDur(); $('stDur').textContent = fmtDur(Date.now() - connectedAt); }
  else { stopDur(); $('stDur').textContent = '0:00'; $('stPing').textContent = '—'; $('stConn').textContent = '0'; $('appList').innerHTML = ''; }
  updateLoginProgress(s);
}

function renderTelemetry(tele) {
  window.connectionOverview.renderTelemetry(tele, t);
  if (tele.connectedAt) connectedAt = tele.connectedAt;
  const latencyAvailable = tele.latencyMs != null;
  $('stPing').textContent = latencyAvailable ? Math.round(tele.latencyMs) + ' ms' : '—';
  $('latencyMetric').classList.toggle('is-empty', !latencyAvailable);
  $('latencyHint').hidden = latencyAvailable;
  $('stConn').textContent = tele.connCount || 0;
  const list = $('appList');
  if (!tele.apps || !tele.apps.length) { list.innerHTML = `<div class="app-empty">${esc(t('stats.appsEmpty'))}</div>`; return; }
  list.innerHTML = tele.apps.map((a) =>
    `<div class="app-row"><span class="app-dot"></span><span class="app-name">${esc(a.name)}</span><span class="app-meta">${esc(t('stats.connectionCount', { count: a.count }))}</span></div>`).join('');
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

function populateTowerForm() {
  $('towerPort').value = settings.port || 1080;
  $('strictProxyAuth').checked = settings.strictProxyAuth === true;
  $('autoReconnect').checked = settings.autoReconnect !== false;
  $('maxAttempts').value = settings.maxAttempts ?? 3;
  $('startAtLogin').checked = !!settings.startAtLogin;
  $('autoConnect').checked = settings.autoConnect !== false;
  proxyAuthFeature?.render();
  if (!towerDirty && !$('towerSaved').textContent) $('towerActions').hidden = true;
}

function setTowerDirty(value) {
  towerDirty = value === true;
  if (towerDirty) $('towerActions').hidden = false;
  else if (!$('towerSaved').textContent) $('towerActions').hidden = true;
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
  $('socksEndpoint').textContent = '127.0.0.1:' + (Number(settings.port) || 1080);
  if (!preserveTower || !towerDirty) populateTowerForm();
  $('acct').textContent = settings.username || '—';
  $('ver').textContent = s.version ? `v${s.version}` : '—';
  if (s.update) renderUpdateResult(s.update);
  $('closeAction').value = ['ask', 'minimize', 'quit'].includes(settings.closeAction) ? settings.closeAction : 'ask';
  $('language').value = ['auto', 'zh', 'en'].includes(settings.language) ? settings.language : 'auto';
  browserNewTabSettings?.render(settings);
  if (document.querySelector('.page.active')?.dataset.page === 'connect') window.connectionOverview.refreshEnvironment(s.loggedIn === true);
  return s;
}

// update check (notify only — the app never downloads updates itself)
let updateHintTimer = null;
let updateDownloadUrl = '';
function setUpdateHint(html, { sticky = false } = {}) {
  const el = $('updateHint');
  if (updateHintTimer) { clearTimeout(updateHintTimer); updateHintTimer = null; }
  el.innerHTML = html || '';
  el.hidden = !html;
  if (html && !sticky) updateHintTimer = setTimeout(() => { el.hidden = true; }, 3500);
}
$('updateHint').addEventListener('click', (event) => {
  if (!event.target?.closest?.('#updateDownload') || !updateDownloadUrl) return;
  window.api.openExternal(updateDownloadUrl);
});
function renderUpdateResult(result, { manual = false } = {}) {
  if (result && result.updateAvailable) {
    updateDownloadUrl = String(result.url || '');
    setUpdateHint(
      t('settings.updateAvailable', {
        version: esc(result.latestVersion),
        button: t('settings.updateDownload'),
      }),
      { sticky: true },
    );
  } else if (manual) {
    updateDownloadUrl = '';
    setUpdateHint(result ? t('settings.updateLatest') : t('settings.updateFailed'));
  }
}
async function runUpdateCheck(manual) {
  try {
    renderUpdateResult(await window.api.checkUpdate(manual === true), { manual });
  } catch {
    if (manual) setUpdateHint(t('settings.updateFailed'));
  }
}

async function loadLogs() {
  const text = await window.api.getLogs();
  const box = $('logs');
  box.textContent = text && text.trim() ? text : t('notif.empty');
  box.scrollTop = box.scrollHeight;
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
// control tower
async function saveTower() {
  if (towerSaving || proxyAuthFeature?.isBusy()) return { ok: false, busy: true };
  const port = Number($('towerPort').value);
  const maxAttempts = Number($('maxAttempts').value);
  if (!Number.isInteger(port) || port < 1025 || port > 65535) {
    flashSaved(t('tower.portInvalid'), true);
    $('towerPort').focus();
    return { ok: false };
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 0 || maxAttempts > 10) {
    flashSaved(t('tower.attemptsInvalid'), true);
    $('maxAttempts').focus();
    return { ok: false };
  }

  towerSaving = true;
  $('towerSave').disabled = true;
  $('strictProxyAuth').disabled = true;
  try {
    const result = await window.api.save({
      port,
      strictProxyAuth: $('strictProxyAuth').checked,
      autoReconnect: $('autoReconnect').checked,
      maxAttempts,
      startAtLogin: $('startAtLogin').checked,
      autoConnect: $('autoConnect').checked,
    });
    if (!result?.ok) {
      flashSaved(result?.error || t('tower.saveFailed'), true);
      return result || { ok: false };
    }
    settings = result.settings || settings;
    setTowerDirty(false);
    await refreshState();
    return result;
  } catch (error) {
    flashSaved(error?.message || t('tower.saveFailed'), true);
    return { ok: false };
  } finally {
    towerSaving = false;
    $('towerSave').disabled = false;
    $('strictProxyAuth').disabled = false;
    proxyAuthFeature?.render();
  }
}
let flashTimer = null;
function flashSaved(msg, isError = false) {
  clearTimeout(flashTimer);
  $('towerActions').hidden = false;
  $('towerSaved').textContent = msg || t('tower.saved');
  $('towerSaved').classList.toggle('error', isError);
  flashTimer = setTimeout(() => {
    $('towerSaved').textContent = '';
    $('towerSaved').classList.remove('error');
    if (!towerDirty && !towerSaving) $('towerActions').hidden = true;
  }, isError ? 3500 : 1800);
}
$('towerSave').addEventListener('click', async () => {
  const result = await saveTower();
  if (result?.ok) {
    const reconnectWarning = result.outcome === 'saved_reconnect_failed'
      ? `${t('tower.saved')} · ${result.warning || ''}`.replace(/\s*·\s*$/u, '')
      : null;
    flashSaved(
      reconnectWarning || result.warning ||
        (result.reconnected ? t('tower.savedApplied') : t('tower.saved')),
      !!result.warning,
    );
  }
});
for (const id of [
  'towerPort', 'strictProxyAuth', 'autoReconnect', 'maxAttempts', 'startAtLogin', 'autoConnect',
]) {
  $(id).addEventListener('input', () => setTowerDirty(true));
  $(id).addEventListener('change', () => setTowerDirty(true));
}
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
  if (!document.hidden) refreshState({ preserveTower: true }).then(() => window.connectionOverview.refreshEnvironment(st.loggedIn === true));
});
window.addEventListener('focus', () => {
  if (document.querySelector('.page.active')?.dataset.page === 'browser') {
    void campusDataFeature?.ensureLoaded();
  }
});

// copy + tools
document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
  try {
    if (b.dataset.copy !== 'socks') throw new Error(t('tower.copyFailed'));
    const text = '127.0.0.1:' + (Number(settings.port) || 1080);
    await window.api.copy(text);
    const old = b.textContent;
    b.textContent = t('tower.copied');
    b.classList.add('done');
    setTimeout(() => { b.textContent = old; b.classList.remove('done'); }, 1200);
  } catch (error) {
    flashSaved(error?.message || t('tower.copyFailed'), true);
  }
}));
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
      flashSaved(message, true);
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
$('checkUpdateBtn').addEventListener('click', async () => {
  $('checkUpdateBtn').disabled = true;
  try { await runUpdateCheck(true); }
  finally { $('checkUpdateBtn').disabled = false; }
});

window.api.onStatus((s) => {
  renderConnect(s);
  if (s.update) renderUpdateResult(s.update);
});
window.api.onTelemetry(renderTelemetry);
proxyAuthFeature = window.proxyAuthMigration.createProxyAuthMigration({
  api: window.api,
  document,
  translate: (key, vars) => t(key, vars),
  getSettings: () => settings,
  setSettings: (next) => { settings = next; },
  isTowerBusy: () => towerSaving,
  flash: flashSaved,
});
proxyAuthFeature.start();
window.routingManager.start({
  openTower: () => { show('dash'); setPage('tower'); },
});
window.certificateManager.start(); window.browserDataSettings.start({ api: window.api, document, translate: (key) => t(key), onClearState: pending => campusDataFeature?.clearDisplay(pending) }); browserNewTabSettings = window.browserNewTabSettings.start({ api: window.api, document, translate: (key) => t(key), getSettings: () => settings, setSettings: (next) => { settings = next; } });
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
favoriteDialogFeature = createOfficialFavorites({
  api: window.api, document, translate: (key, vars) => t(key, vars), getResources: () => campusResources, getGroups: () => resourceGroups,
  setResources: (resources) => { campusResources = resources; renderResources(); }, setGroups: (groups) => { resourceGroups = groups; renderResources(); },
  onSaved: ({ groupId }) => { serviceWorkspace?.setTab('personal', { focus: false }); requestAnimationFrame(() => window.campusCategoryStacks.focusCard(groupId ? 'user-collection' : 'system-widget', groupId || 'ungrouped-favorites')); },
  toast: (message, tone) => usabilityFeature?.toast(message, tone),
});
favoriteDialogFeature.start();
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
}); window.connectionOverview.start({ translate: (key, vars) => t(key, vars), copy: (value) => window.api.copy(value), save: (patch) => window.api.save(patch), refresh: () => refreshState({ preserveTower: true }), getEnvironment: () => window.api.getNetworkEnvironment(), subscribeEnvironment: (callback) => window.api.onNetworkEnvironment?.(callback) }); window.notificationDrawer.start({ document, loadLogs, runAction: (action) => window.notificationView.runAction(action, { openPage: setPage, reconnect: () => (!st.connected && !st.connecting ? window.api.connect() : null) }) });
usabilityFeature = window.usabilityController.create({ window, document, translate: (key) => t(key), openPage: setPage, clearResourceFilter: () => {
  if (window.campusCategoryStacks.isEditing()) { window.campusCategoryStacks.cancelEdit(); return; }
  serviceWorkspace?.clearSearch();
}, openResourceManager: () => { setPage('browser'); serviceWorkspace?.setTab('personal', { focus: false }); window.campusCategoryStacks.toggleEdit(); }, openCampusWorkspace: () => window.api.openCampusBrowser() }); usabilityFeature.start();
init();
