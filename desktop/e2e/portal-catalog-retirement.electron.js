'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-catalog-retirement-'));
app.setPath('userData', path.join(runtime, 'userData'));
app.on('window-all-closed', () => {});
const renderer = path.join(__dirname, '../renderer/index.html');
const adapter = fs.readFileSync(path.join(__dirname, 'portal-catalog-retirement-preload.js'), 'utf8');
const generic = fs.readFileSync(path.join(__dirname, 'resource-manager-layout-preload.js'), 'utf8');
const bridge = "const { contextBridge } = require('electron');";
assert.equal(generic.split(bridge).length, 2, 'generic synthetic preload has one bridge seam');
const preload = path.join(runtime, 'preload.js');
fs.writeFileSync(preload, adapter + '\n' + generic.replace(bridge,
  "const { contextBridge: nativeBridge } = require('electron');\n" +
  "const contextBridge = { exposeInMainWorld: (name, api) => nativeBridge.exposeInMainWorld(name, createPortalCatalogFixture(api)) };"));
const evidence = [];
let window;
const deadline = setTimeout(() => { console.error('catalog retirement fixture exceeded 90 seconds'); app.exit(1); }, 90_000);

async function evaluate(source) { return window.webContents.executeJavaScript(source); }
async function waitFor(source, label) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    if (await evaluate(source)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error('Timed out: ' + label);
}
async function settle() {
  await waitFor('document.hasFocus()', 'focused native fixture');
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
}
async function configure(options) { return evaluate('window.api.fixturePortal(' + JSON.stringify(options) + ')'); }
async function refresh(kind) {
  const before = await configure({});
  await evaluate(kind === 'full'
    ? "document.querySelector('#newsBody [data-campus-data-action=\"retry\"]').click()"
    : "document.getElementById('scheduleRefresh').click()");
  await waitFor("window.api.fixturePortal({}).counts." + kind + ' > ' + before.counts[kind], kind + ' request');
  await settle();
}
async function search() {
  await evaluate("(()=>{const input=document.getElementById('resourceSearch'); input.value='syntheticcatalog'; input.dispatchEvent(new Event('input')); input.focus()})()");
}
async function projection() {
  return evaluate("(() => {" +
    "const ids=id=>[...document.getElementById(id).querySelectorAll('[data-entry-open]')].map(node=>node.dataset.entryOpen);" +
    "const input=document.getElementById('resourceSearch'),state=window.api.testState();" +
    "return {hasFocus:document.hasFocus(),viewport:[innerWidth,innerHeight],deck:ids('officialMainDeck'),search:ids('searchResults'),expanded:ids('officialCatalogList'),query:input.value," +
    "focus:document.activeElement.id,clear:document.getElementById('browserDataStatus').textContent," +
    "resources:state.resources,groups:state.resourceGroups,schedule:document.getElementById('scheduleBody').textContent," +
    "bodyOverflow:document.documentElement.scrollWidth-document.documentElement.clientWidth," +
    "contentOverflow:document.querySelector('.content').scrollWidth-document.querySelector('.content').clientWidth," +
    "reduced:matchMedia('(prefers-reduced-motion: reduce)').matches};})()");
}
function assertRetired(view, personal) {
  for (const key of ['deck', 'search', 'expanded']) {
    assert.ok(view[key].every(id => !id.startsWith('synthetic-portal-')), key + ' retains retired portal entry');
  }
  assert.ok(view.deck.includes('app-myportal'), 'static service desk fallback is preserved');
  assert.equal(view.query, 'syntheticcatalog');
  assert.deepEqual(view.resources, personal.resources, 'personal resources stay unchanged');
  assert.deepEqual(view.groups, personal.groups, 'personal groups stay unchanged');
}
async function run(locale, size, action) {
  console.log('START ' + locale + ' ' + size.join('x') + ' ' + action);
  process.env.HKUSTGZ_E2E_LOCALE = locale;
  window = new BrowserWindow({ show: false, width: size[0], height: size[1],
    webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  const errors = [];
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] },
    (_details, callback) => callback({ cancel: true }));
  await window.loadFile(renderer);
  window.webContents.setZoomFactor(size[2]);
  window.show(); window.focus();
  await waitFor('document.hasFocus()', 'native document focus');
  assert.equal(window.webContents.getZoomFactor(), size[2]);
  await waitFor("document.getElementById('dash').hidden===false", 'dashboard');
  await evaluate("document.querySelector('.nav[data-page=\"browser\"]').click()");
  await waitFor("document.querySelector('#officialMainDeck [data-entry-open=\"synthetic-portal-A\"]')!==null", 'ready catalog');
  const personal = await projection();
  await search();

  if (action.startsWith('clear')) {
    const outcome = action.split('-')[1];
    await configure({ held: true, clearOutcome: outcome });
    await refresh('full');
    await evaluate("document.querySelector('.nav[data-page=\"settings\"]').click(); document.getElementById('clearBrowserData').click(); document.getElementById('clearBrowserData').click()");
    await waitFor("window.api.fixturePortal({}).counts.clear===1 && !document.getElementById('clearBrowserData').disabled", 'clear settles');
    const immediate = await projection();
    assertRetired(immediate, personal);
    assert.ok(immediate.clear.length > 0);
    await configure({ release: true });
    await settle();
    assertRetired(await projection(), personal);
    await evaluate("document.querySelector('.nav[data-page=\"browser\"]').click()");
    await settle();
  } else {
    const kind = action === 'full' ? 'full' : 'week';
    await configure({ phase: 'transient' });
    await refresh(kind);
    assert.ok((await projection()).deck.includes('synthetic-portal-A'));
    await configure({ phase: 'revoked' });
    await evaluate("document.querySelector('#searchResults [data-entry-open=\"synthetic-portal-A\"]').focus()");
    await refresh(kind);
    const retired = await projection();
    assertRetired(retired, personal);
    assert.equal(retired.focus, 'resourceSearch', 'removed search result returns focus to the query');
    assert.equal(retired.hasFocus, true);
  }

  await configure({ phase: 'ready', generation: 'B' });
  await refresh('full');
  await waitFor("document.querySelector('#searchResults [data-entry-open=\"synthetic-portal-B\"]')!==null", 'new catalog recovery in active search');
  const restored = await projection();
  assert.ok(restored.deck.includes('synthetic-portal-B'));
  assert.equal(restored.query, 'syntheticcatalog');

  await evaluate("document.getElementById('resourceSearch').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); document.querySelector('[data-official-more=\"apps\"]').click(); document.querySelector('#officialCatalogList [data-entry-open=\"synthetic-portal-B\"]').focus()");
  await configure({ phase: 'revoked' });
  await refresh('week');
  const expanded = await projection();
  assert.ok(expanded.expanded.includes('app-myportal'));
  assert.ok(!expanded.expanded.includes('synthetic-portal-B'));
  assert.equal(expanded.focus, 'closeOfficialCatalog', 'retired expanded entry returns focus to close');
  assert.equal(expanded.hasFocus, true);
  await evaluate("document.getElementById('closeOfficialCatalog').click()");
  await waitFor("!document.getElementById('officialCatalogDialog').open && document.getElementById('officialCatalogDialog').getClientRects().length===0", 'expanded catalog exit completes');
  await search();
  await settle();
  const retired = await projection();
  assertRetired(retired, personal);
  assert.ok(retired.bodyOverflow <= 1 && retired.contentOverflow <= 1, 'layout remains within viewport');
  assert.equal(errors.length, 0, errors.join('\n'));
  const directory = process.env.HKUSTGZ_E2E_ARTIFACT_DIR;
  if (directory && action === 'clear-success') {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'catalog-' + locale + '-' + size[0] + '-zoom-' + size[2] + '.png'),
      (await window.webContents.capturePage()).toPNG());
  }
  if (app.commandLine.hasSwitch('force-prefers-reduced-motion')) assert.equal(retired.reduced, true);
  evidence.push({ locale, size, viewport: retired.viewport, zoom: window.webContents.getZoomFactor(), action, focus: retired.focus, reduced: retired.reduced,
    bodyOverflow: retired.bodyOverflow, contentOverflow: retired.contentOverflow });
  window.destroy(); window = null;
  console.log('PASS ' + locale + ' ' + size.join('x') + ' ' + action);
}

(async () => {
  await app.whenReady();
  for (const locale of ['en', 'zh']) {
    for (const action of ['clear-success', 'clear-refused', 'clear-rejected', 'full', 'week']) {
      await run(locale, [840, 900, 1], action);
    }
    for (const size of [[500, 760, 1], [1180, 900, 1], [1180, 900, 1.25]]) {
      await run(locale, size, 'clear-success');
    }
  }
  console.log(JSON.stringify({ platform: process.platform, cases: evidence, boundary: 'actual Renderer; synthetic API; no Main clear or campus request' }));
  clearTimeout(deadline); app.exit(0);
})().catch(error => { console.error(error.stack); window?.destroy(); clearTimeout(deadline); app.exit(1); });
