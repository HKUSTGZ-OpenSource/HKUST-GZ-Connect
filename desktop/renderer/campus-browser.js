'use strict';

// The main process passes the resolved UI locale as ?lang= on loadFile, and
// can switch it live later through campusBrowserUI.setLocale.
let locale = 'zh';
let t = window.I18N.createT(locale, window.navigator?.platform || '');
const launchQuery = new URLSearchParams(location.search);
const rawProfileName = launchQuery.get('school') || '';
const profileName = rawProfileName && rawProfileName.length <= 160 &&
  !/[\u0000-\u001f\u007f<>]/u.test(rawProfileName)
  ? rawProfileName : '';
const profileUnverified = launchQuery.get('unverified') === '1';

function browserTitle(pageTitle = '') {
  const context = profileName || t('browser.workspace');
  const trust = profileUnverified ? ` · ${t('school.unverified')}` : '';
  if (!pageTitle) return `${context}${trust} · ${t('browser.title')}`;
  return pageTitle.includes(context) ? `${pageTitle}${trust}` : `${pageTitle} · ${context}${trust}`;
}

function applyLang(lang) {
  locale = window.I18N.resolveLocale(lang);
  t = window.I18N.createT(locale, window.navigator?.platform || '');
  document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
  window.I18N.applyStatic(t, document);
  document.title = browserTitle();
  const profile = document.getElementById('browserProfileName');
  if (profile) profile.textContent = profileName || t('browser.workspace');
}

applyLang(launchQuery.get('lang'));

if (/Macintosh|Mac OS X/.test(navigator.userAgent)) {
  document.documentElement.classList.add('macos');
} else if (/Windows/.test(navigator.userAgent)) {
  document.documentElement.classList.add('windows');
}

const address = document.getElementById('address');
const back = document.getElementById('back');
const forward = document.getElementById('forward');
const reload = document.getElementById('reload');
const state = document.getElementById('state');
const tabs = document.getElementById('tabs');
const routeSelector = document.getElementById('routeSelector');
const routeAutoOption = document.getElementById('routeAutoOption');
const routeBadge = document.getElementById('routeBadge');
const findBar = document.getElementById('findBar');
const findInput = document.getElementById('findInput');
const downloadStatus = document.getElementById('downloadStatus');
const browserSettings = document.getElementById('browserSettings');
const favoritePage = document.getElementById('favoritePage');
const credential = document.getElementById('credential');
const bookmarkBar = document.getElementById('bookmarkBar');
const bookmarkItems = document.getElementById('bookmarkItems');
const bookmarkMoreWrap = document.getElementById('bookmarkMoreWrap');
const bookmarkMore = document.getElementById('bookmarkMore');
const manageBookmarks = document.getElementById('manageBookmarks');
const loadingBanner = document.getElementById('loadingBanner');
const loadingBannerName = document.getElementById('loadingBannerName');
const loadingBannerRoute = document.getElementById('loadingBannerRoute');
let lastBookmarks = [];
let bookmarkLayoutFrame = null;
document.getElementById('browserProfileName').textContent = profileName || t('browser.workspace');
document.getElementById('browserProfileTrust').hidden = !profileUnverified;

function command(name, value = '') {
  return window.campusToolbar?.command(name, value) === true;
}

back.addEventListener('click', () => command('back'));
forward.addEventListener('click', () => command('forward'));
reload.addEventListener('click', () => command('reload'));
document.getElementById('home').addEventListener('click', () => command('home'));
document.getElementById('credential').addEventListener(
  'click',
  () => command('manage-credential'),
);
document.getElementById('newTab').addEventListener('click', () => command('new-tab'));
document.getElementById('addressForm').addEventListener('submit', (event) => {
  event.preventDefault();
  command('navigate', address.value);
});
routeSelector.addEventListener('change', () => command('set-route', routeSelector.value));
browserSettings.addEventListener(
  'click',
  () => command('open-settings'),
);
favoritePage.addEventListener('click', () => command('toggle-favorite'));
manageBookmarks.addEventListener('click', () => command('manage-bookmarks'));
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    command('focus-workspace');
  }
});

