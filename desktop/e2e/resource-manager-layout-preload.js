'use strict';

const { contextBridge } = require('electron');
const fixtureLocale = process.env.HKUSTGZ_E2E_LOCALE === 'en' ? 'en' : 'zh';
const authChallengeListeners = new Set();
let authResponseCount = 0;

function reviewedPreviewResources() {
  const payload = process.env.HKUSTGZ_CONTROL_PREVIEW_RESOURCES_JSON || '';
  if (!payload) return null;
  const document = JSON.parse(payload);
  return document.resources.map((resource) => ({
    ...resource,
    name: fixtureLocale === 'en' ? resource.localizedName?.en || resource.name : resource.name,
    description: fixtureLocale === 'en'
      ? resource.localizedDescription?.en || resource.description : resource.description,
    favorite: false,
    lastOpenedAt: null,
    reviewed: true,
    builtin: true,
  }));
}

const builtinResource = Object.freeze({
  id: 'builtin-home',
  name: fixtureLocale === 'en' ? 'Built-in School Home' : '内置学校主页',
  url: 'https://builtin.example.edu/',
  description: fixtureLocale === 'en' ? 'Built-in removal and restore fixture' : '用于内置网站删除与恢复回归',
  route: 'campus',
  category: 'campus-service',
  keywords: [],
  favorite: false,
  lastOpenedAt: null,
  builtin: true,
});
let resources = reviewedPreviewResources() || [builtinResource, ...Array.from({ length: 30 }, (_, index) => ({
  id: `fixture-${index}`,
  name: fixtureLocale === 'en' ? `Test Site ${index + 1}` : `测试网站 ${index + 1}`,
  url: `https://fixture-${index}.example.edu/`,
  description: fixtureLocale === 'en' ? 'Layout regression fixture' : '用于布局回归测试',
  route: index % 2 ? 'direct' : 'campus',
  category: index >= 18 ? [
    'gateway', 'courses', 'research', 'labs', 'student-finance', 'expenses',
    'documents', 'campus-life', 'career', 'tools', 'newcomer', 'staff',
  ][index - 18] : ['common', 'academic', 'campus-service', 'custom'][index % 4],
  keywords: [],
  favorite: index < 10,
  lastOpenedAt: index >= 10 && index < 20 ? 100 - index : null,
  reviewed: index >= 18,
  builtin: false,
}))];
let lastOpenRequest = null;
let workspaceOpenCount = 0;
let bookmarkManagerOpenCount = 0;
let nextCustomId = 1;
let pendingIntegration = null;
let cardBoardRequests = { get: 0, commit: 0, reset: 0, lastOperations: [] };

