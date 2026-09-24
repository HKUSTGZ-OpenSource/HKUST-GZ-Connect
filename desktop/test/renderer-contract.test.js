'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rendererDir = path.join(__dirname, '..', 'renderer');
const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8')
  + fs.readFileSync(path.join(rendererDir, 'features/campus-data/view.css'), 'utf8');
const appJs = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
const categoryStacksJs = fs.readFileSync(path.join(rendererDir, 'campus-category-stacks.js'), 'utf8');
const serviceWorkspaceJs = fs.readFileSync(path.join(rendererDir, 'campus-service-workspace.js'), 'utf8');
const campusDataModulesJs = fs.readFileSync(path.join(rendererDir, 'features/campus-data/controller.mjs'), 'utf8')
  + fs.readFileSync(path.join(rendererDir, 'features/campus-data/calendar-view.mjs'), 'utf8');
const campusDataModules = require(path.join(rendererDir, 'features/campus-data/index.mjs'));
const usabilityControllerJs = fs.readFileSync(path.join(rendererDir, 'usability-controller.js'), 'utf8');

test('login fields keep native keyboard and password-manager semantics', () => {
  assert.match(html, /id="lgUser"[^>]*name="username"/);
  assert.match(html, /id="lgUser"[^>]*autocomplete="username"/);
  assert.match(html, /id="lgPass"[^>]*name="password"/);
  assert.match(html, /id="lgPass"[^>]*type="password"/);
  assert.match(html, /id="lgPass"[^>]*autocomplete="current-password"/);
  assert.doesNotMatch(html, /id="lgPass"[^>]*(?:disabled|readonly)/);
  assert.match(css, /\.inp\s*\{[^}]*-webkit-user-select:\s*text/);
  assert.match(html, /<script src="\.\.\/lib\/browser\/auth\/login-flow\.js"><\/script>/);
  assert.match(
    html,
    /<script src="\.\.\/lib\/resources\/presentation\/resource-view\.js"><\/script>/,
  );
  assert.match(appJs, /updateLoginProgress\(s\)/);
  assert.match(appJs, /const \{ evaluateLoginProgress \} = window\.loginFlow/);
  assert.match(appJs, /window\.campusCategoryStacks\.render/u);
  assert.doesNotMatch(appJs, /function evaluateLoginProgress\(/);
  assert.doesNotMatch(appJs, /function visibleResources\(|function routeLabel\(/);
  assert.doesNotMatch(appJs, /saved\.ok[\s\S]{0,180}lgPass'\)\.value\s*=\s*''[\s\S]{0,80}show\('dash'\)/);
});

test('login owns a modular bilingual School selector with an explicit unreviewed confirmation', () => {
  assert.match(html, /id="schoolProfileSelect"/u);
  assert.match(html, /id="customGatewayConfirmation"[^>]*hidden/u);
  assert.match(html, /id="confirmCustomGateway"/u);
  assert.match(html, /class="gateway-warning"/u);
  const selectorScript = html.indexOf('<script src="school-profile-selector.js"></script>');
  const appScript = html.indexOf('<script type="module" src="app.js"></script>');
  assert.ok(selectorScript > 0 && selectorScript < appScript);
  assert.match(css, /@media\s*\(max-width:\s*459px\)/u);
  assert.match(appJs, /expectedProfileId: expectedProfileId|expectedProfileId \}/u);
  assert.doesNotMatch(appJs, /probeCustomGateway|confirmCustomGateway|getElementById\(['"]schoolProfileSelect/u,
    'School onboarding belongs to its renderer feature module');
});

test('Control Tower owns a modular Integration Center instead of scattered secret copy buttons', () => {
  assert.match(html, /id="integrationList"/u);
  assert.match(html, /id="integrationDialog"/u);
  assert.match(html, /id="confirmIntegration"/u);
  assert.doesNotMatch(html, /data-copy="(?:pac|clash|ssh)"/u);
  const integrationScript = html.indexOf('<script src="integration-center.js"></script>');
  const appScript = html.indexOf('<script type="module" src="app.js"></script>');
  assert.ok(integrationScript > 0 && integrationScript < appScript);
  assert.doesNotMatch(appJs, /prepareIntegration|confirmIntegration|listIntegrations/u);
});

test('dashboard separates connection, personal Campus Workspace, advanced tower, and settings', () => {
  assert.match(html, /data-page="connect"/);
  assert.match(html, /data-page="browser"/);
  assert.doesNotMatch(html, /data-page="notif"/);
  assert.match(html, /id="openCampusWorkspace"/u);
  assert.match(appJs, /openCampusWorkspace[\s\S]*openCampusBrowser/u);
  assert.doesNotMatch(appJs, /manageResources[\s\S]*openBookmarkManager/u);
  assert.match(html, /id="manageResources"/u);
  assert.match(html, /id="connectCardBoardHost"/u);
  assert.match(categoryStacksJs, /toggleEdit/u);
  assert.match(html, /id="notificationDrawer"[^>]*role="dialog"/u);
  assert.match(html, /id="openNotificationDrawer"/u);
  assert.doesNotMatch(html, /custom-url-details|legacyResourceManager|id="resourceDialog"/u,
    'the retired quick-URL area and legacy website manager are gone');
});

test('Connection keeps student essentials visible and progressively discloses network diagnostics', () => {
  assert.match(html, /id="currentNetworkExit"/u);
  assert.match(html, /id="networkPathDetails"[^>]*class="network-path-details"/u);
  assert.match(html, /data-i18n="connect\.networkPathAction"/u);
  assert.match(html, /data-i18n="stats\.connections">正在使用校园隧道的应用/u);
  assert.match(html, /id="latencyHint"[^>]*data-i18n="connect\.latencyEmpty"/u);
  assert.match(css, /\.latency-metric\.is-empty \.latency-sparkline\s*\{[^}]*display:\s*none/u);
});

test('Campus Workspace exposes plain-language actions without a nested surface shell', () => {
  assert.match(html, /id="openCampusWorkspace"[^>]*data-i18n="browser\.openWindow"[^>]*>打开校园浏览器</u);
  assert.match(html, /id="addWebsite"[^>]*data-i18n="browser\.addWebsite"[^>]*>添加网站</u);
  assert.match(html, /id="manageResources"[^>]*data-i18n="resources\.manage"[^>]*>整理分类与网站</u);
  assert.match(html, /id="createCategory"[^>]*data-i18n="browser\.addCategory"/u);
  assert.match(html, /class="ptoolbar"/u);
  assert.doesNotMatch(html, /class="quick-card category-workspace"/u,
    'Campus Workspace must not wrap Card Board in another large white card');
});

test('Campus Workspace data modules use isolated state projections without portal credentials', () => {
  for (const id of ['moduleSchedule', 'moduleLoans', 'moduleNews', 'scheduleBody', 'loansBody', 'newsBody']) {
    assert.match(html, new RegExp(`id="${id}"`, 'u'));
  }
  assert.match(html, /<script type="module" src="app\.js"><\/script>/u);
  assert.match(appJs, /import \{ create as createCampusData \} from '\.\/features\/campus-data\/index\.mjs'/u);
  assert.doesNotMatch(html, /src="campus-data-modules\.js"/u);
  assert.doesNotMatch(appJs, /window\.campusDataModules/u);
  assert.match(campusDataModulesJs, /not-authenticated/u);
  assert.match(campusDataModulesJs, /source-unavailable/u);
  assert.match(campusDataModulesJs, /session-expired/u);
  assert.match(html, /class="official-main-deck"[^>]*id="officialMainDeck"/u);
  assert.match(html, /id="officialCatalogDialog"/u);
  assert.match(html, /id="officialFavoriteDialog"/u);
  assert.match(html, /<script src="official-favorite-dialog\.js"><\/script>/u);
  assert.match(serviceWorkspaceJs, /const APPS_PAGE_SIZE = 12/u);
  assert.match(serviceWorkspaceJs, /const DESK_PAGE_SIZE = 6/u);
  assert.match(serviceWorkspaceJs, /renderPager/u);
  assert.match(serviceWorkspaceJs, /mainCardHtml/u);
  assert.match(serviceWorkspaceJs, /officialFront/u);
  assert.match(serviceWorkspaceJs, /id="\$\{region\}Pager"/u);
  assert.match(serviceWorkspaceJs, /data-favorite-entry/u);
  assert.match(serviceWorkspaceJs, /openExpanded/u);
  assert.doesNotMatch(serviceWorkspaceJs, /routeBadge|orow-route/u);
  assert.doesNotMatch(serviceWorkspaceJs, /appsShowAll|deskShowAll/u);
  assert.match(css, /\.portal-page\[aria-current="page"\]::after/u);
  assert.match(css, /\.official-main-card\.is-back/u);
  assert.match(css, /\.official-main-card\.is-front/u);
  assert.match(css, /@media\s*\(min-width:\s*980px\)[\s\S]*\.official-main-deck[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(0,\s*1fr\)/u);
  assert.match(css, /@keyframes official-card-draw/u);
  assert.match(css, /\.orow-list-apps\s*\{[^}]*repeat\(2,/u);
  assert.doesNotMatch(css, /\.orow-list-apps\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/u);
  assert.match(css, /\.official-expanded-list/u);
  assert.match(css, /\.orow-favorite\.active/u);
  assert.match(css, /\.official-main-card-body \.orow-list\s*\{[^}]*min-height:\s*288px/u);
  assert.match(html, /class="module module-schedule" id="moduleSchedule"/u);
  assert.match(html, /id="scheduleRefresh"[^>]*data-i18n="workspace\.scheduleRefresh"/u);
  assert.match(campusDataModulesJs, /week-table/u);
  assert.match(campusDataModulesJs, /SCHEDULE_AUTO_REFRESH_MS\s*=\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1_000/u);
  assert.match(campusDataModulesJs, /api\.refreshCampusSchedule/u);
  assert.match(css, /\.module-refresh\s*\{/u);
  assert.match(css, /\.module-schedule\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/u);
  assert.match(css, /\.week-scroll\s*\{[^}]*overflow-x:\s*hidden/u);
  assert.match(css, /\.week-table\s*\{[^}]*min-width:\s*0/u);
  assert.match(css, /\.week-table\.is-mini\s+\.week-body\s*\{[^}]*grid-template-columns:\s*0 repeat\(7, minmax\(0, 1fr\)\)/u);
  assert.doesNotMatch(campusDataModulesJs, /style="/u);
  assert.doesNotMatch(campusDataModulesJs, /cookie|password|localStorage/iu);
  assert.match(appJs, /campusDataFeature\?\.ensureLoaded/u);
  assert.match(appJs, /window\.officialFavoriteDialog\.create/u);
  assert.match(appJs, /serviceWorkspace\?\.setTab\('personal'/u);
  assert.match(categoryStacksJs, /personalCategoryPager/u);
  assert.match(categoryStacksJs, /autoStack:\s*true/u);
  assert.match(appJs, /window\.addEventListener\('focus'[^]*campusDataFeature\?\.ensureLoaded/u);
});

test('weekly timetable maps Monday through Sunday into bounded two-hour course slots', () => {
  const now = new Date(2026, 8, 2, 12, 0, 0).getTime();
  const range = campusDataModules.weekRange(now);
  assert.equal(new Date(range.start).getDay(), 1);
  assert.equal(range.days.length, 7);
  assert.equal(new Date(range.days[6]).getDay(), 0);
  const tuesdayStart = new Date(2026, 8, 1, 9, 0, 0).getTime();
  const fridayStart = new Date(2026, 8, 4, 14, 0, 0).getTime();
  const model = campusDataModules.scheduleWeekModel([
    { title: 'Seminar', startsAt: tuesdayStart, endsAt: tuesdayStart + 2 * 3_600_000 },
    { title: 'Lab', startsAt: fridayStart, endsAt: fridayStart + 2 * 3_600_000 },
    { title: 'Next week', startsAt: range.end + 3_600_000, endsAt: range.end + 7_200_000 },
  ], now);
  assert.deepEqual(model.events.map(({ day, slot, span }) => ({ day, slot, span })), [
    { day: 1, slot: 0, span: 2 },
    { day: 4, slot: 3, span: 1 },
  ]);
});

test('dashboard usability layer keeps status shortcuts feedback and recovery outside Main', () => {
  assert.match(html, /id="navConnectionState"/u);
  assert.match(html, /id="globalToast"[^>]*aria-live="polite"/u);
  assert.match(html, /<script src="usability-controller\.js"><\/script>/u);
  assert.match(usabilityControllerJs, /PAGE_SHORTCUTS/u);
  assert.match(usabilityControllerJs, /event\.key\.toLowerCase\(\) === 'k'/u);
  assert.match(serviceWorkspaceJs, /ArrowLeft[\s\S]*ArrowRight[\s\S]*Home[\s\S]*End/u);
  assert.match(serviceWorkspaceJs, /plainField[\s\S]*entry\?\.\[plainField\]/u);
  assert.doesNotMatch(appJs, /addEventListener\('keydown'[\s\S]*PAGE_SHORTCUTS/u,
    'global shortcuts belong to the usability module');
});

test('personal categories drive the card board with ID-only resource actions', () => {
  for (const id of ['resourceSearch', 'campusResources', 'connectCardBoardHost']) {
    assert.match(html, new RegExp(`id="${id}"`, 'u'));
  }
  assert.doesNotMatch(html, /id="resourceView"|id="resourceViewChips"|id="categoryModeCatalog"/u,
    'the hidden legacy view controls and source tabs are gone');
  assert.match(appJs, /window\.api\.openResource\(selected\.id\)/u);
  assert.match(appJs, /window\.api\.toggleResourceFavorite\(resource\.id\)/u);
  assert.doesNotMatch(appJs, /openCampusBrowser\(\{\s*url:\s*selected\.url/u);
  assert.match(html, /class="card-board-mount"/u);
  assert.match(categoryStacksJs, /officialCategoryProjection/u);
  assert.match(categoryStacksJs, /personalCategoryProjection/u);
  assert.match(categoryStacksJs, /cardBoardController\.create/u);
  assert.match(categoryStacksJs, /getCardBoardLayout/u);
  assert.match(categoryStacksJs, /commitCardBoardLayout/u);
  const workspaceModelScript = html.indexOf('<script src="campus-workspace-model.js"></script>');
  const cardModelScript = html.indexOf('<script src="components/card-board/card-board-model.js"></script>');
  const cardControllerScript = html.indexOf('<script src="components/card-board/card-board-controller.js"></script>');
  const categoryStacksScript = html.indexOf('<script src="campus-category-stacks.js"></script>');
  assert.ok(workspaceModelScript > 0 && workspaceModelScript < cardModelScript &&
    cardModelScript < cardControllerScript && cardControllerScript < categoryStacksScript,
  'taxonomy and shared Card Board must load before category composition');
  const groupDialogScript = html.indexOf('<script src="group-dialog.js"></script>');
  const serviceWorkspaceScript = html.indexOf('<script src="campus-service-workspace.js"></script>');
  const appScript = html.indexOf('<script type="module" src="app.js"></script>');
  assert.ok(groupDialogScript > 0 && groupDialogScript < appScript &&
    serviceWorkspaceScript > 0 && serviceWorkspaceScript < appScript,
    'the service workspace modules must load before the shell composition');
});

test('control panel has responsive wide and compact layout rules', () => {
  assert.match(css, /@media\s*\(max-width:\s*459px\)/);
  assert.match(css, /@media\s*\(max-width:\s*359px\)[\s\S]*\.resource-grid[^}]*grid-template-columns:\s*1fr/u);
  assert.match(css, /\.resource-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,/u);
  assert.doesNotMatch(css, /data-resource-layout=/u,
    'the retired resource layout modes must not linger in the shell stylesheet');
  assert.match(css, /\.page\[data-page="connect"\][^{]*\{/);
  assert.match(appJs, /const content = document\.querySelector\('\.content'\)[\s\S]{0,220}content\.scrollTop\s*=\s*0/u);
});

test('Control Tower distinguishes a committed save from a failed reconnect', () => {
  assert.match(appJs, /outcome === 'saved_reconnect_failed'/u);
  assert.match(appJs, /`\$\{t\('tower\.saved'\)\} · \$\{result\.warning/u);
});

test('Campus Browser chrome keeps the minimum task set and exposes app settings', () => {
  const browserHtml = fs.readFileSync(path.join(rendererDir, 'campus-browser.html'), 'utf8');
  const browserJs = fs.readFileSync(path.join(rendererDir, 'campus-browser.js'), 'utf8');
  for (const id of [
    'tabs', 'back', 'forward', 'reload', 'address', 'routeBadge', 'browserSettings',
    'bookmarkBar', 'bookmarkItems', 'bookmarkMore', 'manageBookmarks',
  ]) {
    assert.match(browserHtml, new RegExp(`id="${id}"`, 'u'));
  }
  assert.match(browserJs, /command\('open-settings'\)/u);
  assert.match(browserJs, /command\('open-resource',\s*entry\.id\)/u);
  assert.match(browserJs, /command\('manage-bookmarks'\)/u);
  assert.doesNotMatch(browserHtml, /id="openExternal"/u);
  assert.match(browserHtml, /id="loadingBanner"[^>]*hidden/u);
  assert.match(browserHtml, /id="loadingBannerName"/u);
  assert.match(browserHtml, /id="loadingBannerRoute"/u);
  assert.match(browserJs, /next\.loadingLabel/u);
});

test('Campus Workspace is a real local renderer with ID-only actions and modular portal surfaces', () => {
  const workspaceHtml = fs.readFileSync(path.join(rendererDir, 'campus-workspace.html'), 'utf8');
  const workspaceJs = fs.readFileSync(path.join(rendererDir, 'campus-workspace.js'), 'utf8');
  const workspaceModel = fs.readFileSync(path.join(rendererDir, 'campus-workspace-model.js'), 'utf8');
  const workspaceCss = fs.readFileSync(path.join(rendererDir, 'campus-workspace.css'), 'utf8');
  for (const id of [
    'homeScreen', 'servicePanel', 'primaryTabs', 'primaryWorkspace',
    'primaryRecent', 'primaryCatalog', 'quickCreateGroup',
    'serviceViewGrid', 'servicePager', 'groupDialog',
  ]) assert.match(workspaceHtml, new RegExp(`id="${id}"`, 'u'));
  for (const retired of [
    'manageScreen', 'resourcePool', 'manageFolderNav', 'managePager', 'createGroup"',
    'backToServices', 'secondaryNavigation', 'secondarySelect', 'serviceViewTabs',
  ]) assert.doesNotMatch(workspaceHtml, new RegExp(`id="${retired}`, 'u'),
    `${retired} stayed deleted with the detached manage screen (DESIGN.md §2)`);
  for (const id of [
    'workspaceCardBoard', 'workspaceCardBoardCatalog', 'workspaceCardBoardPersonal',
    'workspaceCatalogBoardHost', 'workspacePersonalBoardHost',
  ]) assert.match(workspaceHtml, new RegExp(`id="${id}"`, 'u'));
  assert.doesNotMatch(workspaceHtml, /workspace-header|workspace-command|id="workspaceSearch"|id="manageRules"/u);
  assert.match(workspaceModel, /SCREENS[\s\S]*home[\s\S]*manage/u);
  assert.doesNotMatch(workspaceModel, /SCREENS[^\n]*catalog/u);
  assert.match(workspaceModel, /TASK_CATEGORIES[\s\S]*id:\s*'courses'[\s\S]*categoryOf/u);
  assert.match(workspaceJs, /command\('open-resource',\s*\{\s*resourceId:/u);
  assert.match(workspaceJs, /mutate\('toggle-favorite',\s*\{\s*resourceId:/u);
  assert.match(workspaceJs, /campusWorkspace\?\.request\(name, payload\)/u);
  assert.match(workspaceJs, /workspaceMutationFeedback[\s\S]*role', 'alert'/u);
  assert.match(workspaceJs, /command\('focus-address'\)/u);
  assert.match(workspaceJs, /workspaceBoardFeature\.toggleEdit\(\)/u);
  assert.doesNotMatch(workspaceJs, /\$\('openManage'\)[\s\S]{0,160}normalizeNavigation\(\{\s*screen:\s*'manage'/u);
  assert.doesNotMatch(workspaceJs, /window\.open|location\.href|resource\.url/u);
  assert.match(workspaceCss, /\.surface\s*\{[^}]*background:\s*var\(--workspace-surface\)/u);
  assert.match(workspaceCss, /@media\s*\(min-width:\s*1100px\)[\s\S]*repeat\(3/u);
  assert.match(workspaceCss, /\.resource-icon\s*\{[^}]*width:\s*36px[^}]*height:\s*36px/u);
  assert.match(workspaceCss, /@media\s*\(max-width:\s*759px\)[\s\S]*grid-template-columns:\s*1fr/u);
  assert.match(workspaceCss, /body\s*\{[^}]*overflow:\s*auto/u);
  assert.match(workspaceCss, /\.pager-range[\s\S]*\.pager-button/u);
});

test('notifications keep a compact state summary and raw diagnostics collapsed', () => {
  assert.match(html, /id="notificationCard"/u);
  assert.doesNotMatch(html, /class="help-section"/u);
  assert.match(html, /<details class="diagnostic-details">/u);
  assert.doesNotMatch(html, /<details class="diagnostic-details"[^>]*open/u);
});

test('connected status remains static instead of continuously repainting Electron', () => {
  assert.match(css, /\.conn-status\.on\s*\{[^}]*color:\s*var\(--ok\)/);
  assert.doesNotMatch(css, /\.conn-status\.on\s+\.dot\s*\{[^}]*animation:/);
  assert.doesNotMatch(css, /@keyframes\s+ping/);
});

test('update download uses one stable delegated listener', () => {
  assert.match(appJs, /\$\('updateHint'\)\.addEventListener\('click'/);
  assert.match(appJs, /event\.target\?\.closest\?\.\('#updateDownload'\)/);
  assert.doesNotMatch(appJs, /\$\('updateDownload'\)\.addEventListener/);
});
