'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const model = require('../../../renderer/campus-workspace-model');

const resources = [
  { id: 'portal', name: 'Portal', category: 'gateway', favorite: false, lastOpenedAt: null, keywords: [] },
  { id: 'sis', name: 'SIS', category: 'courses', favorite: true, lastOpenedAt: 30, keywords: ['选课'] },
  { id: 'canvas', name: 'Canvas', category: 'courses', favorite: false, lastOpenedAt: 20, keywords: ['作业'] },
  { id: 'lims', name: 'LIMS', category: 'labs', favorite: false, lastOpenedAt: null, keywords: ['实验'] },
  { id: 'grade', name: 'Grade Reporting', category: 'staff', favorite: false, lastOpenedAt: null, keywords: ['教师'] },
];

test('Workspace navigation has one service screen, one organizer, and a transient search', () => {
  assert.deepEqual(model.normalizeNavigation({ screen: 'catalog', category: 'courses' }), {
    screen: 'home', query: '',
  });
  assert.deepEqual(model.normalizeNavigation({ screen: 'home', category: 'courses', query: ' SIS ' }), {
    screen: 'home', query: 'sis',
  });
});

test('Home gateways favorites recents and starter resources never duplicate', () => {
  const value = model.homeProjection(resources);
  assert.deepEqual(value.gateways.map(({ id }) => id), ['portal']);
  assert.deepEqual(value.favorites.map(({ id }) => id), ['sis']);
  assert.deepEqual(value.recent.map(({ id }) => id), ['canvas']);
  assert.equal(value.starter.some(({ id }) => id === 'sis'), false);
});

test('SIS belongs only to Courses and catalogue categories remain task-based', () => {
  assert.equal(model.categoryOf(resources[1]), 'courses');
  assert.deepEqual(model.catalogProjection(resources, 'courses').items.map(({ id }) => id), [
    'sis', 'canvas',
  ]);
  assert.deepEqual(model.catalogProjection(resources).categories.map(({ id }) => id), [
    'courses', 'labs', 'staff',
  ]);
});

test('Search uses real task vocabulary without changing primary categories', () => {
  assert.deepEqual(model.searchResources(resources, '选课').map(({ id }) => id), ['sis']);
  assert.deepEqual(model.searchResources(resources, '实验').map(({ id }) => id), ['lims']);
  assert.equal(model.categoryOf(resources[1]), 'courses');
});
