'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const css = fs.readFileSync(path.join(
  __dirname, '..', '..', '..', '..', 'renderer', 'components', 'card-board', 'card-board.css',
), 'utf8');

test('the deck is a fixed slot of same-size absolutely stacked cards', () => {
  assert.match(css, /\.cb-deck\s*\{[^}]*position:\s*relative/su);
  assert.match(css, /\.cb-card\s*\{[^}]*position:\s*absolute/su);
  assert.doesNotMatch(css, /margin-top:\s*-\d+px/u, 'accordion negative margins are gone');
  assert.doesNotMatch(css, /--cb-stack-inset/u, 'progressively narrower cards are gone');
  assert.doesNotMatch(css, /transition:[^}]*\bheight\b/u, 'height animation is forbidden');
  assert.match(css, /\.cb-card\.is-front\s*\{[^}]*0 1px 2px rgba\(10,\s*35,\s*75,\s*\.04\),\s*0 10px 28px rgba\(10,\s*35,\s*75,\s*\.08\)/su,
    'the front card keeps the approved two-tier shadow');
  assert.match(css, /\.cb-card\s*\{[^}]*box-shadow:\s*0 1px 2px rgba\(10,\s*35,\s*75,\s*\.05\)/su,
    'back layers carry only the light shadow');
});

test('peeking back layers lift on hover without pushing any other card', () => {
  assert.match(css, /\.cb-deck:not\(\.cb-drawing\)\s+\.cb-card\.is-back:hover\s*\{[^}]*transform:\s*translateY\(-4px\)/su);
  assert.match(css, /\.cb-deck\.cb-drawing\s+\.cb-card\s*\{[^}]*pointer-events:\s*none/su,
    'repeat draws are throttled while the 240ms swap runs');
});

test('card content is container-driven with a hard two-column ceiling and a narrow tier', () => {
  assert.match(css, /\.cb-card-body\s*\{[^}]*container:\s*card-content\s*\/\s*inline-size/su);
  assert.match(css, /\.cb-site-list\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/su);
  assert.match(css, /@container\s+card-content\s*\(min-width:\s*360px\)\s*\{[\s\S]*?\.cb-site-list\s*\{[^}]*repeat\(2,/u);
  assert.doesNotMatch(css, /\.cb-site-list\s*\{[^}]*repeat\((?:3|4),/u);
  assert.match(css, /\.cb-deck\.cb-narrow\s+\.cb-site:nth-child\(n\+5\)\s*\{\s*display:\s*none/su,
    'narrow slots hide preview rows beyond four instead of reflowing the slot');
  assert.doesNotMatch(css, /\.cb-(?:card-body|site-list|deck)\s*\{[^}]*overflow-y:\s*(?:auto|scroll)/u,
    'card content must grow into the show-all overlay instead of nesting a scrollbar');
});

test('organize mode lifts the deck with a thin gold edge and keeps drop affordances', () => {
  assert.match(css, /\.cb-board-grid\[data-editing="true"\]\s+\.cb-deck\s*\{[^}]*outline:\s*1\.5px solid var\(--color-brand-gold/su);
  assert.match(css, /\.cb-board-grid\[data-editing="true"\]\s+\.cb-deck\s*\{[^}]*translateY\(-2px\)/su);
  assert.match(css, /\.cb-card\[data-dragging="true"\]\s*\{[^}]*scale\(1\.02\)/su);
  assert.match(css, /data-card-drop-target="stack"[^}]*outline:\s*2px solid var\(--color-brand-gold/su);
  assert.match(css, /\.cb-card-head\.is-draggable\s*\{[^}]*cursor:\s*grab/su);
  assert.doesNotMatch(css, /\.cb-drag-handle\s*\{/u,
    'the obsolete tiny drag handle is still absent');
});

test('card color is restrained to brand and sparse gold tones on approved surfaces', () => {
  assert.match(css, /data-card-tone="gold"/u, 'system widgets keep the sparse gold accent');
  for (const removedTone of ['blue', 'teal', 'violet', 'slate']) {
    assert.doesNotMatch(css, new RegExp(`data-card-tone="${removedTone}"`, 'u'));
  }
  assert.match(css, /\.cb-card\.is-front\s*\{[^}]*background:\s*var\(--color-surface/su);
  assert.match(css, /\.cb-card\s*\{[^}]*background:\s*var\(--color-panel/su,
    'back layers use the quiet panel surface');
  assert.match(css, /\.cb-category-icon\s*\{[^}]*color:\s*var\(--cb-tone\)[^}]*background:\s*var\(--cb-tone-soft\)/su);
});

test('the show-all overlay owns long lists so the slot never grows', () => {
  assert.match(css, /\.cb-overlay\s*\{[^}]*max-height:\s*min\(70vh/su);
  assert.match(css, /\.cb-overlay-body\s*\{[^}]*overflow-y:\s*auto/su);
  assert.match(css, /\.cb-card-foot\s*\{[^}]*height:\s*40px/su);
});

test('focus rings and Reduced Motion follow the shell contract', () => {
  assert.match(css, /\.cb-card-tab:focus-visible[\s\S]*?outline:\s*2px solid var\(--color-brand-navy/u);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.cb-card,[\s\S]*?\.cb-deck\s*\{[^}]*transition:\s*none\s*!important/su);
  assert.doesNotMatch(css, /cb-card-reveal/u, 'the accordion reveal animation is gone');
});

test('the Connection page pinned copy shares the same restrained frame', () => {
  assert.match(css, /\.connect-card-board\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/su);
  assert.match(css, /\.connect-card-board\[hidden\]\s*\{\s*display:\s*none/su);
  assert.match(css, /\.connect-card-board-heading\s+h2\s*\{[^}]*color:\s*var\(--color-brand-navy/su);
});
