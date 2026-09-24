'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  FavoriteGroupStore,
  emptyGroupDocument,
  validateGroupDocument,
} = require('../../../../lib/resources/runtime/favorite-group-store');
const {
  protectWindowsFileOwnerOnly,
  verifyWindowsFileOwnerOnly,
} = require('../../../../lib/platform/storage/windows-private-file');

test('favorite collections are owner-only ordered and placements support many-to-many use', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-favorite-groups-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let seed = 1;
  const store = new FavoriteGroupStore({
    filePath: path.join(root, 'favorite-groups.json'),
    platform: process.platform,
    randomBytes: () => Buffer.alloc(12, seed++),
    now: () => 1_800_000_000_000 + seed,
  });
  assert.deepEqual(store.snapshot(), emptyGroupDocument());
  let document = store.create('学习');
  const learning = document.collections[0].id;
  document = store.create('科研');
  const research = document.collections[1].id;
  document = store.move('canvas', learning, 0, ['canvas', 'library']);
  assert.deepEqual(store.groups()[0].resourceIds, ['canvas']);
  document = store.move('library', learning, 0, ['canvas', 'library']);
  assert.deepEqual(store.groups()[0].resourceIds, ['library', 'canvas']);
  document = store.addMany(['canvas'], research, ['canvas', 'library']);
  assert.deepEqual(store.groups().map(({ resourceIds }) => resourceIds),
    [['library', 'canvas'], ['canvas']], 'one resource may serve multiple task collections');
  document = store.reorder([research, learning]);
  assert.deepEqual(store.groups().map(({ name }) => name), ['科研', '学习']);
  document = store.rename(research, '研究');
  assert.equal(store.groups()[0].name, '研究');
  document = store.remove(research);
  assert.deepEqual(store.groups().map(({ name }) => name), ['学习']);
  const file = path.join(root, 'favorite-groups.json');
  if (process.platform === 'win32') {
    assert.equal(verifyWindowsFileOwnerOnly(file), true);
  } else {
    assert.equal(fs.statSync(file).mode & 0o077, 0);
  }
});

test('v1 group documents migrate without losing order or resource identity', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-favorite-groups-v1-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'favorite-groups.json');
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, groups: [{
    id: 'group_abcdefghijkl', name: '学习', resourceIds: ['canvas', 'sis'],
  }] }), { mode: 0o600 });
  if (process.platform === 'win32') {
    // This is a newly created synthetic legacy document, not an existing user file.
    assert.equal(protectWindowsFileOwnerOnly(file), true);
    assert.equal(verifyWindowsFileOwnerOnly(file), true);
  }
  const store = new FavoriteGroupStore({ filePath: file, platform: process.platform });
  assert.equal(store.snapshot().schemaVersion, 2);
  assert.deepEqual(store.groups(), [{
    id: 'group_abcdefghijkl', name: '学习', resourceIds: ['canvas', 'sis'],
  }]);
});

test('collection schema rejects nesting and duplicate placement identity', () => {
  assert.throws(() => validateGroupDocument({ schemaVersion: 1, groups: [{
    id: 'group_abcdefghijkl', name: 'A', resourceIds: ['canvas'], children: [],
  }] }), /invalid/u);
  assert.throws(() => validateGroupDocument({ schemaVersion: 2, collections: [{
    id: 'group_abcdefghijkl', name: 'A', createdAt: 1, updatedAt: 1,
  }], placements: [
    { collectionId: 'group_abcdefghijkl', resourceId: 'canvas', order: 0, pinned: false },
    { collectionId: 'group_abcdefghijkl', resourceId: 'canvas', order: 1, pinned: false },
  ] }), /duplicated/u);
});
