'use strict';

const {
  NEUTRAL_CAMPUS_PARTITION,
  ROUTE_CAMPUS,
  ROUTE_DIRECT,
} = require('../../routing/policy/campus-route');
const { buildDomainRoutePac, resolveDomainRouteForUrl } = require('../../routing/policy/domain-route-policy');
const { isUnsafeBrowserTargetUrl } = require('../../routing/policy/host-safety');
const { normalizeRuleHost } = require('../../routing/rules/routing-rule-store');
const {
  hkustPortalCatalogSource,
  normalizePortalCatalog,
  portalCatalogState,
} = require('./myportal-catalog');

const requestBoundaryGates = new WeakMap();
const DAY_MS = 86_400_000;
const CAMPUS_OFFSET_MS = 28_800_000;

function calendarWeekQuery(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['date', 'force'].includes(key)) ||
      typeof value.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value.date) ||
      (value.force !== undefined && typeof value.force !== 'boolean')) {
    throw new TypeError('calendar selection must contain only a valid date and optional force');
  }
  const date = new Date(`${value.date}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value.date) {
    throw new TypeError('calendar date is invalid');
  }
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  const start = date.getTime() - CAMPUS_OFFSET_MS;
  return Object.freeze({ date: value.date, force: value.force === true,
    start, end: start + 7 * DAY_MS });
}

const CAMPUS_REQUEST_FILTER = Object.freeze({
  // Deliberately omit `types`: the boundary applies to main frames and every
  // subresource type, including fetch/XHR, WebSocket upgrades, media, and CSP.
  urls: Object.freeze(['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*']),
});
const FAIL_CLOSED_PROXY = 'PROXY 0.0.0.0:0';
const FAIL_CLOSED_PAC = `'use strict';\nfunction FindProxyForURL() { return "${FAIL_CLOSED_PROXY}"; }\n`;

function normalizeProxyPort(port) {
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1025 || value > 65535) {
    throw new Error('本地代理端口无效');
  }
  return value;
}

function campusProxyConfig(port) {
  const value = normalizeProxyPort(port);
  return {
    mode: 'fixed_servers',
    proxyRules: `socks5://127.0.0.1:${value}`,
    proxyBypassRules: '<-loopback>',
  };
}

function pacDataUrl(source) {
  return `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(source).toString('base64')}`;
}

function failClosedProxyConfig() {
  return {
    mode: 'pac_script',
    pacScript: pacDataUrl(FAIL_CLOSED_PAC),
    proxyBypassRules: '<-loopback>',
  };
}

function createMemoryRoutingPolicy() {
  let userRules = [];
  return {
    list: () => userRules.map((rule) => ({ ...rule })),
    resolve: (url, inheritedRoute = null) => resolveDomainRouteForUrl(url, {
      userRules,
      inheritedRoute,
    }),
    upsert(payload) {
      const host = normalizeRuleHost(payload?.host);
      const includeSubdomains = payload?.includeSubdomains === true;
      const route = payload?.route;
      if (![ROUTE_CAMPUS, ROUTE_DIRECT].includes(route)) throw new Error('浏览器网络路径无效');
      const rule = { host, includeSubdomains, route, updatedAt: Date.now() };
      userRules = [rule, ...userRules.filter((candidate) => !(
        candidate.host === host && candidate.includeSubdomains === includeSubdomains
      ))];
      return { rule, rules: userRules.map((candidate) => ({ ...candidate })) };
    },
    remove(payload) {
      const host = normalizeRuleHost(payload?.host);
      const includeSubdomains = payload?.includeSubdomains === true;
      userRules = userRules.filter((candidate) => !(
        candidate.host === host && candidate.includeSubdomains === includeSubdomains
      ));
      return userRules.map((candidate) => ({ ...candidate }));
    },
    proxyConfig(port) {
      return {
        mode: 'pac_script',
        pacScript: pacDataUrl(buildDomainRoutePac({ userRules }, port)),
        proxyBypassRules: '<-loopback>',
      };
    },
  };
}

// A campus web page is untrusted content. Nothing it renders needs the camera,
// microphone, location, notifications, or a USB/serial device, so every request
// is refused without prompting the user.
function applyCampusSessionPolicy(campusSession, ensureRequestReady = null) {
  if (!campusSession || typeof campusSession !== 'object') {
    throw new Error('校园浏览器 Session 无效');
  }
  if (typeof campusSession.setPermissionRequestHandler === 'function') {
    campusSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  }
  if (typeof campusSession.setPermissionCheckHandler === 'function') {
    campusSession.setPermissionCheckHandler(() => false);
  }
  if (typeof campusSession.setDevicePermissionHandler === 'function') {
    campusSession.setDevicePermissionHandler(() => false);
  }
  applyCampusRequestBoundary(campusSession, ensureRequestReady);
  return campusSession;
}

