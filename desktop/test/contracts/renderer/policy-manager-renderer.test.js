'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const renderer = path.join(__dirname, '..', '..', '..', 'renderer');
const html = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(renderer, 'styles.css'), 'utf8');
const app = fs.readFileSync(path.join(renderer, 'app.js'), 'utf8');
const routing = fs.readFileSync(path.join(renderer, 'routing-manager.js'), 'utf8');
const certificates = fs.readFileSync(path.join(renderer, 'certificate-manager.js'), 'utf8');

test('routing-rule manager is bounded, accessible, local-only CRUD UI', () => {
  assert.match(html, /<dialog id="routingRulesDialog"[^>]*aria-labelledby="routingRulesTitle"[^>]*aria-describedby="routingRulesDescription"/);
  assert.match(html, /id="routingRuleStacks"[^>]*category-stack-grid[^>]*routing-stack-grid/u);
  assert.doesNotMatch(html, /id="routingRuleList"/u);
  assert.match(html, /id="routingRuleHost"[^>]*maxlength="2048"[^>]*autocomplete="off"/);
  assert.match(html, /id="routingRulePreview"[^>]*role="status"/u);
  assert.match(html, /id="routingRuleScope"[\s\S]*value="exact"[\s\S]*value="subdomains"/);
  assert.match(html, /id="routingRuleRoute"[\s\S]*value="campus"[\s\S]*value="direct"/);
  assert.match(html, /id="routingRuleError"[^>]*role="alert"/);
  assert.match(html, /id="deleteRoutingRule"[^>]*hidden/u);
  assert.match(routing, /api\.listRoutingRules\(\)/);
  assert.match(routing, /api\.previewRoutingTarget\(value\)/);
  assert.match(routing, /api\.saveRoutingRule\(payload\)/);
  assert.match(routing, /api\.deleteRoutingRule\(\{[\s\S]{0,120}host: rule\.host,[\s\S]{0,120}includeSubdomains: rule\.includeSubdomains/);
  assert.match(routing, /payload\.previous\s*=\s*\{/,
    'editing a host or scope must carry its previous stable identity');
  assert.match(routing, /pendingDeleteKey/,
    'destructive deletion must require an explicit second click');
  assert.match(routing, /\$\('manageRoutingRules'\)\.addEventListener\('click', \(\) => openNew\(\)\)/,
    'Control Tower must open the same routing manager directly');
  assert.match(routing, /api\.onOpenRoutingRules\?\.\(\(\) => \{[\s\S]{0,120}openTower\(\);[\s\S]{0,120}load\(\)/,
    'the campus browser opens the same inline rule stacks without sending page data');
  assert.match(routing, /function balancedPartitions\(/u,
    'routing rule stacks keep their bounded local partition helper');
  assert.match(routing, /role="region" aria-labelledby="\$\{headingId\}"/u,
    'the active routing card must expose a labelled region');
  assert.match(routing, /tabindex="-1" data-routing-heading/u,
    'a newly activated routing card must provide a programmatic heading focus target');
  assert.match(routing, /focus\(\{ preventScroll: true \}\)/u,
    'routing-card activation must move focus without resetting the scroll position');
  assert.match(routing, /renderSignature !== nextSignature/u,
    'stable ResizeObserver notifications must not rebuild routing-card markup');
  assert.match(app, /routingManager\.start\(\{[\s\S]{0,120}setPage\('tower'\)/);
  assert.doesNotMatch(html, /id="routeDomains"/,
    'the legacy bulk domain editor must not compete with the routing manager');
  assert.doesNotMatch(app, /\$\('routeDomains'\)/,
    'Control Tower must not mutate a second routing source');
  const routingDialog = html.slice(html.indexOf('<dialog id="routingRulesDialog"'),
    html.indexOf('</dialog>', html.indexOf('<dialog id="routingRulesDialog"')));
  assert.doesNotMatch(routingDialog, /(?:import|export|sync)/i,
    'the rule editor itself remains local-only and never mutates an external tool');
});

test('certificate manager reveals only origin, fingerprint, timestamp, and revoke controls', () => {
  assert.match(html, /<dialog id="certificatePinsDialog"[^>]*aria-labelledby="certificatePinsTitle"[^>]*aria-describedby="certificatePinsDescription"/);
  assert.match(html, /id="certificatePinList"[^>]*role="list"[^>]*data-i18n-attr="aria-label:certificates\.listLabel"/);
  assert.match(html, /id="certificatePinError"[^>]*role="alert"/);
  assert.match(certificates, /api\.listCertificatePins\(\)/);
  assert.match(certificates, /api\.deleteCertificatePin\(\{[\s\S]{0,120}origin: pin\.origin,[\s\S]{0,120}fingerprint: pin\.fingerprint/);
  assert.match(certificates, /pin\.origin/);
  assert.match(certificates, /pin\.fingerprint/);
  assert.match(certificates, /formatManagerTime\(pin\.updatedAt/);
  assert.match(certificates, /pendingOrigin/,
    'revocation must require an explicit second click');
  const certificateRenderer = certificates.slice(
    certificates.indexOf('function renderList()'),
    certificates.indexOf('function setBusy'),
  );
  assert.doesNotMatch(certificateRenderer, /issuer|subject|certificate(?:Data|Pem)|serial/i);
});

test('manager layout scrolls inside small windows and preserves keyboard focus visibility', () => {
  assert.match(css, /\.manager-dialog\s*\{[^}]*inset:\s*48px 12px 12px[^}]*overflow:\s*hidden/);
  assert.match(css, /\.manager-body\s*\{[^}]*overflow-y:\s*auto[^}]*overscroll-behavior:\s*contain/);
  assert.match(css, /button:focus-visible[\s\S]*outline:/);
  assert.match(css, /@media\s*\(max-width:\s*619px\)[\s\S]*\.manager-item\s*\{\s*grid-template-columns:\s*1fr/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
});

test('all server-provided policy values are escaped before dynamic markup', () => {
  const ruleRenderer = routing.slice(routing.indexOf('function ruleRows('),
    routing.indexOf('function updateFormMode'));
  assert.match(ruleRenderer, /esc\(rule\.host\)/);
  assert.match(ruleRenderer, /esc\(scope\)/);
  const pinRenderer = certificates.slice(
    certificates.indexOf('function renderList()'),
    certificates.indexOf('function setBusy'),
  );
  assert.match(pinRenderer, /esc\(pin\.origin\)/);
  assert.match(pinRenderer, /esc\(pin\.fingerprint\)/);
  assert.match(pinRenderer, /esc\(translate\('certificates\.updated'/);
});
