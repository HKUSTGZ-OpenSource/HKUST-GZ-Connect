'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('Settings owns one persistent configurable new-tab address with a Bing default', () => {
  const html = read('renderer/index.html');
  const renderer = read('renderer/browser-new-tab-settings.js');
  const settings = read('lib/persistence/settings/settings-store.js');
  assert.match(html, /id="browserNewTabUrl"[^>]*maxlength="2048"/u);
  assert.match(html, /id="saveBrowserNewTabUrl"/u);
  assert.match(renderer, /api\.save\(\{ browserNewTabUrl:/u);
  assert.match(settings, /DEFAULT_BROWSER_NEW_TAB_URL\s*=\s*'https:\/\/www\.bing\.com\/'/u);
  assert.match(html, /about:blank/u);
});

test('Campus Browser replaces external-open chrome with the app settings action', () => {
  const html = read('renderer/campus-browser.html');
  const renderer = read('renderer/campus-browser.js');
  assert.match(html, /id="browserSettings"/u);
  assert.match(renderer, /command\('open-settings'\)/u);
  assert.doesNotMatch(html, /id="openExternal"/u);
});