function applyCampusRequestBoundary(campusSession, ensureRequestReady = null) {
  if (!campusSession || typeof campusSession !== 'object' ||
      typeof campusSession.webRequest?.onBeforeRequest !== 'function' ||
      requestBoundaryGates.has(campusSession)) {
    return campusSession;
  }
  const gate = {
    blocked: false,
    epoch: 1,
    ensureRequestReady: typeof ensureRequestReady === 'function' ? ensureRequestReady : null,
  };
  campusSession.webRequest.onBeforeRequest(CAMPUS_REQUEST_FILTER, (details, callback) => {
    if (gate.blocked || isUnsafeBrowserTargetUrl(details?.url)) {
      callback({ cancel: true });
      return;
    }
    if (!gate.ensureRequestReady) {
      callback({ cancel: false });
      return;
    }
    const epoch = gate.epoch;
    Promise.resolve().then(() => gate.ensureRequestReady(details?.url)).then(
      (ready) => callback({
        cancel: ready !== true || gate.blocked || gate.epoch !== epoch,
      }),
      () => callback({ cancel: true }),
    );
  });
  requestBoundaryGates.set(campusSession, gate);
  return campusSession;
}

function setCampusRequestBlocked(campusSession, blocked) {
  const gate = requestBoundaryGates.get(campusSession);
  if (!gate) return false;
  gate.epoch += 1;
  gate.blocked = blocked === true;
  return true;
}

function campusRequestsBlocked(campusSession) {
  return requestBoundaryGates.get(campusSession)?.blocked === true;
}

function validatePacProxyConfig(config) {
  if (!config || config.mode !== 'pac_script' || typeof config.pacScript !== 'string' ||
      !config.pacScript || config.proxyBypassRules !== '<-loopback>') {
    throw new Error('校园浏览器 PAC 配置无效');
  }
  return config;
}

class BrowserSessionManager {
  constructor({
    session,
    routingPolicy,
    partition = NEUTRAL_CAMPUS_PARTITION,
    onSessionReady,
    ensureRequestReady,
  } = {}) {
    if (typeof partition !== 'string' || partition.length > 96 ||
        !/^persist:[a-z0-9-]+$/u.test(partition)) {
      throw new TypeError('校园浏览器存储分区无效');
    }
    this.electronSession = session;
    this.routingPolicy = routingPolicy;
    this.partition = partition;
    this.onSessionReady = typeof onSessionReady === 'function' ? onSessionReady : null;
    this.ensureRequestReady = typeof ensureRequestReady === 'function' ? ensureRequestReady : null;
    this.configuredPort = null;
    this.sessionKey = '';
    this.campusSession = null;
    this.sessions = new Map();
    this.suspended = false;
    this.intentEpoch = 0;
    this.operationChain = Promise.resolve();
  }

  serialize(operation) {
    const next = this.operationChain.then(operation, operation);
    this.operationChain = next.catch(() => {});
    return next;
  }

  async policyProxyConfig(port) {
    if (!this.routingPolicy || typeof this.routingPolicy.proxyConfig !== 'function') {
      throw new Error('校园浏览器路由策略无效');
    }
    return validatePacProxyConfig(await this.routingPolicy.proxyConfig(normalizeProxyPort(port)));
  }

  sessionForRoute(route = ROUTE_CAMPUS) {
    if (![ROUTE_CAMPUS, ROUTE_DIRECT].includes(route)) return null;
    return this.sessions.get(route) || this.campusSession || null;
  }

  isCurrentIntent(epoch) {
    return epoch === this.intentEpoch;
  }

  get requestsBlocked() {
    return !this.campusSession || campusRequestsBlocked(this.campusSession);
  }

  async applyFailClosed(browserSession, epoch) {
    if (!browserSession || !this.isCurrentIntent(epoch)) return null;
    setCampusRequestBlocked(browserSession, true);
    const proxyConfig = failClosedProxyConfig();
    if (typeof browserSession.setProxy !== 'function') {
      throw new Error('校园浏览器 Session 无法进入安全暂停状态');
    }
    if (typeof browserSession.forceReloadProxyConfig !== 'function' ||
        typeof browserSession.closeAllConnections !== 'function') {
      throw new Error('校园浏览器 Session 缺少安全切换能力');
    }
    await browserSession.setProxy(proxyConfig);
    if (!this.isCurrentIntent(epoch)) return null;
    await browserSession.forceReloadProxyConfig();
    if (!this.isCurrentIntent(epoch)) return null;
    await browserSession.closeAllConnections();
    if (!this.isCurrentIntent(epoch)) return null;
    this.sessionKey = JSON.stringify(proxyConfig);
    return browserSession;
  }

