'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const renderer = path.join(__dirname, '..', 'renderer', 'index.html');
const preload = path.join(__dirname, 'resource-manager-layout-preload.js');

async function waitFor(window, expression, description) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function addAndOpenCustomResource(window) {
  return window.webContents.executeJavaScript(`(async () => {
    document.querySelector('.nav[data-page="browser"]').click();
    document.getElementById('serviceTabPersonal').click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const add = document.getElementById('addWebsite');
    if (!add) return { controlPresent: false };
    add.click();
    const addDialog = document.getElementById('addWebsiteDialog');
    document.getElementById('addWebsiteUrl').value = 'https://hpc2login.hpc.hkust-gz.edu.cn/';
    document.getElementById('addWebsiteUrl').dispatchEvent(new Event('blur'));
    await new Promise((resolve) => setTimeout(resolve, 25));
    document.getElementById('addWebsiteName').value = 'HPC2 登录';
    document.getElementById('addWebsiteGroup').value = 'group_research12345';
    document.getElementById('addWebsiteRoute').value = 'campus';
    document.getElementById('addWebsiteForm').requestSubmit();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const state = window.api.testState();
    const saved = state.resources.find((resource) => resource.url === 'https://hpc2login.hpc.hkust-gz.edu.cn/');
    const group = state.resourceGroups.find(({ id }) => id === 'group_research12345');
    return {
      controlPresent: true,
      dialogClosed: !addDialog.open,
      error: document.getElementById('addWebsiteError')?.textContent || '',
      openedRequest: state.lastOpenRequest,
      saved,
      grouped: group?.resourceIds.includes(saved?.id) === true,
      cardVisible: [...document.querySelectorAll('#campusResources .cb-site-name')]
        .some((node) => node.textContent === 'HPC2 登录'),
    };
  })()`);
}

function assertCustomResourceAddAndOpen(result) {
  assert.equal(result.controlPresent, true, 'dashboard is missing the add-to-favorites action');
  assert.equal(result.error, '', 'adding and opening a shortcut reported an error');
  assert.equal(result.dialogClosed, true, 'successful add did not close its dialog');
  assert.equal(result.saved.url, 'https://hpc2login.hpc.hkust-gz.edu.cn/');
  assert.equal(result.saved.route, 'campus');
  assert.equal(result.saved.favorite, true);
  assert.equal(result.grouped, true, 'added website was not placed in the selected category');
  assert.deepEqual(result.openedRequest, { resourceId: result.saved.id },
    'adding and opening did not use the saved WebResource ID');
  assert.equal(result.cardVisible, true, 'the added website did not appear in its category card');
}

