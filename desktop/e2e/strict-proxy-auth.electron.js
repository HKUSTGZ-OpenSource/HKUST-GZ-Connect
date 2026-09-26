'use strict';

// Exercise Chromium's real authenticated HTTP-proxy path without contacting
// the network. A loopback test proxy serves a synthetic, non-loopback origin:
// the first absolute-form request receives a Basic proxy challenge, Electron's
// login event supplies the generation-scoped in-memory credential, and the
// retried request must render successfully. The same authenticated frontend
// also carries a ws:// Upgrade through Chromium's HTTP CONNECT form.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, WebContentsView, session } = require('electron');
const { CampusBrowser } = require('../lib/browser/session/campus-browser');
const { createCampusBrowserWindowOwner } = require('../lib/browser/session/campus-browser-manager');
const { buildDomainRoutePac } = require('../lib/routing/policy/domain-route-policy');
const { pacDataUrl } = require('../lib/browser/session/browser-session-manager');
const { EphemeralProxyCredential } = require('../lib/persistence/credentials/proxy-credential');

const HTTP_TARGET = 'http://strict-proxy-http.invalid/authenticated';
const WS_TARGET = 'ws://strict-proxy-ws.invalid/socket';
const TEST_TIMEOUT_MS = 15_000;
const WAIT_TIMEOUT_MS = 5_000;
const MAX_TUNNEL_HEADER_BYTES = 16 * 1024;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-proxy-auth-e2e-'));
app.setPath('userData', profile);

const resources = {
  browser: null,
  credential: null,
  loginHandler: null,
  proxy: null,
};

function byteEqual(left, right) {
  return Buffer.isBuffer(left) && Buffer.isBuffer(right) &&
    left.length === right.length && crypto.timingSafeEqual(left, right);
}

function validBasicAuthorization(header, expected) {
  if (typeof header !== 'string' || !header.startsWith('Basic ')) return false;
  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), 'base64');
  } catch {
    return false;
  }
  try {
    const separator = decoded.indexOf(0x3a);
    return separator > 0 &&
      byteEqual(decoded.subarray(0, separator), expected.username) &&
      byteEqual(decoded.subarray(separator + 1), expected.password);
  } finally {
    decoded.fill(0);
  }
}

function proxyChallenge(response) {
  response.writeHead(407, {
    'Content-Length': '0',
    'Proxy-Authenticate': 'Basic realm="hkustgzconnect-e2e"',
    Connection: 'close',
  });
  response.end();
}

function proxyChallengeSocket(socket) {
  socket.end([
    'HTTP/1.1 407 Proxy Authentication Required',
    'Content-Length: 0',
    'Proxy-Authenticate: Basic realm="hkustgzconnect-e2e"',
    'Connection: close',
    '',
    '',
  ].join('\r\n'));
}

function websocketAccept(key) {
  return crypto
    .createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
}

function completeWebsocketHandshake(socket, key) {
  if (typeof key !== 'string' || !key) {
    socket.destroy();
    return;
  }
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Connection: Upgrade',
    'Upgrade: websocket',
    `Sec-WebSocket-Accept: ${websocketAccept(key)}`,
    '',
    '',
  ].join('\r\n'));
  const payload = Buffer.from('proxy-websocket-ok', 'utf8');
  socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.equal(typeof address, 'object');
  return address.port;
}

async function closeProxy(proxy) {
  if (!proxy) return;
  for (const socket of proxy.sockets) socket.destroy();
  await new Promise((resolve) => proxy.server.close(() => resolve()));
}

