'use strict';
const assert = require('node:assert/strict');
const { BrowserSessionManager, pacDataUrl } = require('../../lib/browser/session/browser-session-manager');

function deferred() {
  let resolve; const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

// Uses an isolated Session and an intercepted synthetic HTTPS origin; no
// Gateway, system proxy, DNS, route or real account is involved.
async function assertNativeSessionOwnership({ session, BrowserWindow }) {
  const isolated = session.fromPartition('persist:synthetic-session-authority');
  const url = 'https://session-authority.example.invalid/';
  const originalRegister = isolated.webRequest.onBeforeRequest;
  let registrations = 0, oldReady = 0, currentReady = 0, window;
  isolated.webRequest.onBeforeRequest = function(...args) {
    registrations++; return originalRegister.apply(this, args);
  };
  isolated.protocol.handle('https', () => new Response('<!doctype html><title>synthetic Session</title>'));
  const pac = async port => ({ mode: 'pac_script',
    pacScript: pacDataUrl(`function FindProxyForURL(){return "SOCKS5 127.0.0.1:${port}";}`),
    proxyBypassRules: '<-loopback>' });
  const manager = options => new BrowserSessionManager({
    session: { fromPartition: () => isolated }, partition: 'persist:synthetic-session-authority',
    routingPolicy: { proxyConfig: pac }, ...options,
  });
  const release = deferred();
  try {
    await isolated.cookies.set({ url, name: 'synthetic-ownership-cookie', value: 'synthetic-value' });
    const old = manager({ ensureRequestReady: async () => { oldReady++; return true; } });
    await old.configure(11081); await old.suspend();
    const current = manager({ ensureRequestReady: async () => { currentReady++; return false; } });
    await current.configure(11082);
    window = new BrowserWindow({ show: false, webPreferences: {
      session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false,
    } });
    await assert.rejects(window.loadURL(url), /ERR_BLOCKED_BY_CLIENT/u);
    assert.equal(oldReady, 0); assert.ok(currentReady > 0); assert.equal(registrations, 1);
    assert.equal((await isolated.cookies.get({ url, name: 'synthetic-ownership-cookie' }))[0]?.value,
      'synthetic-value', 'replacement retains the same isolated cookie jar');

    const entered = deferred();
    const delayed = manager({ routingPolicy: { proxyConfig: async port => {
      entered.resolve(); await release.promise; return pac(port);
    } } });
    const obsolete = delayed.configure(11083); await entered.promise;
    const replacement = manager(); await replacement.configure(11084);
    release.resolve(); assert.equal(await obsolete, null);
    assert.equal(await isolated.resolveProxy(url), 'SOCKS5 127.0.0.1:11084');
    assert.equal(await delayed.suspend(), null);
    assert.equal(replacement.requestsBlocked, false);
    assert.equal(await isolated.resolveProxy(url), 'SOCKS5 127.0.0.1:11084');

    const originalProxy = isolated.setProxy, nativeEntered = deferred(), nativeRelease = deferred();
    isolated.setProxy = async function(config) {
      const source = Buffer.from(config.pacScript.split(',')[1], 'base64').toString();
      await originalProxy.call(this, config);
      if (source.includes(':11085')) { nativeEntered.resolve(); await nativeRelease.promise; }
    };
    try {
      const retiring = manager(), late = retiring.configure(11085); await nativeEntered.promise;
      const next = manager(); let committed = false;
      const admitted = next.configure(11086).then(value => { committed = true; return value; });
      await new Promise(setImmediate);
      assert.equal(committed, false, 'already-issued native I/O must settle before replacement writes');
      nativeRelease.resolve(); assert.equal(await late, null); await admitted;
      assert.equal(await isolated.resolveProxy(url), 'SOCKS5 127.0.0.1:11086');
      next.retire(); assert.equal(next.requestsBlocked, true);
      assert.equal(await next.resume(11086), null);
    } finally {
      nativeRelease.resolve(); isolated.setProxy = originalProxy;
    }
  } finally {
    release.resolve();
    if (window && !window.isDestroyed()) window.destroy();
    isolated.webRequest.onBeforeRequest = originalRegister;
    isolated.protocol.unhandle('https');
    await isolated.closeAllConnections();
  }
  process.stdout.write('native Browser Session replacement ownership: PASS\n');
}

module.exports = { assertNativeSessionOwnership };
