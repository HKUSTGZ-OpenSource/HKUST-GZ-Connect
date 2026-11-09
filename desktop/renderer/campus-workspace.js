'use strict';

const I18N = Object.freeze({
  zh: Object.freeze({
    title: '校园工作台', manage: '整理收藏', clear: '返回工作台',
    backToServices: '返回校园服务', more: '查看更多',
    primaryWorkspace: '我的工作区', primaryRecent: '最近使用', primaryCatalog: '网站库',
    favorites: '我的收藏', recent: '最近使用', starter: '常用入口', catalogTitle: '网站库',
    manageTitle: '整理收藏', resourcePool: '收藏', groups: '我的分类', createGroup: '＋ 新建分类',
    allSites: '全部', allFavorites: '全部收藏',
    searchResults: '搜索结果：{query}', ungrouped: '未分类', emptyFavorites: '还没有收藏的网站',
    noMatch: '没有符合条件的校园服务', noMatchHint: '尝试其他关键词。', clearSearch: '清除搜索',
    createTitle: '新建分类', renameTitle: '重命名分类', renameSite: '重命名网页', groupName: '名称',
    cancel: '取消', save: '保存', edit: '重命名', remove: '删除', confirmDelete: '确认删除',
    confirmDeleteGroup: '删除分类（网站保留）',
    moveUp: '上移', moveDown: '下移', favorite: '收藏', unfavorite: '取消收藏',
    invalidGroupName: '请输入 1–30 个字符的分类名称', invalidSiteName: '请输入 1–40 个字符的网站名称',
    selectPage: '选择本页', selectedCount: '已选择 {count} 项', selectionHint: '选择网站后可加入分类', chooseGroup: '选择分类',
    addToGroup: '加入分类', clearSelection: '取消选择', memberships: '所在分类',
    mutationFailed: '操作未完成，请重试。', mutationStale: '页面状态已变化，请基于最新内容重试。',
    openedAt: '打开于 {time}', pageRange: '{start}–{end} / {total}', previousPage: '上一页', nextPage: '下一页',
    campus: '校园隧道', direct: '直连',
    newcomer: '入学、账号与迎新', courses: '课程、选课与成绩', research: '科研、进度与计算', labs: '实验室与仪器',
    studentFinance: '学费、奖助与津贴', expenses: '经费、采购与报销', career: '实习、就业与发展', campusLife: '住宿与空间',
    documents: '申请、证明与毕业', tools: '协作、图书馆与 IT', staff: '教师与行政', custom: '自定义',
  }),
  en: Object.freeze({
    title: 'Campus Workspace', manage: 'Organize Favorites', clear: 'Back to Workspace',
    backToServices: 'Back to Services', more: 'More',
    primaryWorkspace: 'My Workspace', primaryRecent: 'Recently Used', primaryCatalog: 'Site Library',
    favorites: 'Favorites', recent: 'Recently Used', starter: 'Common Services', catalogTitle: 'Site Library',
    manageTitle: 'Organize Favorites', resourcePool: 'Favorites', groups: 'My Categories', createGroup: '+ New Category',
    allSites: 'All', allFavorites: 'All Favorites',
    searchResults: 'Search: {query}', ungrouped: 'Uncategorized', emptyFavorites: 'No favorite sites yet',
    noMatch: 'No matching campus services', noMatchHint: 'Try another search term.', clearSearch: 'Clear Search',
    createTitle: 'New Category', renameTitle: 'Rename Category', renameSite: 'Rename Site', groupName: 'Name',
    cancel: 'Cancel', save: 'Save', edit: 'Rename', remove: 'Delete', confirmDelete: 'Confirm delete',
    confirmDeleteGroup: 'Delete Category (keep sites)',
    moveUp: 'Move up', moveDown: 'Move down', favorite: 'Favorite', unfavorite: 'Remove favorite',
    invalidGroupName: 'Enter a category name between 1 and 30 characters', invalidSiteName: 'Enter a site name between 1 and 40 characters',
    selectPage: 'Select Page', selectedCount: '{count} selected', selectionHint: 'Select sites to add them to a category', chooseGroup: 'Choose Category',
    addToGroup: 'Add to Category', clearSelection: 'Clear Selection', memberships: 'Categories',
    mutationFailed: 'The change was not completed. Try again.',
    mutationStale: 'The workspace changed. Retry from the latest view.',
    openedAt: 'Opened {time}', pageRange: '{start}–{end} / {total}', previousPage: 'Previous page', nextPage: 'Next page',
    campus: 'Campus Tunnel', direct: 'Direct',
    newcomer: 'Onboarding & Account', courses: 'Courses, Enrollment & Grades', research: 'Research, Progress & Computing', labs: 'Labs & Instruments',
    studentFinance: 'Fees, Aid & Studentships', expenses: 'Funding, Procurement & Expenses', career: 'Internships, Career & Development', campusLife: 'Housing & Spaces',
    documents: 'Applications, Documents & Graduation', tools: 'Collaboration, Library & IT', staff: 'Teaching & Administration', custom: 'Custom',
  }),
});

