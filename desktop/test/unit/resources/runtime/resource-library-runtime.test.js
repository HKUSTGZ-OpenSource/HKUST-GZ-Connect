'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ResourceLibraryRuntime } = require('../../../../lib/resources/runtime/resource-library-runtime');

class FakeActivityStore {
  constructor(options) {
    this.options = options;
    this.favorites = { schemaVersion: 1, entries: [] };
    this.recent = { schemaVersion: 1, entries: [] };
  }
  snapshot() { return { favorites: this.favorites, recent: this.recent }; }
  toggleFavorite(resourceId) {
    this.favorites = { schemaVersion: 1, entries: [resourceId] };
    return this.favorites;
  }
  replaceFavorites(document) { this.favorites = document; return document; }
  replaceRecent(document) { this.recent = document; return document; }
  recordOpen(resourceId) {
    this.recent = { schemaVersion: 1, entries: [{ resourceId, openedAt: 10 }] };
  }
}

class EmptyGroupStore {
  groups() { return []; }
  snapshot() { return { schemaVersion: 2, collections: [], placements: [] }; }
  removeResource() {}
}

const resources = [{
  id: 'outlook', name: 'Outlook', description: '', url: 'https://outlook.office.com/owa/',
  localizedName: { zh: '邮箱', en: 'Outlook' },
  localizedDescription: { zh: '', en: 'Mail and calendar' },
  route: 'direct', category: 'common', keywords: [], builtin: true,
}];

test('resource source merges the active Profile and resolves effective routes once', () => {
  const settings = { customResources: [{ id: 'custom' }], hiddenBuiltinResourceIds: ['hidden'] };
  const calls = [];
  const source = ResourceLibraryRuntime.createSource({
    loadSettings: () => settings,
    mergeResources: (custom, hidden) => {
      calls.push({ custom, hidden });
      return resources;
    },
    resolveRoute: (url) => {
      calls.push({ url });
      return { route: 'campus', source: 'user-exact' };
    },
    onReadFailure: () => assert.fail('healthy source must not report a read failure'),
  });
  const result = source();
  assert.deepEqual(calls, [
    { custom: settings.customResources, hidden: settings.hiddenBuiltinResourceIds },
    { url: resources[0].url },
  ]);
  assert.equal(result[0].route, 'campus');
  assert.equal(result[0].routeSource, 'user-exact');
  assert.ok(Object.isFrozen(result));
});

test('resource source reports unreadable settings and falls back to the Profile library', () => {
  const failure = new Error('synthetic settings failure');
  const reports = [];
  const merges = [];
  const source = ResourceLibraryRuntime.createSource({
    loadSettings: () => { throw failure; },
    mergeResources: (...args) => { merges.push(args); return resources; },
    resolveRoute: () => assert.fail('fallback must not guess an effective route'),
    onReadFailure: (error) => reports.push(error),
  });
  assert.equal(source(), resources);
  assert.deepEqual(reports, [failure]);
  assert.deepEqual(merges, [[]]);
});

test('resource source also falls back if effective route projection fails', () => {
  const failure = new Error('synthetic routing failure');
  const reports = [];
  let mergeCalls = 0;
  const source = ResourceLibraryRuntime.createSource({
    loadSettings: () => assert.fail('explicit settings must be used'),
    mergeResources: () => { mergeCalls += 1; return resources; },
    resolveRoute: () => { throw failure; },
    onReadFailure: (error) => reports.push(error),
  });
  assert.equal(source({ customResources: [], hiddenBuiltinResourceIds: [] }), resources);
  assert.equal(mergeCalls, 2);
  assert.deepEqual(reports, [failure]);
});

