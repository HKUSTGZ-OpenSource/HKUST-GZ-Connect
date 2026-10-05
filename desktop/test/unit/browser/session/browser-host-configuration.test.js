'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { initializeBrowserHostConfiguration } = require('../../../../lib/browser/session/browser-session-manager');
const { normalizeCampusUrl } = require('../../../../lib/browser/session/campus-browser');
const { createT } = require('../../../../lib/platform/i18n/i18n');
const { NEUTRAL_CAMPUS_PARTITION } = require('../../../../lib/routing/policy/campus-route');

const ports = { blankUrl: 'about:blank', normalizeUrl: normalizeCampusUrl, createTranslator: createT };
function configure(options = {}, injected = ports) {
  const host = {}; initializeBrowserHostConfiguration(host, options, injected); return host;
}

test('initialization writes exactly the original host field set without persisting or invoking services', () => {
  const vault = new Proxy({}, { get: () => { throw new Error('credential service must remain opaque'); } });
  const dialog = new Proxy({}, { get: () => { throw new Error('dialog must not be invoked'); } });
  const host = configure({ credentialVault: vault, dialog, extraUntrustedKey: 'ignored' });
  assert.equal(host.credentialVault, vault); assert.equal(host.dialog, dialog);
  assert.equal(Object.hasOwn(host, 'extraUntrustedKey'), false);
  assert.deepEqual(Object.keys(host).sort(), ['dialog', 'credentialVault', 'parentWindow', 'toolbarFile', 'toolbarPreload',
    'campusPreload', 'routingPolicy', 'ensureCampusReady', 'locale', 't', 'profilePresentation',
    'getWorkspaceResources', 'getWorkspaceGroups', 'onOpenResource', 'showBookmarkMenu', 'onTogglePageFavorite',
    'onRecordPageOpen', 'getSharedPortalCredential', 'onPortalSessionUrl', 'workspaceController', 'showItemInFolder',
    'getNewTabUrl', 'onOpenSettings', 'homeUrl', 'onError'].sort());
});

test('neutral defaults and optional callback fallbacks preserve their original result contracts', async () => {
  const host = configure({ locale: 'unknown', getNewTabUrl: null, ensureCampusReady: null, onOpenResource: 1,
    showBookmarkMenu: {}, onTogglePageFavorite: false, onRecordPageOpen: '', onOpenSettings: null });
  assert.equal(host.locale, 'zh'); assert.equal(host.homeUrl, 'about:blank');
  assert.deepEqual(host.getWorkspaceResources(), []); assert.deepEqual(host.getWorkspaceGroups(), []);
  assert.equal(host.getNewTabUrl(), 'about:blank'); assert.equal(await host.ensureCampusReady(), true);
  assert.equal(host.getSharedPortalCredential(), null); assert.equal(host.onPortalSessionUrl(), false);
  assert.equal(host.showItemInFolder(), undefined); assert.equal(host.onOpenSettings(), undefined);
  for (const key of ['onOpenResource', 'showBookmarkMenu', 'onTogglePageFavorite', 'onRecordPageOpen']) assert.equal(host[key], null);
});

test('explicit providers, services and policy keep identity and do not execute during validation', () => {
  const fn = () => { throw new Error('opaque callback must not execute'); };
  const workspace = { createView: fn, load: fn, sendState: fn }, policy = {};
  const options = { parentWindow: fn, routingPolicy: policy, ensureCampusReady: fn, getWorkspaceResources: fn,
    getWorkspaceGroups: fn, onOpenResource: fn, showBookmarkMenu: fn, onTogglePageFavorite: fn,
    onRecordPageOpen: fn, getSharedPortalCredential: fn, onPortalSessionUrl: fn, showItemInFolder: fn,
    getNewTabUrl: fn, onOpenSettings: fn, onError: fn, workspaceController: workspace };
  const host = configure(options); for (const [key, value] of Object.entries(options)) assert.equal(host[key], value, key);
});