const ICONS = Object.freeze({
  newcomer: '<path d="m4 9 8-5 8 5M6 10v9h12v-9M9 19v-5h6v5"/>',
  courses: '<path d="M4 5.5h6.5A2.5 2.5 0 0 1 13 8v11a2.5 2.5 0 0 0-2.5-2.5H4zM20 5.5h-4.5A2.5 2.5 0 0 0 13 8v11a2.5 2.5 0 0 1 2.5-2.5H20z"/>',
  research: '<path d="M4 18h16M7 18v-5l5-3 5 3v5M9 8a3 3 0 1 1 6 0M12 5V3"/>',
  labs: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 18l-5-9V3M8 15h8"/>',
  'student-finance': '<path d="M4 6h16v12H4zM7 10h10M7 14h5M16 14h1"/>',
  expenses: '<path d="M5 4h14v16H5zM8 8h8M8 12h3M14 12h2M8 16h3M14 16h2"/>',
  career: '<path d="M4 8h16v11H4zM9 8V5h6v3M4 12h16M10 12v2h4v-2"/>',
  'campus-life': '<path d="m4 9 8-5 8 5M5.5 9.5h13v10h-13zM9 19.5v-6h6v6M3.5 20h17"/>',
  documents: '<path d="M6 3h9l3 3v15H6zM14 3v4h4M9 11h6M9 15h6M9 19h4"/>',
  tools: '<path d="M5 5h5v5H5zM14 5h5v5h-5zM5 14h5v5H5zM14 14h5v5h-5z"/>',
  staff: '<path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8M5 21a7 7 0 0 1 14 0M17 9h4M19 7v4"/>',
  custom: '<path d="M10 13.5a4 4 0 0 0 5.7.1l2.2-2.2a4 4 0 0 0-5.7-5.7L11 6.9M14 10.5a4 4 0 0 0-5.7-.1l-2.2 2.2a4 4 0 0 0 5.7 5.7l1.2-1.2"/>',
});

const model = window.campusWorkspaceModel;
let state = null;
let navigation = model.normalizeNavigation({ screen: 'home' });
let editingGroupId = null;
let primaryView = 'workspace';
let servicePage = 0;
let searchPage = 0;
let groupDialogRevision = 0;
let mutationSequence = 0;
let feedbackSequence = 0;

const $ = (id) => document.getElementById(id);
const text = () => I18N[state?.locale === 'en' ? 'en' : 'zh'];
const command = (name, payload = {}) => window.campusWorkspace?.command(name, payload) === true;
const categoryLabel = (category) => text()[model.TASK_CATEGORIES.find(({ id }) => id === category)?.labelKey || 'custom'];
const workspaceBoardFeature = window.campusWorkspaceCardBoard.create({
  window,
  document,
  workspaceModel: model,
  getState: () => state,
  getText: text,
  categoryLabel,
  mutate: (name, payload) => mutate(name, payload),
  command,
});

