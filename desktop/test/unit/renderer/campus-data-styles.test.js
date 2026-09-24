'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const renderer = path.resolve(__dirname, '../../../renderer');
const read = name => fs.readFileSync(path.join(renderer, name), 'utf8');

test('calendar presentation is explicitly loaded once and scoped to its feature root', () => {
  const css = read('features/campus-data/view.css').replace(/\/\*[\s\S]*?\*\//gu, '');
  const rules = [...css.matchAll(/([^{}]+)\{[^{}]*\}/gu)];
  assert.ok(rules.length > 70, 'the complete calendar presentation is feature owned');
  for (const [, selectors] of rules) {
    for (const selector of selectors.split(',')) {
      assert.match(selector.trim(), /^(?::where\(\.module-schedule\) |\.module-schedule(?:\[| ))/u,
        `unscoped calendar selector: ${selector}`);
    }
  }
  assert.doesNotMatch(css, /cb-service-overlay/u, 'category dialogs are not calendar owned');
  assert.doesNotMatch(read('styles.css'), /\.week-[\w-]+/u, 'no global calendar rules remain');
  const html = read('index.html');
  assert.equal(html.match(/href="features\/campus-data\/view\.css"/gu)?.length, 1);
  assert.ok(html.indexOf('href="styles.css"') < html.indexOf('href="features/campus-data/view.css"'));
});

test('calendar and category dialogs retain their separate native centering rules', () => {
  const center = /position:\s*fixed;\s*inset:\s*0;\s*margin:\s*auto;\s*height:\s*fit-content/u;
  assert.match(read('features/campus-data/view.css').match(/\.week-detail\s*\{([^}]+)\}/u)[1], center);
  assert.match(read('styles.css').match(/\.cb-service-overlay\s*\{([^}]+)\}/u)[1], center);
});