function serviceDeskFixture() {
  const payload = process.env.HKUSTGZ_CONTROL_SERVICE_DESK_JSON || '';
  if (payload) return JSON.parse(payload);
  return {
    schemaVersion: 1,
    applications: [
      { id: 'app-myportal', name: 'myPortal 官方门户', localizedName: { zh: 'myPortal 官方门户', en: 'myPortal' },
        url: 'https://myportal.hkust-gz.edu.cn/', route: 'direct', group: 'collab',
        useCase: '校园门户与通知', localizedUseCase: { zh: '校园门户与通知', en: 'Portal' },
        audience: '全体师生', localizedAudience: { zh: '全体师生', en: 'All' }, aliases: ['门户', 'portal'] },
      { id: 'app-sis', name: '学生信息系统 SIS', localizedName: { zh: '学生信息系统 SIS', en: 'SIS' },
        url: 'https://sisn.hkust-gz.edu.cn/auth-sign', route: 'direct', group: 'teach',
        useCase: '选课、成绩与学籍', localizedUseCase: { zh: '选课、成绩与学籍', en: 'Grades' },
        audience: '全体学生', localizedAudience: { zh: '全体学生', en: 'Students' }, aliases: ['成绩', '选课'] },
      { id: 'app-hpc2', name: 'HPC2 登录节点', localizedName: { zh: 'HPC2 登录节点', en: 'HPC2' },
        url: 'https://hpc2login.hpc.hkust-gz.edu.cn/', route: 'campus', group: 'teach',
        useCase: 'SSH 高性能计算入口', localizedUseCase: { zh: 'SSH 高性能计算入口', en: 'HPC over SSH' },
        audience: '科研人员', localizedAudience: { zh: '科研人员', en: 'Researchers' }, aliases: ['hpc', 'hpc2', '超算'] },
    ],
    serviceItems: [
      { id: 'svc-reimbursement', name: '采购与报销申请', localizedName: { zh: '采购与报销申请', en: 'Reimbursement' },
        url: 'https://pbms.hkust-gz.edu.cn/', route: 'campus', group: 'research',
        useCase: '科研项目经费报销与采购', localizedUseCase: { zh: '科研项目经费报销与采购', en: 'Expense claims' },
        audience: '科研项目负责人 / 成员', localizedAudience: { zh: '科研项目负责人 / 成员', en: 'Project members' },
        aliases: ['报销', '采购', 'pbms'] },
      { id: 'svc-certificate', name: '在读证明', localizedName: { zh: '在读证明', en: 'Enrollment Certificate' },
        url: 'https://acad-edoc.hkust-gz.edu.cn/index', route: 'direct', group: 'academic',
        useCase: '开具在读身份证明', localizedUseCase: { zh: '开具在读身份证明', en: 'Enrollment certificate' },
        audience: '本科生 / 研究生', localizedAudience: { zh: '本科生 / 研究生', en: 'Students' },
        aliases: ['在读', '证明', '在读证明'] },
    ],
  };
}
let routingRules = [
  { host: 'login.example.com', includeSubdomains: false, route: 'direct', updatedAt: 2 },
];

const integrationAdapters = [
  'clash_mihomo_yaml', 'vscode_remote_ssh',
];

function integrationViews() {
  return integrationAdapters.map((adapterId) => ({
    schemaVersion: 1,
    adapterId,
    compatibilityState: 'supported',
    bindingState: 'not-installed',
    supportedActions: adapterId === 'vscode_remote_ssh' ? ['copy'] : ['copy', 'save'],
    updatedAt: null,
  }));
}

function normalizeFixtureUrl(value) {
  const source = String(value || '').trim();
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(source) ? source : `https://${source}`;
  return new URL(candidate).href;
}

