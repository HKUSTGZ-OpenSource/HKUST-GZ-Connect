'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const {
  buildDomainRoutePac,
  resolveDomainRouteForUrl,
} = require('../../../lib/routing/policy/domain-route-policy');
const {
  parseBuiltinResourceDocument,
} = require('../../../lib/resources/schema/campus-resource-contract');

const desktopRoot = path.resolve(__dirname, '..', '..', '..');
const profile = JSON.parse(fs.readFileSync(path.join(
  desktopRoot,
  'assets',
  'profiles',
  'hkustgz',
  'school-profile.json',
), 'utf8'));
const resources = parseBuiltinResourceDocument(fs.readFileSync(path.join(
  desktopRoot,
  'assets',
  'profiles',
  'hkustgz',
  'builtin-resources.json',
)));

function pacRoute(value) {
  if (value === 'DIRECT') return 'direct';
  if (value === 'SOCKS5 127.0.0.1:46180') return 'campus';
  throw new Error(`unexpected PAC result: ${String(value)}`);
}

test('every reviewed HKUST(GZ) website keeps one explicit browser and PAC route', () => {
  const options = {
    schoolDomains: profile.browser.campusDomains,
    directPartnerDomains: profile.browser.directPartnerDomains,
    serverResources: resources,
  };
  const context = {};
  vm.runInNewContext(buildDomainRoutePac(options, 46180), context);

  for (const resource of resources) {
    const host = new URL(resource.url).hostname;
    const browser = resolveDomainRouteForUrl(resource.url, options);
    assert.equal(browser.route, resource.route, resource.id);
    assert.equal(browser.source, 'server-resource', resource.id);
    assert.equal(pacRoute(context.FindProxyForURL(resource.url, host)), resource.route, resource.id);
  }
});

test('reviewed Direct sign-in dependencies override the generic school suffix', () => {
  const options = {
    schoolDomains: profile.browser.campusDomains,
    directPartnerDomains: profile.browser.directPartnerDomains,
    serverResources: resources,
  };
  for (const host of ['sso.hkust-gz.edu.cn', 'gzcas.hkust-gz.edu.cn']) {
    const result = resolveDomainRouteForUrl(`https://${host}/`, options);
    assert.equal(result.route, 'direct', host);
    assert.equal(result.source, 'builtin', host);
  }
});