  async configureNow(port, { force = false, epoch } = {}) {
    const value = normalizeProxyPort(port);
    if (!this.electronSession || typeof this.electronSession.fromPartition !== 'function') {
      throw new Error('校园浏览器 Session 不可用');
    }

    let browserSession = this.campusSession;
    if (!browserSession) {
      browserSession = applyCampusSessionPolicy(
        this.electronSession.fromPartition(this.partition),
        this.ensureRequestReady,
      );
      this.onSessionReady?.(browserSession);
    }

    // The in-process request gate is authoritative. Keep it closed for the
    // whole activation and open it only after every async step confirms that
    // no newer suspend/activation intent superseded this one.
    setCampusRequestBlocked(browserSession, true);
    const proxyConfig = await this.policyProxyConfig(value);
    if (!this.isCurrentIntent(epoch)) return null;
    const key = JSON.stringify(proxyConfig);
    if (force || this.sessionKey !== key) {
      if (typeof browserSession.setProxy !== 'function') {
        throw new Error('校园浏览器 Session 无法配置代理');
      }
      if (typeof browserSession.forceReloadProxyConfig !== 'function' ||
          typeof browserSession.closeAllConnections !== 'function') {
        throw new Error('校园浏览器 Session 缺少安全切换能力');
      }
      await browserSession.setProxy(proxyConfig);
      if (!this.isCurrentIntent(epoch)) return null;
      await browserSession.forceReloadProxyConfig();
      if (!this.isCurrentIntent(epoch)) return null;
      await browserSession.closeAllConnections();
      if (!this.isCurrentIntent(epoch)) return null;
      this.sessionKey = key;
    }

    if (!this.isCurrentIntent(epoch)) return null;

    // Chromium chooses DIRECT or the loopback proxy through PAC while cookies,
    // storage, SSO POST state, and certificate decisions stay in one Session.
    this.sessions.set(ROUTE_CAMPUS, browserSession);
    this.sessions.set(ROUTE_DIRECT, browserSession);
    this.configuredPort = value;
    this.campusSession = browserSession;
    this.suspended = false;
    setCampusRequestBlocked(browserSession, false);
    return browserSession;
  }

  configure(port, options = {}) {
    const value = normalizeProxyPort(port);
    const epoch = ++this.intentEpoch;
    if (this.campusSession) setCampusRequestBlocked(this.campusSession, true);
    return this.serialize(async () => {
      if (!this.isCurrentIntent(epoch)) return null;
      try {
        return await this.configureNow(value, { ...options, epoch });
      } catch (error) {
        if (this.isCurrentIntent(epoch)) {
          this.suspended = true;
          if (this.campusSession) setCampusRequestBlocked(this.campusSession, true);
          try { await this.applyFailClosed(this.campusSession, epoch); } catch {}
        }
        throw error;
      }
    });
  }

  // Mark the manager suspended synchronously so a configure already queued by
  // another UI action can never restore a live proxy after shutdown begins.
  // The serialized PAC update is the actual hand-off barrier: callers await it
  // before allowing the engine to release its loopback listener.
  suspend() {
    const epoch = ++this.intentEpoch;
    this.suspended = true;
    if (this.campusSession) setCampusRequestBlocked(this.campusSession, true);
    return this.serialize(async () => {
      if (!this.isCurrentIntent(epoch)) return null;
      const browserSession = this.campusSession;
      if (!browserSession) {
        this.sessionKey = '';
        return null;
      }
      return this.applyFailClosed(browserSession, epoch);
    });
  }

  resume(port = this.configuredPort) {
    return this.configure(port, { force: true });
  }
}

// Personal campus-data reads deliberately share the Campus Browser partition.
// Only bounded display projections cross IPC; credentials and raw responses
// remain owned by Chromium's Session in Main.
const CAMPUS_DATA_MODULES = Object.freeze(['schedule', 'loans', 'news']);
const CAMPUS_DATA_DAILY_CACHE_MS = 24 * 60 * 60 * 1_000;
const CAMPUS_DATA_MAX_CACHE_MS = 7 * CAMPUS_DATA_DAILY_CACHE_MS;
const CAMPUS_DATA_STATES = Object.freeze([
  'not-authenticated', 'authenticating', 'loading', 'ready', 'empty', 'forbidden',
  'session-expired', 'source-unavailable', 'tunnel-required', 'failed',
]);

function campusDataText(value, name, { maxLength = 240, optional = false } = {}) {
  if (optional && (value == null || value === '')) return null;
  if (typeof value !== 'string') throw new TypeError(`${name} must be text`);
  const result = value.trim();
  if (!result || result.length > maxLength || /[\u0000-\u001f\u007f<>]/u.test(result)) {
    throw new TypeError(`${name} has an invalid value`);
  }
  return result;
}

function campusDataUrl(value, name, { optional = false } = {}) {
  if (optional && (value == null || value === '')) return null;
  const text = campusDataText(value, name, { maxLength: 2048 });
  let parsed;
  try { parsed = new URL(text); } catch { throw new TypeError(`${name} is invalid`); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new TypeError(`${name} must be a credential-free HTTPS URL`);
  }
  return parsed.href;
}

function campusDataTimestamp(value, name, { optional = false } = {}) {
  if (optional && value == null) return null;
  if (!Number.isSafeInteger(value) || value <= 0 || !Number.isFinite(new Date(value).getTime())) {
    throw new TypeError(`${name} must be a positive millisecond timestamp`);
  }
  return value;
}

