'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const categoryStacks = require('../../../renderer/campus-category-stacks');

test('personal categories project favorites into groups with an ungrouped bucket first', () => {
  const resources = [
    { id: 'portal', name: 'Portal', reviewed: true, category: 'gateway', favorite: true },
    { id: 'sis', name: 'SIS', reviewed: true, category: 'courses', favorite: true },
    { id: 'apr', name: 'APR', reviewed: true, category: 'research', favorite: false },
    { id: 'custom', name: 'Custom', reviewed: false, category: 'custom', favorite: true },
  ];
  const personal = categoryStacks.personalCategoryProjection(resources, [{
    id: 'study', name: 'Study', resourceIds: ['sis'],
  }], (key) => key);
  assert.deepEqual(personal.map(({ id }) => id), ['ungrouped-favorites', 'study']);
  assert.deepEqual(personal.map(({ kind }) => kind), ['system-widget', 'user-collection']);
  assert.deepEqual(personal[0].items.map(({ id }) => id), ['portal', 'custom']);
});

test('a custom Profile with no reviewed catalogue retains personal categories', () => {
  const resources = [
    { id: 'custom', name: 'Custom', reviewed: false, favorite: true },
  ];
  const personal = categoryStacks.personalCategoryProjection(resources, [{
    id: 'study', name: 'Study', resourceIds: ['custom'],
  }], (key) => key);
  assert.deepEqual(personal.map(({ id, kind }) => ({ id, kind })), [{
    id: 'study', kind: 'user-collection',
  }]);
});

test('the official projection still feeds the pinned Connection copy', () => {
  const workspaceModel = require('../../../renderer/campus-workspace-model');
  const resources = [
    { id: 'portal', name: 'Portal', reviewed: true, category: 'gateway', favorite: false },
    { id: 'sis', name: 'SIS', reviewed: true, category: 'courses', favorite: false },
  ];
  const official = categoryStacks.officialCategoryProjection(resources, (key) => key, workspaceModel);
  assert.deepEqual(official.map(({ id }) => id), ['gateway', 'courses']);
  assert.deepEqual(official.map(({ kind }) => kind), ['official-category', 'official-category']);
});

test('the main window owns the personal deck board plus the pinned connect copy only', () => {
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', '..', '..', 'renderer', 'campus-category-stacks.js'), 'utf8',
  );
  assert.match(source, /boardId: 'browser-personal'/u);
  assert.match(source, /boardId: 'connect'/u);
  assert.doesNotMatch(source, /boardId: 'browser-catalog'/u,
    'the Official Service Desk replaced the catalog board in the control window');
  assert.doesNotMatch(source, /balancedPartitions|getLayoutCapacity|dealUnits/u);
});
