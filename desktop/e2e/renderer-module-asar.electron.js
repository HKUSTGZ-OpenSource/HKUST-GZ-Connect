'use strict';

// Renderer asset packaging only: no Engine, login, installed app or school data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const asar = require('@electron/asar');
const { app, BrowserWindow } = require('electron');

const desktop = path.resolve(__dirname, '..');
const root = process.argv[2];
if (!root || !path.isAbsolute(root) || !path.basename(root).startsWith('campus renderer asar ') ||
    fs.realpathSync(path.dirname(root)) !== fs.realpathSync(os.tmpdir()) ||
    fs.lstatSync(root).isSymbolicLink() || !fs.lstatSync(root).isDirectory()) {
  throw new Error('Run this fixture through node e2e/renderer-module-asar.js');
}
process.env.HKUSTGZ_E2E_EMPTY_SCHEDULE = '1';
app.setPath('userData', path.join(root, 'user-data'));
let window;

async function run() {
  const staging = path.join(root, 'staging');
  for (const directory of ['renderer', 'assets']) {
    fs.cpSync(path.join(desktop, directory), path.join(staging, directory), { recursive: true });
  }
  for (const file of ['lib/browser/auth/login-flow.js', 'lib/resources/presentation/resource-view.js']) {
    fs.mkdirSync(path.dirname(path.join(staging, file)), { recursive: true });
    fs.copyFileSync(path.join(desktop, file), path.join(staging, file));
  }
  const archive = path.join(root, 'app.asar');
  await asar.createPackage(staging, archive);
  await app.whenReady();
  window = new BrowserWindow({ show: false, width: 900, height: 800,
    webPreferences: { contextIsolation: true, nodeIntegration: false,
      preload: path.join(__dirname, 'resource-manager-layout-preload.js') } });
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] },
    (_details, callback) => callback({ cancel: true }));
  await window.loadFile(path.join(archive, 'renderer/index.html'));
  const state = await window.webContents.executeJavaScript(`(async () => {
    const deadline = Date.now() + 5000;
    while (document.getElementById('dash').hidden && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    document.querySelector('.nav[data-page="browser"]').click();
    while (!document.querySelector('#scheduleBody .week-table') && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const auth = await window.api.testEmitAuthChallenge(null);
    const favorite = document.querySelector('#appsList [data-favorite-entry]');
    favorite?.click();
    const chooser = document.getElementById('officialFavoriteDialog');
    return { dashboard: !document.getElementById('dash').hidden,
      days: document.querySelectorAll('#scheduleBody .week-day-head').length,
      legacyGlobal: Object.hasOwn(window, 'campusDataModules'), authListeners: auth.listeners,
      favoriteChooser: chooser.open,
      favoriteFactoryGlobal: typeof window.officialFavoriteDialog?.create,
      archive: location.pathname.includes('app.asar') };
  })()`);
  assert.deepEqual(state, { dashboard: true, days: 7, legacyGlobal: false, authListeners: 1,
    favoriteChooser: true, favoriteFactoryGlobal: 'undefined', archive: true });
  const retired = await window.webContents.executeJavaScript(`(() => {
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('pagehide'));
    return { calendarEmpty: document.getElementById('scheduleBody').innerHTML === '',
      favoriteOpen: document.getElementById('officialFavoriteDialog').open };
  })()`);
  assert.deepEqual(retired, { calendarEmpty:true, favoriteOpen:false },
    'the registered owners retire their DOM and dialog on pagehide');
  console.log('renderer native modules in ASAR: PASS');
}

process.on('unhandledRejection', error => { console.error(error); app.exit(1); });
run().then(() => 0).catch(error => { console.error(error); return 1; }).then(code => {
  if (window && !window.isDestroyed()) window.destroy();
  app.exit(code);
});
