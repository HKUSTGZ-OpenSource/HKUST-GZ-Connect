'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const tls = require('node:tls');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { app, BrowserWindow, WebContentsView, session, safeStorage, net, ipcMain } = require('electron');
const desktop = path.resolve(__dirname, '..');
const { CampusBrowserManager } = require(path.join(desktop, 'lib/browser/session/campus-browser-manager'));
const { MyPortalDataRuntime, hkustMyPortalSources, pacDataUrl } = require(path.join(desktop, 'lib/browser/session/browser-session-manager'));
const { buildDomainRoutePac, resolveDomainRouteForUrl } = require(path.join(desktop, 'lib/routing/policy/domain-route-policy'));
const { EphemeralProxyCredential } = require(path.join(desktop, 'lib/persistence/credentials/proxy-credential'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-portal-proxy-'));
const { scheduleTemporaryProfileCleanup } = require('../scripts/temp-profile-cleanup');
app.once('quit', () => scheduleTemporaryProfileCleanup(profile, 'hkustgz-portal-proxy'));
app.setPath('userData', profile);
app.on('window-all-closed', () => {});
const HOST = 'portal-cold.fixture.invalid';
const PORTAL = `https://${HOST}/`;
const results = [];
// Generate ephemeral TLS material with the system OpenSSL (Git for Windows
// includes it). No private-key fixture or extra npm dependency enters Git.
function createSyntheticCertificate() {
  const candidates = process.platform === 'win32'
    ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git/usr/bin/openssl.exe'), 'openssl'] : ['openssl'];
  for (const binary of candidates) {
    try {
      execFileSync(binary, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', path.join(profile, 'synthetic-key.pem'), '-out', path.join(profile, 'synthetic-cert.pem'),
        '-days', '2', '-subj', `/CN=${HOST}`, '-addext', `subjectAltName=DNS:${HOST}`],
      { windowsHide: true, stdio: 'ignore', timeout: 10000 });
      return;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error('OpenSSL is required for the loopback TLS fixture');
}
const active = { managers: [], sessions: [], sockets: new Set(), servers: [], credentials: [], listeners: [] };
let hardTimeout;
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function fixture(credential, generation) {
  const observed = { unauthorizedConnects: 0, authorizedConnects: 0, cookieMatches: 0, cookieMismatches: 0, unexpectedTargets: 0, apiResponses: 0, probeResponses: 0, appLogin: 0, requestLogin: 0 };
  const context = tls.createSecureContext({ key: fs.readFileSync(path.join(profile, 'synthetic-key.pem')), cert: fs.readFileSync(path.join(profile, 'synthetic-cert.pem')) });
  const server = http.createServer((_request, response) => { observed.unexpectedTargets++; response.writeHead(502); response.end(); });
  active.servers.push(server);
  const track = socket => { active.sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => active.sockets.delete(socket)); };
  server.on('connection', track);
  server.on('connect', (request, socket, initial) => {
    if (request.url !== `${HOST}:443`) { observed.unexpectedTargets++; socket.destroy(); return; }
    const borrowed = credential.socksAuthentication(generation);
    const expected = borrowed && Buffer.concat([borrowed.username, Buffer.from(':'), borrowed.password]);
    const actual = Buffer.from(String(request.headers['proxy-authorization'] || '').replace(/^Basic /, ''), 'base64');
    const accepted = expected && actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    actual.fill(0); expected?.fill(0);
    if (!accepted) {
      observed.unauthorizedConnects++;
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="synthetic-portal-cold"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return;
    }
    observed.authorizedConnects++;
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (initial.length) socket.unshift(initial);
    const secure = new tls.TLSSocket(socket, { isServer: true, secureContext: context });
    track(secure);
    let buffered = Buffer.alloc(0), handled = false;
    secure.on('data', data => {
      if (handled) return;
      buffered = Buffer.concat([buffered, data]);
      if (buffered.length > 16384) { secure.destroy(); return; }
      const end = buffered.indexOf('\r\n\r\n'); if (end < 0) return;
      handled = true;
      const header = buffered.subarray(0, end).toString('latin1'); buffered.fill(0);
      const target = new URL(header.split('\r\n')[0].split(' ')[1], PORTAL);
      if (target.origin !== PORTAL.slice(0, -1)) { observed.unexpectedTargets++; secure.destroy(); return; }
      const hasCookie = /^cookie:.*fixture_session=synthetic-portal-only/im.test(header);
      observed[hasCookie ? 'cookieMatches' : 'cookieMismatches']++;
      let status = 200, type = 'text/html', body = '<!doctype html><title>Synthetic portal</title><main id="ready">ready</main>';
      if (target.pathname.endsWith('/calendarList.rst')) {
        const day = Date.parse(target.searchParams.get('fromDate'));
        body = JSON.stringify([{ id: String(day), title: 'Synthetic calendar', startsAt: day + 36000000, endsAt: day + 39600000, location: 'Fixture room' }]);
        type = 'application/json'; observed.apiResponses++;
      } else if (target.pathname === '/') { observed.probeResponses++; }
      else if (target.pathname === '/favicon.ico') { status = 204; body = ''; }
      else if (target.pathname !== '/') { observed.unexpectedTargets++; status = 404; body = ''; }
      secure.end(`HTTP/1.1 ${status} Synthetic\r\nContent-Type: ${type}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n${body}`);
    });
  });
  return { server, observed };
}
async function runCase(label, sessionHint = false) {
  const partition = `persist:portal-cold-${crypto.randomUUID()}`;
  const owned = session.fromPartition(partition); active.sessions.push(owned);
  owned.setCertificateVerifyProc(({ hostname }, callback) => callback(hostname === HOST ? 0 : -3));
  await owned.cookies.set({ url: PORTAL, name: 'fixture_session', value: 'synthetic-portal-only', secure: true, httpOnly: true });
  const credential = new EphemeralProxyCredential(); active.credentials.push(credential);
  const generation = 1;
  const proxy = fixture(credential, generation);
  await new Promise((resolve, reject) => { proxy.server.once('error', reject); proxy.server.listen(0, '127.0.0.1', resolve); });
  const port = proxy.server.address().port;
  assert.equal(credential.bindGeneration(generation, port), true);
  const rules = [{ host: HOST, includeSubdomains: false, route: 'campus' }];
  const routingPolicy = {
    list: () => rules.map(rule => ({ ...rule })),
    resolve: (url, inheritedRoute) => resolveDomainRouteForUrl(url, { userRules: rules, inheritedRoute }),
    upsert: async () => ({ rules }),
    proxyConfig: currentPort => ({ mode: 'pac_script', proxyBypassRules: '<-loopback>', pacScript: pacDataUrl(buildDomainRoutePac({ userRules: rules }, currentPort, { defaultRoute: 'campus', proxyKind: 'http' })) }),
  };
  const noop = () => {}, errors = [];
  const manager = new CampusBrowserManager({
    BrowserWindow, WebContentsView, session, safeStorage, platform: process.platform,
    dialog: { showMessageBox: async () => ({ response: 1 }), showSaveDialog: async () => ({ canceled: true }) },
    certificateTrust: { isTrusted: () => false, trust: noop },
    credentialFile: path.join(profile, `${label}-unused-vault.json`),
    toolbarFile: path.join(desktop, 'renderer/campus-browser.html'),
    toolbarPreload: path.join(desktop, 'lib/browser/toolbar/campus-toolbar-contract.js'),
    campusPreload: path.join(desktop, 'campus-preload.js'),
    workspaceFile: path.join(desktop, 'renderer/campus-workspace.html'),
    workspacePreload: path.join(desktop, 'lib/browser/workspace/campus-workspace-preload.js'),
    browserPartition: partition, homeUrl: PORTAL, routingPolicy,
    parentWindow: () => null, ensureCampusReady: async () => true, ensureConnected: async () => ({ ok: true }),
    resolveRoute: url => routingPolicy.resolve(url), getSocksPort: () => port,
    getLocale: () => 'en', getTranslator: () => (key, vars) => vars?.message || key,
    getProfilePresentation: () => ({ schoolName: 'Synthetic campus', unverified: true, officialPortalResourceId: null }),
    getWorkspaceResources: () => [], onOpenResource: noop, onWorkspaceMutation: noop,
    showItemInFolder: noop, showRoutingRules: noop, showSettings: noop,
    reportError: error => { if (error) errors.push('BROWSER_ERROR'); },
  });
  active.managers.push(manager);
  const boundary = CampusBrowserManager.createRequestSecurityBoundary({ getBrowser: () => manager, getEngineGeneration: () => generation, proxyAccess: credential });
  const listener = (...args) => { proxy.observed.appLogin++; boundary.proxyLogin(...args); };
  app.on('login', listener); active.listeners.push(listener);
  const opened = await manager.openBookmarkManager(); assert.equal(opened.ok, true, opened.error);
  manager.browser.window.hide();
  assert.equal(manager.browser.campusSession, owned, 'Data and Browser use the same actual Session');
  assert.equal(manager.browser.configuredPort, port);
  assert.equal(await owned.resolveProxy(PORTAL), `PROXY 127.0.0.1:${port}`);
  assert.equal(proxy.observed.unauthorizedConnects, 0); assert.equal(proxy.observed.appLogin, 0);
  // A retained portal URL hint skips the probe; its API requests must also
  // authenticate independently after the proxy authentication cache is cold.
  if (sessionHint) assert.equal(manager.capturePortalSessionUrl(PORTAL), true);
  const runtime = new MyPortalDataRuntime({ electronSession: session, electronNet: { request(options) {
    const request = net.request(options); request.on('login', () => proxy.observed.requestLogin++); return request;
  } }, getPartition: () => partition, getPortalUrl: () => PORTAL,
    getSessionUrlHint: () => manager.portalSessionUrl(PORTAL), getProxyLogin: () => boundary.captureProxyLogin(), getSources: () => ({ schedule: hkustMyPortalSources.schedule }), timeoutMs: 1500 });
  const cold = await runtime.snapshot({ force: true });
  assert.equal(cold.sessionState, 'authenticated', 'cold Main portal probe must authenticate without a Browser network page');
  assert.equal(cold.modules.schedule.state, 'ready');
  assert.equal(cold.modules.schedule.items.length, 7);
  assert.ok(proxy.observed.requestLogin >= 1); assert.equal(proxy.observed.appLogin, 0);
  assert.ok(proxy.observed.unauthorizedConnects >= 1);
  assert.equal(proxy.observed.apiResponses, 7);
  assert.equal(proxy.observed.probeResponses, sessionHint ? 0 : 1, 'retained hint must exercise API authentication without a probe warm-up');
  assert.equal(proxy.observed.cookieMismatches, 0); assert.equal(proxy.observed.unexpectedTargets, 0);
  assert.deepEqual(errors, []);
  results.push({ label, sessionHint, sessionState: cold.sessionState, scheduleState: cold.modules.schedule.state,
    items: cold.modules.schedule.items.length, counters: clone(proxy.observed) });
  app.removeListener('login', listener);
  assert.equal(await manager.closeForContextSwitch(), true);
  await owned.closeAllConnections();
  credential.destroy();
}
async function cleanup() {
  for (const listener of active.listeners) app.removeListener('login', listener);
  for (const manager of active.managers) { try { await manager.closeForContextSwitch(); } catch {} }
  for (const owned of active.sessions) { try { await owned.closeAllConnections(); } catch {} }
  for (const socket of active.sockets) socket.destroy();
  for (const server of active.servers) { try { await new Promise(resolve => server.close(resolve)); } catch {} }
  for (const credential of active.credentials) credential.destroy();
}
hardTimeout = setTimeout(() => { console.error('PORTAL_PROXY_AUTH_TIMEOUT'); void cleanup().finally(() => app.exit(1)); }, 30000);
(async () => {
  await app.whenReady();
  createSyntheticCertificate();
  const { createDefaultCardBoardLayout } = require(path.join(desktop, 'lib/card-board/runtime/card-board-migration'));
  const board = createDefaultCardBoardLayout({ officialCategoryIds: [], userCollectionIds: [], includeUngroupedFavorites: true, connectWidgetIds: ['connection-metrics', 'network-adapter', 'connection-details'] });
  ipcMain.handle('get-card-board-layout', () => ({ document: board }));
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
  await runCase('cold-probe'); await runCase('cold-api-with-retained-hint', true);
  console.log(JSON.stringify({ kind: 'portal-proxy-auth', platform: process.platform, electron: process.versions.electron, results }));
})().then(async () => { await cleanup(); clearTimeout(hardTimeout); console.log('portal proxy auth: PASS'); app.exit(0); }, async error => { console.error(error.stack); await cleanup(); clearTimeout(hardTimeout); app.exit(1); });
