'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const renderer = path.resolve(__dirname, '../../../renderer');

test('official favorites are imported through one native entrypoint without a global script', () => {
  const entry = path.join(renderer, 'features/official-favorites/index.mjs');
  assert.equal(fs.existsSync(entry), true, 'native favorite entrypoint exists');
  assert.deepEqual(Object.keys(require(entry)).sort(), ['comparableUrl', 'create']);
  assert.equal(fs.existsSync(path.join(renderer, 'official-favorite-dialog.js')), false);
  const app = fs.readFileSync(path.join(renderer, 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8');
  assert.ok(app.includes("rendererFeatures.mount('official-favorites', {"));
  assert.ok(!app.includes('favoriteDialogFeature.start()'));
  assert.doesNotMatch(app, /window\.officialFavoriteDialog/u);
  assert.doesNotMatch(html, /src="official-favorite-dialog\.js"/u);
  const source = fs.readFileSync(entry, 'utf8');
  assert.doesNotMatch(source, /\b(?:window|globalThis|root)\.\w+\s*=/u);
  assert.ok(source.split('\n').length < 250, 'feature owner remains bounded');
});