test('resource open uses the injected context transaction and locale', async () => {
  const order = [];
  const runtime = new ResourceLibraryRuntime({
    favoritesFile: '/fixture/favorites.json', recentFile: '/fixture/recent.json',
    platform: 'darwin', loadResources: () => resources,
    captureContext: () => ({ epoch: 1 }), isContextCurrent: () => true,
    openRequest: async () => { order.push('open'); return { ok: true }; },
    runTransaction: async (prepare) => {
      order.push('begin');
      const transaction = await prepare();
      const result = await transaction.commit();
      order.push('end');
      return result;
    },
    getLocale: () => 'en', translate: () => 'unavailable',
    ActivityStoreClass: FakeActivityStore, GroupStoreClass: EmptyGroupStore,
  });
  const result = await runtime.openByIdSerialized({ resourceId: 'outlook' });
  assert.deepEqual(order, ['begin', 'open', 'end']);
  assert.equal(result.resources[0].name, 'Outlook');
  assert.equal(result.resourceId, 'outlook');
});

test('resource open localizes transaction failures without opening or recording', async () => {
  let openCount = 0;
  const runtime = new ResourceLibraryRuntime({
    favoritesFile: '/fixture/favorites.json', recentFile: '/fixture/recent.json',
    platform: 'darwin', loadResources: () => resources,
    captureContext: () => ({ epoch: 1 }), isContextCurrent: () => true,
    openRequest: async () => { openCount += 1; return { ok: true }; },
    runTransaction: async () => { throw new Error('synthetic stale context'); },
    getLocale: () => 'zh', translate: (key) => key === 'error.resourceUnavailable' ? '不可用' : '',
    ActivityStoreClass: FakeActivityStore, GroupStoreClass: EmptyGroupStore,
  });
  assert.deepEqual(await runtime.openByIdSerialized({ resourceId: 'outlook' }), {
    ok: false, error: '不可用',
  });
  assert.equal(openCount, 0);
  assert.deepEqual(runtime.snapshot().recent.entries, []);
});

test('ID-only open resolves inside Main ownership and records activity after success', async () => {
  const requests = [];
  const context = { epoch: 1 };
  const runtime = new ResourceLibraryRuntime({
    favoritesFile: '/fixture/favorites.json',
    recentFile: '/fixture/recent.json',
    platform: 'darwin',
    loadResources: () => resources,
    captureContext: () => context,
    isContextCurrent: (value) => value === context,
    openRequest: async (request) => { requests.push(request); return { ok: true }; },
    ActivityStoreClass: FakeActivityStore,
    GroupStoreClass: EmptyGroupStore,
  });
  const result = await runtime.openById('outlook');
  assert.deepEqual(requests, [{
    url: 'https://outlook.office.com/owa/', route: 'direct', displayName: 'Outlook',
  }]);
  assert.equal(result.resourceId, 'outlook');
  assert.equal(result.resources[0].lastOpenedAt, 10);
  assert.equal(result.resources[0].name, '邮箱');
  assert.equal(Object.hasOwn(result, 'url'), false);
  const effective = runtime.resolveRoutes(resources, () => ({
    route: 'campus', source: 'user-exact',
  }));
  assert.equal(effective[0].route, 'campus');
  assert.equal(effective[0].routeSource, 'user-exact',
    'resource labels must show the same effective route used by the browser');
});

