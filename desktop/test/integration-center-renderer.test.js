'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  adapterView,
  createIntegrationCenter,
  previewView,
} = require('../renderer/features/integration-center/index.mjs');

const IDS = [
  'integrationList', 'integrationStatus', 'integrationError', 'integrationDialog',
  'integrationPreviewName', 'integrationPreviewSummary', 'integrationPreviewWarnings',
  'integrationDialogError', 'closeIntegrationDialog', 'cancelIntegration', 'confirmIntegration',
];

function element() {
  return {
    children: [], listeners: new Map(), textContent: '', className: '', disabled: false,
    open: false, dataset: {},
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    addEventListener(name, callback) { this.listeners.set(name, callback); },
    removeEventListener(name) { this.listeners.delete(name); },
    showModal() { this.open = true; },
    close() { this.open = false; },
  };
}

function view(adapterId, bindingState = 'not-installed') {
  return {
    schemaVersion: 1,
    adapterId,
    displayName: adapterId,
    supportedActions: adapterId === 'vscode_remote_ssh'
      ? ['preview', 'copy']
      : ['preview', 'copy', 'save'],
    compatibilityState: 'supported',
    bindingState,
    updatedAt: null,
    targetFile: '/must-not-cross',
  };
}

function fixture(overrides = {}) {
  const elements = new Map(IDS.map((id) => [id, element()]));
  const calls = [];
  let expiry = null;
  const api = {
    listIntegrations: async () => ({
      ok: true,
      integrations: overrides.views || [
        view('clash_mihomo_yaml'), view('vscode_remote_ssh'),
      ],
    }),
    prepareIntegration: async (request) => {
      calls.push(['prepare', request]);
      return overrides.prepareResult || {
        ok: true,
        preview: {
          schemaVersion: 1,
          confirmationHandle: `export-${'a'.repeat(32)}`,
          adapterId: request.adapterId,
          action: request.action,
          expiresAt: 1_800_000_020_000,
          fileCount: 2,
          changes: { create: 1, replace: 1, remove: 0, unchanged: 0 },
          containsLocalProxyCredential: true,
          warningCodes: ['INTEGRATION_LOCAL_CREDENTIAL_PRIVATE'],
          payload: 'must-not-cross',
          targetFile: '/must-not-cross',
        },
      };
    },
    confirmIntegration: async (request) => {
      calls.push(['confirm', request]); return overrides.confirmResult || { ok: true };
    },
    cancelIntegration: async () => { calls.push(['cancel']); return { ok: true }; },
  };
  const document = {
    getElementById: (id) => elements.get(id),
    createElement: () => element(),
  };
  const feature = createIntegrationCenter({
    api, document,
    translate: (key, vars = {}) => `${key}:${Object.values(vars).join(':')}`,
    now: () => 1_800_000_000_000,
    setTimeoutFn: (callback) => { expiry = callback; return { unref() {} }; },
    clearTimeoutFn: () => { expiry = null; },
  });
  return { api, calls, elements, feature, expire: () => expiry?.() };
}

test('Renderer projections drop paths payloads keys and unknown adapters', () => {
  const projected = adapterView(view('clash_mihomo_yaml'));
  assert.equal(projected.adapterId, 'clash_mihomo_yaml');
  assert.equal(Object.hasOwn(projected, 'targetFile'), false);
  assert.equal(adapterView(view('user_selected_managed_block')), null);
  const preview = previewView({
    schemaVersion: 1,
    confirmationHandle: `export-${'b'.repeat(32)}`,
    adapterId: 'clash_mihomo_yaml', action: 'copy', expiresAt: 1_800_000_020_000,
    containsLocalProxyCredential: true,
    warningCode: 'INTEGRATION_LOCAL_CREDENTIAL_PRIVATE',
    targetFile: '/private', payload: 'secret', accountKey: 'forbidden',
  }, 1_800_000_000_000);
  assert.equal(Object.hasOwn(preview, 'targetFile'), false);
  assert.equal(JSON.stringify(preview).includes('secret'), false);
});

test('list renders both non-destructive exporters and their bounded actions', async () => {
  const f = fixture();
  f.feature.start();
  await f.feature.refresh();
  const rows = f.elements.get('integrationList').children;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].children[1].children.length, 2,
    'combined Clash / Mihomo adapter has copy and save');
  assert.equal(rows[1].children[1].children.length, 1, 'VS Code snippet is copy-only');
  assert.equal(f.elements.get('integrationError').textContent, '');
});

test('one unavailable exporter does not hide an independent supported exporter', async () => {
  const unavailable = { ...view('clash_mihomo_yaml'), compatibilityState: 'unavailable',
    bindingState: 'unavailable' };
  const f = fixture({ views: [unavailable, view('vscode_remote_ssh')] });
  f.feature.start();
  await f.feature.refresh();
  const rows = f.elements.get('integrationList').children;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].children[1].children.length, 0);
  assert.equal(rows[1].children[1].children.length, 1);
});

test('prepare shows only a redacted preview and confirm consumes its exact handle', async () => {
  const f = fixture();
  f.feature.start();
  await f.feature.refresh();
  await f.feature.prepare('vscode_remote_ssh', 'copy');
  assert.equal(f.elements.get('integrationDialog').open, true);
  assert.equal(JSON.stringify(f.elements.get('integrationPreviewSummary').children)
    .includes('/must-not-cross'), false);
  assert.equal(f.elements.get('integrationPreviewWarnings').children.length, 1);
  await f.feature.confirm();
  assert.deepEqual(f.calls.find(([name]) => name === 'confirm'), ['confirm', {
    confirmationHandle: `export-${'a'.repeat(32)}`,
  }]);
  assert.equal(f.elements.get('integrationDialog').open, false);
  assert.equal(f.elements.get('integrationStatus').textContent, 'integration.success.copy:');
});

test('expiry and failed confirmation close stale material and surface stable messages', async () => {
  let f = fixture();
  f.feature.start();
  await f.feature.prepare('vscode_remote_ssh', 'copy');
  f.expire();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.elements.get('integrationDialog').open, false);
  assert.ok(f.calls.some(([name]) => name === 'cancel'));

  f = fixture({ confirmResult: { ok: false, code: 'INTEGRATION_TARGET_CHANGED' } });
  f.feature.start();
  await f.feature.prepare('vscode_remote_ssh', 'copy');
  await f.feature.confirm();
  assert.equal(f.elements.get('integrationDialog').open, false);
  assert.equal(f.elements.get('integrationError').textContent,
    'integration.error.INTEGRATION_TARGET_CHANGED:');
});