test('fallback profile translation receives the original host with prior policy/locale state', () => {
  const host = {}, policy = {};
  const t = function(key) { assert.equal(this, host); assert.equal(this.locale, 'en'); assert.equal(this.routingPolicy, policy); return key; };
  initializeBrowserHostConfiguration(host, { locale: 'en', routingPolicy: policy, t }, ports);
  assert.equal(host.profilePresentation.schoolName, 'browser.workspace'); assert.equal(host.t, t);
});

test('profile normalization preserves a frozen copy, bounds name and accepts only the original typed fields', () => {
  const profile = { schoolName: 'A'.repeat(180), unverified: true, officialPortalResourceId: 'resource', extra: 'ignored' };
  const host = configure({ profilePresentation: profile });
  assert.notEqual(host.profilePresentation, profile); assert.equal(Object.isFrozen(host.profilePresentation), true);
  assert.deepEqual(host.profilePresentation, { schoolName: 'A'.repeat(160), unverified: true, officialPortalResourceId: 'resource' });
  assert.equal(profile.schoolName.length, 180);
  assert.equal(configure({ profilePresentation: { ...profile, officialPortalResourceId: 1 } }).profilePresentation.officialPortalResourceId, null);
  assert.equal(configure({ profilePresentation: { schoolName: 1, unverified: false } }).profilePresentation.unverified, false);
});

test('provider, Workspace and home validation preserve the baseline first-error order', () => {
  assert.throws(() => configure({ getWorkspaceResources: null, workspaceController: {}, homeUrl: 'file:///invalid' }), /workspace provider/);
  assert.throws(() => configure({ getWorkspaceGroups: null }), /workspace provider/);
  assert.throws(() => configure({ workspaceController: {}, homeUrl: 'file:///invalid' }), /Workspace controller/);
  assert.throws(() => configure({ homeUrl: 'file:///invalid' }), error => error.message === createT('zh')('url.schemeUnsupported'));
  assert.equal(configure({ homeUrl: 'example.invalid/path' }).homeUrl, 'https://example.invalid/path');
});

test('default routing authority stays per host and preserves the existing policy implementation', () => {
  const first = configure(), second = configure();
  assert.notEqual(first.routingPolicy, second.routingPolicy);
  first.routingPolicy.upsert({ host: 'synthetic.example.invalid', route: 'campus', includeSubdomains: false });
  assert.equal(first.routingPolicy.list().length, 1); assert.deepEqual(second.routingPolicy.list(), []);
});

test('invalid internal dependencies fail before writing host fields', () => {
  for (const change of [{ blankUrl: '' }, { normalizeUrl: null }, { createTranslator: null }]) {
    const host = {}; assert.throws(() => initializeBrowserHostConfiguration(host, {}, { ...ports, ...change }), /dependencies/);
    assert.deepEqual(host, {});
  }
});

test('only declared constructor options are read, once and in the original order', () => {
  const reads = [], options = {};
  const keys = ['BrowserWindow', 'WebContentsView', 'createWindowOwner', 'session', 'dialog', 'certificateTrust',
    'credentialVault', 'parentWindow', 'toolbarFile', 'toolbarPreload', 'campusPreload', 'profilePresentation',
    'getWorkspaceResources', 'getWorkspaceGroups', 'onOpenResource', 'showBookmarkMenu', 'onTogglePageFavorite',
    'onRecordPageOpen', 'onOpenRetired', 'getSharedPortalCredential', 'onPortalSessionUrl', 'workspaceController',
    'showItemInFolder', 'getNewTabUrl', 'onOpenSettings', 'homeUrl', 'routingPolicy', 'ensureCampusReady', 'locale',
    't', 'onError', 'partition'];
  for (const key of keys) Object.defineProperty(options, key, { get: () => { reads.push(key); return undefined; } });
  Object.defineProperty(options, 'unrelated', { enumerable: true, get: () => { throw new Error('unknown option must not be read'); } });
  const host = {}, nativePorts = initializeBrowserHostConfiguration(host, options, ports);
  assert.deepEqual(reads, keys); assert.equal(nativePorts.createWindowOwner, null);
  assert.equal(nativePorts.partition, NEUTRAL_CAMPUS_PARTITION);
  assert.equal(Object.hasOwn(host, 'BrowserWindow'), false); assert.equal(Object.hasOwn(host, 'session'), false);
});
