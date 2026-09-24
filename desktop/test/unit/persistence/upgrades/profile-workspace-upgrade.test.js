'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const fixture = require('../../../../e2e/fixtures/2.0.1-workspace-upgrade.json');
const packageDocument = require('../../../../package.json');
const {
  parseBuiltinResourceDocument,
} = require('../../../../lib/resources/schema/campus-resource-contract');
const {
  mergeWebResourceLibrary,
} = require('../../../../lib/resources/runtime/campus-resources');
const {
  projectResourceActivity,
} = require('../../../../lib/resources/runtime/resource-activity');
const {
  ResourceActivityStore,
} = require('../../../../lib/resources/runtime/resource-activity-store');
const {
  FavoriteGroupStore,
  emptyGroupDocument,
} = require('../../../../lib/resources/runtime/favorite-group-store');
const {
  validateLocalResourcesDocument,
} = require('../../../../lib/persistence/schema/profile-workspace-documents');
const {
  loadRoutingRules,
} = require('../../../../lib/routing/rules/routing-rule-store');
const { protectWindowsFileOwnerOnly, verifyWindowsFileOwnerOnly } = require('../../../../lib/platform/storage/windows-private-file');

const desktopRoot = path.resolve(__dirname, '..', '..', '..', '..');
const reviewedResourcesFile = path.join(
  desktopRoot, 'assets', 'profiles', 'hkustgz', 'builtin-resources.json',
);

function writeFixture(file, document) {
  fs.writeFileSync(file, `${JSON.stringify(document)}\n`, { mode: 0o600 });
  if (process.platform === 'win32') {
    assert.equal(protectWindowsFileOwnerOnly(file), true);
    assert.equal(verifyWindowsFileOwnerOnly(file), true);
  }
}

test('2.0 workspace upgrade keeps URLs favorites recents hidden sites and routing', (t) => {
  assert.equal(packageDocument.name, 'hkustgzconnect');
  assert.equal(packageDocument.build.appId, 'cn.edu.hkust-gz.connect');

  const reviewed = parseBuiltinResourceDocument(fs.readFileSync(reviewedResourcesFile));
  const reviewedIds = new Set(reviewed.map(({ id }) => id));
  for (const id of fixture.previousBuiltinResourceIds) {
    assert.equal(reviewedIds.has(id), true, `published resource ID disappeared: ${id}`);
  }

  const local = validateLocalResourcesDocument(fixture.localResources);
  const resources = mergeWebResourceLibrary(
    reviewed, local.resources, local.hiddenBuiltinResourceIds,
  );
  assert.equal(resources.some(({ id }) => id === 'room-booking'), false);
  assert.equal(resources.some(({ id, url }) => id === 'custom-upgrade-fixture' &&
    url === 'https://portal.upgrade-fixture.example.edu/'), true);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-upgrade-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const favoritesFile = path.join(root, 'favorites.json');
  const groupsFile = path.join(root, 'favorite-groups.json');
  const recentFile = path.join(root, 'recent-resources.json');
  const routingFile = path.join(root, 'routing-rules.json');
  writeFixture(favoritesFile, fixture.favorites);
  writeFixture(recentFile, fixture.recentResources);
  writeFixture(routingFile, fixture.routingRules);

  const restarted = new ResourceActivityStore({ favoritesFile, recentFile });
  assert.deepEqual(restarted.snapshot(), {
    favorites: fixture.favorites,
    recent: fixture.recentResources,
  });

  // 2.0.1 introduces folders as a sidecar. An existing workspace has no such
  // file, so every old favorite must remain visible as "ungrouped" without
  // rewriting favorites.json. Once created, folder order and membership must
  // survive a restart independently from the original activity documents.
  const originalFavorites = fs.readFileSync(favoritesFile, 'utf8');
  const groups = new FavoriteGroupStore({
    filePath: groupsFile,
    platform: process.platform,
    randomBytes: () => Buffer.alloc(12, 7),
  });
  assert.deepEqual(groups.snapshot(), emptyGroupDocument());
  assert.equal(fs.existsSync(groupsFile), false);
  const created = groups.create('学习与科研');
  groups.move(
    'custom-upgrade-fixture',
    created.collections[0].id,
    0,
    fixture.favorites.entries,
  );
  const restartedGroups = new FavoriteGroupStore({ filePath: groupsFile, platform: process.platform });
  assert.equal(restartedGroups.snapshot().schemaVersion, 2);
  assert.deepEqual(restartedGroups.groups().map(({ name, resourceIds }) => ({
    name, resourceIds,
  })), [{ name: '学习与科研', resourceIds: ['custom-upgrade-fixture'] }]);
  assert.equal(fs.readFileSync(favoritesFile, 'utf8'), originalFavorites);
  assert.deepEqual(restarted.snapshot().favorites, fixture.favorites);
  const projected = projectResourceActivity(
    resources, fixture.favorites, fixture.recentResources,
  );
  for (const id of fixture.favorites.entries) {
    assert.equal(projected.find((resource) => resource.id === id)?.favorite, true, id);
  }
  assert.equal(projected.find(({ id }) => id === 'custom-upgrade-fixture')?.lastOpenedAt,
    1700000002000);
  assert.deepEqual(loadRoutingRules(routingFile), fixture.routingRules.rules);
});

test('desktop package identities preserve in-place upgrades on every supported platform', () => {
  assert.equal(packageDocument.build.appId, 'cn.edu.hkust-gz.connect');
  assert.equal(packageDocument.build.productName, 'hkustgzconnect');
  assert.deepEqual(packageDocument.build.nsis, {
    oneClick: false,
    allowToChangeInstallationDirectory: false,
    perMachine: false,
  });
  assert.deepEqual(packageDocument.build.mac.target[0], {
    target: 'dmg',
    arch: ['arm64', 'x64'],
  });
  assert.deepEqual(packageDocument.build.linux.target[0], {
    target: 'AppImage',
    arch: ['x64'],
  });
});
