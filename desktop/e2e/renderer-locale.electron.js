'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-renderer-locale-')));
process.env.HKUSTGZ_E2E_LOCALE ||= 'en';
const initial = process.env.HKUSTGZ_E2E_LOCALE;
const other = initial === 'en' ? 'zh' : 'en';
const copy = { en: 'Copy', zh: '复制' };
const copied = { en: 'Copied', zh: '已复制' };
const failures = [];
const observations = [];
let window;
let deniedRequests = 0;
const evaluate = code => window.webContents.executeJavaScript(code);
const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
function equal(name, actual, expected) {
  observations.push({ name, actual, expected });
  try { assert.deepEqual(actual, expected, name); } catch { failures.push(name); }
}
async function waitFor(expression) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${expression}`);
}
async function status(locale, overrides = {}) {
  const payload = { connected: true, connecting: false, clientIp: '192.0.2.5',
    dnsMode: 'gateway', lastError: null, notice: null, ...overrides };
  if (locale !== null) payload.locale = locale;
  assert.equal(await evaluate(`window.api.fixtureEmitStatus(${JSON.stringify(payload)})`), 1);
  await settle();
}
const localeCount = () => evaluate('window.api.fixtureLocaleEvents()');
const label = () => evaluate("document.getElementById('copyTunnelIp').textContent");

async function main() {
  await app.whenReady();
  window = new BrowserWindow({ width: 1040, height: 800, show: true,
    webPreferences: { preload: path.join(__dirname, 'resource-manager-layout-preload.js'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, reply) => {
    deniedRequests++; reply({ cancel: true });
  });
  await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  window.show(); window.focus(); window.webContents.focus();
  await waitFor("document.hasFocus() && !document.getElementById('dash').hidden");
  await settle();
  equal('initial static label', await label(), copy[initial]);
  equal('first effective locale applied once', await localeCount(), 1);
  await status(initial);
  await evaluate("document.getElementById('copyTunnelIp').click()");
  await waitFor(`document.getElementById('copyTunnelIp').textContent === ${JSON.stringify(copied[initial])}`);
  await status(initial);
  equal('same locale preserves copied feedback', await label(), copied[initial]);
  await waitFor(`document.getElementById('copyTunnelIp').textContent === ${JSON.stringify(copy[initial])}`);

  await status(initial, { connected: false, connecting: true, clientIp: null });
  equal('connecting status still updates', await evaluate("document.getElementById('power').disabled"), true);
  await status(initial, { connected: false, lastError: 'Synthetic connection error', notice: 'Synthetic notice' });
  equal('error and notice still update', await evaluate(`[
    document.getElementById('connErr').textContent, document.getElementById('settingsNotice').textContent,
    document.getElementById('power').disabled]`), ['Synthetic connection error', 'Synthetic notice', false]);
  await status(initial);
  equal('connected status still updates', await evaluate(`[
    document.getElementById('power').getAttribute('aria-checked'), document.getElementById('stIp').textContent,
    document.getElementById('connErr').textContent, document.getElementById('settingsNotice').hidden]`), ['true', '192.0.2.5', '', true]);

  await evaluate("document.querySelector('.nav[data-page=browser]').click()");
  await waitFor("!!document.querySelector('#newsBody [data-campus-data-action=source]')");
  await evaluate(`window.localeSource = document.querySelector('#newsBody [data-campus-data-action=source]');
    localeSource.scrollIntoView({block:'center'}); localeSource.focus();`);
  const before = await localeCount();
  for (const locale of [null, initial, initial === 'en' ? 'en-US' : 'zh-CN', initial === 'en' ? ' EN-gb ' : ' ZH-Hans ']) {
    await status(locale);
    equal('status retains source node and focus: ' + locale, await evaluate(
      '[localeSource.isConnected, document.activeElement === localeSource, document.hasFocus()]'), [true, true, true]);
  }
  equal('same effective locales do not broadcast changes', await localeCount(), before);

  // Observe a static button that status rendering does not otherwise own.
  await evaluate(`window.localeWrites = 0;
    window.localeObserver = new MutationObserver(records => { localeWrites += records.length; });
    localeObserver.observe(document.getElementById('copyTunnelIp'), {childList:true, characterData:true, subtree:true});`);
  for (let n = 0; n < 20; n++) await status(initial);
  equal('same locale does not rewrite static translations', await evaluate('localeWrites'), 0);
  await evaluate('localeObserver.disconnect()');

  // A normal full state refresh must still populate data despite the locale guard.
  await status(initial, { settings: { ...(await evaluate('window.api.getState()')).settings, username: 'Synthetic updated account' } });
  const refreshBefore = await localeCount();
  await evaluate("document.dispatchEvent(new Event('visibilitychange'))");
  await waitFor("document.getElementById('acct').textContent === 'Synthetic updated account'");
  equal('same locale full refresh does not broadcast changes', await localeCount(), refreshBefore);

  for (const locale of [other, initial]) {
    const count = await localeCount();
    await status(locale);
    equal('real locale change broadcasts once: ' + locale, await localeCount(), count + 1);
    equal('real locale changes static text: ' + locale, await label(), copy[locale]);
    equal('document language changes: ' + locale, await evaluate('document.documentElement.lang'), locale === 'zh' ? 'zh-CN' : 'en');
    equal('dynamic source control changes: ' + locale, await evaluate(
      "document.querySelector('#newsBody [data-campus-data-action=source]').textContent.trim()"),
      locale === 'zh' ? '查看官方资讯 →' : 'Official campus news →');
    // The hidden Personal panel must also receive a real language change.
    await evaluate("document.getElementById('serviceTabPersonal').click()");
    equal('personal panel is localized: ' + locale, await evaluate(
      "document.getElementById('createCategory').textContent.trim()"),
      locale === 'zh' ? '新建分类' : 'New category');
    await evaluate("document.getElementById('serviceTabOfficial').click()");
  }
  for (const [page, selector] of [['connect', '#copyTunnelIp'], ['tower', '[data-copy=socks]']]) {
    await evaluate(`document.querySelector('.nav[data-page=${page}]').click(); document.querySelector('${selector}').click()`);
    await waitFor(`document.querySelector('${selector}').textContent === ${JSON.stringify(copied[initial])}`);
    await status(other);
    // Let the already scheduled 1200ms feedback restoration run after the language change.
    await new Promise(resolve => setTimeout(resolve, 1300));
    await status(other);
    equal('pending copy timer uses current language: ' + page,
      await evaluate(`document.querySelector('${selector}').textContent`), copy[other]);
    await status(initial);
  }
  equal('offline fixture makes no HTTP requests', deniedRequests, 0);
  console.log(JSON.stringify({ initial, platform: process.platform, electron: process.versions.electron, observations, failures }));
  assert.deepEqual(failures, [], 'Renderer locale regressions');
}
const timeout = setTimeout(() => { console.error('Renderer locale fixture deadline'); app.exit(1); }, 30000);
main().then(() => { clearTimeout(timeout); window?.destroy(); app.quit(); })
  .catch(error => { clearTimeout(timeout); console.error(error); window?.destroy(); app.exit(1); });