findInput.addEventListener('input', () => command('find', findInput.value));
findInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    command(event.shiftKey ? 'find-prev' : 'find-next');
  } else if (event.key === 'Escape') {
    event.preventDefault();
    command('find-close');
  }
});
document.getElementById('findPrev').addEventListener('click', () => command('find-prev'));
document.getElementById('findNext').addEventListener('click', () => command('find-next'));
document.getElementById('findClose').addEventListener('click', () => command('find-close'));

function renderTabs(items, activeTabId) {
  const previousScroll = tabs.scrollLeft;
  const fragment = document.createDocumentFragment();
  for (const item of items || []) {
    const tab = document.createElement('button');
    tab.className = `tab${item.id === activeTabId ? ' active' : ''}`;
    tab.type = 'button';
    tab.dataset.tabId = String(item.id);
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(item.id === activeTabId));
    tab.title = item.title || t('browser.newTabFallback');

    if (item.loading) {
      const loading = document.createElement('span');
      loading.className = 'tab-loading';
      loading.setAttribute('aria-hidden', 'true');
      tab.appendChild(loading);
    }

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = item.title || t('browser.newTabFallback');
    tab.appendChild(title);

    const close = document.createElement('span');
    close.className = 'tab-close';
    close.dataset.closeTabId = String(item.id);
    close.title = t('browser.closeTab');
    close.setAttribute('aria-label', t('browser.closeTab'));
    close.textContent = '×';
    tab.appendChild(close);
    fragment.appendChild(tab);
  }
  tabs.replaceChildren(fragment);
  tabs.scrollLeft = previousScroll;
  tabs.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

tabs.addEventListener('click', (event) => {
  const close = event.target.closest('[data-close-tab-id]');
  if (close) {
    command('close-tab', close.dataset.closeTabId);
    return;
  }
  const tab = event.target.closest('[data-tab-id]');
  if (tab) command('switch-tab', tab.dataset.tabId);
});

function bookmarkButton(entry) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `bookmark-entry${entry.official ? ' official' : ''}`;
  button.dataset.bookmarkId = entry.id;
  button.title = entry.name;
  const label = document.createElement('span'); label.textContent = entry.name;
  button.appendChild(label);
  button.addEventListener('click', () => {
    command('open-resource', entry.id);
  });
  return button;
}

function bookmarkFolder(entry) {
  const folder = document.createElement('div'); folder.className = 'bookmark-folder';
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'bookmark-control';
  button.title = entry.name;
  button.setAttribute('aria-label', `${t('browser.bookmarkFolder')}：${entry.name}`);
  const label = document.createElement('span'); label.textContent = entry.name; button.appendChild(label);
  button.addEventListener('click', () => command('open-bookmark-folder', entry.id));
  folder.appendChild(button);
  return folder;
}

function normalizedBookmarks(value) {
  if (!Array.isArray(value) || value.length > 64) return [];
  const ids = new Set();
  const text = (input, max) => typeof input === 'string' && input.trim() &&
    input.length <= max && !/[\u0000-\u001f\u007f<>]/u.test(input) ? input.trim() : null;
  const resource = (entry) => {
    const id = text(entry?.id, 40); const name = text(entry?.name, 80);
    if (!id || !/^[a-z0-9-]+$/u.test(id) || !name || ids.has(id)) return null;
    ids.add(id);
    return Object.freeze({ type: 'bookmark', id, name, official: entry.official === true });
  };
  const result = [];
  for (const entry of value) {
    if (entry?.type === 'bookmark') {
      const item = resource(entry); if (item) result.push(item);
    } else if (entry?.type === 'folder' && Array.isArray(entry.children) && entry.children.length <= 64) {
      const id = text(entry.id, 70); const name = text(entry.name, 30);
      if (!id || !/^group_[a-z0-9_-]{12,64}$/u.test(id) || !name) continue;
      const children = entry.children.map(resource).filter(Boolean);
      if (children.length) result.push(Object.freeze({ type: 'folder', id, name, children }));
    }
  }
  return result;
}

function layoutBookmarkOverflow() {
  bookmarkLayoutFrame = null;
  const nodes = [...bookmarkItems.children];
  nodes.forEach((node) => { node.hidden = false; });
  bookmarkMoreWrap.hidden = true;
  const available = bookmarkItems.clientWidth;
  const total = nodes.reduce((sum, node) => sum + node.getBoundingClientRect().width + 2, 0);
  if (total <= available) return;
  let used = 0;
  let split = nodes.length;
  const limit = Math.max(40, available - 36);
  for (let index = 0; index < nodes.length; index += 1) {
    const width = nodes[index].getBoundingClientRect().width + 2;
    if (used + width > limit) { split = index; break; }
    used += width;
  }
  nodes.slice(split).forEach((node) => { node.hidden = true; });
  bookmarkMoreWrap.hidden = split >= lastBookmarks.length;
}

