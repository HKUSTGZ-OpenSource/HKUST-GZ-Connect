'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  normalizeOpenRequest,
  requiresCampusTunnel,
} = require('../../../../lib/browser/session/campus-browser-manager');

test('open requests fail safe to Campus unless Profile authority supplies an explicit route', () => {
  assert.deepEqual(normalizeOpenRequest('outlook.office.com/owa/'), {
    url: 'https://outlook.office.com/owa/',
    route: 'campus',
  });
  assert.deepEqual(normalizeOpenRequest({
    url: 'https://outlook.office.com/owa/',
    route: 'direct',
    displayName: 'Outlook 邮箱',
  }), {
    url: 'https://outlook.office.com/owa/',
    route: 'direct',
    displayName: 'Outlook 邮箱',
  });
  assert.deepEqual(normalizeOpenRequest({ url: 'https://outlook.office.com/owa/', route: 'campus' }), {
    url: 'https://outlook.office.com/owa/',
    route: 'campus',
  });
});

test('loading labels are bounded plain text or rejected', () => {
  assert.throws(() => normalizeOpenRequest({
    url: 'https://example.edu/', displayName: '<img>',
  }), /display name/u);
  assert.throws(() => normalizeOpenRequest({
    url: 'https://example.edu/', displayName: 'x'.repeat(97),
  }), /display name/u);
});

test('only campus requests require the engine', () => {
  assert.equal(requiresCampusTunnel('campus'), true);
  assert.equal(requiresCampusTunnel('direct'), false);
});