test('reviewed URL additions migrate favorite recent and group IDs without losing activity', () => {
  class AliasedActivityStore extends FakeActivityStore {
    constructor(options) {
      super(options);
      this.favorites = { schemaVersion: 1, entries: ['custom-old'] };
      this.recent = {
        schemaVersion: 1,
        entries: [{ resourceId: 'custom-old', openedAt: 20 }],
      };
    }
  }
  class GroupStore {
    constructor() {
      this.document = {
        schemaVersion: 2,
        collections: [{ id: 'group_abcdefghijkl', name: '学习', createdAt: 1, updatedAt: 1 }],
        placements: [{ collectionId: 'group_abcdefghijkl', resourceId: 'custom-old', order: 0, pinned: false }],
      };
    }
    snapshot() { return structuredClone(this.document); }
    replace(document) { this.document = structuredClone(document); return this.document; }
    groups() { return this.document.collections.map(({ id, name }) => ({ id, name,
      resourceIds: this.document.placements.filter(({ collectionId }) => collectionId === id)
        .sort((left, right) => left.order - right.order).map(({ resourceId }) => resourceId),
    })); }
  }
  const runtime = new ResourceLibraryRuntime({
    favoritesFile: '/fixture/favorites.json', recentFile: '/fixture/recent.json',
    platform: 'darwin', loadResources: () => resources,
    loadAliases: () => [{ from: 'custom-old', to: 'outlook' }],
    captureContext: () => ({ epoch: 1 }), isContextCurrent: () => true,
    openRequest: async () => ({ ok: true }), ActivityStoreClass: AliasedActivityStore,
    GroupStoreClass: GroupStore,
  });
  assert.equal(runtime.list()[0].favorite, true);
  assert.equal(runtime.list()[0].lastOpenedAt, 20);
  assert.deepEqual(runtime.listGroups()[0].resourceIds, ['outlook']);
  assert.deepEqual(runtime.snapshot(), {
    favorites: { schemaVersion: 1, entries: ['outlook'] },
    recent: { schemaVersion: 1, entries: [{ resourceId: 'outlook', openedAt: 20 }] },
  });
});

test('resource presentation selects reviewed text for the active locale', () => {
  const runtime = new ResourceLibraryRuntime({
    favoritesFile: '/fixture/favorites.json',
    recentFile: '/fixture/recent.json',
    platform: 'darwin',
    loadResources: () => resources,
    captureContext: () => ({ epoch: 1 }),
    isContextCurrent: () => true,
    openRequest: async () => ({ ok: true }),
    ActivityStoreClass: FakeActivityStore,
    GroupStoreClass: EmptyGroupStore,
  });
  assert.equal(runtime.listLocalized(null, 'zh')[0].name, '邮箱');
  assert.equal(runtime.listLocalized(null, 'en')[0].name, 'Outlook');
  assert.equal(runtime.listLocalized(null, 'en')[0].description, 'Mail and calendar');
});

test('Browser navigation records a known resource by canonical URL without retaining SSO state', () => {
  const runtime = new ResourceLibraryRuntime({
    favoritesFile: '/fixture/favorites.json',
    recentFile: '/fixture/recent.json',
    platform: 'darwin',
    loadResources: () => resources,
    captureContext: () => ({ epoch: 1 }),
    isContextCurrent: () => true,
    openRequest: async () => ({ ok: true }),
    ActivityStoreClass: FakeActivityStore,
    GroupStoreClass: EmptyGroupStore,
  });
  assert.equal(runtime.recordOpenByUrl(
    'https://outlook.office.com/owa/?code=opaque#fragment',
  ), true);
  assert.deepEqual(runtime.snapshot().recent.entries, [{ resourceId: 'outlook', openedAt: 10 }]);
  assert.equal(runtime.recordOpenByUrl('https://unlisted.example/'), false);
});

test('failed or stale opens never record recent activity', async () => {
  const runtime = new ResourceLibraryRuntime({
    favoritesFile: '/fixture/favorites.json',
    recentFile: '/fixture/recent.json',
    platform: 'darwin',
    loadResources: () => resources,
    captureContext: () => ({ epoch: 1 }),
    isContextCurrent: () => true,
    openRequest: async () => ({ ok: false, error: 'offline' }),
    ActivityStoreClass: FakeActivityStore,
    GroupStoreClass: EmptyGroupStore,
  });
  assert.deepEqual(await runtime.openById('outlook'), { ok: false, error: 'offline' });
  assert.deepEqual(runtime.snapshot().recent.entries, []);
  await assert.rejects(() => runtime.openById('missing'), /unavailable/u);
});

