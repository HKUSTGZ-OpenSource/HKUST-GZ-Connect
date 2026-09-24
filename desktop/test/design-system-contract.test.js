'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const renderer = path.join(__dirname, '..', 'renderer');
const tokens = fs.readFileSync(path.join(renderer, 'design-tokens.css'), 'utf8');
const controlHtml = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8');
const browserHtml = fs.readFileSync(path.join(renderer, 'campus-browser.html'), 'utf8');
const controlCss = fs.readFileSync(path.join(renderer, 'styles.css'), 'utf8');
const cardBoardCss = fs.readFileSync(path.join(renderer, 'components', 'card-board', 'card-board.css'), 'utf8');
const browserCss = fs.readFileSync(path.join(renderer, 'campus-browser.css'), 'utf8');
const workspaceCss = fs.readFileSync(path.join(renderer, 'campus-workspace.css'), 'utf8');

function relativeLuminance(hex) {
  const channels = hex.match(/[0-9a-f]{2}/giu).map((part) => Number.parseInt(part, 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground, background) {
  const values = [relativeLuminance(foreground), relativeLuminance(background)]
    .sort((left, right) => right - left);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test('control panel and Campus Browser share one bounded design-token vocabulary', () => {
  for (const token of [
    '--color-brand-navy',
    '--color-brand-gold',
    '--space-4',
    '--radius-card',
    '--motion-standard',
    '--shadow-lg',
  ]) assert.match(tokens, new RegExp(`${token}:`, 'u'));
  for (const html of [controlHtml, browserHtml]) {
    const tokensAt = html.indexOf('design-tokens.css');
    const surfaceAt = html.indexOf(html === controlHtml ? 'styles.css' : 'campus-browser.css');
    assert.ok(tokensAt > 0 && tokensAt < surfaceAt, 'design tokens must load before surface CSS');
  }
  assert.deepEqual([...controlHtml.matchAll(/<link rel="stylesheet" href="([^"]+)"/gu)].map(match => match[1]),
    ['design-tokens.css', 'styles.css', 'features/campus-data/view.css', 'components/card-board/card-board.css'],
    'load tokens, shared shell, owned calendar presentation and shared card-board in order');
  assert.ok(controlHtml.indexOf('styles.css') < controlHtml.indexOf('components/card-board/card-board.css'),
    'component CSS must be layered after the canonical shell surface');
  assert.doesNotMatch(controlHtml, /styles\/(?:connection-strip|product-shell)\.css/u);
  assert.doesNotMatch(controlCss, /^:root\s*\{/u, 'control CSS must not redefine shared tokens');
  assert.match(browserCss, /var\(--radius-control\)/u);
  assert.match(browserCss, /var\(--motion-fast\)/u);
});

test('Campus Workspace keeps one official main-card deck separate from personal decks', () => {
  assert.match(cardBoardCss, /\.cb-board-grid\s*\{[^}]*repeat\(var\(--cb-columns/u);
  assert.match(cardBoardCss, /\.cb-card-head\s*\{[^}]*height:\s*56px/u);
  assert.match(cardBoardCss, /\.cb-card\s*\{[^}]*border-radius:\s*14px/u);
  assert.match(cardBoardCss, /@container\s+card-content\s*\(min-width:\s*360px\)[\s\S]*repeat\(2,/u);
  assert.match(cardBoardCss, /\.cb-site-icon\s*\{[^}]*width:\s*22px[^}]*height:\s*22px/u);
  assert.match(controlHtml, /data-page="browser"/u);
  assert.match(controlHtml, /id="resourceSearch"/u);
  assert.match(controlHtml, /id="serviceTabOfficial"[^>]*role="tab"/u);
  assert.match(controlHtml, /id="serviceTabPersonal"[^>]*role="tab"/u);
  assert.match(controlHtml, /class="ws-tabs" role="tablist"/u);
  assert.match(controlHtml, /id="officialMainDeck"[^>]*role="tablist"/u,
    'My Applications and the Student Service Desk share one main-card deck');
  assert.match(controlCss, /\.official-main-card\.is-back/u);
  assert.match(controlCss, /\.official-main-card\.is-front/u);
  assert.match(controlHtml, /id="campusResources"[^>]*class="card-board-mount"/u);
  assert.match(controlHtml, /id="connectCardBoardHost"[^>]*class="cb-board-host"/u);
  assert.doesNotMatch(controlHtml, /category-kicker|categoryModeCatalog|id="resourceShelf"/u);
  assert.doesNotMatch(controlHtml, /data-page="connect"[\s\S]*id="moduleSchedule"[\s\S]*data-page="browser"/u,
    'the data modules belong to the Campus Workspace page only');
});

test('auxiliary copy retains AA contrast and legible compact metadata sizes', () => {
  const muted = tokens.match(/--color-text-muted:\s*(#[0-9a-f]{6})/iu)?.[1];
  const workspaceMuted = workspaceCss.match(/--workspace-muted:\s*(#[0-9a-f]{6})/iu)?.[1];
  assert.ok(muted && contrastRatio(muted, '#f4f7fb') >= 4.5,
    'control helper text must meet WCAG AA on the light field surface');
  assert.ok(workspaceMuted && contrastRatio(workspaceMuted, '#f4f7fb') >= 4.5,
    'workspace helper text must meet WCAG AA on its background');
  assert.match(controlCss, /\.page-sub\s*\{[^}]*font-size:\s*12px/u);
  assert.match(controlCss, /\.routing-rule-row \.category-site-copy small\s*\{[^}]*font-size:\s*10\.5px/u);
  assert.match(controlCss, /\.routing-rule-edit\s*\{[^}]*font-size:\s*10\.5px/u);
  assert.match(controlCss, /@media\s*\(max-width:\s*519px\)[\s\S]*\.category-site-copy small\s*\{[^}]*font-size:\s*10\.5px/u);
  assert.match(workspaceCss, /\.resource-route\s*\{[^}]*font-size:\s*12px/u);
});

test('connection-first shell preserves restrained brand controls and progressive disclosure', () => {
  assert.match(controlCss, /\.titlebar\s*\{[^}]*justify-content:\s*center[^}]*1\.5px solid var\(--gold\)/u);
  assert.match(controlCss, /\.sidebar\s*\{[^}]*flex:\s*0 0 72px/u);
  assert.match(controlCss, /\.nav\.active\s*\{[^}]*box-shadow:\s*0 6px 16px/u);
  assert.match(controlCss, /\.connection-layout\s*\{[^}]*grid-template-columns:/u);
  assert.match(controlCss, /\.network-path-details\s*\{[^}]*border-radius:\s*14px/u);
  assert.match(controlHtml, /id="networkPathDetails"[^>]*class="network-path-details"/u);
  assert.match(controlHtml, /id="power"[^>]*class="connection-action"|class="connection-action"[^>]*id="power"/u);
  assert.match(controlHtml, /id="power"[^>]*role="switch"|role="switch"[^>]*id="power"/u);
  assert.match(controlCss, /#power\.connection-action\s*\{[^}]*width:\s*52px[^}]*height:\s*29px/u);
  assert.match(controlHtml, /id="notificationDrawer"[^>]*role="dialog"/u);
  assert.doesNotMatch(controlHtml, /class="nav" data-page="notif"/u);
  assert.match(controlCss, /\.resource-favorite:hover,\s*\.resource-favorite\.active\s*\{[^}]*background:\s*transparent/u);
  assert.match(controlCss, /\.logs\s*\{[^}]*min-height:\s*320px[^}]*max-height:\s*420px/u);
  assert.doesNotMatch(controlHtml, /class="help-section"/u);
  assert.match(browserCss, /\.icon\s*\{[^}]*border:\s*0/u);
  assert.match(browserCss, /\.state\.loading\s*\{[^}]*display:\s*block/u);
  assert.ok(browserHtml.indexOf('id="address"') < browserHtml.indexOf('id="routeBadge"'),
    'the route state belongs at the trailing edge of the address field');
  assert.match(browserHtml, /id="browserSettings"/u);
});