const workspaceFeedback = document.createElement('p');
workspaceFeedback.id = 'workspaceMutationFeedback';
workspaceFeedback.setAttribute('role', 'alert');
workspaceFeedback.setAttribute('aria-live', 'polite');
workspaceFeedback.hidden = true;
document.querySelector('.workspace-shell')?.prepend(workspaceFeedback);

function setMutationFeedback(sequence, message) {
  if (sequence < feedbackSequence) return;
  feedbackSequence = sequence;
  workspaceFeedback.textContent = message || '';
  workspaceFeedback.hidden = !message;
}

async function mutate(name, payload = {}) {
  const sequence = ++mutationSequence;
  let result;
  try {
    result = await window.campusWorkspace?.request(name, payload);
  } catch {
    result = null;
  }
  if (result?.ok === true) {
    setMutationFeedback(sequence, '');
    return result;
  }
  const fallback = result?.code === 'WORKSPACE_MUTATION_STALE'
    ? text().mutationStale : text().mutationFailed;
  setMutationFeedback(sequence, result?.error || fallback);
  return result || { ok: false, code: 'WORKSPACE_MUTATION_FAILED', error: fallback };
}

function routeText(resource) {
  return resource.route === 'direct' ? text().direct : text().campus;
}

function resourceIcon(resource) {
  const category = model.categoryOf(resource);
  const span = document.createElement('span');
  span.className = `resource-icon${category === 'custom' ? ' custom' : ''}`;
  span.setAttribute('aria-hidden', 'true');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.innerHTML = ICONS[category] || ICONS.custom;
  span.appendChild(svg);
  return span;
}

function resourceItem(resource, { showLastOpened = false } = {}) {
  const item = document.createElement('div');
  item.className = 'resource-item';
  item.dataset.resourceId = resource.id;

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'resource-open';
  open.title = resource.name;
  open.appendChild(resourceIcon(resource));
  const copy = document.createElement('span');
  copy.className = 'resource-copy';
  const name = document.createElement('span');
  name.className = 'resource-name';
  name.textContent = resource.name;
  const route = document.createElement('span');
  route.className = `resource-route${resource.route === 'direct' ? ' direct' : ''}`;
  route.textContent = routeText(resource);
  copy.append(name, route);
  if (showLastOpened && Number.isSafeInteger(resource.lastOpenedAt)) {
    const opened = document.createElement('span'); opened.className = 'resource-last-opened';
    const formatted = new Intl.DateTimeFormat(state.locale === 'en' ? 'en' : 'zh-CN', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }).format(resource.lastOpenedAt);
    opened.textContent = text().openedAt.replace('{time}', formatted);
    copy.appendChild(opened);
  }
  open.appendChild(copy);
  open.addEventListener('click', () => command('open-resource', { resourceId: resource.id }));
  item.appendChild(open);

  const star = document.createElement('button');
  star.type = 'button';
  star.className = `resource-star${resource.favorite ? ' active' : ''}`;
  star.textContent = resource.favorite ? '★' : '☆';
  star.setAttribute('aria-label', resource.favorite ? text().unfavorite : text().favorite);
  star.addEventListener('click', () => {
    star.disabled = true;
    void mutate('toggle-favorite', { resourceId: resource.id }).finally(() => {
      if (star.isConnected) star.disabled = false;
    });
  });
  item.appendChild(star);
  return item;
}

function renderGrid(target, resources, options = {}) {
  target.classList.add('resource-grid-enter');
  target.replaceChildren(...resources.map((resource) => resourceItem(resource, options)));
}

function pageCapacity() {
  if (innerWidth >= 1100) return 12;
  if (innerWidth >= 760) return 8;
  return 6;
}

function paged(items, page) {
  const size = pageCapacity();
  const pages = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(Math.max(0, page), pages - 1);
  const start = current * size;
  return {
    current, pages, size, total: items.length,
    start, end: Math.min(items.length, start + size),
    items: items.slice(start, start + size),
  };
}

