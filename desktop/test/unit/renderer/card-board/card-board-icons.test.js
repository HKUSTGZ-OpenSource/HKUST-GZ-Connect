'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const icons = require('../../../../renderer/components/card-board/card-board-icons');

test('official task categories use distinct local semantic icons', () => {
  const ids = [
    'gateway', 'courses', 'research', 'labs', 'student-finance', 'expenses',
    'documents', 'campus-life', 'career', 'tools', 'newcomer', 'staff',
  ];
  const markup = ids.map((id) => icons.categoryIcon('official-category', id));
  assert.equal(new Set(markup).size, ids.length);
  assert.equal(markup.every((value) => /^<svg[\s\S]*<\/svg>$/u.test(value)), true);
  assert.doesNotMatch(markup.join(''), /https?:|<img|style=/u);
});

test('personal collections and system widgets have separate bounded icons', () => {
  const collection = icons.categoryIcon('user-collection', 'local');
  const widget = icons.categoryIcon('system-widget', 'ungrouped-favorites');
  assert.notEqual(collection, widget);
  assert.match(collection, /<svg/u);
  assert.match(widget, /<svg/u);
  assert.doesNotMatch(collection, /M3\.5 7\.5h6l1\.7 2H20\.5v9\.5h-17z/u,
    'personal categories must not look like folders (DESIGN.md §1.2)');
});
