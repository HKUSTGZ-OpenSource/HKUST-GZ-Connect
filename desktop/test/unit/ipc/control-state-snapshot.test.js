'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { validateBuiltinResourceDocument } = require('../../../lib/resources/schema/campus-resource-contract');
const { projectCampusResources } = require('../../../lib/resources/runtime/campus-resources');
const {
  createControlStateSnapshot,
  maskedAccountLabel,
} = require('../../../lib/ipc/control-state-snapshot');

function fixture(overrides = {}) {
  const calls = [];
  const snapshot = createControlStateSnapshot({
    getStatus: () => ({ connected: true }),
    loadSettings: () => ({ username: 'student', port: 6180 }),
    hasCredential: () => true,
    hasAccountIdentity: (settings) => Boolean(settings.username),
    getPacUrl: () => 'file:///routing.pac',
    getLocale: () => 'zh-CN',
    platform: 'darwin',
    getVersion: () => '2.0.0-test',
    getUpdate: () => null,
    getResources: () => [
      { id: 'home', favorite: true, lastOpenedAt: 20 },
      { id: 'hpc', favorite: false, lastOpenedAt: null },
    ],
    getResourceGroups: () => [{
      id: 'group_abcdefghijkl', name: '学习', resourceIds: ['home'],
    }],
    getFallbackResources: () => [{ id: 'home', favorite: false, lastOpenedAt: null }],
    getProfilePresentation: (options) => {
      calls.push(options);
      return {
        schoolProfile: { profileId: 'hkustgz' },
        campusAccount: { kind: 'legacy-primary', hasCredential: options.hasCredential === true },
        workspace: { kind: 'legacy-workspace', resourceCount: options.resourceCount ?? 1 },
      };
    },
    getAuthChallenge: () => null,
    prepareNetworkEnvironment: async () => {},
    getNetworkEnvironment: () => ({ schemaVersion: 1, status: 'ready' }),
    ...overrides,
  });
  return { calls, snapshot };
}

test('projects settings, resources and key-free profile compatibility views', async () => {
  const { calls, snapshot } = fixture();
  const value = await snapshot();
  assert.equal(value.connected, true);
  assert.equal(value.loggedIn, true);
  assert.equal(value.hasPassword, true);
  assert.equal(value.settings.username, 'stu****');
  assert.equal(value.networkEnvironment.status, 'ready');
  assert.deepEqual(value.campusResources.map(({ id }) => id), ['home', 'hpc']);
  assert.deepEqual(value.resourceGroups, [{
    id: 'group_abcdefghijkl', name: '学习', resourceIds: ['home'],
  }]);
  assert.deepEqual(calls, [{
    locale: 'zh-CN',
    hasCredential: true,
    resourceCount: 2,
    favoriteCount: 1,
    recentCount: 1,
  }]);
  for (const forbidden of ['engineConfigRef', 'reviewedDnsFallback', 'accountKey', 'workspaceKey']) {
    assert.equal(JSON.stringify(value).includes(forbidden), false);
  }
});

test('account labels are masked before entering ordinary Renderer state', () => {
  assert.equal(maskedAccountLabel('sample'), 'sam***');
  assert.equal(maskedAccountLabel('ab'), 'ab***');
  assert.equal(maskedAccountLabel(''), '');
});

test('settings failure returns the bounded fallback without probing credentials', async () => {
  let credentialReads = 0;
  const { calls, snapshot } = fixture({
    loadSettings: () => { throw new Error('corrupt settings'); },
    hasCredential: () => { credentialReads += 1; return true; },
  });
  const value = await snapshot();
  assert.equal(value.settings, null);
  assert.equal(value.loggedIn, false);
  assert.equal(value.hasPassword, false);
  assert.deepEqual(value.campusResources, [{ id: 'home', favorite: false, lastOpenedAt: null }]);
  assert.deepEqual(value.resourceGroups, []);
  assert.equal(credentialReads, 0);
  assert.deepEqual(calls, [{ locale: 'zh-CN' }]);
});

test('persistent Account identity can stay logged in without a plaintext settings username', async () => {
  const { snapshot } = fixture({
    loadSettings: () => ({ username: '', port: 6180 }),
    hasAccountIdentity: () => true,
  });
  const value = await snapshot();
  assert.equal(value.loggedIn, true);
  assert.equal(value.settings.username, '');
});

