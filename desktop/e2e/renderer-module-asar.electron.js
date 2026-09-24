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
// Both locale windows belong to this one fixture; only run() completion exits Electron.
app.on('window-all-closed', () => {});
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
  for (const locale of ['zh','en']) {
  process.env.HKUSTGZ_E2E_LOCALE = locale;
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
    await window.api.testEmitAuthChallenge({kind:'otp',maskedDestination:'s***@example.test',
      attemptsRemaining:3,resendAvailable:true,expiresAtUnixMs:null,resendAfterUnixMs:null});
    const authOpen = document.getElementById('authChallengeDialog').open;
    const response = document.getElementById('authChallengeResponse');
    response.value = 'synthetic-response';
    document.getElementById('authChallengeForm').dispatchEvent(new Event('submit',{cancelable:true}));
    const inputCleared = response.value === '';
    const submitted = await window.api.testEmitAuthChallenge(null);
    const authClosed = !document.getElementById('authChallengeDialog').open;
    const favorite = document.querySelector('#appsList [data-favorite-entry]');
    favorite?.click();
    const chooser = document.getElementById('officialFavoriteDialog');
    return { dashboard: !document.getElementById('dash').hidden,
      days: document.querySelectorAll('#scheduleBody .week-day-head').length,
      legacyGlobal: Object.hasOwn(window, 'campusDataModules'), authListeners: auth.listeners,
      authOpen, inputCleared, authClosed, responseCount:submitted.responseCount,
      favoriteChooser: chooser.open,
      favoriteFactoryGlobal: typeof window.officialFavoriteDialog?.create,
      archive: location.pathname.includes('app.asar') };
  })()`);
  assert.deepEqual(state, { dashboard: true, days: 7, legacyGlobal: false, authListeners: 1,
    authOpen:true, inputCleared:true, authClosed:true, responseCount:1,
    favoriteChooser: true, favoriteFactoryGlobal: 'undefined', archive: true });
  const localization = await window.webContents.executeJavaScript(`({
    language: document.documentElement.lang,
    schoolStarted: typeof window.schoolProfileSelectorFeature?.refresh === 'function',
    integrationStarted: typeof window.integrationCenterFeature?.refresh === 'function',
    label: document.querySelector('[data-i18n="nav.browser"]')?.textContent,
    weeklyLabel: window.I18N.createT(document.documentElement.lang === 'en' ? 'en' : 'zh')('workspace.scheduleToday')
  })`);
  assert.equal(localization.language, locale === 'zh' ? 'zh-CN' : 'en');
  assert.equal(localization.schoolStarted,true,'deferred school initialization must not be skipped');
  assert.equal(localization.integrationStarted,true,'deferred integration initialization must not be skipped');
  assert.equal(localization.label,locale === 'zh' ? '校园工作台' : 'Workspace');
  assert.equal(localization.weeklyLabel,locale === 'zh' ? '本周' : 'This week');
  const retired = await window.webContents.executeJavaScript(`(() => {
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('pagehide'));
    return { calendarEmpty: document.getElementById('scheduleBody').innerHTML === '',
      favoriteOpen: document.getElementById('officialFavoriteDialog').open };
  })()`);
  assert.deepEqual(retired, { calendarEmpty:true, favoriteOpen:false },
    'the registered owners retire their DOM and dialog on pagehide');
  await window.loadFile(path.join(archive, 'renderer/campus-browser.html'), {query:{lang:locale}});
  const chrome = await window.webContents.executeJavaScript(`({
    language:document.documentElement.lang,
    ready:typeof window.campusBrowserUI?.setLocale === 'function',
    profile:document.getElementById('browserProfileName').textContent
  })`);
  assert.equal(chrome.language,locale === 'zh' ? 'zh-CN' : 'en');
  assert.equal(chrome.ready,true,'classic toolbar must start after its module translator');
  assert.equal(chrome.profile,locale === 'zh' ? '校园工作台' : 'Campus Workspace');
  const switched = await window.webContents.executeJavaScript(`(() => {
    window.campusBrowserUI.setLocale(${JSON.stringify(locale === 'zh' ? 'en' : 'zh')});
    return document.getElementById('browserProfileName').textContent;
  })()`);
  assert.equal(switched,locale === 'zh' ? 'Campus Workspace' : '校园工作台');
  window.destroy(); window = null;
  }
  console.log('renderer native modules in ASAR: PASS');
}

process.on('unhandledRejection', error => { console.error(error); app.exit(1); });
run().then(() => 0).catch(error => { console.error(error); return 1; }).then(code => {
  if (window && !window.isDestroyed()) window.destroy();
  app.exit(code);
});