function createAuthenticatedProxy(expected) {
  const observations = {
    connect: [],
    http: [],
    ws: [],
  };
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    const authenticated = validBasicAuthorization(
      request.headers['proxy-authorization'],
      expected,
    );
    observations.http.push({
      authenticated,
      method: request.method,
      target: request.url,
    });
    if (!authenticated) {
      proxyChallenge(response);
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end('<!doctype html><title>strict proxy ok</title><main id="result">ok</main>');
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (request, socket) => {
    const authenticated = validBasicAuthorization(
      request.headers['proxy-authorization'],
      expected,
    );
    observations.ws.push({
      authenticated,
      host: request.headers.host,
      method: request.method,
      target: request.url,
      upgrade: String(request.headers.upgrade || '').toLowerCase(),
      via: 'absolute-form',
    });
    if (!authenticated) {
      proxyChallengeSocket(socket);
      return;
    }
    completeWebsocketHandshake(socket, request.headers['sec-websocket-key']);
  });
  server.on('connect', (request, socket, initialData) => {
    const authenticated = validBasicAuthorization(
      request.headers['proxy-authorization'],
      expected,
    );
    observations.connect.push({
      authenticated,
      method: request.method,
      target: request.url,
    });
    if (!authenticated) {
      proxyChallengeSocket(socket);
      return;
    }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    let buffered = Buffer.alloc(0);
    const onData = (data) => {
      buffered = Buffer.concat([buffered, data]);
      if (buffered.length > MAX_TUNNEL_HEADER_BYTES) {
        buffered.fill(0);
        socket.destroy();
        return;
      }
      const boundary = buffered.indexOf('\r\n\r\n');
      if (boundary < 0) return;
      socket.removeListener('data', onData);
      const header = buffered.subarray(0, boundary).toString('latin1');
      buffered.fill(0);
      const lines = header.split('\r\n');
      const [method = '', target = ''] = String(lines.shift() || '').split(' ');
      const headers = {};
      for (const line of lines) {
        const separator = line.indexOf(':');
        if (separator <= 0) continue;
        headers[line.slice(0, separator).trim().toLowerCase()] =
          line.slice(separator + 1).trim();
      }
      observations.ws.push({
        authenticated: true,
        host: headers.host,
        method,
        target,
        upgrade: String(headers.upgrade || '').toLowerCase(),
        via: 'connect-tunnel',
      });
      completeWebsocketHandshake(socket, headers['sec-websocket-key']);
    };
    socket.on('data', onData);
    if (initialData?.length) onData(initialData);
  });
  return { server, sockets, observations };
}

function strictRoutingPolicy() {
  const rules = [
    { host: 'strict-proxy-http.invalid', includeSubdomains: false, route: 'campus' },
    { host: 'strict-proxy-ws.invalid', includeSubdomains: false, route: 'campus' },
  ];
  return {
    list: () => rules.map((rule) => ({ ...rule })),
    resolve: () => ({ route: 'campus', source: 'user-exact', matchedRule: rules[0] }),
    upsert: async () => ({ rules }),
    proxyConfig(port) {
      const source = buildDomainRoutePac({ userRules: rules }, port, {
        defaultRoute: 'campus',
        proxyKind: 'http',
      });
      return {
        mode: 'pac_script',
        pacScript: pacDataUrl(source),
        proxyBypassRules: '<-loopback>',
      };
    },
  };
}

async function waitFor(condition, description) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function cleanup() {
  if (resources.loginHandler) app.removeListener('login', resources.loginHandler);
  resources.browser?.close();
  resources.browser = null;
  resources.credential?.destroy();
  resources.credential = null;
  await closeProxy(resources.proxy);
  resources.proxy = null;
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}

