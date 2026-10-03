'use strict';

const {
  DIRECT_PARTNER_HOSTS,
  ROUTE_CAMPUS,
  ROUTE_DIRECT,
  SCHOOL_CAMPUS_HOSTS,
} = require('./campus-route');
const { hostnameForUrl, resolveRouteForUrl } = require('./route-resolver');
const { isIsolatedNetworkHost } = require('./host-safety');
const {
  deleteRoutingRule,
  loadRoutingRules,
  normalizeRoutingRules,
  normalizeRuleHost,
  saveRoutingRules,
  upsertRoutingRule,
} = require('../rules/routing-rule-store');

const POLICY_SOURCES = Object.freeze([
  'safety',
  'user-exact',
  'user-subdomain',
  'custom-resource',
  'server-resource',
  'builtin',
  'inherited',
  'default',
]);

function validRoute(route) {
  return route === ROUTE_CAMPUS || route === ROUTE_DIRECT;
}

function normalizeDomains(values, fallback = []) {
  const result = [];
  for (const value of Array.isArray(values) ? values : fallback) {
    try {
      const host = normalizeRuleHost(String(value));
      if (!result.includes(host)) result.push(host);
    } catch {}
  }
  return result;
}

function normalizeResourceRoutes(resources) {
  const seen = new Set();
  const result = [];
  for (const resource of Array.isArray(resources) ? resources : []) {
    if (!resource || resource.routePreference === 'auto' || !validRoute(resource.route)) continue;
    const host = hostnameForUrl(resource.url);
    if (!host || seen.has(host)) continue;
    seen.add(host);
    result.push({
      host,
      route: resource.route === ROUTE_DIRECT && isIsolatedNetworkHost(host)
        ? ROUTE_CAMPUS
        : resource.route,
    });
  }
  return result;
}

function normalizeDomainRoutePolicy({
  userRules = [],
  customResources = [],
  schoolDomains = SCHOOL_CAMPUS_HOSTS,
  directPartnerDomains = DIRECT_PARTNER_HOSTS,
  serverResources = [],
} = {}) {
  const rules = normalizeRoutingRules(userRules);
  return {
    userExact: rules
      .filter((rule) => !rule.includeSubdomains)
      .map(({ host, route }) => ({ host, route })),
    userSubdomains: rules
      .filter((rule) => rule.includeSubdomains)
      .sort((left, right) => right.host.length - left.host.length || right.updatedAt - left.updatedAt)
      .map(({ host, route }) => ({ host, route })),
    customExact: normalizeResourceRoutes(customResources),
    builtinSubdomains: [
      ...normalizeDomains(directPartnerDomains, DIRECT_PARTNER_HOSTS)
        .map((host) => ({ host, route: ROUTE_DIRECT })),
      ...normalizeDomains(schoolDomains, SCHOOL_CAMPUS_HOSTS)
        .map((host) => ({ host, route: ROUTE_CAMPUS })),
    ],
    serverExact: normalizeResourceRoutes(serverResources),
  };
}

function resolveDomainRouteForUrl(rawUrl, options = {}) {
  return resolveRouteForUrl(rawUrl, options);
}

function renderDomainRoutePac(policy, port, {
  defaultRoute = ROUTE_CAMPUS,
  campusPrivateIpv4 = false,
  proxyKind = 'socks5',
} = {}) {
  const proxyPort = Number(port);
  if (!Number.isInteger(proxyPort) || proxyPort < 1025 || proxyPort > 65535) {
    throw new Error('本地代理端口无效');
  }
  if (!validRoute(defaultRoute)) throw new Error('默认浏览器网络路径无效');
  if (!['socks5', 'http'].includes(proxyKind)) throw new Error('本地代理类型无效');
  const proxy = `${proxyKind === 'http' ? 'PROXY' : 'SOCKS5'} 127.0.0.1:${proxyPort}`;
  return `'use strict';
var USER_EXACT = ${JSON.stringify(policy.userExact)};
var USER_SUBDOMAINS = ${JSON.stringify(policy.userSubdomains)};
var CUSTOM_EXACT = ${JSON.stringify(policy.customExact)};
var BUILTIN_SUBDOMAINS = ${JSON.stringify(policy.builtinSubdomains)};
var SERVER_EXACT = ${JSON.stringify(policy.serverExact)};
var DEFAULT_ROUTE = ${JSON.stringify(defaultRoute)};
var CAMPUS_PRIVATE_IPV4 = ${campusPrivateIpv4 === true ? 'true' : 'false'};
function exactRoute(entries, host) {
  for (var i = 0; i < entries.length; i++) {
    if (entries[i].host === host) return entries[i].route;
  }
  return "";
}
function suffixRoute(entries, host) {
  for (var i = 0; i < entries.length; i++) {
    var domain = entries[i].host;
    if (host === domain ||
        (host.length > domain.length && host.slice(-(domain.length + 1)) === "." + domain))
      return entries[i].route;
  }
  return "";
}
function forceCampusHost(host) {
  if (host === "localhost" || host.slice(-10) === ".localhost" ||
      host.slice(-6) === ".local" || host.indexOf(":") !== -1) return true;
  var parts = host.split(".");
  if (parts.length !== 4) return false;
  var octets = [];
  for (var i = 0; i < parts.length; i++) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(parts[i])) return false;
    var octet = Number(parts[i]);
    if (octet > 255) return false;
    octets.push(octet);
  }
  return octets[0] === 0 || octets[0] === 10 || octets[0] === 127 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) || octets[0] >= 224;
}
function FindProxyForURL(url, host) {
  host = String(host || "").toLowerCase().replace(/\\.$/, "");
  if (CAMPUS_PRIVATE_IPV4 && forceCampusHost(host)) return ${JSON.stringify(proxy)};
  var route = exactRoute(USER_EXACT, host)
    || suffixRoute(USER_SUBDOMAINS, host)
    || exactRoute(CUSTOM_EXACT, host)
    || exactRoute(SERVER_EXACT, host);
  route = route || suffixRoute(BUILTIN_SUBDOMAINS, host)
    || DEFAULT_ROUTE;
  return route === "direct" ? "DIRECT" : ${JSON.stringify(proxy)};
}
`;
}

