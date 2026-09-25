'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');

const {
  buildDomainRoutePac,
  resolveDomainRouteForUrl,
} = require('../../../lib/routing/policy/domain-route-policy');
const { ROUTE_CAMPUS, ROUTE_DIRECT } = require('../../../lib/routing/policy/campus-route');

const PROXY_PORT = 46180;
const CAMPUS_PROXY = `SOCKS5 127.0.0.1:${PROXY_PORT}`;
const POLICY = Object.freeze({
  userRules: Object.freeze([
    Object.freeze({
      host: 'exact.branch.routing.test',
      includeSubdomains: false,
      route: ROUTE_CAMPUS,
      updatedAt: 100,
    }),
    Object.freeze({
      host: 'deep.branch.routing.test',
      includeSubdomains: true,
      route: ROUTE_CAMPUS,
      updatedAt: 90,
    }),
    Object.freeze({
      host: 'branch.routing.test',
      includeSubdomains: true,
      route: ROUTE_DIRECT,
      updatedAt: 80,
    }),
    Object.freeze({
      host: 'BÜCHER.Example',
      includeSubdomains: false,
      route: ROUTE_DIRECT,
      updatedAt: 70,
    }),
    Object.freeze({
      host: '103.189.154.10',
      includeSubdomains: false,
      route: ROUTE_DIRECT,
      updatedAt: 60,
    }),
    // Storage normalization turns this legacy-unsafe rule into campus, while
    // the resolver's safety layer must still win before user policy.
    Object.freeze({
      host: '192.168.50.1',
      includeSubdomains: false,
      route: ROUTE_DIRECT,
      updatedAt: 50,
    }),
  ]),
  customResources: Object.freeze([
    Object.freeze({ url: 'https://exact.branch.routing.test/custom', route: ROUTE_DIRECT }),
    Object.freeze({ url: 'https://child.branch.routing.test/custom', route: ROUTE_CAMPUS }),
    Object.freeze({ url: 'https://custom.routing.test:4433/path?fixture=ignored', route: ROUTE_DIRECT }),
    Object.freeze({ url: 'https://login.partner.routing.test/custom', route: ROUTE_CAMPUS }),
  ]),
  schoolDomains: Object.freeze(['school.routing.test']),
  directPartnerDomains: Object.freeze(['partner.routing.test']),
  serverResources: Object.freeze([
    Object.freeze({ url: 'https://custom.routing.test/server', route: ROUTE_CAMPUS }),
    Object.freeze({ url: 'https://teams.partner.routing.test/server', route: ROUTE_CAMPUS }),
    Object.freeze({ url: 'https://server.routing.test/service', route: ROUTE_DIRECT }),
    Object.freeze({ url: 'https://server-campus.routing.test/service', route: ROUTE_CAMPUS }),
  ]),
});

function compilePac(defaultRoute = ROUTE_CAMPUS) {
  const source = buildDomainRoutePac(POLICY, PROXY_PORT, {
    campusPrivateIpv4: true,
    defaultRoute,
  });
  const context = {};
  vm.runInNewContext(source, context);
  return context.FindProxyForURL;
}

const campusPac = compilePac();
const inheritedDirectPac = compilePac(ROUTE_DIRECT);

function chromiumHost(url) {
  return new URL(url).hostname;
}

function pacRoute(value) {
  if (value === 'DIRECT') return ROUTE_DIRECT;
  if (value === CAMPUS_PROXY) return ROUTE_CAMPUS;
  throw new Error(`unexpected PAC result: ${String(value)}`);
}

function compareDecision({
  url,
  inheritedRoute = null,
  host = chromiumHost(url),
  expectedRoute = null,
  expectedSource = null,
} = {}) {
  const resolved = resolveDomainRouteForUrl(url, { ...POLICY, inheritedRoute });
  // PAC has no per-request metadata channel. For an inherited fallback case,
  // compile that contextual fallback as DEFAULT_ROUTE; every higher-priority
  // policy entry must still override it. Production currently passes no
  // inherited route to the PAC, so this is a differential seam, not a new claim
  // that PAC can recover a tab's navigation ancestry by itself.
  const evaluate = inheritedRoute === ROUTE_DIRECT ? inheritedDirectPac : campusPac;
  const throughPac = pacRoute(evaluate(url, host));
  assert.equal(throughPac, resolved.route, `${url} (${resolved.source})`);
  if (expectedRoute) assert.equal(resolved.route, expectedRoute, url);
  if (expectedSource) assert.equal(resolved.source, expectedSource, url);
  return resolved;
}

function deterministicRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
}

function randomLabel(next) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const length = 3 + (next() % 10);
  let value = String.fromCharCode(97 + (next() % 26));
  while (value.length < length) value += alphabet[next() % alphabet.length];
  return value;
}