const state = {
  locale: fixtureLocale,
  authChallenge: process.env.HKUSTGZ_E2E_INITIAL_AUTH === '1' ? {
    kind:'otp', maskedDestination:'s***@example.test', attemptsRemaining:3,
    expiresAtUnixMs:null, resendAvailable:true, resendAfterUnixMs:null,
  } : null,
  loggedIn: true,
  settings: {
    port: 1080,
    strictProxyAuth: true,
    autoReconnect: true,
    maxAttempts: 3,
    closeAction: 'ask',
    underlaySourceAddress: '',
  },
  networkEnvironment: {
    schemaVersion: 2,
    platform: 'linux',
    status: 'ready',
    interfaces: [
      { id: 'eth0', name: 'Ethernet', kind: 'physical', active: true, default: true,
        systemDefault: false, addresses: [{ address: '192.0.2.20', family: 4, internal: false, selectable: true,
          publicEgress: { status: 'ready', address: '203.76.12.45', family: 4,
            binding: 'source-address', provider: 'ipify', observedAt: 1_800_000_000_000,
            relation: 'baseline', reason: '' } }] },
      { id: 'tun0', name: 'Mihomo TUN', kind: 'virtual', active: true, default: false,
        systemDefault: true, addresses: [{ address: '198.18.0.1', family: 4, internal: false, selectable: true,
          publicEgress: { status: 'ready', address: '104.16.1.40', family: 4,
            binding: 'source-address', provider: 'ipify', observedAt: 1_800_000_000_000,
            relation: 'different', reason: '' } }] },
    ],
    defaultRoute: { interfaceId: 'eth0', sourceAddress: '192.0.2.20' },
    systemRoute: { interfaceId: 'tun0', sourceAddress: '198.18.0.1' },
    systemProxy: { state: 'detected', type: 'http', endpoint: { host: '127.0.0.1', port: 7890 },
      owner: { provider: 'mihomo', name: 'Mihomo / Clash', mode: 'rule', tunEnabled: true,
        confidence: 'confirmed' } },
    selection: { mode: 'default', interfaceId: 'eth0', sourceAddress: '', available: true },
  },
  campusResources: resources,
  serviceDesk: serviceDeskFixture(),
  resourceGroups: [
    { id: 'group_abcdefghijkl', name: '学习', resourceIds: ['fixture-0', 'fixture-1'] },
    { id: 'group_mnopqrstuvwx', name: '常用工具', resourceIds: ['fixture-2', 'fixture-3'] },
    { id: 'group_research12345', name: '科研协作', resourceIds: ['fixture-4', 'fixture-5'] },
    { id: 'group_expenses1234', name: '报销采购', resourceIds: ['fixture-6', 'fixture-7'] },
    { id: 'group_campuslife12', name: '校园生活', resourceIds: ['fixture-8'] },
    { id: 'group_adminservice', name: '行政办事', resourceIds: ['fixture-9'] },
  ],
  connected: false,
  connecting: false,
  clientIp: null,
  lastError: null,
  version: 'test',
  pacUrl: '',
};

function campusDataSnapshot() {
  const checkedAt = Date.now();
  const emptySchedule = process.env.HKUSTGZ_E2E_EMPTY_SCHEDULE === '1';
  const module = (source) => ({
    state: 'not-authenticated', source, fetchedAt: checkedAt, stale: false, items: [],
  });
  return {
    schemaVersion: 1,
    checkedAt,
    portalUrl: 'https://myportal.hkust-gz.edu.cn/',
    sessionState: emptySchedule ? 'authenticated' : 'unauthenticated',
    modules: {
      schedule: emptySchedule ? { ...module('synthetic-calendar'), state: 'empty' } : module('myportal-session'),
      loans: module('myportal-session'),
      news: { ...module('official-api-not-configured'), state: 'source-unavailable' },
    },
  };
}

const officialCategoryIds = [...new Set(resources.filter(({ reviewed }) => reviewed)
  .map(({ category }) => category))];
const cloneCardBoardDocument = (document) => JSON.parse(JSON.stringify(document));
function placement(boardId, kind, id, order) {
  return {
    placementId: `fixture-${boardId}-${kind}-${id}`,
    boardId,
    card: { kind, id },
    deckId: null,
    order,
    size: 'small',
    hidden: false,
  };
}
const catalogPlacements = officialCategoryIds.map((id, order) => (
  placement('browser-catalog', 'official-category', id, order)
));
const firstDeck = catalogPlacements.length >= 2 ? {
  deckId: 'fixture-deck-catalog-primary',
  boardId: 'browser-catalog',
  placementIds: catalogPlacements.slice(0, 2).map(({ placementId }) => placementId),
  activePlacementId: catalogPlacements[0].placementId,
  order: 0,
} : null;
if (firstDeck) {
  firstDeck.placementIds.forEach((placementId, order) => {
    const target = catalogPlacements.find((candidate) => candidate.placementId === placementId);
    target.deckId = firstDeck.deckId;
    target.order = order;
  });
  catalogPlacements.slice(2).forEach((target, index) => { target.order = index + 1; });
}
const personalPlacements = state.resourceGroups.map(({ id }, order) => (
  placement('browser-personal', 'user-collection', id, order)
));
const personalDeck = personalPlacements.length >= 2 ? {
  deckId: 'fixture-deck-personal-primary',
  boardId: 'browser-personal',
  placementIds: personalPlacements.slice(0, 2).map(({ placementId }) => placementId),
  activePlacementId: personalPlacements[1].placementId,
  order: 0,
} : null;
if (personalDeck) {
  personalDeck.placementIds.forEach((placementId, order) => {
    const target = personalPlacements.find((candidate) => candidate.placementId === placementId);
    target.deckId = personalDeck.deckId;
    target.order = order;
  });
  personalPlacements.slice(2).forEach((target, index) => { target.order = index + 1; });
}
const initialCardBoardDocument = {
  schemaVersion: 1,
  revision: 0,
  placements: [
    ...catalogPlacements,
    ...personalPlacements,
    placement('connect', 'system-widget', 'connection-metrics', 0),
    placement('connect', 'system-widget', 'network-adapter', 1),
    placement('connect', 'system-widget', 'connection-details', 2),
  ],
  decks: [firstDeck, personalDeck].filter(Boolean),
};
let cardBoardDocument = cloneCardBoardDocument(initialCardBoardDocument);