function campusDataItem(value, moduleId, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${moduleId}.items[${index}] must be an object`);
  }
  const base = {
    id: campusDataText(value.id, `${moduleId} item id`, { maxLength: 96 }),
    title: campusDataText(value.title, `${moduleId} item title`),
    url: campusDataUrl(value.url, `${moduleId} item URL`, { optional: true }),
  };
  if (moduleId === 'schedule') {
    const startsAt = campusDataTimestamp(value.startsAt, 'schedule startsAt');
    const endsAt = campusDataTimestamp(value.endsAt, 'schedule endsAt');
    if (endsAt <= startsAt) throw new TypeError('schedule interval must have positive duration');
    return Object.freeze({
      ...base,
      startsAt,
      endsAt,
      location: campusDataText(value.location, 'schedule location', { optional: true, maxLength: 120 }),
      kind: campusDataText(value.kind || 'event', 'schedule kind', { maxLength: 40 }),
    });
  }
  if (moduleId === 'loans') {
    return Object.freeze({
      ...base,
      borrowedAt: campusDataTimestamp(value.borrowedAt, 'loan borrowedAt', { optional: true }),
      dueAt: campusDataTimestamp(value.dueAt, 'loan dueAt'),
      renewable: value.renewable === true,
    });
  }
  return Object.freeze({
    ...base,
    publishedAt: campusDataTimestamp(value.publishedAt, 'news publishedAt'),
    unread: value.unread === true,
  });
}

function normalizeCampusDataModule(value, moduleId) {
  if (!CAMPUS_DATA_MODULES.includes(moduleId) || !value || typeof value !== 'object' ||
      Array.isArray(value) || !CAMPUS_DATA_STATES.includes(value.state) ||
      !Array.isArray(value.items) || value.items.length > 64) {
    throw new TypeError(`${moduleId} campus data projection is invalid`);
  }
  const items = value.items.map((item, index) => campusDataItem(item, moduleId, index));
  if (value.state === 'ready' && items.length === 0) {
    throw new TypeError(`${moduleId}.ready must contain at least one item`);
  }
  if (value.state !== 'ready' && items.length !== 0 && value.stale !== true) {
    throw new TypeError(`${moduleId} non-ready data must be explicitly stale`);
  }
  return Object.freeze({
    state: value.state,
    source: campusDataText(value.source || 'none', `${moduleId}.source`, { maxLength: 80 }),
    fetchedAt: campusDataTimestamp(value.fetchedAt, `${moduleId}.fetchedAt`, { optional: true }),
    stale: value.stale === true,
    items: Object.freeze(items),
  });
}

function campusDataModuleState(state, moduleId, source, fetchedAt) {
  return normalizeCampusDataModule({ state, source, fetchedAt, stale: false, items: [] }, moduleId);
}

function campusDataSnapshot(sessionState, checkedAt, portalUrl, modules, catalog) {
  if (!['authenticated', 'unauthenticated', 'unknown'].includes(sessionState)) {
    throw new TypeError('portal session state is unsupported');
  }
  return Object.freeze({
    schemaVersion: 1,
    checkedAt: campusDataTimestamp(checkedAt, 'checkedAt'),
    portalUrl: campusDataUrl(portalUrl, 'portalUrl'),
    sessionState,
    catalog: normalizePortalCatalog(catalog),
    modules: Object.freeze(Object.fromEntries(CAMPUS_DATA_MODULES.map((moduleId) => [
      moduleId, normalizeCampusDataModule(modules[moduleId], moduleId),
    ]))),
  });
}

function campusDataStateModules(state, source, checkedAt) {
  return Object.fromEntries(CAMPUS_DATA_MODULES.map((moduleId) => [
    moduleId, campusDataModuleState(state, moduleId, source, checkedAt),
  ]));
}

function campusDataSignedOutModules(checkedAt) {
  return {
    schedule: campusDataModuleState('not-authenticated', 'schedule', 'myportal-session', checkedAt),
    loans: campusDataModuleState('not-authenticated', 'loans', 'myportal-session', checkedAt),
    // Public campus news must not pretend to require a personal session while
    // the school's feed contract is still pending.
    news: campusDataModuleState('source-unavailable', 'news', 'official-api-not-configured', checkedAt),
  };
}

function myPortalRoot(value) {
  const parsed = new URL(campusDataUrl(value, 'portal URL'));
  parsed.pathname = '/';
  parsed.search = '';
  parsed.hash = '';
  return parsed.href;
}

function myPortalLoginRedirect(response, portalUrl) {
  if (!response || response.status < 300 || response.status >= 400) return false;
  const location = response.headers?.get?.('location');
  if (!location) return true;
  try {
    const target = new URL(location, portalUrl);
    return target.origin !== new URL(portalUrl).origin ||
      /\/(?:account\/login|connect\/authorize)(?:[/?]|$)/iu.test(target.pathname);
  } catch { return true; }
}

const HKUST_PORTAL_ORIGIN = 'https://myportal.hkust-gz.edu.cn';
const MAX_PORTAL_RESPONSE_BYTES = 512 * 1024;

function portalSourceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parsePortalJsonp(value) {
  const text = String(value || '').trim();
  if (!text || Buffer.byteLength(text, 'utf8') > MAX_PORTAL_RESPONSE_BYTES) {
    throw portalSourceError('PORTAL_RESPONSE_INVALID', 'portal response is empty or oversized');
  }
  if (text.startsWith('{') || text.startsWith('[')) return JSON.parse(text);
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  const callback = open > 0 ? text.slice(0, open).trim() : '';
  if (!/^[A-Za-z_$][A-Za-z0-9_$.]{0,95}$/u.test(callback) || close <= open) {
    throw portalSourceError('PORTAL_RESPONSE_INVALID', 'portal JSONP wrapper is invalid');
  }
  return JSON.parse(text.slice(open + 1, close));
}

function portalItems(payload) {
  if (Array.isArray(payload)) return payload;
  const preferred = [
    payload?.data?.list, payload?.data?.rows, payload?.data?.items,
    payload?.data?.events, payload?.data, payload?.list, payload?.rows,
    payload?.items, payload?.events,
  ];
  for (const value of preferred) {
    if (Array.isArray(value)) return value;
  }
  const total = payload?.data?.total ?? payload?.data?.count ?? payload?.total ?? payload?.count;
  if (Number(total) === 0) return [];
  throw portalSourceError('PORTAL_RESPONSE_INVALID', 'portal response has no bounded item list');
}

function portalScheduleItems(payload) {
  const roots = portalItems(payload);
  const nested = roots.flatMap((item) => [
    item?.list, item?.items, item?.events, item?.schedules, item?.calendarList,
  ].filter(Array.isArray).flat());
  if (nested.length) return nested;
  const direct = roots.filter((item) => portalScheduleField(item,
    ['title', 'subject', 'name', 'summary', 'eventTitle', 'eventName']));
  if (direct.length) return direct;
  if (roots.every((item) => typeof item?.day === 'string' &&
      typeof item?.isHoliday === 'boolean' && Number.isFinite(item?.teachingWeek))) return [];
  throw portalSourceError('PORTAL_RESPONSE_INVALID', 'calendar response has no event projection');
}

function portalField(item, names) {
  for (const name of names) {
    const value = item?.[name];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return null;
}

function portalScheduleField(item, names) {
  return portalField(item, names) || portalField(item?.schedule, names);
}

function portalTimestamp(value, localOffset = null) {
  if (Number.isFinite(value)) {
    const number = Number(value);
    return number > 10_000_000_000 ? Math.trunc(number) : Math.trunc(number * 1000);
  }
  const source = String(value || '').trim();
  if (!source) return null;
  const calendar = /^(\d{4})-(\d{2})-(\d{2})(?:T|\s|$)/u.exec(source);
  if (calendar) {
    const [, year, month, day] = calendar.map(Number);
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day) return null;
  }
  let normalized = source.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/u, '$1T$2');
  if (localOffset && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)?$/u.test(normalized)) {
    if (normalized.length === 10) normalized += 'T00:00:00';
    normalized += localOffset;
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function portalItemUrl(value, portalUrl) {
  if (value == null || value === '') return null;
  try {
    const parsed = new URL(String(value), portalUrl);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    return parsed.href;
  } catch { return null; }
}

function portalSessionHint(value, portalUrl) {
  if (typeof value !== 'string' || !value || value.length > 2_048) return null;
  try {
    const hint = new URL(value);
    const portal = new URL(portalUrl);
    if (hint.protocol !== 'https:' || hint.origin !== portal.origin ||
        hint.username || hint.password) return null;
    return hint.href;
  } catch { return null; }
}

async function fetchPortalJsonp(context, pathname, query, callback) {
  const target = new URL(pathname, context.portalUrl);
  for (const [name, value] of Object.entries(query)) target.searchParams.set(name, String(value));
  target.searchParams.set('callback', callback);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), context.timeoutMs || 8_000);
  timer.unref?.();
  let response;
  try {
    response = await context.session.fetch(target.href, {
      method: 'GET', credentials: 'include', redirect: 'follow', cache: 'no-store',
      headers: { Accept: '*/*' }, signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 401) throw portalSourceError('PORTAL_SESSION_EXPIRED', 'portal session expired');
  if (response.status === 403) throw portalSourceError('PORTAL_FORBIDDEN', 'portal source is forbidden');
  if (response.status === 0 || (response.status >= 300 && response.status < 400)) {
    throw portalSourceError('PORTAL_SESSION_EXPIRED', 'portal source redirected outside the portal');
  }
  if (response.status < 200 || response.status >= 300) {
    throw portalSourceError('PORTAL_RESPONSE_INVALID', 'portal source returned an unsupported status');
  }
  const length = Number(response.headers?.get?.('content-length') || 0);
  if (length > MAX_PORTAL_RESPONSE_BYTES) {
    throw portalSourceError('PORTAL_RESPONSE_INVALID', 'portal response is oversized');
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_PORTAL_RESPONSE_BYTES) {
    throw portalSourceError('PORTAL_RESPONSE_INVALID', 'portal response is oversized');
  }
  return parsePortalJsonp(text);
}

function scheduleProjection(payload, context) {
  const items = portalScheduleItems(payload);
  if (!items.length) {
    return { state: 'empty', source: 'myportal-calendar', fetchedAt: context.checkedAt,
      stale: false, items: [] };
  }
  const projected = items.slice(0, 64).map((item, index) => {
    const title = portalScheduleField(item,
      ['title', 'subject', 'name', 'summary', 'eventTitle', 'eventName']);
    const startsAt = portalTimestamp(portalScheduleField(item,
      ['startsAt', 'startTime', 'startDate', 'beginTime', 'beginDate', 'fromDate']), '+08:00');
    const endsAt = portalTimestamp(portalScheduleField(item,
      ['endsAt', 'endTime', 'endDate', 'finishTime', 'finishDate', 'toDate']), '+08:00');
    if (!title || !startsAt || !endsAt || endsAt <= startsAt) {
      throw portalSourceError('PORTAL_RESPONSE_INVALID', 'calendar item schema is unsupported');
    }
    return {
      id: String(portalScheduleField(item, ['id', 'eventId', 'calendarId', 'scheduleId']) || `schedule-${index + 1}`),
      title: String(title), startsAt, endsAt,
      location: portalScheduleField(item, ['location', 'place', 'room', 'address']),
      kind: String(portalScheduleField(item, ['kind', 'type', 'categoryName', 'source']) ||
        portalField(item?.schedule?.cateGory, ['name', 'shortName']) || 'event'),
      url: portalItemUrl(portalScheduleField(item,
        ['url', 'link', 'linkUrl', 'detailUrl']), context.portalUrl),
    };
  });
  return { state: 'ready', source: 'myportal-calendar', fetchedAt: context.checkedAt,
    stale: false, items: projected };
}

function newsProjection(payload, context) {
  const items = portalItems(payload);
  if (!items.length) {
    return { state: 'empty', source: 'myportal-news', fetchedAt: context.checkedAt,
      stale: false, items: [] };
  }
  const projected = items.slice(0, 3).map((item, index) => {
    const title = portalField(item, ['title', 'subject', 'name']);
    const publishedAt = portalTimestamp(portalField(item,
      ['publishedAt', 'publishTime', 'publishDate', 'releaseTime', 'date', 'createTime']));
    if (!title || !publishedAt) {
      throw portalSourceError('PORTAL_RESPONSE_INVALID', 'news item schema is unsupported');
    }
    return {
      id: String(portalField(item, ['id', 'articleId', 'infoId']) || `news-${index + 1}`),
      title: String(title), publishedAt, unread: false,
      url: portalItemUrl(portalField(item,
        ['linkUrl', 'articleUrl', 'mobileArticleUrl', 'url', 'link']), context.portalUrl),
    };
  });
  return { state: 'ready', source: 'myportal-news', fetchedAt: context.checkedAt,
    stale: false, items: projected };
}

const hkustMyPortalSources = Object.freeze({
  catalog: hkustPortalCatalogSource,
  schedule: Object.freeze({
    async read(context) {
      // Calendar weeks belong to the campus, independent of the host timezone.
      const campusOffsetMs = 8 * 60 * 60 * 1000;
      const campusDay = new Date((context.scheduleWeekStart ?? context.checkedAt) + campusOffsetMs);
      campusDay.setUTCHours(0, 0, 0, 0);
      campusDay.setUTCDate(campusDay.getUTCDate() - ((campusDay.getUTCDay() + 6) % 7));
      const start = new Date(campusDay.getTime() - campusOffsetMs);
      const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000 - 1);
      const payload = await fetchPortalJsonp(context,
        '/calendar/mgr/api/hkust/calendarList.rst', {
          _p: 'YXM9MiZ0PTUmZD05NyZwPTEmZj0yMiZtPU4m',
          queryType: 2,
          categoryIds: '-3,-2,1,-4',
          fromDate: start.toISOString(),
          endDate: end.toISOString(),
          type: 0,
          t: context.checkedAt,
        }, 'hkustgzConnectSchedule');
      return scheduleProjection(payload, context);
    },
  }),
  news: Object.freeze({
    async read(context) {
      const payload = await fetchPortalJsonp(context,
        '/sopplus/_web/customized/getHkustArticleList.jsp', {
          _p: 'YXQ9NSZwPTEmbT1OJg__', page: 1, pageSize: 3, wybs: 'news',
        }, 'hkustgzConnectNews');
      return newsProjection(payload, context);
    },
  }),
});

class MyPortalDataRuntime {
  constructor({ electronSession, getPartition, getPortalUrl, getSources = () => ({}),
    getSessionUrlHint = () => null, now = Date.now,
    cacheMs = CAMPUS_DATA_DAILY_CACHE_MS, timeoutMs = 8_000 } = {}) {
    if (!electronSession || typeof electronSession.fromPartition !== 'function' ||
        typeof getPartition !== 'function' || typeof getPortalUrl !== 'function' ||
        typeof getSources !== 'function' || typeof getSessionUrlHint !== 'function' ||
        typeof now !== 'function') {
      throw new TypeError('myPortal data runtime dependencies are incomplete');
    }
    if (!Number.isSafeInteger(cacheMs) || cacheMs < 0 || cacheMs > CAMPUS_DATA_MAX_CACHE_MS ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 30_000) {
      throw new TypeError('myPortal data runtime timing is invalid');
    }
    Object.assign(this, { electronSession, getPartition, getPortalUrl, getSources, getSessionUrlHint,
      now, cacheMs, timeoutMs });
    this.cached = null;
    this.inflight = null;
    this.calendarCache = new Map();
    this.calendarEpoch = 0;
    this.calendarInflight = new Map();
    this.contextKey = null;
  }

  captureContext() {
    const portalUrl = myPortalRoot(this.getPortalUrl());
    const partition = this.getPartition();
    if (typeof partition !== 'string' || partition.length > 96 || !/^persist:[a-z0-9-]+$/u.test(partition)) {
      throw new TypeError('portal browser partition is invalid');
    }
    const key = JSON.stringify([partition, portalUrl]);
    if (key !== this.contextKey) { this.invalidate(); this.contextKey = key; }
    return Object.freeze({ key, partition, portalUrl, epoch: this.calendarEpoch });
  }

  assertContext(context) {
    let current = false;
    try {
      current = context.epoch === this.calendarEpoch && context.partition === this.getPartition() &&
        context.portalUrl === myPortalRoot(this.getPortalUrl());
    } catch {}
    if (!current) throw Object.assign(new Error('portal data context changed'), { code: 'PORTAL_CONTEXT_CHANGED' });
  }

  cacheFresh(value) {
    const age = this.now() - value?.checkedAt;
    return Number.isFinite(age) && age >= 0 && age < this.cacheMs;
  }

  async probeSession(targetSession, portalUrl, signal) {
    if (typeof targetSession?.fetch !== 'function') {
      return Object.freeze({ state: 'unknown', sessionUrl: portalUrl });
    }
    const response = await targetSession.fetch(portalUrl, {
      method: 'GET', credentials: 'include', redirect: 'follow', cache: 'no-store',
      headers: { Accept: 'text/html,application/xhtml+xml' }, signal,
    });
    let finalUrl;
    try { finalUrl = new URL(response.url || portalUrl); }
    catch { return Object.freeze({ state: 'unknown', sessionUrl: portalUrl }); }
    const portal = new URL(portalUrl);
    if (response.status === 401 || /\/(?:account\/login)(?:[/?]|$)/iu.test(finalUrl.pathname)) {
      return Object.freeze({ state: 'unauthenticated', sessionUrl: portalUrl });
    }
    if (response.status >= 200 && response.status < 300 && finalUrl.origin === portal.origin) {
      return Object.freeze({ state: 'authenticated', sessionUrl: finalUrl.href });
    }
    if (myPortalLoginRedirect(response, portalUrl)) {
      return Object.freeze({ state: 'unauthenticated', sessionUrl: portalUrl });
    }
    return Object.freeze({ state: 'unknown', sessionUrl: portalUrl });
  }

  async readNow({ moduleId = null, scheduleWeekStart = null } = {}) {
    if (moduleId !== null && !CAMPUS_DATA_MODULES.includes(moduleId)) {
      throw new TypeError('campus data module refresh is invalid');
    }
    const checkedAt = this.now();
    const requestContext = this.captureContext();
    const { portalUrl, partition } = requestContext;
    const cachedBase = this.cached;
    const targetSession = this.electronSession.fromPartition(partition);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    let hint = null;
    try { hint = portalSessionHint(this.getSessionUrlHint(), portalUrl); } catch {}
    let probe = hint
      ? Object.freeze({ state: 'authenticated', sessionUrl: hint })
      : Object.freeze({ state: 'unknown', sessionUrl: portalUrl });
    try { if (!hint) probe = await this.probeSession(targetSession, portalUrl, controller.signal); }
    catch { probe = Object.freeze({ state: 'unknown', sessionUrl: portalUrl }); }
    finally { clearTimeout(timer); }
    this.assertContext(requestContext);
    const sessionState = probe.state;
    if (sessionState === 'unauthenticated') {
      return campusDataSnapshot(sessionState, checkedAt, portalUrl,
        campusDataSignedOutModules(checkedAt), portalCatalogState('not-authenticated', checkedAt));
    }
    if (sessionState !== 'authenticated') {
      return campusDataSnapshot(sessionState, checkedAt, portalUrl,
        campusDataStateModules('source-unavailable', 'myportal-session', checkedAt),
        portalCatalogState('source-unavailable', checkedAt));
    }
    const sources = this.getSources() || {};
    // sessionUrl can carry the portal's short-lived routing nonce. It remains
    // inside Main and is never included in the Renderer snapshot.
    const context = Object.freeze({
      session: targetSession, portalUrl, sessionUrl: probe.sessionUrl,
      checkedAt, timeoutMs: this.timeoutMs, scheduleWeekStart,
    });
    const errorState = (error) => error?.code === 'PORTAL_SESSION_EXPIRED' ? 'session-expired'
      : error?.code === 'PORTAL_FORBIDDEN' ? 'forbidden'
        : error?.code === 'PORTAL_TUNNEL_REQUIRED' ? 'tunnel-required' : 'failed';
    const requestedModules = moduleId ? [moduleId] : CAMPUS_DATA_MODULES;
    const baseModules = moduleId && cachedBase?.sessionState === 'authenticated'
      ? { ...cachedBase.modules }
      : campusDataStateModules('source-unavailable', 'official-api-not-configured', checkedAt);
    const entriesPromise = Promise.all(requestedModules.map(async (requestedModuleId) => {
      const source = sources[requestedModuleId];
      if (!source || typeof source.read !== 'function') {
        return [requestedModuleId, campusDataModuleState('source-unavailable', requestedModuleId,
          'official-api-not-configured', checkedAt)];
      }
      try {
        return [requestedModuleId, normalizeCampusDataModule(
          await source.read(Object.freeze({ ...context, moduleId: requestedModuleId })),
          requestedModuleId,
        )];
      } catch (error) {
        return [requestedModuleId, campusDataModuleState(
          errorState(error), requestedModuleId, 'official-api', checkedAt,
        )];
      }
    }));
    const catalogPromise = (async () => {
      if (moduleId) {
        return cachedBase?.sessionState === 'authenticated'
          ? cachedBase.catalog : portalCatalogState('source-unavailable', checkedAt);
      }
      if (!sources.catalog || typeof sources.catalog.read !== 'function') {
        return portalCatalogState('source-unavailable', checkedAt);
      }
      try { return normalizePortalCatalog(await sources.catalog.read(context)); }
      catch (error) { return portalCatalogState(errorState(error), checkedAt); }
    })();
    const [entries, catalog] = await Promise.all([entriesPromise, catalogPromise]);
    this.assertContext(requestContext);
    return campusDataSnapshot(
      sessionState, checkedAt, portalUrl, { ...baseModules, ...Object.fromEntries(entries) }, catalog,
    );
  }

  async snapshot({ force = false } = {}) {
    const context = this.captureContext();
    const now = this.now();
    const weekKey = timestamp => calendarWeekQuery({ date: new Date(timestamp + 28_800_000).toISOString().slice(0, 10) }).start;
    if (!force && this.cached && this.cacheFresh(this.cached) &&
        weekKey(now) === weekKey(this.cached.checkedAt)) return this.cached;
    if (!force && this.inflight) return this.inflight;
    return this.readSnapshot(context);
  }

  async refreshSchedule() {
    const context = this.captureContext();
    if (this.inflight) await this.inflight;
    this.assertContext(context);
    return this.readSnapshot(context, 'schedule');
  }

  async readSnapshot(context, moduleId = null) {
    this.assertContext(context);
    // A new source read supersedes prior week requests, including late denials.
    this.calendarEpoch++;
    context = this.captureContext();
    this.calendarCache.clear(); this.calendarInflight.clear();
    const operation = this.readNow({ moduleId }).then(value => {
      const accepted = this.acceptDataResult(context, value);
      if (accepted && this.inflight === operation) this.cached = value;
      return value;
    });
    this.inflight = operation;
    try { return await operation; }
    finally { if (this.inflight === operation) this.inflight = null; }
  }

  async scheduleWeek(selection) {
    const query = calendarWeekQuery(selection);
    const context = this.captureContext();
    const key = JSON.stringify([context.key, query.start]);
    const cached = this.calendarCache.get(key);
    if (!query.force && cached && this.cacheFresh(cached)) return cached;
    if (!query.force && this.calendarInflight.has(key)) return this.calendarInflight.get(key);
    const operation = this.readWeek(context, query).then(value => {
      const accepted = this.acceptDataResult(context, value);
      if (accepted && this.calendarInflight.get(key) === operation && ['ready', 'empty'].includes(value.modules.schedule.state)) {
        this.calendarCache.delete(key); this.calendarCache.set(key, value);
        if (this.calendarCache.size > 12) this.calendarCache.delete(this.calendarCache.keys().next().value);
      }
      return value;
    });
    this.calendarInflight.set(key, operation);
    try { return await operation; }
    finally { if (this.calendarInflight.get(key) === operation) this.calendarInflight.delete(key); }
  }

  async readWeek(context, query) {
    if (this.inflight) await this.inflight;
    this.assertContext(context);
    if (!query.force && this.cached?.sessionState === 'authenticated' &&
        ['ready', 'empty'].includes(this.cached.modules.schedule.state) &&
        this.cacheFresh(this.cached) &&
        calendarWeekQuery({ date: new Date(this.cached.checkedAt + 28_800_000).toISOString().slice(0, 10) }).start === query.start) {
      return Object.freeze({ ...this.cached, scheduleWeek: { start: query.start, end: query.end } });
    }
    const result = await this.readNow({ moduleId: 'schedule', scheduleWeekStart: query.start });
    this.assertContext(context);
    return Object.freeze({ ...result, scheduleWeek: { start: query.start, end: query.end } });
  }

  acceptDataResult(context, value) {
    this.assertContext(context);
    if (value.sessionState === 'unauthenticated' ||
        ['not-authenticated', 'session-expired', 'forbidden'].includes(value.modules.schedule.state)) {
      // Return this authoritative denial, but invalidate every older cache/flight.
      this.invalidate();
      // A signed-out snapshot contains no personal items; retain that status to avoid
      // repeatedly probing SSO. Forced refresh still revalidates after user login.
      if (value.sessionState === 'unauthenticated') this.cached = value;
      return false;
    }
    return true;
  }

  invalidate() {
    this.cached = null; this.inflight = null;
    this.calendarCache.clear(); this.calendarInflight.clear(); this.calendarEpoch++;
  }
}

module.exports = {
  BrowserSessionManager,
  CAMPUS_REQUEST_FILTER,
  FAIL_CLOSED_PAC,
  FAIL_CLOSED_PROXY,
  MyPortalDataRuntime,
  calendarWeekQuery,
  applyCampusRequestBoundary,
  applyCampusSessionPolicy,
  campusRequestsBlocked,
  campusProxyConfig,
  createMemoryRoutingPolicy,
  failClosedProxyConfig,
  hkustMyPortalSources,
  normalizeProxyPort,
  pacDataUrl,
  setCampusRequestBlocked,
  validatePacProxyConfig,
};