test('RouteResolver and internal PAC agree across every precedence source and boundary', () => {
  const sources = new Set();
  const cases = [
    {
      url: 'https://192.168.50.1/',
      expectedRoute: ROUTE_CAMPUS,
      expectedSource: 'safety',
    },
    {
      url: 'https://exact.branch.routing.test/',
      expectedRoute: ROUTE_CAMPUS,
      expectedSource: 'user-exact',
    },
    {
      url: 'https://child.branch.routing.test/',
      host: 'CHILD.BRANCH.ROUTING.TEST.',
      expectedRoute: ROUTE_DIRECT,
      expectedSource: 'user-subdomain',
    },
    {
      url: 'https://child.deep.branch.routing.test/',
      expectedRoute: ROUTE_CAMPUS,
      expectedSource: 'user-subdomain',
    },
    {
      url: 'https://custom.routing.test/',
      expectedRoute: ROUTE_DIRECT,
      expectedSource: 'custom-resource',
    },
    {
      url: 'https://login.partner.routing.test/',
      expectedRoute: ROUTE_CAMPUS,
      expectedSource: 'custom-resource',
    },
    {
      url: 'https://teams.partner.routing.test/',
      expectedRoute: ROUTE_CAMPUS,
      expectedSource: 'server-resource',
    },
    {
      url: 'https://library.school.routing.test/',
      expectedRoute: ROUTE_CAMPUS,
      expectedSource: 'builtin',
    },
    {
      url: 'https://library.hkust-gz.edu.cn/',
      expectedRoute: ROUTE_CAMPUS,
      expectedSource: 'default',
    },
    {
      url: 'https://teams.office.com/',
      expectedRoute: ROUTE_CAMPUS,
      expectedSource: 'default',
    },
    {
      url: 'https://server.routing.test/',
      expectedRoute: ROUTE_DIRECT,
      expectedSource: 'server-resource',
    },
    {
      url: 'wss://server.routing.test/realtime',
      expectedRoute: ROUTE_DIRECT,
      expectedSource: 'server-resource',
    },
    {
      url: 'https://unknown.routing.test/',
      inheritedRoute: ROUTE_DIRECT,
      expectedRoute: ROUTE_DIRECT,
      expectedSource: 'inherited',
    },
    {
      url: 'https://unknown.routing.test/',
      expectedRoute: ROUTE_CAMPUS,
      expectedSource: 'default',
    },
  ];

  for (const fixture of cases) sources.add(compareDecision(fixture).source);
  assert.deepEqual([...sources].sort(), [
    'builtin',
    'custom-resource',
    'default',
    'inherited',
    'safety',
    'server-resource',
    'user-exact',
    'user-subdomain',
  ]);
});

test('RouteResolver and PAC agree for IDN, IP literals, lookalikes, and deterministic subdomains', () => {
  for (const fixture of [
    { url: 'https://BÜCHER.Example/', expectedRoute: ROUTE_DIRECT, expectedSource: 'user-exact' },
    { url: 'https://103.189.154.10:4433/', expectedRoute: ROUTE_DIRECT, expectedSource: 'user-exact' },
    { url: 'https://10.90.63.2/', expectedRoute: ROUTE_CAMPUS, expectedSource: 'safety' },
    { url: 'https://127.0.0.1/', expectedRoute: ROUTE_CAMPUS, expectedSource: 'safety' },
    { url: 'https://169.254.2.3/', expectedRoute: ROUTE_CAMPUS, expectedSource: 'safety' },
    { url: 'https://[::1]/', expectedRoute: ROUTE_CAMPUS, expectedSource: 'safety' },
    { url: 'https://branch.routing.test/', expectedRoute: ROUTE_DIRECT, expectedSource: 'user-subdomain' },
    { url: 'https://branch.routing.test.evil/', expectedRoute: ROUTE_CAMPUS, expectedSource: 'default' },
    { url: 'https://evilbranch.routing.test/', expectedRoute: ROUTE_CAMPUS, expectedSource: 'default' },
  ]) compareDecision(fixture);

  const next = deterministicRandom(0x4855_5354);
  for (let index = 0; index < 1_024; index += 1) {
    const label = randomLabel(next);
    const category = next() % 7;
    const host = [
      `${label}.branch.routing.test`,
      `${label}.deep.branch.routing.test`,
      `branch-${label}.routing.test`,
      `${label}.school.routing.test`,
      `${label}.partner.routing.test`,
      `${label}.unknown.invalid`,
      `${label}.routing.test.evil`,
    ][category];
    compareDecision({ url: `https://${host}/path` });
  }
});

test('higher-priority policy still overrides a contextual inherited fallback', () => {
  for (const fixture of [
    { url: 'https://exact.branch.routing.test/', expectedRoute: ROUTE_CAMPUS, expectedSource: 'user-exact' },
    { url: 'https://custom.routing.test/', expectedRoute: ROUTE_DIRECT, expectedSource: 'custom-resource' },
    { url: 'https://teams.partner.routing.test/', expectedRoute: ROUTE_CAMPUS, expectedSource: 'server-resource' },
    { url: 'https://server.routing.test/', expectedRoute: ROUTE_DIRECT, expectedSource: 'server-resource' },
    {
      url: 'https://server-campus.routing.test/',
      expectedRoute: ROUTE_CAMPUS,
      expectedSource: 'server-resource',
    },
  ]) compareDecision({ ...fixture, inheritedRoute: ROUTE_DIRECT });
});