contextBridge.exposeInMainWorld('api', {
  getState: async () => state,
  getNetworkEnvironment: async () => state.networkEnvironment,
  getCampusData: async () => campusDataSnapshot(),
  refreshCampusData: async () => campusDataSnapshot(),
  refreshCampusSchedule: async () => campusDataSnapshot(),
  save: async (patch) => {
    state.settings = { ...state.settings, ...(patch || {}) };
    if (Object.hasOwn(patch || {}, 'underlaySourceAddress')) {
      const selected = state.networkEnvironment.interfaces.find((item) => item.addresses.some(({ address }) => (
        address === patch.underlaySourceAddress
      )));
      state.networkEnvironment.selection = selected ? { mode: 'selected', interfaceId: selected.id,
        sourceAddress: patch.underlaySourceAddress, available: true } :
        { mode: 'default', interfaceId: 'eth0', sourceAddress: '', available: true };
    }
    return { ok: true, settings: state.settings };
  },
  connect: async () => ({ ok: true }),
  disconnect: async () => ({ ok: true }),
  reconnect: async () => ({ ok: true }),
  logout: async () => ({ ok: true }),
  clearBrowserData: async () => ({ ok: true }),
  getLogs: async () => '',
  openLog: async () => ({ ok: true }),
  copy: async () => ({ ok: true }),
  openCampusBrowser: async (request) => {
    if (request == null) workspaceOpenCount += 1;
    lastOpenRequest = request;
    return { ok: true };
  },
  openBookmarkManager: async () => {
    bookmarkManagerOpenCount += 1;
    return { ok: true };
  },
  openResource: async (resourceId) => {
    lastOpenRequest = { resourceId };
    resources = resources.map((resource) => (
      resource.id === resourceId ? { ...resource, lastOpenedAt: Date.now() } : resource
    ));
    return { ok: true, resourceId, resources };
  },
  getCardBoardLayout: async () => {
    cardBoardRequests = { ...cardBoardRequests, get: cardBoardRequests.get + 1 };
    return { ok: true, document: cloneCardBoardDocument(cardBoardDocument) };
  },
  commitCardBoardLayout: async ({ baseRevision, operations }) => {
    if (baseRevision !== cardBoardDocument.revision) {
      return { ok: false, code: 'CARD_BOARD_REVISION_CONFLICT' };
    }
    cardBoardDocument.revision += 1;
    cardBoardRequests = {
      ...cardBoardRequests,
      commit: cardBoardRequests.commit + 1,
      lastOperations: structuredClone(operations),
    };
    return { ok: true, changed: operations.length > 0 };
  },
  resetCardBoardLayout: async ({ baseRevision }) => {
    if (baseRevision !== cardBoardDocument.revision) {
      return { ok: false, code: 'CARD_BOARD_REVISION_CONFLICT' };
    }
    cardBoardDocument = { ...cloneCardBoardDocument(initialCardBoardDocument),
      revision: cardBoardDocument.revision + 1 };
    cardBoardRequests = { ...cardBoardRequests, reset: cardBoardRequests.reset + 1 };
    return { ok: true, document: cloneCardBoardDocument(cardBoardDocument), changed: true };
  },
  saveResource: async (resource) => {
    const saved = {
      ...resource,
      id: resource.id || `custom-test-${nextCustomId++}`,
      url: normalizeFixtureUrl(resource.url),
      route: resource.route || 'campus',
      builtin: false,
      category: 'custom',
      keywords: [],
      favorite: false,
      lastOpenedAt: null,
    };
    resources = [...resources.filter((item) => item.id !== saved.id), saved];
    return { ok: true, resource: saved, resources };
  },
  createFavoriteResource: async (resource) => {
    const saved = {
      id: `custom-test-${nextCustomId++}`,
      name: resource.name,
      url: normalizeFixtureUrl(resource.url),
      description: resource.description || '',
      routePreference: 'auto',
      route: resource.routePreference === 'direct' ? 'direct' : 'campus',
      builtin: false,
      category: 'custom',
      keywords: [],
      favorite: true,
      lastOpenedAt: null,
    };
    resources = [...resources, saved];
    state.campusResources = resources;
    if (resource.groupId) {
      state.resourceGroups = state.resourceGroups.map((group) => group.id === resource.groupId
        ? { ...group, resourceIds: [...group.resourceIds, saved.id] } : group);
    }
    return { ok: true, resource: saved, resources, groups: state.resourceGroups,
      affectedResourceIds: [] };
  },
  deleteResource: async (resourceId) => {
    resources = resources.filter((resource) => resource.id !== resourceId);
    return { ok: true, resources };
  },
  restoreBuiltinResources: async () => {
    if (!resources.some((resource) => resource.id === builtinResource.id)) {
      resources = [builtinResource, ...resources];
    }
    return { ok: true, resources };
  },
  reorderResources: async () => ({ ok: true, resources }),
  toggleResourceFavorite: async (resourceId) => {
    resources = resources.map((resource) => (
      resource.id === resourceId ? { ...resource, favorite: !resource.favorite } : resource
    ));
    state.campusResources = resources;
    return { ok: true, resources };
  },
  createFavoriteGroup: async (name) => {
    const group = { id: `group_mock${state.resourceGroups.length}xyzw`, name, resourceIds: [] };
    state.resourceGroups = [...state.resourceGroups, group];
    return { ok: true, groups: state.resourceGroups };
  },
  renameFavoriteGroup: async (groupId, name) => {
    state.resourceGroups = state.resourceGroups.map((group) => (
      group.id === groupId ? { ...group, name } : group));
    return { ok: true, groups: state.resourceGroups };
  },
  moveFavoriteResource: async ({ resourceId, groupId }) => {
    state.resourceGroups = state.resourceGroups.map((group) => ({
      ...group,
      resourceIds: group.id === groupId
        ? [...group.resourceIds.filter((id) => id !== resourceId), resourceId]
        : group.resourceIds.filter((id) => id !== resourceId),
    }));
    return { ok: true, groups: state.resourceGroups };
  },
  listRoutingRules: async () => ({ ok: true, rules: routingRules }),
  previewRoutingTarget: async (target) => {
    try {
      const input = String(target || '').trim();
      const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(input) ? input : `https://${input}`);
      return { ok: true, target: { host: parsed.hostname.toLowerCase(), inputKind: 'url',
        discardedPort: !!parsed.port, discardedPath: parsed.pathname !== '/' },
      resolution: { route: parsed.hostname.endsWith('.example.com') ? 'direct' : 'campus',
        source: 'default', matchedRule: null } };
    } catch { return { ok: false, error: 'invalid target' }; }
  },
  saveRoutingRule: async (rule) => {
    const input = String(rule.target || rule.host || '').trim();
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(input) ? input : `https://${input}`);
    const host = parsed.hostname.toLowerCase();
    if (rule.previous) routingRules = routingRules.filter((item) => !(
      item.host === rule.previous.host && item.includeSubdomains === rule.previous.includeSubdomains
    ));
    routingRules = [...routingRules.filter((item) => !(
      item.host === host && item.includeSubdomains === rule.includeSubdomains
    )), { host, includeSubdomains: rule.includeSubdomains,
      route: rule.route, updatedAt: Date.now() }];
    return { ok: true, rules: routingRules };
  },
  deleteRoutingRule: async (identity) => {
    routingRules = routingRules.filter((item) => !(
      item.host === identity.host && item.includeSubdomains === identity.includeSubdomains
    ));
    return { ok: true, rules: routingRules };
  },
  onOpenRoutingRules: () => {},
  listIntegrations: async () => ({ ok: true, integrations: integrationViews() }),
  prepareIntegration: async ({ adapterId, action }) => {
    if (!integrationAdapters.includes(adapterId)) {
      return { ok: false, code: 'INTEGRATION_ADAPTER_UNAVAILABLE' };
    }
    const confirmationHandle = `export-${'ab'.repeat(16)}`;
    pendingIntegration = { adapterId, action, confirmationHandle };
    return {
      ok: true,
      preview: {
        schemaVersion: 1,
        adapterId,
        action,
        confirmationHandle,
        expiresAt: Date.now() + 10_000,
        changes: { create: 0, replace: 0, remove: 0, unchanged: 0 },
        byteLength: 512,
        ruleCount: 2,
        containsLocalProxyCredential: true,
        warningCodes: ['INTEGRATION_LOCAL_CREDENTIAL_PRIVATE'],
      },
    };
  },
  confirmIntegration: async ({ confirmationHandle }) => {
    if (!pendingIntegration || pendingIntegration.confirmationHandle !== confirmationHandle) {
      return { ok: false, code: 'INTEGRATION_TARGET_CHANGED' };
    }
    pendingIntegration = null;
    return { ok: true };
  },
  cancelIntegration: async () => {
    pendingIntegration = null;
    return { ok: true, cancelled: true };
  },
  resize: async () => ({ ok: true }),
  respondAuthChallenge: async () => { authResponseCount += 1; return { ok: true }; },
  resendAuthChallenge: async () => ({ ok: true }),
  cancelAuthChallenge: async () => ({ ok: true }),
  listSchoolProfiles: async () => ({ ok: true, activeProfileId: 'hkustgz', profiles: [] }),
  probeCustomGateway: async () => ({ ok: false, error: 'not available in fixture' }),
  confirmCustomGateway: async () => ({ ok: false, error: 'not available in fixture' }),
  cancelCustomGateway: async () => false,
  deleteSchoolProfile: async () => ({ ok: false, error: 'not available in fixture' }),
  switchSchoolProfile: async () => ({ ok: false, error: 'not available in fixture' }),
  onStatus: () => {},
  onTelemetry: () => {},
  onNetworkEnvironment: () => {},
  onAuthChallenge: (listener) => {
    authChallengeListeners.add(listener);
    return () => authChallengeListeners.delete(listener);
  },
  testEmitAuthChallenge: (challenge) => {
    for (const listener of authChallengeListeners) listener(challenge);
    return { listeners: authChallengeListeners.size, responseCount: authResponseCount };
  },
  testState: () => ({ lastOpenRequest, workspaceOpenCount, bookmarkManagerOpenCount,
    resources, resourceGroups: state.resourceGroups, cardBoardRequests,
    cardBoardDocument: cloneCardBoardDocument(cardBoardDocument) }),
});