async function exerciseIntegrationCenter(window) {
  window.setContentSize(500, 640);
  await waitFor(window, 'window.innerWidth === 500 && window.innerHeight === 640', 'compact Integration Center size');
  await window.webContents.executeJavaScript(`document.querySelector('.nav[data-page="tower"]').click()`);
  await waitFor(window,
    `document.querySelectorAll('[data-integration-adapter]').length === 2`,
    'Integration Center rows');
  const capabilityBoundary = await window.webContents.executeJavaScript(`(async () => {
    const state = await window.api.getState();
    return {
      card: !!document.getElementById('capabilitySummary'),
      feature: !!window.capabilityPresentationFeature,
      projected: Object.hasOwn(state, 'capabilitySnapshot'),
    };
  })()`);
  assert.deepEqual(capabilityBoundary, { card: false, feature: false, projected: false },
    'Engine capability details must stay outside the Control Renderer');
  const routingStacks = await window.webContents.executeJavaScript(`(async () => {
    const accessibleGroups = () => [
      ...document.querySelectorAll('[data-routing-group]'),
      ...document.querySelectorAll('[data-routing-stack-activate]'),
    ].map((node) => node.dataset.routingGroup || node.dataset.routingStackActivate).sort();
    const initialGroup = document.querySelector('[data-routing-group]')?.dataset.routingGroup || '';
    const initialHost = document.querySelector('.routing-rule-row strong')?.textContent || '';
    document.querySelector('[data-routing-stack-activate]')?.click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const focusedHeading = document.activeElement;
    const stableRenderChanged = window.routingManager.start().renderStacks();
    return {
      groups: accessibleGroups(),
      initialGroup,
      initialHost,
      afterGroup: document.querySelector('[data-routing-group]')?.dataset.routingGroup || '',
      afterHost: document.querySelector('.routing-rule-row strong')?.textContent || '',
      focusedRoute: focusedHeading?.dataset.routingHeading || '',
      stableRenderChanged,
      focusPreserved: document.activeElement === focusedHeading,
      legacyList: !!document.getElementById('routingRuleList'),
    };
  })()`);
  assert.deepEqual(routingStacks, {
    groups: ['campus', 'direct'],
    initialGroup: 'direct',
    initialHost: 'login.example.com',
    afterGroup: 'campus',
    afterHost: '',
    focusedRoute: 'campus',
    stableRenderChanged: false,
    focusPreserved: true,
    legacyList: false,
  }, 'routing stacks must lead with the populated route and keep the empty route accessible');
  const explanation = await window.webContents.executeJavaScript(`(() => {
    const details = document.querySelector('.integration-explainer');
    details.querySelector('summary').click();
    return { open: details.open, text: details.textContent };
  })()`);
  assert.equal(explanation.open, true, 'Integration Center explanation did not expand');
  assert.match(explanation.text, /SOCKS5/u,
    'Integration Center explanation omitted its local proxy mechanism');
  assert.match(explanation.text, /校园(?:账号)?密码|campus password/iu,
    'Integration Center explanation omitted the credential boundary');
  const prepared = await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('[data-integration-adapter="clash_mihomo_yaml"] [data-integration-action="copy"]').click();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const dialog = document.getElementById('integrationDialog');
    const rect = dialog.getBoundingClientRect();
    return {
      open: dialog.open,
      rect: { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left },
      summary: document.getElementById('integrationPreviewSummary').textContent,
      warning: document.getElementById('integrationPreviewWarnings').textContent,
      pageText: document.body.textContent,
    };
  })()`);
  assert.equal(prepared.open, true, 'Integration Center preview did not open');
  assert.ok(prepared.rect.top >= 48 && prepared.rect.left >= 8,
    'Integration Center preview overlaps the titlebar or window edge');
  assert.ok(prepared.rect.right <= 500 - 8 && prepared.rect.bottom <= 640 - 12,
    'Integration Center preview escapes the compact viewport');
  assert.match(prepared.summary, /1|512|2/u, 'Integration Center omitted the bounded change summary');
  assert.match(prepared.warning, /凭据|credential/iu,
    'Integration Center omitted the local proxy credential warning');
  assert.doesNotMatch(prepared.pageText, /\/Users\/|\\Users\\|password\s*[:=]/iu,
    'Integration Center exposed a path or credential value to the renderer');

  await window.webContents.executeJavaScript(`document.getElementById('confirmIntegration').click()`);
  await waitFor(window, `document.getElementById('integrationDialog').open === false`,
    'configuration export confirmation');
  const confirmed = await window.webContents.executeJavaScript(`({
    dialogOpen: document.getElementById('integrationDialog').open,
    status: document.getElementById('integrationStatus').textContent,
    adapterCount: document.querySelectorAll('[data-integration-adapter]').length,
    installVisible: !!document.querySelector('[data-integration-action="install"], [data-integration-action="update"], [data-integration-action="remove"]'),
    vscodeSaveVisible: !!document.querySelector('[data-integration-adapter="vscode_remote_ssh"] [data-integration-action="save"]'),
  })`);
  assert.equal(confirmed.dialogOpen, false, 'confirmed Integration Center preview remained open');
  assert.ok(confirmed.status, 'confirmed Integration Center operation gave no visible result');
  assert.equal(confirmed.adapterCount, 2, 'production Integration Center exposed a historical adapter');
  assert.equal(confirmed.installVisible, false, 'Integration Center exposed third-party installation controls');
  assert.equal(confirmed.vscodeSaveVisible, false, 'VS Code snippet must remain copy-only');
}

async function exerciseAddWebsiteDialogLayout(window) {
  for (const [width, height] of [[500, 640], [420, 560], [760, 900]]) {
    window.setContentSize(width, height);
    await waitFor(window, `window.innerWidth === ${width} && window.innerHeight === ${height}`,
      `${width}×${height} content size`);
    const view = await window.webContents.executeJavaScript(`(() => {
      document.querySelector('.nav[data-page="browser"]').click();
      document.getElementById('serviceTabPersonal').click();
      document.getElementById('addWebsite').click();
      return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
        const dialog = document.getElementById('addWebsiteDialog');
        const rect = (element) => {
          const value = element.getBoundingClientRect();
          return { top: value.top, right: value.right, bottom: value.bottom, left: value.left, width: value.width, height: value.height };
        };
        resolve({
          open: dialog.open,
          dialog: rect(dialog),
          close: rect(document.getElementById('closeAddWebsite')),
          actions: rect(dialog.querySelector('.dialog-actions')),
          bodyOverflow: dialog.scrollWidth - dialog.clientWidth,
        });
      })));
    })()`);
    const label = `${width}×${height}`;
    assert.equal(view.open, true, `${label}: Add Website did not open`);
    assert.ok(view.dialog.top >= 48, `${label}: dialog overlaps the titlebar safe area`);
    assert.ok(view.dialog.left >= 12 && view.dialog.right <= width - 12,
      `${label}: dialog escapes the horizontal safe area`);
    assert.ok(view.dialog.width <= 520, `${label}: dialog grows beyond its readable maximum width`);
    assert.ok(Math.abs((view.dialog.left + view.dialog.right) / 2 - width / 2) <= 1,
      `${label}: dialog is not horizontally centered`);
    assert.ok(view.close.top >= view.dialog.top && view.close.right <= view.dialog.right,
      `${label}: close control is clipped`);
    // DOMRect uses floating point; compare at Blink's 1/64 CSS-pixel layout precision.
    assert.ok(Math.round(view.actions.bottom * 64) <= Math.round(view.dialog.bottom * 64), `${label}: action bar is outside the dialog`);
    assert.ok(view.bodyOverflow <= 0, `${label}: dialog overflows horizontally`);
    await window.webContents.executeJavaScript(`document.getElementById('addWebsiteDialog').close()`);
  }
}

async function main() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    width: 500,
    height: 640,
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload },
  });

  try {
    await window.loadFile(renderer);
    await waitFor(window, "document.getElementById('dash').hidden === false", 'dashboard initialization');
    await exerciseIntegrationCenter(window);
    await exerciseAddWebsiteDialogLayout(window);
    assertCustomResourceAddAndOpen(await addAndOpenCustomResource(window));
    process.stdout.write('renderer layout: PASS\n');
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}

main().then(
  () => app.quit(),
  (error) => {
    process.stderr.write(`${error.stack || error}\n`);
    app.exit(1);
  },
);