function buildDomainRoutePac(options = {}, port, config = {}) {
  return renderDomainRoutePac(normalizeDomainRoutePolicy(options), port, config);
}

class DomainRoutePolicyStore {
  #serverResourceSource;

  constructor({
    filePath,
    customResources = () => [],
    schoolDomains = () => SCHOOL_CAMPUS_HOSTS,
    directPartnerDomains = () => DIRECT_PARTNER_HOSTS,
    serverResources = () => [],
  } = {}) {
    if (typeof filePath !== 'string' || !filePath) {
      throw new TypeError('路由规则文件路径无效');
    }
    this.filePath = filePath;
    this.customResources = typeof customResources === 'function'
      ? customResources
      : () => customResources;
    this.schoolDomains = typeof schoolDomains === 'function'
      ? schoolDomains
      : () => schoolDomains;
    this.directPartnerDomains = typeof directPartnerDomains === 'function'
      ? directPartnerDomains
      : () => directPartnerDomains;
    this.#serverResourceSource = serverResources;
    this.serverResources = () => typeof this.#serverResourceSource === 'function'
      ? this.#serverResourceSource.call(this)
      : this.#serverResourceSource;
    this.cachedRules = null;
  }

  clearServerResources() { this.#serverResourceSource = []; }

  cacheRules(rules) {
    this.cachedRules = Object.freeze(rules.map((rule) => Object.freeze({ ...rule })));
    return this.list();
  }

  list({ reload = false } = {}) {
    if (reload || this.cachedRules === null) {
      this.cacheRules(loadRoutingRules(this.filePath));
    }
    return this.cachedRules.map((rule) => ({ ...rule }));
  }

  options() {
    return {
      userRules: this.list(),
      customResources: this.customResources(),
      schoolDomains: this.schoolDomains(),
      directPartnerDomains: this.directPartnerDomains(),
      serverResources: this.serverResources(),
    };
  }

  snapshot() {
    const policy = normalizeDomainRoutePolicy(this.options());
    return Object.freeze(Object.fromEntries(Object.entries(policy).map(([key, entries]) => [
      key,
      Object.freeze(entries.map((entry) => Object.freeze({ ...entry }))),
    ])));
  }

  resolve(rawUrl, inheritedRoute = null) {
    return resolveDomainRouteForUrl(rawUrl, { ...this.options(), inheritedRoute });
  }

  upsert(payload, now = Date.now()) {
    let current = this.list();
    if (payload?.previous) {
      current = deleteRoutingRule(
        current,
        payload.previous.host,
        payload.previous.includeSubdomains === true,
      );
    }
    const result = upsertRoutingRule(current, payload, now);
    const rules = saveRoutingRules(this.filePath, result.rules);
    return { rule: result.rule, rules: this.cacheRules(rules) };
  }

  remove({ host, includeSubdomains = false } = {}) {
    const rules = saveRoutingRules(
      this.filePath,
      deleteRoutingRule(this.list(), host, includeSubdomains),
    );
    return this.cacheRules(rules);
  }

  replace(rules) {
    const saved = saveRoutingRules(this.filePath, rules);
    return this.cacheRules(saved);
  }

  buildPac(port, config) {
    return renderDomainRoutePac(this.snapshot(), port, config);
  }
}

module.exports = {
  DomainRoutePolicyStore,
  POLICY_SOURCES,
  buildDomainRoutePac,
  normalizeDomainRoutePolicy,
  normalizeResourceRoutes,
  resolveDomainRouteForUrl,
};
