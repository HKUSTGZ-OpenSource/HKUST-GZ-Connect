import { weekRange } from './calendar-model.mjs';
import { renderSchedule } from './calendar-view.mjs';

const MODULES = Object.freeze({
  schedule: { body: 'scheduleBody', sourceId: 'official-portal', sourceUrl: 'https://myportal.hkust-gz.edu.cn/' },
  loans: { body: 'loansBody', sourceId: 'library', sourceUrl: 'https://library.hkust-gz.edu.cn/' },
  news: { body: 'newsBody', sourceId: 'home', sourceUrl: 'https://www.hkust-gz.edu.cn/' },
});
const ACCEPTED_STATES = new Set([
  'not-authenticated', 'authenticating', 'loading', 'ready', 'empty', 'forbidden',
  'session-expired', 'source-unavailable', 'tunnel-required', 'failed',
]);
const SCHEDULE_AUTO_REFRESH_MS = 24 * 60 * 60 * 1_000;

export function create({ document: doc, api, translate, escapeHtml, openDeepLink, onCatalog = null } = {}) {
  if (!doc || !api || typeof translate !== 'function' || typeof escapeHtml !== 'function' ||
      typeof openDeepLink !== 'function') {
    throw new TypeError('campus data module dependencies are incomplete');
  }
  const $ = (id) => doc.getElementById(id);
  const publishCatalog = typeof onCatalog === 'function' ? onCatalog : () => {};
  let loaded = false;
  let inflight = null;
  let snapshot = null;
  let lastLoadedAt = 0;
  let scheduleRefreshTimer = null;
  const campusDate = value => new Date(value + 28_800_000).toISOString().slice(0, 10);
  let selectedDate = campusDate(Date.now());
  let followCurrentWeek = true;
  let scheduleRequest = 0;
  let visibleEvents = [];
  let miniature = false;
  let sizeObserver = null;
  const weekCache = new Map();
  let displayEpoch = 0;
  let clearing = false;
  let scheduleNotice = '';
  let lastScheduleAttempt = 0;
  let scheduleViewKey = null;
  let lastScheduleLayout = null;
  const weekKey = date => weekRange(Date.parse(`${date}T12:00:00+08:00`), true).start;
  const reusable = module => validModule(module) && ['ready', 'empty'].includes(module.state);
  const revoked = value => value?.sessionState === 'unauthenticated' ||
    ['not-authenticated', 'session-expired', 'forbidden'].includes(value?.modules?.schedule?.state);
  function revokeSchedule() {
    displayEpoch++; inflight = null;
    clearTimeout(scheduleRefreshTimer); scheduleRefreshTimer = null;
    weekCache.clear(); scheduleRequest++; lastScheduleLayout = null; scheduleNotice = '';
    setScheduleRefreshBusy(false);
  }
  function remember(date, module) {
    if (!reusable(module)) return;
    const key = weekKey(date);
    weekCache.delete(key);
    weekCache.set(key, module);
    if (weekCache.size > 12) weekCache.delete(weekCache.keys().next().value);
  }
  function clearDisplay(pending = false) {
    displayEpoch++; scheduleRequest++; clearing = pending;
    clearTimeout(scheduleRefreshTimer); scheduleRefreshTimer = null;
    weekCache.clear(); inflight = null; snapshot = null; loaded = false; visibleEvents = [];
    scheduleNotice = ''; scheduleViewKey = null; lastScheduleLayout = null; $('scheduleDetail')?.close?.();
    render(); setScheduleRefreshBusy(pending); publishCatalog(null);
  }

  const locale = () => String(doc.documentElement.lang || '').toLowerCase().startsWith('en')
    ? 'en' : 'zh-CN';
  const formatDate = (value) => new Intl.DateTimeFormat(locale(), {
    month: 'short', day: 'numeric',
  }).format(new Date(value));

  function validModule(module) {
    return module && typeof module === 'object' && ACCEPTED_STATES.has(module.state) &&
      Array.isArray(module.items);
  }

  function stateCopy(state, moduleId) {
    if (state === 'source-unavailable' &&
        snapshot?.modules?.[moduleId]?.source === 'myportal-session') {
      return ['workspace.portalSessionUnavailable', 'workspace.portalSessionUnavailableHint', 'retry'];
    }
    const common = {
      'not-authenticated': ['workspace.portalSignedOut', 'workspace.portalSignedOutHint', 'login'],
      authenticating: ['workspace.portalAuthenticating', 'workspace.portalAuthenticatingHint', null],
      loading: ['workspace.portalLoading', 'workspace.portalLoadingHint', null],
      forbidden: ['workspace.portalForbidden', 'workspace.portalForbiddenHint', 'source'],
      'session-expired': ['workspace.portalExpired', 'workspace.portalExpiredHint', 'login'],
      'source-unavailable': ['workspace.portalSourcePending', 'workspace.portalSourcePendingHint', 'source'],
      'tunnel-required': ['workspace.portalTunnelRequired', 'workspace.portalTunnelRequiredHint', 'source'],
      failed: ['workspace.portalFailed', 'workspace.portalFailedHint', 'retry'],
      empty: [`workspace.${moduleId}Empty`, `workspace.${moduleId}EmptyHint`, 'source'],
    };
    return common[state] || common['source-unavailable'];
  }

  function actionHtml(action, moduleId) {
    if (!action) return '';
    const key = action === 'login' ? 'workspace.portalLogin'
      : action === 'retry' ? 'workspace.portalRetry'
        : `workspace.${moduleId}Source`;
    return `<button class="module-link" type="button" data-campus-data-action="${action}" data-module-id="${moduleId}">${escapeHtml(translate(key))}</button>`;
  }

  function entryShell(entry, content, extraClass = '') {
    if (!entry.url) return `<div class="data-row${extraClass}">${content}</div>`;
    return `<button class="data-row${extraClass}" type="button" data-entry-url="${escapeHtml(entry.url)}">${content}</button>`;
  }

  function stateHtml(module, moduleId) {
    const [titleKey, hintKey, action] = stateCopy(module.state, moduleId);
    const stateClass = ['loading', 'authenticating'].includes(module.state) ? ' is-loading' : '';
    return `<div class="module-state${stateClass}">`
      + `<span class="module-state-mark" aria-hidden="true"></span>`
      + `<div class="module-state-copy"><p class="module-note">${escapeHtml(translate(titleKey))}</p>`
      + `<p class="module-hint">${escapeHtml(translate(hintKey))}</p>`
      + actionHtml(action, moduleId) + '</div></div>';
  }

  function scheduleHtml(module) {
    visibleEvents = [];
    return renderSchedule(module, { selectedDate, clockNow: () => Date.now(), miniature, locale,
      translate, escapeHtml, stateHtml, actionHtml, scheduleNotice, lastScheduleLayout,
      onLayout: geometry => { lastScheduleLayout = geometry; },
      onGroups: groups => { visibleEvents = groups; } });
  }

  function loansHtml(module) {
    if (module.state !== 'ready') return stateHtml(module, 'loans');
    const now = Date.now();
    const dueSoon = module.items.filter(({ dueAt }) => dueAt >= now && dueAt - now <= 3 * 86_400_000).length;
    return `<div class="data-summary"><strong>${escapeHtml(translate('workspace.loansSummary', { count: module.items.length }))}</strong>`
      + (dueSoon ? `<span>${escapeHtml(translate('workspace.loansDueSoon', { count: dueSoon }))}</span>` : '') + '</div>'
      + `<div class="data-list">${module.items.slice(0, 2).map((entry) => entryShell(entry,
        `<span><strong>${escapeHtml(entry.title)}</strong><small>${escapeHtml(translate('workspace.loanDue', { date: formatDate(entry.dueAt) }))}</small></span>`,
      )).join('')}</div>`
      + actionHtml('source', 'loans');
  }

  function newsHtml(module) {
    if (module.state !== 'ready') return stateHtml(module, 'news');
    return `<div class="data-list news-list">${module.items.slice(0, 3).map((entry) => entryShell(entry,
      `<span class="news-unread${entry.unread ? ' is-unread' : ''}" aria-label="${escapeHtml(entry.unread ? translate('workspace.newsUnread') : '')}"></span>`
      + `<span><strong>${escapeHtml(entry.title)}</strong></span><time>${escapeHtml(formatDate(entry.publishedAt))}</time>`,
    )).join('')}</div>`
      + actionHtml('source', 'news');
  }

  function renderModule(moduleId, module) {
    const config = MODULES[moduleId];
    const body = $(config.body);
    const shell = body?.closest('.module');
    if (!body || !shell) return;
    const safe = validModule(module) ? module : { state: 'source-unavailable', items: [] };
    shell.dataset.state = safe.state;
    if (moduleId === 'schedule') {
      const width = body.clientWidth || Math.max(1, (doc.defaultView?.innerWidth || 960) - 128);
      miniature = width < 620;
      shell.dataset.weekSize = miniature ? 'mini' : 'full';
      const key = JSON.stringify([selectedDate, miniature, locale(), safe.state, safe.source, safe.items, scheduleNotice]);
      if (key === scheduleViewKey) return;
      scheduleViewKey = key;
    }
    const focus = doc.activeElement;
    const restoreFocus = focus?.id === 'scheduleDate' ? '#scheduleDate'
      : focus?.dataset?.weekMove ? `[data-week-move="${focus.dataset.weekMove}"]`
        : focus?.hasAttribute?.('data-week-today') ? '[data-week-today]' : null;
    body.innerHTML = moduleId === 'schedule' ? scheduleHtml(safe)
      : moduleId === 'loans' ? loansHtml(safe) : newsHtml(safe);
    if (moduleId === 'schedule') {
      const grid = body.querySelector?.('.week-body');
      if (grid) {
        const rowHeight = Number(grid.dataset.height) / Number(grid.dataset.slotCount);
        grid.style.gridTemplateRows = `repeat(${grid.dataset.slotCount}, ${rowHeight}px)`;
        grid.style.backgroundSize = `100% ${rowHeight}px`;
      }
      for (const event of body.querySelectorAll?.('.week-event') || []) {
        event.style.top = `${Number(event.dataset.offset) + 2}px`;
        event.style.height = `${Number(event.dataset.height)}px`;
      }
      if (restoreFocus) body.querySelector?.(restoreFocus)?.focus({ preventScroll: true });
    }
  }

  function render() {
    for (const moduleId of Object.keys(MODULES)) {
      const module = snapshot?.modules?.[moduleId] || {
        state: loaded ? 'source-unavailable' : 'loading', items: [],
      };
      renderModule(moduleId, module);
    }
  }

  function setScheduleRefreshBusy(busy) {
    const button = $('scheduleRefresh');
    if (!button) return;
    button.disabled = busy;
    button.textContent = translate(busy
      ? 'workspace.scheduleRefreshing' : 'workspace.scheduleRefresh');
  }

  function scheduleNextRefresh() {
    if (scheduleRefreshTimer !== null) clearTimeout(scheduleRefreshTimer);
    scheduleRefreshTimer = null;
    if (!loaded || snapshot?.sessionState !== 'authenticated' || revoked(snapshot)) return;
    const fetchedAt = Math.max(snapshot?.modules?.schedule?.fetchedAt || lastLoadedAt || Date.now(), lastScheduleAttempt);
    const delay = Math.max(1_000, SCHEDULE_AUTO_REFRESH_MS - (Date.now() - fetchedAt));
    scheduleRefreshTimer = setTimeout(() => {
      scheduleRefreshTimer = null;
      void refreshSchedule();
    }, delay);
    scheduleRefreshTimer.unref?.();
  }

  async function load(force = false) {
    if (clearing) return null;
    if (inflight) return inflight;
    if (force) { displayEpoch++; scheduleRequest++; }
    const epoch = displayEpoch;
    const previous = snapshot;
    const method = force ? api.refreshCampusData : api.getCampusData;
    if (typeof method !== 'function') {
      loaded = true;
      render();
      return null;
    }
    snapshot ||= { modules: Object.fromEntries(Object.keys(MODULES).map((id) => [id, {
      state: 'loading', items: [],
    }])) };
    setScheduleRefreshBusy(true);
    render();
    inflight = Promise.resolve(method.call(api)).then((value) => {
      if (epoch !== displayEpoch) return null;
      snapshot = value;
      const denied = revoked(value);
      if (denied) revokeSchedule();
      loaded = true;
      lastLoadedAt = Date.now();
      publishCatalog(value?.catalog || null);
      if (!denied) remember(campusDate(value?.checkedAt || Date.now()), value?.modules?.schedule);
      if (!denied && weekRange(Date.parse(`${selectedDate}T12:00:00+08:00`), true).start !== weekRange(Date.now(), true).start &&
          typeof api.getCampusScheduleWeek === 'function') {
        snapshot = { ...value, modules: { ...value.modules, schedule: weekCache.get(weekKey(selectedDate)) || { state: 'loading', items: [] } } };
        queueMicrotask(() => { void refreshSchedule(false); });
      }
      render();
      return value;
    }).catch(() => {
      if (epoch !== displayEpoch) return null;
      snapshot = previous || { modules: Object.fromEntries(Object.keys(MODULES).map((id) => [id, {
        state: 'failed', items: [],
      }])) };
      loaded = true;
      lastLoadedAt = Date.now();
      render();
      return null;
    }).finally(() => {
      if (epoch !== displayEpoch) return;
      inflight = null;
      setScheduleRefreshBusy(false);
      scheduleNextRefresh();
    });
    return inflight;
  }

  async function refreshSchedule(force = true) {
    if (clearing) return null;
    const epoch = displayEpoch;
    if (followCurrentWeek) selectedDate = campusDate(Date.now());
    const date = selectedDate;
    const request = ++scheduleRequest;
    if (inflight) await inflight;
    if (request !== scheduleRequest || clearing) return null;
    if (typeof api.refreshCampusSchedule !== 'function') return load(true);
    const previous = snapshot;
    const cached = weekCache.get(weekKey(date));
    scheduleNotice = '';
    snapshot = {
      ...(previous || {}),
      modules: {
        ...(previous?.modules || {}),
        schedule: cached || { state: 'loading', source: 'myportal-calendar', items: [] },
      },
    };
    const age = Date.now() - cached?.fetchedAt;
    renderModule('schedule', snapshot.modules.schedule);
    if (!force && cached && age >= 0 && age < SCHEDULE_AUTO_REFRESH_MS) {
      setScheduleRefreshBusy(false); scheduleNextRefresh(); return snapshot;
    }
    setScheduleRefreshBusy(true);
    lastScheduleAttempt = Date.now();
    const operation = Promise.resolve().then(() => {
      if (request !== scheduleRequest) return null;
      return typeof api.getCampusScheduleWeek === 'function'
        ? api.getCampusScheduleWeek({ date, force }) : api.refreshCampusSchedule();
    }).then((value) => {
      if (epoch !== displayEpoch) return null;
      const module = value?.modules?.schedule;
      const denied = revoked(value);
      if (request !== scheduleRequest && !denied) return null;
      if (denied) revokeSchedule();
      if (!reusable(module) && !denied && cached) {
        scheduleNotice = 'workspace.scheduleRefreshFailed';
        snapshot = { ...value, modules: { ...value?.modules, schedule: cached } };
      } else {
        if (!denied) remember(date, module);
        snapshot = { ...previous, ...value, modules: { ...previous?.modules, ...value?.modules } };
      }
      loaded = true;
      lastLoadedAt = Date.now();
      render();
      return value;
    }).catch(() => {
      if (request !== scheduleRequest) return null;
      scheduleNotice = cached ? 'workspace.scheduleRefreshFailed' : '';
      snapshot = {
        ...(previous || {}),
        modules: {
          ...(previous?.modules || {}),
          schedule: cached || { state: 'failed', source: 'myportal-calendar', items: [] },
        },
      };
      loaded = true;
      lastLoadedAt = Date.now();
      render();
      return null;
    }).finally(() => {
      if (request === scheduleRequest) { setScheduleRefreshBusy(false); scheduleNextRefresh(); }
    });
    return operation;
  }

  function activate(target) {
    const weekMove = target.closest('[data-week-move]');
    const today = target.closest('[data-week-today]');
    if (weekMove || today) {
      const timestamp = today ? Date.now() : Date.parse(`${selectedDate}T12:00:00+08:00`) + Number(weekMove.dataset.weekMove) * 7 * 86_400_000;
      const date = campusDate(timestamp);
      if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(date) && date >= '0001-01-01') {
        followCurrentWeek = Boolean(today); selectedDate = date; void refreshSchedule(false);
      }
      return;
    }
    if (target.closest('[data-schedule-close]')) { $('scheduleDetail')?.close(); return; }
    const card = target.closest('[data-schedule-index]');
    if (card) {
      const group = visibleEvents[Number(card.dataset.scheduleIndex)];
      const dialog = $('scheduleDetail');
      if (group && dialog) {
        const date = value => new Intl.DateTimeFormat(locale(), { timeZone: 'Asia/Shanghai',
          dateStyle: 'medium', timeStyle: 'short', hour12: false }).format(value);
        dialog.setAttribute('aria-labelledby', 'scheduleDetailTitle');
        dialog.innerHTML = `<h3 id="scheduleDetailTitle">${escapeHtml(translate('workspace.scheduleDetails'))}</h3>`
          + group.members.map(({ entry }) => `<article class="week-detail-item"><h4>${escapeHtml(entry.title)}</h4><p>${escapeHtml(date(entry.startsAt))} – ${escapeHtml(date(entry.endsAt))}</p>`
            + (entry.location ? `<p>${escapeHtml(entry.location)}</p>` : '')
            + (entry.url ? `<button type="button" data-entry-url="${escapeHtml(entry.url)}">${escapeHtml(translate('workspace.scheduleSource'))}</button>` : '') + '</article>').join('')
          + `<button type="button" data-schedule-close>${escapeHtml(translate('workspace.scheduleClose'))}</button>`;
        dialog.showModal();
      }
      return;
    }
    const entryUrl = target.closest('[data-entry-url]')?.dataset.entryUrl;
    if (entryUrl) { openDeepLink(null, entryUrl); return; }
    const action = target.closest('[data-campus-data-action]');
    if (!action) return;
    const moduleId = action.dataset.moduleId;
    if (action.dataset.campusDataAction === 'retry') {
      void (moduleId === 'schedule' ? refreshSchedule() : load(true));
      return;
    }
    if (action.dataset.campusDataAction === 'login') {
      openDeepLink('official-portal', 'https://myportal.hkust-gz.edu.cn/');
      return;
    }
    const config = MODULES[moduleId];
    if (config) openDeepLink(config.sourceId, config.sourceUrl);
  }

  function start() {
    for (const { body } of Object.values(MODULES)) {
      $(body)?.closest('.module')?.addEventListener('click', (event) => activate(event.target));
    }
    $('scheduleRefresh')?.addEventListener('click', () => { void refreshSchedule(); });
    $('scheduleBody')?.addEventListener('change', (event) => {
      if (event.target.id !== 'scheduleDate' || !event.target.value || !event.target.validity.valid) return;
      followCurrentWeek = false; selectedDate = event.target.value; void refreshSchedule(false);
    });
    doc.addEventListener('app-locale-changed', render);
    const Observer = doc.defaultView?.ResizeObserver;
    if (Observer && !sizeObserver && $('scheduleBody')) {
      sizeObserver = new Observer(entries => {
        const width = entries[0]?.contentRect?.width;
        if (width > 0 && (width < 620) !== miniature) renderModule('schedule', snapshot?.modules?.schedule);
      });
      sizeObserver.observe($('scheduleBody'));
      doc.defaultView.addEventListener('pagehide', () => sizeObserver?.disconnect(), { once: true });
    }
    render();
    return true;
  }

  function ensureLoaded() {
    if (clearing) return Promise.resolve(null);
    if (!loaded) return load(false);
    if (followCurrentWeek && weekRange(Date.parse(`${selectedDate}T12:00:00+08:00`), true).start !==
        weekRange(Date.now(), true).start) return refreshSchedule(false);
    const scheduleState = snapshot?.modules?.schedule?.state;
    const sessionRecovery = snapshot?.sessionState !== 'authenticated' ||
      ['not-authenticated', 'session-expired'].includes(scheduleState);
    if (sessionRecovery) return load(true);
    const fetchedAt = snapshot?.modules?.schedule?.fetchedAt || lastLoadedAt;
    if (Date.now() - fetchedAt >= SCHEDULE_AUTO_REFRESH_MS) return refreshSchedule();
    scheduleNextRefresh();
    return Promise.resolve(snapshot);
  }

  return Object.freeze({
    clearDisplay,
    ensureLoaded,
    load,
    refreshSchedule,
    render,
    snapshot: () => snapshot,
    start,
  });
}
