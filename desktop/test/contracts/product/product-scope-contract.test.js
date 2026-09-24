'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..', '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, ...relativePath.split('/')), 'utf8');
}

test('2.0 keeps Web resources and external tool integration as separate product domains', () => {
  const product = read('docs/product/2.0-product-definition.md');
  const resources = read('docs/architecture/resource-domain-model.md');
  const integrations = read('docs/adr/0005-external-tool-integration-center.md');

  assert.match(product, /ordinary user[\s\S]*Campus Workspace/iu);
  assert.match(product, /External Tool Integration Center/u);
  assert.match(resources, /WebResource[\s\S]*localizedName[\s\S]*route[\s\S]*category/u);
  assert.match(resources, /Main resolves the ID in the active Profile\/Account resource store/u);
  assert.doesNotMatch(resources, /^ResourceDescriptorInternal$/mu);
  assert.doesNotMatch(resources, /^A `LaunchHandle` is:/mu);
  assert.doesNotMatch(resources, /^ResourceLaunchBroker/mu);

  assert.match(integrations, /only generates two non-destructive configuration artifacts/u);
  assert.match(integrations, /never downloads, installs, launches, detects, or updates third-party software/u);
  assert.match(integrations, /VS Code Remote-SSH output is a standard SSH host template/u);
  assert.match(integrations, /must not be uploaded, synchronized or shared/u);
  assert.match(integrations, /trusted IPC rejects every historical or unknown adapter ID/u);
});

test('2.0 phase order keeps isolated school selection before integrations and Web work', () => {
  const plan = read('docs/plans/2.0-preparation-execution-plan.md');
  const p6 = plan.indexOf('### 2.0-P6 — Implemented school selector and isolated experimental custom domain');
  const p7 = plan.indexOf('### 2.0-P7 — Shared Profile Network Rules and External Tool Integration Center');
  const p8 = plan.indexOf('### 2.0-P8 — Lightweight WebResource and ordinary-user Campus Workspace upgrade');
  assert.ok(p6 >= 0 && p7 > p6 && p8 > p7);
  assert.doesNotMatch(plan, /P8b\s+—\s+External Tool Integration Center/u);
  assert.match(plan, /P6 custom path accepts only a bounded HTTPS domain\/port/u);
});

test('the first Beta has no built-in SSH HPC Jupyter database or forwarding workbench module', () => {
  for (const relativePath of [
    'desktop/hpc',
    'desktop/ssh-client',
    'desktop/jupyter',
    'desktop/database-launcher',
    'desktop/forwarding-workbench',
    'independent/src/hpc',
    'independent/src/ssh-client',
    'independent/src/jupyter',
    'independent/src/database-launcher',
    'independent/src/forwarding-workbench',
  ]) {
    assert.equal(fs.existsSync(path.join(root, ...relativePath.split('/'))), false, relativePath);
  }
});

test('production contains no retired third-party installer or managed-config module', () => {
  for (const relativePath of [
    'desktop/lib/integrations/clash-verge-managed-coordinator.js',
    'desktop/lib/integrations/clash-verge-script.js',
    'desktop/lib/integrations/integration-record-store.js',
    'desktop/lib/integrations/managed-adapter-transaction.js',
    'desktop/lib/integrations/managed-file-transaction.js',
    'desktop/lib/integrations/managed-text-block.js',
    'desktop/lib/integrations/openssh-managed-config.js',
    'desktop/lib/integrations/openssh-managed-coordinator.js',
  ]) {
    assert.equal(fs.existsSync(path.join(root, ...relativePath.split('/'))), false, relativePath);
  }
  const preload = read('desktop/preload.js');
  const coreIpc = read('desktop/lib/ipc/core-control-ipc.js');
  assert.doesNotMatch(`${preload}\n${coreIpc}`, /copy-clash-node|ssh-config/u);
});

test('generic Campus Browser contains no HKUST default home title or partition fallback', () => {
  const sources = [
    read('desktop/lib/browser/session/campus-browser.js'),
    read('desktop/lib/browser/session/campus-browser-manager.js'),
    read('desktop/renderer/campus-browser.html'),
    read('desktop/renderer/campus-browser.js'),
  ].join('\n');
  assert.doesNotMatch(sources, /hkust|HKUST/u);
  assert.match(sources, /campus-workspace-neutral|BLANK_CAMPUS_HOME/u);
});

test('generic routing and health modules contain no HKUST deployment defaults', () => {
  const sources = [
    read('desktop/lib/routing/policy/campus-route.js'),
    read('desktop/lib/routing/policy/route-resolver.js'),
    read('desktop/lib/routing/policy/domain-route-policy.js'),
    read('desktop/lib/routing/pac/pac.js'),
    read('desktop/lib/connection/recovery/health-supervisor.js'),
  ].join('\n');
  assert.doesNotMatch(sources, /hkust|remote\.hkust/iu);
  assert.match(sources, /Deployment domains are Profile authority/u);
});

test('2.0 product exposes safe other-school onboarding instead of packaging it away', () => {
  const mainSource = read('desktop/main.js');
  assert.match(mainSource, /customGatewayProductAvailability\(\)/u);
  assert.doesNotMatch(mainSource, /customGatewayOnboardingEnabled\s*=\s*!app\.isPackaged/u);
});