function renderPager(target, page, selectPage) {
  target.hidden = page.pages <= 1;
  if (page.pages <= 1) { target.replaceChildren(); return; }
  const info = document.createElement('span'); info.className = 'pager-range';
  info.textContent = text().pageRange
    .replace('{start}', String(page.start + 1))
    .replace('{end}', String(page.end))
    .replace('{total}', String(page.total));
  const button = (direction, label, disabled, nextPage) => {
    const control = document.createElement('button'); control.type = 'button';
    control.className = 'pager-button'; control.textContent = direction;
    control.title = label; control.setAttribute('aria-label', label); control.disabled = disabled;
    control.addEventListener('click', () => selectPage(nextPage));
    return control;
  };
  target.replaceChildren(
    info,
    button('‹', text().previousPage, page.current === 0, page.current - 1),
    button('›', text().nextPage, page.current === page.pages - 1, page.current + 1),
  );
}

function renderHome() {
  const resources = state.resources.filter(({ category }) => category !== 'gateway');
  const recent = [...resources].filter(({ lastOpenedAt }) => Number.isSafeInteger(lastOpenedAt))
    .sort((left, right) => right.lastOpenedAt - left.lastOpenedAt);
  const primaryLabels = {
    workspace: text().primaryWorkspace,
    recent: text().primaryRecent,
    catalog: text().primaryCatalog,
  };
  for (const control of document.querySelectorAll('[data-primary-view]')) {
    const active = control.dataset.primaryView === primaryView;
    control.textContent = primaryLabels[control.dataset.primaryView];
    control.classList.toggle('active', active);
    control.setAttribute('aria-current', active ? 'page' : 'false');
  }

  const cardMode = workspaceBoardFeature.render(primaryView);
  $('serviceViewGrid').hidden = cardMode;
  $('servicePager').hidden = cardMode;
  $('serviceViewTitle').closest('.view-heading').hidden = cardMode;
  $('openManage').hidden = primaryView === 'recent';
  if (cardMode) {
    $('quickCreateGroup').hidden = primaryView !== 'workspace';
    $('quickCreateGroup').textContent = text().createGroup;
    return;
  }

  const selected = { id: 'recent', name: text().recent, items: recent };
  $('quickCreateGroup').hidden = true;
  $('serviceViewTitle').textContent = selected.name;
  $('serviceViewCount').textContent = String(selected.items.length);
  const page = paged(selected.items, servicePage); servicePage = page.current;
  renderGrid($('serviceViewGrid'), page.items, { showLastOpened: selected.id === 'recent' });
  renderPager($('servicePager'), page, (index) => {
    servicePage = index; renderHome();
  });
}

function renderSearch() {
  const results = model.searchResources(state.resources, navigation.query);
  const page = paged(results, searchPage); searchPage = page.current;
  renderGrid($('searchGrid'), page.items);
  renderPager($('searchPager'), page, (index) => {
    searchPage = index; renderSearch();
  });
  $('searchTitle').textContent = text().searchResults.replace('{query}', navigation.query);
  $('workspaceEmpty').hidden = results.length > 0;
}

function syncText() {
  const strings = text();
  document.documentElement.lang = state.locale === 'en' ? 'en' : 'zh-CN';
  document.title = `${strings.title} · ${state.schoolName}`;
  $('clearWorkspaceSearch').textContent = strings.clear;
  $('emptyTitle').textContent = strings.noMatch;
  $('emptyHint').textContent = strings.noMatchHint;
  $('clearWorkspaceFilter').textContent = strings.clearSearch;
  $('groupNameLabel').textContent = strings.groupName;
  $('cancelGroup').textContent = strings.cancel;
  $('saveGroup').textContent = strings.save;
}

function render() {
  if (!state) return;
  syncText();
  const searchMode = Boolean(navigation.query);
  $('searchScreen').hidden = !searchMode;
  $('homeScreen').hidden = searchMode;
  $('workspaceEmpty').hidden = true;
  $('clearWorkspaceSearch').hidden = !navigation.query;
  if (searchMode) renderSearch();
  else renderHome();
}

