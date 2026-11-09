'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain, session } = require('electron');
const { CampusWorkspaceController } = require('../lib/browser/workspace/campus-workspace-controller');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'hkust-workspace-labels-')));

async function main() {
  const { createT } = await import(pathToFileURL(path.join(__dirname, '../renderer/features/localization/index.mjs')));
  await app.whenReady();
  const browserSession = session.fromPartition('workspace-labels-fixture');
  for (const isolated of [session.defaultSession, browserSession]) {
    isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') }));
  }
  let locale = 'zh';
  const commands = [], errors = [], evidence = [];
  const resources = [
    { id: 'synthetic-course', name: 'Synthetic Course', category: 'courses', route: 'campus', favorite: true, builtin: true, keywords: [], lastOpenedAt: 1 },
    { id: 'synthetic-tool', name: 'Synthetic Tool', category: 'tools', route: 'direct', favorite: true, builtin: true, keywords: [], lastOpenedAt: 2 },
    { id: 'synthetic-lab', name: 'Synthetic Lab', category: 'labs', route: 'campus', favorite: false, builtin: true, keywords: [], lastOpenedAt: null },
  ];
  const controller = new CampusWorkspaceController({
    workspaceFile: path.join(__dirname, '../renderer/campus-workspace.html'),
    workspacePreload: path.join(__dirname, '../lib/browser/workspace/campus-workspace-preload.js'),
    getProfilePresentation: () => ({ schoolName: 'Synthetic School', unverified: true }),
    getResources: () => resources,
    getGroups: () => [
      { id: 'group_abcdefghijkl', name: 'Synthetic category', resourceIds: ['synthetic-course'] },
      { id: 'group_mnopqrstuvwx', name: 'Empty category', resourceIds: [] },
    ],
    getLocale: () => locale,
    onCommand: async command => { commands.push(command); return { ok: true }; },
  });
  const window = new BrowserWindow({ width: 1040, height: 740, show: true, webPreferences: {
    session: browserSession, preload: controller.workspacePreload,
    sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
  } });
  controller.attach(window.webContents);
  window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  const emptyLayout = { schemaVersion: 1, revision: 0, placements: [], decks: [] };
  ipcMain.handle('get-card-board-layout', () => ({ document: emptyLayout }));
  let stage = 'initial load';
  const run = async source => {
    try { return await window.webContents.executeJavaScript(source); }
    catch (error) { throw new Error(`${stage}: ${error.message}`); }
  };
  const wait = () => new Promise(resolve => setTimeout(resolve, 100));
  const repaint = async () => {
    controller.sendState(window.webContents);
    await wait();
    // State delivery starts a layout reload that can retire an open overlay.
    // Await the same owner before exercising the next keyboard interaction.
    await run('workspaceBoardFeature.reload()');
  };
  const key = async keyCode => {
    window.focus(); window.webContents.focus();
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    if (keyCode === 'Return') window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode });
    await wait();
  };
  const output = process.env.HKUSTGZ_WORKSPACE_LABEL_SCREENSHOT_DIR;
  if (output) fs.mkdirSync(output, { recursive: true });
  await controller.load(window);
  await wait();
  for (const [sequence, nextLocale] of ['zh', 'en', 'zh'].entries()) {
    locale = nextLocale;
    await repaint();
    for (const [size, width, height, zoom] of [
      ['narrow', 660, 720, 1], ['standard', 1040, 740, 1],
      ['wide', 1400, 900, 1], ['zoom125', 1000, 760, 1.25],
    ]) {
      window.setContentSize(width, height);
      window.webContents.setZoomFactor(zoom); await wait();
      for (const primary of ['workspace', 'catalog']) {
        stage = `${sequence}-${locale}-${primary}-${size}`;
        const host = primary === 'catalog' ? 'workspaceCatalogBoardHost' : 'workspacePersonalBoardHost';
        await run(`document.querySelector('[data-primary-view="${primary}"]').click()`); await wait();
        const snapshot = await run(`(() => {
          const host = document.getElementById('${host}');
          return { lang: document.documentElement.lang, width: innerWidth,
            overflow: document.documentElement.scrollWidth > innerWidth,
            more: [...host.querySelectorAll('.cb-card-more')].map(button => {
              const card = button.closest('.cb-card'), rect = button.getBoundingClientRect();
              return { text: button.textContent, aria: button.getAttribute('aria-label'),
                title: card.querySelector('.cb-card-title').textContent,
                resources: [...card.querySelectorAll('[data-card-resource-id]')].map(el => el.dataset.cardResourceId),
                fits: rect.right <= card.getBoundingClientRect().right && button.scrollWidth <= button.clientWidth };
            }),
            emptyMore: host.querySelector('[data-card-ref-id="group_mnopqrstuvwx"] .cb-card-more') !== null,
          };
        })()`);
        const label = `${sequence}-${locale}-${primary}-${size}`;
        if (output) {
          const image = await window.webContents.capturePage();
          assert.equal(image.isEmpty(), false, `${label}: missing screenshot surface`);
          fs.writeFileSync(path.join(output, `${label}.png`), image.toPNG());
        }
        assert.ok(snapshot.more.length > 0);
        assert.equal(snapshot.lang, locale === 'en' ? 'en' : 'zh-CN');
        assert.ok(Math.abs(snapshot.width - width / zoom) <= 1);
        assert.equal(snapshot.overflow, false);
        assert.equal(snapshot.emptyMore, false);
        for (const more of snapshot.more) {
          assert.equal(more.text, createT(locale)('workspace.more'), `${label}: actual Workspace adapter must localize More`);
          assert.equal(more.aria, locale === 'en' ? `Show every site in ${more.title}` : `查看 ${more.title} 全部网站`);
          assert.equal(more.fits, true, `${label}: More label overflow`);
        }
        await run(`document.querySelector('#${host} .cb-card-tab').focus()`); await key('Tab');
        assert.equal(await run(`document.activeElement.matches('#${host} .cb-card-more')`), true);
        assert.equal(await run(`(() => { const s=getComputedStyle(document.activeElement); return (s.outlineStyle!=='none' && parseFloat(s.outlineWidth)>0)||s.boxShadow!=='none'; })()`), true);
        await key('Return');
        const overlay = await run(`(() => { const dialog=document.querySelector('#${host} .cb-overlay[open]');
          return { name:dialog?.getAttribute('aria-label'), sites:[...dialog.querySelectorAll('[data-card-resource-id]')].map(el=>el.dataset.cardResourceId),
            close:dialog.querySelector('.cb-overlay-close').getAttribute('aria-label'), closeFocused:document.activeElement.matches('.cb-overlay-close') }; })()`);
        assert.equal(overlay.name, snapshot.more[0].title);
        assert.deepEqual(overlay.sites, snapshot.more[0].resources);
        assert.equal(overlay.close, locale === 'en' ? 'Close' : '关闭');
        assert.equal(overlay.closeFocused, true);
        await key('Escape');
        assert.equal(await run(`document.activeElement.matches('#${host} .cb-card-more')`), true);
        await run(`document.querySelector('[data-primary-view="${primary}"]').focus()`);
        await repaint();
        assert.equal(await run(`document.activeElement.dataset.primaryView`), primary);
        await run(`document.getElementById('openManage').click()`);
        assert.equal(await run(`document.querySelector('#${host} [data-card-board]').dataset.editing`), 'true');
        assert.equal(await run(`document.querySelectorAll('#${host} .cb-card-more').length`), 0);
        await run(`document.querySelector('#${primary === 'catalog' ? 'workspaceCatalogEditToolbar' : 'workspacePersonalEditToolbar'} [data-board-action="cancel"]').click()`);
        evidence.push({ label, ...snapshot, overlay });
      }
    }
  }
  window.webContents.debugger.attach('1.3');
  await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  assert.equal(await run(`matchMedia('(prefers-reduced-motion: reduce)').matches`), true);
  for (const nextLocale of ['en', 'zh']) {
    locale = nextLocale; await repaint();
    for (const primary of ['workspace', 'catalog']) {
      stage = `reduced-motion-${locale}-${primary}`;
      const host = primary === 'catalog' ? 'workspaceCatalogBoardHost' : 'workspacePersonalBoardHost';
      await run(`document.querySelector('[data-primary-view="${primary}"]').click(); document.querySelector('#${host} .cb-card-more').focus()`);
      await key('Return');
      assert.equal(await run(`document.querySelector('#${host} .cb-overlay').open`), true);
      await key('Escape');
    }
  }
  await run(`document.querySelector('#workspaceCatalogBoardHost .resource-favorite').click()`); await wait();
  assert.deepEqual(commands.map(({ command }) => command), ['toggle-favorite']);
  assert.deepEqual(errors, []);
  if (output) fs.writeFileSync(path.join(output, 'receipt.json'), JSON.stringify({ evidence, commands, errors }, null, 2));
  window.webContents.debugger.detach();
  ipcMain.removeHandler('get-card-board-layout');
  window.destroy();
  process.stdout.write(`workspace labels: PASS (${evidence.length} layouts, zh/en/zh, keyboard, existing aria/focus, reduced motion)\n`);
  app.quit();
}

main().catch(error => { process.stderr.write(`${error.stack || error.message}\n`); app.exit(1); });