function scheduleBookmarkLayout() {
  if (bookmarkLayoutFrame !== null) cancelAnimationFrame(bookmarkLayoutFrame);
  bookmarkLayoutFrame = requestAnimationFrame(layoutBookmarkOverflow);
}

function renderBookmarks(value) {
  lastBookmarks = normalizedBookmarks(value);
  bookmarkItems.replaceChildren(...lastBookmarks.map((entry) => (
    entry.type === 'folder' ? bookmarkFolder(entry) : bookmarkButton(entry)
  )));
  scheduleBookmarkLayout();
}

bookmarkMore.addEventListener('click', () => command('open-bookmark-menu'));
new ResizeObserver(scheduleBookmarkLayout).observe(bookmarkBar);

window.campusBrowserUI = {
  setLocale(lang) {
    applyLang(lang);
    renderBookmarks(lastBookmarks);
  },
  setState(next) {
    renderTabs(next.tabs, next.activeTabId);
    renderBookmarks(next.bookmarks);
    if (document.activeElement !== address) address.value = next.workspace ? '' : (next.url || '');
    back.disabled = !next.canGoBack;
    forward.disabled = !next.canGoForward;
    const fixed = next.routeSource === 'user-exact';
    routeSelector.value = fixed ? (next.route === 'direct' ? 'direct' : 'campus') : 'auto';
    routeAutoOption.textContent = t(next.route === 'direct'
      ? 'browser.routeFollowDirect' : 'browser.routeFollowCampus');
    routeSelector.disabled = next.workspace === true;
    credential.disabled = next.workspace === true;
    routeSelector.hidden = next.workspace === true;
    routeBadge.hidden = next.workspace !== true;
    credential.hidden = next.workspace === true;
    favoritePage.hidden = next.workspace === true;
    favoritePage.disabled = next.workspace === true || next.canFavorite !== true;
    favoritePage.classList.toggle('active', next.favorite === true);
    favoritePage.title = t(next.favorite ? 'browser.unfavoritePage' : 'browser.favoritePage');
    favoritePage.setAttribute('aria-label', favoritePage.title);
    routeBadge.textContent = next.workspace ? t('browser.badgeAutomatic')
      : next.route === 'direct' ? t('browser.badgeDirect') : t('browser.badgeCampus');
    routeBadge.title = next.workspace ? t('browser.workspace')
      : next.route === 'direct' ? t('browser.viaDirect') : t('browser.viaCampus');
    state.textContent = next.loading
      ? (next.slow ? t('browser.loadingSlow') : t('browser.loading'))
      : (next.routeLabel || t('browser.routeCampus'));
    state.classList.toggle('loading', !!next.loading);
    loadingBanner.hidden = !next.loading;
    loadingBannerName.textContent = next.loadingLabel || t('browser.loadingSite');
    loadingBannerRoute.textContent = t(next.route === 'direct'
      ? 'browser.loadingViaDirect' : 'browser.loadingViaCampus');
    const download = next.download && typeof next.download === 'object' ? next.download : null;
    downloadStatus.hidden = !download;
    downloadStatus.className = `download-status${download?.status ? ` ${download.status}` : ''}`;
    downloadStatus.textContent = download
      ? t(`browser.download.${download.status}`, {
        filename: download.filename || '',
        percent: Number.isInteger(download.percent) ? download.percent : '…',
      }) : '';
    findBar.hidden = !next.findOpen;
    document.title = browserTitle(next.title || '');
  },
  focusAddress() {
    address.focus();
    address.select();
  },
  focusFind() {
    findInput.focus();
    findInput.select();
  },
};

window.campusToolbar?.onState((next) => window.campusBrowserUI.setState(next || {}));
window.campusToolbar?.onLocale((lang) => window.campusBrowserUI.setLocale(lang));
window.campusToolbar?.onFocus((target) => {
  if (target === 'find') window.campusBrowserUI.focusFind();
  else if (target === 'address') window.campusBrowserUI.focusAddress();
});
