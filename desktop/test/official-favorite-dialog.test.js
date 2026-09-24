'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { comparableUrl } = require('../renderer/features/official-favorites/index.mjs');

test('official favorites compare credential-free HTTPS URLs without page fragments', () => {
  assert.equal(
    comparableUrl('https://myportal.hkust-gz.edu.cn/app?id=7#section'),
    'https://myportal.hkust-gz.edu.cn/app?id=7',
  );
  assert.equal(comparableUrl('not a url'), '');
});
