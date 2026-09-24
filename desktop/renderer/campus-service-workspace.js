(function initializeCampusServiceWorkspace(root, factory) {
  const api = factory(
    typeof module !== 'undefined' && module.exports ? require('./campus-search-presenter') : root.campusSearchPresenter,
    typeof module !== 'undefined' && module.exports ? require('./components/card-board/card-board-motion') : root.cardBoardMotion,
  );
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.campusServiceWorkspace = api;
})(typeof self !== 'undefined' ? self : globalThis, function campusServiceWorkspaceFactory(searchPresenter, motion) {
  'use strict';

  if (!searchPresenter?.scoreEntry || !searchPresenter?.highlight) {
    throw new TypeError('campus service workspace search dependencies are required');
  }

  // §5: the tab state is private to the sites-and-services module; the
  // schedule/loans/news modules are never rebuilt on a switch.
  const APP_GROUPS = ['collab', 'teach', 'life', 'ai'];
  const DESK_GROUPS = ['academic', 'research', 'life'];
  const APP_GROUP_KEYS = { collab: 'workspace.groupCollab', teach: 'workspace.groupTeach', life: 'workspace.groupLife', ai: 'workspace.groupAi' };
  const DESK_GROUP_KEYS = { academic: 'workspace.groupAcademic', research: 'workspace.groupResearch', life: 'workspace.groupLife' };
  const DESK_PAGE_SIZE = 6;
  const APPS_PAGE_SIZE = 12;
  const SEARCH_RESULT_LIMIT = 10;

  function create({
    document: doc,
    translate,
    escapeHtml,
    getServiceDesk,
    getPersonalCategories,
    openEntryUrl,
    openDeepLink,
    isEntryFavorite,
    onFavoriteEntry,
    onCreateCategory,
    onToggleOrganize,
    focusPersonalCard,
  } = {}) {
    for (const dependency of [translate, escapeHtml, getServiceDesk, getPersonalCategories,
      openEntryUrl, openDeepLink, isEntryFavorite, onFavoriteEntry, onCreateCategory,
      onToggleOrganize, focusPersonalCard]) {
      if (typeof dependency !== 'function') {
        throw new TypeError('campus service workspace dependencies are incomplete');
      }
    }
    if (!doc) throw new TypeError('campus service workspace document is incomplete');
    const $ = (id) => doc.getElementById(id);
    const view = $('serviceOfficialView');
    const personalView = $('servicePersonalView');
    const searchView = $('serviceSearchView');
    const input = $('resourceSearch');

    let tab = 'official';
    let searching = false;
    let savedScrollTop = 0;
    let appsFilter = 'all';
    let deskFilter = 'all';
    let appsPage = 0;
    let deskPage = 0;
    let officialFront = 'apps';
    let expandedRegion = null;
    let expandedFilter = 'all';
    let started = false;

    const english = () => String(doc.documentElement.lang || '').toLowerCase().startsWith('en');
    const localized = (entry, field) => {
      const bag = entry?.[`localized${field}`];
      const plainField = `${field.charAt(0).toLowerCase()}${field.slice(1)}`;
      return (english() ? bag?.en : bag?.zh) || entry?.[plainField] || entry?.[field] || '';
    };
    const isReduced = () => doc.defaultView
      ?.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

    /* ---------------- official service desk (§6/§7, option A) ---------------- */

    function favoriteButtonHtml(entry) {
      const favorite = isEntryFavorite(entry) === true;
      const label = translate(favorite
        ? 'workspace.favoriteManage' : 'workspace.favoriteToCategory');
      return `<button class="orow-favorite${favorite ? ' active' : ''}" type="button"`
        + ` data-favorite-entry="${escapeHtml(entry.id)}" aria-pressed="${favorite}"`
        + ` aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${favorite ? '★' : '☆'}</button>`;
    }

    function rowHtml(entry) {
      const name = localized(entry, 'Name');
      const useCase = localized(entry, 'UseCase');
      return `<div class="orow" data-entry-id="${escapeHtml(entry.id)}">`
        + `<button class="orow-open" type="button" data-entry-open="${escapeHtml(entry.id)}"`
        + ` aria-label="${escapeHtml(`${name}，${useCase}`)}">`
        + `<span class="orow-icon" aria-hidden="true">${escapeHtml(name.slice(0, 2))}</span>`
        + `<span class="orow-main"><span class="orow-name">${escapeHtml(name)}</span>`
        + `<span class="orow-sub">${escapeHtml(useCase)}</span></span></button>`
        + favoriteButtonHtml(entry)
        + '</div>';
    }

    function entryById(entryId) {
      const desk = getServiceDesk();
      return [...(desk?.applications || []), ...(desk?.serviceItems || [])]
        .find((candidate) => candidate.id === entryId) || null;
    }

    function fallbackGroups(groups, keyMap) {
      return groups.map((id) => ({ id, name: translate(keyMap[id]) }));
    }

    function renderChips(el, groups, active) {
      const defs = [['all', translate('workspace.groupAll')],
        ...groups.map((group) => [group.id, group.name])];
      el.replaceChildren(...defs.map(([key, label]) => {
        const chip = doc.createElement('button');
        chip.type = 'button';
        chip.className = 'chip';
        chip.textContent = label;
        chip.dataset.group = key;
        chip.setAttribute('aria-pressed', String(key === active));
        return chip;
      }));
    }

    function renderPager(element, total, page, pageSize) {
      const pageCount = Math.ceil(total / pageSize);
      element.hidden = pageCount <= 1;
      element.replaceChildren(...Array.from({ length: pageCount }, (_, index) => {
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'portal-page';
        button.dataset.pageIndex = String(index);
        button.setAttribute('aria-label', translate('workspace.page', {
          page: index + 1, count: pageCount,
        }));
        if (index === page) button.setAttribute('aria-current', 'page');
        return button;
      }));
    }

    function mainCardHtml({ region, title, count, shown, apps = false }) {
      const front = officialFront === region;
      const body = `<div class="official-main-card-body"><div class="chips" id="${region}Chips" role="group"></div>`
        + `<div class="orow-list${apps ? ' orow-list-apps' : ' orow-list-desk'}" id="${region}List">`
        + (shown.length ? shown.map(rowHtml).join('')
          : `<div class="olist-empty">${escapeHtml(translate('workspace.emptyList'))}</div>`)
        + `</div><div class="portal-pager" id="${region}Pager" role="navigation"`
        + ` aria-label="${escapeHtml(translate(apps ? 'workspace.appsPagination' : 'workspace.deskPagination'))}" hidden></div></div>`;
      return `<article class="official-main-card${front ? ' is-front' : ' is-back'}" data-official-region="${region}">`
        + `<header class="official-main-card-head"><button class="official-main-tab" type="button" role="tab"`
        + ` aria-selected="${front}" data-official-main-action="${region}"><span>${escapeHtml(title)}</span>`
        + `<small>${count}</small></button>`
        + `<button class="ocard-more" type="button" data-official-more="${region}">${escapeHtml(translate('workspace.more'))}</button>`
        + `</header>${body}</article>`;
    }

    function drawOfficialCard(region) {
      const next = region === 'desk' ? 'desk' : 'apps';
      if (next === officialFront) return;
      officialFront = next;
      renderOfficial();
      const deck = $('officialMainDeck');
      void motion.animateSwitch(deck, { front: deck.querySelector('.is-front'), back: deck.querySelector('.is-back') });
    }

    function renderOfficial() {
      const desk = getServiceDesk();
      const apps = Array.isArray(desk?.applications) ? desk.applications : [];
      const items = Array.isArray(desk?.serviceItems) ? desk.serviceItems : [];
      const appGroups = Array.isArray(desk?.applicationGroups)
        ? desk.applicationGroups : fallbackGroups(APP_GROUPS, APP_GROUP_KEYS);
      const serviceGroups = Array.isArray(desk?.serviceGroups)
        ? desk.serviceGroups : fallbackGroups(DESK_GROUPS, DESK_GROUP_KEYS);
      if (appsFilter !== 'all' && !appGroups.some(({ id }) => id === appsFilter)) appsFilter = 'all';
      if (deskFilter !== 'all' && !serviceGroups.some(({ id }) => id === deskFilter)) deskFilter = 'all';
      const inGroup = (entry, group) => Array.isArray(entry.groups)
        ? entry.groups.includes(group) : entry.group === group;
      const appList = appsFilter === 'all' ? apps : apps.filter((entry) => inGroup(entry, appsFilter));
      const appPageCount = Math.max(1, Math.ceil(appList.length / APPS_PAGE_SIZE));
      appsPage = Math.min(appsPage, appPageCount - 1);
      const shownApps = appList.slice(appsPage * APPS_PAGE_SIZE, (appsPage + 1) * APPS_PAGE_SIZE);
      const itemList = deskFilter === 'all' ? items : items.filter((entry) => inGroup(entry, deskFilter));
      const deskPageCount = Math.max(1, Math.ceil(itemList.length / DESK_PAGE_SIZE));
      deskPage = Math.min(deskPage, deskPageCount - 1);
      const shown = itemList.slice(deskPage * DESK_PAGE_SIZE, (deskPage + 1) * DESK_PAGE_SIZE);
      const cards = {
        apps: mainCardHtml({ region: 'apps', title: translate('workspace.apps'), count: apps.length,
          shown: shownApps, apps: true }),
        desk: mainCardHtml({ region: 'desk', title: translate('workspace.desk'), count: items.length,
          shown }),
      };
      $('officialMainDeck').innerHTML = officialFront === 'apps'
        ? cards.desk + cards.apps : cards.apps + cards.desk;
      renderChips($('appsChips'), appGroups, appsFilter);
      renderPager($('appsPager'), appList.length, appsPage, APPS_PAGE_SIZE);
      renderChips($('deskChips'), serviceGroups, deskFilter);
      renderPager($('deskPager'), itemList.length, deskPage, DESK_PAGE_SIZE);
      if ($('officialCatalogDialog')?.open) renderExpanded();
    }

    function expandedDefinition() {
      const desk = getServiceDesk();
      const apps = expandedRegion === 'apps';
      return {
        entries: apps ? (desk?.applications || []) : (desk?.serviceItems || []),
        groups: apps
          ? (desk?.applicationGroups || fallbackGroups(APP_GROUPS, APP_GROUP_KEYS))
          : (desk?.serviceGroups || fallbackGroups(DESK_GROUPS, DESK_GROUP_KEYS)),
        title: translate(apps ? 'workspace.apps' : 'workspace.desk'),
      };
    }

    function renderExpanded() {
      if (!expandedRegion) return;
      const definition = expandedDefinition();
      if (expandedFilter !== 'all' &&
          !definition.groups.some(({ id }) => id === expandedFilter)) expandedFilter = 'all';
      $('officialCatalogTitle').textContent = definition.title;
      renderChips($('officialCatalogChips'), definition.groups, expandedFilter);
      const inGroup = (entry) => Array.isArray(entry.groups)
        ? entry.groups.includes(expandedFilter) : entry.group === expandedFilter;
      const entries = expandedFilter === 'all'
        ? definition.entries : definition.entries.filter(inGroup);
      $('officialCatalogCount').textContent = translate('workspace.expandedCount', {
        count: entries.length,
      });
      $('officialCatalogList').innerHTML = entries.length
        ? entries.map(rowHtml).join('')
        : `<div class="olist-empty">${escapeHtml(translate('workspace.emptyList'))}</div>`;
    }

    function openExpanded(region) {
      expandedRegion = region === 'desk' ? 'desk' : 'apps';
      expandedFilter = expandedRegion === 'apps' ? appsFilter : deskFilter;
      renderExpanded();
      const dialog = $('officialCatalogDialog');
      if (!dialog.open) dialog.showModal();
      void motion.animateSwitch(dialog, { front: dialog });
      $('closeOfficialCatalog').focus({ preventScroll: true });
    }

    /* ---------------- tabs (§5) ---------------- */

    function setTab(next, { focus = true } = {}) {
      if (searching) exitSearch({ restore: false });
      tab = next === 'personal' ? 'personal' : 'official';
      const officialTab = $('serviceTabOfficial');
      const personalTab = $('serviceTabPersonal');
      officialTab.setAttribute('aria-selected', String(tab === 'official'));
      personalTab.setAttribute('aria-selected', String(tab === 'personal'));
      officialTab.tabIndex = tab === 'official' ? 0 : -1;
      personalTab.tabIndex = tab === 'personal' ? 0 : -1;
      const showEl = tab === 'official' ? view : personalView;
      const hideEl = tab === 'official' ? personalView : view;
      hideEl.hidden = true;
      showEl.hidden = false;
      if (!isReduced()) {
        showEl.classList.remove('ws-view-enter');
        void showEl.offsetWidth;
        showEl.classList.add('ws-view-enter');
      }
      input.placeholder = translate(tab === 'official' ? 'workspace.searchOfficial' : 'workspace.searchPersonal');
      if (focus) {
        const target = tab === 'official'
          ? showEl.querySelector('.chip')
          : showEl.querySelector('.pbtn');
        target?.focus({ preventScroll: true });
      }
    }

    /* ---------------- search (§13) ---------------- */

    function officialResults(query) {
      const desk = getServiceDesk();
      const results = [];
      for (const [pool, region] of [
        [desk?.applications, 'workspace.regionApp'],
        [desk?.serviceItems, 'workspace.regionDesk'],
      ]) {
        for (const entry of Array.isArray(pool) ? pool : []) {
          const match = searchPresenter.scoreEntry({
            name: localized(entry, 'Name'),
            aliases: [...(entry.aliases || []), localized(entry, 'Name') === entry.name ? null : entry.name].filter(Boolean),
            useCase: localized(entry, 'UseCase'),
            audience: localized(entry, 'Audience'),
          }, query);
          if (match.value > 0) results.push({ score: match.value, term: match.term, entry, region });
        }
      }
      return results.sort((a, b) => b.score - a.score).slice(0, SEARCH_RESULT_LIMIT);
    }

    function personalResults(query) {
      const results = [];
      for (const category of getPersonalCategories()) {
        const categoryMatch = searchPresenter.scoreEntry({ name: category.name, aliases: [], useCase: '' }, query);
        if (categoryMatch.value > 0) {
          results.push({ score: categoryMatch.value - 5, category });
        }
        for (const site of category.items || []) {
          const siteMatch = searchPresenter.scoreEntry({
            name: site.name,
            aliases: Array.isArray(site.keywords) ? site.keywords : [],
            useCase: site.description || '',
          }, query);
          if (siteMatch.value > 0) results.push({ score: siteMatch.value, site, category });
        }
      }
      return results.sort((a, b) => b.score - a.score).slice(0, SEARCH_RESULT_LIMIT);
    }

    function resultRowHtml(result) {
      if (result.entry) {
        const { entry, region } = result;
        const name = localized(entry, 'Name');
        const useCase = localized(entry, 'UseCase');
        const audience = localized(entry, 'Audience');
        return `<div class="orow srow" data-entry-id="${escapeHtml(entry.id)}">`
          + `<button class="orow-open" type="button" data-entry-open="${escapeHtml(entry.id)}">`
          + `<span class="orow-icon" aria-hidden="true">${escapeHtml(name.slice(0, 2))}</span>`
          + `<span class="orow-main"><span class="orow-name">${escapeHtml(name)}</span>`
          + `<span class="orow-sub">${escapeHtml(useCase)}</span></span></button>`
          + `<span class="srow-aud">${escapeHtml(audience)}</span>`
          + `<span class="srow-region">${escapeHtml(translate(region))}</span>`
          + favoriteButtonHtml(entry)
          + '</div>';
      }
      if (result.category && !result.site) {
        const { category } = result;
        return `<div class="orow srow" role="button" tabindex="0" data-personal-category="${escapeHtml(category.id)}">`
          + `<span class="orow-icon" aria-hidden="true">${escapeHtml(category.name.slice(0, 2))}</span>`
          + `<span class="orow-main"><span class="orow-name">${escapeHtml(category.name)}</span>`
          + `<span class="orow-sub">${escapeHtml(translate('workspace.categoryResult', { count: (category.items || []).length }))}</span></span>`
          + `<span class="srow-region">${escapeHtml(translate('workspace.regionPersonal'))}</span>`
          + '</div>';
      }
      const { site, category } = result;
      return `<div class="orow srow" role="button" tabindex="0" data-personal-site="${escapeHtml(site.id)}">`
        + `<span class="orow-icon" aria-hidden="true">${escapeHtml(String(site.name || '').slice(0, 2))}</span>`
        + `<span class="orow-main"><span class="orow-name">${escapeHtml(site.name)}</span>`
        + `<span class="orow-sub">${escapeHtml(category.name)}</span></span>`
        + `<span class="srow-region">${escapeHtml(translate('workspace.regionPersonal'))}</span>`
        + '</div>';
    }

    function runSearch(query) {
      if (!searching) {
        searching = true;
        savedScrollTop = doc.querySelector('.content')?.scrollTop || 0;
        view.hidden = true;
        personalView.hidden = true;
        searchView.hidden = false;
      }
      const results = tab === 'official' ? officialResults(query) : personalResults(query);
      $('searchMeta').textContent = results.length
        ? translate('workspace.searchMeta', { query, count: results.length })
        : '';
      if (results.length) {
        $('searchResults').innerHTML = results.map(resultRowHtml).join('');
        return;
      }
      const portal = (getServiceDesk()?.applications || []).find((entry) => entry.id === 'app-myportal');
      $('searchResults').innerHTML = `<div class="olist-empty">${escapeHtml(translate('workspace.searchEmpty', { query }))}</div>`
        + (portal ? `<div class="orow srow" data-entry-id="app-myportal">`
          + `<button class="orow-open" type="button" data-entry-open="app-myportal"><span class="orow-icon" aria-hidden="true">my</span>`
          + `<span class="orow-main"><span class="orow-name">${escapeHtml(localized(portal, 'Name'))}</span>`
          + `<span class="orow-sub">${escapeHtml(translate('workspace.portalFallback'))}</span></span></button>`
          + favoriteButtonHtml(portal)
          + '</div>' : '');
    }

    function exitSearch({ restore = true, clear = true } = {}) {
      if (!searching) return;
      searching = false;
      if (clear) input.value = '';
      searchView.hidden = true;
      (tab === 'official' ? view : personalView).hidden = false;
      if (restore) {
        const content = doc.querySelector('.content');
        if (content) content.scrollTop = savedScrollTop;
      }
    }

    function activateResult(target) {
      const entryId = target.dataset.entryOpen || target.dataset.entryId;
      if (entryId) {
        const entry = entryById(entryId);
        if (entry) openEntryUrl(entry.url);
        return;
      }
      const categoryId = target.dataset.personalCategory;
      if (categoryId) {
        exitSearch();
        if (tab !== 'personal') setTab('personal', { focus: false });
        focusPersonalCard(categoryId);
        return;
      }
      const siteId = target.dataset.personalSite;
      if (siteId) openDeepLink(siteId, null);
    }

    /* ---------------- render + events ---------------- */

    function render() {
      renderOfficial();
    }

    function handleOfficialClick(event) {
      const favorite = event.target.closest('[data-favorite-entry]');
      if (favorite) {
        const entry = entryById(favorite.dataset.favoriteEntry);
        if (entry) onFavoriteEntry(entry);
        return true;
      }
      const open = event.target.closest('[data-entry-open]');
      if (open) {
        const entry = entryById(open.dataset.entryOpen);
        if (entry) openEntryUrl(entry.url);
        return true;
      }
      return false;
    }

    function start() {
      if (started) return false;
      started = true;
      $('serviceTabOfficial').addEventListener('click', () => setTab('official'));
      $('serviceTabPersonal').addEventListener('click', () => setTab('personal'));
      doc.querySelector('.ws-tabs')?.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' &&
            event.key !== 'Home' && event.key !== 'End') return;
        event.preventDefault();
        setTab(tab === 'official' || event.key === 'End' ? 'personal' : 'official');
      });
      $('createCategory').addEventListener('click', () => onCreateCategory());
      $('manageResources').addEventListener('click', () => onToggleOrganize());
      $('officialMainDeck').addEventListener('click', (event) => {
        const main = event.target.closest('[data-official-main-action]');
        if (main) {
          drawOfficialCard(main.dataset.officialMainAction);
          return;
        }
        const more = event.target.closest('[data-official-more]');
        if (more) { openExpanded(more.dataset.officialMore); return; }
        const chip = event.target.closest('.chip');
        if (chip) {
          const region = chip.closest('[data-official-region]')?.dataset.officialRegion;
          if (region === 'apps') { appsFilter = chip.dataset.group; appsPage = 0; }
          else { deskFilter = chip.dataset.group; deskPage = 0; }
          renderOfficial();
          return;
        }
        const page = event.target.closest('[data-page-index]');
        if (page) {
          const region = page.closest('[data-official-region]')?.dataset.officialRegion;
          if (region === 'apps') appsPage = Number(page.dataset.pageIndex);
          else deskPage = Number(page.dataset.pageIndex);
          renderOfficial();
          return;
        }
        handleOfficialClick(event);
      });
      $('searchResults').addEventListener('click', (event) => {
        if (handleOfficialClick(event)) return;
        const row = event.target.closest('.srow');
        if (row) activateResult(row);
      });
      $('closeOfficialCatalog').addEventListener('click', () => $('officialCatalogDialog').close());
      $('officialCatalogChips').addEventListener('click', (event) => {
        const chip = event.target.closest('.chip');
        if (!chip) return;
        expandedFilter = chip.dataset.group;
        renderExpanded();
      });
      $('officialCatalogList').addEventListener('click', handleOfficialClick);
      $('officialCatalogDialog').addEventListener('close', () => {
        expandedRegion = null;
        expandedFilter = 'all';
      });
      $('searchResults').addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        if (event.target.closest('button')) return;
        const row = event.target.closest('.srow');
        if (!row) return;
        event.preventDefault();
        activateResult(row);
      });
      input.addEventListener('input', () => {
        const query = input.value.trim();
        if (!query) { exitSearch(); return; }
        runSearch(query);
      });
      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        exitSearch();
        input.blur();
      });
      render();
      return true;
    }

    return Object.freeze({
      activeTab: () => tab,
      clearSearch: () => exitSearch(),
      focusSearch: () => input.focus(),
      isSearching: () => searching,
      render,
      setTab,
      start,
    });
  }

  return Object.freeze({ create });
});