function openGroupDialog(group = null) {
  groupDialogRevision += 1;
  editingGroupId = group?.id || null;
  $('groupDialogTitle').textContent = group ? text().renameTitle : text().createTitle;
  $('groupName').value = group?.name || '';
  $('groupError').textContent = '';
  $('saveGroup').disabled = false;
  $('groupDialog').showModal();
  $('groupName').focus();
}

$('primaryTabs').addEventListener('click', (event) => {
  const control = event.target.closest('[data-primary-view]');
  if (!control) return;
  primaryView = control.dataset.primaryView;
  servicePage = 0; renderHome();
});
$('openManage').addEventListener('click', () => {
  workspaceBoardFeature.toggleEdit();
});
$('quickCreateGroup').addEventListener('click', () => openGroupDialog());
function clearSearch() {
  searchPage = 0;
  navigation = model.normalizeNavigation({ screen: 'home' }); render();
}
$('clearWorkspaceSearch').addEventListener('click', clearSearch);
$('clearWorkspaceFilter').addEventListener('click', clearSearch);
$('groupDialog').addEventListener('close', () => {
  groupDialogRevision += 1;
  editingGroupId = null;
});
$('saveGroup').addEventListener('click', async (event) => {
  event.preventDefault();
  const name = $('groupName').value.trim();
  if (!name || name.length > 30) {
    $('groupError').textContent = text().invalidGroupName;
    return;
  }
  const dialogRevision = groupDialogRevision;
  const groupId = editingGroupId;
  $('saveGroup').disabled = true;
  const result = await mutate(groupId ? 'rename-group' : 'create-group', groupId
    ? { groupId, name } : { name });
  if (dialogRevision !== groupDialogRevision || !$('groupDialog').open) return;
  $('saveGroup').disabled = false;
  if (result?.ok) $('groupDialog').close();
  else $('groupError').textContent = result?.error || text().mutationFailed;
});
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault(); command('focus-address'); return;
  }
  if (event.target instanceof Element && event.target.closest('input, select, button, dialog')) return;
  if (event.key === 'ArrowLeft' && servicePage > 0) {
    event.preventDefault(); servicePage -= 1; renderHome();
  } else if (event.key === 'ArrowRight') {
    const next = document.querySelector('#servicePager .pager-button:last-child:not(:disabled)');
    if (next) { event.preventDefault(); next.click(); }
  }
});

let layoutRenderFrame = null;
let lastLayoutSignature = '';
function scheduleLayoutRender() {
  if (layoutRenderFrame !== null) cancelAnimationFrame(layoutRenderFrame);
  layoutRenderFrame = requestAnimationFrame(() => {
    layoutRenderFrame = null;
    const signature = String(pageCapacity());
    if (!state || signature === lastLayoutSignature) return;
    lastLayoutSignature = signature;
    render();
  });
}
new ResizeObserver(scheduleLayoutRender).observe(document.querySelector('.workspace-shell'));
window.addEventListener('resize', scheduleLayoutRender);

window.campusWorkspace?.onState((next) => {
  state = next;
  render();
  if (!workspaceBoardFeature.isEditing()) void workspaceBoardFeature.reload();
});
window.campusWorkspace?.onFocus(({ target, query = '' }) => {
  if (target === 'search') {
    const normalized = query.trim().toLocaleLowerCase();
    const group = normalized && state.groups.find(({ name }) =>
      name.toLocaleLowerCase().includes(normalized));
    if (group) {
      primaryView = 'workspace'; servicePage = 0;
      navigation = model.normalizeNavigation({ screen: 'home' });
      render();
      workspaceBoardFeature.focusPersonalCollection(group.id);
    } else if (query) {
      navigation = model.normalizeNavigation({ screen: 'home', query });
      searchPage = 0; render();
    } else {
      command('focus-address');
    }
  } else if (target === 'manage') {
    navigation = model.normalizeNavigation({ screen: 'home' });
    render();
    workspaceBoardFeature.enterEdit();
  }
});
command('ready');