test('an already stale Profile context opens no page', async () => {
  let openCalls = 0;
  const runtime = new ResourceLibraryRuntime({
    favoritesFile: '/fixture/favorites.json',
    recentFile: '/fixture/recent.json',
    platform: 'darwin',
    loadResources: () => resources,
    captureContext: () => ({ epoch: 1 }),
    isContextCurrent: () => false,
    openRequest: async () => { openCalls += 1; return { ok: true }; },
    ActivityStoreClass: FakeActivityStore,
    GroupStoreClass: EmptyGroupStore,
  });
  await assert.rejects(() => runtime.openById('outlook'), /stale/u);
  assert.equal(openCalls, 0);
});

test('resource display reads reuse activity and refresh after mutations', () => {
  let reads = 0;
  class CountedActivity extends FakeActivityStore {
    snapshot() { reads += 1; return super.snapshot(); }
  }
  class Groups {
    snapshot() { return { schemaVersion: 2, collections: [], placements: [] }; }
    groups() { return []; }
    removeResource() {}
  }
  const runtime = new ResourceLibraryRuntime({
    favoritesFile: '/fixture/favorites.json', recentFile: '/fixture/recent.json',
    platform: 'darwin', loadResources: () => resources,
    loadAliases: () => [{ from: 'custom-old', to: 'outlook' }],
    captureContext: () => ({}), isContextCurrent: () => true,
    openRequest: async () => ({ ok: true }),
    ActivityStoreClass: CountedActivity, GroupStoreClass: Groups,
  });
  for (let i = 0; i < 20; i += 1) { runtime.list(); runtime.listGroups(); }
  assert.equal(reads, 1, 'display polling must not repeatedly read files/Windows ACLs');
  runtime.toggleFavorite('outlook', resources);
  assert.equal(runtime.list()[0].favorite, true);
  assert.equal(reads, 2);
  runtime.recordOpenByUrl('https://outlook.office.com/owa/');
  assert.equal(runtime.list()[0].lastOpenedAt, 10);
  assert.equal(reads, 3);
  runtime.replaceFavorites({ schemaVersion: 1, entries: [] });
  assert.equal(runtime.list()[0].favorite, false);
  assert.equal(reads, 4);
});

test('collection display reads refresh after group mutations', () => {
  let reads = 0;
  class Groups extends EmptyGroupStore {
    constructor() { super(); this.document = super.snapshot(); }
    snapshot() { reads += 1; return this.document; }
    create(name) {
      this.document = { schemaVersion: 2, collections: [{
        id: 'group_abcdefghijkl', name, createdAt: 1, updatedAt: 1,
      }], placements: [] };
    }
    rename(id, name) {
      this.document = { ...this.document, collections: this.document.collections.map(
        (group) => group.id === id ? { ...group, name } : group) };
    }
    remove() { this.document = super.snapshot(); }
  }
  const runtime = new ResourceLibraryRuntime({
    favoritesFile: '/fixture/favorites.json', recentFile: '/fixture/recent.json',
    platform: 'darwin', loadResources: () => resources,
    captureContext: () => ({}), isContextCurrent: () => true,
    openRequest: async () => ({ ok: true }),
    ActivityStoreClass: FakeActivityStore, GroupStoreClass: Groups,
  });
  for (let i = 0; i < 20; i += 1) assert.deepEqual(runtime.listGroups(), []);
  assert.equal(reads, 1);
  runtime.createGroup('First');
  assert.equal(runtime.listGroups()[0].name, 'First');
  assert.equal(reads, 2);
  runtime.renameGroup('group_abcdefghijkl', 'Renamed');
  assert.equal(runtime.listGroups()[0].name, 'Renamed');
  runtime.deleteGroup('group_abcdefghijkl');
  assert.deepEqual(runtime.listGroups(), []);
  assert.equal(reads, 4);
  runtime.groupsSnapshot();
  assert.equal(reads, 5, 'explicit group snapshots still revalidate storage');
});
