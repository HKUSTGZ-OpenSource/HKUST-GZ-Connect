'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { navigationForContents } = require('../../../../lib/browser/session/campus-browser');

test('Electron navigationHistory is preferred without touching deprecated WebContents APIs', () => {
  const calls = [];
  const contents = {
    navigationHistory: {
      canGoBack() { calls.push('modern-can-back'); return true; },
      canGoForward() { calls.push('modern-can-forward'); return true; },
      goBack() { calls.push('modern-back'); },
      goForward() { calls.push('modern-forward'); },
    },
    canGoBack() { throw new Error('deprecated canGoBack called'); },
    canGoForward() { throw new Error('deprecated canGoForward called'); },
    goBack() { throw new Error('deprecated goBack called'); },
    goForward() { throw new Error('deprecated goForward called'); },
  };
  const navigation = navigationForContents(contents);
  assert.equal(navigation.canGoBack(), true);
  assert.equal(navigation.canGoForward(), true);
  assert.equal(navigation.goBack(), true);
  assert.equal(navigation.goForward(), true);
  assert.deepEqual(calls, [
    'modern-can-back', 'modern-can-forward', 'modern-back', 'modern-forward',
  ]);
});

test('legacy Electron APIs remain a bounded fallback', () => {
  const calls = [];
  const navigation = navigationForContents({
    canGoBack() { calls.push('legacy-can-back'); return true; },
    canGoForward() { calls.push('legacy-can-forward'); return false; },
    goBack() { calls.push('legacy-back'); },
    goForward() { calls.push('legacy-forward'); },
  });
  assert.equal(navigation.canGoBack(), true);
  assert.equal(navigation.canGoForward(), false);
  assert.equal(navigation.goBack(), true);
  assert.equal(navigation.goForward(), true);
  assert.deepEqual(calls, [
    'legacy-can-back', 'legacy-can-forward', 'legacy-back', 'legacy-forward',
  ]);
});

test('missing or throwing history methods fail closed', () => {
  const empty = navigationForContents(null);
  assert.equal(empty.canGoBack(), false);
  assert.equal(empty.canGoForward(), false);
  assert.equal(empty.goBack(), false);
  assert.equal(empty.goForward(), false);

  const throwing = navigationForContents({
    navigationHistory: {
      canGoBack() { throw new Error('gone'); },
      canGoForward() { throw new Error('gone'); },
      goBack() { throw new Error('gone'); },
      goForward() { throw new Error('gone'); },
    },
  });
  assert.equal(throwing.canGoBack(), false);
  assert.equal(throwing.canGoForward(), false);
  assert.equal(throwing.goBack(), false);
  assert.equal(throwing.goForward(), false);
});

test('CampusBrowser no longer invokes deprecated navigation methods directly', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', '..', 'lib', 'browser', 'session', 'campus-browser.js'),
    'utf8',
  );
  assert.doesNotMatch(source, /webContents\.(?:canGoBack|canGoForward|goBack|goForward)\(/);
  assert.doesNotMatch(source, /\bcontents\.(?:canGoBack|canGoForward|goBack|goForward)\(/);
  assert.match(source, /navigationForContents\(active\?\.view\.webContents\)/);
  assert.match(source, /navigationForContents\(contents\)/);
});