async function run() {
  await app.whenReady();

  const credential = new EphemeralProxyCredential();
  resources.credential = credential;
  const expected = credential.socksAuthentication(1);
  assert.equal(expected, null, 'credential must be inert before generation binding');

  const proxy = createAuthenticatedProxy({
    get username() { return credential.socksAuthentication(1)?.username; },
    get password() { return credential.socksAuthentication(1)?.password; },
  });
  resources.proxy = proxy;
  const port = await listen(proxy.server);
  assert.equal(credential.bindGeneration(1, port), true);

  const errors = [];
  const browser = new CampusBrowser({
    BrowserWindow,
    createWindowOwner: createCampusBrowserWindowOwner,
    WebContentsView,
    session,
    dialog: {
      showSaveDialog: async () => ({ canceled: true }),
      showMessageBox: async () => ({ response: 1 }),
    },
    certificateTrust: { isTrusted: () => false, trust: () => {} },
    credentialVault: null,
    parentWindow: () => null,
    toolbarFile: path.join(__dirname, '..', 'renderer', 'campus-browser.html'),
    toolbarPreload: path.join(__dirname, '..', 'lib', 'browser', 'toolbar', 'campus-toolbar-contract.js'),
    campusPreload: path.join(__dirname, '..', 'campus-preload.js'),
    routingPolicy: strictRoutingPolicy(),
    onError: (message) => errors.push(String(message)),
  });
  resources.browser = browser;

  let loginChallenges = 0;
  resources.loginHandler = (event, webContents, _details, authInfo, callback) => {
    if (!browser.ownsWebContents(webContents) ||
        !credential.matchesProxyChallenge(authInfo, 1)) return;
    loginChallenges += 1;
    event.preventDefault();
    credential.answerProxyChallenge(authInfo, 1, callback);
  };
  app.on('login', resources.loginHandler);

  await browser.open(HTTP_TARGET, port, 'campus');
  browser.window.hide();
  await waitFor(async () => {
    const tab = browser.activeTab();
    if (!tab || tab.view.webContents.isDestroyed()) return false;
    return tab.view.webContents.executeJavaScript(
      "document.getElementById('result')?.textContent === 'ok'",
    ).catch(() => false);
  }, 'authenticated page to render');

  assert.ok(loginChallenges >= 1, 'Chromium must surface the Basic proxy challenge');
  assert.deepEqual(proxy.observations.http.slice(0, 2), [
    { authenticated: false, method: 'GET', target: HTTP_TARGET },
    { authenticated: true, method: 'GET', target: HTTP_TARGET },
  ]);

  const websocketResult = await browser.activeTab().view.webContents.executeJavaScript(`new Promise((resolve) => {
    const socket = new WebSocket(${JSON.stringify(WS_TARGET)});
    const timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), 3000);
    socket.addEventListener('message', (event) => {
      clearTimeout(timer);
      const data = String(event.data || '');
      socket.close();
      resolve({ ok: data === 'proxy-websocket-ok', data });
    }, { once: true });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      resolve({ ok: false, reason: 'error' });
    }, { once: true });
  })`);
  assert.deepEqual(websocketResult, { ok: true, data: 'proxy-websocket-ok' });
  assert.ok(proxy.observations.ws.length >= 1, 'ws:// must reach the local HTTP proxy');
  const websocket = proxy.observations.ws.at(-1);
  assert.equal(websocket.authenticated, true);
  assert.equal(websocket.host, 'strict-proxy-ws.invalid');
  assert.equal(websocket.method, 'GET');
  assert.equal(websocket.target, '/socket');
  assert.equal(websocket.upgrade, 'websocket');
  assert.equal(websocket.via, 'connect-tunnel');
  assert.ok(proxy.observations.connect.some((request) => (
    request.authenticated && request.method === 'CONNECT' &&
    request.target === 'strict-proxy-ws.invalid:80'
  )));
  assert.deepEqual(errors, []);
  process.stdout.write('strict proxy auth: PASS\n');
}

const hardTimeout = setTimeout(() => {
  process.stderr.write('strict proxy auth: hard timeout\n');
  void cleanup().finally(() => app.exit(1));
}, TEST_TIMEOUT_MS);

run().then(
  async () => {
    clearTimeout(hardTimeout);
    await cleanup();
    app.quit();
  },
  async (error) => {
    clearTimeout(hardTimeout);
    process.stderr.write(`${error.stack || error}\n`);
    await cleanup();
    app.exit(1);
  },
);