test('legacy custom URL conflicts cannot make get-state fail', async () => {
  const builtins = validateBuiltinResourceDocument([{
    id: 'home',
    name: 'Home',
    description: '',
    url: 'https://www.example.edu/',
    route: 'campus',
  }]);
  const customResources = [{
    id: 'legacy-duplicate',
    name: 'Legacy duplicate',
    description: '',
    url: 'https://www.example.edu/',
    route: 'campus',
  }];
  const { snapshot } = fixture({
    loadSettings: () => ({ username: 'student', port: 6180, customResources }),
    getResources: (settings) => projectCampusResources(
      builtins, settings.customResources,
    ).resources,
  });
  assert.deepEqual((await snapshot()).campusResources.map(({ id }) => id), ['home']);
  assert.equal(customResources.length, 1, 'the compatibility view must not rewrite settings');
});

test('rejects an incomplete composition at construction time', () => {
  assert.throws(() => createControlStateSnapshot(), /getStatus must be a function/u);
  assert.throws(() => createControlStateSnapshot({ getStatus() {} }), /loadSettings/u);
});

test('network preparation finishes before current local state is captured', async () => {
  let release;
  const preparation = new Promise((resolve) => { release = resolve; });
  let phase = { locale: 'en', resources: [{ id: 'old-resource' }], groupIds: ['old-resource'] };
  const reads = [];
  const observe = (name, value) => { reads.push(name); return value; };
  const { snapshot } = fixture({
    prepareNetworkEnvironment: () => preparation,
    loadSettings: () => observe('settings', { username: '', language: phase.locale, underlaySourceAddress: '192.0.2.20' }),
    getStatus: () => observe('status', { connected: false }),
    getLocale: () => observe('locale', phase.locale),
    hasCredential: () => observe('credential', true),
    hasAccountIdentity: () => observe('identity', true),
    getResources: () => observe('resources', phase.resources),
    getResourceGroups: () => observe('groups', [{ id: 'group_abcdefghijkl', name: 'Synthetic', resourceIds: phase.groupIds }]),
    getNetworkEnvironment: (settings = {}) => observe('network-view', { selection: settings.underlaySourceAddress }),
    getProfilePresentation: (options) => observe('profile', { schoolProfile: { displayLocale: options.locale } }),
  });
  const pending = snapshot();
  try {
    assert.deepEqual(reads, [], 'no local state is read before observation settles');
    phase = { locale: 'zh', resources: [{ id: 'new-resource' }], groupIds: ['new-resource'] };
    release();
    const value = await pending;
    assert.equal(value.locale, 'zh');
    assert.equal(value.settings.language, 'zh');
    assert.equal(value.schoolProfile.displayLocale, 'zh');
    assert.deepEqual(value.campusResources.map(({ id }) => id), ['new-resource']);
    assert.deepEqual(value.resourceGroups[0].resourceIds, ['new-resource']);
    assert.equal(value.networkEnvironment.selection, value.settings.underlaySourceAddress);
    assert.equal(reads.filter((name) => name === 'locale').length, 1);
  } finally { release(); await pending; }
});

test('failed network preparation rejects without reading local state or credentials', async () => {
  const failure = new Error('synthetic observation failure');
  const reads = [];
  const { snapshot } = fixture({
    prepareNetworkEnvironment: async () => { throw failure; },
    loadSettings: () => { reads.push('settings'); return {}; },
    hasCredential: () => { reads.push('credential'); return false; },
    getResources: () => { reads.push('resources'); return []; },
    getProfilePresentation: () => { reads.push('profile'); return {}; },
  });
  await assert.rejects(snapshot(), (error) => error === failure);
  assert.deepEqual(reads, []);
});

test('settings fallback uses the completed observation and current locale without credentials', async () => {
  let release;
  const preparation = new Promise((resolve) => { release = resolve; });
  let locale = 'en';
  let credentialReads = 0;
  const projectedSettings = [];
  const { snapshot } = fixture({
    prepareNetworkEnvironment: () => preparation,
    loadSettings: () => { throw new Error('synthetic settings failure'); },
    getLocale: () => locale,
    hasCredential: () => { credentialReads += 1; return true; },
    getNetworkEnvironment: (settings) => { projectedSettings.push(settings); return { status: 'unknown' }; },
    getProfilePresentation: (options) => ({ schoolProfile: { displayLocale: options.locale } }),
  });
  const pending = snapshot(); locale = 'zh'; release();
  const value = await pending;
  assert.equal(value.locale, 'zh');
  assert.equal(value.schoolProfile.displayLocale, 'zh');
  assert.equal(value.settings, null);
  assert.equal(value.loggedIn, false);
  assert.equal(value.hasPassword, false);
  assert.deepEqual(value.resourceGroups, []);
  assert.equal(credentialReads, 0);
  assert.deepEqual(projectedSettings, [null]);
});
