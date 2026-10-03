'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const renderer = path.resolve(__dirname, '../../../renderer');

test('connection overview styles are loaded once and scoped beneath the actual layout root', () => {
  const css = fs.readFileSync(path.join(renderer, 'features/connection-overview/view.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//gu, '');
  const selectors = [...css.matchAll(/^\s*([^@{}\n][^{}]*?)\s*\{/gmu)]
    .map(([, selector]) => selector.trim())
    .filter(selector => !/^(?:from|to|\d+%?)$/u.test(selector));
  assert.ok(selectors.length > 45, 'connection metrics and network-path presentation are feature-owned');
  for (const rule of selectors) {
    for (const selector of rule.split(',')) {
      assert.match(selector.trim(), /^:where\(\.connection-overview\)\s/u,
        `unscoped connection overview selector: ${selector}`);
    }
  }
  const html = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8');
  assert.equal(html.match(/href="features\/connection-overview\/view\.css"/gu)?.length, 1);
  assert.match(html, /class="connection-layout connection-overview"/u,
    'the metrics and topology remain under their existing shared layout node');
  assert.ok(html.indexOf('href="styles.css"') < html.indexOf('href="features/connection-overview/view.css"'));
});

test('connection overview CSS retains narrow focus and reduced-motion contracts outside the shell sheet', () => {
  const featureCss = fs.readFileSync(path.join(renderer, 'features/connection-overview/view.css'), 'utf8');
  const sharedCss = fs.readFileSync(path.join(renderer, 'styles.css'), 'utf8');
  assert.match(featureCss, /:where\(\.connection-overview\) \.network-underlay-source:focus-visible/u);
  assert.match(featureCss, /@media\s*\(max-width:\s*609px\)/u);
  assert.match(featureCss, /@media\s*\(max-width:\s*519px\)/u);
  assert.match(featureCss, /@media\s*\(prefers-reduced-motion:\s*reduce\)/u);
  assert.doesNotMatch(sharedCss, /\.network-(?:topology|path-details|tree|underlay|interface|source|egress)/u);
  assert.doesNotMatch(sharedCss, /\.connection-metrics|\.connection-metric|\.latency-sparkline/u);
});
